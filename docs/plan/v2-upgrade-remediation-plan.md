# v2-only 升级收尾计划

本计划以 `agent/v2-upgrade` 的当前代码为准，目标是完成 v2-only 升级的剩余发布门。第一方产品入口已经全部使用 v2，SDK 根方法和公开 option 也已收口；现在不能把“代码迁移完成”等同于“可以发布”，剩余主线是外部实机、全仓/Nix 和真实 release workflow 验收。

更新日期：2026-07-29。

## 当前结论

| 范围 | 代码结论 | 状态 |
| --- | --- | --- |
| CLI / TUI | `kimi`、`kimi -p`、`kimi migrate` 和子命令统一进入 v2 Runtime/Klient；旧 engine gate 和生产 legacy runner 已移除。 | 已完成 |
| ACP | 第一方 `kimi acp` 直接创建 `KimiV2Runtime` + `V2AcpHost`；`LegacyAcpHost` 只保留公开 SDK 兼容重载。 | 已完成 |
| VS Code | Extension host 只创建一个 v2 runtime；auth、config、MCP、session、replay、interaction 已迁移。 | 已完成 |
| Core / Klient | Workspace FS、Todo/context、global MCP、fork/delete、session lifecycle 和 transport conformance 已接通。 | 已完成 |
| SDK 根入口 | 自动覆盖报告为 83/83；原 7 项语义差异和 4 个公开 option 已全部显式映射或报稳定错误。 | 已完成 |
| 发布门 | major changeset、legacy 引用 CI、CLI/ACP/Klient smoke、CLI 日志导出 e2e 和 CI→release SHA gate 已落地；VS Extension Host 1.100.0 已在 macOS 实机通过，credential-free Docker gate 已实现并接入 CI。v2 范围的 package build/typecheck/lint 已通过，剩余 Linux CI、Nix 和真实 release workflow 验收；全仓门禁还受并行 desktop/vis 改动与本机缺少 Wails 影响。 | 进行中 |

第一方生产源码中没有 `createKimiHarness()` / `new KimiHarness()` 执行路径。legacy 引用审计当前为 0 个 violation；唯一 allowlist 是扩展加载器保留的 `@moonshot-ai/agent-core/extension` 虚拟 specifier，它会映射到 v2 host，用于已有用户扩展兼容。

## 已确认的决策

1. **G0-10**：SDK 根入口采用 v2-backed compatibility facade。保留现有符号和主要调用方式，内部只使用 v2；未实现语义必须返回稳定 coded error 或进入 breaking exception，禁止伪造结果。
2. **G0-11**：默认 engine 从 v1 切换到 v2 按 major 处理。`.changeset/v2-engine-default.md` 已设置 `@moonshot-ai/kimi-code: major`。
3. **实现边界**：第一方产品入口直接使用 Runtime/Klient；公开兼容入口可以保留 `KimiHarness` 类型，但不得重新引入 v1 engine。
4. **当前估算假设**：主线按“Kaos/pre-turn drain/persist:false 作为明确 breaking exception、expert-team 采用可证明的兼容投影”估算。若要求这些行为严格复刻旧语义，工期按本文末尾的严格兼容区间计算。

## 本轮已经修复

### 入口与生命周期

- CLI 默认 direct-v2，删除 `experimental-v2.ts` 和 engine 环境变量分流。
- shell/print 正常关闭 runtime、session 和 telemetry；session 分页、cwd、permission 和输出行为完成回归。
- ACP 默认使用 v2 host，接通编辑器内存文件、会话分页、cancel、approval/question 和 symlink confinement。
- VS Code 迁移为单 v2 runtime，生产 `src` 中没有 Harness 构造。
- hard delete 增加 durable intent journal、last-record-wins 启动恢复、legacy index 清理和可重试 locked error；create/fork/delete 的 ABA 与回滚边界已覆盖。

### Core / Klient 能力

