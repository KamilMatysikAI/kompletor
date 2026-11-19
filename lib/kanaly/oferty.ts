// Oferty kanału bez importu z BaseLinkera: „Pobierz oferty” czyta listę ofert adapterem (`hasOfferReader`,
// tylko GET), zakłada brakujące produkty i oferty, a resztę zostawia na liście „Do przypisania”. Reguły:
//   - oferta o tym externalId już jest (każde źródło: MANUAL, BL_LINK, BL_ORDERS, OVERRIDE, CONFIG, SKU): nic nie
//     zmieniamy, tylko liczymy — powiązań z panelu i z importu BL ten przebieg nie rusza;
//   - SKU jest i produkt o tym SKU istnieje: nowa oferta `mappingSource: SKU`; firma bez BL — aktywna od razu, z BL —
//     propozycja do zatwierdzenia (needsApproval), jak w imporcie BL;
//   - SKU jest, produktu nie ma: nowy produkt STOCKED/SZT ze stanem startowym z kanału (null = 0) i oferta. Tylko firma
//     bez BL i bez wFirmy: przy nich produkt zakłada import wFirmy (inaczej ten sam kod towaru dwa razy);
//   - dwa sklepy z tym samym SKU to jeden produkt: stan startowy z pierwszego, drugi tylko oferta, rozjazd w wyniku;
//   - bez SKU, SKU powtórzone na kilku ofertach konta albo różniące się tylko wielkością liter: lista „Do przypisania”.
// Każda oferta osobno (try/catch → ImportIssue), przebieg leci dalej. Powtórka nic nie dubluje, a kolejny przebieg nie
// zmienia ilości: system nie jest lustrem kanału. Wynik w ImportRun (kind „kanal-oferty”).
import type { Channel, ChannelOffer, MappingSource, Prisma, PrismaClient } from '@prisma/client'
import type { ChannelAdapter, ChannelOfferRow, OfferPageWithProblems } from '../adaptery/kontrakt'
import { AdapterError, hasOfferEanReader, hasOfferReader } from '../adaptery/kontrakt'
import { AdapterConfigError } from '../adaptery/rejestr'
import { jestOdlozone } from '../integracje/oslona'
import { organizationIdOf } from '../db'
import { normalizeEan } from '../import/normalizacja'
import { przeliczZamowienia, REMAP_STATUSES } from './przeliczenie'
import { KontoError, type KontoRef } from './konta'
import { stanStartowy, zalozProdukt } from './produkt'
import { zlecPartieZdjec, zlecZdjeciaZOferty } from '../produkty/zdjecia'
import { uniewaznijRozjazdy } from './rejestr-synchronizacji'

export const OFFERS_RUN_KIND = 'kanal-oferty'
const MAX_PAGES = 2000
const MAX_LISTED = 200 // pozycji na liście w wyniku (rozjazdy, błędy)

export type StanOferty = 'POWIAZANA' | 'BEZ_SKU' | 'WIELOZNACZNE' | 'BEZ_PRODUKTU' | 'BLAD'
export const DO_PRZYPISANIA: StanOferty[] = ['BEZ_SKU', 'WIELOZNACZNE', 'BEZ_PRODUKTU', 'BLAD']

export interface WynikOfert {
  runId: string
  status: 'OK' | 'PARTIAL'
  pages: number
  read: number
  newProducts: number
  newOffers: number
  proposals: number
  kept: number
  bezSku: number
  wieloznaczne: number
  bezProduktu: number
  errors: number
  unreadable: number
  ordersRemapped: number
  rozjazdy: { externalId: string; sku: string; kanal: number; stan: number }[]
  complete: boolean
  /** zdjęcia istniejących produktów zlecone z tego odczytu ofert */
  zdjecia?: WynikUzupelnieniaZdjec
  /** EAN dociągnięty ze szczegółów ofert (kanał, którego lista ofert EAN-u nie podaje: Allegro) */
  ean?: WynikUzupelnieniaEan
}

/** najwyżej tyle szczegółów ofert na jedno „Pobierz oferty” (reszta przy następnym pobraniu). */
export const EAN_LIMIT_NA_PRZEBIEG = 200
/** Po tylu błędach z rzędu dociąganie EAN staje (awaria kanału: nie męczymy go dalej w tym przebiegu). */
const EAN_BLEDY_Z_RZEDU = 5

