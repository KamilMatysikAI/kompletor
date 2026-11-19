// Klienci bazy testów. Domyślnie testy pracują jako firma A (klient z RLS, jak aplikacja); firma B
// służy do testów izolacji i symulacji dwóch firm. Czyszczenie i zakładanie firm robi klient systemowy.
// Klient firmy loguje się rolą LOGIN `logistyka_app`, jak w hostingu.
import type { PrismaClient } from '@prisma/client'
import { createOrgClient, createSystemClient } from '@/lib/db'
import { applyOrgPreset, type OrgPreset } from '@/lib/organizacje'
import { ACME_CARRIER_RULES, ACME_PRESET } from '@/tests/preset-testowy'
import { testAppDbUrl, testDbUrl } from './global-setup'

export const ORG_A = 'test_a'
export const ORG_B = 'test_b'

/** Firmy testowe: bez magazynów i kanałów (zakładają je testy), z regułami przewoźników jak ACME. */
export const TEST_ORGS: OrgPreset[] = [
  { id: ORG_A, slug: 'test-a', name: 'Firma testowa A', warehouses: [], carrierRules: ACME_CARRIER_RULES },
  { id: ORG_B, slug: 'test-b', name: 'Firma testowa B', warehouses: [], carrierRules: ACME_CARRIER_RULES },
]

export function testDb(opts: { poolMax?: number; organizationId?: string } = {}): PrismaClient {
  return createOrgClient(opts.organizationId ?? ORG_A, { appConnectionString: testAppDbUrl(), poolMax: opts.poolMax })
}

let sys: PrismaClient | null = null
export function testSystemDb(): PrismaClient {
  sys ??= createSystemClient({ connectionString: testDbUrl(), poolMax: 2 })
  return sys
}

/** Czyści wszystkie tabele i zakłada od nowa firmy testowe. Argument zostawiony dla zgodności wywołań. */
export async function truncateAll(_db?: PrismaClient, orgs: OrgPreset[] = TEST_ORGS): Promise<void> {
  const s = testSystemDb()
  const rows = await s.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  if (rows.length) await s.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} CASCADE`)
  for (const o of orgs) await applyOrgPreset(s, o)
}

/** Konfiguracja importu jak u ACME (magazyn, 3 sklepy Woo, Allegro, Empik) w firmie testowej — same identyfikatory. */
export async function seedImportConfig(organizationId = ORG_A): Promise<void> {
  const org = TEST_ORGS.find((o) => o.id === organizationId)!
  // 3 sklepy aktywne jak w fixtures (tests/fixtures.ts): preset ACME od 27.10 zakłada KolorowyKubek jako nieaktywną
  // (sklep do wyłączenia), a testy importu modelują firmę z trzema działającymi sklepami
  const channels = ACME_PRESET.channels!.map((c) => ({ ...c, active: true }))
  await applyOrgPreset(testSystemDb(), { ...ACME_PRESET, channels, id: org.id, slug: org.slug, name: org.name })
}

/**
 * Przecieki między firmami: wiersz jednej firmy wskazujący wiersz innej (klient systemowy, przez wszystkie firmy).
 * Wynik: liczba takich powiązań per reguła; oczekiwane wszędzie 0.
 */
export async function crossOrgLeaks(sys: PrismaClient = testSystemDb()): Promise<Record<string, number>> {
  const checks: Record<string, string> = {
    stock_produkt: `SELECT count(*) FROM "Stock" x JOIN "Product" p ON p.id = x."productId" WHERE p."organizationId" <> x."organizationId"`,
    oferta_produkt: `SELECT count(*) FROM "ChannelOffer" x JOIN "Product" p ON p.id = x."productId" WHERE p."organizationId" <> x."organizationId"`,
    zestaw_skladnik: `SELECT count(*) FROM "BundleComponent" x JOIN "Product" b ON b.id = x."bundleId" JOIN "Product" c ON c.id = x."componentId" WHERE b."organizationId" <> x."organizationId" OR c."organizationId" <> x."organizationId"`,
    pozycja_zamowienie: `SELECT count(*) FROM "OrderLine" x JOIN "Order" o ON o.id = x."orderId" WHERE o."organizationId" <> x."organizationId"`,
    pozycja_produkt: `SELECT count(*) FROM "OrderLine" x JOIN "Product" p ON p.id = x."productId" WHERE p."organizationId" <> x."organizationId"`,
    rezerwacja: `SELECT count(*) FROM "Reservation" x JOIN "Order" o ON o.id = x."orderId" JOIN "Product" p ON p.id = x."productId" WHERE o."organizationId" <> x."organizationId" OR p."organizationId" <> x."organizationId"`,
    brak: `SELECT count(*) FROM "Shortage" x JOIN "Order" o ON o.id = x."orderId" JOIN "Product" p ON p.id = x."productId" WHERE o."organizationId" <> x."organizationId" OR p."organizationId" <> x."organizationId"`,
    ruch: `SELECT count(*) FROM "PendingMovement" x JOIN "Product" p ON p.id = x."productId" WHERE p."organizationId" <> x."organizationId"`,
    historia_stanu: `SELECT count(*) FROM "StockMovement" x JOIN "Product" p ON p.id = x."productId" WHERE p."organizationId" <> x."organizationId"`,
    faktura: `SELECT count(*) FROM "InvoiceAttempt" x JOIN "Order" o ON o.id = x."orderId" WHERE o."organizationId" <> x."organizationId"`,
    zdarzenie_zamowienia: `SELECT count(*) FROM "OrderEvent" x JOIN "Order" o ON o.id = x."orderId" WHERE o."organizationId" <> x."organizationId"`,
    outbox: `SELECT count(*) FROM "OutboxEvent" x JOIN "Product" p ON p.id = x."productId" WHERE p."organizationId" <> x."organizationId"`,
    job_stanu: `SELECT count(*) FROM "StockSyncJob" x JOIN "ChannelOffer" o ON o.id = x."offerId" WHERE o."organizationId" <> x."organizationId"`,
    log_wysylki: `SELECT count(*) FROM "ChannelPushLog" x JOIN "ChannelOffer" o ON o.id = x."offerId" WHERE o."organizationId" <> x."organizationId"`,
    zwrot: `SELECT count(*) FROM "Return" x JOIN "Order" o ON o.id = x."orderId" WHERE o."organizationId" <> x."organizationId"`,
    klient_zamowienia: `SELECT count(*) FROM "OrderCustomer" x JOIN "Order" o ON o.id = x."orderId" WHERE o."organizationId" <> x."organizationId"`,
    pozycja_zwrotu: `SELECT count(*) FROM "ReturnLine" x JOIN "Return" r ON r.id = x."returnId" JOIN "Product" p ON p.id = x."productId" WHERE r."organizationId" <> x."organizationId" OR p."organizationId" <> x."organizationId"`,
  }
  const out: Record<string, number> = {}
  for (const [k, q] of Object.entries(checks)) {
    const r = await sys.$queryRawUnsafe<{ count: bigint }[]>(q)
    out[k] = Number(r[0]!.count)
  }
  return out
}
