/**
 * TeamRuntime — the WorkBuddy-style mailbox that backs an active expert team.
 *
 * In expert-team mode the `Agent` tool is only a dispatch receipt: a member's
 * progress reports and final results must travel through `SendMessage` → this
 * runtime → a `<teammate-message>` pseudo-user message injected into the lead
 * (or another member). Members are long-lived subagents that can be woken for
 * follow-ups instead of being re-spawned.
 *
 * Delivery is in-memory (no polling): a message to the lead is `turn.steer`-ed
 * (buffered between steps when the lead is busy, launched as a fresh turn when
 * idle); a message to a running member is steered onto its active turn; a
 * message to an idle member wakes it through the main agent's subagent host.
 * The `journal` only holds envelopes that could not be delivered (a wake raced
 * or the process exited) so a crash/restart can replay them.
 */

import { randomUUID } from 'node:crypto';

import type { ExpertTeamMemberState } from '@moonshot-ai/protocol';

import type { Agent } from '../agent';
import type { PromptOrigin } from '../agent/context';
import { AgentBackgroundTask } from '../agent/background';
import { escapeXmlAttr } from '../utils/xml-escape';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  resolveSubagentTimeoutMs,
  type SubagentHandle,
} from '../session/subagent-host';

/** Reserved recipient/sender id for the expert-team lead (the main agent). */
export const TEAM_LEAD_ID = 'team-lead';

/**
 * Origin stamped on every injected `<teammate-message>`. `system_trigger`
 * carries a free-form `name`, matching the subagent-host precedent — no new
 * `PromptOrigin` kind is introduced (which would require touching the
 * compaction handoff switch).
 */
export const TEAMMATE_PROMPT_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'teammate' };

/** Timeout before an unanswered shutdown_request force-stops the member. */
export const SHUTDOWN_TIMEOUT_MS = 60_000;

/** Upper bound on retained undelivered envelopes; oldest are dropped past it. */
const JOURNAL_CAPACITY = 200;

/** Delay between attempts to durably commit lifecycle state. */
const DURABILITY_RETRY_MS = 1_000;

export type TeamMessageType =
  | 'message'
  | 'broadcast'
  | 'shutdown_request'
  | 'shutdown_response';

export interface TeamEnvelope {
  readonly id: string;
  readonly type: TeamMessageType;
  readonly from: string;
  readonly to: string;
  readonly summary: string;
  readonly text: string;
  readonly requestId?: string;
  readonly approve?: boolean;
  readonly sentAt: string;
}

export type TeamMemberStatus = 'idle' | 'running';

export interface TeamMemberEntry {
  readonly name: string;
  readonly agentId: string;
  status: TeamMemberStatus;
}

/** Persisted runtime shape (stored under `SessionMeta.expertTeamRuntime`). */
export interface ExpertTeamRuntimeState {
  readonly members: readonly { readonly name: string; readonly agentId: string }[];
  readonly pendingShutdowns: readonly {
    readonly requestId: string;
    readonly member: string;
    readonly requestedAt: string;
  }[];
  readonly journal: readonly TeamEnvelope[];
}

/** Narrow view of the owning session the runtime needs (avoids a hard cycle). */
export interface TeamRuntimeHost {
  getReadyAgent(id: string): Agent | undefined;
  ensureAgentResumed(id: string): Promise<Agent>;
}

/** Command shape accepted by the SendMessage tool, forwarded to `send()`. */
export interface TeamSendCommand {
  readonly type: TeamMessageType;
  readonly from: string;
  readonly recipient?: string;
  readonly summary: string;
  readonly text?: string;
  readonly requestId?: string;
  readonly approve?: boolean;
}

export interface TeamSendResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Minimal messenger surface the SendMessage tool depends on. The `Agent` class
 * only ever sees these interfaces — it never imports the concrete runtime — so
 * a standalone Agent stays decoupled from Session/expert-team internals.
 */
export interface TeamMessenger {
  send(command: TeamSendCommand): Promise<TeamSendResult>;
  /** Active roster member names, for the unknown-recipient error message. */
  memberNames(): readonly string[];
}

