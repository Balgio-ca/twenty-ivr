import { config } from './config.js';
import { log, warn } from './util/logger.js';

// Etat de sante du fournisseur TTS primaire (ex: ElevenLabs). Quand un appel
// echoue cote TTS, on bascule les appels suivants vers le fournisseur de repli
// pendant une periode de refroidissement, puis on re-tente le primaire.
let downUntil = 0;

export function primaryTtsAvailable(): boolean {
  return Date.now() >= downUntil;
}

export function markPrimaryTtsDown(reason: string): void {
  const already = !primaryTtsAvailable();
  downUntil = Date.now() + config.relay.fallbackCooldownMs;
  if (!already) {
    warn(
      'tts',
      `Fournisseur primaire en echec (${reason}). Repli vers ${config.relay.fallbackProvider}/${config.relay.fallbackVoice} pour ${Math.round(
        config.relay.fallbackCooldownMs / 60_000,
      )} min.`,
    );
  }
}

/** Fournisseur et voix a utiliser maintenant (primaire ou repli). */
export function activeTts(): { provider: string; voice: string; voiceEn: string; fallback: boolean } {
  if (primaryTtsAvailable()) {
    return {
      provider: config.relay.ttsProvider,
      voice: config.relay.voice,
      voiceEn: config.relay.voiceEn,
      fallback: false,
    };
  }
  return {
    provider: config.relay.fallbackProvider,
    voice: config.relay.fallbackVoice,
    voiceEn: config.relay.voiceEn,
    fallback: true,
  };
}

/** Detecte, dans une erreur ConversationRelay, un probleme de synthese vocale. */
export function looksLikeTtsError(description: string): boolean {
  return /tts|eleven|voice|quota|capacity|payment|rate.?limit|synthes/i.test(description);
}

export function noteTtsRecovered(): void {
  if (!primaryTtsAvailable()) return;
  log('tts', 'Fournisseur primaire disponible.');
}
