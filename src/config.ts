import { existsSync, readFileSync } from 'node:fs'
import { McpHub, type UpstreamRegistrationOptions } from './gateway/hub.js'
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

export function createHubFromConfig(config: GatewayConfigFile): McpHub {
  const hub = new McpHub()
  for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
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
      )
    }
  }
  return hub
}

export function loadHubFromFile(filePath: string): McpHub {
  if (!existsSync(filePath)) return new McpHub()
  const raw = readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(raw) as GatewayConfigFile
  return createHubFromConfig(parsed)
}
