window.__ModuleLoader__.load({
  id: "dsh-skill-mcp-gate",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs, Fragment } = require("react/jsx-runtime");

    const API = "/api/skill-mcp-gate";
    const PANEL_ID = "skill-mcp-gate";
    const PANEL_NAME = "Skills / MCPs 管理";

    // 自动运行时 jsx(type, props, key) 第三参是 key：子元素一律写进 props.children。
    const STATE_LABEL = { on: "正常", "name-only": "仅名称", "user-invocable-only": "仅手动" };
    const ENABLED_STATES = ["on", "name-only", "user-invocable-only"];
    const SCOPE_TAG = { project: "项目", user: "用户", builtin: "内置" };
    const CC_SCOPE_TAG = { user: "CC 用户", local: "CC 本地", project: "CC 项目" };
    // MCP 服务器的声明层：与 Skills 行的「项目 / 用户 / 内置」同一套观感
    const LAYER_TAG = { global: "全局", project: "项目", cc: "CC 定义" };
    const SEP = new RegExp("[," + String.fromCharCode(10, 13, 9, 32) + "]+");

    const c = {
      border: "var(--dsh-border-color, rgba(128,128,128,0.22))",
      dim: "var(--dsh-text-secondary, rgba(128,128,128,0.95))",
      text: "var(--dsh-text-primary, inherit)",
      soft: "rgba(128,128,128,0.06)",
      trackOff: "rgba(128,128,128,0.30)",
      trackOn: "#2f7cf6",
      danger: "#c0392b",
      ok: "#2e8b57",
      warn: "#b7791f",
    };

    let tokenPromise = null;
    function getToken() {
      if (!tokenPromise) {
        tokenPromise = fetch(`${API}/token`)
          .then((r) => r.json())
          .then((b) => (b && typeof b.token === "string" ? b.token : null))
          .catch(() => null);
      }
      return tokenPromise;
    }

    async function post(path, body) {
      const token = await getToken();
      const res = await fetch(`${API}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gate-token": token ?? "" },
        body: JSON.stringify(body ?? {}),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload.error) throw new Error(payload.error || `HTTP ${res.status}`);
      return payload;
    }

    async function loadState(ws) {
      const query = ws ? `?ws=${encodeURIComponent(ws)}` : "";
      const res = await fetch(`${API}/state${query}`);
      if (!res.ok) throw new Error(`无法读取状态（HTTP ${res.status}）`);
      return res.json();
    }

    function Switch(props) {
      const on = props.checked;
      return jsx("button", {
        type: "button",
        role: "switch",
        "aria-checked": on,
        "aria-label": props.label,
        title: props.label,
        disabled: props.disabled,
        onClick: () => props.onChange(!on),
        style: {
          flex: "0 0 auto",
          width: 40,
          height: 22,
          padding: 0,
          borderRadius: 999,
          border: "none",
          background: on ? c.trackOn : c.trackOff,
          position: "relative",
          cursor: props.disabled ? "not-allowed" : "pointer",
          opacity: props.disabled ? 0.45 : 1,
          transition: "background .18s ease",
        },
        children: jsx("span", {
          style: {
            position: "absolute",
            top: 2,
            left: on ? 20 : 2,
            width: 18,
            height: 18,
            borderRadius: 999,
            background: "#fff",
            transition: "left .18s ease",
            boxShadow: "0 1px 3px rgba(0,0,0,.3)",
          },
        }),
      });
    }

    function Pill(props) {
      const tone = props.tone;
      const bg = tone === "warn" ? "rgba(183,121,31,.14)"
        : tone === "danger" ? "rgba(192,57,43,.12)"
          : tone === "ok" ? "rgba(46,139,87,.14)"
            : c.soft;
      const fg = tone === "warn" ? c.warn
        : tone === "danger" ? c.danger
          : tone === "ok" ? c.ok
            : c.dim;
      return jsx("span", {
        style: {
          fontSize: 10.5,
          lineHeight: "16px",
          padding: "0 6px",
          borderRadius: 4,
          background: bg,
          color: fg,
          whiteSpace: "nowrap",
        },
        children: props.children,
      });
    }

    function TextButton(props) {
      return jsx("button", {
        type: "button",
        onClick: props.onClick,
        disabled: props.disabled,
        title: props.title,
        style: {
          fontSize: 11.5,
          padding: "4px 9px",
          borderRadius: 6,
          cursor: props.disabled ? "not-allowed" : "pointer",
          border: `1px solid ${c.border}`,
          background: props.active ? c.soft : "transparent",
          color: props.active ? c.text : c.dim,
          whiteSpace: "nowrap",
        },
        children: props.children,
      });
    }

    function Segmented(props) {
      return jsx("div", {
        style: {
          display: "inline-flex",
          border: `1px solid ${c.border}`,
          borderRadius: 6,
          overflow: "hidden",
          flex: "0 0 auto",
        },
        children: (props.states || ENABLED_STATES).map((state) => {
          const active = props.value === state;
          return jsx("button", {
            type: "button",
            disabled: props.disabled,
            onClick: () => props.onChange(state),
            style: {
              fontSize: 10.5,
              padding: "3px 7px",
              border: "none",
              borderRight: `1px solid ${c.border}`,
              cursor: props.disabled ? "not-allowed" : "pointer",
              background: active ? "rgba(47,124,246,0.14)" : "transparent",
              color: active ? c.text : c.dim,
              fontWeight: active ? 600 : 400,
            },
            children: (props.labels || STATE_LABEL)[state],
          }, state);
        }),
      });
    }

    function GateIcon(props) {
      const size = (props && props.size) || 18;
      return jsxs("svg", {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.7,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
        children: [
          jsx("path", { d: "M4 7h9M17 7h3" }),
          jsx("circle", { cx: 15, cy: 7, r: 2 }),
          jsx("path", { d: "M4 17h3M11 17h9" }),
          jsx("circle", { cx: 9, cy: 17, r: 2 }),
        ],
      });
    }

    function GatePanel() {
      const [tab, setTab] = react.useState("skills");
      const [data, setData] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [busy, setBusy] = react.useState(null);
      const [expanded, setExpanded] = react.useState({});
      const [activeWs, setActiveWs] = react.useState(null);
      const [addText, setAddText] = react.useState("");
      const [addError, setAddError] = react.useState(null);
      const [actionsOpen, setActionsOpen] = react.useState({});
      const [probeResults, setProbeResults] = react.useState({});
      const [editor, setEditor] = react.useState(null);
      const [notices, setNotices] = react.useState({});
      const [collapsedGroups, setCollapsedGroups] = react.useState({});
      const [collapsedMcp, setCollapsedMcp] = react.useState({});
      const [skillPreview, setSkillPreview] = react.useState(null);
      // host 支持 /skill/content 吗？没重启到新版本时这个路由不存在，按钮点了只会 404
      const [hasContentApi, setHasContentApi] = react.useState(null);
      const [promptEditor, setPromptEditor] = react.useState(null);
      const [promptPreview, setPromptPreview] = react.useState(null);
      const [previewWidth, setPreviewWidth] = react.useState(420);
      const [leftWidth, setLeftWidth] = react.useState(216);
      const [leftCollapsed, setLeftCollapsed] = react.useState(false);
      const [hoverEdge, setHoverEdge] = react.useState(null);

      const pollRef = react.useRef(0);

      // 连接中自动刷新：MCP 首次启动（npx 冷启动）要几秒到几十秒，
      // 不轮询的话界面会一直停在「未连接」，得手动点刷新才变绿。
      react.useEffect(() => {
        if (!data) return undefined;
        const connections = (data.mcp && data.mcp.connections) || {};
        const active = connections.active || [];
        const waiting = (data.mcp && data.mcp.servers ? data.mcp.servers : [])
          .some((srv) => !srv.connected && active.includes(srv.name));
        if (!waiting) return undefined;
        const timer = setInterval(() => {
          pollRef.current += 1;
          if (pollRef.current > 15) { clearInterval(timer); return; }
          loadState(ws).then((next) => setData(next)).catch(() => {});
        }, 4000);
        return () => clearInterval(timer);
      }, [data && data.active, data && data.mcp && data.mcp.connections && data.mcp.connections.active.join(','), data && data.mcp && data.mcp.servers.map((srv) => (srv.connected ? '1' : '0')).join('')]);

      react.useEffect(() => {
        let alive = true;
        loadState(null)
          .then((next) => { if (alive) setData(next); })
          .catch((e) => { if (alive) setError(e.message); });
        // 探一下 host 有没有这条路由：空请求会得到 400（路由在）或 404/401（路由不在）
        post("/skill/content", {})
          .then(() => { if (alive) setHasContentApi(true); })
          .catch((e) => {
            if (!alive) return;
            setHasContentApi(/HTTP (404|401)|not found/i.test(e.message) ? false : true);
          });
        return () => { alive = false; };
      }, []);

      const ws = activeWs || (data && data.active) || null;

      async function reload(nextWs) {
        setError(null);
        try {
          setData(await loadState(nextWs === undefined ? ws : nextWs));
        } catch (e) {
          setError(e.message);
        }
      }

      async function act(key, call) {
        setBusy(key);
        setError(null);
        try {
          const payload = await call();
          setData(payload && payload.state ? payload.state : await loadState(ws));
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(null);
        }
      }

      function pickWorkspace(next) {
        setActiveWs(next);
        reload(next);
      }

      const files = (data && data.files) || [];
      const skills = (data && data.skills) || [];
      const servers = (data && data.mcp && data.mcp.servers) || [];
      const workspaces = (data && data.workspaces) || [];
      const promptInstructions = data && data.instructions ? data.instructions : null;
      // 只列「本会话真的会读」的文件：readers 里没有 dsh 的（例如 ~/.claude/CLAUDE.md）
      // 在这个会话里不会生效，展示出来只会误导。它们仍然留在 host 的清单里（CC 那边要用）。
      const promptAll = (promptInstructions && promptInstructions.items) || [];
      const promptAllOnDemand = (promptInstructions && promptInstructions.onDemand) || [];
      const readsHere = (file) => Array.isArray(file.readers) && file.readers.includes("dsh");
      const promptItems = promptAll.filter(readsHere);
      const promptOnDemand = promptAllOnDemand.filter(readsHere);
      const promptHiddenCount = (promptAll.length - promptItems.length) + (promptAllOnDemand.length - promptOnDemand.length);

      const skillsOff = skills.filter((s) => s.state === "off").length;
      const serversOff = servers.filter((s) => s.state === "off").length;
      const serversDeferred = servers.filter((s) => s.state === "deferred").length;
      const toolsTotal = servers.reduce((n, s) => n + s.tools.length, 0);
      const toolsOff = servers.reduce((n, s) => n + s.tools.filter((t) => t.state === "off").length, 0);

      const tailPath = (value) => {
        const parts = String(value || "").split(/[\/]/).filter(Boolean);
        return parts.slice(-2).join("/") || String(value || "");
      };

      const shortLabel = (label) => {
        const parts = String(label).split(SEP).filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] : label;
      };

      /** 拖右边缘改左侧列表宽度（150–420）。 */
      function startLeftDrag(event) {
        if (!event || typeof event.preventDefault !== "function") return;
        event.preventDefault();
        setHoverEdge("left");
        const startX = event.clientX;
        const startWidth = leftWidth;
        const onMove = (moveEvent) => {
          const next = startWidth + (moveEvent.clientX - startX);
          setLeftWidth(Math.max(150, Math.min(420, next)));
        };
        const onUp = () => {
          setHoverEdge(null);
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      }

      function Chevron(props) {
        return jsxs("svg", {
          width: 14,
          height: 14,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
          children: [
            jsx("path", { d: props.points ?? "M15 6l-6 6 6 6" }),
          ],
        });
      }

      const leftToggle = jsx("button", {
        type: "button",
        onClick: () => setLeftCollapsed(!leftCollapsed),
        title: leftCollapsed ? "展开左侧列表" : "收起左侧列表",
        "aria-label": leftCollapsed ? "展开左侧列表" : "收起左侧列表",
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          flex: "0 0 auto",
          borderRadius: 6,
          border: `1px solid ${c.border}`,
          background: "transparent",
          color: c.dim,
          cursor: "pointer",
        },
        children: jsx(Chevron, { points: leftCollapsed ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6" }),
      }, "left-toggle");

      const leftList = jsxs("div", {
        style: {
          width: leftWidth,
          flex: "0 0 auto",
          borderRight: `1px solid ${c.border}`,
          overflowY: "auto",
          padding: "14px 10px",
          background: "#f9fafb",
        },
        children: [
          jsx("div", {
            style: {
              fontSize: 10,
              color: c.dim,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              padding: "0 8px 6px",
            },
            children: "作用域",
          }),
          jsx("div", {
            style: {
              fontSize: 10,
              color: c.dim,
              lineHeight: 1.6,
              padding: "0 8px 10px",
              borderBottom: `1px solid ${c.border}`,
              marginBottom: 8,
            },
            children: "优先级由下至上：工作区覆盖全局",
          }),
          ...workspaces.map((entry) => {
            const active = entry.key === ws;
            const isGlobal = entry.key === "global";
            return jsxs("button", {
              type: "button",
              onClick: () => pickWorkspace(entry.key),
              title: entry.cwd || entry.label,
              style: {
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "7px 9px",
                marginBottom: 3,
                border: "none",
                borderLeft: "3px solid transparent",
                borderRadius: 8,
                cursor: "pointer",
                background: active ? "rgba(47,124,246,0.12)" : "transparent",
                color: active ? c.text : c.dim,
              },
              children: [
              jsx("div", {
                key: "t",
                style: {
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 500,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
                children: isGlobal ? "全局" : entry.label,
              }),
              jsx("div", {
                key: "h",
                style: {
                  fontSize: 10,
                  color: isGlobal ? c.dim : c.warn,
                  marginTop: 1,
                  opacity: active ? 0.9 : 0.75,
                },
                children: isGlobal
                  ? "基础层 · 全局配置"
                  : `${entry.hint || "覆盖全局"} · ${tailPath(entry.cwd || entry.label)}`,
              }),
              ],
            }, entry.key);
          }),
        ],
      });

      /**
       * 拖动条：平时完全不可见（透明 + 透明细线），指针进入这 8px 才亮出一道 2px 的线。
       * 直接给整条上色会让面板看起来像被画了格子线。
       */
      function edgeHandle(key, onMouseDown, title, id) {
        const active = hoverEdge === key;
        return jsx("div", {
          onMouseDown,
          onMouseEnter: () => setHoverEdge(key),
          onMouseLeave: () => setHoverEdge((current) => (current === key ? null : current)),
          title,
          style: {
            width: 10,
            flex: "0 0 auto",
            display: "flex",
            justifyContent: "center",
            cursor: "col-resize",
            marginLeft: key === "left" ? -1 : 0,
          },
          children: jsx("div", {
            style: {
              width: 2,
              height: "100%",
              background: active ? c.trackOn : "transparent",
              transition: "background .12s ease",
            },
          }),
        }, id);
      }

      const leftResizer = edgeHandle("left", startLeftDrag, "拖动调整列表宽度", "left-resizer")

      const header = jsxs("div", {
        style: {
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          padding: "14px 16px 8px",
        },
        children: [
          jsxs("div", {
            style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
            children: [
              leftToggle,
              jsxs("div", {
                style: { minWidth: 0 },
                children: [
                  jsx("div", { style: { fontSize: 15, fontWeight: 600 }, children: PANEL_NAME }),
                  jsx("div", {
                    style: { fontSize: 11, color: c.dim, marginTop: 3, lineHeight: 1.6, wordBreak: "break-all" },
                    children: !data
                      ? "正在读取配置…"
                      : ws === "global"
                        ? "作用域：全局 · 写入 ~/.dsh/skill-mcp-gate/settings.json"
                        : `作用域：${ws || "—"} · 写入该工作区的 .dsh/skill-mcp-gate.json`,
                  }),
                ],
              }),
            ],
          }),
          jsx(TextButton, {
            onClick: () => act("refresh", () => loadState(ws)),
            disabled: busy === "refresh",
            children: busy === "refresh" ? "刷新中…" : "刷新",
          }),
        ],
      });

      function tabButton(key, label) {
        const active = tab === key;
        return jsx("button", {
          type: "button",
          onClick: () => setTab(key),
          style: {
            padding: "6px 14px",
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 13,
            border: `1px solid ${active ? c.trackOn : c.border}`,
            background: active ? "rgba(47,124,246,0.10)" : "transparent",
            color: active ? c.text : c.dim,
            fontWeight: active ? 600 : 400,
          },
          children: label,
        });
      }

      const toolbar = jsx("div", {
        role: "tablist",
        style: { display: "flex", gap: 8, padding: "4px 16px 10px" },
        children: [
          tabButton("skills", `Skills ${skills.length}`),
          tabButton("mcps", `MCPs ${servers.length}`),
          tabButton("prompt", `Prompt ${promptItems.length + promptOnDemand.length}`),
        ],
      });

      if (!data) {
        return jsx("div", {
          style: { display: "flex", height: "100%" },
          children: [leftList, jsxs("div", {
            style: { flex: "1 1 auto", display: "flex", flexDirection: "column" },
            children: [
              header,
              jsx("div", {
                style: { padding: 32, textAlign: "center", color: error ? c.danger : c.dim, fontSize: 12.5, lineHeight: 1.8 },
                children: error ? `加载失败：${error}` : "加载中…",
              }),
            ],
          })],
        });
      }

      async function openSkillPreview(skill) {
        if (skillPreview && skillPreview.name === skill.name) { setSkillPreview(null); return; }
        setBusy(`skill:${skill.name}`);
        setError(null);
        try {
          const payload = await post("/skill/content", { name: skill.name });
          setSkillPreview({ ...payload.skill, error: null });
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(null);
        }
      }

      async function invokeSkillOnce(skill) {
        setBusy(`invoke:${skill.name}`);
        try {
          const payload = await post("/skill/invoke", { name: skill.name });
          setNotices({ ...notices, [`skill:${skill.name}`]: `已注入上下文，下一次请求生效（队列 ${payload.pending}）` });
        } catch (e) {
          setNotices({ ...notices, [`skill:${skill.name}`]: e.message });
        } finally {
          setBusy(null);
        }
      }

      function skillRow(skill) {
        const key = `skill:${skill.name}`;
        const enabled = skill.state !== "off";
        const rows = [];
        rows.push(jsxs("div", {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            borderBottom: `1px solid ${c.border}`,
            opacity: busy === key ? 0.6 : 1,
          },
          children: [
            jsxs("div", {
              style: { flex: "1 1 auto", minWidth: 0 },
              children: [
                jsxs("div", {
                  style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
                  children: [
                    jsx("span", {
                      style: { fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                      children: skill.name,
                    }),
                    jsx(Pill, {
                      tone: skill.scope === "project" ? "warn" : undefined,
                      children: SCOPE_TAG[skill.scope] || "系统",
                    }),
                    (skill.gaps || []).length > 0
                      ? jsx(Pill, { tone: "warn", children: `CC 字段 ${skill.gaps.map((g) => g.field).join(" / ")} 未适配` })
                      : null,
                  ],
                }),
                jsx("div", {
                  style: { fontSize: 10.5, color: c.dim, marginTop: 2 },
                  children: `${skill.source} · 覆盖层 ${skill.decidedBy}`,
                }),
              ],
            }),
            hasContentApi === false
              ? null
              : jsx(TextButton, {
                onClick: () => openSkillPreview(skill),
                active: !!(skillPreview && skillPreview.name === skill.name),
                disabled: busy === `skill:${skill.name}` || hasContentApi === null,
                children: "内容",
              }),
            enabled
              ? jsx(Segmented, {
                value: skill.state,
                disabled: busy === key,
                onChange: (next) => act(key, () => post("/skill", { name: skill.name, state: next, ws })),
              })
              : null,
            jsx(Switch, {
              checked: enabled,
              disabled: busy === key,
              label: enabled ? `关闭 ${skill.name}` : `启用 ${skill.name}`,
              onChange: (next) => act(key, () => post("/skill", { name: skill.name, state: next ? "on" : "off", ws })),
            }),
          ],
        }, `${skill.name}:head`));

        if (skillPreview && skillPreview.name === skill.name) {
          rows.push(jsxs("div", {
            style: { padding: "8px 12px 10px 12px", borderBottom: `1px solid ${c.border}`, background: c.soft },
            children: [
              jsxs("div", {
                style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 6 },
                children: [
                  jsx("span", { style: { fontSize: 10.5, color: c.dim }, children: `provider ${skillPreview.provider} · ${skillPreview.content.length} 字符` }),
                  jsx(TextButton, { onClick: () => invokeSkillOnce(skill), disabled: busy === `invoke:${skill.name}`, children: "调用一次" }),
                  jsx(TextButton, { onClick: () => setSkillPreview(null), children: "收起" }),
                ],
              }),
              jsx("pre", {
                style: {
                  margin: 0,
                  maxHeight: 260,
                  overflow: "auto",
                  fontFamily: "ui-monospace, Consolas, monospace",
                  fontSize: 11,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                },
                children: skillPreview.content,
              }),
            ],
          }, `${skill.name}:preview`));
        }

        if (notices[`skill:${skill.name}`]) {
          rows.push(jsx("div", {
            style: { padding: "6px 12px", fontSize: 10.5, color: c.dim, borderBottom: `1px solid ${c.border}` },
            children: notices[`skill:${skill.name}`],
          }, `${skill.name}:notice`));
        }

        return jsx(Fragment, { children: rows }, skill.name);
      }

      // 已建运行期条目、但工具还没出现 → 正在连接（多半是 npx 冷启动）
      const connectingServers = ((data.mcp && data.mcp.connections && data.mcp.connections.active) || [])
        .reduce((acc, name) => { acc[name] = true; return acc; }, {});

      const managedServers = ((data.mcp && data.mcp.connections && data.mcp.connections.managed) || [])
        .reduce((acc, name) => { acc[name] = true; return acc; }, {});

      /** 声明层 tag：与 Skills 行同一套观感（全局 / 项目 / 未声明），CC 来源另外标。 */
      function scopeTags(srv) {
        if (srv.layer === "cc") {
          return [jsx(Pill, { key: "cc", children: CC_SCOPE_TAG[srv.ccScope] || "CC 定义" })];
        }
        const layer = jsx(Pill, {
          key: "layer",
          tone: srv.layer === "project" ? "warn" : undefined,
          children: LAYER_TAG[srv.layer] || "未声明",
        });
        return srv.ccScope
          ? [layer, jsx(Pill, { key: "cc", children: CC_SCOPE_TAG[srv.ccScope] || "CC" })]
          : [layer];
      }

      function probeText(probe) {
        if (!probe) return "";
        const connected = probe.connected ? "当前已连上" : "当前未连上";
        if (probe.mode === "unknown") return `${connected} · 无法探测：${probe.reason}`;
        const head = probe.mode === "http"
          ? (probe.ok ? "端点可达" : "端点不可达")
          : (probe.ok ? "命令可执行" : "命令不可执行");
        return `${connected} · ${head} · ${probe.detail}`;
      }

      async function renameEntry(srv) {
        const next = window.prompt(`把 ${srv.name} 改成（只改本插件配置里的这条记录）：`, srv.name);
        if (next === null) return;
        const to = String(next).trim();
        if (to.length === 0 || to === srv.name) return;
        setBusy(`rename:${srv.name}`);
        setError(null);
        try {
          const payload = await post("/mcp/rename", { from: srv.name, to, ws });
          setData(payload.state);
          setNotices({ ...notices, [srv.name]: `已改名为 ${to}（门禁条目、定义、运行期连接一起改）` });
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(null);
        }
      }

      async function deleteEntry(srv) {
        if (!window.confirm(`删除 ${srv.name} 这条记录？
只删本插件配置文件里的这一条，不动 DSH profile、不动 Claude Code 的文件。`)) return;
        await act(`delete:${srv.name}`, () => post("/mcp/remove", { server: srv.name, ws }));
      }

      /** 把 CC 里的连接定义复制进本插件配置：之后这台就能连、能延迟、能真断开。 */
      async function adoptEntries(list) {
        const names = list
          .filter((srv) => srv.ccScope && !srv.hasDefinition)
          .map((srv) => srv.name);
        if (names.length === 0) return;
        setBusy("adopt");
        setError(null);
        try {
          const payload = await post("/mcp/adopt", { names, ws });
          setData(payload.state);
          const next = { ...notices };
          for (const name of payload.copied || []) next[name] = `已复制到 DSH（${payload.file}）并接管连接`;
          for (const item of payload.skipped || []) next[item.name] = `未复制：${item.reason}`;
          setNotices(next);
          if ((payload.copied || []).length === 0) {
            setError(`复制失败：${(payload.skipped || []).map((item) => `${item.name} — ${item.reason}`).join("；")}`);
          }
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(null);
        }
      }

      async function openEditor(srv) {
        setBusy(`def:${srv.name}`);
        setError(null);
        try {
          const payload = await post("/mcp/definition", { server: srv.name });
          const def = payload.definition;
          setEditor({
            server: srv.name,
            text: JSON.stringify(def.config, null, 2),
            source: def.source,
            managed: def.managed,
            error: null,
          });
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(null);
        }
      }

      async function saveEditor() {
        if (!editor) return;
        setEditor({ ...editor, error: null, saving: true });
        try {
          const payload = await post("/mcp/define", { server: editor.server, json: editor.text });
          setData(payload.state);
          setNotices({ ...notices, [editor.server]: `已写入 ${payload.file} 并接管连接` });
          setEditor(null);
        } catch (e) {
          setEditor({ ...editor, error: e.message, saving: false });
        }
      }


      async function probeEntry(srv) {
        setBusy(`probe:${srv.name}`);
        setError(null);
        try {
          const payload = await post("/mcp/probe", { server: srv.name });
          setProbeResults({ ...probeResults, [srv.name]: payload.probe });
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(null);
        }
      }

      function serverRow(srv) {
        const key = `mcp:${srv.name}`;
        const off = srv.state === "off";
        const deferred = srv.state === "deferred";
        const open = !!expanded[srv.name];
        const ccOnly = srv.layer === "cc";
        const rows = [
          jsxs("div", {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderBottom: `1px solid ${c.border}`,
              opacity: busy === key ? 0.6 : 1,
            },
            children: [
              jsxs("div", {
                style: { flex: "1 1 auto", minWidth: 0 },
                children: [
                  jsxs("div", {
                    style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
                    children: [
                      jsx("span", { style: { fontSize: 13, fontWeight: 500 }, children: srv.name }),
                      off
                        ? jsx(Pill, { tone: "danger", children: "已关闭（已断开）" })
                        : srv.connected
                          ? jsx(Pill, { tone: "ok", children: "运行中" })
                          : connectingServers[srv.name]
                            ? jsx(Pill, { tone: "warn", children: "连接中…" })
                            : jsx(Pill, { tone: "warn", children: "未连接" }),
                      deferred ? jsx(Pill, { tone: "warn", children: "延迟" }) : null,
                      ...scopeTags(srv),
                      srv.ccRejected ? jsx(Pill, { tone: "warn", children: "CC 已拒绝" }) : null,
                      srv.ccScope === "project" && srv.ccApproved === false && !srv.ccRejected
                        ? jsx(Pill, { tone: "warn", children: "CC 未批准" })
                        : null,
                    ],
                  }),
                  jsx("div", {
                    style: { fontSize: 10.5, color: c.dim, marginTop: 2 },
                    children: srv.connected
                      ? `${srv.tools.length} 个工具${srv.tools.some((t) => t.state === "off") ? `，${srv.tools.filter((t) => t.state === "off").length} 个已关` : ""}${deferred ? "，不进提示词，可按需搜索调用" : ""}${off ? "；当前对模型隐藏（不影响连接）" : ""}`
                      : connectingServers[srv.name]
                        ? "正在启动服务器…（npx 冷启动可能要十几秒，成功后自动变绿）"
                        : "尚未连上；先确认它已被本插件接管（看有没有「插件代管」标签）",
                  }),
                ],
              }),
              srv.tools.length > 0
                ? jsx(TextButton, {
                  onClick: () => setExpanded({ ...expanded, [srv.name]: !open }),
                  active: open,
                  children: `工具 ${open ? "▾" : "▸"}`,
                })
                : null,
              jsx(TextButton, {
                onClick: () => openEditor(srv),
                active: editor && editor.server === srv.name,
                disabled: busy === `def:${srv.name}`,
                children: "编辑",
                title: "编辑这台服务器的连接 JSON",
              }),
              jsx(TextButton, {
                onClick: () => deleteEntry(srv),
                disabled: ccOnly || busy === `delete:${srv.name}`,
                title: ccOnly ? "定义来自 Claude Code，本插件不改 CC 文件" : "删除本插件配置里的这条记录",
                children: "删除",
              }),
              jsx(TextButton, {
                onClick: () => setActionsOpen({ ...actionsOpen, [srv.name]: !actionsOpen[srv.name] }),
                active: !!actionsOpen[srv.name],
                children: "⋯",
                title: "延迟 / 重命名 / 测试连通",
              }),
              jsx(Switch, {
                checked: !off,
                disabled: busy === key,
                label: off ? `启用 ${srv.name}` : `停用 ${srv.name}`,
                onChange: (next) => act(key, () => post("/mcp", { server: srv.name, state: next ? "on" : "off", ws })),
              }),
            ],
          }, `${srv.name}:head`),
        ];
        if (actionsOpen[srv.name]) {
          rows.push(jsxs("div", {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
              padding: "6px 12px 6px 26px",
              borderBottom: `1px solid ${c.border}`,
              background: c.soft,
            },
            children: [
              jsx(TextButton, {
                onClick: () => act(key, () => post("/mcp", { server: srv.name, state: deferred ? "on" : "deferred", ws })),
                active: deferred,
                disabled: busy === key || (!srv.hasDefinition && !deferred),
                title: !srv.hasDefinition && !deferred ? "延迟加载需要本插件接管连接定义（这台只在 Claude Code 里声明）" : "延迟：连着但工具不进提示词，可按需搜索调用",
                children: deferred ? "延迟中（点一下关掉）" : "延迟加载",
              }),
              srv.ccScope && !srv.hasDefinition
                ? jsx(TextButton, {
                  onClick: () => adoptEntries([srv]),
                  disabled: busy === "adopt",
                  title: "把 Claude Code 里的连接定义（含 env）复制进本插件配置；之后这台才连得上、能延迟、能真断开",
                  children: busy === "adopt" ? "复制中…" : "复制到 DSH",
                })
                : null,
              jsx(TextButton, {
                onClick: () => renameEntry(srv),
                disabled: ccOnly || busy === `rename:${srv.name}`,
                title: ccOnly ? "定义来自 Claude Code，本插件不改 CC 文件" : "只改本插件配置里的这条记录",
                children: "重命名",
              }),
              jsx(TextButton, {
                onClick: () => probeEntry(srv),
                disabled: busy === `probe:${srv.name}`,
                children: busy === `probe:${srv.name}` ? "探测中…" : "测试连通",
              }),
              probeResults[srv.name]
                ? jsx("span", {
                  style: { fontSize: 10.5, color: probeResults[srv.name].ok ? c.ok : c.warn },
                  children: probeText(probeResults[srv.name]),
                })
                : null,
              notices[srv.name]
                ? jsx("div", {
                  style: { fontSize: 10.5, color: c.dim, flexBasis: "100%", marginTop: 2 },
                  children: notices[srv.name],
                })
                : null,
            ],
          }, `${srv.name}:actions`));
        }
        if (editor && editor.server === srv.name) {
          const sourceNote = editor.source === "mcp.json"
            ? "定义来自项目里的 .mcp.json（Claude Code 的文件，本插件只读）。保存会复制一份进本插件配置，不动源文件。"
            : editor.source === "plugin"
              ? "这是本插件配置里的连接定义。"
              : editor.source === "claude-code"
                ? "这是从 Claude Code 的用户级定义生成的初稿。"
                : "没有现成定义，下面是一份空模板。";
          rows.push(jsxs("div", {
            style: { padding: "8px 12px 10px 26px", borderBottom: `1px solid ${c.border}` },
            children: [
              jsx("div", {
                style: { fontSize: 10.5, color: c.dim, marginBottom: 5 },
                children: `${sourceNote} 保存写进 skill-mcp-gate.json 并立刻接管；切换工作区时只保留当前项目的连接。`,
              }),
              jsx("textarea", {
                value: editor.text,
                spellCheck: false,
                rows: 10,
                onChange: (e) => setEditor({ ...editor, text: e.target.value }),
                style: {
                  width: "100%",
                  boxSizing: "border-box",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  padding: 8,
                  borderRadius: 6,
                  border: `1px solid ${c.border}`,
                  background: "var(--dsh-bg, #fff)",
                  color: c.text,
                  minHeight: 360,
                  resize: "vertical",
                },
              }),
              jsxs("div", {
                style: { display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" },
                children: [
                  jsx(TextButton, { onClick: saveEditor, disabled: !!editor.saving, children: editor.saving ? "保存中…" : "保存并热加载" }),
                  jsx(TextButton, {
                    onClick: () => openEditor(srv),
                    children: "恢复为 CC 定义",
                    title: "重新从 Claude Code 的定义生成初稿（不保存）",
                  }),
                  jsx(TextButton, { onClick: () => setEditor(null), children: "取消" }),
                ],
              }),
              editor.error
                ? jsx("div", { style: { fontSize: 10.5, color: c.danger, marginTop: 5 }, children: editor.error })
                : null,
            ],
          }, `${srv.name}:editor`));
        }
        if (open) {
          for (const tool of srv.tools) {
            const toolKey = `tool:${srv.name}.${tool.name}`;
            rows.push(jsxs("div", {
              style: {
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 12px 6px 26px",
                borderBottom: `1px solid ${c.border}`,
                opacity: off ? 0.45 : busy === toolKey ? 0.6 : 1,
              },
              children: [
                jsxs("div", {
                  style: { flex: "1 1 auto", minWidth: 0 },
                  children: [
                    jsx("div", {
                      style: { fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                      children: tool.name,
                    }),
                    jsx("div", {
                      style: { fontSize: 10, color: c.dim },
                      children: off ? "随服务器一起停用"
                        : tool.state === "off" ? "已从模型工具列表移除"
                          : deferred ? "延迟：可被 gate_mcp_search 搜到并调用"
                            : "对模型可用",
                    }),
                  ],
                }),
                jsx(Switch, {
                  checked: tool.state !== "off",
                  disabled: off || busy === toolKey,
                  label: `切换 ${srv.name}.${tool.name}`,
                  onChange: (next) => act(toolKey, () => post("/tool", { server: srv.name, tool: tool.name, state: next ? "on" : "off", ws })),
                }),
              ],
            }, `${srv.name}.${tool.name}`));
          }
        }
        return jsx(Fragment, { children: rows }, srv.name);
      }

      function card(children, key) {
        return jsx("div", {
          style: { border: `1px solid ${c.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 12 },
          children,
        }, key);
      }

      const emptyBox = (text) => jsx("div", {
        style: { padding: 26, textAlign: "center", color: c.dim, fontSize: 12.5 },
        children: text,
      });

      // 项目级在前、用户级居中、内置在后
      const SCOPE_ORDER = { project: 0, user: 1, builtin: 2 };
      const orderedSkills = [...skills].sort((a, b) => {
        const left = SCOPE_ORDER[a.scope] ?? 9;
        const right = SCOPE_ORDER[b.scope] ?? 9;
        if (left !== right) return left - right;
        return String(a.name).localeCompare(String(b.name));
      });

      // 分组：只有「本项目自己的 skills」默认展开，用户级与内置默认折叠
      const groupOfScope = (scope) => (scope === "project" ? "project" : scope === "builtin" ? "builtin" : "user");
      const GROUP_LABEL = { project: "本项目技能", user: "用户级技能", builtin: "内置技能" };
      const GROUP_HINT = {
        project: "当前工作区里的 .dsh/skills、.claude/skills",
        user: "~/.claude/skills、~/.dsh/skills、~/.agents/skills",
        builtin: "随 DSH 一起打包",
      };
      const groups = ["project", "user", "builtin"].map((key) => ({
        key,
        rows: orderedSkills.filter((skill) => groupOfScope(skill.scope) === key),
      })).filter((group) => group.rows.length > 0);

      /** 默认：只有项目组展开，其它折叠。用户点过就以点的为准。 */
      const isCollapsed = (key) => (collapsedGroups[key] !== undefined ? collapsedGroups[key] : key !== "project");

      function sectionHeader({ id, label, hint, count, collapsed, onToggle }) {
        return jsxs("button", {
          type: "button",
          onClick: onToggle,
          "aria-expanded": !collapsed,
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "7px 12px",
            border: "none",
            borderBottom: `1px solid ${c.border}`,
            background: c.soft,
            cursor: "pointer",
            textAlign: "left",
            color: c.text,
          },
          children: [
            jsx("span", { style: { fontSize: 11, color: c.dim, width: 10 }, children: collapsed ? "▸" : "▾" }),
            jsx("span", { style: { fontSize: 12, fontWeight: 600 }, children: label }),
            jsx("span", { style: { fontSize: 10.5, color: c.dim }, children: `${count} 个` }),
            jsx("span", {
              style: { fontSize: 10, color: c.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
              children: hint,
            }),
          ],
        }, `${id}:header`);
      }

      function groupHeader(group) {
        const collapsed = isCollapsed(group.key);
        return sectionHeader({
          id: group.key,
          label: GROUP_LABEL[group.key],
          hint: GROUP_HINT[group.key],
          count: group.rows.length,
          collapsed,
          onToggle: () => setCollapsedGroups({ ...collapsedGroups, [group.key]: !collapsed }),
        });
      }

      const skillsView = skills.length === 0
        ? emptyBox("当前作用域没有可用技能")
        : groups.map((group) => card([
          groupHeader(group),
          ...(isCollapsed(group.key) ? [] : group.rows.map(skillRow)),
        ], `${group.key}:card`));

      const addPanel = jsxs("div", {
        style: { marginBottom: 12 },
        children: [
          jsxs("div", {
            style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
            children: [
              jsx("span", { style: { fontSize: 11.5, fontWeight: 600 }, children: "自定义填入" }),
              jsx("span", {
                style: { fontSize: 10.5, color: c.dim },
                children: "粘贴连接 config 或 mcpServers JSON，或每行一个服务器名",
              }),
            ],
          }),
          jsx("textarea", {
            value: addText,
            onChange: (e) => { setAddText(e.target.value); setAddError(null); },
            placeholder: '{"transport":"stdio","serverName":"my-server","command":"npx","args":["-y","pkg"]}' + String.fromCharCode(10) + '或 { mcpServers: {...} } / 每行一个名字',
            rows: 3,
            style: {
              width: "100%",
              boxSizing: "border-box",
              fontSize: 11.5,
              fontFamily: "ui-monospace, Consolas, monospace",
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${c.border}`,
              background: "transparent",
              color: "inherit",
              resize: "vertical",
            },
          }),
          jsxs("div", {
            style: { display: "flex", alignItems: "center", gap: 8, marginTop: 6 },
            children: [
              jsx(TextButton, {
                disabled: busy === "add" || addText.trim().length === 0,
                onClick: () => {
                  setBusy("add");
                  setAddError(null);
                  post("/mcp/add", { text: addText, ws })
                    .then((payload) => { setData(payload.state); setAddText(""); })
                    .catch((e) => setAddError(e.message))
                    .finally(() => setBusy(null));
                },
                children: busy === "add" ? "添加中…" : "解析并添加",
              }),
              addError ? jsx("span", { style: { fontSize: 11, color: c.danger }, children: addError }) : null,
            ],
          }),
        ],
      });

      // MCP 分组：本项目 / 全局 / 仅 Claude Code 声明 / 仅运行期发现。
      // 与 Skills 一致：只有本项目默认展开。
      const MCP_GROUP_LABEL = {
        project: "本项目 MCP",
        global: "全局 MCP",
        cc: "Claude Code 声明",
        runtime: "仅运行期发现",
      };
      const MCP_GROUP_HINT = {
        project: "<工作区>/.dsh/skill-mcp-gate.json",
        global: "~/.dsh/skill-mcp-gate/settings.json",
        cc: "在 ~/.claude.json 或 .mcp.json 里；本插件只读 —— 点「复制到 DSH」接管后才能连上",
        runtime: "配置里没有，但工具出现在了装配产物里",
      };
      const mcpGroupOf = (srv) => {
        if (srv.layer === "project") return "project";
        if (srv.layer === "global") return "global";
        if (srv.layer === "cc") return "cc";
        return "runtime";
      };
      const isMcpCollapsed = (key) => (collapsedMcp[key] !== undefined ? collapsedMcp[key] : key !== "project");
      const mcpGroups = ["project", "global", "cc", "runtime"]
        .map((key) => ({
          key,
          rows: [...servers]
            .filter((srv) => mcpGroupOf(srv) === key)
            .sort((a, b) => String(a.name).localeCompare(String(b.name))),
        }))
        .filter((group) => group.rows.length > 0);

      const mcpView = jsxs("div", {
        children: [
          addPanel,
          servers.length === 0
            ? emptyBox("当前作用域没有 MCP 服务器")
            : mcpGroups.map((group) => card([
              sectionHeader({
                id: `mcp:${group.key}`,
                label: MCP_GROUP_LABEL[group.key],
                hint: MCP_GROUP_HINT[group.key],
                count: group.rows.length,
                collapsed: isMcpCollapsed(group.key),
                onToggle: () => setCollapsedMcp({
                  ...collapsedMcp,
                  [group.key]: !isMcpCollapsed(group.key),
                }),
              }),
              ...(group.key === "cc" && !isMcpCollapsed(group.key) && group.rows.some((srv) => !srv.hasDefinition)
                ? [jsxs("div", {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                    padding: "6px 12px 6px 26px",
                    borderBottom: `1px solid ${c.border}`,
                    background: c.soft,
                  },
                  children: [
                    jsx(TextButton, {
                      onClick: () => adoptEntries(group.rows),
                      disabled: busy === "adopt",
                      children: busy === "adopt" ? "复制中…" : "全部复制到 DSH",
                    }),
                    jsx("span", {
                      style: { fontSize: 10.5, color: c.dim },
                      children: "把 CC 的连接定义（含 env）搬进本插件配置；之后可连、可延迟、可真断开。CC 的文件只读不动。",
                    }),
                  ],
                }, `mcp:${group.key}:adopt`)]
                : []),
              ...(isMcpCollapsed(group.key) ? [] : group.rows.map(serverRow)),
            ], `mcp:${group.key}`)),
        ],
      });

      function fmtBytes(n) {
        if (!Number.isFinite(n)) return "";
        return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
      }

      // ── 极简 markdown 渲染（零依赖）──────────────────────
      // 只覆盖 CLAUDE.md / AGENTS.md 里真会出现的东西：标题、列表、代码块、
      // 引用、表格、分隔线，行内含 `code` / **粗** / *斜* / [链接](url)。
      // 链接只放行 http(s)，其余原样当文本。
      const MD_TEXT = { fontSize: 12.5, lineHeight: 1.75, whiteSpace: "pre-wrap" };
      const MD_MONO = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5 };
      const MD_HEAD = [17, 15, 13.5, 12.8, 12.4, 12];

      function mdInline(text, keyBase) {
        const out = [];
        const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]*\]\([^)\s]+\))/g;
        let cursor = 0;
        let index = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
          if (match.index > cursor) out.push(text.slice(cursor, match.index));
          const token = match[0];
          const key = `${keyBase}:${index++}`;
          if (token.startsWith("`")) {
            out.push(jsx("code", { key, style: { ...MD_MONO, background: "rgba(0,0,0,.05)", padding: "1px 4px", borderRadius: 3 }, children: token.slice(1, -1) }));
          } else if (token.startsWith("**")) {
            out.push(jsx("strong", { key, style: { fontWeight: 600 }, children: token.slice(2, -2) }));
          } else if (token.startsWith("*")) {
            out.push(jsx("em", { key, style: { fontStyle: "italic" }, children: token.slice(1, -1) }));
          } else {
            const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
            const href = link ? link[2] : "";
            out.push(/^https?:\/\//i.test(href)
              ? jsx("a", { key, href, target: "_blank", rel: "noreferrer", style: { color: "#2f7cf6" }, children: link[1] || href })
              : jsx("span", { key, children: token }));
          }
          cursor = match.index + token.length;
        }
        if (cursor < text.length) out.push(text.slice(cursor));
        return out.length > 0 ? out : [text];
      }

      function renderMarkdown(source) {
        const NL = String.fromCharCode(10);
        const lines = String(source == null ? "" : source).split(NL);
        const blocks = [];
        let i = 0;
        let n = 0;
        const push = (element) => { blocks.push(element); n += 1; };

        while (i < lines.length) {
          const line = lines[i];
          if (/^\s*$/.test(line)) { i += 1; continue; }

          const fence = /^\s*(```|~~~)\s*[\w-]*\s*$/.exec(line);
          if (fence) {
            const body = [];
            i += 1;
            const close = new RegExp("^\\s*" + fence[1]);
            while (i < lines.length && !close.test(lines[i])) { body.push(lines[i]); i += 1; }
            i += 1;
            push(jsx("pre", {
              key: `b${n}`,
              style: { ...MD_MONO, margin: "6px 0", padding: 8, background: "rgba(0,0,0,.04)", border: `1px solid ${c.border}`, borderRadius: 6, overflowX: "auto", whiteSpace: "pre-wrap" },
              children: body.join(NL),
            }));
            continue;
          }

          // `## 标题` 与 `##标题` 都认（中文文档经常不写空格），也要吃掉 ATX 收尾的 ###
          const heading = /^\s*(#{1,6})(?!#)\s*(.*)$/.exec(line);
          if (heading) {
            const level = heading[1].length;
            const title = heading[2].replace(/\s*#+\s*$/, "").trim();
            if (title.length > 0) {
              push(jsx("h" + level, {
                key: `b${n}`,
                style: { margin: level <= 2 ? "14px 0 6px" : "10px 0 4px", fontSize: MD_HEAD[level - 1], fontWeight: 600, lineHeight: 1.45 },
                children: mdInline(title, `h${n}`),
              }));
              i += 1;
              continue;
            }
          }

          if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
            push(jsx("hr", { key: `b${n}`, style: { border: "none", borderTop: `1px solid ${c.border}`, margin: "12px 0" } }));
            i += 1;
            continue;
          }

          if (/^\s*>\s?/.test(line)) {
            const body = [];
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
              body.push(lines[i].replace(/^\s*>\s?/, ""));
              i += 1;
            }
            push(jsx("blockquote", {
              key: `b${n}`,
              style: { margin: "6px 0", padding: "4px 10px", borderLeft: `3px solid ${c.border}`, color: c.dim, ...MD_TEXT },
              children: mdInline(body.join(" "), `q${n}`),
            }));
            continue;
          }

          if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes("|")) {
            const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
            const head = cells(line);
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
              rows.push(cells(lines[i]));
              i += 1;
            }
            push(jsxs("table", {
              key: `b${n}`,
              style: { borderCollapse: "collapse", margin: "8px 0", fontSize: 11.5 },
              children: [
                jsx("thead", {
                  children: jsx("tr", {
                    children: head.map((cell, ci) => jsx("th", {
                      key: `th${ci}`,
                      style: { border: `1px solid ${c.border}`, padding: "3px 8px", textAlign: "left", background: c.soft },
                      children: mdInline(cell, `th${n}.${ci}`),
                    })),
                  }),
                }),
                jsx("tbody", {
                  children: rows.map((row, ri) => jsx("tr", {
                    key: `tr${ri}`,
                    children: row.map((cell, ci) => jsx("td", {
                      key: `td${ci}`,
                      style: { border: `1px solid ${c.border}`, padding: "3px 8px" },
                      children: mdInline(cell, `td${n}.${ri}.${ci}`),
                    })),
                  })),
                }),
              ],
            }));
            continue;
          }

          const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
          if (item) {
            const ordered = /\d/.test(item[2]);
            const entries = [];
            while (i < lines.length) {
              const next = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
              if (!next) break;
              entries.push({ depth: next[1].length >= 2 ? 1 : 0, text: next[3] });
              i += 1;
            }
            push(jsx(ordered ? "ol" : "ul", {
              key: `b${n}`,
              style: { margin: "4px 0", paddingLeft: 20, ...MD_TEXT },
              children: entries.map((entry, ei) => jsx("li", {
                key: `li${ei}`,
                style: { marginLeft: entry.depth * 14, marginBottom: 2 },
                children: mdInline(entry.text, `li${n}.${ei}`),
              })),
            }));
            continue;
          }

          const paragraph = [];
          while (
            i < lines.length
            && !/^\s*$/.test(lines[i])
            && !/^\s*(#{1,6}\s|```|~~~|>\s?)/.test(lines[i])
            && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])
          ) {
            paragraph.push(lines[i]);
            i += 1;
          }
          if (paragraph.length === 0) {
            // 兜底：走到这里说明有不被任何分支接受、又被段落判定排除的行（比如以前缩进的 `## 标题`）。
            // 原样当成一行输出 —— 否则 i 不前进，整个渲染就是死循环，页面直接卡死。
            paragraph.push(lines[i]);
            i += 1;
          }
          push(jsx("p", { key: `b${n}`, style: { margin: "6px 0", ...MD_TEXT }, children: mdInline(paragraph.join(NL), `p${n}`) }));
        }
        return blocks;
      }

      async function openPrompt(file, force) {
        if (!force && promptEditor && promptEditor.path === file.path) { setPromptEditor(null); return; }
        setBusy(`prompt:${file.path}`);
        setError(null);
        try {
          const payload = await post("/memory/read", { file: file.path });
          const memory = payload.memory;
          setPromptEditor({
            path: memory.path,
            label: memory.label,
            text: memory.content,
            original: memory.content,
            editable: memory.editable,
            error: null,
            saving: false,
          });
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(null);
        }
      }

      /** 只读预览：读正文，放进一个 <pre>，不改任何状态。 */
      async function openPromptPreview(file) {
        if (promptPreview && promptPreview.path === file.path) { setPromptPreview(null); return; }
        setBusy(`prompt:${file.path}`);
        setError(null);
        try {
          const payload = await post("/memory/read", { file: file.path });
          setPromptEditor(null);
          setPromptPreview({
            path: payload.memory.path,
            label: payload.memory.label,
            content: payload.memory.content,
            editable: payload.memory.editable === true,
          });
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(null);
        }
      }

      async function savePrompt() {
        if (!promptEditor) return;
        setPromptEditor({ ...promptEditor, error: null, saving: true });
        try {
          const payload = await post("/memory/save", { file: promptEditor.path, text: promptEditor.text });
          setData(payload.state);
          setNotices({ ...notices, [`prompt:${promptEditor.path}`]: `已写入（${fmtBytes(payload.bytes)}）` });
          setPromptEditor({ ...promptEditor, original: promptEditor.text, saving: false });
        } catch (e) {
          setPromptEditor({ ...promptEditor, error: e.message, saving: false });
        }
      }

      /** 缺失的候选：写一份最小模板，然后直接进编辑器。 */
      async function createPrompt(file) {
        const NL = String.fromCharCode(10);
        const template = ["# 项目约定", "", "<!-- 这份文件会整篇进上下文；不要写只有某一次任务才用得上的东西。 -->", "- ", ""].join(NL);
        setBusy(`prompt:${file.path}`);
        setError(null);
        try {
          const payload = await post("/memory/save", { file: file.path, text: template });
          setData(payload.state);
          setNotices({ ...notices, [`prompt:${file.path}`]: `已创建（${fmtBytes(payload.bytes)}）` });
          await openPrompt(file, true);
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(null);
        }
      }

      /** 一行一个文件：顺序号 = 注入顺序（只有基线文件编号，按需的不编）。 */
      function promptRow(file, index) {
        const key = `prompt:${file.path}`;
        const isOpen = !!promptEditor && promptEditor.path === file.path;
        const isPreview = !!promptPreview && promptPreview.path === file.path;
        const rows = [jsxs("div", {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            borderBottom: `1px solid ${c.border}`,
            opacity: busy === key ? 0.6 : 1,
          },
          children: [
            jsx("div", {
              style: { width: 18, flex: "0 0 auto", fontSize: 10.5, color: c.dim, textAlign: "right" },
              children: file.onDemand ? "·" : String(index),
            }),
            jsxs("div", {
              style: { flex: "1 1 auto", minWidth: 0 },
              children: [
                jsxs("div", {
                  style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
                  children: [
                    jsx("span", {
                      style: { fontSize: 12.5, fontWeight: 500, fontFamily: "ui-monospace, Consolas, monospace" },
                      children: file.label,
                    }),
                    file.readers.includes("dsh") ? jsx(Pill, { tone: "ok", children: "DSH 读" }) : null,
                    file.readers.includes("cc") ? jsx(Pill, { children: "CC 读" }) : null,
                    file.readers.length === 0 ? jsx(Pill, { tone: "warn", children: "没人读" }) : null,
                    file.missing ? jsx(Pill, { tone: "warn", children: "未创建" }) : null,
                    file.editable || file.missing ? null : jsx(Pill, { tone: "warn", children: "只读" }),
                  ],
                }),
                jsx("div", {
                  style: { fontSize: 10.5, color: c.dim, marginTop: 2 },
                  children: [file.missing ? "" : fmtBytes(file.size), file.note ? `${file.missing ? "" : " · "}${file.note}` : ""].join(""),
                }),
              ],
            }),
            file.missing
              ? jsx(TextButton, {
                onClick: () => createPrompt(file),
                disabled: busy === key,
                children: busy === key ? "…" : "新建",
              })
              : jsxs(Fragment, {
                children: [
                  jsx(TextButton, {
                    onClick: () => openPromptPreview(file),
                    active: isPreview,
                    disabled: busy === key,
                    children: isPreview ? "收起" : "预览",
                  }),
                  file.editable
                    ? jsx(TextButton, {
                      onClick: () => openPrompt(file),
                      active: isOpen,
                      disabled: busy === key,
                      children: isOpen ? "收起编辑" : "编辑",
                    })
                    : null,
                ],
              }, "acts"),
          ],
        }, key)];

        if (isOpen) {
          rows.push(jsxs("div", {
            style: { padding: "8px 12px 10px 34px", borderBottom: `1px solid ${c.border}`, background: c.soft },
            children: [
              jsx("textarea", {
                value: promptEditor.text,
                spellCheck: false,
                rows: 24,
                onChange: (e) => setPromptEditor({ ...promptEditor, text: e.target.value }),
                style: {
                  width: "100%",
                  boxSizing: "border-box",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 11.5,
                  lineHeight: 1.6,
                  padding: 8,
                  borderRadius: 6,
                  border: `1px solid ${c.border}`,
                  background: "var(--dsh-bg, #fff)",
                  color: c.text,
                  minHeight: 380,
                  resize: "vertical",
                },
              }),
              jsxs("div", {
                style: { display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" },
                children: [
                  promptEditor.editable
                    ? jsx(TextButton, {
                      onClick: savePrompt,
                      disabled: !!promptEditor.saving || promptEditor.text === promptEditor.original,
                      children: promptEditor.saving ? "保存中…" : "保存",
                    })
                    : jsx("span", { style: { fontSize: 10.5, color: c.dim }, children: "用户级 / 组织级文件：本插件只读" }),
                  jsx(TextButton, { onClick: () => openPrompt(file, true), children: "重新读取" }),
                  jsx(TextButton, { onClick: () => setPromptEditor(null), children: "关闭" }),
                  jsx("span", {
                    style: { fontSize: 10.5, color: c.dim },
                    children: `${promptEditor.text.length} 字${promptEditor.text === promptEditor.original ? "" : " · 已改动未保存"}`,
                  }),
                  notices[key] ? jsx("span", { style: { fontSize: 10.5, color: c.ok }, children: notices[key] }) : null,
                ],
              }),
              promptEditor.error
                ? jsx("div", { style: { fontSize: 10.5, color: c.danger, marginTop: 5 }, children: promptEditor.error })
                : null,
            ],
          }, `${key}:editor`));
        }
        return jsx(Fragment, { children: rows }, key);
      }

      const promptGroups = [
        { key: "project", label: "本项目（注入顺序）", hint: "数字就是进上下文的顺序：越靠后越具体", rows: promptItems.filter((file) => file.scope === "project") },
        { key: "user", label: "用户级 / 组织级", hint: "两边各读各的：CC 读 ~/.claude/CLAUDE.md，DSH 读 $DSH_HOME/AGENTS.md", rows: promptItems.filter((file) => file.scope !== "project") },
        { key: "ondemand", label: "子目录（按需加载）", hint: "有 read / write / edit 摸到那个目录才进上下文", rows: promptOnDemand },
        // 不存在的文件不占位：没创建就没有这一块（空组本来就会被下面的 filter 去掉，
        // 这里直接不产生「未创建」分组，避免用户看到一堆「没有的东西」）
      ].filter((group) => group.rows.length > 0);

      const promptBudget = promptInstructions ? promptInstructions.budget : null;

      const promptView = jsxs("div", {
        children: [
          jsxs("div", {
            style: { padding: "2px 4px 10px", fontSize: 10.5, color: c.dim, lineHeight: 1.75 },
            children: [
              jsx("div", {
                children: "两边都是拼接、不覆盖 —— 顺序就是优先级。DSH：先 $DSH_HOME/AGENTS.md，再从项目根到 cwd 逐目录读 AGENTS.md → CLAUDE.md → *.local.md。",
              }),
              jsx("div", {
                children: promptInstructions
                  ? (promptInstructions.ccHasClaude
                    ? "CC：本目录链上有 CLAUDE.md 家族，所以 AGENTS.md 被它跳过（Project instructions 默认 claude-md-or-agents-md）。"
                    : "CC：目录链上没有 CLAUDE.md 家族，所以读 AGENTS.md。")
                  : "当前 host 还没重启，拿不到提示词文件清单（重启 dsh web 后出现）。",
              }),
              promptHiddenCount > 0
                ? jsx("div", {
                  style: { color: c.dim, marginTop: 3 },
                  children: `只列本会话真正会读的文件；另有 ${promptHiddenCount} 份是另一个工具专用的（例如 ~/.claude/CLAUDE.md），在这里不生效，已隐藏。`,
                })
                : null,
              promptBudget && promptBudget.bytes > 0
                ? jsx("div", {
                  style: { marginTop: 3, color: promptBudget.over ? c.danger : undefined },
                  children: promptBudget.over
                    ? `DSH 预算 ${promptBudget.bytes} / ${promptBudget.maxBytes} B —— 超了：会先整篇丢掉 ${promptBudget.dropped.join("、") || "（无）"}${promptBudget.truncated ? `，最后截断 ${promptBudget.truncated}` : ""}`
                    : `DSH 预算 ${promptBudget.bytes} / ${promptBudget.maxBytes} B（${promptItems.filter((file) => file.readers.includes("dsh")).length} 份进基线）`,
                })
                : null,
            ],
          }),
          promptGroups.length === 0
            ? emptyBox("当前作用域没有 CLAUDE.md / AGENTS.md 一类文件")
            : promptGroups.map((group) => card([
              jsxs("div", {
                style: {
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  padding: "9px 12px",
                  borderBottom: `1px solid ${c.border}`,
                  background: c.soft,
                },
                children: [
                  jsx("span", { style: { fontSize: 12, fontWeight: 600 }, children: group.label }),
                  jsx("span", { style: { fontSize: 10, color: c.dim }, children: `${group.rows.length}` }),
                  jsx("span", { style: { fontSize: 10, color: c.dim }, children: group.hint }),
                ],
              }),
              ...group.rows.map((file, index) => promptRow(file, index)),
            ], `prompt:${group.key}`)),
        ],
      });


      /** 拖左边缘改预览窗格宽度（280–900）。 */
      function startPreviewDrag(event) {
        if (!event || typeof event.preventDefault !== "function") return;
        event.preventDefault();
        setHoverEdge("preview");
        const startX = event.clientX;
        const startWidth = previewWidth;
        const onMove = (moveEvent) => {
          const next = startWidth + (startX - moveEvent.clientX);
          setPreviewWidth(Math.max(280, Math.min(900, next)));
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      }

      const previewAside = promptPreview
        ? jsxs("div", {
          style: {
            width: previewWidth,
            flex: "0 0 auto",
            borderLeft: `1px solid ${c.border}`,
            background: "#fff",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          },
          children: [
            jsxs("div", {
              style: {
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
                borderBottom: `1px solid ${c.border}`,
                background: c.soft,
              },
              children: [
                jsxs("div", {
                  style: { flex: "1 1 auto", minWidth: 0 },
                  children: [
                    jsx("div", {
                      style: {
                        fontSize: 12,
                        fontWeight: 600,
                        fontFamily: "ui-monospace, Consolas, monospace",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      },
                      children: promptPreview.label,
                    }),
                    jsx("div", {
                      style: { fontSize: 10, color: c.dim, marginTop: 2 },
                      children: `渲染预览 · ${promptPreview.content.split(String.fromCharCode(10)).length} 行 · ${promptPreview.content.length} 字`,
                    }),
                  ],
                }),
                promptPreview.editable
                  ? jsx(TextButton, {
                    onClick: () => {
                      const target = { path: promptPreview.path, label: promptPreview.label, editable: true };
                      setPromptPreview(null);
                      openPrompt(target, true);
                    },
                    children: "去编辑",
                  })
                  : null,
                jsx(TextButton, { onClick: () => setPromptPreview(null), children: "关闭" }),
              ],
            }),
            jsx("div", {
              style: { flex: "1 1 auto", overflowY: "auto", padding: "8px 16px 24px", minHeight: 0 },
              // 太大的文件不做 md 渲染：几千个块会把浏览器拖死，原样显示更实在
              children: promptPreview.content.length > 40000
                ? jsxs(Fragment, {
                  children: [
                    jsx("div", {
                      style: { fontSize: 10.5, color: c.dim, marginBottom: 6 },
                      children: `文件偏大（${promptPreview.content.length} 字），按原文显示，不渲染 markdown`,
                    }),
                    jsx("pre", {
                      style: { ...MD_MONO, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" },
                      children: promptPreview.content,
                    }),
                  ],
                })
                : renderMarkdown(promptPreview.content),
            }),
          ],
        }, "prompt-preview")
        : null;

      const problems = (data.problems) || {};
      const lostCount = (problems.lost || []).length;
      const unsupportedCount = (problems.unsupported || []).length;
      const warnCount = (data.warnings || []).length;

      const footNotes = [];
      if (files.length > 0) {
        footNotes.push(jsx("div", {
          key: "f",
          style: { wordBreak: "break-all", marginBottom: 3 },
          children: `配置：${files.map((f) => (f.exists ? "✓ " : "· ") + f.file).join("　")}`,
        }));
      }
      footNotes.push(jsx("div", { key: "a", children: `技能 ${skillsOff} 个关闭 · MCP ${serversOff} 台停用 / ${serversDeferred} 台延迟 / ${toolsOff} 个工具关闭` }));
      footNotes.push(jsx("div", { key: "b", children: "技能通过重写目录消息生效，不改写 SKILL.md；MCP 停用只影响模型工具清单，不断连。" }));
      if (lostCount > 0) footNotes.push(jsx("div", { key: "l", style: { color: c.danger, marginTop: 3 }, children: `${lostCount} 项未生效，见 /gate doctor` }));
      if (unsupportedCount > 0) footNotes.push(jsx("div", { key: "u", style: { color: c.warn, marginTop: 3 }, children: `${unsupportedCount} 项 CC 设置未适配，见 /gate doctor` }));
      const listing = data.listing || {};
      if (listing.budget && listing.budget.chars) {
        const dropped = (listing.cost && listing.cost.dropped) || [];
        footNotes.push(jsx("div", {
          key: "budget",
          style: { color: dropped.length > 0 ? c.warn : undefined, marginTop: 3 },
          children: `目录预算 ${(listing.cost && listing.cost.after) || 0} / ${listing.budget.chars} 字${dropped.length > 0 ? `，${dropped.length} 条描述已省掉` : ""}（${listing.budget.source}）`,
        }));
      }
      if (hasContentApi === false) footNotes.push(jsx("div", { key: "api", style: { color: c.dim, marginTop: 3 }, children: "当前 host 没有技能内容接口，所以技能行不显示「内容」按钮；重启 dsh web 后可用。" }));
      if (warnCount > 0) footNotes.push(jsx("div", { key: "w", style: { color: c.danger, marginTop: 3 }, children: `${warnCount} 条配置警告` }));

      return jsxs("div", {
        style: { display: "flex", height: "100%", minHeight: 0 },
        children: [
          leftCollapsed ? null : leftList,
          leftCollapsed ? null : leftResizer,
          jsxs("div", {
            style: { flex: "1 1 auto", display: "flex", flexDirection: "column", minWidth: 0 },
            children: [
              header,
              toolbar,
              error
                ? jsx("div", {
                  style: {
                    margin: "0 16px 8px",
                    padding: "7px 10px",
                    borderRadius: 6,
                    background: "rgba(192,57,43,.10)",
                    color: c.danger,
                    fontSize: 11.5,
                  },
                  children: error,
                })
                : null,
              jsxs("div", {
                style: { flex: "1 1 auto", display: "flex", minHeight: 0 },
                children: [
                  jsx("div", {
                    style: { flex: "1 1 auto", overflowY: "auto", minHeight: 0, padding: "0 16px 8px" },
                    children: tab === "skills" ? skillsView : tab === "mcps" ? mcpView : promptView,
                  }),
                  tab === "prompt" && previewAside
                    ? edgeHandle("preview", startPreviewDrag, "拖动调整预览宽度", "prompt-preview-handle")
                    : null,
                  tab === "prompt" ? previewAside : null,
                ],
              }),
              jsx("div", {
                style: {
                  padding: "10px 16px 14px",
                  borderTop: `1px solid ${c.border}`,
                  fontSize: 11,
                  color: c.dim,
                  lineHeight: 1.7,
                },
                children: footNotes,
              }),
            ],
          }),
        ],
      });
    }

    function apply(ctx) {
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 20,
          label: () => PANEL_NAME,
        }, GateIcon));

      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID }, GatePanel));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
