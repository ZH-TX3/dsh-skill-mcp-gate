# dsh-skill-mcp-gate

用配置 + 设置页控制 DSH skill / MCP 的可见性与可调用性，支持**全局 + 项目双层覆盖**，skill 配置格式兼容 Claude Code 的 `skillOverrides`。

## 能力

| 对象 | 控制方式 | 效果 |
|---|---|---|
| **skill 来源** | 除 DSH 自带根外，还扫描 `~/.claude/skills`、`<工作区>/.claude/skills`（自带 provider 注册，不改 profile） |
| **skill** | 四档状态（`on` / `name-only` / `user-invocable-only` / `off`）；按选中工作区的 cwd 列目录，**能看到该工作区自己的项目级 skill** | `off` / `user-invocable-only` 在 `agent/pre-step` **重写官方 skill 目录消息**并在调用期用 `guard` 拦住；`name-only` 只留名字、不带描述。**不修改 `SKILL.md`** |
| **MCP 服务器** | `on` / `deferred` / `off` | `off` 让工具消失且不可调用；**`deferred` 让工具不进提示词，但可被 `gate_mcp_search` 搜到、`gate_mcp_call` 调用**。两者都不断连、不写 profile 配置 |
| **目录预算** | 原子 CC 语义：名字全留，超预算时按「最不常用」丢描述；来源 env `SLASH_COMMAND_TOOL_CHAR_BUDGET` 或 `skillListingBudgetFraction` × `contextWindowTokens` |
| **CC 的 MCP 定义** | 只读 `~/.claude.json` / `<工作区>/.mcp.json` + 批准状态 | CC 里声明过的服务器即使 DSH 还没连也列出来（标 `CC 用户` / `CC 本地` / `CC 项目`）；**CC 里拒绝的连接默认 `off`** |
| **MCP 单个工具** | `on` / `off` | 同上，粒度到 `mcp__<服务器>__<工具>`（延迟状态只在服务器级，逐工具写 `deferred` 会被拒绝） |
| **MCP 中间层** | 自动注册 `gate_mcp_search` / `gate_mcp_call` | 没有任何延迟服务器时，这两个工具自己也会从装配里摘掉，不占工具位 |

**界面**：左侧一级面板「技能与工具门禁」（`sidebar.panellist` 图标 + `main` 面板）。

- **左侧作用域列表**：全局 + DSH 工作区树（`ctx.workspaceRegistry`），每项标出「基础层 / 覆盖全局」与路径末段；选中哪层，开关就写到那层的配置文件
- **Skills tab**：按来源分三组 —— 项目级 / 用户级 / 内置，每组带来源路径说明；每行一个四档下拉
- **MCP tab**：按声明层分三组 —— 项目级 / 全局级 / 未在配置中声明；服务器一个开关，下面每个工具各一个开关
- 顶部有 tab 计数、名称筛选框、刷新按钮；底部有汇总与 lost / 需 A 模式 / 配置警告提示

> v0.4.0 起从「设置内一页」改为左侧一级面板，与 `dsh-context` 同级。

## 延迟加载与中间层（对齐 CC 的 tool search）

MCP 工具常驻提示词是最大的固定开销。把服务器设为 `deferred`：

| | 出现在模型工具表 | 可被搜索 | 可被调用 |
|---|---|---|---|
| `on` | 是 | — | 直接调 |
| `deferred` | **否** | **是** | 经 `gate_mcp_call` |
| `off` | 否 | 否 | 拒绝 |

`gate_mcp_search` 的关键词对「工具名 / 服务器名 / 描述」做全词命中，返回每行一条只占十几字；
`gate_mcp_call` 只接受索引里的名字，把调用作为**嵌套 dispatch** 转发（带 `parent` token、
`rootCallId`、`agent`、`signal`），所以 pre-execute / guard / 超时策略对它一样生效。

它的边界说清楚：

