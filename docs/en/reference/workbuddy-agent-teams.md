# WorkBuddy Agent Teams implementation (multi-round chat and team state)

This note reverse-engineers how **WorkBuddy 5.3.5** implements durable **team state** and **multi-round teammate chat**. The core lives in `app.asar.unpacked/cli/dist/codebuddy.js` (agent-cli) and `cli/product.json` (`team-lead-prompt` / `team-sys-prompt`). Expert Teams only force-enable this runtime when a team expert is activated.

> Third-party code changes across versions. Upstream docs mention `~/.codebuddy`; on this machine WorkBuddy’s home is `~/.workbuddy` (`PathUtils.getHomeDir()`). Prefer observed runtime behavior.

For the expert-pack / summon product layer, see [WorkBuddy Experts and Expert Teams](./workbuddy-experts.md).

## Bottom line

Multi-round collaboration is not “subagent tool return value”. It is:

1. **On-disk team objects** (`teams/{name}/config.json` + `inboxes/` + `tasks/`)
2. **Async mailboxes** (`TeamMailbox`: append JSON inbox → poll unread → inject into session)
3. **Independent in-process member sessions** (`TeamMember` + `InProcessTeammateBackend`, with `respawn` / wake)
4. **Role prompts** (`TeamContextInterceptor` injecting lead / member rules)

Expert-pack SOPs choose *who* and *which phase*; Agent Teams owns the multi-round mechanics.

## Component map

| Symbol (from bundle) | Role |
| --- | --- |
| `TeamManager` | Create/delete team, member registry; `isEnabled()` reads `CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS`; holds `teamConfig` |
| `TeamMailbox` | Inbox R/W, broadcast, unread, **default 2s polling** |
| `TeamMember` | Per-member lifecycle: `spawn` / `respawn` / mailbox polling / forceKill |
| `TeamInboxDispatchService` | Bridges inbox traffic into the main session / ACP |
| `TeamContextInterceptor` | Injects `team-lead-prompt` / `team-sys-prompt` (`system-reminder data-role="team-context"`) |
| `ShutdownCoordinator` | Correlates `shutdown_request` ↔ `shutdown_response`, timeout force-kill |
| `TeamCreateTool` / `TeamDeleteTool` / `SendMessageTool` / `AgentTool` / `TaskStopTool` | Model-facing tools |
| `formatTeammateMessage` | Wraps inbox entries as `<teammate-message teammate_id="…" summary="…">` |

Gate:

```js
// TeamManager.isEnabled() (equivalent)
return process.env.CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS !== "0";
```

Desktop expert activation forces this env to `"1"` (see `AgentTeamsEnvResolver` in the experts doc).

## Team state: on-disk model

### Layout

```text
{home}/teams/{teamName}/
├── config.json                 # metadata + member table
├── inboxes/
│   ├── team-lead.json          # lead inbox (JSON array)
│   └── {memberName}.json       # member inbox
└── endpoints/                  # optional member endpoints

{home}/tasks/{teamName}/        # shared task list (1:1 with team)
```

`PathUtils` highlights:

- `getTeamsDir()` → `{home}/teams`
- `getTeamConfigPath(name)` → `…/config.json`
- `getTeamInboxPath(team, member)` → `…/inboxes/{member}.json`
- `getTeamTasksDir(name)` → `{home}/tasks/{name}`

### `config.json` shape (observed)

```json
{
  "name": "software-shopping-mvp",
  "description": "…",
  "createdAt": 1785053274720,
  "leadAgentId": "team-lead@software-shopping-mvp",
  "leadSessionId": "<lead-session-uuid>",
  "members": [
    {
      "agentId": "team-lead@software-shopping-mvp",
      "name": "team-lead",
      "agentType": "team-lead",
      "joinedAt": 1785053274720,
      "tmuxPaneId": "",
      "cwd": "…",
      "subscriptions": []
    },
    {
      "agentId": "software-architect@software-shopping-mvp",
      "name": "software-architect",
      "role": "…",
      "agentType": "software-architect",
      "prompt": "…",
      "color": "blue",
      "joinedAt": 1785053287575,
      "tmuxPaneId": "in-process",
      "backendType": "in-process",
      "subscriptions": ["*"]
    }
  ]
}
```

Conventions:

- Member id: `{name}@{teamName}`
- `team-lead` is reserved for the lead
- Name clashes are renamed via `teamSpawnChain` to `name-2`, `name-3`, …

### `TeamManager.createTeam`

Observed flow:

