import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { error, log } from '../util/logger.js';
import { ensurePerson } from '../twenty/people.js';
import { createFollowUpTask, createMeeting } from '../twenty/records.js';

export type ToolControl =
  | { kind: 'transfer'; to: string; reason: string }
  | { kind: 'hangup'; reason: string };

export type ToolOutcome = {
  /** Texte renvoye au modele comme resultat d'outil. */
  result: string;
  /** Action de controle a executer apres le tour de parole (transfert/raccroché). */
  control?: ToolControl;
};

/** Etat de session accessible aux outils. */
export interface ToolSession {
  phoneE164: string;
  personId?: string;
  callSummary?: string;
  callOutcome?: string;
}

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'prendre_message',
    description:
      "Enregistre un message ou les coordonnees d'un client potentiel dans le CRM et cree une tache de suivi pour l'equipe. A utiliser quand l'appelant veut laisser un message ou etre rappele.",
    input_schema: {
      type: 'object',
      properties: {
        nom: { type: 'string', description: "Nom complet de l'appelant." },
        numero_rappel: {
          type: 'string',
          description: 'Numero de rappel dicte par l appelant. Laisse vide pour utiliser le numero affiche.',
        },
        sujet: { type: 'string', description: "Objet de l'appel en quelques mots." },
        message: { type: 'string', description: 'Message detaille a transmettre a l equipe.' },
        urgent: { type: 'boolean', description: 'Vrai si l appelant indique que c est urgent.' },
      },
      required: ['nom', 'sujet', 'message'],
    },
  },
  {
    name: 'prendre_rendez_vous',
    description:
      "Fixe un rendez-vous dans le CRM. A utiliser quand l'appelant veut planifier une rencontre. L'equipe confirmera ensuite par courriel.",
    input_schema: {
      type: 'object',
      properties: {
        nom: { type: 'string', description: "Nom complet de l'appelant." },
        courriel: { type: 'string', description: 'Courriel de l appelant si fourni.' },
        date_heure_iso: {
          type: 'string',
          description:
            'Date et heure de debut au format ISO 8601 avec decalage horaire, ex 2026-08-12T14:00:00-04:00.',
        },
        duree_minutes: { type: 'number', description: 'Duree en minutes. 30 par defaut.' },
        sujet: { type: 'string', description: 'Sujet ou raison du rendez-vous.' },
      },
      required: ['nom', 'date_heure_iso', 'sujet'],
    },
  },
  {
    name: 'transferer_appel',
    description:
      "Transfere l'appel vers une personne de l'equipe. A utiliser quand l'appelant demande a parler a un humain ou quand la demande depasse ce que tu peux traiter. Dis d'abord une courte phrase a l'appelant, puis appelle cet outil.",
    input_schema: {
      type: 'object',
      properties: {
        raison: { type: 'string', description: 'Raison du transfert, pour le journal.' },
      },
      required: ['raison'],
    },
  },
  {
    name: 'terminer_appel',
    description:
      "Termine et raccroche l'appel proprement une fois le besoin traite. Dis d'abord au revoir a l'appelant, puis appelle cet outil avec un resume clair pour l'equipe.",
    input_schema: {
      type: 'object',
      properties: {
        resume: { type: 'string', description: 'Resume de l appel et de ce qui a ete convenu.' },
        disposition: {
          type: 'string',
          enum: [
            'message_pris',
            'rendez_vous',
            'rappel_demande',
            'information_donnee',
            'pas_interesse',
            'ne_pas_rappeler',
          ],
          description: 'Issue de l appel.',
        },
        rappel_requis: { type: 'boolean', description: 'Vrai si un rappel de l equipe est attendu.' },
      },
      required: ['resume', 'disposition'],
    },
  },
];

const DISPOSITION_TO_OUTCOME: Record<string, string> = {
  message_pris: 'CONNECTED',
  rendez_vous: 'RENCONTRE',
  rappel_demande: 'INTERESSE_RAPPEL',
  information_donnee: 'CONNECTED',
  pas_interesse: 'PAS_INTERESSE',
  ne_pas_rappeler: 'NE_PAS_APPELER',
};

function frenchDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: config.business.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(d);
}

