/**
 * Scenario: expert-team wire state survives the full mode lifecycle.
 *
 * Exercises the pure Op fold so live dispatch and replay share the same
 * activation, member update, team deletion, and deactivation semantics.
 */

import { describe, expect, it } from 'vitest';

import type {
  ExpertTeamMember,
  ExpertTeamSnapshot,
} from '#/session/expertTeam/expertTeam';
import {
  expertTeamActivate,
  expertTeamCreate,
  expertTeamDeactivate,
  expertTeamDelete,
  expertTeamMemberUpsert,
} from '#/session/expertTeam/expertTeamOps';

const snapshot: ExpertTeamSnapshot = {
  binding: {
    pluginId: 'delivery-experts',
    pluginVersion: '1.0.0',
    displayName: 'Delivery Experts',
    leadAgentName: 'delivery-lead',
    leadProfileName: 'expert:delivery-experts:delivery-lead',
    memberAgentNames: ['architect'],
    previousProfile: {
      profileName: 'agent',
      modelAlias: 'kimi',
      thinkingLevel: 'medium',
      cwd: '/workspace',
      systemPrompt: 'default agent prompt',
      activeToolNames: ['Read'],
      disallowedTools: [],
    },
    activatedAt: '2026-07-26T00:00:00.000Z',
  },
};

describe('expert-team wire operations', () => {
  it('folds activation, team creation, member changes, deletion, and deactivation', () => {
    const activated = expertTeamActivate.apply(null, { snapshot });
    const created = expertTeamCreate.apply(activated, {
      team: {
        id: 'delivery',
        name: 'delivery',
        createdAt: '2026-07-26T00:01:00.000Z',
        members: [],
      },
    });
    const member: ExpertTeamMember = {
      name: 'architect',
      agentId: 'architect@delivery',
      profileName: 'expert:delivery-experts:architect',
      status: 'running',
      updatedAt: '2026-07-26T00:02:00.000Z',
      taskId: 'expert-member-1',
    };
    const running = expertTeamMemberUpsert.apply(created, { member });
    const completed = expertTeamMemberUpsert.apply(running, {
      member: {
        ...member,
        status: 'completed',
        updatedAt: '2026-07-26T00:03:00.000Z',
      },
    });
    const deleted = expertTeamDelete.apply(completed, {});

    expect(completed?.team?.members).toEqual([
      {
        ...member,
        status: 'completed',
        updatedAt: '2026-07-26T00:03:00.000Z',
      },
    ]);
    expect(deleted).toEqual({ binding: snapshot.binding });
    expect(expertTeamDeactivate.apply(deleted, {})).toBeNull();
  });

  it('ignores runtime mutations before activation or team creation', () => {
    const member: ExpertTeamMember = {
      name: 'architect',
      agentId: 'architect@delivery',
      profileName: 'expert:delivery-experts:architect',
      status: 'running',
      updatedAt: '2026-07-26T00:02:00.000Z',
    };

    expect(
      expertTeamCreate.apply(null, {
        team: {
          id: 'delivery',
          name: 'delivery',
          createdAt: '2026-07-26T00:01:00.000Z',
          members: [],
        },
      }),
    ).toBeNull();
    expect(expertTeamMemberUpsert.apply(snapshot, { member })).toEqual(snapshot);
  });
});