/** Extended surface the AgentTool team branch uses to dispatch members. */
export interface TeamCollaboration extends TeamMessenger {
  /** Member names declared by the team package (spawned or not). */
  declaredMemberNames(): readonly string[];
  isDeclaredMember(name: string): boolean;
  memberByName(name: string): TeamMemberEntry | undefined;
  /** Atomically reserve a declared member before the async spawn starts. */
  tryReserveMember(name: string): boolean;
  releaseMemberReservation(name: string): void;
  /**
   * Take ownership of a freshly spawned member turn: put it in the roster,
   * persist, register the detached background task (timeout / TaskStop), and
   * wire completion → idle / failure-mail / journal replay.
   */
  dispatchMember(
    name: string,
    handle: SubagentHandle,
    controller: AbortController,
    description: string,
  ): Promise<void>;
}

interface PendingShutdown {
  readonly requestId: string;
  readonly member: string;
  readonly requestedAt: string;
  timer?: ReturnType<typeof setTimeout>;
}

interface MemberRemovalLease {
  readonly entry: TeamMemberEntry;
  readonly token: symbol;
}

/** Render a `<teammate-message>` block. Deliberately not the `<notification>`
 *  protocol — that opening tag is load-bearing for other consumers. */
export function renderTeammateMessage(envelope: TeamEnvelope): string {
  return [
    `<teammate-message teammate_id="${escapeXmlAttr(envelope.from)}" summary="${escapeXmlAttr(
      envelope.summary,
    )}">`,
    envelope.text,
    '</teammate-message>',
  ].join('\n');
}

export class TeamRuntime implements TeamCollaboration {
  readonly roster = new Map<string, TeamMemberEntry>();
  private readonly journal: TeamEnvelope[] = [];
  private readonly pendingShutdowns = new Map<string, PendingShutdown>();
  private readonly memberReservations = new Set<string>();
  private readonly retiringMembers = new Map<string, MemberRemovalLease>();
  private readonly removingMembers = new Map<string, MemberRemovalLease>();
  private readonly retryTimers = new Map<symbol, ReturnType<typeof setTimeout>>();
  private readonly memberTasks = new Map<
    string,
    { readonly entry: TeamMemberEntry; readonly taskId: string }
  >();
  private disposed = false;

  constructor(
    private readonly host: TeamRuntimeHost,
    private readonly mainAgentId: string,
    private readonly declaredMembers: readonly string[],
    private readonly persistState: (state: ExpertTeamRuntimeState) => Promise<void>,
    private readonly onStatusChange?: () => void,
  ) {}

  // ── roster ──────────────────────────────────────────────────────────

  declaredMemberNames(): readonly string[] {
    return this.declaredMembers;
  }

  isDeclaredMember(name: string): boolean {
    return this.declaredMembers.includes(name);
  }

  registerMember(name: string, agentId: string): void {
    this.roster.set(name, { name, agentId, status: 'running' });
    this.emitStatusChange();
  }

  memberByName(name: string): TeamMemberEntry | undefined {
    return this.roster.get(name);
  }

  tryReserveMember(name: string): boolean {
    this.assertActive();
    if (
      this.roster.has(name) ||
      this.memberReservations.has(name) ||
      this.retiringMembers.has(name) ||
      this.removingMembers.has(name)
    ) {
      return false;
    }
    this.memberReservations.add(name);
    return true;
  }

  releaseMemberReservation(name: string): void {
    this.memberReservations.delete(name);
  }

  canAttachMember(name: string, agentId: string): boolean {
    if (this.disposed) return false;
    return this.memberReservations.has(name) || this.roster.get(name)?.agentId === agentId;
  }

  memberNames(): readonly string[] {
    return [...this.roster.keys()];
  }

  markMemberStatus(name: string, status: TeamMemberStatus): void {
    const entry = this.roster.get(name);
    if (entry !== undefined && entry.status !== status) {
      entry.status = status;
      this.emitStatusChange();
    }
  }

  memberStates(): readonly ExpertTeamMemberState[] {
    return [...this.roster.values()].map((entry) => ({
      name: entry.name,
      agentId: entry.agentId,
      status: entry.status,
    }));
  }

  /** True while any member belongs to, is joining, or is leaving the team. */
  hasActiveMembers(): boolean {
    return (
      this.roster.size > 0 ||
      this.memberReservations.size > 0 ||
      this.retiringMembers.size > 0 ||
      this.removingMembers.size > 0
    );
  }

  hasPendingShutdowns(): boolean {
    return this.pendingShutdowns.size > 0;
  }

  // ── persistence ─────────────────────────────────────────────────────

