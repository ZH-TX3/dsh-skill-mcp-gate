# dsh-skill-mcp-gate — 架构设计文档

> 状态：**v0.3 决策全部确认，spike 已完成，可进入 M1 实现**  
> 目标 DSH 版本：0.2.0-rc.2（本机实测）  
> 参考语义：Claude Code 2.1.308 的 `skillOverrides` / tool search / `rules: paths`

## 决策记录

| 项 | 决定 |
|---|---|
| 插件名 | **`dsh-skill-mcp-gate`** |
| Skill 后端 | **C 打底（M1）→ A 补全（M2）**；原方案 B（改写 frontmatter）**废弃** |
| 交付顺序 | 先 CLI / 配置文件，Web UI 放最后 |
| 项目级 MCP 文件 | **`<workspace>/.dsh/skill-mcp-gate.mcp.json`** |
| 目录预算策略 | **top-N + 显式 `priority`**（不做使用频次统计） |
| managed 层 | 不做（DSH 无此概念，只保留全局 + 项目两层） |
| `when` 路径门控 | **进 M2**（A 模式才有意义） |
| 逐工具门禁 | **拉回 M3，三层一次做完**（restrict 隐藏 + guard 拒绝 + 子 agent toolFilter） |
| 配置语义 | **三态 `on`/`off` + skill 专属 `name-only`/`user-invocable-only`**；不引入「可见但拒绝」；不适用值**报错不忽略**（§5.7） |
| M1 起点 | 先跑 restrict spike → **已完成，见 §7.3** |
| CC 配置兼容 | **接受 `skillOverrides` 作为 `skills` 别名**，CC 配置可整段粘贴 |
| plugin skill 同名竞争 | **M1 实测**（见 §5.4） |

### Spike 结论（静态分析即可定论，未起服务）

| 结论 | 证据 |
|---|---|
| 全局插件**不能**调 `restrict()` | 实现里显式抛错：`tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead` |
| 工具级**隐藏**需要 agent scope | 同上；`restrict` 只接受 scoped context |
| 但全局插件**能拿到** agent scope | `ctx.agents: AgentRegistry` + `list(): Agent[]`，且注释明确 `agent.ctx` 可用来 scope effects；有 `agent/created` / `agent/disposed` 事件 |
| 全局逐工具**拒绝**有更好的机制 | `ctx.tools.guard(ToolGuard)`：plain-context 注册即全局生效、同步、**单调不可翻转**（无 allow 结果，监听顺序无关） |

→ **工具级隐藏 v2 可做**（在每个 agent 的 scope 内 restrict）；工具级拒绝应改用 `guard()`，不是监听 `tools/pre-execute`。

---

## 1. 问题陈述

Claude Code 有四层上下文精细控制，DSH 缺三个：

| 能力 | Claude Code | DSH 现状 | 本插件 |
|---|---|---|---|
| skill 逐条可见性 | `skillOverrides` 四档 | ❌ 只有 frontmatter 两布尔位 | ✅ |
| skill 目录预算 | `skillListingBudgetFraction` 1% | ❌ 线性增长无上限 | ✅ top-N |
| 按路径渐进加载 | `rules/` + `paths:` glob | ❌ 只有目录级 | ✅ 作用于 skill |
| MCP 服务器级上下文释放 | tool search | ❌ 只能改 composition 重启 | ✅ 运行时 |
| MCP 逐工具门禁 | deny 规则 | ⚠️ 无统一入口 | ✅ `tools/pre-execute` |
| 指令文件预算 | 字符截断 | ✅ 更强（点名省略） | 复用，不改 |

**核心缝隙**：`SkillRegistry` 故意不做策略（原文：*"Consumers apply model or user invocation policy at their operational boundary."*），而 `dsh-tool-skill` 是消费方且不开放配置。**策略必须插在消费方，或替换消费方。**

---

## 2. 已验证的 API 依据

全部来自本机 `node_modules/@deepseek-ai/*` 类型定义，非推测。

### 2.1 Skill registry

```ts
list(options?: SkillViewOptions): Promise<SkillSummary[]>
snapshot(options?): Promise<SkillCatalogSnapshot>
get(name, options?): Promise<SkillDefinition | undefined>
register(skill: SkillRegistration): () => void          // 注册 runtime skill，返回 disposer
registerProvider(create): () => void
```

| 字段 | 用途 |
|---|---|
| `name` / `description` / `whenToUse` | 目录呈现 |
| `path` | 绝对路径 → **判定全局/项目** |
| `invocation: { modelInvocable, userInvocable }` | **只有两个布尔位** |
| `source` | `'project-dsh' \| 'project-agents' \| 'runtime' \| 'user-dsh' \| 'user-agents' \| 'custom' \| 'bundled'` |
| `provider` / `resourceBase` | 来源与资源基准 |

**同名解析优先级（同一 layer 内）**：`project-*` > `runtime` > `user-*` / `custom` / `bundled`

> ⚠️ 这条决定了 C 的能力边界：runtime 影子**盖不住 `project-dsh` / `project-agents`**。

### 2.2 目录来源与 rank（`dsh-skill-filesystem`）

| Rank | source | 路径 |
|---:|---|---|
| 100 | project-dsh | `<projectRoot>/.dsh/skills` |
| 200 | project-agents | `<projectRoot>/.agents/skills` |
| 300 | custom | `customSkillDirs` |
| 400 | user-dsh | `<dshHome>/skills` |
| 500 | user-agents | `<agentsHome>/skills` |
| 600 | bundled | `bundledSkillDir` |

### 2.3 工具注册表（`dsh-tools`）

```ts
register(definition): () => void                 // 同层重名失败；run_code 为保留名
restrict(filter: ToolRestriction): () => void    // ⚠️ "for the calling agent scope"
schemas(scope?: ScopeKey): ToolSchema[]
get(name, scope?): ToolDefinition | undefined
```

```ts
interface ToolRestriction { allow?: readonly string[]; deny?: readonly string[] }
```

- `restrict` 按**全局工具名**做 allow/deny 掩码，不动连接
- `run_code` 永不被移除/遮蔽；**`skill` 是普通全局工具，可被 shadow 或 restrict**
- `scopeOf(ctx): ScopeKey | undefined`，`undefined` = 全局层

### 2.4 调用拦截（`dsh-tools` 事件）

```ts
'tools/pre-execute'(exec: ToolExecution, next): Promise<PreToolDecision>
// 返回 allow / deny / cancel / ask
```

### 2.5 Loader（`@deepseek-ai/cordis-plugin-loader`）

```ts
ctx.loader.resolve / entries / create / remove / update
```

`EntryOptions` 含 `disabled?: boolean`。profile patch 里 `- id: <row> \n disabled: true` 可关掉**下层 bundle** 的行（用户现有 patch 已对 `mcp-connector`、`skills-manager` 等这么做）。

### 2.6 配置（`dsh-settings`）

只暴露 `.volatile()` 字段，持久化到 **profile 的 Cordis patch（= 全局层）**。→ 细粒度 overrides 必须自建双层文件。

---

## 3. 后端 C：runtime 影子（M1）

### 3.1 机制

对每条需要覆盖的 skill，注册一个同名 runtime skill：

```ts
const disposer = ctx.skills.register({
  name: original.name,
  description: original.description,      // 同源，不改
  whenToUse: original.whenToUse,
  content: loadedBody,                    // 必须提供正文（注册时即需）
  source: 'runtime',
  resourceBase: original.resourceBase,
  invocation: { modelInvocable, userInvocable },  // ← 唯一改动点
})
```

