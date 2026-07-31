// apps/kimi-web/src/composables/client/errorFormatting.ts
// Pure error / warning detail formatting for the useKimiWebClient facade:
// daemon-error introspection helpers and the AppNoticeDetail builders shared
// by the operation-failure and WS-error paths.

import { i18n } from '../../i18n';
import { isDaemonApiError } from '../../api/errors';
import type { AppNoticeDetail } from '../../api/types';

const SESSION_NOT_FOUND_CODE = 40401;

export function isSessionNotFoundError(err: unknown): boolean {
  if (isDaemonApiError(err) && err.code === SESSION_NOT_FOUND_CODE) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === SESSION_NOT_FOUND_CODE
  );
}

export function warningDetail(labelKey: string, value: unknown): AppNoticeDetail | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return { label: i18n.global.t(`warnings.details.${labelKey}`), value: formatDetailValue(value) };
}

export function formatDetailValue(value: unknown): string {
  if (value instanceof Error) {
    // A stack already starts with "Name: message" and carries the frames the
    // plain name/message would throw away, so prefer it when present.
    if (typeof value.stack === 'string' && value.stack) return value.stack;
    return value.message ? `${value.name}: ${value.message}` : value.name;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function errorName(err: unknown): string | undefined {
  return err instanceof Error
    ? err.name
    : typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string'
      ? (err as { name: string }).name
      : undefined;
}

export function errorMessage(err: unknown): string | undefined {
  return err instanceof Error
    ? err.message
    : typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : undefined;
}

export function errorStack(err: unknown): string | undefined {
  return err instanceof Error && typeof err.stack === 'string' && err.stack ? err.stack : undefined;
}

export function formatTimestamp(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return `${Math.round(ms)}ms`;
}
