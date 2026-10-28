/**
 * 目录预算规划（纯函数），语义对齐 Claude Code：
 *
 *   - 名字永远全部保留，只有描述会被丢弃
 *   - 超预算时从「最不常用」的 skill 开始丢描述
 *   - `name-only` 本来就是无描述，不参与丢弃
 *
 * 与 CC 的差别只有一处：CC 用「上下文窗口的 1%」当预算，这里拿不到窗口大小，
 * 所以预算必须由调用方给出（env `SLASH_COMMAND_TOOL_CHAR_BUDGET` 或配置里显式换算）。
 */

/** 单条目录项的渲染代价（与 platform/catalog.js 的渲染保持一致）。 */
export function entryCost(entry, withDescription = true) {
  const name = String(entry?.name ?? '')
  if (!withDescription) return `- \`${name}\``.length
  return `- \`${name}\`: ${String(entry?.description ?? '')}`.length
}

/** 目录总字符数。 */
export function listingCost(entries, nameOnly = new Set()) {
  let total = 0
  for (const entry of entries) total += entryCost(entry, !nameOnly.has(entry.name))
  return total
}

function usageKey(usage, name) {
  const record = usage?.get?.(name)
  if (!record) return { count: 0, lastUsedAt: 0 }
  return {
    count: Number(record.count ?? record.usageCount ?? 0) || 0,
    lastUsedAt: Number(record.lastUsedAt ?? 0) || 0,
  }
}

/**
 * @param entries 完整目录条目 [{name, description}]
 * @param states  Map<name, {state}>
 * @param budgetChars 预算字符数；null / 0 表示不启用
 * @param usage Map<name, {count, lastUsedAt}>（可选，用于「最不常用先丢」）
 * @returns { hide, nameOnly, keep, cost }
 */
export function planListing({ entries, states, budgetChars, usage } = {}) {
  const hide = new Set()
  const nameOnly = new Set()
  const policy = states ?? new Map()

  for (const [name, entry] of policy) {
    if (entry.state === 'off' || entry.state === 'user-invocable-only') hide.add(name)
    else if (entry.state === 'name-only') nameOnly.add(name)
  }

  const keep = (entries ?? []).filter((entry) => !hide.has(entry.name))
  const before = listingCost(keep, nameOnly)
  const dropped = []

  if (budgetChars > 0 && before > budgetChars) {
    // 仍有描述的条目：按使用次数升序（越少用越先丢），同次数时先丢描述长的（更快降下来）
    const candidates = keep
      .filter((entry) => !nameOnly.has(entry.name))
      .map((entry, index) => ({ entry, index, ...usageKey(usage, entry.name) }))
      .sort((a, b) => a.count - b.count
        || b.lastUsedAt - a.lastUsedAt
        || entryCost(b.entry) - entryCost(a.entry)
        || a.index - b.index)

    let cost = before
    for (const candidate of candidates) {
      if (cost <= budgetChars) break
      nameOnly.add(candidate.entry.name)
      const saved = entryCost(candidate.entry) - entryCost(candidate.entry, false)
      cost -= saved
      dropped.push({ name: candidate.entry.name, chars: saved })
    }
  }

  return {
    hide,
    nameOnly,
    keep,
    cost: {
      before,
      after: listingCost(keep, nameOnly),
      budget: budgetChars > 0 ? budgetChars : null,
      dropped,
    },
  }
}
