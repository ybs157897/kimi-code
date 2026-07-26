# WorkBuddy experts and expert teams

This page documents how Tencent **WorkBuddy** (`WorkBuddy.app` on macOS, bundle id `com.workbuddy.workbuddy`) implements **Experts** and **Expert Teams**, for comparison when aligning Kimi Code agents, subagents, and swarm collaboration.

> Findings come from a static reverse look at a local install (`app.asar` / `app.asar.unpacked`) and user data under `~/.workbuddy`, observed at version **5.3.5**. Behavior can change across releases; treat the installed build as source of truth.

## Concept layers

WorkBuddy splits “ability to get work done” into three product layers:

| Layer | Product name | Nature | When to use |
| --- | --- | --- | --- |
| Skill | Skill | Loadable capability pack (docs + scripts + tool constraints) | Need a concrete capability |
| Expert (`expertType: "agent"`) | Expert | Single role-shaped agent: persona + methodology + tool chain | One-domain questions |
| Expert Team (`expertType: "team"`) | Expert Team | Lead + members + baked-in SOP | Cross-role, multi-phase work |

An Expert Team is **not** a separate scheduler binary. It is:

1. A **CodeBuddy plugin** with `expertType: "team"`
2. The **Agent Teams** runtime forced on for that session (`TeamCreate` / `Agent` / `SendMessage` / `TeamDelete`)
3. **Collaboration rules and workflows** written in the lead MD / skills / rules

```text
Expert Center (UI / manifest)
        │
        ▼
ExpertService / ExpertPluginService (fetch zip, parse, activate)
        │
        ▼
Session binds plugin + agentName (lead or single expert)
        │
        ├─ expertType=agent → normal agent session + Role Override
        └─ expertType=team  → CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS=1
                              + X-Expert-Team-Task
                              + TeamCreate / Agent / SendMessage …
```

---

## Install and on-disk locations

| Path | Contents |
| --- | --- |
| `/Applications/WorkBuddy.app` | Electron desktop app |
| `…/Resources/app.asar` | Main / renderer bundles |
| `…/Resources/app.asar.unpacked/cli/` | agent-cli (`codebuddy.js`) and `product.json` prompt templates |
| `…/Resources/app.asar.unpacked/resources/builtin-skills/expert-manager/` | Expert-pack lifecycle skill (init / validate / register / package) |
| `…/Resources/app.asar.unpacked/resources/templates/workbuddy-expert-prompt.tpl` | Expert session system-prompt skeleton (includes Role Override) |
| `~/.workbuddy/app/cache/experts/manifest.json` | Expert Center catalog cache |
| `~/.workbuddy/plugins/marketplaces/` | Installed marketplace plugins (including expert packs) |
| `~/.workbuddy/plugins/marketplaces/my-experts/plugins/` | Custom “My Experts” packs (`WORKBUDDY_CONFIG_DIR` sets the root) |
| `~/.workbuddy/sessions/`, `~/.workbuddy/workbuddy.db` | Session and automation state |

One local catalog snapshot held hundreds of expert entries, including dozens of `expertType: "team"` teams (software delivery, trading analysis, content production, and similar).

---

## Expert pack layout

An expert is a **plugin package**, not a distinct process type. The bundled `expert-manager` skill (v2.0) defines the format.

### Directory skeleton

```text
{expert-name}/
├── .codebuddy-plugin/plugin.json   # metadata + expertType + agents/skills
├── agents/
│   ├── {agent}.md                  # agent type: single MD
│   ├── {team}-team-lead.md         # team type: lead (never a bare team-lead.md)
│   └── {member}.md                 # team type: members
├── skills/…                        # optional
├── rules/…                         # optional (often alwaysApply scene rules)
├── avatars/…
└── settings.json                   # team required: { "agent": "{team}-team-lead" }
```

Generator commands (scripts inside the skill):

