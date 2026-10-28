/**
 * `/gate` 命令面。只负责取数与排版，动作都走注入进来的 api。
 */

import { existsSync } from 'node:fs'
import { SKILL_STATES, describeState } from '../core/policy.js'

const ok = (text) => ({ kind: 'success', text })
const fail = (text) => ({ kind: 'error', text })

export function createCommands(api) {
  function renderStatus() {
    const loaded = api.getLoaded()
    const configured = [...loaded.skills.entries()].filter(([, entry]) => entry.state !== 'on')
    const lines = ['skill-mcp-gate', `项目目录: ${loaded.projectDir}`]
    for (const file of loaded.files) lines.push(`  ${existsSync(file) ? '✓' : '·'} ${file}`)
    lines.push('')
    lines.push(configured.length === 0 ? 'skills: 无覆盖' : `skills 覆盖 ${configured.length} 项：`)
    for (const [name, entry] of configured) {
      lines.push(`  ${name.padEnd(24)} ${entry.state.padEnd(20)} ← ${entry.decidedBy.label}`)
    }

    const offServers = [...loaded.servers.entries()].filter(([, e]) => e.state === 'off').map(([n]) => n)
    const deferredServers = [...loaded.servers.entries()].filter(([, e]) => e.state === 'deferred').map(([n]) => n)
    const offTools = [...loaded.servers.entries()].flatMap(([server, e]) =>
      [...e.tools.entries()].filter(([, s]) => s === 'off').map(([tool]) => `${server}.${tool}`))
    const report = api.getStatus().mcp
    lines.push('')
    lines.push(`mcp: ${report.servers.length} 台服务器；关闭 ${offServers.length} 台、延迟 ${deferredServers.length} 台、${offTools.length} 个工具`)
    if (offServers.length > 0) lines.push(`  关闭: ${offServers.join(', ')}`)
    if (deferredServers.length > 0) lines.push(`  延迟（可搜可调）: ${deferredServers.join(', ')}`)
    if (offTools.length > 0) lines.push(`  工具: ${offTools.join(', ')}`)
    if (report.pending.length > 0) lines.push(`  待连上后生效: ${report.pending.join(', ')}`)

    const cc = loaded.claudeMcp
    if (cc && cc.servers.length > 0) {
      const rejected = cc.servers.filter((s) => s.rejected).map((s) => s.name)
      lines.push(`  CC 侧定义 ${cc.servers.length} 台${rejected.length > 0 ? `，其中被拒绝: ${rejected.join(', ')}` : ''}`)
    }

    if (loaded.budget?.chars) {
      const at = api.getPlanCost()
      lines.push('')
      lines.push(`目录预算: ${at?.after ?? 0} / ${loaded.budget.chars} 字（${loaded.budget.source}）`)
      if (at?.dropped?.length > 0) lines.push(`  已为省预算丢掉 ${at.dropped.length} 条描述: ${at.dropped.map((d) => d.name).join(', ')}`)
    }
    if (loaded.warnings.length > 0) {
      lines.push('')
      lines.push(`配置警告 ${loaded.warnings.length} 条，/gate doctor 查看`)
    }
    return ok(lines.join('\n'))
  }

  async function renderSkills() {
    const data = await api.snapshot()
    const lines = [`共 ${data.skills.length} 个 skill：`]
    for (const skill of data.skills) {
      lines.push(`  ${skill.state.padEnd(20)} ${String(skill.source).padEnd(18)} ${skill.name}`)
      for (const gap of skill.gaps) lines.push(`      ↳ 用了 CC 的 ${gap.field}：${gap.reason}`)
    }
    return ok(lines.join('\n'))
  }

  async function renderMcp() {
    const data = await api.snapshot()
    if (data.mcp.servers.length === 0) return ok('没有发现 MCP 服务器')
    const lines = []
    for (const server of data.mcp.servers) {
      const tag = server.ccScope ? ` [CC ${server.ccScope}${server.ccRejected ? '/拒绝' : ''}]` : ''
      const mark = server.state === 'off' ? '✗' : server.state === 'deferred' ? '◐' : '✓'
      lines.push(`${mark} ${server.name}${tag}  ${server.tools.length} 个工具${server.connected ? '' : '（未连上）'}${server.state === 'deferred' ? '（延迟：可搜可调）' : ''}`)
      for (const tool of server.tools) {
        lines.push(`    ${tool.state === 'off' ? '✗' : '✓'} ${tool.name}${server.state === 'off' ? '（随服务器关闭）' : ''}`)
      }
    }
    lines.push('')
    lines.push('关闭只影响装配期的工具清单：不写配置、不断连，下一轮即恢复')
    return ok(lines.join('\n'))
  }

  async function renderWhy(skillName) {
    if (!skillName) return fail('用法：/gate why <skill 名>')
    const data = await api.snapshot()
    const skill = data.skills.find((s) => s.name === skillName)
    if (!skill) return fail(`目录中没有 skill "${skillName}"`)
    const lines = [
      `skill: ${skill.name}`,
      `来源: ${skill.source}`,
      `当前: 模型${skill.model ? '可见' : '不可见'} / / 菜单${skill.user ? '可见' : '不可见'}`,
      `决定层: ${skill.decidedBy}${skill.decidedByFile ? ` → ${skill.decidedByFile}` : ''}`,
      `目标态: ${skill.state}（${describeState(skill.state)}）`,
    ]
    for (const gap of skill.gaps) lines.push(`⚠ 未适配的 CC 字段: ${gap.field} — ${gap.reason}`)
    return ok(lines.join('\n'))
  }

  async function renderDoctor() {
    const data = await api.snapshot()
    const lines = ['skill-mcp-gate 自检']
    lines.push(`  配置警告: ${data.warnings.length}`)
    lines.push(`  未适配的 CC 设置: ${data.problems.unsupported.length}`)
    lines.push(`  目录消息重写: ${data.problems.catalog.filteredMessages} 条 / 错误 ${data.problems.catalog.errors.length}`)
    lines.push(`  mcp 过滤器错误: ${data.mcp.report.errors.length}`)
    lines.push(`  中间层: ${data.tools && data.tools.disabled ? '已关闭' : '已注册'}${data.tools && data.tools.errors.length > 0 ? ` / 错误 ${data.tools.errors.length}` : ''}`)
    if (data.listing.budget.chars) {
      lines.push(`  目录预算: ${data.listing.cost?.after ?? 0} / ${data.listing.budget.chars} 字`)
    }
    const problems = [
      ...data.warnings.map((w) => `配置: ${w}`),
      ...data.problems.unsupported.map((u) => `未适配: ${u.key} — ${u.reason}`),
      ...data.problems.catalog.errors.map((e) => `catalog:${e.scope} — ${e.reason}`),
      ...data.mcp.report.errors.map((e) => `mcp:${e.scope} — ${e.reason}`),
      ...((data.tools && data.tools.errors) || []).map((e) => `tools:${e.scope} — ${e.reason}`),
    ]
    lines.push('')
    if (problems.length === 0) lines.push('没有发现问题')
    else for (const problem of problems) lines.push(`  ${problem}`)
    return ok(lines.join('\n'))
  }

  async function handle(rawInput) {
    const trimmed = rawInput.trim()
    const [sub, ...rest] = trimmed.length > 0 ? trimmed.split(/\s+/) : []
    try {
      switch (sub) {
        case undefined:
        case 'status': return renderStatus()
        case 'skills': return await renderSkills()
        case 'mcp': return await renderMcp()
        case 'why': return await renderWhy(rest[0])
        case 'doctor': return await renderDoctor()
        case 'reload': {
          const loaded = api.reload(rest[0])
          return ok(`已重新加载，skills 覆盖 ${[...loaded.skills.values()].filter((e) => e.state !== 'on').length} 项，mcp 关闭 ${[...loaded.servers.values()].filter((e) => e.state === 'off').length} 台服务器`)
        }
        case 'set': {
          let key = rest[0]
          let value = rest[1]
          if (typeof key === 'string' && key.includes('=')) {
            const index = key.indexOf('=')
            value = key.slice(index + 1)
            key = key.slice(0, index)
          }
          if (!key || !value) return fail('用法：/gate set <group>.<名字>=<状态>，例如 /gate set skills.dataviz=off')
          const parts = key.split('.')
          const group = parts.shift()
          if (parts.length === 0) return fail(`缺少名字：/gate set ${group}.<名字>=<状态>`)
          if (group === 'skills') {
            if (!SKILL_STATES.includes(value)) return fail(`未知状态 "${value}"，可用 ${SKILL_STATES.join(' / ')}`)
            api.setSkill(parts.join('.'), value)
          } else if (group === 'mcp' && parts.length === 1) api.setServer(parts[0], value)
          else if (group === 'mcp' && parts.length >= 2) api.setTool(parts[0], parts.slice(1).join('.'), value)
          else return fail(`未知分组 "${group}"，可用 skills / mcp`)
          return ok(`已设置 ${key}=${value}`)
        }
        default:
          return fail(`未知子命令 "${sub}"。可用：status / skills / mcp / why <名字> / doctor / reload [目录] / set <key>=<value>`)
      }
    } catch (error) {
      return fail(`执行失败：${error.message}`)
    }
  }

  return { handle }
}
