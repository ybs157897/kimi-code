/**
 * Interaction → v1 protocol event synthesis for the session event broadcaster
 * (`sessionEventBroadcaster.ts`).
 */

import type { ApprovalResponse, Interaction, InteractionKind } from '@moonshot-ai/agent-core-v2';
import { toWireApproval } from '../../../routes/approvals';
import { toWireQuestion } from '../../../routes/questions';
import type { Event } from './events';

// ---------------------------------------------------------------------------
// Interaction → v1 protocol event synthesis. Event names and payload shapes
// mirror v1's question/approval services
// (`packages/server/src/services/{question,approval}/*Service.ts`); the wire
// request bodies are the same projections the REST/snapshot routes use.
// ---------------------------------------------------------------------------

export function interactionRequestedEvent(interaction: Interaction, sessionId: string): Event | undefined {
  const agentId = interaction.origin.agentId ?? 'main';
  switch (interaction.kind) {
    case 'question':
      return {
        type: 'event.question.requested',
        agentId,
        sessionId,
        ...toWireQuestion(interaction, sessionId),
      } as unknown as Event;
    case 'approval':
      return {
        type: 'event.approval.requested',
        agentId,
        sessionId,
        ...toWireApproval(interaction, sessionId),
      } as unknown as Event;
    default:
      // 'user_tool' has no v1 protocol event.
      return undefined;
  }
}

export function interactionResolvedEvent(
  kind: InteractionKind,
  id: string,
  response: unknown,
  sessionId: string,
  agentId: string,
): Event | undefined {
  const resolvedAt = new Date().toISOString();
  switch (kind) {
    case 'question': {
      // `null` marks a dismissal (see `ISessionQuestionService.dismiss`).
      if (response === null) {
        return {
          type: 'event.question.dismissed',
          agentId,
          sessionId,
          question_id: id,
          dismissed_at: resolvedAt,
        } as unknown as Event;
      }
      // `QuestionResult` is either `{ answers, method? }` or a bare answers record.
      const answers = (response as { answers?: unknown }).answers ?? response;
      return {
        type: 'event.question.answered',
        agentId,
        sessionId,
        question_id: id,
        answers,
        resolved_at: resolvedAt,
      } as unknown as Event;
    }
    case 'approval': {
      const r = response as Partial<ApprovalResponse>;
      return {
        type: 'event.approval.resolved',
        agentId,
        sessionId,
        approval_id: id,
        decision: r.decision,
        scope: r.scope,
        feedback: r.feedback,
        selected_label: r.selectedLabel,
        resolved_at: resolvedAt,
      } as unknown as Event;
    }
    default:
      return undefined;
  }
}
