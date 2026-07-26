# WorkBuddy Agent Teams 实现（多轮对话与团队态）

本文基于对本机 **WorkBuddy 5.3.5** 安装包的静态反查，整理 Agent Teams 如何实现「持久化团队态」与「多轮成员对话」。主要代码落在 `app.asar.unpacked/cli/dist/codebuddy.js`（agent-cli）与 `cli/product.json`（`team-lead-prompt` / `team-sys-prompt`）；专家团只是在会话激活时强制打开这套运行时。

> 第三方实现会随版本变化。路径里的 `~/.codebuddy` 在官方文档出现；本机 WorkBuddy 实际 home 为 `~/.workbuddy`（`PathUtils.getHomeDir()`）。下文以观测到的运行时行为为准。

与「专家包 / 召唤」产品层的对照见 [WorkBuddy 专家与专家团实现](./workbuddy-experts.md)。

## 结论先看

WorkBuddy 的多轮与团队态不是「子 Agent 工具返回值」，而是：

1. **磁盘上的团队对象**（`teams/{name}/config.json` + `inboxes/` + `tasks/`）
2. **异步邮箱**（`TeamMailbox`：写入 JSON 收件箱 → 轮询未读 → 注入会话）
3. **独立成员进程内会话**（`TeamMember` + `InProcessTeammateBackend`，可 `respawn` / wake）
4. **角色提示词**（`TeamContextInterceptor` 注入 lead / member 规则）

专家团 SOP 决定「派谁、哪一 Phase」；真正托住多轮的是上面这套 Agent Teams 运行时。

## 组件地图

| 符号（反查） | 职责 |
| --- | --- |
| `TeamManager` | 建团 / 删团 / 成员登记；`isEnabled()` 读 `CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS`；持有 `teamConfig` |
| `TeamMailbox` | 收件箱读写、broadcast、未读、**默认 2s 轮询** |
| `TeamMember` | 单个成员生命周期：`spawn` / `respawn` / mailbox polling / forceKill |
| `TeamInboxDispatchService` | 把收件箱消息接到主会话 / ACP 侧分发 |
| `TeamContextInterceptor` | 注入 `team-lead-prompt` / `team-sys-prompt`（`system-reminder data-role="team-context"`） |
| `ShutdownCoordinator` | `shutdown_request` ↔ `shutdown_response` 关联与超时强杀 |
| `TeamCreateTool` / `TeamDeleteTool` / `SendMessageTool` / `AgentTool` / `TaskStopTool` | 模型可见工具面 |
| `formatTeammateMessage` | 把邮箱条目包成 `<teammate-message teammate_id="…" summary="…">` |

开关：

```js
// TeamManager.isEnabled() 逻辑等价
return process.env.CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS !== "0";
```

专家团会话激活时，桌面侧会把该 env 强制设为 `"1"`（见专家文档中的 `AgentTeamsEnvResolver`）。

## 团队态：落盘模型

### 目录

```text
{home}/teams/{teamName}/
├── config.json                 # 团队元数据 + 成员表
├── inboxes/
│   ├── team-lead.json          # 主理人收件箱（JSON 数组）
│   └── {memberName}.json       # 成员收件箱
└── endpoints/                  # 成员 endpoint（可选）

{home}/tasks/{teamName}/        # 与 Team 1:1 的共享任务列表
```

`PathUtils` 关键 API（逻辑名）：

- `getTeamsDir()` → `{home}/teams`
- `getTeamConfigPath(name)` → `…/config.json`
- `getTeamInboxPath(team, member)` → `…/inboxes/{member}.json`
- `getTeamTasksDir(name)` → `{home}/tasks/{name}`

### `config.json` 形状（观测）

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

约定：

- 成员 ID：`{name}@{teamName}`
- 名称 `team-lead` 保留给主理人
- 同名冲突时 `AgentTool` 经 `teamSpawnChain` 自动改名为 `name-2`、`name-3`…

### `TeamManager.createTeam`

观测逻辑：

1. 已在团队中 → 报错（须先删）
2. 目录已存在且非 auto-team → `resolveUniqueTeamName` 改名
3. `mkdir` inboxes + tasks
4. 写入仅含 lead 的 `teamConfig`，`writeInbox(team, "team-lead", [])`，`saveConfig()`
5. 记入 `sessionCreatedTeams`

`deleteTeam`：先尝试清理 worktree；再 `rm -rf` 团队目录与 tasks 目录；活跃成员未关干净时工具层会失败（逼走 shutdown 协议）。

## 多轮对话：邮箱路径

### 写入（`SendMessage` / `TeamMailbox.send`）

`SendMessageTool` 参数（zod enum）：

