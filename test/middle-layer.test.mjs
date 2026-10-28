#!/usr/bin/env node
/**
 * 中间层端到端（不启动 DSH）：真跑 apply()、真跑装配 waterfall，
 * 验证「延迟服务器 → 索引 → gate_mcp_search → gate_mcp_call → 嵌套 dispatch」整条链路。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
const registered = []
const dispatches = []
const routes = []
const commands = []

const ctx = {
  skills: { list: async () => [], registerProvider: () => () => {} },
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
  on: (event, fn) => { listeners.set(event, fn); return () => {} },
  effect: (factory) => factory(),
}

apply(ctx, { projectDir: ws })
await new Promise((r) => setTimeout(r, 80))

console.log('注册')
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

rmSync(home, { recursive: true, force: true })
rmSync(ws, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
