# WorkBuddy 专家与专家团实现

本文整理腾讯 **WorkBuddy**（macOS 上为 `WorkBuddy.app`，bundle id `com.workbuddy.workbuddy`）「专家 / 专家团」的产品形态与代码实现细节，供 Kimi Code 对照 Agent / 子 Agent / 蜂群协作时参考。

> 信息来自对本机安装包（`app.asar` / `app.asar.unpacked`）与用户数据目录（`~/.workbuddy`）的静态反查，观测版本为 **5.3.5**。第三方实现可能随版本变化；以当前安装版本为准。

## 概念分层

WorkBuddy 把「能做事的能力」拆成三层，UI 与文档里并列展示：

| 层 | 产品名 | 本质 | 适用 |
| --- | --- | --- | --- |
| Skill | 技能 | 可加载的能力包（文档 + 脚本 + 工具约束） | 需要某项具体能力 |
| Expert（`expertType: "agent"`） | 专家 | 单个角色化 Agent：人设 + 方法论 + 工具链 | 单点专业问题 |
| Expert Team（`expertType: "team"`） | 专家团 | 主理人 + 多名成员 + 预制 SOP | 跨角色、多阶段任务 |

代码里「专家团」不是单独的调度引擎，而是：

1. 一个带 `expertType: "team"` 的 **CodeBuddy Plugin**（专家包）
2. 会话激活时强制打开的 **Agent Teams** 运行时（`TeamCreate` / `Agent` / `SendMessage` / `TeamDelete`）
3. 写在主理人 MD / Skill / rules 里的 **协作约束与 Workflow**

```text
专家中心（UI / manifest）
        │
        ▼
ExpertService / ExpertPluginService（下载 zip、解析、激活）
        │
        ▼
会话绑定 plugin + agentName（主理人或单专家）
        │
        ├─ expertType=agent → 普通 Agent 会话 + Role Override
        └─ expertType=team  → CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS=1
                              + X-Expert-Team-Task
                              + TeamCreate / Agent / SendMessage …
```

---

## 安装与数据落点

| 路径 | 内容 |
| --- | --- |
| `/Applications/WorkBuddy.app` | Electron 桌面应用 |
| `…/Resources/app.asar` | 主进程 / 渲染进程打包代码 |
| `…/Resources/app.asar.unpacked/cli/` | agent-cli（`codebuddy.js`）与 `product.json` 提示词模板 |
| `…/Resources/app.asar.unpacked/resources/builtin-skills/expert-manager/` | 专家包生命周期 Skill（创建 / 校验 / 注册 / 打包） |
| `…/Resources/app.asar.unpacked/resources/templates/workbuddy-expert-prompt.tpl` | 专家会话系统提示词骨架（含 Role Override） |
| `~/.workbuddy/app/cache/experts/manifest.json` | 专家中心目录缓存（分类 + 专家列表） |
| `~/.workbuddy/plugins/marketplaces/` | 已安装 marketplace 插件（含专家包） |
| `~/.workbuddy/plugins/marketplaces/my-experts/plugins/` | 「我的专家」自定义专家目录（由 `WORKBUDDY_CONFIG_DIR` 决定根） |
| `~/.workbuddy/sessions/`、`~/.workbuddy/workbuddy.db` | 会话与自动化等本地状态 |

专家中心目录缓存观测规模（本机一次快照）：数百个专家条目，其中 `expertType: "team"` 约占数十个（如软件开发团队、交易分析团队、内容创作专家团等）。

---

## 专家包结构

专家是 **plugin 包**，不是独立进程类型。规范由内置 Skill `expert-manager`（v2.0）定义。

### 目录骨架

```text
{expert-name}/
├── .codebuddy-plugin/plugin.json   # 元数据 + expertType + agents/skills
├── agents/
│   ├── {agent}.md                  # Agent 型：单个 MD
│   ├── {team}-team-lead.md         # Team 型：主理人（禁止叫通用 team-lead.md）
│   └── {member}.md                 # Team 型：成员
├── skills/…                        # 可选
├── rules/…                         # 可选（常 alwaysApply，注入场景说明）
├── avatars/…
└── settings.json                   # Team 型必填：{ "agent": "{team}-team-lead" }
```

生成命令（Skill 内脚本）：

