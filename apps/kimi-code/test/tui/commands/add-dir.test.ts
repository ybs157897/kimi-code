/**
 * Scenario: /add-dir reads and mutates the active session workspace.
 * Responsibilities: the command routes through TUISessionRuntime, preserves
 * persistence and cancellation semantics, and rejects stale selector actions.
 * Wiring: the session runtime workspace port is the only stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/commands/add-dir.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { handleAddDirCommand } from '#/tui/commands/add-dir';
import { dispatchInput, type SlashCommandHost } from '#/tui/commands/dispatch';
import type { TUISessionRuntime } from '#/tui/runtime/tui-session-runtime';

type MountedPanel = {
  handleInput: (data: string) => void;
  render: (width: number) => string[];
};

const ANSI_SGR = /\u001B\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function makeHost(additionalDirs: readonly string[] = []) {
  const state = {
    appState: {
      additionalDirs,
      sessionId: 'session-1',
      streamingPhase: 'idle',
      isCompacting: false,
    },
  };
  let mountedPanel: MountedPanel | null = null;
  const workspace = {
    get: vi.fn(async () => ({
      workDir: '/repo',
      additionalDirs,
    })),
    addAdditionalDir: vi.fn(async (path: string, options: { persist: boolean }) => ({
      additionalDirs: [...additionalDirs, path],
      projectRoot: '/repo',
      configPath: '/repo/.kimi-code/local.toml',
      persisted: options.persist,
    })),
  };
  const runtime = {
    sessionId: 'session-1',
    workspace,
  } as unknown as TUISessionRuntime;
  const host = {
    state,
    session: undefined,
    requireSessionRuntime: vi.fn(() => runtime),
    skillCommandMap: new Map<string, string>(),
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(state.appState, patch)),
    refreshSlashCommandAutocomplete: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    sendNormalUserInput: vi.fn(),
    track: vi.fn(),
    mountEditorReplacement: vi.fn((panel: MountedPanel) => {
      mountedPanel = panel;
    }),
    restoreEditor: vi.fn(() => {
      mountedPanel = null;
    }),
  } as unknown as SlashCommandHost & {
    state: typeof state;
    requireSessionRuntime: ReturnType<typeof vi.fn>;
    setAppState: ReturnType<typeof vi.fn>;
    refreshSlashCommandAutocomplete: ReturnType<typeof vi.fn>;
    appendTranscriptEntry: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    sendNormalUserInput: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
  };
  return {
    host,
    workspace,
    getMountedPanel: () => mountedPanel,
  };
}

describe('handleAddDirCommand', () => {
  it('shows the empty message when no additional dirs are configured', async () => {
    const { host, workspace } = makeHost();

    await handleAddDirCommand(host, '');

    expect(workspace.get).toHaveBeenCalledOnce();
    expect(host.showStatus).toHaveBeenCalledWith('No additional directories configured.');
  });

  it('lists current additional dirs for no args', async () => {
    const { host } = makeHost(['/repo/shared', '/repo/docs']);

    await handleAddDirCommand(host, '');

    expect(host.showStatus).toHaveBeenCalledWith(
      'Additional directories:\n  /repo/shared\n  /repo/docs',
    );
  });

  it('lists current additional dirs for the list subcommand', async () => {
    const { host } = makeHost(['/repo/shared']);

    await handleAddDirCommand(host, 'list');

    expect(host.showStatus).toHaveBeenCalledWith('Additional directories:\n  /repo/shared');
  });

  it('renders the add-dir confirmation without option descriptions', async () => {
    const { host, getMountedPanel } = makeHost();

    await handleAddDirCommand(host, '../shared');

    const rendered = getMountedPanel()?.render(120).map(strip).join('\n') ?? '';
    expect(rendered).toContain('Add directory to workspace: ../shared');
    expect(rendered).toContain('Yes, for this session');
    expect(rendered).toContain('Yes, and remember this directory');
    expect(rendered).toContain('No');
    expect(rendered).not.toContain('Use this directory in the current session only');
    expect(rendered).not.toContain('Save this directory to the project workspace config');
    expect(rendered).not.toContain('Do not add this directory.');
  });

  it('adds a workspace dir for this session only after confirmation', async () => {
    const { host, workspace, getMountedPanel } = makeHost();

    await handleAddDirCommand(host, '../shared');
    getMountedPanel()?.handleInput(' ');

    await vi.waitFor(() => {
      expect(workspace.addAdditionalDir).toHaveBeenCalledWith('../shared', {
        persist: false,
      });
    });
    expect(host.restoreEditor).toHaveBeenCalledOnce();
    expect(host.setAppState).toHaveBeenCalledWith({
      additionalDirs: ['../shared'],
    });
    expect(host.refreshSlashCommandAutocomplete).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalledWith(
        'Added workspace directory:\n  ../shared\n  For this session only',
        'success',
      );
    });
    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();
  });

  it('adds a remembered workspace dir after confirmation', async () => {
    const { host, workspace, getMountedPanel } = makeHost();

    await handleAddDirCommand(host, '../shared');
    getMountedPanel()?.handleInput('\u001B[B');
    getMountedPanel()?.handleInput(' ');

    await vi.waitFor(() => {
      expect(workspace.addAdditionalDir).toHaveBeenCalledWith('../shared', {
        persist: true,
      });
    });
    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalledWith(
        'Added workspace directory:\n  ../shared\n  Saved to:\n  /repo/.kimi-code/local.toml',
        'success',
      );
    });
    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();
  });

  it('does not add a workspace dir when the confirmation is cancelled', async () => {
    const { host, workspace, getMountedPanel } = makeHost();

    await handleAddDirCommand(host, '../shared');
    getMountedPanel()?.handleInput('\u001B[B');
    getMountedPanel()?.handleInput('\u001B[B');
    getMountedPanel()?.handleInput(' ');

    expect(workspace.addAdditionalDir).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Did not add ../shared as a working directory.');
  });

  it('rejects a stale selection when the active session changes', async () => {
    const { host, workspace, getMountedPanel } = makeHost();

    await handleAddDirCommand(host, '../shared');
    host.state.appState.sessionId = 'session-2';
    getMountedPanel()?.handleInput(' ');

    expect(workspace.addAdditionalDir).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith(
      'No active session. Send /login to login.',
    );
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.refreshSlashCommandAutocomplete).not.toHaveBeenCalled();
  });

  it('shows workspace errors without mutating TUI state', async () => {
    const { host, workspace, getMountedPanel } = makeHost();
    workspace.addAdditionalDir.mockRejectedValueOnce(
      new Error('workspace.additional_dir must exist and be a directory'),
    );

    dispatchInput(host, '/add-dir ../other');
    await vi.waitFor(() => {
      expect(getMountedPanel()).not.toBeNull();
    });
    getMountedPanel()?.handleInput(' ');

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(
        'workspace.additional_dir must exist and be a directory',
      );
    });

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.refreshSlashCommandAutocomplete).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });
});
