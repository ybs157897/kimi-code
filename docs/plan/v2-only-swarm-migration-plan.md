# v2 全入口迁移与 legacy agent-core 清理：蜂群开发计划

> 状态：Ready for execution（执行前需完成 G0 决策）
>
> 基线日期：2026-07-28
>
> 基线分支：`agent/v2-upgrade`
>
> 预计总工作量：55–80 人日；若要求严格保留 SDK 的全部公开兼容面，风险上沿约 90 人日
>
> 建议蜂群并发：4；预计关键路径 22–32 个工作日
>
> 计划维护者：每个 Wave 的集成 owner

## 1. 结论

当前还不能称为“全部以 v2 为入口”。

- `kap-server`、Web、Desktop 和 Klient 已经以 `agent-core-v2` 为实际引擎。
- `/api/v1` 是仍在使用的 wire protocol 名称，不代表服务端仍运行 legacy engine，不应为了本迁移另造 `/api/v2`。
- TUI 和 `kimi -p` 已有可工作的 v2 路径，但默认路由仍受实验开关控制，且存在恢复权限、分页、退出 telemetry、Todo replay、图片持久化等差异。
- `kimi acp`、VSCode extension、SDK 根入口仍直接依赖 legacy `KimiHarness` / `Session`。
- `migration-legacy`、`apps/vis/server`、部分构建和测试配置仍直接引用 `@moonshot-ai/agent-core`。
- 在所有可执行引用归零前，不能删除 `packages/agent-core`。

本计划的完成顺序是：

1. 先冻结语义并建立真实组合测试。
2. 把多个宿主共同缺失的能力补到 `agent-core-v2` 和 Klient。
3. 依次把 CLI、ACP、VSCode、SDK 和辅助包切到 v2。
4. 做全仓 import/build 审计。
5. 最后单独删除 legacy package，更新 `flake.nix` 和 lockfile，并执行发布验收。

“只让入口能启动、能聊天”的机械切换约 10–15 人日，但会丢失 ACP 未保存文件、VSCode MCP、按 turn fork、物理删除、context import 等真实功能，不属于本计划定义的完成状态。

## 2. 完成定义

### 2.1 “v2-only” 的硬定义

一个入口只有同时满足以下条件，才算完成：

1. 生产代码不 import、初始化或运行 `@moonshot-ai/agent-core`。
2. Agent、Session 和 App 能力从 `agent-core-v2` 的 DI × Scope 服务取得。
3. 宿主通过 Klient facade 或明确的 host-only composition API 使用这些能力，不取得原始 scope accessor。
4. memory transport 与 IPC transport 的 JSON-safe 能力具有相同 schema、返回值和错误语义。
5. 恢复、取消、交互、持久化和关闭路径有契约测试，不只是 happy-path smoke。
6. 入口的既有用户功能已迁移，或经过明确的 breaking-change 决策后移除。

### 2.2 允许保留的 legacy 字样

以下内容不阻塞 v2-only：

- kap-server 的 `/api/v1` REST 和 WebSocket 路径。
- 为既有用户扩展保留的虚拟模块字符串 `@moonshot-ai/agent-core/extension`。它可继续映射到 v2 host API，但不得形成真实 package dependency。
- migration fixture、禁止依赖的 lint 测试和必要的历史兼容测试中的字符串。

任何 allowlist 都必须是精确文件 + 原因，不能用目录级豁免掩盖新的生产依赖。

### 2.3 最终入口矩阵

| 入口 | 当前事实 | 目标状态 | 主要完成门 |
| --- | --- | --- | --- |
| `kimi` TUI | v1/v2 双路由 | 默认且唯一走 v2 runtime + Klient | CLI-205、CLI-208 |
| `kimi -p` | v1/v2 双路由 | 默认且唯一走 v2；输出契约稳定 | CLI-201、CLI-205、CLI-208 |
| `kimi migrate` | 当前显式绕回 v1 | v2 runtime 下只运行迁移 UI | CLI-206 |
| `export/login/provider/upgrade` | 部分为使用配置或 telemetry 创建 Harness | 使用 v2/Klient 或宿主级 utility，不创建旧 Harness | CLI-207 |
| `kimi acp` | legacy SDK/Harness/Session | v2 hosted runtime + Klient + Session Workspace FS | ACP-301～ACP-305 |
| VSCode | legacy SDK/Harness/Session | 单一 v2 runtime + Klient；保持现有 webview wire | VSC-401～VSC-407 |
| node SDK 根入口 | 旧 facade；`./v2` 另存 | 根入口由 v2 支撑；兼容策略由 G0 决定 | SDK-501～SDK-506 |
| Web/Desktop | 已经由 kap-server v2 支撑 | 保持现状，回归验证 | REL-803 |
| kap-server | 已经运行 v2 | 保持 `/api/v1` wire；不回退旧 engine | REL-803 |
| `migration-legacy` | 复用旧 config/wire 类型 | 只依赖 v2 正式契约 | AUX-601 |
| `apps/vis/server` | 复用旧 wire/compaction 类型 | 使用 v2 wire contract 或自身只读 DTO | AUX-602 |
| `packages/agent-core` | 仍被多个包依赖 | 目录删除，workspace/flake/lock 同步 | CLEAN-702 |

## 3. 非目标

- 不新增 `/api/v2` 路由。
- 不借迁移重写 Web、Desktop、VSCode webview 或 ACP wire protocol。
- 不把 App 级 `IHostFileSystem` 整体替换为编辑器 reverse RPC。
- 不用 App 级 `Map<sessionId, service>` 模拟 Session scope。
- 不让 Klient 暴露 scope accessor、DI container、callback handle 或非 JSON-safe 对象。
- 不把旧 `toolStore` 继续扩散到 v2；Todo 使用明确的 typed contract。
- 不为了清理命名而同步搬动大量稳定文件。
- 不在没有用户明确确认时生成 `major` changeset。
- 不在各蜂群 worker 中分别修改 lockfile、`flake.nix` 或生成 changeset。

## 4. 架构决策

### A1. Klient 是宿主控制面的唯一 RPC facade

CLI、ACP、VSCode 和 SDK 的可序列化操作统一通过：

```text
global.*
session(sessionId).*
agent(sessionId, agentId).*
```

新增能力必须同时具备：

- zod contract；
- facade 方法；
- memory dispatcher/service registry；
- IPC 调用；
- shared conformance；
- 稳定 coded error。

不能为了赶进度让某个宿主直接访问 core scope，然后日后再补 Klient。

### A2. Scope 按状态身份决定

遵循：

```text
App lifetime > Session lifetime > Agent lifetime
```

- App：用户级配置、全局 MCP catalog、OAuth flow、session lifecycle、宿主 runtime。
- Session：工作区文件系统、Session MCP effective config、Todo、session metadata。
- Agent：context command、prompt、permission、replay、swarm。

短生命周期可以依赖长生命周期，反向依赖禁止。Session/Agent 状态不能塞进 App singleton 的 Map 伪装生命周期。

### A3. 为 ACP 新增真正的 Session Workspace FS

ACP 的编辑器内容可能尚未落盘。为了保持现有 ACP text reverse RPC 的能力，让 Read/Write/Edit 看到宿主内存中的文本，需要新增一个 Session-scoped 工作区文件系统边界。

下面只表示依赖方向，不是要在设计前锁死的完整方法表：

```ts
interface IWorkspaceFileSystem {
  readonly _serviceBrand: undefined;

  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  dispose(): Promise<void>;
}

interface IWorkspaceFileSystemFactory {
  readonly _serviceBrand: undefined;

  create(input: {
    sessionId: string;
    workDir: string;
    additionalDirs: readonly string[];
  }): IWorkspaceFileSystem;
}
```

建议位置：

- `packages/agent-core-v2/src/os/interface/workspaceFileSystem.ts`
- 一个默认 App-scoped factory，创建委托给 `IHostFileSystem` 的 Session backend
- ACP/VSCode 的 host-only factory adapter

关键约束：

- 第一个子任务是为 Read、Write、Edit、SessionFs、watch、media、agent/skill discovery 建立能力矩阵；最终 contract 必须覆盖实际需要的 `readLines`、bytes、`stat`/`lstat`、`realpath`、directory、`mkdir`、rename/remove、watch 等能力，不能以上述示意接口直接开工。
- `SessionLifecycleService.materializeSession()` 只 seed factory/context；Session descriptor 创建 backend，确保实例进入 scope disposal 队列。
- 不直接 seed 一个已经构造好的、有资源的 backend，否则 scope 关闭时可能无法自动 dispose。
- 用户工作区相关的 Read/Write/Edit、media read、session/project agent/skill source 按能力矩阵迁到该服务。
- 当前 Glob/Grep 主要通过本地 `rg` 进程读取磁盘。此迁移保持其 on-disk 语义，不承诺它们能检索尚未保存的 editor buffer；若未来需要该能力，应新增独立的 editor search capability 和估时。
- session persistence、wire、plan 文件、global config、catalog、OAuth token 和 session media-originals 继续走本地 `IHostFileSystem` / Store。
- ACP adapter 只覆盖 text read/write；bytes、stat、directory、process 按现有语义回落本地。
- 两个 Session 的 backend 必须隔离；同一 Session 的多个 Agent 必须共享。
- VSCode 继续使用 local backend 和现有 autosave-before-prompt 语义。支持 VSCode 未保存 buffer 是独立 enhancement，不是本迁移的完成门。

需要在实现前对全部 `IHostFileSystem` 注入点做行为分类。禁止机械全局替换。

### A4. 非序列化 host bridge 只存在于 runtime composition

ACP 的 `AgentSideConnection` 和 VSCode callback 不能塞入 Klient contract。

建议在 `packages/node-sdk/src/v2/runtime.ts` 提供 host-only composition：