export interface WynikUzupelnieniaEan {
  /** EAN z poprzedniego pobrania (bez wywołania kanału) */
  zZapisu: number
  /** odpytane w tym przebiegu */
  sprawdzone: number
  /** odpytane z EAN-em */
  znalezione: number
  /** odpytane bez EAN-u (produkt bez EAN, zestaw, kilka EAN-ów) */
  bezEan: number
  /** nieodpytane: ponad limit przebiegu albo po przerwaniu (limit zapytań, błąd konta) */
  pozostale: number
  bledy: number
}

export interface OfertyOpts {
  /** Firma ma BL: nowe oferty po SKU tylko jako propozycje, produktów nie zakładamy. */
  hasBl: boolean
  /** Firma ma wFirmę: produktów nie zakładamy (zakłada je import wFirmy). */
  hasWfirma: boolean
  actorId: string
  now?: Date
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500)
const skuKey = (s: string) => s.trim()

async function readAllOffers(adapter: ChannelAdapter, issue: (kind: string, ref: string, msg: string) => Promise<void>): Promise<{ rows: ChannelOfferRow[]; pages: number; unreadable: number; complete: boolean }> {
  if (!hasOfferReader(adapter)) throw new KontoError('Ten rodzaj sklepu nie umie jeszcze pobrać listy ofert')
  const byId = new Map<string, ChannelOfferRow>()
  let cursor: string | null = null
  let pages = 0
  let unreadable = 0
  for (;;) {
    let p: OfferPageWithProblems
    try {
      p = await adapter.listOffers(cursor)
    } catch (e) {
      await issue('strona', cursor ?? 'pierwsza', `odczyt ofert przerwany: ${errMsg(e)}`)
      return { rows: [...byId.values()], pages, unreadable, complete: false }
    }
    pages++
    for (const r of p.items) byId.set(r.externalId, r)
    for (const u of p.unreadable ?? []) {
      unreadable++
      await issue('oferta-nieczytelna', u.externalId, u.message)
    }
    if (p.nextCursor === null) return { rows: [...byId.values()], pages, unreadable, complete: unreadable === 0 }
    if (pages >= MAX_PAGES) {
      await issue('strona', p.nextCursor, `odczyt ofert zatrzymany po ${MAX_PAGES} stronach`)
      return { rows: [...byId.values()], pages, unreadable, complete: false }
    }
    cursor = p.nextCursor
  }
}

/** Błąd, po którym dalsze odpytywanie w tym przebiegu nie ma sensu: limit zapytań, osłona odłożyła, konto bez zgody. */
const przerywaEan = (e: unknown) => jestOdlozone(e) || e instanceof AdapterConfigError || (e instanceof AdapterError && e.kind === 'PRZEJSCIOWY' && e.retryAfterMs !== undefined)

/**
 * EAN ofert, których lista ofert kanału go nie podaje (Allegro: `getOfferEan`, szczegóły oferty, tylko GET).
 * Kolejność: EAN z poprzedniego pobrania (bez wywołania), potem odpytanie ofert bez aktywnego powiązania, najwyżej
 * {@link EAN_LIMIT_NA_PRZEBIEG} na przebieg. Oferta z aktywnym powiązaniem albo z zapisanym EAN-em nie jest odpytywana.
 * Błąd jednej oferty idzie do „Błędy pobrania” i nie przerywa reszty; limit zapytań, błąd konta albo
 * {@link EAN_BLEDY_Z_RZEDU} błędów z rzędu zatrzymują odpytywanie (reszta przy następnym „Pobierz oferty”).
 * Uzupełnia `row.ean` w miejscu; powód braku EAN do `bezEanPowod`.
 */
