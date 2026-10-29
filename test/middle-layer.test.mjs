#!/usr/bin/env node
/**
 * 中间层端到端（不启动 DSH）：真跑 apply()、真跑装配 waterfall，
 * 验证「延迟服务器 → 索引 → gate_mcp_search → gate_mcp_call → 嵌套 dispatch」整条链路。
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'gate-mid-home-'))
const ws = mkdtempSync(join(tmpdir(), 'gate-mid-ws-'))
process.env.DSH_HOME = home

// 全局配置：exa 延迟加载，ctx7 关闭
mkdirSync(join(home, 'skill-mcp-gate'), { recursive: true })
writeFileSync(join(home, 'skill-mcp-gate', 'settings.json'), JSON.stringify({
  mcp: { servers: { exa: 'deferred', ctx7: 'off' } },
}), 'utf8')
mkdirSync(join(ws, '.dsh'), { recursive: true })
writeFileSync(join(ws, '.dsh', 'skill-mcp-gate.json'), JSON.stringify({
  mcp: { servers: { exa: 'deferred', ctx7: 'off' } },
}), 'utf8')

// CC 侧：user 作用域声明了 exa，并且在 CC 里被拒绝（settings 的 disabledMcpjsonServers）
writeFileSync(join(home, '.claude.json'), JSON.stringify({
  mcpServers: {
    exa: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
    ccOnly: { type: 'http', url: 'http://127.0.0.1:1/only-in-cc' },
  },
}), 'utf8')
mkdirSync(join(home, '.claude'), { recursive: true })
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ disabledMcpjsonServers: ['exa'] }), 'utf8')

const { apply } = await import('../index.js')

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

const listeners = new Map()
const eventCounts = {}
const registered = []
const dispatches = []
const routes = []
const commands = []

// 假的 loader：记录 create/update/remove 与 write 次数，用来验证「写 profile + 热加载」
const loaderEntries = new Map()
let loaderWrites = 0
let loaderSeq = 0
const fakeLoader = {
  entries() { return [...loaderEntries.values()][Symbol.iterator]() },
  async create(options) {
    const id = `entry-${++loaderSeq}`
    loaderEntries.set(id, { id, options: { ...options, id }, disabled: false })
    return id
  },
  async update(id, options) {
    const entry = loaderEntries.get(id)
    if (!entry) throw new Error(`没有条目 ${id}`)
    entry.options = { ...entry.options, ...options }
  },
  remove(id) { loaderEntries.delete(id) },
  write() { loaderWrites += 1 },
}

const ctx = {
  get: (name) => (name === 'loader' ? fakeLoader : undefined),
  skills: {
    list: async () => [],
    registerProvider: () => () => {},
    get: async (name) => (name === 'ghostSkill' ? undefined : {
      name,
      provider: 'fake',
      content: `# ${name} 的正文`,
      source: 'user-dsh',
      description: 'd',
      invocation: { modelInvocable: true, userInvocable: true },
    }),
  },
  commands: { register: (def) => { commands.push(def); return () => {} } },
  tools: {
    schemas: () => [],
    guard: () => () => {},
    register: (tool) => { registered.push(tool); return () => {} },
    execute: async (input) => {
      dispatches.push(input)
      return { isError: false, content: [{ type: 'text', text: `RESULT:${JSON.stringify(input.arguments)}` }] }
    },
  },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  agents: { list: () => [] },
  workspaceRegistry: { list: () => [{ path: ws, title: 'demo' }] },
  on: (event, fn) => { eventCounts[event] = (eventCounts[event] ?? 0) + 1; listeners.set(event, fn); return () => {} },
  effect: (factory) => factory(),
}

apply(ctx, { projectDir: ws, ccHome: home })
await new Promise((r) => setTimeout(r, 80))

console.log('注册')
{
  // 目录门禁与 rules 注入都挂在 agent/pre-step 上，装配过滤器与 rules 各自挂自己的事件
  check('agent/pre-step 有三个监听（目录门禁 + rules + 手动调用）', eventCounts['agent/pre-step'], 3)
  check('tools/result 有 rules 监听', eventCounts['tools/result'], 1)
  check('system-prompt/assemble 有装配过滤器', eventCounts['system-prompt/assemble'], 1)
}
{
  check('中间层两个工具已注册', registered.map((t) => t.name).sort(), ['gate_mcp_call', 'gate_mcp_search'])
  check('参数是 JSON Schema', registered.every((tool) => tool.parameters.type === 'object'), true)
  check('声明了输出契约', registered.every((tool) => typeof tool.output.render === 'function'), true)
}

console.log('\n装配期：延迟工具被摘掉、中间层留下')
const assemble = listeners.get('system-prompt/assemble')
check('装了装配监听', typeof assemble, 'function')

const assembly = {
  tools: [
    { name: 'Bash', description: 'shell' },
    { name: 'gate_mcp_search', description: 'search' },
    { name: 'gate_mcp_call', description: 'call' },
    { name: 'mcp__exa__crawl', description: '抓取网页并返回正文' },
    { name: 'mcp__exa__search', description: '语义搜索互联网' },
    { name: 'mcp__ctx7__resolve', description: '解析库文档' },
  ],
}
await assemble(assembly, {}, async () => assembly)
check('延迟与关闭的工具都消失', assembly.tools.filter((t) => t.name.startsWith('mcp__')).length, 0)
check('中间层保留', assembly.tools.some((t) => t.name === 'gate_mcp_search'), true)
check('非 MCP 工具不受影响', assembly.tools.some((t) => t.name === 'Bash'), true)

console.log('\n搜索 → 调用')
{
  const search = registered.find((t) => t.name === 'gate_mcp_search')
  const call = registered.find((t) => t.name === 'gate_mcp_call')

  const found = await search.execute({ query: '网页' })
  check('搜到延迟工具', found.total, 1)
  check('结果里给出全名', found.text.includes('mcp__exa__crawl'), true)

  const exec = { callId: 'root-call', rootCallId: 'root-call', token: Symbol('tok'), agent: { id: 'agent-1' }, signal: new AbortController().signal }
  const called = await call.execute({ name: 'exa.crawl', arguments: { url: 'https://example.com' } }, exec)
  check('调用成功', called.ok, true)
  check('转发嵌套结果', called.text.includes('https://example.com'), true)
  check('嵌套带上 parent（PTC 下才算嵌套）', dispatches[0].parent === exec.token, true)
  check('嵌套继承 agent 与 rootCallId', [dispatches[0].agent.id, dispatches[0].rootCallId], ['agent-1', 'root-call'])
  check('取消信号贯通', dispatches[0].signal === exec.signal, true)
}

console.log('\n关闭的服务器不可调用')
{
  const call = registered.find((t) => t.name === 'gate_mcp_call')
  const refused = await call.execute({ name: 'ctx7.resolve' }, { callId: 'c2' })
  check('拒绝并说明原因', [refused.ok, refused.text.includes('已被关闭')], [false, true])
  check('没有真的派发', dispatches.length, 1)
  const offAgain = await registered.find((t) => t.name === 'gate_mcp_call')
    .execute({ name: 'ctx7.resolve' }, { callId: 'c3' })
  check('被 CC 拒绝且无本插件覆盖的服务器仍拒绝', offAgain.text.includes('已被关闭'), true)
}

console.log('\nCC 出处与状态的分工')
{
  const stateRoute = routes.find((r) => r.path.endsWith('/state'))
  let body = null
  await new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, end(chunk) { body = JSON.parse(chunk); resolve() } }
    stateRoute.handler({ method: 'GET', headers: {}, url: '/api/skill-mcp-gate/state' }, res)
  })
  const exa = body.mcp.servers.find((srv) => srv.name === 'exa')
  check('本插件配置决定状态', exa.state, 'deferred')
  check('保留 CC 作用域 tag', exa.ccScope, 'user')
  check('保留 CC 的拒绝标记', exa.ccRejected, true)
  check('层标为本插件项目层', exa.layer, 'project')
}

console.log('\n没有延迟服务器时中间层不占位')
{
  const offAssembly = {
    tools: [
      { name: 'gate_mcp_search' },
      { name: 'gate_mcp_call' },
      { name: 'mcp__exa__crawl' },
    ],
  }
  // 切到「exa 正常 / ctx7 关闭」后再装配一次
  writeFileSync(join(ws, '.dsh', 'skill-mcp-gate.json'), JSON.stringify({ mcp: { servers: { exa: 'on', ctx7: 'off' } } }), 'utf8')
  await commands[0].handler({ rawInput: `reload ${ws}` })
  await assemble(offAssembly, {}, async () => offAssembly)
  check('中间层被摘掉', offAssembly.tools.map((t) => t.name), ['mcp__exa__crawl'])
}

console.log('' + '\n条目管理：改名 / 删除 / 探测')
{
  const tokenRoute = routes.find((r) => r.path.endsWith('/token'))
  let token = null
  tokenRoute.handler({}, { statusCode: 200, setHeader() {}, end(body) { token = JSON.parse(body).token } })

  const call = (suffix, body) => new Promise((resolve, reject) => {
    const route = routes.find((r) => r.path.endsWith(suffix))
    if (!route) return reject(new Error(`没有路由 ${suffix}`))
    const timer = setTimeout(() => reject(new Error(`${suffix} 没写响应`)), 5000)
    const res = {
      statusCode: 200,
      setHeader() {},
      end(chunk) { clearTimeout(timer); resolve({ status: this.statusCode, body: JSON.parse(chunk) }) },
    }
    route.handler({ method: 'POST', headers: { 'x-gate-token': token }, url: '/' , on() {}, }, res)
    void body
  })

  // 路由的 withBody 会读 req 的 data/end，补一个最小可读流
  const callJson = (suffix, payload) => new Promise((resolve, reject) => {
    const route = routes.find((r) => r.path.endsWith(suffix))
    if (!route) return reject(new Error(`没有路由 ${suffix}`))
    const timer = setTimeout(() => reject(new Error(`${suffix} 没写响应`)), 5000)
    const handlers = {}
    const req = {
      method: 'POST',
      headers: { 'x-gate-token': token },
      url: '/',
      on(event, fn) { handlers[event] = fn },
    }
    const res = {
      statusCode: 200,
      setHeader() {},
      end(chunk) { clearTimeout(timer); resolve({ status: this.statusCode, body: JSON.parse(chunk) }) },
    }
    route.handler(req, res)
    handlers.data?.(JSON.stringify(payload ?? {}))
    handlers.end?.()
  })

  const renamed = await callJson('/mcp/rename', { from: 'exa', to: 'exa2' })
  check('改名成功返回新名字', renamed.body.to, 'exa2')
  check('改名返回 ok', renamed.body.ok, true)
  check('改名后快照里有新名字', renamed.body.state.mcp.servers.some((srv) => srv.name === 'exa2'), true)
  // 只搬「赢的那一层」：项目层改了名，全局层还有同名条目，所以 exa 仍在列表里
  const exaNow = renamed.body.state.mcp.servers.find((srv) => srv.name === 'exa')
  check('旧名字回落到下一层（全局）而不是消失', exaNow?.layer, 'global')
  check('改名写在项目层文件里',
    JSON.parse(readFileSync(join(ws, '.dsh', 'skill-mcp-gate.json'), 'utf8')).mcp.servers.exa2 !== undefined, true)

  const probeExa = await callJson('/mcp/probe', { server: 'exa' })
  check('CC 有定义的服务器走 http 探测', probeExa.body.probe.mode, 'http')
  check('探测如实报不可达', probeExa.body.probe.ok, false)
  check('探测带原因', String(probeExa.body.probe.detail).length > 0, true)

  const probeRenamed = await callJson('/mcp/probe', { server: 'exa2' })
  check('改过名的看不到 CC 定义 → unknown', probeRenamed.body.probe.mode, 'unknown')
  check('并说明为什么', String(probeRenamed.body.probe.reason).includes('只在本插件'), true)

  const removed = await callJson('/mcp/remove', { server: 'exa2' })
  check('删除返回 ok', removed.body.ok, true)
  check('删除同时清掉配置与运行期连接信息', [removed.body.configRemoved >= 1, 'connectionRemoved' in removed.body], [true, true])
  check('删除后快照里没有它', removed.body.state.mcp.servers.some((srv) => srv.name === 'exa2'), false)

  const again = await callJson('/mcp/remove', { server: 'exa2' })
  check('删不存在的条目报错而不是假装成功', again.status, 400)

  const ccOnly = await callJson('/mcp/remove', { server: 'ccOnly' })
  check('CC-only 的条目拒绝删除', ccOnly.status, 400)
  check('并说明理由', String(ccOnly.body.error).includes('Claude Code'), true)
}

console.log('' + '\n连接定义：编辑 JSON + 热加载')
{
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

  const initial = await callJson('/mcp/definition', { server: 'ccOnly' })
  check('没有 DSH 配置时用 CC 定义当模板', initial.body.definition.source, 'claude-code')
  check('模板是 streamable-http', initial.body.definition.config.transport, 'streamable-http')
  check('初始 managed=false', initial.body.definition.managed, false)

  const saved = await callJson('/mcp/define', {
    server: 'ccOnly',
    json: JSON.stringify({ serverName: 'ccOnly', transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' }),
  })
  check('保存成功', saved.body.ok, true)
  check('真的创建了 loader 条目', loaderEntries.size, 1)
  check('不依赖 loader.write（实测会静默失败）', loaderWrites, 0)
  check('条目用的是可解析的包名', [...loaderEntries.values()][0].options.name, '@deepseek-ai/dsh-mcp-client')
  check('快照标出插件代管', saved.body.state.mcp.connections.managed, ['ccOnly'])
  const ccOnlyRow = saved.body.state.mcp.servers.find((srv) => srv.name === 'ccOnly')
  check('只有定义也能在面板上看到（补门禁状态）', ccOnlyRow?.state, 'on')
  check('写进项目级 .mcp.json', saved.body.kind, 'mcp.json')
  const mcpJson = JSON.parse(readFileSync(join(ws, '.mcp.json'), 'utf8'))
  check('用的是 Claude Code 的形状', mcpJson.mcpServers.ccOnly.type, 'http')
  check('url 一致', mcpJson.mcpServers.ccOnly.url, 'http://127.0.0.1:1/mcp')
  const ownConfig = JSON.parse(readFileSync(join(ws, '.dsh', 'skill-mcp-gate.json'), 'utf8'))
  check('本插件配置里不再重复存一份', ownConfig.mcp?.definitions?.ccOnly, undefined)

  const probeManaged = await callJson('/mcp/probe', { server: 'ccOnly' })
  check('探测优先用 DSH 配置（仍是 http）', probeManaged.body.probe.mode, 'http')
  check('探测如实报不可达', probeManaged.body.probe.ok, false)

  const badJson = await callJson('/mcp/define', { server: 'ccOnly', json: '{ nope' })
  check('坏 JSON 返回 400', badJson.status, 400)
  check('并说明是 JSON 解析失败', String(badJson.body.error).includes('JSON 解析失败'), true)

  const badName = await callJson('/mcp/define', { server: 'ccOnly', json: JSON.stringify({ serverName: 'a b', command: 'x' }) })
  check('非法 serverName 被拒', badName.status, 400)
  check('条目没被改坏', loaderEntries.size, 1)

  const removedDef = await callJson('/mcp/undefine', { server: 'ccOnly' })
  check('删除连接成功', removedDef.body.ok, true)
  check('loader 条目清空', loaderEntries.size, 0)
  check('快照里不再代管', removedDef.body.state.mcp.connections.managed, [])
  const afterDelete = JSON.parse(readFileSync(join(ws, '.mcp.json'), 'utf8'))
  check('.mcp.json 里的定义也删掉了', afterDelete.mcpServers?.ccOnly, undefined)

  // 回归：只删门禁条目时，定义还在 → load 会把服务器又补回列表（看起来删不掉）
  const pastedForDelete = await callJson('/mcp/add', {
    text: JSON.stringify({ transport: 'stdio', serverName: 'wipeMe', command: 'cmd', args: ['/c'] }),
  })
  check('先加一台带定义的服务器', pastedForDelete.body.names, ['wipeMe'])
  const wiped = await callJson('/mcp/remove', { server: 'wipeMe' })
  check('删除后列表里不再有它', wiped.body.state.mcp.servers.some((srv) => srv.name === 'wipeMe'), false)
  check('删除后不再被代管', wiped.body.state.mcp.connections.managed.includes('wipeMe'), false)
  const wipeFile = JSON.parse(readFileSync(join(ws, '.dsh', 'skill-mcp-gate.json'), 'utf8'))
  check('定义与门禁条目都不在了',
    [wipeFile.mcp?.definitions?.wipeMe, wipeFile.mcp?.servers?.wipeMe], [undefined, undefined])

  const againDef = await callJson('/mcp/undefine', { server: 'ccOnly' })
  check('重复删除报错', againDef.status, 400)
  check('并说明没有这条定义', String(againDef.body.error).includes('本插件里没有'), true)

  // 回归：在「自定义填入」里粘贴一份连接 config，曾经被拆成 transport/serverName/command/args 四个假服务器
  const pasted = await callJson('/mcp/add', {
    text: JSON.stringify({ transport: 'stdio', serverName: 'pasteTest', command: 'cmd', args: ['/c', 'npx', '-y', 'pkg'] }),
  })
  check('粘贴单个 config 只加一台', pasted.body.names, ['pasteTest'])
  check('名字里没有 transport 之类的假条目',
    pasted.body.names.some((n) => ['transport', 'serverName', 'command', 'args'].includes(n)), false)
  check('定义被落盘', pasted.body.definitions, ['pasteTest'])
  check('顺手建了运行期连接', [loaderEntries.size, pasted.body.connected], [1, ['pasteTest']])
  const savedMcpJson = JSON.parse(readFileSync(join(ws, '.mcp.json'), 'utf8'))
  check('粘贴的定义也写进 .mcp.json（CC 形状）', savedMcpJson.mcpServers.pasteTest.command, 'cmd')
  check('门禁条目写在项目配置里',
    JSON.parse(readFileSync(join(ws, '.dsh', 'skill-mcp-gate.json'), 'utf8')).mcp.servers.pasteTest, 'on')
}

console.log('skill 读取与手动调用')
{
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

  const content = await callJson('/skill/content', { name: 'demo' })
  check('能读到技能正文', content.body.skill.content, '# demo 的正文')
  check('带上 provider', content.body.skill.provider, 'fake')
  check('带上当前档位', content.body.skill.state, 'on')

  const missing = await callJson('/skill/content', { name: 'ghostSkill' })
  check('读不到时 400', missing.status, 400)
  check('并说明原因', String(missing.body.error).includes('目录里没有 skill'), true)

  const noSession = await callJson('/skill/invoke', { name: 'demo' })
  check('没有活动会话时拒绝', noSession.status, 400)
  check('并指路', String(noSession.body.error).includes('没有活动会话'), true)

  await callJson('/skill', { name: 'demo', state: 'off' })
  const offInvoke = await callJson('/skill/invoke', { name: 'demo' })
  check('off 的技能不能手动调用', offInvoke.status, 400)
  check('并说明怎么恢复', String(offInvoke.body.error).includes('仅手动'), true)
  await callJson('/skill', { name: 'demo', state: 'on' })
}

console.log('')
console.log('切换工作区：只保留当前项目的连接')
{
  const tokenRoute = routes.find((r) => r.path.endsWith('/token'))
  let token = null
  tokenRoute.handler({}, { statusCode: 200, setHeader() {}, end(body) { token = JSON.parse(body).token } })
  const post = (suffix, payload) => new Promise((resolve, reject) => {
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

  const wsB = mkdtempSync(join(tmpdir(), 'gate-mid-wsb-'))
  mkdirSync(join(wsB, '.dsh'), { recursive: true })

  const saved = await post('/mcp/define', {
    server: 'switchTest',
    json: JSON.stringify({ serverName: 'switchTest', transport: 'streamable-http', url: 'http://127.0.0.1:1/x' }),
  })
  check('在本项目里建了一条连接', saved.body.state.mcp.connections.managed.includes('switchTest'), true)
  check('写进项目级 .mcp.json', saved.body.kind, 'mcp.json')
  check('运行期有它', [...loaderEntries.values()].some((e) => e.options.config.serverName === 'switchTest'), true)

  const stateB = await getState(wsB)
  check('切到另一个项目后不再代管它', stateB.mcp.connections.managed, [])
  check('切走时连接被回收', loaderEntries.size, 0)

  rmSync(wsB, { recursive: true, force: true })
}

rmSync(home, { recursive: true, force: true })
rmSync(ws, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
