// Operacje na rezerwacjach i „brakuje” wewnątrz transakcji (spec 3.2, 3.7, 4.2). Wołane wyłącznie przy
// zablokowanych wierszach Stock (StockBook) i po blokadzie doradczej zamówienia.
import type { Order, Prisma } from '@prisma/client'
import { BEFORE_PICKING } from './statusy'
import { type CatalogEntry, partsOf, type StockBook, type Tx } from './stan'

export type Flags = {
  brakuje?: boolean
  /** tekst dla ekranu (powody złączone „; ”); źródłem prawdy jest `powodyWyjasnienia` */
  doWyjasnienia?: string | null
  powodyWyjasnienia?: string[]
  fakturaBlad?: boolean
  /** „Ponów fakturę” z karty — próby o numerze ≤ tej liczbie nie liczą się już do limitu prób (nowa seria). */
  fakturaPonowionaPo?: number
  lastError?: string | null
  doKorekty?: boolean
  fakturaBezWz?: boolean
  wydaneBezDokumentu?: boolean
  niedoplata?: boolean
  /**
   * Kanał zgłosił nieudaną płatność online (bramka odrzuciła BLIK albo kartę): nieopłacone trzyma towar tylko przez
   * krótki czas z zasad rezerwacji. Zostaje przy kolejnych odczytach (ponowna próba bramki), schodzi przy metodzie
   * offline (przelew tradycyjny) i przy wpłacie.
   */
  nieudanaPlatnoscOnline?: boolean
  /** Pozycje zmieniły się w kanale po wydruku karty (3.7): zebrać i spakować tylko z nowej karty; zdejmuje nowy wydruk. */
  kartaNieaktualna?: boolean
  /** gwiazdka zamówienia (krok „oznacz” automatycznych akcji, jak w BL). Opisowe: rdzeń na niej nic nie liczy. */
  gwiazdka?: boolean
  /**
   * świadoma decyzja osoby z karty („Pakuj mimo faktury z BaseLinkera”): zamówienie konta w trybie pracy
   * z fakturą BL wraca do kolejki pakowania i da się spakować (towar dodany po fakturze BL). Bez flagi pakowanie odmawia.
   */
  pakujMimoFakturyBl?: boolean
  /**
   * pozycje zmienione z karty zamówienia (lib/rdzen/edycja.ts). Kanał o zmianie nie wie, więc kolejna rewizja
   * z kanału porównuje się z `pozycjeKanalu` (stan kanału sprzed pierwszej edycji), nie z pozycjami w Kompletorze.
   */
  edytowaneLokalnie?: boolean
  /** Pozycje kanału sprzed pierwszej edycji z karty: externalLineId → [productId, ilość w jednostce bazowej]. */
  pozycjeKanalu?: Record<string, [string | null, number]>
  /** Pozycje usunięte z karty (nie w kanale): id pozycji. */
  usunieteLokalnie?: string[]
  /** Kwota zapłacona przed pierwszą edycją z karty (zamówienie opłacone): podstawa „Do dopłaty” i „Do zwrotu”. */
  kwotaZaplacona?: string
  /**
   * Chwila odczytu numeru zamówienia ze sklepu przy parowaniu faktury BL (lib/cien/parowanie-faktur.ts), gdy sklep
   * numeru nie dał (nie zna zamówienia albo zamówienie nie ma numeru). Taki odczyt się nie zmieni, więc kolejne
   * przebiegi go nie powtarzają. Zapis atomowy (jsonb ||), bez zmiany innych flag.
   */
  numerKanaluSprawdzony?: string
  /**
   * Sposób wysyłki zmieniony na karcie zamówienia (lib/wysylka/zmiana-sposobu.ts): przewoźnik i moduł wybrał człowiek,
   * więc reguła przy nadaniu nie wynika już z metody dostawy z kanału (`regulaDlaZamowienia`). Kolejna rewizja
   * z kanału go nie zdejmuje (przewoźnika też nie nadpisuje); paczki z podziału i dosłania dziedziczą go z przewoźnikiem.
   */
  przewoznikRecznie?: boolean
}

export function flagsOf(o: Pick<Order, 'flags'>): Flags {
  return (o.flags ?? {}) as Flags
}