async function uzupelnijEan(
  db: PrismaClient,
  ref: KontoRef,
  adapter: ChannelAdapter,
  rows: ChannelOfferRow[],
  existing: Map<string, { active: boolean }>,
  bezEanPowod: Map<string, string>,
  issue: (kind: string, ref: string, msg: string) => Promise<void>,
): Promise<WynikUzupelnieniaEan | undefined> {
  if (!hasOfferEanReader(adapter)) return undefined
  const brak = rows.filter((r) => !normalizeEan(r.ean).ean)
  if (!brak.length) return undefined
  const w: WynikUzupelnieniaEan = { zZapisu: 0, sprawdzone: 0, znalezione: 0, bezEan: 0, pozostale: 0, bledy: 0 }
  const zapisane = new Map(
    (await db.channelOfferRead.findMany({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId, ean: { not: null } }, select: { externalId: true, ean: true } })).map((r) => [r.externalId, r.ean!]),
  )
  const kolejka: ChannelOfferRow[] = []
  for (const r of brak) {
    const z = zapisane.get(r.externalId)
    if (z) {
      r.ean = z
      w.zZapisu++
    } else if (!existing.get(r.externalId)?.active) kolejka.push(r)
  }
  let zRzedu = 0
  for (let i = 0; i < kolejka.length; i++) {
    if (i >= EAN_LIMIT_NA_PRZEBIEG) {
      w.pozostale = kolejka.length - i
      break
    }
    const r = kolejka[i]!
    try {
      const x = await adapter.getOfferEan(r.externalId)
      w.sprawdzone++
      zRzedu = 0
      const e = normalizeEan(x.ean)
      if (e.ean) {
        r.ean = e.ean
        w.znalezione++
      } else {
        w.bezEan++
        bezEanPowod.set(r.externalId, x.ean ? `EAN „${x.ean.slice(0, 20)}” w kanale ma złą cyfrę kontrolną` : (x.powod ?? 'brak EAN w szczegółach oferty'))
      }
    } catch (e) {
      if (przerywaEan(e)) {
        w.pozostale = kolejka.length - i
        await issue('oferta-ean', `${ref.channel}/${ref.channelAccountId}`, `EAN ofert: odczyt przerwany (${errMsg(e)}); pozostałe ${w.pozostale} ofert sprawdzi następne „Pobierz oferty”`)
        break
      }
      w.bledy++
      zRzedu++
      await issue('oferta-ean', r.externalId, `EAN oferty: ${errMsg(e)}`)
      if (zRzedu >= EAN_BLEDY_Z_RZEDU) {
        w.pozostale = kolejka.length - i - 1
        if (w.pozostale > 0) await issue('oferta-ean', `${ref.channel}/${ref.channelAccountId}`, `EAN ofert: ${EAN_BLEDY_Z_RZEDU} błędów z rzędu, odczyt zatrzymany; pozostałe ${w.pozostale} ofert sprawdzi następne „Pobierz oferty”`)
        break
      }
    }
  }
  return w
}

const KEPT_SOURCES: MappingSource[] =['MANUAL', 'BL_LINK', 'BL_ORDERS', 'OVERRIDE', 'CONFIG', 'SKU', 'NONE']

