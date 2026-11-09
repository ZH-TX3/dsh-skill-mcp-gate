# AGENTS.md — dsh-skill-mcp-gate

DSH 插件：控制 skill / MCP 的可见性与可调用性（面板「Skills / MCPs 管理」）。
本仓库是 `D:\ds\dsh-plugins` 的 **submodule**。

## 开工前

- 用法与架构看 `README.md`，改动记录与 bug 复盘看 `DESIGN.md`（按版本号追加，不重写历史）。
- 改完必须自测：`npm test`（23 个套件，零依赖，不需要启动 DSH）。
- `lib/` 的分层别打乱：`cc/` = Claude Code 知识、`core/` = 纯领域、`platform/` = DSH 接缝、
  `host/` = 对外的命令/路由/快照。纯逻辑放 `core/` 才测得动。

## 提交

插件仓库只推一半 —— 主仓库里的指针（gitlink）不动，clone 主仓库的人拿不到新代码。
用主仓库的脚本：

```bash
cd /d/ds/dsh-plugins
./sync.sh "feat(panel): 本次改了什么"
```

只在动这个插件时：`./sync.sh "msg" dsh-skill-mcp-gate`。

## 运行环境

- 改完 **host 侧**（`index.js`、`lib/host/`、`lib/platform/`、`lib/load.js`）必须重启 `dsh web` 才生效；
  只改 `lib/client.js` 硬刷新页面即可。
- node 版本不对会让所有子进程执行失败（`Windows Job runner exited with code 1`），先 `node -v` 看一眼。