export function mergeFlags(o: Pick<Order, 'flags'>, patch: Flags): Prisma.InputJsonValue {
  return { ...flagsOf(o), ...patch } as Prisma.InputJsonValue
}

/** Powody „Do wyjaśnienia”: tablica; zamówienia mają tylko tekst złączony „; ”. */
export function clarifyReasons(f: Flags): string[] {
  if (Array.isArray(f.powodyWyjasnienia)) return f.powodyWyjasnienia
  return f.doWyjasnienia ? f.doWyjasnienia.split('; ').filter(Boolean) : []
}

/** Zapis powodów: tablica (logika) + tekst dla ekranu (panel czyta `doWyjasnienia`). Bez powtórzeń. */
export function withReasons(reasons: string[]): Flags {
  const uniq = [...new Set(reasons.filter(Boolean))]
  return { powodyWyjasnienia: uniq, doWyjasnienia: uniq.length ? uniq.join('; ') : null }
}

/** Dokłada `qty` do jedynej ACTIVE rezerwacji pozycji i produktu (indeks częściowy) albo ją zakłada. */
export async function addReservation(
  tx: Tx,
  book: StockBook,
  a: { orderId: string; orderLineId: string; productId: string; qty: number },
): Promise<string> {
  if (a.qty <= 0) throw new Error('addReservation: qty <= 0')
  book.change(a.productId, { reserved: a.qty })
  const existing = await tx.reservation.findFirst({
    where: { orderLineId: a.orderLineId, productId: a.productId, warehouseId: book.warehouseId, state: 'ACTIVE' },
    select: { id: true },
  })
  if (existing) {
    await tx.reservation.update({ where: { id: existing.id }, data: { qtyBase: { increment: a.qty } } })
    return existing.id
  }
  const r = await tx.reservation.create({
    data: { orderId: a.orderId, orderLineId: a.orderLineId, productId: a.productId, warehouseId: book.warehouseId, qtyBase: a.qty },
    select: { id: true },
  })
  return r.id
}

export interface ReserveResult {
  reservedUnits: number
  shortUnits: number
}

/**
 * Rezerwuje `units` sztuk pozycji (dla zestawu: zestawów). STOCKED: min(qty, available), reszta → Shortage.
 * BUNDLE: tylko pełne zestawy (k = min(n, min floor(avail_i/q_i))), brakujące zestawy → Shortage na każdym
 * składniku; składników niekompletnego zestawu nie rezerwujemy (spec 3.2 pkt 3–4). DIGITAL: nic (0, 0).
 */
export async function reserveUnits(
  tx: Tx,
  book: StockBook,
  orderId: string,
  orderLineId: string,
  entry: CatalogEntry,
  units: number,
  opts: { shortageState?: 'OPEN' | 'SHIP_LATER' } = {},
): Promise<ReserveResult> {
  // Produkt bez stanu (e-book): ani rezerwacji, ani braku — nie liczy się też do „brak wszystkiego”.
  if (units <= 0 || entry.kind === 'DIGITAL') return { reservedUnits: 0, shortUnits: 0 }
  const parts = partsOf(entry)
  let k = units
  for (const p of parts) k = Math.min(k, Math.floor(book.available(p.productId) / p.perUnit))
  if (entry.kind === 'BUNDLE' && parts.length === 0) k = 0
  for (const p of parts) {
    if (k > 0) await addReservation(tx, book, { orderId, orderLineId, productId: p.productId, qty: k * p.perUnit })
    if (units - k > 0)
      await tx.shortage.create({
        data: { orderId, orderLineId, productId: p.productId, qtyBase: (units - k) * p.perUnit, state: opts.shortageState ?? 'OPEN' },
      })
  }
  return { reservedUnits: k, shortUnits: units - k }
}

/**
 * Zmniejsza pozycję o `units`: najpierw zamyka „brakuje”, potem zwalnia rezerwację (spec 3.7).
 * Dla zestawu operuje na każdym składniku po `units × q`.
 */