/** Pobranie ofert konta i założenie brakujących produktów i ofert. Adapter dostaje host (worker), nie panel. */
export async function pobierzOferty(db: PrismaClient, ref: KontoRef, adapter: ChannelAdapter, opts: OfertyOpts): Promise<WynikOfert> {
  const now = opts.now ?? new Date()
  const run = await db.importRun.create({ data: { kind: OFFERS_RUN_KIND } })
  await db.channelAccountStatus.upsert({
    where: { organizationId_channel_channelAccountId: { organizationId: organizationIdOf(db), channel: ref.channel, channelAccountId: ref.channelAccountId } },
    create: { channel: ref.channel, channelAccountId: ref.channelAccountId, offersRunId: run.id },
    update: { offersRunId: run.id },
  })
  const w: WynikOfert = {
    runId: run.id,
    status: 'OK',
    pages: 0,
    read: 0,
    newProducts: 0,
    newOffers: 0,
    proposals: 0,
    kept: 0,
    bezSku: 0,
    wieloznaczne: 0,
    bezProduktu: 0,
    errors: 0,
    unreadable: 0,
    ordersRemapped: 0,
    rozjazdy: [],
    complete: false,
  }
  const issue = async (kind: string, r: string, message: string) => {
    w.errors++
    await db.importIssue.create({ data: { runId: run.id, kind, ref: r.slice(0, 200), message: message.slice(0, 1000) } })
  }
  try {
    const all = await readAllOffers(adapter, issue)
    w.pages = all.pages
    w.unreadable = all.unreadable
    w.complete = all.complete
    w.read = all.rows.length
    const skuCount = new Map<string, number>()
    for (const r of all.rows) if (r.sku?.trim()) skuCount.set(skuKey(r.sku), (skuCount.get(skuKey(r.sku)) ?? 0) + 1)
    const existing = new Map(
      (await db.channelOffer.findMany({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId }, select: { externalId: true, productId: true, mappingSource: true, active: true, needsApproval: true, deactivatedByImportAt: true } })).map((o) => [o.externalId, o]),
    )
    // EAN ofert, których lista go nie podaje (Allegro), przed rozdziałem na stany: notatka i podgląd po EAN
    const bezEanPowod = new Map<string, string>()
    try {
      w.ean = await uzupelnijEan(db, ref, adapter, all.rows, existing, bezEanPowod, issue)
    } catch (e) {
      await issue('oferta-ean', `${ref.channel}/${ref.channelAccountId}`, `EAN ofert ze szczegółów: ${errMsg(e)}`)
    }
    const canCreate = !opts.hasBl && !opts.hasWfirma
    const activated: string[] = []
    for (const row of all.rows) {
      let state: StanOferty = 'POWIAZANA'
      let note: string | null = null
      try {
        const ex = existing.get(row.externalId)
        if (ex && KEPT_SOURCES.includes(ex.mappingSource)) {
          w.kept++
          if (ex.active) await noteMismatch(db, w, row, ex.productId)
          else if (!ex.needsApproval) {
            // odłączona w panelu albo wyłączona importem zostaje na liście „Do przypisania”;
            // stan na nią nie wychodzi, więc rozjazdu ilości nie liczymy (propozycja do zatwierdzenia ma własną listę)
            state = 'BEZ_PRODUKTU'
            note = ex.deactivatedByImportAt ? 'wyłączona przez import' : 'odłączona w panelu'
          }
        } else {
          const sku = row.sku?.trim() || null
          if (!sku) {
            state = 'BEZ_SKU'
            const ean = normalizeEan(row.ean).ean
            // z EAN-em łączy „Łączenie ofert z produktami” → „Podgląd: po EAN”; bez niego tylko ręcznie
            note = ean ? `oferta bez SKU w kanale, EAN ${ean}: połączysz ją „Podgląd: po EAN”` : `oferta bez SKU i bez EAN w kanale${bezEanPowod.has(row.externalId) ? ` (${bezEanPowod.get(row.externalId)})` : ''}`
          } else if ((skuCount.get(skuKey(sku)) ?? 0) > 1) {
            state = 'WIELOZNACZNE'
            note = `SKU „${sku}” ma kilka ofert tego konta: który towar to który, rozstrzyga człowiek`
          } else {
            const r = await linkBySku(db, ref, row, sku, canCreate, opts, now)
            state = r.state
            note = r.note
            if (r.created) w.newProducts++
            if (r.offer === 'ACTIVE') {
              w.newOffers++
              activated.push(row.externalId)
            }
            if (r.offer === 'PROPOSAL') w.proposals++
            if (r.offer === 'EXISTING') w.kept++
            if (r.productId && !r.created) await noteMismatch(db, w, row, r.productId)
          }
        }
      } catch (e) {
        state = 'BLAD'
        note = errMsg(e)
        await issue('oferta', row.externalId, note)
      }
      if (state === 'BEZ_SKU') w.bezSku++
      if (state === 'WIELOZNACZNE') w.wieloznaczne++
      if (state === 'BEZ_PRODUKTU') w.bezProduktu++
      try {
        await saveRead(db, ref, row, state, note, run.id, now)
      } catch (e) {
        await issue('oferta-zapis', row.externalId, errMsg(e))
      }
    }
    // ilość w kanale inna niż w ostatnim udanym zapisie (sprzedaż, ręczna zmiana w sklepie) = skrót oferty
    // w rejestrze synchronizacji skasowany, następny zapis stanu tej oferty pójdzie do kanału
    try {
      await uniewaznijRozjazdy(db, ref, all.rows.map((r) => ({ externalId: r.externalId, qty: r.qty ?? null })))
    } catch (e) {
      await issue('rejestr', `${ref.channel}/${ref.channelAccountId}`, `porównanie z rejestrem synchronizacji: ${errMsg(e)}`)
    }
    // Oferty, których kanał już nie ma: znikają z listy „Do przypisania” (tylko po pełnym odczycie).
    if (w.complete) await db.channelOfferRead.deleteMany({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId, runId: { not: run.id } } })
    // Zamówienia czekające na te oferty dostają produkty i rezerwacje.
    w.ordersRemapped = (await przeliczZamowienia(db, ref, activated, { now, onError: (id, e) => issue('zamowienie', id, errMsg(e)) })).remapped
    // istniejące produkty bez zdjęcia dostają zdjęcia z oferty (tylko odczyt kanału, zadanie workera)
    try {
      w.zdjecia = await uzupelnijZdjeciaZOfert(db, ref, now)
    } catch (e) {
      await issue('zdjecia', `${ref.channel}/${ref.channelAccountId}`, `zdjęcia produktów z ofert: ${errMsg(e)}`)
    }
  } catch (e) {
    await db.importRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), error: errMsg(e), stats: w as unknown as Prisma.InputJsonValue } })
    throw e
  }
  w.status = w.errors ? 'PARTIAL' : 'OK'
  await db.importRun.update({ where: { id: run.id }, data: { status: w.status, finishedAt: new Date(), stats: w as unknown as Prisma.InputJsonValue } })
  return w
}