```ts
runtime.hostedSessions.create(options, {
  workspaceFileSystemFactory,
});

runtime.hostedSessions.resume(sessionId, options, {
  workspaceFileSystemFactory,
});
```

名称可按现有 runtime 风格调整，但语义必须满足：

- callback/connection 只在同进程 composition 层存在；
- Session scope 内取得的是正式 `IWorkspaceFileSystem`；
- 普通 CLI、kap-server 和测试未提供 factory 时完全回落本地；
- host bridge 的生命周期随 Session scope 关闭。

### A5. Session lifecycle 承担 create/resume/restore/fork/delete 语义

需要补齐：

- create 透传 `sessionId`、`mcpServers`；
- resume/restore 可携带 `additionalDirs`、`mcpServers` 和 host composition；
- hard delete；
- fork-at-turn。

`resume` 已经命中 live Session 时：

- `additionalDirs` 幂等合并；
- caller MCP 只按冻结后的明确语义处理；
- 不允许静默重建整个 Session scope。

这些规则必须在 G0 冻结并由 core 测试锁定。

### A6. fork-at-turn 使用 legacy 的 user-visible turn 语义

VSCode 现有 `turnIndex` fork 不能用“完整 fork 后 undo”模拟，否则会残留后续 subagent、task、interaction、cron 和 facts。

实现原则：

- 先建立 `ISessionSnapshotStore` 或同等 App-scoped Store。
- 对外字段为兼容可继续叫 `turnIndex`，内部明确称为 `userVisibleTurnIndex`。
- 语义以 `packages/agent-core/src/session/store/session-store.ts` 的 legacy visible-input 判定为基线：从 `context.append_message` 中识别用户可见输入，使用 0-based index。
- 不得直接使用 transcript ordinal。`packages/transcript/src/history/groupTurns.ts` 的分组和 engine visible-input index 并非同一概念，隐藏 system trigger 也可能影响 transcript turn。
- 普通 prompt、用户触发 skill/plugin、shell input、injection、retry、background、cron、compaction的归类全部由移植的 legacy fixtures 锁定，不凭 UI 观感重新定义。
- Node-FS backend 才能操作路径、复制和截断；lifecycle 不直接读写 JSONL。
- 截断 main wire 后，根据 cutoff 清理 subagent、task、interaction、cron 和孤儿 agent。
- 新 session 的派生状态通过正常 cold fold 重建，不在 edge 手工拼 replay snapshot。
- 带 `turnIndex` 的 fork 在 active turn 时返回稳定 error；未带 `turnIndex` 的现有 full fork 保持当前允许 crash-consistent copy 的语义。
- 越界、负数和损坏 wire 返回稳定 error code。

### A7. hard delete 使用可恢复、幂等的领域状态机

目录树、append-only `session_index.jsonl` 和 `IQueryStore` 之间没有跨后端事务，不能承诺一次原子提交。实现必须做到：

1. 排斥并发 resume/fork/delete，并关闭或 drain live scope。
2. 为 legacy `session_index.jsonl` 正式支持 `{ sessionId, deleted: true }` 的 last-record-wins 解析。
3. 通过领域 Store 协调 tombstone、持久化树、cron/后台引用和 QueryStore projection。
4. 每一步可重复执行；失败返回 coded error，不发送成功事件。
5. 再次 delete 或启动时 reconciliation 能从中间状态继续，而不是复活已 tombstone 的 session。
6. 只有所有必要清理完成才向调用方返回成功。

新增 `ISessionIndexProjection.remove(id)` 或同等接口，lifecycle 不直接操作 QueryStore。具体操作顺序由 failure-injection 测试决定，不在 edge 固化。

### A8. MCP 按 App / Session / Agent 三层拆分

目标分层：

```text
App     IMcpServerCatalog   用户级 mcp.json CRUD
App     IMcpOAuthService    token 与 flowId 生命周期
App     IMcpProbeService    一次性连接测试
Session ISessionMcpService  配置合并与 live connection manager
Agent   IAgentMcpService    工具注册、列表与 reconnect
```

实现要求：

- 用户 MCP catalog 不是 `config.toml` section。
- `mcp.json` 写回保留未知顶层字段和 secret。
- OAuth 通过 JSON-safe `flowId` 暴露 begin/complete/cancel/reset；callback 不进入 Klient。
- App 中维护 OAuth flow map 是合理的，因为 flow 是进程级身份；Session connection 不得放在该 Map。
- Probe 使用临时 manager，成功和失败都 shutdown。
- effective config 合并优先级要用测试固定，建议为 `user < project-root < project < caller < plugin`。
- `SessionMcpService` 不再内部 `new` OAuth service。

### A9. context clear/import 是 Agent 领域命令

新增 Agent-scoped 协调服务，例如 `IAgentContextCommandService`：

- `clear()` 通过 context 的正式持久化服务清空；busy、active prompt 或 compacting 时返回 coded error，不隐式取消 prompt。
- `import({ content, source })` 校验空值、busy/compacting、XML escaping 和 context overflow。
- import 写入 durable wire，close/resume 后可重放。
- Klient 暴露 `agent.clearContext()` 和 `agent.importContext()`。

### A10. Todo 使用 typed projection

不要把 legacy `toolStore` 带入 v2。

- core/Klient 暴露 typed Todo snapshot，或在 replay 中增加明确的 `todos` 字段。
- v2 从 `ISessionTodoService` 读取。
- 过渡期 legacy TUI adapter 可从 `toolStore.todo` 映射。
- TUI/ACP/SDK 只消费 `todos`。
- 删除 legacy adapter 后，不留下兼容字段。

### A11. SDK 兼容策略是显式决策门

推荐先走“v2-backed compatibility facade”：

- SDK 根入口保留现有主要符号和调用方式；
- 内部改用 `createKimiV2Runtime()` + memory Klient；
- `./v2` 与根入口最终共享同一 runtime，不产生两套 engine；
- 对确实不能保留的边缘契约单独列出。

以下兼容点不能靠类型强转伪造：

- 同步 `createKimiHarness()` 与异步 v2 bootstrap；
- `KimiHarness` / `Session` 方法和 event 顺序；
- `SDKRpcClientBase`、`SDKRpcClient.core`；
- `Kaos` / `persistenceKaos`；
- `KimiError` 的 code 和 `instanceof`；
- 全局 MCP CRUD/OAuth/test/reset；
- physical delete、turn-index fork；
- replay/resume snapshot；
- 旧 config、logging、image 和 provider helper。

若决定删除或改变这些公开语义，SDK-501 必须暂停发布路径，向用户确认 major。实现任务可以继续做共同的 v2 能力，但不能自行写 major changeset。

## 5. 语义冻结清单（G0）

在任何默认切换或 destructive capability 合并前，由一个 owner 写契约测试并记录选择：

| 编号 | 必须冻结的问题 | 建议默认 | 状态 |
| --- | --- | --- | --- |
| G0-01 | 无环境变量时 TUI/`-p` 使用哪个 engine | v2 | 待冻结 |
| G0-02 | 是否复用 `KIMI_CODE_EXPERIMENTAL_FLAG` 作为 v1 回退 | 否；如需应急回退，新增独立、带移除期限的内部开关 | 待冻结 |
| G0-03 | `-p` 是否输出 v2 实验版本前缀 | 否；保持现有脚本输出契约 | 待冻结 |
| G0-04 | fork `turnIndex` 定义 | 移植 legacy `context.append_message` visible-input 判定；内部称 `userVisibleTurnIndex` | 待冻结 |
| G0-05 | fork active turn | indexed fork 返回稳定 `session.fork_active_turn`；full fork 保持现状 | 待冻结 |
| G0-06 | fork 后 cron/task/subagent | cutoff 后全部清理；不保留孤儿状态 | 待冻结 |
| G0-07 | delete not-found 与中断恢复 | 稳定 `session.not_found`；删除状态机幂等、可重试、可在启动时协调 | 待冻结 |
| G0-08 | live resume 再传 MCP | 不重建 scope；只执行明确、可测试的幂等更新 | 待冻结 |
| G0-09 | ACP Workspace FS 能力边界 | text read/write 走 editor；其余能力本地 fallback；Glob/Grep 仍搜磁盘 | 待冻结 |
| G0-10 | SDK 根入口兼容范围 | v2-backed compatibility facade；保留现有符号和行为，内部全切 v2；无法兼容项逐条列 breaking，禁止静默改语义 | ✅ 已确认（2026-07-28） |
| G0-11 | 默认 engine 变化的 changeset bump | 不预先确认 major；REL-802 时按实际用户影响判断 minor/patch/不生成；若仍有公开 API/配置/命令/行为不兼容，须再次请求用户授权 | ✅ 已确认（2026-07-28） |
| G0-12 | initial session metadata/title 的可见时点 | 明确是在 lifecycle create 内原子可见，还是 create 后 facade patch | 待冻结 |
| G0-13 | `reloadSession(forcePluginSessionStartReminder)` 和 print background helpers | 精确适配或列入 SDK breaking 清单 | 待冻结 |
| G0-14 | context clear 在 busy/active 时的行为 | 返回 coded error，不隐式 cancel | 待冻结 |

G0 的产物不是一篇额外 handoff 文档。应优先表现为测试名、代码中的 typed option/error，以及由 integration owner 更新的本表状态。普通 worker 只返回审计结果，不直接编辑本计划。

## 6. 总任务 DAG

