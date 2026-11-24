import { randomBytes, randomUUID } from 'node:crypto'
import {
  normalizeMcpResult,
  type McpCallToolResult,
  type McpToolDefinition,
  type NormalizedToolResult,
} from '../protocol/jsonrpc.js'
import type { GatewayServerEntry } from '../config.js'
import type { GatewayStorage } from '../storage/sqlite.js'
import type { UpstreamServer, UpstreamStatus } from '../upstream/base.js'

export type ExposureMode = 'eager' | 'lazy'
export type PolicyAction = 'allow' | 'ask' | 'deny'

export interface GatewayToolSchema {
  readonly name: string
  readonly server: string
  readonly originalName: string
  readonly mode: ExposureMode
  readonly enabled: boolean
  readonly policy: PolicyAction
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly callCount: number
  readonly errorCount: number
  readonly avgLatencyMs: number
}

export interface UpstreamRegistrationOptions {
  readonly mode?: ExposureMode
  readonly allowTools?: readonly string[]
  readonly denyTools?: readonly string[]
  readonly toolPolicies?: Readonly<Record<string, PolicyAction>>
}

export interface GatewayServerStatus extends UpstreamStatus {
  readonly mode: ExposureMode
  readonly allowTools?: readonly string[]
  readonly denyTools?: readonly string[]
  readonly config?: Readonly<Record<string, unknown>>
  readonly requestCount: number
  readonly errorCount: number
  readonly avgLatencyMs: number
  readonly lastLatencyMs?: number
}

export interface GatewayCallLog {
  readonly id: string
  readonly timestamp: number
  readonly client: string
  readonly server: string
  readonly tool: string
  readonly namespacedTool: string
  readonly args: Record<string, unknown>
  readonly durationMs: number
  readonly isError: boolean
  readonly preview: string
}

export interface GatewayClientRecord {
  readonly id: string
  readonly name: string
  readonly protocol: 'rest' | 'mcp-jsonrpc'
  readonly userAgent: string
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly requestCount: number
}

export interface GatewayApiKeyRecord {
  readonly id: string
  readonly name: string
  readonly prefix: string
  readonly createdAt: number
  readonly lastUsedAt?: number
}

interface RegisteredUpstream {
  readonly server: UpstreamServer
  options: UpstreamRegistrationOptions
  readonly config?: Readonly<Record<string, unknown>>
  requestCount: number
  errorCount: number
  totalLatencyMs: number
  lastLatencyMs?: number
}

interface ToolStats {
  callCount: number
  errorCount: number
  totalLatencyMs: number
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
    enabled: true,
    policy: 'allow',
    description: 'List or search available MCP tools across servers (especially lazy-loaded servers) without loading full schemas.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Optional server name filter' },
        query: { type: 'string', description: 'Optional case-insensitive keyword filter for tool name or description' },
      },
      additionalProperties: false,
    },
    callCount: 0,
    errorCount: 0,
    avgLatencyMs: 0,
  },
  {
    name: 'mcp_describe_tool',
    server: 'mcp',
    originalName: 'mcp_describe_tool',
    mode: 'eager',
    enabled: true,
    policy: 'allow',
    description: 'Inspect the full JSON inputSchema and description of a specific MCP tool by its namespaced name (<server>__<tool>).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Namespaced tool name, e.g. "github__create_issue"' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    callCount: 0,
    errorCount: 0,
    avgLatencyMs: 0,
  },
  {
    name: 'mcp_call_tool',
    server: 'mcp',
    originalName: 'mcp_call_tool',
    mode: 'eager',
    enabled: true,
    policy: 'ask',
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
    callCount: 0,
    errorCount: 0,
    avgLatencyMs: 0,
  },
]

/**
 * Core MCP Gateway Control Plane Hub:
 * Aggregates upstream MCP servers, isolates namespaces (<server>__<tool>),
 * tracks per-server/per-tool latency & error telemetry, call logs, connected agent clients, and API keys.
 */
export class McpHub {
  private readonly upstreams = new Map<string, RegisteredUpstream>()
  private readonly toolStats = new Map<string, ToolStats>()
  private readonly toolPolicies = new Map<string, PolicyAction>()
  private readonly logs: GatewayCallLog[] = []
  private readonly clients = new Map<string, GatewayClientRecord>()
  private readonly apiKeys = new Map<string, { record: GatewayApiKeyRecord; rawKey: string }>()
  private readonly maxLogs = 300
  readonly startedAt = Date.now()
  private readonly enabledFlags = new Map<string, boolean>()