`invocation` 映射：

| 档位 | modelInvocable | userInvocable |
|---|---|---|
| `on` | true | true |
| `user-invocable-only` | false | true |
| `off` | false | false |

### 3.2 能力与限制

| | |
|---|---|
| ✅ 覆盖来源 | `user-dsh`、`user-agents`、`custom`、`bundled` |
| ❌ 覆盖不到 | `project-dsh`、`project-agents`（runtime 优先级更低） |
| ❌ 拿不到 | `name-only`（非 invocation 维度）、目录预算、路径门控、描述覆盖 |
| 用户文件 | 不动 |
| composition | 不动 |

### 3.3 实现要点

1. **正文加载**：注册时需 `content`。用 `ctx.skills.get(name)` 取正文；`off` 档其实用不到正文，但注册契约要求，仍需加载（技能通常几十 KB，可接受）
2. **变更生效**：配置变化 → 调用 disposer 反注册 → 重新注册；注册会自动 invalidate 目录缓存
3. **幂等**：以 `Map<name, disposer>` 管理，避免重复注册导致「同层 runtime 重名 first-wins」把旧影子留下
4. **项目级 skill 检测**：若 `source` 是 `project-*`，不注册影子，改为在 `/gate status` 里标注「需 A 模式生效」

### 3.4 风险

| 风险 | 对策 |
|---|---|
| 影子注册后正文变更不同步（用户改了 SKILL.md） | 订阅 `skills/change`，重建影子 |
| 某条 skill 被 `off` 后正文仍驻留内存 | 只在 `off` 档跳过正文加载（传最小占位），避免无谓内存 |

---

## 4. 后端 A：替换消费方（M2）

### 4.1 机制

```yaml
# profile patch
- id: tool-skill
  disabled: true
```

由本插件提供等价的「目录 + `skill` 工具」。**不需要 fork 官方代码**（官方 396 行中策略只有一行：`snapshot.skills.filter(isModelInvocable)`）。

### 4.2 必须复刻的契约

1. 目录以 **user 角色持久消息**注入，`source = { kind: 'skill-catalog', form: 'catalog', update?: true, entries: [{name, description}] }`
2. 目录变更时**追加完整替换**（`update: true`）；空目录要能**停用旧名字**
3. 工具名必须是 `skill`，返回 `<skill_content>` 块 —— **复用官方导出的 `renderSkillContent()` / `escapeText()`，不要自己拼 XML**
4. 正文不做长度上限（与现状一致）
5. **回放兼容**：旧会话日志里已有 `skill-catalog` 消息，重启/resume 时必须能正确重放，不得报错或重复注入

### 4.3 A 带来 C 没有的能力

| 能力 | 说明 |
|---|---|
| `name-only` | 目录里只留名字，省描述字符但保留可调用 |
| 描述覆盖 | 配置里写短描述替代原描述 |
| 目录预算 | top-N + `priority` |
| 路径门控 `when` | 只在匹配路径工作时段出现 |
| 项目级 skill 覆盖 | 不受 runtime 优先级限制 |

### 4.4 回落

A 出问题时：删掉 `disabled: true` 一行 → 恢复官方 `tool-skill` → C 模式仍生效。**这是分两期的核心价值。**

---

## 5. 数据模型

### 5.1 文件位置

| 层 | 路径 | git |
|---|---|---|
| 全局 | `~/.dsh/skill-mcp-gate/settings.json` | ❌ |
| 项目 | `<workspace>/.dsh/skill-mcp-gate.json` | ✅ 建议 |
| 项目 MCP | `<workspace>/.dsh/skill-mcp-gate.mcp.json` | ✅ 建议 |

项目层覆盖全局层；两层都没有 → 沿用 frontmatter（`SkillSummary.invocation`）。

### 5.2 Schema

```jsonc
{
  "version": 1,

  "skills": {
    // 简写：仅状态
    "dataviz": "off",
    "keybindings-help": "off",
    "code-review": "name-only",          // 需 A 模式；C 模式下忽略并提示
    "update-config": "user-invocable-only",

    // 完整形式
    "playwright-cli": {
      "state": "on",
      "priority": 10,                    // 预算 top-N 排序依据，越大越靠前
      "description": "浏览器自动化，碰 web/UI 时使用",   // 需 A
      "when": ["**/*.tsx", "**/pages/**", "playwright.config.*"],  // 需 A
      "scope": ["**/frontend/**"]        // 本条的整份配置仅在该 cwd 下适用
    }
  },

  "skillCatalog": {
    "maxEntries": 12,          // top-N；null = 不限制
    "maxDescChars": 500,       // 单条描述上限（对齐 DSH 默认）
    "unnamedPriority": 0       // 未写 priority 的默认值
  },

  "mcp": {
    "servers": {
      // 字符串简写，与 skills 完全一致
      "xiaohongshu-mcp": "off",
      "exa": {
        "state": "on",
        "tools": {
          // 与 skills 共用同一套 state 词汇
          "crawling_exa": "off"         // 从提示词消失 + 拒调用
        }
      },
      "context7": "on"
    }
  },

  "diagnostics": {
    "explainOnDeny": true,
    "notifyOnBudgetDrop": true
  }
}
```

### 5.3 档位语义

| 值 | 模型可见 | `/` 菜单 | `skill` 可加载 | C 支持 |
|---|---|---|---|---|
| `on` | 名称 + 描述 | ✅ | ✅ | ✅ |
| `name-only` | 仅名称 | ✅ | ✅ | ❌ |
| `user-invocable-only` | ❌ | ✅ | ❌ | ✅ |
| `off` | ❌ | ❌ | ❌ | ✅ |

无配置 → 读 `SkillSummary.invocation` 作为基线。**配置只做覆盖，永不回写文件。**

### 5.4 与 Claude Code `skillOverrides` 的对应关系

**配置格式完全兼容**，值形式一致（字符串简写）。`skillOverrides` 作为 `skills` 的**别名**接受，CC 用户可整段粘贴：

```jsonc
// CC 原样
{ "skillOverrides": { "dataviz": "off", "code-review": "name-only" } }
// 本插件等价
{ "skills":        { "dataviz": "off", "code-review": "name-only" } }
```

两者同时出现时 `skills` 优先（避免歧义），并在 `/gate doctor` 提示。

**覆盖矩阵**（按 `SkillSource`，★ 已由 `test/registry-shadow.mjs` 实测）：

| 来源 | C 模式（M1） | A 模式（M2） |
|---|---|---|
| `bundled`（如 dataviz） | ✅ 实测通过 | ✅ |
| `user-dsh` / `user-agents` | ✅ 实测通过 | ✅ |
| `custom` | ✅ 实测通过 | ✅ |
| `project-dsh` / `project-agents` | ❌ 实测 project 胜出 | ✅ |
| plugin 提供的 `runtime` skill | ⚠️ **first-wins**，见下 | ✅ |

依据：同 layer 内同名优先级 `project-*` > `runtime` > `user-*` / `custom` / `bundled`；同级 runtime 之间 **first-wins**。

### 5.5 实测结论（`test/registry-shadow.mjs`，六个用例）

