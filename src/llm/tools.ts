import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { sendSms } from '../sms.js';
import { error, log } from '../util/logger.js';
import { isBusinessOpen } from '../util/hours.js';
import { ensurePerson } from '../twenty/people.js';
import { createFollowUpTask, createOpportunity } from '../twenty/records.js';

export type ToolControl =
  | { kind: 'transfer'; to: string; reason: string; who?: string; caller?: string }
  | { kind: 'hangup'; reason: string }
  | { kind: 'voicemail' }
  | { kind: 'language'; lang: 'fr' | 'en' };

export type ToolOutcome = {
  result: string;
  control?: ToolControl;
};

/** Etat de session accessible aux outils. */
export interface ToolSession {
  phoneE164: string;
  personId?: string;
  existingClient: boolean;
  companyName?: string;
  /** Id de la societe reliee (pour lier l'appel/l'opportunite). */
  companyId?: string;
  /** Une opportunite a deja ete creee pour ce nouveau lead durant l'appel. */
  opportunityDone?: boolean;
  /** Telephone du responsable du dossier (account owner), si connu. */
  ownerPhone?: string;
  /** Nom du responsable du dossier, si connu. */
  ownerName?: string;
  /** Membre Twenty (account owner) a qui assigner la tache, si connu. */
  ownerMemberId?: string;
  callSummary?: string;
  callOutcome?: string;
}

/** Prenom a annoncer a l'oral pour la personne vers qui on route. */
function routeName(session: ToolSession, existing: boolean): string {
  if (existing) {
    const owner = session.ownerName?.trim();
    return owner ? (owner.split(/\s+/)[0] ?? owner) : config.business.existingName;
  }
  return config.business.newName;
}

/**
 * Numero vers lequel router. Client existant -> son responsable de dossier si
 * connu, sinon le numero des clients existants. Nouveau contact -> Alexandre.
 */
function routeTo(session: ToolSession, existing: boolean): string {
  if (existing) return session.ownerPhone || config.business.transferExisting;
  return config.business.transferNew;
}

function clientFlag(args: Record<string, unknown>, session: ToolSession): boolean {
  if (typeof args.client_existant === 'boolean') return args.client_existant;
  return session.existingClient;
}

function label(nom: string, entreprise: string): string {
  const n = nom.trim() || 'Appelant';
  return entreprise.trim() ? `${n} (${entreprise.trim()})` : n;
}

/** Cree une opportunite (pipeline) pour un nouveau lead, une seule fois par appel. */
function ensureOpportunityForNewLead(session: ToolSession, nom: string, entreprise: string): void {
  if (session.existingClient || session.opportunityDone || !session.personId) return;
  session.opportunityDone = true;
  void createOpportunity({
    name: `${label(nom, entreprise)} - Appel entrant`,
    personId: session.personId,
    companyId: session.companyId,
    ownerId: config.business.defaultAssigneeId,
  });
}

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'transferer_appel',
    description:
      "Transfere l'appel a la bonne personne (pendant les heures d'ouverture). Un client existant va a Mathieu, un nouveau contact a Alexandre. Avant d'appeler cet outil, demande simplement si la personne est deja cliente et la raison de l'appel. Dis une courte phrase de mise en relation, puis appelle l'outil. Il envoie une alerte SMS a la personne concernee.",
    input_schema: {
      type: 'object',
      properties: {
        client_existant: {
          type: 'boolean',
          description: "Vrai si l'appelant confirme etre deja client de Balgio.",
        },
        raison: { type: 'string', description: "Raison de l'appel, en quelques mots." },
        nom: { type: 'string', description: "Nom de l'appelant tel qu'entendu (facultatif)." },
        entreprise: { type: 'string', description: "Entreprise de l'appelant (facultatif)." },
      },
      required: ['client_existant', 'raison'],
    },
  },
  {
    name: 'prendre_message',
    description:
      "Passe l'appelant a la boite vocale pour qu'il enregistre son message. AVANT d'appeler cet outil: demande son nom, puis confirme le numero de rappel (par defaut le numero affiche; s'il en veut un autre, qu'il le compose au clavier suivi du carre). Dis ensuite une courte phrase comme 'Parfait, laissez votre message apres la tonalite', puis appelle cet outil.",
    input_schema: {
      type: 'object',
      properties: {
        nom: { type: 'string', description: "Nom de l'appelant." },
        numero_rappel: {
          type: 'string',
          description: 'Numero de rappel confirme. Laisse vide pour utiliser le numero affiche.',
        },
      },
      required: [],
    },
  },
  {
    name: 'changer_langue',
    description:
      "Change la langue de la conversation quand l'appelant s'exprime dans une autre langue. Appelle-le des que tu detectes de l'anglais, puis poursuis dans cette langue.",
    input_schema: {
      type: 'object',
      properties: {
        langue: { type: 'string', enum: ['fr', 'en'], description: 'fr pour francais, en pour anglais.' },
      },
      required: ['langue'],
    },
  },
  {
    name: 'terminer_appel',
    description:
      "Termine et raccroche l'appel. Dis d'abord au revoir, puis appelle cet outil avec un resume clair.",
    input_schema: {
      type: 'object',
      properties: {
        resume: { type: 'string', description: "Resume de l'appel." },
        disposition: {
          type: 'string',
          enum: ['information_donnee', 'message_pris', 'transfere', 'pas_interesse', 'ne_pas_rappeler'],
          description: "Issue de l'appel.",
        },
      },
      required: ['resume', 'disposition'],
    },
  },
];

