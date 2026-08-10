import type Anthropic from '@anthropic-ai/sdk';
import type { WebSocket } from 'ws';

import { config } from '../config.js';
import { anthropic } from '../llm/agent.js';
import { buildSystemPrompt } from '../llm/prompt.js';
import { TOOLS, dispatchTool, type ToolControl, type ToolSession } from '../llm/tools.js';
import {
  accountOwnerName,
  companyName,
  findPersonByPhone,
  fullName,
  isActiveClient,
} from '../twenty/people.js';
import { createNoteOnPerson, logCall } from '../twenty/records.js';
import { humanAvailable } from '../util/hours.js';
import { looksLikeTtsError, markPrimaryTtsDown } from '../tts-health.js';
import { error, log, warn } from '../util/logger.js';
import type { InboundMessage, OutboundMessage, SetupMessage } from './protocol.js';

type Turn = { role: 'user' | 'assistant'; text: string };

const MAX_AGENT_STEPS = 8;

export class RelaySession {
  private readonly ws: WebSocket;

  private system = '';
  private readonly messages: Anthropic.MessageParam[] = [];
  private readonly transcript: Turn[] = [];

  private callSid = '';
  private phoneE164 = '';
  private knownName = '';
  private startedAt = new Date().toISOString();

  private currentAbort: AbortController | undefined;
  private setupDone: Promise<void>;
  private resolveSetup!: () => void;

  private logged = false;
  private closed = false;
  private busy = false;
  private personExisted = false;
  private dtmfBuffer = '';
  private mode: 'message' | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private idleStrikes = 0;

  private readonly toolSession: ToolSession;

  constructor(ws: WebSocket, opts?: { mode?: 'message' }) {
    this.ws = ws;
    this.mode = opts?.mode;
    this.setupDone = new Promise((resolve) => {
      this.resolveSetup = resolve;
    });
    this.toolSession = {
      phoneE164: '',
      personId: undefined,
      existingClient: false,
      companyName: undefined,
      callSummary: undefined,
      callOutcome: undefined,
    };
  }

  // -------- reception --------

  async onMessage(raw: string): Promise<void> {
    let msg: InboundMessage;
    try {
      msg = JSON.parse(raw) as InboundMessage;
    } catch {
      warn('relay', 'Message non-JSON ignore');
      return;
    }
    switch (msg.type) {
      case 'setup':
        await this.onSetup(msg);
        break;
      case 'prompt':
        await this.onPrompt(msg.voicePrompt ?? '');
        break;
      case 'interrupt':
        this.onInterrupt();
        break;
      case 'dtmf':
        await this.onDtmf(msg.digit ?? msg.digits ?? '');
        break;
      case 'error': {
        const desc = msg.description ?? 'inconnue';
        warn('relay', `Erreur ConversationRelay: ${desc}`);
        if (looksLikeTtsError(desc)) markPrimaryTtsDown(desc.slice(0, 80));
        break;
      }
      default:
        break;
    }
  }

  private async onSetup(msg: SetupMessage): Promise<void> {
    const { callSid, from, to } = msg;
    if (msg.customParameters?.mode === 'message') this.mode = 'message';
    this.callSid = callSid;
    this.phoneE164 = from;
    this.toolSession.phoneE164 = from;
    this.startedAt = new Date().toISOString();
    log('relay', `Appel ${callSid} de ${from} vers ${to}${this.mode ? ` [${this.mode}]` : ''}`);

    try {
      const person = await findPersonByPhone(from);
      if (person) {
        this.personExisted = true;
        this.toolSession.personId = person.id;
        this.toolSession.existingClient = isActiveClient(person);
        this.toolSession.companyName = companyName(person) || undefined;
        this.knownName = fullName(person);
        log(
          'relay',
          `Contact reconnu: ${this.knownName || person.id} (${this.toolSession.existingClient ? 'client actif' : 'non-client'})`,
        );
        if (this.toolSession.existingClient) {
          const owner = await accountOwnerName(person);
          const phone = owner ? config.business.ownerPhones[owner.toLowerCase()] : undefined;
          if (phone) {
            this.toolSession.ownerPhone = phone;
            this.toolSession.ownerName = owner;
            log('relay', `Responsable ${owner} -> ${phone}`);
          }
        }
      }
    } catch (err) {
      warn('relay', 'Recherche du contact impossible', err);
    }

    this.system = buildSystemPrompt({
      knownName: this.knownName || undefined,
      companyName: this.toolSession.companyName,
      existingClient: this.toolSession.existingClient,
      clientStatusKnown: this.personExisted,
      phoneE164: from,
      humanAvailable: humanAvailable(),
      mode: this.mode,
    });
    this.resolveSetup();
  }

