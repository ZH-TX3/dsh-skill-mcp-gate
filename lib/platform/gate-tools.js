/**
 * DSH 接缝之四：延迟 MCP 工具的两个中间层工具（CC tool search 的等价物）。
 *
 * 手写 ToolDefinition 而不 import `defineTool`：
 * 后者位于 `@deepseek-ai/dsh-tools`，本地路径插件解析不到；靠绝对路径 import
 * `profiles/node_modules` 会把安装布局焊进代码。实测 defineTool 只是
 * 「把参数规格转成 JSON Schema + 校验参数」，两件事都能自己写（见 DESIGN §19.7）。
 *
 * 这一层不决定谁能被搜：索引由 platform/mcp-filter 按策略填充。
 */

import { serverOfTool } from '../core/mcp-policy.js'
import {
  GATE_CALL, GATE_SEARCH, describeEntry, matchTools, resolveToolName, serverOfInput,
} from '../core/tool-search.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

function textBlock(text) {
  return [{ type: 'text', text }]
}

/** 嵌套结果 → 一段文本；非文本块明确说明被省略，不伪造。 */
export function projectContent(content) {
  const blocks = Array.isArray(content) ? content : []
  const texts = []
  const other = new Map()
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block?.type) other.set(block.type, (other.get(block.type) ?? 0) + 1)
  }
  let text = texts.join('\n\n')
  if (other.size > 0) {
    const list = [...other].map(([type, count]) => `${type}×${count}`).join('、')
    text += `${text.length > 0 ? '\n\n' : ''}[未转发的非文本内容：${list}]`
  }
  return text
}

function refusal(text) {
  return { ok: false, isError: true, text }
}

export function createGateTools({ ctx, getIndex, getServers, log = () => {} }) {
  const errors = []
  const disposers = []

  const searchTool = {
    name: GATE_SEARCH,
    description: 'Search MCP tools that are not currently loaded (deferred servers). Use it when you need a capability that is missing from your tool list, then call the returned name with gate_mcp_call.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, space separated. Every word must appear in the tool name, server, or description.' },
        server: { type: 'string', description: 'Restrict results to one MCP server.' },
        limit: { type: 'integer', description: `Maximum results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
      },
      required: [],
    },
    output: {
      // 注意：这是 JSON Schema，required 是对象级的数组，不是属性里的布尔（defineTool 的 DSL 才是后者）
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { total: { type: 'integer' }, text: { type: 'string' } },
        required: ['total', 'text'],
      },
      render: (_args, value) => textBlock(value.text),
    },
    async execute(args) {
      const entries = [...getIndex().values()]
      if (entries.length === 0) {
        return { total: 0, text: '当前没有延迟加载的 MCP 工具。把服务器状态设为 deferred 后，它的工具会出现在这里。' }
      }
      const limit = Number.isInteger(args?.limit)
        ? Math.min(Math.max(args.limit, 1), MAX_LIMIT)
        : DEFAULT_LIMIT
      const { total, shown } = matchTools(entries, { query: args?.query, server: args?.server, limit })
      if (total === 0) {
        return { total: 0, text: `没有匹配的延迟工具（共 ${entries.length} 个可搜）。换个关键词，或省略 query 列全部。` }
      }
      const header = total > shown.length
        ? `匹配 ${total} 个，先列 ${shown.length} 个：`
        : `匹配 ${total} 个：`
      return { total, text: [header, ...shown.map((entry) => `- ${describeEntry(entry)}`), '', `用 ${GATE_CALL} 调用，例如 {"name": "${shown[0].name}"}`].join('\n') }
    },
  }

  const callTool = {
    name: GATE_CALL,
    description: 'Call one deferred MCP tool by name. Use gate_mcp_search first to find the exact name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact tool name from gate_mcp_search, e.g. mcp__server__tool (server.tool also accepted).' },
        arguments: { type: 'object', description: 'Arguments object passed to the tool as-is.' },
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          isError: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'isError', 'text'],
      },
      render: (_args, value) => textBlock(value.text),
    },
    async execute(args, exec) {
      // 先看服务器状态：关掉的服务器不该因为「不在索引里」而含糊成「没找到」
      const suspected = serverOfInput(args?.name)
      if (suspected && getServers()?.get(suspected)?.state === 'off') {
        return refusal(`服务器 ${suspected} 已被关闭，不能调用。`)
      }

      const index = getIndex()
      const resolved = resolveToolName(args?.name, index)
      if (resolved.error) return refusal(resolved.error)

      const server = serverOfTool(resolved.name)
      const state = getServers()?.get(server)?.state ?? 'on'
      if (state === 'off') return refusal(`服务器 ${server} 已被关闭，不能调用。`)
      if (state !== 'deferred') return refusal(`${resolved.name} 已直接可用，直接调用它即可，不必经过 ${GATE_CALL}。`)

      if (typeof ctx.tools?.execute !== 'function') {
        return refusal('当前运行时不支持嵌套工具调用（ctx.tools.execute 不可用）。')
      }
      const callArguments = args?.arguments && typeof args.arguments === 'object' ? args.arguments : {}
      try {
        const result = await ctx.tools.execute({
          callId: `${String(exec?.callId ?? 'gate')}:gate:1`,
          rootCallId: exec?.rootCallId ?? exec?.callId,
          parent: exec?.token,
          agent: exec?.agent,
          name: resolved.name,
          arguments: callArguments,
          signal: exec?.signal ?? new AbortController().signal,
        })
        log('中间层调用', resolved.name, result?.isError ? '失败' : '成功')
        return { ok: !result?.isError, isError: result?.isError === true, text: projectContent(result?.content) }
      } catch (error) {
        errors.push({ scope: 'call', reason: error.message })
        return refusal(`调用 ${resolved.name} 失败：${error.message}`)
      }
    },
  }

  function install() {
    if (typeof ctx.tools?.register !== 'function') {
      errors.push({ scope: 'install', reason: '当前上下文没有 tools.register()，无法注册中间层工具' })
      return
    }
    for (const tool of [searchTool, callTool]) {
      try {
        disposers.push(ctx.tools.register(tool))
      } catch (error) {
        errors.push({ scope: 'register', reason: `${tool.name}: ${error.message}` })
      }
    }
  }

  return {
    install,
    status: () => ({ errors: [...errors], search: searchTool.name, call: callTool.name }),
    dispose() {
      for (const dispose of disposers) {
        try { dispose?.() } catch { /* ignore */ }
      }
      disposers.length = 0
    },
  }
}
