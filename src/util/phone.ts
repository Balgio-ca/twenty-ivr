import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export type SplitPhone = {
  /** Numero national sans indicatif, ex "5145551234" (format de stockage Twenty). */
  national: string;
  /** Indicatif d'appel avec le +, ex "+1". */
  callingCode: string;
  /** Code pays ISO, ex "CA". */
  country: string;
  /** Format E.164 normalise, ex "+15145551234". */
  e164: string;
};

/**
 * Decoupe un numero (idealement en E.164) selon la structure attendue par le
 * champ composite `phones` de Twenty.
 */
export function splitPhone(raw: string, defaultCountry = 'CA'): SplitPhone {
  const parsed = parsePhoneNumberFromString(raw, defaultCountry as CountryCode);
  if (parsed) {
    return {
      national: parsed.nationalNumber,
      callingCode: `+${parsed.countryCallingCode}`,
      country: parsed.country ?? defaultCountry,
      e164: parsed.number,
    };
  }
  // Repli: on retire un eventuel + et on garde tel quel.
  const digits = raw.replace(/[^\d]/g, '');
  return {
    national: digits,
    callingCode: '',
    country: defaultCountry,
    e164: raw.startsWith('+') ? raw : `+${digits}`,
  };
}

/** Formate un numero pour l'oral en francais, ex "5 1 4, 5 5 5, 1 2 3 4". */
export function spokenDigits(national: string): string {
  return national.split('').join(' ');
}