1. Already in a team → error (delete first)
2. Directory exists and not auto-team → `resolveUniqueTeamName`
3. `mkdir` inboxes + tasks
4. Write lead-only `teamConfig`, `writeInbox(team, "team-lead", [])`, `saveConfig()`
5. Track in `sessionCreatedTeams`

`deleteTeam` cleans worktrees when possible, then `rm -rf` team + tasks dirs. Tooling fails if active members remain (forces shutdown protocol).

## Multi-round chat: mailbox path

### Write (`SendMessage` / `TeamMailbox.send`)

`SendMessageTool` types (zod enum):

| `type` | Meaning |
| --- | --- |
| `message` | DM (`recipient` required) |
| `broadcast` | All members except sender |
| `shutdown_request` | Ask member to shut down |
| `shutdown_response` | Member reply (`request_id` + `approve`) |
| `plan_approval_response` | Plan approval |

Execution notes:

- Disabled when `TeamManager.isEnabled()` is false
- Not in a team → `"Not in a team…"`
- `TeamMailbox.send(...)`: **read JSON array → push → write back** (`read: false`)

`broadcast` loads `config.json` members and `send`s to everyone except the sender.

### Read (polling)

`TeamMailbox.startPolling(team, member, onUnread, intervalMs = 2000)`:

1. `getUnread` (`read !== true`)
2. Invoke callback
3. `markAllAsRead`

`TeamMember.spawn` starts `startMailboxPolling()` when `backendType === "in-process"`.
The lead side uses `startTeamLeadInboxPolling(teamName, session)`.

### Inject into the lead (the multi-round hinge)

`startTeamLeadInboxPolling` (observed):

```text
Every 2s, fetch team-lead unread
        │
        ├─ JSON.type === shutdown_response
        │     → ShutdownCoordinator.fulfillResponse
        │     → remove from TeamMemberRegistry if approved
        │
        └─ other messages
              → formatTeammateMessage(from, summary, text)
              → user-role messages (providerData.teammateMessage)
              → if main agent busy: enqueue (MessageQueue / RichMessageQueue)
              → if idle: AgentService.run(defaultAgent, messages) wake-up turn
```

Teammate replies appear as **pseudo-user messages** (`<teammate-message>`; docs also mention `<agent-notification>`), not as a synchronous `Agent` tool return. The lead can keep chatting with the user and still be woken by mailbox events — that is multi-round.

Members likewise wake / `respawn` on new inbox mail (often resuming `originalTaskId`), so completed workers can be continued.

### Initial task wrapping

Unless `skipPromptWrapping`, the spawn prompt is wrapped as:

```text
<teammate-message teammate_id="team-lead" summary="Initial task assignment for {name}">
{original prompt}
</teammate-message>
```

Same channel shape as later `SendMessage` traffic.

## Member lifecycle

```text
TeamCreate
   → AgentTool.spawnTeammate (teamSpawnChain serializes naming)
        → TeamManager.addMember
        → new TeamMember → spawn(InProcessTeammateBackend)
        → startMailboxPolling + TeammateIdleTracker.register
   → (async work; lead may brief the user and stop)
   → member SendMessage → team-lead inbox → poll inject / wake
   → lead may SendMessage again (continue) or Agent again (spawn fresh)
   → ShutdownCoordinator: shutdown_request → shutdown_response
   → TeamDelete
```

`AgentTool.spawnTeammate`:

- No active team → `"No active team found. Create a team first using TeamCreate."`
- Spawns chain on `teamSpawnChain = teamSpawnChain.then(…)` — **serializes registration/naming only**; multiple `Agent` calls in one model message are still allowed (queued on the Promise chain)
- On failure, `removeMember` rolls back

Non-expert background paths may `autoCreateTeam("_auto_…")` and start lead inbox polling automatically.

## Prompt injection (`TeamContextInterceptor`)

| Role | Template | When (summary) |
| --- | --- | --- |
| Lead | `team-lead-prompt` | In a team; roster change or first/continue turn; avoid duplicate injection |
| Member | `team-sys-prompt` | Has `teamContext`; variables `teamName` / `memberName` / `teamMembers` |

Wrapped as:

```xml
<system-reminder data-role="team-context">
…
</system-reminder>
```

Template semantics (complements code):

- Lead: talk only to the user; worker results are internal signals; use `Agent` / `SendMessage` / `TaskStop`; parallel `Agent` calls in one message are OK
- Member: plain text is **invisible** to the lead; must `SendMessage`; send full results to `team-lead` before completion; on `shutdown_request`, deliver results then `shutdown_response`

