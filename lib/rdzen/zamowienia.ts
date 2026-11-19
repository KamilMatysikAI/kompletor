// Przyjęcie zamówienia z dowolnego kanału, płatność, anulowanie, edycja, wygasanie nieopłaconych
// (spec 3.1–3.3, 3.5, 3.7, 5.2, 5.3, 7.3). Bez wywołań zewnętrznych w transakcjach: maile, kanały i faktury
// idą przez outbox / osobne zadania. Dane osobowe nie wchodzą do rdzenia (OrderContact to adaptery, F2).
import type { Carrier, Channel, Order, OrderStatus, PaymentState, ShippingModule } from '@prisma/client'
import { organizationIdOf } from '../db'
import { zapisKlientaWlaczony, zaplanujZapisKlienta } from '../klienci/kolejka'
import { isLocalLine } from './brakuje'
import { POWOD_ZMIANY_W_KANALE, zmianyWKanale } from './edycja'
import { addBusinessDays } from './kalendarz'
import { failedOnlineRemindAt, getPolicy, stockReleaseAtFor, termsFor, type Policy, type Terms } from './polityka'
import { zwolnijKoszykPoStatusie } from '../koszyki/zwolnienie'
import { fakturaZBl } from './faktura-bl'
import { forcePushForOrder } from './propagacja'
import { loadCarrierRules } from './przewoznicy'
import {
  addReservation,
  clarifyReasons,
  flagsOf,
  hasOpenShortage,
  hintAllocate,
  mergeFlags,
  productsOfOrder,
  reduceUnits,
  releaseOrder,
  reserveUnits,
  withReasons,
} from './rezerwacja'
import {
  alert,
  advisoryLock,
  type CatalogEntry,
  type Db,
  DEFAULT_WAREHOUSE,
  loadCatalog,
  orderLockKey,
  partsOf,
  runTx,
  StockBook,
  type Tx,
} from './stan'
import { BEFORE_PICKING, carrierFor, initialStatus, ON_CARD, TransitionError } from './statusy'

export interface Ctx {
  now?: Date
  /** Zegar „teraz” po operacji zewnętrznej (np. chwila odpowiedzi wFirmy); domyślnie new Date(), w testach wirtualny. */
  clock?: () => Date
  warehouseId?: string
  actorId?: string
  /**
   * Tylko ingestOrder: zamówienie o tym numerze już istnieje, a treść jest inna (nie DUPLIKAT) = OrderExistsError zamiast
   * nowej wersji; transakcja się wycofuje (bez InboundEvent). Publiczne API: system zewnętrzny nie
   * edytuje zamówienia po cichu.
   */
  onlyNew?: boolean
}

export interface IncomingLine {
  externalLineId: string
  /** Bezpośrednio produkt (zamówienie ręczne); wtedy `qty` w jednostce bazowej produktu (zestaw: sztuki zestawu). */
  productId?: string | null
  /** Oferta kanału; `qty` w sztukach oferty, przeliczane przez `qtyBasePerOffer`. */
  offerExternalId?: string | null
  qty: number
  unitPriceGross: number
  vatRate?: string | null
  /** opis pozycji z kanału (nazwa, SKU, EAN); opisowy, nie wpływa na rezerwacje ani na wykrywanie zmian. */
  name?: string | null
  sku?: string | null
  ean?: string | null
}

export interface IncomingOrder {
  source: string // np. woo-poll, woo-webhook, allegro-events, panel
  eventKey?: string
  channel: Channel
  channelAccountId: string
  externalId: string
  externalRevision?: string | null
  channelStatusRank?: number | null
  cancelled?: boolean
  createdAtChannel: Date
  paymentState: PaymentState
  paymentMethod: string
  /** Kanał: bramka online odrzuciła płatność (ChannelOrder.paymentFailedOnline). Krótka rezerwacja z zasad firmy. */
  paymentFailedOnline?: boolean
  /** Kanał: metoda offline (przelew tradycyjny, czek, pobranie); zdejmuje krótką rezerwację po nieudanej płatności. */
  paymentOffline?: boolean
  totalGross: number
  deliveryMethod?: string | null
  wantInvoiceNip?: boolean
  /** numer zamówienia w kanale (gdy inny niż externalId) i koszt wysyłki brutto; opisowe. */
  channelNumber?: string | null
  shippingCostGross?: number | null
  /**
   * przewoźnik wybrany przez człowieka albo integratora (zamówienie ręczne, API ogólne) zamiast dopasowania
   * `deliveryMethod` do reguł. Moduł wysyłki z pierwszej reguły firmy z tym przewoźnikiem; brak reguły = ValidationError.
   * Tylko przy pierwszym przyjęciu (nowe zamówienie); zamówienie bez wysyłki (same e-booki) i tak dostaje BEZ_WYSYLKI.
   */
  carrier?: Carrier | null
  /** źródło zamówienia (np. „Telefon”), opisowe; tylko przy pierwszym przyjęciu. */
  sourceLabel?: string | null
  lines: IncomingLine[]
}

export type IngestOutcome = 'NOWE' | 'ZMIANA' | 'DUPLIKAT' | 'PRZESTARZALE'

export interface IngestResult {
  orderId: string | null
  outcome: IngestOutcome
  reservedUnits: number
  shortUnits: number
  status?: OrderStatus
}

export class ValidationError extends Error {}

/** Zamówienie o tym numerze już jest, a wywołujący zażądał wyłącznie nowego (Ctx.onlyNew). */
export class OrderExistsError extends Error {
  constructor(
    readonly orderId: string,
    readonly status: string,
  ) {
    super('zamówienie o tym numerze już istnieje z inną treścią')
  }
}

const PAID_STATES: PaymentState[] = ['PAID', 'COD']
export const isPaid = (p: PaymentState) => PAID_STATES.includes(p)

/** Walidacja na wejściu: śmieci nie wchodzą do transakcji (zasada 5 roli soft). */
export function validateIncoming(o: IncomingOrder): void {
  if (!o.externalId?.trim()) throw new ValidationError('brak externalId')
  if (!o.channelAccountId?.trim()) throw new ValidationError('brak channelAccountId')
  if (!o.eventKey && !o.externalRevision) throw new ValidationError('brak externalRevision i eventKey (zdarzenie nie dałoby się odróżnić od poprzedniego)')
  if (!(o.createdAtChannel instanceof Date) || Number.isNaN(o.createdAtChannel.getTime())) throw new ValidationError('zła data zamówienia')
  if (!Number.isFinite(o.totalGross) || o.totalGross < 0) throw new ValidationError('zła kwota zamówienia')
  const seen = new Set<string>()
  for (const l of o.lines) {
    if (!l.externalLineId) throw new ValidationError('pozycja bez externalLineId')
    if (seen.has(l.externalLineId)) throw new ValidationError(`zdublowana pozycja ${l.externalLineId}`)
    seen.add(l.externalLineId)
    if (!Number.isInteger(l.qty) || l.qty <= 0 || l.qty > 1_000_000) throw new ValidationError(`zła ilość w pozycji ${l.externalLineId}`)
    if (!Number.isFinite(l.unitPriceGross) || l.unitPriceGross < 0) throw new ValidationError(`zła cena w pozycji ${l.externalLineId}`)
    // Zamówienie ręczne (panel): pozycja zawsze z katalogu, bez wolnego tekstu ani oferty. Pozycja bez
    // produktu nie zdjęłaby stanu (dziś tak gubią się sprzedaże hurtowe dodane w BL z ręki).
    if ((o.channel === 'RECZNE' || o.channel === 'EASYTOOLS') && (!l.productId || l.offerExternalId)) // EASYTOOLS przez API też tylko z katalogu
      throw new ValidationError(`zamówienie ręczne: pozycja ${l.externalLineId} musi wskazywać produkt z katalogu`)
  }
}

/** RECZNE: każdy wskazany produkt musi istnieć w katalogu firmy (bez cichego „niezmapowana oferta”). */
function assertManualFromCatalog(o: IncomingOrder, cat: Map<string, CatalogEntry>): void {
  if (o.channel !== 'RECZNE' && o.channel !== 'EASYTOOLS') return // EASYTOOLS jak RECZNE
  for (const l of o.lines)
    if (!cat.has(l.productId!)) throw new ValidationError(`zamówienie ręczne: produkt ${l.productId} pozycji ${l.externalLineId} spoza katalogu`)
}

/** Porównanie rewizji: liczbowo, gdy obie są liczbami; inaczej leksykalnie (daty ISO). */
export function compareRevision(a: string | null | undefined, b: string | null | undefined): number {
  if (a == null || b == null) return 0
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb) && a.trim() !== '' && b.trim() !== '') return na === nb ? 0 : na < nb ? -1 : 1
  return a === b ? 0 : a < b ? -1 : 1
}

interface ResolvedLine {
  externalLineId: string
  offerId: string | null
  productId: string | null
  qtyBase: number // sztuki zestawu dla BUNDLE, jednostka bazowa dla STOCKED; dla niezmapowanej: qty z kanału
  /** ilość z kanału (sztuki oferty) przy pozycji z ofertą, null przy pozycji wprost z produktem. */
  qtyChannel: number | null
  unitPriceGross: number
  vatRate: string | null
}

async function resolveLines(tx: Tx, o: IncomingOrder): Promise<ResolvedLine[]> {
  const offerIds = o.lines.map((l) => l.offerExternalId).filter((x): x is string => !!x)
  const offers = offerIds.length
    ? await tx.channelOffer.findMany({
        where: { channel: o.channel, channelAccountId: o.channelAccountId, externalId: { in: offerIds }, active: true },
        select: { id: true, externalId: true, productId: true, qtyBasePerOffer: true },
      })
    : []
  const byExt = new Map(offers.map((x) => [x.externalId, x]))
  return o.lines.map((l) => {
    if (l.productId) {
      return { externalLineId: l.externalLineId, offerId: null, productId: l.productId, qtyBase: l.qty, qtyChannel: null, unitPriceGross: l.unitPriceGross, vatRate: l.vatRate ?? null }
    }
    const off = l.offerExternalId ? byExt.get(l.offerExternalId) : undefined
    return {
      externalLineId: l.externalLineId,
      offerId: l.offerExternalId ?? null,
      productId: off?.productId ?? null,
      qtyBase: off ? l.qty * off.qtyBasePerOffer : l.qty,
      qtyChannel: l.offerExternalId ? l.qty : null,
      unitPriceGross: l.unitPriceGross,
      vatRate: l.vatRate ?? null,
    }
  })
}

// ─── Opis z kanału ────────────────────────────────────

/** Tekst opisowy z kanału: przycięty, pusty = null. */
export function tekstOpisu(v: string | null | undefined, max = 500): string | null {
  const t = typeof v === 'string' ? v.trim() : ''
  return t ? t.slice(0, max) : null
}

/** Kwota opisowa (koszt wysyłki): liczba ≥ 0 jako tekst z 2 miejscami, inaczej null. */
export function kwotaOpisu(v: number | null | undefined): string | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? v.toFixed(2) : null
}

export function opisPozycji(l: Pick<IncomingLine, 'name' | 'sku' | 'ean'> | undefined): { channelName: string | null; channelSku: string | null; channelEan: string | null } {
  return { channelName: tekstOpisu(l?.name), channelSku: tekstOpisu(l?.sku, 200), channelEan: tekstOpisu(l?.ean, 20) }
}

export interface OpisZKanalu {
  channelNumber?: string | null
  shippingCostGross?: number | null
  /**
   * wartość zamówienia brutto z kanału. Zapisywana tylko, dopóki kwoty zamówienia są otwarte
   * (`kwotyZKanaluOtwarte`): sklep potrafi pokazać zamówienie, zanim policzy sumę (zamówienie z REST: najpierw 0).
   */
  totalGross?: number | null
  lines: { externalLineId: string; name?: string | null; sku?: string | null; ean?: string | null }[]
}

export function opisZWejscia(i: IncomingOrder): OpisZKanalu {
  return { channelNumber: i.channelNumber, shippingCostGross: i.shippingCostGross, totalGross: i.totalGross, lines: i.lines }
}

/** Zdarzenie w historii: wartość zamówienia (i koszt wysyłki) poprawione odczytem z kanału. */
export const ZDARZENIE_KWOTY_Z_KANALU = 'KWOTA_Z_KANALU'

type ZamowienieDoKwot = Pick<Order, 'id' | 'status' | 'statusBeforeClarify' | 'paymentState' | 'totalGross' | 'parentOrderId' | 'blOrderId' | 'externalId' | 'flags'>

