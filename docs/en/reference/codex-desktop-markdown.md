# Codex Desktop message body Markdown compatibility

This page documents how OpenAI **Codex Desktop** (on macOS: `ChatGPT.app`, bundle id `com.openai.codex`) renders the assistant message body: supported formats, directive contracts, and implementation details useful when aligning Kimi Code rendering or interoperability.

> Findings come from static reverse-engineering of a local install’s frontend bundle (`app.asar`). Observed app version: **26.721.41059**. Behavior can change across releases; treat the installed build as source of truth.

## Rendering pipeline

The assistant body is a Markdown string. A lexer produces tokens; React components render them:

```text
assistant-message.text
        │
        ▼
  Optional preprocess (GitHub HTML normalize, streaming truncation, …)
        │
        ▼
  marked Lexer (GFM + breaks + directive + math + file citations)
        │
        ▼
  tokens[]
        │
        ▼
  Markdown renderer
        ├─ Standard components: a / code / img / table / h1…h6 …
        └─ directives: dispatch by name (render / hide / fall back to raw)
```

### Lexer options

| Option | Value | Meaning |
| --- | --- | --- |
| `gfm` | `true` | Enable GFM (tables, task lists, autolinks, …) |
| `breaks` | `true` | Soft line breaks become `<br>` |
| `tokenizer.del` | returns `false` when input starts with `~~` | Disables standard `~~strikethrough~~` |
| Extensions | marked-directive + math + `【†L】` citation | See below |

### Directive marker levels

| Level | Marker | Shape |
| --- | --- | --- |
| container | `:::` | `:::name{attrs}\nbody\n:::` |
| block / leaf | `::` | `::name{attrs}` |
| inline | `:` | `:name{attrs}` (rarely used for Codex customs) |

Attributes support `key=value`, quoted strings, boolean flags, and numbers; quotes may escape. On tokenizer failure the extension simply does not match. **Unknown directive names fall back to raw text** and must not crash the thread.

### Parse cache

| Limit | Value |
| --- | --- |
| Max cached entries | 100 |
| Max total cached source chars | ~6_000_000 |
| Per-entry cache eligibility | source length ≤ ~1_000_000 |

Post-lexer passes also merge consecutive image tokens, repair `](` link fragments, and normalize directive tokens.

---

## Standard Markdown / GFM

Renderable standard tokens include: `blockquote`, `br`, `code`, `codespan`, `def`, `del`, `em`, `escape`, `heading`, `hr`, `html`, `image`, `link`, `list`, `list_item`, `paragraph`, `space`, `strong`, `table`, `text`.