| # | 场景 | 结果 |
|---|---|---|
| A | `user-dsh` + runtime 影子 | ✅ runtime 胜出，`invocation` 生效 |
| B | 两个同名 runtime（先/后） | ⚠️ **先注册者胜**，后者拿到 no-op disposer |
| C | `project-dsh` + runtime 影子 | ❌ project 胜出，影子无效 |
| D | `project-dsh` + **伪装**成 `project-dsh` 的影子 | ❌ 仍 project 胜出 —— **伪装来源不是歪招，无效** |
| E | `bundled` + runtime 影子 | ✅ runtime 胜出（dataviz 场景成立） |
| F | `custom` + runtime 影子 | ✅ runtime 胜出 |

**推论**：
1. 你的主用例（关掉 `dataviz` 等 bundled skill）**C 模式就够**
2. project 级 skill 无法通过任何影子手段覆盖，**只能等 A 模式**（D 用例已排除侥幸空间）
3. plugin 提供的 runtime skill 可能因加载顺序抢先，**必须做失手检测**

### 5.6 影子失手检测（M1 必做）

`register()` 在被 first-wins 击败时返回 **no-op disposer 且不报错**，所以必须自证成功：

```ts
shadowDisposers.set(name, ctx.skills.register(reg))
const winning = (await ctx.skills.list()).find(s => s.name === name)
if (winning?.invocation.modelInvocable !== want.modelInvocable) {
  // 失手：被更早注册的同名 runtime 或更高优先级来源压制
  lost.set(name, { wanted: want, actual: winning })
}
```

`/gate status` 与 `/gate doctor` 必须列出 `lost`，并提示「该 skill 需 A 模式或由提供方插件让位」。**静默失手是最坏的失败模式**，比报错更糟。

### 5.7 统一状态词汇（skill 与 mcp 共用）

三处（skill、mcp server、mcp tool）共用同一个 `state` 字段名和同一套值，字符串简写与对象详写都支持：

| state | skill | mcp server | mcp tool | 底层机制 |
|---|---|---|---|---|
| `on` | 名称+描述，可调 | 连接，工具全在 | 在提示词里，可调 | — |
| **`off`** | 不可见，不可调 | 断开，工具全消失 | **从提示词消失**，拒调用 | skill: 影子 invocation `{false,false}`<br>server: `loader.remove`<br>tool: `agent.ctx.tools.restrict({deny})` |
| `name-only` | 仅名称，可调 | — | — | A 模式目录重写 |
| `user-invocable-only` | 模型不可见，`/name` 可调 | — | — | 影子 invocation `{false,true}` |

**只有三态 + skill 专属两态。不引入「可见但拒绝」状态。**

理由：`off` 同时满足两个目标 —— 省 token（从提示词消失）和防误触（模型不知道它存在，不会去试）。"可见但拒绝"两者都做不到：既付了 schema 的 token，又留着被误调的可能。**没有配置价值。**

**规则**：

1. **`off` 在三个位置语义完全一致** —— "从模型上下文中消失且不可用"。这是共用词汇的核心价值。
2. **对不适用的位置写了不支持的 state，必须报错**，不能静默忽略：
   - `skills.foo: "disable"` / 任何未知值 → 报错，列出可用值（`on` / `name-only` / `user-invocable-only` / `off`）
   - `mcp.servers.x.tools.y: "name-only"` → 报错，工具没有"只留名字"的呈现形态
   - `mcp.servers.x: "user-invocable-only"` → 报错，MCP 服务器没有面向用户的调用入口

> 理由同 §5.6：**静默忽略会让用户以为配置生效了**。宁可启动时红字，不要运行期装死。

### 5.8 `guard()` 的角色：内部兜底，不是用户状态

`ctx.tools.guard()` 保留，但**不作为配置项暴露**，只在一种情况下启用：

**pending 窗口**。`restrict()` 校验 `restrictableNames`（当前已知全局工具），而 MCP 服务器可能尚未连上 —— 此刻配置为 `off` 的工具名还不存在，`restrict()` 会抛错。

这段时间里模型仍可能调用该工具（如果服务器恰好在窗口内连上）。所以：

```
工具名未知 → guard 先挡住（单调、按名匹配、不依赖 scope）
工具名出现 → restrict 生效（消失 + 拒调用）→ guard 成为冗余但无害
```

两者结论一致（都是拒绝），所以并存不会冲突。

**好处**：不存在"配置了 off 但还能调用"的窗口期。`guard` 是这个保证的实现手段，用户看不见它，也不需要配它。

---

## 6. 优先级与解析

```
frontmatter invocation            ← 基线
   ↑
全局 settings.json
   ↑
项目 .dsh/skill-mcp-gate.json
   ↑
会话临时覆盖（/gate set --session，仅内存）
```

产出 `EffectivePolicy`，每条带 `decidedBy: { layer, file, path }`，支撑 `/gate why`。

---

## 7. MCP 控制

### 7.1 服务器级（真省 token）

mcp-client 行是 effect-scoped（*"disposal disconnects from the server, unregisters all tools"*）：

```ts
// 停用
for (const e of [...ctx.loader.entries()].filter(isMcpRowFor(server)))
  ctx.loader.remove(e.id)
// 启用：用首次停用前保存的 config 快照还原
ctx.loader.create({ name: '@deepseek-ai/dsh-mcp-client', config: saved }, parent, pos)
```

- 本插件创建的 entry id：`gate:mcp:<scope>:<serverName>`
- **只操作自己命名空间**，对 `dsh-mcp-connector` 的 entry 只读不删
- 默认**延迟到下一轮生效**，避免打断进行中的调用

### 7.2 逐工具控制 —— 机制 DSH 已内建

**关键发现**：DSH 已有 `ToolRestriction`（`{ allow?, deny? }`，按工具名），语义正是我们想要的：

> In-process backends apply it as a scoped `tools.restrict()` in the child's creation window: the named tools **vanish from the child's prompt AND refuse to execute (one visibility)**, with loud unknown-name validation.

即：**从提示词消失 + 拒绝执行，一份可见性**（不会出现"看不见但能调"的裂缝），未知名高声报错。

MCP 工具是普通全局工具名（`mcp__<server>__<tool>`），所以**可以直接点名**。

**两层层级**（用户可见的配置面）：

| 层级 | 机制 | 省 schema token | 全局插件可调 |
|---|---|---|---|
| 整台服务器 | `ctx.loader.remove(id)` | ✅ 全部 | ✅ |
| 单工具 | `agent.ctx.tools.restrict({deny})` | ✅ 单条 | ⚠️ 需按 agent 挂 |

`guard()` 只在 pending 窗口兜底，**不作为配置面暴露**（见 §5.8）。

**主 agent 的挂法**（`agent.ctx` 已确认真实存在，`dsh-agent-loop`、`dsh-agent-preset-registry` 均在用）：

```ts
for (const agent of ctx.agents.list())
  agent.ctx.tools.restrict({ deny: policy.deniedToolNames() })
// 新 agent
ctx.on('agent/created', (agent) => applyTo(agent))
```

**两个必须处理的实现细节**：

1. **未知名会抛错**：`restrict()` 校验 `restrictableNames`（当前已知全局工具）。MCP 服务器可能后连，此时名字还不存在 → 必须**容错重放**：
   ```ts
   applyTolerant(names)  // 逐名 try，未知名暂存 pendingTools
   ctx.on('tools/change', () => retryPending())
   ```
2. **幂等**：每次 `restrict()` 都 append 一条 restriction，重复调用会累积 effect。用 `Set<agentId>` 记账，同一 agent 只挂一次；agent 释放时随 scope 自动清理。

### 7.3 `guard` 的边界（实现细节）

`guard` 单调、同步、按名匹配、不依赖 scope —— 因此它能覆盖 `restrict` 覆盖不到的窗口（工具名尚未注册时）。两者结论一致（拒绝），并存不冲突。

