/**
 * DSH 侧：把 MCP 连接定义真正落地（写 profile + 热加载）。
 *
 * 真源是**本插件自己的配置**（`mcp.definitions`），这里只负责把它灌进运行期：
 *   - 启动时（apply 之后）调 `sync()`，把配置里的每份定义 ensure 成 loader 里的 mcp-client 条目
 *   - 保存 / 删除时立刻 create / update / remove，做到「保存即连上」
 *   - profile 文件一个字节都不写 —— 实测 `loader.write()` 在这个 profile 下是静默失败的
 *     （根装配文件不是可写源），所以绝不依赖它持久化；重启后的连接由下一次 `sync()` 重建
 *
 * 代价与取舍：这些连接在语义上归本插件代管 —— 插件被禁用，它们跟着消失。这是对的。
 */

// 必须写可解析的包名：loader 用这个名字 import 插件模块。
// 裸 'mcp-client' 解析不到，条目会创建成功但 import 失败 —— 表现就是「连不上、工具永远不出现」。
const PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'

export function createMcpConnections({ ctx, log = () => {} }) {
  const errors = []
  const createdNames = new Set()   // 本进程里由我们建过的连接，回收时只动这些

  function loader() {
    const service = (typeof ctx.get === 'function' ? ctx.get('loader') : undefined) ?? ctx.loader
    if (!service || typeof service.create !== 'function') return undefined
    return service
  }

  function requireLoader() {
    const service = loader()
    if (!service) throw new Error('当前运行环境没有 loader 服务，无法热加载 MCP 连接（改完只能重启让 profile 生效）')
    return service
  }

  /** 所有本插件管理的 mcp-client 条目。 */
  function list() {
    const service = loader()
    if (!service || typeof service.entries !== 'function') return []
    const out = []
    for (const entry of service.entries()) {
      if (entry?.options?.name !== PLUGIN_NAME) continue
      const config = entry.options.config ?? {}
      const serverName = typeof config.serverName === 'string' ? config.serverName : ''
      if (serverName.length === 0) continue
      out.push({ id: entry.id, serverName, config, disabled: entry.disabled === true })
    }
    return out
  }

  function find(serverName) {
    return list().find((item) => item.serverName === serverName)
  }

  /** 创建或更新一条运行期连接；返回 { id, created }。 */
  async function upsert(config) {
    const service = requireLoader()
    const existing = find(config.serverName)
    if (existing) {
      await service.update(existing.id, { name: PLUGIN_NAME, config })
      log('更新 MCP 连接', config.serverName, existing.id)
      return { id: existing.id, created: false }
    }
    const id = await service.create({ name: PLUGIN_NAME, config })
    createdNames.add(config.serverName)
    log('新建 MCP 连接', config.serverName, id)
    return { id, created: true }
  }

  /** 删掉运行期连接；返回被删掉的 id，没找到返回 undefined。 */
  function remove(serverName) {
    const service = requireLoader()
    const existing = find(serverName)
    if (!existing) return undefined
    service.remove(existing.id)
    createdNames.delete(serverName)
    log('移除 MCP 连接', serverName, existing.id)
    return existing.id
  }

  /**
   * 把配置里的定义对上运行期：缺的建、变了的改。
   * @param definitions Map<name, { config }>
   */
  async function sync(definitions) {
    const wanted = definitions ?? new Map()
    const result = { created: [], updated: [], removed: [], failed: [] }
    if (!loader()) return result
    for (const [name, entry] of wanted) {
      try {
        const { created } = await upsert(entry.config)
        ;(created ? result.created : result.updated).push(name)
      } catch (error) {
        result.failed.push({ name, reason: error.message })
        errors.push({ scope: 'sync', reason: `${name}: ${error.message}` })
      }
    }
    // 只对当前项目生效：本插件建过、但当前工作区不再定义的连接，断开
    for (const name of [...createdNames]) {
      if (wanted.has(name)) continue
      try {
        if (remove(name)) result.removed.push(name)
        else createdNames.delete(name)
      } catch (error) {
        result.failed.push({ name, reason: error.message })
        errors.push({ scope: 'reconcile', reason: `${name}: ${error.message}` })
      }
    }
    return result
  }

  return {
    list,
    find,
    upsert,
    remove,
    sync,
    available: () => Boolean(loader()),
    status: () => ({
      available: Boolean(loader()),
      active: list().map((item) => item.serverName),
      managed: list().map((item) => item.serverName),
      errors: [...errors],
    }),
  }
}