/**
 * czy wartość zamówienia i koszt wysyłki mogą jeszcze iść za kanałem. Tak tylko, gdy nic jeszcze na nich nie
 * stoi: zamówienie główne (paczka dodatkowa liczy kwotę ze swoich pozycji, podzielone ma paczki dodatkowe), nieedytowane
 * w Kompletorze (tam kwota jest nasza), przed spakowaniem i nie anulowane, bez faktury i próby faktury
 * (wFirma, KSeF, BaseLinker, rozchód towaru), bez zapisanej dopłaty/zwrotu i bez przesyłki (pobranie liczone z kwoty).
 * Opłacone (`platnoscPrzed`: stan sprzed bieżącego odczytu) zamyka kwotę, chyba że zapisana kwota to 0: zero przy
 * pozycjach z ceną to odczyt sprzed policzenia sumy w sklepie, nie podstawa rozliczenia wpłaty.
 */
export async function kwotyZKanaluOtwarte(tx: Tx, o: ZamowienieDoKwot, platnoscPrzed: PaymentState = o.paymentState): Promise<boolean> {
  if (o.parentOrderId || o.externalId.includes('#')) return false
  if (flagsOf(o).edytowaneLokalnie) return false
  const etap = o.status === 'DO_WYJASNIENIA' ? (o.statusBeforeClarify ?? 'NOWE') : o.status
  if (!BEFORE_PICKING.includes(etap) && !ON_CARD.includes(etap)) return false
  if (platnoscPrzed === 'PAID' && Number(o.totalGross) !== 0) return false
  const [faktury, ksef, rozchod, wplaty, paczki, przygotowane, przesylki] = await Promise.all([
    tx.invoiceAttempt.count({ where: { orderId: o.id } }),
    tx.ksefInvoiceDraft.count({ where: { orderId: o.id } }),
    tx.reservation.count({ where: { orderId: o.id, state: { in: ['CONSUMING', 'CONSUMED'] } } }),
    tx.orderPayment.count({ where: { orderId: o.id } }),
    tx.order.count({ where: { parentOrderId: o.id } }),
    tx.preparedShipment.count({ where: { orderId: o.id } }),
    tx.shipment.count({ where: { orderId: o.id } }),
  ])
  if (faktury + ksef + rozchod + wplaty + paczki + przygotowane + przesylki > 0) return false
  return (await fakturaZBl(tx, o)) === null
}

/**
 * Uzupełnia opis zamówienia i pozycji z kanału (numer, koszt wysyłki, nazwa/SKU/EAN pozycji). Idempotentne: zapis tylko
 * pola, które kanał podał i które różni się od zapisanego; pusta wartość nie kasuje zapisanej (kanał mógł jej nie wysłać
 * w tej odpowiedzi). Bez wpływu na status, rezerwacje i rewizję. Zwraca liczbę zmienionych wierszy.
 * wartość zamówienia i zmiana zapisanego kosztu wysyłki tylko przy otwartych kwotach (`kwotyZKanaluOtwarte`,
 * pod blokadą zamówienia); brakujący koszt wysyłki uzupełnia się jak dotąd. `platnoscPrzed`: stan płatności sprzed
 * odczytu, gdy wołający właśnie go zmienił (przyjęcie rewizji z wpłatą).
 */
export async function zapiszOpisZKanalu(tx: Tx, orderId: string, opis: OpisZKanalu, opcje: { platnoscPrzed?: PaymentState; actorId?: string } = {}): Promise<number> {
  let zmian = 0
  const o = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      organizationId: true,
      channel: true,
      channelAccountId: true,
      externalId: true,
      totalGross: true,
      channelNumber: true,
      shippingCostGross: true,
      lines: { select: { id: true, externalLineId: true, channelName: true, channelSku: true, channelEan: true } },
    },
  })
  if (!o) return 0
  const nr = tekstOpisu(opis.channelNumber, 100)
  const koszt = kwotaOpisu(opis.shippingCostGross)
  const suma = kwotaOpisu(opis.totalGross)
  const patch: { channelNumber?: string; shippingCostGross?: string; totalGross?: string } = {}
  if (nr && nr !== o.channelNumber) patch.channelNumber = nr
  if (koszt !== null && o.shippingCostGross === null) patch.shippingCostGross = koszt
  const zmianaKosztu = koszt !== null && o.shippingCostGross !== null && o.shippingCostGross.toFixed(2) !== koszt
  const zmianaSumy = suma !== null && o.totalGross.toFixed(2) !== suma
  let kwoty: { z: string; na: string; kosztZ?: string; kosztNa?: string } | null = null
  if (zmianaKosztu || zmianaSumy) {
    // blokada zamówienia (przy przyjęciu z kanału już wzięta w tej transakcji: ponowne wzięcie przechodzi od razu),
    // potem świeży odczyt: stan sprzed blokady mógł się zmienić (faktura, wpłata, pakowanie)
    await advisoryLock(tx, orderLockKey(o))
    const f = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { id: true, status: true, statusBeforeClarify: true, paymentState: true, totalGross: true, parentOrderId: true, blOrderId: true, externalId: true, flags: true, shippingCostGross: true },
    })
    const kosztNa = koszt !== null && f.shippingCostGross !== null && f.shippingCostGross.toFixed(2) !== koszt ? koszt : null
    const sumaNa = suma !== null && f.totalGross.toFixed(2) !== suma ? suma : null
    if ((kosztNa || sumaNa) && (await kwotyZKanaluOtwarte(tx, f, opcje.platnoscPrzed ?? f.paymentState))) {
      if (kosztNa) patch.shippingCostGross = kosztNa
      if (sumaNa) patch.totalGross = sumaNa
      kwoty = { z: f.totalGross.toFixed(2), na: sumaNa ?? f.totalGross.toFixed(2), ...(kosztNa ? { kosztZ: f.shippingCostGross!.toFixed(2), kosztNa } : {}) }
    }
  }
  if (Object.keys(patch).length) {
    await tx.order.update({ where: { id: orderId }, data: patch })
    zmian++
  }
  if (kwoty) await tx.orderEvent.create({ data: { orderId, kind: ZDARZENIE_KWOTY_Z_KANALU, actorId: opcje.actorId ?? 'system:kanal', data: kwoty } })
  const byExt = new Map(opis.lines.map((l) => [l.externalLineId, opisPozycji(l)]))
  for (const l of o.lines) {
    const n = byExt.get(l.externalLineId)
    if (!n) continue
    const data: Partial<Record<'channelName' | 'channelSku' | 'channelEan', string>> = {}
    if (n.channelName && n.channelName !== l.channelName) data.channelName = n.channelName
    if (n.channelSku && n.channelSku !== l.channelSku) data.channelSku = n.channelSku
    if (n.channelEan && n.channelEan !== l.channelEan) data.channelEan = n.channelEan
    if (Object.keys(data).length) {
      await tx.orderLine.update({ where: { id: l.id }, data })
      zmian++
    }
  }
  return zmian
}

function partIds(cat: Map<string, CatalogEntry>, productIds: Iterable<string | null>): string[] {
  const out = new Set<string>()
  for (const id of productIds) {
    const e = id ? cat.get(id) : undefined
    if (e) for (const p of partsOf(e)) out.add(p.productId)
  }
  return [...out]
}

/**
 * Przyjęcie zamówienia (nowego albo kolejnej rewizji). Jedna krótka transakcja na zamówienie: blokada
 * doradcza → InboundEvent (idempotencja) → blokady Stock w kolejności productId → zapis.
 */