const DISPOSITION_TO_OUTCOME: Record<string, string> = {
  information_donnee: 'CONNECTED',
  message_pris: 'CONNECTED',
  transfere: 'CONNECTED',
  pas_interesse: 'PAS_INTERESSE',
  ne_pas_rappeler: 'NE_PAS_APPELER',
};

async function handleTransfer(
  args: Record<string, unknown>,
  session: ToolSession,
): Promise<ToolOutcome> {
  const raison = String(args.raison ?? '').trim();
  const nom = String(args.nom ?? '').trim();
  const entreprise = String(args.entreprise ?? '').trim();
  const existing = clientFlag(args, session);
  session.existingClient = existing;

  const target = routeTo(session, existing);
  if (!isBusinessOpen() || !target) {
    return {
      result:
        "Personne n'est disponible pour l'instant (hors des heures). Ne transfere pas. Prends plutot un message avec prendre_message.",
    };
  }

  if (nom) {
    const person = await ensurePerson(session.phoneE164, nom);
    if (person) session.personId = person.id;
  }
  ensureOpportunityForNewLead(session, nom, entreprise);

  const statut = existing ? 'Client existant' : 'Nouveau contact';
  const sms = `Appel Balgio - ${label(nom, entreprise)}. ${statut}. Raison: ${raison || 'non precisee'}. Transfert en cours.`;
  void sendSms(target, sms); // arriere-plan: ne pas retarder le transfert

  session.callSummary = `Transfert (${statut}) vers ${target}. ${label(nom, entreprise)}. Raison: ${raison}.`;
  session.callOutcome = 'CONNECTED';

  return {
    result: 'Transfert autorise. Dis une courte phrase de mise en relation, puis laisse le transfert se faire.',
    control: {
      kind: 'transfer',
      to: target,
      reason: raison || statut,
      who: routeName(session, existing),
      caller: label(nom, entreprise),
    },
  };
}

async function handlePrendreMessage(
  args: Record<string, unknown>,
  session: ToolSession,
): Promise<ToolOutcome> {
  const nom = String(args.nom ?? '').trim();
  const numero = String(args.numero_rappel ?? '').trim() || session.phoneE164;
  const existing = session.existingClient;

  if (nom) {
    const person = await ensurePerson(numero, nom);
    if (person) session.personId = person.id;
  }
  ensureOpportunityForNewLead(session, nom, '');

  const statut = existing ? 'Client existant' : 'Nouveau contact';
  const target = routeTo(session, existing);

  // Coordonnees + alerte SMS en arriere-plan. Le contenu du message (audio)
  // sera joint plus tard, une fois l'enregistrement de la boite vocale termine.
  void createFollowUpTask({
    title: `Message vocal de ${nom || 'appelant'}`,
    body: [
      `Message vocal recu par ${config.business.assistant}.`,
      `Nom: ${nom || 'non fourni'}`,
      `Statut: ${statut}`,
      `Rappeler au: ${numero}`,
      ``,
      `L'enregistrement audio est joint au courriel et a la fiche de l'appel.`,
    ].join('\n'),
    personId: session.personId,
    assigneeId: session.ownerMemberId || config.business.defaultAssigneeId,
  });
  void sendSms(
    target,
    `Message vocal Balgio - ${nom || 'appelant'}. ${statut}. Rappeler au ${numero}. Enregistrement par courriel.`,
  );

  session.callSummary = `Message vocal. ${nom || 'appelant'}. Rappel: ${numero}.`;
  session.callOutcome = 'CONNECTED';

  return {
    result:
      "Coordonnees notees. Dis une courte phrase invitant a laisser le message apres la tonalite, puis c'est tout: l'enregistrement demarre.",
    control: { kind: 'voicemail' },
  };
}

function handleTerminer(args: Record<string, unknown>, session: ToolSession): ToolOutcome {
  const resume = String(args.resume ?? '').trim();
  const disposition = String(args.disposition ?? 'information_donnee');
  if (resume) session.callSummary = resume;
  session.callOutcome = DISPOSITION_TO_OUTCOME[disposition] ?? 'CONNECTED';
  return {
    result: 'Appel termine. Dis au revoir a l appelant.',
    control: { kind: 'hangup', reason: disposition },
  };
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  session: ToolSession,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'transferer_appel':
        return await handleTransfer(args, session);
      case 'prendre_message':
        return await handlePrendreMessage(args, session);
      case 'changer_langue':
        return {
          result: 'Langue changee. Poursuis dans cette langue.',
          control: { kind: 'language', lang: args.langue === 'en' ? 'en' : 'fr' },
        };
      case 'terminer_appel':
        return handleTerminer(args, session);
      default:
        return { result: `Outil inconnu: ${name}.` };
    }
  } catch (err) {
    error('tools', `Echec de l'outil ${name}`, err);
    log('tools', 'Degradation gracieuse.');
    return {
      result:
        "Le systeme est momentanement indisponible. Continue quand meme: prends l'information a l'oral et rassure l'appelant.",
    };
  }
}
