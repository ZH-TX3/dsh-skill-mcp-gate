#!/usr/bin/env node
/**
 * 全局作用域的增删改查（之前只测了项目作用域，这里补齐）。
 * 不启动 DSH：假 ctx + 临时 DSH_HOME。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'gate-global-home-'))
const ws = mkdtempSync(join(tmpdir(), 'gate-global-ws-'))
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

const globalFile = join(home, 'skill-mcp-gate', 'settings.json')

// 全局作用域加一台：定义 + 门禁状态都写全局配置
mkdirSync(join(home, 'skill-mcp-gate'), { recursive: true })
writeFileSync(globalFile, JSON.stringify({
  mcp: {
    servers: { gtest: 'on' },
    definitions: {
      gtest: { transport: 'http', serverName: 'gtest', url: 'http://127.0.0.1:1/mcp', headers: {} },
    },
  },
}, null, 2), 'utf8')

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

const listeners = new Map()
const routes = []
const ctx = {
  get: (name) => (name === 'loader' ? fakeLoader : undefined),
  skills: { list: async () => [], registerProvider: () => () => {}, get: async () => undefined },
  commands: { register: () => () => {} },
  tools: { schemas: () => [], guard: () => () => {}, register: () => () => {}, execute: async () => ({ isError: false, content: [] }) },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  agents: { list: () => [] },
  workspaceRegistry: { list: () => [{ path: ws, title: 'demo' }] },
  on: (event, fn) => { listeners.set(event, fn); return () => {} },
  effect: (factory) => factory(),
}

apply(ctx, { projectDir: ws })
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

console.log('全局作用域：初始状态')
{
  const state = await getState('global')
  const row = (state.mcp.servers || []).find((s) => s.name === 'gtest')
  check('全局作用域能看到它', Boolean(row), true)
  check('归属层是全局', row?.layer, 'global')
  check('被本插件接管', state.mcp.connections.managed.includes('gtest'), true)
  check('运行期已建连接', state.mcp.connections.active.includes('gtest'), true)
}

console.log('全局作用域：编辑')
{
  const saved = await callJson('/mcp/define', {
    server: 'gtest',
    ws: 'global',
    json: JSON.stringify({ serverName: 'gtest', transport: 'streamable-http', url: 'http://127.0.0.1:2/mcp' }),
  })
  check('保存成功', saved.body.ok, true)
  const doc = JSON.parse(readFileSync(globalFile, 'utf8'))
  check('写进全局配置', doc.mcp.definitions.gtest.url, 'http://127.0.0.1:2/mcp')
  check('没有偷偷写项目文件', existsSync(join(ws, '.dsh', 'skill-mcp-gate.json')), false)
}

console.log('全局作用域：删除')
{
  const removed = await callJson('/mcp/remove', { server: 'gtest', ws: 'global' })
  if (removed.body.error) console.log('    [debug] 删除报错:', removed.body.error)
  check('删除返回 ok', removed.body.ok, true)
  check('门禁 + 定义都被清掉（计数应为 2）', removed.body.configRemoved, 2)
  check('删除后列表里没有', (removed.body.state?.mcp?.servers || []).some((s) => s.name === 'gtest'), false)
  check('运行期连接被回收', (removed.body.state?.mcp?.connections?.active || []).includes('gtest'), false)
  const doc = existsSync(globalFile) ? JSON.parse(readFileSync(globalFile, 'utf8')) : {}
  check('全局配置里的定义删掉了', doc.mcp?.definitions?.gtest, undefined)
  check('全局配置里的门禁记录删掉了', doc.mcp?.servers?.gtest, undefined)
}

console.log('全局作用域：自定义填入（JSON）')
{
  const added = await callJson('/mcp/add', {
    ws: 'global',
    text: JSON.stringify({ transport: 'stdio', serverName: 'gadd', command: 'node', args: ['-v'] }),
  })
  if (added.body.error) console.log('    [debug] 添加报错:', added.body.error)
  check('添加成功', added.body.ok, true)
  const doc = JSON.parse(readFileSync(globalFile, 'utf8'))
  check('定义写进全局配置', doc.mcp.definitions.gadd.command, 'node')
  check('门禁记录也在全局配置', doc.mcp.servers.gadd, 'on')

  const removed = await callJson('/mcp/remove', { server: 'gadd', ws: 'global' })
  check('加完能删掉', removed.body.ok, true)
  const after = JSON.parse(readFileSync(globalFile, 'utf8'))
  check('删完两处都干净', [after.mcp?.definitions?.gadd, after.mcp?.servers?.gadd], [undefined, undefined])
}

rmSync(home, { recursive: true, force: true })
rmSync(ws, { recursive: true, force: true })
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
