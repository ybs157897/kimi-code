/**
 * Browser-safe context message wire shapes consumed by TUI replay and export
 * surfaces. Runtime adapters copy their engine-owned values into these shapes
 * so callers never retain SDK or Klient message objects.
 */

export type TUIContextMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TUITextContentPart {
  readonly type: 'text';
  readonly text: string;
}

export interface TUIThinkContentPart {
  readonly type: 'think';
  readonly think: string;
  readonly encrypted?: string;
}

export interface TUIImageContentPart {
  readonly type: 'image_url';
  readonly imageUrl: {
    readonly url: string;
    readonly id?: string;
  };
}

export interface TUIAudioContentPart {
  readonly type: 'audio_url';
  readonly audioUrl: {
    readonly url: string;
    readonly id?: string;
  };
}

export interface TUIVideoContentPart {
  readonly type: 'video_url';
  readonly videoUrl: {
    readonly url: string;
    readonly id?: string;
  };
}

export type TUIContentPart =
  | TUITextContentPart
  | TUIThinkContentPart
  | TUIImageContentPart
  | TUIAudioContentPart
  | TUIVideoContentPart;

export interface TUIToolCall {
  readonly type: 'function';
  readonly id: string;
  readonly name: string;
  readonly arguments: string | null;
  readonly extras?: Readonly<Record<string, unknown>>;
  readonly _streamIndex?: number | string;
}

/**
 * Prompt origins are deliberately open: TUI consumers can distinguish the
 * stable `kind` discriminator while runtimes retain additional wire fields.
 */
export interface TUIMessageOrigin {
  readonly kind: string;
}

export interface TUIContextMessage {
  readonly role: TUIContextMessageRole;
  readonly name?: string;
  readonly content: readonly TUIContentPart[];
  readonly toolCalls: readonly TUIToolCall[];
  readonly toolCallId?: string;
  readonly partial?: boolean;
  readonly id?: string;
  readonly providerMessageId?: string;
  readonly origin?: TUIMessageOrigin;
  readonly isError?: boolean;
  readonly note?: string;
}

/** Read-only context snapshot for one bound session agent. */
export interface SessionContextView {
  readonly history: readonly TUIContextMessage[];
  readonly tokenCount: number;
}

export interface SessionContextViewPort {
  read(): Promise<SessionContextView>;
}

export function copyTUIContextMessage(
  message: TUIContextMessage,
): TUIContextMessage {
  return {
    role: message.role,
    name: message.name,
    content: message.content.map(copyTUIContentPart),
    toolCalls: message.toolCalls.map(copyTUIToolCall),
    toolCallId: message.toolCallId,
    partial: message.partial,
    id: message.id,
    providerMessageId: message.providerMessageId,
    origin:
      message.origin === undefined
        ? undefined
        : (copyWireValue(message.origin) as TUIMessageOrigin),
    isError: message.isError,
    note: message.note,
  };
}

function copyTUIContentPart(part: TUIContentPart): TUIContentPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      return {
        type: 'think',
        think: part.think,
        encrypted: part.encrypted,
      };
    case 'image_url':
      return {
        type: 'image_url',
        imageUrl: {
          url: part.imageUrl.url,
          id: part.imageUrl.id,
        },
      };
    case 'audio_url':
      return {
        type: 'audio_url',
        audioUrl: {
          url: part.audioUrl.url,
          id: part.audioUrl.id,
        },
      };
    case 'video_url':
      return {
        type: 'video_url',
        videoUrl: {
          url: part.videoUrl.url,
          id: part.videoUrl.id,
        },
      };
  }
}

function copyTUIToolCall(toolCall: TUIToolCall): TUIToolCall {
  return {
    type: 'function',
    id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments,
    extras:
      toolCall.extras === undefined
        ? undefined
        : (copyWireValue(toolCall.extras) as Readonly<Record<string, unknown>>),
    _streamIndex: toolCall._streamIndex,
  };
}

function copyWireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyWireValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, copyWireValue(nested)]),
  );
}
