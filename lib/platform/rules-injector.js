/**
 * DSH 接缝之五：把 CC 的 `rules/` 按路径门控注入上下文。
 *
 * 两个事件就够（与 dsh-agent-instructions 用同一对缝）：
 *   `tools/result`  —— 成功的 read/write/edit 之后记下被触碰的文件
 *   `agent/pre-step` —— 下一步之前，把命中规则的正文作为一条 user 消息插进去
 *
 * 为什么不用 `system-prompt/assemble`：那个缝的 AssembleContext 只有 { scope, signal }，
 * 拿不到 agent，也就拿不到「这个会话碰过哪些文件」。见 DESIGN §17.2 的同一处限制。
 */

import { randomUUID } from 'node:crypto'
import { discoverRules } from '../cc/rules.js'
import { claudeRulesDirs } from '../paths.js'
import { planRuleInjection, renderRulesBlock } from '../core/rules.js'

const FILE_TOUCH_TOOLS = new Set(['read', 'write', 'edit'])
const TOUCH_LIMIT = 500
const DISCOVERY_TTL_MS = 30_000

function touchedPathOf(exec) {
  if (!FILE_TOUCH_TOOLS.has(exec?.name)) return undefined
  const args = exec?.arguments
  if (!args || typeof args !== 'object') return undefined
  const raw = args.file_path
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  return value.length > 0 ? value : undefined
}

/** 手写 user 消息：`createMessage` 只是 `{ ...input, id: randomUUID(), role }`。 */
function rulesMessage(rules, text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'cc-rules', form: 'rules', rules: rules.map((rule) => rule.id) },
  }
}

export function createRulesInjector({ ctx, getOptions, log = () => {} }) {
  const stateByAgent = new WeakMap()   // agent → { touched:Set, injected:Set }
  const discoveryCache = new Map()     // cwd → { at, rules }
  const errors = []
  let injectedTotal = 0
  let lastIds = []
  let disposers = []

  function stateOf(agent) {
    let state = stateByAgent.get(agent)
    if (!state) {
      state = { touched: new Set(), injected: new Set(), budgetNoticed: false }
      stateByAgent.set(agent, state)
    }
    return state
  }

  function rulesFor(cwd, options) {
    const cached = discoveryCache.get(cwd)
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.rules
    const warnings = []
    let rules = []
    try {
      rules = discoverRules({
        dirs: claudeRulesDirs(cwd, options.home),
        root: cwd,
        warnings,
      })
    } catch (error) {
      errors.push({ scope: 'discover', reason: error.message })
    }
    for (const warning of warnings) log('rules', warning)
    discoveryCache.set(cwd, { at: Date.now(), rules })
    return rules
  }

  function install() {
    if (typeof ctx.on !== 'function') {
      errors.push({ scope: 'install', reason: '当前上下文没有 on()，无法安装 rules 注入' })
      return
    }

    disposers.push(ctx.on('tools/result', (exec, result) => {
      try {
        if (!exec?.agent || result?.isError || exec.signal?.aborted) return
        const filePath = touchedPathOf(exec)
        if (!filePath) return
        const state = stateOf(exec.agent)
        if (state.touched.size < TOUCH_LIMIT) state.touched.add(filePath)
      } catch (error) {
        errors.push({ scope: 'touch', reason: error.message })
      }
    }))

    disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        const options = getOptions()
        if (!options?.enabled) return decision
        if (!decision || decision.kind === 'reject') return decision
        const agent = payload?.agent
        const cwd = agent?.session?.header?.cwd
        if (!agent || typeof cwd !== 'string' || cwd.length === 0) return decision

        const state = stateOf(agent)
        const rules = rulesFor(cwd, options)
        if (rules.length === 0) return decision

        const plan = planRuleInjection({
          rules,
          touched: [...state.touched],
          root: cwd,
          injected: state.injected,
          budgetBytes: options.maxBytes,
        })
        // 一条都放不下时，也要说一句「被预算挡了」，不能静默吞掉
        if (plan.inject.length === 0) {
          if (plan.skipped.length === 0 || state.budgetNoticed) return decision
          state.budgetNoticed = true
          const notice = renderRulesBlock([], { omitted: plan.skipped, budgetBytes: options.maxBytes })
          errors.push({ scope: 'budget', reason: `${plan.skipped.length} 条规则因预算未注入` })
          return { ...decision, messages: [...(decision.messages ?? []), rulesMessage([], notice)] }
        }

        const text = renderRulesBlock(plan.inject, {
          omitted: plan.skipped,
          budgetBytes: options.maxBytes,
        })
        for (const rule of plan.inject) state.injected.add(rule.id)
        injectedTotal += plan.inject.length
        lastIds = plan.inject.map((rule) => rule.id)
        log('注入规则', plan.inject.length, '条', plan.bytes, '字节')

        return { ...decision, messages: [...(decision.messages ?? []), rulesMessage(plan.inject, text)] }
      } catch (error) {
        errors.push({ scope: 'inject', reason: error.message })
        return decision
      }
    }))
  }

  return {
    install,
    status: () => ({ injected: injectedTotal, last: lastIds, errors: [...errors] }),
    /** 测试用：清掉发现缓存（改完规则文件后想立刻生效时也可以调） */
    invalidate: () => discoveryCache.clear(),
    dispose() {
      for (const dispose of disposers) {
        try { dispose?.() } catch { /* ignore */ }
      }
      disposers = []
      discoveryCache.clear()
    },
  }
}
