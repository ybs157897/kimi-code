# Codex 桌面端正文 Markdown 兼容格式

本文整理 OpenAI **Codex Desktop**（macOS 上为 `ChatGPT.app`，bundle id `com.openai.codex`）助手消息正文（assistant message body）的渲染兼容面与实现细节，供 Kimi Code 对齐渲染或互操作时参考。

> 信息来自对本地安装包前端资源（`app.asar`）的静态反查，观测版本为 **26.721.41059**。第三方实现可能随版本变化；以当前安装版本为准。

## 渲染管线

助手正文是字符串 Markdown，经 lexer 得到 token，再映射为 React 组件：

```text
assistant-message.text
        │
        ▼
  可选预处理（GitHub HTML 归一化、流式截断等）
        │
        ▼
  marked Lexer（GFM + breaks + directive + math + 文件引用）
        │
        ▼
  tokens[]
        │
        ▼
  Markdown 渲染器
        ├─ 标准组件：a / code / img / table / h1…h6 …
        └─ directives：按 name 分发到专用组件（或隐藏 / 回退原文）
```

### Lexer 配置

| 项 | 值 | 含义 |
| --- | --- | --- |
| `gfm` | `true` | 开启 GFM（表格、任务列表、自动链接等） |
| `breaks` | `true` | 软换行渲染为 `<br>` |
| `tokenizer.del` | 以 `~~` 开头时返回 `false` | 禁用标准 `~~删除线~~` 路径 |
| 扩展 | marked-directive + math + `【†L】` citation | 见下文 |

### Directive 语法层级

| 层级 | 标记 | 形态 |
| --- | --- | --- |
| container | `:::` | `:::name{attrs}\n内容\n:::` |
| block / leaf | `::` | `::name{attrs}` |
| inline | `:` | `:name{attrs}`（Codex 自定义较少使用） |

属性支持 `key=value`、引号字符串、boolean flag、数字；引号内可转义。解析失败时该 extension 不匹配；**未知 directive 名回退为原文 `raw`**，不拖垮整条会话。

### 解析缓存

| 参数 | 值 |
| --- | --- |
| 缓存条数上限 | 100 |
| 缓存总源码上限 | 约 6_000_000 字符 |
| 单条可缓存条件 | 源码长度 ≤ 约 1_000_000 字符 |

Lexer 后处理还会：合并连续图片 token、修复 `](` 链接片段、规范化 directive token。

---

## 标准 Markdown / GFM

可渲染的标准 token 包括：`blockquote`、`br`、`code`、`codespan`、`def`、`del`、`em`、`escape`、`heading`、`hr`、`html`、`image`、`link`、`list`、`list_item`、`paragraph`、`space`、`strong`、`table`、`text`。