- Workspace FS factory 进入 hosted composition，同 Session 多 Agent 共享、跨 Session 隔离并随 scope dispose。
- Todo replay 从 `ISessionTodoService` 读取，不再返回硬编码空数组。
- clear/import context、global MCP catalog/OAuth/probe、session store 和 Todo 进入 Klient contract，memory/IPC 使用同一 conformance。
- fork facade 现在真实透传 `newSessionId`，SDK `forkId` 可以落到 Core `ForkSessionOptions.newSessionId`。
- MCP HTTP/SSE schema 原生保留 `auth: 'oauth'`；stdio 不声明该 marker。Core catalog、Klient mirror 和 memory/IPC CRUD 已覆盖 round-trip。
- MCP probe 的调用方 `cwd` 作为 stdio `defaultCwd` 传递，server 自己的 `config.cwd` 仍具有更高优先级。
- 新增 App-scope `IWorkspaceSkillCatalogService.list(workDir)`，无 Session、无 index/journal 写入；按 builtin → plugin → extra → user/explicit → project 合并，并由 Klient、kap-server、SDK 和 VS Code 共用。
- Klient agent event 已补 `prompt.steered` 和 `shell.completed`；SDK 已完成 content 投影、session `expert-team.changed` 和 global `kosong.changed` 的根协议事件转换。
- SDK 根入口自动覆盖从 28/83 提升到 83/83；所有公开异步方法都有真实 v2 override，全量测试中的意外 `not_implemented` 失败已清零。
- Agent lifecycle 新增按持久 metadata 恢复指定 child Agent 的正式入口；Klient memory dispatcher、kap-server dispatcher 和 prompt route 均可按需 materialize cold child，未知 id 仍返回 not found。
- SDK 的进程级 `log` 已桥接 v2 App/Session `ILogService`，并由 host-only export port 注入 active global log path；CLI 默认导出 session/global 日志，`--no-include-global-log` 明确排除 global 日志。
- SDK 创建 Session 前通过 v2 global MCP catalog 校验用户级 `mcp.json`；配置诊断保留被降级模型的具体路径；可选日志不可读或不是普通文件时不再阻塞 session export。
- SDK 兼容测试中的 session-store/provider/OAuth 替身已与冻结合同对齐，auth fixture 会关闭所有 v2 runtime，消除测试结束时与日志写入竞争删除临时目录的问题。
- `forcePluginSessionStartReminder` 现通过正式 Agent-scope plugin Service/Klient facade 刷新提醒；Kaos override、旧 pre-turn `drainAgentTasksOnStop` 和 `autoLoadConfig:false` 改为稳定 `not_implemented`，不再静默忽略。
- kap-server 的 v1 `POST /sessions` 现在把 `metadata.cwd` 之外的自定义 metadata 写入 v2 Session metadata；后续 fork 会继承并合并这些字段，不再在 create 边缘静默丢失。

### 产品收口

- VS Code 不再使用临时 `vscodeMcpOAuthServers` sidecar，OAuth marker 直接随 catalog entry 持久化。
- VS Code 在 session 尚未创建时也通过 `global.skills.listWorkspace()` 提供 workspace skill 斜杠命令。
- VS Code MCP test 透传 workspace cwd。
- TUI 图片限制与原图持久化使用正式 runtime media port；测试 fixture 不再构造 Harness。
- Klient live harness 已支持与 `KIMI_SERVER_URL` 同源的 REST/WS bearer token，避免鉴权后的 v2 server 被误判为“不可达”而整组跳过。
- Klient Docker runner 改为 Node 24.15.0 + pnpm 10.33.0 自包含镜像，修复不存在的根 Dockerfile、错误的双层参数转发和缺失 workspace `node_modules` 挂载；`KIMI_SERVER_E2E_CREDENTIAL_FREE=1` 使用隔离 HOME 且拒绝已有配置/凭据。

## P0：发布前必须完成

