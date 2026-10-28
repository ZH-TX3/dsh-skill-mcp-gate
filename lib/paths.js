/**
 * 文件位置总表：所有「东西在哪」的知识都在这一个文件里。
 *
 * 这一层只回答「路径」，不解析内容、不做决策、不认识状态。
 * 新增一种配置来源时，改这里 + 对应的 cc/ 或 core/ 模块即可。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'

/** 本插件自己的配置文件（全局 / 项目） */
export function configPaths(config = {}) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const projectDir = config.projectDir ? config.projectDir : process.cwd()
  return {
    globalFile: join(dshHome, 'skill-mcp-gate', 'settings.json'),
    projectFile: join(projectDir, '.dsh', 'skill-mcp-gate.json'),
    projectDir,
  }
}

/** Claude Code 的家目录基准（`--home` 覆盖用于测试）。 */
export function ccHome(home) {
  return home ?? homedir()
}

/** CC 的全局状态文件（含 mcpServers / projects / skillUsage）。 */
export function claudeJsonPath(home) {
  return join(ccHome(home), '.claude.json')
}

/** CC 的项目级 MCP 文件。 */
export function claudeMcpProjectFile(cwd) {
  return join(cwd, '.mcp.json')
}

/**
 * CC 的设置文件，顺序即优先级（低 → 高），与 CC 自己的层叠一致。
 * cwd 为 null / 空时只返回用户级。
 */
export function claudeSettingsLayers(cwd, home) {
  const base = ccHome(home)
  const out = [{ file: join(base, '.claude', 'settings.json'), label: 'CC 用户', scope: 'user' }]
  if (typeof cwd === 'string' && cwd.length > 0) {
    out.push({ file: join(cwd, '.claude', 'settings.json'), label: 'CC 项目', scope: 'project' })
    out.push({ file: join(cwd, '.claude', 'settings.local.json'), label: 'CC 项目本地', scope: 'local' })
  }
  return out
}

/**
 * Claude Code 的 rules 目录（`.claude/rules/**\/*.md`，递归）。
 * 带 `paths` frontmatter 的规则只在读写命中文件时注入；不带的在会话开始时注入。
 */
export function claudeRulesDirs(cwd, home) {
  const base = ccHome(home)
  const out = [{ dir: join(base, '.claude', 'rules'), scope: 'user' }]
  if (typeof cwd === 'string' && cwd.length > 0) {
    out.push({ dir: join(cwd, '.claude', 'rules'), scope: 'project' })
  }
  return out
}

/**
 * skill 根目录。rank 与 DSH 自带 filesystem provider 同一标尺（越小越优先）。
 * 项目级按 cwd 解析；CC 的 `.claude/skills` DSH 自带 provider 不认，所以由本插件的 provider 一并扫。
 */
export function skillDirs(cwd, home) {
  const base = ccHome(home)
  const user = [
    { dir: join(base, '.claude', 'skills'), rank: 450, source: 'claude-user' },
    { dir: join(base, '.dsh', 'skills'), rank: 400, source: 'user-dsh' },
    { dir: join(base, '.agents', 'skills'), rank: 500, source: 'user-agents' },
  ]
  const project = []
  if (typeof cwd === 'string' && cwd.length > 0) {
    project.push(
      { dir: join(cwd, '.claude', 'skills'), rank: 150, source: 'claude-project' },
      { dir: join(cwd, '.dsh', 'skills'), rank: 100, source: 'project-dsh' },
      { dir: join(cwd, '.agents', 'skills'), rank: 200, source: 'project-agents' },
    )
  }
  return { project, user }
}