```text
W0 事实与契约
├─ BASE-001 行为/API 基线
├─ BASE-002 可执行依赖审计器
├─ BASE-003 真实 runtime 组合测试骨架
└─ SDK-501 兼容决策清单
        │
        ▼
W1 v2 共享领域能力（可并行）
├─ CORE-101 Session Workspace FS
├─ CORE-102 create/resume/restore + hosted composition
├─ CORE-103 Todo + context command
├─ CORE-104 Session Store + fork-at-turn + hard delete
└─ CORE-105 MCP App/Session/Agent 分层
        │
        ▼
W2 Klient 统一收口 + CLI parity + 辅助包
├─ EDGE-201 Klient contracts/facades/transports/conformance
├─ CLI-201 print parity + CLI-202 shell lifecycle
├─ CLI-203 Todo/media + CLI-204 真实组合测试
├─ AUX-601 migration-legacy
└─ AUX-602 vis-server
        │
        ▼
W3 产品入口并行迁移
├─ CLI-205 默认 v2 + CLI-206 migrate + CLI-207 subcommands
├─ ACP-301/302 runtime、Session 和 Workspace FS
├─ VSC-401/402 runtime、event/replay/interaction
└─ SDK-502/503 v2-backed runtime、event/replay facade
        │
        ▼
W4 功能闭环
├─ CLI-208 去双栈
├─ ACP-303/304/305
├─ VSC-403/404/405/406/407
└─ SDK-504/505/506
        │
        ▼
W5 删除屏障
├─ AUX-603 direct import/build reference 清理
├─ CLEAN-701 零引用审计
├─ CLEAN-702 删除 packages/agent-core + flake/lock
└─ REL-801/802/803 全仓验证、文档、changeset、PR
```

`CORE-101` 与 `CORE-102` 在 `sessionLifecycleService.ts` 有交点；`CORE-104` 也会触及 lifecycle。蜂群可以并行完成 domain-local 实现，但 lifecycle 大文件必须由单一 integration owner 按顺序接线。

## 7. Wave 0：事实、契约和测试护栏

### BASE-001：建立入口行为矩阵

工作量：0.5–1 人日。

范围：

- `apps/kimi-code/src/cli/run-shell.ts`
- `apps/kimi-code/src/cli/run-prompt.ts`
- `apps/kimi-code/src/cli/v2/*`
- `apps/kimi-code/src/main.ts`
- `apps/kimi-code/src/cli/sub/acp.ts`
- `packages/node-sdk/src/index.ts`
- `packages/node-sdk/src/kimi-harness.ts`
- `packages/node-sdk/src/session.ts`
- `apps/vscode/src/runtime/*`

实现：

1. 只读记录每个入口是否创建 `KimiHarness`、是否创建 v2 runtime、何时 close。
2. 只读列出 resume/create/fork/delete、approval/question、MCP、context、media 的现有测试和缺口。
3. 把结果返回给 integration owner，由 owner 更新 G0 表；本任务不与 BASE-003 争用测试文件。
4. 不改产品代码或测试。

验收：

- 后续切换不依赖开发者记忆判断 parity。
- BASE-003 获得一份精确的待补测试清单。
- 没有新增普通 Markdown 调研文件。

### BASE-002：建立可执行 legacy 引用审计

工作量：0.5 人日。

审计至少覆盖：

```text
@moonshot-ai/agent-core
@moonshot-ai/agent-core/*
../agent-core/src/*
tsdown alias
tsconfig include/path
package dependency/devDependency
API Extractor bundledPackages
pnpm lock importer/link
root build filter
```

实现建议：

- 扩展现有检查脚本或增加一个小型 repo script。
- 分类输出 production import、test-only、config、manifest、allowlist。
- 精确 allowlist extension virtual specifier。
- 删除阶段前该检查是 required gate。

测试：

- 一个真实禁止 fixture 会失败。
- extension virtual specifier allowlist 不失败。
- package manifest 和 tsdown alias 不能逃过检查。
- `apps/vis/package.json` 的 build filter 和 `apps/vscode/scripts/watch-extension.mjs` 的 source directory 不能逃过检查。

### BASE-003：真实 runtime 组合测试骨架

工作量：1–2 人日。

当前很多 CLI 测试 mock `createKimiV2Runtime()`，只能证明路由和 adapter。新增测试应使用真实 v2 runtime + memory Klient，并用 deterministic fake model/provider：

- create；
- resume；
- continue 跨页；
- prompt + event + replay；
- approval/question；
- close；
- error cleanup。

优先复用：

- `packages/node-sdk/test/v2-runtime.test.ts`
- `apps/kimi-code/test/cli/run-v2-print.test.ts`
- `apps/kimi-code/test/tui/kimi-tui-startup.test.ts`

不要让真实模型是否主动调用 `AgentSwarm` 成为硬断言。AgentSwarm 的工具独占、spawn 和 trigger 退出由 core deterministic tests 验证。

### SDK-501：公共 API 与兼容决策

工作量：1 人日。

对以下文件形成符号、签名、默认值、错误、事件顺序和持久化语义基线：

- `packages/node-sdk/src/index.ts`
- `packages/node-sdk/src/types.ts`
- `packages/node-sdk/src/events.ts`
- `packages/node-sdk/src/kimi-harness.ts`
- `packages/node-sdk/src/session.ts`
- `packages/node-sdk/src/rpc.ts`
- `packages/node-sdk/src/sdk-rpc-client.ts`
- `packages/node-sdk/src/auth.ts`
- `packages/node-sdk/src/config-rpc.ts`
- `packages/node-sdk/src/catalog.ts`
- `packages/node-sdk/src/kimi-code-model-provider.ts`

本任务只读输出：

- 兼容保留；
- 可由 v2 精确适配；
- 仅仓内使用、可迁移后删除；
- 无法保留、需 major 确认。

由 integration owner 把确认结果写入 G0-10～G0-13，或同步到正式 issue/PR checklist。不得以“package 目前 private”为理由跳过公开 DTS 和 bundle 审计。

## 8. Wave 1：共享 v2 能力

所有 `packages/agent-core-v2` 任务都必须遵守 `agent-core-dev`：

- 一个 Service contract + 一个 implementation；
- `_serviceBrand`；
- 唯一 decorator；
- `registerScopedService()`；
- 只从 package root 做精确 leaf export；
- 不在 domain 中直接 `new` Service；
- 业务层不 import edge；
- Store → Storage → backend；
- coded error；
- 测试通过 interface 从 scope 解析 SUT。

### CORE-101：Session Workspace FS

工作量：3–4 人日。风险：高。

主要文件：

- 新增 `packages/agent-core-v2/src/os/interface/workspaceFileSystem.ts`
- 新增默认 factory/backend domain
- `packages/agent-core-v2/src/app/sessionLifecycle/sessionLifecycleService.ts`
- `packages/agent-core-v2/src/session/sessionFs/fsService.ts`
- `packages/agent-core-v2/src/session/sessionFs/fsWatchService.ts`
- `packages/agent-core-v2/src/agent/tools/os/read/readTool.ts`
- `packages/agent-core-v2/src/agent/tools/os/write/writeTool.ts`
- `packages/agent-core-v2/src/agent/tools/os/glob/globTool.ts`
- `packages/agent-core-v2/src/agent/tools/os/grep/grepTool.ts`
- `packages/agent-core-v2/src/agent/tools/edit/editTool.ts`
- `packages/agent-core-v2/src/agent/tools/read-media-file/readMediaFileTool.ts`
- session/project agent/skill source、profile context、session init 中属于用户工作区的读取点

实现步骤：

1. 列出全部 `IHostFileSystem` 消费点，并按“工作区 / persistence / global config / runtime assets”和所需方法分类。
2. 写 contract 和默认 local backend。
3. 由 Session descriptor 创建 backend 并实现 dispose。
4. 只迁移用户工作区访问。
5. 把 `app/edit/fileEditService.ts` 中纯编辑算法与 Session IO 分离，防止 App service 反向依赖 Session。
6. 提供 fake backend，验证未保存文本。

测试：

- 两 Session backend 隔离；
- 同 Session 多 Agent 共享；
- close 后 dispose 一次；
- persistence/config 仍走 local；
- 无 host capability 时本地行为不变；
- read/write/edit 能看到 fake editor 内存文本；
- Glob/Grep 的 on-disk 行为与迁移前一致，不宣称可见未保存 buffer；
- additionalDirs 的访问规则不回归。

完成门：

- 不能出现 App `Map<sessionId, fs>`。
- 不能把整个 `IHostFileSystem` 在 Session scope 中 shadow。
- scope disposal 测试通过。

### CORE-102：create/resume/restore 与 hosted composition

工作量：1.5–2.5 人日。

主要文件：

- `packages/agent-core-v2/src/app/sessionLifecycle/sessionLifecycle.ts`
- `packages/agent-core-v2/src/app/sessionLifecycle/sessionLifecycleService.ts`
- `packages/node-sdk/src/v2/runtime.ts`
- `packages/agent-core-v2/test/app/sessionLifecycle/sessionLifecycle.test.ts`
- `packages/node-sdk/test/v2-runtime.test.ts`

实现：

- 增加 typed `ResumeSessionOptions`、`RestoreSessionOptions`。
- create 保留并真正透传 `sessionId`、`mcpServers`。
- 按 G0-12 处理 initial `title` / `metadata`，避免 create event 与随后 patch 之间出现无意的半初始化可见状态。
- resume/restore 透传 `additionalDirs`、`mcpServers`。
- materialize 接受 CORE-101 的 host factory/context。
- runtime 增加同进程 hosted session API，不污染 Klient schema。
- live Session 的重复调用语义按 G0 实现。

测试：

- preminted session id；
- create/resume/restore caller MCP；
- additionalDirs；
- cold 与 live resume；
- host bridge 生命周期；
- 普通 runtime 未提供 factory 时行为不变。

### CORE-103：Todo 与 context command

工作量：2–3 人日。

Todo 文件：

- `packages/agent-core-v2/src/session/todo/sessionTodo.ts`
- `packages/agent-core-v2/src/session/todo/sessionTodoService.ts`
- `packages/agent-core-v2/src/agent/replayBuilder/types.ts`
- `packages/agent-core-v2/src/agent/replayView/agentReplayViewService.ts`

