import { onUnmounted, ref, watch, type Ref } from 'vue';
import { getKimiWebApi } from '../api';
import type { AppTerminal } from '../api/types';
import {
  onTerminalBusConnection,
  terminalBusAttach,
  terminalBusClose,
  terminalBusConnected,
  terminalBusInput,
  terminalBusResize,
} from './useTerminalBus';

export type TerminalStartMode = 'reuse' | 'create' | 'attach';

export function useTerminal(
  sessionId: Ref<string>,
  options?: {
    /** When mode is `attach`, the server terminal id to bind to. */
    terminalId?: Ref<string | null>;
    /** reuse = attach first running or create; create = always spawn; attach = bind terminalId. */
    mode?: TerminalStartMode;
  },
) {
  const mode = options?.mode ?? 'reuse';
  const attachId = options?.terminalId;

  const terminal = ref<AppTerminal | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const connected = ref(terminalBusConnected());
  const readOnly = ref(false);
  const lastSeq = ref(0);

  const outputHandlers = new Set<(data: string) => void>();
  const exitHandlers = new Set<(exitCode: number | null) => void>();
  let detachBus: (() => void) | null = null;
  let offConnection: (() => void) | null = null;

  function ensureBusListeners(sessionIdValue: string, terminalId: string): void {
    detachBus?.();
    detachBus = terminalBusAttach(
      sessionIdValue,
      terminalId,
      lastSeq.value,
      (data, seq) => {
        lastSeq.value = Math.max(lastSeq.value, seq);
        for (const handler of outputHandlers) handler(data);
      },
      (exitCode) => {
        readOnly.value = true;
        terminal.value = terminal.value
          ? { ...terminal.value, status: 'exited', exitCode }
          : terminal.value;
        for (const handler of exitHandlers) handler(exitCode);
      },
    );
  }

  if (!offConnection) {
    offConnection = onTerminalBusConnection((state) => {
      connected.value = state;
    });
  }

  async function start(size?: { cols?: number; rows?: number }): Promise<void> {
    const sid = sessionId.value;
    if (!sid || loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      const api = getKimiWebApi();
      let next: AppTerminal | undefined;

      if (mode === 'attach') {
        const id = attachId?.value;
        if (!id) {
          error.value = 'Missing terminal id';
          return;
        }
        next = await api.getTerminal(sid, id);
      } else if (mode === 'create') {
        next = await api.createTerminal(sid, {
          cols: size?.cols,
          rows: size?.rows,
        });
      } else {
        const existing = (await api.listTerminals(sid)).find((item) => item.status === 'running');
        next =
          existing ??
          (await api.createTerminal(sid, {
            cols: size?.cols,
            rows: size?.rows,
          }));
      }

      terminal.value = next;
      readOnly.value = next.status === 'exited';
      ensureBusListeners(sid, next.id);
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : String(error_);
    } finally {
      loading.value = false;
    }
  }

  function write(data: string): void {
    const current = terminal.value;
    if (!current || readOnly.value) return;
    terminalBusInput(current.sessionId, current.id, data);
  }

  function resize(cols: number, rows: number): void {
    const current = terminal.value;
    if (!current || readOnly.value) return;
    terminalBusResize(current.sessionId, current.id, cols, rows);
  }

  async function close(): Promise<void> {
    const current = terminal.value;
    if (!current) return;
    readOnly.value = true;
    try {
      terminalBusClose(current.sessionId, current.id);
      await getKimiWebApi().closeTerminal(current.sessionId, current.id);
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : String(error_);
    }
  }

  function restart(): void {
    detachBus?.();
    detachBus = null;
    terminal.value = null;
    readOnly.value = false;
    lastSeq.value = 0;
    void start();
  }

  function onOutput(handler: (data: string) => void): () => void {
    outputHandlers.add(handler);
    return () => {
      outputHandlers.delete(handler);
    };
  }

  function onExit(handler: (exitCode: number | null) => void): () => void {
    exitHandlers.add(handler);
    return () => {
      exitHandlers.delete(handler);
    };
  }

  watch(sessionId, () => {
    detachBus?.();
    detachBus = null;
    terminal.value = null;
    readOnly.value = false;
    lastSeq.value = 0;
  });

  onUnmounted(() => {
    detachBus?.();
    detachBus = null;
    offConnection?.();
    offConnection = null;
  });

  return {
    terminal,
    loading,
    error,
    connected,
    readOnly,
    start,
    write,
    resize,
    close,
    restart,
    onOutput,
    onExit,
  };
}
