import { StdioTransport } from '@tmcp/transport-stdio'
import { defineCommand, runMain } from 'citty'
import consola from 'consola'
import pkgjson from '../../package.json' with { type: 'json' }
import { createC8YMcpServer } from '../server'
import { getCredentialsByTenantUrl, getStoredC8yAuth } from '../utils/credentials'

const main = defineCommand({
  meta: {
    name: `${pkgjson.name}-cli`,
    version: pkgjson.version,
    description: pkgjson.description,
  },
  setup: () => {
    globalThis.executionEnvironment = 'cli'
    // Expose credential functions globally for subcommands and tools to use
    globalThis._getCredentialsByTenantUrl = getCredentialsByTenantUrl
    globalThis._getStoredC8yAuth = getStoredC8yAuth
  },
  subCommands: {
    creds: () => import('./subcommands/creds').then((m) => m.default),
  },
  run: async () => {
    const server = createC8YMcpServer()

    // Start the server with stdio transport
    const transport = new StdioTransport(server)
    consola.info('Starting MCP server over stdio transport...')
    transport.listen()
  },
})

runMain(main)