Context 文件：

- `packages/agent-core-v2/src/agent/contextMemory/contextMemory.ts`
- `packages/agent-core-v2/src/agent/contextMemory/contextMemoryService.ts`
- 新增 Agent-scoped context command service

实现：

- 定义 typed Todo snapshot 和 replay 投影。
- `clear()` 走正式 context persistence 和 replay side effect。
- `clear()` 不隐式 cancel；busy/active/compacting 返回 coded error。
- `import()` 做 empty/source 校验、busy/compacting guard、XML escape、token/context overflow 检查和 durable append。
- 为新错误注册稳定 code。

测试：

- 未完成、全部完成和空 Todo；
- cold replay；
- clear 的 durable reset，以及 busy/active 时不取消 prompt；
- import XML escaping；
- overflow 边界；
- busy/compacting；
- close/resume 后 import 仍存在。

### CORE-104：Session Store、fork-at-turn 和 hard delete

工作量：4–6 人日。风险：最高。

建议新增：

- `packages/agent-core-v2/src/app/sessionStore/sessionSnapshotStore.ts`
- `packages/agent-core-v2/src/app/sessionStore/sessionSnapshotStoreService.ts`
- `packages/agent-core-v2/src/app/sessionIndex/*`
- `packages/agent-core-v2/src/app/workspace/workspaceAlias.ts`
- Node-FS backend
- `ISessionIndexProjection.remove(id)`

建议 Store contract：

```ts
interface ISessionSnapshotStore {
  fork(input: {
    sourceWorkspaceId: string;
    sourceSessionId: string;
    targetWorkspaceId: string;
    targetSessionId: string;
    userVisibleTurnIndex?: number;
  }): Promise<ForkSnapshotResult>;

  delete(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<void>;
}
```

实现分两次合并：

1. 先抽 Store，使现有 full fork 行为不变。
2. 再增加 turn boundary 和 delete。

测试矩阵：

- 移植 legacy `session-store.ts` 的 visible-input fixtures；
- `userVisibleTurnIndex` 0、中间、最后、负数、越界，并证明它不等于 transcript ordinal；
- prompt、shell、slash skill/plugin；
- injection、retry、background、cron、compaction；
- cutoff 前后 subagent、task、interaction、cron；
- full fork 不回归且保持现有 active-turn 语义；
- indexed fork 的 active-turn error；
- live/cold delete；
- legacy index tombstone 的 last-record-wins、read-model flag 开/关和 QueryStore projection；
- 每个删除阶段的失败注入、重试与启动 reconciliation；
- 删除失败不发送成功，完成后重复 delete 行为符合 G0；
- 并发 resume/fork/delete。

完成门：

- edge 没有直接截断 `wire.jsonl`。
- lifecycle 没有直接遍历 Node 路径。
- fork 结果可由现有 cold rebuild 正常恢复。

### CORE-105：全局 MCP 管理

工作量：3–4.5 人日。

建议新增：

- `packages/agent-core-v2/src/app/mcpCatalog/*`
- `packages/agent-core-v2/src/app/mcpOAuth/*`
- `packages/agent-core-v2/src/app/mcpProbe/*`

修改：

- `packages/agent-core-v2/src/session/mcp/sessionMcpService.ts`
- session MCP config loader/store
- OAuth 底层实现的归属和注入

方法集合至少覆盖：

- catalog list/add/update/rename/remove/reset；
- OAuth begin/complete/cancel/reset；
- probe/test；
- Session effective config merge。

测试：

- duplicate、rename、not-found；
- 保留 unknown top-level fields 和 secret；
- OAuth already-authorized、begin、complete、cancel、reset；
- probe success/failure/shutdown；
- merge precedence；
- Session close 时连接释放。

## 9. Wave 2：Klient 收口、CLI parity、辅助包

### EDGE-201：Klient 统一暴露共享能力

工作量：3–5 人日。此任务只有一个 owner。

主要文件：

- `packages/klient/src/contract/global/sessions.ts`
- `packages/klient/src/contract/session/lifecycle.ts`
- `packages/klient/src/contract/agent/services.ts`
- 新增 global MCP contract
- `packages/klient/src/core/facade/global.ts`
- `packages/klient/src/core/facade/session.ts`
- `packages/klient/src/core/facade/agent.ts`
- `packages/klient/src/transports/memory/serviceRegistry.ts`
- `packages/klient/src/transports/memory/dispatcher.ts`
- `packages/klient/src/contract/index.ts`
- Klient contract parity 和 shared conformance

暴露：

- `global.sessions.create({ sessionId, mcpServers, title, metadata, ... })`，其可见时点遵守 G0-12；
- resume/restore options；
- hard delete；
- fork `turnIndex`；
- typed Todo；
- context clear/import；
- `global.mcp.*`。

实现要求：

- contract 先行，返回 DTO 不泄露 core object。
- memory/IPC 走同一 dispatcher 语义。
- 错误按 code 映射，不按 message 分支。
- 每个列表/stream/handle 都是 wire-shaped facade。
- 不暴露 CORE-101 的 callback factory；那是 host-only runtime API。

验收：

- contract parity；
- memory 和 IPC shared conformance；
- malformed payload；
- coded error；
- close 后调用；
- build + typecheck + smoke。

### CLI-201：`kimi -p` parity

工作量：0.75–1.25 人日。

文件：

- `apps/kimi-code/src/cli/v2/run-v2-print.ts`
- `apps/kimi-code/src/cli/prompt-render.ts`
- `apps/kimi-code/test/cli/run-v2-print.test.ts`
- `apps/kimi-code/test/cli/run-prompt.test.ts`

实现：

- resume 时保存原 permission。
- success/error/interrupt 都在 runtime close 前恢复 permission。
- `--continue` 分页读取所有 session。
- cwd 比较使用规范化绝对路径。
- text 和 stream-json 保持既有输出，不增加实验前缀。
- 用 `print-background-policy.ts` 的契约测试固定 main turn 完成后等待/取消后台任务的行为，供 SDK-503 对照。

验收：

- 原 permission 不被永久写成 `auto`。
- 第二页以后的目标 session 可找到。
- cleanup 只执行一次。
- stdout/stderr snapshot 稳定。

### CLI-202：交互 shell 生命周期 parity

工作量：0.5–1 人日。

文件：

- `apps/kimi-code/src/cli/v2/run-v2-shell.ts`
- `apps/kimi-code/src/tui/kimi-tui.ts`
- `apps/kimi-code/src/tui/runtime/runtime-environment-port.ts`
- `apps/kimi-code/src/tui/runtime/klient-runtime-telemetry-adapter.ts`

实现：

- 在 runtime close 前发送 `exit` telemetry。
- 正常退出、非零退出、前台任务接管和启动失败只发送一次。
- 保持 `startup_perf`、`first_launch` 现有语义。

### CLI-203：typed Todo replay 与 runtime media port

工作量：1.5–2.5 人日。

文件：

- `apps/kimi-code/src/tui/runtime/agent-replay.ts`
- `apps/kimi-code/src/tui/runtime/agent-events-port.ts`
- `apps/kimi-code/src/tui/runtime/klient-agent-events-adapter.ts`
- `apps/kimi-code/src/tui/runtime/legacy-agent-events-adapter.ts`
- `apps/kimi-code/src/tui/controllers/session-replay.ts`
- `apps/kimi-code/src/tui/controllers/editor-keyboard.ts`
- `apps/kimi-code/src/tui/runtime/tui-runtime.ts`
- 新增 `runtime-media-port.ts` 或同等专用 port

实现：

- replay DTO 使用 `todos`。
- legacy adapter 仅在过渡期映射 `toolStore.todo`。
- controller 不读取 `host.harness.imageLimits` 或 `host.session.summary.sessionDir`。
- media port 提供 max image edge 和 session original persistence。
- v2 adapter 使用 v2 image helper + 本地 session persistence FS。

测试：

- Todo 面板恢复；
- 全完成后为空；
- 图片限制；
- original 稳定目录；
- controller 不依赖 Harness/Session。

### CLI-204：真实 CLI 组合测试

工作量：1–2 人日。

在 BASE-003 基础上覆盖：

- 环境变量未设置；
- create/resume/continue；
- `-p` text/stream-json/error；
- TUI startup/exit/replay；
- 默认路径不调用 `createKimiHarness`；
- v2 runtime 和 Klient 确实创建并关闭。

### AUX-601：`migration-legacy` 脱离 v1

工作量：1–2 人日。

主要文件：

- `packages/migration-legacy/src/steps/config.ts`
- `packages/migration-legacy/src/steps/mcp.ts`
- `packages/migration-legacy/src/sessions/workdir-bucket.ts`
- `packages/migration-legacy/src/sessions/tool-call-display.ts`
- `packages/migration-legacy/src/sessions/translator.ts`
- `packages/migration-legacy/package.json`

实现：

- MCP schema 使用 v2 contract。
- workdir bucket 使用 v2 utility。
- config migrator 从 v2 正式 registry/manifest 取得支持的 top-level keys；不能用静态旧 schema 假装动态 registry。
- resume integration 使用 v2 runtime/Klient。

验收：

- malformed/merge/conflict fixture 不回归；
- v1 数据迁移后可由 v2 cold resume；
- 跨平台 workdir bucket；
- package manifest 无旧 core。

### AUX-602：`apps/vis/server` 脱离 v1

工作量：1.5–3 人日。

主要文件：

- `apps/vis/server/src/lib/agent-record-types.ts`
- `apps/vis/server/src/lib/context-projector.ts`
- `apps/vis/server/src/lib/wire-reader.ts`
- `apps/vis/server/package.json`
- `apps/vis/server/tsdown.config.ts`
- `apps/vis/server/tsconfig.json`

实现选择：

