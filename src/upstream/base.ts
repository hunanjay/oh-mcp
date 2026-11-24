import type { McpCallToolResult, McpToolDefinition } from '../protocol/jsonrpc.js'

export type UpstreamTransportType = 'stdio' | 'http'

/**
 * Three lifecycle states for an upstream MCP server:
 * - 'registered': Configured in gateway, not yet connected or manually disabled.
 * - 'active': Handshake succeeded and tools are live in the gateway routing table.
 * - 'failed': Connection attempt or subprocess execution failed.
 */
export type ServerLifecycleState = 'registered' | 'active' | 'failed'

export interface UpstreamStatus {
  readonly name: string
  readonly transport: UpstreamTransportType
  readonly state: ServerLifecycleState
  readonly connected: boolean
  readonly toolCount: number
  readonly lastError?: string
}

export interface UpstreamServer {
  readonly name: string
  readonly transport: UpstreamTransportType
  connect(signal?: AbortSignal): Promise<void>
  listTools(signal?: AbortSignal): Promise<readonly McpToolDefinition[]>
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallToolResult>
  status(): UpstreamStatus
  close(): Promise<void>
}
