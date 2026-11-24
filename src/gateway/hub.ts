import {
  normalizeMcpResult,
  type McpCallToolResult,
  type McpToolDefinition,
  type NormalizedToolResult,
} from '../protocol/jsonrpc.js'
import type { UpstreamServer, UpstreamStatus } from '../upstream/base.js'

export type ExposureMode = 'eager' | 'lazy'

export interface GatewayToolSchema {
  readonly name: string
  readonly server: string
  readonly originalName: string
  readonly mode: ExposureMode
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export interface UpstreamRegistrationOptions {
  /**
   * 'eager' (default): expose every tool directly to the LLM tool list.
   * 'lazy': omit individual schemas from the active LLM tool list; discoverable and invocable via mcp_list_tools / mcp_describe_tool / mcp_call_tool.
   */
  readonly mode?: ExposureMode
  /** Optional allowlist of tool names exposed from this server. */
  readonly allowTools?: readonly string[]
  /** Optional denylist of tool names hidden from this server. */
  readonly denyTools?: readonly string[]
}

export interface GatewayServerStatus extends UpstreamStatus {
  readonly mode: ExposureMode
}

interface RegisteredUpstream {
  readonly server: UpstreamServer
  readonly options: UpstreamRegistrationOptions
}

export function formatNamespacedTool(server: string, tool: string): string {
  return `${server}__${tool}`
}

export function parseNamespacedTool(namespacedName: string): { server: string; tool: string } | undefined {
  const idx = namespacedName.indexOf('__')
  if (idx <= 0 || idx === namespacedName.length - 2) return undefined
  return {
    server: namespacedName.slice(0, idx),
    tool: namespacedName.slice(idx + 2),
  }
}

export const META_TOOLS: readonly GatewayToolSchema[] = [
  {
    name: 'mcp_list_tools',
    server: 'mcp',
    originalName: 'mcp_list_tools',
    mode: 'eager',
    description: 'List or search available MCP tools across servers (especially lazy-loaded servers) without loading full schemas.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Optional server name filter' },
        query: { type: 'string', description: 'Optional case-insensitive keyword filter for tool name or description' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mcp_describe_tool',
    server: 'mcp',
    originalName: 'mcp_describe_tool',
    mode: 'eager',
    description: 'Inspect the full JSON inputSchema and description of a specific MCP tool by its namespaced name (<server>__<tool>).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Namespaced tool name, e.g. "github__create_issue"' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'mcp_call_tool',
    server: 'mcp',
    originalName: 'mcp_call_tool',
    mode: 'eager',
    description: 'Invoke any MCP tool (including lazy-loaded tools) by its namespaced name (<server>__<tool>) and arguments object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Namespaced tool name, e.g. "github__create_issue"' },
        arguments: { type: 'object', description: 'Tool input arguments matching the tool inputSchema' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
]

/**
 * Core MCP Gateway Hub: aggregates multiple upstream MCP servers, isolates namespaces (<server>__<tool>),
 * supports eager/lazy exposure modes, filters tools, and routes tool invocations.
 */
export class McpHub {
  private readonly upstreams = new Map<string, RegisteredUpstream>()

  register(server: UpstreamServer, options: UpstreamRegistrationOptions = {}): this {
    if (!/^[a-zA-Z0-9_-]+$/.test(server.name)) {
      throw new Error(`Invalid upstream server name "${server.name}": must match /^[a-zA-Z0-9_-]+$/`)
    }
    if (server.name.includes('__')) {
      throw new Error(`Invalid upstream server name "${server.name}": cannot contain "__"`)
    }
    this.upstreams.set(server.name, { server, options })
    return this
  }

  async connectAll(signal?: AbortSignal): Promise<GatewayServerStatus[]> {
    await Promise.allSettled(
      [...this.upstreams.values()].map(async ({ server }) => {
        await server.connect(signal)
      }),
    )
    return this.listServers()
  }

  listServers(): GatewayServerStatus[] {
    return [...this.upstreams.values()].map(({ server, options }) => ({
      ...server.status(),
      mode: options.mode ?? 'eager',
    }))
  }

  /**
   * Return all catalog tools (both eager and lazy).
   */
  async listCatalogTools(signal?: AbortSignal): Promise<GatewayToolSchema[]> {
    const out: GatewayToolSchema[] = []
    for (const { server, options } of this.upstreams.values()) {
      let tools: readonly McpToolDefinition[] = []
      try {
        tools = await server.listTools(signal)
      } catch {
        continue
      }
      const allow = options.allowTools ? new Set(options.allowTools) : undefined
      const deny = options.denyTools ? new Set(options.denyTools) : undefined
      const mode: ExposureMode = options.mode ?? 'eager'

      for (const tool of tools) {
        if (allow && !allow.has(tool.name)) continue
        if (deny && deny.has(tool.name)) continue
        out.push({
          name: formatNamespacedTool(server.name, tool.name),
          server: server.name,
          originalName: tool.name,
          mode,
          description: tool.description ? `[${server.name}] ${tool.description}` : `[${server.name}] ${tool.name}`,
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        })
      }
    }
    return out
  }

  /**
   * Return active tools to expose directly to an LLM:
   * - All tools from 'eager' servers
   * - If any 'lazy' server is registered (or `includeMetaTools` is true), appends `mcp_list_tools`, `mcp_describe_tool`, and `mcp_call_tool`.
   */
  async listTools(signal?: AbortSignal, includeMetaTools?: boolean): Promise<GatewayToolSchema[]> {
    const catalog = await this.listCatalogTools(signal)
    const eager = catalog.filter(t => t.mode === 'eager')
    const hasLazy = includeMetaTools ?? [...this.upstreams.values()].some(u => u.options.mode === 'lazy')
    return hasLazy ? [...eager, ...META_TOOLS] : eager
  }

  async callToolRaw(
    namespacedName: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<McpCallToolResult> {
    if (namespacedName === 'mcp_list_tools') {
      const serverFilter = typeof args['server'] === 'string' ? args['server'].trim() : ''
      const query = typeof args['query'] === 'string' ? args['query'].trim().toLowerCase() : ''
      const catalog = await this.listCatalogTools(signal)
      const matched = catalog.filter(t => {
        if (serverFilter && t.server !== serverFilter) return false
        if (query && !`${t.name} ${t.description}`.toLowerCase().includes(query)) return false
        return true
      })
      if (matched.length === 0) {
        return { content: [{ type: 'text', text: 'No matching MCP tools found.' }] }
      }
      const lines = matched.map(t => `- ${t.name} (${t.mode}): ${t.description}`)
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }

    if (namespacedName === 'mcp_describe_tool') {
      const target = typeof args['name'] === 'string' ? args['name'].trim() : ''
      const catalog = await this.listCatalogTools(signal)
      const found = catalog.find(t => t.name === target)
      if (!found) {
        return {
          content: [{ type: 'text', text: `MCP tool not found: "${target}"` }],
          isError: true,
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: found.name,
                server: found.server,
                originalName: found.originalName,
                mode: found.mode,
                description: found.description,
                inputSchema: found.inputSchema,
              },
              null,
              2,
            ),
          },
        ],
      }
    }

    if (namespacedName === 'mcp_call_tool') {
      const target = typeof args['name'] === 'string' ? args['name'].trim() : ''
      if (!target || target === 'mcp_call_tool') {
        return {
          content: [{ type: 'text', text: 'Invalid target tool name for mcp_call_tool' }],
          isError: true,
        }
      }
      const innerArgs =
        args['arguments'] && typeof args['arguments'] === 'object' && !Array.isArray(args['arguments'])
          ? (args['arguments'] as Record<string, unknown>)
          : {}
      return this.callToolRaw(target, innerArgs, signal)
    }

    const parsed = parseNamespacedTool(namespacedName)
    if (!parsed) {
      return {
        content: [{ type: 'text', text: `Invalid MCP tool name "${namespacedName}": expected "<server>__<tool>"` }],
        isError: true,
      }
    }

    const entry = this.upstreams.get(parsed.server)
    if (!entry) {
      return {
        content: [{ type: 'text', text: `Unknown MCP server "${parsed.server}"` }],
        isError: true,
      }
    }

    const { server, options } = entry
    if (options.allowTools && !options.allowTools.includes(parsed.tool)) {
      return {
        content: [{ type: 'text', text: `Tool "${parsed.tool}" is not allowed on server "${parsed.server}"` }],
        isError: true,
      }
    }
    if (options.denyTools && options.denyTools.includes(parsed.tool)) {
      return {
        content: [{ type: 'text', text: `Tool "${parsed.tool}" is denied on server "${parsed.server}"` }],
        isError: true,
      }
    }

    try {
      return await server.callTool(parsed.tool, args, signal)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `MCP tool "${namespacedName}" failed: ${msg}` }],
        isError: true,
      }
    }
  }

  async callTool(
    namespacedName: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<NormalizedToolResult> {
    const raw = await this.callToolRaw(namespacedName, args, signal)
    return normalizeMcpResult(raw)
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.upstreams.values()].map(({ server }) => server.close()))
  }
}
