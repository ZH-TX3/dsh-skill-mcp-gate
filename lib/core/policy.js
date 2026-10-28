/**
 * 纯领域层：skill 状态的词汇表、校验、分层合并。
 *
 * 这里不认识 Claude Code，也不认识任何文件名 —— 只认「四档状态」这个词汇。
 * CC 的 `skillOverrides` 别名解析放在 cc/skills.js，解析完再交给这里合并。
 */

/** 四档状态，与 Claude Code 的 skillOverrides 同一套词汇。 */
export const SKILL_STATES = ['on', 'name-only', 'user-invocable-only', 'off']

/** 模型完全看不到。 */
export const HIDDEN_STATES = new Set(['off', 'user-invocable-only'])

/** 只露名字、不露描述。 */
export const NAME_ONLY_STATES = new Set(['name-only'])

/** 状态 → 目录里的可见性，供渲染层使用。 */
export function visibilityOf(state) {
  if (HIDDEN_STATES.has(state)) return 'hidden'
  if (NAME_ONLY_STATES.has(state)) return 'name-only'
  return 'full'
}

/**
 * mcp 服务器三档：on 直接可用 / deferred 延迟（可搜可调但不占工具位）/ off 关闭。
 * 逐工具只有两档：deferred 只在服务器级有意义（见 DESIGN §19.2）。
 */
export const MCP_STATES = ['on', 'deferred', 'off']
export const MCP_TOOL_STATES = ['on', 'off']

export function assertSkillState(state, where) {
  if (!SKILL_STATES.includes(state)) {
    throw new Error(`${where}: 未知状态 "${state}"，可用值 ${SKILL_STATES.join(' / ')}`)
  }
  return state
}

export function assertMcpState(state, where) {
  if (!MCP_STATES.includes(state)) {
    throw new Error(`${where}: 未知状态 "${state}"，可用值 ${MCP_STATES.join(' / ')}`)
  }
  return state
}

export function assertMcpToolState(state, where) {
  if (!MCP_TOOL_STATES.includes(state)) {
    throw new Error(`${where}: 未知状态 "${state}"，逐工具仅支持 ${MCP_TOOL_STATES.join(' / ')}`)
  }
  return state
}

/** 把服务器状态翻译成一句人话。 */
export function describeMcpState(state) {
  switch (state) {
    case 'on': return '工具常驻，模型可直接调用'
    case 'deferred': return '工具不进提示词，可按需搜索并调用'
    case 'off': return '工具既不出现也不可调用'
    default: return state
  }
}

/**
 * 合并多层 skill 策略；后者覆盖前者。
 * @param layers [{ file, label, skills: Map<name,{state}> }]，顺序为低 → 高
 * @returns Map<name, { state, decidedBy: { file, label } }>
 */
export function mergeSkillLayers(layers) {
  const out = new Map()
  for (const layer of layers) {
    for (const [name, entry] of layer.skills) {
      out.set(name, { state: entry.state, decidedBy: { file: layer.file, label: layer.label } })
    }
  }
  return out
}

/** 把四档翻译成可读说明。 */
export function describeState(state) {
  switch (state) {
    case 'on': return '模型可见且可调用'
    case 'name-only': return '仅名称可见（目录里不带描述）'
    case 'user-invocable-only': return '模型不可见，/name 可调用'
    case 'off': return '模型不可见且不可调用'
    default: return state
  }
}
