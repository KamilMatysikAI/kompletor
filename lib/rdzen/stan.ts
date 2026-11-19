// Prymitywy rdzenia: transakcja z ponowieniem, blokady w jednej kolejności (spec 5.1), księga stanu pod
// blokadą i outbox w tej samej transakcji. Kolejność blokad we wszystkich transakcjach:
//   (1) blokada doradcza zamówienia → (2) wiersze Stock rosnąco po productId → (3) Order/OrderLine/Reservation/…
// `db`/`tx` to zawsze klient jednej firmy (lib/db.ts, RLS) — surowe SQL widzi tylko jej wiersze, a
// INSERT bez "organizationId" dostaje firmę z sesji. Klucze blokad doradczych zawierają firmę (blokady są globalne).
import type { Prisma, PrismaClient } from '@prisma/client'

export type Tx = Prisma.TransactionClient
export type Db = PrismaClient

export const DEFAULT_WAREHOUSE = 'glowny' // = MAIN_WAREHOUSE_ID z importu (magazyn „Główny” wFirmy)

// ─── Transakcja z ponowieniem przy zakleszczeniu / serializacji ──────────────

export interface TxStats {
  retries: number
}

export const txStats: TxStats = { retries: 0 }

export function isRetryable(e: unknown): boolean {
  const x = e as { code?: string; message?: string; meta?: unknown; cause?: unknown }
  const text = `${x?.code ?? ''} ${x?.message ?? ''} ${safeJson(x?.meta)} ${safeJson((x?.cause as { message?: string })?.message ?? '')}`
  return /P2034|40P01|40001|deadlock|could not serialize|write conflict/i.test(text)
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}

export class RetryExhausted extends Error {}

/** Cała transakcja do 3 ponowień z losowym opóźnieniem 20–200 ms (spec 5.1). */
export async function runTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, opts: { retries?: number } = {}): Promise<T> {
  const max = opts.retries ?? 3
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(fn, { maxWait: 30_000, timeout: 60_000 })
    } catch (e) {
      if (!isRetryable(e)) throw e
      if (attempt >= max) throw new RetryExhausted(`transakcja nie przeszła po ${max} ponowieniach: ${(e as Error).message}`)
      txStats.retries++
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 180))
    }
  }
}

// ─── Blokady ─────────────────────────────────────────────────────────────────

export async function advisoryLock(tx: Tx, key: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))) s`
}

export async function tryAdvisoryLock(tx: Tx, key: string): Promise<boolean> {
  const r = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS ok`
  return r[0]?.ok === true
}

export function orderLockKey(o: { organizationId: string; channel: string; channelAccountId: string; externalId: string }): string {
  return `order:${o.organizationId}:${o.channel}:${o.channelAccountId}:${o.externalId}`
}

export interface StockRow {
  productId: string
  warehouseId: string
  wfirmaCount: number
  wfirmaReadAt: Date
  pendingDelta: number
  physical: number
  reserved: number
  overcommitSince: Date | null
  overcommitListedAt: Date | null
  allocationPendingSince: Date | null
  version: number
}

/** Porównanie zgodne z `ORDER BY "productId" COLLATE "C"` (kolejność blokad). */
export function byProductId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function availableOf(s: Pick<StockRow, 'physical' | 'reserved'>): number {
  return Math.max(0, s.physical - s.reserved)
}

/**
 * Księga wierszy Stock zablokowanych w tej transakcji. Zmiany w pamięci, zapis jednym `flush` na końcu:
 * version++, a przy zmianie `available` — outbox AVAILABLE_CHANGED (spec 3.2 pkt 5, 6.1).
 */
export class StockBook {
  readonly rows = new Map<string, StockRow>()
  private readonly before = new Map<string, StockRow>()
  private readonly touched = new Set<string>()

  constructor(readonly warehouseId: string) {}

  static async lock(tx: Tx, warehouseId: string, productIds: Iterable<string>): Promise<StockBook> {
    const book = new StockBook(warehouseId)
    await book.lockMore(tx, productIds)
    return book
  }

  /** Dobiera blokady (tylko gdy nowe id są „większe” od już trzymanych — inaczej błąd programisty). */
  async lockMore(tx: Tx, productIds: Iterable<string>): Promise<void> {
    const ids = [...new Set(productIds)].filter((id) => !this.before.has(id)).sort(byProductId)
    if (!ids.length) return
    const rows = await tx.$queryRaw<StockRow[]>`
      SELECT "productId", "warehouseId", "wfirmaCount", "wfirmaReadAt", "pendingDelta", physical, reserved,
             "overcommitSince", "overcommitListedAt", "allocationPendingSince", version
      FROM "Stock" WHERE "warehouseId" = ${this.warehouseId} AND "productId" = ANY(${ids}::text[])
      ORDER BY "productId" COLLATE "C" FOR UPDATE`
    for (const r of rows) {
      this.rows.set(r.productId, { ...r })
      this.before.set(r.productId, { ...r })
    }
  }

  has(productId: string): boolean {
    return this.rows.has(productId)
  }

  get(productId: string): StockRow | undefined {
    return this.rows.get(productId)
  }

  available(productId: string): number {
    const r = this.rows.get(productId)
    return r ? availableOf(r) : 0
  }

