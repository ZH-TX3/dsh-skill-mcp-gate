#!/usr/bin/env node
/** .mcp.json 的形状转换：DSH config ↔ Claude Code mcpServers 条目。 */

import { toCcServer, serversOf, withServer, withoutServer } from '../lib/cc/mcp-json.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

const section = (title) => { console.log(''); console.log(title) }

section('toCcServer')
{
  check('stdio 形状', toCcServer({ transport: 'stdio', serverName: 'x', command: 'cmd', args: ['/c'], env: { A: '1' } }),
    { type: 'stdio', command: 'cmd', args: ['/c'], env: { A: '1' } })
  check('http 形状', toCcServer({ transport: 'streamable-http', serverName: 'x', url: 'https://a', headers: { H: '1' } }),
    { type: 'http', url: 'https://a', headers: { H: '1' } })
  check('空 args/env', toCcServer({ transport: 'stdio', serverName: 'x', command: 'node', args: [], env: {} }),
    { type: 'stdio', command: 'node', args: [] })
}

section('withServer / withoutServer')
{
  const base = { mcpServers: { a: { type: 'http', url: 'https://a' } }, other: { keep: true } }
  const added = withServer(base, 'b', { transport: 'stdio', serverName: 'b', command: 'node', args: ['x'] })
  check('新增保留其它服务器', Object.keys(added.mcpServers).sort(), ['a', 'b'])
  check('保留文件里的其它键', added.other, { keep: true })
  check('原文档不被修改', Object.keys(base.mcpServers), ['a'])
  check('删掉一条', Object.keys(withoutServer(added, 'a').mcpServers), ['b'])
  check('删不存在的返回 undefined', withoutServer(added, 'zzz'), undefined)
}
{
  check('空文档也能加',
    Object.keys(withServer(undefined, 'x', { transport: 'stdio', serverName: 'x', command: 'node', args: [] }).mcpServers), ['x'])
  check('serversOf 容错', serversOf({ mcpServers: [] }), {})
  const last = withServer({ mcpServers: { only: {} } }, 'only', { transport: 'stdio', serverName: 'only', command: 'x', args: [] })
  check('最后一条删掉后移除键', withoutServer(last, 'only').mcpServers, undefined)
}

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