export async function reduceUnits(
  tx: Tx,
  book: StockBook,
  orderLineId: string,
  entry: CatalogEntry,
  units: number,
  reason: string,
  now: Date,
): Promise<void> {
  for (const p of partsOf(entry)) {
    let left = units * p.perUnit
    const shortages = await tx.shortage.findMany({
      where: { orderLineId, productId: p.productId, state: { in: ['OPEN', 'SHIP_LATER'] } },
      orderBy: { createdAt: 'desc' },
    })
    for (const s of shortages) {
      if (left <= 0) break
      const take = Math.min(left, s.qtyBase)
      if (take === s.qtyBase) await tx.shortage.update({ where: { id: s.id }, data: { state: 'CANCELLED', note: reason, resolvedAt: now } })
      else await tx.shortage.update({ where: { id: s.id }, data: { qtyBase: s.qtyBase - take } })
      left -= take
    }
    if (left <= 0) continue
    const res = await tx.reservation.findFirst({
      where: { orderLineId, productId: p.productId, warehouseId: book.warehouseId, state: 'ACTIVE' },
    })
    if (!res) throw new Error(`reduceUnits: brak ACTIVE dla pozycji ${orderLineId}`)
    const take = Math.min(left, res.qtyBase)
    if (take === res.qtyBase)
      await tx.reservation.update({ where: { id: res.id }, data: { state: 'RELEASED', releasedReason: reason, releasedAt: now } })
    else await tx.reservation.update({ where: { id: res.id }, data: { qtyBase: res.qtyBase - take } })
    book.change(p.productId, { reserved: -take })
    left -= take
    if (left > 0) throw new Error(`reduceUnits: za mało rezerwacji i braków na pozycji ${orderLineId}`)
  }
}

/** Zwalnia wszystkie ACTIVE rezerwacje zamówienia i zamyka otwarte „brakuje” (anulowanie, wygaśnięcie). */
export async function releaseOrder(tx: Tx, book: StockBook, orderId: string, reason: string, now: Date): Promise<number> {
  const active = await tx.reservation.findMany({ where: { orderId, state: 'ACTIVE', warehouseId: book.warehouseId } })
  for (const r of active) book.change(r.productId, { reserved: -r.qtyBase })
  if (active.length)
    await tx.reservation.updateMany({
      where: { id: { in: active.map((r) => r.id) } },
      data: { state: 'RELEASED', releasedReason: reason, releasedAt: now },
    })
  await tx.shortage.updateMany({
    where: { orderId, state: { in: ['OPEN', 'SHIP_LATER'] } },
    data: { state: 'CANCELLED', resolvedAt: now, note: reason },
  })
  return active.reduce((s, r) => s + r.qtyBase, 0)
}

/** Produkty z aktywnymi rezerwacjami i otwartymi brakami zamówienia (do zablokowania przed zmianą). */
export async function productsOfOrder(tx: Tx, orderId: string): Promise<string[]> {
  const [r, s] = await Promise.all([
    tx.reservation.findMany({ where: { orderId, state: { in: ['ACTIVE', 'CONSUMING'] } }, select: { productId: true } }),
    tx.shortage.findMany({ where: { orderId, state: { in: ['OPEN', 'SHIP_LATER'] } }, select: { productId: true } }),
  ])
  return [...new Set([...r, ...s].map((x) => x.productId))]
}

/** Czy zamówienie ma jeszcze otwarte braki (flaga `brakuje`). */
export async function hasOpenShortage(tx: Tx, orderId: string): Promise<boolean> {
  return (await tx.shortage.count({ where: { orderId, state: { in: ['OPEN', 'SHIP_LATER'] } } })) > 0
}

/**
 * Po commicie zamówienia z otwartymi brakami przydział musi je zobaczyć, nawet jeśli `allocate` pominął to
 * zamówienie (blokada doradcza zajęta, spec 4.4 pkt 3c). Tanie: tylko gdy produkt ma wolny stan.
 */
export async function hintAllocate(tx: Tx, orderId: string, now: Date): Promise<void> {
  const rows = await tx.$queryRaw<{ productId: string }[]>`
    SELECT DISTINCT s."productId" FROM "Shortage" s
    JOIN "Stock" st ON st."productId" = s."productId"
    JOIN "Order" o ON o.id = s."orderId"
    WHERE s."orderId" = ${orderId} AND s.state IN ('OPEN', 'SHIP_LATER') AND st.physical - st.reserved > 0
      AND o.status::text = ANY(${BEFORE_PICKING as string[]}::text[])`
  for (const r of rows) await tx.outboxEvent.create({ data: { kind: 'ALLOCATE', productId: r.productId, createdAt: now } })
}
