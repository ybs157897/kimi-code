// apps/kimi-web/src/api/daemon/wireMessage.ts
// Daemon wire DTOs — message content shapes. Part of the shared wire barrel
// (wire.ts); ALL fields stay snake_case as they appear on the wire.

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export type WireMessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool_call_id: string; tool_name: string; input: unknown }
  | { type: 'tool_result'; tool_call_id: string; output: unknown; is_error?: boolean }
  | { type: 'image'; source: WireImageSource }
  | { type: 'video'; source: WireImageSource }
  | { type: 'file'; file_id: string; name: string; media_type: string; size: number }
  | { type: 'thinking'; thinking: string; signature?: string };

export type WireImageSource =
  | { kind: 'url'; url: string; id?: string }
  | { kind: 'base64'; media_type: string; data: string }
  | { kind: 'file'; file_id: string };

export interface WireMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: WireMessageContent[];
  created_at: string;
  prompt_id?: string;
  parent_message_id?: string;
  metadata?: Record<string, unknown>;
}
