// Testy integracyjne: osobna baza TEST_DATABASE_URL (nazwa musi kończyć się na „_test”, żeby nigdy nie
// wyczyścić bazy deweloperskiej), schemat od zera + migracje przed przebiegiem. Klient firmy w testach loguje się
// rolą LOGIN `logistyka_app` — hasło ustawia ten sam krok instalacji co w obrazie (ensureAppRoleLogin).
import 'dotenv/config'
import { execSync } from 'node:child_process'
import pg from 'pg'
import { APP_ROLE, ensureAppRoleLogin, isLoopbackUrl } from '../lib/db'

export function testDbUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? ''
  if (!url) throw new Error('Brak TEST_DATABASE_URL (patrz .env.example); uruchom bazę: npm run db:up')
  if (!/\/[A-Za-z0-9_]+_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL musi wskazywać bazę *_test')
  return url
}

/** Rola-wabik z testu członkostwa (organizacje-izolacja); przerwany przebieg mógł ją zostawić z grantem. */
export const TEST_FOREIGN_ROLE = 'logistyka_test_obca'

/**
 * Adres roli aplikacji dla testów: TEST_APP_DATABASE_URL albo adres bazy testów z rolą `logistyka_app`. Rola i jej
 * hasło to stan całego serwera Postgres (nie bazy `*_test`), a testy je ustawiają i rotują — dlatego domyślny adres
 * tylko dla serwera na 127.0.0.1 / localhost /::1. Hasło: z lokalnego APP_DATABASE_URL,
 * gdy wskazuje ten sam host i port (testy nie przestawiają hasła `npm run dev`), inaczej lokalne z .env.example.
 */
export function testAppDbUrl(): string {
  const own = process.env.TEST_APP_DATABASE_URL
  if (own) {
    if (!/\/[A-Za-z0-9_]+_test(\?|$)/.test(own)) throw new Error('TEST_APP_DATABASE_URL musi wskazywać bazę *_test')
    return own
  }
  const base = testDbUrl()
  if (!isLoopbackUrl(base))
    throw new Error('Testy integracyjne ustawiają i zmieniają hasło roli logistyka_app na całym serwerze Postgres — przy TEST_DATABASE_URL spoza 127.0.0.1/localhost podaj świadomie TEST_APP_DATABASE_URL')
  const u = new URL(base)
  let password = 'logistyka_app_local'
  const dev = process.env.APP_DATABASE_URL
  if (dev) {
    try {
      const d = new URL(dev)
      if (d.hostname === u.hostname && (d.port || '5432') === (u.port || '5432') && decodeURIComponent(d.username) === APP_ROLE && d.password) password = decodeURIComponent(d.password)
    } catch {
      // niepoprawny APP_DATABASE_URL: zostaje hasło lokalne
    }
  }
  u.username = APP_ROLE
  u.password = encodeURIComponent(password)
  return u.toString()
}

/** Sprzątanie po przerwanym teście członkostwa: zostawiona rola z grantem odcina każde połączenie klienta firmy. */
export async function dropStaleTestRoles(client: pg.Client): Promise<void> {
  await client.query(`DROP ROLE IF EXISTS ${TEST_FOREIGN_ROLE}`)
}

export default async function setup(): Promise<void> {
  const url = testDbUrl()
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
    await dropStaleTestRoles(client)
  } finally {
    await client.end()
  }
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: url } })
  await ensureAppRoleLogin({ ownerUrl: url, appUrl: testAppDbUrl() })
}
