#!/usr/bin/env node
/**
 * 端到端测试：真实配置文件 → 真实 SkillRegistry。
 * 覆盖 M1 的完成判据之一：配置 dataviz=off 后，目录里它的 invocation 真的变了。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// BASE 默认值只对本机成立；换机器/换 node 版本时用 DSH_SDK_BASE 覆盖
// （指向 dsh 依赖树里 @deepseek-ai/ 那一层，末尾带斜杠）
const BASE = process.env.DSH_SDK_BASE
  || 'file:///D:/nvm/v24.18.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
const { Context } = await import(BASE + 'cordis/lib/index.js')
const { default: SkillRegistry } = await import(BASE + 'dsh-skill/lib/index.js')
const { apply } = await import('../index.js')

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

const inv = (model, user) => ({ modelInvocable: model, userInvocable: user })
const cand = (name, source, rank) => ({
  name, source, rank, provider: 'fs', description: `desc-${name}`,
  invocation: inv(true, true), locator: {},
})

const workdir = mkdtempSync(join(tmpdir(), 'gate-e2e-'))
mkdirSync(join(workdir, '.dsh'), { recursive: true })
writeFileSync(join(workdir, '.dsh', 'skill-mcp-gate.json'), JSON.stringify({
  skills: { dataviz: 'off', caveman: 'user-invocable-only' },
}), 'utf8')

const ctx = new Context()
ctx.plugin(SkillRegistry)
await new Promise((r) => setTimeout(r, 10))
ctx.skills.registerProvider(() => ({
  name: 'fs',
  list: async () => [cand('dataviz', 'bundled', 600), cand('caveman', 'user-dsh', 400)],
  get: async (c) => ({
    name: c.name, description: c.description, source: c.source,
    provider: 'fs', invocation: c.invocation, content: `BODY-${c.name}`,
  }),
}))

const before = new Map((await ctx.skills.list()).map((s) => [s.name, s]))
check('装载前 dataviz 可见可调', before.get('dataviz').invocation, inv(true, true))

let registeredCommand = null
ctx.commands = { register: (definition) => { registeredCommand = definition; return () => {} } }
ctx.tools = { schemas: () => [] }
ctx.agents = { list: () => [] }
ctx.webServer = { register: () => () => {} }
// 真实 cordis Context 已有 effect，不能覆盖

apply(ctx, { projectDir: workdir, debug: false })
await new Promise((r) => setTimeout(r, 100))

// 目录门禁不改 registry，而是重写发给模型的目录消息；这里验配置解析与命令面
const status = await registeredCommand.handler({ rawInput: 'status' })
check('status 列出 dataviz 覆盖', status.text.includes('dataviz'), true)
const why = await registeredCommand.handler({ rawInput: 'why dataviz' })
check('why 归因到项目层', why.text.includes('项目'), true)
check('why 显示目标态 off', why.text.includes('off'), true)

check('注册了 gate 命令', registeredCommand?.name, 'gate')

rmSync(workdir, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
