#!/usr/bin/env node
/** MCP 连接定义：校验归一化、CC 初稿、探测用的映射。 */

import {
  normalizeDefinition, templateFromCc, probeInfoFromConfig,
} from '../lib/core/mcp-definition.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}
function throws(label, fn, needle) {
  let message = null
  try { fn() } catch (error) { message = error.message }
  check(label, Boolean(message) && message.includes(needle), true)
}

console.log('stdio')
{
  const config = normalizeDefinition({ serverName: 'context7', command: 'cmd', args: ['/c', 'npx'] })
  check('默认 transport 是 stdio', config.transport, 'stdio')
  check('保留 command / args', [config.command, config.args], ['cmd', ['/c', 'npx']])
  check('env 缺省为空对象', config.env, {})
  check('没给 cwd 就不加', 'cwd' in config, false)
}
{
  const config = normalizeDefinition({
    transport: 'stdio', serverName: 'x', command: ' node ', args: [], env: { A: '1' }, cwd: 'D:/w', toolCallTimeoutMs: 5000,
  })
  check('command 去空白', config.command, 'node')
  check('env 原样', config.env, { A: '1' })
  check('cwd 保留', config.cwd, 'D:/w')
  check('超时保留', config.toolCallTimeoutMs, 5000)
}

console.log('\nstreamable-http')
{
  const config = normalizeDefinition({ serverName: 'exa', url: 'https://mcp.exa.ai/mcp', headers: { Authorization: 'Bearer x' } })
  check('有 url 时默认走 http', config.transport, 'streamable-http')
  check('headers 保留', config.headers, { Authorization: 'Bearer x' })
}
{
  check('http 别名归一', normalizeDefinition({ serverName: 'a', transport: 'http', url: 'https://x' }).transport, 'streamable-http')
  check('sse 别名归一', normalizeDefinition({ serverName: 'a', transport: 'sse', url: 'https://x' }).transport, 'streamable-http')
}

console.log('\n校验')
{
  throws('缺 serverName', () => normalizeDefinition({ command: 'x' }), 'serverName')
  throws('serverName 太长', () => normalizeDefinition({ serverName: 'a'.repeat(33), command: 'x' }), 'serverName')
  throws('serverName 含非法字符', () => normalizeDefinition({ serverName: 'a b', command: 'x' }), 'serverName')
  throws('未知 transport', () => normalizeDefinition({ serverName: 'a', transport: 'grpc' }), 'transport')
  throws('stdio 缺 command', () => normalizeDefinition({ serverName: 'a', transport: 'stdio' }), 'command')
  throws('http 缺 url', () => normalizeDefinition({ serverName: 'a', transport: 'streamable-http' }), 'url')
  throws('url 非 http', () => normalizeDefinition({ serverName: 'a', url: 'ftp://x' }), 'url')
  throws('args 非字符串数组', () => normalizeDefinition({ serverName: 'a', command: 'x', args: [1] }), 'args')
  throws('env 值不是字符串', () => normalizeDefinition({ serverName: 'a', command: 'x', env: { A: 1 } }), 'env.A')
  throws('headers 不是对象', () => normalizeDefinition({ serverName: 'a', url: 'https://x', headers: [] }), 'headers')
  throws('超时非正整数', () => normalizeDefinition({ serverName: 'a', command: 'x', toolCallTimeoutMs: 1.5 }), 'toolCallTimeoutMs')
  throws('输入不是对象', () => normalizeDefinition(null), 'JSON 对象')
}

console.log('\n丢弃不认识的键')
{
  const config = normalizeDefinition({ serverName: 'a', command: 'x', bogus: 1, type: 'stdio' })
  check('不认识的键不进 config', Object.keys(config).sort(), ['args', 'command', 'env', 'serverName', 'transport'])
}

console.log('\ntemplateFromCc')
{
  check('CC 的 http 定义 → streamable-http',
    templateFromCc('exa', { type: 'http', url: 'https://x/mcp', headers: { H: '1' } }),
    { transport: 'streamable-http', serverName: 'exa', url: 'https://x/mcp', headers: { H: '1' } })
  check('CC 的 command 定义 → stdio',
    templateFromCc('context7', { type: 'stdio', command: 'cmd', args: ['/c'] }),
    { transport: 'stdio', serverName: 'context7', command: 'cmd', args: ['/c'] })
  check('没有定义时给空 stdio 模板',
    templateFromCc('ghost', undefined),
    { transport: 'stdio', serverName: 'ghost', command: '', args: [] })
}

console.log('\nprobeInfoFromConfig')
{
  check('http 配置 → url/headers',
    probeInfoFromConfig({ transport: 'streamable-http', url: 'https://x', headers: { A: 'b' } }),
    { url: 'https://x', headers: { A: 'b' } })
  check('stdio 配置 → command/args/env',
    probeInfoFromConfig({ transport: 'stdio', command: 'node', args: ['a'], env: { B: '2' } }),
    { command: 'node', args: ['a'], env: { B: '2' } })
  check('看不懂的配置返回 undefined', probeInfoFromConfig({ transport: 'streamable-http' }), undefined)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
