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

export const config = {
  port: Number(opt('PORT', '8080')),
  // URL publique du service. Vide => deduite des entetes de la requete.
  publicBaseUrl: opt('PUBLIC_BASE_URL').replace(/\/$/, ''),

  business: {
    name: opt('BUSINESS_NAME', 'Balgio'),
    assistant: opt('ASSISTANT_NAME', 'Gio'),
    timezone: opt('BUSINESS_TIMEZONE', 'America/Toronto'),
    transferNumber: opt('HUMAN_TRANSFER_NUMBER'),
  },

  anthropic: {
    apiKey: opt('ANTHROPIC_API_KEY'),
    model: opt('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001'),
    maxTokens: Number(opt('ANTHROPIC_MAX_TOKENS', '1024')),
  },

  twenty: {
    baseUrl: opt('TWENTY_BASE_URL', 'https://crm.agencebalgio.ca').replace(/\/$/, ''),
    apiKey: opt('TWENTY_API_KEY'),
    defaultCountry: opt('TWENTY_DEFAULT_COUNTRY', 'CA'),
  },

  twilio: {
    authToken: opt('TWILIO_AUTH_TOKEN'),
    validateSignature: bool('VALIDATE_TWILIO_SIGNATURE', true),
  },

  relay: {
    language: opt('CR_LANGUAGE', 'fr-CA'),
    ttsProvider: opt('CR_TTS_PROVIDER'),
    voice: opt('CR_VOICE'),
    transcriptionProvider: opt('CR_TRANSCRIPTION_PROVIDER'),
    speechModel: opt('CR_SPEECH_MODEL'),
    interruptible: bool('CR_INTERRUPTIBLE', true),
  },
};

export type AppConfig = typeof config;
