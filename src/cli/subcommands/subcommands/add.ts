import type { CommandDef } from 'citty'
import type { UserC8yAuth } from '../../../utils/credentials'
import { exit } from 'node:process'
import { cancel, isCancel, password } from '@clack/prompts'
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
        cancel: 'reject',
      })

      // check if tenantUrl is valid
      v.parse(v.pipe(v.string(), v.url()), tenantUrl)

      const user = await consola.prompt('Username:', {
        type: 'text',
        cancel: 'reject',
      })

      const passwordPrompt = await password({
        message: 'Password:',
        clearOnError: true,
        validate: (value) => {
          if (!value) {
            return 'Password is required.'
          }

          return undefined
        },
      })

      if (isCancel(passwordPrompt)) {
        cancel('Cancelled.')
        exit()
      }

      // Check if credentials with same tenant URL already exist
      const existingCreds = await getStoredC8yAuth()
      const exists = existingCreds.some((cred: UserC8yAuth) => cred.tenantUrl === cleanTenantUrl(tenantUrl))

      if (exists) {
        const overwrite = await consola.prompt('Credentials for this tenant already exist. Overwrite?', {
          type: 'confirm',
          cancel: 'reject',
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
        password: passwordPrompt,
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
