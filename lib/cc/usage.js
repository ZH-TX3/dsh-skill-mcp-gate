/**
 * CC 的 skill 使用统计（只读），用于目录预算「最不常用的先丢描述」的排序。
 *
 * 数据在 `~/.claude.json` 的 `skillUsage`：
 *   { "<name>": { "usageCount": 12, "lastUsedAt": 1789115533651 } }
 *
 * 没有记录 = 没用过 = 最不常用，由 core/listing 按 0 处理。
 */

export function readSkillUsage(doc) {
  const usage = new Map()
  const raw = doc?.skillUsage
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return usage
  for (const [name, record] of Object.entries(raw)) {
    if (!record || typeof record !== 'object') continue
    const count = Number(record.usageCount ?? record.count ?? 0)
    const lastUsedAt = Number(record.lastUsedAt ?? 0)
    usage.set(name, {
      count: Number.isFinite(count) ? count : 0,
      lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : 0,
    })
  }
  return usage
}