- 索引来自装配产物（`system-prompt/assemble` 过滤前看到的 schema），不额外遍历、不连服务器
- 索引在**第一次装配之后**才有效；为空时如实回「还没有可用工具」，不猜
- 嵌套结果只转发文本；图片/音视频等非文本块会在结尾写明 `[未转发的非文本内容：image×2]`
- **不新增依赖**：手写 `ToolDefinition`，不去 import 解析不到的 `defineTool`

## 架构

```
index.js              接线：装载 → 装 seams → 注册命令/路由（薄）
lib/
  paths.js            所有「东西在哪」：本插件配置、CC 设置层、skill 根目录
  load.js             唯一知道「配置有哪几层、谁覆盖谁」的地方
  io.js               原子读写的字节层
  cc/                 Claude Code 的一切知识
    skills.js         frontmatter 字段表、目录扫描、skillOverrides 解析
    mcp.js            三处 MCP 定义源 + 批准/拒绝语义
    listing.js        目录预算两个设置键的读取与换算
    usage.js          skillUsage（预算丢弃顺序用）
  core/               纯领域，不认识任何文件名
    policy.js         四档词汇、校验、分层合并
    listing.js        目录预算规划（谁隐藏、谁只留名字）
    mcp-policy.js     工具名解析、配置归一化、隐藏集合
  platform/           DSH 接缝
    catalog.js        agent/pre-step 重写目录消息 + 调用期 guard
    mcp-filter.js     system-prompt/assemble 过滤工具
    provider.js       额外 skill provider（把 .claude/skills 接进目录）
    observe.js        只读地看 DSH 现状（agents / 工作区 / 工具 / skill）
  host/               对外表面
    snapshot.js       面板数据、commands.js `/gate`、routes.js Web API
```

依赖方向单向：`cc/` 与 `core/` 都不认识 DSH；`platform/` 只认 DSH 与 `core/`；
`host/` 只拼装。**加一个 Claude Code 字段不会碰到 platform / host。**

### 新增一个 CC 字段怎么接

1. **frontmatter 字段** → 在 `lib/cc/skills.js` 的 `SKILL_FRONTMATTER` 加一行：
   - 能映射：`{ kind: 'string'|'bool'|'list', target: '候选上的字段名' }`
   - 落不了地：`{ kind, gap: '为什么' }` —— 会自动出现在面板与 `/gate doctor`，不会假装生效
2. **设置键（全局行为）** → 在 `lib/cc/` 对应模块里解析，产出一个纯数据交给 `core/`；
   需要新行为的，先在 `core/` 写成纯函数（可单测），再到 `platform/` 用最小改动接上
3. **新的文件来源** → 只需改 `lib/paths.js`，`load.js` 会按层序自动带进来

## 明确的边界

| 做不到 | 原因 |
|---|---|
| CC 的单条描述上限 `skillListingMaxDescChars` | DSH 上游已按 `catalogDescriptionMaxLength`（默认 500）截过描述，拿不到原文，只能降不能升。配置了会**明确告警** |
| CC 的 `skillListingBudgetFraction` 按比例换算 | 比例本身支持，但**必须配合 `contextWindowTokens`**（本插件读不到上下文窗口）；或直接用环境变量 `SLASH_COMMAND_TOOL_CHAR_BUDGET` 给固定字符数 |
| `.claude/commands/*.md` | CC 的旧式斜杠命令，正文里可能有 `!bash` / `$ARGUMENTS`，直接当 skill 注入语义不对，暂不接 |
| CC 插件里的 skill | `~/.claude/plugins` 下没有装带 skill 的插件；CC 自己也规定 `skillOverrides` 不作用于插件 skill |
| MCP 中间层（按需调用隐藏工具） | 需要 `@deepseek-ai/dsh-tools` 的 `defineTool`，本地路径插件解析不到该依赖（见下） |

## 安装

```bash
dsh plugin --profile web add <plugin-dir>   # 例如 ~/.dsh/plugins/dsh-skill-mcp-gate
```

装完重启 `dsh web`。之后可以在会话里 `/gate status`，或到设置页操作。

## 与 Claude Code 共用配置

除了本插件自己的文件，还会读取 Claude Code 的设置文件里的 `skillOverrides`（语义完全一致），所以同一份配置在两个工具里通用：

