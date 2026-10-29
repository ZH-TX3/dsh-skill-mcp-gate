/**
 * CC 的 skill 侧知识：frontmatter 字段表、目录扫描、`skillOverrides` 解析。
 *
 * 新增一个 CC 字段的适配成本 = 在 SKILL_FRONTMATTER 里加一行：
 *   - 能映射到 DSH 的字段：给 target（+ invert / fallback）
 *   - CC 会据此改变行为、但 DSH 没有对应机制的：给 gap（会自动进面板与 /gate doctor）
 * 字段表之外的一切都不认识，也就不可能悄悄假装生效。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SKILL_STATES } from '../core/policy.js'

/** CC skill frontmatter 字段表。 */
export const SKILL_FRONTMATTER = {
  name: { kind: 'string' },
  description: { kind: 'string' },
  when_to_use: { kind: 'string', target: 'whenToUse', alias: 'whenToUse' },
  'argument-hint': { kind: 'string', gap: 'DSH 的 skill 调用没有参数补全（argument-hint）' },
  arguments: { kind: 'list', gap: 'DSH 不做 $name 位置参数替换' },
  'disable-model-invocation': { kind: 'bool', target: 'modelInvocable', invert: true, fallback: true },
  'user-invocable': { kind: 'bool', target: 'userInvocable', fallback: true },
  'allowed-tools': { kind: 'list', gap: '技能级工具预授权在 DSH 里没有对应机制' },
  'disallowed-tools': { kind: 'list', gap: '技能级工具屏蔽尚未接入（计划中）' },
  model: { kind: 'string', gap: '技能级模型切换未接入' },
  effort: { kind: 'string', gap: '技能级 effort 未接入' },
  context: { kind: 'string', gap: 'context: fork 需要子代理执行，DSH 的 skill 不走这条路径' },
  agent: { kind: 'string', gap: 'agent 只在 context: fork 下有意义，未接入' },
  background: { kind: 'bool', gap: 'background 只在 context: fork 下有意义，未接入' },
  hooks: { kind: 'object', gap: 'skill 自带 hooks 未接入' },
  paths: { kind: 'list', gap: '路径门控（paths）未接入' },
  shell: { kind: 'string', gap: '内联 !`cmd` 执行未接入' },
  // CC 自己也不据 metadata / license / compatibility 改变行为，这里同样只读取不使用
  metadata: { kind: 'object' },
  license: { kind: 'string' },
  compatibility: { kind: 'string' },
}

