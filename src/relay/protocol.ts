// Messages du protocole Twilio ConversationRelay (websocket).
// Reference: https://www.twilio.com/docs/voice/twiml/connect/conversationrelay

export type SetupMessage = {
  type: 'setup';
  sessionId: string;
  callSid: string;
  from: string;
  to: string;
  direction?: string;
  callerName?: string;
};

export type PromptMessage = {
  type: 'prompt';
  voicePrompt: string;
  lang?: string;
  last?: boolean;
};

export type InterruptMessage = {
  type: 'interrupt';
  utteranceUntilInterrupt?: string;
  durationUntilInterruptMs?: number;
};

export type DtmfMessage = {
  type: 'dtmf';
  digit?: string;
  digits?: string;
};

export type ErrorMessage = {
  type: 'error';
  description?: string;
};

export type InboundMessage =
  | SetupMessage
  | PromptMessage
  | InterruptMessage
  | DtmfMessage
  | ErrorMessage;

// Messages sortants (serveur -> Twilio).
export type TextMessage = { type: 'text'; token: string; last: boolean };
export type EndMessage = { type: 'end'; handoffData?: string };
export type SendDigitsMessage = { type: 'sendDigits'; digits: string };

export type OutboundMessage = TextMessage | EndMessage | SendDigitsMessage;
