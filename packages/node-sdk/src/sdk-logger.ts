/**
 * SDK-local diagnostic logging facade.
 *
 * Keeps the root SDK's process-wide `log` symbol while routing entries into
 * the v2 runtime that owns the matching live session. Untagged entries use the
 * most recently constructed runtime, preserving the root SDK's active-home
 * behavior without exposing engine log services to consumers.
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

type WritableLogLevel = Exclude<LogLevel, 'off'>;

interface DiagnosticEntry {
  readonly level: WritableLogLevel;
  readonly message: string;
  readonly payload?: LogPayload;
}

export interface DiagnosticLogBackend {
  readonly globalLogPath: string;
  write(
    level: WritableLogLevel,
    message: string,
    payload?: LogPayload,
  ): boolean;
  flush(): Promise<void>;
  flushSync?(): void;
}

export interface DiagnosticLogRegistration {
  dispose(): void;
}

interface BackendSlot {
  readonly pending: DiagnosticEntry[];
  ready: Promise<void>;
  backend?: DiagnosticLogBackend;
  disposed: boolean;
  failed: boolean;
}

const backendSlots: BackendSlot[] = [];

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

  private emit(
    level: WritableLogLevel,
    message: string,
    payload?: LogPayload,
  ): void {
    const entry: DiagnosticEntry = {
      level,
      message,
      payload: mergePayloadContext(payload, this.boundCtx),
    };
    if (routeEntry(entry)) return;
    emitFallback(entry);
  }
}

export const log: Logger = new SimpleLogger({});

export function registerDiagnosticLogBackend(
  backendReady: Promise<DiagnosticLogBackend>,
): DiagnosticLogRegistration {
  const slot = {
    pending: [],
    ready: Promise.resolve(),
    disposed: false,
    failed: false,
  } as BackendSlot;
  slot.ready = backendReady.then(
    (backend) => {
      if (slot.disposed) return;
      slot.backend = backend;
      for (const entry of slot.pending.splice(0)) {
        backend.write(entry.level, entry.message, entry.payload);
      }
    },
    () => {
      slot.failed = true;
      slot.pending.length = 0;
    },
  );
  backendSlots.push(slot);
  return {
    dispose(): void {
      if (slot.disposed) return;
      slot.disposed = true;
      slot.pending.length = 0;
      const index = backendSlots.indexOf(slot);
      if (index >= 0) backendSlots.splice(index, 1);
    },
  };
}

export async function resolveActiveGlobalLogPath(): Promise<string | undefined> {
  const slot = latestSlot();
  if (slot === undefined) return undefined;
  await slot.ready;
  return slot.backend?.globalLogPath;
}

export async function flushDiagnosticLogs(): Promise<boolean> {
  const slots = [...backendSlots];
  await Promise.all(slots.map((slot) => slot.ready));
  const results = await Promise.all(
    slots.map(async (slot) => {
      if (slot.disposed || slot.failed || slot.backend === undefined) return false;
      try {
        await slot.backend.flush();
        return true;
      } catch {
        return false;
      }
    }),
  );
  return results.every(Boolean);
}

export function flushDiagnosticLogsSync(): void {
  for (const slot of backendSlots) {
    if (!slot.disposed) slot.backend?.flushSync?.();
  }
}

export function getRootLoggerInfo(): { readonly log: Logger } {
  return { log };
}

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

function routeEntry(entry: DiagnosticEntry): boolean {
  if (entrySessionId(entry) !== undefined) {
    for (let i = backendSlots.length - 1; i >= 0; i--) {
      const slot = backendSlots[i]!;
      if (
        !slot.disposed &&
        slot.backend?.write(entry.level, entry.message, entry.payload) === true
      ) {
        return true;
      }
    }
  }

  const slot = latestSlot();
  if (slot === undefined) return false;
  if (slot.backend !== undefined) {
    return slot.backend.write(entry.level, entry.message, entry.payload);
  }
  if (!slot.failed) {
    slot.pending.push(entry);
    return true;
  }
  return false;
}

function latestSlot(): BackendSlot | undefined {
  for (let i = backendSlots.length - 1; i >= 0; i--) {
    const slot = backendSlots[i]!;
    if (!slot.disposed) return slot;
  }
  return undefined;
}

function mergePayloadContext(
  payload: LogPayload | undefined,
  bound: LogContext,
): LogPayload | undefined {
  if (Object.keys(bound).length === 0) return payload;
  if (payload instanceof Error) return { error: payload, ...bound };
  return { ...payload, ...bound };
}

function entrySessionId(entry: DiagnosticEntry): string | undefined {
  const payload = entry.payload;
  if (payload === undefined || payload instanceof Error) return undefined;
  const sessionId = payload['sessionId'];
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

function emitFallback(entry: DiagnosticEntry): void {
  if (!fallbackEnabled(entry.level)) return;
  const sessionId = entrySessionId(entry);
  const prefix =
    sessionId === undefined
      ? `[kimi:${entry.level}]`
      : `[kimi:${entry.level}] [session:${sessionId}]`;
  process.stderr.write(`${prefix} ${entry.message}\n`);
}

function fallbackEnabled(level: WritableLogLevel): boolean {
  const configured = process.env['KIMI_LOG_LEVEL']?.trim().toLowerCase() ?? 'off';
  const order: LogLevel[] = ['off', 'error', 'warn', 'info', 'debug'];
  const targetIndex = order.indexOf(level);
  const configuredIndex = order.indexOf(configured as LogLevel);
  return targetIndex > 0 && configuredIndex >= targetIndex;
}

function redactTree(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = REDACTED_MESSAGE;
    } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = redactTree(val as Record<string, unknown>);
    } else if (Array.isArray(val)) {
      result[key] = val.map((item) =>
        item !== null && typeof item === 'object'
          ? redactTree(item as Record<string, unknown>)
          : item,
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}
