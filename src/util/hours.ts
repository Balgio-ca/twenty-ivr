import { config } from '../config.js';

/** Jour (abrege) et heure courants dans le fuseau de l'entreprise. */
function nowParts(): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.business.timezone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  let hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  if (hour === 24) hour = 0;
  return { weekday, hour };
}

/** Vrai si nous sommes dans les heures d'ouverture (jour ouvrable + plage horaire). */
export function isBusinessOpen(): boolean {
  const { weekday, hour } = nowParts();
  const { days, openHour, closeHour } = config.business.hours;
  const isWorkday = days.includes(weekday);
  return isWorkday && hour >= openHour && hour < closeHour;
}

/** Vrai si un humain peut prendre l'appel (heures d'ouverture + au moins un numero). */
export function humanAvailable(): boolean {
  const { transferExisting, transferNew } = config.business;
  return isBusinessOpen() && Boolean(transferExisting || transferNew);
}

/** Description en francais des heures d'ouverture, pour le prompt. */
export function hoursDescription(): string {
  const { openHour, closeHour } = config.business.hours;
  return `du lundi au vendredi, de ${openHour} h a ${closeHour} h`;
}
