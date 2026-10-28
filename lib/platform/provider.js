/**
 * DSH 接缝之三：额外 skill provider。
 *
 * DSH 自带的 filesystem provider 只扫 `.dsh/skills` / `.agents/skills`，
 * 不认 CC 的 `.claude/skills`。这里注册一个只读 provider 补上，
 * 好处是不用改用户 profile 的 `customSkillDirs` —— 卸载即干净。
 *
 * 扫描规则在 cc/skills.js，这一层只负责包成 DSH 认识的 provider 形状。
 */

import { readFileSync } from 'node:fs'
import { skillDirs } from '../paths.js'
import { parseFrontmatter, scanSkillDir } from '../cc/skills.js'

export function createSkillProvider({
  name = 'claude-skills',
  home,
  onGaps = () => {},
  log = () => {},
} = {}) {
  return {
    name,
    async list(options) {
      const cwd = options && options.cwd
      const dirs = skillDirs(typeof cwd === 'string' ? cwd : null, home)
      const found = []
      for (const entry of [...dirs.project, ...dirs.user]) {
        found.push(...scanSkillDir(entry.dir, {
          rank: entry.rank,
          source: entry.source,
          providerName: name,
          report: onGaps,
        }))
      }
      log('skill 候选取自额外 provider', found.length)
      return found
    },
    async get(candidate) {
      const file = candidate?.locator?.file
      if (typeof file !== 'string') return undefined
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
      const { body } = parseFrontmatter(text)
      return {
        name: candidate.name,
        description: candidate.description,
        whenToUse: candidate.whenToUse,
        source: candidate.source,
        provider: name,
        path: file,
        invocation: candidate.invocation,
        content: body,
      }
    },
  }
}
