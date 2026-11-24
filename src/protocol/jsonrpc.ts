export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number | string
  readonly method: string
  readonly params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: Record<string, unknown>
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly id: number | string
  readonly result: unknown
}

export interface JsonRpcError {
  readonly jsonrpc: '2.0'
  readonly id: number | string | null
  readonly error: {
    readonly code: number
    readonly message: string
    readonly data?: unknown
  }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError

export interface McpToolDefinition {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
}

export type McpContentItem =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'resource'; readonly resource: { readonly uri: string; readonly text?: string; readonly mimeType?: string } }
  | { readonly type: string; readonly [key: string]: unknown }

export interface McpCallToolResult {
  readonly content: readonly McpContentItem[]
  readonly isError?: boolean
}

export interface NormalizedToolResult {
  readonly content: string
  readonly isError?: boolean
}

/**
 * Normalize MCP content blocks into OpenHarness text tool result format.
 * Explicitly labels non-text blocks instead of silently dropping them.
 */
export function normalizeMcpResult(raw: McpCallToolResult): NormalizedToolResult {
  const parts: string[] = []
  for (const item of raw.content ?? []) {
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    } else if (item.type === 'resource' && item.resource && typeof item.resource === 'object') {
      const res = item.resource as { uri?: string; text?: string; mimeType?: string }
      if (typeof res.text === 'string') {
        parts.push(res.text)
      } else {
        parts.push(`[MCP binary resource: ${res.uri ?? 'unknown'} (${res.mimeType ?? 'unknown'})]`)
      }
    } else {
      parts.push(`[Unsupported MCP content block: ${item.type}]`)
    }
  }
  return {
    content: parts.join('\n'),
    ...(raw.isError ? { isError: true } : {}),
  }
}
