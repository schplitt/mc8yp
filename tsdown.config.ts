import { defineConfig } from 'tsdown'

export default defineConfig(
  [
    {
      name: 'mc8yp-server-build',
      entry: { server: './src/index.ts' },
      treeshake: true,
      clean: true,
      dts: false,
      format: 'module',
      // mark everything as internal so that server build has no external dependencies
      noExternal: [/^.*$/],
      external: [],
      outDir: '.output',
    },
    {
      name: 'mc8yp-cli-build',
      entry: { cli: './src/cli/index.ts' },
      treeshake: true,
      clean: true,
      dts: false,
      format: 'module',
      // no external -> everything start starts with @c8y/ should be bundled for cli usage
      noExternal: [/^@c8y\/.*$/],
      outDir: 'dist',
    },
  ],
)
