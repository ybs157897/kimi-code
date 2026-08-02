# 专家团

专家团适合把一个需要多阶段、不同专业角色协作的任务交给多个 Agent。知识图谱专家团把工作拆成「静态建图 → 深度语义分析 → 质量审查」三阶段，并通过主理人统一汇总结果。

## 知识图谱专家团的工作方式

启动知识图谱专家团后，主理人必须按顺序调度三个成员：

- `graph-builder`：调用 `GraphBuild`，建立文件、函数、类和关系边的结构图。
- `semantic-analyst`：在结构图成功后，由主理人把待处理文件分成少量批次，通过 `AgentSwarm` 并行启动多个实例；每个实例处理一个批次，主理人再用 `GraphSummarize` 合并结果。
- `graph-reviewer`：使用登录、持久化、请求路由、后台任务、配置等代表性问题审查图谱覆盖率。

只有三个成员都通过 `SendMessage` 回传结果，主理人才能向用户宣布专家团完成。`GraphBuild` 成功只表示结构图完成，不表示深度语义分析完成。

## 创建目录型专家团

目录型专家团不需要单独安装扩展。把一个团队目录放在项目配置目录的 `experts/` 下，重新加载会话后即可发现：

```text
.kimi-desktop/experts/knowledge-graph-expert-team/
├── kimi.plugin.json
├── agents/
│   ├── knowledge-graph-expert-team-lead.md
│   ├── graph-builder.md
│   ├── semantic-analyst.md
│   └── graph-reviewer.md
└── skills/
    └── knowledge-graph-team-bootstrap/
        └── SKILL.md
```

`.kimi-code/experts/` 也可以作为兼容目录使用。下面是最小的 `kimi.plugin.json`：

```json
{
  "name": "knowledge-graph-expert-team",
  "version": "1.0.0",
  "expertType": "team",
  "agentName": "knowledge-graph-expert-team-lead",
  "agents": [
    "./agents/knowledge-graph-expert-team-lead.md",
    "./agents/graph-builder.md",
    "./agents/semantic-analyst.md",
    "./agents/graph-reviewer.md"
  ],
  "skills": ["./skills/knowledge-graph-team-bootstrap"],
  "teamInfo": {
    "leadAgent": "knowledge-graph-expert-team-lead",
    "memberAgents": ["graph-builder", "semantic-analyst", "graph-reviewer"]
  }
}
```

每个 Agent 文件都使用 Frontmatter 加 Markdown 正文。成员要显式声明自己需要的工具，例如：

```markdown
---
name: semantic-analyst
description: 为知识图谱补充深度语义摘要并验证语义搜索。
tools: [GraphSummarize, GraphSearch, SendMessage, TodoList]
---

先确认 GraphBuild 已成功，再分批执行 GraphSummarize；完成后必须通过 SendMessage 把完整结果发给 team-lead。
```

主理人文件应明确执行 `TeamCreate`、`TeamSpawn`、`SendMessage` 和 `TeamDelete` 的顺序，成员文件应明确输入、工具、输出和回传协议。这个模式与代码型 Extension 类似：能力和工作流沉淀在可复用文件中，但专家团使用声明式 Agent 文件，不需要编写运行时代码。

## 运行专家团

在 TUI 中使用 `/experts` 选择 `knowledge-graph-expert-team`，或直接告诉主 Agent：

```text
启动知识图谱专家团：先生成结构图，再做深度语义分析，最后审查搜索质量。只有三个阶段都完成后再汇总。
```

主理人创建运行时团队后，必须先等待 `graph-builder` 回报成功，再进入 `AgentSwarm`。每轮先用 `GraphSummarize` 获取有限文件批次，再把文件分成少量批次，通过 `AgentSwarm` 并行启动 `semantic-analyst`，最后由主理人合并 `analyses`。调用 `AgentSwarm` 的那一轮只能发出这一个工具调用。中断后使用 `resume_agent_ids` 继续失败项，不要从头覆盖已有摘要。

## 与 Extension 的区别

Extension 是可执行的 TypeScript/JavaScript 扩展，可以注册工具、事件和斜杠命令；专家团是由 `kimi.plugin.json`、Agent 文件和 Skill 文件组成的协作配置包。前者扩展运行时能力，后者扩展 Agent 的角色分工和工作流程，两者可以放在同一个 Plugin 中一起发布。
