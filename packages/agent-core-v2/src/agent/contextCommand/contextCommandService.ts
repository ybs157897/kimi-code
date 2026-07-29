/**
 * `contextCommand` domain (L5) — `IAgentContextCommandService` implementation.
 *
 * Guards `clear()` and `importContext()` behind active-turn / compaction
 * checks, then delegates to `IAgentContextMemoryService`. `importContext()`
 * additionally validates input, XML-escapes content, checks for context
 * overflow, and appends durably to the wire. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import { ErrorCodes } from '#/errors';
import { escapeXml } from '#/_base/utils/xml-escape';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';

import {
  IAgentContextCommandService,
  type ContextImportInput,
} from './contextCommand';

const IMPORT_VARIANT = 'context_import';

export class AgentContextCommandService extends Disposable implements IAgentContextCommandService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentFullCompactionService private readonly fullCompaction: IAgentFullCompactionService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
  ) {
    super();
  }

  clear(): void {
    this.assertQuiescent();
    this.context.clear();
  }

  importContext(input: ContextImportInput): void {
    if (!input.content || input.content.trim().length === 0) {
      throw new Error2(ErrorCodes.CONTEXT_IMPORT_EMPTY, 'Import content must not be empty.');
    }
    if (!input.source || input.source.trim().length === 0) {
      throw new Error2(ErrorCodes.CONTEXT_IMPORT_INVALID, 'Import source must not be empty.');
    }
    this.assertQuiescent();

    const escapedContent = escapeXml(input.content);
    const message: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: escapedContent }],
      toolCalls: [],
      origin: { kind: 'injection', variant: IMPORT_VARIANT },
      note: input.source,
    };

    this.assertNoOverflow(message);
    this.context.append(message);
  }

  private assertQuiescent(): void {
    const quiescence = this.loop.tryAcquireQuiescence();
    if (quiescence === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_BUSY,
        'Cannot modify context while a turn is active or queued. Wait for it to finish, then retry.',
        { details: { reason: 'loop' } },
      );
    }
    quiescence.dispose();

    if (this.fullCompaction.compacting !== null) {
      throw new Error2(
        ErrorCodes.SESSION_BUSY,
        'Cannot modify context while conversation compaction is running. Wait for it to finish, then retry.',
        { details: { reason: 'compaction' } },
      );
    }
  }

  private assertNoOverflow(message: ContextMessage): void {
    const capabilities = this.profile.data().modelCapabilities;
    const inputLimit = capabilities.max_input_tokens ?? capabilities.max_context_tokens;
    if (inputLimit <= 0) return;

    const currentSize = this.contextSize.get().size;
    const estimatedTokens = estimateTokensForMessages([message]);

    if (currentSize + estimatedTokens > inputLimit) {
      throw new Error2(
        ErrorCodes.CONTEXT_IMPORT_OVERFLOW,
        `Import would exceed the model's context window (current: ${currentSize}, import: ${estimatedTokens}, limit: ${inputLimit}).`,
        { details: { currentSize, estimatedTokens, inputLimit } },
      );
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextCommandService,
  AgentContextCommandService,
  ScopeActivation.OnDemand,
  'contextCommand',
);