| `type` | 含义 |
| --- | --- |
| `message` | 点对点 DM（需 `recipient`） |
| `broadcast` | 发给除自己外全部成员 |
| `shutdown_request` | 请求成员关闭 |
| `shutdown_response` | 成员应答（需 `request_id` + `approve`） |
| `plan_approval_response` | 计划审批 |

执行要点：

- `TeamManager.isEnabled()` 为假则工具不可用
- 不在团队中 → 返回 `"Not in a team…"`
- `TeamMailbox.send(team, recipient, { from, text, summary, color, read: false, … })`：**读 JSON 数组 → push → 写回**

`broadcast`：读 `config.json` 的 members，对除发送者外每人 `send`。

### 读取（轮询）

`TeamMailbox.startPolling(team, member, onUnread, intervalMs = 2000)`：

1. `getUnread`（`read !== true`）
2. 回调消费
3. `markAllAsRead`

成员 `TeamMember.spawn` 在 `backendType === "in-process"` 时调用 `startMailboxPolling()`。
主理人侧由 `startTeamLeadInboxPolling(teamName, session)` 挂 lead 收件箱。

### 注入主理人上下文（多轮的关键）

`startTeamLeadInboxPolling` 观测逻辑：

```text
每 2s 拉 team-lead 未读
        │
        ├─ JSON.type === shutdown_response
        │     → ShutdownCoordinator.fulfillResponse
        │     → 从 TeamMemberRegistry 移除该成员（若 approve）
        │
        └─ 其余消息
              → formatTeammateMessage(from, summary, text)
              → 构造成 user-role 消息（带 providerData.teammateMessage）
              → 若主 Agent 正忙：MessageQueueManager / RichMessageQueue 入队
              → 若空闲：AgentService.run(defaultAgent, messages) 唤醒一轮
```

因此成员回传在主理人眼里是 **伪用户消息**（`<teammate-message>` / 文档亦称 `<agent-notification>`），不是 `Agent` 工具的同步 return。主理人可在用户继续聊天的同时，被邮箱事件再次唤醒——这就是多轮。

成员侧同理：收件箱新消息可触发 `respawn` / wake，用已有 `originalTaskId` resume，从而「对已完成成员再聊一轮」。

### 初始任务也走邮箱包装

spawn 时若不 `skipPromptWrapping`，初始 prompt 会被包成：

```text
<teammate-message teammate_id="team-lead" summary="Initial task assignment for {name}">
{原始 prompt}
</teammate-message>
```

与后续 `SendMessage` 同形，成员只认「收件箱 / teammate 消息」这一条通道。

## 成员生命周期

```text
TeamCreate
   → AgentTool.spawnTeammate（teamSpawnChain 串行化命名）
        → TeamManager.addMember
        → new TeamMember → spawn(InProcessTeammateBackend)
        → startMailboxPolling + TeammateIdleTracker.register
   → （异步干活；lead 可先对用户说话后收口）
   → 成员 SendMessage → team-lead 收件箱 → polling 注入 / 唤醒
   → lead 可再 SendMessage 纠偏（continue）或再 Agent 新成员（spawn fresh）
   → ShutdownCoordinator: shutdown_request → shutdown_response
   → TeamDelete
```

`AgentTool.spawnTeammate`：

- 无活跃 team → `"No active team found. Create a team first using TeamCreate."`
- 全部 spawn 挂在实例字段 `teamSpawnChain = teamSpawnChain.then(…)` 上，**只串行化注册/命名**，不禁止同消息多个 `Agent` 调用（Promise 链排队执行 spawn）
- 失败时 `removeMember` 回滚

后台 / 非专家路径里还有 `autoCreateTeam("_auto_…")`：无团时自动建团并 `startTeamLeadInboxPolling`。

## 提示词注入（`TeamContextInterceptor`）

| 角色 | 模板 | 注入条件（摘要） |
| --- | --- | --- |
| Lead | `team-lead-prompt` | 已在团队；roster 变化或首轮 / continue；避免重复塞同一段 |
| Member | `team-sys-prompt` | 带 `teamContext`；变量 `teamName` / `memberName` / `teamMembers` |

均包在：

```xml
<system-reminder data-role="team-context">
…
</system-reminder>
```

模板强制的产品语义（与代码互补）：

- Lead：只对用户说话；工人结果是内部信号；用 `Agent` / `SendMessage` / `TaskStop`；同消息可并行多个 `Agent`
- Member：明文输出 **对 lead 不可见**；必须 `SendMessage`；收工前把完整结果发给 `team-lead`；处理 `shutdown_request` 须先交结果再 `shutdown_response`

专家团包内 SOP 常再要求「跨成员经主理人星型中转」；通用 `team-sys-prompt` 仍允许成员互发 / `broadcast`——对齐时要区分 **Agent Teams 通用能力** 与 **专家包约束**。

