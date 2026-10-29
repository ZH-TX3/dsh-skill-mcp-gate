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
import { claudeMcpProjectFile, configPaths } from './lib/paths.js'
import { planListing } from './lib/core/listing.js'
import { assertMcpState, assertMcpToolState, assertSkillState } from './lib/core/policy.js'
import { agentCwd, liveAgents, toolNames, workspaceList } from './lib/platform/observe.js'
import { groupToolsByServer } from './lib/core/mcp-policy.js'
import { runProbe } from './lib/platform/probe.js'
import { createMcpConnections } from './lib/platform/mcp-connections.js'
import { normalizeDefinition, parseServerInput, probeInfoFromConfig, templateFromCc } from './lib/core/mcp-definition.js'
import { findSkillFile } from './lib/cc/skills.js'
import { skillDirs } from './lib/paths.js'
import { createSkillProvider } from './lib/platform/provider.js'
import { createCatalogGate } from './lib/platform/catalog.js'
import { createMcpFilter } from './lib/platform/mcp-filter.js'
import { createGateTools } from './lib/platform/gate-tools.js'
import { createRulesInjector } from './lib/platform/rules-injector.js'
import { createSkillInvoker } from './lib/platform/skill-invoke.js'
import { createSnapshotter } from './lib/host/snapshot.js'
import { createCommands } from './lib/host/commands.js'
import { createRoutes } from './lib/host/routes.js'
import {
  addServerNames, readJsonFile, removeDefinition, removeServer, renameServer, setDefinition,
  setServerState, setSkillState, setToolState, writeJsonFile,
} from './lib/io.js'
import { withServer, withoutServer } from './lib/cc/mcp-json.js'

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

  // 手动调用：面板上点「调用一次」= 以用户身份把技能正文注入下一次请求
  const skillInvoker = createSkillInvoker({ ctx, log })

  const status = () => ({
    catalog: catalogGate.status(),
    mcp: mcpFilter.status(),
    tools: gateTools ? gateTools.status() : { errors: [], disabled: true },
    rules: rulesInjector ? rulesInjector.status() : { disabled: true, injected: 0, last: [], errors: [] },
    connections: { ...connections.status(), managed: [...(current?.definitions?.keys() ?? [])] },
    skillInvoke: skillInvoker.status(),
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
    for (const item of parsed.definitions) writeDefinition(item.config, item.name)
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

  /** 这台服务器在本插件里/在 CC 里各有什么。 */
  function footprintOf(serverName) {
    const entry = current?.servers.get(serverName)
    const owned = current?.definitions?.get(serverName)
    const ccInfo = current?.claudeMcp?.servers.find((item) => item.name === serverName)
    return {
      entry: entry && entry.layer !== 'cc' ? entry : null,
      owned: owned ?? null,
      cc: ccInfo ?? null,
    }
  }

  /**
   * 删除 = 删掉这台服务器在**本插件里的一切**：门禁条目 + 连接定义 + 运行期连接。
   * 只删一半会「点了没反应」：定义还在，load 时又会把它补回列表。
   */
  async function removeServerEntry(serverName) {
    const { entry, owned, cc } = footprintOf(serverName)
    if (!entry && !owned) {
      throw new Error(cc
        ? `"${serverName}" 只存在于 Claude Code 的定义里，本插件没有可删的配置。要停用它，把这一行的开关关掉就行。`
        : `找不到 "${serverName}" 的配置，可能已经被删掉了。刷新面板看看。`)
    }
    let configRemoved = 0
    if (entry && removeServer(entry.file, serverName)) configRemoved += 1
    if (owned) {
      const dropped = dropDefinitionEverywhere(serverName)
      configRemoved += dropped.length
    }
    const connectionRemoved = Boolean(connections.remove(serverName))
    reload(current.workspace)
    log('删除服务器', serverName, { configRemoved, connectionRemoved })
    return { configRemoved, connectionRemoved, stillDeclaredByCc: Boolean(cc) }
  }

  /** 改名要同时改门禁条目名、定义里的 serverName、以及运行期连接。 */
  async function renameServerEntry(from, to) {
    if (typeof to !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(to)) {
      throw new Error(`"${to}" 不是合法的名字：只能用字母、数字、下划线、点、短横线，最长 64 位`)
    }
    const { entry, owned, cc } = footprintOf(from)
    if (!entry && !owned) {
      throw new Error(cc
        ? `"${from}" 只存在于 Claude Code 的定义里，改名得改 CC 的配置；本插件只能停用它。`
        : `找不到 "${from}" 的配置，可能已经被删掉了。`)
    }
    if (from !== to && current.servers.has(to)) throw new Error(`"${to}" 已经存在，换一个名字`)
    if (entry && !renameServer(entry.file, from, to)) throw new Error(`改名失败：配置里没有 "${from}"`)
    if (owned) {
      removeDefinition(owned.file, from)
      setDefinition(owned.file, to, { ...owned.config, serverName: to })
    }
    const connectionMoved = Boolean(connections.remove(from))
    reload(current.workspace)
    if (owned) {
      await connections.upsert({ ...owned.config, serverName: to })
        .catch((error) => warn(`改名后重连失败: ${error.message}`))
    }
    return { from, to, connectionMoved }
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

  /**
   * 定义写哪儿：
   *   项目工作区 → `<ws>/.mcp.json`（与 Claude Code 共用同一个文件）
   *   全局       → 本插件的全局配置 `mcp.definitions`
   */
  function definitionTarget() {
    const ws = current?.workspace
    if (ws && ws !== GLOBAL_WS) {
      return { ws, file: claudeMcpProjectFile(ws), kind: 'mcp.json' }
    }
    const target = writeTarget()
    return { ws: target.ws, file: target.file, kind: 'plugin' }
  }

  /** 从所有可能的定义来源里删掉一条（.mcp.json + 本插件全局/项目配置）。 */
  function dropDefinitionEverywhere(serverName, { includeMcpJson = true } = {}) {
    const files = []
    const ws = current?.workspace
    if (includeMcpJson && ws && ws !== GLOBAL_WS) {
      const mcpFile = claudeMcpProjectFile(ws)
      const doc = readJsonFile(mcpFile)
      const next = doc ? withoutServer(doc, serverName) : undefined
      if (next) {
        writeJsonFile(mcpFile, next)
        files.push(mcpFile)
      }
    }
    const candidates = [
      files.globalFile,
      current?.workspace && current.workspace !== GLOBAL_WS ? configPaths({ projectDir: current.workspace }).projectFile : null,
    ].filter(Boolean)
    for (const file of new Set(candidates)) {
      if (removeDefinition(file, serverName)) files.push(file)
    }
    return files
  }

  /**
   * 把一份定义写到当前项目对应的位置：
   *   项目 → `<ws>/.mcp.json`（CC 形状，两边共用）
   *   全局 → 本插件全局配置
   * @param previousName 改名前的名字；给了就从旧名字位置清掉
   */
  function writeDefinition(config, previousName) {
    const target = definitionTarget()
    if (target.kind === 'mcp.json') {
      const doc = readJsonFile(target.file) ?? {}
      let next = withServer(doc, config.serverName, config)
      if (previousName && previousName !== config.serverName) {
        next = withoutServer(next, previousName) ?? next
      }
      writeJsonFile(target.file, next)
      // 同一台服务器不要在本插件配置里再留一份（刚写的 .mcp.json 不能删）
      dropDefinitionEverywhere(config.serverName, { includeMcpJson: false })
      if (previousName && previousName !== config.serverName) {
        dropDefinitionEverywhere(previousName, { includeMcpJson: false })
      }
    } else {
      if (previousName && previousName !== config.serverName) removeDefinition(target.file, previousName)
      setDefinition(target.file, config.serverName, config)
    }
    return target
  }

  /** 编辑器要显示的 JSON：优先本插件代管的定义，否则用 CC 的定义当模板。 */
  function getDefinition(serverName) {
    const owned = current?.definitions?.get(serverName)
    if (owned) {
      return {
        server: serverName,
        managed: true,
        config: owned.config,
        source: owned.source === 'mcp.json' || owned.file?.endsWith('.mcp.json') ? 'mcp.json' : 'plugin',
        file: owned.file,
      }
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
    const target = writeDefinition(config, serverName)
    reload(target.ws)
    const result = await connections.upsert(config)
    return { ...result, config, file: target.file, workspace: target.ws, kind: target.kind }
  }

  async function deleteDefinition(serverName) {
    const owned = current?.definitions?.get(serverName)
    if (!owned) throw new Error(`本插件里没有 "${serverName}" 的连接定义`)
    const filesRemovedFrom = dropDefinitionEverywhere(serverName)
    if (filesRemovedFrom.length === 0) throw new Error(`删除失败：没找到 "${serverName}" 的定义，可能已经被删掉了`)
    reload(current.workspace)
    const removedId = connections.remove(serverName)
    return { id: removedId ?? null, files: filesRemovedFrom }
  }

  /** 启动 / 保存后：把配置里的定义灌进 loader。 */
  async function syncConnections() {
    const result = await connections.sync(current?.definitions)
    for (const failure of result.failed) warn(`MCP 连接失败: ${failure.name} — ${failure.reason}`)
    return result
  }

  /** 稳定的会话上下文：注入要落到某个 agent 上。 */
  function sessionAgent() {
    return liveAgents(ctx, warn)[0]
  }

  async function readSkillContent(skillName) {
    const agent = sessionAgent()
    const cwd = agent?.session?.header?.cwd ?? current?.projectDir ?? undefined
    const state = current?.skills.get(skillName)?.state ?? 'on'
    const dirs = skillDirs(typeof cwd === 'string' ? cwd : null, config.ccHome)
    const skill = await skillInvoker.read(skillName, {
      cwd,
      agent,
      fallback: (name) => findSkillFile([...dirs.project, ...dirs.user], name),
    })
    return { state, ...skill }
  }

  /** 手动调用一次：读正文 → 排队 → 下一次请求生效。 */
  async function invokeSkill(skillName) {
    const state = current?.skills.get(skillName)?.state ?? 'on'
    if (state === 'off') {
      throw new Error(`"${skillName}" 已关闭（off），不能调用。想手动用就把它设为「仅手动」或「正常」。`)
    }
    const agent = sessionAgent()
    if (!agent) throw new Error('当前没有活动会话，注入无处可去 —— 先在左边打开一个会话')
    const skill = await readSkillContent(skillName)
    const pending = skillInvoker.enqueue(agent, skill)
    return { name: skillName, pending, agent: String(agent.id ?? '') }
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
    select: async (ws) => {
      reload(ws)
      await syncConnections()
    },
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
    readSkillContent,
    invokeSkill,
  })
  const routeDisposers = routes.map((route) => ctx.webServer.register(route))

  syncConnections().catch((error) => warn(`灌入 MCP 连接失败: ${error.message}`))
  skillInvoker.install()

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
    skillInvoker.dispose()
  }, 'skill-mcp-gate: cleanup')
}
