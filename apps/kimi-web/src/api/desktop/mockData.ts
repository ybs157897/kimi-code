// apps/kimi-web/src/api/desktop/mockData.ts
// Canned fixtures for the browser dev mock bridge (mock.ts): the mock
// workspace / command / reply text, the expert-team catalog, and the
// streaming cadence + journal bound the simulated turns play at.

import type { WireExpertTeamDefinition } from '../daemon/wire';

export const MOCK_WORKSPACE_ID = 'mock-workspace';
export const MOCK_COMMAND = 'echo "hello from the mock engine"';

/** Whitelisted open-in app ids the mock accepts (mirrors the sidecar list). */
export const MOCK_OPEN_IN_APPS = ['finder', 'cursor', 'vscode', 'iterm', 'terminal'];

export const MOCK_COMMAND_OUTPUT = 'hello from the mock engine\n';
export const MOCK_REPLY_OPENING = 'Sure — let me run a quick command to demonstrate the stream.\n\n';
export const MOCK_REPLY_CLOSING =
  '\n\nThe command printed `hello from the mock engine`. This whole turn was ' +
  'simulated by the browser dev mock — no engine is attached.';

/** Canned expert-team catalog so Modes → 专家团 appears under ?desktop_transport=1. */
export const MOCK_EXPERT_TEAMS: WireExpertTeamDefinition[] = [
  {
    plugin_id: 'mock-experts',
    display_name: 'Mock Expert Team',
    description: 'Demo specialists for the desktop transport',
    tags: ['demo'],
    lead_agent_name: 'lead',
    member_agent_names: ['researcher', 'reviewer'],
    members: [
      { agent: 'lead', role: 'lead', display_name: 'Lead' },
      { agent: 'researcher', role: 'member', display_name: 'Researcher' },
      { agent: 'reviewer', role: 'member', display_name: 'Reviewer' },
    ],
    quick_prompts: ['Review this change as a specialist team'],
  },
];

/** Streaming cadence: one assistant.delta every DELTA_INTERVAL_MS per chunk. */
export const DELTA_CHUNK_CHARS = 8;
export const DELTA_INTERVAL_MS = 24;

/** Bounded retained-frame count per mock stream (mirrors the sidecar hub). */
export const MOCK_JOURNAL_CAPACITY = 1024;
