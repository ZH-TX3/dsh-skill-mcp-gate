#!/usr/bin/env node
/** CC 的 MCP 定义源与批准状态：user / local / project 三个作用域 + 拒绝语义。 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readClaudeMcp, buildBaseline, normalizeCwd } from '../lib/cc/mcp.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

const home = mkdtempSync(join(tmpdir(), 'gate-cc-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'gate-cc-proj-'))

function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

// ~/.claude.json：user scope + 按项目路径存的 local scope（键写成反斜杠，验归一化）
writeJson(join(home, '.claude.json'), {
  mcpServers: { exa: { command: 'x' }, context7: { command: 'y' } },
  projects: {
    [cwd.replace(/\//g, '\\').toUpperCase()]: { mcpServers: { 'chrome-devtools': { command: 'z' } } },
    'D:/other/project': { mcpServers: { ignored: { command: 'w' } } },
  },
})
// <cwd>/.mcp.json：project scope
writeJson(join(cwd, '.mcp.json'), { mcpServers: { filesystem: { command: 'f' }, github: { command: 'g' } } })
// 用户设置：批准 github，拒绝 exa
writeJson(join(home, '.claude', 'settings.json'), {
  enabledMcpjsonServers: ['github'],
  disabledMcpjsonServers: ['exa'],
})
// 项目本地设置：整批批准 + 再拒绝 filesystem（拒绝优先级最高）
writeJson(join(cwd, '.claude', 'settings.local.json'), {
  enableAllProjectMcpServers: true,
  disabledMcpjsonServers: ['filesystem'],
})

console.log('normalizeCwd')
{
  check('反斜杠 + 大写 + 尾斜杠归一', normalizeCwd('D:\\Work\\App\\'), 'd:/work/app')
  check('空值', normalizeCwd(''), null)
}

const warnings = []
const cc = readClaudeMcp({ cwd, home, warnings })

console.log('\n作用域')
{
  check('user scope 收到', cc.servers.get('exa').scope, 'user')
  check('local scope 按路径匹配（大小写/斜杠无关）', cc.servers.get('chrome-devtools').scope, 'local')
  check('别的项目不混进来', cc.servers.has('ignored'), false)
  // `<cwd>/.mcp.json` 现在由本插件按「项目定义」处理，不再算「仅 CC 声明」
  check('项目 .mcp.json 不进 CC 基线', cc.servers.has('filesystem'), false)
  check('服务器总数', [...cc.servers.keys()].sort(), ['chrome-devtools', 'context7', 'exa'])
  check('读到的文件数（不含 .mcp.json）', cc.files.length, 3)
  check('无警告', warnings, [])
}

console.log('\n批准语义')
{
  check('enableAll 生效（最高层胜出）', cc.enableAll, true)
  check('user 作用域不需要批准', cc.servers.get('exa').approved, false) // 被拒绝 → 不批准
  check('local 作用域默认批准', cc.servers.get('chrome-devtools').approved, true)
  check('disabled 名单仍然被读进来', cc.disabled.has('filesystem'), true)
  check('enabled 名单仍然被读进来', cc.enabled.has('github'), true)
}

console.log('\n归一化到基线层')
{
  const baseline = buildBaseline(cc)
  check('被 CC 拒绝的默认 off', baseline.get('exa').state, 'off')
  check('其余默认 on', baseline.get('context7').state, 'on')
  check('基线层标记', baseline.get('context7').layer, 'cc')
  check('基线带作用域', baseline.get('context7').ccScope, 'user')
  check('空输入返回空表', buildBaseline(null).size, 0)
}

console.log('\n同名覆盖（越具体越优先）')
{
  const h2 = mkdtempSync(join(tmpdir(), 'gate-cc-home2-'))
  const c2 = mkdtempSync(join(tmpdir(), 'gate-cc-proj2-'))
  writeJson(join(h2, '.claude.json'), { mcpServers: { shared: {} } })
  check('只有 user 声明时是 user', readClaudeMcp({ cwd: c2, home: h2 }).servers.get('shared').scope, 'user')
  // local 更具体，但要它存在才有意义：单独验一次
  const h3 = mkdtempSync(join(tmpdir(), 'gate-cc-home3-'))
  const c3 = mkdtempSync(join(tmpdir(), 'gate-cc-proj3-'))
  writeJson(join(h3, '.claude.json'), {
    mcpServers: { shared: {} },
    projects: { [normalizeCwd(c3)]: { mcpServers: { shared: {} } } },
  })
  check('local 压过 user', readClaudeMcp({ cwd: c3, home: h3 }).servers.get('shared').scope, 'local')
  rmSync(h2, { recursive: true, force: true })
  rmSync(c2, { recursive: true, force: true })
  rmSync(h3, { recursive: true, force: true })
  rmSync(c3, { recursive: true, force: true })
}

console.log('\n容错')
{
  const h4 = mkdtempSync(join(tmpdir(), 'gate-cc-home4-'))
  writeFileSync(join(h4, '.claude.json'), '{ oops', 'utf8')
  const w4 = []
  const out = readClaudeMcp({ cwd: null, home: h4, warnings: w4 })
  check('坏 JSON 不抛，只记警告', out.servers.size, 0)
  check('警告里点名文件', w4.some((w) => w.includes('.claude.json')), true)
  check('没有 cwd 也能跑', out.files.length, 0)
  rmSync(h4, { recursive: true, force: true })
}

rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