但它**不省 token**，所以永远不暴露成配置项。用户要 `off`，就得到"消失 + 拒绝"；不存在只拒绝的选项。

### 7.4 subagent 已经有现成入口

`toolFilter: ToolRestriction` 是 subagent descriptor 的正式字段（`dsh-subagent`），**今天就能用**，且 resume 时自动重放。本插件可以直接把全局配置映射进去，零成本覆盖子 agent。

### 7.5 状态

原定「逐工具 → v2」。机制现已确认可行（只需按 agent 挂 + 容错重放），**是否提前进 M3 待定**。

### 7.4 项目级 MCP

读 `<workspace>/.dsh/skill-mcp-gate.mcp.json`（结构同 `.mcp.json` 的 `mcpServers`），按 `cwd` 作用域挂载，entry id 含 workspace hash → **A 项目停用不影响 B 项目**。

---

## 8. 生效时机

| 变更 | 生效 | 代价 |
|---|---|---|
| C 模式 invocation 覆盖 | disposer + 重新 register → 目录 invalidate | 下一轮目录追加替换 |
| A 模式四档 / 描述 | 重建目录（节流 5s） | cache 断点 |
| `when` 路径门控 | 每轮评估 | 无 |
| MCP `state` | loader remove/create | 重连，进行中调用失败 |
| MCP `tools` | 内存表 | 无 |

配置写入用「读-改-写 + revision 校验」，对齐 `dsh-settings` 的 `SettingsConflictError` 语义。

---

## 9. 命令面（M1 交付物）

| 命令 | 作用 |
|---|---|
| `/gate status` | 生效策略、预算水位、C/A 模式、被预算丢弃项 |
| `/gate why <skill>` | **哪一层决定当前状态**；项目级 skill 在 C 模式下提示「需 A」 |
| `/gate skills` | 列出 skill：来源、档位、描述字符、是否被覆盖 |
| `/gate mcp` | 服务器状态、工具数、估算 token、逐工具策略 |
| `/gate set <path>=<value> [--session]` | 临时或持久化修改 |
| `/gate doctor` | 自检：文件合法性、与官方 `tool-skill` 是否冲突、影子是否漏注册 |

---

## 10. 目录结构

```
dsh-skill-mcp-gate/
├─ package.json            # dsh.bundle + dsh.client
├─ cordis.patch.yml
├─ README.md / README.zh.md
├─ src/
│  ├─ index.ts             # apply(ctx, config)
│  ├─ policy/
│  │  ├─ schema.ts         # schemastery 校验
│  │  ├─ store.ts          # 双层读写 + watch + 原子写
│  │  └─ resolve.ts        # 优先级合并 → EffectivePolicy
│  ├─ skill/
│  │  ├─ shadow.ts         # ★ C 模式：runtime 影子
│  │  ├─ consumer.ts       # ★ A 模式：目录 + skill 工具
│  │  ├─ replay.ts         # ★ A 模式：skill-catalog 回放兼容
│  │  ├─ classify.ts       # 全局/项目判定（rank 前缀）
│  │  └─ budget.ts         # top-N + priority
│  ├─ mcp/
│  │  ├─ loader-gate.ts
│  │  ├─ tool-gate.ts
│  │  └─ project.ts
│  └─ commands.ts
├─ client/                 # M4
└─ test/
```

---

## 11. 里程碑

| 期 | 范围 | 验收标准 |
|---|---|---|
| **M1** | `PolicyStore` + `Resolver` + C 影子 + 命令面 | ① 把 `dataviz` 设为 `off` 后，抓包确认目录里没有它；② `/gate why dataviz` 正确归因到项目层文件；③ 项目级 skill 在 C 模式下被标注「需 A」 |
| **M2** | A 模式：`disabled: true` + 自有目录/工具 + `name-only` + 描述覆盖 + top-N 预算 + **`when` 路径门控** | ① 请求体字符数低于 C 模式；② 旧会话 resume 不报错、目录不重复；③ `when` 未匹配时 skill 不出现在目录里；④ 删除 `disabled` 一行可完整回落 |
| **M3** | MCP 两层配置面：① 服务器级 `loader.remove/create` ② 逐工具 `agent.ctx.tools.restrict`（按 agent 挂 + 容错重放 + pending 窗口 `guard` 兜底）③ 子 agent `toolFilter` 映射 ④ 项目级 MCP 文件 | ① 服务器 `off` 后 `mcp__*` 全消失；② 工具 `off` 后该条从提示词消失（抓包确认）且调用被拒；③ MCP 后连时 pending 窗口内调用被 guard 挡住，连上后 restrict 接手，全程无"可调用"空档；④ 启用还原配置原样；⑤ A 项目停用不影响 B 项目 |
| **M4** | Web 设置页 + 诊断页 | 设置页可改可落盘；并发写有冲突提示 |
| **v2（未排期）** | 逐工具：`restrict` 按 agent 隐藏 + `guard` 全局拒绝 | §7.2 / §7.3 |

---

## 12. 风险与失败模式

| 风险 | 影响 | 对策 |
|---|---|---|
| C 影子漏注册 / 重名 first-wins 留旧影子 | 配置改了不生效 | disposer 表严格管理；`/gate doctor` 自检 |
| 影子正文与磁盘正文不同步 | 调用到旧内容 | 订阅 `skills/change` 重建 |
| A 模式与官方 `tool-skill` 同时启用 | `skill` 工具重名 → 注册失败 | 启动时检测 `ctx.tools.get('skill')` 来源；冲突则拒绝激活并给出可操作报错 |
| A 模式回放不兼容 | 旧会话 resume 目录错乱 | M2 必须覆盖 replay 用例；不达标不切默认 |
| 移除正在使用的 MCP 服务器 | 调用失败 | 默认延迟到下一轮 |
| `restrict()` 在主 agent 不可用 | 工具级隐藏做不到 | M1 spike 定论；退化到服务器级 |
| 预算丢弃导致 skill 不触发 | 静默能力下降 | 丢弃时通知；`/gate status` 列明 |

---

## 13. 决策状态

**已全部确认，无待定项。**

| 曾待定 | 结论 |
|---|---|
| `when` 路径门控 | 进 M2 |
| 逐工具门禁 | v1 不做，机制结论入 v2 |
| restrict spike | 已完成（静态定论，见开头表格） |

## 14. 实现进度（截至 v0.2.0 代码）

**已交付**：M1（skills C 模式 + 命令面）+ MCP 服务器级 + Web 设置页。

| 交付物 | 文件 | 说明 |
|---|---|---|
| skills 四档 / C 模式 | `lib/policy.js` `lib/shadow.js` | 含 first-wins 静默失败自证 |
| MCP 服务器级 | `lib/mcp.js` | **改用 `agent.ctx.tools.restrict`，不走 loader**（见 §15.1） |
| 配置读写 | `lib/store.js` | 原子写、保留无关键、写进"决定该项的那一层" |
| 命令面 | `index.js` | `/gate status\|skills\|mcp\|why\|doctor\|reload\|set` |
| Web API | `index.js` | 5 条路由 + `x-gate-token` 鉴权 |
| 界面 | `lib/client.js` | 左侧一级面板：`sidebar.panellist` 图标 + `main` 面板（key 对齐） |

### 14.1 偏差：MCP 用 restrict 而非 loader

