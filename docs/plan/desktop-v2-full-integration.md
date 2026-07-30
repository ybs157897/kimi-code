# Desktop Web 全量接入 V2 计划

状态：待实施。基线日期：2026-07-30。

本文整理 `apps/kimi-web` 在 Wails 桌面版中全量接入 V2 引擎所需的工作。这里的「全量接入」指桌面 WebView 默认只通过 Wails Bind、Go IPC 客户端和 Node.js sidecar 驱动 `agent-core-v2`，不依赖本地 kap-server，也不按方法回退到 HTTP。

普通浏览器中的 `kimi web` 已经由 kap-server 和 `agent-core-v2` 提供后端。它继续使用 `/api/v1` REST 和 WebSocket 路径，是为了保持 Web 产品协议稳定；路径中的 `v1` 不代表旧 Agent 引擎。本文只处理桌面直连传输的剩余覆盖。

## 目标架构

两种 Web 运行方式共用 `KimiWebApi`，但传输不同：

```text
普通浏览器
Vue UI → DaemonKimiWebApi → /api/v1 REST + WS → kap-server → agent-core-v2

Wails 桌面版
Vue UI → WailsKimiWebApi → window.go.main.App
       → Go ipcclient → desktopProduct → ProductFacade
       → klient / agent-core-v2 Service
```

桌面版保持以下边界：

- `apps/kimi-web` 只拥有产品类型和 wire 映射，不直接依赖 `agent-core-v2`。
- `apps/kimi-desktop/sidecar/product/facade.ts` 是桌面产品协议到 V2 Service 的反腐层（将稳定的 Web 协议转换为引擎调用）。
- `apps/kimi-desktop/product.go` 只负责 Wails Bind 和 IPC 转发，不实现业务规则。
- JSON 请求继续走通用 `ProductCall`。二进制、长流和终端帧使用专用流式桥，避免把大文件或持续输出塞进单次 JSON RPC。
- 桌面默认不启动 kap-server；`desktop_transport=0` 只保留为显式诊断开关。

## 当前覆盖

`KimiWebApi` 当前声明 80 个方法。`WailsKimiWebApi` 静态实现了其中 42 个，但专家团队的 4 个方法尚未在真实 `ProductFacade` 注册，因此当前只有 38 个方法具备端到端调用路径。这个数字只表示方法可达，不表示事件重连和终端流已经具备完整语义。

| 状态 | 数量 | 方法 |
| --- | ---: | --- |
| 端到端已接入 | 38 | `getHealth`、`getMeta`、`listSessions`、`createSession`、`updateSession`、`getSessionStatus`、`getSessionGoal`、`getSessionWarnings`、`archiveSession`、`restoreSession`、`getSessionSnapshot`、`submitPrompt`、`abortPrompt`、`respondApproval`、`respondQuestion`、`listSkills`、`listTasks`、`getGitStatus`、`connectEvents`、`listWorkspaces`、`deleteWorkspace`、`getFsHome`、模型与供应商 9 个方法、配置 2 个方法、认证 5 个方法 |
| Web 客户端已写、真实 sidecar 未接 | 4 | `listExpertTeams`、`getExpertTeam`、`activateExpertTeam`、`deactivateExpertTeam` |
| 桌面客户端尚未实现 | 38 | 会话与历史 11 个、问题 1 个、Skill/扩展 5 个、任务 2 个、终端 4 个、会话文件系统 9 个、工作区 3 个、文件存储 3 个 |

`connectEvents` 当前仍是部分实现：`subscribe` 忽略游标，`unsubscribe`、`seedSnapshot`、`bindNextPromptId`、`markSideChannelAgent` 和重连逻辑没有完整实现，终端相关回调全部为空操作。`ProductProjector` 也只覆盖第一批聊天事件，并且每次订阅都从进程内 `seq = 0` 重新开始。

## 接入原则

每个普通 JSON 方法都采用同一条路径。新增方法时，不需要增加新的 Go Bind：

