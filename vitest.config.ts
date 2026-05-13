import { defineConfig } from 'vitest/config'
import { coreOpenApiPlugin, dtmOpenApiPlugin } from './tsdown.config'

export default defineConfig({
  plugins: [coreOpenApiPlugin({ mode: 'cli' }), dtmOpenApiPlugin({ mode: 'cli' })],
})
