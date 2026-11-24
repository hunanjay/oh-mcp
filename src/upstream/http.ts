import type {
  JsonRpcError,
  JsonRpcSuccess,
  McpCallToolResult,
  McpToolDefinition,
} from '../protocol/jsonrpc.js'
import type { UpstreamServer, UpstreamStatus } from './base.js'

export interface HttpUpstreamConfig {
  readonly name: string
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly fetchImpl?: typeof fetch
}

/**
 * Remote HTTP / Streamable-HTTP JSON-RPC 2.0 MCP client.
 */
export class HttpUpstream implements UpstreamServer {
  readonly name: string
  readonly transport = 'http' as const
  private readonly fetchImpl: typeof fetch
  private nextId = 1
  private sessionId: string | undefined
  private cachedTools: readonly McpToolDefinition[] = []
  private connected = false
  private lastError: string | undefined

  constructor(private readonly config: HttpUpstreamConfig) {
    this.name = config.name
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async connect(signal?: AbortSignal): Promise<void> {
    try {
      await this.request(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'oh-mcp', version: '0.1.0' },
        },
        signal,
      )
      this.connected = true
      this.lastError = undefined
      await this.listTools(signal)
    } catch (error) {
      this.connected = false
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async listTools(signal?: AbortSignal): Promise<readonly McpToolDefinition[]> {
    if (!this.connected) await this.connect(signal)
    const res = (await this.request('tools/list', {}, signal)) as { tools?: McpToolDefinition[] }
    this.cachedTools = res.tools ?? []
    return this.cachedTools
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallToolResult> {
    if (!this.connected) await this.connect(signal)
    const res = (await this.request('tools/call', { name, arguments: args }, signal)) as McpCallToolResult
    return {
      content: Array.isArray(res?.content) ? res.content : [],
      ...(res?.isError ? { isError: true } : {}),
    }
  }

  status(): UpstreamStatus {
    const state = this.connected ? 'active' : this.lastError ? 'failed' : 'registered'
    return {
      name: this.name,
      transport: this.transport,
      state,
      connected: this.connected,
      toolCount: this.cachedTools.length,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  async close(): Promise<void> {
    this.connected = false
    this.lastError = undefined
    this.sessionId = undefined
  }

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...this.config.headers,
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
    }

    const res = await this.fetchImpl(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      ...(signal ? { signal } : {}),
    })

    const headerSession = res.headers.get('mcp-session-id')
    if (headerSession) this.sessionId = headerSession

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP MCP server "${this.name}" error (${res.status}): ${text || res.statusText}`)
    }

    const data = (await res.json()) as JsonRpcSuccess | JsonRpcError
    if ('error' in data) {
      throw new Error(`MCP error (${data.error.code}): ${data.error.message}`)
    }
    return data.result
  }
}
