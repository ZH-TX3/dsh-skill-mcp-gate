#!/usr/bin/env node
/** 中间层：延迟 MCP 工具的搜索与嵌套调用（假 ctx，不启动 DSH）。 */

import { createGateTools, projectContent } from '../lib/platform/gate-tools.js'
import { GATE_CALL, GATE_SEARCH, describeEntry, matchTools, resolveToolName } from '../lib/core/tool-search.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

console.log('纯函数')
{
  const entries = [
    { name: 'mcp__exa__crawl', server: 'exa', bare: 'crawl', description: '抓取网页并返回正文' },
    { name: 'mcp__exa__search', server: 'exa', bare: 'search', description: '语义搜索互联网' },
    { name: 'mcp__ctx7__resolve', server: 'ctx7', bare: 'resolve', description: '解析库文档 id' },
  ]
  check('无关键词返回全部', matchTools(entries, {}).total, 3)
  check('按名字命中', matchTools(entries, { query: 'crawl' }).shown.map((e) => e.bare), ['crawl'])
  check('按描述命中（中文）', matchTools(entries, { query: '文档' }).shown.map((e) => e.name), ['mcp__ctx7__resolve'])
  check('多词必须全中', matchTools(entries, { query: 'exa crawl' }).total, 1)
  check('server 过滤', matchTools(entries, { server: 'exa' }).total, 2)
  check('命中数可大于展示数', matchTools(entries, { limit: 1 }).total, 3)
  check('展示受 limit 约束', matchTools(entries, { limit: 1 }).shown.length, 1)
  check('描述截断', describeEntry({ name: 'a', description: 'x'.repeat(200) }).endsWith('…'), true)

  const known = new Map(entries.map((e) => [e.name, e]))
  check('全名解析', resolveToolName('mcp__exa__crawl', known).name, 'mcp__exa__crawl')
  check('简写解析', resolveToolName('exa.crawl', known).name, 'mcp__exa__crawl')
  check('未知名字给提示', resolveToolName('nope', known).error.includes(GATE_SEARCH), true)
  check('不许调用自己', resolveToolName(GATE_CALL, known).error.includes('自己'), true)
  check('空名字报错', resolveToolName('', known).error, '缺少工具名')
}

console.log('\n结果投影')
{
  check('纯文本拼接', projectContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\n\nb')
  check('非文本明确说明', projectContent([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'image' }]),
    'a\n\n[未转发的非文本内容：image×2]')
  check('只有非文本', projectContent([{ type: 'image' }]), '[未转发的非文本内容：image×1]')
  check('空内容', projectContent(undefined), '')
}

function makeCtx({ state = 'deferred', execute } = {}) {
  const registered = []
  const calls = []
  const ctx = {
    tools: {
      register: (tool) => { registered.push(tool); return () => {} },
      execute: async (input) => {
        calls.push(input)
        return execute ? execute(input) : { isError: false, content: [{ type: 'text', text: 'NESTED-OK' }] }
      },
    },
  }
  return { ctx, registered, calls, serverState: state }
}

