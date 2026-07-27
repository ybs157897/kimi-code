/**
 * Scenario: reload slash commands update TUI config plus runtime-owned session
 * and process state. Real config-file loading is wired to isolated temp homes;
 * runtime/session boundaries are stubs. Run with:
 * pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/commands/reload.test.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  handleReloadCommand,
  handleReloadTuiCommand,
} from '#/tui/commands/reload';
import { currentTheme } from '#/tui/theme';
import type { SlashCommandHost } from '#/tui/commands';
import {
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
} from '#/tui/commands/experimental-flags';
import type { TUISessionRuntime } from '#/tui/runtime/tui-session-runtime';

const tempDirs: string[] = [];
const originalKimiCodeHome = process.env['KIMI_CODE_HOME'];

afterEach(async () => {
  setExperimentalFeatures([]);
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  if (originalKimiCodeHome === undefined) {
    delete process.env['KIMI_CODE_HOME'];
  } else {
    process.env['KIMI_CODE_HOME'] = originalKimiCodeHome;
  }
});

describe('reload slash commands', () => {
  it('reloads tui.toml without touching Core session state', async () => {
    await writeTuiConfig(`
theme = "light"

[editor]
command = "vim"

[notifications]
enabled = false
notification_condition = "always"

[upgrade]
auto_install = false
`);
    const session = {};
    const host = makeHost({ session });

    await handleReloadTuiCommand(host);

    expect(host.harness.getConfig).not.toHaveBeenCalled();
    expect(host.harness.getExperimentalFeatures).not.toHaveBeenCalled();
    expect(host.runtime.models.load).not.toHaveBeenCalled();
    expect(host.runtime.featureFlags.list).not.toHaveBeenCalled();
    expect(host.state.appState).toMatchObject({
      theme: 'light',
      editorCommand: 'vim',
      notifications: { enabled: false, condition: 'always' },
      upgrade: { autoInstall: false },
    });
    expect(host.showStatus).toHaveBeenCalledWith(
      'TUI config reloaded.',
      'success',
    );
  });

  it('fully refreshes a runtime-only active session without requiring a raw Session', async () => {
    await writeTuiConfig('theme = "light"\n');
    const trace: string[] = [];
    const sessionRuntime = makeSessionRuntime(trace);
    const host = makeHost({ sessionRuntime, trace });

    await handleReloadCommand(host);

    expect(trace).toEqual([
      'refresh.reload',
      'refreshSkillCommands',
      'refreshPluginCommands',
      'refreshExtensionCommands',
    ]);
    expect(host.reloadCurrentSessionView).toHaveBeenCalledExactlyOnceWith(
      'Session reloaded.',
    );
    expect(host.runtime.models.load).toHaveBeenCalledWith({ reload: true });
    expect(host.runtime.featureFlags.list).toHaveBeenCalledOnce();
    expect(host.harness.getConfig).not.toHaveBeenCalled();
    expect(host.harness.getExperimentalFeatures).not.toHaveBeenCalled();
    expect(host.refreshSlashCommandAutocomplete).toHaveBeenCalledOnce();
    expect(isExperimentalFlagEnabled('micro_compaction')).toBe(true);
    expect(host.state.appState).toMatchObject({
      theme: 'light',
      availableModels: {
        fresh: {
          provider: 'test',
          model: 'fresh-model',
          maxContextSize: 1000,
        },
      },
      availableProviders: {
        test: {
          type: 'kimi',
          baseUrl: 'https://example.test',
          defaultModel: 'fresh',
        },
      },
    });
  });

  it('rebinds the active session view after runtime-port reload', async () => {
    await writeTuiConfig('theme = "light"\n');
    const session = { id: 'ses-1' };
    const sessionRuntime = makeSessionRuntime();
    const host = makeHost({ session, sessionRuntime });

    await handleReloadCommand(host);

    expect(sessionRuntime.refresh.reload).toHaveBeenCalledOnce();
    expect(host.reloadCurrentSessionView).toHaveBeenCalledWith(
      'Session reloaded.',
    );
  });

  it('refreshes global runtime state when no session is active', async () => {
    await writeTuiConfig('theme = "light"\n');
    const host = makeHost();

    await handleReloadCommand(host);

    expect(host.requireSessionRuntime).toHaveBeenCalledOnce();
    expect(host.reloadCurrentSessionView).not.toHaveBeenCalled();
    expect(host.refreshSkillCommands).not.toHaveBeenCalled();
    expect(host.refreshPluginCommands).not.toHaveBeenCalled();
    expect(host.refreshExtensionCommands).not.toHaveBeenCalled();
    expect(host.runtime.models.load).toHaveBeenCalledWith({ reload: true });
    expect(host.runtime.featureFlags.list).toHaveBeenCalledOnce();
    expect(host.refreshSlashCommandAutocomplete).toHaveBeenCalledOnce();
    expect(isExperimentalFlagEnabled('micro_compaction')).toBe(true);
    expect(host.state.appState.theme).toBe('light');
    expect(host.state.appState.availableModels).toEqual({
      fresh: { provider: 'test', model: 'fresh-model', maxContextSize: 1000 },
    });
    expect(host.showStatus).toHaveBeenCalledWith(
      'Runtime and TUI config reloaded; no active session.',
      'success',
    );
  });

  it('propagates a session runtime reload failure without continuing', async () => {
    await writeTuiConfig('theme = "light"\n');
    const sessionRuntime = makeSessionRuntime();
    vi.mocked(sessionRuntime.refresh.reload).mockRejectedValueOnce(
      new Error('session reload failed'),
    );
    const host = makeHost({ sessionRuntime });

    await expect(handleReloadCommand(host)).rejects.toThrow(
      'session reload failed',
    );

    expect(sessionRuntime.skills.reload).not.toHaveBeenCalled();
    expect(sessionRuntime.plugins.reload).not.toHaveBeenCalled();
    expect(sessionRuntime.extensionCommands.reload).not.toHaveBeenCalled();
    expect(host.runtime.models.load).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
  });

  it('awaits the async theme application before refreshing terminal tracking', async () => {
    await writeTuiConfig('theme = "auto"\n');
    const host = makeHost();
    const mutable = host as unknown as {
      applyTheme: (theme: string) => Promise<void>;
      refreshTerminalThemeTracking: () => void;
      state: { appState: { theme: string } };
    };

    let themeWhenTracked: string | undefined;
    // Theme application resolves on a later microtask, mirroring the real
    // async palette load; tracking must observe the *new* theme.
    mutable.applyTheme = vi.fn(async (theme: string) => {
      await Promise.resolve();
      mutable.state.appState.theme = theme;
    });
    mutable.refreshTerminalThemeTracking = vi.fn(() => {
      themeWhenTracked = mutable.state.appState.theme;
    });

    await handleReloadTuiCommand(host);

    expect(themeWhenTracked).toBe('auto');
  });
});

async function writeTuiConfig(text: string): Promise<void> {
  const dir = join(tmpdir(), `kimi-tui-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  process.env['KIMI_CODE_HOME'] = dir;
  await writeFile(join(dir, 'tui.toml'), text, 'utf-8');
}

function makeHost({
  session,
  sessionRuntime,
  trace,
}: {
  readonly session?: Record<string, unknown>;
  readonly sessionRuntime?: TUISessionRuntime;
  readonly trace?: string[];
} = {}) {
  const state = {
    appState: {
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      availableModels: {},
      availableProviders: {},
    },
    editor: {
      setDisablePasteBurst: vi.fn(),
    },
    theme: {
      palette: {
        success: '#00ff00',
      },
    },
  };
  return {
    state,
    session,
    harness: {
      getConfig: vi.fn(),
      getExperimentalFeatures: vi.fn(),
    },
    runtime: {
      models: {
        load: vi.fn(async () => ({
          models: {
            fresh: {
              provider: 'test',
              model: 'fresh-model',
              maxContextSize: 1000,
            },
          },
          providers: {
            test: {
              type: 'kimi',
              baseUrl: 'https://example.test',
              defaultModel: 'fresh',
              status: 'connected',
              hasApiKey: true,
            },
          },
        })),
      },
      featureFlags: {
        list: vi.fn(async () => [
          {
            id: 'micro_compaction',
            title: 'Micro compaction',
            description: 'Compact tool results.',
            surface: 'both',
            env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
            defaultEnabled: false,
            enabled: true,
            source: 'config',
            configValue: true,
          },
        ]),
      },
    },
    requireSessionRuntime: vi.fn(() => {
      if (sessionRuntime === undefined) {
        throw new Error('No active session.');
      }
      return sessionRuntime;
    }),
    setAppState: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(state.appState, patch);
    }),
    applyTheme: vi.fn((theme: string) => {
      state.appState.theme = theme;
    }),
    refreshTerminalThemeTracking: vi.fn(),
    refreshSlashCommandAutocomplete: vi.fn(),
    refreshSkillCommands: vi.fn(async () => {
      trace?.push('refreshSkillCommands');
    }),
    refreshPluginCommands: vi.fn(async () => {
      trace?.push('refreshPluginCommands');
    }),
    refreshExtensionCommands: vi.fn(async () => {
      trace?.push('refreshExtensionCommands');
    }),
    reloadExtensionCommands: vi.fn(async () => {}),
    reloadCurrentSessionView: vi.fn(async () => {}),
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost & {
    readonly harness: {
      readonly getConfig: ReturnType<typeof vi.fn>;
      readonly getExperimentalFeatures: ReturnType<typeof vi.fn>;
    };
    readonly runtime: {
      readonly models: {
        readonly load: ReturnType<typeof vi.fn>;
      };
      readonly featureFlags: {
        readonly list: ReturnType<typeof vi.fn>;
      };
    };
    readonly requireSessionRuntime: ReturnType<typeof vi.fn>;
    readonly refreshSlashCommandAutocomplete: ReturnType<typeof vi.fn>;
    readonly refreshSkillCommands: ReturnType<typeof vi.fn>;
    readonly refreshPluginCommands: ReturnType<typeof vi.fn>;
    readonly refreshExtensionCommands: ReturnType<typeof vi.fn>;
    readonly reloadExtensionCommands: ReturnType<typeof vi.fn>;
    readonly reloadCurrentSessionView: ReturnType<typeof vi.fn>;
    readonly showStatus: ReturnType<typeof vi.fn>;
  };
}

function makeSessionRuntime(trace?: string[]): TUISessionRuntime {
  return {
    refresh: {
      reload: vi.fn(async () => {
        trace?.push('refresh.reload');
      }),
    },
    skills: {
      reload: vi.fn(async () => {
        trace?.push('skills.reload');
      }),
    },
    plugins: {
      reload: vi.fn(async () => {
        trace?.push('plugins.reload');
        return { added: [], removed: [], errors: [] };
      }),
    },
    extensionCommands: {
      reload: vi.fn(async () => {
        trace?.push('extensionCommands.reload');
      }),
    },
  } as unknown as TUISessionRuntime;
}
