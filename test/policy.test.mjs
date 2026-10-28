#!/usr/bin/env node
/** 纯领域 + CC 设置解析：四档词汇、分层合并、skillOverrides 别名与校验。 */

import {
  SKILL_STATES, MCP_STATES, mergeSkillLayers, visibilityOf, describeState,
  assertSkillState, assertMcpState, assertMcpToolState, describeMcpState,
} from '../lib/core/policy.js'
import { parseSkillOverrides } from '../lib/cc/skills.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

const meta = (file = 'f.json', label = '全局') => ({ file, label })

console.log('parseSkillOverrides')
{
  const r = parseSkillOverrides({ skills: { dataviz: 'off', caveman: 'user-invocable-only' } }, meta())
  check('字符串简写解析', [...r.skills.entries()], [['dataviz', { state: 'off' }], ['caveman', { state: 'user-invocable-only' }]])
  check('无告警', r.warnings, [])
}
{
  const r = parseSkillOverrides({ skills: { dataviz: 'disable' } }, meta())
  check('未知状态被拒', r.skills.size, 0)
  check('未知状态报出可用值', r.warnings[0].includes('name-only'), true)
}
{
  const r = parseSkillOverrides({ skills: { x: { state: 'off', bogus: 1 } } }, meta())
  check('对象形式取 state', r.skills.get('x').state, 'off')
  check('未知字段单独提示', r.warnings.some((w) => w.includes('bogus') && w.includes('未知字段')), true)
}
{
  const r = parseSkillOverrides({ skillOverrides: { dataviz: 'off' } }, meta())
  check('接受 CC 的 skillOverrides 别名', r.skills.get('dataviz').state, 'off')
}
{
  const r = parseSkillOverrides({ skillOverrides: { dataviz: 'off' }, skills: { dataviz: 'on' } }, meta())
  check('skills 覆盖别名', r.skills.get('dataviz').state, 'on')
}
{
  const r = parseSkillOverrides({ skills: [1, 2] }, meta())
  check('块不是对象时告警', r.warnings.length, 1)
  check('仍返回空表', r.skills.size, 0)
}
{
  check('空输入不抛', parseSkillOverrides(null, meta()).skills.size, 0)
  check('mcp 块不产生 skill 告警', parseSkillOverrides({ mcp: { servers: {} } }, meta()).warnings, [])
}

console.log('\nmergeSkillLayers')
{
  const low = { file: 'a.json', label: 'CC 用户', skills: new Map([['x', { state: 'name-only' }], ['y', { state: 'off' }]]) }
  const high = { file: 'b.json', label: '项目', skills: new Map([['x', { state: 'on' }]]) }
  const merged = mergeSkillLayers([low, high])
  check('后者覆盖前者', merged.get('x').state, 'on')
  check('未覆盖的保留', merged.get('y').state, 'off')
  check('归因到决定层', merged.get('x').decidedBy, { file: 'b.json', label: '项目' })
  check('低层归因正确', merged.get('y').decidedBy.label, 'CC 用户')
}

console.log('\n四档词汇')
{
  check('四档齐备', SKILL_STATES, ['on', 'name-only', 'user-invocable-only', 'off'])
  check('off 隐藏', visibilityOf('off'), 'hidden')
  check('user-invocable-only 隐藏', visibilityOf('user-invocable-only'), 'hidden')
  check('name-only 只露名字', visibilityOf('name-only'), 'name-only')
  check('on 完整', visibilityOf('on'), 'full')
  check('name-only 说明提到描述', describeState('name-only').includes('描述'), true)
}
{
  let threw = null
  try { assertSkillState('nope', 'skills.x') } catch (error) { threw = error.message }
  check('非法状态抛错并点名位置', threw?.includes('skills.x'), true)
  threw = null
  try { assertMcpState('name-only', 'mcp.exa') } catch (error) { threw = error.message }
  check('服务器状态列出三档', threw?.includes('on / deferred / off'), true)
  check('合法状态原样返回', assertMcpState('off', 'mcp.exa'), 'off')
  check('服务器三档齐备', MCP_STATES, ['on', 'deferred', 'off'])
  check('deferred 有说明', describeMcpState('deferred').includes('搜索'), true)
}
{
  let threw = null
  try { assertMcpToolState('deferred', 'mcp.exa.crawl') } catch (error) { threw = error.message }
  check('逐工具不接受 deferred', threw?.includes('仅支持 on / off'), true)
  check('逐工具合法值', assertMcpToolState('off', 'mcp.exa.crawl'), 'off')
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