| 层（低 → 高） | 文件 |
|---|---|
| CC 用户 | `~/.claude/settings.json` |
| 本插件全局 | `~/.dsh/skill-mcp-gate/settings.json` |
| CC 项目 | `<工作区>/.claude/settings.json` |
| CC 项目本地 | `<工作区>/.claude/settings.local.json` |
| 本插件项目 | `<工作区>/.dsh/skill-mcp-gate.json` |

只读 `skillOverrides`（和本插件自己的 `skills`）。CC 的 `permissions` / `hooks` / `enabledPlugins` 不参与。

### MCP 也读 CC 的三处定义

CC 把 MCP 服务器放在三个地方，本插件只取名与批准状态，不解析 `command` / `env`（连接是 DSH 的事）：

| 来源 | 文件 | 作用域 |
|---|---|---|
| 用户级 | `~/.claude.json` → `mcpServers` | `user` |
| 项目级 | `<工作区>/.mcp.json` → `mcpServers` | `project`（要批准） |
| 本地级 | `~/.claude.json` → `projects["<工作区路径>"].mcpServers` | `local` |

同名服务器以更具体的为准（`local` > `project` > `user`），路径比较对大小写与斜杠方向不敏感。

批准状态读 settings 里的三个键，`disabledMcpjsonServers` 优先级最高：

```json
{ "disabledMcpjsonServers": ["filesystem"], "enabledMcpjsonServers": ["github"], "enableAllProjectMcpServers": true }
```

被拒绝的服务器在本插件里作为**基线层**默认 `off`；本插件自己的全局 / 项目配置会覆盖它。想关掉这套 CC 联动，用 `claudeMcp: false`。

## 配置

| 层 | 路径 |
|---|---|
| 全局 | `~/.dsh/skill-mcp-gate/settings.json` |
| 项目 | `<项目>/.dsh/skill-mcp-gate.json` |

项目层覆盖全局层。设置页写入时会**写进当前决定该项的那一层**，避免"点了没反应"。

```jsonc
{
  "skills": {
    "dataviz": "off",
    "update-config": "user-invocable-only",
    "playwright-cli": { "state": "name-only" }
  },
  "mcp": {
    "servers": {
      "xiaohongshu-mcp": "off"
    }
  }
}
```

`skillOverrides` 是 `skills` 的别名（同名时 `skills` 优先），CC 配置可直接粘过来。

### 项目配置文件定位

插件用 `config.projectDir`（未配置则取进程 cwd）找项目配置。若 `dsh web` 不是从项目根启动：

- 在 `cordis.patch.yml` 里设 `projectDir`
- 或会话里 `/gate reload <项目目录>`

## 命令

| 命令 | 作用 |
|---|---|
| `/gate` / `/gate status` | 覆盖项、MCP 汇总、配置文件状态 |
| `/gate skills` | 全部 skill：状态、来源 |
| `/gate mcp` | 服务器列表、工具数、是否已连上 |
| `/gate why <名字>` | **哪一层决定了它的状态**，以及为什么没生效 |
| `/gate set skills.<名字>=<状态>` | 改 skill（也接受 `set skills.x off` 写法） |
| `/gate set mcp.<服务器>=on\|off` | 改 MCP 服务器 |
| `/gate doctor` | 自检：配置警告、静默失败、缺失、异常 |
| `/gate reload [目录]` | 重新加载 |

## Web API

