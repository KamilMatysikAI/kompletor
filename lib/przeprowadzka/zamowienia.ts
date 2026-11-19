// Przeprowadzka z BL: otwarte zamówienia BL → rdzeń Kompletora (ingestOrder), bez danych osobowych.
//
// Surowe zamówienie BL (z adresem, e-mailem, telefonem, danymi do faktury, komentarzami) żyje wyłącznie w pętli
// pobierania (`pobierzZamowienia`): od razu przechodzi przez `parseBlOrder`, który KOPIUJE tylko pola z listy
// dozwolonych. Wszystko inne — `email`, `phone`, `user_login`, `delivery_*` poza metodą i ceną, `invoice_*`, `comment`,
// `user_comments`, `extra_field_*` i każde nieznane pole — zostaje w pętli i ginie z nią. Dalej (raport, zrzut,
// ImportIssue, statystyki, baza) idzie tylko wynik parsera. Ten sam wzór co `fetchBlSales` (lib/import/pobieranie.ts).
//
// [NIEPEWNE] getOrders: kolejność i stronicowanie z `status_id` + `id_from` (repo dotąd używało `date_confirmed_from`);
// pola `external_order_id` (Allegro: id formularza zakupu, Empik: id zamówienia Mirakl) i `payment_method_cod` —
// do potwierdzenia na prawdziwym koncie BL.
import type { Channel, PaymentState, PrismaClient } from '@prisma/client'
import type { Analysis } from '../import/katalog'
import { blIdOfLine, MANUAL_LINE_NAME, offerIntent, offerKeyOfLine } from '../import/mapowanie'
import type { ChannelT, SaleLine } from '../import/normalizacja'
import type { FetchIssue } from '../import/pobieranie'
import { carrierFromRules, type CarrierRuleT } from '../rdzen/przewoznicy'
import { ingestOrder, type IncomingLine, type IncomingOrder, type IngestOutcome, validateIncoming } from '../rdzen/zamowienia'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'

export const ZRODLO_PRZEPROWADZKI = 'przeprowadzka-bl'

/** Pola zamówienia BL, które przechodzą przez parser. Każde inne pole jest odrzucane. */
export const POLA_ZAMOWIENIA = [
  'order_id',
  'order_status_id',
  'date_add',
  'date_confirmed',
  'order_source',
  'order_source_id',
  'shop_order_id',
  'external_order_id',
  'payment_done',
  'payment_method',
  'payment_method_cod',
  'delivery_method',
  'delivery_price',
  'want_invoice',
] as const

/**
 * Pola pozycji. `storage` i `auction_id` są ponad listę z zadania (ODSTĘPSTWO, opisane w raporcie zadania): to nie są
 * dane osobowe, a bez nich nie da się wskazać oferty pozycji (Allegro: `auction_id` = id oferty; sklep: `storage` =
 * „shop” odróżnia produkt sklepu od produktu magazynu BL) — tak samo czyta je import katalogu (`fromBlOrder`).
 */
export const POLA_POZYCJI = [
  'order_product_id',
  'product_id',
  'variant_id',
  'sku',
  'ean',
  'name',
  'quantity',
  'price_brutto',
  'tax_rate',
  'storage',
  'storage_id',
  'auction_id',
] as const

export interface BlPozycja {
  order_product_id: string
  product_id: string | null
  variant_id: string | null
  sku: string | null
  ean: string | null
  /** Nazwa produktu; pozycja dodana ręcznie (bez SKU, produktu i oferty) dostaje stały zamiennik — nazwę wpisaną z ręki mogą tworzyć dane klienta. */
  name: string
  quantity: number
  price_brutto: number
  tax_rate: string | null
  storage: string | null
  storage_id: string | null
  auction_id: string | null
}

export interface BlZamowienie {
  order_id: string
  order_status_id: string
  date_add: number
  date_confirmed: number | null
  order_source: string
  order_source_id: string
  shop_order_id: string | null
  external_order_id: string | null
  payment_done: number
  payment_method: string
  payment_method_cod: boolean
  delivery_method: string | null
  delivery_price: number
  want_invoice: boolean
  products: BlPozycja[]
}

