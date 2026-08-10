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
