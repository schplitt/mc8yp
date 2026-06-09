import { defineConfig } from 'changelogithub'

export default defineConfig({
  types: {
    feat: { title: '🚀 Features' },
    fix: { title: '🐞 Bug Fixes' },
    perf: { title: '🏎 Performance' },
    docs: { title: '📖 Documentation' },
    test: { title: '🧪 Tests' },
    refactor: { title: '♻️ Refactors' },
    chore: { title: '🧹 Chores' },
  },
})
