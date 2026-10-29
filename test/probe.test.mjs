#!/usr/bin/env node
/** 探测：计划（纯）+ 真探测（本地 http server / PATH 查找）。 */

import { createServer } from 'node:http'
import { planProbe, expandEnv } from '../lib/core/probe.js'
import { runProbe, resolveCommand } from '../lib/platform/probe.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

console.log('expandEnv')
{
  check('替换已存在的变量', expandEnv('Bearer ${TOK}', { TOK: 'abc' }), 'Bearer abc')
  check('用默认值', expandEnv('${MISSING:-fallback}', {}), 'fallback')
  check('缺失且无默认值保留原样', expandEnv('${MISSING}', {}), '${MISSING}')
  check('非字符串原样返回', expandEnv(undefined, {}), undefined)
}

console.log('\nplanProbe')
{
  check('有 url → http', planProbe({ definition: { url: 'https://x/mcp' } }).mode, 'http')
  check('url 里的变量被展开', planProbe({ definition: { url: 'https://${H}/mcp' }, env: {} }).url, 'https://${H}/mcp')
  const withHeaders = planProbe({ definition: { url: 'https://x', headers: { Authorization: 'Bearer ${TOK}', X: 1 } } })
  check('只展开字符串 header', withHeaders.headers.X, undefined)
  check('有 command → stdio', planProbe({ definition: { command: 'npx', args: ['-y', 'pkg'] } }).mode, 'stdio')
  check('stdio 带 args', planProbe({ definition: { command: 'npx', args: ['-y'] } }).args, ['-y'])
  const connected = planProbe({ connected: true })
  check('已连上但没定义 → unknown 并解释', connected.mode === 'unknown' && connected.reason.includes('DSH profile'), true)
  const ccOnly = planProbe({ ccScope: 'user' })
  check('CC 有声明没定义 → unknown', ccOnly.reason.includes('Claude Code'), true)
  check('只有名字 → unknown', planProbe({}).reason.includes('只在本插件'), true)
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

async function main() {
  const server = createServer((req, res) => { res.statusCode = 405; res.end('no GET') })
  const port = await listen(server)
  const url = `http://127.0.0.1:${port}/mcp`

  console.log('\nrunProbe · http')
  {
    const ok = await runProbe({ definition: { url } })
    check('能收到响应就算可达（405 也算）', [ok.mode, ok.ok, ok.status], ['http', true, 405])
    check('带耗时', /ms$/.test(ok.detail), true)

    const dead = await runProbe({ definition: { url: 'http://127.0.0.1:1/mcp' } }, { timeoutMs: 1500 })
    check('连不上要如实说不可达', dead.ok, false)
    check('给出原因而不是空字符串', dead.detail.length > 0, true)

    const timeout = await runProbe({ definition: { url: 'http://10.255.255.1:9/mcp' } }, { timeoutMs: 300 })
    check('超时被兜住', timeout.ok, false)
  }

  console.log('\nrunProbe · stdio')
  {
    check('PATH 里有 node', Boolean(resolveCommand('node')), true)
    const found = await runProbe({ definition: { command: 'node' } })
    check('命令存在 → 可执行', found.ok, true)
    check('明确说明没启动进程', found.detail.includes('未启动进程'), true)

    const missing = await runProbe({ definition: { command: 'definitely-not-a-real-cmd-xyz' } })
    check('命令不存在 → 不可执行', missing.ok, false)
    check('明确说明没尝试启动', missing.detail.includes('未尝试启动'), true)
  }

  console.log('\nrunProbe · 无定义')
  {
    const unknown = await runProbe({})
    check('unknown 模式', unknown.mode, 'unknown')
    check('带原因', unknown.reason.length > 0, true)
  }

  await new Promise((resolve) => server.close(resolve))
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
