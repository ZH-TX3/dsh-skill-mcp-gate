#!/usr/bin/env node
/** 目录门禁：消息重写与调用期拦截（plan 由调用方给）。 */

import { renderCatalogUpdate, catalogEntriesOf, createCatalogGate } from '../lib/platform/catalog.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

console.log('renderCatalogUpdate')
{
  const out = renderCatalogUpdate([{ name: 'a', description: 'A' }, { name: 'b', description: '<x>' }])
  check('source 标记为 catalog/update', [out.source.kind, out.source.form, out.source.update], ['skill-catalog', 'catalog', true])
  check('source 带 entries', out.source.entries.map((e) => e.name), ['a', 'b'])
  check('文本含 available_skills', out.text.includes('<available_skills>'), true)
  check('条目格式', out.text.includes('- `a`: A'), true)
  check('描述被转义', out.text.includes('&lt;x&gt;'), true)
  check('替换语义文案', out.text.includes('replaces every earlier available-skills list'), true)
}
{
  const out = renderCatalogUpdate([], new Set(['a']))
  check('空目录给出停用提示', out.text.includes('No skills are currently available'), true)
}

console.log('\ncatalogEntriesOf')
{
  check('非目录消息返回 undefined', catalogEntriesOf({ content: [] }), undefined)
  check('有 entries 时返回', catalogEntriesOf({ source: { kind: 'skill-catalog', entries: [{ name: 'a' }] } }).length, 1)
}

console.log('\n门禁行为')
{
  const listeners = new Map()
  const guards = []
  const ctx = {
    on: (event, fn) => { listeners.set(event, fn); return () => {} },
    tools: { guard: (fn) => { guards.push(fn); return () => {} } },
  }
  const plan = { hide: new Set(['dataviz', 'caveman']), nameOnly: new Set(['brainstorming']) }
  const calls = []
  const gate = createCatalogGate({ ctx, getPlan: (entries) => { calls.push(entries.length); return plan } })
  gate.install()

  const preStep = listeners.get('agent/pre-step')
  check('注册了 pre-step 监听', typeof preStep, 'function')
  check('注册了 tool guard', guards.length, 1)

  const catalog = {
    content: [{ type: 'text', text: 'old' }],
    source: {
      kind: 'skill-catalog', form: 'catalog', update: true,
      entries: [
        { name: 'dataviz', description: 'd' },
        { name: 'caveman', description: 'c' },
        { name: 'brainstorming', description: '定方向用' },
        { name: 'karpathy-guidelines', description: 'k' },
      ],
    },
  }
  const out = await preStep({}, async () => ({ messages: [catalog] }))
  check('plan 拿到的是这条消息的条目', calls[0], 4)
  check('隐藏项被剔除', out.messages[0].source.entries.map((e) => e.name), ['brainstorming', 'karpathy-guidelines'])
  check('描述记录保持不变（官方按它算摘要）', out.messages[0].source.entries[0].description, '定方向用')
  check('文本同步重写', out.messages[0].content[0].text.includes('dataviz'), false)
  check('name-only 只留名字', out.messages[0].content[0].text.includes('- `brainstorming`'), true)
  check('name-only 不带描述', out.messages[0].content[0].text.includes('定方向用'), false)
  check('其余条目仍有描述', out.messages[0].content[0].text.includes('- `karpathy-guidelines`: k'), true)
  check('非目录消息原样保留', (await preStep({}, async () => ({ messages: [{ content: [{ type: 'text', text: 'hi' }] }] }))).messages[0].content[0].text, 'hi')
  check('reject 决策直通', (await preStep({}, async () => ({ kind: 'reject' }))).kind, 'reject')

  check('guard 拒绝已隐藏 skill', guards[0]({ name: 'skill', arguments: { name: 'dataviz' } }).includes('skill-mcp-gate'), true)
  check('guard 放行 name-only（仍可调用）', guards[0]({ name: 'skill', arguments: { name: 'brainstorming' } }), undefined)
  check('guard 放行正常 skill', guards[0]({ name: 'skill', arguments: { name: 'karpathy-guidelines' } }), undefined)
  check('guard 放行其它工具', guards[0]({ name: 'Bash', arguments: {} }), undefined)
  check('guard 容错无参数', guards[0]({ name: 'skill' }), undefined)

  gate.dispose()
}

console.log('\n容错')
{
  const gate = createCatalogGate({ ctx: {}, getPlan: () => ({ hide: new Set(), nameOnly: new Set() }) })
  gate.install()
  check('无 on() 时记录错误而不抛', gate.status().errors.length, 1)
}
{
  const listeners = new Map()
  const ctx = {
    on: (event, fn) => { listeners.set(event, fn); return () => {} },
    tools: { guard: () => () => {} },
  }
  const gate = createCatalogGate({ ctx, getPlan: () => { throw new Error('plan boom') } })
  gate.install()
  const catalog = { content: [{ type: 'text', text: 'x' }], source: { kind: 'skill-catalog', entries: [{ name: 'a', description: 'A' }] } }
  const out = await listeners.get('agent/pre-step')({}, async () => ({ messages: [catalog] }))
  check('plan 抛错时原样放行', out.messages[0].content[0].text, 'x')
  check('错误被记录', gate.status().errors.some((e) => e.reason.includes('plan boom')), true)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