async function main() {
  console.log('\n注册')
  {
    const { ctx, registered } = makeCtx()
    const index = new Map([['mcp__exa__crawl', { name: 'mcp__exa__crawl', server: 'exa', bare: 'crawl', description: '抓网页' }]])
    const servers = new Map([['exa', { state: 'deferred', tools: new Map() }]])
    const gate = createGateTools({ ctx, getIndex: () => index, getServers: () => servers })
    gate.install()
    check('注册两个工具', registered.map((t) => t.name), [GATE_SEARCH, GATE_CALL])
    check('参数是 JSON Schema', registered[0].parameters.type, 'object')
    check('声明了输出契约', typeof registered[0].output.render, 'function')
    check('渲染出一条文本块', registered[0].output.render({}, { total: 1, text: 'hi' }), [{ type: 'text', text: 'hi' }])
  }

  console.log('\n搜索')
  {
    const { ctx, registered } = makeCtx()
    const servers = new Map([['exa', { state: 'deferred', tools: new Map() }]])
    let index = new Map()
    const gate = createGateTools({ ctx, getIndex: () => index, getServers: () => servers })
    gate.install()
    const search = registered.find((t) => t.name === GATE_SEARCH)

    const empty = await search.execute({})
    check('空索引给引导话术', empty.text.includes('deferred'), true)

    index = new Map([
      ['mcp__exa__crawl', { name: 'mcp__exa__crawl', server: 'exa', bare: 'crawl', description: '抓取网页' }],
      ['mcp__exa__search', { name: 'mcp__exa__search', server: 'exa', bare: 'search', description: '搜索' }],
    ])
    const all = await search.execute({})
    check('无关键词列全部', all.total, 2)
    check('结果里带可调用提示', all.text.includes(GATE_CALL), true)
    const one = await search.execute({ query: 'crawl' })
    check('关键词收敛', one.total, 1)
    const miss = await search.execute({ query: 'zzz' })
    check('无命中给替代动作', miss.text.includes('换个关键词'), true)
  }

  console.log('\n调用')
  {
    const { ctx, registered, calls } = makeCtx()
    const servers = new Map([['exa', { state: 'deferred', tools: new Map() }]])
    const index = new Map([['mcp__exa__crawl', { name: 'mcp__exa__crawl', server: 'exa', bare: 'crawl', description: '抓网页' }]])
    const gate = createGateTools({ ctx, getIndex: () => index, getServers: () => servers })
    gate.install()
    const call = registered.find((t) => t.name === GATE_CALL)
    const exec = { callId: 'call-1', rootCallId: 'root-1', token: 'TOKEN', agent: { id: 'a' }, signal: 'SIG' }

    const ok = await call.execute({ name: 'exa.crawl', arguments: { url: 'https://x' } }, exec)
    check('简写能调通', ok.ok, true)
    check('结果文本转发', ok.text, 'NESTED-OK')
    check('异步未被误判为错误', ok.isError, false)
    check('嵌套调用带 parent（PTC 下才算嵌套）', calls[0].parent, 'TOKEN')
    check('继承 rootCallId 与 agent', [calls[0].rootCallId, calls[0].agent.id], ['root-1', 'a'])
    check('取消信号贯通', calls[0].signal, 'SIG')
    check('callId 可追踪', calls[0].callId.startsWith('call-1'), true)
    check('参数原样传下去', calls[0].arguments, { url: 'https://x' })

    const unknown = await call.execute({ name: 'nope' }, exec)
    check('未知名字拒绝', unknown.ok, false)
    check('并提示先搜索', unknown.text.includes(GATE_SEARCH), true)

    servers.set('exa', { state: 'off', tools: new Map() })
    const off = await call.execute({ name: 'exa.crawl' }, exec)
    check('关闭的服务器不透露细节', off.text.includes('已被关闭'), true)

    servers.set('exa', { state: 'on', tools: new Map() })
    const on = await call.execute({ name: 'exa.crawl' }, exec)
    check('已直接可用时明确指路', on.text.includes('直接调用'), true)

    servers.set('exa', { state: 'deferred', tools: new Map() })
    const self = await call.execute({ name: GATE_CALL }, exec)
    check('不许自调用', self.text.includes('自己'), true)
  }

  console.log('\n嵌套失败与异常')
  {
    const { ctx, registered } = makeCtx({ execute: async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }) })
    const servers = new Map([['exa', { state: 'deferred', tools: new Map() }]])
    const index = new Map([['mcp__exa__crawl', { name: 'mcp__exa__crawl', server: 'exa', bare: 'crawl', description: '' }]])
    const gate = createGateTools({ ctx, getIndex: () => index, getServers: () => servers })
    gate.install()
    const call = registered.find((t) => t.name === GATE_CALL)
    const failed = await call.execute({ name: 'mcp__exa__crawl' }, { callId: 'c' })
    check('失败如实透出', [failed.ok, failed.isError], [false, true])
    check('失败文本不丢', failed.text, 'boom')

    const { ctx: ctx2, registered: reg2 } = makeCtx({ execute: async () => { throw new Error('dispatch boom') } })
    const gate2 = createGateTools({ ctx: ctx2, getIndex: () => index, getServers: () => servers })
    gate2.install()
    const call2 = reg2.find((t) => t.name === GATE_CALL)
    const caught = await call2.execute({ name: 'mcp__exa__crawl' }, { callId: 'c' })
    check('异常被兜住并回话', caught.text.includes('dispatch boom'), true)
    check('错误进 status', gate2.status().errors.some((e) => e.reason.includes('dispatch boom')), true)
  }

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
