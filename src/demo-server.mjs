import { createInterface } from 'node:readline'
import { hostname, platform, release, uptime } from 'node:os'

const rl = createInterface({ input: process.stdin })

const TOOLS = [
  {
    name: 'system_info',
    description: 'Get host OS, architecture, and uptime summary.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'calc',
    description: 'Add or multiply two numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['add', 'mul'], description: 'Operation: add or mul' },
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['op', 'a', 'b'],
      additionalProperties: false,
    },
  },
]

rl.on('line', line => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  if (!('id' in msg) || msg.id === undefined || msg.id === null) return

  if (msg.method === 'initialize') {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'oh-mcp-demo', version: '0.1.0' },
        },
      }) + '\n',
    )
    return
  }

  if (msg.method === 'tools/list') {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: TOOLS },
      }) + '\n',
    )
    return
  }

  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params ?? {}
    if (name === 'system_info') {
      const info = `Host: ${hostname()} (${platform()} ${release()}), Uptime: ${Math.round(uptime())}s`
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: info }] },
        }) + '\n',
      )
      return
    }
    if (name === 'calc') {
      const a = Number(args.a ?? 0)
      const b = Number(args.b ?? 0)
      const val = args.op === 'mul' ? a * b : a + b
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `${a} ${args.op === 'mul' ? '*' : '+'} ${b} = ${val}` }] },
        }) + '\n',
      )
      return
    }
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true },
      }) + '\n',
    )
  }
})
