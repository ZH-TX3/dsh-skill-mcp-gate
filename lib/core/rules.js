/**
 * 路径门控的纯逻辑：glob 编译、命中判定、注入规划。
 *
 * 不认识 fs、不认识 ctx —— 文件列表由 cc/rules.js 给，这里只算「谁该进上下文」。
 */

/** 一段规则的渲染外壳（纯文本，便于单测）。 */
export function renderRulesBlock(rules, { omitted = [], budgetBytes = null } = {}) {
  if (rules.length === 0 && omitted.length === 0) return ''
  const lines = ['<system-reminder>']
  if (rules.length > 0) {
    lines.push(
      'Workspace rules are now active because you are working with matching files. They add to the instructions you already have.',
      '',
    )
  }
  for (const rule of rules) {
    lines.push(`<rule path="${rule.id}">`, rule.text, '</rule>', '')
  }
  if (omitted.length > 0) {
    lines.push(`以下规则因超出注入预算被省略：${omitted.map((rule) => rule.id).join('、')}`)
    lines.push('')
  }
  if (budgetBytes !== null) lines.push(`Rule budget: ${budgetBytes} bytes`)
  lines.push('</system-reminder>')
  return lines.join('\n')
}

function escapeRegex(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/**
 * glob → RegExp。
 * `**` 跨目录，`*` 不跨，`?` 单个非分隔符；大小写不敏感（Windows 与 CC 行为一致）。
 */
export function globToRegExp(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/').trim()
  let source = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` 吃掉任意层目录（含零层）
        if (normalized[i + 2] === '/') { source += '(?:.*/)?'; i += 2 } else { source += '.*'; i += 1 }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') { source += '[^/]'; continue }
    source += escapeRegex(char)
  }
  return new RegExp(`^${source}$`, 'i')
}

/** 把绝对路径折成项目内的相对路径（统一正斜杠）。 */
export function toRelativePath(root, filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return ''
  const posix = filePath.replace(/\\/g, '/')
  if (!root) return posix.replace(/^\/+/, '')
  const base = String(root).replace(/\\/g, '/').replace(/\/+$/, '')
  if (posix.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return posix.slice(base.length + 1)
  return posix.replace(/^\/+/, '')
}

/**
 * 相对路径是否命中任一模式。
 * 不含 `/` 的模式额外对文件名匹配 —— 用户写 `*.md` 时通常想匹配所有层级。
 */
export function matchesAny(patterns, relativePath) {
  const target = String(relativePath).replace(/\\/g, '/')
  const name = target.split('/').pop() ?? target
  for (const pattern of patterns) {
    const normalized = String(pattern).replace(/\\/g, '/').trim()
    if (normalized.length === 0) continue
    if (globToRegExp(normalized).test(target)) return true
    if (!normalized.includes('/') && globToRegExp(normalized).test(name)) return true
  }
  return false
}

/** 规则是否无条件加载（没有 paths / 空列表 / frontmatter 解析失败）。 */
export function isUnconditional(rule) {
  return !rule || !Array.isArray(rule.paths) || rule.paths.length === 0
}

/**
 * 决定这一步要注入哪些规则。
 * @param rules      cc/rules.js discoverRules 的结果
 * @param touched    本会话已触碰的绝对文件路径
 * @param root       项目根（用于折相对路径）
 * @param injected   已经注入过的规则 id 集合（会话级）
 * @param budgetBytes 单次注入的字节上限
 */
export function planRuleInjection({ rules = [], touched = [], root, injected = new Set(), budgetBytes = 8192 } = {}) {
  const candidates = []
  for (const rule of rules) {
    if (injected.has(rule.id)) continue
    if (!isUnconditional(rule)) {
      const hit = touched.some((filePath) => matchesAny(rule.paths, toRelativePath(root, filePath)))
      if (!hit) continue
    }
    candidates.push(rule)
  }

  // 无条件规则先（对标 CC：它们与 CLAUDE.md 同优先级），其余按 id 稳定排序
  candidates.sort((a, b) => {
    const byKind = (isUnconditional(a) ? 0 : 1) - (isUnconditional(b) ? 0 : 1)
    return byKind !== 0 ? byKind : a.id.localeCompare(b.id)
  })

  const inject = []
  const skipped = []
  let used = 0
  for (const rule of candidates) {
    const bytes = Buffer.byteLength(rule.text, 'utf8')
    if (used + bytes > budgetBytes) {
      skipped.push(rule)
      continue
    }
    used += bytes
    inject.push(rule)
  }
  return { inject, skipped, bytes: used }
}
