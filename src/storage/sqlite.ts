import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { GatewayApiKeyRecord, GatewayCallLog, PolicyAction } from '../gateway/hub.js'
import type { GatewayServerEntry } from '../config.js'

export interface PersistedServerRecord {
  readonly name: string
  readonly entry: GatewayServerEntry
  readonly enabled: boolean
  readonly updatedAt: number
}

export interface PersistedApiKeyRecord extends GatewayApiKeyRecord {
  readonly rawKey: string
}

export interface GatewayStorage {
  loadServers(): PersistedServerRecord[]
  upsertServer(record: PersistedServerRecord): void
  deleteServer(name: string): void

  loadPolicies(): Record<string, PolicyAction>
  setPolicy(tool: string, policy: PolicyAction): void

  loadApiKeys(): PersistedApiKeyRecord[]
  upsertApiKey(record: PersistedApiKeyRecord): void
  deleteApiKey(id: string): void

  loadLogs(limit?: number): GatewayCallLog[]
  appendLog(log: GatewayCallLog): void

  close(): void
}

/**
 * SQLite-backed persistence for oh-mcp Control Plane (servers, policies, API keys, call logs).
 */
export class SqliteGatewayStorage implements GatewayStorage {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true })
      closeSync(openSync(dbPath, 'a', 0o600))
    }
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS servers (
        name TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_policies (
        tool TEXT PRIMARY KEY,
        policy TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        raw_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS call_logs (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        client TEXT NOT NULL,
        server TEXT NOT NULL,
        tool TEXT NOT NULL,
        namespaced_tool TEXT NOT NULL,
        args_json TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        is_error INTEGER NOT NULL,
        preview TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_call_logs_ts ON call_logs(timestamp DESC);
    `)
  }

  loadServers(): PersistedServerRecord[] {
    const rows = this.db
      .prepare('SELECT name, config_json, enabled, updated_at FROM servers ORDER BY updated_at ASC')
      .all() as Array<{ name: string; config_json: string; enabled: number; updated_at: number }>
    return rows.map(r => ({
      name: r.name,
      entry: JSON.parse(r.config_json) as GatewayServerEntry,
      enabled: Boolean(r.enabled),
      updatedAt: r.updated_at,
    }))
  }

  upsertServer(record: PersistedServerRecord): void {
    this.db
      .prepare(
        `INSERT INTO servers (name, config_json, enabled, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           config_json = excluded.config_json,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(record.name, JSON.stringify(record.entry), record.enabled ? 1 : 0, record.updatedAt)
  }

  deleteServer(name: string): void {
    this.db.prepare('DELETE FROM servers WHERE name = ?').run(name)
  }

  loadPolicies(): Record<string, PolicyAction> {
    const rows = this.db.prepare('SELECT tool, policy FROM tool_policies').all() as Array<{
      tool: string
      policy: PolicyAction
    }>
    const out: Record<string, PolicyAction> = {}
    for (const r of rows) out[r.tool] = r.policy
    return out
  }

  setPolicy(tool: string, policy: PolicyAction): void {
    this.db
      .prepare(
        `INSERT INTO tool_policies (tool, policy) VALUES (?, ?)
         ON CONFLICT(tool) DO UPDATE SET policy = excluded.policy`,
      )
      .run(tool, policy)
  }

  loadApiKeys(): PersistedApiKeyRecord[] {
    const rows = this.db
      .prepare('SELECT id, name, prefix, raw_key, created_at, last_used_at FROM api_keys ORDER BY created_at DESC')
      .all() as Array<{
      id: string
      name: string
      prefix: string
      raw_key: string
      created_at: number
      last_used_at: number | null
    }>
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      rawKey: r.raw_key,
      createdAt: r.created_at,
      ...(r.last_used_at !== null ? { lastUsedAt: r.last_used_at } : {}),
    }))
  }

  upsertApiKey(record: PersistedApiKeyRecord): void {
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, prefix, raw_key, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           last_used_at = excluded.last_used_at`,
      )
      .run(record.id, record.name, record.prefix, record.rawKey, record.createdAt, record.lastUsedAt ?? null)
  }

  deleteApiKey(id: string): void {
    this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id)
  }

  loadLogs(limit = 300): GatewayCallLog[] {
    const rows = this.db
      .prepare(
        'SELECT id, timestamp, client, server, tool, namespaced_tool, args_json, duration_ms, is_error, preview FROM call_logs ORDER BY timestamp DESC LIMIT ?',
      )
      .all(limit) as Array<{
      id: string
      timestamp: number
      client: string
      server: string
      tool: string
      namespaced_tool: string
      args_json: string
      duration_ms: number
      is_error: number
      preview: string
    }>
    return rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      client: r.client,
      server: r.server,
      tool: r.tool,
      namespacedTool: r.namespaced_tool,
      args: JSON.parse(r.args_json) as Record<string, unknown>,
      durationMs: r.duration_ms,
      isError: Boolean(r.is_error),
      preview: r.preview,
    }))
  }

  appendLog(log: GatewayCallLog): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO call_logs (id, timestamp, client, server, tool, namespaced_tool, args_json, duration_ms, is_error, preview)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        log.id,
        log.timestamp,
        log.client,
        log.server,
        log.tool,
        log.namespacedTool,
        JSON.stringify(log.args),
        log.durationMs,
        log.isError ? 1 : 0,
        log.preview,
      )
  }

  close(): void {
    this.db.close()
  }
}
