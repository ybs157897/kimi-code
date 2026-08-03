---
name: create-expert-team
description: How to author an expert-team package — the directory layout, `kimi.plugin.json` manifest contract, topology rules, and per-role Agent `.md` files. Use whenever the user asks to create, author, modify, or debug an expert team (专家团队 / 专家组) or a multi-agent team plugin under an `experts/` directory. Read this skill first instead of guessing the format.
---

# Create an expert team

An expert team is a **declarative multi-agent package**: a `kimi.plugin.json`
manifest plus one Markdown file per Agent role. It contains no executable code
— the runtime wires the roles, tools, and messaging for you. Two shapes exist:

- `expertType: "team"` — one lead plus declared specialist members.
- `expertType: "agent"` — a single specialist agent.

## Where packages live (discovery roots)

Drop-in packages are scanned from `experts/` directories, no install step
needed. Roots are scanned in order and **earlier roots win id collisions**:

1. Project scope: `<workDir>/<projectConfigDirName>/experts/<team>/` — the
   project config directory name depends on the host (`.kimi-code/experts/`
   for the CLI, `.kimi-desktop/experts/` for the desktop app).
2. User scope: `<home>/.kimi-code/experts/<team>/` (the Kimi home directory).

Directory packages also shadow installed plugins with the same `name`. The
feature is on by default; `KIMI_CODE_EXPERIMENTAL_EXPERT_TEAMS=0` disables it.

## Directory layout

```text
<projectConfigDirName>/experts/my-team/
├── kimi.plugin.json          # manifest (required)
├── agents/                   # one .md file per role (required)
│   ├── my-team-lead.md
│   ├── worker-a.md
│   └── worker-b.md
└── skills/                   # optional shared skills (SKILL.md folders)
    └── my-team-toolkit/
        └── SKILL.md
```

## Manifest contract (`kimi.plugin.json`)

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Stable id; must match `/^[a-z0-9][a-z0-9_-]{0,63}$/`. |
| `expertType` | yes | `"team"` or `"agent"`. |
| `agentName` | yes | The entry role; must equal the stem of one declared agent file, and for teams it is the lead. |
| `agents` | no | `string[]` of `./agents/*.md` paths. Omit it to auto-discover every `.md` directly under `agents/`. |
| `skills` | no | `string[]` of skill directories. If omitted, a root-level `SKILL.md` is picked up when present. |
| `teamInfo` | team only | `{ "leadAgent": string, "memberAgents": string[] }`. |
| `members` | team only | Display/role metadata for every role (see below). |
| `version`, `description` | no | Plain metadata. |
| `displayName`, `displayDescription`, `profession`, `tags`, `categoryId`, `defaultInitPrompt`, `quickPrompts` | no | Storefront/UI display fields. |

### Topology rules (validated at load; violations skip the package)

- `"agentName"` must reference one of the declared agent files.
- `"teamInfo.leadAgent"` must equal `"agentName"`.
- `"teamInfo.memberAgents"` must not include the lead, must not contain
  duplicates, and every entry must reference a declared agent file.
- `"members"` is required for teams: every entry needs `"agent"` (or `"id"`)
  plus `"role": "lead" | "member"`; exactly one lead matching
  `teamInfo.leadAgent`; it must cover the lead and every `memberAgents` entry
  exactly — nothing missing, nothing undeclared, no duplicates.

Each member entry may add `name`, `profession` (plain string or
`{ "en": ..., "zh": ... }` localized map), `displayName`, `description`, and
`avatar`.

## Agent file contract (`agents/<name>.md`)

Frontmatter plus a prompt body. The body becomes that role's instructions
(wrapped by an auto-injected runtime role preamble — you do not write it).

```markdown
---
name: worker-a            # kebab-case, MUST equal the file name stem
description: One-line role summary shown to the lead.
tools: [Read, Grep]       # optional allowlist; omit for the full toolset
---

What this role does, its inputs, deliverable, and reporting protocol.
```

- Recognized frontmatter: `name`, `description`, `whenToUse`, `tools`,
  `disallowedTools`, `subagents`, `override`, `model_preference`. Unknown
  fields are ignored — do not rely on them.
- The frontmatter `name` must match the file name; a `tools` list is an
  allowlist that the runtime **extends**, never shrinks: leads always get
  `TeamCreate`, `TeamSpawn`, `SendMessage`, `TeamDelete`; members always get
  `SendMessage` and `TodoList`.
- Write the lead body as an SOP: team objectives, member capability list,
  phase order, and reporting rules. Write member bodies as job descriptions:
  inputs, tools, deliverable shape, and the rule to report complete findings
  to the lead via `SendMessage`.

## Minimal complete example (team)

`experts/release-review-team/kimi.plugin.json`:

```json
{
  "name": "release-review-team",
  "version": "1.0.0",
  "description": "Reviews a pending release: audits the change set, then assesses rollout risk.",
  "expertType": "team",
  "agentName": "release-review-lead",
  "teamInfo": {
    "leadAgent": "release-review-lead",
    "memberAgents": ["change-auditor", "risk-reviewer"]
  },
  "members": [
    { "agent": "release-review-lead", "role": "lead" },
    { "agent": "change-auditor", "role": "member" },
    { "agent": "risk-reviewer", "role": "member" }
  ]
}
```

`agents/release-review-lead.md`:

```markdown
---
name: release-review-lead
description: Coordinates the release review and writes the final verdict.
---

You lead a release review. Workflow:

1. Confirm the review target (branch, change set, release scope) with the user.
2. TeamSpawn change-auditor with the change-set range; wait for its report.
3. TeamSpawn risk-reviewer with the audit findings; wait for its report.
4. Merge both reports into one verdict: ship / hold, with reasons.

Only spawn declared members, one clear assignment each. Do not do the audit
or risk analysis yourself, and do not call TeamDelete before every member has
reported.
```

`agents/change-auditor.md` and `agents/risk-reviewer.md` follow the member
shape: role summary frontmatter, then inputs → work → deliverable, ending
with "send the complete findings to the lead via SendMessage".

## Single-agent expert example

```json
{
  "name": "sql-tuner",
  "version": "1.0.0",
  "description": "Database query performance specialist.",
  "expertType": "agent",
  "agentName": "sql-tuner"
}
```

with `agents/sql-tuner.md` holding the role prompt. The `agent` shape takes
no `teamInfo`, and `members` is optional for it.

## Activation and runtime flow

1. The user activates the team with `/experts` (TUI) or the expert picker in
   GUI hosts; `/experts off` returns to the standard agent. Activation fails
   visibly if the manifest is invalid — packages with diagnostics are skipped
   with a warning.
2. The lead becomes the session's active agent and is the **only** role that
   talks to the user. The runtime injects the role preamble; your SOP body is
   the rest.
3. The lead's lifecycle: `TeamCreate` (once, before anything else) →
   `TeamSpawn` per assignment (`name` = declared member id, prompt =
   self-contained task) → collect `SendMessage` reports → `TeamDelete` after
   every member finished. `TeamSpawn` replaces the generic `Agent` tool
   inside a team; members never talk to the user or to each other directly.

## Checklist before declaring done

- [ ] `name` matches the regex; `agentName`/`leadAgent`/member ids all match
      agent file stems exactly.
- [ ] Every file under `agents/` parses: kebab-case frontmatter `name` equal
      to the file name, non-empty `description`, non-empty body.
- [ ] `members` covers lead + members exactly once each.
- [ ] Lead SOP names every member id it will spawn and the phase order.
- [ ] Reload the session (or rerun `/experts`) and confirm the team appears
      without skip warnings.
