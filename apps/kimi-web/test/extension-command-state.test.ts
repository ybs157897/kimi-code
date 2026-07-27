// Extension-command state: reload refreshes the callback-free session catalog.
// Wiring: real useExtensionState with only the daemon API boundary stubbed.
// Run: pnpm --filter @moonshot-ai/kimi-web exec vitest run test/extension-command-state.test.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useExtensionState } from '../src/composables/client/useExtensionState';
import type { ExtendedState } from '../src/composables/useKimiWebClient';

const apiMock = vi.hoisted(() => ({
  reloadExtensions: vi.fn(),
  listExtensionCommands: vi.fn(),
  activateExtensionCommand: vi.fn(),
}));

vi.mock('../src/api', () => ({
  getKimiWebApi: () => apiMock,
}));

function rig() {
  const state = {
    activeSessionId: 'session-1',
    sessions: [],
    thinkingBySession: {},
  } as unknown as ExtendedState;
  const pushOperationFailure = vi.fn();
  const extensionState = useExtensionState(state, {
    pushOperationFailure,
  });
  return { extensionState, pushOperationFailure };
}

describe('extension command control state', () => {
  beforeEach(() => {
    apiMock.reloadExtensions.mockReset();
    apiMock.listExtensionCommands.mockReset();
    apiMock.activateExtensionCommand.mockReset();
  });

  it('replaces the session catalog after extensions reload successfully', async () => {
    apiMock.reloadExtensions.mockResolvedValue({ active: ['release-tools'], errors: [] });
    apiMock.listExtensionCommands.mockResolvedValue([
      {
        extensionId: 'release-tools',
        name: 'prepare',
        description: 'Prepare a release',
      },
    ]);
    const { extensionState } = rig();

    const result = await extensionState.reload();

    expect(result).toEqual({ active: ['release-tools'], errors: [] });
    expect(extensionState.commandsBySession.value['session-1']).toEqual([
      {
        extensionId: 'release-tools',
        name: 'prepare',
        description: 'Prepare a release',
      },
    ]);
  });

  it('reports a user-visible operation failure when a catalog command is stale', async () => {
    apiMock.activateExtensionCommand.mockResolvedValue({ activated: false });
    apiMock.listExtensionCommands.mockResolvedValue([]);
    const { extensionState, pushOperationFailure } = rig();

    await extensionState.activateCommand('release-tools', 'prepare');

    expect(pushOperationFailure).toHaveBeenCalledWith(
      'activateExtensionCommand',
      expect.objectContaining({
        message: 'Extension command "release-tools:prepare" is not available',
      }),
      { sessionId: 'session-1' },
    );
  });

  it('reports extension load diagnostics returned by reload', async () => {
    apiMock.reloadExtensions.mockResolvedValue({
      active: [],
      errors: [
        { path: '/workspace/broken.ts', error: 'invalid module' },
        { path: '/workspace/other.ts', error: 'missing export' },
      ],
    });
    apiMock.listExtensionCommands.mockResolvedValue([]);
    const { extensionState, pushOperationFailure } = rig();

    await extensionState.reload();

    expect(pushOperationFailure).toHaveBeenCalledWith(
      'reloadExtensions',
      expect.objectContaining({
        message: '/workspace/broken.ts: invalid module (1 more)',
      }),
      {
        title: 'Extension reload failed',
        message: '/workspace/broken.ts: invalid module (1 more)',
        sessionId: 'session-1',
      },
    );
  });

  it('clears a stale session catalog when the backend read fails', async () => {
    apiMock.listExtensionCommands
      .mockResolvedValueOnce([
        {
          extensionId: 'release-tools',
          name: 'prepare',
          description: 'Prepare a release',
        },
      ])
      .mockRejectedValueOnce(new Error('unsupported backend'));
    const { extensionState } = rig();

    await extensionState.loadCommandsForSession('session-1');
    await extensionState.loadCommandsForSession('session-1');

    expect(extensionState.commandsBySession.value['session-1']).toEqual([]);
  });
});
