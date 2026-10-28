#!/usr/bin/env node
/**
 * 作用域列表测试：
 *   - 选「全局」→ 只列全局层
 *   - 选某个工作区 → 列该 cwd 的项目级 skill + 该工作区活跃会话的 scope
 *   - 不会把别的工作区的 skill 混进来
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'gate-scope-home-'))
const wsA = mkdtempSync(join(tmpdir(), 'gate-ws-a-'))
const wsB = mkdtempSync(join(tmpdir(), 'gate-ws-b-'))
process.env.DSH_HOME = home

mkdirSync(join(wsA, '.dsh'), { recursive: true })
writeFileSync(join(wsA, '.dsh', 'skill-mcp-gate.json'), JSON.stringify({ skills: { caveman: 'off' } }), 'utf8')

// Claude Code 的项目本地设置：skillOverrides 与 CC 语义一致，应当也能生效
mkdirSync(join(wsA, '.claude'), { recursive: true })
writeFileSync(join(wsA, '.claude', 'settings.local.json'),
  JSON.stringify({ skillOverrides: { 'cc-skill': 'user-invocable-only' } }), 'utf8')

const { apply } = await import('../index.js')

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

const agentA = { id: 'a', session: { header: { cwd: wsA } } }
const agentB = { id: 'b', session: { header: { cwd: wsB } } }
const skill = (name, source) => ({
  name, source, description: 'd',
  invocation: { modelInvocable: true, userInvocable: true },
})

const GLOBAL = [skill('bundled-skill', 'bundled')]
const A_SCOPE = [skill('bundled-skill', 'bundled'), skill('caveman', 'user-agents'), skill('cc-skill', 'user-agents')]
const B_SCOPE = [skill('bundled-skill', 'bundled'), skill('save-state', 'user-agents')]
const A_PROJECT = [skill('bundled-skill', 'bundled'), skill('caveman', 'user-agents'), skill('cc-skill', 'user-agents'), skill('ws-a-only', 'project-dsh')]
const B_PROJECT = [skill('bundled-skill', 'bundled'), skill('save-state', 'user-agents'), skill('ws-b-only', 'project-dsh')]

const routes = []

const ctx = {
  skills: {
    list: async (options) => {
      const scopeId = options && options.scope ? options.scope.id : undefined
      const cwd = options ? options.cwd : undefined
      if (scopeId === 'a') return A_SCOPE
      if (scopeId === 'b') return B_SCOPE
      if (cwd === wsA) return A_PROJECT
      if (cwd === wsB) return B_PROJECT
      return GLOBAL
    },
    get: async () => undefined,
    register: () => () => {},
  },
  tools: { schemas: () => [], guard: () => () => {} },
  agents: { list: () => [agentA, agentB] },
  workspaceRegistry: {
    list: () => [
      { id: 'w1', path: wsA, title: 'ws-a' },
      { id: 'w2', path: wsB, title: 'ws-b' },
    ],
  },
  commands: { register: () => () => {} },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  on: () => () => {},
  effect: (factory) => factory(),
}

apply(ctx, {})
await new Promise((r) => setTimeout(r, 80))

const stateRoute = routes.find((r) => r.path.endsWith('/state'))
const call = (ws) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, end(chunk) { resolve(JSON.parse(chunk)) } }
  const url = ws ? `/state?ws=${encodeURIComponent(ws)}` : '/state'
  stateRoute.handler({ method: 'GET', headers: {}, url }, res)
})

console.log('工作区列表来自 workspaceRegistry')
const initial = await call()
check('全局 + 两个工作区', initial.workspaces.map((w) => (w.key === 'global' ? 'global' : w.label)), ['global', 'ws-a', 'ws-b'])
check('每项带优先级提示', initial.workspaces.map((w) => w.hint), ['基础层', '覆盖全局', '覆盖全局'])

console.log('全局作用域')
const globalScope = await call('global')
check('只列全局层', globalScope.skills.map((s) => s.name), ['bundled-skill'])

console.log('工作区 A')
const scopeA = await call(wsA)
check('含该工作区的项目级 skill', scopeA.skills.some((s) => s.name === 'ws-a-only'), true)
check('不混入工作区 B 的 skill', scopeA.skills.some((s) => s.name === 'ws-b-only'), false)
check('项目配置生效', scopeA.skills.find((s) => s.name === 'caveman').state, 'off')
check('decidedBy 指向项目层', scopeA.skills.find((s) => s.name === 'caveman').decidedBy, '项目')

console.log('Claude Code settings.local.json 兼容')
check('CC 里写的 skillOverrides 生效', scopeA.skills.find((s) => s.name === 'cc-skill').state, 'user-invocable-only')
check('decidedBy 指向 CC 项目本地层', scopeA.skills.find((s) => s.name === 'cc-skill').decidedBy, 'CC 项目本地')
check('本插件项目配置仍然优先', scopeA.skills.find((s) => s.name === 'caveman').decidedBy, '项目')
check('配置文件列表含 CC 文件', scopeA.files.some((f) => f.file.includes('settings.local.json')), true)

console.log('工作区 B')
const scopeB = await call(wsB)
check('含工作区 B 的项目级 skill', scopeB.skills.some((s) => s.name === 'ws-b-only'), true)
check('不含工作区 A 的 skill', scopeB.skills.some((s) => s.name === 'caveman'), false)

rmSync(home, { recursive: true, force: true })
rmSync(wsA, { recursive: true, force: true })
rmSync(wsB, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