```sh
python3 scripts/init_expert.py <expert-name> --type agent|team \
  --path "$WORKBUDDY_CONFIG_DIR/plugins/marketplaces/my-experts/plugins"
python3 scripts/validate_expert.py <expert-dir>
python3 scripts/register_expert.py <expert-dir> --session-id "$CODEBUDDY_SESSION_ID"
python3 scripts/package_expert.py <expert-dir>
```

### Key `plugin.json` fields

| Field | Agent type | Team type |
| --- | --- | --- |
| `expertType` | `"agent"` | `"team"` |
| `agentName` | Main agent MD basename (no `.md`) | `{team}-team-lead` |
| `agents` | Path array | Lead + every member MD path |
| `teamInfo` | — | `{ leadAgent, memberAgents[] }` (`memberAgents` **excludes** the lead) |
| `members[]` | Optional for display | Required; includes lead with `role` `"lead"` / `"member"` |
| `displayName` / `profession` / `displayDescription` | Card copy; Chinese description ~40–50 chars | `profession` must match `displayName` |
| `tags` / `quickPrompts` | Exactly three each; first quick prompt = `defaultInitPrompt` | Same |
| `categoryId` | Industry category (e.g. `02-Engineering`) | Same |
| `plugin` | Same as `name` | Same |

### Agent MD

- Frontmatter carries `name` / `description` / display fields; the spec tells authors **not** to declare `tools` in frontmatter.
- Body usually covers role, capabilities, workflow, output contract, and constraints.
- Member MDs must require finishing via `SendMessage` back to the lead. When spawning, `Agent` `name` and `subagent_type` use the **agent ID** (MD basename), never the Chinese display nickname.

### Lead MD (team)

Lead templates are expected to include:

1. Member table (agent ID ↔ display name ↔ duty)
2. Standard SOP (phases; parallel vs serial)
3. **Collaboration hard rules** (below)
4. Preset workflows (trigger, phase graph, I/O dependencies)
5. Direct-dispatch table (simple asks go to one member; complex asks use a workflow)

Hard rules (from `team-spec.md` / lead body — model constraints, not a separate runtime):

1. **Create the team**: only the lead may `TeamCreate`
2. **Dispatch members**: spawn per SOP; the lead must not ghost-write member deliverables
3. **Relay messages**: cross-member information flows through the lead (product-layer constraint in expert packs)
4. **Member output is authoritative**: accept specialist conclusions only after that member produces them

Red lines include skipping `TeamCreate` and faking multi-role output, jumping phases early, and spawning the lead as a teammate.

::: info Note
The generic runtime `team-sys-prompt` allows peer `SendMessage` / `broadcast` among teammates. Expert-team packs tighten this to a star topology via the lead MD and skill SOP. When aligning implementations, separate **Agent Teams primitives** from **expert-pack policy**.
:::

---

## Summon and session activation

### Services and entry points

Important symbols in the main process (`main/initialize.js` and related):

| Symbol | Role |
| --- | --- |
| `ExpertService` | Market list, detail, recents, ranking |
| `ExpertPluginService` | Resolve location, download zip, install, switch plugin per session |
| `ExpertCloudService` / `ExpertDesktopService` | Cloud / desktop expert resources |
| `ExpertPluginActivation` | Activate expert from session `expertId` before prompt |
| `AgentTeamsEnvResolver` | Compute Agent Teams env from session `expertType` |
| `fetchExpertZipBuffer` | Download expert zip by URL |
| `activateExpert` / `deactivateExpert` | Install or remove an expert plugin |

Session config carries `expertId`, `expertMarketplace`, `expertLocale`, `expertRuntimeIdentity`, and related fields. Updating `expertId` pre-resolves `manifest.expertType` into `AgentTeamsEnvResolver`.

### Activation flow

