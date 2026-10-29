import io

# ---------- 新测试：cc/mcp-json 纯变换 ----------
p = 'test/mcp-json.test.mjs'
io.open(p, 'w', encoding='utf-8', newline='').write('''#!/usr/bin/env node
/** .mcp.json 的形状转换：DSH config ↔ Claude Code mcpServers 条目。 */

import { toCcServer, serversOf, withServer, withoutServer } from '../lib/cc/mcp-json.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\\n      期望 ${e}\\n      实际 ${a}`)
}

console.log('toCcServer')
{
  check('stdio 形状', toCcServer({ transport: 'stdio', serverName: 'x', command: 'cmd', args: ['/c'], env: { A: '1' } }),
    { type: 'stdio', command: 'cmd', args: ['/c'], env: { A: '1' } })
  check('http 形状', toCcServer({ transport: 'streamable-http', serverName: 'x', url: 'https://a', headers: { H: '1' } }),
    { type: 'http', url: 'https://a', headers: { H: '1' } })
  check('空 args/env 不写进去', toCcServer({ transport: 'stdio', serverName: 'x', command: 'node', args: [], env: {} }),
    { type: 'stdio', command: 'node', args: [] })
}

console.log('\\nwithServer / withoutServer')
{
  const base = { mcpServers: { a: { type: 'http', url: 'https://a' } }, other: { keep: true } }
  const added = withServer(base, 'b', { transport: 'stdio', serverName: 'b', command: 'node', args: ['x'] })
  check('新增保留其它服务器', Object.keys(added.mcpServers).sort(), ['a', 'b'])
  check('保留文件里的其它键', added.other, { keep: true })
  check('原文档不被修改', Object.keys(base.mcpServers), ['a'])

  const removed = withoutServer(added, 'a')
  check('删掉一条', Object.keys(removed.mcpServers), ['b'])
  check('删空的键会整体移除', Object.keys(withoutServer(added, 'a').mcpServers), ['b'])
  check('删不存在的返回 undefined', withoutServer(added, 'zzz'), undefined)
}
{
  check('空文档也能加', Object.keys(withServer(undefined, 'x', { transport: 'stdio', serverName: 'x', command: 'node', args: [] }).mcpServers), ['x'])
  check('serversOf 容错', serversOf({ mcpServers: [] }), {})
  const last = withServer({ mcpServers: { only: {} } }, 'only', { transport: 'stdio', serverName: 'only', command: 'x', args: [] })
  const after = withoutServer(last, 'only')
  check('最后一条删掉后移除 mcpServers 键', after.mcpServers, undefined)
}

console.log(failures === 0 ? '\\n全部通过' : `\\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
''', newline='')
print('mcp-json test written')

# ---------- middle-layer：切工作区要回收连接 ----------
p = 'test/middle-layer.test.mjs'
s = io.open(p, encoding='utf-8', newline='').read().replace('\r\n', '\n')

anchor = """rmSync(home, { recursive: true, force: true })"""
block = """console.log('切换工作区：只保留当前项目的连接')
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
  check('在本项目里建了一条连接', saved.body.state.mcp.connections.managed, ['switchTest'])
  check('运行期也只有它', loaderEntries.size, 1)

  const stateB = await getState(wsB)
  check('切到另一个项目后不再代管它', stateB.mcp.connections.managed, [])
  check('切走时连接被回收', loaderEntries.size, 0)
}

"""
assert s.count(anchor) == 1
s = s.replace(anchor, block + anchor, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s.replace('\n', '\r\n'))
print('middle-layer patched')

# ---------- package.json 加入新测试 ----------
p = 'package.json'
s = io.open(p, encoding='utf-8', newline='').read().replace('\r\n', '\n')
s = s.replace('node test/mcp-definition.test.mjs &&', 'node test/mcp-definition.test.mjs && node test/mcp-json.test.mjs &&')
s = s.replace('"version": "0.13.1"', '"version": "0.14.0"')
io.open(p, 'w', encoding='utf-8', newline='').write(s.replace('\n', '\r\n'))
print('package patched')
