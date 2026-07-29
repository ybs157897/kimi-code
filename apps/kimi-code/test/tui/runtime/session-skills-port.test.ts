/**
 * Scenario: skill discovery, catalog reload, and activation cross the TUI
 * runtime boundary. The Klient adapter preserves neutral summaries, route
 * reloads and errors, and targets the active agent. The runtime facade is
 * the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-skills-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionSkillsPort } from '#/tui/runtime/klient-session-skills-adapter';

describe('session skills runtime port (adapter contract)', () => {
  it('list maps Klient session summaries to the neutral view', async () => {
    const session = klientSession({
      list: vi.fn(async () => [
        {
          name: 'review',
          description: 'Review a change',
          path: '/skills/review/SKILL.md',
          source: 'user' as const,
          type: 'flow',
          disableModelInvocation: false,
          isSubSkill: true,
        },
      ]),
    });

    const result = await createKlientSessionSkillsPort(session, 'worker').list();

    expect(result).toEqual([
      {
        name: 'review',
        description: 'Review a change',
        path: '/skills/review/SKILL.md',
        source: 'user',
        type: 'flow',
        disableModelInvocation: false,
        isSubSkill: true,
      },
    ]);
  });

  it('activate targets the selected Klient agent with skill input', async () => {
    const activate = vi.fn(async () => undefined);
    const session = klientSession({ activate });

    await createKlientSessionSkillsPort(session, 'worker').activate(
      'review',
      'src/main.ts',
    );

    expect(session.agent).toHaveBeenCalledWith('worker');
    expect(activate).toHaveBeenCalledWith({
      name: 'review',
      args: 'src/main.ts',
    });
  });

  it('reload calls the Klient session skill catalog for an active session', async () => {
    const reload = vi.fn(async () => undefined);
    const session = klientSession({ reload });

    await createKlientSessionSkillsPort(session, 'worker').reload();

    expect(reload).toHaveBeenCalledExactlyOnceWith();
  });

  it('reload rejects with the Klient catalog error when catalog reload fails', async () => {
    const failure = new Error('catalog reload failed');
    const session = klientSession({
      reload: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(createKlientSessionSkillsPort(session, 'worker').reload()).rejects.toBe(
      failure,
    );
  });
});

function klientSession(
  overrides: Partial<{
    list: () => Promise<
      readonly {
        name: string;
        description: string;
        path: string;
        source: 'project' | 'user' | 'extra' | 'builtin';
        type?: string;
        disableModelInvocation?: boolean;
        isSubSkill?: boolean;
      }[]
    >;
    reload: () => Promise<void>;
    activate: (input: { name: string; args?: string }) => Promise<void>;
  }> = {},
) {
  const activate = overrides.activate ?? vi.fn(async () => undefined);
  return {
    skills: {
      list: overrides.list ?? vi.fn(async () => []),
      reload: overrides.reload ?? vi.fn(async () => undefined),
    },
    agent: vi.fn(() => ({
      skills: { activate },
    })),
  };
}
