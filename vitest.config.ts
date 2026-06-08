import { defineConfig } from 'vitest/config'
import { bundledServicesPlugin, coreOpenApiPlugin } from './tsdown.config'

export default defineConfig({
  plugins: [coreOpenApiPlugin({ mode: 'cli' }), bundledServicesPlugin()],
})