const s = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const t = String(v).trim()
  return t === '' ? null : t
}
const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const x = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : Number.NaN
  return Number.isFinite(x) ? x : null
}
const b = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true'
const idOrNull = (v: unknown): string | null => {
  const t = s(v)
  return t && t !== '0' ? t : null
}

export class ZleZamowienie extends Error {}

function parsePozycja(raw: unknown): BlPozycja {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ZleZamowienie('pozycja nie jest obiektem')
  const p = raw as Record<string, unknown>
  const id = s(p['order_product_id'])
  if (!id) throw new ZleZamowienie('pozycja bez order_product_id')
  const quantity = n(p['quantity'])
  if (quantity === null || !Number.isInteger(quantity) || quantity <= 0) throw new ZleZamowienie(`pozycja ${id}: zła ilość`)
  const price = n(p['price_brutto'])
  if (price === null || price < 0) throw new ZleZamowienie(`pozycja ${id}: zła cena`)
  const sku = s(p['sku'])
  const productId = idOrNull(p['product_id'])
  const auctionId = idOrNull(p['auction_id'])
  const tax = n(p['tax_rate'])
  return {
    order_product_id: id,
    product_id: productId,
    variant_id: idOrNull(p['variant_id']),
    sku,
    ean: s(p['ean']),
    name: sku || productId || auctionId ? (s(p['name']) ?? '') : MANUAL_LINE_NAME,
    quantity,
    price_brutto: price,
    tax_rate: tax === null ? null : String(tax),
    storage: s(p['storage']),
    storage_id: s(p['storage_id']),
    auction_id: auctionId,
  }
}

/**
 * Jedyna droga zamówienia BL dalej: kopiuje pola z listy dozwolonych (nigdy nie rozpakowuje obiektu wejściowego), więc
 * każde inne pole — także nowe, którego BL dziś nie ma — zostaje odrzucone. Zły rekord = wyjątek z samym id zamówienia.
 */