1. 在 `WailsKimiWebApi` 中实现 `KimiWebApi` 方法，构造与 `DaemonKimiWebApi` 相同的 snake_case wire 参数。
2. 通过 `this.call('<method>', args)` 调用现有 `ProductCall`。
3. 在 `ProductFacade.dispatch()` 注册同名分支。
4. 在 `ProductFacade` 中解析参数、解析正确的 V2 Scope、调用 V2 Service，并返回与 kap-server 一致的 `WireEnvelope`。
5. Web 端复用 `apps/kimi-web/src/api/daemon/mappers.ts`，将 wire 结果转换为 `App*` 类型。
6. 在 `MockDesktopBridge` 中实现相同方法，使普通浏览器的 `desktop_transport=1` 预览不产生假阳性。

不要在 `WailsKimiWebApi` 中调用 `fetch` 作为临时补丁。若一个方法还没有直连实现，应继续明确报错，直到这一整条链路和测试同时落地。

### 一个普通方法的接入示例

以 `getSession` 为例，Web 客户端只负责调用和映射：

```ts
async getSession(sessionId: string): Promise<AppSession> {
  const data = await this.call<WireSession>('getSession', [sessionId]);
  return toAppSession(data);
}
```

sidecar 注册并完成 V2 投影：

```ts
case 'getSession':
  return this.getSession(this.argSessionId(args[0], ctx));
```

`ProductFacade.getSession()` 应镜像 `packages/kap-server/src/routes/sessions.ts`：

1. 使用 `ISessionIndex.get(sessionId)` 查找持久化会话。
2. 优先使用 summary 中持久化的 `cwd`，仅在缺失时通过 `IWorkspaceService` 回退。
3. 使用与列表接口相同的会话事实投影。
4. 调用 `toWireSession()`，返回与 `/api/v1/sessions/{id}` 相同的 wire。
5. 将不存在、工作区丢失等错误映射为相同的产品错误码。

其余 JSON 方法按同样规则镜像对应 kap-server handler。镜像的是 Service 调用、投影和错误语义，不是 HTTP 路由本身。

## P0：补齐核心会话闭环

P0 先消除桌面聊天、深链接和运行控制中的明确断点。这一批全部可以走现有 `ProductCall`，不需要修改 Go IPC 协议。

| Web 方法 | V2 Service /代码来源 | 接入方式 |
| --- | --- | --- |
| `getSession` | `ISessionIndex`、`IWorkspaceService`；`routes/sessions.ts` | 按会话 ID 读取 summary，恢复 `cwd`，复用 `toWireSession()` 和会话事实投影。 |
| `listMessages` | `IMessageLegacyService.list()`；`routes/messages.ts` | 原样传递分页游标、`page_size` 和角色筛选，复用 `toAppMessage()`。冷会话也必须可读。 |
| `steerPrompts` | `IAgentPromptService.steer()`；`routes/prompts.ts` | 先恢复 Session 和主 Agent，再传入 `prompt_ids`；保持 `PROMPT_NOT_FOUND` 错误。 |
| `abortSession` | `IAgentRPCService.cancel({})`；`routes/sessions.ts` | 取消当前活动 turn，空闲时保持成功的幂等语义。 |
| `compactSession` | `IAgentFullCompactionService.begin()` | 传入手动压缩来源和可选 instruction；保持 busy 与 unable 的错误映射。 |
| `undoSession` | `IAgentConversationUndoService.undo()`、`IAgentContextMemoryService`、`ISessionLegacyService.status()` | 等待 undo 完成后重新投影消息页和状态，不能只返回空成功。 |
| `forkSession` | `ISessionLifecycleService.fork()` | 创建后读取 `ISessionMetadata`/`ISessionContext`，发布 `event.session.created`。 |
| `createChildSession` | `ISessionLifecycleService.createChild()` | 保留父子标记和默认标题，并发布创建事件。 |
| `listChildSessions` | `ISessionIndex.list({ childOf })`、`IWorkspaceService` | 保留游标、页大小、busy 过滤和 `has_more` 语义。 |
| `startBtw` | `ISessionLifecycleService.resume()`、`IAuthSummaryService.ensureReady()`、`ISessionBtwService.start()` | 冷加载会话后创建 side-channel Agent，返回 `agent_id`。 |
| `dismissQuestion` | `ISessionInteractionService`、`ISessionQuestionService.dismiss()` | 先检查 pending/recently-resolved，再返回和 REST 一致的 `40909` 成功 envelope。 |
| `getTask` | `IAgentTaskService.getTask()`、`readOutput()` | 支持 `with_output` 和尾部字节上限，任务输出不可用时只返回元数据。 |
| `cancelTask` | `IAgentTaskService.stopByUser()` | 先区分不存在和已结束，保持 `TASK_NOT_FOUND`/`TASK_ALREADY_FINISHED`。 |