原设计 §7.1 写的是 `loader.remove/create`。实现前核实到 **`dsh-app-boot` 的 `Loader.write()` 会真正落盘**（`writeFile(this.root.data)`），意味着启停一次就永久改写用户的 profile 组合文件，卸载插件也不复原。

改用 `agent.ctx.tools.restrict({ deny })`：

- 工具同样从提示词消失（省 token 效果一致）
- 不写任何配置文件、不断连、释放 disposer 即恢复
- 代价：MCP 服务器进程保持连接

参考实现 `dsh-mcp-skill-panel@0.6.0` 走的是 loader 路线，本插件**有意不采用**。

### 14.2 客户端半边的形态（已验证）

> **v0.4.0 修正**：原注册进 `settings.section`（设置内一页）。改为一級面板后需要两条注册：
> `sidebar.panellist`（图标，options 带 `id`，owner props 只有 `{size, active}`，点击由外壳按 id 切换）
> + `main`（面板本体，`key` 与上面 `id` 相同；layout 以 `entryKey = activePanelId` 渲染）。
> `dsh.client.inject` 需声明 `dsh-client-ui-layout` 与 `dsh-client-ui-sidebar`，否则槽位可能尚未声明。

DSH 的 client bundle 是 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })` 包装，`react` / `react/jsx-runtime` 由宿主 loader 提供 —— **不需要构建步骤，可手写**。

设置页注册：

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'skill-mcp-gate', order: 40,
  label: () => 'Skill / MCP 门禁',
}, GateSection))
```

`package.json` 需声明 `dsh.client.inject: ['@deepseek-ai/dsh-client-ui-slots']` 与 `exports['./client']`。

### 14.3 实现中修掉的三个真 bug

| bug | 症状 | 修法 |
|---|---|---|
| `updateJsonFile` 丢弃 mutator 返回值 | 写配置完全无效（点了没反应） | 写回 `result` 而非 `current` |
| `verify()` 未把失败项从 `applied` 摘掉 | 同一 skill 同时显示"已生效"和"未生效" | 检出 lost 时同步剔除 |
| `/gate set` 解析器与文档不一致 | 文档写 `key=value`，代码按空格分两段 | 两种写法都支持 |

### 14.4 待办

1. `name-only` / 描述覆盖 / 目录预算 / 路径门控（M2，需 A 模式）
2. 配置变更自动监听（需防自身 `register()` 触发的重入）
3. 设置页缺 i18n（当前写死中文，未注册 locale 字典）
4. workspace 维度的 MCP 隔离（需 scope→agent 反查，见 14.5）
5. MCP 中间层 `search`/`call`（被依赖解析阻塞，见 14.5）

### 14.5 对照审计后的架构修正（v0.3.0）

审计 `dsh-mcp-skill-panel@0.6.0` 源码（7,127 行）后修正两处。

**修正 1：MCP 改用 `system-prompt/assemble` 装配过滤**

原实现用 `agent.ctx.tools.restrict`。审计发现更好的缝（对方 `mcpcall-*.mjs:640`）：

```js
ctx.root.on("system-prompt/assemble", (assembly, context, next) => {
  assembly.tools = assembly.tools.filter(...)
  return next()
})
```

| | `agent.ctx.tools.restrict`（旧） | `system-prompt/assemble`（现） |
|---|---|---|
| 全局生效 | 否，要遍历 `agents.list()` | **是** |
| 新 agent | 要 `agent/created` 补挂 | 自动 |
| 未知名工具 | 抛错，需要 pending 队列 | **无此问题** |
| 改文件 | 否 | 否 |

已在本机 0.2.0-rc.2 核实事件存在（`dsh-system-prompt/lib/types/index.d.ts:27`）。

**修正 2：workspace 维度暂不支持（与对方不同）**

对方读 `context?.agent?.session?.header?.cwd`，但本机 `AssembleContext` 只有 `{ scope?, signal? }` —— **没有 `agent`**。它的 workspace 过滤在 rc.2 上实际是静默失效的（兜底成 undefined）。

本插件因此不做 workspace 隔离，配置按全局生效。要做需要 scope→agent 反查（`ctx.agents.list()` + `scopeOf(agent.ctx)` 比对 `context.scope`），而 `scopeOf` 需要 import `@deepseek-ai/dsh-scope`，本地路径插件解析不到。

**阻塞项：中间层 `search`/`call` 未实现**

对方的 `dsh_mcp_search` / `dsh_mcp_call` 需要 `defineTool`（来自 `@deepseek-ai/dsh-tools`）。本机实测：

```
$ node -e "import('@deepseek-ai/dsh-tools')"
不可解析: ERR_MODULE_NOT_FOUND
```

profile 的 `node_modules/@deepseek-ai` 只有 6 个包，不含 `dsh-tools`；本地路径插件向上查找也拿不到。

解锁方式二选一：把插件做成真正的 npm 包（`npm pack` 后安装），或把 `@deepseek-ai/dsh-tools` 装进 profile 的 node_modules。

我的隐藏方式是"装配期过滤"而非"卸载"，工具始终处于已注册状态，所以做 `call` 只需 `ctx.tools.execute({ callId, name, arguments, agent })` —— 比对方的保活/回收方案简单，**等依赖可用时约 80 行**。

## 15. M1 首版实现记录（skills-only）

**产物**（`~/.dsh/plugins/dsh-skill-mcp-gate/`）：

| 文件 | 行数 | 职责 |
|---|---:|---|
| `index.js` | 219 | `apply()` 接线 + `/gate` 命令面 |
| `lib/policy.js` | 112 | 配置校验、`skillOverrides` 别名、分层合并（纯函数） |
| `lib/shadow.js` | 119 | C 模式影子 + first-wins 静默失败检测 |
| `cordis.patch.yml` | 14 | 插入插件行 |
| `test/policy.test.mjs` | 73 | 纯函数单测 |
| `test/shadow.test.mjs` | 111 | 真实 `SkillRegistry` 集成测试 |
| `test/wiring.test.mjs` | 89 | 假 ctx 跑 `apply()`，验命令面 |
| `test/e2e.test.mjs` | 71 | 配置文件 → registry 全链路 |
| `test/registry-shadow.mjs` | 127 | DSH 同名解析规则回归（§5.5 那六个用例） |

**完成判据对照**：

| 判据 | 状态 |
|---|---|
| ① `dataviz` 设 `off` 后目录里消失 | ✅ `e2e.test.mjs` 断言 `invocation = {false,false}` |
| ② `/gate why` 能指出哪个文件哪一行 | ✅ 归因到 `decidedBy.file` + `label` |
| ③ registry 两条结论写进文档 | ✅ §5.5 |

**相对设计的偏差（有意为之）**：

| 项 | 设计 | 实现 | 原因 |
|---|---|---|---|
| 配置监听 | `watch: true` 自动重载 | **手动 `/gate reload`** | `skills/change` 会被自己的 `register()` 触发，极易写成重入死循环。M1 先不做，等有稳定需求再加防抖 + 抑制 |
| MCP | 部分配置 | **完全不读，明确告警** | M3 才实现；静默忽略会让人以为生效了 |
| `name-only` | C 模式不支持 | **如实进 `unsupported`** | 不假装成功 |
| 项目配置定位 | 按会话 cwd | `config.projectDir` ?? 进程 cwd，可 `/gate reload <dir>` 覆盖 | 拿不到可靠的 per-session cwd 时的保守选择 |

**已知待办（M2 起步点）**：

