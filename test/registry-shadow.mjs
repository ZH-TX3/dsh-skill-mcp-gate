// registry-shadow.mjs — 验证 SkillRegistry 的同名解析规则
// 目的：确认 C 模式（runtime 影子）能覆盖哪些来源
// 同 e2e.test.mjs：本机默认值，可用 DSH_SDK_BASE 覆盖
const BASE = process.env.DSH_SDK_BASE
  || 'file:///D:/nvm/v24.18.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'

const { Context } = await import(BASE + 'cordis/lib/index.js')
const { default: SkillRegistry } = await import(BASE + 'dsh-skill/lib/index.js')

const inv = (model, user) => ({ modelInvocable: model, userInvocable: user })

function cand(name, source, rank, desc) {
  return {
    name, description: desc, source, rank, provider: 'fs',
    invocation: inv(true, true),
    locator: { via: source },
  }
}
function provider(name, items) {
  return {
    name,
    list: async () => items,
    get: async (c) => ({
      name: c.name, description: c.description, source: c.source,
      provider: 'fs',
      invocation: c.invocation, content: `BODY-FROM-${c.source}`,
    }),
  }
}

async function fresh() {
  const ctx = new Context()
  ctx.plugin(SkillRegistry)
  await new Promise((r) => setTimeout(r, 10))
  return ctx
}

async function show(label, ctx) {
  const list = await ctx.skills.list()
  const row = list.filter((s) => s.name === 'probe')
  if (!row.length) return console.log(`  ${label}: (无 probe)`)
  const s = row[0]
  const body = await ctx.skills.get('probe')
  console.log(
    `  ${label}: 胜出 source=${s.source} desc="${s.description}" ` +
    `model=${s.invocation.modelInvocable} body=${body?.content ?? '(none)'}`
  )
}

// ── 用例 A：user-dsh 提供者 vs runtime 影子
{
  const ctx = await fresh()
  ctx.skills.registerProvider(() => provider('fs', [
    cand('probe', 'user-dsh', 400, 'ORIGINAL-user'),
  ]))
  await show('A 基线(仅 user-dsh)', ctx)
  ctx.skills.register({
    name: 'probe', description: 'SHADOW-runtime', content: 'BODY-runtime',
    source: 'runtime', invocation: inv(false, false),
  })
  await show('A +runtime 影子', ctx)
}

// ── 用例 B：两个同名 runtime，谁胜
{
  const ctx = await fresh()
  ctx.skills.register({
    name: 'probe', description: 'RUNTIME-FIRST', content: 'BODY-first',
    source: 'runtime', invocation: inv(true, true),
  })
  ctx.skills.register({
    name: 'probe', description: 'RUNTIME-SECOND', content: 'BODY-second',
    source: 'runtime', invocation: inv(false, false),
  })
  await show('B 两个 runtime(first/second)', ctx)
}

// ── 用例 C：project-dsh vs runtime 影子
{
  const ctx = await fresh()
  ctx.skills.registerProvider(() => provider('fs', [
    cand('probe', 'project-dsh', 100, 'ORIGINAL-project'),
  ]))
  ctx.skills.register({
    name: 'probe', description: 'SHADOW-runtime', content: 'BODY-runtime',
    source: 'runtime', invocation: inv(false, false),
  })
  await show('C project-dsh + runtime 影子', ctx)
}

// ── 用例 D：runtime 影子装成 project-dsh 来源，能否盖过真 project-dsh
{
  const ctx = await fresh()
  ctx.skills.registerProvider(() => provider('fs', [
    cand('probe', 'project-dsh', 100, 'ORIGINAL-project'),
  ]))
  ctx.skills.register({
    name: 'probe', description: 'SPOOF-project', content: 'BODY-spoof',
    source: 'project-dsh', invocation: inv(false, false),
  })
  await show('D project-dsh + 伪装 project-dsh 影子', ctx)
}

// ── 用例 E：bundled vs runtime 影子（dataviz 属于这类，最关键）
{
  const ctx = await fresh()
  ctx.skills.registerProvider(() => provider('fs', [
    cand('probe', 'bundled', 600, 'ORIGINAL-bundled'),
  ]))
  await show('E 基线(仅 bundled)', ctx)
  ctx.skills.register({
    name: 'probe', description: 'SHADOW-runtime', content: 'BODY-runtime',
    source: 'runtime', invocation: inv(false, false),
  })
  await show('E bundled + runtime 影子', ctx)
}

// ── 用例 F：custom(300) vs runtime 影子
{
  const ctx = await fresh()
  ctx.skills.registerProvider(() => provider('fs', [
    cand('probe', 'custom', 300, 'ORIGINAL-custom'),
  ]))
  ctx.skills.register({
    name: 'probe', description: 'SHADOW-runtime', content: 'BODY-runtime',
    source: 'runtime', invocation: inv(false, false),
  })
  await show('F custom + runtime 影子', ctx)
}