```text
User summons expert / expert team
        │
        ▼
session.desiredConfig.expertId (+ expertMarketplace)
        │
        ▼
onBeforePrompt → ExpertPluginActivation
        │
        ├─ resolveExpertLocation(expertId, marketplace)
        ├─ read manifest.expertType / agentName / name
        ├─ if team: headers X-Expert-Id + X-Expert-Team-Task: true
        ├─ recordSessionExpertType(sessionId, expertType)
        └─ switchExpertPluginForSession(
             sessionId, pluginName, agentName, …, internalModelRequestHeaders
           )
                │
                ▼
           ACP /api/v1/plugins/switch
           (inject expert identity into the agent-cli session)
```

Team type also enables Agent Teams. Comments in-tree call this a hard product requirement (“when the user picks an expert team session, these tools must be on”):

```js
// agent-teams-env.ts (equivalent logic)
const TEAM_EXPERT_TYPE = "team";
const AGENT_TEAMS_ENV_KEY = "CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS";

function resolveAgentTeamsEnv({ expertType, disableAgentTeams }) {
  if (expertType === TEAM_EXPERT_TYPE) return "1"; // force on
  return (disableAgentTeams ?? true) ? "0" : "1"; // default off
}
```

### Expert system prompt

Expert sessions use `workbuddy-expert-prompt.tpl`. It starts with a **Role Override** so `{{ PluginAgentPrompt }}` (from the expert MD) wins over any earlier persona. The rest stitches memory, safety, working modes, the agent loop, and delivery (`present_files`) into a shared runtime shell.

Single experts and team leads share that shell; the difference is whether `PluginAgentPrompt` is one role MD or a lead MD that embeds the SOP.

---

## Agent Teams runtime

Expert-team execution sits on agent-cli Agent Teams (`cli/dist/codebuddy.js` + `product.json` prompts). For the code-level walkthrough of multi-round chat, mailboxes, on-disk team state, and core classes (`TeamManager` / `TeamMailbox` / `TeamMember`, …), see [WorkBuddy Agent Teams implementation](./workbuddy-agent-teams.md).

### Tools

| Tool | Role |
| --- | --- |
| `TeamCreate` | Create a team (`team_name`, description). Writes team metadata and a matching task list |
| `Agent` | Spawn / continue members; in teams, pass `name`, `subagent_type` (agent ID), and task `prompt` |
| `SendMessage` | Lead ↔ member messaging; can resume finished workers; supports `shutdown_request` / `shutdown_response` |
| `TaskStop` | Stop a misdirected member |
| `TeamDelete` | Remove team and task dirs; fails while members are still active |
| Task tools (`TaskCreate` / `TaskList` / `TaskUpdate`…) | Task list bound 1:1 to the team (Team = TaskList) |

`TeamCreate` on-disk layout (from the tool description template):

- Team file: `{{codebuddyHome}}/teams/{team-name}.json`
- Task dir: `{{codebuddyHome}}/tasks/{team-name}/`

If the session ends without an explicit `TeamDelete`, the team directory is cleaned up automatically.

### Prompt injection (`TeamContextInterceptor`)

| Role | Template | Role of the text |
| --- | --- | --- |
| Lead | `team-lead-prompt` | Speak only to the user; schedule with `Agent` / `SendMessage` / `TaskStop`; synthesize; never invent member results |
| Member | `team-sys-prompt` | Plain text is invisible to the lead — **must** `SendMessage`; use TaskList; send full results to `team-lead` when done |

Lead-side rules from the template:

- Worker results arrive as user-role `<agent-notification>` messages, not real user turns
- Parallelism: multiple `Agent` calls in one assistant message
- Worker prompts must be self-contained; ban “based on your findings…” delegation
- Wrap-up: `shutdown_request` to active members, wait for `shutdown_response`, then `TeamDelete`

`AgentTool.spawnTeammate` requires an existing team or returns “create a team first”; member ids look like `name@teamName`; `team-lead` is reserved; spawns serialize on `teamSpawnChain` to avoid name clashes.

### IM / Claw limits