async function saveRead(db: PrismaClient, ref: KontoRef, row: ChannelOfferRow, state: StanOferty, note: string | null, runId: string, now: Date): Promise<void> {
  const data = {
    sku: row.sku?.trim() || null,
    ean: normalizeEan(row.ean).ean,
    name: row.name?.slice(0, 300) ?? null,
    qty: row.qty,
    priceGross: row.priceGross ?? null,
    vatRate: row.vatRate ?? null,
    imageUrls: (row.imageUrls ?? []).slice(0, 10),
    active: row.active,
    state,
    note: note?.slice(0, 500) ?? null,
    runId,
    seenAt: now,
  }
  await db.channelOfferRead.upsert({
    where: { organizationId_channel_channelAccountId_externalId: { organizationId: organizationIdOf(db), channel: ref.channel, channelAccountId: ref.channelAccountId, externalId: row.externalId } },
    create: { channel: ref.channel, channelAccountId: ref.channelAccountId, externalId: row.externalId, ...data },
    update: data,
  })
}

/** Rozjazd ilości kanału ze stanem produktu (informacja; nic nie zmieniamy). */
async function noteMismatch(db: PrismaClient, w: WynikOfert, row: ChannelOfferRow, productId: string): Promise<void> {
  if (row.qty === null || w.rozjazdy.length >= MAX_LISTED) return
  const st = await db.stock.findFirst({ where: { productId }, select: { physical: true, reserved: true, product: { select: { sku: true } } } })
  if (!st) return
  // kanał samodzielnie zdejmuje sprzedane sztuki, więc porównujemy z dostępnym, nie fizycznym
  const ours = Math.max(0, st.physical - st.reserved)
  if (ours !== row.qty) w.rozjazdy.push({ externalId: row.externalId, sku: st.product.sku, kanal: row.qty, stan: ours })
}

type LinkResult = { state: StanOferty; note: string | null; created: boolean; productId: string | null; offer: 'ACTIVE' | 'PROPOSAL' | 'EXISTING' | null }

async function linkBySku(db: PrismaClient, ref: KontoRef, row: ChannelOfferRow, sku: string, canCreate: boolean, opts: OfertyOpts, now: Date): Promise<LinkResult> {
  return db.$transaction(async (tx) => {
    let product = await tx.product.findFirst({ where: { sku }, select: { id: true, unit: true } })
    let created = false
    if (!product) {
      const similar = await tx.product.count({ where: { sku: { equals: sku, mode: 'insensitive' } } })
      if (similar > 0) return { state: 'WIELOZNACZNE', note: `SKU „${sku}” różni się od produktu tylko wielkością liter`, created: false, productId: null, offer: null }
      if (!canCreate)
        return {
          state: 'BEZ_PRODUKTU',
          note: opts.hasWfirma || opts.hasBl ? 'brak produktu o tym SKU: firma z BL albo wFirmą zakłada produkty importem' : 'brak produktu o tym SKU',
          created: false,
          productId: null,
          offer: null,
        }
      product = await zalozProdukt(tx, { sku, name: row.name ?? sku, ean: row.ean, priceGross: row.priceGross ?? null, vatRate: row.vatRate ?? null })
      created = true
      await zlecZdjeciaZOferty(tx, product.id, row.imageUrls ?? [])
      await stanStartowy(tx, product.id, row.qty ?? 0, opts.actorId, `stan startowy z kanału ${ref.channel}/${ref.channelAccountId}`, now)
    }
    const offer = await createOffer(tx, ref, row.externalId, product.id, product.unit === 'KG' ? 1000 : 1, 'SKU', opts.hasBl, now)
    return { state: 'POWIAZANA', note: null, created, productId: product.id, offer }
  })
}

async function createOffer(
  tx: Prisma.TransactionClient,
  ref: KontoRef,
  externalId: string,
  productId: string,
  qtyBasePerOffer: number,
  mappingSource: MappingSource,
  proposal: boolean,
  now: Date,
): Promise<'ACTIVE' | 'PROPOSAL' | 'EXISTING'> {
  const found = await tx.channelOffer.findFirst({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId, externalId }, select: { id: true } })
  if (found) return 'EXISTING'
  await tx.channelOffer.create({
    data: {
      channel: ref.channel,
      channelAccountId: ref.channelAccountId,
      externalId,
      productId,
      qtyBasePerOffer,
      mappingSource,
      ...(proposal ? { active: false, needsApproval: true, deactivatedByImportAt: now } : { active: true }),
    },
  })
  return proposal ? 'PROPOSAL' : 'ACTIVE'
}

// ─── Przeliczenie zamówień „Do wyjaśnienia” ──────────────────────────────────
// Wspólny kod z importem katalogu: lib/kanaly/przeliczenie.ts. Reeksport dla dotychczasowych importów.
export { przeliczZamowienia, REMAP_STATUSES }

