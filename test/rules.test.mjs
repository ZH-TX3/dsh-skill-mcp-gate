#!/usr/bin/env node
/** CC rules 的纯逻辑：frontmatter 解析、花括号展开、glob 命中、注入规划。 */

import { parseRule, expandPatterns } from '../lib/cc/rules.js'
import {
  globToRegExp, matchesAny, toRelativePath, planRuleInjection, renderRulesBlock, isUnconditional,
} from '../lib/core/rules.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

const NL = String.fromCharCode(10)
const md = (...lines) => lines.join(NL)

console.log('parseRule')
{
  const out = parseRule(md('---', 'paths: src/**/*.ts, lib/*.ts', '---', '正文'))
  check('逗号分隔的 paths', out.paths, ['src/**/*.ts', 'lib/*.ts'])
  check('frontmatter 被剥掉', out.body, '正文')
}
{
  const out = parseRule(md('---', 'paths:', '  - "src/**"', '  - docs/*.md', 'other: 1', '---', 'X'))
  check('YAML 列表', out.paths, ['src/**', 'docs/*.md'])
  check('遇到下一个 key 就停', out.paths.length, 2)
}
{
  check('没有 frontmatter → 无条件', parseRule('纯正文').paths, null)
  check('没有 paths 字段 → 无条件', parseRule(md('---', 'title: x', '---', 'X')).paths, null)
  check('paths 为空 → 无条件', parseRule(md('---', 'paths:', '---', 'X')).paths, null)
  check('frontmatter 没闭合 → 当作正文', parseRule(md('---', 'paths: a/*.ts', 'X')).paths, null)
}

console.log('\nexpandPatterns')
{
  const out = expandPatterns(['src/*.{ts,tsx}', 'docs/**'])
  check('花括号展开', out.patterns, ['src/*.ts', 'src/*.tsx', 'docs/**'])
  check('未截断', out.truncated, false)
}
{
  const out = expandPatterns(['{a,b}/{c,d}/*.{ts,tsx}'])
  check('多层花括号乘算', out.patterns.length, 8)
}
{
  const out = expandPatterns(['{a,b,c,d}', 'plain/**'], { patterns: 2, bytes: 4096 })
  check('模式数受预算约束', out.truncated, true)
  check('预算用尽后不再往后展开', out.patterns, ['a', 'b'])
}
{
  const out = expandPatterns(['a/**', 'b/**', '{x,y,z}'], { patterns: 3, bytes: 4096 })
  check('不含花括号的模式不吃模式预算', out.truncated, false)
  check('全部保留', out.patterns.length, 5)
}

console.log('\nglob')
{
  check('** 跨目录', matchesAny(['src/**/*.ts'], 'src/a/b.ts'), true)
  check('** 含零层', matchesAny(['src/**/*.ts'], 'src/b.ts'), true)
  check('* 不跨目录', matchesAny(['src/*.ts'], 'src/a/b.ts'), false)
  check('* 单层命中', matchesAny(['src/*.ts'], 'src/a.ts'), true)
  check('? 单字符', matchesAny(['a?.md'], 'ab.md'), true)
  check('大小写不敏感', matchesAny(['SRC/**'], 'src/x.ts'), true)
  check('反斜杠模式归一', matchesAny(['src\\**\\*.md'], 'src/a/b.md'), true)
  check('无斜杠模式匹配文件名', matchesAny(['*.md'], 'docs/deep/x.md'), true)
  check('不命中', matchesAny(['src/**'], 'test/a.ts'), false)
  check('编译后可用于 test()', globToRegExp('**/*.ts').test('a/b/c.ts'), true)
}

console.log('\ntoRelativePath')
{
  check('项目内相对化', toRelativePath('D:/work/app', 'D:\\work\\app\\src\\a.ts'), 'src/a.ts')
  check('大小写差异也能相对化', toRelativePath('d:/Work/App', 'D:/work/app/src/a.ts'), 'src/a.ts')
  check('项目外保持原样', toRelativePath('D:/work/app', 'D:/other/x.ts'), 'D:/other/x.ts')
  check('无 root 时只去前导斜杠', toRelativePath(null, '/tmp/x.ts'), 'tmp/x.ts')
}

console.log('\nplanRuleInjection')
{
  const rules = [
    { id: '.claude/rules/always.md', paths: null, text: 'A'.repeat(10) },
    { id: '.claude/rules/ts.md', paths: ['src/**/*.ts'], text: 'B'.repeat(10) },
    { id: '.claude/rules/md.md', paths: ['*.md'], text: 'C'.repeat(10) },
  ]
  const root = 'D:/proj'

  const first = planRuleInjection({ rules, touched: [], root, budgetBytes: 1000 })
  check('没有触碰时只注入无条件规则', first.inject.map((r) => r.id), ['.claude/rules/always.md'])
  check('无条件规则的判定', isUnconditional(rules[0]), true)

  const touched = planRuleInjection({ rules, touched: ['D:/proj/src/x.ts'], root, budgetBytes: 1000 })
  check('命中路径规则后追加', touched.inject.map((r) => r.id), ['.claude/rules/always.md', '.claude/rules/ts.md'])

  const mdHit = planRuleInjection({ rules, touched: ['D:/proj/docs/readme.md'], root, budgetBytes: 1000 })
  check('无斜杠模式按文件名命中', mdHit.inject.map((r) => r.id), ['.claude/rules/always.md', '.claude/rules/md.md'])

  const once = planRuleInjection({
    rules, touched: ['D:/proj/src/x.ts'], root, budgetBytes: 1000,
    injected: new Set(['.claude/rules/always.md', '.claude/rules/ts.md']),
  })
  check('已注入的不重复', once.inject, [])

  const tight = planRuleInjection({
    rules, touched: ['D:/proj/src/x.ts'], root, budgetBytes: 15,
  })
  check('超预算的进 skipped', tight.inject.length, 1)
  check('被跳过的是后一条', tight.skipped.map((r) => r.id), ['.claude/rules/ts.md'])
  check('字节统计正确', tight.bytes, 10)

  const outside = planRuleInjection({ rules, touched: ['D:/elsewhere/x.py'], root, budgetBytes: 1000 })
  check('项目外的触碰不触发项目规则', outside.inject.map((r) => r.id), ['.claude/rules/always.md'])
}

console.log('\nrenderRulesBlock')
{
  const text = renderRulesBlock(
    [{ id: '.claude/rules/a.md', text: '用 pnpm' }],
    { omitted: [{ id: '.claude/rules/b.md' }], budgetBytes: 100 },
  )
  check('带 system-reminder 外壳', text.startsWith('<system-reminder>'), true)
  check('带规则路径', text.includes('<rule path=".claude/rules/a.md">'), true)
  check('带正文', text.includes('用 pnpm'), true)
  check('列出省略项', text.includes('.claude/rules/b.md'), true)
  check('带预算说明', text.includes('100 bytes'), true)
  check('空输入返回空串', renderRulesBlock([]), '')
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