  snapshot(): ExpertTeamRuntimeState {
    return {
      members: [...this.roster.values()].map((entry) => ({
        name: entry.name,
        agentId: entry.agentId,
      })),
      pendingShutdowns: [...this.pendingShutdowns.values()].map((pending) => ({
        requestId: pending.requestId,
        member: pending.member,
        requestedAt: pending.requestedAt,
      })),
      journal: [...this.journal],
    };
  }

  async persist(): Promise<void> {
    if (this.disposed) return;
    await this.persistState(this.snapshot());
  }

  // ── send ────────────────────────────────────────────────────────────

  /** The single entry point used by the SendMessage tool. Validation errors
   *  are returned as `{ ok: false }`, never thrown. */
  async send(command: TeamSendCommand): Promise<TeamSendResult> {
    if (this.disposed) {
      return { ok: false, message: 'This expert-team runtime is no longer active.' };
    }
    if (command.from !== TEAM_LEAD_ID && !this.roster.has(command.from)) {
      return {
        ok: false,
        message: `Teammate "${command.from}" is no longer active on this team.`,
      };
    }
    switch (command.type) {
      case 'message':
        return this.sendDirect(command);
      case 'broadcast':
        return this.sendBroadcast(command);
      case 'shutdown_request':
        return this.sendShutdownRequest(command);
      case 'shutdown_response':
        return this.sendShutdownResponse(command);
    }
  }

  private resolveRecipient(command: TeamSendCommand): TeamMemberEntry | 'lead' | undefined {
    if (command.recipient === TEAM_LEAD_ID) return 'lead';
    return command.recipient === undefined ? undefined : this.roster.get(command.recipient);
  }

  private unknownRecipient(recipient: string): TeamSendResult {
    const known = [TEAM_LEAD_ID, ...this.memberNames()].join(', ');
    return {
      ok: false,
      message: `Unknown teammate "${recipient}". Known teammates: ${known}.`,
    };
  }

  private async sendDirect(command: TeamSendCommand): Promise<TeamSendResult> {
    const recipient = command.recipient?.trim();
    if (recipient === undefined || recipient.length === 0) {
      return { ok: false, message: 'recipient is required for type=message.' };
    }
    if (recipient === command.from) {
      return { ok: false, message: 'You cannot send a message to yourself.' };
    }
    const text = command.text?.trim();
    if (text === undefined || text.length === 0) {
      return { ok: false, message: 'message is required for type=message.' };
    }
    const target = this.resolveRecipient({ ...command, recipient });
    if (target === undefined) return this.unknownRecipient(recipient);
    await this.deliver(this.envelope(command, recipient, text));
    return { ok: true, message: `Message sent to ${recipient}.` };
  }

  private async sendBroadcast(command: TeamSendCommand): Promise<TeamSendResult> {
    const text = command.text?.trim();
    if (text === undefined || text.length === 0) {
      return { ok: false, message: 'message is required for type=broadcast.' };
    }
    const recipients = [
      ...(command.from === TEAM_LEAD_ID ? [] : [TEAM_LEAD_ID]),
      ...this.memberNames().filter((name) => name !== command.from),
    ];
    for (const recipient of recipients) {
      await this.deliver(this.envelope(command, recipient, text));
    }
    return {
      ok: true,
      message: `Broadcast sent to ${recipients.length} teammate${
        recipients.length === 1 ? '' : 's'
      }.`,
    };
  }

  private envelope(command: TeamSendCommand, to: string, text: string): TeamEnvelope {
    return {
      id: randomUUID(),
      type: command.type,
      from: command.from,
      to,
      summary: command.summary,
      text,
      requestId: command.requestId,
      approve: command.approve,
      sentAt: new Date().toISOString(),
    };
  }

  // ── delivery ────────────────────────────────────────────────────────

