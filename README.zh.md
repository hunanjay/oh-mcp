<div align="center">

# oh-mcp

### 轻量级、零运行时依赖的 AI Agent MCP 网关与控制平面。

将本地 `stdio` 子进程与远程 `Streamable HTTP` MCP Server 聚合到统一命名空间路由后，支持 Eager/Lazy 省 Context 模式与 SQLite 持久化。

[English](README.md) · [中文文档](README.zh.md)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-1C1917?style=flat-square)](tsconfig.json)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-B4652E?style=flat-square)](package.json)
[![Runtime Deps](https://img.shields.io/badge/Runtime_Deps-0-1C1917?style=flat-square)](package.json)
[![Works With](https://img.shields.io/badge/Works_With-OpenHarness-B4652E?style=flat-square)](https://github.com/hunanjay/openharness)

</div>

---

## 为什么做 oh-mcp？

把 5 个以上的 MCP Server 直接塞进 Agent 循环会立刻带来三个痛点：大量工具的 JSON Schema 撑爆上下文窗口、多 Server 重名工具冲突、以及每次启动 CLI 都要冷启动一堆子进程。

**oh-mcp** 将工具基础设施从 Agent 运行时彻底解耦：

- **零第三方运行时依赖**：完全基于 Node.js 22 原生 API 构建（`node:http`、`node:child_process`、`node:sqlite`、`fetch`）。
- **命名空间路由（`<server>__<tool>`）**：统一聚合多个 `stdio` 与 `Streamable HTTP` 上游 Server，避免重名冲突，支持单 Server 级 `allowTools` / `denyTools` 过滤。
- **Eager / Lazy 混合暴露模式**：高频 Server 保持 `eager` 直出；工具数量庞大时切为 `lazy` 模式，仅暴露 3 个元工具（`mcp_list_tools`、`mcp_describe_tool`、`mcp_call_tool`）按需检索与调用，大幅节省 Context Token。
- **三态生命周期管理**：清晰追踪每个上游 Server 的 `registered`（已注册）→ `active`（生效中）/ `failed`（已失效）状态，记录报错原因并支持一键启停与重连。
- **SQLite 持久化**：使用 `.oh-mcp/gateway.db` 持久化保存 Server 配置、暴露模式、工具策略、API Keys 与调用日志，重启不丢失。
- **双北向出口**：同时提供给 [**OpenHarness**](https://github.com/hunanjay/openharness) 控制平面的 REST 接口（`/api/*`），以及标准 MCP JSON-RPC 2.0 端点（`/mcp`），可接入任意标准 MCP 客户端。

---

## 系统架构

```text
  Agent 客户端 (OpenHarness · Claude Desktop · Cursor · 自定义 Agent)
         │                                            │
         │ REST (/api/*)                              │ MCP JSON-RPC (/mcp)
         ▼                                            ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │                       oh-mcp Gateway (:4090)                        │
  │                                                                     │
  │   McpHub 路由 (<server>__<tool>) · Eager / Lazy 元工具              │
  │   工具策略 · API Keys · 客户端遥测 · 调用日志 (node:sqlite)         │
  └──────────────┬─────────────────────────────────────┬────────────────┘
                 │                                     │
        ┌────────▼────────┐                   ┌────────▼────────┐
        │  StdioUpstream  │                   │  HttpUpstream   │
        │  本地子进程     │                   │ Streamable HTTP │
        └─────────────────┘                   └─────────────────┘
```

---

## 快速开始

> **环境要求**：Node.js 22+

```sh
# 1. 安装开发依赖
npm install

# 2. 类型检查 & 运行测试
npm run typecheck
npm test

# 3. 启动网关守护进程 (默认监听 http://127.0.0.1:4090)
npm start
```

首次启动时会自动加载 [mcp.json](mcp.json)（内置免配置的 `demo` stdio MCP Server，提供 `demo__system_info` 与 `demo__calc` 两个测试工具）并初始化 `.oh-mcp/gateway.db`。

---

## 配置示例 (`mcp.json`)

```json
{
  "mcpServers": {
    "demo": {
      "transport": "stdio",
      "mode": "eager",
      "command": "node",
      "args": ["src/demo-server.mjs"]
    },
    "github": {
      "transport": "stdio",
      "mode": "lazy",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "denyTools": ["delete_repository"]
    },
    "remote_docs": {
      "transport": "http",
      "mode": "eager",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

---

## License

MIT
