/**
 * `task` domain (L5) — task output retention limits and snapshot primitives:
 * the retained in-memory ring cap (`MAX_OUTPUT_BYTES`), the terminal
 * `outputTail` cap (`TERMINAL_OUTPUT_TAIL_BYTES`), the total process-output
 * cap (`MAX_TASK_OUTPUT_BYTES`) with its `outputLimitReason` message, and the
 * empty `AgentTaskOutputSnapshot` factory.
 */

import type { AgentTaskOutputSnapshot } from './task';

export const MAX_OUTPUT_BYTES = 1024 * 1024;

export const TERMINAL_OUTPUT_TAIL_BYTES = 4 * 1024;

export const MAX_TASK_OUTPUT_BYTES = 16 * 1024 * 1024;

export function outputLimitReason(): string {
  const mib = Math.floor(MAX_TASK_OUTPUT_BYTES / (1024 * 1024));
  return (
    `Output limit exceeded: the command produced more than ${mib} MiB and was ` +
    'terminated. Redirect large output to a file (e.g. `command > out.txt`) and ' +
    'inspect it in slices instead.'
  );
}

export function emptyOutputSnapshot(): AgentTaskOutputSnapshot {
  return {
    outputSizeBytes: 0,
    previewBytes: 0,
    truncated: false,
    fullOutputAvailable: false,
    preview: '',
  };
}
