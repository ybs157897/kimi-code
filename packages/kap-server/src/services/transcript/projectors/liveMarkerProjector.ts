/**
 * Live timeline marker projection.
 *
 * This adapter owns the live marker id namespace and the small set of engine
 * events that project directly to markers. It deliberately knows
 * `DomainEvent`; the transcript package and reducer remain engine-agnostic.
 */

import type { DomainEvent } from '@moonshot-ai/agent-core-v2';
import type {
  TranscriptMarker,
  TranscriptOperation,
} from '@moonshot-ai/transcript';

type DirectMarkerEvent =
  | Extract<DomainEvent, { type: 'hook.result' }>
  | Extract<DomainEvent, { type: 'skill.activated' }>
  | Extract<DomainEvent, { type: 'plugin_command.activated' }>
  | Extract<DomainEvent, { type: 'cron.fired' }>
  | Extract<DomainEvent, { type: `compaction.${string}` }>
  | Extract<DomainEvent, { type: 'context.spliced' }>
  | Extract<DomainEvent, { type: 'error' }>
  | Extract<DomainEvent, { type: 'warning' }>;

export class LiveMarkerProjector {
  private markerSeq = 0;

  project(event: DirectMarkerEvent): TranscriptOperation[] {
    switch (event.type) {
      case 'hook.result':
        return [this.marker('hook', eventPayload(event))];
      case 'skill.activated':
        return [this.marker('skill', eventPayload(event))];
      case 'plugin_command.activated':
        return [
          this.marker('skill', {
            ...eventPayload(event),
            variant: 'plugin_command',
          }),
        ];
      case 'cron.fired':
        return [this.marker('cron.fired', eventPayload(event))];
      case 'compaction.started':
      case 'compaction.blocked':
      case 'compaction.cancelled':
      case 'compaction.completed':
        return [
          this.marker('compaction', {
            phase: event.type.slice('compaction.'.length),
            ...eventPayload(event),
          }),
        ];
      case 'context.spliced':
        // Known limitation: undo/clear projects as a marker; persisted context
        // currently does not provide enough information for items.remove.
        return [this.marker('undo', eventPayload(event))];
      case 'error':
        return [this.notice('error', event.message, eventPayload(event))];
      case 'warning':
        return [this.notice('warning', event.message, eventPayload(event))];
    }
  }

  marker(marker: string, payload: unknown): TranscriptOperation {
    this.markerSeq += 1;
    const item: TranscriptMarker = {
      kind: 'marker',
      // Cold rebuilds own `m<N>`; live projection uses a separate namespace
      // so an upsert never replaces a historical marker.
      markerId: `live-m${this.markerSeq}`,
      marker,
      payload,
      at: nowIso(),
    };
    return { op: 'marker.upsert', item };
  }

  private notice(
    level: 'error' | 'warning' | 'info',
    message: string,
    payload: unknown,
  ): TranscriptOperation {
    return this.marker('notice', { level, message, event: payload });
  }
}

export function eventPayload(event: { readonly type: string }): Record<string, unknown> {
  const { type: _type, ...payload } = event;
  return payload;
}

function nowIso(): string {
  return new Date().toISOString();
}
