import { config } from './config.js';
import { activeTts } from './tts-health.js';

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
  return `Bonjour, ici ${assistant}, l'assistant virtuel de ${name}. Comment puis-je vous aider aujourd'hui ?`;
}

/** Accueil quand on reprend la ligne apres un transfert sans reponse. */
export function messageGreeting(who?: string): string {
  const nom = who && who.trim() ? who.trim() : 'la personne';
  return `Désolé, il semble que ${nom} ne soit pas disponible pour le moment. Je peux prendre un message et nous vous rappellerons rapidement. Quelle est la raison de votre appel?`;
}

/** TwiML qui connecte l'appel au websocket ConversationRelay. */
export function connectTwiml(
  wssUrl: string,
  actionUrl: string,
  opts?: { greeting?: string; parameters?: Record<string, string> },
): string {
  const r = config.relay;
  // Fournisseur/voix actifs (primaire ElevenLabs, ou repli Amazon si en echec).
  const tts = activeTts();
  const relayAttrs =
    attr('url', wssUrl) +
    attr('welcomeGreeting', opts?.greeting ?? welcomeGreeting()) +
    attr('language', r.language) +
    attr('ttsProvider', tts.provider) +
    attr('voice', tts.voice) +
    attr('transcriptionProvider', r.transcriptionProvider) +
    attr('speechModel', r.speechModel) +
    attr('interruptible', r.interruptible) +
    attr('welcomeGreetingInterruptible', r.welcomeGreetingInterruptible) +
    attr('dtmfDetection', true);

  // Voix pour l'anglais (bascule en cours d'appel). On declare le francais et
  // l'anglais comme langues disponibles.
  const languages: string[] = [];
  if (r.bilingual && r.languageEn) {
    languages.push(
      `    <Language${attr('code', r.language)}${attr('ttsProvider', tts.provider)}${attr('voice', tts.voice)} />`,
      `    <Language${attr('code', r.languageEn)}${attr('ttsProvider', tts.provider)}${attr('voice', tts.voiceEn)} />`,
    );
  }

  // Parametres livres dans le message setup du websocket (ex: mode=message).
  const params = Object.entries(opts?.parameters ?? {}).map(
    ([name, value]) => `    <Parameter${attr('name', name)}${attr('value', value)} />`,
  );

  const children = [...languages, ...params];
  const relayEl = children.length
    ? `    <ConversationRelay${relayAttrs}>\n${children.join('\n')}\n    </ConversationRelay>`
    : `    <ConversationRelay${relayAttrs} />`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Connect${attr('action', actionUrl)}>`,
    relayEl,
    '  </Connect>',
    '</Response>',
  ].join('\n');
}

/**
 * TwiML de transfert filtre. La personne appelee entend d'abord un chuchotement
 * (whisperUrl) et doit appuyer sur 1 pour accepter; sinon l'appel n'est pas
 * ponte et revient a actionUrl (l'appelant ne tombe jamais sur une boite vocale).
 */
export function transferTwiml(
  to: string,
  actionUrl: string,
  whisperUrl: string,
  timeout = 25,
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Say language="${config.relay.language}">Je vous mets en relation, un instant.</Say>`,
    `  <Dial timeout="${timeout}"${attr('action', actionUrl)} answerOnBridge="true">`,
    `    <Number${attr('url', whisperUrl)}>${escapeXml(to)}</Number>`,
    '  </Dial>',
    '</Response>',
  ].join('\n');
}

/** Chuchotement joue a la personne appelee: elle doit appuyer sur 1 pour accepter. */
export function whisperTwiml(caller: string, reason: string, acceptUrl: string): string {
  const de = caller ? ` de ${caller}` : '';
  const sujet = reason ? ` Sujet: ${reason}.` : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Gather numDigits="1" timeout="10"${attr('action', acceptUrl)}>`,
    `    <Say language="${config.relay.language}">Appel${escapeXml(de)} pour Balgio.${escapeXml(sujet)} Appuyez sur le 1 pour prendre l'appel.</Say>`,
    '  </Gather>',
    '  <Hangup/>',
    '</Response>',
  ].join('\n');
}

/** Reponse quand la personne accepte (appuie sur 1): on ponte les deux appels. */
export function acceptTwiml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Say language="${config.relay.language}">Je vous connecte.</Say>`,
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
