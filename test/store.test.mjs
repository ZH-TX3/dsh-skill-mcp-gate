#!/usr/bin/env node
/** 配置文件写入测试：原子写、保留其它键、on 等于清除覆盖。 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setSkillState, setServerState, updateJsonFile, readJsonFile } from '../lib/io.js'

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

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
