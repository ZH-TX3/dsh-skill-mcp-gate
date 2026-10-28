#!/usr/bin/env node
/** 目录预算：按 CC 语义「名字全留、描述按最不常用先丢」，以及预算来源的解析。 */

import { planListing, listingCost, entryCost } from '../lib/core/listing.js'
import { readListingBudget } from '../lib/cc/listing.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

const entries = [
  { name: 'alpha', description: 'A'.repeat(50) },
  { name: 'beta', description: 'B'.repeat(50) },
  { name: 'gamma', description: 'C'.repeat(50) },
  { name: 'quiet', description: 'Q'.repeat(50) },
]

console.log('不启用预算')
{
  const states = new Map([['quiet', { state: 'name-only' }], ['gamma', { state: 'off' }]])
  const plan = planListing({ entries, states, budgetChars: null })
  check('隐藏项进 hide', [...plan.hide], ['gamma'])
  check('name-only 进 nameOnly', [...plan.nameOnly], ['quiet'])
  check('剩下的都保留', plan.keep.map((e) => e.name), ['alpha', 'beta', 'quiet'])
  check('没有丢描述', plan.cost.dropped, [])
  check('预算为 null', plan.cost.budget, null)
}

console.log('\n超预算')
{
  const states = new Map()
  const full = listingCost(entries)
  // 预算只够放下两条完整描述
  const budget = entryCost(entries[0]) * 2 + 10
  const plan = planListing({ entries, states, budgetChars: budget })
  check('没有整条被隐藏', plan.hide.size, 0)
  check('名字一条不少', plan.keep.length, 4)
  check('确实丢了描述', plan.cost.dropped.length > 0, true)
  check('落到预算之内', plan.cost.after <= budget, true)
  check('before 是原始代价', plan.cost.before, full)
  check('预算被记录', plan.cost.budget, budget)
}

console.log('\n按使用次数丢（最不常用先丢）')
{
  const states = new Map()
  const usage = new Map([
    ['alpha', { count: 99, lastUsedAt: 1 }],
    ['beta', { count: 5, lastUsedAt: 1 }],
    ['gamma', { count: 1, lastUsedAt: 1 }],
    // quiet 没记录 → 视为 0 次，最不常用
  ])
  const budget = entryCost(entries[0]) * 2 + 10
  const plan = planListing({ entries, states, budgetChars: budget, usage })
  const dropped = plan.cost.dropped.map((d) => d.name)
  check('最不常用的（无记录）先丢', dropped[0], 'quiet')
  check('次少用的第二个丢', dropped[1], 'gamma')
  check('最先丢的是最不常用的两条', dropped.slice(0, 2), ['quiet', 'gamma'])
  check('最常用的最后才丢', dropped[dropped.length - 1] === 'alpha' || !dropped.includes('alpha'), true)
}

console.log('\nname-only 不参与丢弃')
{
  const states = new Map([['alpha', { state: 'name-only' }]])
  const plan = planListing({ entries, states, budgetChars: 10 })
  check('name-only 条目不会被重复丢', plan.cost.dropped.some((d) => d.name === 'alpha'), false)
  check('其它条目被丢到只剩名字', plan.nameOnly.size >= 3, true)
}

console.log('\n预算来源')
{
  const layers = [{ file: 'cc.json', doc: {} }]
  const viaEnv = readListingBudget({ layers, config: {}, env: { SLASH_COMMAND_TOOL_CHAR_BUDGET: '1234' } })
  check('环境变量直接给字符数', viaEnv.chars, 1234)
  check('来源可读', viaEnv.source.includes('SLASH_COMMAND_TOOL_CHAR_BUDGET'), true)
}
{
  const layers = [{ file: 'cc.json', doc: { skillListingBudgetFraction: 0.02 } }]
  const noWindow = readListingBudget({ layers, config: {}, env: {} })
  check('缺窗口大小时不启用', noWindow.chars, null)
  check('并给出警告', noWindow.warnings.some((w) => w.includes('contextWindowTokens')), true)
  const withWindow = readListingBudget({ layers, config: { contextWindowTokens: 100000 }, env: {} })
  check('按比例换算', withWindow.chars, 2000)
}
{
  const layers = [{ file: 'cc.json', doc: { skillListingBudgetFraction: 3 } }]
  const bad = readListingBudget({ layers, config: { contextWindowTokens: 1000 }, env: {} })
  check('非法比例被拒', bad.chars, null)
  check('给出警告', bad.warnings.length > 0, true)
}
{
  const layers = [{ file: 'cc.json', doc: { skillListingMaxDescChars: 2048 } }]
  const out = readListingBudget({ layers, config: {}, env: {} })
  check('单条上限键如实报未适配', out.unsupported.map((u) => u.key), ['skillListingMaxDescChars'])
  check('不带成分数警告', out.warnings, [])
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
