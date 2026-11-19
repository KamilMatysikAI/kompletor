// Sprzedaż dnia kontra BL (krok 0): codziennie liczba zamówień i kwota brutto (z wysyłką) złożonych danego
// dnia (Europe/Warsaw) per konto kanału — w Kompletorze z tego samego źródła co pulpit „Dziś” (`salesOrders`)
// i w BL (`getOrders` po date_add, tylko get*). Różnica liczby ≠ 0 albo kwoty > 0,01 zł → Alert
// `SPRZEDAZ_DNIA_ROZJAZD` z numerami zamówień, które się różnią (bez danych osobowych), i wpis w ShadowDailyCheck
// (raport rozjazdów). Zgodny dzień zamknięty (sprawdzony po północy) liczy się do kryterium 7 dni cienia bez rozjazdów.
// Powód: 26.10.2026 rozjazd pulpitu z BL (3 / 279,85 zł kontra 8 / 842,61 zł) wyłapał człowiek zrzutem, nie system.
import type { Channel, Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import type { ChannelMap } from '../import/normalizacja'
import { salesOrders, type SalesOrder } from '../panel/dane'
import { SALES_COUNT_CANCELLED } from '../panel/format'
import { addDays, fromWarsaw, type IsoDay, toWarsaw } from '../rdzen/kalendarz'
import { alert } from '../rdzen/stan'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'
import { type AccountInfo, type BlOrderHeader, fetchBlOrdersAdded } from './bl-porownanie'

export const SALES_CHECK = 'sprzedaz-dnia'
/** Ile po północy zamykamy dzień poprzedni (BL importuje zamówienia z kanałów z opóźnieniem). */
export const DAY_CLOSE_MARGIN_MS = 30 * 60_000
/** Sprawdzenie „za dziś” na żądanie: zamówienia z ostatnich minut pomijamy po obu stronach (import BL w drodze). */
export const TODAY_GRACE_MS = 20 * 60_000
const TOLERANCE_CENTS = 1
/**
 * Margines parowania z BL wokół doby: BL `date_add` może być chwilą importu, nie
 * złożenia w sklepie, więc zamówienie z 23:58 bywa w BL po północy. Pary szukamy w oknie doba ± 2 h po obu stronach,
 * a dzień przypisuje nasza strona (data złożenia w kanale).
 */
export const PAIR_MARGIN_MS = 2 * 3600_000
/**
 * Statusy Woo, których BL zwykle nie importuje, dopóki są nieopłacone (Empik do potwierdzenia na żywo). Nie
 * zawsze: zamówienie w statusie `failed` bywa w BL z numerem; takie zamówienie ma parę i liczy się zwykle, lista dotyczy
 * tylko zamówień bez pary.
 */
const NOT_IMPORTED_WOO = new Set(['pending', 'failed'])
const MAX_LISTED = 50
/** Ile dni wstecz przeliczamy dzień po spóźnionym imporcie BL: tyle, ile trwa seria kryterium;
 *  starszy dzień ma odczyt BL dłuższy o każdą dobę, a przeliczyć go można na żądanie. */
export const RECHECK_MAX_DAYS_BACK = 7

export interface DayOrder {
  /** Numer do wyjaśnienia: numer w kanale/BL, inaczej id zamówienia w kanale. */
  ref: string
  keys: string[]
  cents: number
}

export interface AccountDaySales {
  channel: Channel
  channelAccountId: string
  name: string
  /** Konto czytane przez nasz adapter (pokrycie odczytem) — tylko takie porównujemy. */
  compared: boolean
  /** `count`/`cents` — wszystkie nasze zamówienia dnia (z anulowanymi: BL importuje opłacone i potem anulowane).
   *  Rozbicie jak pulpit (`OutsideCore`): `cancelled` — anulowane (rdzeń ANULOWANE, kopia CANCELLED);
   *  `beforeStart`/`notIngested`/`skipped` — spoza realizacji systemu, przy `SALES_COUNT_CANCELLED = false` bez anulowanych. */
  ours: { count: number; cents: number; beforeStart: number; notIngested: number; skipped: number; cancelled: number }
  /** Nasze zamówienia dnia bez pary w BL, których BL zwykle nie importuje (Woo pending/failed nieopłacone, anulowane przez
   *  kanał bez płatności) — informacja, nie rozjazd. Liczą się w `ours`. */
  notImportedByBl: string[]
  /** Nasze zamówienia dnia, które BL ma z `date_add` po oknie parowania (import BL z opóźnieniem > 2 h)
   *  numer i dzień w BL — informacja, nie rozjazd (inna kwota idzie do `amountDiffs`). Liczą się w `ours`, nie w
   *  `bl` tego dnia. */
  blLaterImport: { ref: string; blDay: IsoDay }[]
  bl: { count: number; cents: number; unconfirmed: number; unreadableTotal: number }
  /** Zamówienia BL dnia bez pary w oknie, które u nas są złożone innego dnia (BL zaimportował je z opóźnieniem > 2 h,
   *  np. Woo `pending` opłacone następnego dnia): numer i dzień naszego zamówienia — informacja, nie
   *  rozjazd (inna kwota idzie do `amountDiffs`). Liczą się w `bl` (tak je widać w BL). */
  blDelayedImport: { ref: string; ourDay: IsoDay }[]
  onlyHere: string[]
  onlyBl: string[]
  amountDiffs: { ref: string; oursCents: number; blCents: number | null }[]
  ok: boolean
}

export interface DaySalesResult {
  day: IsoDay
  final: boolean
  from: Date
  to: Date
  blComplete: boolean
  blErrors: string[]
  accounts: AccountDaySales[]
  /** Źródła BL bez naszego konta/adaptera: liczba zamówień i kwota (bez porównania). */
  notCompared: { key: string; count: number; cents: number }[]
  ok: boolean
}

const accKey = (c: string, a: string) => `${c}|${a}`
const refKey = (c: string, a: string, ref: string) => `${accKey(c, a)}|${ref}`

/** Granice doby `day` w strefie Warszawy. */
export function warsawDay(day: IsoDay): { from: Date; to: Date } {
  return { from: fromWarsaw(day, 0), to: fromWarsaw(addDays(day, 1), 0) }
}

/** Dzień do zamknięcia po północy: wczorajszy (Warszawa), gdy od jego końca minął margines; inaczej null. */
export function dayToClose(now: Date): IsoDay | null {
  const today = toWarsaw(now).day
  const yesterday = addDays(today, -1)
  return now.getTime() - warsawDay(yesterday).to.getTime() >= DAY_CLOSE_MARGIN_MS ? yesterday : null
}

const toCents = (v: string | number) => Math.round(Number(v) * 100)

/** Anulowane jak w `salesRows` pulpitu: rdzeń po statusie, kopia bez rdzenia po cyklu życia. */
const isCancelled = (o: SalesOrder) => (o.orderStatus !== null ? o.orderStatus === 'ANULOWANE' : o.lifecycle === 'CANCELLED')

/** Nasze zamówienie spoza okna parowania znalezione po numerze (import BL z opóźnieniem). */
export interface OurOrderElsewhere {
  channel: Channel
  channelAccountId: string
  externalId: string
  channelNumber: string | null
  createdAtChannel: Date
  /** Kwota jak w `salesOrders`: z rdzenia, kopia tylko bez rdzenia. */
  gross: string
}

/**
 * Zamówienie, którego BL zwykle nie importuje: anulowane przez kanał i nigdy nieopłacone, nieprzyjęta kopia
 * anulowana w kanale albo Woo `pending`/`failed` bez płatności (`failed` jest otwarte, rozpoznanie po
 * statusie kopii). Dotyczy tylko zamówień bez pary w BL — sparowane liczą się zwykle.
 */
export function notImportedByBl(o: SalesOrder): boolean {
  if (o.paymentState !== null && o.paymentState !== 'UNPAID') return false
  if (o.orderStatus === 'ANULOWANE' && o.cancelReason === 'CANCELLED') return true
  if (o.orderStatus === null && o.lifecycle === 'CANCELLED') return true
  return o.channel === 'WOO' && o.channelStatus !== null && NOT_IMPORTED_WOO.has(o.channelStatus)
}

/**
 * Porównanie (czysta funkcja): nasze zamówienia dnia kontra nagłówki BL złożone tego dnia, per konto. Łączenie po
 * koncie + numerze (id zamówienia w kanale albo numer z wtyczki, jak w porównaniu cienia). `ours` i `bl` mogą
 * obejmować szersze okno (doba ± PAIR_MARGIN_MS): pary szukamy w całym oknie, dzień przypisuje nasza strona —
 * BL sparowany z naszym zamówieniem dnia liczy się do dnia niezależnie od `date_add`, BL sparowany z naszym
 * zamówieniem innego dnia nie liczy się wcale, BL bez pary — po swoim `date_add`. Niepotwierdzone w BL nie liczą się
 * do sprzedaży BL (osobny licznik). Konta bez pokrycia odczytem → `notCompared`. Konto zgodne = puste listy różnic
 * nie same równe sumy (zamiana zamówienia na inne o tej samej kwocie to rozjazd).
 */
export function compareDaySales(input: {
  day: IsoDay
  final: boolean
  from: Date
  to: Date
  ours: SalesOrder[]
  bl: BlOrderHeader[]
  blComplete: boolean
  blErrors: string[]
  accounts: AccountInfo[]
  /** Nagłówki BL z `date_add` po oknie (ten sam odczyt getOrders, bez dodatkowych wywołań) — pary dla naszych zamówień
   *  dnia zaimportowanych do BL z opóźnieniem > 2 h. */
  blLater?: BlOrderHeader[]
  /** Nasze zamówienia spoza okna o numerach zamówień BL bez pary (`ordersByRef`). */
  elsewhere?: OurOrderElsewhere[]
}): DaySalesResult {
  const accounts: AccountDaySales[] = []
  const inDay = (t: Date) => t.getTime() >= input.from.getTime() && t.getTime() < input.to.getTime()
  const covered = new Map(input.accounts.filter((a) => a.coverageFrom).map((a) => [accKey(a.channel, a.channelAccountId), a]))
  for (const a of input.accounts) {
    if (!covered.has(accKey(a.channel, a.channelAccountId))) continue
    const k = accKey(a.channel, a.channelAccountId)
    const oursAll = input.ours.filter((o) => accKey(o.channel, o.channelAccountId) === k)
    const ours = oursAll.filter((o) => inDay(o.createdAtChannel))
    const blAll = input.bl.filter((h) => accKey(h.channel, h.channelAccountId) === k)
    const blByRef = new Map<string, BlOrderHeader>()
    for (const h of blAll) if (h.confirmed && h.externalRef) blByRef.set(h.externalRef, h)
    const pairOf = (o: SalesOrder) => blByRef.get(o.externalId) ?? (o.channelNumber ? blByRef.get(o.channelNumber) : undefined)
    const laterByRef = new Map<string, BlOrderHeader>()
    for (const h of input.blLater ?? []) if (accKey(h.channel, h.channelAccountId) === k && h.confirmed && h.externalRef && !laterByRef.has(h.externalRef)) laterByRef.set(h.externalRef, h)
    const laterOf = (o: SalesOrder) => laterByRef.get(o.externalId) ?? (o.channelNumber ? laterByRef.get(o.channelNumber) : undefined)
    const elsewhere = (input.elsewhere ?? []).filter((e) => accKey(e.channel, e.channelAccountId) === k && !inDay(e.createdAtChannel))
    const elsewhereOf = (ref: string) => elsewhere.find((e) => e.externalId === ref || e.channelNumber === ref)
    const counted = (o: SalesOrder) => SALES_COUNT_CANCELLED || !isCancelled(o)
    const blTotalCents = (h: BlOrderHeader) => (h.totalGross === null ? null : Math.round(h.totalGross * 100))
    const pairedAny = new Set<number>() // BL sparowany z którymkolwiek naszym zamówieniem z okna
    const pairedDay = new Set<number>() // BL sparowany z naszym zamówieniem tego dnia
    for (const o of oursAll) {
      const h = pairOf(o)
      if (!h) continue
      pairedAny.add(h.blOrderId)
      if (inDay(o.createdAtChannel)) pairedDay.add(h.blOrderId)
    }
    const blDay = blAll.filter((h) => h.confirmed && (pairedDay.has(h.blOrderId) || (!pairedAny.has(h.blOrderId) && inDay(h.dateAdd))))
    const r: AccountDaySales = {
      channel: a.channel,
      channelAccountId: a.channelAccountId,
      name: a.name,
      compared: true,
      ours: {
        count: ours.length,
        cents: ours.reduce((s, o) => s + toCents(o.gross), 0),
        beforeStart: ours.filter((o) => counted(o) && o.outside === 'przed-startem').length,
        notIngested: ours.filter((o) => counted(o) && o.outside === 'nieprzyjete').length,
        skipped: ours.filter((o) => counted(o) && o.outside === 'pominiete').length,
        cancelled: ours.filter(isCancelled).length,
      },
      notImportedByBl: [],
      blLaterImport: [],
      bl: {
        count: blDay.length,
        cents: blDay.reduce((s, h) => s + (h.totalGross === null ? 0 : Math.round(h.totalGross * 100)), 0),
        unconfirmed: blAll.filter((h) => !h.confirmed && inDay(h.dateAdd)).length,
        unreadableTotal: blDay.filter((h) => h.totalGross === null).length,
      },
      blDelayedImport: [],
      onlyHere: [],
      onlyBl: [],
      amountDiffs: [],
      ok: true,
    }
    // para z opóźnionym importem też ma zgodną kwotę: lista informacyjna nie może schować rozjazdu
    const compareAmount = (ref: string, oursCents: number, blCents: number | null) => {
      if (blCents === null || Math.abs(oursCents - blCents) > TOLERANCE_CENTS) r.amountDiffs.push({ ref, oursCents, blCents })
    }
    for (const o of ours) {
      const ref = o.channelNumber ?? o.externalId
      const h = pairOf(o)
      if (!h) {
        const later = laterOf(o)
        if (later) {
          r.blLaterImport.push({ ref, blDay: toWarsaw(later.dateAdd).day })
          compareAmount(ref, toCents(o.gross), blTotalCents(later))
        } else if (notImportedByBl(o)) r.notImportedByBl.push(ref)
        else r.onlyHere.push(ref)
        continue
      }
      compareAmount(ref, toCents(o.gross), blTotalCents(h))
    }
    for (const h of blDay) {
      if (pairedDay.has(h.blOrderId)) continue
      const e = h.externalRef ? elsewhereOf(h.externalRef) : undefined
      if (e) {
        r.blDelayedImport.push({ ref: h.externalRef!, ourDay: toWarsaw(e.createdAtChannel).day })
        compareAmount(h.externalRef!, toCents(e.gross), blTotalCents(h))
      } else r.onlyBl.push(h.externalRef ?? `BL ${h.blOrderId}`)
    }
    r.ok = r.onlyHere.length === 0 && r.onlyBl.length === 0 && r.amountDiffs.length === 0 && r.bl.unreadableTotal === 0
    accounts.push(r)
  }
  const nc = new Map<string, { count: number; cents: number }>()
  for (const h of input.bl) {
    if (!h.confirmed || !inDay(h.dateAdd) || covered.has(accKey(h.channel, h.channelAccountId))) continue
    const key = input.accounts.find((a) => a.channel === h.channel && a.channelAccountId === h.channelAccountId)?.name ?? `${h.orderSource}:${h.orderSourceId}`
    const x = nc.get(key) ?? { count: 0, cents: 0 }
    x.count++
    x.cents += h.totalGross === null ? 0 : Math.round(h.totalGross * 100)
    nc.set(key, x)
  }
  const ok = input.blComplete && accounts.every((a) => a.ok)
  return { day: input.day, final: input.final, from: input.from, to: input.to, blComplete: input.blComplete, blErrors: input.blErrors, accounts, notCompared: [...nc.entries()].map(([key, v]) => ({ key, ...v })), ok }
}

const zl = (cents: number) => (cents / 100).toFixed(2).replace('.', ',')

/**
 * Liczba zamówień z rozbiciem, żeby „Kompletor 10 / BL 8 / zgodne” nie wyglądało jak błąd, np.
 * „10 (2 nieimportowane przez BL, 1 import BL z opóźnieniem; w tym 1 anulowane)”. Przed średnikiem podział do rachunku
 * z BL, po nim przekrój: anulowane nakładają się na podział i na zwykłe zamówienia. Wpisy dni
 * nie mają nowych pól — liczą się jako 0.
 */
export function salesCountBreakdown(a: AccountDaySales, side: 'ours' | 'bl'): string {
  const parts: string[] = []
  if (side === 'ours') {
    if (a.notImportedByBl?.length) parts.push(`${a.notImportedByBl.length} nieimportowane przez BL`)
    if (a.blLaterImport?.length) parts.push(`${a.blLaterImport.length} import BL z opóźnieniem`)
    const note = [parts.join(', '), a.ours.cancelled ? `w tym ${a.ours.cancelled} anulowane` : ''].filter(Boolean).join('; ')
    return note ? `${a.ours.count} (${note})` : String(a.ours.count)
  }
  if (a.blDelayedImport?.length) parts.push(`${a.blDelayedImport.length} import z opóźnieniem, u nas z innego dnia`)
  return parts.length ? `${a.bl.count} (${parts.join(', ')})` : String(a.bl.count)
}

/** Treść alertu: liczby i numery zamówień (bez danych klientów), najwyżej 50 numerów na listę. */
export function divergenceMessage(day: IsoDay, a: AccountDaySales): string {
  const list = (xs: string[]) => (xs.length > MAX_LISTED ? `${xs.slice(0, MAX_LISTED).join(', ')} … (+${xs.length - MAX_LISTED})` : xs.join(', '))
  const parts = [`Sprzedaż ${day} ${a.name}: Kompletor ${salesCountBreakdown(a, 'ours')} zam. / ${zl(a.ours.cents)} zł, BL ${salesCountBreakdown(a, 'bl')} zam. / ${zl(a.bl.cents)} zł.`]
  if (a.onlyHere.length) parts.push(`Tylko u nas: ${list(a.onlyHere)}.`)
  if (a.onlyBl.length) parts.push(`Tylko w BL: ${list(a.onlyBl)}.`)
  if (a.amountDiffs.length) parts.push(`Inna kwota: ${list(a.amountDiffs.map((d) => `${d.ref} (${zl(d.oursCents)} / ${d.blCents === null ? '?' : zl(d.blCents)})`))}.`)
  if (a.bl.unreadableTotal) parts.push(`BL bez czytelnej kwoty: ${a.bl.unreadableTotal}.`)
  if (a.notImportedByBl.length) parts.push(`Bez pary, BL ich nie importuje (nieopłacone albo anulowane, nie rozjazd): ${list(a.notImportedByBl)}.`)
  if (a.blDelayedImport?.length) parts.push(`Import BL z opóźnieniem, u nas złożone innego dnia (nie rozjazd): ${list(a.blDelayedImport.map((d) => `${d.ref} (${d.ourDay})`))}.`)
  if (a.blLaterImport?.length) parts.push(`Import BL z opóźnieniem, w BL z innym dniem (nie rozjazd): ${list(a.blLaterImport.map((d) => `${d.ref} (${d.blDay})`))}.`)
  return parts.join(' ')
}

/**
 * Nasze zamówienia (rdzeń bez podzamówień i kopie kanału bez szkiców) o numerach `refs` (id w kanale albo numer
 * z wtyczki), bez filtra daty — jedno zapytanie na sprawdzenie dnia. Kwota także dla kopii z rdzenia, jak w
 * `salesOrders`, bo numer wtyczki trafia tylko w kopię. RLS ogranicza do firmy z sesji.
 */
export async function ordersByRef(db: PrismaClient, refs: string[]): Promise<OurOrderElsewhere[]> {
  organizationIdOf(db)
  if (!refs.length) return []
  return db.$queryRaw<OurOrderElsewhere[]>`
    SELECT o."channel"::text AS channel, o."channelAccountId", o."externalId", NULL::text AS "channelNumber", o."createdAtChannel", o."totalGross"::text AS gross
    FROM "Order" o
    WHERE o."externalId" = ANY(${refs}::text[]) AND o."parentOrderId" IS NULL
    UNION ALL
    SELECT c."channel"::text, c."channelAccountId", c."externalId", c."channelNumber", c."createdAtChannel", COALESCE(x."totalGross", c."totalGross")::text
    FROM "ChannelOrderSnapshot" c
    LEFT JOIN "Order" x
      ON x."organizationId" = c."organizationId" AND x."channel" = c."channel" AND x."channelAccountId" = c."channelAccountId" AND x."externalId" = c."externalId"
    WHERE (c."externalId" = ANY(${refs}::text[]) OR c."channelNumber" = ANY(${refs}::text[])) AND c."lifecycle" <> 'DRAFT'`
}

/**
 * Nasze zamówienia z dni przed `from`, których numer BL pokazał w sprawdzanym dniu [from, to): dzień złożenia → numery
 * (`refKey`, oba numery zamówienia). Obejmuje też parę sprzed północy z okna ± 2 h, która nie trafia do `blDelayedImport`
 * (BL sparowany z naszym zamówieniem innego dnia nie liczy się wcale).
 */
export function arrivedInDay(from: Date, to: Date, orders: Pick<OurOrderElsewhere, 'channel' | 'channelAccountId' | 'externalId' | 'channelNumber' | 'createdAtChannel'>[], bl: BlOrderHeader[]): Map<IsoDay, Set<string>> {
  const seen = new Set(bl.filter((h) => h.confirmed && h.externalRef && h.dateAdd >= from && h.dateAdd < to).map((h) => refKey(h.channel, h.channelAccountId, h.externalRef!)))
  const out = new Map<IsoDay, Set<string>>()
  for (const o of orders) {
    if (o.createdAtChannel >= from) continue
    const refs = [o.externalId, ...(o.channelNumber ? [o.channelNumber] : [])].map((r) => refKey(o.channel, o.channelAccountId, r))
    if (!refs.some((r) => seen.has(r))) continue
    const day = toWarsaw(o.createdAtChannel).day
    const known = out.get(day) ?? new Set<string>()
    for (const r of refs) known.add(r)
    out.set(day, known)
  }
  return out
}

export interface DaySalesOpts {
  day: IsoDay
  now?: Date
  /** `false` = bez przeliczania wcześniejszych dni: przeliczenie jest jednorazowe, nie kaskadowe. */
  recheckEarlier?: boolean
}

/**
 * Sprawdzenie dnia: nasze zamówienia (źródło pulpitu) + BL getOrders → porównanie → ShadowDailyCheck (+ alert per
 * konto przy rozjeździe). Dzień bieżący (`final = false`) bez ostatnich 20 min po obu stronach. Odczyt BL tylko get*.
 */
export async function runDaySalesCheck(db: PrismaClient, bl: BaseLinkerReadOnly, map: ChannelMap, accounts: AccountInfo[], opts: DaySalesOpts): Promise<DaySalesResult> {
  const now = opts.now ?? new Date()
  const { from, to: dayEnd } = warsawDay(opts.day)
  if (from.getTime() > now.getTime()) throw new Error(`dzień ${opts.day} jeszcze się nie zaczął`)
  const final = now.getTime() >= dayEnd.getTime()
  const to = final ? dayEnd : new Date(Math.min(dayEnd.getTime(), now.getTime() - TODAY_GRACE_MS))
  // okno parowania: doba ± margines, nie dalej niż „teraz”
  const wFrom = new Date(from.getTime() - PAIR_MARGIN_MS)
  const wTo = new Date(Math.min(dayEnd.getTime() + PAIR_MARGIN_MS, now.getTime()))
  const ours = await salesOrders(db, wFrom, wTo)
  // getOrders po `date_from` i tak czyta wszystko do „teraz” (strony po id_from); nagłówki po oknie to pary dla naszych
  // zamówień dnia zaimportowanych do BL z opóźnieniem > 2 h — bez dodatkowych wywołań
  const wToSec = Math.floor(wTo.getTime() / 1000)
  const f = await fetchBlOrdersAdded(bl, Math.floor(wFrom.getTime() / 1000), Math.max(wToSec, Math.floor(now.getTime() / 1000) + 1), map)
  const blWindow = f.headers.filter((h) => h.dateAdd.getTime() / 1000 < wToSec)
  const blLater = f.headers.filter((h) => h.dateAdd.getTime() / 1000 >= wToSec)
  // zamówienia BL dnia bez pary w oknie — czy mamy je z innego dnia (jedno zapytanie, bez filtra daty)
  const oursRefs = new Set(ours.flatMap((o) => [accKey(o.channel, o.channelAccountId) + '|' + o.externalId, ...(o.channelNumber ? [accKey(o.channel, o.channelAccountId) + '|' + o.channelNumber] : [])]))
  const unpaired = blWindow.filter((h) => h.confirmed && h.externalRef && h.dateAdd >= from && h.dateAdd < to && !oursRefs.has(accKey(h.channel, h.channelAccountId) + '|' + h.externalRef))
  const elsewhere = await ordersByRef(db, [...new Set(unpaired.map((h) => h.externalRef!))])
  // dzień bez pełnego odczytu BL zostaje otwarty (handler godzinowy ponowi); po dobie bez zamknięcia seria się przerywa
  const closed = final && f.complete
  const res = compareDaySales({ day: opts.day, final: closed, from, to, ours, bl: blWindow, blComplete: f.complete, blErrors: f.errors, accounts, blLater, elsewhere })
  const stats = JSON.parse(JSON.stringify(res)) as Prisma.InputJsonValue
  // dzień zamknięty nie wraca do „otwartego” od sprawdzenia na żądanie (inny wiersz nie istnieje: jeden na dzień)
  const where = { organizationId_kind_day: { organizationId: organizationIdOf(db), kind: SALES_CHECK, day: opts.day } }
  const prev = await db.shadowDailyCheck.findUnique({ where })
  if (!(prev?.final && !closed))
    await db.shadowDailyCheck.upsert({
      where,
      create: { kind: SALES_CHECK, day: opts.day, final: closed, ok: res.ok, checkedAt: now, stats },
      update: { final: closed, ok: res.ok, checkedAt: now, stats },
    })
  // przy niepełnym odczycie BL lista BL jest częściowa i zmienia się z przebiegu na przebieg (klucz z liczbami BL
  // dałby kilka fałszywych alertów dziennie) — wtedy tylko alert `bl-niepelne`, alerty kont dopiero po pełnym odczycie
  if (f.complete)
    for (const a of res.accounts.filter((x) => !x.ok))
      await alert(db, 'SPRZEDAZ_DNIA_ROZJAZD', `${a.channel}/${a.channelAccountId}/${opts.day}`, divergenceMessage(opts.day, a), `sprzedaz-dnia:${opts.day}:${a.channel}:${a.channelAccountId}:${a.ours.count}/${a.ours.cents}:${a.bl.count}/${a.bl.cents}`)
  if (!f.complete)
    await alert(db, 'SPRZEDAZ_DNIA_ROZJAZD', `BL/${opts.day}`, `Sprzedaż ${opts.day}: niepełne pobranie zamówień z BL (${f.errors.slice(0, 3).join('; ')}) — dzień nie liczy się jako zgodny`, `sprzedaz-dnia:${opts.day}:bl-niepelne`)
  // dzień zamknięty, zanim BL dociągnął zamówienie, przerwałby serię na stałe, bo worker do dnia
  // z `final` nie wraca; zamknięcie dnia, w którym numer się pojawił, przelicza tamten dzień raz
  if (closed && opts.recheckEarlier !== false) await recheckEarlierDays(db, bl, map, accounts, opts.day, now, arrivedInDay(from, to, [...ours, ...elsewhere], blWindow))
  return res
}

/** Przelicza dni zamknięte z rozjazdem, których numer z `onlyHere` pojawił się w BL później. Błąd jednego dnia nie psuje
 *  reszty ani zapisanego już dnia `day`: idzie do alertu, bo nic nie ponowi przeliczenia samo. */
async function recheckEarlierDays(db: PrismaClient, bl: BaseLinkerReadOnly, map: ChannelMap, accounts: AccountInfo[], day: IsoDay, now: Date, arrived: Map<IsoDay, Set<string>>): Promise<void> {
  const oldest = addDays(day, -RECHECK_MAX_DAYS_BACK)
  const days = [...arrived.keys()].filter((d) => d >= oldest && d < day)
  if (!days.length) return
  const rows = await db.shadowDailyCheck.findMany({ where: { kind: SALES_CHECK, final: true, ok: false, day: { in: days } }, orderBy: { day: 'asc' } })
  for (const row of rows) {
    const refs = arrived.get(row.day)!
    const accs = (row.stats as { accounts?: AccountDaySales[] }).accounts ?? []
    if (!accs.some((a) => a.onlyHere?.some((r) => refs.has(refKey(a.channel, a.channelAccountId, r))))) continue
    try {
      const res = await runDaySalesCheck(db, bl, map, accounts, { day: row.day, now, recheckEarlier: false })
      if (!res.blComplete) throw new Error('niepełny odczyt BL')
    } catch (e) {
      await alert(db, 'SPRZEDAZ_DNIA_ROZJAZD', `BL/${row.day}`, `Sprzedaż ${row.day}: nieudane przeliczenie po imporcie BL z opóźnieniem (${e instanceof Error ? e.message : String(e)}) — wpis dnia bez zmian, przelicz: npm run cien -- sprzedaz-dnia --dzien ${row.day}`, `sprzedaz-dnia:${row.day}:przeliczenie-nieudane`)
    }
  }
}

/**
 * Kryterium 7 dni cienia: dni zamknięte z rzędu bez rozjazdu sprzedaży, licząc wstecz od ostatniego
 * sprawdzonego dnia; per konto (klucz „kanał|konto”) i dla całej firmy (`*`). Dzień bez wpisu przerywa serię.
 */
export async function cleanDayStreaks(db: PrismaClient, upTo: IsoDay, maxDays = 60): Promise<Record<string, number>> {
  const rows = await db.shadowDailyCheck.findMany({ where: { kind: SALES_CHECK, final: true, day: { lte: upTo, gte: addDays(upTo, -maxDays) } }, orderBy: { day: 'desc' } })
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const out: Record<string, number> = {}
  const keys = new Set<string>(['*'])
  for (const r of rows) for (const a of ((r.stats as { accounts?: AccountDaySales[] }).accounts ?? [])) keys.add(accKey(a.channel, a.channelAccountId))
  for (const key of keys) {
    let n = 0
    for (let d = upTo; ; d = addDays(d, -1)) {
      const r = byDay.get(d)
      if (!r) break
      const accs = (r.stats as { accounts?: AccountDaySales[]; blComplete?: boolean }).accounts ?? []
      const good = key === '*' ? r.ok : (r.stats as { blComplete?: boolean }).blComplete !== false && accs.some((a) => accKey(a.channel, a.channelAccountId) === key && a.ok)
      if (!good) break
      n++
    }
    out[key] = n
  }
  return out
}
