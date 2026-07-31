import { Readable, Writable } from 'node:stream';

import {
  AgentSideConnection,
  ndJsonStream,
  type Implementation,
  type Stream,
} from '@agentclientprotocol/sdk';
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { log } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from './acp-server';
import { toAcpHost } from './host';
import { redirectConsoleToStderr } from './log-guard';
import type { SlashCommandsResolver } from './slash-commands';
import type { AcpHost } from './types';

/**
 * Drive an {@link AcpServer} over an arbitrary ACP {@link Stream}.
 *
 * Useful for tests that build the stream with `ndJsonStream` over an
 * in-memory pair instead of process stdio.
 */
export async function runAcpServerWithStream(
  host: AcpHost | KimiHarness,
  stream: Stream,
  opts?: {
    agentInfo?: Implementation;
    terminalAuthEnv?: Readonly<Record<string, string>>;
    terminalAuthLegacyCommand?: string;
    slashCommands?: SlashCommandsResolver;
  },
): Promise<void> {
  const conn = new AgentSideConnection((c) => new AcpServer(host, c, opts), stream);
  await conn.closed;
}

/**
 * Drive an {@link AcpServer} over Node stdio (or the supplied streams).
 *
 * The ACP SDK speaks Web `ReadableStream` / `WritableStream`, so Node stdio
 * is bridged through `Readable.toWeb` / `Writable.toWeb`.
 *
 * SIGINT / SIGTERM are wired to a single-shot cleanup that calls
 * {@link AcpHost.close} so an editor terminating the agent process
 * (Zed closing the panel, JetBrains stopping the run config, the user
 * pressing Ctrl-C) drains in-flight sessions before the OS reaps the
 * process. The handlers are installed via `.once(...)` and explicitly
 * uninstalled in `finally` so repeat invocations from tests do not
 * pollute the process-wide listener set.
 *
 * The `signals` option exists primarily for tests — production callers
 * use the default of `process`. A test can pass a fresh
 * `EventEmitter`, emit `'SIGINT'` on it, and assert `host.close()`
 * was called exactly once without touching the real Node signal
 * handlers (which vitest itself relies on).
 */
export async function runAcpServer(
  hostInput: AcpHost | KimiHarness,
  opts?: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    /**
     * Optional agent identity metadata advertised in the `initialize`
     * response (`InitializeResponse.agentInfo`). When omitted, the
     * field is left out of the response rather than serialized as
     * `null`, matching the kimi-cli reference implementation.
     */
    agentInfo?: Implementation;
    /**
     * Env vars to forward to the `kimi login` subprocess clients spawn
     * via `terminal-auth`. See {@link AcpServer} ctor for the use case.
     */
    terminalAuthEnv?: Readonly<Record<string, string>>;
    /**
     * Absolute path to the agent binary, advertised in the legacy
     * `_meta['terminal-auth'].command` fallback. See {@link AcpServer}
     * ctor for compatibility rationale.
     */
    terminalAuthLegacyCommand?: string;
    /**
     * Slash commands to advertise to ACP clients so their slash-command
     * palette is populated. See {@link AcpServer} ctor for details.
     */
    slashCommands?: SlashCommandsResolver;
    /**
     * @internal Test seam — supply a fake `EventEmitter` (or a
     * subset that exposes `.once` / `.off`) to drive SIGINT / SIGTERM
     * without touching the real `process` listener set. Defaults to
     * `process` in production.
     */
    signals?: Pick<NodeJS.EventEmitter, 'once' | 'off'>;
  },
): Promise<void> {
  // Stdout is the JSON-RPC channel; protect it before anything else
  // (a dependency, harness, etc.) can emit non-JSON via console.log.
  redirectConsoleToStderr();
  const input = (opts?.input ?? process.stdin) as Readable;
  const output = (opts?.output ?? process.stdout) as Writable;
  const stream = ndJsonStream(Writable.toWeb(output), Readable.toWeb(input));
  const signals = opts?.signals ?? process;
  const host = toAcpHost(hostInput);

  let cleanedUp = false;
  const cleanup = async (signal?: NodeJS.Signals): Promise<void> => {
    // Idempotent: signal-then-natural-close (or vice-versa) must not
    // call `harness.close()` twice. `cleanedUp` is checked-and-set
    // synchronously so concurrent invocations cannot race.
    if (cleanedUp) return;
    cleanedUp = true;
    if (signal) {
      log.info('acp: received signal, draining harness', { signal });
    }
    try {
      await host.close?.();
    } catch (error) {
      // The process is exiting either way; log so the diagnostic is
      // preserved rather than disappearing into a thrown promise.
      log.error('acp: harness close failed during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onSigint = (): void => {
    void cleanup('SIGINT');
  };
  const onSigterm = (): void => {
    void cleanup('SIGTERM');
  };
  signals.once('SIGINT', onSigint);
  signals.once('SIGTERM', onSigterm);

  try {
    // Resolves when `AgentSideConnection.closed` settles — either
    // because the client disconnected stdin (natural EOF) or because
    // a signal handler closed the underlying stream.
    await runAcpServerWithStream(host, stream, {
      agentInfo: opts?.agentInfo,
      terminalAuthEnv: opts?.terminalAuthEnv,
      terminalAuthLegacyCommand: opts?.terminalAuthLegacyCommand,
      slashCommands: opts?.slashCommands,
    });
  } finally {
    // Uninstall BEFORE the final cleanup so a second SIGINT (a user
    // double-tapping Ctrl-C while the drain is in flight) propagates
    // to the default handler and force-kills the process — exactly
    // the behaviour terminal users expect.
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
    await cleanup();
  }
}
