import type { CommandDef } from 'citty'
import { defineCommand, runCommand } from 'citty'

const command: CommandDef = defineCommand({
  meta: {
    name: 'creds',
    description: 'Manage your Cumulocity credentials',
  },
  subCommands: {
    add: () => import('./subcommands/add').then((m) => m.default),
    remove: () => import('./subcommands/remove').then((m) => m.default),
    list: () => import('./subcommands/list').then((m) => m.default),
  },
  run: async ({ rawArgs }) => {
    const command = await import('./subcommands/add').then((m) => m.default)
    await runCommand(command, {
      rawArgs,
    })
  },
})

export default command