- 优先从 v2/generated wire contract 使用稳定类型；
- 若 v2 公共 `WireRecord` 太宽，在 Vis 内维护只读兼容 DTO，并用 fixture 锁定；
- compaction 和 tool-result rendering 使用 v2 helper。

验收：

- v1.0–v1.5 fixtures 可读；
- raw vs migrated 展示正确；
- context projector 与 v2 fold 对齐；
- build/test/typecheck。

## 10. Wave 3/4：CLI 完成迁移

CLI/TUI 修改必须遵守 `write-tui`：

- `KimiTUI` 只协调；
- 复杂行为放 controller；
- runtime-specific 逻辑放 port/adapter；
- tests 放在对应现有测试文件；
- 不引入泛化 UI 重构。

### CLI-205：默认切到 v2

工作量：0.5–1 人日。

文件：

- `apps/kimi-code/src/cli/run-shell.ts`
- `apps/kimi-code/src/cli/run-prompt.ts`
- `apps/kimi-code/src/cli/options.ts`
- `apps/kimi-code/src/cli/commands.ts`
- `apps/kimi-code/src/cli/experimental-v2.ts`

实现：

- 无环境变量时直接进入 v2 runner。
- `--agent` / `--agent-file` 在 `-p` 下默认可用。
- 删除帮助中的“v2 experimental”描述。
- 不把全局实验开关反转成 v1 开关。
- 如确有回退需求，使用单独内部开关，注明 owner、删除日期和 telemetry；CLEAN-701 前必须移除或重新审批。

验收：

- 无环境变量的 TUI/`-p` 都走 v2。
- v1 runner 不被初始化。
- 实验总开关仍只控制真正的实验能力。

### CLI-206：`migrate` 走 v2

工作量：0.5–1 人日。

文件：

- `apps/kimi-code/src/main.ts`
- `apps/kimi-code/src/cli/run-shell.ts`
- `apps/kimi-code/src/cli/v2/run-v2-shell.ts`

实现：

- 传递 `ignoreMarker: true`。
- 支持“无内容可迁移”的既有消息。
- 把 `migrateOnly` 传给 TUI。
- 只显示迁移流程，不创建聊天 Session。
- 所有退出路径关闭 v2 runtime。

### CLI-207：非 ACP 子命令

工作量：3–5 人日，可拆四个 item。

| 子任务 | 文件 | 目标 |
| --- | --- | --- |
| CLI-207A Export | `src/cli/sub/export.ts` | 使用 `global.sessionExport` / sessions |
| CLI-207B Login | `src/cli/sub/login-flow.ts` | 使用 `global.auth` |
| CLI-207C Provider | `src/cli/sub/provider.ts` | 使用 `global.config` + model/provider facade |
| CLI-207D Upgrade | `src/main.ts`、upgrade helpers | 不为 config/telemetry 创建 Harness |

约束：

- 可以抽一个薄的 v2 runtime/Klient lifecycle helper。
- 简单子命令不得无故创建 Agent/Session scope。
- Provider config shape 必须显式转换，不用 `as` 绕过。

### CLI-208：删除 CLI/TUI 双栈

工作量：2.5–4 人日。

顺序：

1. 删除 `run-shell.ts`、`run-prompt.ts` 的 v1 runner 主体。
2. 删除 `apps/kimi-code/src/cli/prompt-session.ts`。
3. 删除 `apps/kimi-code/src/tui/runtime/legacy-*.ts`。
4. 删除 `createLegacyTUIRuntime` 和 legacy session composer。
5. 删除 `KimiTUI` 构造参数中的 `KimiHarness` 和原始 `Session`。
6. 收紧 TUI runtime port types。
7. 删除 legacy-only tests；保留 port contract 和 Klient adapter tests。

完成检查：

```bash
rg -n "createKimiHarness|createLegacyTUIRuntime|legacy-" \
  apps/kimi-code/src/cli apps/kimi-code/src/tui
```

生产范围应无命中。

## 11. Wave 3/4：ACP 迁移

总工作量：6–9 人日。各子任务存在少量同文件协作，但人日预算按下面分项汇总，不以并行抵扣。

### ACP-301：runtime-neutral host contract

工作量：1–1.5 人日。

主要文件：

- `packages/acp-adapter/src/server.ts`
- `packages/acp-adapter/src/session.ts`
- `packages/acp-adapter/src/types.ts`
- 新增 `AcpHost` / `AcpSessionHost` contract

实现：

- ACP protocol 层不再接收 `KimiHarness` / legacy `Session`。
- contract 只包含 ACP 所需的 create/load/list/prompt/cancel/config/event/interaction 操作。
- 现有协议测试改用 fake host，不依赖具体 engine。
- 不让 ACP 包依赖 TUI adapter。

验收：

- wire 输出不变。
- protocol tests 可在无 engine 情况运行。
- 不在 contract 中暴露 Klient 或 core 私有对象。

### ACP-302：v2 hosted runtime、Session 和 Workspace FS

工作量：2–2.5 人日。

主要文件：

- `packages/acp-adapter/src/server.ts`
- `packages/acp-adapter/src/session.ts`
- 新增 `packages/acp-adapter/src/acp-workspace-file-system.ts`
- 替代 `packages/acp-adapter/src/kaos-acp.ts`
- `apps/kimi-code/src/cli/sub/acp.ts`

实现：

- CLI 创建一个 `KimiV2Runtime`。
- adapter 持有 Klient，不持有旧 Harness。
- new/load/resume/list/cancel 使用 lifecycle facade。
- preminted `sessionId`、caller MCP、cwd、additionalDirs 正确透传。
- `AgentSideConnection` bind 到 Session factory。
- text read/write reverse RPC 保持当前语义，其余能力 local fallback。

测试：

- new/load/resume/list；
- MCP forward；
- sessionId；
- 两 Session 文件隔离；
- 未保存文件 Read/Edit；
- close/dispose。

### ACP-303：prompt、event、interaction 和 replay

工作量：2–2.5 人日。

实现：

- `agent.events` → ACP chunk/tool-call/update。
- Session interaction service → approval/question response。
- `agent.replay.read()` → load/resume 初始状态。
- prompt/cancel/compact/task/plan/permission/model/thinking/skills 映射到 Klient。
- 保持 ACP event 顺序和 error mapping。

重点测试：

- approval/question/cancel/prompt；
- streaming tool input/progress/result；
- plan review；
- replay、load 与 resume 的差异；
- handler error；
- close 以后不再发送事件。

### ACP-304：MCP、配置和 slash

工作量：0.75–1.5 人日。

文件：

- `packages/acp-adapter/src/mcp.ts`
- `packages/acp-adapter/src/model-catalog.ts`
- `packages/acp-adapter/src/slash.ts`
- `packages/acp-adapter/src/config-options.ts`

实现：

- MCP 类型切到 v2/Klient contract。
- model alias helper 局部化或使用新正式 owner。
- slash skill resolver 使用 Klient。
- 不再 import old `ProviderType` 等类型。

### ACP-305：切入口和删依赖

工作量：0.5–1 人日。

完成门：

- `apps/kimi-code/src/cli/sub/acp.ts` 不创建 Harness。
- `packages/acp-adapter` manifest、tsconfig、tsdown 无旧 core/Kaos alias。
- ACP typecheck/test/build。
- 使用真实 ACP client 做 new/load/resume、approval/question、未保存文件和 MCP smoke。

若要删除公开的 `runAcpServer(harness)` 签名，必须归入 SDK-501 breaking 清单，不能在本任务中顺手删除。

## 12. Wave 3/4：VSCode 迁移

总工作量：11–17 人日。并行只缩短日历时间，不减少下面分项的人日。

### VSC-401：runtime composition

工作量：2–3 人日。

主要文件：

- `apps/vscode/src/runtime/kimi-runtime.ts`
- `apps/vscode/src/runtime/session-runtime.ts`
- `apps/vscode/src/handlers/types.ts`
- `apps/vscode/src/KimiWebviewProvider.ts`

实现：

- extension host 只创建一个 `KimiV2Runtime`。
- `SessionRuntime` 只保存 Klient session/agent handle 和 host UI state。
- 保留 `runExclusiveAfterCancelling`、host action 和 baseline 生命周期。
- 定义后续 event/handler 所依赖的最小接口，避免两组 worker 同时反复改 `SessionRuntime`。

### VSC-402：event、replay 和 interaction

工作量：2–3 人日。

文件：

- `apps/vscode/src/runtime/event-adapter.ts`
- `apps/vscode/src/runtime/replay-adapter.ts`
- `apps/vscode/src/runtime/reverse-rpc.ts`
- `apps/vscode/src/runtime/legacy-approval.ts`
- `apps/vscode/src/runtime/tool-display.ts`

实现：

- Klient event hub → 现有 webview event protocol。
- replay view → baseline 和 webview 初始状态。
- `reverse-rpc.ts` 中的 approval/question → Session interaction service。
- 保持现有 autosave-before-prompt 行为，并使用 CORE-101 的默认 local backend；本计划不增加 VSCode 文件 reverse RPC。
- 保持 webview/shared wire 不变，降低前端回归面。

### VSC-403：基础 handlers

工作量：2–3 人日。

文件：

- `handlers/auth.handler.ts`
- `handlers/config.handler.ts`
- `handlers/chat.handler.ts`
- `handlers/workspace.handler.ts`
- model/provider 相关 handler

实现：

- auth/config/model 映射现有 `global.auth`、`global.config` 和 `global.kosong.*`。
- prompt/cancel/permission/plan/compact/skill/add-dir 映射 Klient。
- secret mask/restore 保留在 VSCode edge，不下沉 engine。

### VSC-404：context slash commands

工作量：1–1.5 人日。

文件：

- `apps/vscode/src/handlers/slash-command.ts`
- context utility

实现：

