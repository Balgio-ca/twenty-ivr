import { config } from './config.js';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attr(name: string, value: string | boolean | undefined): string {
  if (value === undefined || value === '' || value === false) return '';
  const v = value === true ? 'true' : escapeXml(String(value));
  return ` ${name}="${v}"`;
}

/** Message d'accueil parle automatiquement par ConversationRelay. */
export function welcomeGreeting(): string {
  const { name, assistant } = config.business;
  return `Bonjour et bienvenue chez ${name}. Je suis ${assistant}, l'assistant virtuel de l'agence. Comment puis-je vous aider aujourd'hui?`;
}

/** TwiML qui connecte l'appel au websocket ConversationRelay. */
export function connectTwiml(wssUrl: string, actionUrl: string): string {
  const r = config.relay;
  const relayAttrs =
    attr('url', wssUrl) +
    attr('welcomeGreeting', welcomeGreeting()) +
    attr('language', r.language) +
    attr('ttsProvider', r.ttsProvider) +
    attr('voice', r.voice) +
    attr('transcriptionProvider', r.transcriptionProvider) +
    attr('speechModel', r.speechModel) +
    attr('interruptible', r.interruptible) +
    attr('dtmfDetection', true);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Connect${attr('action', actionUrl)}>`,
    `    <ConversationRelay${relayAttrs} />`,
    '  </Connect>',
    '</Response>',
  ].join('\n');
}

/** TwiML de transfert vers une personne de l'equipe. */
export function transferTwiml(to: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Say language="${config.relay.language}">Je vous mets en relation, un instant.</Say>`,
    `  <Dial>${escapeXml(to)}</Dial>`,
    '</Response>',
  ].join('\n');
}

/** TwiML de fin d'appel. */
export function hangupTwiml(message?: string): string {
  const say = message
    ? `  <Say language="${config.relay.language}">${escapeXml(message)}</Say>\n`
    : '';
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>', say + '  <Hangup/>', '</Response>'].join(
    '\n',
  );
}
