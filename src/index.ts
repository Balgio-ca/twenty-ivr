import { createServer } from 'node:http';
import express, { type Request } from 'express';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';

import { config } from './config.js';
import { RelaySession } from './relay/session.js';
import { connectTwiml, hangupTwiml, transferTwiml } from './twiml.js';
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
  let handoff: { action?: string; to?: string } = {};
  const raw = (req.body?.HandoffData as string) ?? '';
  try {
    if (raw) handoff = JSON.parse(raw);
  } catch {
    warn('http', 'HandoffData illisible');
  }
  if (handoff.action === 'transfer' && handoff.to) {
    log('http', `Transfert vers ${handoff.to}`);
    res.type('text/xml').send(transferTwiml(handoff.to));
    return;
  }
  res.type('text/xml').send(hangupTwiml('Merci de votre appel. Au revoir.'));
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { url } = request;
  if (!url || new URL(url, 'http://localhost').pathname !== '/relay') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  const session = new RelaySession(ws);
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
