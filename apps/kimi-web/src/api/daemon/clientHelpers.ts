// apps/kimi-web/src/api/daemon/clientHelpers.ts
// Module-level helpers used by the daemon client: export filename sanitation,
// error trace metadata, and history-compaction reason classification.

export function safeExportFileName(contentDisposition: string | undefined, fallback: string): string {
  if (contentDisposition === undefined) return fallback;
  let candidate: string | undefined;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(contentDisposition)?.[1]?.trim();
  if (encoded !== undefined) {
    try {
      candidate = decodeURIComponent(encoded.replaceAll(/^"|"$/g, ''));
    } catch {
      return fallback;
    }
  } else {
    candidate =
      /filename\s*=\s*"([^"]*)"/i.exec(contentDisposition)?.[1] ??
      /filename\s*=\s*([^;]+)/i.exec(contentDisposition)?.[1]?.trim();
  }
  if (
    candidate === undefined ||
    candidate.length === 0 ||
    candidate.length > 200 ||
    candidate === '.' ||
    candidate === '..' ||
    /[\u0000-\u001F\u007F/\\]/.test(candidate) ||
    !candidate.toLowerCase().endsWith('.zip')
  ) {
    return fallback;
  }
  return candidate;
}

export function errorTraceMetadata(err: unknown): Record<string, string | number | undefined> {
  if (typeof err !== 'object' || err === null) return { errorName: typeof err };
  const value = err as {
    name?: unknown;
    code?: unknown;
    requestId?: unknown;
    phase?: unknown;
    status?: unknown;
  };
  return {
    errorName: typeof value.name === 'string' ? value.name : 'Error',
    errorCode: typeof value.code === 'number' ? value.code : undefined,
    requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
    phase: typeof value.phase === 'string' ? value.phase : undefined,
    httpStatus: typeof value.status === 'number' ? value.status : undefined,
  };
}

/**
 * historyCompacted reasons caused by compaction itself. These do NOT trigger a
 * snapshot reload: the client keeps the visible scrollback and renders a
 * divider marker instead. Every other reason (delta_gap, history_rewrite, …)
 * still means "cached messages are stale" and goes through onResync.
 */
export function isCompactionReason(reason: string): boolean {
  return reason === 'auto_compact' || reason === 'manual_compact';
}
