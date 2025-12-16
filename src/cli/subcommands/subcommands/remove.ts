import type { CommandDef } from 'citty'
import { exit } from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'
import { deleteStoredC8yAuth, getStoredC8yAuth } from '../../../utils/credentials'

const command: CommandDef = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove stored Cumulocity credentials',
  },
  run: async () => {
    try {
      const creds = await getStoredC8yAuth()

      if (!creds || creds.length === 0) {
        consola.info('No credentials stored.')
        exit()
      }

      const options = creds.map((c) => ({ value: c.tenantUrl, label: `${c.tenantUrl} — ${c.user}` }))

      const selected = await consola.prompt('Select credentials to remove:', {
        type: 'multiselect',
        options,
      })

      if (!selected || (Array.isArray(selected) && selected.length === 0)) {
        consola.info('Cancelled.')
        exit()
      }

      const selections = Array.isArray(selected) ? selected : [selected]
      let removed = 0
      for (const sel of selections) {
        const tenantUrl = typeof sel === 'string' ? sel : sel.value
        const ok = await deleteStoredC8yAuth(tenantUrl)
        if (ok) {
          removed++
        } else {
          consola.warn(`Failed to remove credentials for: ${tenantUrl}`)
        }
      }

      if (removed === 0) {
        consola.info('No credentials were removed.')
      } else {
        consola.success(`Removed ${removed} credential(s).`)
      }

      exit()
    } catch (error) {
      consola.error('Failed to remove credentials:', error)
      exit(1)
    }
  },
})

export default command
