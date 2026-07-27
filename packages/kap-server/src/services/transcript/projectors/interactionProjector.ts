/**
 * Approval/question interaction projection.
 *
 * Interaction entities are global and replace-on-upsert. This projector owns
 * their pending state; the optional tool-frame backlink is delegated through
 * a narrow callback to the frame owner.
 */

import type {
  TranscriptInteraction,
  TranscriptOperation,
} from '@moonshot-ai/transcript';

export interface ProjectorInteraction {
  readonly id: string;
  readonly kind: 'approval' | 'question';
  readonly payload: unknown;
  readonly origin: {
    readonly agentId?: string;
    readonly turnId?: number;
  };
}

export type LinkApproval = (
  toolCallId: string,
  interactionId: string,
) => TranscriptOperation | undefined;

export class InteractionProjector {
  private readonly interactions = new Map<string, TranscriptInteraction>();

  constructor(private readonly linkApproval: LinkApproval) {}

  requested(interaction: ProjectorInteraction): TranscriptOperation[] {
    const payload = interaction.payload as { toolCallId?: unknown };
    const toolCallId =
      typeof payload.toolCallId === 'string'
        ? payload.toolCallId
        : undefined;
    const entity: TranscriptInteraction = {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      toolCallId,
      state: 'pending',
      request: interaction.payload,
    };
    this.interactions.set(interaction.id, entity);
    return [{ op: 'interaction.upsert', interaction: entity }];
  }

  resolved(id: string, response: unknown): TranscriptOperation[] {
    const record = this.interactions.get(id);
    if (record === undefined) return [];
    this.interactions.delete(id);
    const ops: TranscriptOperation[] = [
      {
        op: 'interaction.upsert',
        interaction: {
          ...record,
          state: mapInteractionEndState(record.interactionKind, response),
          response,
        },
      },
    ];
    if (record.toolCallId !== undefined) {
      const link = this.linkApproval(record.toolCallId, id);
      if (link !== undefined) ops.push(link);
    }
    return ops;
  }
}

function mapInteractionEndState(
  kind: TranscriptInteraction['interactionKind'],
  response: unknown,
): TranscriptInteraction['state'] {
  if (kind === 'question') {
    return response === null ? 'dismissed' : 'answered';
  }
  const decision = (
    response as { decision?: unknown } | null | undefined
  )?.decision;
  if (
    decision === 'approved' ||
    decision === 'rejected' ||
    decision === 'cancelled'
  ) {
    return decision;
  }
  return 'cancelled';
}