- `/clear` 使用 `agent.clearContext()`。
- `/import` 使用 `agent.importContext()`。
- 从另一个 session 导入时先通过正式 replay/export API取得内容，再调用 import。
- 保留 busy、active、overflow 和错误提示；`/clear` 不隐式取消正在运行的 prompt。

### VSC-405：session list/fork/delete

工作量：1.5–2.5 人日。

文件：

- `apps/vscode/src/handlers/session.handler.ts`
- `apps/vscode/src/utils/session-context.ts`

实现：

- list/resume/archive/restore/full fork 使用 lifecycle facade。
- turn-index fork 使用 CORE-104。
- physical delete 使用 CORE-104。
- handler 不读写 session 目录。

### VSC-406：MCP handler

工作量：1.5–2 人日。

文件：

- `apps/vscode/src/handlers/mcp.handler.ts`

实现：

- list/add/update/rename/remove/reset → `global.mcp.catalog`。
- login/reset → OAuth flowId API。
- test → probe API。
- webview DTO 转换留在 handler。

### VSC-407：验证与清理

工作量：1–1.5 人日。

验收：

- runtime、SessionRuntime、handler、replay/resume、workspace path 和 bridge tests。
- typecheck、unit tests、build、extension-host smoke。
- `apps/vscode` 生产代码和 `tsdown.config.ts` 无旧 SDK root/core alias。
- Webview protocol snapshot 不因 engine 切换无意变化。

## 13. Wave 3/4：SDK 根入口 v2-backed

推荐兼容路径总工作量：14–22 人日，其中 CORE/EDGE 的共享能力不重复计算时，SDK 自身约 10–16 人日。严格兼容 `Kaos`、`SDKRpcClient.core` 等全部边缘公开结构时，额外增加 6–10 人日。

### SDK-502：v2-backed runtime/RPC

工作量：4–6 人日。

文件：

- `packages/node-sdk/src/sdk-rpc-client.ts`
- `packages/node-sdk/src/rpc.ts`
- `packages/node-sdk/src/kimi-harness.ts`
- `packages/node-sdk/src/session.ts`
- `packages/node-sdk/src/v2/runtime.ts`

实现：

- `SDKRpcClient` 不再创建 legacy `KimiCore`。
- 内部使用一个 v2 runtime + memory Klient。
- 若保留同步 `createKimiHarness()`，内部保存 lazy `ready` Promise；每个需要 engine 的方法等待初始化。
- create/resume/fork/list/export/config/plugin/goal/task 逐项显式投影。
- 按 G0-13 处理 `reloadSession(forcePluginSessionStartReminder)`；无法精确适配时列入 breaking 清单。
- close 按 Session → Klient → telemetry → scope 顺序幂等关闭。
- 不用 `as unknown as` 伪造兼容。

### SDK-503：event、interaction 和 replay compatibility

工作量：3–5 人日。

文件：

- `packages/node-sdk/src/events.ts`
- `packages/node-sdk/src/types.ts`
- `packages/node-sdk/src/rpc.ts`
- `packages/node-sdk/src/session.ts`

实现：

- v2 event → 旧 SDK Event union。
- interaction stream → approval/question handlers。
- handler 注册、替换、异常和 Session close 清理。
- `agent.replay.read()` → `ResumedSessionState`。
- cold resume/live event 的竞态、顺序和去重。
- `waitForBackgroundTasksOnPrint` / `handlePrintMainTurnCompleted` 与 CLI-201 的 background policy 对齐，或明确列入 breaking 清单。
- v2/Klient coded error → `KimiError`。

重点测试：

- `session-prompt-events.test.ts`
- `session-event-types.test.ts`
- `session-approval-handler.test.ts`
- `session-question-handler.test.ts`
- `session-plan-compact-usage-resume.test.ts`
- `session-background-tasks.test.ts`
- `list-sessions.test.ts`
- `create-session-transport.test.ts`

### SDK-504：host utilities、errors 和 public types

工作量：2–4 人日。

分类处理：

| 能力 | 建议 owner |
| --- | --- |
| home/config path、proxy dispatcher | v2 或 SDK host utility 薄封装 |
| process-level logging | SDK host utility 或 CLI；不能假装成 scoped v2 logger |
| image compression/persistence | v2 helper + Node edge wrapper |
| config string/safe load | 动态 config registry 的正式 adapter |
| `KimiError` | SDK 兼容 class + Klient boundary mapper |
| auth facade | Klient auth + SDK custom OAuth wrapper |
| model alias/provider helper | 新正式 owner或 SDK 局部 compatibility |

约束：

- 不新建一个“legacy helper 垃圾桶”。
- 只被 CLI 使用的启动工具优先下沉到 CLI。
- 多宿主真正共用的 Node helper 才留在 SDK。

### SDK-505：root exports、DTS 和 bundle

工作量：1–2 人日。此任务只有一个 owner。

文件：

- `packages/node-sdk/src/index.ts`
- `packages/node-sdk/src/v2/index.ts`
- `packages/node-sdk/package.json`
- `packages/node-sdk/tsdown.config.ts`
- `packages/node-sdk/scripts/build-dts.mjs`
- `packages/node-sdk/api-extractor.json`
- `packages/node-sdk/tsconfig.json`
- `packages/node-sdk/tsconfig.dts.json`
- `packages/node-sdk/vitest.config.ts`

实现：

- 移除旧 core alias、DTS source directory 和 bundled package。
- 根入口和 `./v2` 共享同一实现。
- 对比迁移前后 public DTS。
- 构建产物不能 import 或 bundle legacy core。

### SDK-506：SDK 和下游回归

工作量：2–4 人日。

要求：

- 现有 SDK contract tests 优先保留，只替换 engine fixture。
- 18 个 examples 至少全部 typecheck。
- 核心 smoke 示例运行。
- CLI、ACP、VSCode 在兼容路径下不依赖 legacy facade。
- 根 `dist` 做静态 import/bundle 审计。

若选择 breaking 路径：

1. CLI/ACP/VSCode 必须先全部脱离旧 Harness API。
2. 根入口成为正式 v2 runtime/Klient SDK。
3. `./v2` 临时作为同实现 alias。
4. 删除旧 facade、tests 和 examples。
5. 写 major 前再次取得用户明确确认。

## 14. Wave 5：辅助引用与 legacy package 删除

### AUX-603：清理 direct imports 和 build references

工作量：1 人日。

重点：

- `packages/acp-adapter` 的 model/MCP 旧类型。
- `apps/vscode/tsdown.config.ts`。
- `apps/vscode/scripts/watch-extension.mjs` 中的 legacy source directory。
- `apps/kimi-code/tsconfig*.json`。
- `apps/vis/server/tsconfig.json`。
- `apps/vis/package.json` 的 `build:deps` filter。
- `packages/node-sdk` 的 build/DTS/vitest/API Extractor。
- v2 tests 中把旧 tool class 当对照实现的相对 import。
- root build filter。

旧 `prompt-modules.d.ts` 等价声明应迁到仍存在的 owner，不得为了一个 ambient type 保留整个 package。

### CLEAN-701：零引用审计

工作量：0.5–1 人日。

必须分别检查：

```bash
rg -n "from ['\"]@moonshot-ai/agent-core(?:/[^'\"]*)?['\"]|import\\(['\"]@moonshot-ai/agent-core" \
  apps packages

rg -n "@moonshot-ai/agent-core|packages/agent-core" \
  --glob 'package.json' --glob 'tsconfig*.json' --glob '*config.*' \
  --glob '*.nix' --glob '*.mjs' --glob '*.yaml' --glob '*.yml'
```

然后运行 BASE-002 的审计脚本。所有剩余命中必须逐条归类为：

- extension virtual specifier；
- fixture；
- lint 禁止模式；
- 必须修复。

### CLEAN-702：删除 `packages/agent-core`

工作量：1–2 人日。必须是独立提交/阶段。

顺序：

1. CLEAN-701 通过。
2. 删除 `packages/agent-core`。
3. `pnpm-workspace.yaml` 使用 `packages/*`，不新增人为 exclusion。
4. 从 `flake.nix.workspacePaths` 删除 `./packages/agent-core`。
5. 从 `flake.nix.workspaceNames` 删除 `@moonshot-ai/agent-core`。
6. 更新 `pnpm-lock.yaml`，移除 importer/link/dependency edges。
7. 更新旧 build filter。
8. 手工核对 flake 两个列表与实际 workspace。
9. 运行 `scripts/check-nix-workspace.mjs`，但不把它当作唯一证明。

删除失败或验证失败时，不使用 `git reset --hard`；修复当前阶段或回退该独立提交。

## 15. 蜂群执行规则

### 15.1 使用方式

Kimi 的用户入口是：

```text
/swarm
/swarm on
/swarm off
/swarm <task>
```

模型真正调用的工具名是 `AgentSwarm`。

重要语义：

- `/swarm <task>` 只是进入 task trigger 并发送普通用户 prompt；模型随后决定是否调用 `AgentSwarm`。
- 一次响应中 `AgentSwarm` 必须是唯一工具调用。
- 有 `items` 时，`prompt_template` 必须包含精确的 `{{item}}`。
- 没有 `resume_agent_ids` 时至少需要 2 个 items。
- task/tool trigger 在该 turn 结束后自动退出；`/swarm on` 的 manual trigger 持续到 `/swarm off`。
- 失败或未完成 worker 使用 `resume_agent_ids` 恢复，不要重复创建相同任务。

建议设置：

```bash
export KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY=4
```

四并发是为本计划的共享热点和集成吞吐选择的上限，不是工具能力上限。

### 15.2 每个 worker 的统一契约

每个编码 worker 必须：

