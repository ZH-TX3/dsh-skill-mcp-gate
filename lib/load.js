/**
 * 装载层：一个工作区的全部配置 → 归一化后的策略。
 *
 * 这是唯一知道「配置文件有哪几层、谁覆盖谁」的地方。
 * 上面的 index.js 只管把结果交给 DSH，下面的 cc/ 只管解析、core/ 只管合并。
 *
 * 层序（低 → 高）：CC 用户 → 本插件全局 → CC 项目 → CC 项目本地 → 本插件项目
 */

import { claudeJsonPath, claudeMcpProjectFile, claudeSettingsLayers, configPaths } from './paths.js'
import { readJsonFile } from './io.js'
import { parseSkillOverrides } from './cc/skills.js'
import { readClaudeMcp, buildBaseline, readJsonSafe } from './cc/mcp.js'
import { readSkillUsage } from './cc/usage.js'
import { readListingBudget } from './cc/listing.js'
import { mergeSkillLayers } from './core/policy.js'
import { normalizeServers } from './core/mcp-policy.js'
import { normalizeDefinition } from './core/mcp-definition.js'
import { templateFromCc } from './core/mcp-definition.js'

/** 左侧列表里「全局」那一项的 key。 */
export const GLOBAL_WS = 'global'

/**
 * @param workspace 工作区路径，或 GLOBAL_WS
 * @param config    插件配置（ccHome / claudeMcp / claudeJson / contextWindowTokens）
 * @returns 归一化的策略与来源清单
 */
