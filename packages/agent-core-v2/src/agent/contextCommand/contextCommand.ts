/**
 * `contextCommand` domain (L5) — `IAgentContextCommandService` contract.
 *
 * Guards context mutations (clear / import) against active turns and
 * compaction, then delegates to `IAgentContextMemoryService`. Exposed as an
 * Agent-scoped service so callers at the edge can trigger these operations
 * without knowing the internal guard logic. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ContextImportInput {
  readonly content: string;
  readonly source: string;
}

export interface IAgentContextCommandService {
  readonly _serviceBrand: undefined;

  /** Clear the entire conversation history, guarded against active turns and
   *  compaction. Throws `session.busy` if the agent is busy; does NOT
   *  implicitly cancel. */
  clear(): void;

  /** Import external content into the conversation as a user message. The
   *  content is XML-escaped, validated for emptiness, checked against the
   *  current context window to prevent overflow, and appended durably to the
   *  wire so it survives close/resume. Throws `context_import.empty`,
   *  `context_import.invalid`, `context_import.overflow`, or `session.busy`. */
  importContext(input: ContextImportInput): void;
}

export const IAgentContextCommandService: ServiceIdentifier<IAgentContextCommandService> =
  createDecorator<IAgentContextCommandService>('agentContextCommandService');
