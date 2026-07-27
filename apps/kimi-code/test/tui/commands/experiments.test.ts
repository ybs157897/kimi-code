/**
 * Scenario: experimental feature changes cross the command boundary.
 * Responsibilities: explicit changes persist, refresh command visibility, and
 * reload an active session while empty drafts remain a no-op.
 * Wiring: the command handler and cache are real; host/runtime edges are stubs.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/commands/experiments.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import {
  applyExperimentalFeatureChanges,
} from '#/tui/commands/config';
import {
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
} from '#/tui/commands/experimental-flags';
import type { RuntimeFeatureState } from '#/tui/runtime/runtime-feature-flags-port';
import { darkColors } from '#/tui/theme/colors';

function feature(
  overrides: Partial<RuntimeFeatureState> = {},
): RuntimeFeatureState {
  return {
    id: 'micro_compaction',
    title: 'Micro compaction',
    description: 'Trim older tool results.',
    surface: 'core',
    env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    defaultEnabled: true,
    enabled: true,
    source: 'default',
    ...overrides,
  };
}

function makeHost() {
  const refresh = {
    reload: vi.fn(async () => {}),
  };
  const host = {
    state: {
      theme: { palette: darkColors },
      ui: { requestRender: vi.fn() },
    },
    runtime: {
      featureFlags: {
        apply: vi.fn(async () => [
          feature({ enabled: false, source: 'config', configValue: false }),
        ]),
      },
    },
    requireSessionRuntime: vi.fn(() => ({ refresh })),
    refreshSlashCommandAutocomplete: vi.fn(),
    reloadCurrentSessionView: vi.fn(async () => {}),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    runtime: {
      featureFlags: {
        apply: ReturnType<typeof vi.fn>;
      };
    };
    requireSessionRuntime: ReturnType<typeof vi.fn>;
    refreshSlashCommandAutocomplete: ReturnType<typeof vi.fn>;
    reloadCurrentSessionView: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
    refresh: typeof refresh;
  };
  return Object.assign(host, { refresh });
}

describe('experimental feature command handlers', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  it('persists config overrides, refreshes command flags, closes the panel, and reloads', async () => {
    const host = makeHost();

    await applyExperimentalFeatureChanges(host, [
      { id: 'micro_compaction', enabled: false },
    ]);

    expect(host.runtime.featureFlags.apply).toHaveBeenCalledWith({
      'micro_compaction': false,
    });
    expect(isExperimentalFlagEnabled('micro_compaction')).toBe(false);
    expect(host.refreshSlashCommandAutocomplete).toHaveBeenCalled();
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.refresh.reload).toHaveBeenCalledOnce();
    expect(host.reloadCurrentSessionView).toHaveBeenCalledWith(
      'Experimental features updated. Session reloaded.',
    );
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.track).toHaveBeenCalledWith('experimental_features_apply', {
      changed: 1,
    });
    expect(host.showStatus).not.toHaveBeenCalledWith(
      'Experimental features updated.',
      darkColors.success,
    );
  });

  it('does not write config when there are no drafted changes', async () => {
    const host = makeHost();

    await applyExperimentalFeatureChanges(host, []);

    expect(host.runtime.featureFlags.apply).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'No experimental feature changes to apply.',
      'textMuted',
    );
  });
});