  private async onPrompt(text: string): Promise<void> {
    if (!text.trim()) return;
    this.clearIdle();
    this.idleStrikes = 0;
    await this.setupDone;
    if (this.closed) return;
    if (this.busy) {
      // Un tour est deja en cours; on annule l'ancien avant d'enchainer.
      this.currentAbort?.abort();
    }
    this.transcript.push({ role: 'user', text });
    this.messages.push({ role: 'user', content: text });
    await this.runAgent();
  }

  private onInterrupt(): void {
    log('relay', 'Interruption par l appelant');
    this.currentAbort?.abort();
  }

  /** Accumule les touches du clavier; '#' valide, '*' efface. */
  private async onDtmf(digit: string): Promise<void> {
    if (!digit) return;
    this.clearIdle();
    if (digit === '#') {
      const num = this.dtmfBuffer;
      this.dtmfBuffer = '';
      if (num) await this.onPrompt(`(L'appelant a saisi ce numero au clavier: ${num})`);
      return;
    }
    if (digit === '*') {
      this.dtmfBuffer = '';
      return;
    }
    this.dtmfBuffer += digit;
  }

  /** Bascule la langue de la synthese et de la transcription. */
  private applyLanguage(lang: 'fr' | 'en'): void {
    if (!config.relay.bilingual) return;
    const target = lang === 'en' ? config.relay.languageEn : config.relay.language;
    this.send({ type: 'language', ttsLanguage: target, transcriptionLanguage: target });
    log('relay', `Langue -> ${target}`);
  }

  // -------- boucle agent --------

