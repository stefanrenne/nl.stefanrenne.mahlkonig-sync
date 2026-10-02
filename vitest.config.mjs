import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      // `homey` is provided by the Homey runtime and isn't installed; `homey/lib/*` is only imported for types.
      { find: /^homey$/, replacement: fileURLToPath(new URL('./test/mocks/homey.mts', import.meta.url)) },
    ],
  },
  test: {
    include: ['test/**/*.test.mts'],
  },
})
