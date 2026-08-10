import 'dotenv/config';

function opt(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v !== 'false' && v !== '0';
}

/** Parse "Nom=+1...;Autre=+1..." en table {nom minuscule -> telephone}. */
function parsePairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(/[;\n]/)) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

export const config = {
  port: Number(opt('PORT', '8080')),
  // URL publique du service. Vide => deduite des entetes de la requete.
  publicBaseUrl: opt('PUBLIC_BASE_URL').replace(/\/$/, ''),

  business: {
    name: opt('BUSINESS_NAME', 'Balgio'),
    assistant: opt('ASSISTANT_NAME', 'Gio'),
    timezone: opt('BUSINESS_TIMEZONE', 'America/Toronto'),
    // Routage par statut client. Existant -> Mathieu; nouveau -> Alexandre.
    transferExisting: opt('TRANSFER_EXISTING_CLIENT') || opt('HUMAN_TRANSFER_NUMBER') || '+14389288488',
    transferNew: opt('TRANSFER_NEW_CLIENT', '+15145716742'),
    // Prenoms utilises a l'oral (ex: "il semble que Mathieu ne soit pas dispo").
    existingName: opt('EXISTING_CONTACT_NAME', 'Mathieu'),
    newName: opt('NEW_CONTACT_NAME', 'Alexandre'),
    // Membre Twenty a qui assigner les taches de suivi (defaut: Mathieu Giosi).
    defaultAssigneeId: opt('DEFAULT_ASSIGNEE_ID', '3f1f1fee-27e9-40c9-9f71-101a9c6d0a05'),
    // Routage vers le vrai responsable du dossier (account owner du CRM).
    // Table "Nom complet=+1...;Autre=+1..." (le nom doit matcher le membre Twenty).
    ownerPhones: parsePairs(
      opt('OWNER_PHONES', 'mathieu giosi=+14389288488;alexandre beauchamp=+15145716742'),
    ),
    mainPhone: opt('BUSINESS_MAIN_PHONE', '514-447-5205'),
    hours: {
      openHour: Number(opt('BUSINESS_OPEN_HOUR', '8')),
      closeHour: Number(opt('BUSINESS_CLOSE_HOUR', '17')),
      // Jours ouvrables (abreviations anglaises comme retournees par Intl).
      days: opt('BUSINESS_DAYS', 'Mon,Tue,Wed,Thu,Fri')
        .split(',')
        .map((d) => d.trim()),
    },
  },

  email: {
    smtpHost: opt('SMTP_HOST'),
    smtpPort: Number(opt('SMTP_PORT', '587')),
    smtpUser: opt('SMTP_USER'),
    smtpPass: opt('SMTP_PASS'),
    smtpSecure: bool('SMTP_SECURE', false),
    from: opt('EMAIL_FROM'),
    to: opt('MESSAGE_EMAIL_TO', 'mgiosi@balgio.ca'),
  },

  anthropic: {
    apiKey: opt('ANTHROPIC_API_KEY'),
    model: opt('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001'),
    // Reponses courtes pour rester conversationnel (voix).
    maxTokens: Number(opt('ANTHROPIC_MAX_TOKENS', '300')),
  },

  twenty: {
    baseUrl: opt('TWENTY_BASE_URL', 'https://crm.agencebalgio.ca').replace(/\/$/, ''),
    apiKey: opt('TWENTY_API_KEY'),
    defaultCountry: opt('TWENTY_DEFAULT_COUNTRY', 'CA'),
  },

  twilio: {
    accountSid: opt('TWILIO_ACCOUNT_SID'),
    authToken: opt('TWILIO_AUTH_TOKEN'),
    fromNumber: opt('TWILIO_NUMBER'),
    validateSignature: bool('VALIDATE_TWILIO_SIGNATURE', true),
  },

  relay: {
    language: opt('CR_LANGUAGE', 'fr-CA'),
    ttsProvider: opt('CR_TTS_PROVIDER'),
    voice: opt('CR_VOICE'),
    transcriptionProvider: opt('CR_TRANSCRIPTION_PROVIDER'),
    speechModel: opt('CR_SPEECH_MODEL'),
    // "none" | "dtmf" | "speech" | "any" (true=any, false=none).
    interruptible: opt('CR_INTERRUPTIBLE', 'any'),
    // Le message d'accueil ne doit pas etre coupe par un bruit: "none".
    welcomeGreetingInterruptible: opt('CR_WELCOME_INTERRUPTIBLE', 'none'),
    // Delai de silence avant que Gio relance ("etes-vous toujours la?").
    idleMs: Number(opt('CR_IDLE_SEC', '20')) * 1000,
    // Bascule vers l'anglais si l'appelant parle anglais.
    bilingual: bool('CR_BILINGUAL', true),
    languageEn: opt('CR_LANGUAGE_EN', 'en-US'),
    voiceEn: opt('CR_VOICE_EN') || opt('CR_VOICE'),
    // Repli TTS si le fournisseur primaire echoue (ex: ElevenLabs a capacite).
    // Les appels suivants utilisent ce fournisseur pendant le refroidissement.
    fallbackProvider: opt('CR_TTS_FALLBACK_PROVIDER', 'Amazon'),
    fallbackVoice: opt('CR_FALLBACK_VOICE', 'Liam-Neural'),
    fallbackCooldownMs: Number(opt('CR_TTS_COOLDOWN_MIN', '15')) * 60_000,
  },
};

export type AppConfig = typeof config;
