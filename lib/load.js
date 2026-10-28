/**
 * 装载层：一个工作区的全部配置 → 归一化后的策略。
 *
 * 这是唯一知道「配置文件有哪几层、谁覆盖谁」的地方。
 * 上面的 index.js 只管把结果交给 DSH，下面的 cc/ 只管解析、core/ 只管合并。
 *
 * 层序（低 → 高）：CC 用户 → 本插件全局 → CC 项目 → CC 项目本地 → 本插件项目
 */

import { claudeJsonPath, claudeSettingsLayers, configPaths } from './paths.js'
import { readJsonFile } from './io.js'
import { parseSkillOverrides } from './cc/skills.js'
import { readClaudeMcp, buildBaseline, readJsonSafe } from './cc/mcp.js'
import { readSkillUsage } from './cc/usage.js'
import { readListingBudget } from './cc/listing.js'
import { mergeSkillLayers } from './core/policy.js'
import { normalizeServers } from './core/mcp-policy.js'

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
      // 本插件的配置覆盖 CC 基线的状态，但保留 CC 的出处信息（面板要标 tag）
      const previous = servers.get(name)
      servers.set(name, {
        ...entry,
        layer: index === 0 ? 'global' : 'project',
        file,
        ccScope: previous?.ccScope ?? null,
        ccApproved: previous?.ccApproved ?? null,
        ccRejected: previous?.ccRejected ?? false,
      })
    }
  })

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
    usage,
    budget,
    claudeMcp: claudeMcp
      ? {
        files: claudeMcp.files,
        disabled: [...claudeMcp.disabled].sort(),
        enabled: [...claudeMcp.enabled].sort(),
        enableAll: claudeMcp.enableAll,
        servers: [...claudeMcp.servers].map(([name, info]) => ({ name, ...info })),
      }
      : null,
  }
}
