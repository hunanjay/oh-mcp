<div align="center">

# oh-mcp

### Lightweight, zero-dependency MCP Gateway & Control Plane for AI Agents.

Aggregate local `stdio` subprocesses and remote `Streamable HTTP` MCP servers behind a single namespace router, with Eager/Lazy context-saving modes and SQLite persistence.

[English](README.md) · [中文文档](README.zh.md)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-1C1917?style=flat-square)](tsconfig.json)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-B4652E?style=flat-square)](package.json)
[![Runtime Deps](https://img.shields.io/badge/Runtime_Deps-0-1C1917?style=flat-square)](package.json)
[![Works With](https://img.shields.io/badge/Works_With-OpenHarness-B4652E?style=flat-square)](https://github.com/hunanjay/openharness)

</div>

---

## Why oh-mcp?

Connecting 5+ MCP servers directly into an agent loop bloats the context window with dozens of JSON schemas, causes tool name collisions, and forces every CLI/agent process to cold-start its own subprocesses.

**oh-mcp** decouples tool infrastructure from the agent runtime:

- **Zero Runtime Dependencies** — Built purely on Node.js 22 native APIs (`node:http`, `node:child_process`, `node:sqlite`, `fetch`).
- **Namespace Routing (`<server>__<tool>`)** — Aggregates any number of `stdio` and `Streamable HTTP` upstreams without tool name conflicts, with per-server `allowTools` / `denyTools` filtering.
- **Eager & Lazy Exposure Modes** — Keep high-frequency servers in `eager` mode, and switch large servers to `lazy` mode to hide individual schemas behind 3 meta-tools (`mcp_list_tools`, `mcp_describe_tool`, `mcp_call_tool`) — saving thousands of context tokens per turn.
- **3-State Lifecycle Management** — Tracks every upstream server cleanly through `registered` → `active` / `failed`, capturing exit/handshake errors and supporting one-click connect, disconnect, and reconnect.
- **SQLite Persistence** — Persists servers, exposure modes, tool policies, API keys, and execution call logs in `.oh-mcp/gateway.db` across restarts, seeded automatically from `mcp.json`.
- **Dual Northbound Interfaces** — Serves both a lightweight Control Plane REST API (`/api/*`) for [**OpenHarness**](https://github.com/hunanjay/openharness) and a standard MCP JSON-RPC 2.0 endpoint (`/mcp`) for any MCP client.

---

## Architecture

```text
  Agent Clients (OpenHarness · Claude Desktop · Cursor · Custom Agents)
         │                                            │
         │ REST (/api/*)                              │ MCP JSON-RPC (/mcp)
         ▼                                            ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │                       oh-mcp Gateway (:4090)                        │
  │                                                                     │
  │   McpHub Router (<server>__<tool>) · Eager / Lazy Meta-Tools        │
  │   Policies · API Keys · Client Telemetry · Call Logs (node:sqlite)  │
  └──────────────┬─────────────────────────────────────┬────────────────┘
                 │                                     │
        ┌────────▼────────┐                   ┌────────▼────────┐
        │  StdioUpstream  │                   │  HttpUpstream   │
        │  Local Process  │                   │ Streamable HTTP │
        └─────────────────┘                   └─────────────────┘
```

---

## Directory Structure

```text
src/
├── protocol/
│   └── jsonrpc.ts      # JSON-RPC 2.0 types & normalizeMcpResult()
├── upstream/
│   ├── base.ts         # UpstreamServer contract & ServerLifecycleState ('registered' | 'active' | 'failed')
│   ├── stdio.ts        # Local subprocess MCP client (newline JSON-RPC, timeout/abort cancellation)
│   └── http.ts         # Remote Streamable-HTTP MCP client (Mcp-Session-Id support)
├── gateway/
│   └── hub.ts          # McpHub aggregator, namespace routing, eager/lazy meta-tools, telemetry & logs
├── storage/
│   └── sqlite.ts       # SqliteGatewayStorage (.oh-mcp/gateway.db via node:sqlite)
├── server/
│   ├── http.ts         # HTTP server exposing /api/control-plane, /api/servers, /api/tools, /mcp
│   └── cli.ts          # CLI daemon entrypoint (default 127.0.0.1:4090)
├── config.ts           # Declarative mcp.json loader + SQLite seed merging
├── demo-server.mjs     # Built-in zero-dependency stdio demo server (system_info, calc)
└── index.ts            # Public exports
```

---

## Quick Start

> **Requires:** Node.js 22+

```sh
# 1. Install dev dependencies
npm install

# 2. Typecheck & run tests
npm run typecheck
npm test

# 3. Start the gateway daemon (default http://127.0.0.1:4090)
npm start
```

On first start, `oh-mcp` loads [mcp.json](mcp.json) (which includes a built-in `demo` stdio server with `demo__system_info` and `demo__calc`) and persists state to `.oh-mcp/gateway.db`.

---

## Configuration (`mcp.json`)

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

## HTTP & MCP Endpoints

| Endpoint | Purpose |
| :--- | :--- |
| `GET /health` | Gateway health & server summary |
| `GET /api/control-plane` | Aggregated servers, tools, clients, logs, API keys, and policies |
| `GET /api/servers` / `POST /api/servers` | List or register upstream MCP servers |
| `POST /api/servers/:name/connect` \| `disconnect` | Transition server between `registered` ↔ `active` / `failed` |
| `PATCH /api/servers/:name` \| `DELETE /api/servers/:name` | Update `mode` (`eager`/`lazy`), `denyTools`, or remove server |
| `GET /api/tools` (`?all=true&disabled=true`) | List exposed tools (or full catalog) |
| `POST /api/tools/call` | Invoke a tool by `<server>__<tool>` and return normalized text result |
| `POST /mcp` | Standard MCP JSON-RPC 2.0 endpoint (`initialize`, `tools/list`, `tools/call`) |

---

## License

MIT