export function loadWorkspace({ workspace, config = {}, warnings = [] } = {}) {
  const isGlobal = !workspace || workspace === GLOBAL_WS
  const projectDir = isGlobal ? null : workspace
  const own = configPaths({ projectDir: projectDir ?? config.projectDir })

  const ccLayers = claudeSettingsLayers(projectDir, config.ccHome)
  const layerDefs = [
    ccLayers[0],                                              // CC 用户
    { file: own.globalFile, label: '全局', scope: 'plugin' },  // 本插件全局
    ...ccLayers.slice(1),                                     // CC 项目 / CC 项目本地
  ]
  if (!isGlobal) layerDefs.push({ file: own.projectFile, label: '项目', scope: 'plugin' })

  const layers = layerDefs.map((entry) => {
    const doc = readJsonFile(entry.file, warnings)
    const parsed = parseSkillOverrides(doc, entry)
    for (const message of parsed.warnings) warnings.push(message)
    return { ...entry, doc, skills: parsed.skills }
  })
  const docOf = new Map(layers.map((layer) => [layer.file, layer.doc]))

  // ── skills ──
  const skills = mergeSkillLayers(layers)

  // ── CC 的全局状态文件（MCP 定义 + 使用统计）──────
  const ccEnabled = config.claudeMcp !== false
  const claudeDoc = ccEnabled
    ? readJsonSafe(config.claudeJson ?? claudeJsonPath(config.ccHome), warnings)
    : null
  const claudeMcp = ccEnabled
    ? readClaudeMcp({ cwd: projectDir, home: config.ccHome, doc: claudeDoc, warnings })
    : null
  const usage = readSkillUsage(claudeDoc)

  // ── mcp ──
  const servers = new Map(buildBaseline(claudeMcp))
  const ownFiles = isGlobal ? [own.globalFile] : [own.globalFile, own.projectFile]
  ownFiles.forEach((file, index) => {
    const parsed = normalizeServers(docOf.get(file)?.mcp?.servers, file, warnings)
    for (const [name, entry] of parsed) {
      // 本插件的配置只覆盖「门禁状态」；**归属层仍按谁声明的连接来算**。
      // 否则给一台「仅 CC 声明」的服务器点一下开关，它会从 CC 组跳到本项目组 —— 看着像被搬走了。
      const previous = servers.get(name)
      servers.set(name, {
        ...entry,
        layer: previous?.layer === 'cc' ? 'cc' : (index === 0 ? 'global' : 'project'),
        file: previous?.layer === 'cc' ? previous.file : file,
        stateFile: file,
        ccScope: previous?.ccScope ?? null,
        ccApproved: previous?.ccApproved ?? null,
        ccRejected: previous?.ccRejected ?? false,
      })
    }
  })

  // ── 连接定义（本插件代管，启动时灌给 loader）──
  const definitions = new Map()

  // 项目级 CC 文件 `<ws>/.mcp.json` 作为基础层：同一个文件 CC 和 DSH 都能用。
  // 本插件自己的配置覆盖它（同名时以本插件为准）。
  if (!isGlobal) {
    const mcpJsonFile = claudeMcpProjectFile(workspace)
    const doc = readJsonFile(mcpJsonFile, warnings)
    const block = doc?.mcpServers
    for (const [name, value] of Object.entries(block && typeof block === 'object' && !Array.isArray(block) ? block : {})) {
      try {
        const config = normalizeDefinition({ ...templateFromCc(name, value), serverName: name })
        definitions.set(name, { file: mcpJsonFile, config, source: 'mcp.json' })
      } catch (error) {
        warnings.push(`${mcpJsonFile}: ${name} 不是可用的连接定义 — ${error.message}`)
      }
    }
  }
  for (const file of ownFiles) {
    const block = docOf.get(file)?.mcp?.definitions
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue
    for (const [name, raw] of Object.entries(block)) {
      try {
        definitions.set(name, {
          file,
          source: 'plugin',
          config: normalizeDefinition({ ...raw, serverName: raw?.serverName ?? name }),
        })
      } catch (error) {
        warnings.push(`${file}: mcp.definitions.${name} 无效 — ${error.message}`)
      }
    }
  }

  // 我们在自己的配置里给了定义 = 接管了这台（「复制到 DSH」/ 编辑器保存）。
  // 归属层跟着定义所在的作用域走：否则复制过来的行还赖在「仅 CC 声明」组里，
  // 改名 / 删除 / 延迟全被锁住 —— 看起来就像「复制了但没接管」。
  for (const [name, entry] of definitions) {
    if (entry.source !== 'plugin') continue
    const server = servers.get(name)
    if (!server) continue
    server.layer = entry.file === own.globalFile ? 'global' : 'project'
    server.file = entry.file
  }

  // 有连接定义但还没登记门禁状态的服务器：补一条（否则面板上看不到它）
  for (const [name, entry] of definitions) {
    if (servers.has(name)) continue
    servers.set(name, {
      state: 'on',
      tools: new Map(),
      layer: entry.file === own.globalFile ? 'global' : 'project',
      file: entry.file,
      stateFile: null,
      ccScope: null,
      ccApproved: null,
      ccRejected: false,
    })
  }

  // 最后统一标「有没有连接定义」——必须放在合成之后，
  // 否则合成出来的条目会漏掉这个标记（面板就会以为它没定义，延迟按钮永远灰着）
  for (const [name, entry] of servers) {
    entry.hasDefinition = definitions.has(name)
    if (entry.stateFile === undefined) entry.stateFile = null
  }

  // ── 目录预算 ──
  const budget = readListingBudget({
    layers: layers.map((layer) => ({ file: layer.file, doc: layer.doc })),
    config,
  })
  for (const message of budget.warnings) warnings.push(message)

  return {
    workspace: isGlobal ? GLOBAL_WS : workspace,
    projectDir,
    warnings,
    files: layers.map((layer) => layer.file),
    layers,
    skills,
    servers,
    definitions,
    usage,
    budget,
    claudeMcp: claudeMcp
      ? {
        files: claudeMcp.files,
        disabled: [...claudeMcp.disabled].sort(),
        enabled: [...claudeMcp.enabled].sort(),
        enableAll: claudeMcp.enableAll,
        // 面板快照不带 env（里面常有 token）；要用的走下面那份 ccDefinitions
        servers: [...claudeMcp.servers].map(([name, info]) => ({
          name,
          scope: info.scope,
          file: info.file,
          rejected: info.rejected,
          approved: info.approved,
          definition: info.definition ? { ...info.definition, env: undefined } : undefined,
        })),
      }
      : null,
    /** CC 声明的完整连接定义（含 env），供「复制到 DSH」与编辑器初稿使用。 */
    ccDefinitions: new Map([...(claudeMcp?.servers ?? new Map())]
      .filter(([, info]) => info.definition)
      .map(([name, info]) => [name, info.definition])),
  }
}