Expert-pack SOPs often tighten communication to a lead-centered star; the generic `team-sys-prompt` still allows peer DM / `broadcast`. Distinguish **Agent Teams capability** from **expert-pack policy**.

## UI / ACP team state

Session updates use ACP `session_info_update` with `_meta["codebuddy.ai/teamUpdate"]`, e.g.:

- `team_created` / `team_deleted`
- `member_status_change` (`teamName`, `isAutoTeam`, `members[]`)

The desktop UI drives the status bar (`●` working / `✓` done, …) and `@member` completion. User-facing docs ship at `cli/dist/web-ui/docs/en/cli/agent-teams.md`.

## Versus ordinary subagents

| | Subagent (sync `Agent` result) | Agent Teams |
| --- | --- | --- |
| Return path | Tool return | Mailbox → pseudo-user message |
| Lifetime | Ends with the call | Lives for the team; wake / continue |
| Team object | None | `config` + `inboxes` + `tasks` |
| Parallelism | Scheduler-dependent | Multiple `Agent` calls + async members |
| User interrupt | Often blocked on the tool | Lead can chat while notifications arrive; `@member` relay |

## Current Kimi Code alignment

`packages/agent-core/src/expert-team` has moved beyond remapping ordinary `Agent` return values into a working expert-team runtime. It implements equivalent semantics with Kimi Code sessions, agent records, and background tasks instead of copying WorkBuddy’s directory layout.

### Implemented

- **Activation path**: The experimental flag, plugin-declared lead/member profiles, RPC, Node SDK, and the interactive Kimi Code CLI `/experts` entry point are connected.
- **Asynchronous results**: `Agent` returns only a dispatch receipt. Members report through `SendMessage`, and the runtime injects the result into the lead as a pseudo-user `<teammate-message>`.
- **Multi-round member lifecycle**: Each member keeps independent agent context. Messages steer a running member or resume an idle one. Messages that cannot be delivered immediately enter a `SessionMeta` journal and replay after restore.
- **Collaboration semantics**: Direct messages, broadcast, initial-task wrapping, and atomic reservation of each fixed member are implemented, preventing duplicate concurrent dispatch.
- **Shutdown protocol**: Correlated `shutdown_request` / `shutdown_response` messages use `request_id`, validate the sender, reject duplicate requests, force-stop on timeout, and prevent team deactivation until the roster is empty.
- **Restore and cleanup**: Members restore as idle. Invalid roster entries, including roles removed from the current plugin, are dropped. Restored members regain their team handle and `SendMessage` tool. A closed, deactivated, or replaced runtime cannot keep sending messages or overwrite newer state.
- **Product status surface**: Core and the Node SDK expose a complete declared-member status snapshot and push `not_started` / `idle` / `running` changes through `expert_team.updated`. The TUI footer shows running/declared member counts, while `/experts status` displays the complete roster.

### Remaining gaps

- **Storage model**: There is no `teams/{name}/config.json`, independent inbox, or shared tasks directory. Agent records persist member context; `SessionMeta` stores only the roster, pending shutdowns, and undelivered journal. A pending shutdown is force-stopped after restart instead of resuming the original handshake.
- **Dynamic teams**: Product APIs and `/experts` activate a fixed plugin-declared topology. There are no model-visible `TeamCreate` / `TeamDelete` tools, auto-team mode, dynamic naming, or multiple instances of one role.
- **Shared tasks and approval**: WorkBuddy-style shared team tasks and `plan_approval_response` are not implemented.
- **Interactive completion**: WorkBuddy-style `@member` completion is not implemented. Kimi Code uses its own `expert_team.updated` contract instead of copying the `team_created` / `member_status_change` event names.
- **Engine scope**: This adapter is on the legacy `agent-core` path used by the interactive Kimi Code CLI. The `agent-core-v2` / kap-server entry points need to converge on the same contract separately.

`AgentSwarm` remains closer to one parallel phase, not the full Teams product.

## Local reverse-engineering entry points

| Path | Content |
| --- | --- |
| `…/cli/dist/codebuddy.js` | `TeamManager` / `TeamMailbox` / `TeamMember` / `TeamContextInterceptor` / tools |
| `…/cli/product.json` | `team-lead-prompt`, `team-sys-prompt`, Team tool blurbs |
| `…/cli/dist/web-ui/docs/en/cli/agent-teams.md` | Upstream user guide |
| `…/resources/builtin-skills/expert-manager/references/team-spec.md` | Expert-team SOP / hard rules |
| `~/.workbuddy/teams/`, `~/.workbuddy/tasks/` | Runtime on-disk observation |