  constructor(private readonly storage?: GatewayStorage) {
    // Seed a default connected client entry for OpenHarness local control plane
    const now = Date.now()
    this.clients.set('openharness-local', {
      id: 'openharness-local',
      name: 'OpenHarness Agent Loop',
      protocol: 'rest',
      userAgent: 'OpenHarness/0.1.0 (McpGatewayClient)',
      firstSeenAt: now,
      lastSeenAt: now,
      requestCount: 0,
    })

    if (storage) {
      for (const [tool, policy] of Object.entries(storage.loadPolicies())) {
        this.toolPolicies.set(tool, policy)
      }
      for (const key of storage.loadApiKeys()) {
        this.apiKeys.set(key.id, {
          record: {
            id: key.id,
            name: key.name,
            prefix: key.prefix,
            createdAt: key.createdAt,
            ...(key.lastUsedAt !== undefined ? { lastUsedAt: key.lastUsedAt } : {}),
          },
          rawKey: key.rawKey,
        })
      }
      for (const log of storage.loadLogs(this.maxLogs)) {
        this.logs.push(log)
      }
    }
  }

  register(
    server: UpstreamServer,
    options: UpstreamRegistrationOptions = {},
    config?: Readonly<Record<string, unknown>>,
    persist = true,
  ): this {
    if (!/^[a-zA-Z0-9_-]+$/.test(server.name)) {
      throw new Error(`Invalid upstream server name "${server.name}": must match /^[a-zA-Z0-9_-]+$/`)
    }
    if (server.name.includes('__')) {
      throw new Error(`Invalid upstream server name "${server.name}": cannot contain "__"`)
    }
    if (options.toolPolicies) {
      for (const [tName, policy] of Object.entries(options.toolPolicies)) {
        const key = tName.includes('__') ? tName : formatNamespacedTool(server.name, tName)
        this.toolPolicies.set(key, policy)
        this.storage?.setPolicy(key, policy)
      }
    }
    this.upstreams.set(server.name, {
      server,
      options,
      ...(config ? { config } : {}),
      requestCount: 0,
      errorCount: 0,
      totalLatencyMs: 0,
    })
    if (!this.enabledFlags.has(server.name)) {
      this.enabledFlags.set(server.name, true)
    }
    if (persist) {
      this.persistServer(server.name)
    }
    return this
  }

  setServerEnabledFlag(name: string, enabled: boolean): void {
    this.enabledFlags.set(name, enabled)
  }

  isServerEnabled(name: string): boolean {
    return this.enabledFlags.get(name) ?? true
  }

  private persistServer(name: string): void {
    if (!this.storage) return
    const entry = this.upstreams.get(name)
    if (!entry?.config) return
    const cfg = entry.config as GatewayServerEntry
    const merged: GatewayServerEntry = {
      ...cfg,
      mode: entry.options.mode ?? 'eager',
      ...(entry.options.allowTools ? { allowTools: entry.options.allowTools } : {}),
      ...(entry.options.denyTools ? { denyTools: entry.options.denyTools } : {}),
    }
    this.storage.upsertServer({
      name,
      entry: merged,
      enabled: this.isServerEnabled(name),
      updatedAt: Date.now(),
    })
  }

  recordClientActivity(clientName: string, protocol: 'rest' | 'mcp-jsonrpc', userAgent = ''): void {
    const id = clientName.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'anonymous-agent'
    const existing = this.clients.get(id)
    const now = Date.now()
    if (existing) {
      this.clients.set(id, {
        ...existing,
        lastSeenAt: now,
        requestCount: existing.requestCount + 1,
        ...(userAgent ? { userAgent } : {}),
      })
    } else {
      this.clients.set(id, {
        id,
        name: clientName || 'Agent Client',
        protocol,
        userAgent: userAgent || 'MCP Client',
        firstSeenAt: now,
        lastSeenAt: now,
        requestCount: 1,
      })
    }
  }

