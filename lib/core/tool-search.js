/**
 * 延迟 MCP 工具的索引与检索（纯函数）。
 *
 * 索引内容来自装配过滤器看到的工具 schema —— 不额外遍历、不连服务器、不读配置。
 * 这一层只做「数据变换 + 打分」，不认识 ctx，也不认识 CC。
 */

import { bareToolName, serverOfTool } from './mcp-policy.js'

export const GATE_SEARCH = 'gate_mcp_search'
export const GATE_CALL = 'gate_mcp_call'
export const GATE_PREFIX = 'gate_mcp_'

/** 一条索引记录。 */
export function indexEntry(tool) {
  const name = String(tool?.name ?? '')
  const server = serverOfTool(name)
  if (!server) return undefined
  return {
    name,
    server,
    bare: bareToolName(name) ?? name,
    description: String(tool?.description ?? '').replace(/\s+/g, ' ').trim(),
  }
}

/** 展示用的一行（描述截断，省 token）。 */
export function describeEntry(entry, maxLength = 120) {
  const description = entry.description.length > maxLength
    ? `${entry.description.slice(0, maxLength - 1)}…`
    : entry.description
  return description.length > 0 ? `\`${entry.name}\` — ${description}` : `\`${entry.name}\``
}

function tokensOf(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function score(entry, tokens) {
  if (tokens.length === 0) return 0
  const name = entry.name.toLowerCase()
  const bare = entry.bare.toLowerCase()
  const server = entry.server.toLowerCase()
  const description = entry.description.toLowerCase()
  let total = 0
  for (const token of tokens) {
    if (bare.includes(token) || name.includes(token)) total += 3
    else if (server.includes(token)) total += 2
    else if (description.includes(token)) total += 1
    else return -1   // 有一个词找不到就不算命中
  }
  return total
}

/**
 * @param entries 索引里的全部记录
 * @param query   关键词（空格分隔，全部命中才算）
 * @param server  只看某台服务器
 * @param limit   返回条数上限
 */
export function matchTools(entries, { query = '', server, limit = 20 } = {}) {
  const tokens = tokensOf(query)
  const scoped = server ? entries.filter((entry) => entry.server === server) : entries
  const scored = []
  for (const entry of scoped) {
    const value = score(entry, tokens)
    if (value < 0) continue
    scored.push({ entry, value })
  }
  scored.sort((a, b) => b.value - a.value || a.entry.name.localeCompare(b.entry.name))
  return {
    total: scored.length,
    shown: scored.slice(0, Math.max(1, limit)).map((item) => item.entry),
  }
}

/**
 * 从输入里推断服务器名（`mcp__s__t` 全名或 `s.t` 简写）。
 * 用于在查索引之前先判断「这台服务器是不是被关掉了」。
 */
export function serverOfInput(input) {
  const raw = String(input ?? '').trim()
  if (raw.startsWith('mcp__')) return serverOfTool(raw)
  const dot = raw.indexOf('.')
  return dot > 0 ? raw.slice(0, dot) : undefined
}

/**
 * 解析模型给的工具名：接受 `mcp__server__tool` 全名，也接受 `server.tool` 简写。
 * @returns { name } | { error }
 */
export function resolveToolName(input, known) {
  if (typeof input !== 'string' || input.trim().length === 0) return { error: '缺少工具名' }
  const raw = input.trim()
  if (raw.startsWith(GATE_PREFIX)) return { error: `${raw} 不能调用自己` }
  const candidates = raw.includes('__') ? [raw] : [`mcp__${raw.replace(/\./g, '__')}`, raw]
  for (const candidate of candidates) {
    if (known.has(candidate)) return { name: candidate }
  }
  return { error: `索引里没有 "${raw}"，先用 ${GATE_SEARCH} 搜索` }
}
