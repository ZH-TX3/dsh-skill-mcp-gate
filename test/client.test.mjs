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

function collectTypes(node, out = []) {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const child of node) collectTypes(child, out); return out }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') {
    try { return collectTypes(node.type(node.props || {}), out) } catch { return out }
  }
  if (typeof node.type === 'string') out.push(node.type)
  if (node.props && node.props.children !== undefined) collectTypes(node.props.children, out)
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

console.log('Skills tab（默认：只展开项目组）')
const t1 = render(['skills', S, null, null, {}, null, '', null])
check('标题', t1.includes('Skills / MCPs 管理'), true)
check('tab 顺序：Skills 在前', t1.findIndex((t) => t.startsWith('Skills ')) < t1.findIndex((t) => t.startsWith('MCPs ')), true)
check('左侧作用域列表有全局', t1.includes('全局'), true)
check('左侧作用域列表有工作区', t1.some((t) => t.includes('demo')), true)
check('作用域说明', t1.some((t) => t.includes('写入')), true)
check('项目组标题', t1.includes('本项目技能'), true)
check('项目组默认展开（技能行可见）', t1.includes('proj-skill'), true)
check('项目组的开关可见', t1.includes('关闭 proj-skill') || t1.includes('启用 proj-skill'), true)
check('用户组标题在', t1.includes('用户级技能'), true)
check('用户组默认折叠（行不可见）', t1.includes('karpathy-guidelines'), false)
check('内置组标题在', t1.includes('内置技能'), true)
check('内置组默认折叠（行不可见）', t1.includes('dataviz'), false)
check('折叠时给出分组说明', t1.some((t) => t.includes('~/.claude/skills')), true)
check('页脚统计', t1.some((t) => t.includes('个关闭')), true)
check('技能行有「内容」按钮（可预览 + 手动调用）', t1.includes('内容'), true)

console.log('host 没有内容接口时')
{
  const hooks = (flag) => ['skills', S, null, null, {}, null, '', null, {}, {}, null, {}, {}, {}, null, flag]
  const hidden = render(hooks(false))
  check('按钮不出现', hidden.includes('内容'), false)
  check('页脚说明原因', hidden.some((t) => t.includes('重启 dsh web')), true)
  const shown = render(hooks(true))
  check('有接口时按钮出现', shown.includes('内容'), true)
}

console.log('Skills tab（全部展开）')
const t1b = render(['skills', S, null, null, {}, null, '', null, {}, {}, null, {}, { user: false, builtin: false }])
check('展开后用户技能可见', t1b.includes('karpathy-guidelines'), true)
check('展开后内置技能可见', t1b.includes('dataviz'), true)
check('IOS 开关存在', t1b.includes('关闭 dataviz') || t1b.includes('启用 dataviz'), true)
check('打开态显示三态分段', ['正常', '仅名称', '仅手动'].every((x) => t1b.includes(x)), true)
check('CC 字段未适配 pill', t1b.some((t) => t.includes('CC 字段 paths 未适配')), true)

console.log('关闭态技能不显示三态')
const offSnap = { ...S, skills: S.skills.map((s) => ({ ...s, state: 'off' })) }
const t2 = render(['skills', offSnap, null, null, {}, null, '', null])
check('关闭后不显示三态分段', t2.includes('仅名称'), false)
check('关闭后开关标签为启用', t2.some((t) => t.startsWith('启用 ')), true)

// MCP 渲染的 hook 数组：默认把三个非项目组都展开，另有断言专门验折叠
const EXPAND_MCP = { global: false, cc: false, runtime: false }
const mcpHooks = (over = {}) => ([
  'mcps', S, null, null,
  over.expanded ?? {}, null, '', null,
  over.actionsOpen ?? {}, over.probeResults ?? {},
  over.editor ?? null, over.notices ?? {},
  over.collapsedGroups ?? {}, over.collapsedMcp ?? EXPAND_MCP,
])

console.log('MCPs tab（默认：只展开本项目组）')
{
  const folded = render(mcpHooks({ collapsedMcp: {} }))
  check('本项目组标题', folded.includes('本项目 MCP'), true)
  check('本项目行可见', folded.includes('proj-mcp2'), true)
  check('全局组标题在', folded.includes('全局 MCP'), true)
  check('全组默认折叠（行不可见）', folded.includes('exa'), false)
  check('CC 组标题在', folded.includes('Claude Code 声明'), true)
  check('CC 组默认折叠', folded.includes('cc-only'), false)
  check('折叠时给出来源路径', folded.some((t) => t.includes('skill-mcp-gate')), true)
}

