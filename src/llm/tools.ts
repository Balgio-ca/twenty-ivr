import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { sendMessageEmail } from '../email.js';
import { sendSms } from '../sms.js';
import { error, log } from '../util/logger.js';
import { isBusinessOpen } from '../util/hours.js';
import { ensurePerson } from '../twenty/people.js';
import { createFollowUpTask } from '../twenty/records.js';

export type ToolControl =
  | { kind: 'transfer'; to: string; reason: string }
  | { kind: 'hangup'; reason: string }
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
  /** Telephone du responsable du dossier (account owner), si connu. */
  ownerPhone?: string;
  callSummary?: string;
  callOutcome?: string;
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
      "Enregistre un message, l'envoie par courriel et alerte l'equipe par SMS. A utiliser hors des heures d'ouverture, ou si l'appelant prefere laisser un message. Demande la raison et un numero de rappel; le nom et l'entreprise sont facultatifs.",
    input_schema: {
      type: 'object',
      properties: {
        raison: { type: 'string', description: "Raison de l'appel." },
        numero_rappel: {
          type: 'string',
          description: 'Numero de rappel. Laisse vide pour utiliser le numero affiche.',
        },
        nom: { type: 'string', description: "Nom de l'appelant (facultatif)." },
        entreprise: { type: 'string', description: "Entreprise (facultatif)." },
        client_existant: { type: 'boolean', description: 'Vrai si deja client (si connu).' },
        message: { type: 'string', description: 'Details additionnels (facultatif).' },
      },
      required: ['raison'],
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

  const statut = existing ? 'Client existant' : 'Nouveau contact';
  const sms = `Appel Balgio - ${label(nom, entreprise)}. ${statut}. Raison: ${raison || 'non precisee'}. Transfert en cours.`;
  await sendSms(target, sms);

  session.callSummary = `Transfert (${statut}) vers ${target}. ${label(nom, entreprise)}. Raison: ${raison}.`;
  session.callOutcome = 'CONNECTED';

  return {
    result: 'Transfert autorise. Dis une courte phrase de mise en relation, puis laisse le transfert se faire.',
    control: { kind: 'transfer', to: target, reason: raison || statut },
  };
}

async function handlePrendreMessage(
  args: Record<string, unknown>,
  session: ToolSession,
): Promise<ToolOutcome> {
  const raison = String(args.raison ?? '').trim();
  const nom = String(args.nom ?? '').trim();
  const entreprise = String(args.entreprise ?? '').trim();
  const numero = String(args.numero_rappel ?? '').trim() || session.phoneE164;
  const message = String(args.message ?? '').trim() || raison;
  const existing = clientFlag(args, session);
  const afterHours = !isBusinessOpen();

  if (nom) {
    const person = await ensurePerson(numero, nom);
    if (person) session.personId = person.id;
  }

  const statut = existing ? 'Client existant' : 'Nouveau contact';
  const body = [
    `Message telephonique pris par ${config.business.assistant}.`,
    ``,
    `Appelant: ${label(nom, entreprise)}`,
    `Statut: ${statut}`,
    `Numero de rappel: ${numero}`,
    `Raison: ${raison || 'non precisee'}`,
    ``,
    message,
  ].join('\n');

  await createFollowUpTask({
    title: `Message de ${label(nom, entreprise)} - ${raison || 'appel'}`,
    body,
    personId: session.personId,
  });

  let emailed = false;
  try {
    emailed = await sendMessageEmail({
      nom: label(nom, entreprise),
      numeroRappel: numero,
      sujet: raison,
      message,
      afterHours,
    });
  } catch (err) {
    error('tools', 'Envoi du courriel echoue', err);
  }

  const sms = `Message Balgio - ${label(nom, entreprise)}. ${statut}. Raison: ${raison || 'non precisee'}. Rappeler au ${numero}.`;
  await sendSms(routeTo(session, existing), sms);

  session.callSummary = `Message (${statut}). ${label(nom, entreprise)}. Raison: ${raison}. Rappel: ${numero}.`;
  session.callOutcome = 'CONNECTED';

  const suffix = emailed ? ' Le message a ete envoye par courriel.' : ' Le message est enregistre dans le CRM.';
  return { result: `Message enregistre.${suffix} L'equipe a ete alertee.` };
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
