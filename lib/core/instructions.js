/**
 * 提示词文件的「谁读、什么顺序、超预算丢谁」模型 —— 纯函数，不碰 fs。
 *
 * 事实来源（对着源码/文档核过，别凭印象改）：
 *
 * 1. DSH — `@deepseek-ai/dsh-agent-instructions` 0.2.0-rc.2
 *    `lib/index.js` 的 `discoverInstructionFiles()`：
 *      - 第一条是 `$DSH_HOME/AGENTS.md`（用户级**只有 AGENTS.md**，不认 CLAUDE.md）
 *      - 然后 `ancestorChain(projectRoot, cwd)` 从项目根往 cwd 逐目录，
 *        每层先 `[AGENTS.md, CLAUDE.md]`，再 `[AGENTS.local.md, CLAUDE.local.md]`
 *      - 同目录里 trim 后内容完全相同的只渲染一次
 *      - 预算 65536 B：先整篇丢掉更宽泛的，最后才截断最具体的那份
 *      - 项目根 = 向上第一个含 `.git` 的目录；再深一层的文件要等 read/write/edit 摸到才进来
 *
 * 2. Claude Code — code.claude.com/docs/en/memory（v2.1.277+）
 *      managed policy → `~/.claude/CLAUDE.md` → cwd 及以上每层 `CLAUDE.md` → `CLAUDE.local.md`
 *      只要 cwd 或任一上层有 `CLAUDE.md` / `.claude/CLAUDE.md` / `CLAUDE.local.md`，
 *      默认（Project instructions = `claude-md-or-agents-md`）就**完全不读 `AGENTS.md`**；
 *      `~/.claude/CLAUDE.md` 与 `.claude/rules/` 不算数、照读。
 *      `AGENTS.local.md` CC 不认。
 *
 * 两边都是**拼接**，不是覆盖 —— 顺序就是优先级，没有"后者顶掉前者"。
 */

import { dirname, join, relative, resolve } from 'node:path'

export const DSH_DEFAULT_MAX_BYTES = 65536

/** DSH 每层的候选（顺序即注入顺序）。 */
export const DSH_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']
export const DSH_LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md']

/** 有其中任意一个，CC 默认就不再读 AGENTS.md。 */
export const CC_CLAUDE_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', join('.claude', 'CLAUDE.md')]
/** CC 也认这个位置的 AGENTS.md。 */
export const CC_AGENTS_NAME = join('.claude', 'AGENTS.md')

export const CC_USER_FILE = join('.claude', 'CLAUDE.md')
export const DSH_USER_FILE = 'AGENTS.md'

/** 组织级 managed policy：每个平台路径不同，只有 CC 读。 */
export function managedPolicyPath(platform = process.platform) {
  if (platform === 'win32') return join('C:\\Program Files\\ClaudeCode', 'CLAUDE.md')
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/CLAUDE.md'
  return '/etc/claude-code/CLAUDE.md'
}

/** 从 root 到 cwd（含两端）的目录链；root 不在 cwd 的祖先上就只给 cwd。 */
export function ancestorChain(root, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return []
  const target = resolve(root ?? cwd)
  const chain = []
  let current = resolve(cwd)
  for (;;) {
    chain.push(current)
    if (current === target) return chain.reverse()
    const parent = dirname(current)
    if (parent === current) return [resolve(cwd)]
    current = parent
  }
}

function posixRel(base, path) {
  return relative(base, path).replace(/\\/g, '/') || '.'
}

/**
 * 这个目录里 CC 会不会读 AGENTS.md（默认模式下：没有 CLAUDE.md 家族才读）。
 * 判定范围是 cwd 及其所有上层，不是单目录。
 */
export function ccReadsAgents(dirs, exists) {
  return !dirs.some((dir) => CC_CLAUDE_NAMES.some((name) => exists(join(dir, name))))
}

/**
 * 按注入顺序铺开候选清单。`items` 只含**存在**的文件；
 * 另外给出项目根 / cwd 上「还没有」的 AGENTS.md、CLAUDE.md（面板里可以新建）。
 *
 * @returns {{ items: Array, missing: Array, ccHasClaude: boolean }}
 *   item: { path, label, scope, order, readers, note, editable }
 */