console.log('MCPs tab')
const t3 = render(mcpHooks())
check('MCPs tab 标题', t3.some((t) => t.startsWith('MCPs ')), true)
check('自定义填入标题', t3.includes('自定义填入'), true)
check('自定义填入按钮', t3.includes('解析并添加'), true)
check('服务器行', t3.includes('exa'), true)
check('工具展开按钮', t3.some((t) => t.startsWith('工具 ')), true)
const mcpTreeSwitches = collectNodesByProp(tree(mcpHooks()), 'role')
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
check('延迟按钮在（可切成本策略，收在 ⋯ 里）', render(mcpHooks({ actionsOpen: { 'lazy-srv': true } })).some((t) => t.includes('延迟中')), true)
check('CC 未批准 pill', t3.includes('CC 未批准'), true)
check('CC 已拒绝 pill', t3.includes('CC 已拒绝'), true)

console.log('条目操作区')
{
  const opened = render(mcpHooks({ actionsOpen: { exa: true } }))
  check('⋯ 里有重命名', opened.includes('重命名'), true)
  check('⋯ 里有测试连通', opened.includes('测试连通'), true)
  check('⋯ 里有延迟加载', opened.includes('延迟加载'), true)
  const closed = render(mcpHooks())
  check('收起时没有重命名', closed.includes('重命名'), false)
  check('收起时没有延迟加载', closed.includes('延迟加载'), false)
  check('编辑与删除常驻行上（不折叠）', closed.includes('编辑') && closed.includes('删除'), true)
}

{
  const ccActions = render(mcpHooks({ actionsOpen: { 'cc-only': true } }))
  check('只声明在 CC 里的行给出「复制到 DSH」', ccActions.includes('复制到 DSH'), true)
  const ccGroup = render(mcpHooks({ collapsedMcp: { cc: false } }))
  check('CC 组展开后有「全部复制到 DSH」', ccGroup.includes('全部复制到 DSH'), true)
}

console.log('JSON 编辑器')
{
  const editorState = { server: 'exa', text: JSON.stringify({ serverName: 'exa' }, null, 2), source: 'claude-code', managed: false, error: null }
  const out = render(mcpHooks({ expanded: { exa: true }, actionsOpen: { exa: true }, editor: editorState }))
  check('行上直接有编辑按钮', out.includes('编辑'), true)
  check('出现保存按钮', out.includes('保存并热加载'), true)
  check('出现恢复按钮', out.includes('恢复为 CC 定义'), true)
  check('删除按钮统一在动作行里（编辑器里不再重复一个）', out.includes('删除 DSH 连接'), false)
  check('说明保存落点与接管', out.some((t) => t.includes('skill-mcp-gate.json')), true)

  const managed = render(mcpHooks({ expanded: { exa: true }, actionsOpen: { exa: true }, editor: { ...editorState, source: 'mcp.json', managed: true } }))
  check('已代管时说明来自 .mcp.json', managed.some((t) => t.includes('本插件只读')), true)
}

