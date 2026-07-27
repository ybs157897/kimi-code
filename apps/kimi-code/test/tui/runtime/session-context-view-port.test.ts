/**
 * Scenario: read-only context snapshots cross a bound session-agent TUI boundary.
 * Responsibilities: both adapters map the neutral context wire fields, deep-copy history,
 * bind the requested agent, and preserve source errors. The legacy Session or
 * Klient agent facade is the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-context-view-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionContextViewPort } from '#/tui/runtime/klient-session-context-view-adapter';
import { createLegacySessionContextViewPort } from '#/tui/runtime/legacy-session-context-view-adapter';
import type {
  SessionContextView,
  TUIContentPart,
  TUIContextMessage,
  TUIToolCall,
} from '#/tui/runtime/session-context-view-port';

describe('legacy session context view adapter', () => {
  it('read maps available legacy context to the neutral view', async () => {
    const rig = legacyRig({
      getContext: vi.fn(async () => ({
        history: [contextMessage()],
        tokenCount: 12,
      })),
    });

    const result = await rig.port.read();

    expect(result).toEqual({
      history: [
        {
          role: 'assistant',
          name: 'reviewer',
          content: [
            { type: 'text', text: 'Inspect the change.' },
            {
              type: 'think',
              think: 'Check the boundary.',
              encrypted: 'reasoning-signature',
            },
            {
              type: 'image_url',
              imageUrl: { url: 'https://example.test/image.png', id: 'image-1' },
            },
            {
              type: 'audio_url',
              audioUrl: { url: 'https://example.test/audio.mp3', id: 'audio-1' },
            },
            {
              type: 'video_url',
              videoUrl: { url: 'https://example.test/video.mp4', id: 'video-1' },
            },
          ],
          toolCalls: [
            {
              type: 'function',
              id: 'call-1',
              name: 'Inspect',
              arguments: '{"path":"src/index.ts"}',
              extras: { provider: { trace: ['step-1'] } },
              _streamIndex: 2,
            },
          ],
          toolCallId: 'parent-call',
          partial: true,
          id: 'message-1',
          providerMessageId: 'provider-message-1',
          origin: {
            kind: 'runtime_extension',
            metadata: { attempt: 1 },
          },
          isError: true,
          note: 'model-only note',
        },
      ],
      tokenCount: 12,
    });
  });

  it('read deep-copies legacy messages without retaining nested wire values', async () => {
    const message = contextMessage();
    const history = [message];
    const rig = legacyRig({
      getContext: vi.fn(async () => ({ history, tokenCount: 12 })),
    });

    const result = await rig.port.read();

    expect(result.history).not.toBe(history);
    expect(result.history[0]).not.toBe(message);
    expect(result.history[0]?.content).not.toBe(message.content);
    expect(result.history[0]?.content[2]).not.toBe(message.content[2]);
    expect(
      (result.history[0]?.content[2] as Extract<
        TUIContentPart,
        { type: 'image_url' }
      >).imageUrl,
    ).not.toBe(
      (message.content[2] as Extract<TUIContentPart, { type: 'image_url' }>)
        .imageUrl,
    );
    expect(result.history[0]?.toolCalls).not.toBe(message.toolCalls);
    expect(result.history[0]?.toolCalls[0]?.extras).not.toBe(
      message.toolCalls[0]?.extras,
    );
    expect(result.history[0]?.origin).not.toBe(message.origin);
  });

  it('read binds legacy context loading to the requested agent', async () => {
    const rig = legacyRig();

    await rig.port.read();

    expect(rig.selectedAgentIds).toEqual(['worker']);
  });

  it('read rejects with the original legacy error when context loading fails', async () => {
    const error = new Error('Context unavailable.');
    const rig = legacyRig({
      getContext: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(rig.port.read()).rejects.toBe(error);
  });
});

describe('Klient session context view adapter', () => {
  it('read maps available Klient context to the neutral view', async () => {
    const rig = klientRig({
      getContext: vi.fn(async () => ({
        history: [contextMessage()],
        tokenCount: 24,
      })),
    });

    const result = await rig.port.read();

    expect(result).toEqual({
      history: [
        {
          role: 'assistant',
          name: 'reviewer',
          content: [
            { type: 'text', text: 'Inspect the change.' },
            {
              type: 'think',
              think: 'Check the boundary.',
              encrypted: 'reasoning-signature',
            },
            {
              type: 'image_url',
              imageUrl: { url: 'https://example.test/image.png', id: 'image-1' },
            },
            {
              type: 'audio_url',
              audioUrl: { url: 'https://example.test/audio.mp3', id: 'audio-1' },
            },
            {
              type: 'video_url',
              videoUrl: { url: 'https://example.test/video.mp4', id: 'video-1' },
            },
          ],
          toolCalls: [
            {
              type: 'function',
              id: 'call-1',
              name: 'Inspect',
              arguments: '{"path":"src/index.ts"}',
              extras: { provider: { trace: ['step-1'] } },
              _streamIndex: 2,
            },
          ],
          toolCallId: 'parent-call',
          partial: true,
          id: 'message-1',
          providerMessageId: 'provider-message-1',
          origin: {
            kind: 'runtime_extension',
            metadata: { attempt: 1 },
          },
          isError: true,
          note: 'model-only note',
        },
      ],
      tokenCount: 24,
    });
  });

  it('read deep-copies Klient messages without retaining nested wire values', async () => {
    const message = contextMessage();
    const history = [message];
    const rig = klientRig({
      getContext: vi.fn(async () => ({ history, tokenCount: 24 })),
    });

    const result = await rig.port.read();

    expect(result.history).not.toBe(history);
    expect(result.history[0]).not.toBe(message);
    expect(result.history[0]?.content).not.toBe(message.content);
    expect(result.history[0]?.content[2]).not.toBe(message.content[2]);
    expect(
      (result.history[0]?.content[2] as Extract<
        TUIContentPart,
        { type: 'image_url' }
      >).imageUrl,
    ).not.toBe(
      (message.content[2] as Extract<TUIContentPart, { type: 'image_url' }>)
        .imageUrl,
    );
    expect(result.history[0]?.toolCalls).not.toBe(message.toolCalls);
    expect(result.history[0]?.toolCalls[0]?.extras).not.toBe(
      message.toolCalls[0]?.extras,
    );
    expect(result.history[0]?.origin).not.toBe(message.origin);
  });

  it('read binds Klient context loading to the requested agent', async () => {
    const rig = klientRig();

    await rig.port.read();

    expect(rig.session.agent).toHaveBeenCalledWith('reviewer');
  });

  it('read rejects with the original Klient error when context loading fails', async () => {
    const error = new Error('Context unavailable.');
    const rig = klientRig({
      getContext: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(rig.port.read()).rejects.toBe(error);
  });
});

function contextMessage(): TUIContextMessage {
  const content: readonly TUIContentPart[] = [
    { type: 'text', text: 'Inspect the change.' },
    {
      type: 'think',
      think: 'Check the boundary.',
      encrypted: 'reasoning-signature',
    },
    {
      type: 'image_url',
      imageUrl: { url: 'https://example.test/image.png', id: 'image-1' },
    },
    {
      type: 'audio_url',
      audioUrl: { url: 'https://example.test/audio.mp3', id: 'audio-1' },
    },
    {
      type: 'video_url',
      videoUrl: { url: 'https://example.test/video.mp4', id: 'video-1' },
    },
  ];
  const toolCalls: readonly TUIToolCall[] = [
    {
      type: 'function',
      id: 'call-1',
      name: 'Inspect',
      arguments: '{"path":"src/index.ts"}',
      extras: { provider: { trace: ['step-1'] } },
      _streamIndex: 2,
    },
  ];
  const origin = {
    kind: 'runtime_extension',
    metadata: { attempt: 1 },
  };
  return {
    role: 'assistant',
    name: 'reviewer',
    content,
    toolCalls,
    toolCallId: 'parent-call',
    partial: true,
    id: 'message-1',
    providerMessageId: 'provider-message-1',
    origin,
    isError: true,
    note: 'model-only note',
  };
}

function legacyRig(
  overrides: Partial<{
    getContext: () => Promise<SessionContextView>;
  }> = {},
) {
  const session = {
    getContext:
      overrides.getContext ??
      vi.fn(async () => ({ history: [], tokenCount: 0 })),
  };
  const selectedAgentIds: string[] = [];
  const harness = {
    withInteractiveAgent<T>(agentId: string, operation: () => T): T {
      selectedAgentIds.push(agentId);
      return operation();
    },
  };
  return {
    port: createLegacySessionContextViewPort(
      harness,
      session,
      'worker',
    ),
    selectedAgentIds,
  };
}

function klientRig(
  overrides: Partial<{
    getContext: () => Promise<SessionContextView>;
  }> = {},
) {
  const agent = {
    getContext:
      overrides.getContext ??
      vi.fn(async () => ({ history: [], tokenCount: 0 })),
  };
  const session = {
    agent: vi.fn((_agentId: string) => agent),
  };
  return {
    port: createKlientSessionContextViewPort(session, 'reviewer'),
    session,
  };
}
