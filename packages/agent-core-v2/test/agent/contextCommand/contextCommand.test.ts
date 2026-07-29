/**
 * Scenario: guarded context clear and import through IAgentContextCommandService.
 * Responsibility: verify busy/compaction guards, input validation, XML escaping,
 *   overflow check, and durable append.
 * Wiring: resolve IAgentContextCommandService by interface via TestInstantiationService
 *   with stubs for all Agent-scoped dependencies.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/agent/contextCommand/contextCommand.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ErrorCodes } from '#/errors';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextSize } from '#/agent/contextSize/contextSize';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { AgentConfigData } from '#/agent/profile/profile';
import { IAgentProfileService } from '#/agent/profile/profile';

import {
  IAgentContextCommandService,
} from '#/agent/contextCommand/contextCommand';
import { AgentContextCommandService } from '#/agent/contextCommand/contextCommandService';

function createRealCapabilities(overrides?: Partial<ModelCapability>): ModelCapability {
  return {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: true,
    max_context_tokens: 128000,
    max_input_tokens: 100000,
    ...overrides,
  };
}

function stubProfileData(overrides?: Partial<AgentConfigData>): AgentConfigData {
  return {
    cwd: '/tmp',
    modelAlias: 'mock-model',
    modelCapabilities: createRealCapabilities(),
    profileName: 'default',
    thinkingLevel: 'off',
    systemPrompt: '',
    ...overrides,
  };
}

describe('AgentContextCommandService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  // Mutable state for stubs to simulate different scenarios.
  let busy: boolean;
  let compacting: boolean;
  let contextMessages: ContextMessage[];
  let contextSizeValue: ContextSize;
  let profileData: AgentConfigData;

  function makeStubs(): void {
    busy = false;
    compacting = false;
    contextMessages = [];
    contextSizeValue = { size: 0, measured: 0, estimated: 0 };
    profileData = stubProfileData();

    const loopStub: IAgentLoopService = {
      _serviceBrand: undefined,
      tryAcquireQuiescence: () => (busy ? undefined : toDisposable(() => {})),
      settled: async () => {},
      hasPendingRequests: () => busy,
      cancel: () => false,
      status: () => ({ state: busy ? 'running' : 'idle' as const, hasPendingRequests: busy, pendingTurnIds: [], activeTurnId: undefined, activeTraceId: undefined }),
      enqueue: () => ({ assigned: Promise.resolve({ turn: {} as any, step: {} as any }), abort: () => false }),
      run: async () => ({ outcome: 'completed', turnsUsed: 0, usage: {} }),
      registerLoopErrorHandler: () => toDisposable(() => {}),
      hooks: {} as IAgentLoopService['hooks'],
    } as unknown as IAgentLoopService;

    const compactionStub: IAgentFullCompactionService = {
      _serviceBrand: undefined,
      get compacting() {
        return compacting
          ? {
              abortController: new AbortController(),
              promise: Promise.resolve({
                summary: '',
                contextSummary: '',
                compactedCount: 0,
                tokensBefore: 0,
                tokensAfter: 0,
                keptUserMessageCount: 0,
                keptHeadUserMessageCount: 0,
                droppedCount: 0,
                messages: [],
              }),
              trigger: 'manual',
              tokenCount: 100,
            }
          : null;
      },
      begin: () => false,
      hooks: {} as IAgentFullCompactionService['hooks'],
      onDidFinishCompaction: () => toDisposable(() => {}),
    } as unknown as IAgentFullCompactionService;

    const memoryStub: IAgentContextMemoryService = {
      _serviceBrand: undefined,
      get: () => contextMessages,
      append: (...messages: readonly ContextMessage[]) => {
        contextMessages.push(...messages);
      },
      appendLoopEvent: () => {},
      clear: () => {
        contextMessages = [];
      },
      undo: () => ({ cutIndex: 0, removedCount: 0, stoppedAtCompaction: false }),
      applyCompaction: () => ({
        summary: '',
        contextSummary: '',
        compactedCount: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        keptUserMessageCount: 0,
      }),
    };

    const contextSizeStub: IAgentContextSizeService = {
      _serviceBrand: undefined,
      get: () => contextSizeValue,
      measured: () => {},
    };

    const profileStub: IAgentProfileService = {
      _serviceBrand: undefined,
      data: () => profileData,
      changeModel: async () => ({}),
    } as unknown as IAgentProfileService;

    ix.set(IAgentLoopService, loopStub);
    ix.set(IAgentFullCompactionService, compactionStub);
    ix.set(IAgentContextMemoryService, memoryStub);
    ix.set(IAgentContextSizeService, contextSizeStub);
    ix.set(IAgentProfileService, profileStub);
    ix.set(IAgentContextCommandService, new SyncDescriptor(AgentContextCommandService));
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = new TestInstantiationService();
    disposables.add(ix);
  });

  afterEach(() => disposables.dispose());

  function sut(): IAgentContextCommandService {
    return ix.get(IAgentContextCommandService);
  }

  // ── import ────────────────────────────────────────────────────────────

  it('imports content as a durable user message with XML-escaped content', () => {
    makeStubs();
    sut().importContext({ content: '<hello>&world</hello>', source: 'test' });

    expect(contextMessages).toHaveLength(1);
    const msg = contextMessages[0]!;
    expect(msg.role).toBe('user');
    expect(msg.content).toEqual([
      { type: 'text', text: '&lt;hello&gt;&amp;world&lt;/hello&gt;' },
    ]);
    expect(msg.origin).toEqual({ kind: 'injection', variant: 'context_import' });
    expect(msg.note).toBe('test');
  });

  it('throws context_import.empty when content is empty string', () => {
    makeStubs();
    expect(() => sut().importContext({ content: '', source: 'test' })).toThrow(
      expect.objectContaining({ code: ErrorCodes.CONTEXT_IMPORT_EMPTY }),
    );
  });

  it('throws context_import.empty when content is whitespace only', () => {
    makeStubs();
    expect(() => sut().importContext({ content: '   ', source: 'test' })).toThrow(
      expect.objectContaining({ code: ErrorCodes.CONTEXT_IMPORT_EMPTY }),
    );
  });

  it('throws context_import.invalid when source is empty', () => {
    makeStubs();
    expect(() => sut().importContext({ content: 'hello', source: '' })).toThrow(
      expect.objectContaining({ code: ErrorCodes.CONTEXT_IMPORT_INVALID }),
    );
  });

  it('throws context_import.invalid when source is whitespace only', () => {
    makeStubs();
    expect(() => sut().importContext({ content: 'hello', source: '  ' })).toThrow(
      expect.objectContaining({ code: ErrorCodes.CONTEXT_IMPORT_INVALID }),
    );
  });

  it('throws session.busy when a turn is active during import', () => {
    makeStubs();
    busy = true;
    expect(() => sut().importContext({ content: 'hello', source: 'test' })).toThrow(
      expect.objectContaining({ code: ErrorCodes.SESSION_BUSY }),
    );
    expect(contextMessages).toHaveLength(0);
  });

  it('throws session.busy when compaction is running during import', () => {
    makeStubs();
    compacting = true;
    expect(() => sut().importContext({ content: 'hello', source: 'test' })).toThrow(
      expect.objectContaining({ code: ErrorCodes.SESSION_BUSY }),
    );
    expect(contextMessages).toHaveLength(0);
  });

  it('throws context_import.overflow when import would exceed context window', () => {
    makeStubs();
    contextSizeValue = { size: 99900, measured: 99900, estimated: 99900 };
    expect(() =>
      sut().importContext({ content: 'a'.repeat(10000), source: 'test' }),
    ).toThrow(expect.objectContaining({ code: ErrorCodes.CONTEXT_IMPORT_OVERFLOW }));
    expect(contextMessages).toHaveLength(0);
  });

  it('does not check overflow when input limit is unknown (0)', () => {
    makeStubs();
    profileData = stubProfileData({
      modelCapabilities: createRealCapabilities({ max_input_tokens: undefined, max_context_tokens: 0 }),
    });
    expect(() =>
      sut().importContext({ content: 'hello', source: 'test' }),
    ).not.toThrow();
    expect(contextMessages).toHaveLength(1);
  });

  // ── clear ─────────────────────────────────────────────────────────────

  it('clears the conversation history when idle', () => {
    makeStubs();
    contextMessages = [
      { role: 'user', content: [{ type: 'text', text: 'previous' }], toolCalls: [] },
    ];
    sut().clear();
    expect(contextMessages).toHaveLength(0);
  });

  it('throws session.busy when a turn is active during clear', () => {
    makeStubs();
    busy = true;
    contextMessages = [
      { role: 'user', content: [{ type: 'text', text: 'previous' }], toolCalls: [] },
    ];
    expect(() => sut().clear()).toThrow(
      expect.objectContaining({ code: ErrorCodes.SESSION_BUSY }),
    );
    expect(contextMessages).toHaveLength(1);
  });

  it('throws session.busy when compaction is running during clear', () => {
    makeStubs();
    compacting = true;
    contextMessages = [
      { role: 'user', content: [{ type: 'text', text: 'previous' }], toolCalls: [] },
    ];
    expect(() => sut().clear()).toThrow(
      expect.objectContaining({ code: ErrorCodes.SESSION_BUSY }),
    );
    expect(contextMessages).toHaveLength(1);
  });

  it('clear does not cancel an active turn', () => {
    makeStubs();
    busy = true;
    expect(() => sut().clear()).toThrow();
    // The error is the only side effect — no cancellation, no state change.
  });

  it('satisfies the IAgentContextCommandService contract', () => {
    makeStubs();
    const svc = sut();
    expect(typeof svc.clear).toBe('function');
    expect(typeof svc.importContext).toBe('function');
  });
});
