import { existsSync, readFileSync } from 'node:fs'
import { McpHub, type UpstreamRegistrationOptions } from './gateway/hub.js'
import type { GatewayStorage } from './storage/sqlite.js'
import { HttpUpstream } from './upstream/http.js'
import { StdioUpstream } from './upstream/stdio.js'

export interface GatewayServerEntry extends UpstreamRegistrationOptions {
  readonly transport?: 'stdio' | 'http'
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface GatewayConfigFile {
  readonly mcpServers: Readonly<Record<string, GatewayServerEntry>>
}

export function registerServerFromEntry(
  hub: McpHub,
  name: string,
  entry: GatewayServerEntry,
  persist = true,
): void {
  const filterOpts: UpstreamRegistrationOptions = {
    ...(entry.mode ? { mode: entry.mode } : {}),
    ...(entry.allowTools ? { allowTools: entry.allowTools } : {}),
    ...(entry.denyTools ? { denyTools: entry.denyTools } : {}),
  }
  if (entry.transport === 'http' || entry.url) {
    if (!entry.url) throw new Error(`MCP server "${name}" requires "url" for http transport`)
    hub.register(
      new HttpUpstream({
        name,
        url: entry.url,
        ...(entry.headers ? { headers: entry.headers } : {}),
      }),
      filterOpts,
      {
        transport: 'http',
        url: entry.url,
        ...(entry.headers ? { headers: entry.headers } : {}),
      },
      persist,
    )
  } else {
    if (!entry.command) throw new Error(`MCP server "${name}" requires "command" for stdio transport`)
    hub.register(
      new StdioUpstream({
        name,
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.env ? { env: entry.env } : {}),
        ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
      }),
      filterOpts,
      {
        transport: 'stdio',
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.env ? { env: entry.env } : {}),
        ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
      },
      persist,
    )
  }
}

export function createHubFromConfig(config: GatewayConfigFile, storage?: GatewayStorage): McpHub {
  const hub = new McpHub(storage)
  if (storage) {
    const persisted = storage.loadServers()
    for (const rec of persisted) {
      hub.setServerEnabledFlag(rec.name, rec.enabled)
      registerServerFromEntry(hub, rec.name, rec.entry, false)
    }
    const existingNames = new Set(persisted.map(r => r.name))
    for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
      if (!existingNames.has(name)) {
        registerServerFromEntry(hub, name, entry, true)
      }
    }
    return hub
  }
  for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
    registerServerFromEntry(hub, name, entry, false)
  }
  return hub
}

export function loadHubFromFile(filePath: string, storage?: GatewayStorage): McpHub {
  if (!existsSync(filePath)) return createHubFromConfig({ mcpServers: {} }, storage)
  const raw = readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(raw) as GatewayConfigFile
  return createHubFromConfig(parsed, storage)
}
