import { createServer } from 'node:http';
import express, { type Request } from 'express';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';

import { config } from './config.js';
import { RelaySession } from './relay/session.js';
import { downloadRecording } from './sms.js';
import { attachRecording } from './twenty/records.js';
import { sendRecordingEmail } from './email.js';
import {
  acceptTwiml,
  connectTwiml,
  hangupTwiml,
  messageGreeting,
  transferTwiml,
  whisperTwiml,
} from './twiml.js';
import { error, log, warn } from './util/logger.js';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/** Base publique (https) du service, deduite de la requete si non configuree. */
function publicBase(req: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || `localhost:${config.port}`;
  return `${proto}://${host}`;
}

/** Valide la signature Twilio quand un auth token est configure. */
function twilioSignatureValid(req: Request): boolean {
  if (!config.twilio.validateSignature || !config.twilio.authToken) return true;
  const signature = req.header('X-Twilio-Signature') ?? '';
  const url = `${publicBase(req)}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, string>;
  const ok = twilio.validateRequest(config.twilio.authToken, signature, url, params);
  if (!ok) warn('http', `Signature Twilio invalide pour ${req.originalUrl}`);
  return ok;
}

// Transferts filtres acceptes (cle: CallSid de l'appelant). La personne a
// appuye sur 1 pour prendre l'appel; sinon on renvoie l'appelant vers Gio.
const acceptedTransfers = new Map<string, number>();
function markTransferAccepted(callSid: string): void {
  acceptedTransfers.set(callSid, Date.now() + 5 * 60_000);
}
function consumeTransferAccepted(callSid: string): boolean {
  const exp = acceptedTransfers.get(callSid);
  acceptedTransfers.delete(callSid);
  const now = Date.now();
  for (const [k, v] of acceptedTransfers) if (v < now) acceptedTransfers.delete(k);
  return exp !== undefined && exp > now;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'twenty-ivr', crm: Boolean(config.twenty.apiKey) });
});

// Webhook voix de Twilio: renvoie le TwiML qui ouvre ConversationRelay.
app.post('/twiml/voice', (req, res) => {
  if (!twilioSignatureValid(req)) {
    res.status(403).type('text/xml').send(hangupTwiml());
    return;
  }
  const base = publicBase(req);
  const wssUrl = `${base.replace(/^http/, 'ws')}/relay`;
  const actionUrl = `${base}/twiml/action`;
  log('http', `Nouvel appel -> ConversationRelay ${wssUrl}`);
  res.type('text/xml').send(connectTwiml(wssUrl, actionUrl));
  // L'enregistrement demarre a la connexion du websocket (media etabli), pas
  // ici (sinon Twilio renvoie 21220 "not eligible"). Voir RelaySession.
});

// Twilio notifie quand l'enregistrement est pret: on l'attache a l'appel Twenty.
app.post('/twiml/recording-status', (req, res) => {
  if (!twilioSignatureValid(req)) {
    res.status(403).end();
    return;
  }
  const callSid = (req.body?.CallSid as string) ?? '';
  const url = (req.body?.RecordingUrl as string) ?? '';
  const duration = (req.body?.RecordingDuration as string) ?? '?';
  log('http', `Enregistrement pret pour ${callSid}`);
  res.type('text/xml').send('<Response/>');
  if (!callSid || !url) return;

  // En arriere-plan: attacher au CRM + envoyer le mp3 par courriel.
  void (async () => {
    const info = await attachRecording(callSid, url).catch(() => null);
    const audio = await downloadRecording(url);
    if (!audio) return;
    const label = info?.name || info?.phoneNumber || callSid;
    await sendRecordingEmail({
      subject: `Enregistrement d'appel - ${label}`,
      text: [
        `Enregistrement de l'appel entrant.`,
        info?.phoneNumber ? `Numero: ${info.phoneNumber}` : '',
        `Duree: ${duration} secondes.`,
        `Lien Twilio: ${url}`,
      ]
        .filter(Boolean)
        .join('\n'),
      filename: `appel-${callSid}.mp3`,
      content: audio,
    });
  })();
});