### 专家团队的真实 sidecar 接入

以下 4 个方法已经存在于 `WailsKimiWebApi` 和浏览器 mock，但真实 `ProductFacade.dispatch()` 没有对应 case：

- `listExpertTeams`
- `getExpertTeam`
- `activateExpertTeam`
- `deactivateExpertTeam`

实现时恢复目标 Session，并调用 `ISessionExpertTeamService.listAvailable()`、`snapshot()`、`activate()` 和 `deactivate()`。返回值继续使用现有 `toWireDefinition`/`toWireSnapshot` 形状；若这些投影只存在于 kap-server，应把纯投影复制到 sidecar 的 `builders.ts`，不要让桌面 sidecar 依赖 Fastify route。

这是最小且风险最低的一批修复，也应补一条真实 sidecar IPC 测试。当前 mock 测试会通过，但无法发现真实 `ProductFacade` 未注册的问题。

## P0：补齐事件一致性

方法覆盖完成后，事件必须能和快照收敛，否则重连、切换会话或多 Agent 时仍会出现漏消息和重复消息。

### 当前缺口

- `ProductSubscribe(sessionId, agentId)` 不接受 `epoch`/`afterSeq` 游标。
- Go 侧只有订阅，没有单会话/单 Agent 的 `ProductUnsubscribe`。
- `WailsKimiWebApi.connectEvents().unsubscribe()` 是空操作。
- `getSessionSnapshot()` 返回固定进程 epoch 和 `as_of_seq: 0`，与后续事件没有共享水位。
- `ProductProjector` 的 seq 只在单次订阅内递增，没有 journal、catch-up 或 resync。
- `markSideChannelAgent()` 是空操作，多 Agent 事件覆盖不完整。
- `ProductProjector` 只投影第一批 turn、文本、thinking、工具、usage 和 interaction 事件。

### 推荐实现

1. sidecar 为每个 `(sessionId, agentId)` 持有产品事件流状态：稳定 epoch、单调 seq 和有界 journal。
2. `getSessionSnapshot()` 从同一个状态读取 `as_of_seq` 和 epoch。
3. 将 `ProductSubscribe` 扩展为 `{ sessionId, agentId, epoch?, afterSeq? }`，journal 可覆盖时补发，不能覆盖时发 `resync_required`。
4. 增加 `ProductUnsubscribe(sessionId, agentId)`，Go 侧调用 `ipcclient.Unlisten()` 并清理 `App.subs`。
5. Web 的 `subscribe(cursor)`、`unsubscribe()`、`health()` 和 `reconnect()` 使用真实状态；断线后先恢复 IPC，再按 cursor 续订。
6. 将 kap-server 的事件投影清单与 `ProductProjector` 做逐项对照，补齐 session meta、task/subagent、Skill、专家团队、文件/终端状态等 UI 会消费的事件。
7. 对于无法增量补发的状态，明确触发 `onResync()`，由 Web 重新读取 snapshot；不要静默继续。

完成后，`seedSnapshot()` 不应再是空操作。它至少要记录当前 epoch/seq，并确保下一次 `subscribe` 从该水位开始。

## P1：工作区和结构化文件系统

这一批仍是普通 JSON RPC。所有相对路径必须继续受 Session workspace 边界约束。

| Web 方法 | V2 Service /代码来源 | 接入方式 |
| --- | --- | --- |
| `addWorkspace` | `IHostFileSystem`、`IWorkspaceService.createOrTouch()`、`IWorkspaceSessions` | 验证绝对路径存在且为目录，再创建或 touch；返回派生的 `session_count`。 |
| `updateWorkspace` | `IWorkspaceService.update()` | 只修改显示名称，不移动磁盘目录。 |
| `browseFs` | `IHostFolderBrowser.browse()` | 复用 HostFolder 的绝对路径、权限和不存在错误映射。 |
| `listDirectory` | `ISessionFsService.list()` / `listMany()` | 先 `resume()` 冷会话；保留 depth、git status 和 truncated 语义。 |
| `readFile` | `ISessionFsService.read()` | 保留 offset、length、binary、etag、mime 和大小限制。 |
| `searchFiles` | `ISessionFsService.search()` | 复用搜索上限、score 和 match positions。 |
| `grepFiles` | `ISessionFsService.grep()` | 保留 regex、大小写、超时和上下文行。 |
| `getFileDiff` | `ISessionFsService.diff()` | 返回统一 diff wire，保持 git unavailable 错误。 |