export function parseBlOrder(raw: unknown): BlZamowienie {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ZleZamowienie('zamówienie nie jest obiektem')
  const o = raw as Record<string, unknown>
  const id = s(o['order_id'])
  if (!id || !/^\d+$/.test(id)) throw new ZleZamowienie('zamówienie bez order_id')
  const dateAdd = n(o['date_add'])
  if (dateAdd === null || dateAdd <= 0) throw new ZleZamowienie(`zamówienie ${id}: zła data`)
  const products = Array.isArray(o['products']) ? o['products'] : []
  const lines: BlPozycja[] = []
  for (const p of products) {
    try {
      lines.push(parsePozycja(p))
    } catch (e) {
      throw new ZleZamowienie(`zamówienie ${id}: ${e instanceof Error ? e.message : 'zła pozycja'}`)
    }
  }
  const confirmed = n(o['date_confirmed'])
  return {
    order_id: id,
    order_status_id: s(o['order_status_id']) ?? '',
    date_add: dateAdd,
    date_confirmed: confirmed && confirmed > 0 ? confirmed : null,
    order_source: s(o['order_source']) ?? '',
    order_source_id: s(o['order_source_id']) ?? '',
    shop_order_id: idOrNull(o['shop_order_id']),
    external_order_id: idOrNull(o['external_order_id']),
    payment_done: n(o['payment_done']) ?? 0,
    payment_method: s(o['payment_method']) ?? '',
    payment_method_cod: b(o['payment_method_cod']),
    delivery_method: s(o['delivery_method']),
    delivery_price: n(o['delivery_price']) ?? 0,
    want_invoice: b(o['want_invoice']),
    products: lines,
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500)

/**
 * Pobranie zamówień BL stronami po `id_from` (rosnąco). Surowe zamówienie istnieje tylko w tej pętli. `params` to
 * filtr (`status_id` albo `date_from`); zawsze z niepotwierdzonymi (`get_unconfirmed_orders: true`).
 */
async function pobierzStronami(
  bl: BaseLinkerReadOnly,
  params: Record<string, unknown>,
  out: Map<string, BlZamowienie>,
  issues: FetchIssue[],
  maxPages: number,
  /** false = przepełnienie limitu stron to nie problem (celowy wycinek): bez wpisu w `issues`. */
  przepelnienieToProblem = true,
): Promise<{ complete: boolean }> {
  let idFrom = 1
  for (let page = 0; page < maxPages; page++) {
    let batch: unknown[]
    try {
      const r = await bl.call<{ orders: unknown[] }>('getOrders', { ...params, id_from: idFrom, get_unconfirmed_orders: true })
      batch = Array.isArray(r.orders) ? r.orders : []
    } catch (e) {
      issues.push({ kind: 'bl-zamowienia', ref: JSON.stringify(params), message: errMsg(e) })
      return { complete: false }
    }
    let maxId = 0
    for (const raw of batch) {
      const rawId = raw && typeof raw === 'object' ? Number((raw as Record<string, unknown>)['order_id']) : Number.NaN
      if (Number.isFinite(rawId) && rawId > maxId) maxId = rawId
      try {
        const o = parseBlOrder(raw)
        out.set(o.order_id, o)
      } catch (e) {
        // do raportu tylko id zamówienia i powód z parsera (parser nie cytuje wartości pól)
        issues.push({ kind: 'bl-zamowienie', ref: Number.isFinite(rawId) ? String(rawId) : '?', message: errMsg(e) })
      }
    }
    if (batch.length < 100) return { complete: true }
    if (maxId < idFrom) {
      issues.push({ kind: 'bl-zamowienia', ref: JSON.stringify(params), message: 'pełna strona bez postępu id — przerwane' })
      return { complete: false }
    }
    idFrom = maxId + 1
  }
  if (przepelnienieToProblem) issues.push({ kind: 'bl-zamowienia', ref: JSON.stringify(params), message: `więcej niż ${maxPages} stron — reszta pominięta` })
  return { complete: false }
}

export interface PobraneZamowienia {
  /** Otwarte: ze statusów nieterminalnych mapy. */
  otwarte: BlZamowienie[]
  /** Ostatnie (okno dni) — tylko do rozpoznania metod dostawy; nie są przenoszone, jeśli nie są otwarte. */
  ostatnie: BlZamowienie[]
  /** Wszystkie otwarte zamówienia pobrane (statusy do decyzji czytane częściowo się nie liczą). */
  complete: boolean
  /** Okno „ostatnich” obcięte limitem stron (to nie błąd: okno służy tylko do rozpoznania metod dostawy). */
  ostatnieObciete?: boolean
  /** Statusy do decyzji czytane tylko pierwszą stroną i mające więcej zamówień (raport: „co najmniej N”). */
  statusyObciete?: string[]
}

export async function pobierzZamowienia(
  bl: BaseLinkerReadOnly,
  statusyOtwarte: string[],
  issues: FetchIssue[],
  opts: { now?: Date; dniOstatnich?: number; maxStron?: number; maxStronOkna?: number; statusyDoDecyzji?: ReadonlySet<string> } = {},
): Promise<PobraneZamowienia> {
  const otwarte = new Map<string, BlZamowienie>()
  let complete = true
  const statusyObciete: string[] = []
  for (const st of statusyOtwarte) {
    // status do decyzji blokuje zapis już przy jednym zamówieniu, więc do decyzji wystarcza
    // pierwsza strona; pełne pobranie po wpisaniu decyzji w mapie (status bez pełnego odczytu nie trafia do
    // `statusyPobrane`, więc zapis ze zrzutu wymusi zebranie od nowa). Oszczędza limit BL dzielony ze sklepem.
    if (opts.statusyDoDecyzji?.has(st)) {
      const r = await pobierzStronami(bl, { status_id: Number(st) }, otwarte, issues, 1, false)
      if (!r.complete) statusyObciete.push(st)
      continue
    }
    const r = await pobierzStronami(bl, { status_id: Number(st) }, otwarte, issues, opts.maxStron ?? 200)
    complete &&= r.complete
  }
  const ostatnie = new Map<string, BlZamowienie>()
  const dni = opts.dniOstatnich ?? 30
  let ostatnieObciete = false
  if (dni > 0) {
    const since = Math.floor((opts.now ?? new Date()).getTime() / 1000) - dni * 86_400
    // okno to celowy wycinek do rozpoznania metod dostawy — przepełnienie nie jest problemem
    // pobierania i nie robi z przebiegu PARTIAL
    ostatnieObciete = !(await pobierzStronami(bl, { date_from: since }, ostatnie, issues, opts.maxStronOkna ?? 20, false)).complete
  }
  // zamówienie zwrócone pod statusem spoza listy otwartych (zmiana w BL w trakcie pobierania) nie jest otwarte
  const open = new Set(statusyOtwarte)
  return {
    otwarte: [...otwarte.values()].filter((o) => open.has(o.order_status_id)),
    ostatnie: [...ostatnie.values()],
    complete,
    ...(ostatnieObciete ? { ostatnieObciete } : {}),
    ...(statusyObciete.length ? { statusyObciete } : {}),
  }
}

// ─── Zamówienie BL → zamówienie rdzenia ──────────────────────────────────────

export interface KontoZamowienia {
  channel: ChannelT
  channelAccountId: string
}

/** Pozycja jako linia sprzedaży importu (ta sama funkcja klucza oferty co import katalogu: `offerKeyOfLine`). */
export function liniaSprzedazy(o: BlZamowienie, p: BlPozycja, konto: KontoZamowienia): SaleLine {
  return {
    channel: konto.channel,
    accountId: konto.channelAccountId,
    orderId: o.order_id,
    soldAt: new Date((o.date_confirmed ?? o.date_add) * 1000),
    storage: p.storage ?? '',
    storageId: p.storage_id,
    productId: p.product_id,
    variantId: p.variant_id,
    auctionId: p.auction_id,
    sku: p.sku,
    ean: p.ean,
    name: p.name,
    qty: p.quantity,
  }
}

export function sumaZamowienia(o: BlZamowienie): number {
  return Math.round((o.products.reduce((a, p) => a + p.price_brutto * p.quantity, 0) + o.delivery_price) * 100) / 100
}

export function stanPlatnosci(o: BlZamowienie): PaymentState {
  if (o.payment_method_cod) return 'COD'
  const total = sumaZamowienia(o)
  if (o.payment_done > 0 && o.payment_done + 0.01 >= total) return 'PAID'
  if (o.payment_done > 0) return 'PARTIAL'
  return 'UNPAID'
}

/**
 * Id zamówienia w kanale: ten sam, którym posłuży się później adapter kanału (Woo: numer zamówienia sklepu, Allegro i
 * Empik: id zamówienia u nich), żeby cień kanału po przełączeniu nie założył drugiego zamówienia. Źródło bez adaptera
 * (BL_INNE) i zamówienie bez numeru kanału: „bl:<id BL>”.
 */
export function externalIdOf(o: BlZamowienie, channel: Channel): string {
  if (channel === 'WOO' && o.shop_order_id) return o.shop_order_id
  if ((channel === 'ALLEGRO' || channel === 'EMPIK') && o.external_order_id) return o.external_order_id
  return `bl:${o.order_id}`
}

/** Klucz zdarzenia oparty na id BL: ponowne uruchomienie przeprowadzki daje w rdzeniu DUPLIKAT. */
export const eventKeyOf = (o: Pick<BlZamowienie, 'order_id'>) => `bl:${o.order_id}`

export function doRdzenia(o: BlZamowienie, konto: KontoZamowienia, lines: IncomingLine[]): IncomingOrder {
  return {
    source: ZRODLO_PRZEPROWADZKI,
    eventKey: eventKeyOf(o),
    channel: konto.channel,
    channelAccountId: konto.channelAccountId,
    externalId: externalIdOf(o, konto.channel),
    createdAtChannel: new Date(o.date_add * 1000),
    paymentState: stanPlatnosci(o),
    paymentMethod: o.payment_method || (o.payment_method_cod ? 'pobranie' : 'nieznana'),
    totalGross: sumaZamowienia(o),
    deliveryMethod: o.delivery_method,
    shippingCostGross: Number.isFinite(o.delivery_price) && o.delivery_price >= 0 ? o.delivery_price : null,
    wantInvoiceNip: o.want_invoice,
    lines,
  }
}

// ─── Przewidywanie (tryb próbny) i zapis ─────────────────────────────────────

/** Czym pozycja zostanie powiązana: oferta kanału albo wprost produkt magazynu BL (pozycja z magazynu BL). */
export interface PowiazanieLinii {
  offerExternalId: string | null
  blProductId: string | null
}

export function powiazanieLinii(o: BlZamowienie, p: BlPozycja, konto: KontoZamowienia): PowiazanieLinii {
  const l = liniaSprzedazy(o, p, konto)
  return { offerExternalId: offerKeyOfLine(l), blProductId: blIdOfLine(l) }
}

export interface WynikZamowienia {
  blOrderId: string
  channel: Channel
  channelAccountId: string
  /** NOWE / DUPLIKAT / … z rdzenia; w trybie próbnym „PLAN”; BLAD = zamówienie nie przeszło (powód w `blad`). */
  wynik: IngestOutcome | 'PLAN' | 'BLAD'
  pozycje: number
  pozycjeBezPowiazania: number
  /** Status w Kompletorze (po zapisie: z rdzenia; w trybie próbnym: DO_WYJASNIENIA, gdy jest pozycja bez powiązania). */
  status: string | null
  blad?: string
}

/**
 * Zapis otwartych zamówień przez rdzeń: po jednym, try/catch wokół każdego — zły rekord trafia do wyników jako BLAD,
 * reszta idzie dalej. Pozycja: aktywna oferta kanału, a gdy jej nie ma, a pozycja jest z magazynu BL — produkt
 * powiązany z produktem BL. Bez powiązania: pozycja „niezmapowana”, rdzeń daje DO_WYJASNIENIA.
 */
export async function przeniesZamowienia(
  db: PrismaClient,
  zamowienia: { o: BlZamowienie; konto: KontoZamowienia }[],
  opts: { now?: Date } = {},
): Promise<WynikZamowienia[]> {
  const out: WynikZamowienia[] = []
  for (const { o, konto } of zamowienia) {
    const base = { blOrderId: o.order_id, channel: konto.channel, channelAccountId: konto.channelAccountId, pozycje: o.products.length }
    try {
      const links = o.products.map((p) => ({ p, ...powiazanieLinii(o, p, konto) }))
      const offerIds = links.map((x) => x.offerExternalId).filter((x): x is string => !!x)
      const active = new Set(
        (
          await db.channelOffer.findMany({
            where: { channel: konto.channel, channelAccountId: konto.channelAccountId, externalId: { in: offerIds }, active: true },
            select: { externalId: true },
          })
        ).map((x) => x.externalId),
      )
      const blIds = links.filter((x) => !(x.offerExternalId && active.has(x.offerExternalId)) && x.blProductId).map((x) => x.blProductId!)
      const viaBl = new Map(
        (
          await db.blProduct.findMany({
            where: { id: { in: blIds }, productId: { not: null } },
            select: { id: true, productId: true, product: { select: { unit: true, kind: true } } },
          })
        ).map((x) => [x.id, x]),
      )
      let unmapped = 0
      const lines: IncomingLine[] = links.map(({ p, offerExternalId, blProductId }) => {
        const common = { externalLineId: p.order_product_id, unitPriceGross: p.price_brutto, vatRate: p.tax_rate, name: p.name || null, sku: p.sku, ean: p.ean }
        if (offerExternalId && active.has(offerExternalId)) return { ...common, offerExternalId, qty: p.quantity }
        const bp = blProductId ? viaBl.get(blProductId) : undefined
        if (bp?.productId && bp.product && bp.product.kind !== 'DIGITAL') {
          // 1 jednostka BL = 1 szt. albo 1 kg (jak oferta w imporcie: qtyBasePerOffer 1000 dla kg)
          return { ...common, productId: bp.productId, qty: bp.product.unit === 'KG' ? p.quantity * 1000 : p.quantity }
        }
        unmapped++
        return { ...common, offerExternalId: offerExternalId ?? `bl-pozycja:${p.order_product_id}`, qty: p.quantity }
      })
      const res = await ingestOrder(db, doRdzenia(o, konto, lines), { now: opts.now, actorId: 'system:przeprowadzka-bl' })
      if (res.orderId) await db.order.update({ where: { id: res.orderId }, data: { blOrderId: Number(o.order_id) } })
      out.push({ ...base, wynik: res.outcome, pozycjeBezPowiazania: unmapped, status: res.status ?? null })
    } catch (e) {
      out.push({ ...base, wynik: 'BLAD', pozycjeBezPowiazania: 0, status: null, blad: errMsg(e) })
    }
  }
  return out
}

/**
 * Tryb próbny: co stałoby się z zamówieniem bez zapisu. Pozycja powiązana = oferta, którą import zapisze jako aktywną
 * (MAPPED, intencja ACTIVE), albo produkt magazynu BL, który trafi do planu katalogu. Status jak w rdzeniu: pozycja bez
 * powiązania albo metoda dostawy bez reguły = DO_WYJASNIENIA, inaczej NOWE / DO_REALIZACJI wg płatności.
 */
export function przewidzZamowienia(
  zamowienia: { o: BlZamowienie; konto: KontoZamowienia }[],
  analiza: Pick<Analysis, 'offers' | 'plan'> | null,
  reguly: readonly CarrierRuleT[],
): WynikZamowienia[] {
  const active = new Set(
    (analiza?.offers ?? []).filter((x) => x.state === 'MAPPED' && offerIntent(x) === 'ACTIVE').map((x) => `${x.channel}|${x.accountId}|${x.externalId}`),
  )
  return zamowienia.map(({ o, konto }): WynikZamowienia => {
    let unmapped = 0
    for (const p of o.products) {
      const l = powiazanieLinii(o, p, konto)
      const viaOffer = l.offerExternalId && active.has(`${konto.channel}|${konto.channelAccountId}|${l.offerExternalId}`)
      const viaBl = l.blProductId && analiza?.plan.blToKey.has(l.blProductId)
      if (!viaOffer && !viaBl) unmapped++
    }
    const base = { blOrderId: o.order_id, channel: konto.channel, channelAccountId: konto.channelAccountId, pozycje: o.products.length }
    // ta sama walidacja co na wejściu rdzenia (np. zdublowana pozycja) — błąd widać już w trybie próbnym
    try {
      validateIncoming(doRdzenia(o, konto, o.products.map((p) => ({ externalLineId: p.order_product_id, qty: p.quantity, unitPriceGross: p.price_brutto }))))
    } catch (e) {
      return { ...base, wynik: 'BLAD' as const, pozycjeBezPowiazania: unmapped, status: null, blad: errMsg(e) }
    }
    const carrier = carrierFromRules(reguly, konto.channel, o.delivery_method).carrier
    const pay = stanPlatnosci(o)
    const status = unmapped || carrier === 'BRAK' ? 'DO_WYJASNIENIA' : pay === 'PAID' || pay === 'COD' ? 'DO_REALIZACJI' : 'NOWE'
    return { ...base, wynik: 'PLAN' as const, pozycjeBezPowiazania: unmapped, status }
  })
}
