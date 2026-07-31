// apps/kimi-web/src/api/daemon/wirePrompt.ts
// Daemon wire DTOs — prompt submission shapes. Part of the shared wire barrel
// (wire.ts); ALL fields stay snake_case as they appear on the wire.

import type { WireMessageContent } from './wireMessage';

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface WirePromptSubmission {
  content: WireMessageContent[];
  metadata?: Record<string, unknown>;
  agent_id?: string;
  model?: string;
  thinking?: string;
  permission_mode?: string;
  plan_mode?: boolean;
  swarm_mode?: boolean;
  goal_objective?: string;
  goal_control?: 'pause' | 'resume' | 'cancel';
}

export interface WirePromptSubmitResult {
  prompt_id: string;
  user_message_id: string;
  /** 'running' = started immediately; 'queued' = parked behind the active prompt. */
  status?: 'running' | 'queued';
}

export interface WirePromptSteerResult {
  steered: boolean;
  prompt_ids: string[];
}
