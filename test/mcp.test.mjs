#!/usr/bin/env node
/** MCP 门禁测试：配置归一化、隐藏集合计算、装配期过滤。 */

import {
  serverOfTool, groupToolsByServer, bareToolName,
  normalizeServers, computeDisabled,
} from '../lib/core/mcp-policy.js'
import { createMcpFilter } from '../lib/platform/mcp-filter.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

console.log('工具名解析')
check('标准三段式', serverOfTool('mcp__exa__web_search_exa'), 'exa')
check('服务器名带连字符', serverOfTool('mcp__xiaohongshu-mcp__search'), 'xiaohongshu-mcp')
check('非 MCP 返回 undefined', serverOfTool('Bash'), undefined)
check('缺工具段返回 undefined', serverOfTool('mcp__exa'), undefined)
check('裸工具名', bareToolName('mcp__exa__web_search_exa'), 'web_search_exa')
{
  const grouped = groupToolsByServer(['Bash', 'mcp__exa__a', 'mcp__exa__b', 'mcp__c7__x'])
  check('归组', [...grouped.entries()], [['exa', ['mcp__exa__a', 'mcp__exa__b']], ['c7', ['mcp__c7__x']]])
}

console.log('\nnormalizeServers')
{
  const w = []
  const m = normalizeServers({ exa: 'off', c7: 'on' }, 'f.json', w)
  check('字符串形式', [...m.entries()].map(([k, v]) => [k, v.state]), [['exa', 'off'], ['c7', 'on']])
  check('无告警', w, [])
}
{
  const w = []
  const m = normalizeServers({ exa: { state: 'on', tools: { crawl: 'off', other: 'on' } } }, 'f.json', w)
  check('对象形式 state', m.get('exa').state, 'on')
  check('对象形式 tools', [...m.get('exa').tools.entries()], [['crawl', 'off'], ['other', 'on']])
  check('无告警', w, [])
}
{
  const w = []
  normalizeServers({ bad: 'disable', worse: 42, ok: { state: 'nope' } }, 'f.json', w)
  check('非法值全被拒', w.length, 3)
  check('告警列出可用状态', w[0].includes('on / deferred / off'), true)
}

console.log('\ncomputeDisabled')
{
  const names = ['Bash', 'mcp__exa__search', 'mcp__exa__crawl', 'mcp__c7__resolve']
  const servers = normalizeServers({ exa: 'off' }, 'f')
  const r = computeDisabled(names, servers)
  check('服务器 off → 全部工具隐藏', r.hidden, ['mcp__exa__crawl', 'mcp__exa__search'])
  check('未配置的服务器不隐藏', r.hidden.includes('mcp__c7__resolve'), false)
  check('发现两台服务器', r.servers, ['c7', 'exa'])
  check('无 pending', r.pending, [])
}
{
  const names = ['mcp__exa__search', 'mcp__exa__crawl']
  const servers = normalizeServers({ exa: { tools: { crawl: 'off' } } }, 'f')
  const r = computeDisabled(names, servers)
  check('逐工具 off 只隐藏那一个', r.hidden, ['mcp__exa__crawl'])
}
{
  const servers = normalizeServers({ exa: 'off' }, 'f')
  const r = computeDisabled(['mcp__c7__x'], servers)
  check('服务器未连上时进 pending', r.pending, ['exa'])
  check('pending 时不误隐藏别的服务器', r.hidden, [])
}
{
  const servers = normalizeServers({ exa: { tools: { ghost: 'off' } } }, 'f')
  const r = computeDisabled(['mcp__exa__search'], servers)
  check('逐工具名字不存在时进 pending', r.pending, ['exa.ghost'])
}

console.log('\ncreateMcpFilter.filter')
{
  let servers = normalizeServers({ exa: 'off' }, 'f')
  const filter = createMcpFilter({ ctx: {}, getServers: () => servers })
  const assembly = {
    tools: [
      { name: 'Bash', description: '' },
      { name: 'mcp__exa__search', description: '' },
      { name: 'mcp__c7__resolve', description: '' },
    ],
  }
  const filtered = filter.filter(assembly)
  check('隐藏了 1 个', filtered, 1)
  check('装配里只剩非 exa 工具', assembly.tools.map((t) => t.name), ['Bash', 'mcp__c7__resolve'])
  check('报告记录隐藏项', filter.status().hidden, ['mcp__exa__search'])
}
{
  const servers = new Map()
  const filter = createMcpFilter({ ctx: {}, getServers: () => servers })
  const assembly = { tools: [{ name: 'mcp__exa__search' }] }
  check('没有配置时不动装配', filter.filter(assembly), 0)
  check('工具原样保留', assembly.tools.length, 1)
}
{
  const servers = normalizeServers({ exa: 'off' }, 'f')
  const filter = createMcpFilter({ ctx: {}, getServers: () => servers })
  check('装配缺 tools 字段时安全返回', filter.filter({}), 0)
  check('assembly 为 null 时安全返回', filter.filter(null), 0)
}

console.log('')
console.log('deferred（延迟加载）')
{
  const servers = normalizeServers({ exa: 'deferred', c7: { state: 'deferred', tools: { resolve: 'off' } } }, 'f')
  const filter = createMcpFilter({ ctx: {}, getServers: () => servers })
  const assembly = {
    tools: [
      { name: 'Bash', description: '' },
      { name: 'gate_mcp_search', description: '' },
      { name: 'gate_mcp_call', description: '' },
      { name: 'mcp__exa__search', description: '语义搜索' },
      { name: 'mcp__exa__crawl', description: '抓网页' },
      { name: 'mcp__c7__resolve', description: '解析文档' },
    ],
  }
  const removed = filter.filter(assembly)
  check('延迟工具也被摘掉', assembly.tools.map((t) => t.name), ['Bash', 'gate_mcp_search', 'gate_mcp_call'])
  check('移除计数只算真移除', removed, 3)
  check('报告区分延迟与关闭', [filter.status().deferred.slice().sort(), filter.status().hidden], [['mcp__exa__crawl', 'mcp__exa__search'], ['mcp__c7__resolve']])
  check('索引只收延迟工具', [...filter.index().keys()].sort(), ['mcp__exa__crawl', 'mcp__exa__search'])
  check('索引带描述', filter.index().get('mcp__exa__crawl').description, '抓网页')
  check('有延迟工具时中间层可见', filter.status().gateVisible, true)
}
{
  const servers = normalizeServers({ exa: 'on' }, 'f')
  const filter = createMcpFilter({ ctx: {}, getServers: () => servers })
  const assembly = { tools: [{ name: 'gate_mcp_search' }, { name: 'gate_mcp_call' }, { name: 'mcp__exa__search' }] }
  const removed = filter.filter(assembly)
  check('没有延迟工具时中间层不占位', assembly.tools.map((t) => t.name), ['mcp__exa__search'])
  check('移除两个中间层工具', removed, 2)
  check('索引为空', filter.index().size, 0)
  check('gateVisible 为 false', filter.status().gateVisible, false)
}
{
  const servers = normalizeServers({ exa: { state: 'deferred', tools: { crawl: 'off' } } }, 'f')
  const filter = createMcpFilter({ ctx: {}, getServers: () => servers })
  filter.filter({ tools: [{ name: 'mcp__exa__crawl' }, { name: 'mcp__exa__search' }] })
  check('延迟服务器里被关掉的工具不可搜', [...filter.index().keys()], ['mcp__exa__search'])
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
