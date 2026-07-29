/**
 * Minimal SDK-local diagnostic logger.
 *
 * The legacy `@moonshot-ai/agent-core` owned a full rotating-file `RootLogger`
 * with session-scoped sinks.  In the v2 world the engine's `ILogService`
 * handles that — the SDK only needs a lightweight singleton for process-level
 * startup / shutdown messages that may occur before or after the v2 runtime's
 * lifecycle.
 *
 * This implementation is a best-effort stderr emitter with the same type
 * surface as the legacy `Logger`.  Diagnostics not configured at process
 * level will be swallowed silently.
 *
 * External consumers who previously imported `log`, `redact`,
 * `flushDiagnosticLogs` from `@moonshot-ai/kimi-code-sdk` get the same
 * symbols from this module — the interface is backward compatible and the
 * implementation is intentionally simpler, since v2's ILogService owns the
 * durable session-scoped path.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LogPayload = Record<string, any> | Error;

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export interface LogContext {
  readonly [key: string]: unknown;
}

export interface Logger {
  error(message: string, payload?: LogPayload): void;
  warn(message: string, payload?: LogPayload): void;
  info(message: string, payload?: LogPayload): void;
  debug(message: string, payload?: LogPayload): void;
  createChild(ctx: LogContext): Logger;
}

class SimpleLogger implements Logger {
  constructor(private readonly boundCtx: LogContext) {}

  error(message: string, payload?: LogPayload): void {
    this.emit('error', message, payload);
  }

  warn(message: string, payload?: LogPayload): void {
    this.emit('warn', message, payload);
  }

  info(message: string, payload?: LogPayload): void {
    this.emit('info', message, payload);
  }

  debug(message: string, payload?: LogPayload): void {
    this.emit('debug', message, payload);
  }

  createChild(ctx: LogContext): Logger {
    return new SimpleLogger({ ...this.boundCtx, ...ctx });
  }

  private emit(level: string, message: string, _payload?: LogPayload): void {
    if (isEnabled(level, currentLogLevel)) {
      const sid = this.boundCtx['sessionId'];
      const prefix = sid
        ? `[kimi:${level}] [session:${String(sid)}]`
        : `[kimi:${level}]`;
      process.stderr.write(`${prefix} ${message}\n`);
    }
  }
}

let currentLogLevel: LogLevel = resolveLogLevel();

function resolveLogLevel(): LogLevel {
  const env = process.env['KIMI_LOG_LEVEL']?.trim().toLowerCase();
  if (env === 'error' || env === 'warn' || env === 'info' || env === 'debug') return env;
  return 'off';
}

function isEnabled(target: string, current: LogLevel): boolean {
  if (current === 'off') return false;
  const order: LogLevel[] = ['error', 'warn', 'info', 'debug'];
  const targetIdx = order.indexOf(target as LogLevel);
  const currentIdx = order.indexOf(current);
  return targetIdx >= 0 && currentIdx >= 0 && targetIdx <= currentIdx;
}

export const log: Logger = new SimpleLogger({});

/**
 * Best-effort value redaction.  Walks a plain object tree and masks known
 * sensitive keys (apiKey, token, password, secret).
 */
export function redact<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return redactTree(value as Record<string, unknown>) as T;
}

const REDACTED_MESSAGE = '***';

const SENSITIVE_KEYS = new Set([
  'apiKey',
  'api_key',
  'token',
  'password',
  'secret',
  'authorization',
  'Authorization',
]);

function redactTree(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = REDACTED_MESSAGE;
    } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = redactTree(val as Record<string, unknown>);
    } else if (Array.isArray(val)) {
      result[key] = val.map((item) =>
        item !== null && typeof item === 'object' ? redactTree(item as Record<string, unknown>) : item,
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}

export async function flushDiagnosticLogs(): Promise<boolean> {
  return true;
}

export function flushDiagnosticLogsSync(): void {
  // no-op
}

export function getRootLoggerInfo(): { readonly log: Logger } {
  return { log };
}