```sh
python3 scripts/init_expert.py <expert-name> --type agent|team \
  --path "$WORKBUDDY_CONFIG_DIR/plugins/marketplaces/my-experts/plugins"
python3 scripts/validate_expert.py <expert-dir>
python3 scripts/register_expert.py <expert-dir> --session-id "$CODEBUDDY_SESSION_ID"
python3 scripts/package_expert.py <expert-dir>
```

### `plugin.json` 关键字段

| 字段 | Agent 型 | Team 型 |
| --- | --- | --- |
| `expertType` | `"agent"` | `"team"` |
| `agentName` | 主 Agent MD 文件名（无 `.md`） | `{team}-team-lead` |
| `agents` | 路径数组 | 主理人 + 全部成员 MD 路径 |
| `teamInfo` | 无 | `{ leadAgent, memberAgents[] }`（`memberAgents` **不含**主理人） |
| `members[]` | 展示用（可省略） | 必填；含主理人，`role` 为 `"lead"` / `"member"` |
| `displayName` / `profession` / `displayDescription` | 卡片展示；描述中文约 40–50 字 | `profession` 须与 `displayName` 一致 |
| `tags` / `quickPrompts` | 各固定 3 个；第一条 quickPrompt = `defaultInitPrompt` | 同左 |
| `categoryId` | 行业分类（如 `02-Engineering`） | 同左 |
| `plugin` | 与 `name` 一致 | 同左 |

### Agent MD

- Frontmatter 提供 `name` / `description` / 展示名等；规范要求 **不要**在 frontmatter 声明 `tools`（避免把工具面锁死）。
- 正文通常包含：角色定义、核心能力、工作流程、输出规范、注意事项。
- 成员 MD 须写明完成后用 `SendMessage` 回传主理人；调度时 `Agent` 的 `name` 与 `subagent_type` 使用 **Agent ID**（MD 文件名），禁止用中文花名。

### 主理人 MD（Team）

主理人模板要求写清：

1. 团队成员表（Agent ID ↔ 花名 ↔ 职责）
2. 标准 SOP（分 Phase；标明并行 / 串行）
3. **协作铁律**（见下）
4. 预设 Workflow（触发条件、Phase 编排、输入输出依赖）
5. 单 Agent 直调路由表（简单问题直派成员，复杂问题走 Workflow）

协作铁律（写在 `team-spec.md` / 主理人正文，约束模型行为）：

1. **建立团队**：仅主理人可 `TeamCreate`，禁止委派成员创建团队
2. **调度成员**：按 SOP spawn；主理人不得代写成员专业产出
3. **消息中转**：跨成员信息流经主理人（专家包 SOP 层的产品约束）
4. **成员结论为准**：专业结论必须由对应成员产出后再采信

红线包括：禁止跳过 `TeamCreate` 自己模拟多角色、禁止未完成前序 Phase 就跳阶段、禁止 spawn 主理人自己。

::: info 说明
运行时注入的通用 `team-sys-prompt` 允许成员之间直接 `SendMessage` / `broadcast`。专家团产品层通过主理人 MD 与 Skill SOP 收紧为「星型中转」。对齐实现时需区分 **Agent Teams 通用能力** 与 **专家团包约束**。
:::

---

## 召唤与会话激活

### 服务与入口

主进程（`main/initialize.js` 等）中的关键符号：

| 符号 | 职责 |
| --- | --- |
| `ExpertService` | 市场列表、详情、最近使用、排名 |
| `ExpertPluginService` | 解析位置、下载 zip、安装、会话切换 plugin |
| `ExpertCloudService` / `ExpertDesktopService` | 云端 / 桌面侧专家资源 |
| `ExpertPluginActivation` | Prompt 前按会话 `expertId` 激活专家 |
| `AgentTeamsEnvResolver` | 按会话 `expertType` 计算 Agent Teams env |
| `fetchExpertZipBuffer` | 按 download URL 拉取专家包 zip |
| `activateExpert` / `deactivateExpert` | 安装或卸载专家 plugin |

会话配置会携带 `expertId`、`expertMarketplace`、`expertLocale`、`expertRuntimeIdentity` 等字段；更新 `expertId` 时会预解析 `manifest.expertType` 并写入 `AgentTeamsEnvResolver`。

### 激活流程

