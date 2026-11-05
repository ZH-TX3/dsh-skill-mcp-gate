#!/usr/bin/env node
/**
 * 声明来源 × 状态 × 操作的矩阵测试。
 *
 * 之前只按「项目作用域」测过 CRUD，全局作用域那条分支整条没跑过（v0.15.4 的删不掉就是这么漏的）。
 * 这个文件把「声明来源」拉成一条轴，逐个来源验证：列不列出来、归哪组、开关、改名、删除、探测。
 *
 * 来源：
 *   plugin-global  本插件全局配置里的定义
 *   plugin-project 本插件项目配置里的定义
 *   name-only      本插件配置里只有名字（没有连接定义）
 *   cc-user        ~/.claude.json 的 mcpServers
 *   cc-local       ~/.claude.json 的 projects[cwd].mcpServers
 *   mcp-json       项目里的 .mcp.json（只读）
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'gate-matrix-home-'))
const ws = mkdtempSync(join(tmpdir(), 'gate-matrix-ws-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

// ── 夹具 ──────────────────────────────────────────────
const globalFile = join(home, 'skill-mcp-gate', 'settings.json')
const projectFile = join(ws, '.dsh', 'skill-mcp-gate.json')
const claudeJson = join(home, '.claude.json')
const mcpJson = join(ws, '.mcp.json')

const httpDef = (name, port = 1) => ({ transport: 'streamable-http', serverName: name, url: `http://127.0.0.1:${port}/mcp`, headers: {} })
const stdioDef = (name) => ({ transport: 'stdio', serverName: name, command: 'node', args: ['-v'], env: {} })

mkdirSync(join(home, 'skill-mcp-gate'), { recursive: true })
mkdirSync(join(ws, '.dsh'), { recursive: true })

writeFileSync(globalFile, JSON.stringify({
  mcp: {
    servers: { pluginGlobal: 'on', ccUserTouched: 'off' },
    definitions: { pluginGlobal: httpDef('pluginGlobal', 11) },
  },
}, null, 2), 'utf8')

writeFileSync(projectFile, JSON.stringify({
  mcp: {
    servers: { pluginProject: 'on', nameOnly: 'on' },
    definitions: { pluginProject: stdioDef('pluginProject') },
  },
}, null, 2), 'utf8')

writeFileSync(claudeJson, JSON.stringify({
  mcpServers: { ccUser: { type: 'http', url: 'http://127.0.0.1:12/mcp' }, ccUserTouched: { type: 'http', url: 'http://127.0.0.1:13/mcp' } },
  projects: { [ws.replace(/\//g, '/').toLowerCase()]: { mcpServers: { ccLocal: { type: 'http', url: 'http://127.0.0.1:14/mcp' } } } },
}, null, 2), 'utf8')

writeFileSync(mcpJson, JSON.stringify({
  mcpServers: { fromMcpJson: { type: 'stdio', command: 'node', args: ['-v'] } },
}, null, 2), 'utf8')

// ── 假 ctx ────────────────────────────────────────────
const loaderEntries = new Map()
let seq = 0
const fakeLoader = {
  entries() { return [...loaderEntries.values()][Symbol.iterator]() },
  async create(options) {
    const id = `entry-${++seq}`
    loaderEntries.set(id, { id, options: { ...options, id }, disabled: false })
    return id
  },
  async update(id, options) {
    const entry = loaderEntries.get(id)
    if (!entry) throw new Error(`没有条目 ${id}`)
    entry.options = { ...entry.options, ...options }
  },
  remove(id) { loaderEntries.delete(id) },
  write() {},
}

const routes = []
const ctx = {
  get: (name) => (name === 'loader' ? fakeLoader : undefined),
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
const rowOf = (state, name) => (state.mcp.servers || []).find((s) => s.name === name)

// ── 各来源的期望 ──────────────────────────────────────
const cases = [
  {
    source: 'plugin-global', name: 'pluginGlobal', scope: 'global',
    listed: true, layer: 'global', hasDefinition: true,
    probeMode: 'http', ownedByPlugin: true,
  },
  {
    source: 'plugin-project', name: 'pluginProject', scope: ws,
    listed: true, layer: 'project', hasDefinition: true,
    probeMode: 'stdio', ownedByPlugin: true,
  },
  {
    source: 'name-only', name: 'nameOnly', scope: ws,
    listed: true, layer: 'project', hasDefinition: false,
    probeMode: 'unknown', ownedByPlugin: true,
  },
  {
    source: 'cc-user', name: 'ccUser', scope: ws,
    listed: true, layer: 'cc', hasDefinition: false,
    probeMode: 'http', ownedByPlugin: false,
  },
  {
    source: 'cc-user（已被我们记过开关）', name: 'ccUserTouched', scope: 'global',
    listed: true, layer: 'cc', hasDefinition: false,
    probeMode: 'http', ownedByPlugin: false, initialState: 'off',
  },
  {
    source: 'cc-local', name: 'ccLocal', scope: ws,
    listed: true, layer: 'cc', hasDefinition: false,
    probeMode: 'http', ownedByPlugin: false,
  },
  {
    source: 'mcp-json', name: 'fromMcpJson', scope: ws,
    listed: true, layer: 'project', hasDefinition: true,
    probeMode: 'stdio', ownedByPlugin: true, readOnlyDefinition: true,
  },
]

for (const item of cases) {
  console.log('')
  console.log(`【${item.source}】${item.name}`)

  // 1) 初始形态
  const state = await getState(item.scope)
  const row = rowOf(state, item.name)
  check('出现在列表里', Boolean(row), item.listed)
  if (!row) continue
  check('归属层正确', row.layer, item.layer)
  check('有没有连接定义', row.hasDefinition, item.hasDefinition)
  check('初始状态', row.state, item.initialState ?? 'on')
  if (item.hasDefinition) {
    check('被本插件接管', state.mcp.connections.managed.includes(item.name), true)
  }

  // 2) 探测：按来源给出确定的模式
  const probe = await callJson('/mcp/probe', { server: item.name })
  check('探测模式', probe.body.probe?.mode, item.probeMode)
  check('探测不写任何配置', existsSync(mcpJson), true)   // .mcp.json 是我们自己造的夹具，只确认它没被删

  // 3) 开关一轮：不该换组
  const off = await callJson('/mcp', { server: item.name, state: 'off', ws: item.scope })
  const offRow = rowOf(off.body.state, item.name)
  check('关闭后仍在原组', offRow?.layer, item.layer)
  check('关闭后状态生效', offRow?.state, 'off')
  if (item.hasDefinition) {
    check('关闭 = 断开（运行期条目移除）', off.body.state.mcp.connections.active.includes(item.name), false)
  }

  const on = await callJson('/mcp', { server: item.name, state: 'on', ws: item.scope })
  const onRow = rowOf(on.body.state, item.name)
  check('打开后仍在原组', onRow?.layer, item.layer)
  check('打开后状态生效', onRow?.state, 'on')
  if (item.hasDefinition) {
    check('打开 = 重新连上', on.body.state.mcp.connections.active.includes(item.name), true)
  }
}

// ── 删除语义（按来源分开验，因为它们本来就该不同）──────────
console.log('')
console.log('【删除语义】')

{
  // 本插件自己的定义：删得干净
  const removed = await callJson('/mcp/remove', { server: 'pluginProject', ws: ws })
  check('plugin-project 删除成功', removed.body.ok, true)
  check('plugin-project 从列表消失', Boolean(rowOf(removed.body.state, 'pluginProject')), false)
  const doc = JSON.parse(readFileSync(projectFile, 'utf8'))
  check('plugin-project 定义与门禁都没了', [doc.mcp?.definitions?.pluginProject, doc.mcp?.servers?.pluginProject], [undefined, undefined])
}
{
  // 只有名字的条目：删掉就真没了
  const removed = await callJson('/mcp/remove', { server: 'nameOnly', ws: ws })
  check('name-only 删除成功', removed.body.ok, true)
  check('name-only 从列表消失', Boolean(rowOf(removed.body.state, 'nameOnly')), false)
}
{
  // 全局定义：也要删得掉（v0.15.4 的 bug 就在这里）
  const removed = await callJson('/mcp/remove', { server: 'pluginGlobal', ws: 'global' })
  check('plugin-global 删除成功', removed.body.ok, true)
  check('plugin-global 清掉了定义那一处', removed.body.configRemoved, 1)
  const doc = JSON.parse(readFileSync(globalFile, 'utf8'))
  check('plugin-global 全局文件干净', doc.mcp?.definitions?.pluginGlobal, undefined)
}
{
  // CC 声明：删不掉对方的声明，只能清掉我们自己的记录
  await callJson('/mcp', { server: 'ccUserTouched', state: 'off', ws: 'global' })
  const removed = await callJson('/mcp/remove', { server: 'ccUserTouched', ws: 'global' })
  check('CC 声明 + 我们的开关：删除成功（清我们的记录）', removed.body.ok, true)
  check('并告知仍由 CC 声明', removed.body.stillDeclaredByCc, true)
  const doc = JSON.parse(readFileSync(globalFile, 'utf8'))
  check('我们的开关记录已清', doc.mcp?.servers?.ccUserTouched, undefined)
  const state = await getState('global')
  check('行还在（那是 CC 的声明）', Boolean(rowOf(state, 'ccUserTouched')), true)
  check('状态回到默认 on', rowOf(state, 'ccUserTouched')?.state, 'on')
}
{
  // 只读定义（.mcp.json）：删除退化成停用
  const removed = await callJson('/mcp/remove', { server: 'fromMcpJson', ws: ws })
  check('mcp-json 删除不报错', removed.body.ok, true)
  check('但仍标明定义来自只读文件', typeof removed.body.readOnlySource, 'string')
  const state = await getState(ws)
  check('行还在（定义在 .mcp.json 里）', Boolean(rowOf(state, 'fromMcpJson')), true)
  check('已被停用', rowOf(state, 'fromMcpJson')?.state, 'off')
  check('.mcp.json 未被改写', JSON.parse(readFileSync(mcpJson, 'utf8')).mcpServers.fromMcpJson.command, 'node')
}
{
  // CC 声明但没有我们的记录：拒绝删除并说清原因
  const removed = await callJson('/mcp/remove', { server: 'ccUser', ws: ws })
  check('CC-only 拒绝删除', removed.status, 400)
  check('理由指向「只存在于 Claude Code」', String(removed.body.error).includes('Claude Code'), true)
}

// ── 作用域串味：在 A 作用域操作，不能写到 B 的配置文件里 ─────────
console.log('')
console.log('【作用域不串味】')

{
  // 当前视图还停在项目工作区，但用户在「全局」添加 → 必须写全局配置
  await getState(ws)
  const added = await callJson('/mcp/add', {
    text: JSON.stringify({ transport: 'stdio', serverName: 'scopeGlobal', command: 'node', args: ['-v'] }),
    ws: 'global',
  })
  check('全局添加成功', added.body.ok, true)
  const globalDoc = JSON.parse(readFileSync(globalFile, 'utf8'))
  const projectDoc = JSON.parse(readFileSync(projectFile, 'utf8'))
  check('定义落在全局配置', globalDoc.mcp?.definitions?.scopeGlobal?.command, 'node')
  check('没有写进项目配置', projectDoc.mcp?.definitions?.scopeGlobal, undefined)
  check('门禁记录也在全局配置', globalDoc.mcp?.servers?.scopeGlobal, 'on')

  const state = await getState('global')
  check('全局视图里被接管', state.mcp.connections.managed.includes('scopeGlobal'), true)
  check('全局视图里归属层正确', rowOf(state, 'scopeGlobal')?.layer, 'global')

  const removed = await callJson('/mcp/remove', { server: 'scopeGlobal', ws: 'global' })
  check('全局添加的能删掉', removed.body.ok, true)
  const after = JSON.parse(readFileSync(globalFile, 'utf8'))
  check('删完全局配置干净', [after.mcp?.definitions?.scopeGlobal, after.mcp?.servers?.scopeGlobal], [undefined, undefined])
}
{
  // 当前视图在全局，但用户在项目作用域添加 → 必须写项目配置
  await getState('global')
  const added = await callJson('/mcp/add', {
    text: JSON.stringify({ transport: 'stdio', serverName: 'scopeProject', command: 'node', args: ['-v'] }),
    ws,
  })
  check('项目添加成功', added.body.ok, true)
  const projectDoc = JSON.parse(readFileSync(projectFile, 'utf8'))
  const globalDoc = JSON.parse(readFileSync(globalFile, 'utf8'))
  check('定义落在项目配置', projectDoc.mcp?.definitions?.scopeProject?.command, 'node')
  check('没有写进全局配置', globalDoc.mcp?.definitions?.scopeProject, undefined)

  const removed = await callJson('/mcp/remove', { server: 'scopeProject', ws })
  check('项目添加的能删掉', removed.body.ok, true)
}

rmSync(home, { recursive: true, force: true })
rmSync(ws, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