1. 阅读根 `AGENTS.md` 和最近的目录级 `AGENTS.md`。
2. `agent-core-v2` 任务使用 `agent-core-dev`；TUI 任务使用 `write-tui`；写/审测试时遵守 test skill。
3. 先核对任务对应源码，代码事实高于本计划。
4. 只修改任务列出的 ownership 范围；发现必须跨 hotspot 时先返回 integration owner。
5. 先写/更新契约测试，再实现。
6. 跑最小相关测试和 typecheck。
7. 返回：状态、改动文件、关键设计、测试命令与结果、未解决风险、可能冲突。
8. 不创建 handoff/notes Markdown，不生成 changeset，不改 lockfile/flake。普通 worker 不修改本计划；只有 Wave integration owner 可更新 G0 状态和执行进度。
9. 不提交真实内部 identifier、token、个人路径或 secret。

推荐通用 `prompt_template`：

```text
阅读 docs/plan/v2-only-swarm-migration-plan.md，执行任务 {{item}}。
先阅读根和最近的 AGENTS.md，并使用该任务要求的 skill。
只修改该任务的 ownership 范围；共享 hotspot 留给 integration owner。
从契约测试开始，完成实现并运行相关 typecheck/test。
不要修改 lockfile、flake.nix、changeset 或计划文档，不要创建 handoff 文件。
最后返回状态、改动文件、实现决策、测试结果、风险和冲突。
```

### 15.3 热点文件所有权

以下文件/区域同一时刻只能有一个 owner：

| Hotspot | Owner |
| --- | --- |
| `sessionLifecycleService.ts` 及其主测试 | core lifecycle integration owner |
| `packages/agent-core-v2/src/index.ts` 和跨 domain export 接线 | core lifecycle integration owner |
| Klient `facade/{global,session,agent}.ts` | EDGE-201 |
| Klient `contract/index.ts`、registry、dispatcher、parity/conformance | EDGE-201 |
| `packages/node-sdk/src/v2/runtime.ts` | runtime composition owner |
| `packages/node-sdk/src/index.ts` 和 build/DTS config | SDK-505 |
| `apps/kimi-code/src/main.ts` | CLI integration owner |
| VSCode `SessionRuntime` public interface | VSC-401 |
| package manifests、`pnpm-lock.yaml`、`flake.nix` | CLEAN-702 / release owner |
| changesets、用户文档和 PR 描述 | REL-802 |

能力 worker 可以添加 domain-local contract/implementation/test；需要接入 hotspot 时在结果中给出精确接线清单，由 owner 完成。

### 15.4 合并纪律

- 每个 capability 形成可独立验证的小提交。
- 不在一个提交同时做 default cutover 和删除旧 package。
- 不在不同 worker 中机械格式化同一大文件。
- 每次合并后由 integration owner 跑受影响包的 typecheck/test。
- 出现冲突时以接口契约和测试为准，不用“保留两套实现”规避冲突。
- 删除 legacy adapter 必须晚于 v2 adapter 的真实组合测试。

## 16. 可直接使用的 `/swarm` 波次提示词

下面的 prompt 假设当前分支已同步前一 Wave，并且工作区没有未归属改动。

### Wave 0：审计和基线

```text
/swarm 请执行 docs/plan/v2-only-swarm-migration-plan.md 的 Wave 0。
本轮只调用一次 AgentSwarm，model=primary。
items 为 BASE-001、BASE-002、BASE-003、SDK-501。
prompt_template 使用计划 15.2 的统一模板，并要求所有任务只做基线/测试/审计，不改变产品行为。
```

Ownership：

- `BASE-001` 和 `SDK-501` 只读，不修改测试。
- `BASE-002` 独占审计脚本和其 fixture。
- `BASE-003` 独占真实 runtime fixture 及相关 CLI/SDK 测试。
- swarm 返回后，由 integration owner 单独更新 G0 表。

预期工具载荷：

```json
{
  "description": "建立 v2 全入口迁移的行为、依赖和 SDK 兼容基线",
  "subagent_type": "coder",
  "prompt_template": "阅读 docs/plan/v2-only-swarm-migration-plan.md，执行任务 {{item}}。遵守第 15.2 节；本轮只做基线、测试和审计，不改变产品行为。",
  "items": ["BASE-001", "BASE-002", "BASE-003", "SDK-501"],
  "model": "primary"
}
```

### Wave 1A：共享 core domain

```text
/swarm 执行计划 Wave 1A。
只调用一次 AgentSwarm，items 为 CORE-101、CORE-103、CORE-104、CORE-105。
每个 worker 只实现 domain-local Service/Store 和测试，不编辑 Klient hotspot。
CORE-101/104 不直接接线 sessionLifecycleService.ts，而是在结果中给 lifecycle owner 精确接线清单。
```

### Wave 1B：lifecycle 与 host composition 集成

此处有严格 barrier，拆成三个 turn：

1. 单一 lifecycle integration owner 执行 CORE-102，并接线 CORE-101/104；这一 turn 不启动并发 swarm。
2. owner 完成并跑 targeted tests 后，再执行：

```text
/swarm 只读审查已经完成的 CORE-102 lifecycle 集成。
items 为 CORE-SCOPE-DISPOSE-REVIEW、CORE-STORE-ERROR-REVIEW、CORE-LIFECYCLE-TEST-REVIEW。
所有 worker 只读，返回精确文件和问题，不修改代码。
```

3. 在下一 turn 恢复 integration owner 修复 review 结果并重跑测试。review 与修复不得放在同一个 AgentSwarm。

### Wave 2A：Klient、CLI parity、辅助包

```text
/swarm 执行计划 Wave 2A。
items 为 EDGE-201、CLI-201+CLI-202、AUX-601、AUX-602。
EDGE-201 独占所有 Klient hotspot；其他 worker 不编辑 packages/klient。
每项完成相关 package 的 typecheck/test。
```

### Wave 2B：TUI replay/media 与真实组合

先完成实现：

```text
/swarm 执行计划 Wave 2B。
items 为 CLI-203-TODO、CLI-203-MEDIA、CLI-204-INTEGRATION。
前两项分别拥有 session-replay 和 editor-keyboard，不能交叉修改。
```

合并并跑完 targeted tests 后，下一 turn 再执行：

```text
/swarm 只读审查已经合并的 Wave 2B。
items 为 W2-TUI-BOUNDARY-REVIEW、W2-COMPOSITION-REVIEW。
分别检查 TUI controller 的 engine 依赖，以及真实 runtime fixture 是否仍被 mock escape；不要修改代码。
```

review 与实现不得在同一个 AgentSwarm。

### Wave 3：四条产品线并行

```text
/swarm 执行计划 Wave 3。
items 为 CLI-205+CLI-206+CLI-207、ACP-301+ACP-302、VSC-401+VSC-402、SDK-502+SDK-503。
所有 worker 只能消费已经合并的 Klient contract，不得各自新增临时 facade 或 scope escape hatch。
```

### Wave 4A：ACP、VSCode、SDK 功能闭环

```text
/swarm 执行计划 Wave 4A。
items 为 ACP-303+ACP-304、VSC-403+VSC-404、VSC-405+VSC-406、SDK-504。
VSC 两个 worker 不修改 SessionRuntime 公共接口；需要变更时返回 VSC-401 owner。
```

### Wave 4B：清双栈和回归

```text
/swarm 执行计划 Wave 4B。
items 为 CLI-208、ACP-305、VSC-407、SDK-505+SDK-506。
本轮允许删除已被测试覆盖的 legacy adapter，但仍不得删除 packages/agent-core、改 lockfile/flake 或生成 changeset。
```

### Wave 5A：删除前修复与审计

此处拆成两个有 barrier 的 turn。

先修复构建和测试引用：

```text
/swarm 执行 AUX-603 的删除前引用清理。
items 为 AUX-603-BUILD-CONFIG、AUX-603-TEST-IMPORTS、AUX-603-PACKAGE-FILTERS。
各 worker 只改自己的 ownership，完成后由 integration owner 合并并运行相关测试。
```

修复全部合并后，下一 turn 才做只读审计：

```text
/swarm 执行 CLEAN-701 删除前零引用审计。
items 为 CLEAN-701-PRODUCTION、CLEAN-701-BUILD-CONFIG、CLEAN-701-READONLY-DIFF-AUDIT。
所有 worker 只读；只要存在非 allowlist 命中，就停止删除并返回上一 turn 修复。
```

### Wave 5B：删除和发布验证

此处也拆成两个 turn：

1. 单一 integration owner 执行 CLEAN-702，删除 `packages/agent-core`，更新 flake/lock，形成独立提交；这一 turn 不启动验证 swarm。
2. 删除提交完成后，下一 turn 执行：

```text
/swarm 验证已完成的 legacy package 删除。
items 为 REL-801-CORE-KLIENT、REL-801-PRODUCTS、REL-801-PACKAGING-NIX。
worker 先只读/运行测试；发现问题时只修自己的局部 ownership，不得恢复 legacy package。
```

### 恢复未完成 worker

不要重新分派同一任务。让 Kimi 使用：

```json
{
  "description": "恢复未完成的 v2 迁移任务",
  "resume_agent_ids": {
    "<agent-id>": "继续原任务；先读取当前工作区和最新测试结果，只完成未完成部分并返回差异。"
  }
}
```

## 17. 验证门

### REL-801：分层验证

先跑最小包，再跑全仓。任何层失败都在该层修复，不用下游 snapshot 掩盖 core bug。

#### agent-core-v2

```bash
pnpm --filter @moonshot-ai/agent-core-v2 lint:domain
pnpm --filter @moonshot-ai/agent-core-v2 typecheck
pnpm --filter @moonshot-ai/agent-core-v2 test
pnpm --filter @moonshot-ai/agent-core-v2 build
```

若修改 registry/contract，运行相应 generator，并确认生成物无陈旧差异：

```bash
pnpm --filter @moonshot-ai/agent-core-v2 gen:contract-types
pnpm --filter @moonshot-ai/agent-core-v2 gen:config-manifest
pnpm --filter @moonshot-ai/agent-core-v2 gen:wire-manifest
pnpm --filter @moonshot-ai/agent-core-v2 gen:state-manifest
```