```text
用户召唤专家 / 专家团
        │
        ▼
session.desiredConfig.expertId (+ expertMarketplace)
        │
        ▼
onBeforePrompt → ExpertPluginActivation
        │
        ├─ resolveExpertLocation(expertId, marketplace)
        ├─ 读 manifest.expertType / agentName / name
        ├─ 若 team：请求头加 X-Expert-Id + X-Expert-Team-Task: true
        ├─ recordSessionExpertType(sessionId, expertType)
        └─ switchExpertPluginForSession(
             sessionId, pluginName, agentName, …, internalModelRequestHeaders
           )
                │
                ▼
           ACP /api/v1/plugins/switch
           （注入专家身份到 agent-cli 会话）
```

Team 型额外打开 Agent Teams（注释写明这是 PRD 硬要求：「用户选专家团进行会话时，要开启这些工具」）：

```js
// agent-teams-env.ts（逻辑等价）
const TEAM_EXPERT_TYPE = "team";
const AGENT_TEAMS_ENV_KEY = "CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS";

function resolveAgentTeamsEnv({ expertType, disableAgentTeams }) {
  if (expertType === TEAM_EXPERT_TYPE) return "1"; // 强制启用
  return (disableAgentTeams ?? true) ? "0" : "1"; // 默认禁用
}
```

### 专家系统提示词

专家会话使用 `workbuddy-expert-prompt.tpl`。开头强制 **Role Override**：后续 `{{ PluginAgentPrompt }}`（来自专家 MD）覆盖此前任何 persona。其后拼接记忆、安全策略、工作模式、agent loop、交付（`present_files`）等通用运行时段落。

单专家与专家团主理人共用这套骨架；差异在于注入的 `PluginAgentPrompt` 是单个角色 MD，还是主理人 MD（含 SOP）。

---

## Agent Teams 运行时

专家团执行面是 agent-cli 的 Agent Teams 能力（`cli/dist/codebuddy.js` + `product.json` 提示词）。多轮对话、邮箱、落盘团队态与关键类（`TeamManager` / `TeamMailbox` / `TeamMember` 等）的代码级整理见 [WorkBuddy Agent Teams 实现](./workbuddy-agent-teams.md)。

### 工具

| 工具 | 作用 |
| --- | --- |
| `TeamCreate` | 创建团队；参数含 `team_name`（及描述）。落盘团队元数据与对应任务列表 |
| `Agent` | Spawn / 继续成员；团队场景下需 `name`、`subagent_type`（Agent ID）、任务 `prompt` |
| `SendMessage` | 主理人 ↔ 成员通信；也可用于 resume 已完成 worker；支持 `shutdown_request` / `shutdown_response` |
| `TaskStop` | 中止跑偏的成员 |
| `TeamDelete` | 删除团队与任务目录；若仍有活跃成员会失败 |
| Task 系列（`TaskCreate` / `TaskList` / `TaskUpdate`…） | 与 Team 1:1 绑定的任务列表（Team = TaskList） |

`TeamCreate` 落盘（模板描述）：

- 团队文件：`{{codebuddyHome}}/teams/{team-name}.json`
- 任务目录：`{{codebuddyHome}}/tasks/{team-name}/`

未显式 `TeamDelete` 时，会话结束会自动清理团队目录。

### 提示词注入（`TeamContextInterceptor`）

| 角色 | 模板名 | 作用 |
| --- | --- | --- |
| 主理人 | `team-lead-prompt` | 只对用户说话；用 `Agent` / `SendMessage` / `TaskStop` 调度；合成结果；勿臆造成员产出 |
| 成员 | `team-sys-prompt` | 明文输出对团长不可见，**必须** `SendMessage`；可查 TaskList；结束须把完整结果发给 `team-lead` |

主理人侧关键行为（模板约束）：

- Worker 结果以 user-role 的 `<agent-notification>` 到达，不是真用户消息
- 并行：同一消息内多次 `Agent` 调用
- 写 worker prompt 必须自包含；禁止「根据你的发现去做」这类甩锅式委派
- 收尾：对活跃成员发 `shutdown_request`，收到 `shutdown_response` 后再 `TeamDelete`

成员 spawn（`AgentTool.spawnTeammate`）要求已存在 team，否则返回需先 `TeamCreate`；成员 ID 形如 `name@teamName`；`team-lead` 名称保留给团长；spawn 经 `teamSpawnChain` 串行化以避免重名冲突。