设置页用，POST 需带 `x-gate-token` 头（`GET /token` 获取）：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/skill-mcp-gate/token` | GET | 取本进程 token |
| `/api/skill-mcp-gate/state` | GET | skills + mcp + 配置状态快照 |
| `/api/skill-mcp-gate/skill` | POST | `{ name, state }` |
| `/api/skill-mcp-gate/mcp` | POST | `{ server, state }` |
| `/api/skill-mcp-gate/tool` | POST | `{ server, tool, state }` |
| `/api/skill-mcp-gate/reload` | POST | 重新加载 |

## 为什么 skill 不用 runtime 影子

实测撞墙：`agent.ctx` 未声明 `skills` 注入，`agent.ctx.skills` 直接抛
`cannot get property "skills" without inject`；而全局上下文注册只会落在**全局层**，
用户 skill 却在 **agent scope 层**（就近层优先），影子天然盖不住。

所以改成在**消费侧**拦截，与层无关：

1. `agent/pre-step` 里把官方发布的 `<available_skills>` 目录消息重写成过滤后的版本（完整替换语义）
2. `ctx.tools.guard()` 拦住对已关闭 skill 的 `skill` 工具调用（单调拒绝，不可被其它监听翻转）

## 为什么 MCP 走装配过滤

三个候选机制，实测后选第三个：

| 机制 | 问题 |
|---|---|
| `loader.remove/create` | `dsh-app-boot` 的 `Loader.write()` 会真落盘改写 profile 组合 |
| `agent.ctx.tools.restrict` | 全局上下文调不了，要遍历 agents 逐个挂；且校验「已知工具名」，MCP 后连会抛错 |
| **`system-prompt/assemble` 过滤 `assembly.tools`** | ✅ 全局生效、自动覆盖新 agent、不受未知名限制、只改本次装配产物 |

## 关于 loader（参考实现的路线）

`dsh-app-boot` 的 `Loader.write()` 会真的落盘改写 profile 组合文件 —— 走 `loader.remove/create` 启停一次就**永久改了用户配置，卸载插件也不复原**。

所以本插件改用 `agent.ctx.tools.restrict({ deny })`：

| | loader 启停 | restrict（本插件） |
|---|---|---|
| 工具从提示词消失 | ✅ | ✅ |
| 写配置文件 | **会，且不可逆** | 否 |
| 断连 / 重连 | 会 | 不会 |
| 恢复 | 需重建行 | 释放 disposer 即恢复 |

代价：MCP 服务器进程保持连接（只是工具不可见）。

## 自测

```bash
cd ~/.dsh/plugins/dsh-skill-mcp-gate
npm test
```

十三个套件，零依赖，不启动 DSH：

| 测试 | 覆盖 |
|---|---|
| `policy.test.mjs` | 四档词汇、`skillOverrides` 别名、未知值拒绝、分层优先级与归因 |
| `mcp.test.mjs` | 工具名解析/归组、配置归一化、隐藏集合、装配过滤器（含 null/缺字段的安全返回） |
| `store.test.mjs` | 原子写、保留其它键、`on` 等于清除覆盖、非对象拒绝写入 |
| `catalog.test.mjs` | 目录消息重写：整条剔除、`name-only` 只留名字、描述记录不变、guard 拦截 |
| `claude-skills.test.mjs` | `.claude/skills` / `.dsh/skills` / `.agents/skills` 扫描与 frontmatter 解析 |
| `claude-mcp.test.mjs` | CC 的 user / local / project 三作用域、路径归一化、批准与拒绝优先级、基线层 |
| `listing.test.mjs` | 目录预算：隐藏/只留名字、超预算丢描述、按使用次数排序、预算来源解析 |
| `gate-tools.test.mjs` | 中间层：检索打分、名字解析、拒绝规则、嵌套 dispatch 的身份与取消、结果降级 |
| `middle-layer.test.mjs` | 端到端（假 ctx）：真跑 apply + 装配 waterfall → 索引 → 搜索 → 调用 → 嵌套派发 |
| `scope.test.mjs` | 工作区作用域列表与写层选择 |
| `wiring.test.mjs` | 假 ctx：真跑一次 `system-prompt/assemble` waterfall 验证过滤；命令面 + 路由 + token 鉴权 + 落盘 |
| `client.test.mjs` | 假 react 执行 client.js 并直接渲染面板，断言 tab 名、分组标题、行文案真的出现在渲染树里 |
| `e2e.test.mjs` | 真实配置文件 → 真实 registry 全链路 |

另有 `npm run test:registry`：DSH 同名解析规则回归，升级 DSH 后跑一遍就知道规则变没变。

## 设计文档

见 [DESIGN.md](./DESIGN.md)，含 API 依据、实测矩阵、里程碑与偏差记录。