console.log('Prompt tab')
{
  const snap = {
    ...S,
    instructions: {
      root: '/w',
      cwd: '/w',
      ccHasClaude: true,
      items: [
        { path: '/u/.claude/CLAUDE.md', label: '~/.claude/CLAUDE.md', scope: 'user', order: 0, readers: ['cc'], note: '用户级：CC 每个项目都读', editable: false, size: 1305, mtime: 0 },
        { path: '/u/.dsh/AGENTS.md', label: '~/.dsh/AGENTS.md', scope: 'user', order: 1, readers: ['dsh'], note: '用户级：DSH 每条指令链的第一条', editable: false, size: 1141, mtime: 0 },
        { path: '/w/CLAUDE.md', label: 'CLAUDE.md', scope: 'project', order: 2, readers: ['cc', 'dsh'], note: null, editable: true, size: 2048, mtime: 0 },
        { path: '/w/AGENTS.md', label: 'AGENTS.md', scope: 'project', order: 3, readers: ['dsh'], note: 'CC 默认跳过：上层已有 CLAUDE.md 家族', editable: true, size: 512, mtime: 0 },
      ],
      onDemand: [{ path: '/w/pkg/CLAUDE.md', label: 'pkg/CLAUDE.md', scope: 'subdir', onDemand: true, readers: ['cc', 'dsh'], note: '按需：等有 read/write/edit 摸到这个目录才进上下文', editable: true, size: 100, mtime: 0 }],
      budget: { bytes: 3693, maxBytes: 65536, over: false, dropped: [], truncated: null },
    },
  }
  const hooks = (over = {}) => ['prompt', snap, null, null, {}, null, '', null, {}, {}, null, {}, {}, EXPAND_MCP, null, null, over.promptEditor ?? null, over.promptPreview ?? null, over.previewWidth ?? 420]
  const out = render(hooks())
  check('Prompt tab 标题带数量', out.some((t) => t.startsWith('Prompt ')), true)
  check('只显示本会话会读的文件', out.includes('~/.dsh/AGENTS.md'), true)
  check('另一个工具专用的文件不显示', out.includes('~/.claude/CLAUDE.md'), false)
  check('并说明隐藏了几份', out.some((t) => t.includes('在这里不生效，已隐藏')), true)
  check('reader 徽章', out.includes('DSH 读') && out.includes('CC 读'), true)
  check('被 CC 跳过的原因写明', out.some((t) => t.includes('CC 默认跳过')), true)
  check('用户级标只读', out.includes('只读'), true)
  check('预算行', out.some((t) => t.includes('65536')), true)
  check('按需分组标题', out.includes('子目录（按需加载）'), true)

  const editing = render(hooks({
    promptEditor: { path: '/w/CLAUDE.md', label: 'CLAUDE.md', text: '# hi', original: '# hi', editable: true, error: null, saving: false },
  }))
  check('编辑器里有保存按钮', editing.includes('保存'), true)
  check('字数统计', editing.some((t) => t.includes('# hi') === false && t.includes(' 字')), true)
  check('未改动时说明干净', editing.some((t) => t.includes('已改动未保存')), false)

  const readOnlyEditor = render(hooks({
    promptEditor: { path: '/u/.dsh/AGENTS.md', label: '~/.dsh/AGENTS.md', text: '# u', original: '# u', editable: false, error: null, saving: false },
  }))
  check('用户级打开后没有保存按钮', readOnlyEditor.includes('保存'), false)
  check('并说明只读来源', readOnlyEditor.some((t) => t.includes('用户级 / 组织级文件')), true)

  const previewMd = ['# 标题', '', '- 一条约定', '普通段落 `代码` 与 **加粗**', '', '```', 'npm test', '```'].join(String.fromCharCode(10))
  const previewing = render(hooks({
    promptPreview: { path: '/w/CLAUDE.md', label: 'CLAUDE.md', content: previewMd, editable: true },
  }))
  check('侧窗标题与统计', previewing.some((t) => t.includes('渲染预览')), true)
  check('渲染后不再有 # 号', previewing.some((t) => t.includes('# 标题')), false)
  check('标题文字还在', previewing.includes('标题'), true)
  check('代码块内容原样', previewing.includes('npm test'), true)
  check('行内码与加粗拆开渲染', previewing.includes('代码') && previewing.includes('加粗'), true)
  check('预览里有去编辑入口', previewing.includes('去编辑'), true)
  check('预览里有关闭', previewing.includes('关闭'), true)

  const types = collectTypes(tree(hooks({ promptPreview: { path: '/w/CLAUDE.md', label: 'CLAUDE.md', content: previewMd, editable: true } })))
  check('用了真正的 md 语义标签', ['h1', 'ul', 'li', 'pre', 'code', 'strong', 'p'].every((tag) => types.includes(tag)), true)

  // 回归：缩进/制表符开头的标题曾经让渲染器原地死循环（分支和段落排除条件口径不一致，i 不前进），
  // 表现就是点一下预览整个页面卡死。
  const NL = String.fromCharCode(10)
  const tricky = [
    '   ## 缩进标题',
    String.fromCharCode(9) + '# 制表符标题',
    '- 项目一',
    '| a | b |',
    '| --- | --- |',
    '1. 编号',
    '> 引用',
    '```',
    'code-line',
    '```',
    '普通段落',
  ].join(NL)
  const trickyHooks = hooks({ promptPreview: { path: '/w/AGENTS.md', label: 'AGENTS.md', content: tricky, editable: true } })
  const trickyText = render(trickyHooks)
  check('缩进标题不再吞掉（死循环回归）', trickyText.includes('缩进标题'), true)
  check('制表符标题也在', trickyText.includes('制表符标题'), true)
  check('其余块都还在', ['项目一', '编号', '引用', 'code-line', '普通段落'].every((mark) => trickyText.includes(mark)), true)
  const trickyTypes = collectTypes(tree(trickyHooks))
  check('缩进标题仍按 h2 渲染', trickyTypes.includes('h2'), true)
  check('列表/表格/引用/代码块都生成了', ['ul', 'ol', 'table', 'blockquote', 'pre'].every((tag) => trickyTypes.includes(tag)), true)

  // 标题的各种写法都不能漏成 "# 文字"
  const headingForms = [
    '##无空格标题',
    '## 带空格标题 ###',
    '#######  七个井号',
    '# 普通标题',
  ].join(String.fromCharCode(10))
  const headingHooks = hooks({ promptPreview: { path: '/w/AGENTS.md', label: 'AGENTS.md', content: headingForms, editable: true } })
  const headingText = render(headingHooks)
  check('无空格标题渲染成标题', headingText.includes('无空格标题'), true)
  check('输出里不再留着井号', headingText.some((t) => t.includes('##无空格标题')), false)
  check('ATX 收尾的 ### 被吃掉', headingText.some((t) => t.includes('带空格标题 ###')), false)
  check('七个井号仍是文字（不是标题）', headingHooks && render(hooks({ promptPreview: { path: '/w/AGENTS.md', label: 'AGENTS.md', content: '#######  七个井号', editable: true } })).some((t) => t.includes('#######')), true)
  check('所有标题都生成了 hN', collectTypes(tree(headingHooks)).filter((tag) => /^h[1-6]$/.test(tag)).length >= 2, true)

  // 预览窗格：可拖宽 + 拖动条
  const wide = tree(hooks({ previewWidth: 640, promptPreview: { path: '/w/CLAUDE.md', label: 'CLAUDE.md', content: '# x', editable: true } }))
  const widths = collectNodesByProp(wide, 'style').map((n) => n.props.style && n.props.style.width).filter((w) => typeof w === 'number')
  check('窗格宽度跟着可拖状态走', widths.includes(640), true)
  check('有拖动条', collectNodesByProp(wide, 'title').some((n) => String(n.props.title).includes('拖动调整预览宽度')), true)

  // 编辑器要够高（曾经是 16 行的矮框）
  const editingTree = tree(hooks({ promptEditor: { path: '/w/CLAUDE.md', label: 'CLAUDE.md', text: '# hi', original: '# hi', editable: true, error: null, saving: false } }))
  const rowCounts = collectNodesByProp(editingTree, 'rows').map((n) => n.props.rows)
  check('编辑器至少 20 行高', rowCounts.some((rows) => typeof rows === 'number' && rows >= 20), true)

  const readOnlyPreview = render(hooks({ promptPreview: { path: '/u/.dsh/AGENTS.md', label: '~/.dsh/AGENTS.md', content: '# u', editable: false } }))
  check('只读文件没有去编辑', readOnlyPreview.includes('去编辑'), false)
}

