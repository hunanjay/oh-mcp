import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type {
  JsonRpcError,
  JsonRpcMessage,
  JsonRpcSuccess,
  McpCallToolResult,
  McpToolDefinition,
} from '../protocol/jsonrpc.js'
import type { UpstreamServer, UpstreamStatus } from './base.js'

export interface StdioUpstreamConfig {
  readonly name: string
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Local subprocess MCP client communicating via newline-delimited JSON-RPC 2.0 over stdio.
 */
export class StdioUpstream implements UpstreamServer {
  readonly name: string
  readonly transport = 'stdio' as const
  private child: ChildProcess | undefined
  private rl: Interface | undefined
  private nextId = 1
  private readonly pending = new Map<number | string, PendingRequest>()
  private cachedTools: readonly McpToolDefinition[] = []
  private connected = false
  private lastError: string | undefined
  private readonly timeoutMs: number

  constructor(private readonly config: StdioUpstreamConfig) {
    this.name = config.name
    this.timeoutMs = config.timeoutMs ?? 30_000
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.connected && this.child && !this.child.killed) return
    await this.close()

    try {
      const child = spawn(this.config.command, [...(this.config.args ?? [])], {
        cwd: this.config.cwd ?? process.cwd(),
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child

      child.on('exit', (code, sig) => {
        this.connected = false
        const err = new Error(`Stdio MCP server "${this.name}" exited (code=${code}, signal=${sig})`)
        this.lastError = err.message
        this.failAllPending(err)
      })

      child.on('error', err => {
        this.connected = false
        this.lastError = err.message
        this.failAllPending(err)
      })

      const rl = createInterface({ input: child.stdout! })
      this.rl = rl
      rl.on('line', line => this.handleLine(line))

      await this.request(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'oh-mcp', version: '0.1.0' },
        },
        signal,
      )
      this.notify('notifications/initialized', {})
      this.connected = true
      this.lastError = undefined
      await this.listTools(signal)
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      await this.close()
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
    return {
      name: this.name,
      transport: this.transport,
      connected: this.connected,
      toolCount: this.cachedTools.length,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  async close(): Promise<void> {
    this.connected = false
    this.rl?.close()
    this.rl = undefined
    this.failAllPending(new Error(`Stdio MCP server "${this.name}" closed`))
    const child = this.child
    this.child = undefined
    if (child && !child.killed) {
      child.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          resolve()
        }, 500)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) return
    const payload = JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
    this.child.stdin.write(`${payload}\n`)
  }

  private request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error(`Stdio MCP server "${this.name}" is not writable`))
    }

    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        this.notify('notifications/cancelled', { requestId: id, reason: 'Client aborted request' })
        reject(signal?.reason instanceof Error ? signal.reason : new Error('MCP request aborted'))
      }

      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        this.notify('notifications/cancelled', { requestId: id, reason: 'Request timed out' })
        reject(new Error(`MCP request "${method}" on "${this.name}" timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)

      signal?.addEventListener('abort', onAbort, { once: true })

      this.pending.set(id, {
        resolve: val => {
          signal?.removeEventListener('abort', onAbort)
          resolve(val)
        },
        reject: err => {
          signal?.removeEventListener('abort', onAbort)
          reject(err)
        },
        timer,
      })

      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      this.child!.stdin!.write(`${payload}\n`)
    })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage
    } catch {
      return
    }
    if (!('id' in msg) || msg.id === null || msg.id === undefined) return
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)

    if ('error' in msg) {
      const errMsg = (msg as JsonRpcError).error
      entry.reject(new Error(`MCP error (${errMsg.code}): ${errMsg.message}`))
    } else {
      entry.resolve((msg as JsonRpcSuccess).result)
    }
  }

  private failAllPending(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }
}
