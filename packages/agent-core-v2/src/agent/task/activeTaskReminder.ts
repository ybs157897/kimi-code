/**
 * `task` domain (L5) — the post-compaction active background-task reminder:
 * the context-injection variant and guidance text that re-surface
 * still-running tasks after compaction, plus the compaction-splice predicate
 * that arms the reminder.
 */

export const ACTIVE_BACKGROUND_TASK_INJECTION_VARIANT = 'background_task_status';
export const ACTIVE_BACKGROUND_TASK_GUIDANCE = [
  'The conversation was compacted, so the earlier messages that started these background tasks are gone — but the tasks are still running from before.',
  'Do not start duplicates. Use TaskList to list them, TaskOutput for a non-blocking status/output snapshot, and TaskStop to cancel one — completion arrives via automatic notification.',
].join(' ');

export function isCompactionSplice(splice: {
  readonly deleteCount: number;
  readonly messages: readonly { readonly origin?: { readonly kind: string } | undefined }[];
}): boolean {
  return (
    splice.deleteCount > 0 &&
    splice.messages.some((message) => message.origin?.kind === 'compaction_summary')
  );
}
