import type { CommandDef } from 'citty'
import { exit } from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'
import { getStoredC8yAuth } from '../../../utils/credentials'

const command: CommandDef = defineCommand({
  meta: {
    name: 'list',
    description: 'List stored Cumulocity credentials',
  },
  run: async () => {
    try {
      const creds = await getStoredC8yAuth()

      if (!creds || creds.length === 0) {
        consola.info('No credentials stored.')
        exit()
      }

      consola.box('Stored credentials')
      for (const c of creds) {
        consola.log(`${c.tenantUrl} — ${c.user}`)
      }
      exit()
    } catch (err) {
      consola.error('Failed to list credentials:', err)
      exit(1)
    }
  },
})

export default command
