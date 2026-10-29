#!/usr/bin/env node
/** 手动调用 skill：外壳渲染、读正文、排队、pre-step 注入、拒绝路径。 */

import { renderSkillContent, createSkillInvoker } from '../lib/platform/skill-invoke.js'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}
async function rejects(label, fn, needle) {
  let message = null
  try { await fn() } catch (error) { message = error.message }
  check(label, Boolean(message) && message.includes(needle), true)
}

console.log('renderSkillContent')
{
  const text = renderSkillContent({ name: 'demo', content: '正文', provider: 'fs' })
  check('带 skill_content 外壳', text.startsWith('<skill_content name="demo">'), true)
  check('带 instructions 段', text.includes('<skill_instructions>\n正文\n</skill_instructions>'), true)
  check('没有目录基址时说明由 provider 管理', text.includes('managed by provider "fs"'), true)
}
{
  const text = renderSkillContent({
    name: 'demo', content: 'x', provider: 'fs', resourceBase: { kind: 'directory', path: 'C:/rules' },
  })
  check('有目录基址时给绝对路径', text.includes('Base directory for this skill: C:/rules'), true)
}
{
  const text = renderSkillContent({ name: 'a<b', content: 'x', provider: 'p' })
  check('名字做属性转义', text.includes('name="a&lt;b"'), true)
}

function makeCtx(skills = {}) {
  const listeners = new Map()
  return {
    listeners,
    ctx: {
      on: (event, fn) => { listeners.set(event, fn); return () => {} },
      skills: {
        get: async (name) => (name === 'missing' ? undefined : {
          name,
          provider: 'fs',
          content: `# ${name} 正文`,
          resourceBase: { kind: 'directory', path: 'D:/skills' },
          invocation: { modelInvocable: true, userInvocable: true },
        }),
      },
    },
  }
}

async function main() {
  console.log('\n读正文')
  {
    const { ctx } = makeCtx()
    const invoker = createSkillInvoker({ ctx })
    const skill = await invoker.read('demo', { cwd: '/w' })
    check('拿到 content', skill.content, '# demo 正文')
    check('拿到 provider', skill.provider, 'fs')
    await rejects('读不到时给清楚的错', () => invoker.read('missing'), '目录里没有 skill')
    const viaFile = await invoker.read('missing', { fallback: async (name) => ({ name, content: '来自文件' }) })
    check('registry 读不到时回退到文件', viaFile.content, '来自文件')
    invoker.dispose()
  }

  console.log('\n排队与注入')
  {
    const { ctx, listeners } = makeCtx()
    const invoker = createSkillInvoker({ ctx })
    invoker.install()
    const agent = { id: 'agent-1' }
    const skill = await invoker.read('demo', { agent })
    const pending = invoker.enqueue(agent, skill)
    check('排队数', pending, 1)

    const preStep = listeners.get('agent/pre-step')
    const decision = await preStep({ agent }, async () => ({ messages: [] }))
    check('注入一条消息', decision.messages.length, 1)
    check('是 user 消息', decision.messages[0].role, 'user')
    check('source 标记', [decision.messages[0].source.kind, decision.messages[0].source.name], ['skill-invoke', 'demo'])
    check('消息带技能正文', decision.messages[0].content[0].text.includes('# demo 正文'), true)
    check('消息有 id', typeof decision.messages[0].id, 'string')

    const second = await preStep({ agent }, async () => ({ messages: [] }))
    check('只注入一次', second.messages.length, 0)
    check('status 记录过', invoker.status().last, ['demo'])
    invoker.dispose()
  }

  console.log('\n拒绝与容错')
  {
    const { ctx, listeners } = makeCtx()
    const invoker = createSkillInvoker({ ctx })
    invoker.install()
    let threw = null
    try { invoker.enqueue(undefined, { name: 'x', content: 'y' }) } catch (error) { threw = error.message }
    check('没有会话时拒绝', threw?.includes('没有活动会话'), true)

    const preStep = listeners.get('agent/pre-step')
    const reject = await preStep({ agent: { id: 'a' } }, async () => ({ kind: 'reject' }))
    check('reject 直通', reject.kind, 'reject')
    const noAgent = await preStep({}, async () => ({ messages: [] }))
    check('没有 agent 时直通', noAgent.messages.length, 0)
    invoker.dispose()
  }

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
