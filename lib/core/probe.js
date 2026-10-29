/**
 * 探测规划（纯函数）：给定一条服务器记录，决定「怎么验证它通不通」。
 *
 * 三种结论：
 *   http  —— CC 文件里有 url，可以真发一次请求
 *   stdio —— CC 文件里有 command，只能验证可执行文件在不在（不启动进程）
 *   unknown —— 看不到定义，如实说为什么
 *
 * 这一层不联网、不碰 fs，方便单测；执行在 platform/probe.js。
 */

/** `${VAR}` / `${VAR:-default}` 的展开；缺失且无默认值时保留原样。 */
export function expandEnv(value, env = process.env) {
  if (typeof value !== 'string') return value
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, key, fallback) => {
    const found = env?.[key]
    if (found !== undefined) return found
    return fallback !== undefined ? fallback : whole
  })
}

/**
 * @param info { connected, ccScope, definition }
 * @returns {{ mode:'http', url, headers } | { mode:'stdio', command, args } | { mode:'unknown', reason }}
 */
export function planProbe(info = {}) {
  const definition = info.definition ?? undefined
  const connected = info.connected === true

  if (definition?.url) {
    const headers = {}
    for (const [key, value] of Object.entries(definition.headers ?? {})) {
      if (typeof value === 'string') headers[key] = expandEnv(value)
    }
    return { mode: 'http', url: expandEnv(definition.url), headers }
  }
  if (definition?.command) {
    return { mode: 'stdio', command: definition.command, args: definition.args ?? [] }
  }
  if (connected) {
    return { mode: 'unknown', reason: '已在 DSH 里连上，但连接定义在 DSH profile 里，这里看不到（要看连通性直接看工具是否出现）' }
  }
  if (info.ccScope) {
    return { mode: 'unknown', reason: 'Claude Code 里有这台服务器的声明，但没读到可用的 url / command' }
  }
  return { mode: 'unknown', reason: '只在本插件里登记过名字，没有连接定义，DSH 也没有连上它' }
}

/** 探测结果的一句话展示。 */
export function describeProbe(result) {
  if (!result) return ''
  if (result.mode === 'unknown') return `无法探测：${result.reason}`
  if (result.mode === 'http') return `${result.ok ? '可达' : '不可达'} · ${result.detail}`
  return `${result.ok ? '可执行' : '不可执行'} · ${result.detail}`
}
