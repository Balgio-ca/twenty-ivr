import { config } from '../config.js';
import { splitPhone } from '../util/phone.js';
import { log } from '../util/logger.js';
import { twenty } from './client.js';

export type Person = {
  id: string;
  name?: { firstName?: string; lastName?: string };
  phones?: { primaryPhoneNumber?: string };
  emails?: { primaryEmail?: string };
};

export function fullName(p?: Person | null): string {
  if (!p?.name) return '';
  return [p.name.firstName, p.name.lastName].filter(Boolean).join(' ').trim();
}

/** Cherche un contact par numero de telephone (numero national). */
export async function findPersonByPhone(rawPhone: string): Promise<Person | null> {
  if (!twenty.enabled) return null;
  const { national } = splitPhone(rawPhone, config.twenty.defaultCountry);
  if (!national) return null;
  const filter = encodeURIComponent(`phones.primaryPhoneNumber[eq]:${national}`);
  const path = `/people?filter=${filter}&limit=1&depth=0`;
  const people = await twenty.getList<Person>(path);
  return people[0] ?? null;
}

/** Cree un contact minimal (nom + telephone + courriel optionnel). */
export async function createPerson(input: {
  firstName: string;
  lastName?: string;
  phone: string;
  email?: string;
}): Promise<Person> {
  const { national, callingCode, country } = splitPhone(input.phone, config.twenty.defaultCountry);
  const body: Record<string, unknown> = {
    name: { firstName: input.firstName, lastName: input.lastName ?? '' },
    phones: {
      primaryPhoneNumber: national,
      primaryPhoneCallingCode: callingCode,
      primaryPhoneCountryCode: country,
    },
  };
  if (input.email) {
    body.emails = { primaryEmail: input.email };
  }
  const person = await twenty.post<Person>('/people', body);
  log('twenty', `Contact cree ${person.id} (${input.firstName})`);
  return person;
}

/**
 * Retourne le contact existant pour ce numero, sinon le cree a partir du nom
 * fourni. Renvoie null si le CRM est desactive.
 */
export async function ensurePerson(
  phone: string,
  name?: string,
  email?: string,
): Promise<Person | null> {
  if (!twenty.enabled) return null;
  const existing = await findPersonByPhone(phone);
  if (existing) return existing;
  if (!name) return null;
  const [firstName, ...rest] = name.trim().split(/\s+/);
  return createPerson({
    firstName: firstName ?? name,
    lastName: rest.join(' '),
    phone,
    email,
  });
}
