// Porównanie cienia z BL (spec 9.1–9.2 pkt 1–2): zamówienia BL (getOrders, tylko odczyt, bez danych
// klientów) kontra kopie zamówień kanałów czytanych przez nasze adaptery. Wynik: obecne w kanale a brak w BL i
// odwrotnie, różnice statusu wg mapy 7.1 (status BL po nazwie → nasz status i przewoźnik). Łączenie po numerze
// zamówienia w kanale (shop_order_id sklepu, external_order_id marketplace) → Order.blOrderId.
// Klucz pary: id zamówienia w kanale albo jego numer (Woo z numeracją wtyczki: BL trzyma numer, nie id).
// W cieniu nasze zamówienie nie przechodzi dalej niż „Do realizacji” (pakuje BL), więc BL dalej w realizacji to
// zgodność, nie rozjazd; „Do realizacji” u nas przy „Nowe” w BL to „lepiej niż BL” (spec 7.2), osobno.
import type { Carrier, Channel, OrderStatus, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { channelOfOrder, type ChannelMap } from '../import/normalizacja'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'
import { applyBlJournal, checkJournalError, checkJournalSilent, journalFailed, type JournalRun } from './dziennik-bl'
import { KOPIA_Z_PAROWANIA_FETCHED_AT } from './parowanie-faktur'

export type BlFamily = OrderStatus | 'EBOOK' | 'NIEZNANY'

const FAMILY_RULES: [RegExp, BlFamily][] = [
  [/^nowe/, 'NOWE'],
  [/^e-?book/, 'EBOOK'],
  [/^do realizacji/, 'DO_REALIZACJI'],
  [/^rozpocz\S* zbieranie/, 'ZBIERANIE'],
  [/^zebrane/, 'ZEBRANE'],
  [/^spakowane/, 'SPAKOWANE'],
  [/^do wys/, 'DO_WYSLANIA'],
  [/^do odbioru/, 'DO_ODBIORU'],
  [/^wys[lł]ane/, 'WYSLANE'],
  [/^odebrane/, 'ODEBRANE'],
  [/^anulowane/, 'ANULOWANE'],
  [/^do wyja/, 'DO_WYJASNIENIA'],
  [/^reklamac/, 'REKLAMACJA'],
]

/** Status BL po nazwie (mapa spec 7.1) + przewoźnik z końcówki nazwy („Do realizacji DPD”). */
export function blStatusFamily(name: string): { family: BlFamily; carrier: Carrier | null } {
  const n = name.trim().toLowerCase()
  const family = FAMILY_RULES.find(([re]) => re.test(n))?.[1] ?? 'NIEZNANY'
  const carrier: Carrier | null = /paczkomat/.test(n) ? 'PACZKOMATY' : /dpd/.test(n) ? 'DPD' : /osobist/.test(n) ? 'OSOBISTY' : /allegro/.test(n) ? 'ALLEGRO' : null
  return { family, carrier }
}

export interface BlOrderHeader {
  blOrderId: number
  orderSource: string
  orderSourceId: string
  channel: Channel
  channelAccountId: string
  externalRef: string | null
  statusId: number
  deliveryMethod: string | null
  paymentDone: number | null
  /** Σ pozycji brutto (price_brutto × quantity) + wysyłka; null = pozycji albo cen nie da się odczytać. */
  totalGross: number | null
  /** Potwierdzone w BL (`confirmed`); brak pola = potwierdzone (getOrders bez niepotwierdzonych). */
  confirmed: boolean
  dateAdd: Date
  dateConfirmed: Date | null
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && v !== 0 ? String(v) : null)

/** Kwota zamówienia BL w groszach: pozycje brutto × ilość + wysyłka. Nieczytelna pozycja = null, nie 0. */
export function blOrderTotalCents(o: Record<string, unknown>): number | null {
  const products = o['products']
  if (!Array.isArray(products)) return null
  let cents = 0
  for (const p of products as Record<string, unknown>[]) {
    const price = num(p?.['price_brutto'])
    const qty = num(p?.['quantity'])
    if (price === null || qty === null) return null
    cents += Math.round(price * 100) * qty
  }
  const delivery = o['delivery_price'] === undefined || o['delivery_price'] === null ? 0 : num(o['delivery_price'])
  if (delivery === null) return null
  return Math.round(cents + delivery * 100)
}

/** Nagłówek zamówienia BL: tylko źródło, numery, status, metoda dostawy, wpłata, kwota, daty. Dane klienta nie wychodzą. */
export function blOrderHeader(o: Record<string, unknown>, map: ChannelMap): BlOrderHeader | null {
  const id = num(o['order_id'])
  const statusId = num(o['order_status_id'])
  const dateAdd = num(o['date_add'])
  if (id === null || statusId === null || dateAdd === null) return null
  const source = String(o['order_source'] ?? '')
  const sourceId = String(o['order_source_id'] ?? '')
  const { channel, accountId } = channelOfOrder(source, sourceId, map)
  const conf = num(o['date_confirmed'])
  return {
    blOrderId: id,
    orderSource: source,
    orderSourceId: sourceId,
    channel,
    channelAccountId: accountId,
    externalRef: source === 'shop' ? str(o['shop_order_id']) : str(o['external_order_id']),
    statusId,
    deliveryMethod: str(o['delivery_method']),
    paymentDone: num(o['payment_done']),
    totalGross: ((c) => (c === null ? null : c / 100))(blOrderTotalCents(o)),
    confirmed: o['confirmed'] !== false && o['confirmed'] !== 0 && o['confirmed'] !== '0',
    dateAdd: new Date(dateAdd * 1000),
    dateConfirmed: conf ? new Date(conf * 1000) : null,
  }
}

export interface BlFetch {
  headers: BlOrderHeader[]
  statuses: Map<number, string>
  complete: boolean
  errors: string[]
}

/** Zamówienia BL potwierdzone od `fromUnix` (paginacja po date_confirmed jak w imporcie) + lista statusów. */
export async function fetchBlOrders(bl: BaseLinkerReadOnly, fromUnix: number, map: ChannelMap): Promise<BlFetch> {
  const errors: string[] = []
  const statuses = new Map<number, string>()
  const st = await bl.call<{ statuses?: { id?: unknown; name?: unknown }[] }>('getOrderStatusList')
  for (const s of st.statuses ?? []) {
    const id = num(s.id)
    if (id !== null && typeof s.name === 'string') statuses.set(id, s.name)
  }
  const headers: BlOrderHeader[] = []
  const seen = new Set<number>()
  let from = fromUnix
  let complete = true
  for (let guard = 0; guard < 500; guard++) {
    let batch: Record<string, unknown>[]
    try {
      const r = await bl.call<{ orders: Record<string, unknown>[] }>('getOrders', { date_confirmed_from: from, get_unconfirmed_orders: false })
      batch = Array.isArray(r.orders) ? r.orders : []
    } catch (e) {
      errors.push(`getOrders od ${from}: ${e instanceof Error ? e.message : String(e)}`)
      complete = false
      break
    }
    let fresh = 0
    for (const o of batch) {
      const h = blOrderHeader(o, map)
      if (!h) {
        errors.push('zamówienie BL bez numeru, statusu albo daty — pominięte')
        continue
      }
      if (seen.has(h.blOrderId)) continue
      seen.add(h.blOrderId)
      fresh++
      headers.push(h)
    }
    if (batch.length < 100) break
    if (fresh === 0) {
      errors.push('pełna paczka bez nowych zamówień (ta sama sekunda)')
      complete = false
      break
    }
    // Założenie: strona `getOrders` po `date_confirmed_from` jest posortowana rosnąco po
    // `date_confirmed`, więc ostatnia pozycja niesie najpóźniejszą datę. Do sprawdzenia na żywo przy pierwszym dniu
    // > 100 zamówień (inaczej kolejna strona może pominąć zamówienia ze środka paczki).
    const last = num(batch[batch.length - 1]?.['date_confirmed'])
    from = last ?? from + 1
  }
  return { headers, statuses, complete, errors }
}

/**
 * Zamówienia BL złożone (date_add) w [fromUnix, toUnix) — sprzedaż dnia. `date_from` filtruje po dacie
 * złożenia, strony po `id_from` (rosnące numery BL), z niepotwierdzonymi (liczone osobno). Tylko get*.
 */
export async function fetchBlOrdersAdded(bl: BaseLinkerReadOnly, fromUnix: number, toUnix: number, map: ChannelMap): Promise<{ headers: BlOrderHeader[]; complete: boolean; errors: string[] }> {
  const errors: string[] = []
  const headers: BlOrderHeader[] = []
  const seen = new Set<number>()
  let idFrom = 0
  let complete = true
  for (let guard = 0; ; guard++) {
    if (guard >= 500) {
      errors.push('ponad 500 stron getOrders — przerwane')
      complete = false
      break
    }
    let batch: Record<string, unknown>[]
    try {
      const r = await bl.call<{ orders: Record<string, unknown>[] }>('getOrders', { date_from: fromUnix, ...(idFrom ? { id_from: idFrom } : {}), get_unconfirmed_orders: true })
      batch = Array.isArray(r.orders) ? r.orders : []
    } catch (e) {
      errors.push(`getOrders od ${fromUnix} (id ${idFrom}): ${e instanceof Error ? e.message : String(e)}`)
      complete = false
      break
    }
    let fresh = 0
    let maxId = idFrom
    for (const o of batch) {
      const h = blOrderHeader(o, map)
      if (!h) {
        errors.push('zamówienie BL bez numeru, statusu albo daty — pominięte')
        complete = false
        continue
      }
      maxId = Math.max(maxId, h.blOrderId)
      if (seen.has(h.blOrderId)) continue
      seen.add(h.blOrderId)
      fresh++
      const t = h.dateAdd.getTime() / 1000
      if (t >= fromUnix && t < toUnix) headers.push(h)
    }
    if (batch.length < 100) break
    if (fresh === 0) {
      errors.push('pełna paczka bez nowych zamówień')
      complete = false
      break
    }
    // Założenie: strona `getOrders` z `date_from` + `id_from` jest posortowana rosnąco po
    // `order_id` (pierwsze 100 od `id_from`), więc `maxId + 1` niczego nie przeskakuje. Do sprawdzenia na żywo przy
    // pierwszym dniu > 100 zamówień (porównać liczbę z BL z panelem BL).
    idFrom = maxId + 1
  }
  return { headers, complete, errors }
}

// ─── Porównanie (czysta funkcja) ─────────────────────────────────────────────

export type StatusVerdict = 'ZGODNE' | 'BL_DALEJ' | 'LEPIEJ_NIZ_BL' | 'PRZEWOZNIK' | 'U_NAS_DO_WYJASNIENIA' | 'ROZJAZD' | 'BL_NIEZNANY'

const IN_PROGRESS: BlFamily[] = ['ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE']
const SHIPPED: BlFamily[] = ['WYSLANE', 'ODEBRANE', 'DO_ODBIORU', 'DO_WYSLANIA', 'SPAKOWANE']
const normCarrier = (c: Carrier | null | undefined) => (c === 'DPD_EMPIK' ? 'DPD' : (c ?? null))

export type OurSide = { kind: 'ORDER'; status: OrderStatus; carrier: Carrier | null } | { kind: 'SKIPPED_FULFILLED' } | { kind: 'NOT_INGESTED' }

export function classifyStatus(our: OurSide, bl: { family: BlFamily; carrier: Carrier | null }): StatusVerdict {
  if (bl.family === 'NIEZNANY' || bl.family === 'EBOOK') return 'BL_NIEZNANY'
  if (our.kind === 'SKIPPED_FULFILLED') return SHIPPED.includes(bl.family) ? 'ZGODNE' : 'ROZJAZD'
  if (our.kind === 'NOT_INGESTED') return 'ROZJAZD'
  const carrierOk = !bl.carrier || normCarrier(our.carrier) === normCarrier(bl.carrier)
  if (our.status === 'ANULOWANE' || bl.family === 'ANULOWANE') return our.status === bl.family ? 'ZGODNE' : 'ROZJAZD'
  if (our.status === 'DO_WYJASNIENIA') return bl.family === 'DO_WYJASNIENIA' ? 'ZGODNE' : 'U_NAS_DO_WYJASNIENIA'
  if (our.status === 'DO_REALIZACJI') {
    if (bl.family === 'NOWE') return 'LEPIEJ_NIZ_BL'
    if (bl.family === 'DO_REALIZACJI') return carrierOk ? 'ZGODNE' : 'PRZEWOZNIK'
    if (IN_PROGRESS.includes(bl.family)) return carrierOk ? 'BL_DALEJ' : 'PRZEWOZNIK'
    return 'ROZJAZD'
  }
  if (our.status === bl.family) return carrierOk ? 'ZGODNE' : 'PRZEWOZNIK'
  return 'ROZJAZD'
}

export interface SnapRow {
  channel: Channel
  channelAccountId: string
  externalId: string
  /** Numer w kanale/BL, gdy inny niż id — BL łączy sklep po numerze (shop_order_id). */
  channelNumber?: string | null
  channelStatus: string
  lifecycle: string
  skipReason: string | null
  orderId: string | null
  createdAtChannel: Date
}

export interface OrderRow {
  id: string
  status: OrderStatus
  carrier: Carrier | null
  activeReservations: number
}

export interface AccountInfo {
  channel: Channel
  channelAccountId: string
  name: string
  /** Konto czytane przez nasz adapter; od kiedy odczyt pokrywa kanał. */
  coverageFrom: Date | null
}

export interface AccountComparison {
  channel: Channel
  channelAccountId: string
  name: string
  polled: boolean
  inChannel: number
  inBl: number
  paired: number
  missingInBl: number
  missingInBlByStatus: Record<string, number>
  missingHere: number
  missingHereByBlStatus: Record<string, number>
  verdicts: Record<StatusVerdict, number>
  divergences: Record<string, number> // „nasz → BL” dla ROZJAZD i PRZEWOZNIK
  activeReservationsBlAhead: number // aktywne rezerwacje na zamówieniach, które BL już pakuje/wysłał (faktura w BL)
}

export interface CompareInput {
  accounts: AccountInfo[]
  snaps: SnapRow[]
  bl: BlOrderHeader[]
  statuses: Map<number, string>
  orders: Map<string, OrderRow>
  windowFrom: Date
  now: Date
  graceMs: number
  /** Margines po początku pokrycia, zanim „brak u nas” się liczy (BL importuje z opóźnieniem). */
  coverageMarginMs: number
}

const emptyVerdicts = (): Record<StatusVerdict, number> => ({ ZGODNE: 0, BL_DALEJ: 0, LEPIEJ_NIZ_BL: 0, PRZEWOZNIK: 0, U_NAS_DO_WYJASNIENIA: 0, ROZJAZD: 0, BL_NIEZNANY: 0 })
const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1)
const accKey = (c: Channel, a: string) => `${c}|${a}`

