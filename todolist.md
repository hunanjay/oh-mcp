 我还在想 关于 工具这一块，我想做一个 MCP Gateway，来统一管理

  引入 MCP Gateway 是一个非常契合 OpenHarness “极薄核心（Thin Core）”哲学的方向：把内置的 read / write / edit / bash 保持为最底层的核心原语，而把所有扩展能力（浏览器、数据库、GitHub、外部 API 等）全部收拢到统一的 MCP Gateway 层，这样
  Harness 本身永远不会因为集成几十个第三方工具而膨胀。

  结合当前 src/tools/base.ts 和 src/core/loop.ts 的结构，设计一个轻量、高可靠的 MCP Gateway，核心要解决以下 4 个关键问题：
  ──────
  1. 架构定位：MCP Gateway 与 ToolRegistry 的关系

  最干净的分层方式是让 McpGateway 作为 上游多个 MCP Server 的聚合与路由器，向下直接桥接进现有的 ToolRegistry（或者实现相同的执行与 Schema 暴露契约），这样所有的 MCP 工具天然享受现有的 Policy 权限检查、HITL 人工审批、Ajv
  参数校验、超时控制、输出截断与 Spill 落盘、以及 Trace 记录：

  ┌────────────────────────────────────────┐   ┌────────────────────────┐   ┌────────────────────────┐
  │                                        │   │                        │   │                        │   │         │
  │          Core Loop (loop.ts)           ├──►│ Policy / HITL Approval ├──►│ ToolRegistry (base.ts) ├──►│ Builtin │
┌─┼────────────────────────────────────────┼─┐ │                        │   │                        │   │         │
│ └───────────Built-in─Pi─Tools────────────┘ │ └────────────────────────┘   └────────────┬───────────┘   └─────────┘
│                                            │                                           │
│                                            │                                           │
│ ┌────────────────────────────────────────┐ │                                           │               ┌─────────┐
│ │                                        │ │                                           │               │         │
│ │       read / write / edit / bash       │ │                                           └──────────────►│ Gateway │
│ │                                        │ │                                                           │         │
│ └────────────────────────────────────────┘ │                                                           └─────────┘
│                                            │
└────────────────────────────────────────────┘
  ┌────────────────────────────────────────┐
