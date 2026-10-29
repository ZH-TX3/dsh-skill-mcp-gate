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
import { agentCwd, toolNames, workspaceList } from './lib/platform/observe.js'
import { groupToolsByServer } from './lib/core/mcp-policy.js'
import { runProbe } from './lib/platform/probe.js'
import { createMcpConnections } from './lib/platform/mcp-connections.js'
import { normalizeDefinition, parseServerInput, probeInfoFromConfig, templateFromCc } from './lib/core/mcp-definition.js'
import { createSkillProvider } from './lib/platform/provider.js'
import { createCatalogGate } from './lib/platform/catalog.js'
import { createMcpFilter } from './lib/platform/mcp-filter.js'
import { createGateTools } from './lib/platform/gate-tools.js'
import { createRulesInjector } from './lib/platform/rules-injector.js'
import { createSnapshotter } from './lib/host/snapshot.js'
import { createCommands } from './lib/host/commands.js'
import { createRoutes } from './lib/host/routes.js'
import {
  addServerNames, removeDefinition, removeServer, renameServer, setDefinition, setServerState, setSkillState, setToolState,
} from './lib/io.js'

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

  const connections = createMcpConnections({ ctx, log })

  const status = () => ({
    catalog: catalogGate.status(),
    mcp: mcpFilter.status(),
    tools: gateTools ? gateTools.status() : { errors: [], disabled: true },
    rules: rulesInjector ? rulesInjector.status() : { disabled: true, injected: 0, last: [], errors: [] },
    connections: { ...connections.status(), managed: [...(current?.definitions?.keys() ?? [])] },
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

  /**
   * 自定义填入：名字只登记门禁；带连接参数的定义会落盘并立刻接管。
   * 输入形状由 core/mcp-definition.js 的 parseServerInput 判定。
   */
  async function addServers(text, workspaceKey) {
    const parsed = parseServerInput(text)
    const { ws, file } = writeTarget(workspaceKey)
    addServerNames(file, parsed.names)
    for (const item of parsed.definitions) setDefinition(file, item.name, item.config)
    reload(ws)

    const connected = []
    for (const item of parsed.definitions) {
      try {
        await connections.upsert(item.config)
        connected.push(item.name)
      } catch (error) {
        warn(`接管 ${item.name} 失败: ${error.message}`)
      }
    }
    return {
      names: parsed.names,
      definitions: parsed.definitions.map((item) => item.name),
      connected,
      warnings: parsed.warnings ?? [],
      file,
      workspace: ws,
    }
  }

  /** 只允许改「本插件自己写的」条目；CC 的定义一律不碰。 */
  function ownEntry(serverName) {
    const entry = current?.servers.get(serverName)
    if (!entry) throw new Error(`没有 "${serverName}" 这条记录`)
    if (entry.layer === 'cc') {
      throw new Error(`"${serverName}" 的定义来自 Claude Code，本插件不改 CC 的文件；要停用它请把状态设为 off`)
    }
    return entry
  }

  function removeServerEntry(serverName) {
    const entry = ownEntry(serverName)
    if (!removeServer(entry.file, serverName)) {
      throw new Error(`"${serverName}" 不在 ${entry.file} 里，可能已被其它地方移除了`)
    }
    reload(current.workspace)
    return { file: entry.file }
  }

  function renameServerEntry(from, to) {
    if (typeof to !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(to)) {
      throw new Error(`"${to}" 不是合法的服务器名（字母数字 _ . - ，最长 64）`)
    }
    const entry = ownEntry(from)
    if (from !== to && current.servers.has(to)) throw new Error(`"${to}" 已经存在`)
    if (!renameServer(entry.file, from, to)) {
      throw new Error(`"${from}" 不在 ${entry.file} 里，可能已被其它地方移除了`)
    }
    reload(current.workspace)
    return { file: entry.file, from, to }
  }

  /** 真探测一台服务器：运行态 + （能拿到定义时）http / 可执行文件。 */
  async function probeServer(serverName) {
    const entry = current?.servers.get(serverName)
    const ccInfo = current?.claudeMcp?.servers.find((item) => item.name === serverName)
    const connected = groupToolsByServer(toolNames(ctx, warn)).has(serverName)
    // DSH 已配置的连接优先：那才是它真正会去连的东西
    const owned = current?.definitions?.get(serverName)
    const definition = owned ? probeInfoFromConfig(owned.config) : ccInfo?.definition
    const result = await runProbe({
      connected,
      ccScope: owned ? null : (entry?.ccScope ?? ccInfo?.scope ?? null),
      definition,
    })
    return { name: serverName, connected, ...result }
  }

  function ccDefinitionOf(serverName) {
    return current?.claudeMcp?.servers.find((item) => item.name === serverName)?.definition
  }

  /** 编辑器要显示的 JSON：优先本插件代管的定义，否则用 CC 的定义当模板。 */
  function getDefinition(serverName) {
    const owned = current?.definitions?.get(serverName)
    if (owned) {
      return { server: serverName, managed: true, config: owned.config, source: 'plugin', file: owned.file }
    }
    const template = templateFromCc(serverName, ccDefinitionOf(serverName))
    return {
      server: serverName,
      managed: false,
      config: template,
      source: ccDefinitionOf(serverName) ? 'claude-code' : 'blank',
    }
  }

  /** 保存 JSON → 校验 → 写本插件配置 → 立刻热加载。 */
  async function saveDefinition(serverName, json) {
    let parsed
    if (typeof json === 'string') {
      try {
        parsed = JSON.parse(json)
      } catch (error) {
        throw new Error(`JSON 解析失败：${error.message}`)
      }
    } else {
      parsed = json
    }
    const config = normalizeDefinition({ ...parsed, serverName: parsed?.serverName ?? serverName })
    const { ws, file } = writeTarget()
    // 改名 = 删旧存新，避免留下两条指向同一台服务器的连接
    if (config.serverName !== serverName) removeDefinition(file, serverName)
    setDefinition(file, config.serverName, config)
    reload(ws)
    const result = await connections.upsert(config)
    return { ...result, config, file, workspace: ws }
  }

  async function deleteDefinition(serverName) {
    const owned = current?.definitions?.get(serverName)
    if (!owned) throw new Error(`本插件里没有 "${serverName}" 的连接定义`)
    if (!removeDefinition(owned.file, serverName)) throw new Error(`删除失败：${owned.file} 里没有这条定义`)
    reload(current.workspace)
    const removedId = connections.remove(serverName)
    return { id: removedId ?? null, file: owned.file }
  }

  /** 启动 / 保存后：把配置里的定义灌进 loader。 */
  async function syncConnections() {
    const result = await connections.sync(current?.definitions)
    for (const failure of result.failed) warn(`MCP 连接失败: ${failure.name} — ${failure.reason}`)
    return result
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
    removeServer: removeServerEntry,
    renameServer: renameServerEntry,
    probeServer,
    getDefinition,
    saveDefinition,
    deleteDefinition,
  })
  const routeDisposers = routes.map((route) => ctx.webServer.register(route))

  syncConnections().catch((error) => warn(`灌入 MCP 连接失败: ${error.message}`))

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
