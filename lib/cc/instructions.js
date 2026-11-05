/**
 * 提示词文件的落地版：把 core/instructions.js 的顺序模型接到真文件上。
 *
 * 只做「找 + 量」，不做决策 —— 谁读、什么顺序、超预算丢谁全在 core 里。
 * 写入由 host 层按 allowlist 判定（项目内、且在这份清单里）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ccHome, dshHomePath } from '../paths.js'
import {
  DSH_DEFAULT_MAX_BYTES,
  DSH_CANDIDATES,
  DSH_LOCAL_CANDIDATES,
  CC_CLAUDE_NAMES,
  instructionPlan,
  planBudget,
  ccReadsAgents,
} from '../core/instructions.js'

/** 明显不是项目内容的目录，扫了只会浪费时间。 */
const NOISE = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next',
  'target', 'vendor', '.venv', 'venv', 'tmp', 'temp', '.cache', '.turbo',
])

const MAX_SUBDIRS = 200

/** 项目根 = cwd 向上第一个含 `.git` 的目录（与 DSH 的 projectRootMarkers 默认一致）。 */
export function findProjectRoot(cwd, exists = existsSync) {
  let current = cwd
  for (;;) {
    if (exists(join(current, '.git'))) return current
    const parent = current.replace(/[\\/][^\\/]+$/, '')
    if (!parent || parent === current) return cwd
    current = parent
  }
}

function statOf(path) {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

/** 按同一套候选看一层子目录（按需加载的那批）。 */
function onDemandIn(dir, root, items) {
  const names = [...DSH_CANDIDATES, ...DSH_LOCAL_CANDIDATES, join('.claude', 'CLAUDE.md'), join('.claude', 'AGENTS.md')]
  const exists = (path) => Boolean(statOf(path))
  const localHasClaude = !ccReadsAgents([dir], exists)
  for (const name of names) {
    const path = join(dir, name)
    const stat = statOf(path)
    if (!stat) continue
    const base = name.replace(/^\.claude[\\/]/, '')
    const isClaude = CC_CLAUDE_NAMES.includes(name) || name === join('.claude', 'CLAUDE.md')
    const readers = []
    if (DSH_CANDIDATES.includes(base) || DSH_LOCAL_CANDIDATES.includes(base)) readers.push('dsh')
    if (isClaude) readers.push('cc')
    else if (base === 'AGENTS.md' && !localHasClaude) readers.push('cc')
    items.push({
      path,
      label: `${path.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')}`,
      scope: 'subdir',
      onDemand: true,
      readers,
      note: '按需：等有 read/write/edit 摸到这个目录才进上下文',
      editable: true,
      size: stat.size,
      mtime: stat.mtimeMs,
    })
  }
}

/**
 * @param cwd  会话 / 工作区目录
 * @param home 覆盖家目录（测试用）
 */
export function scanInstructions({ cwd, home, maxBytes = DSH_DEFAULT_MAX_BYTES } = {}) {
  const scoped = typeof cwd === 'string' && cwd.length > 0
  const root = scoped ? findProjectRoot(cwd) : null
  const plan = instructionPlan({
    root,
    cwd: scoped ? cwd : null,
    home: ccHome(home),
    dshHome: dshHomePath(home),
    exists: existsSync,
  })

  const items = []
  for (const item of plan.items) {
    const stat = statOf(item.path)
    if (!stat) continue
    items.push({ ...item, size: stat.size, mtime: stat.mtimeMs })
  }

  // 子目录：CC 与 DSH 都是「摸到才算」，所以单独一组，不参与基线预算
  const onDemand = []
  let budget = MAX_SUBDIRS
  let entries = []
  try {
    entries = scoped ? readdirSync(cwd, { withFileTypes: true }) : []
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (budget <= 0) break
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || NOISE.has(entry.name)) continue
    budget -= 1
    onDemandIn(join(cwd, entry.name), root, onDemand)
  }

  return {
    root,
    cwd: scoped ? cwd : null,
    ccHasClaude: plan.ccHasClaude,
    items,
    missing: plan.missing,
    onDemand,
    budget: planBudget(items, maxBytes),
  }
}