1. `security`: `verify()` 的 `skills.list()` 未传 cwd，若未来支持 per-session 项目配置需补
2. `watch`：实现时要加「重建期间抑制自身触发的 change 事件」
3. `name-only` 与描述覆盖随 A 模式一起做

## 16. v0.7.0 — CC 语义对齐第二轮

### 16.1 `name-only` 真生效（推翻 §14.7 的判断）

§14.7 当时判定 `name-only` 要等 A 模式替换 `dsh-tool-skill`。重读上游源码后否掉这个结论：

`dsh-tool-skill/lib/index.js` 里，模型能看到 skill 的唯一通道是那条 `skill-catalog` 消息
（`renderCatalogEntries` 逐条渲染 `- \`name\`: description`），`skill` 工具自身的 description
是通用文案，不含目录。既然目录门禁已经能重写这条消息，**`name-only` 就只是「渲染条目时不带描述」**，
不需要动 runtime 影子，也不需要替换消费方。

| 档位 | 目录消息 | `skill` 工具 guard |
|---|---|---|
| `on` | 名字 + 描述 | 放行 |
| `name-only` | **只有名字** | 放行（模型仍可调用） |
| `user-invocable-only` | 整条剔除 | 拒绝 |
| `off` | 整条剔除 | 拒绝 |

实现上有一条约束：**只改渲染文本，不改 `source.entries`**。
上游用 `digestCatalogEntries(entries)` 判断要不要重新发布目录，
如果我们把 `description` 改成空串写进 `source`，摘要就会和上游算出来的不一致，
每个 turn 都会触发一次重发布。所以 `renderCatalogUpdate(entries, nameOnly)` 的
`nameOnly` 只影响 `renderCatalogEntries`，`source.entries` 保持原样。

实测（用用户真实的 `~/.claude/settings.json`）：16 条 `skillOverrides` →
12 条 `name-only` 渲染成裸名字、4 条 `off` 整条消失、未配置的条目描述完好。

### 16.2 CC 的 MCP 定义源与批准语义

之前只读 CC 的 `skillOverrides`，MCP 完全是本插件自己的配置。这轮补上 CC 的三处定义：

| 来源 | 文件 | scope | rank |
|---|---|---|---|
| `~/.claude.json` → `mcpServers` | 同一个文件 | `user` | 0 |
| `<cwd>/.mcp.json` → `mcpServers` | 项目文件 | `project` | 1 |
| `~/.claude.json` → `projects[<cwd>].mcpServers` | 同一个文件 | `local` | 2 |

- `~/.claude.json` 的 `projects` 用 `D:/Work/app` 这种正斜杠写法当键；
  `normalizeCwd()` 统一小写 + 正斜杠 + 去尾斜杠再比，Windows 上反斜杠路径也能对上。
- 批准状态读 settings：`disabledMcpjsonServers`（拒绝，优先级最高）>
  `enabledMcpjsonServers` / `enableAllProjectMcpServers`（批准）。
  `enableAll` 取最高层，拒绝取并集 —— 与 CC 文档一致。
- 语义落地：CC 的定义作为**基线层**进入 `serverPolicy`（layer = `cc`），
  被 CC 拒绝的默认 `off`，其余 `on`；本插件自己的全局 / 项目文件覆盖它。
  这样两个工具里对同一台服务器的判断不会打架。
- `project` 作用域里没被批准的服务器**不强行置 off**：CC 不批准代表它自己不连，
  但 DSH 连不连是 DSH 自己的配置决定，这里只在面板标 `CC 未批准`，不替用户做决定。

### 16.3 落在哪一层（本轮边界）

| 项 | 状态 |
|---|---|
| `name-only` | ✅ 目录文本剥离描述 |
| CC MCP 定义源 + 拒绝语义 | ✅ 基线层 |
| `skillListingBudgetFraction` | ❌ 上游已截断描述 + 拿不到上下文窗口 → 配置时明确告警 |
| `skillListingMaxDescChars` | ❌ 同上 |
| `.claude/commands/*.md` | ❌ 正文含 `!bash` / `$ARGUMENTS`，当 skill 注入语义不对 |
| CC 插件 skill | ❌ 本机未装；CC 自己也不让 `skillOverrides` 作用于插件 skill |

## 17. v0.8.0 — 分层重构（先立骨架，再往上加字段）

### 17.1 为什么要拆

v0.7.0 之前，Claude Code 的知识散在四个文件里：`policy.js` 解析 `skillOverrides` 别名、
`store.js` 列 CC 设置文件、`index.js` 排层序、`claude-mcp.js` 读 `.claude.json`。
后果是每加一个 CC 字段都要动 3–4 个文件，而且很容易把「CC 说什么」和「DSH 能做什么」混在一起写。

### 17.2 现在的分层与依赖方向

```
host/  ──▶ platform/ ──▶ DSH
  │           │
  └──▶ load.js ──▶ cc/ ──▶ core/
```

| 层 | 认识什么 | 不认识什么 | 新增内容时改这里 |
|---|---|---|---|
| `cc/` | CC 的文件格式与字段名 | DSH 事件、渲染 | 新字段、新设置键、新文件来源 |
| `core/` | 四档词汇、纯数据变换 | 任何文件名、任何 ctx | 新的判定逻辑（先写成纯函数） |
| `platform/` | DSH 的三个缝 | CC、策略从哪来 | 新的生效方式 |
| `host/` | 面板 / 命令 / HTTP | 判定逻辑 | 展示与交互 |
| `load.js` | 层序与覆盖关系 | 具体字段含义 | 新的配置层 |

三条硬约束：

1. **`core/` 里不出现 `claude`、`.claude`、`skillOverrides` 字样** —— 一旦出现就是漏层。
2. **`platform/` 不读配置文件** —— 它只接收 `getPlan()` / `getServers()` 这类取值器。
3. **未适配的东西必须显式产出**：frontmatter 的 `gap`、设置键的 `unsupported`，
   一路走到面板与 `/gate doctor`。静默忽略是最坏的失败模式。

### 17.3 目录门禁的输入变成「计划」

重构前门禁自己算「谁隐藏」，现在它只接收

```js
getPlan(entries) → { hide: Set<string>, nameOnly: Set<string> }
```

为什么不预计算：`nameOnly` 有一部分来自**预算**，而预算要按这条消息的真实条目算，
所以「条目」必须是入参。guard 期拿不到条目就传空数组 —— 预算只会降低描述、不会隐藏整条，
所以 `hide` 与条目无关。

这个改动是 v0.8.0 能塞进 P1 的前提：门禁不用知道预算存在。

## 18. v0.8.0 — P1：目录预算（CC 语义）

### 18.1 语义对齐

CC 的规则（docs/en/skills.md "Skill descriptions are cut short"）：

- 名字永远全部保留，只有描述会被丢
- 预算默认 = 上下文窗口的 1%，可用 `skillListingBudgetFraction` 改
- 也可用环境变量 `SLASH_COMMAND_TOOL_CHAR_BUDGET` 直接给固定字符数（优先级更高）
- 超预算时从**最不常用的 skill** 开始丢描述，常用的保住
- 单条描述另有上限 `skillListingMaxDescChars`（默认 1536）

本插件的实现（`core/listing.js` + `cc/listing.js`）：

