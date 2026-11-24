import { resolve } from 'node:path'
import { loadHubFromFile } from '../config.js'
import { SqliteGatewayStorage } from '../storage/sqlite.js'
import { createGatewayServer } from './http.js'

const port = Number(process.env['PORT'] ?? 4090)
const configPath = resolve(process.env['MCP_CONFIG'] ?? 'mcp.json')
const dbPath = resolve(process.env['MCP_DB'] ?? '.oh-mcp/gateway.db')

const storage = new SqliteGatewayStorage(dbPath)
const hub = loadHubFromFile(configPath, storage)
await hub.connectAll()

const server = createGatewayServer(hub)
server.listen(port, '127.0.0.1', () => {
  console.log(`oh-mcp gateway listening on http://127.0.0.1:${port}`)
  console.log(`- REST tools API: http://127.0.0.1:${port}/api/tools`)
  console.log(`- Standard MCP:   http://127.0.0.1:${port}/mcp`)
  console.log(`- SQLite DB:      ${dbPath}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    server.close()
    await hub.closeAll()
    storage.close()
    process.exit(0)
  })
}
