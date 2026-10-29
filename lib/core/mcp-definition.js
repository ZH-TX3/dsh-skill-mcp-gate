/**
 * MCP 连接定义的校验与归一化（纯函数）。
 *
 * 这里的形状是 **DSH `mcp-client` 的 config**，不是 CC 的 mcpServers：
 *   stdio            { transport:'stdio', serverName, command, args[], env{}, cwd? }
 *   streamable-http  { transport:'streamable-http', serverName, url, headers{} }
 *
 * 编辑器里用户敲的是 JSON，落盘前必须过这一层：只保留认识的键，
 * 名字按 DSH 的 `[A-Za-z0-9_-]{1,32}` 校验（工具名是 `mcp__<serverName>__<tool>`）。
 */

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

const TRANSPORT_ALIASES = {
  stdio: 'stdio',
  'streamable-http': 'streamable-http',
  http: 'streamable-http',
  sse: 'streamable-http',
}

function stringsOnly(value, label) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`${label}.${key} 必须是字符串`)
    out[key] = item
  }
  return out
}

/** 把用户输入（已 JSON.parse 的对象）归一化成 mcp-client config；非法就抛。 */
export function normalizeDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config 必须是一个 JSON 对象')
  }
  const transport = TRANSPORT_ALIASES[String(input.transport ?? (input.url ? 'http' : 'stdio')).toLowerCase()]
  if (!transport) {
    throw new Error(`transport 只能是 stdio 或 streamable-http（也接受 http / sse 别名），收到 "${input.transport}"`)
  }

  const serverName = typeof input.serverName === 'string' ? input.serverName.trim() : ''
  if (!SERVER_NAME_RE.test(serverName)) {
    throw new Error('serverName 必须是 1–32 位字母、数字、下划线或短横线（它会出现在工具名 mcp__<serverName>__<tool> 里）')
  }

  const config = { transport, serverName }
  if (input.toolCallTimeoutMs !== undefined) {
    if (!Number.isInteger(input.toolCallTimeoutMs) || input.toolCallTimeoutMs <= 0) {
      throw new Error('toolCallTimeoutMs 必须是正整数')
    }
    config.toolCallTimeoutMs = input.toolCallTimeoutMs
  }
  if (input.maxInstructionBytes !== undefined) {
    if (!Number.isInteger(input.maxInstructionBytes) || input.maxInstructionBytes <= 0) {
      throw new Error('maxInstructionBytes 必须是正整数')
    }
    config.maxInstructionBytes = input.maxInstructionBytes
  }
  if (input.failOnStartupError !== undefined) {
    if (typeof input.failOnStartupError !== 'boolean') throw new Error('failOnStartupError 必须是布尔值')
    config.failOnStartupError = input.failOnStartupError
  }

  if (transport === 'stdio') {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (command.length === 0) throw new Error('stdio 必须给 command')
    const args = input.args === undefined ? [] : input.args
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
      throw new Error('args 必须是字符串数组')
    }
    config.command = command
    config.args = [...args]
    config.env = stringsOnly(input.env, 'env')
    if (input.cwd !== undefined) {
      if (typeof input.cwd !== 'string') throw new Error('cwd 必须是字符串')
      config.cwd = input.cwd
    }
    return config
  }

  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (!/^https?:\/\//i.test(url)) throw new Error('streamable-http 必须给 http(s) 开头的 url')
  config.url = url
  config.headers = stringsOnly(input.headers, 'headers')
  return config
}

/**
 * 从 Claude Code 的定义生成一份可编辑的初稿（用户点「用 CC 定义填充」时用）。
 * CC 的 type 只有 stdio / http / sse，这里统一映射。
 */
export function templateFromCc(name, definition) {
  if (!definition) return { transport: 'stdio', serverName: name, command: '', args: [] }
  if (definition.url) {
    return {
      transport: 'streamable-http',
      serverName: name,
      url: definition.url,
      ...(definition.headers ? { headers: definition.headers } : {}),
    }
  }
  return {
    transport: 'stdio',
    serverName: name,
    command: definition.command ?? '',
    args: definition.args ?? [],
    ...(definition.env ? { env: definition.env } : {}),
  }
}

/** mcp-client config → 探测用的定义（core/probe.js 认的形状）。 */
export function probeInfoFromConfig(config) {
  if (!config || typeof config !== 'object') return undefined
  if (config.transport === 'streamable-http' && typeof config.url === 'string') {
    return { url: config.url, headers: config.headers ?? {} }
  }
  if (typeof config.command === 'string') {
    return { command: config.command, args: config.args ?? [], env: config.env ?? {} }
  }
  return undefined
}
