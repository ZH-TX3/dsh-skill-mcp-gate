/**
 * CC「目录预算」两个设置键的读取与换算。
 *
 * CC 的做法：
 *   skillListingBudgetFraction   占上下文窗口的比例（默认 0.01）
 *   SLASH_COMMAND_TOOL_CHAR_BUDGET  环境变量，直接给固定字符数（优先级更高）
 *   skillListingMaxDescChars     单条描述上限（默认 1536）
 *
 * 本插件能落地的只有「总字符预算」这一半：
 * 单条上限落不了 —— DSH 上游 `catalogDescriptionMaxLength`（默认 500）已经把描述截短，
 * 这里拿不到原文，只能降不能升，所以那个键如实报不支持。
 */

const ENV_BUDGET = 'SLASH_COMMAND_TOOL_CHAR_BUDGET'

/** 拆成「能算出字符预算」与「有值但落不了地」两类。 */
export function readListingBudget({ layers = [], config = {}, env = process.env } = {}) {
  const warnings = []
  const unsupported = []

  let fraction = null
  let fractionSource = null
  for (const layer of layers) {
    const raw = layer?.doc?.skillListingBudgetFraction
    if (raw === undefined) continue
    if (typeof raw !== 'number' || !(raw > 0) || raw > 1) {
      warnings.push(`${layer.file}: skillListingBudgetFraction 需要是 (0,1] 之间的小数，本次忽略`)
      continue
    }
    fraction = raw
    fractionSource = layer.file
  }

  for (const layer of layers) {
    if (layer?.doc?.skillListingMaxDescChars === undefined) continue
    unsupported.push({ key: 'skillListingMaxDescChars', file: layer.file, reason: '描述已被 DSH 上游截到 catalogDescriptionMaxLength，无法放大' })
  }

  const envRaw = env?.[ENV_BUDGET]
  if (envRaw !== undefined && envRaw !== '') {
    const chars = Number(envRaw)
    if (Number.isFinite(chars) && chars > 0) {
      return { chars: Math.floor(chars), source: `环境变量 ${ENV_BUDGET}`, fraction, fractionSource, unsupported, warnings }
    }
    warnings.push(`${ENV_BUDGET}="${envRaw}" 不是正数，本次忽略`)
  }

  if (fraction === null) return { chars: null, source: null, fraction, fractionSource, unsupported, warnings }

  const window = Number(config.contextWindowTokens)
  if (!Number.isFinite(window) || window <= 0) {
    warnings.push('skillListingBudgetFraction 需要配合 contextWindowTokens（本插件拿不到上下文窗口大小），本次不启用预算')
    return { chars: null, source: null, fraction, fractionSource, unsupported, warnings }
  }

  return {
    chars: Math.floor(window * fraction),
    source: `${fractionSource} × contextWindowTokens=${window}`,
    fraction,
    fractionSource,
    unsupported,
    warnings,
  }
}
