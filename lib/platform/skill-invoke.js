/**
 * 手动调用 skill：把某个技能的正文作为一条 user 消息注入下一次请求。
 *
 * DSH 里 skill 只有「模型通过 `skill` 工具加载」这一条路，没有 `/name` 那样的用户入口，
 * 于是 `user-invocable-only` 和 `off` 在行为上没区别（都是「模型看不到」）。
 * 这个接缝补的就是用户那条路：面板上点「调用一次」= 以用户身份把技能正文塞进上下文。
 *
 * 两个事件：
 *   agent/pre-step —— 把排队的技能刷成消息（每条只注入一次）
 *   （没有第二个：内容由 ctx.skills.get() 读，读的时候就已经是最终正文）
 */

const MAX_QUEUE = 4

/** 复刻 dsh-skill 的 `<skill_content>` 外壳（那是模型唯一认得的形状）。 */
export function renderSkillContent({ name, content, provider, resourceBase }) {
  const escapeAttr = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const escapeText = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const resources = resourceBase && resourceBase.kind === 'directory' && typeof resourceBase.path === 'string'
    ? [
      `Base directory for this skill: ${escapeText(resourceBase.path)}`,
      'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
    ]
    : [
      `Resources for this skill are managed by provider "${escapeText(provider ?? 'unknown')}".`,
      'Load referenced resources only as needed.',
    ]
  return [
    `<skill_content name="${escapeAttr(name)}">`,
    '<skill_resources>',
    ...resources,
    '</skill_resources>',
    '',
    '<skill_instructions>',
    content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

export function createSkillInvoker({ ctx, log = () => {} }) {
  const queues = new WeakMap()   // agent → [{ name, text }]
  const errors = []
  let disposer
  let injectedTotal = 0
  let lastNames = []

  function queueFor(agent) {
    let queue = queues.get(agent)
    if (!queue) {
      queue = []
      queues.set(agent, queue)
    }
    return queue
  }

  /** 读技能正文（走 DSH 的 registry，provider 由它自己挑）。 */
  async function read(name, { cwd, agent, fallback } = {}) {
    let skill
    if (typeof ctx.skills?.get === 'function') {
      skill = await ctx.skills.get(name, agent ? { cwd, scope: agent } : { cwd })
    }
    // registry 只读得到「有会话所在的层」；没会话时回退到直接扫目录
    if (!skill && typeof fallback === 'function') skill = await fallback(name)
    if (!skill) throw new Error(`目录里没有 skill "${name}"`)
    return {
      name: skill.name,
      provider: skill.provider,
      content: skill.content,
      resourceBase: skill.resourceBase,
      invocation: skill.invocation,
    }
  }

  /** 排队一次手动调用；下一次 pre-step 会把它注入。 */
  function enqueue(agent, skill) {
    if (!agent) throw new Error('当前没有活动会话，无法注入 —— 先在左边打开一个会话')
    const queue = queueFor(agent)
    if (queue.length >= MAX_QUEUE) queue.shift()
    const text = renderSkillContent(skill)
    queue.push({ name: skill.name, text })
    log('排队手动调用', skill.name, queue.length)
    return queue.length
  }

  function install() {
    if (typeof ctx.on !== 'function') {
      errors.push({ scope: 'install', reason: '当前上下文没有 on()，无法安装手动调用' })
      return
    }
    disposer = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        const agent = payload?.agent
        if (!agent || !decision || decision.kind === 'reject') return decision
        const queue = queues.get(agent)
        if (!queue || queue.length === 0) return decision
        const pending = queue.splice(0, queue.length)
        const messages = pending.map((item) => ({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: 'user',
          content: [{ type: 'text', text: item.text }],
          source: { kind: 'skill-invoke', form: 'content', name: item.name },
        }))
        injectedTotal += messages.length
        lastNames = pending.map((item) => item.name)
        log('注入手动调用', lastNames.join(', '))
        return { ...decision, messages: [...(decision.messages ?? []), ...messages] }
      } catch (error) {
        errors.push({ scope: 'inject', reason: error.message })
        return decision
      }
    })
  }

  return {
    install,
    read,
    enqueue,
    status: () => ({ injected: injectedTotal, last: lastNames, errors: [...errors] }),
    dispose() {
      try { disposer?.() } catch { /* ignore */ }
    },
  }
}
