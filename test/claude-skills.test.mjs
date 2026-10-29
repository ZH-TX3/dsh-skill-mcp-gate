#!/usr/bin/env node
/** skill 来源（.claude/skills 等）测试：frontmatter 解析、字段映射、目录扫描、provider 调用。 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseFrontmatter, scanSkillDir, findSkillFile } from '../lib/cc/skills.js'
import { createSkillProvider } from '../lib/platform/provider.js'

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

console.log('parseFrontmatter')
{
  const out = parseFrontmatter(md('---', 'name: demo', 'description: 一句话说明', '---', '', '# 标题', '正文'))
  check('name', out.data.name, 'demo')
  check('description', out.data.description, '一句话说明')
  check('body 去掉 frontmatter', out.body.startsWith('# 标题'), true)
}
{
  const out = parseFrontmatter(md('---', 'name: demo', 'description: >', '  第一行', '  第二行', '---', 'body'))
  check('多行折叠成一个空格', out.data.description, '第一行 第二行')
}
{
  const out = parseFrontmatter(md('---', 'name: "quoted"', '---', 'x'))
  check('去引号', out.data.name, 'quoted')
}
{
  const out = parseFrontmatter('没有 frontmatter')
  check('无 frontmatter 时 data 为空', out.data, {})
  check('body 原样', out.body, '没有 frontmatter')
}

const root = mkdtempSync(join(tmpdir(), 'claude-skills-'))
const projectDir = join(root, '.claude', 'skills')
mkdirSync(join(projectDir, 'alpha'), { recursive: true })
writeFileSync(join(projectDir, 'alpha', 'SKILL.md'),
  md('---', 'name: alpha', 'description: 目录形式', '---', 'ALPHA-BODY'), 'utf8')
writeFileSync(join(projectDir, 'beta.md'),
  md('---', 'description: 平铺形式', 'disable-model-invocation: yes', '---', 'BETA-BODY'), 'utf8')
writeFileSync(join(projectDir, 'Bad_Name.md'), md('---', 'description: 非法名字', '---', 'x'), 'utf8')
mkdirSync(join(projectDir, 'no-skill-md'), { recursive: true })

console.log(NL + 'scanSkillDir')
{
  const found = scanSkillDir(projectDir, { rank: 150, source: 'claude-project', providerName: 'claude-skills' })
  check('扫到两个合法 skill', found.map((c) => c.name).sort(), ['alpha', 'beta'])
  check('rank 透传', found.every((c) => c.rank === 150), true)
  check('source 透传', found.every((c) => c.source === 'claude-project'), true)
  const beta = found.find((c) => c.name === 'beta')
  check('disable-model-invocation=yes 生效', beta.invocation, { modelInvocable: false, userInvocable: true })
  const alpha = found.find((c) => c.name === 'alpha')
  check('默认可见可调', alpha.invocation, { modelInvocable: true, userInvocable: true })
  check('带文件路径', typeof alpha.path === 'string', true)
}
{
  // CC 会据此改变行为、但本插件落不了地的字段，必须显式报出来，不能悄悄忽略
  const gapDir = join(root, 'gap')
  mkdirSync(join(gapDir, 'gated'), { recursive: true })
  writeFileSync(join(gapDir, 'gated', 'SKILL.md'),
    md('---', 'description: 用了 CC 的运行时字段', 'allowed-tools: Read Grep', 'paths: src/**', 'model: opus', '---', 'X'),
    'utf8')
  const seen = []
  scanSkillDir(gapDir, {
    rank: 1, source: 'claude-project', providerName: 'p',
    report: (name, gaps) => seen.push([name, gaps.map((g) => g.field).sort()]),
  })
  check('未适配字段被收集', seen, [['gated', ['allowed-tools', 'model', 'paths']]])
}
{
  check('目录不存在时返回空', scanSkillDir(join(root, 'missing'), { rank: 1, source: 'x', providerName: 'p' }), [])
}

console.log(NL + 'findSkillFile（不走 registry）')
{
  const hit = findSkillFile([{ dir: projectDir, rank: 150, source: 'claude-project' }], 'alpha')
  check('按名字找到文件', hit.name, 'alpha')
  check('正文不含 frontmatter', hit.content.trim(), 'ALPHA-BODY')
  check('带资源基址', hit.resourceBase.path, join(projectDir, 'alpha'))
  check('找不到返回 undefined', findSkillFile([{ dir: projectDir, rank: 1, source: 'x' }], 'nope'), undefined)
}

console.log(NL + 'provider')
{
  const fakeHome = join(root, 'home')
  mkdirSync(join(fakeHome, '.dsh', 'skills', 'home-skill'), { recursive: true })
  writeFileSync(join(fakeHome, '.dsh', 'skills', 'home-skill', 'SKILL.md'),
    md('---', 'description: 家目录 skill', '---', 'HOME-BODY'), 'utf8')
  const provider = createSkillProvider({ name: 'claude-skills', home: fakeHome })
  check('provider 名字', provider.name, 'claude-skills')

  const listed = await provider.list({ cwd: root })
  check('按 cwd 扫到项目级 skill', listed.filter((c) => c.source === 'claude-project').map((c) => c.name).sort(), ['alpha', 'beta'])
  check('用户级根也被收录', listed.some((c) => c.source === 'user-dsh' && c.name === 'home-skill'), true)

  const got = await provider.get(listed.find((c) => c.name === 'alpha'))
  check('get 返回正文（不含 frontmatter）', got.content.trim(), 'ALPHA-BODY')
  check('get 保留 invocation', got.invocation, { modelInvocable: true, userInvocable: true })
  check('get 保留 source', got.source, 'claude-project')

  check('无 cwd 时只列用户级', (await provider.list({})).map((c) => c.name), ['home-skill'])
  check('候选缺 locator 时 get 返回 undefined', await provider.get({ name: 'x' }), undefined)
}

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? NL + '全部通过' : `${NL}${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