`getGitStatus` 已经直连，可作为这一批实现的参考。所有方法都应先恢复 Session，再从 Session scope 获取同一个 `ISessionFsService`，不要直接使用不受约束的 Node.js `fs`。

### 原生打开操作

`openFile`、`revealFile` 和 `openInApp` 先通过 `ISessionFsService.resolvePath()` 做 workspace 边界校验，然后执行平台操作。推荐把「解析安全路径」留在 sidecar，把「调用 Finder、编辑器或其他应用」放到 Go/Wails 层，避免 Node.js 子进程策略在 macOS、Windows 和 Linux 间分叉。

若暂时继续镜像 kap-server 的 `launchDetached()`，必须验证打包后的启动不会弹出终端窗口，并保持平台命令白名单。

## P1：文件上传、下载和会话文件 URL

以下方法不能作为普通 JSON 结果一次性返回：

- `uploadFile`
- `getFileUrl`
- `getFileBlob`
- `getFileDownloadUrl`

V2 存储由 App scope 的 `IFileService` 提供；会话内文件下载由 `ISessionFsService.resolveDownload()` 提供。真正缺失的是 WebView、Go 和 sidecar 之间的二进制传输。

### 推荐的流式桥

在现有 JSON Bind 之外增加通用流式能力：

```text
ProductStreamStart(method, argsJSON) → streamId
ProductStreamCancel(streamId)
kimi:stream event → { streamId, type: "data" | "end" | "error", chunk?, meta? }
```

实现顺序：

1. 为 `internal/ipcclient.Client` 增加 `Stream()` 和 `StreamCancel()`，处理现有 IPC 协议已经定义的 `stream_data`、`stream_end` 和 `stream_error`。
2. 在 sidecar host 中为 `desktopProduct` 增加 stream 分发，不经过 Fastify。
3. Go 将 IPC stream 转发到单独的 `kimi:stream` Wails 事件频道。
4. TS bridge 按 `streamId` 组装数据并支持 `AbortSignal`。
5. 二进制 chunk 使用有界 base64 块，不能把整个文件编码进一个 NDJSON frame。

上传方向需要独立的分块会话：

```text
ProductUploadStart(metaJSON) → uploadId
ProductUploadChunk(uploadId, base64Chunk)
ProductUploadFinish(uploadId) → WireFileMeta
ProductUploadCancel(uploadId)
```

sidecar 将 chunk 写入临时文件或受限流，并在 finish 时调用 `IFileService.save()`。中断、窗口关闭或超时必须清理临时文件。

### URL 契约调整

`getFileUrl()` 和 `getFileDownloadUrl()` 是同步方法，无法在直连传输中等待二进制数据。推荐将桌面使用点迁移到异步 Blob：

1. 通过 `getFileBlob()` 或新增的 `getWorkspaceFileBlob(sessionId, path)` 拉取数据。
2. Web 使用 `URL.createObjectURL(blob)` 生成临时 URL。
3. 组件卸载、会话切换或文件替换时调用 `URL.revokeObjectURL()`。

完成调用点迁移后，再从 `KimiWebApi` 删除或异步化两个同步 URL 方法。若这会影响公开 Web 契约，应单独评估 breaking change；不要在桌面实现中返回一个实际不可访问的 `/api/v1` 假 URL。

## P1：内嵌终端

终端的创建和查询是 JSON RPC，持续输出不是。