  private async deliver(envelope: TeamEnvelope, options: { append?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    try {
      if (envelope.to === TEAM_LEAD_ID) {
        await this.deliverToLead(envelope, options.append === true);
        return;
      }
      const entry = this.roster.get(envelope.to);
      if (entry === undefined) {
        // Recipient vanished (shut down between validation and delivery).
        return;
      }
      await this.deliverToMember(entry, envelope);
    } catch {
      if (this.disposed) return;
      // A wake that raced, or a lead that could not be resumed: keep the
      // envelope so a later completion callback / restart can replay it.
      this.journalPush(envelope);
      await this.persist();
    }
  }

  private async deliverToLead(envelope: TeamEnvelope, append: boolean): Promise<void> {
    const main = await this.host.ensureAgentResumed(this.mainAgentId);
    this.assertActive();
    const parts = [{ type: 'text' as const, text: renderTeammateMessage(envelope) }];
    if (append) {
      main.context.appendUserMessage(parts, TEAMMATE_PROMPT_ORIGIN);
    } else {
      main.turn.steer(parts, TEAMMATE_PROMPT_ORIGIN);
    }
  }

  private async deliverToMember(entry: TeamMemberEntry, envelope: TeamEnvelope): Promise<void> {
    const child = this.host.getReadyAgent(entry.agentId);
    if (entry.status !== 'idle' && child?.turn.hasActiveTurn === true) {
      child.turn.steer(
        [{ type: 'text', text: renderTeammateMessage(envelope) }],
        TEAMMATE_PROMPT_ORIGIN,
      );
      return;
    }
    if (entry.status !== 'idle') {
      // Spawned but the first turn has not activated yet (spawn/wake race):
      // hold the envelope; the member's completion callback replays it.
      this.journalPush(envelope);
      await this.persist();
      return;
    }
    await this.wakeMember(entry, envelope);
  }

  /** Wake an idle member with a fresh background turn carrying the message. */
  private async wakeMember(entry: TeamMemberEntry, envelope: TeamEnvelope): Promise<void> {
    const main = await this.host.ensureAgentResumed(this.mainAgentId);
    this.assertActive();
    const host = main.subagentHost;
    if (host === undefined) {
      throw new Error('Main agent has no subagent host to wake a teammate.');
    }
    const previousStatus = entry.status;
    entry.status = 'running';
    this.emitStatusChange();
    const controller = new AbortController();
    let handle: SubagentHandle | undefined;
    try {
      handle = await host.resume(entry.agentId, {
        parentToolCallId: `team-wake:${envelope.id}`,
        prompt: renderTeammateMessage(envelope),
        description: `teammate message: ${envelope.summary}`,
        runInBackground: true,
        signal: controller.signal,
        skipSummaryContinuation: true,
      });
      this.assertActive();
      this.registerMemberTask(
        main,
        entry,
        handle,
        controller,
        `teammate message: ${envelope.summary}`,
      );
    } catch (error) {
      controller.abort(error);
      void handle?.completion.catch(() => {});
      if (this.roster.get(entry.name) === entry) {
        entry.status = previousStatus;
        this.emitStatusChange();
      }
      if (this.disposed) this.detachMemberAgent(entry.agentId);
      throw error;
    }
  }

  /** See {@link TeamCollaboration.dispatchMember}. */
  async dispatchMember(
    name: string,
    handle: SubagentHandle,
    controller: AbortController,
    description: string,
  ): Promise<void> {
    let main: Agent | undefined;
    let entry: TeamMemberEntry | undefined;
    let removalLease: MemberRemovalLease | undefined;
    let taskId: string | undefined;
    try {
      this.assertActive();
      controller.signal.throwIfAborted();
      if (
        this.roster.has(name) ||
        this.retiringMembers.has(name) ||
        this.removingMembers.has(name)
      ) {
        throw new Error(`Teammate "${name}" is already on the team.`);
      }
      entry = { name, agentId: handle.agentId, status: 'running' };
      this.roster.set(name, entry);
      main = await this.host.ensureAgentResumed(this.mainAgentId);
      this.assertActive();
      controller.signal.throwIfAborted();
      taskId = this.registerMemberTask(main, entry, handle, controller, description);
      await this.persist();
      this.assertActive();
      controller.signal.throwIfAborted();
      if (this.roster.get(name) !== entry) {
        throw new Error(`Teammate "${name}" failed before its dispatch committed.`);
      }
      this.emitStatusChange();
    } catch (error) {
      if (entry !== undefined && this.roster.get(name) === entry) {
        this.roster.delete(name);
        removalLease = { entry, token: Symbol(name) };
        this.removingMembers.set(name, removalLease);
        this.emitStatusChange();
      }
      // Revoke attachment authority before the asynchronously configuring
      // child can observe it, then clear an attachment that already landed.
      this.releaseMemberReservation(name);
      if (entry !== undefined) this.clearPendingForMember(name);
      controller.abort(error);
      void handle.completion.catch(() => {});
      if (main !== undefined && taskId !== undefined) {
        await main.background.stop(taskId, 'Expert-team member dispatch failed').catch(() => {});
      }
      if (entry !== undefined && this.memberTasks.get(name)?.entry === entry) {
        this.memberTasks.delete(name);
      }
      this.detachMemberAgent(handle.agentId);
      if (removalLease !== undefined) {
        await this.releaseGateWhenDurable('removing', removalLease).catch(() => {});
      }
      throw error;
    }
  }

  /**
   * Register a member's running turn as a detached background task so it joins
   * the timeout / TaskStop / session-close machinery, suppress its terminal
   * notification (the member reports via SendMessage, not the auto summary),
   * and flip the member back to idle when it settles.
   */
  private registerMemberTask(
    main: Agent,
    entry: TeamMemberEntry,
    handle: SubagentHandle,
    controller: AbortController,
    description: string,
  ): string {
    const timeoutMs = resolveSubagentTimeoutMs(main.kimiConfig?.subagent?.timeoutMs);
    let taskId: string;
    try {
      taskId = main.background.registerTask(
        new AgentBackgroundTask(handle, description, main.subagentHost!, controller),
        {
          detached: true,
          timeoutMs: timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
        },
      );
    } catch (error) {
      void handle.completion.catch(() => {});
      throw error;
    }
    this.memberTasks.set(entry.name, { entry, taskId });
    void handle.completion.then(
      () => {
        this.onMemberSettled(entry, taskId);
      },
      () => {
        this.onMemberSettled(entry, taskId, true);
      },
    );
    void main.background.waitUntilTerminal(taskId).then(
      (info) => {
        if (info !== undefined) {
          this.onMemberSettled(entry, taskId, info.status !== 'completed');
        }
      },
      () => {},
    );
    // The authoritative report travels over SendMessage; the auto task
    // notification would re-feed the summary to the lead redundantly.
    void main.background.suppressTerminalNotification(taskId);
    return taskId;
  }

  private onMemberSettled(entry: TeamMemberEntry, taskId: string, failed = false): void {
    const currentTask = this.memberTasks.get(entry.name);
    if (currentTask?.entry !== entry || currentTask.taskId !== taskId) return;
    this.memberTasks.delete(entry.name);
    if (this.disposed) return;
    if (this.removingMembers.get(entry.name)?.entry === entry) return;
    const retirementLease = this.retiringMembers.get(entry.name);
    if (retirementLease?.entry === entry) {
      this.detachMemberAgent(entry.agentId);
      void this.releaseGateWhenDurable('retiring', retirementLease).catch(() => {});
      return;
    }
    if (this.roster.get(entry.name) !== entry) return;
    if (failed && !this.isUsableMember(entry)) {
      void this.removeUnusableMember(entry).catch(() => {});
      return;
    }
    entry.status = 'idle';
    this.emitStatusChange();
    if (failed) {
      void this.notifyLeadMemberFailed(entry).catch(() => {});
    }
    void this.replayJournal().catch(() => {});
  }

  private isUsableMember(entry: TeamMemberEntry): boolean {
    const child = this.host.getReadyAgent(entry.agentId);
    if (
      child?.config.profileName === entry.name &&
      child.config.systemPrompt !== '' &&
      child.team === this &&
      child.teamSelfName === entry.name
    ) {
      try {
        return child.tools.loopTools.some((tool) => tool.name === 'SendMessage');
      } catch {
        return false;
      }
    }
    return false;
  }

  private async removeUnusableMember(entry: TeamMemberEntry): Promise<void> {
    const removalLease = await this.removeMember(entry.name, true);
    await this.finishRemovalWithNotice(
      removalLease,
      this.envelope(
        { type: 'message', from: entry.name, summary: `Teammate ${entry.name} failed to start` },
        TEAM_LEAD_ID,
        `Teammate "${entry.name}" failed before its expert-team profile finished loading and was removed. Dispatch it again to retry.`,
      ),
    );
  }

  private async notifyLeadMemberFailed(entry: TeamMemberEntry): Promise<void> {
    try {
      await this.deliver(
        this.envelope(
          { type: 'message', from: entry.name, summary: `Teammate ${entry.name} failed` },
          TEAM_LEAD_ID,
          `Teammate "${entry.name}" stopped before delivering a result. Its context is preserved; you may follow up with SendMessage or reassign the work.`,
        ),
      );
    } catch {
      // Best effort — the failure is also visible via the background task.
    }
  }

  // ── journal ─────────────────────────────────────────────────────────

  private journalPush(envelope: TeamEnvelope): void {
    if (this.journal.some((pending) => pending.id === envelope.id)) return;
    this.journal.push(envelope);
    while (this.journal.length > JOURNAL_CAPACITY) {
      this.journal.shift();
    }
  }

  /** Re-attempt every buffered envelope. When `append`, lead-bound envelopes
   *  are appended to history rather than steering a new turn (restore path). */
  async replayJournal(options: { append?: boolean } = {}): Promise<void> {
    if (this.disposed || this.journal.length === 0) return;
    const pending = this.journal.splice(0);
    for (const envelope of pending) {
      await this.deliver(envelope, options);
    }
    await this.persist();
  }

  restoreState(state: ExpertTeamRuntimeState): void {
    for (const pending of this.pendingShutdowns.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
    }
    this.pendingShutdowns.clear();
    this.roster.clear();
    this.memberReservations.clear();
    this.retiringMembers.clear();
    this.removingMembers.clear();
    this.memberTasks.clear();
    for (const member of state.members) {
      // A restarted process can hold no live turn: every member comes back idle.
      this.roster.set(member.name, { name: member.name, agentId: member.agentId, status: 'idle' });
    }
    this.journal.splice(0, this.journal.length, ...state.journal);
    // Pending shutdowns cannot survive a restart handshake; the restore path
    // (Session.restoreExpertTeamMode) resolves them by timeout semantics.
  }

  dropMissingMembers(isValid: (name: string, agentId: string) => boolean): void {
    for (const [name, entry] of this.roster) {
      if (!isValid(name, entry.agentId)) this.roster.delete(name);
    }
  }

  // ── shutdown handshake ──────────────────────────────────────────────

  private async sendShutdownRequest(command: TeamSendCommand): Promise<TeamSendResult> {
    if (command.from !== TEAM_LEAD_ID) {
      return { ok: false, message: 'Only the team-lead may send a shutdown_request.' };
    }
    const recipient = command.recipient?.trim();
    if (recipient === undefined || recipient.length === 0) {
      return { ok: false, message: 'recipient is required for type=shutdown_request.' };
    }
    const entry = this.roster.get(recipient);
    if (entry === undefined) return this.unknownRecipient(recipient);
    const existing = this.pendingShutdownForMember(recipient);
    if (existing !== undefined) {
      return {
        ok: false,
        message: `Shutdown request already pending for ${recipient} (request_id: ${existing.requestId}).`,
      };
    }

    const requestId = randomUUID();
    const timer = setTimeout(() => {
      void this.forceStopMember(recipient, requestId).catch(() => {});
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref?.();
    const pending: PendingShutdown = {
      requestId,
      member: recipient,
      requestedAt: new Date().toISOString(),
      timer,
    };
    this.pendingShutdowns.set(requestId, pending);

    // Commit the correlation id before the member can observe it. Otherwise a
    // successful steer followed by a failed metadata write would leave the
    // member holding a request id that this runtime no longer recognizes.
    try {
      await this.persist();
      this.assertActive();
    } catch (error) {
      if (this.pendingShutdowns.get(requestId) === pending) {
        this.clearPending(pending);
      }
      await this.persistEventually(Symbol(`shutdown-request-rollback:${requestId}`));
      throw error;
    }

    const text = command.text?.trim();
    const envelope = this.envelope(
      command,
      recipient,
      `${text ?? 'Please wrap up.'}\n\nShutdown requested (request_id: ${requestId}). Send your complete final results to team-lead first, then reply with SendMessage(type="shutdown_response", request_id="${requestId}", approve=true).`,
    );
    try {
      await this.deliver(envelope);
    } catch {
      // `deliver` journals before it throws. The request itself is already
      // durable, so keep the pending handshake and make the queued delivery
      // durable instead of invalidating an id the member may have observed.
      await this.persistEventually(Symbol(`shutdown-request-delivery:${requestId}`));
    }
    return { ok: true, message: `Shutdown request sent to ${recipient} (request_id: ${requestId}).` };
  }

  private async sendShutdownResponse(command: TeamSendCommand): Promise<TeamSendResult> {
    const requestId = command.requestId?.trim();
    if (requestId === undefined || requestId.length === 0) {
      return { ok: false, message: 'request_id is required for type=shutdown_response.' };
    }
    if (command.approve === undefined) {
      return { ok: false, message: 'approve is required for type=shutdown_response.' };
    }
    const pending = this.pendingShutdowns.get(requestId);
    if (pending === undefined) {
      return { ok: false, message: `Unknown shutdown request_id "${requestId}".` };
    }
    if (command.from !== pending.member) {
      return {
        ok: false,
        message: `Shutdown request_id "${requestId}" belongs to ${pending.member}, not ${command.from}.`,
      };
    }
    this.clearPending(pending);

    if (command.approve) {
      const entry = this.roster.get(pending.member);
      let removalLease: MemberRemovalLease | undefined;
      if (entry !== undefined && this.memberTasks.get(pending.member)?.entry === entry) {
        this.roster.delete(pending.member);
        const retirementLease = {
          entry,
          token: Symbol(pending.member),
        };
        this.retiringMembers.set(pending.member, retirementLease);
        this.emitStatusChange();
      } else {
        removalLease = await this.removeMember(pending.member, true);
      }
      const notice = this.envelope(
        {
          type: 'message',
          from: pending.member,
          summary: `${pending.member} approved shutdown`,
        },
        TEAM_LEAD_ID,
        command.text?.trim() ??
          `Teammate "${pending.member}" approved shutdown and is finishing its current turn.`,
      );
      if (removalLease !== undefined) {
        await this.finishRemovalWithNotice(removalLease, notice);
      } else {
        try {
          await this.deliver(notice);
          await this.persist();
        } catch (error) {
          await this.persistEventually(Symbol(`shutdown-approve:${requestId}`));
          throw error;
        }
      }
      return {
        ok: true,
        message: `Shutdown approved; ${pending.member} will leave when its current turn finishes.`,
      };
    }

    try {
      await this.deliver(
        this.envelope(
          { type: 'message', from: pending.member, summary: `${pending.member} declined shutdown` },
          TEAM_LEAD_ID,
          command.text?.trim() ?? `Teammate "${pending.member}" declined to shut down.`,
        ),
      );
      await this.persist();
    } catch (error) {
      await this.persistEventually(Symbol(`shutdown-decline:${requestId}`));
      throw error;
    }
    return { ok: true, message: `Shutdown declined by ${pending.member}.` };
  }

  private async forceStopMember(member: string, requestId: string): Promise<void> {
    if (this.disposed) return;
    const pending = this.pendingShutdowns.get(requestId);
    if (pending === undefined || pending.member !== member) return;
    this.clearPending(pending);
    const removalLease = await this.removeMember(member, true);
    await this.finishRemovalWithNotice(
      removalLease,
      this.envelope(
        { type: 'message', from: member, summary: 'Teammate force-stopped after shutdown timeout' },
        TEAM_LEAD_ID,
        `Teammate "${member}" did not respond to the shutdown request within ${
          SHUTDOWN_TIMEOUT_MS / 1000
        }s and was force-stopped.`,
      ),
    );
  }

  private async removeMember(
    member: string,
    holdGate = false,
  ): Promise<MemberRemovalLease | undefined> {
    if (this.removingMembers.has(member)) return undefined;
    const entry = this.roster.get(member) ?? this.retiringMembers.get(member)?.entry;
    this.roster.delete(member);
    this.memberReservations.delete(member);
    this.retiringMembers.delete(member);
    if (entry === undefined) return;
    this.emitStatusChange();
    const removalLease = { entry, token: Symbol(member) };
    this.removingMembers.set(member, removalLease);
    let completed = false;
    try {
      // Abort the member's active background turn, if any.
      const main = this.host.getReadyAgent(this.mainAgentId);
      if (main !== undefined) {
        const taskIds = main.background
          .list(true)
          .filter((task) => task.kind === 'agent' && task.agentId === entry.agentId)
          .map((task) => task.taskId);
        await Promise.all(
          taskIds.map((taskId) =>
            main.background.stop(taskId, 'Expert team member shut down').catch(() => undefined),
          ),
        );
      }
      if (this.memberTasks.get(member)?.entry === entry) {
        this.memberTasks.delete(member);
      }
      this.detachMemberAgent(entry.agentId);
      completed = true;
      return removalLease;
    } finally {
      if (!holdGate || !completed) this.finishRemovingMember(removalLease);
    }
  }

  private finishRemovingMember(removalLease: MemberRemovalLease | undefined): void {
    if (
      removalLease !== undefined &&
      this.removingMembers.get(removalLease.entry.name)?.token === removalLease.token
    ) {
      this.removingMembers.delete(removalLease.entry.name);
    }
  }

  private async finishRemovalWithNotice(
    removalLease: MemberRemovalLease | undefined,
    notice: TeamEnvelope,
  ): Promise<void> {
    try {
      await this.deliver(notice);
    } catch (error) {
      if (removalLease !== undefined) {
        void this.releaseGateWhenDurable('removing', removalLease).catch(() => {});
      }
      throw error;
    }
    if (removalLease !== undefined) {
      await this.releaseGateWhenDurable('removing', removalLease);
    } else {
      await this.persist();
    }
  }

  /**
   * A member is allowed to rejoin only after its absence and any queued mail
   * are durable. Each retry belongs to one lease token, so an older operation
   * can never release a newer removal gate for the same member name.
   */
  private async releaseGateWhenDurable(
    gate: 'retiring' | 'removing',
    lease: MemberRemovalLease,
  ): Promise<void> {
    if (this.disposed || !this.ownsGate(gate, lease)) return;
    try {
      await this.persist();
      await this.replayJournal();
    } catch (error) {
      this.scheduleRetry(lease.token, () => this.releaseGateWhenDurable(gate, lease));
      throw error;
    }
    if (!this.ownsGate(gate, lease)) return;
    this.clearRetry(lease.token);
    if (gate === 'retiring') {
      this.retiringMembers.delete(lease.entry.name);
    } else {
      this.finishRemovingMember(lease);
    }
  }

  private ownsGate(gate: 'retiring' | 'removing', lease: MemberRemovalLease): boolean {
    const current =
      gate === 'retiring'
        ? this.retiringMembers.get(lease.entry.name)
        : this.removingMembers.get(lease.entry.name);
    return current?.token === lease.token;
  }

  private scheduleRetry(token: symbol, retry: () => Promise<void>): void {
    if (this.disposed || this.retryTimers.has(token)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(token);
      void retry().catch(() => {});
    }, DURABILITY_RETRY_MS);
    timer.unref?.();
    this.retryTimers.set(token, timer);
  }

  private clearRetry(token: symbol): void {
    const timer = this.retryTimers.get(token);
    if (timer !== undefined) clearTimeout(timer);
    this.retryTimers.delete(token);
  }

  private async persistEventually(token: symbol): Promise<void> {
    if (this.disposed) return;
    try {
      await this.persist();
      this.clearRetry(token);
    } catch {
      this.scheduleRetry(token, () => this.persistEventually(token));
    }
  }

  private pendingShutdownForMember(member: string): PendingShutdown | undefined {
    for (const pending of this.pendingShutdowns.values()) {
      if (pending.member === member) return pending;
    }
    return undefined;
  }

  private clearPendingForMember(member: string): void {
    for (const pending of this.pendingShutdowns.values()) {
      if (pending.member === member) this.clearPending(pending);
    }
  }

  private detachMemberAgent(agentId: string): void {
    const child = this.host.getReadyAgent(agentId);
    if (child === undefined) return;
    child.team = undefined;
    child.teamSelfName = undefined;
    try {
      if (child.config.hasProvider) {
        child.tools.initializeBuiltinTools();
      }
    } catch {
      // The cleared handles are authoritative. A stale SendMessage instance
      // still cannot send because TeamRuntime validates the sender roster.
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('This expert-team runtime is no longer active.');
    }
  }

  private emitStatusChange(): void {
    if (this.disposed) return;
    try {
      this.onStatusChange?.();
    } catch {
      // UI/event projection is observational and must not break team work.
    }
  }

  private clearPending(pending: PendingShutdown): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.pendingShutdowns.delete(pending.requestId);
  }

  /** Restore path: resolve every restored pending shutdown by force-stop
   *  semantics. The notice is journaled (not steered) so the restore flow can
   *  append it to history without auto-launching a lead turn. */
  async resolveRestoredShutdownsByTimeout(members: readonly string[]): Promise<void> {
    for (const member of members) {
      await this.removeMember(member);
      this.journalPush(
        this.envelope(
          {
            type: 'message',
            from: member,
            summary: 'Teammate force-stopped after shutdown timeout',
          },
          TEAM_LEAD_ID,
          `Teammate "${member}" had a pending shutdown request when the session was interrupted and was force-stopped on restore.`,
        ),
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingShutdowns.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
    }
    this.pendingShutdowns.clear();
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.memberReservations.clear();
    this.retiringMembers.clear();
    this.removingMembers.clear();
    this.memberTasks.clear();
    this.roster.clear();
    this.journal.splice(0);
  }
}
