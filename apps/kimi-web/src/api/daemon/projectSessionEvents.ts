// apps/kimi-web/src/api/daemon/projectSessionEvents.ts
// Session-scoped raw event projection: session.meta.updated (title / last
// prompt meta patches) and agent.status.updated (usage / model / mode flags).

import type { AppEvent } from '../types';
import { buildUsageSnapshot, type SessionState } from './projectorState';

export function projectSessionMetaUpdated(sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  // The daemon auto-generates a title from the first prompt (and other
  // clients can rename a session); it also reports the latest user prompt
  // via patch.lastPrompt. It announces all of these via this event. We
  // don't have the full AppSession here, so emit a lightweight
  // sessionMetaUpdated that patches only the changed meta fields.
  const title: string | undefined = p?.patch?.title ?? p?.title;
  const lastPrompt: string | undefined = p?.patch?.lastPrompt;
  const patch: { title?: string; lastPrompt?: string } = {};
  if (typeof title === 'string' && title.length > 0) patch.title = title;
  if (typeof lastPrompt === 'string') patch.lastPrompt = lastPrompt;
  if (patch.title !== undefined || patch.lastPrompt !== undefined) {
    out.push({ type: 'sessionMetaUpdated', sessionId, ...patch });
  }
  return out;
}

export function projectAgentStatusUpdated(s: SessionState, sessionId: string, p: any): AppEvent[] {
  const out: AppEvent[] = [];
  if (p?.model) s.model = p.model;
  if (p?.contextTokens !== undefined) s.contextTokens = p.contextTokens;
  if (p?.maxContextTokens !== undefined) s.contextLimit = p.maxContextTokens;

  out.push({
    type: 'sessionUsageUpdated',
    sessionId,
    usage: buildUsageSnapshot(s),
    // Carry the live model so the status bar shows the real running model
    // instead of falling back to the daemon's (empty) REST model.
    model: s.model || undefined,
    swarmMode: p?.swarmMode === true ? true : p?.swarmMode === false ? false : undefined,
    // The agent reports plan mode here too (e.g. it auto-entered plan mode
    // for a "make a plan" prompt). Carry it so the composer's plan toggle
    // reflects the agent's real state, not just the user's manual choice.
    planMode: p?.planMode === true ? true : p?.planMode === false ? false : undefined,
    // The session's own thinking level, so per-session state stays in sync
    // across clients (same treatment as plan/swarm above).
    thinking:
      typeof p?.thinkingEffort === 'string' && p.thinkingEffort.length > 0
        ? p.thinkingEffort
        : undefined,
  });
  return out;
}