## UI / ACP 团队态

会话更新通过 ACP `session_info_update`，`_meta["codebuddy.ai/teamUpdate"]`，例如：

- `team_created` / `team_deleted`
- `member_status_change`（带 `teamName`、`isAutoTeam`、`members[]`）

桌面端据此维护状态栏（`●` 工作中 / `✓` 完成等）与 `@成员` 补全。官方用户文档见安装包内 `cli/dist/web-ui/docs/cn/cli/agent-teams.md`。

## 与普通子代理的对比

| | 子代理（同步 `Agent` 结果） | Agent Teams |
| --- | --- | --- |
| 回传 | 工具 return | 邮箱 → 伪 user 消息 |
| 成员存活 | 调用结束即收 | 团队生命周期内可续聊 / wake |
| 团队对象 | 无 | `config` + `inboxes` + `tasks` |
| 并行 | 调度器允许时可并行 | 同消息多 `Agent` + 异步成员 |
| 用户插话 | 常阻塞在 tool | lead 可边聊边收通知；可 `@成员` |

## Kimi Code 当前对齐状态

`packages/agent-core/src/expert-team` 已经从「普通 `Agent` 返回值 remap」推进到可运行的专家团运行时。它采用 Kimi Code 的会话、Agent record 和后台任务机制实现等价语义，并不照搬 WorkBuddy 的磁盘目录。

### 已完成

- **激活链路**：实验开关、插件声明的 lead/member profile、RPC、Node SDK 与交互式 Kimi Code CLI 的 `/experts` 入口已经接通。
- **异步回传**：`Agent` 只返回派发回执；成员结果通过 `SendMessage` 进入运行时，再以 `<teammate-message>` 伪 User 消息注入 lead。
- **多轮成员生命周期**：成员保留独立 Agent 上下文；运行中消息走 steer，空闲成员通过 resume 唤醒，无法即时投递的消息写入 `SessionMeta` journal 并在恢复后重放。
- **协作语义**：支持点对点消息、broadcast、初始任务包装，以及同名固定成员的原子 reservation，避免并发派发生成重复成员。
- **关闭协议**：支持带 `request_id` 的 `shutdown_request` / `shutdown_response`、发送者校验、重复请求拒绝、超时强停，以及 roster 清空前禁止停用专家团。
- **恢复与清理**：重启后成员以 idle 状态恢复；无效或不再属于当前插件的 roster 项会被丢弃，恢复成员会重新绑定团队句柄并重建 `SendMessage`。会话关闭、停用或切换团队后，旧运行时不能继续收发或覆盖新状态。
- **产品状态面**：核心与 Node SDK 提供完整的声明成员状态快照，并通过 `expert_team.updated` 推送 `not_started` / `idle` / `running` 变化。TUI 页脚显示「运行中 / 声明成员」计数，`/experts status` 可查看完整 roster。

### 仍有差距

- **存储模型**：目前没有 `teams/{name}/config.json`、独立 inbox 与共享 tasks 目录。成员上下文由各 Agent record 持久化；`SessionMeta` 只保存 roster、待关闭请求和未投递 journal。跨重启的待关闭请求按超时强停处理，不会继续原握手。
- **动态组队**：当前由产品 API / `/experts` 激活插件声明的固定拓扑，没有模型可见的 `TeamCreate` / `TeamDelete`、auto-team、动态命名或同角色多实例。
- **共享任务与审批**：尚未实现 WorkBuddy 风格的团队共享 task list 和 `plan_approval_response`。
- **交互补全**：尚未实现 WorkBuddy 风格的 `@成员` 补全；Kimi Code 使用自己的 `expert_team.updated` 契约，而不是复刻 `team_created` / `member_status_change` 事件名。
- **引擎范围**：上述适配落在交互式 Kimi Code CLI 当前使用的 legacy `agent-core` 路径；`agent-core-v2` / kap-server 等入口需要分别收敛相同契约。

蜂群（`AgentSwarm`）仍更接近「一个并行 Phase」，不是整套 Teams。

## 本地反查入口

| 路径 | 内容 |
| --- | --- |
| `…/cli/dist/codebuddy.js` | `TeamManager` / `TeamMailbox` / `TeamMember` / `TeamContextInterceptor` / 工具 |
| `…/cli/product.json` | `team-lead-prompt`、`team-sys-prompt`、Team 工具描述 |
| `…/cli/dist/web-ui/docs/cn/cli/agent-teams.md` | 官方用户向说明 |
| `…/resources/builtin-skills/expert-manager/references/team-spec.md` | 专家团 SOP / 铁律 |
| `~/.workbuddy/teams/`、`~/.workbuddy/tasks/` | 运行时落盘观测 |