### SDK-COMPAT-603：根方法薄适配（已完成）

覆盖统计从 `SDKRpcClientBase` 的真实公开异步方法和 `SDKRpcClient` concrete overrides 自动派生，不再依赖手写清单。83 个兼容方法现有 83 个真实 v2 override，`unmapped` 为空；全量测试不再因意外 `not_implemented` 失败。

### SDK-SEM-604：七个非等价语义（已完成）

| 方法 | 已落地语义 | 明确信息损失 / exception |
| --- | --- | --- |
| `getExpertTeamStatus` | 从 v2 team member 投影：`spawning → waiting`、`running → active`、`completed/failed/shutdown → completed`；`stepDescription` 使用 member name。 | v2 snapshot 没有旧 `goal/response`，失败与 shutdown 在根枚举中只能收敛到 `completed`。 |
| `getCronTasks` | `id/name = task.id`，`expression = cron`；新增 Klient `getNextFireForTask()`，有 next fire 为 `scheduled`，否则 `inactive`。 | 根形状没有 prompt/recurring 字段；不伪造这些字段。 |
| `waitForBackgroundTasksOnPrint` | 复用 SDK v2 的 shared print policy；只在 `drain` 模式按配置 ceiling 等待。 | 无独立 legacy scheduler；行为以 v2 `task` 配置为准并兼容读取旧 `background` 配置。 |
| `handlePrintMainTurnCompleted` | 与第一方 CLI 共用 `exit/drain/steer`、active-task count 和 drain helpers。 | `exit/drain` 返回 `finish`；`steer` 仅在存在 active task 时返回 `continue`。 |
| `activateExtensionCommand` | 根名称冻结为 `<extensionId>:<commandName>`；v2 enqueue 成功返回 `undefined`，false 返回 `request.invalid`。 | 不伪造旧 `{ prompt }` 返回值。 |
| `addAdditionalDir` | `persist:true` 直接走 v2 workspace command，并验证 close/reload 后仍存在。 | `persist:false` 无法满足根 SDK 的 resume 恢复合同，显式返回 `not_implemented`，进入 major breaking 清单。 |
| `importContext` | 直接走正式 Klient agent context command，保留 source/content 并验证 context 可读。 | token/overflow/error 以 v2 context domain 为准，不直接写 memory。 |

这 7 项均有公开 contract test；CLI print 不再维护第二套 background policy。

### SDK-OPTIONS-605：公开 option 审计（已完成）

| Option | 最终收口 | 验证 |
| --- | --- | --- |
| `kaos` / `persistenceKaos` | v2 hosted lifecycle 没有完整 Kaos process/persistence 注入 seam；create/resume 均返回带 option detail 的 `not_implemented`。 | 真实根 SDK create/resume contract test。 |
| `drainAgentTasksOnStop` | 这是旧 engine 的 pre-turn-completion subagent drain hook，不能由 v2 的 post-turn print policy 等价替代；仅 `true` 返回稳定 `not_implemented`，默认/false 不改变行为。 | 真实根 SDK create contract test。 |
| `forcePluginSessionStartReminder` | 新增 `IAgentPluginService.appendFreshSessionStartReminder()` 的 Klient contract/facade；reload 完成 restore 后显式刷新 main Agent reminder。 | Core plugin、Klient memory/IPC、SDK real reload。 |
| `autoLoadConfig` | v2 hosted runtime 必须在暴露 Service 前完成 config load；默认/true 维持该语义，false 返回稳定 `not_implemented`。 | 根 SDK 构造 contract test。 |

Kaos、`drainAgentTasksOnStop:true`、`autoLoadConfig:false` 与 `addAdditionalDir({persist:false})` 一并进入 major breaking 清单。

### EVENT-COMPAT-606：事件闭环（已完成）

验证 Core → Klient → SDK 的四条链：

