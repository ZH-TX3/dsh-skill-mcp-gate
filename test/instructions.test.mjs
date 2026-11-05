#!/usr/bin/env node
/**
 * 提示词文件（CLAUDE.md / AGENTS.md 一族）：顺序模型 + 预算重演 + 读取/保存的边界。
 *
 * 模型的事实来源：
 *   DSH  @deepseek-ai/dsh-agent-instructions 0.2.0-rc.2（lib/index.js discoverInstructionFiles）
 *   CC   code.claude.com/docs/en/memory（v2.1.277+，Project instructions 默认 claude-md-or-agents-md）
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DSH_DEFAULT_MAX_BYTES,
  ancestorChain,
  instructionPlan,
  planBudget,
} from '../lib/core/instructions.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

// ── 纯模型：假的 exists，只看规则 ────────────────────────
console.log('顺序模型（纯函数）')

const ROOT = '/proj'
const CWD = '/proj/pkg'
const HOME = '/home/u'
const DSH = '/home/u/.dsh'

function planOf(files, extra = {}) {
  const set = new Set(files.map((file) => resolve(file).toLowerCase()))
  return instructionPlan({
    root: ROOT,
    cwd: CWD,
    home: HOME,
    dshHome: DSH,
    platform: 'linux',
    exists: (path) => set.has(resolve(path).toLowerCase()),
    ...extra,
  })
}

{
  const plan = planOf(['/home/u/.claude/CLAUDE.md', '/home/u/.dsh/AGENTS.md', '/proj/CLAUDE.md'])
  check('用户级两条在最前：CC 的 ~/.claude，然后 DSH 的 $DSH_HOME', plan.items.map((i) => i.label),
    ['~/.claude/CLAUDE.md', '~/.dsh/AGENTS.md', 'CLAUDE.md'])
  check('managed policy 不存在就不出现', plan.items.some((i) => i.scope === 'managed'), false)
}

{
  const plan = planOf(['/proj/AGENTS.md'])
  check('只有 AGENTS.md 时 CC 也会读它', plan.items.find((i) => i.label === 'AGENTS.md').readers, ['dsh', 'cc'])
  check('CC 的判定标记', plan.ccHasClaude, false)
  check('AGENTS.md 顺序在 CLAUDE.md 之前（DSH 的口径）', plan.items.map((i) => i.label), ['AGENTS.md'])
}

{
  const plan = planOf(['/proj/AGENTS.md', '/proj/CLAUDE.md', '/proj/AGENTS.local.md', '/proj/CLAUDE.local.md'])
  check('顶层 CLAUDE.md 让 CC 跳过 AGENTS.md', plan.items.find((i) => i.label === 'AGENTS.md').readers, ['dsh'])
  check('跳过原因写在 note 里', String(plan.items.find((i) => i.label === 'AGENTS.md').note).includes('CC 默认跳过'), true)
  check('CLAUDE.md 两边都读', plan.items.find((i) => i.label === 'CLAUDE.md').readers, ['cc', 'dsh'])
  check('AGENTS.local.md 只有 DSH 认', plan.items.find((i) => i.label === 'AGENTS.local.md').readers, ['dsh'])
  check('CLAUDE.local.md 两边都读', plan.items.find((i) => i.label === 'CLAUDE.local.md').readers, ['cc', 'dsh'])
  check('目录内顺序 AGENTS → CLAUDE → 两个 local', plan.items.map((i) => i.label), ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'])
}

{
  const plan = planOf(['/proj/.claude/CLAUDE.md', '/proj/.claude/AGENTS.md', '/proj/pkg/CLAUDE.md'])
  check('.claude/CLAUDE.md 只有 CC 读', plan.items.find((i) => i.label === '.claude/CLAUDE.md').readers, ['cc'])
  check('.claude/CLAUDE.md 也算「有 CLAUDE.md 家族」', plan.ccHasClaude, true)
  check('有人读时 .claude/AGENTS.md 被两边忽略', plan.items.some((i) => i.label === '.claude/AGENTS.md'), false)
}

{
  const plan = planOf(['/proj/AGENTS.md', '/proj/pkg/AGENTS.md', '/proj/pkg/CLAUDE.md'])
  check('从项目根往 cwd 排：根在前', plan.items.map((i) => i.label), ['AGENTS.md', 'pkg/AGENTS.md', 'pkg/CLAUDE.md'])
  check('子目录的 CLAUDE.md 会顶掉子目录的 AGENTS.md', plan.items.find((i) => i.label === 'pkg/AGENTS.md').readers, ['dsh'])
}

{
  const norm = (path) => path.replace(/[\/]/g, '/')
  const chain = ancestorChain('/proj', '/proj/a/b').map(norm)
  check('目录链含两端、根在前', chain, [resolve('/proj'), resolve('/proj/a'), resolve('/proj/a/b')].map(norm))
  const outside = ancestorChain('/other', '/proj/a').map(norm)
  check('root 不是祖先时只给 cwd', outside, [resolve('/proj/a')].map(norm))
}

{
  const plan = planOf(['/proj/CLAUDE.md'])
  check('缺的文件被列成 missing（项目根 + cwd 各两个位置）', plan.missing.map((item) => item.label), ['AGENTS.md', 'pkg/AGENTS.md', 'pkg/CLAUDE.md'])
  check('缺失项也是可创建的', plan.missing[0].editable, true)
  check('已有 CLAUDE.md 时，缺失的 AGENTS.md 标注只有 DSH 读', plan.missing[0].readers, ['dsh'])
}
{
  const plan = planOf([])
  check('空项目给出两个根候选', plan.missing.map((item) => item.label), ['AGENTS.md', 'CLAUDE.md', 'pkg/AGENTS.md', 'pkg/CLAUDE.md'])
  check('没有 CLAUDE.md 家族时 AGENTS.md 两边都读', plan.missing[0].readers, ['dsh', 'cc'])
}

console.log('预算重演（DSH 65536 B）')
{
  const budget = planBudget([{ label: 'a', size: 1000, readers: ['dsh'] }, { label: 'b', size: 2000, readers: ['dsh'] }], DSH_DEFAULT_MAX_BYTES)
  check('没超就不丢', [budget.over, budget.bytes, budget.dropped], [false, 3000, []])
}
{
  const items = [
    { label: 'broad', size: 60000, readers: ['dsh'] },
    { label: 'mid', size: 10000, readers: ['dsh'] },
    { label: 'specific', size: 10000, readers: ['dsh'] },
  ]
  const budget = planBudget(items, DSH_DEFAULT_MAX_BYTES)
  check('超预算了', budget.over, true)
  check('先整篇丢掉最宽泛的那份', budget.dropped, ['broad'])
  check('最具体的没被截', budget.truncated, null)
}
{
  const items = [
    { label: 'broad', size: 60000, readers: ['dsh'] },
    { label: 'specific', size: 70000, readers: ['dsh'] },
  ]
  const budget = planBudget(items, DSH_DEFAULT_MAX_BYTES)
  check('只剩最具体那份也装不下 → 截它', budget.truncated, 'specific')
  check('宽泛的仍被整篇丢掉', budget.dropped, ['broad'])
}
{
  const budget = planBudget([{ label: 'cc-only', size: 999999, readers: ['cc'] }], DSH_DEFAULT_MAX_BYTES)
  check('CC 没有预算，不参与', [budget.bytes, budget.over], [0, false])
}

// ── 真文件：扫描 + 面板读写 ──────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'gate-prompt-home-'))
const ws = mkdtempSync(join(tmpdir(), 'gate-prompt-ws-'))
process.env.DSH_HOME = home

mkdirSync(join(home, '.claude'), { recursive: true })
writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# 用户级 CC 规则', 'utf8')
writeFileSync(join(home, 'AGENTS.md'), '# 用户级 DSH 规则', 'utf8')

mkdirSync(join(ws, '.git'), { recursive: true })
writeFileSync(join(ws, 'CLAUDE.md'), '# 项目根 CLAUDE', 'utf8')
writeFileSync(join(ws, 'AGENTS.md'), '# 项目根 AGENTS', 'utf8')
mkdirSync(join(ws, 'pkg'), { recursive: true })
writeFileSync(join(ws, 'pkg', 'CLAUDE.md'), '# 子目录 CLAUDE', 'utf8')
writeFileSync(join(ws, 'AGENTS.local.md'), '# 本地 overlay', 'utf8')

const { apply } = await import('../index.js')

const routes = []
const ctx = {
  get: () => undefined,
  skills: { list: async () => [], registerProvider: () => () => {}, get: async () => undefined },
  commands: { register: () => () => {} },
  tools: { schemas: () => [], guard: () => () => {}, register: () => () => {}, execute: async () => ({ isError: false, content: [] }) },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  agents: { list: () => [] },
  workspaceRegistry: { list: () => [{ path: ws, title: 'demo' }] },
  on: () => () => {},
  effect: (factory) => factory(),
}

apply(ctx, { projectDir: ws, ccHome: home })
await new Promise((r) => setTimeout(r, 80))

const tokenRoute = routes.find((r) => r.path.endsWith('/token'))
let token = null
tokenRoute.handler({}, { statusCode: 200, setHeader() {}, end(body) { token = JSON.parse(body).token } })

const callJson = (suffix, payload) => new Promise((resolve, reject) => {
  const route = routes.find((r) => r.path.endsWith(suffix))
  if (!route) return reject(new Error(`没有路由 ${suffix}`))
  const timer = setTimeout(() => reject(new Error(`${suffix} 没写响应`)), 5000)
  const handlers = {}
  const req = { method: 'POST', headers: { 'x-gate-token': token }, url: '/', on(event, fn) { handlers[event] = fn } }
  const res = { statusCode: 200, setHeader() {}, end(chunk) { clearTimeout(timer); resolve({ status: this.statusCode, body: JSON.parse(chunk) }) } }
  route.handler(req, res)
  handlers.data?.(JSON.stringify(payload ?? {}))
  handlers.end?.()
})
const getState = (target) => new Promise((resolve, reject) => {
  const route = routes.find((r) => r.path.endsWith('/state'))
  const timer = setTimeout(() => reject(new Error('state 没写响应')), 5000)
  const res = { statusCode: 200, setHeader() {}, end(chunk) { clearTimeout(timer); resolve(JSON.parse(chunk)) } }
  route.handler({ method: 'GET', headers: {}, url: `/api/skill-mcp-gate/state?ws=${encodeURIComponent(target)}` }, res)
})

console.log('扫描真文件')
{
  const state = await getState(ws)
  const instructions = state.instructions
  check('认出项目根', instructions.root.replace(/\\/g, '/'), ws.replace(/\\/g, '/'))
  check('CC 因为项目根有 CLAUDE.md 而跳过 AGENTS.md', instructions.ccHasClaude, true)
  const labels = instructions.items.map((item) => `${item.label}:${item.readers.join('+')}`)
  check('顺序 = 用户级 → 项目根 → 本地 overlay', labels, [
    '~/.claude/CLAUDE.md:cc',
    '~/.dsh/AGENTS.md:dsh',
    'AGENTS.md:dsh',
    'CLAUDE.md:cc+dsh',
    'AGENTS.local.md:dsh',
  ])
  check('子目录文件按需、不进基线', instructions.onDemand.map((item) => item.label), ['pkg/CLAUDE.md'])
  const bytesOf = (text) => Buffer.byteLength(text, 'utf8')
  check('基线预算只算 DSH 读的那几份（CC 独有与用户级不重复计）', instructions.budget.bytes,
    bytesOf('# 用户级 DSH 规则') + bytesOf('# 项目根 AGENTS') + bytesOf('# 项目根 CLAUDE') + bytesOf('# 本地 overlay'))
  check('用户级不可编辑', instructions.items.find((item) => item.scope === 'user').editable, false)
  check('项目内可编辑', instructions.items.find((item) => item.label === 'CLAUDE.md').editable, true)
}

console.log('读取')
{
  const read = await callJson('/memory/read', { file: join(ws, 'CLAUDE.md') })
  check('读到正文', read.body.memory.content, '# 项目根 CLAUDE')
  const user = await callJson('/memory/read', { file: join(home, 'AGENTS.md') })
  check('用户级也能读', user.body.memory.content, '# 用户级 DSH 规则')
  const outside = await callJson('/memory/read', { file: join(ws, 'package.json') })
  check('清单外的路径拒绝读', outside.status, 400)
}

console.log('保存')
{
  const text = '# 新的项目约定' + String.fromCharCode(10) + '- 用中文' + String.fromCharCode(10)
  const saved = await callJson('/memory/save', { file: join(ws, 'CLAUDE.md'), text })
  check('保存成功', saved.body.ok, true)
  check('内容原样落盘（不补换行、不丢换行）', readFileSync(join(ws, 'CLAUDE.md'), 'utf8'), text)
  check('返回字节数', saved.body.bytes, Buffer.byteLength(text, 'utf8'))
  const row = saved.body.state.instructions.items.find((item) => item.label === 'CLAUDE.md')
  check('快照里大小跟着变', row.size, Buffer.byteLength(text, 'utf8'))

  const user = await callJson('/memory/save', { file: join(home, 'AGENTS.md'), text })
  check('用户级拒绝写', user.status, 400)
  check('说清是只读', String(user.body.error).includes('只读'), true)
  check('用户级内容没被改', readFileSync(join(home, 'AGENTS.md'), 'utf8'), '# 用户级 DSH 规则')

  const arbitrary = await callJson('/memory/save', { file: join(ws, 'pkg', 'index.js'), text })
  check('清单外拒绝写（面板不是任意文件写入器）', arbitrary.status, 400)
  check('文件没被创建', existsSync(join(ws, 'pkg', 'index.js')), false)
}

console.log('新建缺失的候选')
{
  const bare = mkdtempSync(join(tmpdir(), 'gate-prompt-bare-'))
  mkdirSync(join(bare, '.git'), { recursive: true })
  const picked = await getState(bare)
  check('空项目把自己列成 missing', picked.instructions.missing.map((item) => item.label), ['AGENTS.md', 'CLAUDE.md'])
  check('同时没有任何基线项目文件', picked.instructions.items.filter((item) => item.scope === 'project'), [])

  const created = await callJson('/memory/save', { file: join(bare, 'AGENTS.md'), text: '# 新建' })
  check('新建成功', created.body.ok, true)
  check('文件真的出现', existsSync(join(bare, 'AGENTS.md')), true)
  check('内容原样', readFileSync(join(bare, 'AGENTS.md'), 'utf8'), '# 新建')
  const after = created.body.state.instructions
  check('新建后从 missing 消失', after.missing.map((item) => item.label), ['CLAUDE.md'])
  check('新建后进基线（两边都读）', after.items.find((item) => item.label === 'AGENTS.md').readers, ['dsh', 'cc'])
  rmSync(bare, { recursive: true, force: true })
}

rmSync(home, { recursive: true, force: true })
rmSync(ws, { recursive: true, force: true })
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
