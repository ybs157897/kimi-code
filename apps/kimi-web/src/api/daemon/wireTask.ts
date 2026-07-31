// apps/kimi-web/src/api/daemon/wireTask.ts
// Daemon wire DTOs — background task shapes. Part of the shared wire barrel
// (wire.ts); ALL fields stay snake_case as they appear on the wire.

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export type WireTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WireTask {
  id: string;
  session_id: string;
  kind: 'subagent' | 'bash' | 'tool';
  description: string;
  status: WireTaskStatus;
  command?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  output_preview?: string;
  output_bytes?: number;
  subagent_phase?: 'queued' | 'working' | 'suspended' | 'completed' | 'failed';
  subagent_type?: string;
  parent_tool_call_id?: string;
  suspended_reason?: string;
  swarm_index?: number;
  run_in_background?: boolean;
}
