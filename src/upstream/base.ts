import type { McpCallToolResult, McpToolDefinition } from '../protocol/jsonrpc.js'

export type UpstreamTransportType = 'stdio' | 'http'

export interface UpstreamStatus {
  readonly name: string
  readonly transport: UpstreamTransportType
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
