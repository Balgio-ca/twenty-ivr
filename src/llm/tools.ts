import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { sendMessageEmail } from '../email.js';
import { error, log } from '../util/logger.js';
import { isBusinessOpen } from '../util/hours.js';
import { ensurePerson } from '../twenty/people.js';
import { createFollowUpTask } from '../twenty/records.js';

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
      "Enregistre un message et l'envoie par courriel a l'equipe. A utiliser quand l'appelant veut laisser un message, etre rappele, ou quand personne n'est disponible pour prendre l'appel.",
    input_schema: {
      type: 'object',
      properties: {
        nom: { type: 'string', description: "Nom complet de l'appelant." },
        numero_rappel: {
          type: 'string',
          description: 'Numero de rappel dicte par l appelant. Laisse vide pour utiliser le numero affiche.',
        },
        sujet: { type: 'string', description: "Objet de l'appel en quelques mots." },
        message: { type: 'string', description: 'Message a transmettre a l equipe.' },
      },
      required: ['nom', 'sujet', 'message'],
    },
  },
  {
    name: 'transferer_appel',
    description:
      "Transfere l'appel vers l'equipe. A utiliser, pendant les heures d'ouverture seulement, quand l'appelant veut parler a une personne ou discuter d'un projet. Dis d'abord une courte phrase de mise en relation, puis appelle cet outil.",
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
      "Termine et raccroche l'appel une fois le besoin traite. Dis d'abord au revoir, puis appelle cet outil avec un resume clair pour l'equipe.",
    input_schema: {
      type: 'object',
      properties: {
        resume: { type: 'string', description: 'Resume de l appel et de ce qui a ete convenu.' },
        disposition: {
          type: 'string',
          enum: [
            'information_donnee',
            'message_pris',
            'transfere',
            'rappel_demande',
            'pas_interesse',
            'ne_pas_rappeler',
          ],
          description: 'Issue de l appel.',
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
  rappel_demande: 'INTERESSE_RAPPEL',
  pas_interesse: 'PAS_INTERESSE',
  ne_pas_rappeler: 'NE_PAS_APPELER',
};

async function handlePrendreMessage(
  args: Record<string, unknown>,
  session: ToolSession,
): Promise<ToolOutcome> {
  const nom = String(args.nom ?? '').trim();
  const numero = String(args.numero_rappel ?? '').trim() || session.phoneE164;
  const sujet = String(args.sujet ?? '').trim();
  const message = String(args.message ?? '').trim();
  const afterHours = !isBusinessOpen();

  const person = await ensurePerson(numero, nom);
  if (person) session.personId = person.id;

  const body = [
    `Message telephonique pris par ${config.business.assistant}.`,
    ``,
    `Nom: ${nom || 'non fourni'}`,
    `Numero de rappel: ${numero}`,
    `Objet: ${sujet || 'non precise'}`,
    ``,
    message,
  ].join('\n');

  await createFollowUpTask({
    title: `Message de ${nom || 'appelant'} - ${sujet || 'appel'}`,
    body,
    personId: person?.id,
  });

  let emailed = false;
  try {
    emailed = await sendMessageEmail({ nom, numeroRappel: numero, sujet, message, afterHours });
  } catch (err) {
    error('tools', 'Envoi du courriel echoue', err);
  }

  const suffix = emailed
    ? ' Le message a ete envoye par courriel a l equipe.'
    : ' Le message est enregistre dans le CRM pour l equipe.';
  return {
    result: `Message enregistre.${suffix} Numero de rappel note: ${numero}.`,
  };
}

function handleTransfer(args: Record<string, unknown>, session: ToolSession): ToolOutcome {
  const raison = String(args.raison ?? 'demande de l appelant').trim();

  if (!isBusinessOpen() || !config.business.transferNumber) {
    return {
      result:
        "Personne n'est disponible pour l'instant (hors des heures d'ouverture). Ne transfere pas. Propose plutot de prendre un message avec prendre_message; il sera envoye par courriel.",
    };
  }

  session.callSummary = `Transfert vers l'equipe. Raison: ${raison}.`;
  session.callOutcome = 'CONNECTED';
  return {
    result: 'Transfert autorise. Dis une courte phrase de mise en relation, puis laisse le transfert se faire.',
    control: { kind: 'transfer', to: config.business.transferNumber, reason: raison },
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
        "Le systeme est momentanement indisponible. Continue quand meme: prends l'information a l'oral et rassure l'appelant.",
    };
  }
}