| 项 | 实现 |
|---|---|
| 谁丢 | `planListing()`：隐藏 → 剔除；`name-only` → 本来就没描述、不参与丢；其余按使用次数升序丢描述 |
| 预算来源 | env `SLASH_COMMAND_TOOL_CHAR_BUDGET` > `skillListingBudgetFraction × contextWindowTokens` > 不启用 |
| 使用次数 | `~/.claude.json.skillUsage[name].usageCount`；无记录按 0（= 最不常用） |
| 同次数 | 先丢描述长的（降得快），再按目录顺序，保证确定性 |
| 单条上限 | **不支持**：DSH 上游 `catalogDescriptionMaxLength`（默认 500）已截断，拿不到原文；配了会告警 |

刻意不猜的：**没有 `contextWindowTokens` 就不启用比例预算**，只警告。
拿不到窗口就猜一个 200k，会按错误的基准把描述丢掉，比不省 token 更糟。

### 18.4 验证

- `test/listing.test.mjs`：预算关闭 / 超预算 / 丢弃顺序 / name-only 不重复丢 / 四种预算来源
- 真实实例（`SLASH_COMMAND_TOOL_CHAR_BUDGET=1500`，port 3099）：
  `/state` 的 `listing.budget` 正确返回 1500 与该来源；13 个 skill 中 9 条 name-only、
  2 个 skill 因 `argument-hint` / `allowed-tools` 报出未适配字段
- `npm test` 11 套件 244 项全绿

## 19. v0.9.0 — P2：MCP 中间层（CC tool search 的等价物）

### 19.1 问题

CC 的 tool search 解决的是「工具太多、每轮都要付定义的钱」。本插件此前只会**藏**：
`off` 让工具从提示词消失，模型也就再也拿不到它。于是「省 token」和「还能用」二选一。

### 19.2 第三档：`deferred`

MCP 服务器状态从 on/off 变三档：

| 档 | 出现在模型工具表 | 可被搜索 | 可被调用 |
|---|---|---|---|
| `on` | 是 | —（本来就能直接调） | 直接调 |
| `deferred` | **否** | **是** | 经 `gate_mcp_call` |
| `off` | 否 | 否 | 拒绝 |

为什么必须新增一档、而不是让 `off` 兼任：`off` 是**用户意图**（我不要这个工具），
`deferred` 是**成本策略**（我要，但别每轮都占位）。混在一起会让「关掉」失去意义，
也会让中间层绕过用户明确的关闭决定。

作用域刻意只到**服务器级**：逐工具的 `deferred` 在配置里会被拒绝并告警，
因为「同一台服务器一半常驻一半延迟」除增加心智负担外没有收益。

### 19.3 索引从哪来、什么时候有效

装配过滤器本来就能看到过滤前的完整 `assembly.tools`（含 description）。
在那里顺手记下 `deferred` 工具的 `{name, server, description}` 就是索引：
不额外遍历、不连服务器、不解析配置。

代价：**索引在下一次装配之后才有效**。第一次装配一定发生在任何模型请求之前，
所以对调用方不可见；真拿到空索引时按「还没有可用工具」回话，不猜。

### 19.4 两个工具

用 `ctx.tools.register()` 注册（全局层），名字 `gate_mcp_search` / `gate_mcp_call`。

```jsonc
// gate_mcp_search
{ "query": "爬网页", "server": "exa", "limit": 20 }   // query/server 都可省
→ 每行一条：`mcp__exa__crawl` — 抓取网页并返回正文…（描述截 120 字）

// gate_mcp_call
{ "name": "exa.crawl", "arguments": { "url": "https://…" } }
→ 转发嵌套调用的结果文本
```

拒绝规则（都给出可执行的下一步，而不是只说 no）：

| 情况 | 回应 |
|---|---|
| 名字不在索引 | 提示先 `gate_mcp_search` |
| 服务器是 `off` | 明确「已被关闭」，不透露是否存在 |
| 服务器是 `on` | 「该工具已直接可用，直接调用即可」 |
| 目标是 `gate_mcp_*` 自己 | 拒绝（不允许自调用/递归） |

### 19.5 嵌套 dispatch 的身份与取消

`ctx.tools.execute()` 在 PTC 模式下只允许**带 parent** 的调用执行原生工具名。
`ToolRunContext` 继承自 `ToolExecution`，手里有 `token` / `rootCallId` / `agent` / `signal`，
所以嵌套调用原样带上：

```js
ctx.tools.execute({
  callId: `${exec.callId}:gate:1`,   // 可追踪
  rootCallId: exec.rootCallId,
  parent: exec.token,                // 关键：标记为嵌套而非模型直呼
  agent: exec.agent,
  name: fullName,
  arguments,
  signal: exec.signal,               // 取消贯通
})
```

这样中间层不是「绕过策略的后门」：pre-execute、guard、超时策略对它一样生效。

### 19.6 结果的保真度（明确的降级）

工具声明 `output.schema = { ok, text, isError }`，`render()` 产出一条 text block。
嵌套结果里的 text block 原样拼接；**非文本块（图片/音视频）不转发**，
改为在末尾注明 `[未转发的非文本内容：image×2]`。

理由：内容块要穿过 `output.render` 的 JSON 值边界，伪造结构化内容很容易静默丢字段。
少给不如说清楚少了什么。

### 19.7 不新增依赖：手写 ToolDefinition

`defineTool` 位于 `@deepseek-ai/dsh-tools`，本地路径插件默认解析不到；
虽然能用绝对路径 import 到 `profiles/node_modules`，但那把一个**安装布局**焊进了代码。
实测 `defineTool` 只是把 `parameters` 规格转成 JSON Schema 并加参数校验 —— 两者都能自己写，
所以这里手写 `ToolDefinition`（`parameters` 直接给 JSON Schema），零新依赖、零路径探测。

### 19.8 没有 deferred 时零成本

注册是常驻的，但装配过滤器会在**没有任何 `deferred` 服务器**时把 `gate_mcp_search` /
`gate_mcp_call` 自己从 `assembly.tools` 里摘掉 —— 不用的功能不占一个 token 的工具位。

## 20. v0.9.1 — Windows rename 的偶发 EPERM

**现象**：全套测试约 1/20 概率挂掉，栈顶固定是 `renameSync` 抛 `EPERM`，写的是临时目录里的 JSON。
手工压测确认：`node test/store.test.mjs` 连跑 30 次，第 22 次失败。

**根因**：Windows 上 rename 覆盖已存在文件时，若目标正被杀毒/索引服务短暂持有，
会返回 `EPERM`/`EBUSY`/`EACCES` 而不是重试。这不是代码逻辑错，是平台行为。

**处理**：`lib/io.js` 的原子写加退避重试（10/25/50/100/200/400ms，共约 0.8s），
非这一类错误码直接抛，重试用尽也抛，并把临时文件删掉不留垃圾。

**证据**：改前 30 次里 1 次失败；改后 40 次 0 次。

这条不是本插件特有 —— 任何在 Windows 上做「临时文件 + rename」的插件都会撞，
所以这里记一笔，别在下次重构时又把重试删掉。

## 21. v0.10.0 — C1：CC `rules/` 的路径门控

### 21.1 为什么不是「读文件塞提示词」那么简单

CC 的 `.claude/rules/` 不是一个目录，是一套**条件加载**协议：

- 递归发现 `.md`
- 无 `paths` 的规则启动即加载（优先级同 `.claude/CLAUDE.md`）
- 有 `paths` 的规则，只在 Read / Write / Edit 命中匹配文件时才加载
- `paths` 接受 YAML 列表或逗号分隔字符串；glob 支持 `**` / `*` / `?` / `{a,b}`
- 展开预算 1000 个模式、4 MiB；不含花括号的模式不计入模式预算
- frontmatter 解析失败 → 当作没有 `paths`（无条件加载）
- `paths` 是唯一被读取的字段，frontmatter 在载入前剥掉

