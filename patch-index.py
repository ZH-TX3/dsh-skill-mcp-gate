import io

p = 'index.js'
s = io.open(p, encoding='utf-8', newline='').read().replace('\r\n', '\n')

pairs = []

pairs.append((
"""import {
  addServerNames, removeServer, renameServer, setServerState, setSkillState, setToolState,
} from './lib/io.js'""",
"""import {
  addServerNames, removeDefinition, removeServer, renameServer, setDefinition,
  setServerState, setSkillState, setToolState,
} from './lib/io.js'"""))

pairs.append((
"""    const managed = connections.find(serverName)
    const definition = managed ? probeInfoFromConfig(managed.config) : ccInfo?.definition""",
"""    const owned = current?.definitions?.get(serverName)
    const definition = owned ? probeInfoFromConfig(owned.config) : ccInfo?.definition"""))

pairs.append((
"""      ccScope: managed ? null : (entry?.ccScope ?? ccInfo?.scope ?? null),""",
"""      ccScope: owned ? null : (entry?.ccScope ?? ccInfo?.scope ?? null),"""))

pairs.append((
"""  /** 编辑器要显示的 JSON：优先 DSH 已配置的，否则用 CC 的定义当模板。 */
  function getDefinition(serverName) {
    const managed = connections.find(serverName)
    if (managed) {
      return { server: serverName, managed: true, config: managed.config, id: managed.id, source: 'dsh' }
    }
    const template = templateFromCc(serverName, ccDefinitionOf(serverName))
    return { server: serverName, managed: false, config: template, source: ccDefinitionOf(serverName) ? 'claude-code' : 'blank' }
  }

  /** 保存 JSON → 校验 → 写 profile → 热加载。 */
  async function saveDefinition(serverName, json) {
    let parsed
    if (typeof json === 'string') {
      try {
        parsed = JSON.parse(json)
      } catch (error) {
        throw new Error(`JSON 解析失败：${error.message}`)
      }
    } else {
      parsed = json
    }
    const config = normalizeDefinition({ ...parsed, serverName: parsed?.serverName ?? serverName })
    const existing = connections.find(serverName)
    if (existing && config.serverName !== serverName) {
      // 改名 = 删旧建新，避免留下两条指向同一台服务器的连接
      connections.remove(serverName)
    }
    const result = await connections.upsert(config)
    reload(current.workspace)
    return { ...result, config }
  }

  function deleteDefinition(serverName) {
    const removed = connections.remove(serverName)
    if (!removed) throw new Error(`DSH 里没有 "${serverName}" 的连接配置`)
    reload(current.workspace)
    return { id: removed }
  }""",
"""  /** 编辑器要显示的 JSON：优先本插件代管的定义，否则用 CC 的定义当模板。 */
  function getDefinition(serverName) {
    const owned = current?.definitions?.get(serverName)
    if (owned) {
      return { server: serverName, managed: true, config: owned.config, source: 'plugin', file: owned.file }
    }
    const template = templateFromCc(serverName, ccDefinitionOf(serverName))
    return {
      server: serverName,
      managed: false,
      config: template,
      source: ccDefinitionOf(serverName) ? 'claude-code' : 'blank',
    }
  }

  /** 保存 JSON → 校验 → 写本插件配置 → 立刻热加载。 */
  async function saveDefinition(serverName, json) {
    let parsed
    if (typeof json === 'string') {
      try {
        parsed = JSON.parse(json)
      } catch (error) {
        throw new Error(`JSON 解析失败：${error.message}`)
      }
    } else {
      parsed = json
    }
    const config = normalizeDefinition({ ...parsed, serverName: parsed?.serverName ?? serverName })
    const { ws, file } = writeTarget()
    // 改名 = 删旧存新，避免留下两条指向同一台服务器的连接
    if (config.serverName !== serverName) removeDefinition(file, serverName)
    setDefinition(file, config.serverName, config)
    reload(ws)
    const result = await connections.upsert(config)
    return { ...result, config, file, workspace: ws }
  }

  async function deleteDefinition(serverName) {
    const owned = current?.definitions?.get(serverName)
    if (!owned) throw new Error(`本插件里没有 "${serverName}" 的连接定义`)
    if (!removeDefinition(owned.file, serverName)) throw new Error(`删除失败：${owned.file} 里没有这条定义`)
    reload(current.workspace)
    const removedId = connections.remove(serverName)
    return { id: removedId ?? null, file: owned.file }
  }

  /** 启动 / 保存后：把配置里的定义灌进 loader。 */
  async function syncConnections() {
    const result = await connections.sync(current?.definitions)
    for (const failure of result.failed) warn(`MCP 连接失败: ${failure.name} — ${failure.reason}`)
    return result
  }"""))

pairs.append((
"""    connections: connections.status(),""",
"""    connections: { ...connections.status(), managed: [...(current?.definitions?.keys() ?? [])] },"""))

pairs.append((
"""  rulesInjector?.install()""",
"""  syncConnections().catch((error) => warn(`灌入 MCP 连接失败: ${error.message}`))

  rulesInjector?.install()"""))

for old, new in pairs:
    assert old in s, 'anchor missing: ' + old[:60]
    s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s.replace('\n', '\r\n'))
print('index patched')
