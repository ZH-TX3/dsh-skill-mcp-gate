#!/usr/bin/env node
/** 接线测试：假 ctx 跑 apply()，验证命令面 + Web API + 装配过滤器，全部落在临时目录。 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'gate-home-'))
const project = mkdtempSync(join(tmpdir(), 'gate-proj-'))
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

const catalog = [
  { name: 'dataviz', source: 'bundled', invocation: { modelInvocable: true, userInvocable: true }, description: 'd' },
  { name: 'caveman', source: 'user-dsh', invocation: { modelInvocable: true, userInvocable: true }, description: 'd' },
]
const shadows = new Map()
const routes = []
const listeners = new Map()
const commands = []
const toolNames = ['Bash', 'mcp__exa__search', 'mcp__exa__crawl', 'mcp__context7__resolve']

const ctx = {
  skills: {
    list: async () => [...catalog, ...shadows.values()],
    get: async (n) => catalog.find((s) => s.name === n),
    register: (reg) => { shadows.set(reg.name, { ...reg }); return () => shadows.delete(reg.name) },
  },
  commands: { register: (def) => { commands.push(def); return () => {} } },
  tools: { schemas: () => toolNames.map((name) => ({ name, description: '' })), guard: () => () => {} },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  on: (event, fn) => { listeners.set(event, fn); return () => {} },
  effect: (factory) => factory(),
}

apply(ctx, { claudeMcp: false })
await new Promise((r) => setTimeout(r, 60))

const run = (rawInput) => commands[0].handler({ rawInput })
/** WebRoute.handler 是 (req, res) => void，handler 自己写响应 —— 用假 res 捕获。 */
const callRoute = (suffix, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  // 若 handler 忘了写响应，这里 3 秒内必定失败，而不是让测试挂死
  const timer = setTimeout(() => reject(new Error(`路由 ${suffix} 未写响应（handler 必须调用 res.end）`)), 3000)
  const target = routes.find((r) => r.path.endsWith(suffix))
  if (!target) return resolve({ status: 0, text: 'route not found' })
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk) { clearTimeout(timer); resolve({ status: this.statusCode, text: chunk ?? '' }) },
  }
  const req = {
    method,
    headers,
    on: (event, cb) => {
      if (event === 'data' && body !== undefined) cb(JSON.stringify(body))
      if (event === 'end') cb()
    },
  }
  target.handler(req, res)
})
const json = async (suffix, opts) => {
  const res = await callRoute(suffix, opts)
  return { ...res, data: JSON.parse(res.text || '{}') }
}
const getToken = async () => (await json('token')).data.token
const post = async (suffix, body, token) => json(suffix, { method: 'POST', headers: { 'x-gate-token': token }, body })
const readConfig = () => JSON.parse(readFileSync(join(home, 'skill-mcp-gate', 'settings.json'), 'utf8'))

console.log('注册')
check('gate 命令', commands[0]?.name, 'gate')
check('13 条路由', routes.map((r) => r.path.split('/').slice(-1)[0]).sort(),
  ['add', 'define', 'definition', 'mcp', 'probe', 'reload', 'remove', 'rename', 'skill', 'state', 'token', 'tool', 'undefine'])
check('装了装配过滤器', typeof listeners.get('system-prompt/assemble'), 'function')

console.log('\n装配期过滤（真跑一次 waterfall handler）')
{
  const assembly = { tools: toolNames.map((name) => ({ name, description: '' })) }
  listeners.get('system-prompt/assemble')(assembly, {}, () => Promise.resolve(assembly))
  check('没配置时工具不动', assembly.tools.length, toolNames.length)
}

console.log('\n命令面')
{
  const r = await run('set mcp.exa=off')
  check('关闭服务器', r.kind, 'success')
  check('写入配置', readConfig().mcp.servers, { exa: 'off' })
}
{
  const assembly = { tools: toolNames.map((name) => ({ name, description: '' })) }
  listeners.get('system-prompt/assemble')(assembly, {}, () => Promise.resolve(assembly))
  check('exa 的两个工具被隐藏', assembly.tools.map((t) => t.name), ['Bash', 'mcp__context7__resolve'])
}
{
  await run('set mcp.exa=on')
  const r = await run('set mcp.exa.search=off')
  check('逐工具设置成功', r.kind, 'success')
  check('服务器条目升级成对象', readConfig().mcp.servers.exa, { tools: { search: 'off' } })
}
{
  const assembly = { tools: toolNames.map((name) => ({ name, description: '' })) }
  listeners.get('system-prompt/assemble')(assembly, {}, () => Promise.resolve(assembly))
  check('只隐藏 search 一个', assembly.tools.map((t) => t.name), ['Bash', 'mcp__exa__crawl', 'mcp__context7__resolve'])
}
{
  const r = await run('mcp')
  check('mcp 列出逐工具', r.text.includes('search'), true)
}
{
  const r = await run('set skills.dataviz=off')
  check('skill 写入', r.kind, 'success')
  const preStep = listeners.get('agent/pre-step')
  const catalogMsg = {
    content: [{ type: 'text', text: '<system-reminder>old</system-reminder>' }],
    source: {
      kind: 'skill-catalog', form: 'catalog', update: true,
      entries: [{ name: 'dataviz', description: 'd' }, { name: 'caveman', description: 'c' }],
    },
  }
  const out = await preStep({ agent: null, messages: [] }, async () => ({ messages: [catalogMsg] }))
  const kept = out.messages[0].source.entries.map((e) => e.name)
  check('目录重写：去掉已关闭的 skill', kept, ['caveman'])
  check('目录重写：标记为完整替换', out.messages[0].source.update, true)
  check('目录重写：文本重新生成', out.messages[0].content[0].text.includes('<available_skills>'), true)
  check('目录重写：不再包含 dataviz', out.messages[0].content[0].text.includes('dataviz'), false)
}
{
  const r = await run('set bogus.x=1')
  check('未知分组报错', r.kind, 'error')
}

console.log('\nWeb API')
{
  const { data: body } = await json('state')
  check('skills 含目录项与影子', body.skills.length >= 2, true)
  const exa = body.mcp.servers.find((s) => s.name === 'exa')
  check('服务器列出工具', exa.tools.map((t) => t.name).sort(), ['crawl', 'search'])
  check('逐工具状态可见', exa.tools.find((t) => t.name === 'search').state, 'off')
  check('逐工具标记隐藏', exa.tools.find((t) => t.name === 'search').hidden, true)
  check('context7 未受影响', body.mcp.servers.find((s) => s.name === 'context7').tools[0].hidden, false)
}
{
  const res = await post('skill', { name: 'caveman', state: 'off' }, 'wrong')
  check('错 token 被拒', res.status, 403)
}
{
  const token = await getToken()
  const res = await post('tool', { server: 'context7', tool: 'resolve', state: 'off' }, token)
  check('tool 路由生效', res.status, 200)
  const body = res.data
  check('快照反映工具关闭', body.state.mcp.servers.find((s) => s.name === 'context7').tools[0].state, 'off')
}
{
  const token = await getToken()
  const res = await post('mcp', { server: 'exa', state: 'on' }, token)
  check('恢复服务器', res.status, 200)
}
{
  const res = await post('reload', {}, null)
  check('无 token 被拒', res.status, 403)
}

rmSync(home, { recursive: true, force: true })
rmSync(project, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