`dsh-agent-instructions` 的 Deferred Work 明确写了「不解释 `.claude/rules/`、`@path` import」，
所以这块只能自己补。

### 21.2 分层

| 层 | 文件 | 职责 |
|---|---|---|
| 位置 | `lib/paths.js` | `claudeRulesDirs(cwd, home)`，用户级在前、项目级在后 |
| CC 知识 | `lib/cc/rules.js` | 递归发现、`paths` 解析、花括号展开与预算 |
| 纯逻辑 | `lib/core/rules.js` | glob 编译、相对化、命中判定、注入规划、文本渲染 |
| DSH 接缝 | `lib/platform/rules-injector.js` | `tools/result` 记触碰 + `agent/pre-step` 注入消息 |

`core/rules.js` 里没有 `claude`、没有 `fs`、没有 `ctx`，可直接单测（`test/rules.test.mjs`）。

### 21.3 为什么用 `agent/pre-step` 而不是 `system-prompt/assemble`

`AssembleContext` 只有 `{ scope, signal }`，**没有 agent** —— 拿不到「这个会话碰过哪些文件」，
而这正是路径门控的全部输入。`agent/pre-step` 的 payload 有 `agent`，能读
`agent.session.header.cwd`，也能用 `WeakMap` 按 agent 存会话态（触碰集合 + 已注入集合）。

代价：注入的是一条 **user 消息**，不是系统提示的一段。消息只手写
`{ id: randomUUID(), role: 'user', content, source }`，与 `createMessage` 等价，
不需要 import `@deepseek-ai/dsh-llm`（本地路径插件解析不到）。

### 21.4 会话态与去重

- `WeakMap<agent, { touched:Set, injected:Set, budgetNoticed:boolean }>` —— agent 回收即释放
- 触碰集合上限 500 条，防长会话无限增长
- `injected` 保证每条规则只注入一次；**不做**「压缩后自动补发」（CC 也不会）
- 发现结果按 cwd 缓存 30s（`invalidate()` 可强制清）

### 21.5 预算与失败模式

`ccRulesMaxBytes`（默认 8192）：

- 放得下的注入，放不下的进 `skipped`，在注入消息末尾点名
- **一条都放不下时**，仍然发一条只含省略说明的消息，并且只发一次（`budgetNoticed`）。
  静默丢弃是这里最坏的失败模式：用户会以为规则生效了
- 发现阶段的读错误进 `warnings`（日志），注入期异常进 `status().errors`，`/gate doctor` 可见

### 21.6 与 CC 的两处已知差别

1. **Bash 读取不算触碰**。CC 把 `cat`/`head` 单文件也算 Read；本插件只认结构化工具。
   理由与 `dsh-agent-instructions` 相同：shell 语法与每次调用的 shell 状态不是可靠的 fs 接缝，
   猜错的代价是「规则莫名不生效」。
2. **规则不跨压缩存活**。CC 加载后留在上下文里；本插件每条只注入一次。

### 21.7 验证

- `test/rules.test.mjs`：frontmatter 四种形态、花括号乘算、预算计数（不含花括号不吃预算）、
  glob 语义（`**` 跨层与零层、`*` 不跨层、`?`、大小写、反斜杠模式、文件名回退）、
  注入规划（无条件优先、去重、预算跳过、项目外触碰不触发）
- `test/rules-inject.test.mjs`：首轮只注入无条件、第二轮不重复、触碰后按 paths 注入、
  失败/其它工具/已取消的触碰都不算、预算提示只发一次、关闭开关、无 agent 直通、reject 直通
- `middle-layer.test.mjs` 追加事件计数断言：`agent/pre-step` 必须有两个监听（目录门禁 + rules）

## 22. v0.11.0 — 条目管理 + 连通性探测

### 22.1 边界：我们只改自己的配置

用户「添加错了改不了」的痛点，根源是之前只有 `add` 没有 `remove / rename`。

但**能改到哪一层**必须先划清：

| 条目来源 | 能改 | 为什么 |
|---|---|---|
| 本插件全局 / 项目配置 | ✅ 改 / 删 | 那是我们自己的文件 |
| Claude Code 的定义（`layer === 'cc'`） | ❌ 只有状态可以被覆盖成 `off` | 零写入用户文件是这条插件的底线；改 CC 的 `.mcp.json` 等于替用户动了另一个工具 |
| DSH profile（`cordis.yml` 里一行一台） | ❌ 完全不碰 | `dsh-mcp-client` 是一实例一服务器，改它等于改部署 |

所以 `ownEntry()` 见到 `layer === 'cc'` 直接抛错并说明「要停用请设 off」，
面板上两个按钮是禁用态。**不假装能删**。

### 22.2 改名的层级语义（容易误解，写清楚）

`renameServer` 只搬「当前赢的那一层」。若同名条目同时存在于本插件全局与项目层，
改名后项目层变成新名字、旧名字会**回落到全局层的那条**——面板上会看到它还在，只是层 tag 变了。

这是有意的：跨层批量改名会同时改两个文件，用户很难预期。

### 22.3 探测：三种模式，宁可说不知道

| 输入 | 探测 | 判定 |
|---|---|---|
| CC 定义有 `url` | `fetch(GET, 4s, headers)` | 收到响应即可达（400/405 也算）——MCP 端点本来就不响应 GET |
| CC 定义有 `command` | 在 `PATH` / 绝对路径里找可执行文件 | 找到即「可执行」，**不 spawn**：启动第三方 MCP 有副作用，也可能卡住会话 |
| 看不到定义 | 不探测 | 分三种原因回话：已连上但定义在 profile / CC 只声明没细节 / 只登记过名字 |

`connected` 与探测结果是两个维度，界面上分开显示：
「通」不等于「DSH 连上了」，「连上了」也不一定探得通。

`${VAR}` / `${VAR:-default}` 按 `process.env` 展开（`core/probe.js` 纯函数，`platform/probe.js` 执行）。

### 22.4 落点

| 层 | 文件 | 内容 |
|---|---|---|
| 位置 | 无新增 | 沿用 `cc/mcp.js` 里已有的文件路径 |
| CC 知识 | `lib/cc/mcp.js` | `definitionOf()`：从 `mcpServers` 条目里抽 `type/url/command/args/headers` |
| 纯逻辑 | `lib/core/probe.js` | `planProbe()` 三态判定、`expandEnv()` |
| 副作用 | `lib/platform/probe.js` | `fetch` / PATH 查找，失败只回话不抛 |
| I/O | `lib/io.js` | `removeServer()` / `renameServer()`，返回布尔（没改就 false） |
| 表面 | `lib/host/routes.js` | `POST /mcp/remove` `/mcp/rename` `/mcp/probe` |

### 22.5 验证

- `test/probe.test.mjs`：`${VAR}` 三种形态、三种探测计划、本地 http server（405 算可达）、拒连、300ms 超时、PATH 命中/不命中、无定义
- `test/store.test.mjs`：改名搬状态、目标重名报错且不写坏文件、删除返回布尔、删空后清掉空块、无关键不受影响
- `test/middle-layer.test.mjs`：三条路由真跑（改名后回落全局层、删不存在的条目 400、CC-only 条目拒绝删除）
- 真实实例（3099）实测：`exa` → `HTTP 405 · 689ms` 可达；`context7`（command=cmd）→ 找到 `cmd.exe`；只登记名字的 `demo-server` → unknown 并说明原因
