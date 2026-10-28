/**
 * Claude Code 的 rules 知识：`.claude/rules/**\/*.md` 的发现与 frontmatter 解析。
 *
 * CC 的语义（docs/en/memory.md "Organize rules with .claude/rules/"）：
 *   - 递归发现所有 `.md`
 *   - 带 `paths:` frontmatter 的规则，只在 Read/Write/Edit 命中匹配文件时才加载
 *   - 不带 `paths` 的规则在启动时加载，优先级同 `.claude/CLAUDE.md`
 *   - `paths` 接受 YAML 列表或逗号分隔字符串；展开后的模式总数上限 1000、总长上限 4 MiB
 *   - frontmatter 解析失败 → 当作没有 `paths`（即无条件加载）
 *   - `paths` 是唯一被读取的字段，其余字段忽略；frontmatter 在载入上下文前被剥掉
 *
 * 这一层只负责「文件在哪、写了什么」，判断谁命中、谁该注入在 core/rules.js。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** CC 自己的展开预算（模式数 / 总字节）。 */
export const EXPAND_BUDGET = { patterns: 1000, bytes: 4 * 1024 * 1024 }

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/

function unquote(value) {
  const text = value.trim()
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * 解析规则文件的 frontmatter，只取 `paths`。
 * @returns {{ paths: string[]|null, body: string }}
 *   `paths === null` 表示无条件加载（没有该字段 / 空列表 / frontmatter 解析失败）
 */
export function parseRule(text) {
  const match = FRONTMATTER_RE.exec(text)
  if (!match) return { paths: null, body: text }
  const body = text.slice(match[0].length)
  const lines = match[1].split(/\r?\n/)

  let index = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^paths\s*:/.test(lines[i])) { index = i; break }
  }
  if (index === -1) return { paths: null, body }

  const inline = unquote(lines[index].replace(/^paths\s*:/, ''))
  const items = []
  if (inline.length > 0) {
    items.push(...inline.split(',').map(unquote))
  } else {
    // YAML 列表：后续以 `- ` 开头的行，直到下一个顶层 key
    for (let i = index + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^[A-Za-z0-9_-]+\s*:/.test(line)) break
      const item = /^\s*-\s*(.+)$/.exec(line)
      if (item) items.push(unquote(item[1]))
      else if (line.trim().length > 0) break
    }
  }
  const paths = items.map((item) => item.trim()).filter(Boolean)
  return { paths: paths.length > 0 ? paths : null, body }
}

/** 递归列出目录下的 `.md`（不跟随目录符号链接，避免环）。 */
function walk(dir, out = []) {
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) walk(full, out)
    else if (/\.md$/i.test(entry) && info.isFile()) out.push(full)
  }
  return out
}

/**
 * 发现规则文件。
 * @param dirs [{ dir, scope }]，按优先级排列（user 在前，project 覆盖同名）
 * @param root 项目根（用于把绝对路径折成相对的规则 id）
 * @param maxFileBytes 单个文件上限，超过则忽略（CC 用 maxSourceBytes 同类保护）
 */
export function discoverRules({ dirs = [], root, maxFileBytes = 256 * 1024, warnings } = {}) {
  const rules = []
  const seen = new Set()
  for (const { dir, scope } of dirs) {
    for (const file of walk(dir)) {
      let text
      try {
        const info = statSync(file)
        if (info.size > maxFileBytes) {
          warnings?.push(`${file}: 超过 ${maxFileBytes} 字节，已忽略`)
          continue
        }
        text = readFileSync(file, 'utf8')
      } catch (error) {
        warnings?.push(`${file}: 读取失败 — ${error.message}`)
        continue
      }
      const { paths, body } = parseRule(text)
      const relative = root && file.startsWith(root) ? file.slice(root.length).replace(/^[\\/]+/, '') : file
      if (seen.has(relative)) continue
      seen.add(relative)
      rules.push({
        id: relative.replace(/\\/g, '/'),
        file,
        scope,
        name: basename(file).replace(/\.md$/i, ''),
        paths,
        text: body.trim(),
      })
    }
  }
  return rules
}

/**
 * 花括号展开（CC 的 `{ts,tsx}` 语法），受预算约束。
 * @returns {{ patterns: string[], truncated: boolean }}
 */
export function expandPatterns(patterns, budget = EXPAND_BUDGET) {
  const out = []
  let bytes = 0
  let truncated = false

  const expand = (pattern) => {
    const match = /\{([^{}]*)\}/.exec(pattern)
    if (!match) return [pattern]
    const head = pattern.slice(0, match.index)
    const tail = pattern.slice(match.index + match[0].length)
    const parts = match[1].split(',').map((part) => part.trim())
    return parts.flatMap((part) => expand(head + part + tail))
  }

  let braceCount = 0
  for (const pattern of patterns) {
    // 不含花括号的模式不计入模式预算（CC 明确这么算），但仍计入字节
    if (!pattern.includes('{')) {
      bytes += pattern.length
      if (bytes > budget.bytes) { truncated = true; break }
      out.push(pattern)
      continue
    }
    for (const item of expand(pattern)) {
      if (braceCount >= budget.patterns) { truncated = true; break }
      bytes += item.length
      if (bytes > budget.bytes) { truncated = true; break }
      braceCount += 1
      out.push(item)
    }
    if (truncated) break
  }
  return { patterns: out, truncated }
}