export interface Pairing {
  snapExternalId: string
  channel: Channel
  channelAccountId: string
  blOrderId: number
  statusId: number
  orderId: string | null
}

export function compareShadowWithBl(input: CompareInput): { accounts: AccountComparison[]; pairings: Pairing[]; unpolled: Record<string, number> } {
  const cutoff = input.now.getTime() - input.graceMs
  const blByKey = new Map<string, BlOrderHeader>()
  for (const h of input.bl) if (h.externalRef) blByKey.set(`${accKey(h.channel, h.channelAccountId)}|${h.externalRef}`, h)
  const snapByKey = new Map<string, SnapRow>()
  for (const s of input.snaps) {
    snapByKey.set(`${accKey(s.channel, s.channelAccountId)}|${s.externalId}`, s)
    if (s.channelNumber) snapByKey.set(`${accKey(s.channel, s.channelAccountId)}|${s.channelNumber}`, s)
  }
  const blOf = (k: string, s: SnapRow) => blByKey.get(`${k}|${s.externalId}`) ?? (s.channelNumber ? blByKey.get(`${k}|${s.channelNumber}`) : undefined)
  const polled = new Map(input.accounts.map((a) => [accKey(a.channel, a.channelAccountId), a]))
  const out: AccountComparison[] = []
  const pairings: Pairing[] = []
  for (const a of input.accounts) {
    const k = accKey(a.channel, a.channelAccountId)
    const r: AccountComparison = {
      channel: a.channel,
      channelAccountId: a.channelAccountId,
      name: a.name,
      polled: !!a.coverageFrom,
      inChannel: 0,
      inBl: 0,
      paired: 0,
      missingInBl: 0,
      missingInBlByStatus: {},
      missingHere: 0,
      missingHereByBlStatus: {},
      verdicts: emptyVerdicts(),
      divergences: {},
      activeReservationsBlAhead: 0,
    }
    for (const s of input.snaps) {
      if (accKey(s.channel, s.channelAccountId) !== k || s.lifecycle === 'DRAFT') continue
      const t = s.createdAtChannel.getTime()
      if (t < input.windowFrom.getTime() || t > cutoff) continue
      r.inChannel++
      const h = blOf(k, s)
      if (!h) {
        r.missingInBl++
        inc(r.missingInBlByStatus, s.channelStatus)
        continue
      }
      r.paired++
      pairings.push({ snapExternalId: s.externalId, channel: s.channel, channelAccountId: s.channelAccountId, blOrderId: h.blOrderId, statusId: h.statusId, orderId: s.orderId })
      const blFam = blStatusFamily(input.statuses.get(h.statusId) ?? '')
      const o = s.orderId ? input.orders.get(s.orderId) : undefined
      const our: OurSide = o ? { kind: 'ORDER', status: o.status, carrier: o.carrier } : s.skipReason === 'zrealizowane-przed-pierwszym-odczytem' ? { kind: 'SKIPPED_FULFILLED' } : { kind: 'NOT_INGESTED' }
      const v = classifyStatus(our, blFam)
      r.verdicts[v]++
      if (v === 'ROZJAZD' || v === 'PRZEWOZNIK') {
        const ours = our.kind === 'ORDER' ? `${our.status}${our.carrier ? `/${our.carrier}` : ''}` : our.kind
        inc(r.divergences, `${ours} → ${input.statuses.get(h.statusId) ?? h.statusId}`)
      }
      if (o && o.activeReservations > 0 && IN_PROGRESS.includes(blFam.family)) r.activeReservationsBlAhead += o.activeReservations
    }
    for (const h of input.bl) {
      if (accKey(h.channel, h.channelAccountId) !== k) continue
      const t = h.dateAdd.getTime()
      if (t < input.windowFrom.getTime() || t > cutoff) continue
      r.inBl++
      if (!a.coverageFrom || t < a.coverageFrom.getTime() + input.coverageMarginMs) continue
      if (!h.externalRef || !snapByKey.has(`${k}|${h.externalRef}`)) {
        r.missingHere++
        inc(r.missingHereByBlStatus, input.statuses.get(h.statusId) ?? String(h.statusId))
      }
    }
    out.push(r)
  }
  // źródła BL bez naszego adaptera (Allegro, InPost Buy, TikTok, ręczne)
  const unpolled: Record<string, number> = {}
  for (const h of input.bl) {
    const k = accKey(h.channel, h.channelAccountId)
    const a = polled.get(k)
    if (a?.coverageFrom) continue
    const t = h.dateAdd.getTime()
    if (t < input.windowFrom.getTime() || t > cutoff) continue
    inc(unpolled, a ? `${a.name} (${h.channel})` : `${h.orderSource}:${h.orderSourceId}`)
  }
  return { accounts: out, pairings, unpolled }
}

