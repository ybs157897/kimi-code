import type { SessionRow } from '#/tui/components/dialogs/session-picker';
import type { SessionIdentity } from '#/tui/runtime/session-control-port';

export function sessionRowsForPicker(
  sessions: readonly SessionIdentity[],
  currentSessionId: string,
  currentSessionHasContent: boolean,
): SessionRow[] {
  return sessions
    .filter((session) => currentSessionHasContent || session.id !== currentSessionId)
    .map((session) => ({
      id: session.id,
      title: session.title ?? null,
      last_prompt: session.lastPrompt ?? null,
      work_dir: session.workDir ?? '',
      updated_at: session.updatedAt,
      metadata: session.metadata,
    }));
}
