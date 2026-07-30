/**
 * Scenario: `/swarm` and `/btw` operate through an active TUI runtime binding.
 * Responsibilities: command behavior is independent of the raw SDK Session,
 * preserves prompts, markers, normal input, panels, and stable error messages.
 * Wiring: runtime agent/swarm/BTW ports are the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/commands/swarm.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { handleBtwCommand, handleSwarmCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { currentTheme } from '#/tui/theme';

const ENTER = '\r';
const ESCAPE = '\u001B';
const DOWN = '\u001B[B';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

interface TestComponent {
  render(width: number): string[];
}

function makeHost(
  overrides: {
    model?: string;
    hasBinding?: boolean;
    permissionMode?: 'manual' | 'auto' | 'yolo';
    swarmMode?: boolean;
  } = {},
) {
  const agent = {
    setPermission: vi.fn(async () => {}),
  };
  const swarm = {
    isActive: vi.fn(async () => false),
    enter: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
  };
  const btw = {
    start: vi.fn(async () => 'agent-btw'),
  };
  const ports = { agent, swarm, btw };
  const hasBinding = overrides.hasBinding ?? true;
  const sessionId = hasBinding ? 'session-1' : '';
  const runtime = {
    sessionId: 'session-1',
    ...ports,
  };
  const host = {
    state: {
      appState: {
        sessionId,
        model: overrides.model ?? 'kimi-model',
        permissionMode: overrides.permissionMode ?? 'auto',
        swarmMode: overrides.swarmMode ?? false,
      },
      theme: currentTheme,
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: undefined,
    requireSession: vi.fn(() => {
      throw new Error('raw Session must not be used');
    }),
    requireSessionRuntime: vi.fn(() => {
      if (!hasBinding) throw new Error('No active session');
      return runtime;
    }),
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showError: vi.fn(),
    showStatus: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    sendNormalUserInput: vi.fn(),
    btwPanelController: {
      closeOrCancel: vi.fn(),
      open: vi.fn(),
    },
  } as unknown as SlashCommandHost;
  return { host, ports };
}

interface TestPicker {
  handleInput(data: string): void;
  render(width: number): string[];
}

function mountedPicker(host: SlashCommandHost): TestPicker {
  const mock = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0]?.[0] as TestPicker;
}

function markerAddChild(host: SlashCommandHost): ReturnType<typeof vi.fn> {
  return host.state.transcriptContainer.addChild as ReturnType<typeof vi.fn>;
}

function expectSwarmMarker(host: SlashCommandHost, text: string): void {
  const components = markerAddChild(host).mock.calls.map(([component]) => component as TestComponent);
  const rendered = stripAnsi(components.at(-1)?.render(80).join('\n') ?? '');
  expect(rendered).toContain(text);
}

describe('handleSwarmCommand', () => {
  it('sends the swarm prompt as a normal prompt after enabling swarm mode', async () => {
    const { host, ports } = makeHost({ permissionMode: 'auto' });

    await handleSwarmCommand(host, 'Ship feature X');

    expect(ports.agent.setPermission).not.toHaveBeenCalled();
    expect(ports.swarm.enter).toHaveBeenCalledWith('task');
    expect(host.state.swarmModeEntry).toBe('task');
    expectSwarmMarker(host, 'Swarm activated');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('sends the swarm prompt without re-entering swarm mode when already on', async () => {
    const { host, ports } = makeHost({ permissionMode: 'auto', swarmMode: true });

    await handleSwarmCommand(host, 'Ship feature X');

    expect(ports.swarm.enter).not.toHaveBeenCalled();
    expect(host.state.swarmModeEntry).toBeUndefined();
    expectSwarmMarker(host, 'Swarm activated');
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('turns swarm mode on without sending a prompt', async () => {
    const { host, ports } = makeHost({ model: '' });

    await handleSwarmCommand(host, 'on');

    expect(ports.swarm.enter).toHaveBeenCalledWith('manual');
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: true });
    expect(host.state.swarmModeEntry).toBe('manual');
    expectSwarmMarker(host, 'Swarm activated');
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('asks before turning swarm mode on in Manual mode', async () => {
    const { host, ports } = makeHost({ model: '', permissionMode: 'manual' });

    await handleSwarmCommand(host, 'on');

    expect(ports.swarm.enter).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(ports.agent.setPermission).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(host).render(80).join('\n'));
    expect(text).toContain('Manual mode can block swarm work');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(ports.swarm.enter).toHaveBeenCalledWith('manual');
    });
    expect(ports.agent.setPermission).toHaveBeenCalledWith('auto');
    expect(ports.swarm.enter).toHaveBeenCalledTimes(1);
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'auto' });
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: true });
    expect(host.state.swarmModeEntry).toBe('manual');
    expectSwarmMarker(host, 'Swarm activated');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns swarm mode on when called without args while swarm mode is off', async () => {
    const { host, ports } = makeHost({ model: '', swarmMode: false });

    await handleSwarmCommand(host, '');

    expect(ports.swarm.enter).toHaveBeenCalledWith('manual');
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: true });
    expect(host.state.swarmModeEntry).toBe('manual');
    expectSwarmMarker(host, 'Swarm activated');
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not enter swarm mode when swarm mode is already on', async () => {
    const { host, ports } = makeHost({ model: '', swarmMode: true });

    await handleSwarmCommand(host, 'on');

    expect(ports.swarm.enter).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalledWith({ swarmMode: true });
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Swarm mode is already on.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns swarm mode off without sending a prompt', async () => {
    const { host, ports } = makeHost({ model: '', swarmMode: true });

    await handleSwarmCommand(host, 'off');

    expect(ports.swarm.exit).toHaveBeenCalledOnce();
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: false });
    expect(host.state.swarmModeEntry).toBeUndefined();
    expectSwarmMarker(host, 'Swarm deactivated');
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns swarm mode off when called without args while swarm mode is on', async () => {
    const { host, ports } = makeHost({ model: '', swarmMode: true });

    await handleSwarmCommand(host, '');

    expect(ports.swarm.exit).toHaveBeenCalledOnce();
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: false });
    expect(host.state.swarmModeEntry).toBeUndefined();
    expectSwarmMarker(host, 'Swarm deactivated');
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not exit swarm mode when swarm mode is already off', async () => {
    const { host, ports } = makeHost({ model: '', swarmMode: false });

    await handleSwarmCommand(host, 'off');

    expect(ports.swarm.exit).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalledWith({ swarmMode: false });
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Swarm mode is already off.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('asks before starting a swarm task in Manual mode', async () => {
    const { host, ports } = makeHost({ permissionMode: 'manual' });

    await handleSwarmCommand(host, 'Ship feature X');

    expect(ports.swarm.enter).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(ports.agent.setPermission).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(host).render(80).join('\n'));
    expect(text).toContain('Manual mode can block swarm work');
    expect(text).toContain('Switch to YOLO and start');
    expect(text).not.toContain('Do not start');
  });

  it('defaults to Auto when confirming a Manual-mode swarm start', async () => {
    const { host, ports } = makeHost({ permissionMode: 'manual' });

    await handleSwarmCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(ports.agent.setPermission).toHaveBeenCalledWith('auto');
    expect(ports.swarm.enter).toHaveBeenCalledWith('task');
    expect(ports.swarm.enter).toHaveBeenCalledTimes(1);
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'auto' });
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: true });
    expect(host.state.swarmModeEntry).toBe('task');
    expectSwarmMarker(host, 'Swarm activated');
  });

  it('can start a Manual-mode swarm task without changing permission', async () => {
    const { host, ports } = makeHost({ permissionMode: 'manual' });

    await handleSwarmCommand(host, 'Ship feature X');
    const picker = mountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(ports.agent.setPermission).not.toHaveBeenCalled();
    expect(ports.swarm.enter).toHaveBeenCalledWith('task');
    expect(ports.swarm.enter).toHaveBeenCalledTimes(1);
    expect(host.state.swarmModeEntry).toBe('task');
    expectSwarmMarker(host, 'Swarm activated');
  });

  it('can start a Manual-mode swarm task after switching to YOLO', async () => {
    const { host, ports } = makeHost({ permissionMode: 'manual' });

    await handleSwarmCommand(host, 'Ship feature X');
    const picker = mountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(ports.agent.setPermission).toHaveBeenCalledWith('yolo');
    expect(ports.swarm.enter).toHaveBeenCalledWith('task');
    expect(ports.swarm.enter).toHaveBeenCalledTimes(1);
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'yolo' });
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: true });
    expect(host.state.swarmModeEntry).toBe('task');
    expectSwarmMarker(host, 'Swarm activated');
  });

  it('returns the command to the input box when a Manual-mode swarm start is cancelled', async () => {
    const { host, ports } = makeHost({ permissionMode: 'manual' });

    await handleSwarmCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ESCAPE);

    expect(host.restoreInputText).toHaveBeenCalledWith('/swarm Ship feature X');
    expect(host.showStatus).toHaveBeenCalledWith('Swarm task not started.');
    expect(ports.agent.setPermission).not.toHaveBeenCalled();
    expect(ports.swarm.enter).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not start when permission update fails', async () => {
    const { host, ports } = makeHost({ permissionMode: 'manual' });
    ports.agent.setPermission.mockRejectedValueOnce(new Error('denied'));

    await handleSwarmCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(
        'Failed to set permission mode: denied',
      );
    });
    expect(ports.swarm.enter).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not send from Manual mode when enabling swarm mode fails after confirmation', async () => {
    const { host, ports } = makeHost({ permissionMode: 'manual' });
    ports.swarm.enter.mockRejectedValueOnce(new Error('denied'));

    await handleSwarmCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(
        'Failed to enable swarm mode: denied',
      );
    });
    expect(ports.agent.setPermission).toHaveBeenCalledWith('auto');
    expect(ports.swarm.enter).toHaveBeenCalledWith('task');
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not send a prompt when enabling swarm mode fails', async () => {
    const { host, ports } = makeHost({ permissionMode: 'auto' });
    ports.swarm.enter.mockRejectedValueOnce(new Error('denied'));

    await handleSwarmCommand(host, 'Ship feature X');

    expect(host.showError).toHaveBeenCalledWith(
      'Failed to enable swarm mode: denied',
    );
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('shows the original no-session error when no runtime binding is active', async () => {
    const { host, ports } = makeHost({ hasBinding: false });

    await handleSwarmCommand(host, 'on');

    expect(host.showError).toHaveBeenCalledWith(
      'No active session. Send /login to login.',
    );
    expect(ports.swarm.enter).not.toHaveBeenCalled();
  });
});

describe('handleBtwCommand', () => {
  it('starts BTW through the runtime binding when the raw session is absent', async () => {
    const { host, ports } = makeHost();

    await handleBtwCommand(host, '  inspect this  ');

    expect(ports.btw.start).toHaveBeenCalledOnce();
    expect(host.btwPanelController.closeOrCancel).toHaveBeenCalledOnce();
    expect(host.btwPanelController.open).toHaveBeenCalledWith(
      'agent-btw',
      'inspect this',
    );
  });

  it('shows the original login error when no runtime binding is active', async () => {
    const { host, ports } = makeHost({ hasBinding: false });

    await handleBtwCommand(host, 'inspect this');

    expect(host.showError).toHaveBeenCalledWith(
      'LLM not set, send "/login" to login',
    );
    expect(ports.btw.start).not.toHaveBeenCalled();
  });

  it('preserves the BTW startup error prefix when the runtime port fails', async () => {
    const { host, ports } = makeHost();
    ports.btw.start.mockRejectedValueOnce(new Error('side agent unavailable'));

    await handleBtwCommand(host, 'inspect this');

    expect(host.showError).toHaveBeenCalledWith(
      'Failed to start /btw: side agent unavailable',
    );
    expect(host.btwPanelController.open).not.toHaveBeenCalled();
  });
});