| Token | 行为 |
| --- | --- |
| heading | depth 1–6 → `h1`…`h6`；非法 depth 退化为段落 |
| strong / em / del | 对应 HTML 标签 |
| codespan | 行内代码；可叠加文件路径装饰 |
| code | 围栏代码块；见 [代码围栏](#代码围栏) |
| list / list_item | 支持有序 `start`；任务列表用禁用复选框，`task-list-item` |
| table | GFM 表 + 复制按钮 |
| link / image | 见 [链接与路径](#链接与路径)、[图片](#图片) |
| def | 解析但不渲染 |
| space | 不渲染 |

### 基础 HTML

在 `allowBasicHtml` 开启时，允许成对标签：`b`、`del`、`em`、`i`、`s`、`strong`、`sub`、`sup`、`u`，以及单独的 `<br>`。

### 预处理兼容

| 输入 | 变换 |
| --- | --- |
| `<!-- ... -->` | 删除 |
| `<details>…<summary>…</summary>…</details>` | 转为 `:::github-details{summary="…" [open="true"]}` |
| `> [!NOTE\|TIP\|IMPORTANT\|WARNING\|CAUTION]` | 转为带加粗标签的引用样式 |
| 围栏代码块 | 预处理时用占位符保护，避免被 details / alert 规则误伤 |

::: warning 注意
标准 `~~删除线~~` 可能不生效（lexer 显式关闭了以 `~~` 开头的 `del`）。`<del>` 等其它路径仍可显示删除效果。
:::

---

## 数学公式

使用 KaTeX（懒加载）。`throwOnError: false`，`strict: "ignore"`。

| 形态 | 语法 |
| --- | --- |
| 块级 | `\[ ... \]` 或 `$$ ... $$`（结束符后须为行尾空白或 EOF） |
| 行内 | `\( ... \)`（禁止跨行） |

---

## 代码围栏

| 条件 | 行为 |
| --- | --- |
| 行内 code | 常规样式；可识别「整块仅为一个 `[label](href)`」的特殊展示 |
| `hideCodeBlocks` | 整块不渲染 |
| `language` 为 `text` / `md` / `markdown`（或空）且开启 Writing Block | 升格为可编辑写作块，而非纯高亮 |
| `language === mermaid`（流式时也匹配 `mermaid*` 前缀） | Mermaid 图；可宽屏；失败回退 plaintext |
| 其它语言 | Shiki 语法高亮 |
| 流式未闭合围栏 | 标记 `isCodeFenceOpen`，可延迟增强直到可见 |

`diff` 等语言走普通高亮；结构化 patch / turn-diff 另有独立消息类型，不一定走正文围栏。

---

## Codex Directive

助手正文的 directive 组件映射大致为：

```text
artifact-template
+ codex-file-citation
+ task-stub
+ github-details
+ 隐藏控制类（渲染 null）
+ codex-inline-vis / codex-live-vis（可选）
(+ automation-citation，视上下文)
```

分发规则：有组件则渲染；无映射则显示原文。

### 可见 UI

#### `codex-file-citation`

两种入口：

1. Directive：`::codex-file-citation{path="..." line_range_start="12" line_range_end="40" purpose="source|output"}`
2. 特殊字面量：

```text
【path/to/file.ts†L12】
【path/to/file.ts†L12-L40】
【F:percent-encoded-path†L12】
```

正则形态：`【…†L{start}(-L{end})?】`。`F:` 前缀表示 path 经 `decodeURI`；无 `F:` 时 path 须通过「像本地路径」的判定。

可选 artifact 扩展属性：

| `artifact_kind` | 关键属性 |
| --- | --- |
| `presentation` | `object_id`，以及 `slide_id` / `slide_number` |
| `workbook` | `object_id` + `sheet` + 可选 `object_kind`（`chart` / `table` / `image` / `shape`），或 `range` + `sheet` |
| `document` | `page_number`（正整数） |
| 共用 | `label?`，`path`（必填） |

UI：文件名 + 行号 chip，点击打开侧栏 / 编辑器。

#### `github-details`

```text
:::github-details{summary="标题" open="true"}
内容
:::
```

渲染为可折叠 `<details>` 卡片。常由 GitHub / PR HTML 预处理生成。

#### `task-stub`

```text
::task-stub{title="..."}
prompt 正文
```

渲染为 “Suggested task” 卡片，可一键预填 Composer。

#### `artifact-template`

关键属性：

| 字段 | 约束 |
| --- | --- |
| `artifact_kind` | `document` / `presentation` / `spreadsheet` / `google-docs` / `google-slides` / `google-sheets` |
| `display_name` | 非空字符串 |
| `skill_directory` | 绝对路径 |
| `skill_name` | 以 `artifact-template-` 开头 |

#### `codex-inline-vis`

```text
::codex-inline-vis{file="vis/foo.html" title="..." expandable="true|false" threadId="..."}
```

读取会话可视化产物并在沙箱 iframe 中展示。流式半截 directive 会被截断隐藏。`codex-live-vis` 同族语法，但正文映射为不渲染。

#### `automation-citation`

```text
::automation-citation{automation_id="..." index="0"}
```

与 turn 上的自动化结果列表对齐，渲染引用 chip。

#### `:::writing`

```text
:::writing{id="..." title="..." variant="..." metadata="%7B...%7D" recipient="..." cc="..." bcc="..." subject="..."}
正文
:::
```

| 属性 | 用途 |
| --- | --- |
| `id` | 块 ID；缺省则 hash 生成 |
| `title` / `variant` | 标题与变体 |
| `metadata` | URI 编码 JSON（tone sections 等） |
| `recipient` / `cc` / `bcc` / `subject` | 邮件元数据 |

写作模式枚举包括：`standard`、`document`、`email`、`creative`、`chat_message`、`social_post`、`slides`、`unknown`。

### 正文隐藏（副作用 / 元数据）

下列 directive 在气泡正文中渲染为 `null`，但仍会解析并驱动其它 UI：

| name | 作用 |
| --- | --- |
| `git-stage` / `git-commit` / `git-create-branch` / `git-push` / `git-create-pr` | 驱动 Git / PR UI；属性见下 |
| `code-comment` | 注入 Review diff 评论（侧栏） |
| `inbox-item` / `archive-thread` / `created-thread` | 会话 / 收件箱控制 |
| `pr-auto-fix-progress` | PR 自动修复进度 |
| `codex-realtime-inline` | 实时内联占位（`::codex-realtime-inline{}`） |

**Git 属性：**

| 字段 | 说明 |
| --- | --- |
| `cwd` | 必填 |
| `branch` | 可选 |
| `url` | 可选（PR） |
| `isDraft` | 可选；接受 boolean 或 `"true"` / `"false"` |

Windows 路径中的 `\` 曾导致 directive 属性解析崩溃；实践上应使用 `/`，客户端也应 fail-soft。

**`code-comment` 属性（仅行首 `::code-comment{...}`）：**

| 字段 | 说明 |
| --- | --- |
| `title` / `body` / `file` | 必填 |
| `priority` | 可选整数；也可从标题 `[p1]` 解析 |
| `confidence` | 可选数字 |
| `start` / `end` | 行号；默认从 1 |

### 控制类行首集合

用于流式 / 折叠逻辑识别「整行应吃掉的控制 directive」：

`inbox-item` · `archive-thread` · `created-thread` · `code-comment` · `git-stage` · `git-commit` · `git-create-branch` · `git-push` · `git-create-pr` · `pr-auto-fix-progress` · `codex-realtime-inline`

---

## 链接与路径

### 富链接 kind

| kind | 判定 |
| --- | --- |
| `agent` | `agent://` / `subagent://` / `thread://` |
| `browser-tab` | 特殊 `plugin://…?mention=browser-tab&…` |
| `plugin` | `plugin://` |
| `chatgpt-conversation` | `chatgpt-conversation://{id}` |
| `mcp-resource` | `mcp-resource://{server}/{resourceUri}` |
| `sites-project` | `sites-project://{id}` |
| `app` | `app://` |
| `skill` | label 以 `$` 开头，且 href 不是「知名 HTTP app」链接 |
| `text` | 其它；再尝试本地文件路径 |

外链受 `externalResourcePolicy`（`allow` / `restricted`）约束。另有 `codex-text-link://` 包装形态。

### 本地文件路径与行号

支持：

```text
path:12
path:12:4
path:12-40
path:12:4-40:8
path#L12
path#L12C4
path#L12C4-L40C8
file:///abs/path
file://localhost/abs
```

启发式：已有行号 / 列号则视为文件引用；排除 `scheme://`、`www.`、`mailto:`、`tel:`；路径需像带扩展名的文件。目录尾 `/` 可识别为「在文件管理器中打开」。

---

## 图片

- 标准 `![alt](src "title")`
- 连续多个 image token 会在 lexer 后处理中合并
- 支持媒体展示策略、缓存 key、入场动画
- `restricted` 策略会限制外链媒体
- turn 级 `generated-image` / `image-view` 不走正文 Markdown

---

## 与正文并列的消息类型

下列内容多为独立 turn item，不是纯 Markdown 正文，但导出时常落成 Markdown 片段：

- `exec` / `patch` / `turn-diff` / `web-search`
- `generated-image` / `image-view`
- plan / todo / MCP / permission / subagent 等

导出时会剥掉 `::git-*{…}`，并把工具输出包进 `<details>`，patch 落为 `` ```diff `` 等。

---

## 稳健性

| 策略 | 行为 |
| --- | --- |
| directive tokenizer | 单 extension `try/catch`，失败则跳过匹配 |
| KaTeX | 不抛错，坏公式尽量不炸整条消息 |
| Markdown 根组件 | ErrorBoundary + Retry |
| 未知 directive | 显示 raw |
| 隐藏 directive | 不显示，但可驱动副作用 |

---

## 兼容速查

| 类别 | 兼容项 | 正文可见 |
| --- | --- | --- |
| MD / GFM | 标题 / 列表 / 表格 / 任务列表 / 引用 / 代码 / 链接 / 图片 | 是 |
| HTML | 有限标签；details → directive；注释剥离 | 部分 |
| Alert | `[!NOTE/TIP/IMPORTANT/WARNING/CAUTION]` | 是 |
| Math | `\[\]` / `$$` / `\(\)` → KaTeX | 是 |
| Code | Shiki；`mermaid`；md/text → Writing Block | 是 |
| Citation | `【†L】` / `::codex-file-citation` / 路径链接 | 是（chip） |
| Details | `:::github-details` | 是 |
| Task | `::task-stub` | 是（卡片） |
| Artifact | `::artifact-template` | 是（卡片） |
| Vis | `::codex-inline-vis` | 是（iframe） |
| Writing | `:::writing{…}` | 是（写作块） |
| Automation | `::automation-citation` | 是（chip） |
| Git UI | `::git-stage/commit/create-branch/push/create-pr` | 否（副作用） |
| Review | `::code-comment` | 否（进 diff 评论） |
| Control | inbox / archive / created-thread / pr-auto-fix / realtime-inline | 否 |

---

## 对齐实现建议

若要在 Kimi Code 中做同构或降级兼容，建议优先落实：

1. **Lexer**：GFM + soft breaks + `::` / `:::` directive + math + `【†L】`
2. **Directive 三类**：可见组件 / 隐藏副作用 / raw 回退
3. **Git directive**：只认行首，`cwd` 必填，路径用 `/`，解析失败 fail-soft
4. **文件引用**：同时支持 citation 字面量与 `path:line` / `#L` 链接
5. **围栏**：`mermaid` 特殊化；`md` / `markdown` / `text` 可升格写作块
6. **失败策略**：单 token 失败不拖垮整条会话

## Next steps

- [交互与输入](/zh/guides/interaction) — Kimi Code 终端侧输入与展示约定
- [内置工具](/zh/reference/tools) — 工具输出如何进入会话上下文
