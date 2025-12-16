import type { CommandDef } from 'citty'
import type { C8yAuth } from '../../../utils/credentials'
import { exit } from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'
import * as v from 'valibot'
import { cleanTenantUrl, getStoredC8yAuth, setStoredC8yAuth } from '../../../utils/credentials'

const command: CommandDef = defineCommand({
  meta: {
    name: 'add',
    description: 'Add new Cumulocity credentials',
  },
  run: async () => {
    try {
      const tenantUrl = await consola.prompt('Cumulocity tenant URL:', {
        type: 'text',
      })

      if (!tenantUrl) {
        consola.info('Cancelled.')
        exit()
      }

      // check if tenantUrl is valid
      const res = v.safeParse(v.pipe(v.string(), v.url()), tenantUrl)
      if (!res.success) {
        consola.error('Invalid tenant URL format.')
        exit(1)
      }

      const user = await consola.prompt('Username:', {
        type: 'text',
      })

      if (!user) {
        consola.info('Cancelled.')
        exit()
      }

      const password = await consola.prompt('Password:', {
        type: 'text',
      })

      if (!password) {
        consola.info('Cancelled.')
        exit()
      }

      // Check if credentials with same tenant URL already exist
      const existingCreds = await getStoredC8yAuth()
      const exists = existingCreds.some((cred: C8yAuth) => cred.tenantUrl === cleanTenantUrl(tenantUrl))

      if (exists) {
        const overwrite = await consola.prompt('Credentials for this tenant already exist. Overwrite?', {
          type: 'confirm',
        })

        if (!overwrite) {
          consola.info('Cancelled.')
          exit()
        }
      }

      // Store the credentials
      await setStoredC8yAuth({
        tenantUrl,
        user,
        password,
      })

      consola.success('Credentials saved successfully!')
      exit()
    } catch (error) {
      consola.error('Failed to add credentials:', error)
      exit()
    }
  },
})

export default command
