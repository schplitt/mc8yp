import { defineConfig } from 'vitest/config'
import { coreOpenApiPlugin } from './tsdown.config'

export default defineConfig({
  plugins: [coreOpenApiPlugin({ mode: 'cli' })],
})