// ─── „Do przypisania”: przypisanie z panelu ──────────────────────────────────

export interface Przypisanie {
  externalId: string
  productId: string
  qtyBasePerOffer: number
}

/**
 * stan oferty, który wołający widział przed decyzją; inny w chwili zapisu = odmowa
 * („zmieniło się w międzyczasie”). `null` = oferty miało jeszcze nie być. Bez pola: zapis bez sprawdzenia.
 */
export type OczekiwanaOferta = { productId: string; active: boolean; qtyBasePerOffer?: number } | null

const OFFER_ID_RE = /^[\x21-\x7e]{1,200}$/

const ZMIENILO_SIE = 'Powiązanie tej oferty zmieniło się w międzyczasie: odśwież ekran i spróbuj jeszcze raz'

function snapshot(o: ChannelOffer | null) {
  return o ? { productId: o.productId, active: o.active, mappingSource: o.mappingSource, qtyBasePerOffer: o.qtyBasePerOffer, needsApproval: o.needsApproval } : null
}

/**
 * Ręczne powiązanie oferty z produktem (`mappingSource: MANUAL`: import BL i kolejne pobrania jej nie zmieniają) i od
 * razu przeliczenie zamówień czekających na tę ofertę.
 */
export async function przypiszOferte(db: PrismaClient, ref: KontoRef, p: Przypisanie, opts: { actorId: string; now?: Date; expected?: OczekiwanaOferta }): Promise<{ remapped: number; failed: number }> {
  if (!OFFER_ID_RE.test(p.externalId)) throw new KontoError('Zły numer oferty')
  if (!Number.isInteger(p.qtyBasePerOffer) || p.qtyBasePerOffer < 1 || p.qtyBasePerOffer > 100_000) throw new KontoError('Liczba sztuk na ofertę musi być liczbą całkowitą od 1')
  const product = await db.product.findFirst({ where: { id: p.productId, active: true }, select: { id: true, kind: true } })
  if (!product) throw new KontoError('Nie ma takiego produktu')
  await db.$transaction(async (tx) => {
    const before = await tx.channelOffer.findFirst({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId, externalId: p.externalId } })
    if (opts.expected !== undefined) {
      const e = opts.expected
      const zgodne = e === null ? !before : !!before && before.productId === e.productId && before.active === e.active && (e.qtyBasePerOffer === undefined || before.qtyBasePerOffer === e.qtyBasePerOffer)
      if (!zgodne) throw new KontoError(ZMIENILO_SIE)
    }
    const data = { productId: product.id, qtyBasePerOffer: p.qtyBasePerOffer, active: true, mappingSource: 'MANUAL' as const, needsApproval: false, deactivatedByImportAt: null }
    // zapis warunkowy: równoległa zmiana między odczytem a zapisem (druga sesja, „Pobierz oferty”) = odmowa, nie nadpisanie
    if (before && opts.expected) {
      const e = opts.expected
      const n = await tx.channelOffer.updateMany({ where: { id: before.id, productId: e.productId, active: e.active, ...(e.qtyBasePerOffer !== undefined ? { qtyBasePerOffer: e.qtyBasePerOffer } : {}) }, data })
      if (n.count !== 1) throw new KontoError(ZMIENILO_SIE)
    }
    const after = before
      ? opts.expected
        ? await tx.channelOffer.findUniqueOrThrow({ where: { id: before.id } })
        : await tx.channelOffer.update({ where: { id: before.id }, data })
      : await tx.channelOffer.create({ data: { channel: ref.channel, channelAccountId: ref.channelAccountId, externalId: p.externalId, ...data } })
    await tx.channelOfferRead.updateMany({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId, externalId: p.externalId }, data: { state: 'POWIAZANA', note: 'przypisane w panelu' } })
    await tx.auditLog.create({ data: { entity: 'ChannelOffer', entityId: after.id, actorId: opts.actorId, before: snapshot(before) ?? undefined, after: snapshot(after)! } })
  })
  return przeliczZamowienia(db, ref, [p.externalId], { now: opts.now })
}

/**
 * „Utwórz produkt” z oferty z listy: produkt STOCKED/SZT z nazwą i SKU oferty (bez SKU: „<konto>-<oferta>”), stan
 * startowy z kanału, potem przypisanie jak wyżej. Tylko firma bez wFirmy (z wFirmą produkt zakłada import).
 */
