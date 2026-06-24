import { defineConfig } from 'vitest/config'
import { bundledServicesPlugin, bundleStringPlugin, coreOpenApiPlugin } from './tsdown.config'

export default defineConfig({
  plugins: [coreOpenApiPlugin({ mode: 'cli' }), bundledServicesPlugin({ mode: 'cli' }), bundleStringPlugin()],
})