async function handlePrendreMessage(
  args: Record<string, unknown>,
  session: ToolSession,
): Promise<ToolOutcome> {
  const nom = String(args.nom ?? '').trim();
  const numero = String(args.numero_rappel ?? '').trim() || session.phoneE164;
  const sujet = String(args.sujet ?? '').trim();
  const message = String(args.message ?? '').trim();
  const urgent = Boolean(args.urgent);

  const person = await ensurePerson(numero, nom);
  if (person) session.personId = person.id;

  const body = [
    `Message telephonique recu par ${config.business.assistant}.`,
    ``,
    `Nom: ${nom || 'non fourni'}`,
    `Numero de rappel: ${numero}`,
    `Objet: ${sujet || 'non precise'}`,
    urgent ? `Priorite: URGENT` : '',
    ``,
    message,
  ]
    .filter((line) => line !== '')
    .join('\n');

  await createFollowUpTask({
    title: `${urgent ? '[URGENT] ' : ''}Message de ${nom || 'appelant'} - ${sujet || 'appel'}`,
    body,
    personId: person?.id,
  });

  return {
    result: `Message enregistre et tache de suivi creee pour l'equipe${urgent ? ' (marquee urgente)' : ''}. Numero de rappel note: ${numero}.`,
  };
}

async function handlePrendreRendezVous(
  args: Record<string, unknown>,
  session: ToolSession,
): Promise<ToolOutcome> {
  const nom = String(args.nom ?? '').trim();
  const courriel = String(args.courriel ?? '').trim();
  const sujet = String(args.sujet ?? '').trim();
  const startIso = String(args.date_heure_iso ?? '').trim();
  const duree = Number(args.duree_minutes) > 0 ? Number(args.duree_minutes) : 30;

  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) {
    return { result: "La date fournie est invalide. Redemande la date et l'heure a l'appelant." };
  }
  const endIso = new Date(start.getTime() + duree * 60_000).toISOString();

  const person = await ensurePerson(session.phoneE164, nom, courriel || undefined);
  if (person) session.personId = person.id;

  await createMeeting({
    name: `Rendez-vous - ${sujet || nom || 'appel entrant'}`,
    startsAt: start.toISOString(),
    endsAt: endIso,
    personId: person?.id,
    attendeeEmail: courriel || undefined,
    summary: `Demande par telephone via ${config.business.assistant}. Sujet: ${sujet}.`,
  });

  return {
    result: `Rendez-vous inscrit au CRM pour le ${frenchDateTime(startIso)} (${duree} minutes). Confirme a l'appelant que l'equipe validera par courriel.`,
  };
}

function handleTransfer(args: Record<string, unknown>, session: ToolSession): ToolOutcome {
  const raison = String(args.raison ?? 'demande de l appelant').trim();
  const to = config.business.transferNumber;
  if (!to) {
    return {
      result:
        "Aucun numero de transfert n'est configure. Propose plutot de prendre un message avec prendre_message.",
    };
  }
  session.callSummary = `Transfert vers un humain. Raison: ${raison}.`;
  session.callOutcome = 'CONNECTED';
  return {
    result: 'Transfert autorise. Dis une courte phrase de mise en relation, puis laisse le transfert se faire.',
    control: { kind: 'transfer', to, reason: raison },
  };
}

function handleTerminer(args: Record<string, unknown>, session: ToolSession): ToolOutcome {
  const resume = String(args.resume ?? '').trim();
  const disposition = String(args.disposition ?? 'information_donnee');
  session.callSummary = resume;
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
      case 'prendre_message':
        return await handlePrendreMessage(args, session);
      case 'prendre_rendez_vous':
        return await handlePrendreRendezVous(args, session);
      case 'transferer_appel':
        return handleTransfer(args, session);
      case 'terminer_appel':
        return handleTerminer(args, session);
      default:
        return { result: `Outil inconnu: ${name}.` };
    }
  } catch (err) {
    error('tools', `Echec de l'outil ${name}`, err);
    log('tools', 'Degradation gracieuse: le modele en est informe.');
    return {
      result:
        "Le systeme CRM est momentanement indisponible. Continue quand meme: prends l'information a l'oral, rassure l'appelant et propose un suivi ou un transfert.",
    };
  }
}
