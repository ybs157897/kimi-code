/**
 * `kimi acp`
 *
 * Verifies that the ACP sub-command is registered on the program and
 * that the action wires the harness into `@moonshot-ai/acp-adapter`'s
 * `runAcpServer` (the real server is stubbed so the test doesn't
 * actually take over stdio).
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAcpServer, V2AcpHost } from '@moonshot-ai/acp-adapter';
import { createKimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import { registerAcpCommand } from '#/cli/sub/acp';

const mocks = vi.hoisted(() => {
  const runtime = { kind: 'v2-runtime' };
  return {
    runtime,
    createKimiV2Runtime: vi.fn(async () => runtime),
    runAcpServer: vi.fn(async () => undefined),
  };
});

vi.mock('@moonshot-ai/acp-adapter', () => ({
  ACP_BUILTIN_SLASH_COMMANDS: [],
  runAcpServer: mocks.runAcpServer,
  V2AcpHost: class {
    constructor(readonly runtime: unknown) {}
  },
}));

vi.mock('@moonshot-ai/kimi-code-sdk/v2', () => ({
  createKimiV2Runtime: mocks.createKimiV2Runtime,
}));

class ExitCalled extends Error {
  constructor(public code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe('kimi acp', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(runAcpServer).mockClear();
    vi.mocked(createKimiV2Runtime).mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new ExitCalled(code);
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('registers an `acp` subcommand on the program', () => {
    const program = new Command('kimi');
    registerAcpCommand(program);

    const acp = program.commands.find((c) => c.name() === 'acp');
    expect(acp).toBeDefined();
    expect(acp?.description()).toMatch(/Agent Client Protocol/);
  });

  it('creates the v2 runtime and invokes runAcpServer with a V2AcpHost', async () => {
    const program = new Command('kimi').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

    expect(runAcpServer).toHaveBeenCalledTimes(1);
    const hostArg = vi.mocked(runAcpServer).mock.calls[0]?.[0];
    expect(createKimiV2Runtime).toHaveBeenCalledTimes(1);
    expect(hostArg).toBeInstanceOf(V2AcpHost);
    expect(hostArg).toMatchObject({ runtime: mocks.runtime });
    const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[1];
    expect(optsArg).toEqual(
      expect.objectContaining({
        agentInfo: { name: 'Kimi Code CLI', version: expect.any(String) },
      }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('forwards KIMI_CODE_HOME to terminalAuthEnv when set', async () => {
    const previous = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = '/tmp/kimi-debug';
    try {
      const program = new Command('kimi').exitOverride();
      registerAcpCommand(program);

      await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

      const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[1];
      expect(optsArg).toEqual(
        expect.objectContaining({
          terminalAuthEnv: { KIMI_CODE_HOME: '/tmp/kimi-debug' },
        }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env['KIMI_CODE_HOME'];
      } else {
        process.env['KIMI_CODE_HOME'] = previous;
      }
    }
  });

  it('omits terminalAuthEnv when KIMI_CODE_HOME is unset', async () => {
    const previous = process.env['KIMI_CODE_HOME'];
    delete process.env['KIMI_CODE_HOME'];
    try {
      const program = new Command('kimi').exitOverride();
      registerAcpCommand(program);

      await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

      const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[1] as {
        terminalAuthEnv?: unknown;
      };
      expect(optsArg.terminalAuthEnv).toBeUndefined();
    } finally {
      if (previous !== undefined) {
        process.env['KIMI_CODE_HOME'] = previous;
      }
    }
  });

  it('forwards process.argv[1] as terminalAuthLegacyCommand', async () => {
    const program = new Command('kimi').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

    const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[1] as {
      terminalAuthLegacyCommand?: string;
    };
    // process.argv[1] points at the test runner entry — non-empty
    // absolute-ish path, exactly what we want forwarded.
    expect(typeof optsArg.terminalAuthLegacyCommand).toBe('string');
    expect((optsArg.terminalAuthLegacyCommand ?? '').length).toBeGreaterThan(0);
    expect(optsArg.terminalAuthLegacyCommand).toBe(process.argv[1]);
  });

  it('exits without starting the ACP server when --login is passed', async () => {
    // Stub the auth facade so runLoginFlow doesn't hit a real OAuth
    // endpoint: auth.login resolves immediately and triggers exit 0.
    // `importOriginal` preserves the other named exports (`ErrorCodes`, etc.)
    // that constant/app.ts depends on at module load.
    const loginStub = vi.fn(async (..._args: unknown[]) => ({
      providerName: 'kimi-code',
      ok: true as const,
      defaultModel: 'k2',
      defaultThinking: true,
    }));
    vi.doMock(import('@moonshot-ai/kimi-code-sdk'), async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        KimiAuthFacade: class extends actual.KimiAuthFacade {
          override login(
            ...args: Parameters<InstanceType<typeof actual.KimiAuthFacade>['login']>
          ): ReturnType<InstanceType<typeof actual.KimiAuthFacade>['login']> {
            return loginStub(...args);
          }
        },
      };
    });
    vi.resetModules();
    const { registerAcpCommand: freshRegister } = await import('#/cli/sub/acp');
    try {
      const program = new Command('kimi').exitOverride();
      freshRegister(program);

      await expect(program.parseAsync(['node', 'kimi', 'acp', '--login'])).rejects.toThrow(
        ExitCalled,
      );

      expect(loginStub).toHaveBeenCalledTimes(1);
      expect(runAcpServer).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      vi.doUnmock('@moonshot-ai/kimi-code-sdk');
      vi.resetModules();
    }
  });
});
