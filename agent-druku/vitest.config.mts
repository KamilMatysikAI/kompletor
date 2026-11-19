import { defineConfig } from 'vitest/config'

// Testy bez prawdziwego druku: atrapy drukarek i serwera (test/atrapy.ts) + lokalny serwer HTTP na 127.0.0.1.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