只运行与实际改动相关的 generator，不机械改写无关生成物。

#### Klient

```bash
pnpm --filter @moonshot-ai/klient typecheck
pnpm --filter @moonshot-ai/klient test
pnpm --filter @moonshot-ai/klient build
pnpm --filter @moonshot-ai/klient smoke
pnpm --filter @moonshot-ai/klient smoke:boundary
```

#### SDK / ACP / migration / Vis

```bash
pnpm --filter @moonshot-ai/kimi-code-sdk typecheck
pnpm --filter @moonshot-ai/kimi-code-sdk build
pnpm --dir packages/node-sdk exec vitest run --config vitest.config.ts

pnpm --filter @moonshot-ai/acp-adapter typecheck
pnpm --filter @moonshot-ai/acp-adapter test
pnpm --filter @moonshot-ai/acp-adapter build

pnpm --filter @moonshot-ai/migration-legacy typecheck
pnpm --filter @moonshot-ai/migration-legacy test
pnpm --filter @moonshot-ai/migration-legacy build

pnpm --filter @moonshot-ai/vis-server typecheck
pnpm --filter @moonshot-ai/vis-server test
pnpm --filter @moonshot-ai/vis-server build
```

SDK 当前没有单独的 `test` script，因此使用其既有 Vitest config；SDK-506 再决定是否补正式 script。

#### CLI / TUI

```bash
pnpm --filter @moonshot-ai/kimi-code typecheck
pnpm --filter @moonshot-ai/kimi-code test
pnpm --filter @moonshot-ai/kimi-code build
pnpm --filter @moonshot-ai/kimi-code smoke
pnpm --filter @moonshot-ai/kimi-code e2e
```

需要有效模型凭据的 `e2e:real` 只在具备环境时运行，不能代替 deterministic test。

#### VSCode

```bash
pnpm --dir apps/vscode typecheck
pnpm --dir apps/vscode test
pnpm --dir apps/vscode build
pnpm --dir apps/vscode test:extension-host
```

#### 删除后的 workspace / Nix / install

```bash
node scripts/check-nix-workspace.mjs
pnpm install --frozen-lockfile
```

还要人工确认：

- `flake.nix.workspacePaths` 与目录一致；
- `flake.nix.workspaceNames` 与 package name 一致；
- lockfile 无旧 importer/link；
- SDK/CLI/ACP/VSCode/Vis 构建产物无旧 core import；
- 可用环境下运行 `nix flake check`。

#### Root workspace gate

逐包验证通过后，再运行真正的全仓 gate：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
pnpm sherif
```

root gate 不能由前面的逐包命令替代；它还覆盖 Web、Desktop 依赖闭包、未单列 workspace 和根级规则。

### REL-802：文档、changeset 和 PR

1. 用户可见行为变化完成后，使用 `gen-docs` 更新中英文文档。
2. 提交 PR 前运行 `gen-changesets`。
3. 如任何包需要 major，先停止并向用户说明 breaking 面，得到明确确认后才写。
4. PR 标题使用 Conventional Commit。
5. 填完整 `.github/pull_request_template.md`：问题、方案、边界、测试、风险。
6. 不添加 co-author，不暴露 agent 身份。
7. PR 前让一个只读 agent 审计 diff 中的内部 identifier。
8. `git status` 和 staged stat 中不得出现 handoff、scratch、root mockup 或临时文件。

### REL-803：最终功能验收

必须手工或自动证明：

- TUI：new/resume/continue、Todo、图片、approval/question、swarm、退出。
- `-p`：text、stream-json、resume、continue、permission restore、异常。
- migrate/export/login/provider/upgrade：不创建 Harness。
- ACP：new/load/resume、未保存文本 Read/Edit、MCP、approval/question、cancel。
- VSCode：new/resume、baseline/replay、turn fork、delete、MCP OAuth/test、clear/import，以及 autosave-before-prompt。
- SDK：根入口和 `./v2` 只运行一个 v2 backend；DTS/bundle 无旧 core。
- Web/Desktop/kap-server：现有 `/api/v1` + WebSocket 回归通过。
- cold session：v2 可重建 main/subagent 状态。
- legacy package 删除后，全仓 build/test 不依赖本地残留 `dist`。

## 18. 风险登记

| 风险 | 影响 | 缓解与 gate |
| --- | --- | --- |
| Workspace FS Scope 错误 | ACP 读不到未保存文本，或 persistence 被错误远程化 | CORE-101 能力矩阵、隔离/dispose/persistence tests；Scope reviewer |
| turn-index fork ordinal 错位 | 截错 visible input，或新 Session 混入 cutoff 后 task/subagent/facts | 移植 legacy visible-input predicate；不得用 transcript ordinal；cold rebuild tests |
| hard delete 半完成 | 目录、append log 和 QueryStore 不一致 | 幂等状态机、last-record-wins、失败注入、启动 reconciliation、独立提交 |
| MCP OAuth callback 非序列化 | IPC 失效或泄露 process handle | flowId API；callback 留在 App service |
| resume MCP 语义不清 | live Session 重建连接或配置漂移 | G0 冻结；cold/live conformance |
| CLI default cutover 污染脚本输出 | 自动化用户回归 | CLI-201 snapshot；不输出 v2 实验前缀 |
| permission 未恢复 | 用户 Session 被永久改为 auto | finally 恢复；错误/中断测试 |
| SDK 同步构造与 v2 异步启动冲突 | 死锁、竞态或隐式 breaking | lazy ready + 幂等 close tests；SDK-501 决策 |
| `Kaos` 精确兼容成本过高 | 工期增加 6–10 人日 | 独立列 compatibility decision，不伪造 |
| 多 worker 编辑 Klient/lifecycle hotspot | 冲突和 transport 漂移 | 单一 EDGE/lifecycle owner |
| 过早删除旧包 | DTS、migration、Vis、tests 全线失败 | CLEAN-701 零引用硬门 |
| `flake.nix` 漏项 | Nix 构建静默丢文件或依赖失败 | 手工核对两个列表，不只依赖脚本 |
| 真实 LLM swarm 测试不稳定 | flaky CI | core deterministic AgentSwarm tests；真实模型只 smoke |

## 19. 里程碑和工作量

| 里程碑 | 内容 | 人日估算 | 完成后可宣称 |
| --- | --- | ---: | --- |
| M0 | G0、基线、审计、真实测试骨架 | 2–4 | 迁移契约已冻结 |
| M1 | Workspace FS、lifecycle、Todo/context、Store、MCP、Klient | 13–19 | v2 具备全部宿主迁移能力 |
| M2 | CLI/TUI/`-p`/子命令 v2-only | 8–13 | CLI 除 ACP 外全部 v2 |
| M3 | ACP + VSCode v2-only | 17–26 | 所有第一方产品入口 v2 |
| M4 | SDK 根入口 v2-backed + auxiliary packages | 11–17 | 仓内所有 executable consumer 脱离旧 core |
| M5 | 删除旧 package、全仓验证、发布材料 | 3–5 | repository v2-only |

里程碑预算按不重复计算共享能力的口径汇总，算术区间约 54–84 人日；考虑部分任务会在同一 vertical slice 中共同完成，计划期望值取 55–80 人日。若严格保留 `Kaos`、`SDKRpcClient.core` 等全部 SDK 边缘公开结构，增加约 6–10 人日，风险上沿约 90 人日。若用户明确批准 SDK major 并采用 breaking 路径，可下降到约 48–68 人日。

四并发也不能把人日直接除以四：

- lifecycle 和 Klient hotspot 必须串行集成；
- destructive persistence 任务需要额外 review；
- SDK DTS、lock、flake 和最终 package 删除只能最后收口；
- 完整回归通常占 3–5 个工作日。

建议对外排期：

- 第 1 周：M0 + M1 domain work。
- 第 2 周：M1 lifecycle/Klient 收口 + CLI parity + auxiliary。
- 第 3～4 周：CLI、ACP、VSCode、SDK 四线迁移。
- 第 5 周：功能闭环、去双栈、SDK exports。
- 第 6 周：删除、全仓回归、changeset/docs/PR；若出现 SDK 严格兼容或 fork 数据问题，继续使用风险缓冲。

## 20. 最终 Definition of Done

只有全部勾选后，任务才能标记完成：

- [ ] G0 每项语义都有明确选择和测试。
- [ ] 所有产品入口默认且唯一使用 v2。
- [ ] ACP 未保存工作区文本通过 Session-scoped FS 工作；Glob/Grep 的 on-disk 限制已记录。
- [ ] VSCode 保持并验证 autosave-before-prompt；未把不存在的文件 reverse RPC 当作 parity 要求。
- [ ] create/resume/restore 的 caller MCP/additionalDirs 行为一致。
- [ ] Todo、clear/import、fork-at-turn、hard delete、global MCP 已进入正式 core/Klient contract。
- [ ] Klient memory/IPC conformance 通过。
- [ ] CLI v1 runners 和 TUI legacy adapters 删除。
- [ ] ACP、VSCode 生产代码无旧 Harness/Session。
- [ ] SDK 根入口由 v2 backend 支撑，兼容决策已执行。
- [ ] migration-legacy 和 Vis 不依赖旧 core。
- [ ] executable import/build audit 除精确 allowlist 外为零。
- [ ] `packages/agent-core` 已删除。
- [ ] `flake.nix` 两个 workspace 列表和 lockfile 已同步。
- [ ] 分层测试、全仓测试、build、smoke 和可用的 Nix 检查通过。
- [ ] 用户可见文档已同步中英文。
- [ ] 已运行 `gen-changesets`；major 如适用已获得用户明确确认。
- [ ] PR diff 已做内部 identifier 只读审计。
