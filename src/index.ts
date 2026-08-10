import { createServer } from 'node:http';
import express, { type Request } from 'express';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';

import { config } from './config.js';
import { RelaySession } from './relay/session.js';
import { connectTwiml, hangupTwiml, messageGreeting, transferTwiml } from './twiml.js';
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
});

// Action de fin de session ConversationRelay (transfert ou raccroché).
app.post('/twiml/action', (req, res) => {
  if (!twilioSignatureValid(req)) {
    res.status(403).type('text/xml').send(hangupTwiml());
    return;
  }
  let handoff: { action?: string; to?: string; who?: string } = {};
  const raw = (req.body?.HandoffData as string) ?? '';
  try {
    if (raw) handoff = JSON.parse(raw);
  } catch {
    warn('http', 'HandoffData illisible');
  }
  log('http', `Fin de session ConversationRelay, action=${handoff.action ?? 'aucune'}`);
  if (handoff.action === 'transfer' && handoff.to) {
    const base = publicBase(req);
    const whoQuery = handoff.who ? `?who=${encodeURIComponent(handoff.who)}` : '';
    log('http', `Transfert vers ${handoff.to}`);
    res.type('text/xml').send(transferTwiml(handoff.to, `${base}/twiml/dial-status${whoQuery}`));
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
  log('http', `Resultat du transfert: ${status}`);
  if (status === 'completed' || status === 'answered') {
    res.type('text/xml').send(hangupTwiml());
    return;
  }
  const who = (req.query?.who as string) || '';
  const base = publicBase(req);
  // Chemin dedie: le mode "message" est derive du chemin, fiable cote Twilio.
  const wssUrl = `${base.replace(/^http/, 'ws')}/relay-message`;
  const actionUrl = `${base}/twiml/action`;
  res.type('text/xml').send(
    connectTwiml(wssUrl, actionUrl, { greeting: messageGreeting(who || undefined) }),
  );
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
