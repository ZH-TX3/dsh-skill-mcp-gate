#!/usr/bin/env node
/**
 * 「复制到 DSH」：把 Claude Code 里声明的连接定义搬进本插件配置，之后才连得上、才能真断开。
 *
 * 之前的行为：CC 的定义只读 —— 面板看得见名字，但没有连接定义，所以永远连不上。
 * 这里从三个入口各验一遍：Web API（项目 / 全局两个作用域）与 `/gate copy` 命令面。
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'gate-adopt-home-'))
const ws = mkdtempSync(join(tmpdir(), 'gate-adopt-ws-'))
process.env.DSH_HOME = home

// Claude Code 的用户级声明：stdio（带 env）、http、以及一个 DSH 不接受的带点名字
writeFileSync(join(home, '.claude.json'), JSON.stringify({
  mcpServers: {
    ccstdio: { command: 'node', args: ['-v'], env: { TOKEN: 'abc123', PORT: 3000 } },
    cchttp: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
    cccmd: { command: 'node', args: ['--version'] },
    'bad.name': { command: 'node' },
  },
}), 'utf8')

const { apply } = await import('../index.js')

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

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
const commands = []
const ctx = {
  get: (name) => (name === 'loader' ? fakeLoader : undefined),
  skills: { list: async () => [], registerProvider: () => () => {}, get: async () => undefined },
  commands: { register: (def) => { commands.push(def); return () => {} } },
  tools: { schemas: () => [], guard: () => () => {}, register: () => () => {}, execute: async () => ({ isError: false, content: [] }) },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  agents: { list: () => [] },
  workspaceRegistry: { list: () => [{ path: ws, title: 'demo' }] },
  on: () => () => {},
  effect: (factory) => factory(),
}

apply(ctx, { projectDir: ws, ccHome: home })
await new Promise((r) => setTimeout(r, 80))

const projectFile = join(ws, '.dsh', 'skill-mcp-gate.json')
const globalFile = join(home, 'skill-mcp-gate', 'settings.json')
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})

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
const rowOf = (state, name) => (state.mcp.servers || []).find((srv) => srv.name === name)

console.log('复制前：CC 里看得见，但没有连接定义')
{
  const state = await getState(ws)
  const row = rowOf(state, 'ccstdio')
  check('CC 声明的服务器出现在面板上', Boolean(row), true)
  check('归属层是 cc', row?.layer, 'cc')
  check('没有连接定义', row?.hasDefinition, false)
  check('面板快照里不带 env（可能含 token）', rowOf(state, 'ccstdio') && state.mcp.cc.servers.find((s) => s.name === 'ccstdio').definition.env, undefined)
  check('运行期没有它', state.mcp.connections.managed.includes('ccstdio'), false)
}

console.log('复制到 DSH（项目作用域）')
{
  const adopted = await callJson('/mcp/adopt', { names: ['ccstdio'], ws })
  check('复制成功', adopted.body.ok, true)
  check('copied 里只有它', adopted.body.copied, ['ccstdio'])
  check('写进项目配置', adopted.body.file, projectFile)
  const doc = readJson(projectFile)
  check('定义落盘：stdio', doc.mcp?.definitions?.ccstdio?.transport, 'stdio')
  check('定义落盘：command 带过来了', doc.mcp?.definitions?.ccstdio?.command, 'node')
  check('env 带过来了（只留字符串值）', doc.mcp?.definitions?.ccstdio?.env, { TOKEN: 'abc123' })
  check('真的建了运行期连接', adopted.body.connected, ['ccstdio'])
  check('loader 里有一条', loaderEntries.size, 1)

  const row = rowOf(adopted.body.state, 'ccstdio')
  check('接管后归属层变成本项目', row?.layer, 'project')
  check('已经算插件代管', row?.hasDefinition, true)
  check('CC 的声明仍在（两个 tag 都在）', row?.ccScope, 'user')
  check('门禁状态默认 on', row?.state, 'on')
}

console.log('再复制一次：幂等')
{
  const again = await callJson('/mcp/adopt', { names: ['ccstdio'], ws })
  check('没有重复复制', again.body.copied, [])
  check('说明原因', String(again.body.skipped[0]?.reason).includes('已经有一份定义'), true)
  check('配置没被改坏', readJson(projectFile).mcp?.definitions?.ccstdio?.command, 'node')
}

console.log('复制后就能真控制：off = 断开')
{
  const off = await callJson('/mcp', { server: 'ccstdio', state: 'off', ws })
  check('off 后运行期条目被移除', loaderEntries.size, 0)
  check('定义还在（随时能再开）', off.body.state.mcp.connections.managed.includes('ccstdio'), true)
  const on = await callJson('/mcp', { server: 'ccstdio', state: 'on', ws })
  check('on 后重新建连', loaderEntries.size, 1)
  check('active 恢复', on.body.state.mcp.connections.active.includes('ccstdio'), true)
}

console.log('复制到 DSH（全局作用域）')
{
  const adopted = await callJson('/mcp/adopt', { names: ['cchttp'], ws: 'global' })
  check('复制成功', adopted.body.ok, true)
  check('写进全局配置', adopted.body.file, globalFile)
  check('没有偷偷写项目配置', readJson(projectFile).mcp?.definitions?.cchttp, undefined)
  check('http 定义保留 url', readJson(globalFile).mcp?.definitions?.cchttp?.url, 'http://127.0.0.1:1/mcp')
  const row = rowOf(adopted.body.state, 'cchttp')
  check('归属层是全局', row?.layer, 'global')
}

console.log('名字不合法的照实报，不硬塞')
{
  const adopted = await callJson('/mcp/adopt', { names: ['bad.name', 'not-in-cc'], ws })
  check('一台都没复制', adopted.body.copied, [])
  const reasons = adopted.body.skipped.map((item) => `${item.name}:${item.reason}`).join(' | ')
  check('带点的名字被拒（DSH 工具名限制）', reasons.includes('bad.name'), true)
  check('CC 里没有的也说清楚', reasons.includes('not-in-cc'), true)
  check('没有留下垃圾定义', readJson(projectFile).mcp?.definitions?.['bad.name'], undefined)
  check('也没有登记多余名字', readJson(projectFile).mcp?.servers?.['bad.name'], undefined)
}

console.log('/gate 命令面')
{
  const gate = commands[0]
  check('注册了 /gate', gate?.name, 'gate')
  const result = await gate.handler({ rawInput: 'copy cccmd' })
  check('命令返回成功', result.kind, 'success')
  // 命令面没有 ws 参数，跟随当前作用域（上一步已经切回本项目）
  check('提示里带文件路径', String(result.text).includes(projectFile), true)
  check('定义真落盘了', readJson(projectFile).mcp?.definitions?.cccmd?.args, ['--version'])
  const missing = await gate.handler({ rawInput: 'copy' })
  check('缺参数时给用法', missing.kind, 'error')
}

rmSync(home, { recursive: true, force: true })
rmSync(ws, { recursive: true, force: true })
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
