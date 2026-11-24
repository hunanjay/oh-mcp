import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { JsonRpcRequest } from '../protocol/jsonrpc.js'
import type { McpHub } from '../gateway/hub.js'

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * HTTP server exposing:
 * 1. OpenHarness REST endpoints:
 *    - GET  /api/servers
 *    - GET  /api/tools
 *    - POST /api/tools/call
 * 2. Standard MCP Streamable-HTTP JSON-RPC endpoint:
 *    - POST /mcp
 */
export function createGatewayServer(hub: McpHub): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, servers: hub.listServers() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/servers') {
        sendJson(res, 200, { servers: hub.listServers() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/tools') {
        const includeCatalog = url.searchParams.get('all') === 'true'
        const tools = includeCatalog ? await hub.listCatalogTools() : await hub.listTools()
        sendJson(res, 200, { tools })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/tools/call') {
        const body = await readJsonBody<{ name?: string; arguments?: Record<string, unknown> }>(req)
        if (!body?.name || typeof body.name !== 'string') {
          sendJson(res, 400, { error: 'Missing tool "name"' })
          return
        }
        const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
          ? body.arguments
          : {}
        const result = await hub.callTool(body.name, args)
        sendJson(res, 200, result)
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

        // Notifications have no id
        if (!('id' in rpc) || rpc.id === undefined) {
          res.writeHead(202)
          res.end()
          return
        }

        if (rpc.method === 'initialize') {
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
          const params = (rpc.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
          if (!params.name || typeof params.name !== 'string') {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id: rpc.id,
              error: { code: -32602, message: 'Missing tool name in tools/call' },
            })
            return
          }
          const rawResult = await hub.callToolRaw(params.name, params.arguments ?? {})
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