/** 只取 frontmatter 里的标量与块标量，够用即可。 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return { data: {}, body: text }
  const data = {}
  const lines = match[1].split(/\r?\n/)
  let key = null
  let buffer = []
  const flush = () => {
    if (key === null) return
    const value = buffer.join(' ').replace(/\s+/g, ' ').trim()
    data[key] = value.replace(/^["']|["']$/g, '')
    buffer = []
  }
  for (const line of lines) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (kv) {
      flush()
      key = kv[1]
      const inline = kv[2].trim()
      // `>` / `|` 是 YAML 块标量标记，本身不是内容
      if (inline.length > 0 && inline !== '>' && inline !== '|') buffer.push(inline)
      continue
    }
    if (key !== null) buffer.push(line.trim())
  }
  flush()
  return { data, body: text.slice(match[0].length).replace(/^[\r\n]+/, '') }
}

function readBool(raw, fallback) {
  if (raw === undefined) return fallback
  const value = String(raw).trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(value)) return true
  if (['false', 'no', 'off', '0'].includes(value)) return false
  return fallback
}

/** 字段表 → 候选上的映射值与「用到了但落不了地」的缺口清单。 */
export function mapFrontmatter(data) {
  const mapped = {}
  const gaps = []
  for (const [field, spec] of Object.entries(SKILL_FRONTMATTER)) {
    const raw = data[field] ?? (spec.alias ? data[spec.alias] : undefined)
    if (raw === undefined || raw === '') continue
    if (spec.gap) { gaps.push({ field, reason: spec.gap }); continue }
    if (!spec.target) continue
    if (spec.kind === 'bool') {
      const value = readBool(raw, spec.fallback)
      mapped[spec.target] = spec.invert ? !value : value
    } else {
      mapped[spec.target] = String(raw)
    }
  }
  return { mapped, gaps }
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * 扫描一个 skill 根目录。
 * @param report 可选回调 (name, gaps) —— 收集「该 skill 用了 CC 的哪些落不了地的字段」
 */
export function scanSkillDir(dir, { rank, source, providerName = 'claude-skills', report } = {}) {
  if (!existsSync(dir)) return []
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    const full = join(dir, entry)
    let file = null
    let fallbackName = null
    try {
      const info = statSync(full)
      if (info.isDirectory()) {
        const candidate = join(full, 'SKILL.md')
        if (!existsSync(candidate)) continue
        file = candidate
        fallbackName = entry
      } else if (entry.toLowerCase().endsWith('.md')) {
        file = full
        fallbackName = entry.replace(/\.md$/i, '')
      } else {
        continue
      }
    } catch {
      continue
    }
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const { data } = parseFrontmatter(text)
    const { mapped, gaps } = mapFrontmatter(data)
    const declared = mapped.name ?? fallbackName
    if (!NAME_RE.test(declared)) continue
    if (gaps.length > 0) report?.(declared, gaps)
    out.push({
      name: declared,
      description: mapped.description ?? `来自 ${dir}`,
      whenToUse: mapped.whenToUse,
      source,
      provider: providerName,
      rank,
      path: file,
      invocation: {
        modelInvocable: mapped.modelInvocable ?? true,
        userInvocable: mapped.userInvocable ?? true,
      },
      locator: { file },
    })
  }
  return out
}

/**
 * 解析一份设置文件里的 skill 覆盖。
 * `skillOverrides`（CC 原文）与 `skills`（本插件）都接受，同名时 `skills` 优先。
 */
export function parseSkillOverrides(doc, meta) {
  const skills = new Map()
  const warnings = []
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { skills, warnings }
  }
  for (const key of ['skillOverrides', 'skills']) {
    const block = doc[key]
    if (block === undefined) continue
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      warnings.push(`${meta.file}: \`${key}\` 必须是对象`)
      continue
    }
    for (const [name, value] of Object.entries(block)) {
      const state = typeof value === 'string' ? value : value?.state
      if (typeof state !== 'string' || !SKILL_STATES.includes(state)) {
        warnings.push(`${meta.file}: \`${key}.${name}\` 状态无效，可用值 ${SKILL_STATES.join(' / ')}`)
        continue
      }
      if (value && typeof value === 'object') {
        for (const field of Object.keys(value)) {
          if (field === 'state') continue
          warnings.push(`${meta.file}: \`${key}.${name}.${field}\` 是未知字段，本次忽略`)
        }
      }
      skills.set(name, { state })
    }
  }
  return { skills, warnings }
}

/**
 * 不走 registry，直接按目录找某个技能并读正文。
 * 用途：面板「内容」按钮在没有活动会话时（registry 读不到 agent 层）也能显示真东西。
 * @param dirs [{ dir, rank, source }]，通常来自 paths.skillDirs()
 * @returns { name, content, file, source, provider } | undefined
 */
export function findSkillFile(dirs, name) {
  for (const entry of dirs) {
    const candidates = scanSkillDir(entry.dir, { rank: entry.rank, source: entry.source, providerName: 'file' })
    const hit = candidates.find((candidate) => candidate.name === name)
    if (!hit) continue
    let text
    try {
      text = readFileSync(hit.path, 'utf8')
    } catch {
      continue
    }
    const { body } = parseFrontmatter(text)
    return {
      name: hit.name,
      content: body,
      file: hit.path,
      source: hit.source,
      provider: 'file',
      resourceBase: { kind: 'directory', path: dirname(hit.path) },
    }
  }
  return undefined
}