- `prompt.steered`：v2 `ContentPart` 转根 `MessageContent`；text/think/image/video/data URL/audio 都必须有明确投影，不能因单个 part 丢掉整个事件。
- `shell.completed`：保留 `commandId`、`taskId`、`isError` 和与 `shell.output` 的顺序。
- session `expert-team.changed` → 根 `expert_team.updated`。
- global `kosong.changed` → 根 `event.model_catalog.changed`。

测试使用真实 memory transport 和公开 SDK listener，已覆盖 subscribe、close 后释放和 late-event suppression。

### REL-801：发布门

1. SDK API 完整性测试已经自动比较 base public methods 和 concrete overrides；当前为 83/83、`unmapped=[]`。option exception 与 `addAdditionalDir({persist:false})` 已固化为发布清单。
2. `scripts/check-legacy-agent-core-refs.mjs` 已接入根脚本和 CI。
3. CLI bundle smoke 已覆盖假 OpenAI SSE 的 v2 print、`migrate` runtime 和 ACP initialize/正常退出；VS Code Extension Host 使用与 CI 相同的 1.100.0 已在 macOS 实机通过（10 commands、webview 打开、host exit 0）。默认下载到 1.131.0 时，`@vscode/test-electron` 在 macOS 找不到新版 app bundle 的旧 Electron 路径，属于 latest runner/packaging 兼容问题，不影响固定 CI 门。
4. `apps/kimi-code` e2e 的日志导出已闭环（2 passed / 1 环境型 skipped）。Klient credential-free Docker runner 和 Linux CI job 已实现；本地空配置、真实 bearer-auth v2 server 的等价切片为 15 passed / 4 model-required skipped。当前机器没有 Docker，最终完成门是新增 Linux job 的首次成功运行。
5. release workflow 已改为仅消费同仓库 main push 的成功 CI，并固定通过 CI 的 SHA；仍需在真实 workflow run 中验收 changesets/docs/native 三条后续链。
6. SDK API Extractor、publint、pack/import smoke 已通过；`check-nix-workspace.mjs` 的 17 个递归依赖检查通过，人工核对的 23 个 workspace path/name 也与 `flake.nix` 一致。本机没有 `nix`，仍需在 Nix 环境执行最终构建。

## P1：主线后立即处理

### VSC-COLD-701：cold child-agent replay（已完成）

Session-scope `IAgentLifecycleService.restore(agentId)` 现在只对持久 metadata 中已登记的 Agent 按需 materialize scope，并复用统一创建/重放管线但不改写 durable metadata。Klient memory dispatcher、kap-server dispatcher 与 prompt route 均先读 live handle，再走 restore；未知 id 仍返回 not found。SDK public resume 和 VS Code `getResumeState()` 已通过真实 close/resume child replay 集成测试。

### RPC-CLEAN-702：清理失真 RPC 声明（已完成）

已删除零消费者、无实现和无 DI 注册的 `ISessionRPCService` / `CoreAPI` / `SessionAPI`，保留真实注册的 `IAgentRPCService` 和共享 DTO。Core、Klient、kap-server、kimi-inspect typecheck、Core build/API declaration 和 domain lint 均通过。

## P2：非阻塞债务

- deletion journal 当前每次 get/list 都全量 fold，尚无 compaction；低频路径可接受，但长期应按阈值写 compact snapshot 并保留 crash-safe replace。
- workspace skill API 是一次性快照，没有 watch/event；配置或插件 reload 后调用方需要重新 list。
- extension virtual specifier 仍有一个 allowlist；等用户扩展生态迁移后才能删除。

## 执行顺序

```text
已完成
├─ SDK-COMPAT-602/603：83/83 映射
├─ EVENT-COMPAT-606：四条事件链
├─ SDK-SEM-604：七个非等价语义
├─ RPC-CLEAN-702：删除失真 RPC facade
├─ REL-801A：legacy audit、bundle smoke、CI→release SHA gate
└─ SDK-OPTIONS-605：公开 option / breaking exceptions
            │
            ▼
当前 Wave
└─ REL-801B：Extension Host 实机、credential-free gates（代码完成，待 Linux CI）
            │
            ▼
最终全仓、Nix 与真实 release workflow 验收
```

