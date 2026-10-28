/**
 * MCP 策略（纯函数）：工具名解析、配置归一化、隐藏集合计算。
 *
 * 不认识 DSH 的事件、不认识 CC 的文件 —— 只做数据变换，
 * 方便单测，也让装配过滤器这一层只剩「接线」。
 */

export const MCP_PREFIX = 'mcp__'

/** 服务器级三档；逐工具两档（deferred 只在服务器级有意义）。 */
const SERVER_STATES = ['on', 'deferred', 'off']
const TOOL_STATES = ['on', 'off']

/** 从工具名解析出服务器名；不是 MCP 工具返回 undefined。 */
export function serverOfTool(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith(MCP_PREFIX)) return undefined
  const rest = toolName.slice(MCP_PREFIX.length)
  const index = rest.indexOf('__')
  if (index <= 0) return undefined
  return rest.slice(0, index)
}

/** 归组：服务器 → 该服务器的工具名列表。 */
export function groupToolsByServer(toolNames) {
  const byServer = new Map()
  for (const name of toolNames) {
    const server = serverOfTool(name)
    if (!server) continue
    if (!byServer.has(server)) byServer.set(server, [])
    byServer.get(server).push(name)
  }
  return byServer
}

/** 服务器条目的裸工具名（去掉 `mcp__<server>__` 前缀）。 */
export function bareToolName(toolName) {
  const server = serverOfTool(toolName)
  if (!server) return undefined
  return toolName.slice(MCP_PREFIX.length + server.length + 2)
}

/**
 * 归一化 mcp.servers 配置。
 * 支持 `"exa": "off"` 与 `"exa": { "state": "deferred", "tools": { "crawl": "off" } }`。
 * 服务器三档（on / deferred / off），逐工具只有 on / off。
 */
export function normalizeServers(raw, file, warnings) {
  const servers = new Map()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return servers
  for (const [server, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      if (!SERVER_STATES.includes(value)) {
        warnings?.push(`${file}: mcp.servers.${server} 状态无效（仅 ${SERVER_STATES.join(' / ')}）`)
        continue
      }
      servers.set(server, { state: value, tools: new Map() })
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      warnings?.push(`${file}: mcp.servers.${server} 需要状态字符串或对象`)
      continue
    }
    const state = value.state ?? 'on'
    if (!SERVER_STATES.includes(state)) {
      warnings?.push(`${file}: mcp.servers.${server}.state 状态无效（仅 ${SERVER_STATES.join(' / ')}）`)
      continue
    }
    const tools = new Map()
    if (value.tools && typeof value.tools === 'object' && !Array.isArray(value.tools)) {
      for (const [tool, toolState] of Object.entries(value.tools)) {
        if (!TOOL_STATES.includes(toolState)) {
          warnings?.push(`${file}: mcp.servers.${server}.tools.${tool} 状态无效（逐工具仅 ${TOOL_STATES.join(' / ')}）`)
          continue
        }
        tools.set(tool, toolState)
      }
    }
    servers.set(server, { state, tools })
  }
  return servers
}

/**
 * 算出本次装配要隐藏的工具名。
 * @param toolNames 当前装配里的工具名
 * @param servers   normalizeServers 的结果（或叠加了基线层的同类 Map）
 */
export function computeDisabled(toolNames, servers) {
  const byServer = groupToolsByServer(toolNames)
  const hidden = new Map()     // toolName -> 原因（彻底关闭）
  const deferred = new Map()   // toolName -> 原因（延迟：不进工具表但可搜可调）
  const pending = []

  for (const [server, entry] of servers) {
    const tools = byServer.get(server) ?? []
    if (entry.state === 'off') {
      if (tools.length === 0) { pending.push(server); continue }
      for (const tool of tools) hidden.set(tool, `${server} 已关闭`)
      continue
    }
    if (entry.state === 'deferred') {
      if (tools.length === 0) { pending.push(server); continue }
      for (const tool of tools) {
        const bare = bareToolName(tool) ?? tool
        if (entry.tools.get(bare) === 'off') hidden.set(tool, `${server}.${bare} 已关闭`)
        else deferred.set(tool, `${server} 延迟加载`)
      }
      continue
    }
    for (const [bare, toolState] of entry.tools) {
      if (toolState !== 'off') continue
      const full = `${MCP_PREFIX}${server}__${bare}`
      if (!tools.includes(full)) { pending.push(`${server}.${bare}`); continue }
      hidden.set(full, `${server}.${bare} 已关闭`)
    }
  }

  return {
    hidden: [...hidden.keys()].sort(),
    deferred: [...deferred.keys()].sort(),
    reasons: hidden,
    deferredReasons: deferred,
    pending: pending.sort(),
    servers: [...byServer.keys()].sort(),
  }
}
