/**
 * DSH 接缝之一：装配期过滤 MCP 工具，并顺手维护「延迟工具」索引。
 *
 * 为什么用这个缝（而不是 agent.ctx.tools.restrict）：
 *   - 全局生效，不需要遍历 agents、不需要 agent/created 补挂
 *   - 不受 restrict() 的"已知工具名"校验限制，MCP 后连也不会抛错
 *   - 只改本次装配产物，不写文件、不断连、下个 turn 即恢复
 *
 * 依据：dsh-system-prompt/lib/types/index.d.ts:27
 *   'system-prompt/assemble'(assembly, context, next) => Promise<PromptAssembly>
 *
 * `deferred` 服务器的工具从这里被摘掉，同时把 name + description 记进索引，
 * 供 gate_mcp_search / gate_mcp_call 使用（见 DESIGN §19.3）。
 */

import { computeDisabled } from '../core/mcp-policy.js'
import { GATE_CALL, GATE_SEARCH, indexEntry } from '../core/tool-search.js'

/**
 * @param getServers () => Map<name, {state, tools}>，每次装配现取，配置改动立即生效
 */
export function createMcpFilter({ ctx, getServers, log = () => {} }) {
  let disposer
  let lastReport = { hidden: [], deferred: [], pending: [], servers: [], filtered: 0, gateVisible: false }
  const errors = []
  const index = new Map()   // 全名 → { name, server, bare, description }

  function filter(assembly) {
    if (!assembly || !Array.isArray(assembly.tools)) return 0
    const servers = getServers() ?? new Map()

    const names = assembly.tools.map((tool) => String(tool?.name ?? ''))
    const report = computeDisabled(names, servers)

    // 索引只收延迟工具：装配产物里的 description 就是权威来源
    const deferredNow = new Set(report.deferred)
    const byName = new Map(assembly.tools.map((tool) => [String(tool?.name ?? ''), tool]))
    index.clear()
    for (const name of deferredNow) {
      const entry = indexEntry(byName.get(name))
      if (entry) index.set(name, entry)
    }

    const remove = new Set([...report.hidden, ...report.deferred])
    // 没有任何延迟工具时，连中间层自己也不必占工具位
    const gateVisible = deferredNow.size > 0
    if (!gateVisible) {
      remove.add(GATE_SEARCH)
      remove.add(GATE_CALL)
    }

    const before = assembly.tools.length
    if (remove.size > 0) {
      assembly.tools = assembly.tools.filter((tool) => !remove.has(String(tool?.name ?? '')))
    }
    const removed = before - assembly.tools.length

    lastReport = {
      hidden: report.hidden,
      deferred: report.deferred,
      pending: report.pending,
      servers: report.servers,
      filtered: removed,
      gateVisible,
    }

    if (removed > 0) log('装配期隐藏工具', removed, '其中延迟', report.deferred.length)
    return removed
  }

  function install() {
    const root = ctx.root ?? ctx
    if (typeof root?.on !== 'function') {
      errors.push({ scope: 'install', reason: '当前上下文没有 on()，无法安装装配过滤器' })
      return
    }
    disposer = root.on('system-prompt/assemble', (assembly, _context, next) => {
      try {
        filter(assembly)
      } catch (error) {
        errors.push({ scope: 'assemble', reason: error.message })
      }
      return next()
    })
  }

  return {
    install,
    /** 供测试与诊断：直接对一份 assembly 应用过滤 */
    filter,
    /** 延迟工具索引（gate_mcp_search / gate_mcp_call 用） */
    index: () => index,
    status: () => ({ ...lastReport, errors: [...errors] }),
    dispose() {
      try { disposer?.() } catch { /* ignore */ }
    },
  }
}
