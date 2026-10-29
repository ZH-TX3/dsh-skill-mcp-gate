/**
 * 面板快照：把「装载结果 + DSH 运行时事实」拼成给前端与 /gate 的 JSON。
 *
 * 纯拼装，不做决策；任何需要判断的事情都已经在 load/ 与 core/ 里做完了。
 */

import { existsSync } from 'node:fs'
import { groupToolsByServer, bareToolName } from '../core/mcp-policy.js'
import { GLOBAL_WS } from '../load.js'
import { liveAgents, listSkills, toolNames, workspaceList } from '../platform/observe.js'

/** source → 面板上的分组。 */
function scopeOfSource(source) {
  if (typeof source !== 'string') return 'user'
  if (source === 'project-dsh' || source === 'project-agents' || source === 'claude-project') return 'project'
  if (source === 'bundled') return 'builtin'
  return 'user'
}

export function createSnapshotter({ ctx, getLoaded, getPlanCost, getGaps, getStatus, warn = () => {} }) {
  async function snapshotSkills(loaded) {
    const agents = liveAgents(ctx, warn)
    const ws = loaded.workspace
    const lookups = []
    if (!ws || ws === GLOBAL_WS) {
      lookups.push({})
    } else {
      // 先读该工作区活跃会话的 scope（DSH 原生来源最权威），再补全局层 + 项目根
      for (const agent of agents) {
        if (agent.session?.header?.cwd === ws) lookups.push({ cwd: ws, scope: agent })
      }
      lookups.push({ cwd: ws })
    }
    const listed = await listSkills(ctx, lookups, warn)
    const gaps = getGaps()
    return listed.map((skill) => {
      const decided = loaded.skills.get(skill.name)
      return {
        name: skill.name,
        scope: scopeOfSource(skill.source),
        source: skill.source,
        state: decided?.state ?? 'on',
        decidedBy: decided ? decided.decidedBy.label : 'frontmatter',
        decidedByFile: decided ? decided.decidedBy.file : null,
        model: skill.invocation?.modelInvocable ?? true,
        user: skill.invocation?.userInvocable ?? true,
        gaps: gaps.get(skill.name) ?? [],
      }
    })
  }

  function snapshotServers(loaded) {
    const byServer = groupToolsByServer(toolNames(ctx, warn))
    const names = new Set([...byServer.keys(), ...loaded.servers.keys()])
    return [...names].sort().map((server) => {
      const entry = loaded.servers.get(server)
      const state = entry?.state ?? 'on'
      const tools = (byServer.get(server) ?? []).map((full) => {
        const bare = bareToolName(full) ?? full
        const toolState = entry?.tools?.get(bare) ?? 'on'
        return { name: bare, full, state: toolState, hidden: state === 'off' || toolState === 'off' }
      })
      return {
        name: server,
        state,
        connected: byServer.has(server),
        layer: entry?.layer ?? null,
        file: entry?.file ?? null,
        ccScope: entry?.ccScope ?? null,
        ccApproved: entry?.ccApproved ?? null,
        ccRejected: entry?.ccRejected ?? false,
        tools,
      }
    })
  }

  return async function snapshot() {
    const loaded = getLoaded()
    const agents = liveAgents(ctx, warn)
    const status = getStatus()
    const primary = agents[0]

    return {
      workspaces: workspaceList(ctx, { globalKey: GLOBAL_WS, warn }),
      active: loaded.workspace,
      skills: await snapshotSkills(loaded),
      session: primary
        ? { id: String(primary.id ?? ''), cwd: primary.session?.header?.cwd ?? null, count: agents.length }
        : null,
      mcp: {
        servers: snapshotServers(loaded),
        report: status.mcp,
        cc: loaded.claudeMcp,
        connections: status.connections,
      },
      tools: status.tools,
      rules: status.rules,
      listing: { budget: loaded.budget, cost: getPlanCost() },
      files: loaded.files.map((file) => ({ file, exists: existsSync(file) })),
      projectDir: loaded.projectDir,
      warnings: loaded.warnings,
      problems: {
        unsupported: loaded.budget?.unsupported ?? [],
        missing: [],
        failed: [],
        lost: [],
        catalog: status.catalog,
      },
    }
  }
}
