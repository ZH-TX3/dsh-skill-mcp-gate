/**
 * DSH 接缝之二：目录消息门禁。
 *
 * 不往 agent scope 注册任何东西，而是在 `agent/pre-step` 重写官方 tool-skill
 * 发布的 skill 目录消息，并在调用期拦住被隐藏的 skill。
 *
 * 为什么不用 runtime 影子：`agent.ctx` 未声明 skills 注入，`agent.ctx.skills`
 * 直接抛 "cannot get property \"skills\" without inject"；全局上下文注册只落在全局层，
 * 用户 skill 却在 agent scope 层 —— 影子天然盖不住。消费侧拦截与层无关。
 *
 * 这一层只负责「把计划落到消息上」，具体藏谁、谁只留名字，由调用方给的 plan 决定。
 */

const NO_NAMES = new Set()

function escapeText(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 一条目录项。name-only 只渲染名字（对齐 CC：看得到名字、看不到描述）。 */
function renderEntries(entries, nameOnly = NO_NAMES) {
  return entries.map((entry) => (nameOnly.has(entry.name)
    ? `- \`${entry.name}\``
    : `- \`${entry.name}\`: ${escapeText(entry.description)}`))
}

/**
 * 与官方 renderCatalogUpdate 同构：完整替换语义。
 * `source.entries` 保留完整描述 —— 官方按它算摘要去重，
 * 只改模型看到的文本，不动事实记录。
 */
export function renderCatalogUpdate(entries, nameOnly = NO_NAMES) {
  const availability = entries.length === 0
    ? [
      'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.',
      'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
    ]
    : [
      'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
      'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    ]
  const text = [
    '<system-reminder>',
    'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
    '',
    '<available_skills>',
    ...renderEntries(entries, nameOnly),
    '</available_skills>',
    '',
    ...availability,
    '</system-reminder>',
  ].join('\n')
  return { text, source: { kind: 'skill-catalog', form: 'catalog', update: true, entries } }
}

/** 从一条消息里取出目录条目；不是目录消息返回 undefined。 */
export function catalogEntriesOf(message) {
  const source = message?.source
  if (!source || source.kind !== 'skill-catalog' || !Array.isArray(source.entries)) return undefined
  return source.entries
}

const EMPTY_PLAN = { hide: NO_NAMES, nameOnly: NO_NAMES }

/**
 * @param getPlan (entries) => { hide: Set<string>, nameOnly: Set<string> }
 *   entries 是该条目录消息里的条目（预算要按它算）；guard 期传空数组。
 */
export function createCatalogGate({ ctx, getPlan, log = () => {} }) {
  let disposers = []
  const errors = []
  let lastFiltered = 0

  function planFor(entries) {
    try {
      const value = getPlan(entries)
      return value ?? EMPTY_PLAN
    } catch (error) {
      errors.push({ scope: 'plan', reason: error.message })
      return EMPTY_PLAN
    }
  }

  /** 隐藏的整条删掉，name-only 的只留名字。 */
  function rewrite(message, { hide, nameOnly }) {
    const entries = catalogEntriesOf(message)
    if (!entries) return message
    const kept = hide.size === 0 ? entries : entries.filter((entry) => !hide.has(entry.name))
    const stripped = nameOnly.size === 0
      ? NO_NAMES
      : new Set(kept.filter((entry) => nameOnly.has(entry.name)).map((entry) => entry.name))
    if (kept.length === entries.length && stripped.size === 0) return message
    const rebuilt = renderCatalogUpdate(kept, stripped)
    const content = Array.isArray(message.content) ? message.content : []
    const first = content[0]
    if (!first || first.type !== 'text') return message
    return {
      ...message,
      content: [{ ...first, text: rebuilt.text }, ...content.slice(1)],
      source: rebuilt.source,
    }
  }

  function install() {
    if (typeof ctx.on !== 'function') {
      errors.push({ scope: 'install', reason: '当前上下文没有 on()，无法安装目录门禁' })
      return
    }
    disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (!decision || decision.kind === 'reject') return decision
      let filtered = 0
      const messages = (decision.messages ?? []).map((message) => {
        const entries = catalogEntriesOf(message)
        if (!entries) return message
        const current = planFor(entries)
        const next_ = rewrite(message, current)
        if (next_ !== message) filtered += 1
        return next_
      })
      lastFiltered = filtered
      return filtered === 0 ? decision : { ...decision, messages }
    }))

    // 调用期兜底：被隐藏的 skill 就算被点名也不执行（name-only 仍然可调）
    try {
      disposers.push(ctx.tools.guard((exec) => {
        if (exec?.name !== 'skill') return undefined
        const name = exec?.arguments?.name
        if (typeof name !== 'string') return undefined
        if (!planFor([]).hide.has(name)) return undefined
        return `skill "${name}" 已被 skill-mcp-gate 关闭`
      }))
    } catch (error) {
      errors.push({ scope: 'guard', reason: error.message })
    }
    log('目录门禁已安装')
  }

  return {
    install,
    status: () => ({ filteredMessages: lastFiltered, errors: [...errors] }),
    dispose() {
      for (const dispose of disposers) {
        try { dispose?.() } catch { /* ignore */ }
      }
      disposers = []
    },
  }
}