export async function utworzProduktZOferty(db: PrismaClient, ref: KontoRef, externalId: string, opts: { actorId: string; hasWfirma: boolean; now?: Date }): Promise<{ productId: string; remapped: number }> {
  if (opts.hasWfirma) throw new KontoError('Firma z wFirmą zakłada produkty importem z wFirmy: przypisz ofertę do istniejącego produktu')
  if (!OFFER_ID_RE.test(externalId)) throw new KontoError('Zły numer oferty')
  const now = opts.now ?? new Date()
  const read = await db.channelOfferRead.findFirst({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId, externalId } })
  const sku = (read?.sku?.trim() || `${ref.channelAccountId}-${externalId.replace(/\//g, '-')}`).slice(0, 100)
  if (await db.product.findFirst({ where: { sku: { equals: sku, mode: 'insensitive' } }, select: { id: true } }))
    throw new KontoError(`Produkt o SKU „${sku}” już jest: przypisz ofertę do niego`)
  const productId = await db.$transaction(async (tx) => {
    const p = await zalozProdukt(tx, { sku, name: read?.name ?? sku, ean: read?.ean ?? null, priceGross: read?.priceGross ? Number(read.priceGross.toString()) : null, vatRate: read?.vatRate ?? null })
    await zlecZdjeciaZOferty(tx, p.id, read?.imageUrls ?? [])
    await stanStartowy(tx, p.id, read?.qty ?? 0, opts.actorId, `stan startowy z kanału ${ref.channel}/${ref.channelAccountId}`, now)
    await tx.auditLog.create({ data: { entity: 'Product', entityId: p.id, actorId: opts.actorId, after: { sku, zKanalu: `${ref.channel}/${ref.channelAccountId}`, oferta: externalId } } })
    return p.id
  })
  const r = await przypiszOferte(db, ref, { externalId, productId, qtyBasePerOffer: 1 }, opts)
  return { productId, remapped: r.remapped }
}

// ─── Zdjęcia produktów z ofert ─────────────────────────────────────

// limit, odstęp i odłożenie po nieudanej próbie są wspólne z feedem produktowym (lib/produkty/zdjecia.ts,
// `zlecPartieZdjec`); stałe zostają też pod tymi nazwami tutaj.
export { ZDJECIA_LIMIT_NA_PRZEBIEG, ZDJECIA_ODSTEP_MS, ZDJECIA_PONOW_PO_MS } from '../produkty/zdjecia'

export interface WynikUzupelnieniaZdjec {
  /** produkty bez zdjęcia z powiązaną ofertą tego konta (albo wszystkich kont) */
  bezZdjecia: number
  /** nowe zlecenia pobrania w tym przebiegu (zadanie `produkt-zdjecia-z-oferty`, po jednym na produkt) */
  zlecone: number
  /** zlecenie tego produktu już czeka w kolejce (z poprzedniego przebiegu) */
  wKolejce: number
  /** bez adresu zdjęcia https w ostatnim odczycie ofert */
  bezAdresu: number
  /** pominięte: pobranie nie udało się w ostatnich 7 dniach */
  odlozone: number
  /** ponad limit przebiegu ({@link ZDJECIA_LIMIT_NA_PRZEBIEG}): zlecenie przy następnym „Pobierz oferty” */
  pominiete: number
  bledy: number
}

/**
 * zdjęcia dla produktów, które już istnieją (import wFirmy albo BL, produkt dodany ręcznie) i mają powiązaną
 * ofertę kanału, a nie mają ani jednego zdjęcia. Adresy z ostatniego odczytu ofert (`ChannelOfferRead.imageUrls`, „Pobierz
 * oferty”), pobranie przez to samo zadanie workera co przy produkcie zakładanym z oferty (https, osłona przed adresami
 * wewnętrznymi, limit rozmiaru). Tylko odczyt kanału; produkt z jakimkolwiek zdjęciem zostaje bez zmian, a usunięte
 * w panelu zdjęcie wraca dopiero wtedy, gdy produkt nie ma żadnego. Każdy produkt osobno (błąd jednego nie przerywa reszty).
 */
