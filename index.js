/**
 * dsh-skill-mcp-gate — host 半边（薄接线）。
 *
 * 分层：
 *   lib/cc/        Claude Code 的一切知识（文件在哪、字段叫什么、怎么解析）
 *   lib/core/      纯领域：四档词汇、分层合并、目录预算规划、MCP 策略
 *   lib/platform/  DSH 接缝：目录消息门禁、装配过滤、额外 provider、运行时观察
 *   lib/host/      对外表面：面板快照、/gate 命令、Web API
 *   lib/load.js    唯一知道「配置有哪几层、谁覆盖谁」的地方
 *
 * 效果：
 *   skills —— `agent/pre-step` 重写官方目录消息（整条隐藏 / 只留名字 / 按预算丢描述）+ 调用期 guard
 *   mcp    —— `system-prompt/assemble` 过滤装配产物里的工具；不断连、不写 profile
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { GLOBAL_WS, loadWorkspace } from './lib/load.js'
import { configPaths } from './lib/paths.js'
import { planListing } from './lib/core/listing.js'
import { assertMcpState, assertMcpToolState, assertSkillState } from './lib/core/policy.js'
import { agentCwd, workspaceList } from './lib/platform/observe.js'
import { createSkillProvider } from './lib/platform/provider.js'
import { createCatalogGate } from './lib/platform/catalog.js'
import { createMcpFilter } from './lib/platform/mcp-filter.js'
import { createGateTools } from './lib/platform/gate-tools.js'
import { createRulesInjector } from './lib/platform/rules-injector.js'
import { createSnapshotter } from './lib/host/snapshot.js'
import { createCommands } from './lib/host/commands.js'
import { createRoutes } from './lib/host/routes.js'
import { addServerNames, setServerState, setSkillState, setToolState } from './lib/io.js'

export const name = 'skill-mcp-gate'

export const inject = ['skills', 'commands', 'tools', 'webServer', 'agents', 'workspaceRegistry']

const TAG = '[skill-mcp-gate]'

export function apply(ctx, config = {}) {
  const debug = config.debug === true
  const log = (...args) => { if (debug) console.log(TAG, ...args) }
  const warn = (msg) => console.warn(`${TAG} ${msg}`)

  const files = configPaths(config)
  const token = randomUUID()

  /** skill 上「用了 CC 但落不了地」的字段，按名字收集。 */
  const gaps = new Map()
  let current = null
  let planCost = null
  let lastWorkspace = config.projectDir ? resolve(config.projectDir) : null

  // ── 额外 provider：把 .claude/skills 等目录接进 DSH 目录（不改 profile）──
  if (config.claudeSkills !== false) {
    try {
      ctx.skills.registerProvider(() => createSkillProvider({
        home: config.ccHome,
        onGaps: (skillName, list) => gaps.set(skillName, list),
        log: (...args) => log('claude-skills', ...args),
      }))
    } catch (error) {
      warn(`注册额外 skill provider 失败: ${error.message}`)
    }
  }

  // ── 装载 ──────────────────────────────────────────────
  function firstWorkspaceKey() {
    const entry = workspaceList(ctx, { globalKey: GLOBAL_WS, warn })
      .find((item) => item.key !== GLOBAL_WS)
    return entry ? entry.key : GLOBAL_WS
  }

  function reload(workspaceKey) {
    const ws = workspaceKey || lastWorkspace || agentCwd(ctx, warn) || firstWorkspaceKey()
    const warnings = []
    const loaded = loadWorkspace({ workspace: ws, config, warnings })
    current = loaded
    lastWorkspace = loaded.workspace
    gaps.clear()
    for (const message of loaded.warnings) warn(`配置警告: ${message}`)
    log('已装载', loaded.workspace, `skills ${loaded.skills.size}`, `mcp ${loaded.servers.size}`)
    return loaded
  }

  /** 目录门禁的输入：谁隐藏、谁只留名字（含预算丢描述）。 */
  function catalogPlan(entries) {
    const loaded = current
    if (!loaded) return undefined
    const plan = planListing({
      entries: entries ?? [],
      states: loaded.skills,
      budgetChars: loaded.budget?.chars ?? null,
      usage: loaded.usage,
    })
    if (Array.isArray(entries) && entries.length > 0) planCost = plan.cost
    return { hide: plan.hide, nameOnly: plan.nameOnly }
  }

  const catalogGate = createCatalogGate({ ctx, getPlan: catalogPlan, log })
  const mcpFilter = createMcpFilter({ ctx, getServers: () => current?.servers ?? new Map(), log })

  // 中间层：延迟 MCP 工具的搜索与调用（索引由 mcpFilter 在装配期填充）
  const gateTools = config.mcpSearch === false
    ? null
    : createGateTools({
      ctx,
      getIndex: () => mcpFilter.index(),
      getServers: () => current?.servers ?? new Map(),
      log,
    })

  // CC 的 rules/：按 touched paths 做路径门控注入
  const rulesInjector = config.ccRules === false
    ? null
    : createRulesInjector({
      ctx,
      getOptions: () => ({
        enabled: config.ccRules !== false,
        maxBytes: config.ccRulesMaxBytes ?? 8192,
        home: config.ccHome,
      }),
      log,
    })

  const status = () => ({
    catalog: catalogGate.status(),
    mcp: mcpFilter.status(),
    tools: gateTools ? gateTools.status() : { errors: [], disabled: true },
    rules: rulesInjector ? rulesInjector.status() : { disabled: true, injected: 0, last: [], errors: [] },
  })
  const snapshot = createSnapshotter({
    ctx,
    getLoaded: () => current,
    getPlanCost: () => planCost,
    getGaps: () => gaps,
    getStatus: status,
    warn,
  })

  // ── 写配置：写到「当前选中的作用域」那一层 ──────────────
  function writeTarget(workspaceKey) {
    const ws = workspaceKey || current?.workspace || lastWorkspace || GLOBAL_WS
    const file = ws === GLOBAL_WS ? files.globalFile : configPaths({ projectDir: ws }).projectFile
    return { ws, file }
  }

  function setSkill(skillName, nextState, workspaceKey) {
    if (typeof skillName !== 'string' || skillName.length === 0) throw new Error('缺少 skill 名称')
    assertSkillState(nextState, `skills.${skillName}`)
    const { ws, file } = writeTarget(workspaceKey)
    setSkillState(file, skillName, nextState)
    reload(ws)
    return { file, workspace: ws }
  }

  function setServer(server, nextState, workspaceKey) {
    if (typeof server !== 'string' || server.length === 0) throw new Error('缺少服务器名')
    assertMcpState(nextState, `mcp.${server}`)
    const { ws, file } = writeTarget(workspaceKey)
    setServerState(file, server, nextState)
    reload(ws)
  }

  function setTool(server, tool, nextState, workspaceKey) {
    if (!server || !tool) throw new Error('缺少服务器名或工具名')
    assertMcpToolState(nextState, `mcp.${server}.${tool}`)
    const { ws, file } = writeTarget(workspaceKey)
    setToolState(file, server, tool, nextState)
    reload(ws)
  }

  /** 自定义填入：从粘贴内容里提取服务器名。 */
  function parseServerNames(text) {
    const raw = String(text ?? '').trim()
    if (raw.length === 0) throw new Error('内容为空')
    let names = []
    if (raw.startsWith('{') || raw.startsWith('[')) {
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new Error(`JSON 解析失败：${error.message}`)
      }
      const block = parsed && parsed.mcpServers ? parsed.mcpServers : parsed
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        throw new Error('没找到 mcpServers 对象')
      }
      names = Object.keys(block)
    } else {
      const SEP = new RegExp('[,' + String.fromCharCode(10, 13, 9, 32) + ']+')
      names = raw.split(SEP).map((line) => line.trim()).filter(Boolean)
    }
    const cleaned = [...new Set(names.filter((serverName) => /^[A-Za-z0-9_.-]{1,64}$/.test(serverName)))]
    if (cleaned.length === 0) throw new Error('没有解析到合法的服务器名')
    return cleaned
  }

  function addServers(text, workspaceKey) {
    const names = parseServerNames(text)
    const { ws, file } = writeTarget(workspaceKey)
    addServerNames(file, names)
    reload(ws)
    return { names, file, workspace: ws }
  }

  // ── 接线 ──────────────────────────────────────────────
  reload()

  const commands = createCommands({
    snapshot,
    getLoaded: () => current,
    getPlanCost: () => planCost,
    getStatus: status,
    reload,
    setSkill,
    setServer,
    setTool,
  })

  ctx.commands.register({
    name: 'gate',
    description: '查看并调整 skill / MCP 的可见性（skill-mcp-gate）',
    input: { hint: 'status | skills | mcp | why <name> | doctor | reload [dir] | set <key>=<value>' },
    recordInput: false,
    handler: (invocation) => commands.handle(invocation.rawInput),
  })

  const routes = createRoutes({
    token,
    snapshot,
    select: (ws) => reload(ws),
    reload: (ws) => reload(ws),
    setSkill,
    setServer,
    setTool,
    addServers,
  })
  const routeDisposers = routes.map((route) => ctx.webServer.register(route))

  rulesInjector?.install()
  gateTools?.install()
  mcpFilter.install()
  catalogGate.install()

  ctx.effect(() => () => {
    for (const dispose of routeDisposers) { try { dispose?.() } catch { /* ignore */ } }
    catalogGate.dispose()
    mcpFilter.dispose()
    gateTools?.dispose()
    rulesInjector?.dispose()
  }, 'skill-mcp-gate: cleanup')
}