  change(productId: string, d: { reserved?: number; physical?: number; pending?: number }): void {
    const r = this.rows.get(productId)
    if (!r) throw new Error(`brak zablokowanego wiersza Stock dla ${productId}`)
    r.reserved += d.reserved ?? 0
    r.pendingDelta += d.pending ?? 0
    r.physical += (d.physical ?? 0) + (d.pending ?? 0)
    if (r.reserved < 0) throw new Error(`reserved < 0 dla ${productId}`)
    if (r.pendingDelta > 0) throw new Error(`pendingDelta > 0 dla ${productId}`)
    this.touched.add(productId)
  }

  set(productId: string, patch: Partial<StockRow>): void {
    const r = this.rows.get(productId)
    if (!r) throw new Error(`brak zablokowanego wiersza Stock dla ${productId}`)
    Object.assign(r, patch)
    this.touched.add(productId)
  }

  /** Zapis zmian + outbox. Zwraca produkty, którym zmienił się `available`. */
  async flush(tx: Tx, now: Date): Promise<string[]> {
    const changed: string[] = []
    for (const id of [...this.touched].sort(byProductId)) {
      const r = this.rows.get(id)!
      const b = this.before.get(id)!
      const version = b.version + 1
      await tx.stock.update({
        where: { productId_warehouseId: { productId: id, warehouseId: this.warehouseId } },
        data: {
          reserved: r.reserved,
          physical: r.physical,
          pendingDelta: r.pendingDelta,
          wfirmaCount: r.wfirmaCount,
          wfirmaReadAt: r.wfirmaReadAt,
          overcommitSince: r.overcommitSince,
          overcommitListedAt: r.overcommitListedAt,
          allocationPendingSince: r.allocationPendingSince,
          version,
        },
      })
      r.version = version
      if (availableOf(r) !== availableOf(b)) {
        changed.push(id)
        await tx.outboxEvent.create({ data: { kind: 'AVAILABLE_CHANGED', productId: id, version, createdAt: now } })
      }
      this.before.set(id, { ...r })
    }
    this.touched.clear()
    return changed
  }
}

// ─── Katalog: rozwinięcie zestawów ──────────────────────────────────────────

export interface CatalogEntry {
  id: string
  kind: 'STOCKED' | 'BUNDLE' | 'DIGITAL'
  components: { componentId: string; qtyBase: number }[]
}

export async function loadCatalog(tx: Tx | Db, productIds: Iterable<string>): Promise<Map<string, CatalogEntry>> {
  const ids = [...new Set(productIds)]
  const map = new Map<string, CatalogEntry>()
  if (!ids.length) return map
  const rows = await tx.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, kind: true, bundleComponents: { select: { componentId: true, qtyBase: true } } },
  })
  for (const r of rows) map.set(r.id, { id: r.id, kind: r.kind, components: r.kind === 'BUNDLE' ? r.bundleComponents : [] })
  return map
}

/**
 * Ilość z kanału (sztuki oferty) pozycji podzamówienia (`#dosle`, `#paczka`) z `units` jednostek bazowych i przelicznika
 * oferty: bez oferty `null`, przy reszcie z dzielenia `null` (zmiana przelicznika takiej oferty jest wtedy odmawiana).
 */
export function qtyChannelPodzamowienia(offerId: string | null, units: number, per: number): number | null {
  if (!offerId || !(per >= 1)) return null
  return units % per === 0 ? units / per : null
}

/**
 * Składniki magazynowe pozycji: STOCKED → [(produkt, 1)], BUNDLE → [(składnik, qtyBase)], DIGITAL → [] (bez stanu,
 * nic nie blokuje, nie rezerwuje i nie trafia do „brakuje”).
 */
export function partsOf(entry: CatalogEntry): { productId: string; perUnit: number }[] {
  if (entry.kind === 'DIGITAL') return []
  return entry.kind === 'BUNDLE'
    ? entry.components.map((c) => ({ productId: c.componentId, perUnit: c.qtyBase }))
    : [{ productId: entry.id, perUnit: 1 }]
}

export async function outbox(tx: Tx, kind: 'ALLOCATE' | 'WFIRMA_READ' | 'AVAILABLE_CHANGED', productId: string, now: Date): Promise<void> {
  await tx.outboxEvent.create({ data: { kind, productId, createdAt: now } })
}

/** Alert z deduplikacją (jedna wiadomość na sprawę). Nie przerywa transakcji przy duplikacie. */
/** true = powstał nowy alert; false = alert z tym kluczem deduplikacji już był. */
export async function alert(tx: Tx | Db, kind: string, ref: string, message: string, dedupeKey?: string): Promise<boolean> {
  if (dedupeKey) {
    const n = await tx.$executeRaw`INSERT INTO "Alert" (id, kind, ref, message, "dedupeKey", "createdAt")
      VALUES (${'al_' + cryptoId()}, ${kind}, ${ref}, ${message.slice(0, 2000)}, ${dedupeKey}, now())
      ON CONFLICT ("organizationId", "dedupeKey") DO NOTHING`
    return n > 0
  }
  await tx.alert.create({ data: { kind, ref, message: message.slice(0, 2000) } })
  return true
}

function cryptoId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '')
}
