import { describe, expect, it } from 'vitest'
import {
  HttpUpstream,
  McpHub,
  SqliteGatewayStorage,
  StdioUpstream,
  createHubFromConfig,
  normalizeMcpResult,
  registerServerFromEntry,
} from '../src/index.js'

const MOCK_STDIO_SERVER_SCRIPT = `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (!('id' in msg)) return;
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-stdio', version: '1.0.0' } }
    }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo text back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
          },
          {
            name: 'secret_tool',
            description: 'Hidden tool',
            inputSchema: { type: 'object', properties: {} }
          }
        ]
      }
    }) + '\\n');
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    if (name === 'echo') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: 'stdio:' + (args?.text ?? '') }] }
      }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: 'unknown tool' }], isError: true }
      }) + '\\n');
    }
  }
});
`

describe('oh-mcp McpHub & Upstreams', () => {
  it('aggregates stdio and http upstreams, enforces tool filters, and routes calls by namespace', async () => {
    const stdioServer = new StdioUpstream({
      name: 'local',
      command: process.execPath,
      args: ['--input-type=module', '-e', MOCK_STDIO_SERVER_SCRIPT],
    })

    const mockFetch: typeof fetch = async (_input, init) => {
      const rpc = JSON.parse(String(init?.body ?? '{}')) as { id: number; method: string; params?: Record<string, unknown> }
      if (rpc.method === 'initialize') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'remote', version: '1.0' } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', 'mcp-session-id': 'sess-1' } },
        )
      }
      if (rpc.method === 'tools/list') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              tools: [
                {
                  name: 'search',
                  description: 'Search remote docs',
                  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (rpc.method === 'tools/call') {
        const params = rpc.params as { name: string; arguments: { q?: string } }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { content: [{ type: 'text', text: `http:${params.arguments.q ?? ''}` }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('Not found', { status: 404 })
    }

    const httpServer = new HttpUpstream({
      name: 'docs',
      url: 'https://mcp.example.test/mcp',
      fetchImpl: mockFetch,
    })

    const hub = new McpHub()
      .register(stdioServer, { denyTools: ['secret_tool'] })
      .register(httpServer)

    try {
      // Initially in 'registered' state before connect
      expect(hub.listServers().map(s => s.state)).toEqual(['registered', 'registered'])

      const statuses = await hub.connectAll()
      expect(statuses).toMatchObject([
        { name: 'local', transport: 'stdio', state: 'active', connected: true, toolCount: 2, mode: 'eager', denyTools: ['secret_tool'] },
        { name: 'docs', transport: 'http', state: 'active', connected: true, toolCount: 1, mode: 'eager' },
      ])

      const tools = await hub.listTools()
      expect(tools.map(t => t.name)).toEqual(['local__echo', 'docs__search'])

      expect(await hub.callTool('local__echo', { text: 'hello' })).toEqual({
        content: 'stdio:hello',
      })
      expect(await hub.callTool('docs__search', { q: 'openharness' })).toEqual({
        content: 'http:openharness',
      })

      // Denied tool cannot be called even directly
      expect(await hub.callTool('local__secret_tool', {})).toEqual({
        content: 'Tool "secret_tool" is denied on server "local"',
        isError: true,
      })

      // Invalid namespace or server returns structured error
      expect(await hub.callTool('invalid_name', {})).toMatchObject({ isError: true })
      expect(await hub.callTool('missing__tool', {})).toMatchObject({ isError: true })
    } finally {
      await hub.closeAll()
    }
  })

  it('normalizes text, resource, and unsupported MCP content blocks', () => {
    expect(
      normalizeMcpResult({
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'resource text' } },
          { type: 'resource', resource: { uri: 'file:///img.png', mimeType: 'image/png' } },
          { type: 'image', data: 'base64...' },
        ],
        isError: true,
      }),
    ).toEqual({
      content: 'line 1\nresource text\n[MCP binary resource: file:///img.png (image/png)]\n[Unsupported MCP content block: image]',
      isError: true,
    })
  })

  it('builds a hub from declarative config and tracks registered -> active / failed / disconnected states', async () => {
    const hub = createHubFromConfig({
      mcpServers: {
        remote_api: { url: 'https://example.test/mcp', allowTools: ['ping'], mode: 'lazy' },
        broken_stdio: { command: '/nonexistent/binary/for/oh-mcp-test' },
      },
    })
    expect(hub.listServers()).toMatchObject([
      {
        name: 'remote_api',
        transport: 'http',
        state: 'registered',
        connected: false,
        toolCount: 0,
        mode: 'lazy',
        allowTools: ['ping'],
        config: { transport: 'http', url: 'https://example.test/mcp' },
      },
      {
        name: 'broken_stdio',
        transport: 'stdio',
        state: 'registered',
        connected: false,
        toolCount: 0,
        mode: 'eager',
        config: { transport: 'stdio', command: '/nonexistent/binary/for/oh-mcp-test' },
      },
    ])

    const failedStatus = await hub.connectServer('broken_stdio')
    expect(failedStatus.state).toBe('failed')
    expect(failedStatus.lastError).toBeTruthy()

    // Disconnecting resets state back to 'registered'
    const resetStatus = await hub.disconnectServer('broken_stdio')
    expect(resetStatus.state).toBe('registered')
  })

  it('supports lazy exposure mode via mcp_list_tools, mcp_describe_tool, and mcp_call_tool', async () => {
    const stdioServer = new StdioUpstream({
      name: 'heavy',
      command: process.execPath,
      args: ['--input-type=module', '-e', MOCK_STDIO_SERVER_SCRIPT],
    })
    const hub = new McpHub().register(stdioServer, { mode: 'lazy', denyTools: ['secret_tool'] })
    try {
      await hub.connectAll()
      // Active tools list only contains the 3 meta-tools, saving context window
      const activeTools = await hub.listTools()
      expect(activeTools.map(t => t.name)).toEqual(['mcp_list_tools', 'mcp_describe_tool', 'mcp_call_tool'])

      // 1. Discover via mcp_list_tools
      const listRes = await hub.callTool('mcp_list_tools', { query: 'echo' })
      expect(listRes.content).toContain('heavy__echo (lazy): [heavy] Echo text back')

      // 2. Inspect schema via mcp_describe_tool
      const descRes = await hub.callTool('mcp_describe_tool', { name: 'heavy__echo' })
      expect(JSON.parse(descRes.content)).toMatchObject({
        name: 'heavy__echo',
        server: 'heavy',
        originalName: 'echo',
        mode: 'lazy',
      })

      // 3. Call lazy tool via mcp_call_tool
      const callRes = await hub.callTool('mcp_call_tool', {
        name: 'heavy__echo',
        arguments: { text: 'via-meta-tool' },
      })
      expect(callRes).toEqual({ content: 'stdio:via-meta-tool' })
    } finally {
      await hub.closeAll()
    }
  })

  it('persists servers, policies, api keys, and call logs in SqliteGatewayStorage across restarts', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'oh-mcp-sqlite-'))
    const dbPath = join(dir, 'gateway.db')

    try {
      const storage1 = new SqliteGatewayStorage(dbPath)
      const hub1 = createHubFromConfig({ mcpServers: {} }, storage1)
      registerServerFromEntry(hub1, 'mem_http', { url: 'https://example.test/mcp', mode: 'lazy' })
      hub1.setToolPolicy('mem_http__ping', 'deny')
      const { record } = hub1.createApiKey('CI Agent')
      await hub1.disconnectServer('mem_http')
      await hub1.closeAll()
      storage1.close()

      const storage2 = new SqliteGatewayStorage(dbPath)
      const hub2 = createHubFromConfig({ mcpServers: {} }, storage2)
      expect(hub2.listServers()).toMatchObject([
        { name: 'mem_http', transport: 'http', mode: 'lazy', state: 'registered' },
      ])
      expect(hub2.isServerEnabled('mem_http')).toBe(false)
      expect(hub2.getToolPolicy('mem_http__ping')).toBe('deny')
      expect(hub2.listApiKeys().map(k => k.id)).toEqual([record.id])
      await hub2.closeAll()
      storage2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caches tools/list responses, drains stdio stderr, supports SSE Streamable HTTP, and enforces API keys & origin safety', async () => {
    let httpToolsListCalls = 0
    const sseHttpServer = new HttpUpstream({
      name: 'sse_remote',
      url: 'https://mcp.example.test/sse',
      fetchImpl: async (_input, init) => {
        const rpc = JSON.parse(String(init?.body ?? '{}')) as { id: number; method: string }
        if (rpc.method === 'initialize') {
          return new Response(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'sse', version: '1.0' } },
            })}\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          )
        }
        if (rpc.method === 'tools/list') {
          httpToolsListCalls++
          return new Response(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: { tools: [{ name: 'ping', description: 'Ping via SSE', inputSchema: { type: 'object', properties: {} } }] },
            })}\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          )
        }
        return new Response('Not Found', { status: 404 })
      },
    })

    const noisyStderrScript = `
      for (let i = 0; i < 100; i++) {
        process.stderr.write('log-line-' + i + ':' + 'x'.repeat(800) + '\\n');
      }
      process.stderr.write('fatal: custom stderr reason\\n', () => process.exit(1));
    `
    const failingStdio = new StdioUpstream({
      name: 'noisy',
      command: process.execPath,
      args: ['--input-type=module', '-e', noisyStderrScript],
    })

    const hub = new McpHub().register(sseHttpServer).register(failingStdio)
    try {
      await hub.connectServer('sse_remote')
      expect(httpToolsListCalls).toBe(1)

      // Subsequent listTools calls reuse cachedTools without extra RPC roundtrips
      await hub.listTools()
      await hub.listCatalogTools()
      expect(httpToolsListCalls).toBe(1)

      const failed = await hub.connectServer('noisy')
      expect(failed.state).toBe('failed')
      expect(failed.lastError).toContain('fatal: custom stderr reason')

      // API key verification: open when no keys exist, enforced once created
      expect(hub.verifyApiKey(undefined)).toBe(true)
      const { token } = hub.createApiKey('Test Runner')
      expect(hub.verifyApiKey(undefined)).toBe(false)
      expect(hub.verifyApiKey('Bearer wrong_token')).toBe(false)
      expect(hub.verifyApiKey(`Bearer ${token}`)).toBe(true)
      expect(hub.listApiKeys()[0]?.lastUsedAt).toEqual(expect.any(Number))
    } finally {
      await hub.closeAll()
    }
  })
})