// ─── Przebieg z bazą ─────────────────────────────────────────────────────────

export interface ComparisonRun {
  windowFrom: Date
  now: Date
  blComplete: boolean
  blErrors: string[]
  accounts: AccountComparison[]
  unpolled: Record<string, number>
  /** Dziennik zdarzeń BL; błąd odczytu w `journal.error` i w `blErrors`. */
  journal: JournalRun
  /** Odświeżanie zapasowe kopii spoza okna. */
  refresh: SnapshotRefresh
}

export interface ComparisonOpts {
  now?: Date
  windowMs?: number
  graceMs?: number
  coverageMarginMs?: number
}

/** Wspólny zapis kopii nagłówka BL (porównanie i odświeżanie zapasowe). Chwili zmiany statusu nie rusza (zna ją tylko dziennik). */
async function saveBlSnapshot(db: PrismaClient, organizationId: string, h: BlOrderHeader, statuses: Map<number, string>, now: Date): Promise<void> {
  const data = {
    orderSource: h.orderSource,
    orderSourceId: h.orderSourceId,
    channel: h.channel,
    channelAccountId: h.channelAccountId,
    externalRef: h.externalRef,
    statusId: h.statusId,
    statusName: statuses.get(h.statusId) ?? null,
    deliveryMethod: h.deliveryMethod,
    paymentDone: h.paymentDone === null ? null : h.paymentDone.toFixed(2),
    totalGross: h.totalGross === null ? null : h.totalGross.toFixed(2),
    confirmed: h.confirmed,
    dateAdd: h.dateAdd,
    dateConfirmed: h.dateConfirmed,
    fetchedAt: now,
  }
  await db.blOrderSnapshot.upsert({ where: { organizationId_blOrderId: { organizationId, blOrderId: h.blOrderId } }, create: { blOrderId: h.blOrderId, ...data }, update: data })
}

