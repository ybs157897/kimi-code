export interface HookResultView {
  readonly hookEvent: string;
  readonly content: string;
  readonly blocked?: boolean;
}

export function formatHookResultMarkdown(event: HookResultView): string {
  return `*${formatHookResultTitle(event)}*\n\n${formatHookResultBody(event)}`;
}

export function formatHookResultPlain(event: HookResultView): string {
  return `${formatHookResultTitle(event)}\n\n${formatHookResultBody(event)}`;
}

function formatHookResultTitle(event: HookResultView): string {
  return `${event.hookEvent} hook${event.blocked === true ? ' blocked' : ''}`;
}

function formatHookResultBody(event: HookResultView): string {
  const content = event.content.trim();
  return content.length === 0 ? '(empty)' : content;
}