  private async runAgent(): Promise<void> {
    this.busy = true;
    try {
      for (let step = 0; step < MAX_AGENT_STEPS; step++) {
        if (this.closed) return;
        const ac = new AbortController();
        this.currentAbort = ac;

        let assistantText = '';
        let final: Anthropic.Message;
        try {
          const stream = anthropic.messages.stream(
            {
              model: config.anthropic.model,
              max_tokens: config.anthropic.maxTokens,
              system: this.system,
              tools: TOOLS,
              messages: this.messages,
            },
            { signal: ac.signal },
          );
          stream.on('text', (delta) => {
            if (ac.signal.aborted || this.closed) return;
            assistantText += delta;
            this.send({ type: 'text', token: delta, last: false });
          });
          final = await stream.finalMessage();
        } catch (err) {
          if (ac.signal.aborted) {
            log('relay', 'Generation interrompue');
            return;
          }
          error('relay', 'Echec Claude', err);
          this.send({
            type: 'text',
            token: 'Désolé, un petit problème technique. Pouvez-vous répéter ?',
            last: true,
          });
          return;
        } finally {
          this.currentAbort = undefined;
        }

        if (assistantText.trim()) {
          this.transcript.push({ role: 'assistant', text: assistantText.trim() });
        }
        this.messages.push({
          role: 'assistant',
          content: final.content as Anthropic.ContentBlockParam[],
        });

        const toolUses = final.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        if (toolUses.length === 0) {
          this.finishSpeaking();
          this.armIdle();
          return;
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        let control: ToolControl | undefined;
        for (const tu of toolUses) {
          const outcome = await dispatchTool(
            tu.name,
            (tu.input ?? {}) as Record<string, unknown>,
            this.toolSession,
          );
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: outcome.result });
          if (outcome.control && !control) control = outcome.control;
        }
        this.messages.push({ role: 'user', content: results });

        if (control) {
          if (control.kind === 'language') {
            // Changement de langue: on applique et on continue la conversation.
            this.applyLanguage(control.lang);
            continue;
          }
          // La phrase de politesse a deja ete diffusee dans ce tour; on clot
          // le tour de parole puis on execute l'action (transfert/raccroché).
          this.finishSpeaking();
          await this.executeControl(control);
          return;
        }
        // Outils de donnees: on reboucle pour la reponse orale du modele.
      }
      warn('relay', 'Nombre maximum d etapes atteint');
      this.finishSpeaking();
    } finally {
      this.busy = false;
    }
  }

  private async executeControl(control: Exclude<ToolControl, { kind: 'language' }>): Promise<void> {
    this.clearIdle();
    await this.logCallOnce();
    const handoff =
      control.kind === 'transfer'
        ? { action: 'transfer', to: control.to, reason: control.reason, who: control.who }
        : { action: 'hangup', reason: control.reason };
    this.send({ type: 'end', handoffData: JSON.stringify(handoff) });
    log('relay', `Fin de session: ${control.kind}`);
  }

  private finishSpeaking(): void {
    this.send({ type: 'text', token: '', last: true });
  }

  // -------- cloture --------

  async onClose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    this.currentAbort?.abort();
    await this.logCallOnce();
    log('relay', `Session fermee ${this.callSid}`);
  }

  // -------- gestion du silence --------

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.closed) return;
    this.idleTimer = setTimeout(() => {
      void this.onIdle();
    }, config.relay.idleMs);
  }

  private async onIdle(): Promise<void> {
    this.idleTimer = undefined;
    if (this.closed || this.busy) return;
    this.idleStrikes += 1;
    if (this.idleStrikes >= 2) {
      this.send({
        type: 'text',
        token: "Je vais vous laisser pour l'instant. N'hésitez pas à rappeler. Au revoir.",
        last: true,
      });
      await this.logCallOnce();
      this.send({ type: 'end', handoffData: JSON.stringify({ action: 'hangup', reason: 'silence' }) });
      return;
    }
    this.send({
      type: 'text',
      token: 'Êtes-vous toujours là ? Je peux prendre un message si vous préférez.',
      last: true,
    });
    this.armIdle();
  }

  private async logCallOnce(): Promise<void> {
    if (this.logged) return;
    this.logged = true;
    const endedAt = new Date().toISOString();
    const durationSeconds = (Date.parse(endedAt) - Date.parse(this.startedAt)) / 1000;
    try {
      await logCall({
        callSid: this.callSid,
        phoneNumber: this.phoneE164,
        personId: this.toolSession.personId,
        name: `Appel entrant - ${this.knownName || this.phoneE164}`,
        startedAt: this.startedAt,
        endedAt,
        durationSeconds,
        transcript: this.transcriptText(),
        summary: this.toolSession.callSummary,
        outcome: this.toolSession.callOutcome,
      });
    } catch (err) {
      error('relay', 'Journalisation de l appel impossible', err);
    }

    // Note dans la fiche du contact (utile quand un lead demarche rappelle).
    if (this.toolSession.personId) {
      const statut = this.toolSession.existingClient ? 'Client actif' : 'Contact / lead';
      const contexte = this.personExisted
        ? 'Retour d appel (fiche deja au CRM)'
        : 'Nouveau contact cree lors de l appel';
      const body = [
        `Appel entrant recu par ${config.business.assistant}.`,
        `Statut: ${statut}. ${contexte}.`,
        `Duree: ${Math.round(durationSeconds)} s.`,
        this.toolSession.callSummary ? `Resume: ${this.toolSession.callSummary}` : '',
        this.toolSession.callOutcome ? `Issue: ${this.toolSession.callOutcome}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      try {
        await createNoteOnPerson({
          personId: this.toolSession.personId,
          title: `Appel entrant - ${config.business.assistant}`,
          body,
        });
      } catch (err) {
        error('relay', 'Note sur la fiche impossible', err);
      }
    }
  }

  private transcriptText(): string {
    const who = config.business.assistant;
    return this.transcript
      .map((t) => `${t.role === 'user' ? 'Appelant' : who}: ${t.text}`)
      .join('\n');
  }

  private send(msg: OutboundMessage): void {
    if (this.closed) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      warn('relay', 'Envoi websocket impossible', err);
    }
  }
}
