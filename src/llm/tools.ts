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
  | { kind: 'hangup'; reason: string };

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
  callSummary?: string;
  callOutcome?: string;
}

/** Numero vers lequel router selon le statut client. */
function routeTo(session: ToolSession): string {
  return session.existingClient ? config.business.transferExisting : config.business.transferNew;
}

const CALLER_FIELDS = {
  prenom: { type: 'string', description: "Prenom de l'appelant." },
  nom: { type: 'string', description: "Nom de famille de l'appelant." },
  entreprise: { type: 'string', description: "Nom de l'entreprise de l'appelant, si applicable." },
  raison: { type: 'string', description: "Raison de l'appel, en quelques mots." },
} as const;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'transferer_appel',
    description:
      "Transfere l'appel a la bonne personne de l'equipe (pendant les heures d'ouverture). Un client existant est achemine a Mathieu, un nouveau contact a Alexandre. Recueille d'abord le prenom, le nom, l'entreprise et la raison de l'appel, dis une courte phrase de mise en relation, puis appelle cet outil. Il envoie aussi une alerte SMS a la personne concernee.",
    input_schema: {
      type: 'object',
      properties: { ...CALLER_FIELDS },
      required: ['prenom', 'nom', 'raison'],
    },
  },
  {
    name: 'prendre_message',
    description:
      "Enregistre un message, l'envoie par courriel a l'equipe et alerte la personne concernee par SMS. A utiliser hors des heures d'ouverture, ou quand l'appelant prefere laisser un message. Recueille d'abord le prenom, le nom, l'entreprise, la raison et un numero de rappel.",
    input_schema: {
      type: 'object',
      properties: {
        ...CALLER_FIELDS,
        numero_rappel: {
          type: 'string',
          description: 'Numero de rappel. Laisse vide pour utiliser le numero affiche.',
        },
        message: { type: 'string', description: 'Details du message a transmettre.' },
      },
      required: ['prenom', 'nom', 'raison'],
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

function callerLabel(prenom: string, nom: string, entreprise: string): string {
  const nomComplet = [prenom, nom].filter(Boolean).join(' ').trim() || 'Appelant';
  return entreprise ? `${nomComplet} (${entreprise})` : nomComplet;
}

async function handleTransfer(
  args: Record<string, unknown>,
  session: ToolSession,
): Promise<ToolOutcome> {
  const prenom = String(args.prenom ?? '').trim();
  const nom = String(args.nom ?? '').trim();
  const entreprise = String(args.entreprise ?? '').trim();
  const raison = String(args.raison ?? '').trim();

  const target = routeTo(session);
  if (!isBusinessOpen() || !target) {
    return {
      result:
        "Personne n'est disponible pour l'instant (hors des heures). Ne transfere pas. Prends plutot un message avec prendre_message.",
    };
  }

  const person = await ensurePerson(session.phoneE164, `${prenom} ${nom}`.trim());
  if (person) session.personId = person.id;

  const statut = session.existingClient ? 'Client existant' : 'Nouveau contact';
  const sms = `Appel Balgio - ${callerLabel(prenom, nom, entreprise)}. ${statut}. Raison: ${raison || 'non precisee'}. Transfert en cours.`;
  await sendSms(target, sms);

  session.callSummary = `Transfert (${statut}) vers ${target}. ${callerLabel(prenom, nom, entreprise)}. Raison: ${raison}.`;
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
  const prenom = String(args.prenom ?? '').trim();
  const nom = String(args.nom ?? '').trim();
  const entreprise = String(args.entreprise ?? '').trim();
  const raison = String(args.raison ?? '').trim();
  const numero = String(args.numero_rappel ?? '').trim() || session.phoneE164;
  const message = String(args.message ?? '').trim() || raison;
  const afterHours = !isBusinessOpen();

  const person = await ensurePerson(numero, `${prenom} ${nom}`.trim());
  if (person) session.personId = person.id;

  const statut = session.existingClient ? 'Client existant' : 'Nouveau contact';
  const body = [
    `Message telephonique pris par ${config.business.assistant}.`,
    ``,
    `Appelant: ${callerLabel(prenom, nom, entreprise)}`,
    `Statut: ${statut}`,
    `Numero de rappel: ${numero}`,
    `Raison: ${raison || 'non precisee'}`,
    ``,
    message,
  ].join('\n');

  await createFollowUpTask({
    title: `Message de ${callerLabel(prenom, nom, entreprise)} - ${raison || 'appel'}`,
    body,
    personId: person?.id,
  });

  let emailed = false;
  try {
    emailed = await sendMessageEmail({
      nom: callerLabel(prenom, nom, entreprise),
      numeroRappel: numero,
      sujet: raison,
      message,
      afterHours,
    });
  } catch (err) {
    error('tools', 'Envoi du courriel echoue', err);
  }

  const sms = `Message Balgio - ${callerLabel(prenom, nom, entreprise)}. ${statut}. Raison: ${raison || 'non precisee'}. Rappeler au ${numero}.`;
  await sendSms(routeTo(session), sms);

  session.callSummary = `Message (${statut}). ${callerLabel(prenom, nom, entreprise)}. Raison: ${raison}. Rappel: ${numero}.`;
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