  listClients(): GatewayClientRecord[] {
    return [...this.clients.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  createApiKey(name: string): { record: GatewayApiKeyRecord; token: string } {
    const id = `key_${randomUUID().slice(0, 8)}`
    const secret = randomBytes(18).toString('hex')
    const token = `ohmcp_${secret}`
    const record: GatewayApiKeyRecord = {
      id,
      name: name.trim() || 'Agent Key',
      prefix: `ohmcp_${secret.slice(0, 6)}...${secret.slice(-4)}`,
      createdAt: Date.now(),
    }
    this.apiKeys.set(id, { record, rawKey: token })
    this.storage?.upsertApiKey({ ...record, rawKey: token })
    return { record, token }
  }

  listApiKeys(): GatewayApiKeyRecord[] {
    return [...this.apiKeys.values()].map(k => k.record).sort((a, b) => b.createdAt - a.createdAt)
  }

  deleteApiKey(id: string): boolean {
    const deleted = this.apiKeys.delete(id)
    if (deleted) this.storage?.deleteApiKey(id)
    return deleted
  }

  listLogs(limit = 100): GatewayCallLog[] {
    return this.logs.slice(0, limit)
  }

  setToolPolicy(namespacedTool: string, policy: PolicyAction): void {
    this.toolPolicies.set(namespacedTool, policy)
    this.storage?.setPolicy(namespacedTool, policy)
  }

  getToolPolicy(namespacedTool: string): PolicyAction {
    return this.toolPolicies.get(namespacedTool) ?? 'allow'
  }

  getAllToolPolicies(): Record<string, PolicyAction> {
    return Object.fromEntries(this.toolPolicies.entries())
  }

  async connectServer(name: string, signal?: AbortSignal): Promise<GatewayServerStatus> {
    const entry = this.upstreams.get(name)
    if (!entry) throw new Error(`MCP server "${name}" is not registered`)
    this.setServerEnabledFlag(name, true)
    this.persistServer(name)
    const started = performance.now()
    try {
      await entry.server.connect(signal)
      entry.lastLatencyMs = Math.max(1, Math.round(performance.now() - started))
    } catch {
      // Status reflects 'failed' with lastError
    }
    return this.getServerStatus(name)!
  }

  async disconnectServer(name: string): Promise<GatewayServerStatus> {
    const entry = this.upstreams.get(name)
    if (!entry) throw new Error(`MCP server "${name}" is not registered`)
    this.setServerEnabledFlag(name, false)
    this.persistServer(name)
    await entry.server.close()
    return this.getServerStatus(name)!
  }

  async removeServer(name: string): Promise<boolean> {
    const entry = this.upstreams.get(name)
    if (!entry) return false
    await entry.server.close()
    this.upstreams.delete(name)
    this.enabledFlags.delete(name)
    this.storage?.deleteServer(name)
    return true
  }

  updateServerOptions(name: string, patch: Partial<UpstreamRegistrationOptions>): GatewayServerStatus {
    const entry = this.upstreams.get(name)
    if (!entry) throw new Error(`MCP server "${name}" is not registered`)
    entry.options = {
      ...entry.options,
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.allowTools !== undefined ? { allowTools: patch.allowTools } : {}),
      ...(patch.denyTools !== undefined ? { denyTools: patch.denyTools } : {}),
    }
    if (patch.toolPolicies) {
      for (const [tool, policy] of Object.entries(patch.toolPolicies)) {
        const key = tool.includes('__') ? tool : formatNamespacedTool(name, tool)
        this.toolPolicies.set(key, policy)
        this.storage?.setPolicy(key, policy)
      }
    }
    this.persistServer(name)
    return this.getServerStatus(name)!
  }

  getServerStatus(name: string): GatewayServerStatus | undefined {
    const entry = this.upstreams.get(name)
    if (!entry) return undefined
    const { server, options, config, requestCount, errorCount, totalLatencyMs, lastLatencyMs } = entry
    const avgLatencyMs = requestCount > 0 ? Math.round(totalLatencyMs / requestCount) : (lastLatencyMs ?? 0)
    return {
      ...server.status(),
      mode: options.mode ?? 'eager',
      ...(options.allowTools ? { allowTools: options.allowTools } : {}),
      ...(options.denyTools ? { denyTools: options.denyTools } : {}),
      ...(config ? { config } : {}),
      requestCount,
      errorCount,
      avgLatencyMs,
      ...(lastLatencyMs !== undefined ? { lastLatencyMs } : {}),
    }
  }

  async connectAll(signal?: AbortSignal): Promise<GatewayServerStatus[]> {
    await Promise.allSettled(
      [...this.upstreams.keys()]
        .filter(name => this.isServerEnabled(name))
        .map(async name => {
          await this.connectServer(name, signal)
        }),
    )
    return this.listServers()
  }

  listServers(): GatewayServerStatus[] {
    return [...this.upstreams.keys()].map(name => this.getServerStatus(name)!)
  }

  /**
   * Return all catalog tools (including disabled tools when `includeDisabled` is true).
   */
  async listCatalogTools(signal?: AbortSignal, includeDisabled = false): Promise<GatewayToolSchema[]> {
    const out: GatewayToolSchema[] = []
    for (const { server, options } of this.upstreams.values()) {
      if (!server.status().connected) continue
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
        const isAllowed = (!allow || allow.has(tool.name)) && (!deny || !deny.has(tool.name))
        if (!isAllowed && !includeDisabled) continue
        const namespaced = formatNamespacedTool(server.name, tool.name)
        const stats = this.toolStats.get(namespaced)
        const callCount = stats?.callCount ?? 0
        const errorCount = stats?.errorCount ?? 0
        const avgLatencyMs = callCount > 0 ? Math.round((stats?.totalLatencyMs ?? 0) / callCount) : 0
        out.push({
          name: namespaced,
          server: server.name,
          originalName: tool.name,
          mode,
          enabled: isAllowed,
          policy: this.getToolPolicy(namespaced),
          description: tool.description ? `[${server.name}] ${tool.description}` : `[${server.name}] ${tool.name}`,
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
          callCount,
          errorCount,
          avgLatencyMs,
        })
      }
    }
    return out
  }

