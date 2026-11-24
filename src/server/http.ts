import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { registerServerFromEntry, type GatewayServerEntry } from '../config.js'
import type { JsonRpcRequest } from '../protocol/jsonrpc.js'
import type { ExposureMode, McpHub, PolicyAction } from '../gateway/hub.js'

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Client',
  })
  res.end(JSON.stringify(payload))
}

export function createGatewayServer(hub: McpHub): Server {
  return createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Client',
      })
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const clientHeader = String(req.headers['x-agent-client'] ?? '')
    const userAgent = String(req.headers['user-agent'] ?? '')

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, servers: hub.listServers() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/control-plane') {
        const [activeTools, catalogTools] = await Promise.all([
          hub.listTools(undefined, undefined),
          hub.listCatalogTools(undefined, true),
        ])
        sendJson(res, 200, {
          startedAt: hub.startedAt,
          servers: hub.listServers(),
          activeTools,
          catalogTools,
          clients: hub.listClients(),
          logs: hub.listLogs(100),
          apiKeys: hub.listApiKeys(),
          policies: hub.getAllToolPolicies(),
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/servers') {
        sendJson(res, 200, { servers: hub.listServers() })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/servers') {
        const body = await readJsonBody<{ name: string; connect?: boolean } & GatewayServerEntry>(req)
        if (!body?.name) {
          sendJson(res, 400, { error: 'Missing server "name"' })
          return
        }
        await hub.removeServer(body.name)
        registerServerFromEntry(hub, body.name, body)
        if (body.connect !== false) {
          await hub.connectServer(body.name)
        } else {
          await hub.disconnectServer(body.name)
        }
        sendJson(res, 200, { servers: hub.listServers() })
        return
      }

      if (url.pathname.startsWith('/api/servers/')) {
        const rest = url.pathname.slice('/api/servers/'.length).split('/')
        const serverName = decodeURIComponent(rest[0] ?? '')
        const action = rest[1]

        if (req.method === 'POST' && action === 'connect') {
          await hub.connectServer(serverName)
          sendJson(res, 200, { servers: hub.listServers() })
          return
        }
        if (req.method === 'POST' && action === 'disconnect') {
          await hub.disconnectServer(serverName)
          sendJson(res, 200, { servers: hub.listServers() })
          return
        }
        if (req.method === 'PATCH' && !action) {
          const patch = await readJsonBody<{
            mode?: ExposureMode
            allowTools?: string[]
            denyTools?: string[]
            toolPolicies?: Record<string, PolicyAction>
          }>(req)
          hub.updateServerOptions(serverName, patch)
          sendJson(res, 200, { servers: hub.listServers() })
          return
        }
        if (req.method === 'DELETE' && !action) {
          const deleted = await hub.removeServer(serverName)
          sendJson(res, 200, { deleted, servers: hub.listServers() })
          return
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/tools') {
        const includeCatalog = url.searchParams.get('all') === 'true'
        const includeDisabled = url.searchParams.get('disabled') === 'true'
        const tools = includeCatalog
          ? await hub.listCatalogTools(undefined, includeDisabled)
          : await hub.listTools()
        sendJson(res, 200, { tools })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/tools/call') {
        const clientName = clientHeader || 'OpenHarness Agent Loop'
        hub.recordClientActivity(clientName, 'rest', userAgent)
        const body = await readJsonBody<{ name?: string; arguments?: Record<string, unknown>; client?: string }>(req)
        if (!body?.name || typeof body.name !== 'string') {
          sendJson(res, 400, { error: 'Missing tool "name"' })
          return
        }
        const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
          ? body.arguments
          : {}
        const result = await hub.callTool(body.name, args, undefined, body.client ?? clientName)
        sendJson(res, 200, result)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/logs') {
        sendJson(res, 200, { logs: hub.listLogs(100) })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/clients') {
        sendJson(res, 200, { clients: hub.listClients() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/keys') {
        sendJson(res, 200, { apiKeys: hub.listApiKeys() })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/keys') {
        const body = await readJsonBody<{ name?: string }>(req)
        const created = hub.createApiKey(body?.name ?? 'Agent Key')
        sendJson(res, 200, { ...created, apiKeys: hub.listApiKeys() })
        return
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/api/keys/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/keys/'.length))
        const deleted = hub.deleteApiKey(id)
        sendJson(res, 200, { deleted, apiKeys: hub.listApiKeys() })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/policies') {
        const body = await readJsonBody<{ tool: string; policy: PolicyAction }>(req)
        if (body?.tool && body?.policy) {
          hub.setToolPolicy(body.tool, body.policy)
        }
        sendJson(res, 200, { policies: hub.getAllToolPolicies() })
        return
      }

      if (req.method === 'POST' && url.pathname === '/mcp') {
        const rpc = await readJsonBody<JsonRpcRequest>(req)
        if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            id: rpc?.id ?? null,
            error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
          })
          return
        }

        if (!('id' in rpc) || rpc.id === undefined) {
          res.writeHead(202)
          res.end()
          return
        }

        if (rpc.method === 'initialize') {
          const clientInfo = (rpc.params as { clientInfo?: { name?: string; version?: string } } | undefined)?.clientInfo
          const cName = clientInfo?.name ? `${clientInfo.name}${clientInfo.version ? `/${clientInfo.version}` : ''}` : (clientHeader || 'MCP JSON-RPC Client')
          hub.recordClientActivity(cName, 'mcp-jsonrpc', userAgent)
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'oh-mcp', version: '0.1.0' },
            },
          })
          return
        }

        if (rpc.method === 'tools/list') {
          hub.recordClientActivity(clientHeader || 'MCP JSON-RPC Client', 'mcp-jsonrpc', userAgent)
          const tools = await hub.listTools()
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              tools: tools.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            },
          })
          return
        }

        if (rpc.method === 'tools/call') {
          const cName = clientHeader || 'MCP JSON-RPC Client'
          hub.recordClientActivity(cName, 'mcp-jsonrpc', userAgent)
          const params = (rpc.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
          if (!params.name || typeof params.name !== 'string') {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id: rpc.id,
              error: { code: -32602, message: 'Missing tool name in tools/call' },
            })
            return
          }
          const rawResult = await hub.callToolRaw(params.name, params.arguments ?? {}, undefined, cName)
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: rawResult,
          })
          return
        }

        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        })
        return
      }

      sendJson(res, 404, { error: 'Not Found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, { error: message })
    }
  })
}
