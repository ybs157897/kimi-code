import {
  type NoticeFrame,
  type ToolCallFrame,
  type TranscriptAttachment,
  type TranscriptFrame,
  type TranscriptInteraction,
  type TranscriptTask,
} from '@moonshot-ai/transcript';

import { Badge, JsonView } from '../../ui';
import { InteractionEntityView } from './InteractionEntityView';

// ---------------------------------------------------------------- frames

export function AttachmentChips({
  ids,
  attachments,
}: {
  ids: readonly string[];
  attachments: ReadonlyMap<string, TranscriptAttachment>;
}) {
  return (
    <div className="mb-2 flex flex-wrap gap-1">
      {ids.map((id) => {
        const attachment = attachments.get(id);
        const label = attachment?.name ?? attachment?.mediaType ?? id;
        const href =
          attachment?.source?.kind === 'url' ? attachment.source.url : undefined;
        return (
          <span
            key={id}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] text-neutral-400"
            title={attachment?.mediaType}
          >
            📎 {href !== undefined ? <a href={href} className="underline">{label}</a> : label}
          </span>
        );
      })}
    </div>
  );
}

export function FrameView({
  frame,
  tasks,
  interactions,
  attachments,
}: {
  frame: TranscriptFrame;
  tasks: ReadonlyMap<string, TranscriptTask>;
  interactions: ReadonlyMap<string, TranscriptInteraction>;
  attachments: ReadonlyMap<string, TranscriptAttachment>;
}) {
  switch (frame.kind) {
    case 'text': {
      const chips =
        frame.attachmentIds !== undefined && frame.attachmentIds.length > 0 ? (
          <AttachmentChips ids={frame.attachmentIds} attachments={attachments} />
        ) : null;
      const taskBadge =
        frame.taskId !== undefined ? (
          <div className="mb-1">
            <Badge tone={tasks.get(frame.taskId)?.state === 'running' ? 'amber' : 'neutral'}>
              task: {frame.taskId}
              {tasks.get(frame.taskId) !== undefined ? ` (${tasks.get(frame.taskId)!.state})` : ''}
            </Badge>
          </div>
        ) : null;
      const bubble =
        frame.role === 'user' ? (
          <div className="mb-2 flex justify-end">
            <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-sky-900/40 px-3 py-2 text-[13px] text-neutral-100">
              {frame.text}
            </div>
          </div>
        ) : (
          <div className="mb-2 max-w-[85%] whitespace-pre-wrap rounded-lg bg-neutral-800/60 px-3 py-2 text-[13px] text-neutral-100">
            {frame.text}
          </div>
        );
      return (
        <>
          {taskBadge}
          {chips}
          {bubble}
        </>
      );
    }
    case 'thinking':
      return (
        <div className="mb-2 max-w-[85%] whitespace-pre-wrap rounded-lg border border-dashed border-neutral-700 px-3 py-2 font-mono text-[11px] text-neutral-500">
          {frame.text}
        </div>
      );
    case 'tool':
      return <ToolFrameView frame={frame} tasks={tasks} interactions={interactions} />;
    case 'notice':
      return <NoticeFrameView frame={frame} />;
  }
}

function ToolFrameView({
  frame,
  tasks,
  interactions,
}: {
  frame: ToolCallFrame;
  tasks: ReadonlyMap<string, TranscriptTask>;
  interactions: ReadonlyMap<string, TranscriptInteraction>;
}) {
  const task = frame.taskId !== undefined ? tasks.get(frame.taskId) : undefined;
  // The interaction anchored at this call (via approvalId, or by scanning the
  // entity's toolCallId for requests that predate the back-link).
  const linked = [...interactions.values()].filter(
    (interaction) =>
      interaction.interactionId === frame.approvalId || interaction.toolCallId === frame.toolCallId,
  );
  return (
    <div className="mb-2 max-w-[85%] rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2 font-mono text-[11px]">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge tone={frame.state === 'error' ? 'red' : frame.state === 'running' ? 'amber' : 'neutral'}>
          tool
        </Badge>
        <span className="text-neutral-300">{frame.name}</span>
        <span className="text-neutral-600 select-all">{frame.toolCallId}</span>
        {frame.view !== undefined && frame.view !== frame.name ? (
          <span className="text-neutral-600">view: {frame.view}</span>
        ) : null}
        {frame.agentRefs?.map((ref) => (
          <Badge key={ref.agentId} tone="sky">
            agent: {ref.agentId}
          </Badge>
        ))}
        {task !== undefined ? <span className="text-neutral-600">task: {task.state}</span> : null}
        {frame.todoId !== undefined ? <span className="text-neutral-600">todo: {frame.todoId}</span> : null}
      </div>
      {frame.input !== undefined ? (
        typeof frame.input === 'string' ? (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-neutral-500">{frame.input}</pre>
        ) : (
          <JsonView data={frame.input} />
        )
      ) : null}
      {frame.output !== undefined ? (
        typeof frame.output === 'string' ? (
          <pre
            className={`max-h-40 overflow-auto whitespace-pre-wrap ${
              frame.state === 'error' ? 'text-red-400' : 'text-neutral-400'
            }`}
          >
            {frame.output}
          </pre>
        ) : (
          <JsonView data={frame.output} />
        )
      ) : task !== undefined && task.outputTail !== '' ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-neutral-400">
          {task.outputTail}
        </pre>
      ) : null}
      {frame.error !== undefined && frame.error !== frame.output ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-red-400">{frame.error}</pre>
      ) : null}
      {linked.map((interaction) => (
        <InteractionEntityView key={interaction.interactionId} interaction={interaction} nested />
      ))}
    </div>
  );
}

function NoticeFrameView({ frame }: { frame: NoticeFrame }) {
  const tone =
    frame.level === 'error'
      ? 'bg-red-950/50 text-red-400'
      : frame.level === 'warning'
        ? 'bg-amber-950/40 text-amber-300'
        : 'bg-neutral-900/60 text-neutral-400';
  return (
    <div className={`mb-2 max-w-[85%] rounded px-3 py-1.5 text-[11px] ${tone}`}>
      {frame.source !== undefined ? <span className="text-neutral-500">[{frame.source}] </span> : null}
      {frame.message}
      {frame.detail !== undefined ? <JsonView data={frame.detail} /> : null}
    </div>
  );
}
