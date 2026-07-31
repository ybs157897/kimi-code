/**
 * Controller-local types for the KimiTUI coordinator: the send-message
 * options and the active session binding.
 */

import type { PromptPart } from '@moonshot-ai/kimi-code-sdk';

import type { SessionIdentity } from '#/tui/runtime/session-control-port';
import type { TUISessionRuntime } from '#/tui/runtime/tui-session-runtime';

export interface SendMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly hasMedia?: boolean;
}

export interface ActiveSessionBinding {
  readonly identity: SessionIdentity;
  readonly runtime: TUISessionRuntime;
}
