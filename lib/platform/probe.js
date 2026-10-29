/**
 * DSH 接缝之外的一层「纯副作用」：真去探测一台 MCP 服务器。
 *
 * - http：发一次 GET，能收到响应就算可达（MCP 端点对 GET 常回 400/405，那也是「通」）
 * - stdio：只在 PATH / 绝对路径里找可执行文件，**不启动进程**（启动第三方 MCP 有副作用）
 *
 * 不缓存结果、不改配置；失败只回话不抛。
 */

import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { planProbe } from '../core/probe.js'

const DEFAULT_TIMEOUT_MS = 4000

function candidatesFor(command, env) {
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : ['']
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return exts.map((ext) => `${command}${ext}`)
  }
  const dirs = String(env?.PATH ?? '').split(delimiter).filter(Boolean)
  const out = []
  for (const dir of dirs) for (const ext of exts) out.push(join(dir, `${command}${ext}`))
  return out
}

/** 在 PATH 里定位命令，找不到返回 undefined。 */
export function resolveCommand(command, env = process.env) {
  for (const candidate of candidatesFor(command, env)) {
    try {
      if (existsSync(candidate)) return candidate
    } catch { /* ignore */ }
  }
  return undefined
}

async function probeHttp(plan, timeoutMs) {
  const started = Date.now()
  try {
    const response = await fetch(plan.url, {
      method: 'GET',
      headers: plan.headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    })
    return {
      mode: 'http',
      ok: true,
      status: response.status,
      detail: `HTTP ${response.status} · ${Date.now() - started}ms`,
    }
  } catch (error) {
    const reason = error?.name === 'TimeoutError'
      ? `${timeoutMs}ms 超时`
      : (error?.cause?.code ?? error?.message ?? '请求失败')
    return { mode: 'http', ok: false, status: null, detail: reason }
  }
}

export async function runProbe(info, { timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  const plan = planProbe(info)
  if (plan.mode === 'unknown') return { mode: 'unknown', ok: false, reason: plan.reason }
  if (plan.mode === 'http') return probeHttp(plan, timeoutMs)

  const found = resolveCommand(plan.command, env)
  return {
    mode: 'stdio',
    ok: Boolean(found),
    detail: found
      ? `找到 ${found}（未启动进程，只验证可执行文件）`
      : `PATH 里找不到 ${plan.command}（未尝试启动）`,
  }
}
