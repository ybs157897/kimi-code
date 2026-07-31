// Shared WebSocket bus for terminal IO. Every Terminal tab demuxes through one
// connectEvents socket instead of opening a connection per tab. When the
// underlying IPC/WS connection drops and recovers, every still-attached
// terminal is re-attached at its last seen seq so the replay buffer catches
// the disconnected span up.

import { getKimiWebApi } from '../api';
import type { KimiEventConnection } from '../api/types';

type OutputHandler = (data: string, seq: number) => void;
type ExitHandler = (exitCode: number | null) => void;
type ConnectionHandler = (connected: boolean) => void;

interface TerminalListeners {
  output: Set<OutputHandler>;
  exit: Set<ExitHandler>;
}

function terminalKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\0${terminalId}`;
}

let conn: KimiEventConnection | null = null;
let connRefCount = 0;
const listeners = new Map<string, TerminalListeners>();
const connectionHandlers = new Set<ConnectionHandler>();
// Last delivered output seq per terminal, so a reconnect re-attaches at the
// right replay cursor (0 for terminals that never produced output).
const lastSeqs = new Map<string, number>();
let connected = false;

function ensureConnection(): KimiEventConnection | null {
  if (conn !== null) return conn;
  if (typeof WebSocket === 'undefined') return null;
  conn = getKimiWebApi().connectEvents({
    onEvent: () => {},
    onResync: () => {},
    onError: () => {},
    onConnectionChange: (state) => {
      const wasConnected = connected;
      connected = state;
      for (const handler of connectionHandlers) handler(state);
      if (state && !wasConnected && conn !== null) {
        // The socket recovered — re-attach every active terminal at its last
        // seq so buffered output from the disconnected span is replayed.
        for (const [key, lastSeq] of lastSeqs) {
          if (!listeners.has(key)) continue;
          const separator = key.indexOf('\0');
          if (separator < 0) continue;
          const sessionId = key.slice(0, separator);
          const terminalId = key.slice(separator + 1);
          conn.terminalAttach(sessionId, terminalId, lastSeq);
        }
      }
    },
    onTerminalOutput: (sessionId, terminalId, data, seq) => {
      lastSeqs.set(terminalKey(sessionId, terminalId), seq);
      const entry = listeners.get(terminalKey(sessionId, terminalId));
      if (!entry) return;
      for (const handler of entry.output) handler(data, seq);
    },
    onTerminalExit: (sessionId, terminalId, exitCode) => {
      const entry = listeners.get(terminalKey(sessionId, terminalId));
      if (!entry) return;
      for (const handler of entry.exit) handler(exitCode);
    },
  });
  return conn;
}

function retainConnection(): KimiEventConnection | null {
  const next = ensureConnection();
  if (next) connRefCount += 1;
  return next;
}

function releaseConnection(): void {
  connRefCount = Math.max(0, connRefCount - 1);
  if (connRefCount > 0 || conn === null) return;
  conn.close();
  conn = null;
  connected = false;
}

function getListeners(sessionId: string, terminalId: string): TerminalListeners {
  const key = terminalKey(sessionId, terminalId);
  let entry = listeners.get(key);
  if (!entry) {
    entry = { output: new Set(), exit: new Set() };
    listeners.set(key, entry);
  }
  return entry;
}

export function terminalBusConnected(): boolean {
  return connected;
}

export function onTerminalBusConnection(handler: ConnectionHandler): () => void {
  connectionHandlers.add(handler);
  handler(connected);
  return () => {
    connectionHandlers.delete(handler);
  };
}

export function terminalBusAttach(
  sessionId: string,
  terminalId: string,
  sinceSeq: number,
  onOutput: OutputHandler,
  onExit: ExitHandler,
): () => void {
  const socket = retainConnection();
  const key = terminalKey(sessionId, terminalId);
  const entry = getListeners(sessionId, terminalId);
  entry.output.add(onOutput);
  entry.exit.add(onExit);
  if (sinceSeq === 0) lastSeqs.delete(key);
  socket?.terminalAttach(sessionId, terminalId, sinceSeq);

  return () => {
    entry.output.delete(onOutput);
    entry.exit.delete(onExit);
    if (entry.output.size === 0 && entry.exit.size === 0) {
      listeners.delete(key);
      lastSeqs.delete(key);
      socket?.terminalDetach(sessionId, terminalId);
    }
    releaseConnection();
  };
}

export function terminalBusInput(sessionId: string, terminalId: string, data: string): void {
  ensureConnection()?.terminalInput(sessionId, terminalId, data);
}

export function terminalBusResize(
  sessionId: string,
  terminalId: string,
  cols: number,
  rows: number,
): void {
  ensureConnection()?.terminalResize(sessionId, terminalId, cols, rows);
}

export function terminalBusClose(sessionId: string, terminalId: string): void {
  ensureConnection()?.terminalClose(sessionId, terminalId);
}