`packages/node-sdk/src/sdk-rpc-client.ts` 已收口。后续 worker 可并行处理 CI 实机门、pack smoke 和只读 diff 审计；除非发现可复现回归，不再修改该热点。

## Kimi 蜂群任务单

当前已完成或正在执行的任务不要重复派发：

| 任务 | 状态 | 独占范围 | 完成门 |
| --- | --- | --- | --- |
| `STORE-RECON-601` | 已完成 | Core lifecycle/store/index | durable deletion reconciliation、locked retry、全量 Core 回归 |
| `VSC-601` | 已完成 | VS Code runtime/handlers | 单 v2 runtime、生产 Harness 构造为零、297 项测试 |
| `TUI-CLEAN-601/602` | 已完成 | TUI runtime/tests | runtime-neutral media port、全量 TUI 回归 |
| `MCP-AUTH-MARKER-701` | 已完成 | Core/Klient MCP schema | OAuth marker round-trip、Core/Klient 全量回归 |
| `WORKSPACE-SKILLS-702` | 已完成 | Core/Klient/kap skills | session-less read-only API、transport conformance |
| `SDK-COMPAT-602` | 已完成 | node-sdk compatibility adapter | global MCP/lifecycle/workspace skill/fork/event 第一批映射和自动覆盖报告 |
| `SDK-COMPAT-603` | 已完成 | node-sdk | 覆盖提升到 83/83；`unmapped=[]` |
| `SDK-SEM-604` | 已完成 | node-sdk + Klient cron + CLI print | 七个非等价语义冻结并验证 |
| `SDK-OPTIONS-605` | 已完成 | Core plugin + Klient + node-sdk | 1 项真实支持，3 类稳定 major exception |
| `EVENT-COMPAT-606` | 已完成 | node-sdk event projector/tests | 四条事件端到端 |
| `VSC-COLD-701` | 已完成 | Core agent lifecycle + Klient dispatcher + SDK/VS tests | cold child replay 完整恢复 |
| `RPC-CLEAN-702` | 已完成 | Core agent/rpc + API surface tests | 删除失真声明和无消费者 wrapper |
| `REL-801A` | 已完成 | scripts/workflows/package gates | legacy audit、runtime smoke、CI→release SHA gate |
| `REL-801B` | 待 CI 验收 | VS host / docker gate | VS 1.100.0 实机通过；credential-free Docker/CI 已实现，等待 Linux job |

下一轮蜂群建议：

```text
/swarm 请执行 docs/plan/v2-upgrade-remediation-plan.md 的下一轮任务。
items 为 REL-801B-CI、FINAL-GATES-AUDIT。

REL-801B-CI 只读观察新增 credential-free Docker job；失败时独占 Docker runner / workflow 修复；
FINAL-GATES-AUDIT 只读核对根 workspace、Nix、pack/import 和 changeset，不修改 sdk-rpc-client.ts。

每个任务先读取最近的 AGENTS.md 和匹配 skill。不要提交 commit，不要创建 handoff 文档。
结果必须返回：修改文件、公开语义、验证命令、测试统计、剩余 exception。
```

SDK 热点已经收口；后续 worker 不应继续修改 `sdk-rpc-client.ts`，除非最终 gate 发现可复现回归。

## 当前验证基线

