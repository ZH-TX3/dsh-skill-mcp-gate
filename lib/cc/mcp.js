/**
 * CC 的 MCP 侧知识：三处定义源 + 批准/拒绝语义（只读）。
 *
 *   ~/.claude.json  `.mcpServers`                 → user scope（全机器）
 *   ~/.claude.json  `.projects[cwd].mcpServers`   → local scope（只这个项目）
 *   <cwd>/.mcp.json `.mcpServers`                 → project scope（要批准才连）
 *
 * 批准状态在 settings 里（disabled 优先级最高）：
 *   disabledMcpjsonServers / enabledMcpjsonServers / enableAllProjectMcpServers
 *
 * 只取名字与批准状态，不解析 command / args / env —— 连接是 DSH 自己的事。
 */

import { existsSync, readFileSync } from 'node:fs'
import { claudeJsonPath, claudeSettingsLayers } from '../paths.js'

/** scope 具体度：同名服务器以更具体的来源为准。 */
const SCOPE_RANK = { user: 0, project: 1, local: 2 }

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/

/** CC 用 `D:/Work/app` 这种正斜杠写法当 projects 的键，比较前统一。 */
export function normalizeCwd(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function readJsonSafe(file, warnings) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    warnings?.push(`${file}: JSON 解析失败 — ${error.message}`)
    return null
  }
}

function asNames(value, file, warnings) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warnings?.push(`${file}: 期望字符串数组，实际是 ${typeof value}`)
    return []
  }
  return value.filter((item) => typeof item === 'string' && item.length > 0)
}

/**
 * 从一条服务器配置里抽出「探测够用」的那点定义。
 * 连接本身是 DSH 的事，这里只是为了让面板能说明「它长什么样、怎么连」。
 */
export function definitionOf(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const type = typeof value.type === 'string' ? value.type : (value.url ? 'http' : 'command' in value ? 'stdio' : undefined)
  return {
    type,
    url: typeof value.url === 'string' ? value.url : undefined,
    command: typeof value.command === 'string' ? value.command : undefined,
    args: Array.isArray(value.args) ? value.args.filter((item) => typeof item === 'string') : undefined,
    headers: value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers) ? value.headers : undefined,
  }
}

function collect(block, file, scope, servers, warnings) {
  if (block === undefined) return
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    warnings?.push(`${file}: mcpServers 必须是对象`)
    return
  }
  for (const name of Object.keys(block)) {
    if (!NAME_RE.test(name)) {
      warnings?.push(`${file}: 服务器名 "${name}" 不合法，忽略`)
      continue
    }
    const previous = servers.get(name)
    if (previous && SCOPE_RANK[previous.scope] >= SCOPE_RANK[scope]) continue
    servers.set(name, { scope, file, definition: definitionOf(name, block[name]) })
  }
}

/**
 * @param cwd        工作区目录；null 表示只看用户级
 * @param home       覆盖家目录（测试用）
 * @param claudeJson 覆盖 ~/.claude.json 路径（测试用）
 * @param warnings   收集警告
 */
export function readClaudeMcp({ cwd, home, claudeJson, doc: givenDoc, warnings } = {}) {
  const jsonFile = claudeJson ?? claudeJsonPath(home)
  const servers = new Map()
  const files = []
  const disabled = new Set()
  const enabled = new Set()
  let enableAll = null

  // 调用方已经解析过同一个文件时直接复用，避免重复解析几百 KB
  const doc = givenDoc !== undefined ? givenDoc : readJsonSafe(jsonFile, warnings)
  if (doc && typeof doc === 'object') {
    files.push(jsonFile)
    collect(doc.mcpServers, jsonFile, 'user', servers, warnings)
    if (cwd) {
      const key = normalizeCwd(cwd)
      const projects = doc.projects && typeof doc.projects === 'object' ? doc.projects : {}
      for (const [raw, entry] of Object.entries(projects)) {
        if (normalizeCwd(raw) !== key) continue
        collect(entry?.mcpServers, jsonFile, 'local', servers, warnings)
      }
    }
  }

  // 注意：`<cwd>/.mcp.json` 不在这里读。
  // 它是本插件与 Claude Code 共用的项目级定义文件（见 load.js），
  // 由本插件按「项目定义」处理 —— 否则它会先被当成「仅 CC 声明」占住名字，
  // 面板上就归到「仅 Claude Code 声明」组（默认折叠），关掉后层又变成 project，
  // 看起来就像「关一下就消失了」。

  // 批准状态：低 → 高（用户 → 项目 → 项目本地）；拒绝取并集，enableAll 取最高层
  for (const entry of claudeSettingsLayers(cwd, home)) {
    const settings = readJsonSafe(entry.file, warnings)
    if (!settings || typeof settings !== 'object') continue
    files.push(entry.file)
    for (const name of asNames(settings.disabledMcpjsonServers, entry.file, warnings)) disabled.add(name)
    for (const name of asNames(settings.enabledMcpjsonServers, entry.file, warnings)) enabled.add(name)
    if (typeof settings.enableAllProjectMcpServers === 'boolean') enableAll = settings.enableAllProjectMcpServers
  }

  for (const [name, info] of servers) {
    const rejected = disabled.has(name)
    info.rejected = rejected
    // user / local 作用域本来就是用户自己的，不需要批准；project 作用域要
    info.approved = info.scope === 'project'
      ? !rejected && (enableAll === true || enabled.has(name))
      : !rejected
  }

  return { servers, disabled, enabled, enableAll, files }
}

/**
 * CC 的定义 → 本插件的基线层：被 CC 拒绝的默认 off，其余 on。
 * 本插件自己的配置文件覆盖这一层。
 */
export function buildBaseline(claude) {
  const baseline = new Map()
  if (!claude) return baseline
  for (const [name, info] of claude.servers) {
    baseline.set(name, {
      state: info.rejected ? 'off' : 'on',
      tools: new Map(),
      layer: 'cc',
      file: info.file,
      ccScope: info.scope,
      ccApproved: info.approved,
      ccRejected: info.rejected,
    })
  }
  return baseline
}
