import { config } from '../config.js';
import { splitPhone } from '../util/phone.js';
import { log } from '../util/logger.js';
import { twenty } from './client.js';

export type Person = {
  id: string;
  name?: { firstName?: string; lastName?: string };
  phones?: { primaryPhoneNumber?: string };
  emails?: { primaryEmail?: string };
  company?: {
    id?: string;
    name?: string;
    accountOwnerId?: string;
    clientStatus?: string;
    lastInvoiceDate?: string | null;
    lifetimeValue?: { amountMicros?: number | null };
  };
};

type WorkspaceMember = { id: string; name?: { firstName?: string; lastName?: string } };
let memberCache: Map<string, string> | null = null;

async function workspaceMembers(): Promise<Map<string, string>> {
  if (memberCache) return memberCache;
  const list = await twenty.getList<WorkspaceMember>('/workspaceMembers?limit=200&depth=0');
  const map = new Map<string, string>();
  for (const m of list) {
    const full = `${m.name?.firstName ?? ''} ${m.name?.lastName ?? ''}`.trim();
    if (m.id) map.set(m.id, full);
  }
  memberCache = map;
  return map;
}

/** Nom complet du responsable de compte (account owner) de la societe reliee. */
export async function accountOwnerName(p?: Person | null): Promise<string> {
  const id = p?.company?.accountOwnerId;
  if (!id || !twenty.enabled) return '';
  try {
    return (await workspaceMembers()).get(id) ?? '';
  } catch {
    return '';
  }
}

export function companyName(p?: Person | null): string {
  return p?.company?.name ?? '';
}

/**
 * Client actif = a deja eu des factures. On se fie a la societe reliee:
 * une date de derniere facture, une valeur a vie > 0, ou un statut ACTIVE.
 * Une simple fiche au CRM sans facture ne compte pas.
 */
export function isActiveClient(p?: Person | null): boolean {
  const c = p?.company;
  if (!c) return false;
  if (c.clientStatus === 'ACTIVE') return true;
  if (c.lastInvoiceDate) return true;
  if ((c.lifetimeValue?.amountMicros ?? 0) > 0) return true;
  return false;
}

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
  // depth=1 pour recuperer la societe reliee (nom de l'entreprise).
  const path = `/people?filter=${filter}&limit=1&depth=1`;
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