// Action de fin de session ConversationRelay (transfert ou raccroché).
app.post('/twiml/action', (req, res) => {
  if (!twilioSignatureValid(req)) {
    res.status(403).type('text/xml').send(hangupTwiml());
    return;
  }
  let handoff: { action?: string; to?: string; who?: string; caller?: string; reason?: string } = {};
  const raw = (req.body?.HandoffData as string) ?? '';
  try {
    if (raw) handoff = JSON.parse(raw);
  } catch {
    warn('http', 'HandoffData illisible');
  }
  log('http', `Fin de session ConversationRelay, action=${handoff.action ?? 'aucune'}`);
  if (handoff.action === 'transfer' && handoff.to) {
    const base = publicBase(req);
    const callerCallSid = (req.body?.CallSid as string) ?? '';
    const dialAction = `${base}/twiml/dial-status?who=${encodeURIComponent(handoff.who ?? '')}`;
    const whisper = `${base}/twiml/whisper?${new URLSearchParams({
      caller: handoff.caller ?? '',
      reason: handoff.reason ?? '',
      accept: callerCallSid,
    }).toString()}`;
    log('http', `Transfert filtre vers ${handoff.to}`);
    res.type('text/xml').send(transferTwiml(handoff.to, dialAction, whisper));
    return;
  }
  res.type('text/xml').send(hangupTwiml('Merci de votre appel. Au revoir.'));
});

// Resultat du transfert: si personne n'a repondu, Gio reprend la ligne pour
// prendre un message; sinon on raccroche.
app.post('/twiml/dial-status', (req, res) => {
  if (!twilioSignatureValid(req)) {
    res.status(403).type('text/xml').send(hangupTwiml());
    return;
  }
  const status = (req.body?.DialCallStatus as string) ?? '';
  const callerCallSid = (req.body?.CallSid as string) ?? '';
  log('http', `Resultat du transfert: ${status}`);
  // La personne a accepte (appuye sur 1) et a parle avec l'appelant: on raccroche.
  if (consumeTransferAccepted(callerCallSid)) {
    res.type('text/xml').send(hangupTwiml());
    return;
  }
  // Non accepte (decline, boite vocale, pas de reponse): Gio prend un message.
  const who = (req.query?.who as string) || '';
  const base = publicBase(req);
  // Chemin dedie: le mode "message" est derive du chemin, fiable cote Twilio.
  const wssUrl = `${base.replace(/^http/, 'ws')}/relay-message`;
  const actionUrl = `${base}/twiml/action`;
  res.type('text/xml').send(
    connectTwiml(wssUrl, actionUrl, { greeting: messageGreeting(who || undefined) }),
  );
});

// Chuchotement a la personne appelee (elle doit appuyer sur 1 pour accepter).
app.post('/twiml/whisper', (req, res) => {
  if (!twilioSignatureValid(req)) {
    res.status(403).type('text/xml').send(hangupTwiml());
    return;
  }
  const caller = (req.query?.caller as string) || '';
  const reason = (req.query?.reason as string) || '';
  const accept = (req.query?.accept as string) || '';
  const acceptUrl = `${publicBase(req)}/twiml/accept?accept=${encodeURIComponent(accept)}`;
  res.type('text/xml').send(whisperTwiml(caller, reason, acceptUrl));
});

// La personne a compose une touche pendant le chuchotement.
app.post('/twiml/accept', (req, res) => {
  if (!twilioSignatureValid(req)) {
    res.status(403).type('text/xml').send(hangupTwiml());
    return;
  }
  const accept = (req.query?.accept as string) || '';
  const digits = (req.body?.Digits as string) || '';
  if (digits === '1' && accept) {
    markTransferAccepted(accept);
    log('http', `Transfert accepte (${accept})`);
    res.type('text/xml').send(acceptTwiml());
    return;
  }
  res.type('text/xml').send(hangupTwiml());
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

const RELAY_PATHS = new Set(['/relay', '/relay-message']);

server.on('upgrade', (request, socket, head) => {
  const { url } = request;
  const pathname = url ? new URL(url, 'http://localhost').pathname : '';
  if (!RELAY_PATHS.has(pathname)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, request) => {
  const pathname = new URL(request?.url ?? '', 'http://localhost').pathname;
  const mode = pathname === '/relay-message' ? 'message' : undefined;
  log('ws', `Connexion ${pathname}${mode ? ' [message]' : ''}`);
  const session = new RelaySession(ws, { mode });
  ws.on('message', (data) => {
    void session.onMessage(data.toString());
  });
  ws.on('close', () => {
    void session.onClose();
  });
  ws.on('error', (err) => {
    error('ws', 'Erreur websocket', err);
  });
});

function checkConfig(): void {
  if (!config.anthropic.apiKey) warn('config', 'ANTHROPIC_API_KEY manquant: Claude ne repondra pas.');
  if (!config.twenty.apiKey) warn('config', 'TWENTY_API_KEY manquant: rien ne sera ecrit dans le CRM.');
  if (!config.business.transferExisting && !config.business.transferNew)
    warn('config', 'Aucun numero de transfert configure: transferts desactives.');
  if (!config.twilio.accountSid) warn('config', 'TWILIO_ACCOUNT_SID manquant: SMS desactives.');
}

server.listen(config.port, () => {
  checkConfig();
  log('http', `twenty-ivr en ecoute sur le port ${config.port}`);
  log('http', `Webhook voix Twilio: POST /twiml/voice`);
});