| Token | Behavior |
| --- | --- |
| heading | depth 1–6 → `h1`…`h6`; invalid depth degrades to paragraph |
| strong / em / del | Matching HTML tags |
| codespan | Inline code; may add file-path decoration |
| code | Fenced blocks; see [Code fences](#code-fences) |
| list / list_item | Ordered `start`; task items use disabled checkboxes + `task-list-item` |
| table | GFM table + copy control |
| link / image | See [Links and paths](#links-and-paths), [Images](#images) |
| def | Parsed but not rendered |
| space | Not rendered |

### Basic HTML

When `allowBasicHtml` is enabled, paired tags `b`, `del`, `em`, `i`, `s`, `strong`, `sub`, `sup`, `u` and standalone `<br>` are allowed.

### Preprocess compatibility

| Input | Transform |
| --- | --- |
| `<!-- ... -->` | Stripped |
| `<details>…<summary>…</summary>…</details>` | → `:::github-details{summary="…" [open="true"]}` |
| `> [!NOTE\|TIP\|IMPORTANT\|WARNING\|CAUTION]` | Styled blockquote with bold label |
| Fenced code blocks | Protected with placeholders during preprocess so details/alert rules do not corrupt them |

::: warning Note
Standard `~~strikethrough~~` may not work because the lexer disables `del` when the input starts with `~~`. Other paths such as `<del>` can still render strikethrough.
:::

---

## Math

Rendered with KaTeX (lazy-loaded). `throwOnError: false`, `strict: "ignore"`.

| Form | Syntax |
| --- | --- |
| Block | `\[ ... \]` or `$$ ... $$` (closing marker must be followed by end-of-line whitespace or EOF) |
| Inline | `\( ... \)` (must not span lines) |

---

## Code fences

| Condition | Behavior |
| --- | --- |
| Inline code | Normal style; may special-case a single `[label](href)` payload |
| `hideCodeBlocks` | Entire block omitted |
| `language` in `text` / `md` / `markdown` (or empty) with Writing Block enabled | Promoted to an editable writing surface instead of plain highlight |
| `language === mermaid` (streaming also matches `mermaid*` prefix) | Mermaid diagram; optional wide layout; fallback to plaintext on error |
| Other languages | Shiki highlighting |
| Open streaming fence | `isCodeFenceOpen`; enhancements may wait until visible |

Languages such as `diff` use normal highlighting. Structured patch / turn-diff items are separate message types and do not always go through body fences.

---

## Codex directives

Assistant-body directive component maps roughly compose as:

```text
artifact-template
+ codex-file-citation
+ task-stub
+ github-details
+ hidden control directives (render null)
+ codex-inline-vis / codex-live-vis (optional)
(+ automation-citation, context-dependent)
```

Dispatch rule: mapped name → component; unmapped name → raw text.

### Visible UI

#### `codex-file-citation`

Two entry points:

1. Directive: `::codex-file-citation{path="..." line_range_start="12" line_range_end="40" purpose="source|output"}`
2. Literal citation:

```text
【path/to/file.ts†L12】
【path/to/file.ts†L12-L40】
【F:percent-encoded-path†L12】
```

Shape: `【…†L{start}(-L{end})?】`. Prefix `F:` means the path is `decodeURI`’d; without `F:`, the path must look like a local filesystem path.

Optional artifact attributes:

| `artifact_kind` | Related attributes |
| --- | --- |
| `presentation` | `object_id`, plus `slide_id` / `slide_number` |
| `workbook` | `object_id` + `sheet` + optional `object_kind` (`chart` / `table` / `image` / `shape`), or `range` + `sheet` |
| `document` | `page_number` (positive integer) |
| Shared | `label?`, required `path` |

UI: filename + line-range chip; click opens side panel / editor.

#### `github-details`

```text
:::github-details{summary="Title" open="true"}
body
:::
```

Renders a collapsible `<details>` card. Often produced from GitHub / PR HTML preprocessing.

#### `task-stub`

```text
::task-stub{title="..."}
prompt body
```

Renders a “Suggested task” card that can prefill the composer.

#### `artifact-template`

| Field | Constraint |
| --- | --- |
| `artifact_kind` | `document` / `presentation` / `spreadsheet` / `google-docs` / `google-slides` / `google-sheets` |
| `display_name` | Non-empty string |
| `skill_directory` | Absolute path |
| `skill_name` | Must start with `artifact-template-` |

#### `codex-inline-vis`

```text
::codex-inline-vis{file="vis/foo.html" title="..." expandable="true|false" threadId="..."}
```

Loads a thread visualization artifact into a sandboxed iframe. Incomplete streaming directive lines are truncated/hidden. Sibling `codex-live-vis` uses related syntax but maps to no body UI.

#### `automation-citation`

```text
::automation-citation{automation_id="..." index="0"}
```

Aligned with turn-level automation results; renders a citation chip.

#### `:::writing`

```text
:::writing{id="..." title="..." variant="..." metadata="%7B...%7D" recipient="..." cc="..." bcc="..." subject="..."}
body
:::
```

| Attribute | Role |
| --- | --- |
| `id` | Block id; hashed if omitted |
| `title` / `variant` | Title and variant |
| `metadata` | URI-encoded JSON (tone sections, …) |
| `recipient` / `cc` / `bcc` / `subject` | Email metadata |

Writing mode enum includes: `standard`, `document`, `email`, `creative`, `chat_message`, `social_post`, `slides`, `unknown`.

### Hidden in the bubble (side effects / metadata)

These directives render as `null` in the chat bubble but are still parsed and drive other UI:

| name | Role |
| --- | --- |
| `git-stage` / `git-commit` / `git-create-branch` / `git-push` / `git-create-pr` | Drive Git / PR UI; attributes below |
| `code-comment` | Inject review diff comments (side panel) |
| `inbox-item` / `archive-thread` / `created-thread` | Inbox / thread control |
| `pr-auto-fix-progress` | PR auto-fix progress |
| `codex-realtime-inline` | Realtime inline placeholder (`::codex-realtime-inline{}`) |

**Git attributes:**

| Field | Notes |
| --- | --- |
| `cwd` | Required |
| `branch` | Optional |
| `url` | Optional (PR) |
| `isDraft` | Optional; boolean or `"true"` / `"false"` |

Backslash Windows paths historically crashed directive attribute parsing; prefer `/`, and clients should fail soft.

**`code-comment` attributes (line-start `::code-comment{...}` only):**

| Field | Notes |
| --- | --- |
| `title` / `body` / `file` | Required |
| `priority` | Optional int; may also parse from title `[p1]` |
| `confidence` | Optional number |
| `start` / `end` | Line numbers; default starts at 1 |

### Line-start control set

Used by streaming / collapse logic to recognize whole-line control directives:

`inbox-item` · `archive-thread` · `created-thread` · `code-comment` · `git-stage` · `git-commit` · `git-create-branch` · `git-push` · `git-create-pr` · `pr-auto-fix-progress` · `codex-realtime-inline`

---

## Links and paths

### Rich link kinds

| kind | Detection |
| --- | --- |
| `agent` | `agent://` / `subagent://` / `thread://` |
| `browser-tab` | Special `plugin://…?mention=browser-tab&…` |
| `plugin` | `plugin://` |
| `chatgpt-conversation` | `chatgpt-conversation://{id}` |
| `mcp-resource` | `mcp-resource://{server}/{resourceUri}` |
| `sites-project` | `sites-project://{id}` |
| `app` | `app://` |
| `skill` | Label starts with `$` and href is not a known HTTP app link |
| `text` | Everything else; then try local file path |

External links respect `externalResourcePolicy` (`allow` / `restricted`). There is also a `codex-text-link://` wrapper form.

### Local paths and line anchors

Supported shapes:

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

Heuristics: line/column present ⇒ file reference; reject `scheme://`, `www.`, `mailto:`, `tel:`; path should look like a file with an extension. Trailing `/` can mean “reveal in file manager”.

---

## Images

- Standard `![alt](src "title")`
- Consecutive image tokens may be merged after lexing
- Media presentation policy, cache key, enter animation
- `restricted` policy limits external media
- Turn-level `generated-image` / `image-view` are not body Markdown

---

## Sibling message types (not body Markdown)

These are usually independent turn items, though export may flatten them into Markdown:

- `exec` / `patch` / `turn-diff` / `web-search`
- `generated-image` / `image-view`
- plan / todo / MCP / permission / subagent, …

Export strips `::git-*{…}`, wraps tool output in `<details>`, and emits patches as `` ```diff `` blocks.

---

## Robustness

| Strategy | Behavior |
| --- | --- |
| Directive tokenizer | Per-extension `try/catch`; failed match is skipped |
| KaTeX | Does not throw; bad math should not kill the message |
| Markdown root | ErrorBoundary + Retry |
| Unknown directive | Show raw |
| Hidden directive | No bubble UI; may still trigger side effects |

---

## Compatibility cheat sheet

| Category | Items | Visible in body |
| --- | --- | --- |
| MD / GFM | Headings / lists / tables / task lists / quotes / code / links / images | Yes |
| HTML | Limited tags; details → directive; comments stripped | Partial |
| Alert | `[!NOTE/TIP/IMPORTANT/WARNING/CAUTION]` | Yes |
| Math | `\[\]` / `$$` / `\(\)` → KaTeX | Yes |
| Code | Shiki; `mermaid`; md/text → Writing Block | Yes |
| Citation | `【†L】` / `::codex-file-citation` / path links | Yes (chip) |
| Details | `:::github-details` | Yes |
| Task | `::task-stub` | Yes (card) |
| Artifact | `::artifact-template` | Yes (card) |
| Vis | `::codex-inline-vis` | Yes (iframe) |
| Writing | `:::writing{…}` | Yes (writing block) |
| Automation | `::automation-citation` | Yes (chip) |
| Git UI | `::git-stage/commit/create-branch/push/create-pr` | No (side effect) |
| Review | `::code-comment` | No (diff comments) |
| Control | inbox / archive / created-thread / pr-auto-fix / realtime-inline | No |

---

## Alignment recommendations

To mirror or soft-compat in Kimi Code:

1. **Lexer**: GFM + soft breaks + `::` / `:::` directives + math + `【†L】`
2. **Directive classes**: visible components / hidden side effects / raw fallback
3. **Git directives**: line-start only, required `cwd`, prefer `/` paths, fail soft
4. **File citations**: support both citation literals and `path:line` / `#L` links
5. **Fences**: special-case `mermaid`; optionally promote `md` / `markdown` / `text` to writing blocks
6. **Failure policy**: one bad token must not break the whole thread

## Next steps

- [Interaction and input](/en/guides/interaction) — Kimi Code terminal input and display conventions
- [Built-in tools](/en/reference/tools) — how tool output enters session context