### IM / Claw 限制

IM 通道禁用 `Agent` / `TeamCreate` / `TeamDelete` / `SendMessage`（与 `AskUserQuestion`、`ImageGen` 等一并列入 `CLAW_DISABLED_TOOLS`）。专家团协作主要在桌面会话执行面可用。

### UI 侧团队状态

主进程维护 `teamRuntime` 快照，消费 `teamUpdate` 事件类型，例如：`team_created`、`member_status_change`、`team_deleted`，以及 `isAutoTeam`、成员状态归一化等，用于会话侧展示忙碌 / 成员进度。

---

## 端到端：专家团一次任务

以本机已安装的 `trading-agent`（交易分析）为例，包内同时有：

- `agents/*.md`：11 个专业角色
- `skills/trading-analysis`：主协调器 SOP
- `rules/trading-agent_rules.md`：`alwaysApply`，声明场景与可用 Agent

典型阶段（Skill / rules 描述）：

```text
Phase 1 并行 TeamCreate/Agent：
  market-analyst / fundamentals-analyst / news-analyst / sentiment-analyst
        │
        ▼ 四份报告回主理人
Phase 2 串行：
  bull-researcher → bear-researcher → research-manager → [投资计划]
        │
        ▼
Phase 3：trader → FINAL TRANSACTION PROPOSAL
        │
        ▼
Phase 4 并行风险分析师 → risk-manager → [最终交易决策]
        │
        ▼
Phase 5：主理人整合最终报告 + 交付检查
```

这与「蜂群」式同质批量不同：并行只发生在无依赖的 Phase 内；跨 Phase 必须串行传完整产出原文。

---

## 与 Kimi Code 蜂群模式对照

| 维度 | WorkBuddy 专家团 | Kimi Code 蜂群（`AgentSwarm` / Swarm Mode） |
| --- | --- | --- |
| 产品形态 | 可召唤的预制团队 plugin | 主 Agent 的一种工作模式 / 工具 |
| 子 Agent | 异质角色（各有 MD） | 多为同质（同一 `subagent_type` + `{{item}}`） |
| 并行模型 | SOP Phase 内并行，跨 Phase 常串行 | 一次模板批量并行（最多 128） |
| 通信 | 多轮 `SendMessage`（+ 任务列表） | 子 Agent 结果一次性回主 Agent |
| 流程来源 | 专家包内 SOP / Workflow | 进模式 reminder + 现场拆分 |
| 入口 | 专家中心召唤 | `/swarm`、`AgentSwarm` 工具调用 |

Kimi 已有 `Agent`（异质子任务）与 `AgentSwarm`（同质批量）。专家团额外提供的是：**可发现的团队配置包、会话级主理人身份、多轮中转与预制 Workflow**。蜂群更接近专家团里某一个并行 Phase，而不是整团产品。

---

## 实现对照清单

若要在 Kimi Code 侧做能力对齐，可按层拆分：

1. **目录与包格式**：`expertType` + `agents/*.md` +（Team）`settings.json` / `teamInfo` / `members`
2. **会话激活**：绑定专家 ID → 注入 Role Override / 默认 agent → Team 时打开多 Agent 工具面
3. **运行时工具**：创建团队工作区、spawn 成员、消息回传、优雅关闭与清理
4. **产品约束**：主理人 SOP、能力预检、交付检查清单（以 prompt / Skill 表达，而非硬编码状态机）
5. **UI**：专家卡片、成员列表、召唤、积分/消耗提示、团队进度（`teamRuntime`）

---

## 本地观测要点

反查时可优先打开：

1. `~/.workbuddy/app/cache/experts/manifest.json` — 专家 / 专家团目录字段
2. `~/.workbuddy/plugins/marketplaces/**/plugins/*/agents/*.md` — 真实角色与 SOP
3. `app.asar.unpacked/resources/builtin-skills/expert-manager/references/*.md` — 官方打包规范
4. `app.asar.unpacked/cli/product.json` — `team-lead-prompt` / `team-sys-prompt` / `TeamCreate` 工具说明
5. `main/initialize.js` 中 `ExpertPluginActivation`、`resolveAgentTeamsEnv` — 召唤到运行时的桥接

第三方二进制与云端 marketplace 内容会随版本更新；本文只固定观测版本上的结构与控制流。