| Web 方法或连接动作 | V2 Service | 接入方式 |
| --- | --- | --- |
| `listTerminals` | `ISessionTerminalService.list()` | 恢复 Session 后返回当前终端列表。 |
| `createTerminal` | `ISessionTerminalService.create()` | 传入 cwd、shell、cols、rows；cwd 继续受 workspace 限制。 |
| `getTerminal` | `ISessionTerminalService.get()` | 保持 `TERMINAL_NOT_FOUND`。 |
| `closeTerminal` / `terminalClose` | `ISessionTerminalService.close()` | HTTP 方法和连接动作复用同一业务实现。 |
| `terminalInput` | `ISessionTerminalService.write()` | 通过普通 ProductCall 发送短输入。 |
| `terminalResize` | `ISessionTerminalService.resize()` | 发送 cols/rows。 |
| `terminalAttach` | `ISessionTerminalService.attach()` | 创建带稳定 sink ID 的 sidecar sink，将 replay 和实时 frame 推到流式桥。 |
| `terminalDetach` | `ISessionTerminalService.detach()` | 释放 sink；窗口关闭时调用 `detachAllForSink()`。 |

终端帧已经包含 `seq`。订阅时传入 `sinceSeq`，先 replay buffer，再发送实时 `terminal_output`/`terminal_exit`，这样切换面板不会丢输出。终端使用独立的 `kimi:terminal` 频道或复用带明确 `kind: "terminal"` 的通用流频道，不要混入聊天的 `WireEvent`。

## P2：Skill 和代码扩展

这些方法都是普通 JSON RPC：

| Web 方法 | V2 Service | 接入方式 |
| --- | --- | --- |
| `listSkillsForWorkspace` | `IWorkspaceService`、`IWorkspaceSkillCatalogService.list()` | 用 workspace root 做无 Session 扫描，投影为现有 `AppSkill` wire。 |
| `activateSkill` | `IAgentSkillService.activate()` | 恢复 Session 和主 Agent，并应用首次 prompt 的会话标题更新。 |
| `listExtensionCommands` | `ISessionExtensionService.listCommands()` | 恢复 Session 后列出扩展命令。 |
| `reloadExtensions` | `ISessionExtensionService.reload()` | 返回 active 和 errors 的相同 wire。 |
| `activateExtensionCommand` | `IAgentExtensionService.activateCommand()` | 在主 Agent scope 执行，并返回布尔结果。 |

Skill 激活和扩展命令可能直接启动 turn。接入这些方法前，事件投影必须已经覆盖相应事件，否则调用成功后 UI 会看不到运行过程。

## P2：会话导出