IM channels disable `Agent` / `TeamCreate` / `TeamDelete` / `SendMessage` (listed in `CLAW_DISABLED_TOOLS` with tools like `AskUserQuestion` and `ImageGen`). Expert-team collaboration is mainly for the desktop execution surface.

### UI team state

The main process keeps a `teamRuntime` snapshot from `teamUpdate` events such as `team_created`, `member_status_change`, and `team_deleted`, plus flags like `isAutoTeam`, for busy / member progress UI.

---

## End-to-end: one expert-team task

The installed `trading-agent` pack is a concrete example. It ships:

- `agents/*.md` — eleven specialist roles
- `skills/trading-analysis` — orchestrator SOP
- `rules/trading-agent_rules.md` — `alwaysApply` scene + available agents

Typical phases (from the skill / rules):

```text
Phase 1 parallel TeamCreate/Agent:
  market-analyst / fundamentals-analyst / news-analyst / sentiment-analyst
        │
        ▼ four reports back to the lead
Phase 2 serial:
  bull-researcher → bear-researcher → research-manager → [investment plan]
        │
        ▼
Phase 3: trader → FINAL TRANSACTION PROPOSAL
        │
        ▼
Phase 4 parallel risk analysts → risk-manager → [final decision]
        │
        ▼
Phase 5: lead assembles the final report + delivery checks
```

Unlike homogeneous swarm batching, parallelism is only inside dependency-free phases; later phases must wait and pass full prior outputs.

---

## Comparison with Kimi Code swarm mode

| Dimension | WorkBuddy Expert Team | Kimi Code swarm (`AgentSwarm` / Swarm Mode) |
| --- | --- | --- |
| Product shape | Summonable prefab team plugin | A main-agent work mode / tool |
| Subagents | Heterogeneous roles (per-MD) | Mostly homogeneous (one `subagent_type` + `{{item}}`) |
| Parallelism | Parallel inside SOP phases; often serial across phases | One template batch (up to 128) |
| Communication | Multi-turn `SendMessage` (+ task list) | Results return once to the main agent |
| Process source | Pack SOP / workflows | Enter-mode reminder + on-the-fly split |
| Entry | Expert Center summon | `/swarm`, `AgentSwarm` tool call |

Kimi already has `Agent` (heterogeneous subtasks) and `AgentSwarm` (homogeneous batches). Expert Teams add a **discoverable team pack**, **session-level lead identity**, **multi-turn relay**, and **preset workflows**. Swarm is closer to one parallel phase inside an expert team than to the full team product.

---

## Alignment checklist

If aligning capabilities in Kimi Code, split by layer:

1. **Catalog + pack format**: `expertType` + `agents/*.md` + (team) `settings.json` / `teamInfo` / `members`
2. **Session activation**: bind expert id → Role Override / default agent → enable multi-agent tools for teams
3. **Runtime tools**: create team workspace, spawn members, message relay, graceful shutdown and cleanup
4. **Product policy**: lead SOP, capability preflight, delivery checklist (prompt / skill, not a hard-coded state machine)
5. **UI**: expert cards, member list, summon, cost hints, team progress (`teamRuntime`)

---

## Local inspection tips

Useful entry points when re-checking a build:

1. `~/.workbuddy/app/cache/experts/manifest.json` — catalog fields for experts / teams
2. `~/.workbuddy/plugins/marketplaces/**/plugins/*/agents/*.md` — real roles and SOPs
3. `app.asar.unpacked/resources/builtin-skills/expert-manager/references/*.md` — packaging spec
4. `app.asar.unpacked/cli/product.json` — `team-lead-prompt` / `team-sys-prompt` / `TeamCreate` tool text
5. `main/initialize.js` — `ExpertPluginActivation`, `resolveAgentTeamsEnv` (summon → runtime bridge)

Marketplace content and the binary both move with releases; this page freezes structure and control flow for the observed version only.