┌─┼────────────────────────────────────────┼─┐
│ │   MCP Gateway[(src/mcp/gateway.ts)     │ │
│ │                                        │ │
│ └────────────────────────────────────────┘ │
│                                            │
│                                            │
│ ┌────────────────────────────────────────┐ │
│ │                                        │ │
│ │             Schema Cache"]             │ │
│ │                                        │ │
│ └────────────────────────────────────────┘ │
│                                            │
│                                            │
│ ┌────────────────────────────────────────┐ │
│ │                                        │ │
│ │ Eager / Lazy Discovery (search / call) │ │
│ │                                        │ │
│ └────────────────────────────────────────┘ │
│                                            │
│                                            │
│                                            │
│                                            │
│                                            │
│                                            │
│ ┌────────────────────────────────────────┐ │
│ │                                        │ │
│ │   Stdio Transport (Local Subprocess)   │ │
│ │                                        │ │
│ └────────────────────────────────────────┘ │
│                      ▲                     │
│                      └─────────────────────┤
│ ┌────────────────────────────────────────┐ │
│ │                                        │ │
│ │ HTTP / Streamable HTTP / SSE Transport │ │
│ │                                        │ │
│ └────────────────────────────────────────┘ │
│                      ▲                     │
└──────────────────────┼─────────────────────┘
  ┌────────────────────┴───────────────────┐
  │                    ┴                   │
  │                 Router                 │
  │                                        │
  └────────────────────────────────────────┘
  ──────
  2. 四个核心设计要点

  ① 命名空间与防冲突路由（Namespacing）

  多个 MCP Server 很容易出现同名工具（例如两个 Server 都有 search 或 query）。

  • Gateway 统一采用 <serverName>__<toolName>（双下划线，兼容所有主流 LLM 的函数命名规范 ^[a-zA-Z0-9_-]+$）作为暴露给模型的工具名。
  • Gateway 内部维护 { "github__create_issue": { server: "github", originalName: "create_issue" } } 的路由表。

  ② 两种暴露模式：Eager（直接挂载） vs Lazy（按需加载，省 Context）

  这是 MCP 接入 Agent 最痛的点：如果接了 5 个 MCP Server、共 80 个工具，每个回合光是 tools JSON Schema 就会吃掉 15,000+ Tokens，还会严重干扰模型注意力。
  Gateway 可以原生支持按 Server 配置 mode: 'eager' | 'lazy'：

  • Eager 模式（适合常用、工具少的 Server）：连接后将 tools/list 拿到的工具直接注册进 ToolRegistry，模型第一轮就能直接调用 server__tool。
  • Lazy / Gateway 元工具模式（适合工具多的大型 Server）：
  不在 ToolRegistry 里展开几十个工具，而是只由 Gateway 注册 2 个元工具（或在 System Prompt 中列出简短目录）：
      • mcp_list_tools / mcp_describe_tool：按需查看某个 Server 下的工具详情与 inputSchema。
      • mcp_call_tool：传入 { server, tool, arguments } 动态路由调用（并且 Policy 可以直接针对 server__tool 做细粒度 allow / ask / deny 拦截！）。


  ③ 零依赖的传输层实现（Transports）

  为了保持 OpenHarness 近乎零依赖 的优势，MCP 的 JSON-RPC 2.0 协议其实非常薄，不需要引入庞大的 SDK 就能用百来行 TypeScript 实现核心 Client：

  • StdioMcpClient：通过 child_process.spawn 启动本地 MCP Server（按行 JSON-RPC 通信，处理 initialize → notifications/initialized → tools/list → tools/call，并在 Gateway 关闭或进程退出时自动清理子进程）。
  • HttpMcpClient：对接远程 MCP Server（支持标准的 JSON-RPC POST / Streamable HTTP 与 SSE，支持附带自定义 Authorization Headers）。

  ④ 结果与错误的平稳降级（契合 OpenHarness 边界）

  • MCP 的 tools/call 返回的是 content: Array<{ type: 'text' | 'image' | 'resource', ... }> 以及 isError?: boolean。
  • Gateway 负责将其规范化为 OpenHarness 的 ToolResult：
      • 将多个 text 和文本型 resource 块拼接为字符串；
      • 若遇到当前不支持的二进制/图片块，明确标注 [Unsupported MCP content block: image/png]（或按现有契约显式报错），绝不静默丢弃；
      • 将 AbortSignal 透传给底层请求，超时或用户点击 Abort 时向 MCP Server 发送 notifications/cancelled 或终止传输。

  ──────
  3. 跟你的想法对齐一下

  在你构想的 MCP Gateway 里，你更希望它侧重哪种形态？

  1. 客户端聚合网关（In-Process Aggregator）：作为 src/mcp/gateway.ts 内嵌在 OpenHarness 里，通过配置文件（例如 .openharness/mcp.json 或 Web UI 的 MCP 管理页）管理多个上游 stdio / http MCP Server，统一注入给 run()。
  2. 支持 Eager / Lazy 混合加载：支持把高频工具直接暴露给模型，低频/海量工具通过 Gateway 动态发现与调用，防止撑爆 Context。
  3. Web 端可视化管理：在 Web UI 里加一个 MCP Gateway 面板（或放在 Settings 里），能添加/启停 MCP Server、查看已发现的工具列表、并为每个 MCP Server/工具配置 allow / ask / deny 权限策略。

## 4. 实施状态清单 (Implementation Checklist)

- [x] **① 命名空间与防冲突路由（Namespacing）**
  - `<serverName>__<toolName>` 格式化、解析与冲突隔离（`src/gateway/hub.ts`）
  - 支持单 Server 级别的 `allowTools` / `denyTools` 黑白名单过滤
- [x] **② 两种暴露模式：Eager（直接挂载） vs Lazy（按需加载，省 Context）**
  - 支持按 Server 配置 `mode: 'eager' | 'lazy'`
  - Eager 模式直接暴露 `<server>__<tool>` Schema
  - Lazy 模式自动挂载元工具 `mcp_list_tools`、`mcp_describe_tool`、`mcp_call_tool`，按需检索与调用，避免撑爆模型 Context
- [x] **③ 零依赖的传输层实现（Transports）**
  - `StdioUpstream`（`src/upstream/stdio.ts`）：本地子进程拉起、按行 JSON-RPC、超时/Abort 发送 `notifications/cancelled`、退出清理
  - `HttpUpstream`（`src/upstream/http.ts`）：远程 JSON-RPC POST / Streamable-HTTP（支持 `Mcp-Session-Id` 与自定义 Header）
- [x] **④ 结果与错误的平稳降级（契合 OpenHarness 边界）**
  - `normalizeMcpResult`（`src/protocol/jsonrpc.ts`）：拼接 `text` 与文本型 `resource`，显式标注二进制资源与不支持的块类型
- [x] **⑤ 独立 Gateway 服务与 OpenHarness 超薄桥接**
  - `oh-mcp` HTTP 服务（`src/server/http.ts`）：同时提供 `/api/servers`、`/api/tools`、`/api/tools/call` 与标准 MCP `/mcp` 端点
  - `openharness` 客户端桥接（`openharness/src/tools/mcp.ts`）：`McpGatewayClient` 一键将 Gateway 工具接入 `ToolRegistry`，复用 Policy / HITL 审批 / Ajv 校验 / Trace 记录

