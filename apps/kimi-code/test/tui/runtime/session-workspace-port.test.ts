/**
 * Scenario: active-session workspace state and updates cross the TUI runtime boundary.
 * Responsibilities: legacy and Klient adapters preserve the neutral workspace view,
 * result shape, and persistence choice. Each runtime facade is the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-workspace-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionWorkspacePort } from '#/tui/runtime/klient-session-workspace-adapter';
import { createLegacySessionWorkspacePort } from '#/tui/runtime/legacy-session-workspace-adapter';

describe('session workspace runtime port (adapter contract)', () => {
  it('reads a copied workspace view from the legacy session', async () => {
    const additionalDirs = ['/workspace/shared'];
    const session = legacySession({
      workDir: '/workspace/project',
      summary: { additionalDirs },
    });

    const result = await createLegacySessionWorkspacePort(session).get();

    expect(result).toEqual({
      workDir: '/workspace/project',
      additionalDirs: ['/workspace/shared'],
    });
    expect(result.additionalDirs).not.toBe(additionalDirs);
  });

  it('maps a copied additional-directory result from the legacy session', async () => {
    const additionalDirs = ['/workspace/shared'];
    const session = legacySession({
      addAdditionalDir: vi.fn(async () => ({
        projectRoot: '/workspace/project',
        configPath: '/workspace/project/.kimi/config.toml',
        additionalDirs,
        persisted: true,
      })),
    });

    const result = await createLegacySessionWorkspacePort(
      session,
    ).addAdditionalDir('/workspace/shared');

    expect(result).toEqual({
      projectRoot: '/workspace/project',
      configPath: '/workspace/project/.kimi/config.toml',
      additionalDirs: ['/workspace/shared'],
      persisted: true,
    });
    expect(result.additionalDirs).not.toBe(additionalDirs);
  });

  it('forwards the persistence choice to the legacy session', async () => {
    const addAdditionalDir = vi.fn(async () => workspaceResult());
    const session = legacySession({ addAdditionalDir });

    await createLegacySessionWorkspacePort(session).addAdditionalDir(
      '/workspace/shared',
      { persist: false },
    );

    expect(addAdditionalDir).toHaveBeenCalledWith('/workspace/shared', {
      persist: false,
    });
  });

  it('reads a copied workspace view from the Klient session facade', async () => {
    const additionalDirs = ['/workspace/shared'];
    const session = klientSession({
      get: vi.fn(async () => ({
        workDir: '/workspace/project',
        additionalDirs,
      })),
    });

    const result = await createKlientSessionWorkspacePort(session).get();

    expect(result).toEqual({
      workDir: '/workspace/project',
      additionalDirs: ['/workspace/shared'],
    });
    expect(result.additionalDirs).not.toBe(additionalDirs);
  });

  it('maps a copied additional-directory result from the Klient session facade', async () => {
    const additionalDirs = ['/workspace/shared'];
    const session = klientSession({
      addAdditionalDir: vi.fn(async () => ({
        projectRoot: '/workspace/project',
        configPath: '/workspace/project/.kimi/config.toml',
        additionalDirs,
        persisted: true,
      })),
    });

    const result = await createKlientSessionWorkspacePort(
      session,
    ).addAdditionalDir('/workspace/shared');

    expect(result).toEqual({
      projectRoot: '/workspace/project',
      configPath: '/workspace/project/.kimi/config.toml',
      additionalDirs: ['/workspace/shared'],
      persisted: true,
    });
    expect(result.additionalDirs).not.toBe(additionalDirs);
  });

  it('forwards the persistence choice to the Klient session facade', async () => {
    const addAdditionalDir = vi.fn(async () => workspaceResult());
    const session = klientSession({ addAdditionalDir });

    await createKlientSessionWorkspacePort(session).addAdditionalDir(
      '/workspace/shared',
      { persist: false },
    );

    expect(addAdditionalDir).toHaveBeenCalledWith({
      path: '/workspace/shared',
      persist: false,
    });
  });
});

function workspaceResult() {
  return {
    projectRoot: '/workspace/project',
    configPath: '/workspace/project/.kimi/config.toml',
    additionalDirs: ['/workspace/shared'],
    persisted: false,
  };
}

function legacySession(
  overrides: Partial<{
    workDir: string;
    summary: { additionalDirs?: readonly string[] };
    addAdditionalDir: (
      path: string,
      options?: { persist?: boolean },
    ) => Promise<ReturnType<typeof workspaceResult>>;
  }> = {},
) {
  return {
    workDir: '/workspace/project',
    summary: { additionalDirs: [] },
    addAdditionalDir: vi.fn(async () => workspaceResult()),
    ...overrides,
  };
}

function klientSession(
  overrides: Partial<{
    get: () => Promise<{
      workDir: string;
      additionalDirs: readonly string[];
    }>;
    addAdditionalDir: (input: {
      path: string;
      persist?: boolean;
    }) => Promise<ReturnType<typeof workspaceResult>>;
  }> = {},
) {
  return {
    workspace: {
      get:
        overrides.get ??
        vi.fn(async () => ({
          workDir: '/workspace/project',
          additionalDirs: [],
        })),
      addAdditionalDir:
        overrides.addAdditionalDir ?? vi.fn(async () => workspaceResult()),
    },
  };
}
