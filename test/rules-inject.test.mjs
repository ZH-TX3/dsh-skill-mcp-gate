#!/usr/bin/env node
/**
 * rules 注入（假 ctx，不启动 DSH）：
 * 成功的 read/write/edit → 记 touched；下一步把命中规则作为一条 user 消息插进决策。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRulesInjector } from '../lib/platform/rules-injector.js'

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

const home = mkdtempSync(join(tmpdir(), 'gate-rules-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'gate-rules-proj-'))

function writeRule(relative, text) {
  const file = join(cwd, '.claude', 'rules', relative)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

writeRule('always.md', md('---', '---', '始终适用：用 pnpm 而不是 npm。'))
writeRule('ts.md', md('---', 'paths: src/**/*.ts', '---', 'TS 规则：默认 strict。'))
writeRule('deep/md.md', md('---', 'paths: "*.md"', '---', '文档规则：标题只用一级。'))
writeRule('ignored.txt', 'not a rule')

function makeCtx() {
  const listeners = new Map()
  return {
    listeners,
    ctx: { on: (event, fn) => { listeners.set(event, fn); return () => {} } },
  }
}

const agent = { id: 'agent-1', session: { header: { cwd } } }
const decision = (messages = []) => ({ messages })

function makeInjector(overrides = {}) {
  const { ctx, listeners } = makeCtx()
  const options = { enabled: true, maxBytes: 8192, home, ...overrides }
  const injector = createRulesInjector({ ctx, getOptions: () => options })
  injector.install()
  return {
    injector,
    listeners,
    step: (payload = { agent }) => listeners.get('agent/pre-step')(payload, async () => decision()),
    stepWith: (messages, payload = { agent }) => listeners.get('agent/pre-step')(payload, async () => decision(messages)),
    touch: (name, args, result = { isError: false }) => listeners.get('tools/result')({ name, arguments: args, agent, signal: { aborted: false } }, result),
  }
}

async function main() {
  console.log('首轮：只注入无条件规则')
  {
    const { injector, step } = makeInjector()
    const out = await step()
    check('插入了一条消息', out.messages.length, 1)
    const message = out.messages[0]
    check('是 user 消息', message.role, 'user')
    check('source 标记自己', [message.source.kind, message.source.form], ['cc-rules', 'rules'])
    check('带规则 id', message.source.rules, ['.claude/rules/always.md'])
    check('正文含规则内容', message.content[0].text.includes('用 pnpm'), true)
    check('带了 rule 路径', message.content[0].text.includes('<rule path=".claude/rules/always.md">'), true)
    check('两条路径规则没被带进来', message.content[0].text.includes('TS 规则'), false)
    check('每个消息都有 id', typeof message.id === 'string', true)
    injector.dispose()
  }

  console.log(NL + '不重复注入')
  {
    const { injector, step } = makeInjector()
    await step()
    const second = await step()
    check('第二轮不再插入', second.messages.length, 0)
    injector.dispose()
  }

  console.log(NL + '触碰文件后按 paths 注入')
  {
    const { injector, step, touch } = makeInjector()
    await step()
    touch('read', { file_path: join(cwd, 'src', 'a.ts') })
    const out = await step()
    check('命中 src/**/*.ts', out.messages.length, 1)
    check('只带命中的那条', out.messages[0].source.rules, ['.claude/rules/ts.md'])
    check('无条件规则不重复', out.messages[0].source.rules.includes('.claude/rules/always.md'), false)

    touch('edit', { file_path: join(cwd, 'docs', 'guide.md') })
    const third = await step()
    check('无斜杠模式按文件名命中', third.messages[0].source.rules, ['.claude/rules/deep/md.md'])
    check('已注入的 ts 不重复', third.messages[0].source.rules.includes('.claude/rules/ts.md'), false)
    injector.dispose()
  }

  console.log(NL + '不该记的触碰')
  {
    const { injector, step, touch, listeners } = makeInjector()
    await step()
    touch('read', { file_path: join(cwd, 'src', 'a.ts') }, { isError: true })
    touch('bash', { file_path: join(cwd, 'src', 'b.ts') })
    touch('read', { path: join(cwd, 'src', 'c.ts') })
    listeners.get('tools/result')({ name: 'read', arguments: { file_path: join(cwd, 'src', 'd.ts') }, agent, signal: { aborted: true } }, { isError: false })
    const out = await step()
    check('失败/别的工具/被取消的触碰都不算', out.messages.length, 0)
    injector.dispose()
  }

  console.log(NL + '预算')
  {
    const { injector, step, touch } = makeInjector({ maxBytes: 20 })
    const first = await step()
    check('连无条件规则都放不下时，给一条提示而不是静默', first.messages.length, 1)
    check('提示里列出被省略的规则', first.messages[0].content[0].text.includes('超出注入预算'), true)
    check('提示只发一次', (await step()).messages.length, 0)
    touch('read', { file_path: join(cwd, 'src', 'a.ts') })
    check('预算仍然不允许硬塞', (await step()).messages.length, 0)
    injector.dispose()
  }

  console.log(NL + '关闭与容错')
  {
    const { injector, step } = makeInjector({ enabled: false })
    check('关闭后什么都不注入', (await step()).messages.length, 0)
    injector.dispose()
  }
  {
    const { injector, step, listeners } = makeInjector()
    check('没有 agent 时直通', (await step({})).messages.length, 0)
    check('reject 决策直通', (await listeners.get('agent/pre-step')({ agent }, async () => ({ kind: 'reject' }))).kind, 'reject')
    injector.dispose()
  }

  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
  console.log(failures === 0 ? NL + '全部通过' : `${NL}${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