  async listTools(signal?: AbortSignal, includeMetaTools?: boolean): Promise<GatewayToolSchema[]> {
    const catalog = await this.listCatalogTools(signal, false)
    const eager = catalog.filter(t => t.mode === 'eager')
    const hasLazy = includeMetaTools ?? [...this.upstreams.values()].some(u => u.options.mode === 'lazy')
    return hasLazy ? [...eager, ...META_TOOLS] : eager
  }

  async callToolRaw(
    namespacedName: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
    clientName = 'OpenHarness Agent Loop',
  ): Promise<McpCallToolResult> {
    const startedAt = performance.now()

    if (namespacedName === 'mcp_list_tools') {
      const serverFilter = typeof args['server'] === 'string' ? args['server'].trim() : ''
      const query = typeof args['query'] === 'string' ? args['query'].trim().toLowerCase() : ''
      const catalog = await this.listCatalogTools(signal, false)
      const matched = catalog.filter(t => {
        if (serverFilter && t.server !== serverFilter) return false
        if (query && !`${t.name} ${t.description}`.toLowerCase().includes(query)) return false
        return true
      })
      const text = matched.length === 0
        ? 'No matching MCP tools found.'
        : matched.map(t => `- ${t.name} (${t.mode}): ${t.description}`).join('\n')
      this.recordCallLog(clientName, 'mcp', 'mcp_list_tools', namespacedName, args, performance.now() - startedAt, false, text)
      return { content: [{ type: 'text', text }] }
    }

    if (namespacedName === 'mcp_describe_tool') {
      const target = typeof args['name'] === 'string' ? args['name'].trim() : ''
      const catalog = await this.listCatalogTools(signal, false)
      const found = catalog.find(t => t.name === target)
      if (!found) {
        const errText = `MCP tool not found: "${target}"`
        this.recordCallLog(clientName, 'mcp', 'mcp_describe_tool', namespacedName, args, performance.now() - startedAt, true, errText)
        return { content: [{ type: 'text', text: errText }], isError: true }
      }
      const text = JSON.stringify(
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
      )
      this.recordCallLog(clientName, 'mcp', 'mcp_describe_tool', namespacedName, args, performance.now() - startedAt, false, text)
      return { content: [{ type: 'text', text }] }
    }

    if (namespacedName === 'mcp_call_tool') {
      const target = typeof args['name'] === 'string' ? args['name'].trim() : ''
      if (!target || target === 'mcp_call_tool') {
        return { content: [{ type: 'text', text: 'Invalid target tool name for mcp_call_tool' }], isError: true }
      }
      const innerArgs =
        args['arguments'] && typeof args['arguments'] === 'object' && !Array.isArray(args['arguments'])
          ? (args['arguments'] as Record<string, unknown>)
          : {}
      return this.callToolRaw(target, innerArgs, signal, clientName)
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
    if (this.getToolPolicy(namespacedName) === 'deny') {
      const msg = `Tool "${namespacedName}" is denied by gateway policy`
      this.recordCallLog(clientName, parsed.server, parsed.tool, namespacedName, args, performance.now() - startedAt, true, msg)
      return { content: [{ type: 'text', text: msg }], isError: true }
    }
    if (options.allowTools && !options.allowTools.includes(parsed.tool)) {
      const msg = `Tool "${parsed.tool}" is not allowed on server "${parsed.server}"`
      this.recordCallLog(clientName, parsed.server, parsed.tool, namespacedName, args, performance.now() - startedAt, true, msg)
      return { content: [{ type: 'text', text: msg }], isError: true }
    }
    if (options.denyTools && options.denyTools.includes(parsed.tool)) {
      const msg = `Tool "${parsed.tool}" is denied on server "${parsed.server}"`
      this.recordCallLog(clientName, parsed.server, parsed.tool, namespacedName, args, performance.now() - startedAt, true, msg)
      return { content: [{ type: 'text', text: msg }], isError: true }
    }

    try {
      const result = await server.callTool(parsed.tool, args, signal)
      const durationMs = Math.max(1, Math.round(performance.now() - startedAt))
      const isError = Boolean(result.isError)
      this.recordMetrics(entry, namespacedName, durationMs, isError)
      const norm = normalizeMcpResult(result)
      this.recordCallLog(clientName, parsed.server, parsed.tool, namespacedName, args, durationMs, isError, norm.content)
      return result
    } catch (error) {
      const durationMs = Math.max(1, Math.round(performance.now() - startedAt))
      this.recordMetrics(entry, namespacedName, durationMs, true)
      const msg = error instanceof Error ? error.message : String(error)
      const errText = `MCP tool "${namespacedName}" failed: ${msg}`
      this.recordCallLog(clientName, parsed.server, parsed.tool, namespacedName, args, durationMs, true, errText)
      return {
        content: [{ type: 'text', text: errText }],
        isError: true,
      }
    }
  }

  async callTool(
    namespacedName: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
    clientName = 'OpenHarness Agent Loop',
  ): Promise<NormalizedToolResult> {
    const raw = await this.callToolRaw(namespacedName, args, signal, clientName)
    return normalizeMcpResult(raw)
  }

  private recordMetrics(entry: RegisteredUpstream, namespacedTool: string, durationMs: number, isError: boolean): void {
    entry.requestCount++
    if (isError) entry.errorCount++
    entry.totalLatencyMs += durationMs
    entry.lastLatencyMs = durationMs

    const existing = this.toolStats.get(namespacedTool) ?? { callCount: 0, errorCount: 0, totalLatencyMs: 0 }
    existing.callCount++
    if (isError) existing.errorCount++
    existing.totalLatencyMs += durationMs
    this.toolStats.set(namespacedTool, existing)
  }

  private recordCallLog(
    client: string,
    server: string,
    tool: string,
    namespacedTool: string,
    args: Record<string, unknown>,
    durationMs: number,
    isError: boolean,
    output: string,
  ): void {
    const logEntry: GatewayCallLog = {
      id: `req_${randomUUID().slice(0, 8)}`,
      timestamp: Date.now(),
      client,
      server,
      tool,
      namespacedTool,
      args,
      durationMs: Math.max(1, Math.round(durationMs)),
      isError,
      preview: output.length > 240 ? `${output.slice(0, 240)}...` : output,
    }
    this.logs.unshift(logEntry)
    if (this.logs.length > this.maxLogs) {
      this.logs.length = this.maxLogs
    }
    this.storage?.appendLog(logEntry)
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.upstreams.values()].map(({ server }) => server.close()))
  }
}
