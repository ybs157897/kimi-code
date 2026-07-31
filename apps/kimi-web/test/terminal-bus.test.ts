// useTerminalBus tests — shared terminal bus: attach forwards the replay
// cursor, output/exit fan out, and an IPC/WS reconnect re-attaches every
// active terminal at its last seen seq (so the disconnected span replays).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api', () => ({
  getKimiWebApi: vi.fn(),
}));

type ChangeHandler = (state: boolean) => void;
type OutputHandler = (sessionId: string, terminalId: string, data: string, seq: number) => void;
type ExitHandler = (sessionId: string, terminalId: string, exitCode: number | null) => void;

interface FakeConnection {
  attaches: Array<{ sessionId: string; terminalId: string; sinceSeq?: number }>;
  detaches: Array<{ sessionId: string; terminalId: string }>;
  terminalAttach: ReturnType<typeof vi.fn>;
  terminalDetach: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emitOutput: (sessionId: string, terminalId: string, data: string, seq: number) => void;
  emitExit: (sessionId: string, terminalId: string, exitCode: number | null) => void;
  setConnected: (state: boolean) => void;
}

function makeApi(): { api: ReturnType<typeof vi.fn>; conn: FakeConnection } {
  let connChange: ChangeHandler | undefined;
  let outputHandler: OutputHandler | undefined;
  let exitHandler: ExitHandler | undefined;
  let connected = false;
  const conn: FakeConnection = {
    attaches: [],
    detaches: [],
    terminalAttach: vi.fn((sessionId: string, terminalId: string, sinceSeq?: number) => {
      conn.attaches.push({ sessionId, terminalId, sinceSeq });
    }),
    terminalDetach: vi.fn((sessionId: string, terminalId: string) => {
      conn.detaches.push({ sessionId, terminalId });
    }),
    close: vi.fn(),
    emitOutput: (sessionId, terminalId, data, seq) => outputHandler?.(sessionId, terminalId, data, seq),
    emitExit: (sessionId, terminalId, exitCode) => exitHandler?.(sessionId, terminalId, exitCode),
    setConnected: (state) => {
      connected = state;
      connChange?.(state);
    },
  };
  const api = vi.fn(() => ({
    connectEvents: vi.fn((handlers: {
      onConnectionChange: ChangeHandler;
      onTerminalOutput: OutputHandler;
      onTerminalExit: ExitHandler;
    }) => {
      connChange = handlers.onConnectionChange;
      outputHandler = handlers.onTerminalOutput;
      exitHandler = handlers.onTerminalExit;
      handlers.onConnectionChange(connected);
      return conn as unknown as ReturnType<ReturnType<typeof getKimiWebApi>['connectEvents']>;
    }),
  }));
  return { api, conn };
}

import { getKimiWebApi } from '../src/api';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useTerminalBus', () => {
  it('attaches at the given cursor and fans output/exit out', async () => {
    const { api, conn } = makeApi();
    (getKimiWebApi as ReturnType<typeof vi.fn>).mockImplementation(api);
    const { terminalBusAttach } = await import('../src/composables/useTerminalBus');

    const output = vi.fn();
    const exit = vi.fn();
    const detach = terminalBusAttach('s-1', 't-1', 5, output, exit);

    expect(conn.attaches).toEqual([{ sessionId: 's-1', terminalId: 't-1', sinceSeq: 5 }]);

    conn.emitOutput('s-1', 't-1', 'hello', 6);
    expect(output).toHaveBeenCalledWith('hello', 6);
    conn.emitExit('s-1', 't-1', 0);
    expect(exit).toHaveBeenCalledWith(0);

    detach();
    expect(conn.detaches).toEqual([{ sessionId: 's-1', terminalId: 't-1' }]);
  });

  it('re-attaches every active terminal at its last seq after a reconnect', async () => {
    const { api, conn } = makeApi();
    (getKimiWebApi as ReturnType<typeof vi.fn>).mockImplementation(api);
    const { terminalBusAttach } = await import('../src/composables/useTerminalBus');

    const output = vi.fn();
    terminalBusAttach('s-1', 't-1', 0, output, vi.fn());
    conn.emitOutput('s-1', 't-1', 'a', 3);
    conn.emitOutput('s-1', 't-1', 'b', 4);
    expect(conn.attaches).toHaveLength(1);

    // IPC drops: the shell reports the disconnect, then a successful re-dial.
    conn.setConnected(false);
    conn.setConnected(true);

    // The re-attach resumes at the last delivered seq so the replay buffer
    // catches the disconnected span up.
    expect(conn.attaches.at(-1)).toEqual({ sessionId: 's-1', terminalId: 't-1', sinceSeq: 4 });
  });

  it('a fresh attach (sinceSeq 0) resets the terminal replay cursor', async () => {
    const { api, conn } = makeApi();
    (getKimiWebApi as ReturnType<typeof vi.fn>).mockImplementation(api);
    const { terminalBusAttach } = await import('../src/composables/useTerminalBus');

    const output = vi.fn();
    const detach1 = terminalBusAttach('s-1', 't-1', 0, output, vi.fn());
    conn.emitOutput('s-1', 't-1', 'a', 9);
    detach1();

    // Re-attach from scratch: cursor resets to 0 (whole history replays).
    terminalBusAttach('s-1', 't-1', 0, output, vi.fn());
    conn.setConnected(false);
    conn.setConnected(true);
    expect(conn.attaches.at(-1)?.sinceSeq).toBe(0);
  });
});