console.log('工具展开')
const t4 = render(mcpHooks({ expanded: { exa: true } }))
check('展开出现工具名', t4.includes('search'), true)
check('已关闭说明', t4.some((t) => t.includes('已从模型工具列表移除')), true)

console.log('左侧导航：拖动 / 收起')
{
  const hooksWithLeft = (over = {}) => ['skills', S, null, null, {}, null, '', null, {}, {}, null, {}, {}, {}, null, null, null, null, null, over.leftWidth ?? 216, over.leftCollapsed ?? false]

  const base = render(hooksWithLeft())
  check('列表默认显示工作区', base.includes('D:/Work/demo'), true)
  check('有拖动条', (() => {
    const nodes = collectNodesByProp(tree(hooksWithLeft()), 'title')
    return nodes.some((n) => String(n.props.title).includes('拖动调整列表宽度'))
  })(), true)

  const wide = tree(hooksWithLeft({ leftWidth: 320 }))
  const widths = collectNodesByProp(wide, 'style').map((n) => n.props.style && n.props.style.width).filter((w) => typeof w === 'number')
  check('宽度跟着可拖状态走', widths.includes(320), true)

  const collapsed = render(hooksWithLeft({ leftCollapsed: true }))
  check('收起后工作区列表不显示', collapsed.includes('D:/Work/demo'), false)
  check('收起后出现展开图标', (() => {
    const nodes = collectNodesByProp(tree(hooksWithLeft({ leftCollapsed: true })), 'title')
    return nodes.some((n) => String(n.props.title).includes('展开左侧列表'))
  })(), true)

  const expanded = tree(hooksWithLeft())
  check('展开态图标是「收起」', collectNodesByProp(expanded, 'title').some((n) => String(n.props.title).includes('收起左侧列表')), true)
  check('图标是 svg 折角', collectNodesByProp(expanded, 'viewBox').length > 0, true)
}

console.log('加载中 / 错误')
check('加载态', render(['skills', null, null, null, {}, null, '', null]).includes('加载中…'), true)
const t5 = render(['skills', null, 'boom', null, {}, null, '', null])
check('错误态', t5.some((t) => t.includes('加载失败')), true)

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
