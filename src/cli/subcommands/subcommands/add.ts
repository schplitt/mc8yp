import type { CommandDef } from 'citty'
import type { UserC8yAuth } from '../../../utils/credentials'
import { exit } from 'node:process'
import { cancel, isCancel, password, text } from '@clack/prompts'
import { defineCommand } from 'citty'
import consola from 'consola'
import * as v from 'valibot'
import { cleanTenantUrl, getStoredC8yAuth, requestTfaSession, setStoredC8yAuth, TfaRequiredError } from '../../../utils/credentials'

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
        return
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

      const creds = {
        tenantUrl: cleanTenantUrl(tenantUrl),
        user,
        password: passwordPrompt as string,
      }

      try {
        await setStoredC8yAuth(creds)
        consola.success('Credentials saved successfully!')
        exit()
        return
      } catch (error) {
        if (!(error instanceof TfaRequiredError)) {
          throw error
        }
      }

      // TFA users cannot use Basic auth: exchange password + TFA code for an
      // OAI-Secure token. The password is stored too, so an expired token can
      // later be renewed with just a new code (prompted via MCP elicitation).
      consola.info('Two-factor authentication is enabled for this user.')
      const tfaCode = await text({
        message: 'TFA code from your authenticator app:',
        validate: (value) => /^\s*\d{6,8}\s*$/.test(value ?? '') ? undefined : 'Enter the 6-digit code.',
      })
      if (isCancel(tfaCode)) {
        cancel('Cancelled.')
        exit()
        return
      }

      const tfaSession = await requestTfaSession(creds, tfaCode as string)
      await setStoredC8yAuth({ ...creds, tfaSession })
      consola.success(`Credentials saved successfully! TFA session valid until ${new Date(tfaSession.expiresAt).toLocaleString()}.`)
      exit()
    } catch (error) {
      consola.error(`Failed to add credentials: ${error instanceof Error ? error.message : String(error)}`)
      exit()
    }
  },
})

export default command
