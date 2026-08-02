import type { AppAgentTranscript } from '../types';
import { toolLabel, toolSummary } from '../../lib/toolMeta';

interface TranscriptFrame {
  kind?: unknown;
  text?: unknown;
  role?: unknown;
  name?: unknown;
  input?: unknown;
}

interface TranscriptStep {
  frames?: unknown;
}

interface TranscriptTurn {
  kind?: unknown;
  steps?: unknown;
}

interface TranscriptResponse {
  items?: unknown;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    : [];
}

function frameText(frame: TranscriptFrame): string | undefined {
  return typeof frame.text === 'string' && frame.text.trim().length > 0 ? frame.text.trimEnd() : undefined;
}

function toolCallLine(frame: TranscriptFrame): string | undefined {
  if (typeof frame.name !== 'string' || frame.name.length === 0) return undefined;
  let serialized = '';
  if (typeof frame.input === 'string') serialized = frame.input;
  else if (frame.input !== undefined) {
    try {
      serialized = JSON.stringify(frame.input);
    } catch {
      serialized = '';
    }
  }
  const summary = toolSummary(frame.name, serialized);
  const label = toolLabel(frame.name.replace(/_\d+$/, ''));
  return summary ? `Calling ${label}: ${summary}` : `Calling ${label}`;
}

/** Flatten the transcript contract into the three sections used by AgentDetailPanel. */
export function normalizeAgentTranscript(value: unknown): AppAgentTranscript {
  const response = value as TranscriptResponse;
  const thinking: string[] = [];
  const text: string[] = [];
  const progressLines: string[] = [];

  for (const item of records(response.items) as TranscriptTurn[]) {
    if (item.kind !== 'turn') continue;
    for (const step of records(item.steps) as TranscriptStep[]) {
      for (const rawFrame of records(step.frames)) {
        const frame = rawFrame as TranscriptFrame;
        const content = frameText(frame);
        if (frame.kind === 'thinking' && content) thinking.push(content);
        else if (frame.kind === 'text' && frame.role === 'assistant' && content) text.push(content);
        else if (frame.kind === 'tool') {
          const line = toolCallLine(frame);
          if (line) progressLines.push(line);
        }
      }
    }
  }

  return {
    thinking: thinking.join('\n\n'),
    text: text.join('\n\n'),
    progressLines,
  };
}