export function instructionPlan({ root, cwd, home, dshHome, exists = () => false, platform = process.platform }) {
  const dirs = ancestorChain(root ?? cwd, cwd)
  const ccHasClaude = !ccReadsAgents(dirs, exists)
  const items = []

  const add = (path, label, scope, readers, note) => {
    if (readers.length === 0) return
    if (!exists(path)) return
    items.push({
      path,
      label,
      scope,
      order: items.length,
      readers,
      note: note ?? null,
      editable: scope === 'project',
    })
  }

  // CC 的组织级策略：本机一般不存在，存在就说明是 IT 管的，只读
  add(managedPolicyPath(platform), 'managed policy', 'managed', ['cc'], '组织级策略')

  add(join(home, CC_USER_FILE), `~/${CC_USER_FILE.replace(/\\/g, '/')}`, 'user', ['cc'], '用户级：CC 每个项目都读')

  add(join(dshHome, DSH_USER_FILE), '~/.dsh/AGENTS.md', 'user', ['dsh'], '用户级：DSH 每条指令链的第一条')

  const agentsNote = ccHasClaude ? 'CC 默认跳过：上层已有 CLAUDE.md 家族' : null

  for (const dir of dirs) {
    const inRoot = dir === root
    const relOf = (name) => (inRoot ? name.replace(/\\/g, '/') : posixRel(root, join(dir, name)))
    // CC 把它当项目指令，DSH 不认
    add(join(dir, '.claude', 'CLAUDE.md'), relOf(join('.claude', 'CLAUDE.md')), 'project', ['cc'], null)
    add(join(dir, 'AGENTS.md'), relOf('AGENTS.md'), 'project', ccHasClaude ? ['dsh'] : ['dsh', 'cc'], agentsNote)
    add(join(dir, 'CLAUDE.md'), relOf('CLAUDE.md'), 'project', ['cc', 'dsh'], null)
    add(join(dir, 'AGENTS.local.md'), relOf('AGENTS.local.md'), 'project', ['dsh'], '本地 overlay：DSH 会读，CC 不认')
    add(join(dir, 'CLAUDE.local.md'), relOf('CLAUDE.local.md'), 'project', ['cc', 'dsh'], '本地 overlay：同目录内排最后')
    add(join(dir, '.claude', 'AGENTS.md'), relOf(join('.claude', 'AGENTS.md')), 'project', ccHasClaude ? [] : ['cc'], null)
  }

  // 缺失的候选：只给项目根与 cwd 两个位置，免得祖先链上一堆空位迷惑人
  const missing = []
  const seedDirs = [...new Set([root, cwd].filter(Boolean))]
  for (const dir of seedDirs) {
    const inRoot = dir === root
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const path = join(dir, name)
      if (exists(path)) continue
      missing.push({
        path,
        label: inRoot ? name : posixRel(root, path),
        scope: 'project',
        order: null,
        readers: name === 'AGENTS.md'
          ? (ccHasClaude ? ['dsh'] : ['dsh', 'cc'])
          : ['cc', 'dsh'],
        note: '还没创建',
        editable: true,
        missing: true,
      })
    }
  }

  return { items, missing, ccHasClaude }
}

/**
 * 重演 DSH 的预算裁决：先整篇丢最宽泛的，若最具体的那份自己就超了才截断。
 * 只算 DSH 会读的那些（CC 没有硬预算）。
 */
export function planBudget(items, maxBytes = DSH_DEFAULT_MAX_BYTES) {
  const dsh = items.filter((item) => item.readers.includes('dsh') && Number.isFinite(item.size))
  const bytes = dsh.reduce((sum, item) => sum + item.size, 0)
  if (bytes <= maxBytes) return { bytes, maxBytes, over: false, dropped: [], truncated: null }

  // 从最具体的一端往回装
  let kept = 0
  let sum = 0
  for (let index = dsh.length - 1; index >= 0; index -= 1) {
    if (sum + dsh[index].size > maxBytes) break
    sum += dsh[index].size
    kept += 1
  }
  // 一份都装不下时：最后那份算「截断」，其余算「整篇丢掉」—— 别两边都报
  const boundary = kept === 0 ? dsh.length - 1 : dsh.length - kept
  const dropped = dsh.slice(0, boundary).map((item) => item.label)
  const truncated = kept === 0 ? dsh[dsh.length - 1].label : null
  return { bytes, maxBytes, over: true, dropped, truncated }
}
