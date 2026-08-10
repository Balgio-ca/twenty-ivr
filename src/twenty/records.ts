import { log } from '../util/logger.js';
import { twenty } from './client.js';

/** Journalise l'appel dans l'objet natif `calls` de Twenty. */
export async function logCall(input: {
  callSid: string;
  phoneNumber: string;
  personId?: string;
  name: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  transcript: string;
  summary?: string;
  notes?: string;
  outcome?: string;
}): Promise<{ id: string } | null> {
  if (!twenty.enabled) return null;
  const body: Record<string, unknown> = {
    twilioCallSid: input.callSid,
    direction: 'INBOUND',
    phoneNumber: input.phoneNumber,
    name: input.name,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationSeconds: Math.max(0, Math.round(input.durationSeconds)),
    transcript: input.transcript,
    outcome: input.outcome ?? 'CONNECTED',
  };
  if (input.personId) body.personId = input.personId;
  if (input.summary) body.summary = input.summary;
  if (input.notes) body.notes = input.notes;
  const call = await twenty.post<{ id: string }>('/calls', body);
  log('twenty', `Appel journalise ${call.id}`);
  return call;
}

/** Cree un rendez-vous (objet `meetings`, libelle "Rendez-vous"). */
export async function createMeeting(input: {
  name: string;
  startsAt: string;
  endsAt: string;
  personId?: string;
  attendeeEmail?: string;
  summary?: string;
}): Promise<{ id: string } | null> {
  if (!twenty.enabled) return null;
  const body: Record<string, unknown> = {
    name: input.name,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    status: 'BOOKED',
  };
  if (input.personId) body.personId = input.personId;
  if (input.attendeeEmail) body.attendeeEmail = input.attendeeEmail;
  if (input.summary) body.summary = input.summary;
  const meeting = await twenty.post<{ id: string }>('/meetings', body);
  log('twenty', `Rendez-vous cree ${meeting.id}`);
  return meeting;
}

/** Cree une note et la rattache a la fiche du contact via un noteTarget. */
export async function createNoteOnPerson(input: {
  personId: string;
  title: string;
  body: string;
}): Promise<{ id: string } | null> {
  if (!twenty.enabled) return null;
  const note = await twenty.post<{ id: string }>('/notes', {
    title: input.title,
    bodyV2: { markdown: input.body },
  });
  try {
    await twenty.post('/noteTargets', { noteId: note.id, personId: input.personId });
  } catch (err) {
    log('twenty', `noteTarget non cree pour ${note.id}`, err);
  }
  log('twenty', `Note creee ${note.id}`);
  return note;
}

/** Cree une tache de suivi et la rattache au contact via un taskTarget. */
export async function createFollowUpTask(input: {
  title: string;
  body: string;
  personId?: string;
  dueAt?: string;
}): Promise<{ id: string } | null> {
  if (!twenty.enabled) return null;
  const task = await twenty.post<{ id: string }>('/tasks', {
    title: input.title,
    bodyV2: { markdown: input.body },
    status: 'TODO',
    ...(input.dueAt ? { dueAt: input.dueAt } : {}),
  });
  if (input.personId) {
    try {
      await twenty.post('/taskTargets', { taskId: task.id, personId: input.personId });
    } catch (err) {
      log('twenty', `taskTarget non cree pour ${task.id}`, err);
    }
  }
  log('twenty', `Tache creee ${task.id}`);
  return task;
}
