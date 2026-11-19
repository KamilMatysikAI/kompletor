import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

// Tryby: `unit` (bez bazy), `integration` (baza TEST_DATABASE_URL z docker-compose), domyślnie oba.
// agent-druku/ to osobny pakiet z własnym package.json i vitest — tu pomijany.
export default defineConfig(({ mode }) => ({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include:
      mode === 'unit'
        ? ['**/*.test.ts']
        : mode === 'integration'
          ? ['**/*.integration.test.ts']
          : ['**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**', 'agent-druku/**', ...(mode === 'unit' ? ['**/*.integration.test.ts'] : [])],
    globalSetup: mode === 'unit' ? [] : ['./tests/global-setup.ts'],
    fileParallelism: mode === 'unit',
    // reset bazy w beforeEach zakłada też firmy testowe (ok. 1,5–3 s, pod obciążeniem więcej)
    ...(mode === 'unit' ? {} : { hookTimeout: 60_000, testTimeout: 30_000 }),
  },
}))
