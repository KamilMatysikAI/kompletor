import 'dotenv/config'
import { defineConfig } from 'prisma/config'

// Prisma 7: adres bazy tutaj, nie w schema.prisma.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
    shadowDatabaseUrl: process.env['SHADOW_DATABASE_URL'] || undefined,
  },
})