| 范围 | 结果 |
| --- | --- |
| agent-core-v2 | 全量 287 files / 4371 tests；typecheck 通过 |
| Klient | 13 files；214 passed / 24 skipped；memory/IPC conformance 通过；typecheck 通过 |
| node-sdk | 29 files；264 passed / 1 todo / 0 failed；兼容覆盖 83/83；typecheck、build、双 API Extractor、publint、pack/import smoke 通过 |
| CLI e2e | 2 passed / 1 环境型 skipped；默认/显式排除 global log 的导出合同通过 |
| CLI | 全量 207 files / 2671 passed / 3 skipped；typecheck 通过 |
| TUI | 148 files / 1945 tests；typecheck 通过 |
| ACP | 39 files / 352 tests；typecheck 通过 |
| VS Code | 14 files / 297 tests；typecheck 通过 |
| VS Code cold replay | 2 passed；真实 v2 runtime 的 main + persisted child close/resume 通过 |
| VS Code Extension Host | 固定官方 CI 版本 1.100.0 在 macOS 实机通过；10 commands、webview、host exit 0 |
| kap-server prompts / rpc / sessions | prompts/rpc 62 tests 通过；sessions 单文件 57/57 通过；三个文件并发时有一次既有 10 秒 teardown timeout |
| Klient credential-free live | 空配置、真实 bearer auth v2 server：client + refresh 15 passed / 4 model-required skipped；macOS node-pty 无法作为 Linux terminal gate 的替代 |
| workspace skill slice | Core 17 + Klient 137 + kap 14 tests |
| MCP probe cwd | Core 3 tests；Klient facade/memory/IPC 137 tests |
| legacy 引用审计 | 0 violation，1 个 extension virtual-specifier allowlist |
| 根 package/typecheck | 14 个 package build/typecheck、SDK 双 API Extractor、CLI、VS Code、kimi-web 和 vis-server 均通过；根 typecheck 最终只停在并行修改中的 `apps/vis/web` |
| 根 build | package 与前端构建已通过；最终停在 `apps/kimi-desktop` 的本机 `wails: command not found`，不是 v2 package 编译错误 |
| lint / manifest | v2 范围 oxlint 0 error；`sherif` 0 issue；根 lint 仅剩并行 desktop/web/vis 的 12 个 error |
| Nix workspace | 自动检查 17/17 recursive dependencies；人工核对 23/23 workspace path/name；本机无 `nix` 命令，尚未执行 Nix build |
| diff hygiene | `git diff --check` 通过 |

SDK 既有 18 个失败分组已全部清零，根方法覆盖达到 83/83，公开 option 也已收口。按 v2 升级自身范围计算，代码实现约 **98%**；可在当前 macOS 环境实现的发布门代码已经完成。剩余是新增 Linux Docker job、Nix 和真实 release workflow 的外部验收，以及等待并行 desktop/vis 工作恢复全仓门禁。

## 工作量

按当前代码状态：

- release 实机 gate 和 credential-free CI：实现已完成，首次 Linux CI 观察/修正约 0.25～0.75 人日。
- 最终全仓/Nix/release workflow 验收：0.5～1 人日。

主线按默认假设剩余约 **0.75～1.75 人日**；蜂群并行后的现实日历时间约 **0.5～1 个工作日**。若要求 Kaos、旧 expert-team `goal/response`、pre-turn drain 和 `addAdditionalDir({persist:false})` 全部严格兼容，额外增加约 **2～4 人日**。

## 完成定义

只有以下条件全部满足，才能宣布升级完成：

- 所有第一方 executable 入口默认且唯一使用 v2。
- SDK 自动覆盖报告中没有未批准的方法；公开测试不再因 `not_implemented` 失败。
- 不能等价保留的 option/返回形状进入明确 major breaking 清单，代码不静默忽略。
- Core/Klient/SDK 的 workspace FS、Todo/context、fork/delete、MCP、skills 和事件链全部通过公开 contract。
- SDK、ACP、VS Code、CLI、kap-server 和根 workspace 的 typecheck/build/test 全部通过。
- API Extractor、publint、pack/install、ESM import、legacy audit、Nix 和 executable smoke 全部通过。
- changeset 与实际代码一致，且没有临时文件、`.bak`、内部标识或 agent handoff 文档进入 staged diff。
