#!/usr/bin/env node
/**
 * 客户端渲染冒烟测试。
 * 不启动浏览器：用假 react 执行 client.js，直接调用面板组件，
 * 收集渲染树里的全部文本，断言 tab 名与分组标题真的出现。
 * （tab 名字曾经因为 jsx 第三参当 key 而整片空白，这个测试能抓住。）
 */

import { readFileSync } from 'node:fs'

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) return console.log(`  ✓ ${label}`)
  failures += 1
  console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`)
}

// ── 假 react ────────────────────────────────────────────
let hookQueue = []
let hookIndex = 0
const fakeReact = {
  useState(initial) {
    const value = hookIndex < hookQueue.length ? hookQueue[hookIndex] : initial
    hookIndex += 1
    return [value, () => {}]
  },
  useEffect() {},
  useMemo(fn) { return fn() },
  useRef(v) { return { current: v } },
  createElement: (type, props) => ({ type, props: props || {} }),
}

const makeNode = (type, props) => ({ type, props: props || {} })
const fakeJsxRuntime = {
  jsx: makeNode,
  jsxs: makeNode,
  Fragment: "Fragment",
  jsxDEV: makeNode,
}

// ── 加载 client.js ──────────────────────────────────────
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) { loaded = entry },
  },
}
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function('window', source)(globalThis.window)

check("client 已注册模块", loaded?.id, "dsh-skill-mcp-gate")

const requireStub = (name) => {
  if (name === 'react') return fakeReact
  if (name === 'react/jsx-runtime') return fakeJsxRuntime
  throw new Error(`未预期的依赖: ${name}`)
}
const mod = loaded.factory(requireStub)

check('导出 apply', typeof mod.apply, 'function')
check('导出 inject', mod.inject, ['slots'])

// ── 收集渲染树文本 ──────────────────────────────────────
function collectTexts(node, out = []) {
  if (node == null || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectTexts(child, out)
    return out
  }
  if (typeof node === 'object') {
    // 函数组件要真的调一次，否则它内部渲染的文本收不到
    if (typeof node.type === 'function') {
      try { return collectTexts(node.type(node.props || {}), out) } catch { return out }
    }
    const props = node.props || {}
    if (props.children !== undefined) collectTexts(props.children, out)
    const SKIP = new Set(['children', 'style', 'key', 'ref'])
    for (const key of Object.keys(props)) {
      if (SKIP.has(key)) continue
      const value = props[key]
      if (typeof value === 'string' || typeof value === 'number') out.push(String(value))
      else if (value && typeof value === 'object') collectTexts(value, out)
    }
  }
  return out
}


// 结构断言用：收集带某个 prop 的节点（例如 role="switch" 的开关）
function collectNodesByProp(node, key, out = []) {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const child of node) collectNodesByProp(child, key, out); return out }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') {
    try { return collectNodesByProp(node.type(node.props || {}), key, out) } catch { return out }
  }
  const props = node.props || {}
  if (props[key] !== undefined) out.push(node)
  if (props.children !== undefined) collectNodesByProp(props.children, key, out)
  return out
}

// ── 注册 ────────────────────────────────────────────────
const registrations = []
const injections = []
const ctx = {
  slots: {
    inject(slot, run) { injections.push(slot); run() },
    register(options, Component) { registrations.push({ options, Component }); return () => {} },
  },
}
mod.apply(ctx)

check('注入两个槽位', injections.sort(), ['main', 'sidebar.panellist'])
const iconReg = registrations.find((r) => r.options.name === 'sidebar.panellist')
const mainReg = registrations.find((r) => r.options.name === 'main')
check('图标注册带 id', iconReg?.options.id, 'skill-mcp-gate')
check('面板注册带相同 key', mainReg?.options.key, 'skill-mcp-gate')
check('面板 key 与图标 id 一致', mainReg?.options.key, iconReg?.options.id)

// 图标能画出来
const iconTree = iconReg.Component({ size: 16, active: false })
check('图标渲染 svg', iconTree.type, 'svg')

// ── 面板：有数据时的渲染 ────────────────────────────────
const snapshot = {
  skills: [
    { name: 'dataviz', scope: 'builtin', source: 'bundled', state: 'off', decidedBy: '全局', decidedByFile: 'g.json', coverable: true },
    { name: 'karpathy-guidelines', scope: 'user', source: 'user-agents', state: 'on', decidedBy: 'frontmatter', decidedByFile: null, coverable: true },
    { name: 'proj-skill', scope: 'project', source: 'project-dsh', state: 'on', decidedBy: 'frontmatter', decidedByFile: null, coverable: false, gaps: [{ field: 'paths', reason: '未接入' }] },
  ],
  mcp: {
    servers: [
      { name: 'exa', state: 'on', connected: true, layer: 'global', file: 'g.json', ccScope: 'user', ccRejected: false, ccApproved: true, tools: [{ name: 'search', state: 'on', hidden: false }, { name: 'crawl', state: 'off', hidden: true }] },
      { name: 'proj-mcp', state: 'off', connected: false, layer: 'project', file: 'p.json', tools: [] },
      { name: 'loose', state: 'on', connected: true, layer: null, file: null, tools: [{ name: 'ping', state: 'on', hidden: false }] },
      { name: 'cc-proj', state: 'on', connected: false, layer: 'cc', file: 'c.json', ccScope: 'project', ccRejected: false, ccApproved: false, tools: [] },
      { name: 'lazy-srv', state: 'deferred', connected: true, layer: 'global', file: 'g.json', ccScope: null, ccRejected: false, ccApproved: null, tools: [{ name: 'scan', state: 'on', hidden: true }] },
      { name: 'proj-mcp2', state: 'on', connected: true, layer: 'project', file: 'p.json', ccScope: 'local', ccRejected: false, ccApproved: true, tools: [] },
      { name: 'cc-only', state: 'on', connected: false, layer: 'cc', file: 'c.json', ccScope: 'project', ccRejected: false, ccApproved: false, tools: [] },
      { name: 'ghost', state: 'on', connected: false, layer: null, file: null, tools: [] },
      { name: 'cc-off', state: 'off', connected: false, layer: 'cc', file: 'c.json', ccScope: 'user', ccRejected: true, ccApproved: false, tools: [] },
    ],
  },
  listing: { budget: { chars: 900, source: '环境变量 SLASH_COMMAND_TOOL_CHAR_BUDGET' }, cost: { after: 500, dropped: [{ name: 'x', chars: 40 }] } },
  files: [{ file: 'g.json', exists: true }, { file: 'p.json', exists: false }],
  warnings: ['一条警告'],
  problems: { lost: [{ name: 'x' }], unsupported: [], missing: [], failed: [] },
}

/** 只要渲染树本身（结构断言用；render 返回的是文本数组）。 */
function tree(hookValues) {
  hookQueue = hookValues
  hookIndex = 0
  return mainReg.Component({})
}

function render(hookValues) {
  // 钩子顺序：tab / data / error / busy / expanded / activeWs / addText / addError
  hookQueue = hookValues
  hookIndex = 0
  return collectTexts(mainReg.Component({}))
}

const S = { ...snapshot, workspaces: [
  { key: 'global', label: '全局', cwd: null, sessions: 0 },
  { key: 'D:/Work/demo', label: 'D:/Work/demo', cwd: 'D:/Work/demo', sessions: 2 },
], active: 'global' }

console.log('Skills tab（默认）')
const t1 = render(['skills', S, null, null, {}, null, '', null])
check('标题', t1.includes('Skills / MCPs 管理'), true)
check('tab 顺序：Skills 在前', t1.findIndex((t) => t.startsWith('Skills ')) < t1.findIndex((t) => t.startsWith('MCPs ')), true)
check('左侧作用域列表有全局', t1.includes('全局'), true)
check('左侧作用域列表有工作区', t1.some((t) => t.includes('demo')), true)
check('作用域说明', t1.some((t) => t.includes('写入')), true)
check('技能行', t1.includes('dataviz'), true)
check('IOS 开关存在', t1.includes('关闭 dataviz') || t1.includes('启用 dataviz'), true)
check('打开态显示三态分段', ['正常', '仅名称', '仅手动'].every((x) => t1.includes(x)), true)
check('CC 字段未适配 pill', t1.some((t) => t.includes('CC 字段 paths 未适配')), true)
check('页脚统计', t1.some((t) => t.includes('个关闭')), true)

console.log('关闭态技能不显示三态')
const offSnap = { ...S, skills: S.skills.map((s) => ({ ...s, state: 'off' })) }
const t2 = render(['skills', offSnap, null, null, {}, null, '', null])
check('关闭后不显示三态分段', t2.includes('仅名称'), false)
check('关闭后开关标签为启用', t2.some((t) => t.startsWith('启用 ')), true)

console.log('MCPs tab')
const t3 = render(['mcps', S, null, null, {}, null, '', null])
check('MCPs tab 标题', t3.some((t) => t.startsWith('MCPs ')), true)
check('自定义填入标题', t3.includes('自定义填入'), true)
check('自定义填入按钮', t3.includes('解析并添加'), true)
check('服务器行', t3.includes('exa'), true)
check('工具展开按钮', t3.some((t) => t.startsWith('工具 ')), true)
const mcpTreeSwitches = collectNodesByProp(tree(['mcps', S, null, null, {}, null, '', null]), 'role')
  .filter((n) => n.props.role === 'switch').length
check('CC 作用域 pill', t3.includes('CC 用户'), true)
check('延迟服务器 pill', t3.includes('延迟'), true)
check('延迟说明文案', t3.some((t) => t.includes('不进提示词，可按需搜索调用')), true)
check('每台服务器都有开关', mcpTreeSwitches >= S.mcp.servers.length, true)
check('全局层 tag', t3.includes('全局'), true)
check('项目层 tag', t3.includes('项目'), true)
check('未声明 tag', t3.includes('未声明'), true)
check('CC 本地 tag', t3.includes('CC 本地'), true)
check('CC 项目 tag（layer=cc 时不重复标全局/项目）', t3.includes('CC 项目'), true)
check('延迟按钮在（可切成本策略）', t3.includes('延迟中'), true)
check('CC 未批准 pill', t3.includes('CC 未批准'), true)
check('CC 已拒绝 pill', t3.includes('CC 已拒绝'), true)

console.log('条目操作区')
{
  const opened = render(['mcps', S, null, null, { exa: true }, null, '', null, { exa: true }])
  check('展开后出现重命名', opened.includes('重命名'), true)
  check('展开后出现删除', opened.includes('删除'), true)
  check('展开后出现测试连通', opened.includes('测试连通'), true)
  const closed = render(['mcps', S, null, null, {}, null, '', null])
  check('默认收起', closed.includes('重命名'), false)
}

console.log('JSON 编辑器')
{
  const editorState = { server: 'exa', text: JSON.stringify({ serverName: 'exa' }, null, 2), source: 'claude-code', managed: false, error: null }
  const out = render(['mcps', S, null, null, { exa: true }, null, '', null, { exa: true }, {}, editorState])
  check('出现编辑 JSON 按钮', out.includes('编辑 JSON'), true)
  check('出现保存按钮', out.includes('保存并热加载'), true)
  check('出现恢复按钮', out.includes('恢复为 CC 定义'), true)
  check('删除按钮统一在动作行里（编辑器里不再重复一个）', out.includes('删除 DSH 连接'), false)
  check('说明保存会接管连接', out.some((t) => t.includes('mcp-client')), true)

  const managed = render(['mcps', S, null, null, { exa: true }, null, '', null, { exa: true }, {}, { ...editorState, source: 'plugin', managed: true }])
  check('已代管时提示插件代管', managed.some((t) => t.includes('本插件代管的连接')), true)
}

console.log('工具展开')
const t4 = render(['mcps', S, null, null, { exa: true }, null, '', null])
check('展开出现工具名', t4.includes('search'), true)
check('已关闭说明', t4.some((t) => t.includes('已从模型工具列表移除')), true)

console.log('加载中 / 错误')
check('加载态', render(['skills', null, null, null, {}, null, '', null]).includes('加载中…'), true)
const t5 = render(['skills', null, 'boom', null, {}, null, '', null])
check('错误态', t5.some((t) => t.includes('加载失败')), true)

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
