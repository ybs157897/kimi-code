/**
 * Scenario: code-extension slash commands cross the TUI runtime boundary.
 * Responsibilities: Klient-shaped adapters preserve list, reload,
 * and activation semantics. Each runtime facade is the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/extension-command-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { dispatchInput, type SlashCommandHost } from '#/tui/commands/dispatch';
import { createKlientExtensionCommandPort } from '#/tui/runtime/klient-extension-command-adapter';

describe('extension command runtime port (adapter contract)', () => {
  it('dispatches a registered extension command without a Session argument', () => {
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
