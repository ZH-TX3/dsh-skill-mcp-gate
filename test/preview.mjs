#!/usr/bin/env node
/**
 * UI 预览 + 截图自测工具。
 *
 * 用假 react 执行 lib/client.js，把面板组件渲染成 HTML（内联样式），
 * 再用 Edge 无头模式截图，供人眼检查。
 *
 * 用法：node test/preview.mjs
 * 产物：test/out/preview-skills.png、preview-mcp.png、preview.html
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'out')
mkdirSync(outDir, { recursive: true })

// ── 假 react ──────────────────────────────────────────
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
const node = (type, props) => ({ type, props: props || {} })
const fakeJsx = { jsx: node, jsxs: node, Fragment: 'Fragment', jsxDEV: node }

let loaded = null
globalThis.window = { __ModuleLoader__: { load(e) { loaded = e } } }
new Function('window', readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8'))(globalThis.window)

const module = loaded.factory((name) => {
  if (name === 'react') return fakeReact
  if (name === 'react/jsx-runtime') return fakeJsx
  throw new Error(`未预期依赖 ${name}`)
})

const registered = []
module.apply({
  slots: {
    inject(_slot, run) { run() },
    register(options, Component) { registered.push({ options, Component }); return () => {} },
  },
})
const Panel = registered.find((r) => r.options.name === 'main').Component

// ── 渲染：元素树 → HTML ───────────────────────────────
const VOID = new Set(['input', 'br', 'hr', 'img', 'circle', 'path'])
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function css(style) {
  return Object.entries(style || {})
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`)
    .join(';')
}

function attrs(props) {
  const skip = new Set(['style', 'children', 'onClick', 'onChange', 'key'])
  const out = []
  for (const [k, v] of Object.entries(props)) {
    if (skip.has(k) || v === undefined || v === null || v === false || typeof v === 'function' || typeof v === 'object') continue
    if (k === 'value' || k === 'placeholder' || k === 'disabled' || k === 'type' || k === 'role' || k === 'title' || k === 'aria-checked' || k === 'aria-label') {
      out.push(`${k}="${esc(v)}"`)
    }
  }
  return out.length ? ' ' + out.join(' ') : ''
}

function render(vNode, ctxSelect) {
  if (vNode === null || vNode === undefined || typeof vNode === 'boolean') return ''
  if (typeof vNode === 'string' || typeof vNode === 'number') return esc(vNode)
  if (Array.isArray(vNode)) return vNode.map((c) => render(c, ctxSelect)).join('')
  const { type, props = {} } = vNode
  if (type === 'Fragment') return render(props.children, ctxSelect)

  // 自定义组件（大写开头）→ 直接调用
  if (typeof type === 'function') return render(type(props), ctxSelect)

  const tag = type
  const style = props.style ? ` style="${css(props.style)}"` : ''

  if (tag === 'select') {
    const value = props.value
    const options = (Array.isArray(props.children) ? props.children : [props.children])
      .filter(Boolean)
      .map((opt) => {
        const ov = opt?.props?.value
        const sel = ov === value ? ' selected' : ''
        return `<option value="${esc(ov)}"${sel}>${esc(opt?.props?.children ?? '')}</option>`
      })
      .join('')
    return `<select${style}${attrs(props)}>${options}</select>`
  }
  if (VOID.has(tag)) return `<${tag}${style}${attrs(props)} />`
  return `<${tag}${style}${attrs(props)}>${render(props.children, ctxSelect)}</${tag}>`
}

// ── 假数据 ────────────────────────────────────────────
const snapshot = {
  workspaces: [
    { key: 'global', label: '全局', cwd: null, hint: '基础层' },
    { key: 'D:/ds/plugins', label: 'dsh-plugins', cwd: 'D:/ds/plugins', hint: '覆盖全局' },
    { key: 'D:/Work/demo', label: 'demo', cwd: 'D:/Work/demo', hint: '覆盖全局' },
    { key: 'C:/Users/<user>/.dsh', label: '.dsh', cwd: 'C:/Users/<user>/.dsh', hint: '覆盖全局' },
    { key: 'D:/Work/test/toolCli', label: 'toolCli', cwd: 'D:/Work/test/toolCli', hint: '覆盖全局' },
  ],
  active: 'global',
  skills: [
    { name: 'dataviz', scope: 'builtin', source: 'bundled', state: 'off', decidedBy: '全局', coverable: true },
    { name: 'karpathy-guidelines', scope: 'user', source: 'user-agents', state: 'on', decidedBy: 'frontmatter', coverable: true },
    { name: 'playwright-cli', scope: 'user', source: 'user-dsh', state: 'user-invocable-only', decidedBy: '项目', coverable: true },
    { name: 'proj-style', scope: 'project', source: 'project-dsh', state: 'on', decidedBy: 'frontmatter', coverable: false },
  ],
  mcp: {
    servers: [
      {
        name: 'exa', state: 'on', connected: true, layer: 'global',
        tools: [
          { name: 'web_search_exa', state: 'on' },
          { name: 'crawling_exa', state: 'off' },
          { name: 'deep_research', state: 'on' },
        ],
      },
      {
        name: 'context7', state: 'on', connected: true, layer: 'global',
        tools: [{ name: 'resolve-library-id', state: 'on' }, { name: 'get-library-docs', state: 'on' }],
      },
      { name: 'xiaohongshu-mcp', state: 'off', connected: false, layer: 'project', tools: [] },
    ],
  },
  files: [
    { file: 'C:/Users/<user>/.dsh/skill-mcp-gate/settings.json', exists: true },
    { file: 'D:/Work/demo/.dsh/skill-mcp-gate.json', exists: false },
  ],
  warnings: [],
  problems: { lost: [], unsupported: [{ name: 'proj-style' }], missing: [], failed: [] },
}

// ── 出图 ──────────────────────────────────────────────
const shell = (body) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: light; }
  body { margin:0; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
         background:#f6f7f9; color:#1f2328; }
  .wrap { width: 1080px; height: 740px; display:flex; background:#fff; }
  .rail { width: 56px; background:#eef0f3; border-right:1px solid rgba(0,0,0,.08);
          display:flex; flex-direction:column; align-items:center; padding-top:14px; gap:14px; }
  .rail i { width:22px; height:22px; border-radius:6px; background:rgba(0,0,0,.10); display:block; }
  .rail i.on { background:#2f7cf6; }
  .main { flex:1; display:flex; flex-direction:column; min-width:0; }
</style></head>
<body><div class="wrap">
  <div class="rail"><i></i><i></i><i class="on"></i><i></i></div>
  <div class="main">${body}</div>
</div></body></html>`

function shoot(name, hookValues) {
  hookQueue = hookValues
  hookIndex = 0
  const html = shell(render(Panel({})))
  const file = join(outDir, `${name}.html`)
  writeFileSync(file, html, 'utf8')
  const png = join(outDir, `${name}.png`)
  execFileSync(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--screenshot=${png}`, '--window-size=1080,740', `file:///${file.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore' })
  console.log(`  ${name}.png`)
}

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
console.log('生成预览：')
shoot('preview-skills', ['skills', snapshot, null, null, {}, null, '', null])
shoot('preview-mcp', ['mcps', snapshot, null, null, { exa: true }, null, '', null])
console.log(`输出目录：${outDir}`)
