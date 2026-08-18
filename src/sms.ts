import { config } from './config.js';
import { log, warn } from './util/logger.js';

/**
 * Envoie un SMS via l'API Twilio vers `to`. Retourne false (sans lever) si
 * Twilio n'est pas configure ou en cas d'echec, pour degrader gracieusement.
 */
export async function sendSms(to: string, body: string): Promise<boolean> {
  const { accountSid, authToken, fromNumber } = config.twilio;
  if (!accountSid || !authToken || !fromNumber || !to) {
    warn('sms', 'Twilio SMS non configure: SMS non envoye.');
    return false;
  }
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: fromNumber, Body: body }).toString(),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      warn('sms', `Echec Twilio ${res.status}`, text.slice(0, 200));
      return false;
    }
    log('sms', `SMS envoye a ${to}`);
    return true;
  } catch (err) {
    warn('sms', 'Erreur envoi SMS', err);
    return false;
  }
}

/** Demarre l'enregistrement d'un appel via l'API Twilio (les deux directions). */
export async function startCallRecording(callSid: string, statusCallbackUrl: string): Promise<void> {
  const { accountSid, authToken } = config.twilio;
  if (!accountSid || !authToken || !callSid) return;
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}/Recordings.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          RecordingStatusCallback: statusCallbackUrl,
          RecordingStatusCallbackEvent: 'completed',
          RecordingChannels: 'dual',
        }).toString(),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) warn('rec', `Echec demarrage enregistrement ${res.status}`, (await res.text()).slice(0, 150));
    else log('rec', `Enregistrement demarre pour ${callSid}`);
  } catch (err) {
    warn('rec', 'Erreur demarrage enregistrement', err);
  }
}

/** Telecharge le mp3 d'un enregistrement Twilio (avec authentification). */
export async function downloadRecording(recordingUrl: string): Promise<Buffer | null> {
  const { accountSid, authToken } = config.twilio;
  if (!accountSid || !authToken || !recordingUrl) return null;
  try {
    const res = await fetch(`${recordingUrl}.mp3`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      warn('rec', `Telechargement enregistrement ${res.status}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    warn('rec', 'Erreur telechargement enregistrement', err);
    return null;
  }
}
