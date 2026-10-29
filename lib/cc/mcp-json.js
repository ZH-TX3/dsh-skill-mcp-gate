/**
 * Claude Code 的项目级 MCP 文件 `<工作区>/.mcp.json`：读、写、增删。
 *
 * 形状与 CC 完全一致，所以同一个文件在 CC 和 DSH 里都能用：
 *   { "mcpServers": { "exa": { "type": "http", "url": "https://…" },
 *                     "ctx": { "command": "cmd", "args": ["/c","npx","-y","pkg"], "env": {"K":"v"} } } }
 *
 * 这一层只做「文档 ↔ 条目」的纯变换；真正的原子写由调用方用 io.writeJsonFile 完成。
 */

export const MCP_JSON_KEY = 'mcpServers'

/** DSH 的 mcp-client config → CC 的 mcpServers 条目。 */
export function toCcServer(config) {
  if (!config || typeof config !== 'object') return undefined
  if (config.transport === 'streamable-http') {
    return {
      type: 'http',
      url: config.url,
      ...(config.headers && Object.keys(config.headers).length > 0 ? { headers: { ...config.headers } } : {}),
    }
  }
  return {
    type: 'stdio',
    command: config.command,
    args: [...(config.args ?? [])],
    ...(config.env && Object.keys(config.env).length > 0 ? { env: { ...config.env } } : {}),
  }
}

/** 取出一份文档里的服务器条目（保持 CC 的原始形状）。 */
export function serversOf(doc) {
  const block = doc?.[MCP_JSON_KEY]
  if (!block || typeof block !== 'object' || Array.isArray(block)) return {}
  return block
}

/** 写入/覆盖一条服务器，保留文件里其它键与其它服务器。 */
export function withServer(doc, name, config) {
  const next = doc && typeof doc === 'object' && !Array.isArray(doc) ? { ...doc } : {}
  next[MCP_JSON_KEY] = { ...serversOf(next), [name]: toCcServer(config) }
  return next
}

/** 删掉一条服务器；没有该条目时返回 undefined（调用方据此避免无意义写盘）。 */
export function withoutServer(doc, name) {
  const servers = serversOf(doc)
  if (!(name in servers)) return undefined
  const next = { ...doc }
  const rest = { ...servers }
  delete rest[name]
  if (Object.keys(rest).length === 0) delete next[MCP_JSON_KEY]
  else next[MCP_JSON_KEY] = rest
  return next
}
