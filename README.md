# oh-mcp

A minimal, zero-bloat **MCP Gateway** for **OpenHarness** and standard MCP clients.

## Features

- **Unified Namespace Routing (`<server>__<tool>`)**: Aggregates multiple `stdio` subprocesses and remote `http` MCP servers without tool name collisions.
- **Tool Governance**: Per-server `allowTools` and `denyTools` filtering.
- **Dual Northbound Interface**:
  - **OpenHarness REST API**: `GET /api/servers`, `GET /api/tools`, `POST /api/tools/call`
  - **Standard MCP Endpoint**: `POST /mcp` (JSON-RPC 2.0 `initialize`, `tools/list`, `tools/call`)
- **Zero Runtime Dependencies**: Built entirely on Node.js 22 native APIs.

## Quick Start

```sh
npm install
npm run typecheck
npm test
npm start
```