`exportSession` 使用 App scope 的 `ISessionExportService.export()`。sidecar 先生成 zip 到受控临时目录，再通过[文件流式桥](#推荐的流式桥)返回字节和文件名。

桌面端也可以提供原生保存流程：Go 弹出保存对话框并把 sidecar 生成的 zip 拷贝到目标路径。若采用这种体验，应保留一个返回 `Blob` 的实现供现有 `KimiWebApi` 调用，同时新增桌面专用「保存到磁盘」能力，不能让同一按钮在浏览器和桌面产生无提示的行为差异。

无论采用哪种方式，都要保留：

- 64 MiB Web log 上限。
- 取消信号和临时目录清理。
- Session 不存在、文件过大和导出失败的相同错误语义。
- 桌面日志、全局日志和版本信息的 manifest 字段。

## 每个接入切片的代码改动

普通 JSON 方法通常只修改以下文件：

| 文件 | 责任 |
| --- | --- |
| `apps/kimi-web/src/api/desktop/client.ts` | 实现 `KimiWebApi` 方法、wire 参数和 App 映射。 |
| `apps/kimi-desktop/sidecar/product/facade.ts` | 注册方法、调用 V2 Service、返回 `WireEnvelope`。 |
| `apps/kimi-desktop/sidecar/product/builders.ts` | 放纯 wire 投影，避免在 facade 中堆积转换代码。 |
| `apps/kimi-web/src/api/desktop/mock.ts` | 实现开发 mock，保持同一 wire 契约。 |
| `apps/kimi-web/src/api/desktop/client.test.ts` | 测试公开 `KimiWebApi` 行为。 |
| `apps/kimi-web/src/api/desktop/mock.test.ts` | 测试 mock envelope 和状态变化。 |

流式和二进制方法还需要修改：

| 文件 | 责任 |
| --- | --- |
| `apps/kimi-desktop/internal/ipcclient/ipcclient.go` | 实现 stream frame、取消和断线清理。 |
| `apps/kimi-desktop/product.go` | 增加流、上传和取消 Bind，并转发 Wails 事件。 |
| `apps/kimi-web/src/api/desktop/types.ts` | 声明新增的 Wails Bind 和事件类型。 |
| `apps/kimi-web/src/api/desktop/bridge.ts` | 把 Wails 事件转换为 Promise/AsyncIterable/Blob。 |
| `apps/kimi-desktop/sidecar/product/host.ts` | 分发产品 stream 和上传会话。 |

## 测试要求

现有 mock 测试不足以证明真实桌面链路可用。每个切片至少包含以下验证：

1. **Web 公共契约测试**：通过 `createWailsKimiWebApi()` 调用，不直接测试私有 mapper。
2. **Facade 单元测试**：使用最小 Scope/Service stub，验证 V2 Service 调用、wire 投影和错误码。
3. **dispatch 覆盖测试**：静态或运行时校验 `client.ts` 中每个 `this.call('<method>')` 都在 `ProductFacade.dispatch()` 注册。该测试应能发现当前专家团队的 4 个缺口。
4. **真实 IPC 测试**：启动 sidecar product host，通过 Go 或 TS IPC 客户端调用至少一个成功和一个失败场景。
5. **传输一致性测试**：对同一 fixture，`DaemonKimiWebApi` 和 `WailsKimiWebApi` 应返回相同的 `App*` 形状。
6. **打包桌面 smoke test**：验证 Wails 自动选择 direct transport，核心流程不会发出 `/api/v1` 网络请求，也不会启动 kap-server。
7. **重连测试**：快照水位后断开并恢复，最终 transcript 无重复、无缺失。
8. **流式测试**：大文件、取消、断线、终端 replay、终端退出和临时资源清理。

在全量完成前，建议增加一份显式的 `DESKTOP_SUPPORTED_METHODS` 清单，供测试和 UI 能力判断共同使用。全量完成后让 `WailsKimiWebApi` 直接 `implements KimiWebApi`，删除用于兜底的动态 Proxy；以后新增 `KimiWebApi` 方法时，由 TypeScript 编译器直接阻止桌面覆盖倒退。

## 推荐实施顺序

按以下切片推进，每个切片都可以独立验收：

1. **Slice 1：明显断点**：专家团队、`getSession`、`listMessages`、`dismissQuestion`、`getTask`、`cancelTask`。
2. **Slice 2：会话控制**：steer、abort、compact、undo、fork、children、BTW。
3. **Slice 3：事件收敛**：cursor、journal、unsubscribe、resync、多 Agent 和完整事件投影。
4. **Slice 4：工作区和结构化 FS**：workspace 新增/改名/浏览，目录、读取、搜索、grep、diff。
5. **Slice 5：二进制文件**：IPC stream、上传、Blob、会话文件下载。
6. **Slice 6：终端**：CRUD、input/resize、attach/replay/detach。
7. **Slice 7：Skill、扩展和导出**：补齐剩余方法，完成 Proxy 清理和全量回归。

这个顺序先保证聊天和会话不会因未实现方法中断，再处理对 IPC 机制有额外要求的文件与终端。

## 完成标准

全部满足以下条件后，才能宣称桌面 Web 已经全量接入 V2：

- `WailsKimiWebApi implements KimiWebApi` 可以直接通过类型检查，不再依赖 Proxy 补齐缺失方法。
- 80 个公开方法都有真实 `WailsKimiWebApi → ProductCall/Stream → ProductFacade → V2 Service` 路径。
- `client.ts` 的所有 product method 都在 `ProductFacade.dispatch()` 注册，并由自动化测试锁定。
- 专家团队不再只在 mock 中可用。
- 事件订阅支持 cursor、unsubscribe、断线重连和 resync，快照与事件共享 epoch/seq。
- 多 Agent、interaction、任务和 Skill 事件在桌面与 kap-server Web 中收敛到相同 UI 状态。
- 文件上传、下载、预览和会话导出不依赖 `/api/v1` URL。
- 内嵌终端支持 replay、输入、resize、退出和清理，不弹出外部终端窗口。
- Wails 默认启动不创建 kap-server 进程，不要求 Kimi 登录才能进入界面。
- 配置、供应商、模型和凭据只使用桌面独立的 `.kimi-desktop` 数据目录。
- 打包后的 macOS 应用完成一次无网络后端依赖的端到端 smoke test。

