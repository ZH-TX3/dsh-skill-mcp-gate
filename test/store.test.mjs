#!/usr/bin/env node
/** 配置文件写入测试：原子写、保留其它键、on 等于清除覆盖。 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setSkillState, setServerState, updateJsonFile, readJsonFile, removeServer, renameServer } from '../lib/io.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

const dir = mkdtempSync(join(tmpdir(), 'gate-store-'))
const file = join(dir, 'settings.json')
const read = () => JSON.parse(readFileSync(file, 'utf8'))

console.log('setSkillState')
{
  setSkillState(file, 'dataviz', 'off')
  check('新建文件并写入', read(), { skills: { dataviz: 'off' } })
}
{
  setSkillState(file, 'caveman', 'user-invocable-only')
  check('追加第二项', read().skills, { dataviz: 'off', caveman: 'user-invocable-only' })
}
{
  setSkillState(file, 'dataviz', 'on')
  check('设为 on 等于删除覆盖', read().skills, { caveman: 'user-invocable-only' })
}
{
  setSkillState(file, 'caveman', 'on')
  check('最后一项清除后删掉空 skills 块', read(), {})
}

console.log('\n保留无关键')
{
  writeFileSync(file, JSON.stringify({ mcp: { servers: { exa: 'off' } }, 自定义: 1 }), 'utf8')
  setSkillState(file, 'dataviz', 'off')
  const doc = read()
  check('mcp 块保留', doc.mcp, { servers: { exa: 'off' } })
  check('未知键保留', doc['自定义'], 1)
  check('skills 已写入', doc.skills, { dataviz: 'off' })
}

console.log('\nsetServerState')
{
  setServerState(file, 'xiaohongshu-mcp', 'off')
  check('写入服务器状态', read().mcp.servers, { exa: 'off', 'xiaohongshu-mcp': 'off' })
  setServerState(file, 'xiaohongshu-mcp', 'on')
  check('on 等于删除', read().mcp.servers, { exa: 'off' })
}

console.log('\n别名兼容')
{
  writeFileSync(file, JSON.stringify({ skillOverrides: { old: 'off' } }), 'utf8')
  setSkillState(file, 'old', 'on')
  check('能清掉 skillOverrides 里的同名项', read(), {})
}

console.log('\n安全边界')
{
  writeFileSync(file, JSON.stringify([1, 2, 3]), 'utf8')
  let threw = false
  try { updateJsonFile(file, (doc) => doc) } catch { threw = true }
  check('顶层非对象时拒绝写入而不是覆盖', threw, true)
}
{
  const missing = join(dir, 'nope.json')
  check('读不存在的文件返回 null', readJsonFile(missing), null)
}

console.log('removeServer / renameServer')
{
  const file = join(dir, 'entry.json')
  updateJsonFile(file, () => ({ mcp: { servers: { exa: 'deferred', ctx7: { state: 'off', tools: { resolve: 'off' } } } }, skills: { dataviz: 'off' } }))

  check('改名把状态一起搬走', renameServer(file, 'exa', 'exa2'), true)
  const renamed = readJsonFile(file)
  check('新名字在', Object.keys(renamed.mcp.servers).sort(), ['ctx7', 'exa2'])
  check('旧名字不在了', renamed.mcp.servers.exa, undefined)
  check('状态跟着走', renamed.mcp.servers.exa2, 'deferred')
  check('无关的键不受影响', renamed.skills, { dataviz: 'off' })

  let conflict = null
  try { renameServer(file, 'exa2', 'ctx7') } catch (error) { conflict = error.message }
  check('目标已存在时报错', conflict?.includes('已存在'), true)
  check('冲突时不写坏文件', Object.keys(readJsonFile(file).mcp.servers).sort(), ['ctx7', 'exa2'])

  check('删除存在的条目', removeServer(file, 'ctx7'), true)
  check('删完只剩另一条', Object.keys(readJsonFile(file).mcp.servers), ['exa2'])
  check('删不存在的条目返回 false', removeServer(file, 'nope'), false)

  removeServer(file, 'exa2')
  check('删空后把 mcp 块一起清掉', readJsonFile(file).mcp, undefined)
  check('其它块还在', readJsonFile(file).skills, { dataviz: 'off' })
}

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
