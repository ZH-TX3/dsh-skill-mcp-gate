/**
 * DSH 观察层：只读地看 DSH 现在是什么样（活的 agent、工作区、工具、skill 目录）。
 *
 * 这一层不认识配置、不做决策，只把 DSH 的运行时事实翻译成普通数据，
 * 让 host/ 那层不需要直接碰 ctx。
 */

/** 线上 agent 列表。 */
export function liveAgents(ctx, warn = () => {}) {
  try {
    const list = ctx.agents?.list?.()
    return Array.isArray(list) ? list.filter(Boolean) : []
  } catch (error) {
    warn(`读取 agent 列表失败: ${error.message}`)
    return []
  }
}

/** 当前会话的 cwd（取第一个有 cwd 的 agent）。 */
export function agentCwd(ctx, warn) {
  for (const agent of liveAgents(ctx, warn)) {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  }
  return undefined
}

/**
 * 左侧列表：全局 + DSH 的工作区树（用户在侧边栏建的那几个），
 * 而不是从活着的会话反推 —— 后者只能看到当前打开的会话。
 */
export function workspaceList(ctx, { globalKey, warn = () => {} } = {}) {
  const map = new Map()
  map.set(globalKey, { key: globalKey, label: '全局', cwd: null, hint: '基础层' })

  let fromRegistry = []
  try {
    fromRegistry = ctx.workspaceRegistry?.list?.() ?? []
  } catch (error) {
    warn(`读取工作区列表失败: ${error.message}`)
  }
  for (const item of fromRegistry) {
    const path = item?.path
    if (typeof path !== 'string' || path.length === 0) continue
    map.set(path, { key: path, label: item.title || path, cwd: path, hint: '覆盖全局' })
  }

  // 兜底：当前会话的 cwd 若不在工作区树里（例如临时目录），也列出来
  for (const agent of liveAgents(ctx, warn)) {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) continue
    if (map.has(cwd)) continue
    map.set(cwd, { key: cwd, label: cwd, cwd, hint: '临时目录' })
  }
  return [...map.values()]
}

/** 当前全部工具名（全局层 + 每个 agent 层）。 */
export function toolNames(ctx, warn = () => {}) {
  const agents = liveAgents(ctx, warn)
  const names = new Set()
  const collect = (scope) => {
    try {
      for (const schema of ctx.tools.schemas(scope)) names.add(schema.name)
    } catch (error) {
      warn(`读取工具清单失败: ${error.message}`)
    }
  }
  if (agents.length === 0) collect(undefined)
  for (const agent of agents) collect(agent)
  return [...names]
}

/**
 * skill 目录。官方写法必须带 scope，否则只能读到全局层：
 *   skills.list({ cwd: agent.session.header.cwd, scope: agent })
 */
export async function listSkills(ctx, lookups, warn = () => {}) {
  const byName = new Map()
  for (const options of lookups) {
    try {
      for (const skill of await ctx.skills.list(options)) {
        if (!byName.has(skill.name)) byName.set(skill.name, skill)
      }
    } catch (error) {
      warn(`读取 skill 目录失败: ${error.message}`)
    }
  }
  return [...byName.values()]
}