/** Limit odświeżeń zapasowych na przebieg (BL: 100 zapytań/min na token, porównanie co 10 min). */
export const REFRESH_MAX_PER_RUN = 60
/** Kopia starsza niż doba (bez odczytu getOrders ani zdarzenia dziennika) idzie do odświeżenia zapasowego. */
export const REFRESH_STALE_MS = 24 * 3600_000
/**
 * Rodziny bez dalszego planu: kopia w nich już nie da akcji (Wysłane, Odebrane, Anulowane), a „E-book” i statusy spoza
 * mapy reguły planu pomijają (rozjazdy liczą je jako `BL_NIEZNANY`) —: bez tego zamówienie, które
 * na stałe zostaje w „E-book”, zjadałoby co dobę jedno odświeżenie zapasowe bez końca.
 */
const NO_PLAN_FAMILIES: BlFamily[] = ['WYSLANE', 'ODEBRANE', 'ANULOWANE', 'EBOOK', 'NIEZNANY']

export interface SnapshotRefresh {
  /** Kopie sprawdzone przez getOrders po numerze. */
  checked: number
  /** Zmiana statusu wykryta przy odświeżeniu. */
  statusChanged: number
  /** Zamówienie zwrócone pusto (usunięte w BL): `fetchedAt` podbite, żeby nie blokowało kolejki. */
  gone: number
  failed: number
}

