# 对照审计：dsh-mcp-skill-panel 0.6.0 vs dsh-skill-mcp-gate 0.2.0

> 依据：`dsh-mcp-skill-panel@0.6.0` 的发布包源码（7,127 行）逐项 grep 核实，不是读 README。
> 结论以源码行号为准。

## 0. 规模

| | dsh-mcp-skill-panel | dsh-skill-mcp-gate |
|---|---:|---:|
| host | 3,098 行 `lib/index.js` | 368 行 |
| client | 3,322 行 `lib/client.js` | 238 行 |
| 辅助模块 | 6 个 `.mjs`/`.js`（1,000+ 行） | 4 个（444 行） |
| 合计 | **7,127 行** | **1,050 行** |
| API 路由 | **17** | 5 |
| 配置项 | 6 | 3 |

差 6.8 倍。它的体量不是冗余——下面每一行都对应我做不了的事。

---

## 1. 机制对照（带源码证据）

### 1.1 Skill 启停

| | 它 | 我 |
|---|---|---|
| 机制 | 往 `SKILL.md` frontmatter 注入/移除 `disable-model-invocation: true`（`index.js:2509`） | 运行时 `ctx.skills.register()` 同名影子覆盖 `invocation` |
| 档位 | 2（开/关） | **4**（`on` / `name-only` / `user-invocable-only` / `off`） |
| 改用户文件 | **是** | 否 |
| 项目级覆盖 | 无（改了就是全仓库） | 两层 + `decidedBy` 归因 |
| 静默失败自证 | 无 | **有**（`lost` 检测） |
| CC 配置兼容 | 无 | `skillOverrides` 别名 |

**我赢的这一项是实的**：DSH 的 `register()` 被 first-wins 击败时静默返回 no-op disposer，它没有对应检测，配错了不会告诉你。

### 1.2 MCP 服务器启停

| | 它 | 我 |
|---|---|---|
| 机制 | `ctx.loader.remove/create`（7 处调用） | `agent.ctx.tools.restrict({ deny })` |
| 写入用户 profile 组合 | **是**（`Loader.write()` 落盘） | 否 |
| 断开/重连 | 会 | 不会 |
| 重启持久化 | `state.json` desired + `syncPresetFiles()` 物化 | 配置文件 + 启动重放 |

它的持久化是**设计意图**（把开关物化进预设组合，重启后还在）。我把"不写用户配置"当红线。理念分歧，不是对错。

### 1.3 逐工具禁用 —— **它比我高明**

```js
// mcpcall-BvfQcVOv.mjs:640
function installToolDisableFilter(ctx) {
  return ctx.effect(() =>
    ctx.root.on("system-prompt/assemble", (assembly, context, next) => {
      if (assembly && Array.isArray(assembly.tools)) {
        if (disabledTools.size === 0 && projectDisabledTools.size === 0) return next();
        const cwd = context?.agent?.session?.header?.cwd;
        const workspace = typeof cwd === "string" ? cwd : void 0;
        assembly.tools = assembly.tools.filter((tool) =>
          !isToolDisabled(String(tool?.name ?? ""), workspace));
      }
      return next();
    }), "mcp-skill-panel: tool disable filter");
}
```

**这是全局缝**：不需要 agent scope、不需要 `restrict()` 的名字校验、能拿到真实会话 cwd。

我原本的结论是"逐工具隐藏只能用 `agent.ctx.tools.restrict`，需按 agent 逐个挂 + 容错重放未知名"。**这个结论是错的**——我没找到 `system-prompt/assemble`。

已在我这台 0.2.0-rc.2 上核实存在：

```
dsh-system-prompt/lib/types/index.d.ts:27
'system-prompt/assemble'(assembly: PromptAssembly, context: AssembleContext, next): Promise<PromptAssembly>

PromptAssembly = { sections, contexts, tools, variables }   // tools 可直接过滤
AssembleContext 带 agent → agent.session.header.cwd          // 拿到 per-session 工作目录
```

### 1.4 MCP 中间层 —— 我完全没有

`dsh_mcp_search` / `dsh_mcp_call` 两个真实模型工具（`mcpcall-*.mjs`），配"保活启用→等注册→插件内执行→空闲回收"。

效果：停用的 MCP 对模型隐藏，需要时按需开、用完回收。**这是真·tool search**，我只做到"隐藏省钱"，它做到"省钱还能用"。

### 1.5 其他它有我无

| 能力 | 它的实现 |
|---|---|
| 项目级 MCP | `.dsh/mcps/**/mcp.json`，按 workspace 隔离 + 热更新 |
| 迁移 | `mcp-convert.js`（225 行）转换 Claude Code / Codex 的 `mcpServers` |
| 停用态回填 | last-good catalog 快照 → "多少工具 / 约多少 token" |
| 工具批量 | `POST /mcp/toolBulk` |
| 状态队列 | `pendingMcp` 内存队列 + "下次会话生效"选项 |
| 乐观更新 | 客户端布尔翻转先于服务端确认 |

---

## 2. 这次审计改变了我的两个设计决定

### 2.1 MCP 门禁应改用 `system-prompt/assemble`

| | `agent.ctx.tools.restrict`（我现在的） | `system-prompt/assemble` 过滤 |
|---|---|---|
| 全局生效 | 否，要遍历 `agents.list()` | **是** |
| 新 agent | 要 `agent/created` 补挂 | 自动 |
| 未知名工具 | 抛错，要 pending 队列 | **无此问题**（按名字前缀过滤） |
| workspace 维度 | 拿不到 | 从 `context.agent.session.header.cwd` 取 |
| 逐工具粒度 | 可行但繁琐 | 自然 |

**决定：MCP 层重写为 assemble 过滤器。** 我原来的 `restrict` 方案是为"没有更好的缝"设计的，前提不成立。

### 2.2 项目配置定位应改用会话 cwd

我现在用 `config.projectDir ?? process.cwd()` —— 如果 `dsh web` 不是从项目根启动就失效。

`AssembleContext` 带 `agent`，能拿到**真实会话 cwd**。项目级配置定位和 MCP 的 workspace 隔离都该用它。

**决定：M2 起，项目层解析改为按会话 cwd，`projectDir` 降级为兜底。**

---

## 3. 我该保留自己做法的地方

| 项 | 理由 |
|---|---|
| Skill 四档 + 影子 | 它做不到 `name-only` / `user-invocable-only`，而这是你实际要的 |
| 不写 `SKILL.md` | 它改文件；我保持零污染可逆 |
| 静默失败自证 | 它没有；`lost` 检测是这套方案的安全网 |
| `/gate why` 归因 | 它没有"哪一层决定的"概念 |

---

## 4. 净结论

| 维度 | 谁强 |
|---|---|
| 功能覆盖 | **它**（17 路由 vs 5，逐工具 + 中间层 + 迁移 + 批量） |
| 实现规模 | 它 7,127 行 vs 我 1,050 行 |
| skill 控制精度 | **我**（4 档 vs 2 档） |
| 对用户文件的侵入 | **我**（零写入 vs 改 SKILL.md + 改 profile） |
| MCP 工具级机制 | **它**（assemble 过滤，我用了次级方案） |
| 错误可观测性 | **我**（lost 检测 + `/gate why`） |

**它更完整；我更有针对性。** 如果我继续做，第一优先是把 1.3 和 1.4 抄过来——那不是抄功能，是抄两个我找错的缝。
