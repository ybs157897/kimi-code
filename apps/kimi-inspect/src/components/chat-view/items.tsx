import {
  type TranscriptAttachment,
  type TranscriptInteraction,
  type TranscriptItem,
  type TranscriptMarker,
  type TranscriptTask,
  type TranscriptTaskRef,
  type TranscriptTurn,
  type TranscriptUsage,
  type TurnOrigin,
  type TurnState,
} from '@moonshot-ai/transcript';

import { Badge, JsonView, relTime } from '../../ui';
import { AttachmentChips, FrameView } from './frames';

// ---------------------------------------------------------------- items

export function ItemView({
  item,
  tasks,
  interactions,
  attachments,
}: {
  item: TranscriptItem;
  tasks: ReadonlyMap<string, TranscriptTask>;
  interactions: ReadonlyMap<string, TranscriptInteraction>;
  attachments: ReadonlyMap<string, TranscriptAttachment>;
}) {
  switch (item.kind) {
    case 'turn':
      return <TurnView turn={item} tasks={tasks} interactions={interactions} attachments={attachments} />;
    case 'marker':
      return <MarkerView marker={item} />;
    case 'taskref':
      return <TaskRefView item={item} task={tasks.get(item.taskId)} />;
  }
}

export function collectToolCallIds(items: readonly TranscriptItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind === 'tool') ids.add(frame.toolCallId);
      }
    }
  }
  return ids;
}

function turnStateTone(state: TurnState): 'neutral' | 'green' | 'amber' | 'red' {
  switch (state) {
    case 'running':
      return 'amber';
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    default:
      return 'neutral';
  }
}

function usageText(usage: TranscriptUsage): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens}`);
  if (usage.cachedTokens !== undefined) parts.push(`cached ${usage.cachedTokens}`);
  if (usage.cost !== undefined) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(' / ');
}

function TurnView({
  turn,
  tasks,
  interactions,
  attachments,
}: {
  turn: TranscriptTurn;
  tasks: ReadonlyMap<string, TranscriptTask>;
  interactions: ReadonlyMap<string, TranscriptInteraction>;
  attachments: ReadonlyMap<string, TranscriptAttachment>;
}) {
  return (
    <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/30">
      <div className="flex items-center gap-2 border-b border-neutral-800/60 px-3 py-1.5">
        <span className="font-mono text-[10px] text-neutral-500">{turn.turnId}</span>
        <Badge tone={turn.origin.kind === 'user' ? 'sky' : 'neutral'}>{turn.origin.kind}</Badge>
        <Badge tone={turnStateTone(turn.state)}>{turn.state}</Badge>
        {turn.startedAt !== undefined ? (
          <span className="text-[10px] text-neutral-600">{relTime(Date.parse(turn.startedAt))}</span>
        ) : null}
        {turn.usage !== undefined ? (
          <span className="ml-auto text-[10px] text-neutral-600">{usageText(turn.usage)}</span>
        ) : null}
      </div>
      <div className="px-3 py-2">
        {turn.prompt !== undefined && turn.prompt !== '' ? (
          <TurnPrompt origin={turn.origin} prompt={turn.prompt} />
        ) : null}
        {turn.attachmentIds !== undefined && turn.attachmentIds.length > 0 ? (
          <AttachmentChips ids={turn.attachmentIds} attachments={attachments} />
        ) : null}
        {turn.steps.map((step) => (
          <div key={step.stepId}>
            {step.frames.map((frame) => (
              <FrameView
                key={frame.frameId}
                frame={frame}
                tasks={tasks}
                interactions={interactions}
                attachments={attachments}
              />
            ))}
            {step.state === 'interrupted' ? (
              <div className="mb-2 text-[10px] text-neutral-600 italic">step interrupted</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function TurnPrompt({ origin, prompt }: { origin: TurnOrigin; prompt: string }) {
  if (origin.kind === 'user') {
    return (
      <div className="mb-2 flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-sky-900/40 px-3 py-2 text-[13px] text-neutral-100">
          {prompt}
        </div>
      </div>
    );
  }
  return (
    <div className="mb-2 whitespace-pre-wrap rounded-lg border border-neutral-800 px-3 py-2 text-[12px] text-neutral-400">
      {prompt}
    </div>
  );
}

function MarkerView({ marker }: { marker: TranscriptMarker }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 text-[10px] text-neutral-600">
        <div className="h-px flex-1 bg-neutral-800" />
        <span className="font-mono">{marker.marker}</span>
        {marker.at !== undefined ? <span>{relTime(Date.parse(marker.at))}</span> : null}
        <div className="h-px flex-1 bg-neutral-800" />
      </div>
      {marker.payload !== undefined ? <JsonView data={marker.payload} /> : null}
    </div>
  );
}

function TaskRefView({
  item,
  task,
}: {
  item: TranscriptTaskRef;
  task: TranscriptTask | undefined;
}) {
  const failed =
    task !== undefined && (task.state === 'failed' || task.state === 'timed_out' || task.state === 'lost');
  return (
    <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-[11px]">
      <div className="flex items-center gap-2">
        <Badge tone={task?.state === 'running' ? 'amber' : failed ? 'red' : 'neutral'}>
          task{task !== undefined ? `: ${task.kind}` : ''}
        </Badge>
        <span className="text-neutral-300">{task?.description ?? item.taskId}</span>
        {task !== undefined ? (
          <span className="text-neutral-600">
            {task.state}
            {task.detached ? ' (detached)' : ''}
          </span>
        ) : null}
      </div>
      {task !== undefined && task.outputTail !== '' ? (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-neutral-500">
          {task.outputTail}
        </pre>
      ) : null}
    </div>
  );
}