/**
 * Zapas, gdy dziennik milczy albo ma lukę: kopie sparowane z `Order.blOrderId`, w statusach, które mogą
 * jeszcze dać plan (bez `NO_PLAN_FAMILIES`),
 * bez odczytu od doby — `getOrders` z `order_id`, najstarsze `fetchedAt` najpierw, do `REFRESH_MAX_PER_RUN`. Błąd
 * jednego zamówienia nie przerywa reszty. Chwili zmiany statusu ta ścieżka nie zna (`statusChangedAt` bez zmian).
 */
async function refreshStaleSnapshots(db: PrismaClient, bl: BaseLinkerReadOnly, map: ChannelMap, statuses: Map<number, string>, now: Date, errors: string[]): Promise<SnapshotRefresh> {
  const organizationId = organizationIdOf(db)
  const r: SnapshotRefresh = { checked: 0, statusChanged: 0, gone: 0, failed: 0 }
  // lista dozwolonych statusów (nie wykluczonych): status spoza getOrderStatusList (usunięty w BL) też nie wchodzi
  const activeIds = [...statuses].filter(([, name]) => !NO_PLAN_FAMILIES.includes(blStatusFamily(name).family)).map(([id]) => id)
  if (!activeIds.length) return r
  // kopia z parowania od strony faktury nie zna nazwy statusu (np. „Wysłane”): jeden odczyt ją uzupełnia, inaczej przy
  // statusie końcowym zostałaby bez nazwy na zawsze
  const where = {
    organizationId,
    fetchedAt: { lt: new Date(now.getTime() - REFRESH_STALE_MS) },
    OR: [{ statusId: { in: activeIds } }, { statusName: null, fetchedAt: KOPIA_Z_PAROWANIA_FETCHED_AT }],
  }
  // stronami po najstarszych: kopie niesparowane (źródła bez adaptera) nie blokują sparowanych
  const picked: { blOrderId: number; statusId: number }[] = []
  for (let page = 0; page < 10 && picked.length < REFRESH_MAX_PER_RUN; page++) {
    const rows = await db.blOrderSnapshot.findMany({ where, orderBy: [{ fetchedAt: 'asc' }, { blOrderId: 'asc' }], skip: page * 500, take: 500, select: { blOrderId: true, statusId: true } })
    if (!rows.length) break
    const paired = new Set((await db.order.findMany({ where: { blOrderId: { in: rows.map((x) => x.blOrderId) } }, select: { blOrderId: true } })).map((o) => o.blOrderId))
    for (const x of rows) if (paired.has(x.blOrderId) && picked.length < REFRESH_MAX_PER_RUN) picked.push(x)
    if (rows.length < 500) break
  }
  for (const x of picked) {
    try {
      const res = await bl.call<{ orders?: Record<string, unknown>[] }>('getOrders', { order_id: x.blOrderId, get_unconfirmed_orders: true })
      const o = (Array.isArray(res.orders) ? res.orders : []).find((y) => num(y?.['order_id']) === x.blOrderId)
      const h = o ? blOrderHeader(o, map) : null
      r.checked++
      if (!h) {
        // usunięte w BL (albo nieczytelne): bez podbicia stałoby na czele kolejki w każdym przebiegu
        await db.blOrderSnapshot.update({ where: { organizationId_blOrderId: { organizationId, blOrderId: x.blOrderId } }, data: { fetchedAt: now } })
        r.gone++
        continue
      }
      if (h.statusId !== x.statusId) r.statusChanged++
      await saveBlSnapshot(db, organizationId, h, statuses, now)
    } catch (e) {
      r.failed++
      if (r.failed <= 3) errors.push(`odświeżenie kopii BL ${x.blOrderId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return r
}

/**
 * Pobiera BL (od początku okna minus doba zapasu), zapisuje kopie nagłówków, łączy pary (Order.blOrderId, kopia
 * kanału) i zwraca porównanie. Odczyt BL tylko get*; zapis wyłącznie w naszej bazie.
 *
 * po zapisie kopii z okna — dziennik zdarzeń BL (zmiany statusu starszych zamówień z chwilą zmiany) i
 * odświeżanie zapasowe kopii spoza okna. Każde w osobnym try/catch: ich błąd idzie do `blErrors`, porównanie zostaje.
 */
export async function runBlComparison(db: PrismaClient, bl: BaseLinkerReadOnly, map: ChannelMap, accountNames: AccountInfo[], opts: ComparisonOpts = {}): Promise<ComparisonRun> {
  const now = opts.now ?? new Date()
  const windowFrom = new Date(now.getTime() - (opts.windowMs ?? 24 * 3600_000))
  const graceMs = opts.graceMs ?? 20 * 60_000
  const organizationId = organizationIdOf(db) // klient firmy (RLS): kopie BL i pary tylko tej firmy
  const f = await fetchBlOrders(bl, Math.floor((windowFrom.getTime() - 24 * 3600_000) / 1000), map)
  const before = f.headers.length
    ? new Map((await db.blOrderSnapshot.findMany({ where: { organizationId, blOrderId: { in: f.headers.map((h) => h.blOrderId) } }, select: { blOrderId: true, statusId: true } })).map((x) => [x.blOrderId, x.statusId]))
    : new Map<number, number>()
  let statusChangesSeen = 0
  for (const h of f.headers) {
    const prev = before.get(h.blOrderId)
    if (prev !== undefined && prev !== h.statusId) statusChangesSeen++
    await saveBlSnapshot(db, organizationId, h, f.statuses, now)
  }
  let journal: JournalRun
  try {
    const { errors, ...j } = await applyBlJournal(db, bl, f.statuses, now)
    journal = j
    f.errors.push(...errors)
  } catch (e) {
    const m = `dziennik BL: ${e instanceof Error ? e.message : String(e)}`
    journal = journalFailed(m)
    f.errors.push(m)
    try {
      await checkJournalError(db, m, now) // doba samych błędów = alert, nie tylko wpis w ImportRun.error
    } catch (e2) {
      f.errors.push(`alert dziennika BL: ${e2 instanceof Error ? e2.message : String(e2)}`)
    }
  }
  let refresh: SnapshotRefresh = { checked: 0, statusChanged: 0, gone: 0, failed: 0 }
  try {
    refresh = await refreshStaleSnapshots(db, bl, map, f.statuses, now, f.errors)
    statusChangesSeen += refresh.statusChanged
    if (!journal.error) await checkJournalSilent(db, statusChangesSeen, now) // przy błędzie dziennika alarmuje `BL_DZIENNIK_BLAD`, nie podwójnie
  } catch (e) {
    f.errors.push(`odświeżenie kopii BL: ${e instanceof Error ? e.message : String(e)}`)
  }
  const snaps = await db.channelOrderSnapshot.findMany({
    where: { createdAtChannel: { gte: windowFrom } },
    select: { channel: true, channelAccountId: true, externalId: true, channelNumber: true, channelStatus: true, lifecycle: true, skipReason: true, orderId: true, createdAtChannel: true },
  })
  const orderIds = snaps.map((s) => s.orderId).filter((x): x is string => !!x)
  const orderRows = orderIds.length
    ? await db.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, status: true, carrier: true, reservations: { where: { state: 'ACTIVE' }, select: { qtyBase: true } } } })
    : []
  const orders = new Map(orderRows.map((o) => [o.id, { id: o.id, status: o.status, carrier: o.carrier, activeReservations: o.reservations.reduce((s, r) => s + r.qtyBase, 0) }]))
  const res = compareShadowWithBl({ accounts: accountNames, snaps, bl: f.headers, statuses: f.statuses, orders, windowFrom, now, graceMs, coverageMarginMs: opts.coverageMarginMs ?? 30 * 60_000 })
  // łączenie par (spec 9.1): kopia kanału i zamówienie rdzenia dostają numer BL
  for (const p of res.pairings) {
    try {
      await db.channelOrderSnapshot.update({
        where: { organizationId_channel_channelAccountId_externalId: { organizationId, channel: p.channel, channelAccountId: p.channelAccountId, externalId: p.snapExternalId } },
        data: { blOrderId: p.blOrderId, blStatusId: p.statusId, blCheckedAt: now },
      })
      if (p.orderId) await db.order.updateMany({ where: { id: p.orderId, blOrderId: null }, data: { blOrderId: p.blOrderId } })
    } catch {
      // jedna para nie zatrzymuje reszty; zostanie połączona przy następnym porównaniu
    }
  }
  return { windowFrom, now, blComplete: f.complete, blErrors: f.errors, accounts: res.accounts, unpolled: res.unpolled, journal, refresh }
}