export async function ingestOrder(db: Db, input: IncomingOrder, ctx: Ctx = {}): Promise<IngestResult> {
  validateIncoming(input)
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  const eventKey = input.eventKey ?? `${input.externalId}:${input.externalRevision ?? '-'}`
  const organizationId = organizationIdOf(db)
  return runTx(db, async (tx) => {
    await advisoryLock(tx, orderLockKey({ ...input, organizationId }))
    const ins = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "InboundEvent" (id, source, "eventKey", "receivedAt")
      VALUES (${'ie_' + globalThis.crypto.randomUUID().replace(/-/g, '')}, ${input.source}, ${eventKey}, ${now})
      ON CONFLICT ("organizationId", source, "eventKey") DO NOTHING RETURNING id`
    if (!ins.length) return { orderId: null, outcome: 'DUPLIKAT', reservedUnits: 0, shortUnits: 0 }
    const inboundId = ins[0]!.id
    const existing = await tx.order.findUnique({
      where: {
        organizationId_channel_channelAccountId_externalId: { organizationId, channel: input.channel, channelAccountId: input.channelAccountId, externalId: input.externalId },
      },
      include: { lines: true },
    })
    if (existing && ctx.onlyNew) throw new OrderExistsError(existing.id, existing.status)
    const res = existing ? await updateOrder(tx, existing, input, now, wh) : await createOrder(tx, input, now, wh)
    // płatność sprzed tej rewizji — wpłata przychodząca razem z poprawioną kwotą nie zamyka kwoty
    if (existing && res.orderId && res.outcome !== 'PRZESTARZALE')
      await zapiszOpisZKanalu(tx, res.orderId, opisZWejscia(input), { platnoscPrzed: existing.paymentState, actorId: `system:${input.source}` })
    await tx.inboundEvent.update({ where: { id: inboundId }, data: { processedAt: now, outcome: res.outcome } })
    if (res.orderId) await hintAllocate(tx, res.orderId, now)
    // dane klienta zapisuje osobne zadanie (sam Order.id, kanał czytany poza tą transakcją). Nowe zamówienie
    // albo nowa rewizja z kanału (adres mógł się zmienić; rewizji brak = nie wiadomo, więc też).
    const nowaRewizja = res.outcome === 'ZMIANA' && (!input.externalRevision || input.externalRevision !== existing?.externalRevision)
    if (res.orderId && (res.outcome === 'NOWE' || nowaRewizja) && zapisKlientaWlaczony(process.env)) await zaplanujZapisKlienta(tx, res.orderId, now)
    return res
  })
}

/** przewoźnik wybrany wprost; moduł z pierwszej reguły firmy z tym przewoźnikiem (kanał albo każdy). */
async function carrierZWyboru(tx: Tx, channel: Channel, carrier: Carrier): Promise<{ carrier: Carrier; shippingModule: ShippingModule }> {
  if (carrier === 'BRAK' || carrier === 'BEZ_WYSYLKI') throw new ValidationError('przewoźnik: wybierz przewoźnika paczki albo odbiór osobisty')
  const rule = (await loadCarrierRules(tx)).find((r) => r.carrier === carrier && (!r.channel || r.channel === channel))
  if (!rule) throw new ValidationError('przewoźnik: tego przewoźnika nie ma w regułach przewoźników firmy')
  return { carrier: rule.carrier, shippingModule: rule.shippingModule }
}

async function createOrder(tx: Tx, input: IncomingOrder, now: Date, wh: string): Promise<IngestResult> {
  const lines = await resolveLines(tx, input)
  const cat = await loadCatalog(tx, lines.map((l) => l.productId).filter((x): x is string => !!x))
  assertManualFromCatalog(input, cat)
  // zamówienie widziane pierwszy raz już anulowane (np. Woo cancelled/refunded): bez rezerwacji (3.1). Woo failed
  // nie jest już anulowaniem (otwarte, nieopłacone jak pending)
  const book = await StockBook.lock(tx, wh, input.cancelled ? [] : partIds(cat, lines.map((l) => l.productId)))
  const policy = await getPolicy(tx)
  const paid = isPaid(input.paymentState)
  // Zamówienie bez wysyłki: same pozycje bez stanu (e-book) na koncie w PRACA — rozpoznanie wyłącznie po
  // rodzaju pozycji, nigdy po nazwie metody dostawy. W cieniu bez zmian (fakturę i status prowadzi BL).
  const { carrier, shippingModule } = (await noShipping(tx, input, lines, cat))
    ? { carrier: 'BEZ_WYSYLKI' as const, shippingModule: 'BRAK' as const }
    : input.carrier
      ? await carrierZWyboru(tx, input.channel, input.carrier)
      : carrierFor(input.channel, input.deliveryMethod, await loadCarrierRules(tx))
  const reasons: string[] = []
  if (lines.some((l) => !l.productId || !cat.has(l.productId))) reasons.push('niezmapowana oferta')
  if (carrier === 'BRAK') reasons.push(`nieznana metoda dostawy: ${input.deliveryMethod ?? '(brak)'}`)
  const natural: OrderStatus = paid ? 'DO_REALIZACJI' : 'NOWE'
  const status: OrderStatus = input.cancelled ? 'ANULOWANE' : reasons.length ? 'DO_WYJASNIENIA' : initialStatus(paid, carrier)
  const failedOnline = failedOnlineAfter(false, input)
  const terms = paid || input.cancelled ? null : termsFor(input.createdAtChannel, policy)
  // nieudana płatność online: towar trzymany tylko do krótkiego terminu, zamówienie czeka dalej do `reservationDeadline`
  const stockReleaseAt = terms && failedOnline ? stockReleaseAtFor(input.createdAtChannel, policy) : null
  const order = await tx.order.create({
    data: {
      channel: input.channel,
      channelAccountId: input.channelAccountId,
      externalId: input.externalId,
      externalRevision: input.externalRevision ?? null,
      channelStatusRank: input.channelStatusRank ?? null,
      status,
      statusBeforeClarify: reasons.length ? natural : null,
      carrier,
      shippingModule,
      deliveryMethod: input.deliveryMethod ?? null,
      channelNumber: tekstOpisu(input.channelNumber, 100),
      shippingCostGross: kwotaOpisu(input.shippingCostGross),
      sourceLabel: tekstOpisu(input.sourceLabel, 80),
      paymentState: input.paymentState,
      paymentMethod: input.paymentMethod,
      totalGross: input.totalGross.toFixed(2),
      wantInvoiceNip: input.wantInvoiceNip ?? false,
      termsSeasonMode: terms ? terms.seasonMode : null,
      remindAt: terms ? remindAtOf(terms, failedOnline && input.paymentState === 'UNPAID', input.createdAtChannel, policy, now) : null,
      reservationDeadline: terms?.reservationDeadline ?? null,
      stockReleaseAt,
      createdAtChannel: input.createdAtChannel,
      flags: { ...withReasons(reasons), niedoplata: input.paymentState === 'PARTIAL' || undefined, nieudanaPlatnoscOnline: failedOnline || undefined },
    },
  })
  let reserved = 0
  let short = 0
  for (const l of lines) {
    const line = await tx.orderLine.create({
      data: {
        orderId: order.id,
        externalLineId: l.externalLineId,
        offerId: l.offerId,
        productId: l.productId && cat.has(l.productId) ? l.productId : null,
        qty: l.qtyBase,
        qtyChannel: l.qtyChannel,
        unitPriceGross: l.unitPriceGross.toFixed(2),
        vatRate: l.vatRate,
        ...opisPozycji(input.lines.find((x) => x.externalLineId === l.externalLineId)),
      },
    })
    const entry = l.productId ? cat.get(l.productId) : undefined
    if (!entry || input.cancelled) continue
    const r = await reserveUnits(tx, book, order.id, line.id, entry, l.qtyBase)
    reserved += r.reservedUnits
    short += r.shortUnits
  }
  if (short > 0) await tx.order.update({ where: { id: order.id }, data: { flags: mergeFlags(order, { brakuje: true }) } })
  // termin zwolnienia minął już przy przyjęciu (0 godzin albo zamówienie odczytane późno): zwolnienie od razu, a wynik
  // i zdarzenie przyjęcia pokazują stan po zwolnieniu (0 zarezerwowanych, 0 braków)
  const odRazu = !!stockReleaseAt && stockReleaseAt <= now && status === 'NOWE' && input.paymentState === 'UNPAID'
  if (odRazu) {
    reserved = 0
    short = 0
  }
  await tx.orderEvent.create({ data: { orderId: order.id, kind: 'PRZYJETE', actorId: `system:${input.source}`, data: { reserved, short, status, ...(odRazu ? { towarZwolniony: true } : {}) } } })
  if (odRazu) await releaseStockInTx(tx, book, order.id, `system:${input.source}`, now)
  await refreshShortageWait(tx, order.id, now)
  await book.flush(tx, now)
  return { orderId: order.id, outcome: 'NOWE', reservedUnits: reserved, shortUnits: short, status }
}

/** Wszystkie pozycje to produkty bez stanu (DIGITAL) i konto kanału jest w PRACA (statusy prowadzi Kompletor). */
async function noShipping(tx: Tx, input: IncomingOrder, lines: ResolvedLine[], cat: Map<string, CatalogEntry>): Promise<boolean> {
  if (!lines.length || !lines.every((l) => !!l.productId && cat.get(l.productId)?.kind === 'DIGITAL')) return false
  const acc = await tx.channelConfig.findFirst({ where: { channel: input.channel, channelAccountId: input.channelAccountId }, select: { statusMode: true } })
  return acc?.statusMode === 'PRACA'
}

function setClarify(order: Order, reason: string): Partial<Order> {
  return {
    status: 'DO_WYJASNIENIA',
    statusBeforeClarify: order.status === 'DO_WYJASNIENIA' ? order.statusBeforeClarify : order.status,
    flags: mergeFlags(order, withReasons([...clarifyReasons(flagsOf(order)), reason])) as Order['flags'],
  }
}

async function updateOrder(
  tx: Tx,
  order: Order & { lines: { id: string; externalLineId: string; productId: string | null; qty: number; qtyRejected: number; removed: boolean }[] },
  input: IncomingOrder,
  now: Date,
  wh: string,
): Promise<IngestResult> {
  if (compareRevision(input.externalRevision, order.externalRevision) < 0)
    return { orderId: order.id, outcome: 'PRZESTARZALE', reservedUnits: 0, shortUnits: 0 }
  const incoming = await resolveLines(tx, input)
  const cat = await loadCatalog(tx, [...order.lines.map((l) => l.productId), ...incoming.map((l) => l.productId)].filter((x): x is string => !!x))
  assertManualFromCatalog(input, cat)
  const book = await StockBook.lock(tx, wh, [...partIds(cat, order.lines.map((l) => l.productId)), ...partIds(cat, incoming.map((l) => l.productId)), ...(await productsOfOrder(tx, order.id))])
  const base = { externalRevision: input.externalRevision ?? order.externalRevision }
  let reserved = 0
  let short = 0

  // Reaktywacja w kanale (krok 5): zamówienie anulowane przez ten sam kanał wraca
  // w nowszej rewizji jako otwarte (Woo cancelled → processing; failed → processing tylko dla zamówień zapisanych
  // wtedy, gdy failed było anulowaniem) — jak
  // „opłacone po anulowaniu”: ponowna rezerwacja, czego nie ma → DO_WYJASNIENIA; dalej zwykła ścieżka (edycja
  // pozycji, cofnięcie statusu). Anulowane przez obsługę albo przez inny tor i płatność z innego źródła zostają bez
  // zmian (alert „płatność po anulowaniu”). Po fakturze bez automatu — tylko alert.
  if (input.cancelled === false && order.status === 'ANULOWANE' && order.cancelReason === 'CANCELLED' && (await cancelledBy(tx, order.id)) === `system:${input.source}`) {
    const fresh = await reactivateInTx(tx, book, order, input, cat, `system:${input.source}`, now)
    if (!fresh) {
      await tx.order.update({ where: { id: order.id }, data: base })
      return { orderId: order.id, outcome: 'ZMIANA', reservedUnits: 0, shortUnits: 0, status: 'ANULOWANE' }
    }
    reserved += fresh.reserved
    short += fresh.short
    order = { ...fresh.order, lines: order.lines }
  }

  // Cofnięcie statusu w kanale → DO_WYJASNIENIA, stan bez zmian (5.3, T14). Anulowane zostaje anulowane (bez
  // rezerwacji „Do wyjaśnienia” łamałoby bilans pozycji).
  if (order.status !== 'ANULOWANE' && input.channelStatusRank != null && order.channelStatusRank != null && input.channelStatusRank < order.channelStatusRank) {
    await tx.order.update({ where: { id: order.id }, data: { ...base, ...setClarify(order, 'cofnięty status w kanale') } as never })
    await tx.orderEvent.create({ data: { orderId: order.id, kind: 'COFNIETY_STATUS', actorId: `system:${input.source}`, data: { z: order.channelStatusRank, na: input.channelStatusRank } } })
    return { orderId: order.id, outcome: 'ZMIANA', reservedUnits: 0, shortUnits: 0, status: 'DO_WYJASNIENIA' }
  }
  if (input.channelStatusRank != null) (base as Record<string, unknown>).channelStatusRank = input.channelStatusRank

  if (input.cancelled) {
    await tx.order.update({ where: { id: order.id }, data: base })
    const st = await cancelInTx(tx, book, { ...order, ...base }, 'CANCELLED', `system:${input.source}`, now)
    await book.flush(tx, now)
    return { orderId: order.id, outcome: 'ZMIANA', reservedUnits: 0, shortUnits: 0, status: st }
  }

  // Edycja pozycji (3.7).
  const invoiced = await tx.reservation.count({ where: { orderId: order.id, state: { in: ['CONSUMING', 'CONSUMED'] } } })
  const byExt = new Map(order.lines.map((l) => [l.externalLineId, l]))
  const incomingByExt = new Map(incoming.map((l) => [l.externalLineId, l]))
  const changes: string[] = []
  for (const l of order.lines) {
    if (l.removed || isLocalLine(l)) continue
    const inc = incomingByExt.get(l.externalLineId)
    if (!inc) changes.push(`usunięta ${l.externalLineId}`)
    else if ((inc.productId ?? null) !== (l.productId ?? null) && l.productId) changes.push(`zmiana produktu ${l.externalLineId}`)
    else if (inc.qtyBase !== l.qty && l.productId) changes.push(`ilość ${l.externalLineId}`)
  }
  for (const inc of incoming) if (!byExt.has(inc.externalLineId)) changes.push(`nowa ${inc.externalLineId}`)

  let patch: Partial<Order> = { ...base }
  const stage = order.status === 'DO_WYJASNIENIA' ? (order.statusBeforeClarify ?? 'NOWE') : order.status
  // pozycje zmienione z karty zamówienia. Kanał o tym nie wie, więc porównanie idzie ze zdjęciem kanału sprzed
  // edycji, nie z pozycjami w Kompletorze: bez zmiany w kanale edycja zostaje, ze zmianą — decyzja obsługi, bez nadpisania.
  // Zdjęcie i `zmianyWKanale` porównują tylko produkt i ilość: sama zmiana ceny w kanale po edycji
  // z karty nie nadpisuje ceny w Kompletorze i nie wysyła zamówienia do „Do wyjaśnienia” (różnica przechodzi bez sygnału).
  const zdjecie = flagsOf(order).edytowaneLokalnie ? flagsOf(order).pozycjeKanalu : undefined
  if (zdjecie && order.status !== 'ANULOWANE') {
    const wKanale = zmianyWKanale(zdjecie, incoming)
    if (wKanale.length) {
      const clarified = setClarify(order, POWOD_ZMIANY_W_KANALE)
      const noweZdjecie = Object.fromEntries(incoming.map((l) => [l.externalLineId, [l.productId, l.qtyBase] as [string | null, number]]))
      patch = { ...patch, ...clarified, flags: mergeFlags({ flags: clarified.flags! }, { pozycjeKanalu: noweZdjecie }) as Order['flags'] }
      await tx.orderEvent.create({ data: { orderId: order.id, kind: 'ZMIANA_W_KANALE_PO_EDYCJI', actorId: `system:${input.source}`, data: { changes: wKanale } } })
    }
  } else if (changes.length && order.status === 'ANULOWANE') {
    // anulowane zostaje anulowane (bez rezerwacji); zmiana tylko w historii do wglądu obsługi
    await tx.orderEvent.create({ data: { orderId: order.id, kind: 'EDYCJA_PO_ANULOWANIU', actorId: `system:${input.source}`, data: { changes } } })
  } else if (changes.length && order.stockReleasedAt && stage === 'NOWE' && invoiced === 0) {
    // towar zwolniony po nieudanej płatności online: pozycje jak w kanale, bez rezerwacji i bez braków; rezerwacja od
    // nowa dopiero po wpłacie albo po zmianie na przelew tradycyjny (z bieżących pozycji)
    for (const l of order.lines) {
      if (l.removed || isLocalLine(l)) continue
      const inc = incomingByExt.get(l.externalLineId)
      const entry = l.productId ? cat.get(l.productId) : undefined
      if (!inc) await tx.orderLine.update({ where: { id: l.id }, data: { removed: true } })
      else if (entry && (inc.productId ?? null) !== l.productId) patch = { ...patch, ...setClarify({ ...order, ...patch } as Order, `zmiana produktu w pozycji ${l.externalLineId}`) }
      else if (entry && inc.qtyBase !== l.qty && inc.qtyBase < l.qtyRejected)
        patch = { ...patch, ...setClarify({ ...order, ...patch } as Order, `zmiana ilości poniżej dosłanej lub zamienionej: ${l.externalLineId}`) }
      else if (entry && inc.qtyBase !== l.qty) await tx.orderLine.update({ where: { id: l.id }, data: { qty: inc.qtyBase, qtyChannel: inc.qtyChannel } })
    }
    for (const inc of incoming) {
      if (byExt.has(inc.externalLineId)) continue
      const entry = inc.productId ? cat.get(inc.productId) : undefined
      await tx.orderLine.create({
        data: {
          orderId: order.id,
          externalLineId: inc.externalLineId,
          offerId: inc.offerId,
          productId: entry ? inc.productId : null,
          qty: inc.qtyBase,
          qtyChannel: inc.qtyChannel,
          unitPriceGross: inc.unitPriceGross.toFixed(2),
          vatRate: inc.vatRate,
          ...opisPozycji(input.lines.find((x) => x.externalLineId === inc.externalLineId)),
        },
      })
      if (!entry) patch = { ...patch, ...setClarify({ ...order, ...patch } as Order, 'niezmapowana oferta') }
      else if (order.carrier === 'BEZ_WYSYLKI' && entry.kind !== 'DIGITAL')
        patch = { ...patch, ...setClarify({ ...order, ...patch } as Order, `towar w zamówieniu bez wysyłki: ${inc.externalLineId}`) }
    }
    await tx.orderEvent.create({ data: { orderId: order.id, kind: 'EDYCJA', actorId: `system:${input.source}`, data: { changes, bezRezerwacji: true } } })
  } else if (changes.length && (invoiced > 0 || !(BEFORE_PICKING.includes(stage) || ON_CARD.includes(stage)))) {
    // po spakowaniu albo po fakturze: bez automatu (3.7; między wydrukiem karty a SPAKOWANE niżej)
    patch = { ...patch, ...setClarify(order, `edycja w kanale po spakowaniu: ${changes.join(', ')}`) }
  } else if (changes.length) {
    for (const l of order.lines) {
      if (l.removed || isLocalLine(l)) continue
      const inc = incomingByExt.get(l.externalLineId)
      const entry = l.productId ? cat.get(l.productId) : undefined
      if (!inc) {
        if (entry) await reduceUnits(tx, book, l.id, entry, l.qty - l.qtyRejected, 'LINE_CHANGED', now)
        await tx.orderLine.update({ where: { id: l.id }, data: { removed: true } })
      } else if (entry && (inc.productId ?? null) !== l.productId) {
        patch = { ...patch, ...setClarify({ ...order, ...patch } as Order, `zmiana produktu w pozycji ${l.externalLineId}`) }
      } else if (entry && inc.qtyBase > l.qty) {
        const r = await reserveUnits(tx, book, order.id, l.id, entry, inc.qtyBase - l.qty)
        reserved += r.reservedUnits
        short += r.shortUnits
        await tx.orderLine.update({ where: { id: l.id }, data: { qty: inc.qtyBase, qtyChannel: inc.qtyChannel } })
      } else if (entry && inc.qtyBase < l.qtyRejected) {
        // cięcie wchodzi w sztuki już dosłane albo zamienione (`qtyRejected`), których pozycja nie ma: decyzja obsługi
        patch = { ...patch, ...setClarify({ ...order, ...patch } as Order, `zmiana ilości poniżej dosłanej lub zamienionej: ${l.externalLineId}`) }
      } else if (entry && inc.qtyBase < l.qty) {
        await reduceUnits(tx, book, l.id, entry, l.qty - inc.qtyBase, 'LINE_CHANGED', now)
        await tx.orderLine.update({ where: { id: l.id }, data: { qty: inc.qtyBase, qtyChannel: inc.qtyChannel } })
      }
    }
    for (const inc of incoming) {
      if (byExt.has(inc.externalLineId)) continue
      const entry = inc.productId ? cat.get(inc.productId) : undefined
      const line = await tx.orderLine.create({
        data: {
          orderId: order.id,
          externalLineId: inc.externalLineId,
          offerId: inc.offerId,
          productId: entry ? inc.productId : null,
          qty: inc.qtyBase,
          qtyChannel: inc.qtyChannel,
          unitPriceGross: inc.unitPriceGross.toFixed(2),
          vatRate: inc.vatRate,
          ...opisPozycji(input.lines.find((x) => x.externalLineId === inc.externalLineId)),
        },
      })
      if (!entry) {
        patch = { ...patch, ...setClarify({ ...order, ...patch } as Order, 'niezmapowana oferta') }
        continue
      }
      // zamówienie bez wysyłki dostało towar: paczka potrzebuje przewoźnika, decyzja obsługi
      if (order.carrier === 'BEZ_WYSYLKI' && entry.kind !== 'DIGITAL')
        patch = { ...patch, ...setClarify({ ...order, ...patch } as Order, `towar w zamówieniu bez wysyłki: ${inc.externalLineId}`) }
      const r = await reserveUnits(tx, book, order.id, line.id, entry, inc.qtyBase)
      reserved += r.reservedUnits
      short += r.shortUnits
    }
    // karta w ręku zbieracza: pozycje już nowe, zbierać i pakować dopiero z nowego wydruku (3.7). Bez
    // rezerwacji nie ma czego zbierać: nowej karty się nie wydrukuje albo nie da się z niej spakować, a ZEBRANE nie ma
    // drogi wstecz, więc zamiast flagi decyzja obsługi; flaga z wcześniejszej edycji też schodzi
    const staleCard = ON_CARD.includes(stage) && (await tx.reservation.count({ where: { orderId: order.id, state: 'ACTIVE' } })) > 0
    if (ON_CARD.includes(stage) && !staleCard) {
      const clarified = setClarify({ ...order, ...patch } as Order, 'edycja w kanale po wydruku: nic do zbierania')
      patch = { ...patch, ...clarified, flags: mergeFlags({ flags: clarified.flags! }, { kartaNieaktualna: undefined }) as Order['flags'] }
    }
    if (staleCard) patch = { ...patch, flags: mergeFlags({ ...order, ...patch } as Order, { kartaNieaktualna: true }) as Order['flags'] }
    await tx.orderEvent.create({ data: { orderId: order.id, kind: 'EDYCJA', actorId: `system:${input.source}`, data: { changes, ...(staleCard ? { kartaNieaktualna: true } : {}) } } })
  }
  await tx.order.update({ where: { id: order.id }, data: patch as never })
  await updateFailedOnlinePayment(tx, book, cat, order.id, input, `system:${input.source}`, now)

  // Płatność (T2, 3.3 „płatność po zwolnieniu”).
  let status = (patch.status ?? order.status) as OrderStatus
  if (isPaid(input.paymentState) && !isPaid(order.paymentState)) {
    // zamówienie zmienione z karty przed wpłatą. Klient zapłacił w kanale kwotę kanału, nie
    // kwotę po edycji, więc podstawą rozliczenia (dopłata / zwrot różnicy) jest kwota z kanału.
    if (input.paymentState !== 'COD') {
      const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id } })
      const f = flagsOf(fresh)
      if (f.edytowaneLokalnie && f.kwotaZaplacona === undefined)
        await tx.order.update({ where: { id: order.id }, data: { flags: mergeFlags(fresh, { kwotaZaplacona: input.totalGross.toFixed(2) }) } })
    }
    status = await applyPaymentInTx(tx, book, order.id, input.paymentState, cat, `system:${input.source}`, now)
  }
  if (!(await hasOpenShortage(tx, order.id))) {
    const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id } })
    if (flagsOf(fresh).brakuje) await tx.order.update({ where: { id: order.id }, data: { flags: mergeFlags(fresh, { brakuje: false }) } })
  } else if (short > 0) {
    const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id } })
    await tx.order.update({ where: { id: order.id }, data: { flags: mergeFlags(fresh, { brakuje: true }) } })
  }
  await refreshShortageWait(tx, order.id, now) // edycja może zabrać ostatnią rezerwację albo zamknąć braki
  await book.flush(tx, now)
  return { orderId: order.id, outcome: 'ZMIANA', reservedUnits: reserved, shortUnits: short, status }
}

/**
 * Znacznik nieudanej płatności online po odczycie z kanału: raz ustawiony zostaje (np. Woo `failed` → `pending` przy
 * ponownej próbie tej samej bramki), schodzi przy metodzie offline (klient wybrał przelew tradycyjny) i przy wpłacie.
 */
function failedOnlineAfter(prev: boolean, input: Pick<IncomingOrder, 'paymentFailedOnline' | 'paymentOffline' | 'paymentState'>): boolean {
  if (input.paymentOffline || isPaid(input.paymentState)) return false
  return prev || !!input.paymentFailedOnline
}

/**
 * Termin przypomnienia nieopłaconego: zwykły z zasad firmy, a przy nieudanej płatności online bez żadnej wpłaty pytanie
 * o płatność rano po N dniach kalendarzowych od `from` (`failedOnlineRemindAt`: nie w przeszłości, przed terminem
 * anulowania). Częściowo opłacone dostaje zwykły mail, więc i zwykły termin.
 */
function remindAtOf(terms: Terms, failedOnlineUnpaid: boolean, from: Date, policy: Policy, now: Date): Date {
  return failedOnlineUnpaid ? failedOnlineRemindAt(from, policy, terms.remindAt, terms.reservationDeadline, now) : terms.remindAt
}

/**
 * Zmiana znacznika nieudanej płatności online na zamówieniu już przyjętym (pod blokadą, w transakcji odczytu kanału).
 * Działa tylko dla zamówienia otwartego, nieopłaconego i z terminem płatności; zwykłe terminy (przypomnienie,
 * anulowanie) się nie zmieniają. Włączenie = termin zwolnienia towaru od złożenia z zasad firmy (minął → zwolnienie od
 * razu, gdy zamówienie jest w Nowych; w „Do wyjaśnienia” zwolni je worker po wyjaśnieniu). Zdjęcie (klient wybrał
 * przelew tradycyjny albo pobranie) = bez terminu zwolnienia, a towar już zwolniony wraca na to, co jest na stanie.
 * Anulowane i opłacone: sam znacznik.
 */
async function updateFailedOnlinePayment(tx: Tx, book: StockBook, cat: Map<string, CatalogEntry>, orderId: string, input: Pick<IncomingOrder, 'paymentFailedOnline' | 'paymentOffline' | 'paymentState'>, actorId: string, now: Date): Promise<void> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
  const prev = flagsOf(o).nieudanaPlatnoscOnline === true
  const next = failedOnlineAfter(prev, input)
  if (prev === next) return
  await tx.order.update({ where: { id: orderId }, data: { flags: mergeFlags(o, { nieudanaPlatnoscOnline: next || undefined }) } })
  if (o.status === 'ANULOWANE' || isPaid(o.paymentState) || isPaid(input.paymentState) || !o.reservationDeadline) return
  // po zbieraniu albo po zamknięciu (np. punkt cięcia): towar nie wraca do zamówienia, same terminy zwolnienia schodzą
  if (!przedZbieraniem(o)) {
    if (o.stockReleaseAt || o.stockReleasedAt) await tx.order.update({ where: { id: orderId }, data: { stockReleaseAt: null, stockReleasedAt: null } })
    return
  }
  const policy = await getPolicy(tx)
  // przypomnienie jeszcze nie poszło: przy nieudanej płatności online bez wpłaty pytanie o płatność rano (nie w
  // przeszłości), w pozostałych przypadkach (znacznik zdjęty: przelew tradycyjny; częściowa wpłata) zwykły termin z zasad
  // przyjęcia, nie wcześniej niż dotychczasowy i nie po terminie anulowania (zasady mogły się zmienić po przyjęciu)
  if (!o.reminderSentAt && o.remindAt) {
    const regular = termsFor(o.createdAtChannel, { ...policy, seasonMode: o.termsSeasonMode ?? policy.seasonMode }).remindAt
    const zwykly = regular < o.reservationDeadline ? new Date(Math.max(regular.getTime(), o.remindAt.getTime())) : o.remindAt
    const remindAt = next && input.paymentState === 'UNPAID' ? failedOnlineRemindAt(o.createdAtChannel, policy, o.remindAt, o.reservationDeadline, now) : zwykly
    if (remindAt.getTime() !== o.remindAt.getTime()) await tx.order.update({ where: { id: orderId }, data: { remindAt } })
  }
  if (next) {
    if (o.stockReleasedAt) return
    const at = stockReleaseAtFor(o.createdAtChannel, policy)
    await tx.order.update({ where: { id: orderId }, data: { stockReleaseAt: at } })
    await tx.orderEvent.create({ data: { orderId, kind: 'NIEUDANA_PLATNOSC_ONLINE', actorId, data: { zwolnienieTowaru: at.toISOString() } } })
    if (at <= now && o.status === 'NOWE' && o.paymentState === 'UNPAID') await releaseStockInTx(tx, book, orderId, actorId, now)
    return
  }
  await tx.order.update({ where: { id: orderId }, data: { stockReleaseAt: null } })
  await tx.orderEvent.create({ data: { orderId, kind: 'PLATNOSC_OFFLINE', actorId, data: { towarZwolniony: !!o.stockReleasedAt } } })
  if (o.stockReleasedAt) await reserveReleasedInTx(tx, book, cat, orderId, actorId, now)
}

/**
 * Zwolnienie towaru zamówienia z nieudaną płatnością online po krótkim terminie (blokady zamówienia i stanów już
 * wzięte). Zamówienie zostaje otwarte i nieopłacone (status, płatność, zwykłe terminy bez zmian, do sklepu nic nie
 * idzie); rezerwacje zwolnione, braki zamknięte, znacznik `stockReleasedAt`. Stan wraca do kanałów jak przy anulowaniu.
 */
async function releaseStockInTx(tx: Tx, book: StockBook, orderId: string, actorId: string, now: Date): Promise<number> {
  const released = await releaseOrder(tx, book, orderId, 'FAILED_ONLINE_PAYMENT', now)
  const fresh = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
  const godzin = (await getPolicy(tx)).failedOnlinePaymentHoldHours
  await tx.order.update({ where: { id: orderId }, data: { stockReleaseAt: null, stockReleasedAt: now, shortageWaitUntil: null, flags: mergeFlags(fresh, { brakuje: false }) } })
  await tx.orderEvent.create({ data: { orderId, kind: 'TOWAR_ZWOLNIONY', actorId, data: { released, godzin } } })
  await forcePushForOrder(tx, fresh, now)
  return released
}

/**
 * Towar zwolniony po nieudanej płatności online wraca do zamówienia (wpłata albo przelew tradycyjny; blokady wzięte):
 * rezerwacja od nowa na to, co jest dostępne, reszta na braki zwykłą drogą (flaga `brakuje`, termin „brak wszystkiego”).
 * Status zostawia wywołujący. Bez znacznika zwolnienia nic nie robi (idempotentne).
 */
async function reserveReleasedInTx(tx: Tx, book: StockBook, cat: Map<string, CatalogEntry>, orderId: string, actorId: string, now: Date): Promise<{ reserved: number; short: number }> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } })
  if (!order.stockReleasedAt) return { reserved: 0, short: 0 }
  if (!przedZbieraniem(order)) {
    // zamówienie już poza Nowymi (np. zamknięte punktem cięcia, bo obsłużył je inny system): rezerwacja nie miałaby kto
    // zużyć, więc tylko znaczniki zwolnienia schodzą
    await tx.order.update({ where: { id: orderId }, data: { stockReleasedAt: null, stockReleaseAt: null } })
    return { reserved: 0, short: 0 }
  }
  let reserved = 0
  let short = 0
  for (const l of order.lines) {
    if (l.removed || !l.productId) continue
    const entry = cat.get(l.productId)
    if (!entry) continue
    const r = await reserveUnits(tx, book, order.id, l.id, entry, l.qty - l.qtyRejected)
    reserved += r.reservedUnits
    short += r.shortUnits
  }
  // zamówienie bez wysyłki (same e-booki przy przyjęciu), a po zwolnieniu doszedł towar fizyczny: bez przewoźnika
  // nikt go nie wyśle, więc decyzja obsługi
  const clarify = order.carrier === 'BEZ_WYSYLKI' && reserved + short > 0 ? setClarify(order, POWOD_TOWAR_BEZ_WYSYLKI) : {}
  await tx.order.update({ where: { id: orderId }, data: { ...clarify, stockReleasedAt: null, stockReleaseAt: null, flags: mergeFlags({ flags: (clarify as Partial<Order>).flags ?? order.flags }, { brakuje: short > 0 }) } as never })
  await tx.orderEvent.create({ data: { orderId, kind: 'TOWAR_ZAREZERWOWANY_PONOWNIE', actorId, data: { reserved, short } } })
  await refreshShortageWait(tx, orderId, now)
  return { reserved, short }
}

/** Powód „Do wyjaśnienia”: towar fizyczny w zamówieniu bez wysyłki po powrocie rezerwacji. */
export const POWOD_TOWAR_BEZ_WYSYLKI = 'towar w zamówieniu bez wysyłki'

/**
 * Etap przed zbieraniem, w którym towar zwolniony po nieudanej płatności online może wrócić do zamówienia: Nowe albo
 * Do wyjaśnienia z Nowych / Do realizacji (albo bez zapisanego etapu).
 */
export function przedZbieraniem(o: Pick<Order, 'status' | 'statusBeforeClarify'>): boolean {
  if (o.status === 'NOWE') return true
  return o.status === 'DO_WYJASNIENIA' && (o.statusBeforeClarify === null || o.statusBeforeClarify === 'NOWE' || o.statusBeforeClarify === 'DO_REALIZACJI')
}

/** Kto anulował zamówienie (ostatnie zdarzenie ANULOWANE): `system:<źródło>` dla kanału, inaczej obsługa albo rdzeń. */
async function cancelledBy(tx: Tx, orderId: string): Promise<string | null> {
  const e = await tx.orderEvent.findFirst({ where: { orderId, kind: 'ANULOWANE' }, orderBy: { createdAt: 'desc' }, select: { actorId: true } })
  return e?.actorId ?? null
}

/**
 * Reaktywacja anulowanego w kanale (blokady już wzięte): pozycje dostają rezerwację od nowa (braki → Shortage),
 * status naturalny wg płatności, przy brakach, niezmapowanej ofercie albo nieznanej metodzie dostawy → DO_WYJASNIENIA.
 * Po fakturze (CONSUMED) zwraca null: towar już wyszedł w BL/wFirmie, decyzja obsługi (alert).
 * Termin płatności nieopłaconego liczy się od `termsFrom` (domyślnie chwila przywrócenia).
 */
async function reactivateInTx(
  tx: Tx,
  book: StockBook,
  order: Order & { lines: { id: string; productId: string | null; qty: number; qtyRejected: number; removed: boolean }[] },
  input: Pick<IncomingOrder, 'paymentState' | 'paymentFailedOnline' | 'paymentOffline'>,
  cat: Map<string, CatalogEntry>,
  actorId: string,
  now: Date,
  termsFrom: Date = now,
  eventKind = 'PRZYWROCONE_W_KANALE',
): Promise<{ order: Order; reserved: number; short: number } | null> {
  const invoiced = (await tx.reservation.count({ where: { orderId: order.id, state: 'CONSUMED' } })) + (await tx.invoiceAttempt.count({ where: { orderId: order.id, state: 'ISSUED' } }))
  if (invoiced > 0) {
    await alert(tx, 'REAKTYWACJA_PO_FAKTURZE', order.id, 'Zamówienie anulowane po fakturze wróciło w kanale jako otwarte — sprawdź i przywróć ręcznie albo anuluj w kanale', `reaktywacja-po-fakturze:${order.id}`)
    return null
  }
  let reserved = 0
  let short = 0
  for (const l of order.lines) {
    if (l.removed || !l.productId) continue
    const entry = cat.get(l.productId)
    if (!entry) continue
    const r = await reserveUnits(tx, book, order.id, l.id, entry, l.qty - l.qtyRejected)
    reserved += r.reservedUnits
    short += r.shortUnits
  }
  const paid = isPaid(input.paymentState)
  const natural: OrderStatus = paid ? 'DO_REALIZACJI' : 'NOWE'
  // nieudana płatność online (znacznik z kanału albo zapisany wcześniej): termin zwolnienia towaru od `termsFrom`
  const failedOnline = failedOnlineAfter(flagsOf(order).nieudanaPlatnoscOnline === true, input)
  const policy = await getPolicy(tx)
  const terms = paid ? null : termsFor(termsFrom, policy) // nowy termin płatności (domyślnie od chwili przywrócenia)
  const stockReleaseAt = terms && failedOnline ? stockReleaseAtFor(termsFrom, policy) : null
  const reasons: string[] = []
  if (short > 0) reasons.push('przywrócone w kanale po anulowaniu: brak towaru')
  if (order.lines.some((l) => !l.removed && !l.productId)) reasons.push('niezmapowana oferta')
  if (order.carrier === 'BRAK') reasons.push(`nieznana metoda dostawy: ${order.deliveryMethod ?? '(brak)'}`)
  const upd: Partial<Order> = {
    status: reasons.length ? 'DO_WYJASNIENIA' : natural,
    statusBeforeClarify: reasons.length ? natural : null,
    cancelReason: null,
    pendingAction: null,
    paymentState: input.paymentState,
    termsSeasonMode: terms ? terms.seasonMode : order.termsSeasonMode,
    remindAt: terms ? remindAtOf(terms, failedOnline && input.paymentState === 'UNPAID', termsFrom, policy, now) : null,
    reminderSentAt: null,
    reservationDeadline: terms?.reservationDeadline ?? null,
    stockReleaseAt,
    stockReleasedAt: null,
    shortageWaitUntil: short > 0 && reserved === 0 ? addBusinessDays(now, policy.allOutOfStockWaitBusinessDays) : null,
    flags: mergeFlags(order, { brakuje: short > 0 || undefined, doWyjasnienia: reasons.length ? reasons.join('; ') : null, niedoplata: input.paymentState === 'PARTIAL' || undefined, nieudanaPlatnoscOnline: failedOnline || undefined }) as Order['flags'],
  }
  const fresh = await tx.order.update({ where: { id: order.id }, data: upd as never })
  await tx.orderEvent.create({ data: { orderId: order.id, kind: eventKind, actorId, data: { reserved, short, status: upd.status } } })
  if (stockReleaseAt && stockReleaseAt <= now && upd.status === 'NOWE' && input.paymentState === 'UNPAID') {
    await releaseStockInTx(tx, book, order.id, actorId, now)
    return { order: await tx.order.findUniqueOrThrow({ where: { id: order.id } }), reserved: 0, short: 0 }
  }
  return { order: fresh, reserved, short }
}

/** Wynik przeliczenia zamówienia anulowanego przez kanał z powodu nieudanej płatności. */
export type WynikNieudanejPlatnosci = 'otwarte' | 'otwarte-zwolnione' | 'po-terminie' | 'pominiete'

/**
 * Zamówienie przyjęte jako anulowane przez kanał, choć w kanale jest tylko nieudana płatność (Woo `failed`, dawna mapa
 * adaptera): dziś takie zamówienie jest otwarte i nieopłacone jak `pending`. Termin płatności z polityki firmy liczony
 * od złożenia zamówienia (jak przy przyjęciu):
 * - termin nie minął → rezerwacja od nowa (braki → Do wyjaśnienia), status Nowe, przypomnienie i mail „Brak płatności”
 *   wg zwykłych terminów; zamówienie liczy się jako nieudana płatność online (polecenie bierze tylko kopie w statusie
 *   nieudanej płatności; przelew tradycyjny poprawi się sam przy kolejnej zmianie w sklepie), więc gdy krótki termin od
 *   złożenia już minął, towar zwalnia się od razu ('otwarte-zwolnione': otwarte, bez rezerwacji, czeka na płatność);
 * - termin minął → tylko powód anulowania „nieopłacone po terminie” (EXPIRED_UNPAID), bez ruchu rezerwacji i stanów
 *   (rezerwacja zwolniona przy anulowaniu), czyli stan, w którym zamówienie byłoby, gdyby od początku było otwarte.
 * Warunki sprawdzane pod blokadą zamówienia: Anulowane i nieopłacone, bez faktury, a do tego albo powód CANCELLED
 * z ostatnim anulowaniem z odczytu tego konta (`system:poll:<kanał>:<konto>`), albo zamówienie przyjęte od razu jako
 * anulowane przez ten odczyt (bez powodu i bez anulowania w dzienniku). Do tego ostatni status kopii zamówienia z kanału
 * musi być `statusKanalu` (nieudana płatność): sprawdzane tu, pod blokadą, a nie u wywołującego, żeby zamówienie
 * anulowane w sklepie (np. `failed` → `cancelled` między wyborem kandydatów a blokadą) nie wróciło do „Nowe” z
 * rezerwacją. Inne = 'pominiete' (nic nie zmienia). Idempotentne.
 */
export async function przywrocNieudanaPlatnosc(db: Db, orderId: string, ctx: Ctx & { naSucho?: boolean; statusKanalu: string }): Promise<WynikNieudanejPlatnosci> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  const actorId = ctx.actorId ?? 'system:nieudana-platnosc'
  return runTx(db, async (tx) => {
    const order = await lockOrderById(tx, orderId)
    if (order.status !== 'ANULOWANE' || order.paymentState !== 'UNPAID') return 'pominiete'
    // kopia z kanału czytana pod blokadą zamówienia. Odczyt kanału zapisuje kopię przed przyjęciem do rdzenia: nowszy
    // status (np. cancelled) widoczny tu = pomijamy; zapisany po naszym odczycie = przyjęcie tej rewizji idzie pod tą samą
    // blokadą już po przywróceniu i anuluje zamówienie zwykłą ścieżką (towar wraca).
    const kopia = await tx.channelOrderSnapshot.findFirst({ where: { channel: order.channel, channelAccountId: order.channelAccountId, externalId: order.externalId }, select: { channelStatus: true } })
    if (!ctx.statusKanalu || kopia?.channelStatus !== ctx.statusKanalu) return 'pominiete'
    const odczyt = `system:poll:${order.channel}:${order.channelAccountId}`
    if (order.cancelReason === 'CANCELLED') {
      // anulowane po przyjęciu: ostatnie anulowanie z odczytu tego konta
      if ((await cancelledBy(tx, order.id)) !== odczyt) return 'pominiete'
    } else if (order.cancelReason === null) {
      // przyjęte od razu jako anulowane (pierwszy odczyt już w statusie nieudanej płatności): bez anulowania w dzienniku
      if (await tx.orderEvent.count({ where: { orderId, kind: 'ANULOWANE' } })) return 'pominiete'
      const przyjete = await tx.orderEvent.findFirst({ where: { orderId, kind: 'PRZYJETE' }, select: { actorId: true } })
      if (przyjete?.actorId !== odczyt) return 'pominiete'
    } else return 'pominiete'
    const invoiced = (await tx.reservation.count({ where: { orderId, state: { in: ['CONSUMING', 'CONSUMED'] } } })) + (await tx.invoiceAttempt.count({ where: { orderId } }))
    if (invoiced > 0) return 'pominiete'
    const terms = termsFor(order.createdAtChannel, await getPolicy(tx))
    if (terms.reservationDeadline <= now) {
      if (ctx.naSucho) return 'po-terminie'
      await tx.order.update({ where: { id: orderId }, data: { cancelReason: 'EXPIRED_UNPAID' } })
      await tx.orderEvent.create({ data: { orderId, kind: 'NIEUDANA_PLATNOSC_PO_TERMINIE', actorId, data: { terminAnulowania: terms.reservationDeadline.toISOString() } } })
      return 'po-terminie'
    }
    // na sucho bez rezerwacji: zwolnienie od razu zakłada Nowe (przy braku towaru zamówienie poszłoby do wyjaśnienia)
    if (ctx.naSucho) return stockReleaseAtFor(order.createdAtChannel, await getPolicy(tx)) <= now ? 'otwarte-zwolnione' : 'otwarte'
    const { book, cat } = await bookForOrder(tx, orderId, wh)
    const full = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } })
    const fresh = await reactivateInTx(tx, book, full, { paymentState: order.paymentState, paymentFailedOnline: true }, cat, actorId, now, order.createdAtChannel, 'NIEUDANA_PLATNOSC_OTWARTE')
    if (!fresh) return 'pominiete'
    await refreshShortageWait(tx, orderId, now)
    await book.flush(tx, now)
    return fresh.order.stockReleasedAt ? 'otwarte-zwolnione' : 'otwarte'
  })
}

/** Wynik oznaczenia otwartego zamówienia jako nieudanej płatności online. */
export type WynikOznaczeniaNieudanej = 'oznaczone' | 'oznaczone-zwolnione' | 'pominiete'

/**
 * Zamówienie otwarte i nieopłacone, przyjęte przed rozpoznawaniem nieudanej płatności online (bez znacznika), choć
 * ostatni status kopii z kanału to nieudana płatność (`statusKanalu`, Woo `failed`): dostaje to, co dostałoby przy
 * przyjęciu dziś, tą samą drogą co odczyt kanału (`updateFailedOnlinePayment`): znacznik, termin zwolnienia towaru od
 * złożenia z zasad firmy (minął = towar zwolniony od razu, gdy zamówienie jest w Nowych i bez wpłaty) i przypomnienie
 * z pytaniem o płatność rano następnego dnia (gdy przypomnienie jeszcze nie poszło). Termin anulowania bez zmian.
 * Warunki pod blokadą: przed zbieraniem, nieopłacone, z terminem płatności, bez znacznika, kopia w `statusKanalu`.
 * Inne = 'pominiete'. Idempotentne (drugie przejście widzi znacznik).
 */
export async function oznaczNieudanaPlatnoscOtwartego(db: Db, orderId: string, ctx: Ctx & { naSucho?: boolean; statusKanalu: string }): Promise<WynikOznaczeniaNieudanej> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  const actorId = ctx.actorId ?? 'system:nieudana-platnosc'
  return runTx(db, async (tx) => {
    const order = await lockOrderById(tx, orderId)
    if (!przedZbieraniem(order) || isPaid(order.paymentState) || !order.reservationDeadline || flagsOf(order).nieudanaPlatnoscOnline === true) return 'pominiete'
    const kopia = await tx.channelOrderSnapshot.findFirst({ where: { channel: order.channel, channelAccountId: order.channelAccountId, externalId: order.externalId }, select: { channelStatus: true } })
    if (!ctx.statusKanalu || kopia?.channelStatus !== ctx.statusKanalu) return 'pominiete'
    if ((await tx.reservation.count({ where: { orderId, state: { in: ['CONSUMING', 'CONSUMED'] } } })) > 0) return 'pominiete'
    const policy = await getPolicy(tx)
    const zwolni = order.status === 'NOWE' && order.paymentState === 'UNPAID' && stockReleaseAtFor(order.createdAtChannel, policy) <= now
    if (ctx.naSucho) return zwolni ? 'oznaczone-zwolnione' : 'oznaczone'
    const { book, cat } = await bookForOrder(tx, orderId, wh)
    await updateFailedOnlinePayment(tx, book, cat, orderId, { paymentState: order.paymentState, paymentFailedOnline: true, paymentOffline: false }, actorId, now)
    await book.flush(tx, now)
    const fresh = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { stockReleasedAt: true } })
    return fresh.stockReleasedAt ? 'oznaczone-zwolnione' : 'oznaczone'
  })
}

/**
 * Płatność w transakcji (blokady już wzięte): T2 albo „płatność po anulowaniu” — rezerwacja próbuje się
 * ponownie, czego nie ma → Shortage + DO_WYJASNIENIA (3.3).
 */
async function applyPaymentInTx(
  tx: Tx,
  book: StockBook,
  orderId: string,
  payment: PaymentState,
  cat: Map<string, CatalogEntry>,
  actorId: string,
  now: Date,
): Promise<OrderStatus> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } })
  if (order.status === 'ANULOWANE' && order.cancelReason === 'EXPIRED_UNPAID') {
    let short = 0
    for (const l of order.lines) {
      if (l.removed || !l.productId) continue
      const entry = cat.get(l.productId)
      if (!entry) continue
      const r = await reserveUnits(tx, book, order.id, l.id, entry, l.qty - l.qtyRejected)
      short += r.shortUnits
    }
    const upd: Partial<Order> = { paymentState: payment, reservationDeadline: null, remindAt: null, stockReleaseAt: null, stockReleasedAt: null, cancelReason: null, status: 'DO_REALIZACJI' }
    if (short > 0)
      Object.assign(upd, setClarify({ ...order, status: 'DO_REALIZACJI' } as Order, 'opłacone po anulowaniu'), {
        flags: mergeFlags(order, { brakuje: true, ...withReasons(['opłacone po anulowaniu']) }),
      })
    await tx.order.update({ where: { id: order.id }, data: upd as never })
    await refreshShortageWait(tx, order.id, now) // pełny brak → termin 3 dni jak przy przyjęciu
    await tx.orderEvent.create({ data: { orderId, kind: 'OPLACONE_PO_ANULOWANIU', actorId, data: { short } } })
    return upd.status as OrderStatus
  }
  if (order.status === 'ANULOWANE') {
    // płatność do zamówienia anulowanego w kanale albo przez obsługę: bez rezerwacji, pieniądze do zwrotu
    await tx.order.update({ where: { id: order.id }, data: { paymentState: payment, flags: mergeFlags(order, withReasons([...clarifyReasons(flagsOf(order)), 'płatność po anulowaniu'])) } })
    await alert(tx, 'PLATNOSC_PO_ANULOWANIU', order.id, 'Płatność do anulowanego zamówienia — zwrot pieniędzy albo przywrócenie przez obsługę', `platnosc-po-anulowaniu:${order.id}`)
    await tx.orderEvent.create({ data: { orderId, kind: 'PLATNOSC_PO_ANULOWANIU', actorId, data: { payment } } })
    return 'ANULOWANE'
  }
  // towar zwolniony po nieudanej płatności online: rezerwacja od nowa na to, co jest, reszta na braki
  if (order.stockReleasedAt) await reserveReleasedInTx(tx, book, cat, orderId, actorId, now)
  // po powrocie rezerwacji świeży wiersz (powrót mógł przenieść zamówienie do „Do wyjaśnienia”)
  const current = order.stockReleasedAt ? await tx.order.findUniqueOrThrow({ where: { id: orderId } }) : order
  const upd: Partial<Order> = { paymentState: payment, reservationDeadline: null, remindAt: null, stockReleaseAt: null }
  if (current.status === 'NOWE') upd.status = 'DO_REALIZACJI'
  if (current.status === 'DO_WYJASNIENIA' && current.statusBeforeClarify === 'NOWE') upd.statusBeforeClarify = 'DO_REALIZACJI'
  await tx.order.update({ where: { id: order.id }, data: { ...upd, flags: mergeFlags(current, { niedoplata: false }) } as never })
  await tx.orderEvent.create({ data: { orderId, kind: 'OPLACONE', actorId, data: { payment } } })
  return (upd.status ?? current.status) as OrderStatus
}

async function lockOrderById(tx: Tx, orderId: string): Promise<Order> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
  await advisoryLock(tx, orderLockKey(o))
  return tx.order.findUniqueOrThrow({ where: { id: orderId } })
}

async function bookForOrder(tx: Tx, orderId: string, wh: string): Promise<{ book: StockBook; cat: Map<string, CatalogEntry> }> {
  const lines = await tx.orderLine.findMany({ where: { orderId }, select: { productId: true } })
  const cat = await loadCatalog(tx, lines.map((l) => l.productId).filter((x): x is string => !!x))
  const book = await StockBook.lock(tx, wh, [...partIds(cat, lines.map((l) => l.productId)), ...(await productsOfOrder(tx, orderId))])
  return { book, cat }
}

/** Wynik powrotu rezerwacji jednego zamówienia (przygotowanie do powrotu na wersję bez zwalniania samego towaru). */
export type WynikPowrotuRezerwacji = 'przywrocone' | 'znaczniki-zdjete' | 'termin-zdjety' | 'bez-zmian'

/**
 * Powrót rezerwacji zamówienia ze zwolnionym towarem po nieudanej płatności online (pod blokadą zamówienia i stanów):
 * - towar zwolniony, zamówienie w Nowych albo „Do wyjaśnienia” → rezerwacja od nowa drogą wpłaty (czego nie ma,
 *   idzie na listę braków), znaczniki zwolnienia schodzą ('przywrocone');
 * - towar zwolniony, zamówienie już dalej (np. zamknięte punktem cięcia) → same znaczniki schodzą ('znaczniki-zdjete');
 * - tylko termin zwolnienia (towar jeszcze trzymany) → termin schodzi, rezerwacja zostaje ('termin-zdjety').
 * Po tym zamówienie wygląda jak każde nieopłacone ze zwykłymi terminami. Na sucho nic nie zapisuje. Powtórka nic nie zmienia.
 */
export async function przywrocRezerwacjeZwolnionego(db: Db, orderId: string, ctx: Ctx & { naSucho?: boolean } = {}): Promise<{ wynik: WynikPowrotuRezerwacji; reserved: number; short: number }> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  const actorId = ctx.actorId ?? 'system:powrot-rezerwacji'
  return runTx(db, async (tx) => {
    const order = await lockOrderById(tx, orderId)
    if (order.stockReleasedAt && order.status !== 'ANULOWANE') {
      const wynik: WynikPowrotuRezerwacji = przedZbieraniem(order) ? 'przywrocone' : 'znaczniki-zdjete'
      if (ctx.naSucho) return { wynik, reserved: 0, short: 0 }
      const { book, cat } = await bookForOrder(tx, orderId, wh)
      const r = await reserveReleasedInTx(tx, book, cat, orderId, actorId, now)
      await book.flush(tx, now)
      return { wynik, ...r }
    }
    if (!order.stockReleaseAt && !order.stockReleasedAt) return { wynik: 'bez-zmian', reserved: 0, short: 0 }
    if (!ctx.naSucho) await tx.order.update({ where: { id: orderId }, data: { stockReleaseAt: null, stockReleasedAt: null } })
    return { wynik: 'termin-zdjety', reserved: 0, short: 0 }
  })
}

/** Płatność z bramki / panelu (T2). „Płatność i anulowanie wygrywają z przeterminowaniem” (5.3). */
export async function markPaid(db: Db, orderId: string, payment: 'PAID' | 'COD' = 'PAID', ctx: Ctx = {}): Promise<OrderStatus> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  return runTx(db, async (tx) => {
    const order = await lockOrderById(tx, orderId)
    if (isPaid(order.paymentState)) return order.status
    const { book, cat } = await bookForOrder(tx, orderId, wh)
    const st = await applyPaymentInTx(tx, book, orderId, payment, cat, ctx.actorId ?? 'system:platnosc', now)
    await book.flush(tx, now)
    await hintAllocate(tx, orderId, now)
    return st
  })
}

/**
 * Anulowanie w transakcji (T5/T6). Faktura w drodze (CONSUMING) → odłożone do rozstrzygnięcia ruchu (3.5).
 * Po fakturze: stan nie wraca sam, zamówienie na liście „do korekty i zwrotu na półkę”.
 */
export async function cancelInTx(
  tx: Tx,
  book: StockBook,
  order: Pick<Order, 'id' | 'flags' | 'status'>,
  reason: 'CANCELLED' | 'EXPIRED_UNPAID',
  actorId: string,
  now: Date,
): Promise<OrderStatus> {
  if (order.status === 'ANULOWANE') return 'ANULOWANE'
  // faktura samej usługi (zamówienie bez wysyłki) nie ma rezerwacji: w drodze i po fakturze liczy próba faktury
  const consuming =
    (await tx.reservation.count({ where: { orderId: order.id, state: 'CONSUMING' } })) +
    // dokument bez rozchodu nie blokuje anulowania: stan prowadzi rdzeń, a dokument,
    // który wejdzie już po anulowaniu, dostaje „do korekty” w `completeInvoice`
    (await tx.invoiceAttempt.count({ where: { orderId: order.id, documentOnly: false, state: { in: ['SENDING', 'UNKNOWN'] } } }))
  if (consuming > 0) {
    await tx.order.update({ where: { id: order.id }, data: { pendingAction: `CANCEL:${reason}` } })
    await tx.orderEvent.create({ data: { orderId: order.id, kind: 'ANULOWANIE_ODLOZONE', actorId, data: { reason } } })
    return order.status
  }
  const consumed =
    (await tx.reservation.count({ where: { orderId: order.id, state: 'CONSUMED' } })) + (await tx.invoiceAttempt.count({ where: { orderId: order.id, state: 'ISSUED' } }))
  const released = await releaseOrder(tx, book, order.id, reason, now)
  const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id } })
  await tx.order.update({
    where: { id: order.id },
    data: {
      status: 'ANULOWANE',
      cancelReason: reason,
      pendingAction: null,
      reservationDeadline: null,
      stockReleaseAt: null,
      stockReleasedAt: null,
      shortageWaitUntil: null,
      flags: mergeFlags(fresh, { doKorekty: consumed > 0 || undefined, brakuje: false }),
    },
  })
  await zwolnijKoszykPoStatusie(tx, order.id, 'ANULOWANE') // anulowane wychodzi z koszyka
  await tx.orderEvent.create({ data: { orderId: order.id, kind: 'ANULOWANE', actorId, data: { reason, released, poFakturze: consumed > 0 } } })
  await forcePushForOrder(tx, fresh, now) // kanał oddał sobie sztuki anulowanego zamówienia (6.1 pkt 4)
  return 'ANULOWANE'
}

export async function cancelOrder(db: Db, orderId: string, ctx: Ctx = {}): Promise<OrderStatus> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  return runTx(db, async (tx) => {
    const order = await lockOrderById(tx, orderId)
    const { book } = await bookForOrder(tx, orderId, wh)
    const st = await cancelInTx(tx, book, order, 'CANCELLED', ctx.actorId ?? 'system:anulowanie', now)
    await book.flush(tx, now)
    return st
  })
}

/** Po zmapowaniu oferty: pozycje niezmapowane dostają produkt i rezerwację (przypadek 6). */
export async function remapOrder(db: Db, orderId: string, ctx: Ctx = {}): Promise<{ mapped: number; stillUnmapped: number }> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  return runTx(db, async (tx) => {
    const order = await lockOrderById(tx, orderId)
    const lines = await tx.orderLine.findMany({ where: { orderId, productId: null, removed: false } })
    const offers = await tx.channelOffer.findMany({
      where: { channel: order.channel, channelAccountId: order.channelAccountId, externalId: { in: lines.map((l) => l.offerId).filter((x): x is string => !!x) }, active: true },
    })
    const byExt = new Map(offers.map((o) => [o.externalId, o]))
    const mappedLines = await tx.orderLine.findMany({ where: { orderId, productId: { not: null } }, select: { productId: true } })
    const cat = await loadCatalog(tx, [...offers.map((o) => o.productId), ...mappedLines.map((l) => l.productId!)])
    // jedna blokada na wszystkie produkty zamówienia i nowo zmapowane (kolejność productId)
    const book = await StockBook.lock(tx, wh, [
      ...partIds(cat, [...offers.map((o) => o.productId), ...mappedLines.map((l) => l.productId)]),
      ...(await productsOfOrder(tx, orderId)),
    ])
    let mapped = 0
    let short = 0
    for (const l of lines) {
      const off = l.offerId ? byExt.get(l.offerId) : undefined
      const entry = off ? cat.get(off.productId) : undefined
      if (!off || !entry) continue
      // pozycja bez produktu ma w `qty` ilość z kanału (sztuki oferty)
      const kanal = l.qtyChannel ?? l.qty
      const qty = kanal * off.qtyBasePerOffer
      await tx.orderLine.update({ where: { id: l.id }, data: { productId: off.productId, qty, qtyChannel: kanal } })
      // towar zwolniony po nieudanej płatności online: sam produkt w pozycji, rezerwacja dopiero po wpłacie
      // albo po zmianie na przelew tradycyjny (`reserveReleasedInTx` bierze bieżące pozycje)
      if (!order.stockReleasedAt) short += (await reserveUnits(tx, book, orderId, l.id, entry, qty)).shortUnits
      mapped++
    }
    const still = await tx.orderLine.count({ where: { orderId, productId: null, removed: false } })
    const fresh = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
    const f = flagsOf(fresh)
    const reasons = clarifyReasons(f)
    if (still === 0 && fresh.status === 'DO_WYJASNIENIA' && reasons.includes('niezmapowana oferta')) {
      // zdejmujemy tylko powód „niezmapowana oferta”; inne powody zostają, a bez nich zamówienie wraca samo
      const rest = reasons.filter((r) => r !== 'niezmapowana oferta')
      await tx.order.update({
        where: { id: orderId },
        data: rest.length
          ? { flags: mergeFlags(fresh, { ...withReasons(rest), brakuje: short > 0 || f.brakuje }) }
          : { status: recomputeStatus(fresh), statusBeforeClarify: null, flags: mergeFlags(fresh, { ...withReasons([]), brakuje: short > 0 || f.brakuje }) },
      })
    } else if (short > 0) await tx.order.update({ where: { id: orderId }, data: { flags: mergeFlags(fresh, { brakuje: true }) } })
    await refreshShortageWait(tx, orderId, now)
    await book.flush(tx, now)
    await hintAllocate(tx, orderId, now)
    return { mapped, stillUnmapped: still }
  })
}

/** powód, dla którego pozycji oferty nie przepinamy automatem (zostaje z poprzednim produktem i ilością). */
export type PowodPominiecia = 'ETAP' | 'EDYTOWANE' | 'BEZ_WYSYLKI' | 'FAKTURA' | 'DOSLANE' | 'PRZELICZNIK' | 'PRODUKT'

/**
 * przepięcie oferty na inny produkt albo zmiana jej przelicznika (karta produktu → Powiązania). Oferta jest
 * już zapisana z nowym produktem i przelicznikiem; tu pozycje tej oferty, które w zamówieniu przed zbieraniem dalej
 * wskazują `fromProductId`, dostają produkt i ilość oferty: nowa ilość = ilość z kanału (`qtyChannel`) × przelicznik
 * oferty (pozycje sprzed migracji bez `qtyChannel`: stara ilość ÷ `fromQtyBasePerOffer`). Inny produkt: rezerwacja
 * i braki starego zwolnione (`LINE_CHANGED`), nowa rezerwacja jak przy przyjęciu. Ten sam produkt (zmiana przelicznika):
 * różnica dorezerwowana albo zwolniona, jak przy edycji ilości w kanale. Jedna transakcja na zamówienie, więc pozycja
 * nigdy nie zostaje bez produktu. Nie ruszamy: zamówień po wydruku karty i dalej, edytowanych z karty (porównanie
 * z kanałem idzie po zdjęciu pozycji), bez wysyłki, pozycji z fakturą, dosłanych albo zamienionych i takich, których
 * ilości nie da się przeliczyć. Nic nie idzie do kanału.
 */
export async function przepnijPozycjeOferty(
  db: Db,
  orderId: string,
  p: { offerId: string; fromProductId: string; fromQtyBasePerOffer: number; actorId: string },
  ctx: Ctx = {},
): Promise<{ przepiete: number; pominiete: PowodPominiecia[] }> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  return runTx(db, async (tx) => {
    const order = await lockOrderById(tx, orderId)
    const lines = await tx.orderLine.findMany({ where: { orderId, offerId: p.offerId, productId: p.fromProductId, removed: false } })
    if (!lines.length) return { przepiete: 0, pominiete: [] }
    const off = await tx.channelOffer.findFirst({ where: { channel: order.channel, channelAccountId: order.channelAccountId, externalId: p.offerId, active: true } })
    if (!off) return { przepiete: 0, pominiete: [] }
    const samProdukt = off.productId === p.fromProductId
    const docelowa = (l: { qty: number; qtyChannel: number | null }): number | null =>
      l.qtyChannel !== null ? l.qtyChannel * off.qtyBasePerOffer : p.fromQtyBasePerOffer >= 1 && l.qty % p.fromQtyBasePerOffer === 0 ? (l.qty / p.fromQtyBasePerOffer) * off.qtyBasePerOffer : null
    // ten sam produkt i ilości już zgodne z przelicznikiem: nic do zrobienia (powtórka, drugi przebieg)
    const doZmiany = samProdukt ? lines.filter((l) => docelowa(l) !== l.qty) : lines
    if (!doZmiany.length) return { przepiete: 0, pominiete: [] }
    const stage = order.status === 'DO_WYJASNIENIA' ? (order.statusBeforeClarify ?? 'NOWE') : order.status
    const whole = (powod: PowodPominiecia) => ({ przepiete: 0, pominiete: doZmiany.map(() => powod) })
    if (!REMAP_ORDER_STATUSES.includes(order.status) || !BEFORE_PICKING.includes(stage)) return whole('ETAP')
    if (flagsOf(order).edytowaneLokalnie) return whole('EDYTOWANE')
    if (order.carrier === 'BEZ_WYSYLKI') return whole('BEZ_WYSYLKI')
    const cat = await loadCatalog(tx, [p.fromProductId, off.productId])
    const from = cat.get(p.fromProductId)
    const to = cat.get(off.productId)
    if (!from || !to) return whole('PRODUKT')
    const book = await StockBook.lock(tx, wh, [...partIds(cat, [p.fromProductId, off.productId]), ...(await productsOfOrder(tx, orderId))])
    const invoiced = new Set(
      (await tx.reservation.findMany({ where: { orderLineId: { in: doZmiany.map((l) => l.id) }, state: { in: ['CONSUMING', 'CONSUMED'] } }, select: { orderLineId: true } })).map((r) => r.orderLineId),
    )
    // faktura bez rezerwacji (produkt bez stanu) albo w toku wystawiania: całe zamówienie bez zmian (jak anulowanie)
    if ((await tx.invoiceAttempt.count({ where: { orderId, state: { in: ['SENDING', 'UNKNOWN', 'ISSUED'] } } })) > 0) return whole('FAKTURA')
    const pominiete: PowodPominiecia[] = []
    const zmiany: { pozycja: string; z: number; na: number }[] = []
    let short = 0
    for (const l of doZmiany) {
      if (invoiced.has(l.id)) {
        pominiete.push('FAKTURA')
        continue
      }
      if (l.qtyRejected > 0) {
        pominiete.push('DOSLANE')
        continue
      }
      const qty = docelowa(l)
      if (qty === null || qty < 1) {
        pominiete.push('PRZELICZNIK')
        continue
      }
      const kanal = l.qtyChannel ?? qty / off.qtyBasePerOffer
      if (order.stockReleasedAt) {
        // towar zwolniony po nieudanej płatności online: pozycja bez rezerwacji i bez braków, zmieniamy sam produkt
        // i ilość; rezerwacja od nowa dopiero po wpłacie albo po zmianie na przelew tradycyjny
        await tx.orderLine.update({ where: { id: l.id }, data: { productId: off.productId, qty, qtyChannel: kanal } })
      } else if (samProdukt) {
        if (qty > l.qty) short += (await reserveUnits(tx, book, orderId, l.id, to, qty - l.qty)).shortUnits
        else await reduceUnits(tx, book, l.id, from, l.qty - qty, 'LINE_CHANGED', now)
        await tx.orderLine.update({ where: { id: l.id }, data: { qty, qtyChannel: kanal } })
      } else {
        await reduceUnits(tx, book, l.id, from, l.qty, 'LINE_CHANGED', now)
        await tx.orderLine.update({ where: { id: l.id }, data: { productId: off.productId, qty, qtyChannel: kanal } })
        short += (await reserveUnits(tx, book, orderId, l.id, to, qty)).shortUnits
      }
      zmiany.push({ pozycja: l.externalLineId, z: l.qty, na: qty })
    }
    if (zmiany.length) {
      const fresh = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
      const open = await hasOpenShortage(tx, orderId)
      if (open !== !!flagsOf(fresh).brakuje || short > 0) await tx.order.update({ where: { id: orderId }, data: { flags: mergeFlags(fresh, { brakuje: open }) } })
      await tx.orderEvent.create({
        data: {
          orderId,
          kind: samProdukt ? 'ZMIANA_PRZELICZNIKA_OFERTY' : 'PRZEPIECIE_OFERTY',
          actorId: p.actorId,
          data: { oferta: p.offerId, zProduktu: p.fromProductId, naProdukt: off.productId, przelicznik: off.qtyBasePerOffer, pozycje: zmiany, ...(order.stockReleasedAt ? { bezRezerwacji: true } : {}) },
        },
      })
      await refreshShortageWait(tx, orderId, now)
      await book.flush(tx, now)
      await hintAllocate(tx, orderId, now)
    }
    return { przepiete: zmiany.length, pominiete }
  })
}

/** Statusy, w których przepięcie i remap przeliczają zamówienie (= REMAP_STATUSES z lib/kanaly/przeliczenie.ts). */
const REMAP_ORDER_STATUSES: OrderStatus[] = ['NOWE', 'DO_REALIZACJI', 'DO_WYJASNIENIA']

/**
 * „brakuje wszystkiego” (otwarty brak, żadnej rezerwacji ACTIVE/CONSUMING/CONSUMED) →
 * termin oczekiwania `allOutOfStockWaitBusinessDays` (4.2), jeśli go jeszcze nie ma; coś zarezerwowane albo braki
 * zamknięte → termin zdjęty. Jedna funkcja dla przyjęcia, edycji, „opłacone po anulowaniu” i remapu.
 */
export async function refreshShortageWait(tx: Tx, orderId: string, now: Date): Promise<void> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { shortageWaitUntil: true, status: true } })
  const open = o.status !== 'ANULOWANE' && (await hasOpenShortage(tx, orderId))
  const held = open ? await tx.reservation.count({ where: { orderId, state: { in: ['ACTIVE', 'CONSUMING', 'CONSUMED'] } } }) : 0
  if (open && held === 0) {
    if (!o.shortageWaitUntil) {
      const policy = await getPolicy(tx)
      await tx.order.update({ where: { id: orderId }, data: { shortageWaitUntil: addBusinessDays(now, policy.allOutOfStockWaitBusinessDays) } })
    }
  } else if (o.shortageWaitUntil) await tx.order.update({ where: { id: orderId }, data: { shortageWaitUntil: null } })
}

function recomputeStatus(o: Pick<Order, 'statusBeforeClarify' | 'paymentState'>): OrderStatus {
  const before = o.statusBeforeClarify ?? 'NOWE'
  if (before === 'NOWE' && isPaid(o.paymentState)) return 'DO_REALIZACJI'
  return before
}

/**
 * Zamówienie do wyjaśnienia z zewnątrz (np. kanał nie zna już zamówienia — krok 6): status DO_WYJASNIENIA
 * z powodem, rezerwacje bez zmian (kasowanie stwierdza tylko kanał, decyzja obsługi). Idempotentne dla tego samego
 * powodu; tylko ze statusów `allowed`.
 */
export async function clarifyOrder(db: Db, orderId: string, reason: string, opts: { allowed: OrderStatus[]; actorId: string; now?: Date }): Promise<boolean> {
  return runTx(db, async (tx) => {
    const order = await lockOrderById(tx, orderId)
    if (!opts.allowed.includes(order.status)) return false
    if (order.status === 'DO_WYJASNIENIA' && (flagsOf(order).doWyjasnienia ?? '').includes(reason)) return false
    await tx.order.update({ where: { id: orderId }, data: setClarify(order, reason) as never })
    await tx.orderEvent.create({ data: { orderId, kind: 'DO_WYJASNIENIA', actorId: opts.actorId, data: { reason } } })
    return true
  })
}

/**
 * T15: obsługa rozwiązuje „Do wyjaśnienia” — status przeliczony z uwzględnieniem płatności. Zamówienie bez wysyłki
 * (BEZ_WYSYLKI), które dostało towar edycją w kanale (rezerwacja ACTIVE), wychodzi jak paczka, więc wymaga przewoźnika
 * w `ctx.carrier`: zapisany razem z modułem wysyłki z reguły firmy; bez niego `TransitionError`.
 */
export async function resolveClarification(db: Db, orderId: string, ctx: Ctx & { carrier?: Carrier | null } = {}): Promise<OrderStatus> {
  return runTx(db, async (tx) => {
    const order = await lockOrderById(tx, orderId)
    if (order.status !== 'DO_WYJASNIENIA') return order.status
    const status = recomputeStatus(order)
    let carrier: { carrier: Carrier; shippingModule: ShippingModule } | null = null
    // przewoźnik BRAK (nieznana metoda dostawy) też może dostać przewoźnika z wyboru biura;
    // wymagany jest tylko przy BEZ_WYSYLKI z towarem, karta trybu PRACA wymaga wyboru także przy BRAK z towarem.
    const bezPrzewoznika = order.carrier === 'BRAK' || order.carrier === null
    if ((order.carrier === 'BEZ_WYSYLKI' || (bezPrzewoznika && ctx.carrier)) && (await tx.reservation.count({ where: { orderId, state: 'ACTIVE' } }))) {
      if (!ctx.carrier) throw new TransitionError('W zamówieniu jest towar do wysłania: wybierz przewoźnika')
      if (ctx.carrier === 'BRAK' || ctx.carrier === 'BEZ_WYSYLKI') throw new TransitionError('Towar wymaga przewoźnika paczki albo odbioru osobistego')
      const rule = (await loadCarrierRules(tx)).find((r) => r.carrier === ctx.carrier && (!r.channel || r.channel === order.channel))
      if (!rule) throw new TransitionError('Tego przewoźnika nie ma w regułach firmy (Ustawienia → Wysyłka i druk → Przewoźnicy)')
      carrier = { carrier: rule.carrier, shippingModule: rule.shippingModule }
    }
    await tx.order.update({ where: { id: orderId }, data: { status, statusBeforeClarify: null, flags: mergeFlags(order, withReasons([])), ...(carrier ?? {}) } })
    await tx.orderEvent.create({ data: { orderId, kind: 'WYJASNIONE', actorId: ctx.actorId ?? 'panel', data: { status, ...(carrier ? { przewoznik: carrier.carrier } : {}) } } })
    await hintAllocate(tx, orderId, ctx.now ?? new Date()) // braki mogą dostać towar już leżący na stanie
    return status
  })
}

// ─── Worker reservation-expiry (co 5 min) ────────────────────────────────────

export interface ExpiryStats {
  reminders: number
  released: number
  /** towar zwolniony po nieudanej płatności online (zamówienie zostaje otwarte) */
  stockReleased: number
  toClarify: number
  errors: number
}

/**
 * Przypomnienia, zwolnienia nieopłaconych, „brakuje wszystkiego” po terminie. Każde zamówienie osobno
 * (try/catch, błąd do flags.lastError i alertu), idempotentnie; decyzja pod blokadą zamówienia.
 */
export async function runReservationExpiry(db: Db, ctx: Ctx = {}): Promise<ExpiryStats> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  const stats: ExpiryStats = { reminders: 0, released: 0, stockReleased: 0, toClarify: 0, errors: 0 }
  const due = await db.order.findMany({
    where: {
      status: 'NOWE',
      paymentState: { in: ['UNPAID', 'PARTIAL'] },
      OR: [{ reservationDeadline: { lte: now } }, { stockReleaseAt: { lte: now } }, { remindAt: { lte: now }, reminderSentAt: null }],
    },
    select: { id: true },
    orderBy: { createdAtChannel: 'asc' },
  })
  for (const { id } of due) {
    try {
      const r = await runTx(db, async (tx) => {
        const o = await lockOrderById(tx, id)
        if (o.status !== 'NOWE' || isPaid(o.paymentState)) return []
        if (o.reservationDeadline && o.reservationDeadline <= now) {
          if ((await tx.reservation.count({ where: { orderId: id, state: 'CONSUMING' } })) > 0) return []
          const { book } = await bookForOrder(tx, id, wh)
          await cancelInTx(tx, book, o, 'EXPIRED_UNPAID', 'system:reservation-expiry', now)
          await book.flush(tx, now)
          return ['zwolnione']
        }
        const done: string[] = []
        // nieudana płatność online: sam towar wraca do sprzedaży, zamówienie czeka na płatność do zwykłego terminu
        // tylko bez żadnej wpłaty: częściowo opłacone trzyma towar do zwykłego terminu
        if (o.paymentState === 'UNPAID' && o.stockReleaseAt && o.stockReleaseAt <= now && !o.stockReleasedAt && (await tx.reservation.count({ where: { orderId: id, state: 'CONSUMING' } })) === 0) {
          const { book } = await bookForOrder(tx, id, wh)
          await releaseStockInTx(tx, book, id, 'system:reservation-expiry', now)
          await book.flush(tx, now)
          done.push('towar')
        }
        if (o.remindAt && o.remindAt <= now && !o.reminderSentAt) {
          await tx.order.update({ where: { id }, data: { reminderSentAt: now } })
          // Mail „Brak płatności” wysyła adapter maili (F2); w cieniu tylko zapis „wysłałbym”.
          await tx.orderEvent.create({ data: { orderId: id, kind: 'PRZYPOMNIENIE_WYSLALBYM', actorId: 'system:reservation-expiry', data: { szablon: 'Brak płatności' } } })
          done.push('przypomnienie')
        }
        return done
      })
      if (r.includes('zwolnione')) stats.released++
      if (r.includes('towar')) stats.stockReleased++
      if (r.includes('przypomnienie')) stats.reminders++
    } catch (e) {
      stats.errors++
      await recordOrderError(db, id, e)
    }
  }
  // Brak wszystkiego po terminie → DO_WYJASNIENIA (4.2).
  const waiting = await db.order.findMany({
    where: { shortageWaitUntil: { lte: now }, status: { in: ['NOWE', 'DO_REALIZACJI'] } },
    select: { id: true },
  })
  for (const { id } of waiting) {
    try {
      const moved = await runTx(db, async (tx) => {
        const o = await lockOrderById(tx, id)
        if (!o.shortageWaitUntil || o.shortageWaitUntil > now || !['NOWE', 'DO_REALIZACJI'].includes(o.status)) return false
        const active = await tx.reservation.count({ where: { orderId: id, state: { in: ['ACTIVE', 'CONSUMING', 'CONSUMED'] } } })
        if (active > 0 || !(await hasOpenShortage(tx, id))) {
          await tx.order.update({ where: { id }, data: { shortageWaitUntil: null } })
          return false
        }
        await tx.order.update({ where: { id }, data: { ...setClarify(o, 'brak wszystkich pozycji po terminie oczekiwania'), shortageWaitUntil: null } as never })
        return true
      })
      if (moved) stats.toClarify++
    } catch (e) {
      stats.errors++
      await recordOrderError(db, id, e)
    }
  }
  return stats
}

export async function recordOrderError(db: Db, orderId: string, e: unknown): Promise<void> {
  const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000)
  try {
    const o = await db.order.findUnique({ where: { id: orderId } })
    if (o) await db.order.update({ where: { id: orderId }, data: { flags: mergeFlags(o, { lastError: msg }) } })
    await alert(db, 'BLAD_ZAMOWIENIA', orderId, msg, `blad-zamowienia:${orderId}:${msg.slice(0, 80)}`)
  } catch {
    // ostatnia linia obrony: błąd zapisu błędu nie może zatrzymać pętli
  }
}

export { addReservation }
