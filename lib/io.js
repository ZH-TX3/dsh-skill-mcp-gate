/**
 * 配置文件读写（通用 I/O）。只写本插件自己的文件，绝不碰 profile 组合、也不碰 SKILL.md。
 * 路径知识在 paths.js，这里只管字节。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJsonFile(file, warnings) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    warnings?.push(`${file}: JSON 解析失败 — ${error.message}`)
    return null
  }
}

/** 原子写：先写临时文件再 rename，避免半截文件。 */
export function writeJsonFile(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 读-改-写；mutator 返回 false 表示无需写盘。 */
export function updateJsonFile(file, mutator) {
  const current = existsSync(file) ? readJsonFile(file) ?? {} : {}
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    throw new Error(`${file} 顶层必须是对象，无法安全写入`)
  }
  const draft = structuredClone(current)
  const result = mutator(draft)
  if (result === false) return current
  writeJsonFile(file, result)
  return result
}

/** 把某个 skill 的档位写进指定层；`on` 等价于清除覆盖，保持文件干净。 */
export function setSkillState(file, name, state) {
  if (state === 'on') {
    return updateJsonFile(file, (doc) => {
      let changed = false
      for (const block of ['skills', 'skillOverrides']) {
        if (doc[block] && typeof doc[block] === 'object' && name in doc[block]) {
          delete doc[block][name]
          changed = true
          if (Object.keys(doc[block]).length === 0) delete doc[block]
        }
      }
      return changed ? doc : false
    })
  }
  return updateJsonFile(file, (doc) => {
    if (!doc.skills || typeof doc.skills !== 'object') doc.skills = {}
    doc.skills[name] = state
    return doc
  })
}

export function setServerState(file, server, state) {
  return updateJsonFile(file, (doc) => {
    if (!doc.mcp || typeof doc.mcp !== 'object') doc.mcp = {}
    if (!doc.mcp.servers || typeof doc.mcp.servers !== 'object') doc.mcp.servers = {}
    const current = doc.mcp.servers[server]
    if (state === 'on') {
      // 只清服务器的 on/off，保留逐工具配置
      if (current === undefined) return false
      if (typeof current === 'string') { delete doc.mcp.servers[server]; return doc }
      delete current.state
      if (!current.tools || Object.keys(current.tools).length === 0) delete doc.mcp.servers[server]
      else doc.mcp.servers[server] = current
      return doc
    }
    if (typeof current === 'string') doc.mcp.servers[server] = state
    else {
      const entry = { ...(current ?? {}), state }
      // 没有逐工具配置时退回字符串形式，配置更干净
      if (!entry.tools || Object.keys(entry.tools).length === 0) {
        delete entry.tools
        const keys = Object.keys(entry)
        doc.mcp.servers[server] = keys.length === 1 && keys[0] === 'state' ? state : entry
      } else doc.mcp.servers[server] = entry
    }
    return doc
  })
}

/** 批量登记服务器名（自定义填入）；已存在的保持原状。 */
export function addServerNames(file, names) {
  return updateJsonFile(file, (doc) => {
    if (!doc.mcp || typeof doc.mcp !== 'object') doc.mcp = {}
    if (!doc.mcp.servers || typeof doc.mcp.servers !== 'object') doc.mcp.servers = {}
    let changed = false
    for (const name of names) {
      if (doc.mcp.servers[name] === undefined) {
        doc.mcp.servers[name] = 'on'
        changed = true
      }
    }
    return changed ? doc : false
  })
}

/** 逐工具开关；服务器条目会自动升级成对象形式。 */
export function setToolState(file, server, tool, state) {
  return updateJsonFile(file, (doc) => {
    if (!doc.mcp || typeof doc.mcp !== 'object') doc.mcp = {}
    if (!doc.mcp.servers || typeof doc.mcp.servers !== 'object') doc.mcp.servers = {}
    const current = doc.mcp.servers[server]
    const entry = typeof current === 'string' ? { state: current } : { ...(current ?? {}) }
    if (!entry.tools || typeof entry.tools !== 'object') entry.tools = {}
    if (state === 'on') delete entry.tools[tool]
    else entry.tools[tool] = state
    if (Object.keys(entry.tools).length === 0) delete entry.tools
    if (entry.state === undefined && entry.tools === undefined) delete doc.mcp.servers[server]
    else doc.mcp.servers[server] = entry
    return doc
  })
}
