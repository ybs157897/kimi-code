/**
 * Scenario: code-extension slash commands cross the TUI runtime boundary.
 * Responsibilities: legacy and Klient-shaped adapters preserve list, reload,
 * and activation semantics. Each runtime facade is the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/extension-command-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { dispatchInput, type SlashCommandHost } from '#/tui/commands/dispatch';
import { createKlientExtensionCommandPort } from '#/tui/runtime/klient-extension-command-adapter';
import { createLegacyExtensionCommandPort } from '#/tui/runtime/legacy-extension-command-adapter';

describe('extension command runtime port (adapter contract)', () => {
  it('dispatches a registered extension command without a legacy Session argument', () => {
    const activateExtensionCommand = vi.fn();
    const host = {
      state: { appState: { streamingPhase: 'idle', isCompacting: false } },
      skillCommandMap: new Map(),
      pluginCommandMap: new Map(),
      extensionCommandNames: new Set(['review:check']),
      track: vi.fn(),
      activateExtensionCommand,
    } as unknown as SlashCommandHost;

    dispatchInput(host, '/review:check src/main.ts');

    expect(activateExtensionCommand).toHaveBeenCalledWith(
      'review:check',
      'src/main.ts',
    );
  });

  it('lists legacy extension commands through the neutral definition shape', async () => {
    const commands = [
      { extensionId: 'review', name: 'check', description: 'Review changes' },
    ];
    const session = legacySession({ listExtensionCommands: vi.fn(async () => commands) });

    const result = await createLegacyExtensionCommandPort(session).list();

    expect(result).toEqual([
      { extensionId: 'review', name: 'check', description: 'Review changes' },
    ]);
  });

  it('reloads the legacy runtime with its existing session semantics', async () => {
    const reloadSession = vi.fn(async () => ({}));
    const session = legacySession({ reloadSession });

    await createLegacyExtensionCommandPort(session).reload();

    expect(reloadSession).toHaveBeenCalledWith({
      forcePluginSessionStartReminder: true,
    });
  });

  it('returns legacy prompt activations for the TUI prompt pipeline', async () => {
    const activateExtensionCommand = vi.fn(async () => ({ prompt: 'Review src/main.ts' }));
    const session = legacySession({ activateExtensionCommand });

    const result = await createLegacyExtensionCommandPort(session).activate(
      'review:check',
      'src/main.ts',
    );

    expect(result).toEqual({ prompt: 'Review src/main.ts' });
  });

  it('lists Klient extension commands from the session facade', async () => {
    const listCommands = vi.fn(async () => [
      { extensionId: 'review', name: 'check', description: 'Review changes' },
    ]);
    const session = klientSession({ listCommands });

    const result = await createKlientExtensionCommandPort(session).list();

    expect(result).toEqual([
      { extensionId: 'review', name: 'check', description: 'Review changes' },
    ]);
  });

  it('reloads Klient extensions through the session facade', async () => {
    const reload = vi.fn(async () => ({ active: [], errors: [] }));
    const session = klientSession({ reload });

    await createKlientExtensionCommandPort(session).reload();

    expect(reload).toHaveBeenCalledOnce();
  });

  it('activates a namespaced Klient command through the main-agent facade', async () => {
    const activateCommand = vi.fn(async () => true);
    const session = klientSession({ activateCommand });

    const result = await createKlientExtensionCommandPort(session).activate(
      'review:check',
      'src/main.ts',
    );

    expect(activateCommand).toHaveBeenCalledWith({
      extensionId: 'review',
      name: 'check',
      args: 'src/main.ts',
    });
    expect(result).toBeUndefined();
  });

  it('rejects a Klient command when the agent reports it unavailable', async () => {
    const session = klientSession({
      activateCommand: vi.fn(async () => false),
    });

    const result = createKlientExtensionCommandPort(session).activate(
      'review:missing',
      '',
    );

    await expect(result).rejects.toThrow(
      'Extension command "review:missing" is unavailable.',
    );
  });
});

function legacySession(
  overrides: Partial<{
    listExtensionCommands: () => Promise<
      readonly { extensionId: string; name: string; description: string }[]
    >;
    reloadSession: (options: {
      forcePluginSessionStartReminder: boolean;
    }) => Promise<unknown>;
    activateExtensionCommand: (
      name: string,
      args?: string,
    ) => Promise<{ prompt?: string } | undefined>;
  }> = {},
) {
  return {
    listExtensionCommands: vi.fn(async () => []),
    reloadSession: vi.fn(async () => ({})),
    activateExtensionCommand: vi.fn(async () => undefined),
    ...overrides,
  };
}

function klientSession(
  overrides: Partial<{
    listCommands: () => Promise<
      readonly { extensionId: string; name: string; description: string }[]
    >;
    reload: () => Promise<unknown>;
    activateCommand: (input: {
      extensionId: string;
      name: string;
      args?: string;
    }) => Promise<boolean>;
  }> = {},
) {
  const activateCommand = overrides.activateCommand ?? vi.fn(async () => false);
  return {
    extensions: {
      listCommands: overrides.listCommands ?? vi.fn(async () => []),
      reload: overrides.reload ?? vi.fn(async () => ({ active: [], errors: [] })),
    },
    agent: vi.fn(() => ({
      extensions: { activateCommand },
    })),
  };
}