export async function uzupelnijZdjeciaZOfert(db: PrismaClient, ref?: KontoRef, now = new Date()): Promise<WynikUzupelnieniaZdjec> {
  const w: WynikUzupelnieniaZdjec = { bezZdjecia: 0, zlecone: 0, wKolejce: 0, bezAdresu: 0, odlozone: 0, pominiete: 0, bledy: 0 }
  const oferty = await db.channelOffer.findMany({
    where: { active: true, ...(ref ? { channel: ref.channel, channelAccountId: ref.channelAccountId } : {}), product: { images: { none: {} } } },
    select: { productId: true, channel: true, channelAccountId: true, externalId: true },
    orderBy: [{ productId: 'asc' }, { createdAt: 'asc' }],
  })
  if (!oferty.length) return w
  // odczyty ofert po koncie (jedno zapytanie na konto)
  const konta = new Map<string, { channel: Channel; channelAccountId: string; ids: string[] }>()
  for (const o of oferty) {
    const k = `${o.channel}:${o.channelAccountId}`
    const x = konta.get(k) ?? { channel: o.channel, channelAccountId: o.channelAccountId, ids: [] }
    x.ids.push(o.externalId)
    konta.set(k, x)
  }
  const adresy = new Map<string, string[]>()
  for (const [k, x] of konta) {
    const rows = await db.channelOfferRead.findMany({ where: { channel: x.channel, channelAccountId: x.channelAccountId, externalId: { in: x.ids } }, select: { externalId: true, imageUrls: true } })
    for (const r of rows) if (r.imageUrls.length) adresy.set(`${k}:${r.externalId}`, r.imageUrls)
  }
  // pierwsza oferta produktu z adresami zdjęć (kolejność: najstarsze powiązanie)
  const doPobrania = new Map<string, string[]>()
  const produkty = new Set<string>()
  for (const o of oferty) {
    produkty.add(o.productId)
    if (doPobrania.has(o.productId)) continue
    const u = adresy.get(`${o.channel}:${o.channelAccountId}:${o.externalId}`)
    if (u) doPobrania.set(o.productId, u)
  }
  w.bezZdjecia = produkty.size
  w.bezAdresu = produkty.size - doPobrania.size
  const z = await zlecPartieZdjec(db, doPobrania, now, 'oferty')
  w.zlecone = z.zlecone
  w.wKolejce = z.wKolejce
  w.bezAdresu += z.bezAdresu
  w.odlozone = z.odlozone
  w.pominiete = z.pominiete
  w.bledy = z.bledy
  return w
}

// ─── Odczyt do ekranu ────────────────────────────────────────────────────────

export interface PozycjaDoPrzypisania {
  externalId: string
  sku: string | null
  name: string | null
  qty: number | null
  state: StanOferty | 'Z_ZAMOWIENIA'
  note: string | null
  /** Zamówienia „Do wyjaśnienia” albo otwarte z pozycją tej oferty bez produktu. */
  orders: number
}

/**
 * Oferty konta bez powiązania (z ostatniego pobrania) i pozycje zamówień bez produktu (numer oferty z zamówienia).
 * Bez danych klienta: tylko numer oferty, nazwa z odczytu ofert i liczba zamówień.
 */
export async function doPrzypisania(db: PrismaClient, ref: { channel: Channel; channelAccountId: string }, limit = 200): Promise<PozycjaDoPrzypisania[]> {
  const [reads, lines, offers] = await Promise.all([
    db.channelOfferRead.findMany({
      where: { channel: ref.channel, channelAccountId: ref.channelAccountId, state: { in: DO_PRZYPISANIA } },
      orderBy: [{ state: 'asc' }, { externalId: 'asc' }],
      take: 2000,
    }),
    db.orderLine.findMany({
      where: { productId: null, removed: false, offerId: { not: null }, order: { channel: ref.channel, channelAccountId: ref.channelAccountId, status: { in: REMAP_STATUSES } } },
      select: { offerId: true, orderId: true },
      take: 5000,
    }),
    db.channelOffer.findMany({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId, active: true }, select: { externalId: true } }),
  ])
  const linked = new Set(offers.map((o) => o.externalId))
  const ordersBy = new Map<string, Set<string>>()
  for (const l of lines) ordersBy.set(l.offerId!, (ordersBy.get(l.offerId!) ?? new Set()).add(l.orderId))
  const out = new Map<string, PozycjaDoPrzypisania>()
  for (const r of reads) {
    if (linked.has(r.externalId)) continue
    out.set(r.externalId, { externalId: r.externalId, sku: r.sku, name: r.name, qty: r.qty, state: r.state as StanOferty, note: r.note, orders: ordersBy.get(r.externalId)?.size ?? 0 })
  }
  for (const [ext, ids] of ordersBy) {
    if (out.has(ext) || linked.has(ext)) continue
    out.set(ext, { externalId: ext, sku: null, name: null, qty: null, state: 'Z_ZAMOWIENIA', note: 'oferta z zamówienia, której nie ma w ostatnim pobraniu ofert', orders: ids.size })
  }
  return [...out.values()].sort((a, b) => b.orders - a.orders || a.externalId.localeCompare(b.externalId)).slice(0, limit)
}
