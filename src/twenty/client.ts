import { config } from '../config.js';
import { error } from '../util/logger.js';

/**
 * Client mince pour l'API REST de Twenty.
 * Les reponses de creation sont de la forme { data: { createXxx: {...} } } et
 * les listes { data: { xxx: [...] } } ; on extrait la valeur imbriquee.
 */
export class TwentyClient {
  private readonly base: string;
  private readonly apiKey: string;

  constructor() {
    this.base = `${config.twenty.baseUrl}/rest`;
    this.apiKey = config.twenty.apiKey;
  }

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.apiKey) {
      throw new Error('TWENTY_API_KEY manquant: integration CRM desactivee.');
    }
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      error('twenty', `${method} ${path} -> ${res.status}`, text.slice(0, 400));
      throw new Error(`Twenty ${res.status}: ${text.slice(0, 200)}`);
    }
    return json as T;
  }

  /** Extrait la premiere valeur de l'enveloppe `data` d'une reponse REST. */
  private static unwrap<T>(payload: { data?: Record<string, unknown> }): T {
    const data = payload.data ?? {};
    const values = Object.values(data);
    return (values.length > 0 ? values[0] : data) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const json = await this.request<{ data?: Record<string, unknown> }>('POST', path, body);
    return TwentyClient.unwrap<T>(json);
  }

  async getList<T>(path: string): Promise<T[]> {
    const json = await this.request<{ data?: Record<string, unknown> }>('GET', path);
    const value = TwentyClient.unwrap<T[]>(json);
    return Array.isArray(value) ? value : [];
  }
}

export const twenty = new TwentyClient();
