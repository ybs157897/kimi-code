/**
 * Scenario: runtime validation at Klient wire-contract boundaries.
 *
 * Exercises selected facade-facing schemas directly with no external
 * collaborators, including managed auth usage, session export, session
 * creation, startup warnings, swarm mode, session init, and BTW. Run with
 * `pnpm --filter @moonshot-ai/klient exec
 * vitest run test/contract.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { pluginManifestSchema } from '../src/contract/global/plugins.js';
import {
  authManagedUsageResultSchema,
  completeFeedbackUploadBodySchema,
  completeFeedbackUploadResultSchema,
  createFeedbackUploadUrlBodySchema,
  createFeedbackUploadUrlResultSchema,
  submitFeedbackBodySchema,
  submitFeedbackResultSchema,
} from '../src/contract/global/auth.js';
import { sessionExportContract } from '../src/contract/global/session-export.js';
import {
  agentSwarmContract,
  swarmModeTriggerSchema,
} from '../src/contract/agent/swarm.js';
import { agentReplayViewContract } from '../src/contract/agent/services.js';
import { sessionBtwContract } from '../src/contract/session/btw.js';
import {
  goalQueueMoveDirectionSchema,
  goalQueueSnapshotSchema,
  sessionGoalQueueContract,
} from '../src/contract/session/goal-queue.js';
import { sessionInitContract } from '../src/contract/session/init.js';
import { createSessionOptionsSchema } from '../src/contract/session/lifecycle.js';
import { sessionSkillCatalogContract } from '../src/contract/session/skill.js';
import {
  sessionSecondaryModelWarningContract,
  sessionWarningSchema,
} from '../src/contract/session/warnings.js';

type McpTimeoutField = 'startupTimeoutMs' | 'toolTimeoutMs';

const timeoutCases = [
  {
    surface: 'session creation',
    parse: (field: McpTimeoutField, value: number) =>
      createSessionOptionsSchema.safeParse({
        workDir: '/tmp/example',
        mcpServers: {
          example: { transport: 'stdio', command: 'node', [field]: value },
        },
      }),
  },
  {
    surface: 'plugin manifests',
    parse: (field: McpTimeoutField, value: number) =>
      pluginManifestSchema.safeParse({
        name: 'example',
        mcpServers: {
          example: { transport: 'stdio', command: 'node', [field]: value },
        },
      }),
  },
].flatMap(({ surface, parse }) => [
  { surface, field: 'startupTimeoutMs' as const, parse },
  { surface, field: 'toolTimeoutMs' as const, parse },
]);

describe('MCP timeout contract validation', () => {
  it.each(timeoutCases)('accepts the maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_647).success).toBe(true);
  });

  it.each(timeoutCases)('rejects an above-maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_648).success).toBe(false);
  });
});

describe('managed auth usage contract', () => {
  it('accepts a complete successful managed usage result', () => {
    const result = {
      kind: 'ok' as const,
      summary: {
        label: 'Weekly limit',
        used: 125,
        limit: 1_000,
        resetHint: '2d 3h',
      },
      limits: [
        {
          label: '5h limit',
          used: 10,
          limit: 100,
        },
      ],
      extraUsage: {
        balanceCents: 1_500,
        totalCents: 2_000,
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimitCents: 5_000,
        monthlyUsedCents: 750,
        currency: 'USD',
      },
    };

    expect(authManagedUsageResultSchema.parse(result)).toEqual(result);
  });

  it('accepts a managed usage error result with its status', () => {
    const result = {
      kind: 'error' as const,
      message: 'Usage endpoint unavailable.',
      status: 503,
    };

    expect(authManagedUsageResultSchema.parse(result)).toEqual(result);
  });
});

describe('managed feedback contract', () => {
  it('accepts a complete feedback submission exchange', () => {
    const body = {
      session_id: 'session-example',
      content: 'Example feedback.',
      version: '1.2.3-example',
      os: 'example-os',
      model: 'model-example',
      contact: 'feedback@example.test',
      info: { source: 'contract-test' },
    };
    const result = { kind: 'ok' as const, feedbackId: 42 };

    expect(submitFeedbackBodySchema.parse(body)).toEqual(body);
    expect(submitFeedbackResultSchema.parse(result)).toEqual(result);
  });

  it('accepts a complete multipart upload request exchange', () => {
    const body = {
      file_hash: 'sha256-example',
      file_name: 'feedback.zip',
      file_size: 1_024,
      feedback_id: 42,
    };
    const result = {
      kind: 'ok' as const,
      upload_id: 7,
      parts: [
        {
          part_number: 1,
          url: 'https://example.test/upload/part-1',
          method: 'PUT',
          size: 1_024,
        },
      ],
    };

    expect(createFeedbackUploadUrlBodySchema.parse(body)).toEqual(body);
    expect(createFeedbackUploadUrlResultSchema.parse(result)).toEqual(result);
  });

  it('accepts a complete multipart upload completion exchange', () => {
    const body = {
      upload_id: 7,
      parts: [{ part_number: 1, etag: 'etag-example' }],
    };
    const result = { kind: 'ok' as const };

    expect(completeFeedbackUploadBodySchema.parse(body)).toEqual(body);
    expect(completeFeedbackUploadResultSchema.parse(result)).toEqual(result);
  });

  it.each([
    ['submit', submitFeedbackResultSchema],
    ['create upload', createFeedbackUploadUrlResultSchema],
    ['complete upload', completeFeedbackUploadResultSchema],
  ])('accepts the managed feedback error result for %s', (_operation, schema) => {
    const result = {
      kind: 'error' as const,
      status: 503,
      message: 'Managed feedback is unavailable.',
    };

    expect(schema.parse(result)).toEqual(result);
  });
});

describe('session export contract', () => {
  it('accepts every wire-safe session export request field', () => {
    const payload = {
      sessionId: 'session-example',
      outputPath: '/tmp/session-example.zip',
      includeGlobalLog: true,
      includeDesktopLog: true,
      version: '1.2.3-example',
      installSource: 'example-installer',
      shellEnv: {
        term: 'xterm-example',
        termProgram: 'terminal-example',
        termProgramVersion: '1.0.0',
        multiplexer: 'multiplexer-example',
        shell: '/bin/example-shell',
      },
    };

    expect(sessionExportContract.export.input.parse([payload])).toEqual([payload]);
  });

  it('accepts a complete session export result', () => {
    const result = {
      zipPath: '/tmp/session-example.zip',
      entries: ['manifest.json', 'agents/main/wire.jsonl'],
      sessionDir: '/tmp/session-example',
      manifest: {
        sessionId: 'session-example',
        exportedAt: '2026-07-27T00:00:00.000Z',
        kimiCodeVersion: '1.2.3-example',
        wireProtocolVersion: '1',
        os: 'example-os example-arch',
        nodejsVersion: '24.15.0',
        sessionFirstActivity: '2026-07-27T00:00:01.000Z',
        sessionLastActivity: '2026-07-27T00:00:02.000Z',
        title: 'Example session',
        workspaceDir: '/workspace',
        sessionLogPath: 'logs/kimi-code.log',
        globalLogPath: 'logs/global/kimi-code.log',
        desktopLogPath: 'logs/kimi-desktop.log',
        webLogPath: 'logs/kimi-web.jsonl',
        installSource: 'example-installer',
        shellEnv: {
          term: 'xterm-example',
          termProgram: 'terminal-example',
          termProgramVersion: '1.0.0',
          multiplexer: 'multiplexer-example',
          shell: '/bin/example-shell',
        },
      },
    };

    expect(sessionExportContract.export.output.parse(result)).toEqual(result);
  });

  it('rejects the service-only options argument at the wire boundary', () => {
    const result = sessionExportContract.export.input.safeParse([
      { sessionId: 'session-example', version: '1.2.3-example' },
      {
        webLog: '{"example":true}',
        maxArchiveBytes: 1_000,
        signal: {},
      },
    ]);

    expect(result.success).toBe(false);
  });
});

describe('session creation contract', () => {
  it('accepts a serializable main-agent binding', () => {
    expect(
      createSessionOptionsSchema.safeParse({
        workDir: '/tmp/example',
        mainAgentBinding: {
          profile: 'reviewer',
          model: 'example-model',
          thinking: 'off',
        },
      }).success,
    ).toBe(true);
  });
});

describe('session startup warning contract', () => {
  it('accepts a neutral warning payload', () => {
    const warning = {
      code: 'secondary-model-invalid',
      message: 'The configured secondary model is unavailable.',
    };

    expect(sessionWarningSchema.parse(warning)).toEqual(warning);
  });

  it('normalizes a missing wire warning to undefined', () => {
    expect(
      sessionSecondaryModelWarningContract.getSecondaryModelWarning.output.parse(null),
    ).toBeUndefined();
  });
});

describe('agent swarm contract', () => {
  it.each(['manual', 'task', 'tool'] as const)(
    'accepts the %s swarm trigger',
    (trigger) => {
      expect(swarmModeTriggerSchema.parse(trigger)).toBe(trigger);
    },
  );

  it('rejects an unknown swarm trigger', () => {
    expect(agentSwarmContract.enter.input.safeParse(['automatic']).success).toBe(false);
  });
});

describe('agent replay view contract', () => {
  it('accepts a complete wire-friendly replay snapshot', () => {
    const message = {
      role: 'assistant' as const,
      name: 'example-agent',
      content: [
        { type: 'text' as const, text: 'Replay the durable state.' },
        { type: 'think' as const, think: 'Check every slice.', encrypted: 'opaque' },
        {
          type: 'image_url' as const,
          imageUrl: { url: 'https://example.test/image.png', id: 'image-example' },
        },
        {
          type: 'audio_url' as const,
          audioUrl: { url: 'https://example.test/audio.mp3', id: 'audio-example' },
        },
        {
          type: 'video_url' as const,
          videoUrl: { url: 'https://example.test/video.mp4', id: 'video-example' },
        },
      ],
      toolCalls: [
        {
          type: 'function' as const,
          id: 'call-example',
          name: 'ExampleTool',
          arguments: '{"value":1}',
          extras: { trace: 'example' },
          _streamIndex: 0,
        },
      ],
      tools: [
        {
          name: 'ExampleTool',
          description: 'Runs a neutral example.',
          parameters: { type: 'object' },
          deferred: true as const,
        },
      ],
      id: 'message-example',
      providerMessageId: 'provider-message-example',
      origin: {
        kind: 'skill_activation' as const,
        activationId: 'activation-example',
        skillName: 'example-skill',
        skillArgs: 'verify',
        trigger: 'model-tool' as const,
        skillType: 'prompt',
        skillPath: '/workspace/.agents/skills/example/SKILL.md',
        skillSource: 'project' as const,
      },
      partial: false,
      isError: false,
      note: 'durable',
    };
    const goal = {
      goalId: 'goal-example',
      objective: 'Verify the replay snapshot',
      completionCriterion: 'Every replay slice is present',
      status: 'active' as const,
      turnsUsed: 1,
      tokensUsed: 8,
      wallClockMs: 13,
      budget: {
        tokenBudget: 100,
        turnBudget: 5,
        wallClockBudgetMs: 1_000,
        remainingTokens: 92,
        remainingTurns: 4,
        remainingWallClockMs: 987,
        tokenBudgetReached: false,
        turnBudgetReached: false,
        wallClockBudgetReached: false,
        overBudget: false,
      },
    };
    const snapshot = {
      type: 'main' as const,
      config: {
        cwd: '/workspace',
        modelAlias: 'example-model',
        modelCapabilities: {
          image_in: true,
          video_in: true,
          audio_in: true,
          thinking: true,
          tool_use: true,
          max_context_tokens: 128_000,
          max_input_tokens: 120_000,
          dynamically_loaded_tools: true,
        },
        profileName: 'example-profile',
        thinkingLevel: 'high',
        systemPrompt: 'Use only neutral examples.',
      },
      context: { history: [message], tokenCount: 21 },
      replay: [
        { type: 'message' as const, time: 1, message },
        {
          type: 'compaction' as const,
          time: 2,
          result: {
            summary: 'The durable state remains.',
            contextSummary: 'Keep the complete snapshot.',
            compactedCount: 2,
            tokensBefore: 21,
            tokensAfter: 8,
            keptUserMessageCount: 1,
            keptHeadUserMessageCount: 0,
            droppedCount: 1,
          },
          instruction: 'Retain durable facts.',
        },
        {
          type: 'goal_updated' as const,
          time: 3,
          snapshot: goal,
          change: {
            kind: 'lifecycle' as const,
            status: 'active' as const,
            reason: 'started',
            stats: { turnsUsed: 1, tokensUsed: 8, wallClockMs: 13 },
            actor: 'runtime' as const,
          },
        },
        { type: 'plan_updated' as const, time: 4, enabled: true },
        {
          type: 'config_updated' as const,
          time: 5,
          config: { modelAlias: 'example-model', thinkingLevel: 'high' },
        },
        { type: 'permission_updated' as const, time: 6, mode: 'manual' as const },
        {
          type: 'approval_result' as const,
          time: 7,
          record: {
            turnId: 1,
            toolCallId: 'call-example',
            toolName: 'ExampleTool',
            action: 'run a neutral example',
            sessionApprovalRule: 'ExampleTool(*)',
            result: {
              decision: 'approved' as const,
              scope: 'session' as const,
              feedback: 'continue',
              selectedLabel: 'Approve',
            },
          },
        },
      ],
      permission: {
        mode: 'manual' as const,
        rules: [
          {
            decision: 'allow' as const,
            scope: 'project' as const,
            pattern: 'ExampleTool(*)',
            reason: 'neutral example',
          },
        ],
      },
      plan: {
        id: 'plan-example',
        content: '# Example plan',
        path: '/workspace/plan-example.md',
      },
      swarmMode: true,
      usage: {
        byModel: {
          'example-model': {
            inputOther: 8,
            output: 5,
            inputCacheRead: 3,
            inputCacheCreation: 2,
          },
        },
        currentTurn: {
          inputOther: 8,
          output: 5,
          inputCacheRead: 3,
          inputCacheCreation: 2,
        },
        total: {
          inputOther: 8,
          output: 5,
          inputCacheRead: 3,
          inputCacheCreation: 2,
        },
      },
      tools: [
        {
          name: 'ExampleTool',
          description: 'Runs a neutral example.',
          parameters: { type: 'object' },
          source: 'user' as const,
          disclosure: 'deferred' as const,
          info: { category: 'example' },
        },
      ],
      tasks: [
        {
          kind: 'process' as const,
          taskId: 'task-example',
          description: 'Run a neutral process',
          status: 'completed' as const,
          detached: false,
          startedAt: 10,
          endedAt: 11,
          stopReason: 'complete',
          terminalNotificationSuppressed: true,
          timeoutMs: 1_000,
          command: 'echo example',
          pid: 42,
          exitCode: 0,
        },
      ],
      todos: [],
    };

    expect(agentReplayViewContract.read.output.parse(snapshot)).toEqual(snapshot);
  });
});

describe('session init contract', () => {
  it('accepts a null wire result for synchronous cancellation', () => {
    expect(sessionInitContract.cancelInit.output.safeParse(null).success).toBe(true);
  });
});

describe('session skill catalog contract', () => {
  it('accepts no arguments for catalog reload', () => {
    expect(sessionSkillCatalogContract.reload.input.safeParse([]).success).toBe(true);
  });

  it('normalizes a null catalog reload result to undefined', () => {
    const result = sessionSkillCatalogContract.reload.output.safeParse(null);

    expect(result).toEqual({ success: true, data: undefined });
  });
});

describe('session BTW contract', () => {
  it('accepts a side-agent id result', () => {
    expect(sessionBtwContract.start.output.parse('agent-example')).toBe('agent-example');
  });
});

describe('session goal queue contract', () => {
  it('keeps upcoming-goal timestamps as wire strings', () => {
    const snapshot = {
      goals: [
        {
          id: 'goal-example',
          objective: 'Finish the example migration',
          createdAt: 'created-at-example',
          updatedAt: 'updated-at-example',
        },
      ],
    };

    expect(goalQueueSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it.each([
    {
      method: 'read',
      parse: () => sessionGoalQueueContract.read.input.safeParse([]),
    },
    {
      method: 'append',
      parse: () =>
        sessionGoalQueueContract.append.input.safeParse([
          { objective: 'Add the next goal' },
        ]),
    },
    {
      method: 'update',
      parse: () =>
        sessionGoalQueueContract.update.input.safeParse([
          { goalId: 'goal-example', objective: 'Update the goal' },
        ]),
    },
    {
      method: 'remove',
      parse: () =>
        sessionGoalQueueContract.remove.input.safeParse([
          { goalId: 'goal-example' },
        ]),
    },
    {
      method: 'restore',
      parse: () =>
        sessionGoalQueueContract.restore.input.safeParse([
          {
            id: 'goal-example',
            objective: 'Restore the goal',
            createdAt: '2026-07-27T00:00:00.000Z',
            updatedAt: '2026-07-27T00:00:00.000Z',
          },
        ]),
    },
    {
      method: 'move',
      parse: () =>
        sessionGoalQueueContract.move.input.safeParse([
          { goalId: 'goal-example', direction: 'up' },
        ]),
    },
  ])('accepts the $method method payload', ({ parse }) => {
    expect(parse().success).toBe(true);
  });

  it('rejects a goal queue move outside the wire direction union', () => {
    expect(goalQueueMoveDirectionSchema.safeParse('first').success).toBe(false);
  });
});
