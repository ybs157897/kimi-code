/**
 * Prompt queue projection.
 *
 * `prompt.upsert` replaces the whole entity, so this projector alone owns the
 * last prompt value needed to preserve slices across partial engine events.
 */

import type { DomainEvent } from '@moonshot-ai/agent-core-v2';
import type {
  TranscriptOperation,
  TranscriptPrompt,
} from '@moonshot-ai/transcript';

type PromptCompletedEvent = Extract<DomainEvent, { type: 'prompt.completed' }>;
type PromptAbortedEvent = Extract<DomainEvent, { type: 'prompt.aborted' }>;
type PromptSteeredEvent = Extract<DomainEvent, { type: 'prompt.steered' }>;

/**
 * Edge-synthesized submission shape. The v2 prompt service currently emits
 * only terminal/steer events, but an edge that observes submission can feed
 * it through the same projector.
 */
export interface ProjectorPromptSubmittedEvent {
  readonly type: 'prompt.submitted';
  readonly promptId: string;
  readonly userMessageId: string;
  readonly status: 'running' | 'queued' | 'blocked';
  readonly content?: unknown;
  readonly createdAt: string;
}

export type PromptProjectionEvent =
  | ProjectorPromptSubmittedEvent
  | PromptCompletedEvent
  | PromptAbortedEvent
  | PromptSteeredEvent;

export class PromptProjector {
  private readonly prompts = new Map<string, TranscriptPrompt>();

  project(event: PromptProjectionEvent): TranscriptOperation[] {
    switch (event.type) {
      case 'prompt.submitted':
        return this.onSubmitted(event);
      case 'prompt.completed':
        return this.onCompleted(event);
      case 'prompt.aborted':
        return this.onAborted(event);
      case 'prompt.steered':
        return this.onSteered(event);
    }
  }

  private onSubmitted(event: ProjectorPromptSubmittedEvent): TranscriptOperation[] {
    const prompt = this.upsert(event.promptId, () => ({
      promptId: event.promptId,
      status: event.status,
      userMessageId: event.userMessageId,
      content: event.content,
      createdAt: event.createdAt,
    }));
    return [{ op: 'prompt.upsert', prompt }];
  }

  private onCompleted(event: PromptCompletedEvent): TranscriptOperation[] {
    const prompt = this.upsert(event.promptId, (previous) => ({
      promptId: event.promptId,
      status: event.reason ?? 'completed',
      userMessageId: previous?.userMessageId,
      content: previous?.content,
      createdAt: previous?.createdAt ?? event.finishedAt,
      finishedAt: event.finishedAt,
      steeredAt: previous?.steeredAt,
    }));
    return [{ op: 'prompt.upsert', prompt }];
  }

  private onAborted(event: PromptAbortedEvent): TranscriptOperation[] {
    const prompt = this.upsert(event.promptId, (previous) => ({
      promptId: event.promptId,
      status: 'aborted',
      userMessageId: previous?.userMessageId,
      content: previous?.content,
      createdAt: previous?.createdAt ?? event.abortedAt,
      finishedAt: event.abortedAt,
      steeredAt: previous?.steeredAt,
    }));
    return [{ op: 'prompt.upsert', prompt }];
  }

  private onSteered(event: PromptSteeredEvent): TranscriptOperation[] {
    const ops: TranscriptOperation[] = [];
    const active = this.upsert(event.activePromptId, (previous) => ({
      promptId: event.activePromptId,
      status: previous?.status ?? 'running',
      userMessageId: previous?.userMessageId,
      content: event.content,
      createdAt: previous?.createdAt ?? event.steeredAt,
      finishedAt: previous?.finishedAt,
      steeredAt: event.steeredAt,
    }));
    ops.push({ op: 'prompt.upsert', prompt: active });
    for (const promptId of event.promptIds) {
      const steered = this.upsert(promptId, (previous) => ({
        promptId,
        status: 'completed',
        userMessageId: previous?.userMessageId,
        content: previous?.content,
        createdAt: previous?.createdAt ?? event.steeredAt,
        finishedAt: event.steeredAt,
        steeredAt: event.steeredAt,
      }));
      ops.push({ op: 'prompt.upsert', prompt: steered });
    }
    return ops;
  }

  private upsert(
    promptId: string,
    build: (previous: TranscriptPrompt | undefined) => TranscriptPrompt,
  ): TranscriptPrompt {
    const prompt = build(this.prompts.get(promptId));
    this.prompts.set(promptId, prompt);
    return prompt;
  }
}
