// Adapter IdoSell Admin API, dwa klucze:
//   `idosell.admin.v1`       — domyślny, tylko odczyt: dziennik zamówień (wyszukiwanie po dacie zmiany, kursor jak
//                              Woo/Shoper), oferty (produkty i rozmiary z SKU, EAN, stanem magazynu konta), test połączenia;
//   `idosell.admin.zapis.v1` — to samo plus, ZA WYŁĄCZNIKIEM `zapisWlaczony`, zapis stanu (`PUT products/stocks`,
//                              ustawienie wartości bezwzględnej) i statusu zamówienia (`PUT orders/orders`).
// Bez `zapisWlaczony: true` metody zapisu zwracają TRWALY i nie wysyłają żadnego żądania (także odczytu).
// Numeru nadania do zamówienia (`orders/packages`) nie zapisujemy: IdoSell wymaga identyfikatora kuriera ze swojego
// słownika, a przesyłki tworzy Kompletor; to osobna paczka po próbie na koncie testowym.
//
// Oparte na wiedzy z Open Integration Platform (Apache-2.0, Pinquark.com):
// integrators/ecommerce/idosell/v1.0.0/src/idosell/client.py (ae43d1e) oraz mapper.py, integration.py, schemas.py —
// przepisane i zmienione (własny kod TS w kontrakcie Kompletora; THIRD_PARTY_NOTICES.md). Pierwszeństwo ma oficjalna
// dokumentacja idosell.readme.io (v8). Kod sprawdzony wyłącznie na atrapie HTTP (tests/idosell-atrapa.ts); pola
// oznaczone [NIEPEWNE] czekają na próbę na koncie testowym (docs/integracje/idosell.md).
//
// Oferta = „<productId>” (produkt bez rozmiarów, rozmiar uniwersalny „uniw”) albo „<productId>/<sizeId>”.
// Zamówienie = numer zamówienia w panelu (`orderSerialNumber`); `orderId` (np. „sklep-12-345”) idzie jako numer.
// Dane klienta (adresy, e-mail, telefon, login, uwagi) nie są czytane; z adresu do faktury tylko „czy jest NIP” (tak/nie).
import type { PaymentState } from '@prisma/client'
import { normalizeEan } from '../import/normalizacja'
import { localToUtc } from '../zrodla/czas-lokalny'
import type { FetchLike } from '../zrodla/http'
import { IDOSELL_WERSJA, IDOSELL_WERSJE, IdoSellHttpError, IdoSellOdczyt, IdoSellSesja, IdoSellZapis } from '../zrodla/idosell'
import {
  AdapterError,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type ChannelAdapter,
  type ChannelBehavior,
  type ChannelOfferRow,
  type ChannelOrder,
  type ChannelOrderLine,
  type ConfigField,
  type ConnectionTest,
  type FailedWriteItem,
  type FailureKind,
  type OfferPageWithProblems,
  type OfferReader,
  type OfferReadProblem,
  type OrderFeed,
  type OrderFeedItem,
  type OrderFeedOptions,
  type OrderFeedPage,
  type OrderLifecycle,
  type OrderStatusWriter,
  optAmount,
  opisLinii,
  optText,
  readNumber,
  type StatusWriteGuard,
  type StockWriteItem,
  type StockWriter,
  UnreadableDataError,
  type WriteOutcome,
} from './kontrakt'
import { AdapterConfigError } from './rejestr'
import { sinceLocal } from './shoper'
import { parseWooCursor } from './woo'

// ─── Statusy ─────────────────────────────────────────────────────────────────

/**
 * Status IdoSell (`orderDetails.orderStatus`) → cykl życia i kolejność. Lista wg dokumentacji v8 i konektora OIP.
 * [NIEPEWNE] Zamówienia „nieodebrane”, „zagubione”, „zwrot” i „reklamacja” traktujemy jak zrealizowane (towar już
 * wyszedł z magazynu), „połączone” jak anulowane (pozycje przeszły do innego zamówienia).
 */
export const IDOSELL_STATUS: Readonly<Record<string, { lifecycle: OrderLifecycle; rank: number | null }>> = {
  new: { lifecycle: 'OPEN', rank: 10 },
  payment_waiting: { lifecycle: 'OPEN', rank: 10 },
  delivery_waiting: { lifecycle: 'OPEN', rank: 15 },
  on_order: { lifecycle: 'OPEN', rank: 20 },
  suspended: { lifecycle: 'OPEN', rank: null },
  blocked: { lifecycle: 'OPEN', rank: null },
  wait_for_packaging: { lifecycle: 'OPEN', rank: 25 },
  packed: { lifecycle: 'OPEN', rank: 30 },
  packed_fulfillment: { lifecycle: 'OPEN', rank: 30 },
  packed_ready: { lifecycle: 'OPEN', rank: 35 },
  ready: { lifecycle: 'OPEN', rank: 40 },
  wait_for_dispatch: { lifecycle: 'OPEN', rank: 40 },
  finished: { lifecycle: 'FULFILLED', rank: 50 },
  finished_ext: { lifecycle: 'FULFILLED', rank: 50 },
  handled: { lifecycle: 'FULFILLED', rank: 50 },
  wait_for_receive: { lifecycle: 'FULFILLED', rank: 50 },
  missing: { lifecycle: 'FULFILLED', rank: null },
  lost: { lifecycle: 'FULFILLED', rank: null },
  returned: { lifecycle: 'FULFILLED', rank: null },
  complainted: { lifecycle: 'FULFILLED', rank: null },
  canceled: { lifecycle: 'CANCELLED', rank: null },
  all_canceled: { lifecycle: 'CANCELLED', rank: null },
  false: { lifecycle: 'CANCELLED', rank: null },
  joined: { lifecycle: 'CANCELLED', rank: null },
}

/**
 * Statusy, które Kompletor może ustawić w IdoSell (`PUT orders/orders`, dokumentacja v8), z nazwami jak w panelu.
 * tylko cele, które mają sens w tabeli „Statusy w sklepie” (bez `joined`, `missing`, `lost`, `false`:
 * te ustawia sam sklep albo kurier). [NIEPEWNE] nazwy po polsku zebrane z panelu i dokumentacji, a znaczenie `handled`
 * i `finished` (który z nich to „wysłane”) do potwierdzenia na koncie testowym (punkt 11 listy w docs).
 */
export const IDOSELL_STATUSY_ZAPISU: readonly { id: string; label: string }[] = [
  { id: 'new', label: 'Nowe (nieobsłużone)' },
  { id: 'payment_waiting', label: 'Oczekuje na płatność' },
  { id: 'delivery_waiting', label: 'Oczekuje na dostawę' },
  { id: 'on_order', label: 'W realizacji' },
  { id: 'packed', label: 'Pakowane' },
  { id: 'packed_fulfillment', label: 'Pakowane (fulfillment)' },
  { id: 'packed_ready', label: 'Spakowane' },
  { id: 'ready', label: 'Gotowe do wysłania' },
  { id: 'wait_for_dispatch', label: 'Oczekuje na wysyłkę' },
  { id: 'finished', label: 'Zrealizowane / wysłane [do potwierdzenia]' },
  { id: 'finished_ext', label: 'Obsłużone w programie zewnętrznym' },
  { id: 'suspended', label: 'Wstrzymane' },
  { id: 'canceled', label: 'Anulowane' },
]

/**
 * Zachowanie kanału: sklep sam zdejmuje stan przy zamówieniu [NIEPEWNE]. Bez domyślnej mapy statusów
 * (jak Shoper i PrestaShop). Zmiana statusu w IdoSell potrafi wysłać klientowi e-mail ze sklepu, a znaczenie statusów
 * nie jest sprawdzone na prawdziwym sklepie, więc dopóki firma nie uzupełni tabeli „Statusy w sklepie” na ekranie
 * konta, Kompletor nie zmienia statusów w IdoSell.
 */
export const IDOSELL_BEHAVIOR: ChannelBehavior = {
  stockModel: 'self-decrementing',
  channelStatuses: IDOSELL_STATUSY_ZAPISU,
}

// ─── [NIEPEWNE] — do potwierdzenia na koncie testowym, nigdzie indziej ──────

export const NIEPEWNE = {
  /** Wpłata zaksięgowana: `prepaids[].paymentStatus` = „y” (inne: niepotwierdzona, anulowana). */
  wplataPotwierdzona: 'y',
  /** Rodzaje wpłat liczone do opłacenia (zwrot „repayment” odejmujemy, „fee” pomijamy). */
  wplatyPlus: ['payment', 'advance'] as readonly string[],
  /** Kwoty `orderCurrency` (waluta zamówienia, jak ceny pozycji) są brutto, gdy `orderWorthCalculateType` ≠ „net”. */
  kwotyBrutto: true,
  /** Rozmiar w zapisie stanu wskazany identyfikatorem rozmiaru (`ident.identType: "id"` = sizeId, np. „uniw”). */
  rozmiarPoId: true,
  /** Produkt bez `productStocksData` = sklep nie prowadzi jego stanu (qty null); rozmiar bez wpisu w magazynie konta = nieczytelny. */
  brakDanychMagazynu: 'qty null',
  /** EAN rozmiaru = kod producenta (`productSizeCodeProducer`), gdy jest poprawnym kodem kreskowym. */
  eanZKoduProducenta: true,
  /** Język nazw produktów (`productDescriptionsLangData[].langId`). */
  jezyk: 'pol',
} as const

/** Rozmiar „uniwersalny” = produkt bez rozmiarów; oferta to sam numer produktu (jak produkt prosty Woo). */
export const ROZMIAR_UNIW = 'uniw'
const SIZE_RE = /^[A-Za-z0-9_-]{1,40}$/
const OFFER_RE = /^(\d+)(?:\/([A-Za-z0-9_-]{1,40}))?$/

export function idosellOfferId(productId: number | string, sizeId: string | null): string {
  return !sizeId || sizeId === ROZMIAR_UNIW ? String(productId) : `${productId}/${sizeId}`
}

/** Oferta → produkt i rozmiar; null = zły format. */
export function parseOfferId(id: string): { productId: number; sizeId: string } | null {
  const m = OFFER_RE.exec(id)
  return m ? { productId: Number(m[1]), sizeId: m[2] ?? ROZMIAR_UNIW } : null
}

// ─── Manifesty ───────────────────────────────────────────────────────────────

const CONFIG: readonly ConfigField[] = [
  { key: 'baseUrl', type: 'string', required: true, description: 'adres panelu IdoSell https://… (np. https://client12345.idosell.com albo domena sklepu)', pattern: /^https:\/\/\S+$/i, envSuffix: 'URL' },
  { key: 'wersjaApi', type: 'string', required: false, description: `wersja Admin API (domyślnie ${IDOSELL_WERSJA})`, options: IDOSELL_WERSJE.map((v) => ({ value: v, label: v })) },
  { key: 'magazyn', type: 'number', required: false, description: 'numer magazynu w IdoSell, z którego czytamy i do którego zapisujemy stan (stock_id, domyślnie 1 = M1)' },
  { key: 'envPrefix', type: 'string', required: false, description: 'self-host: przedrostek zmiennych env konta (np. SKLEP_IDO)', pattern: /^[A-Z][A-Z0-9_]{0,40}$/ },
  { key: 'pollIntervalSec', type: 'number', required: false, description: 'co ile sekund czytać zamówienia (domyślnie 60)' },
  { key: 'overlapMinutes', type: 'number', required: false, description: 'zakładka czasowa odczytu (domyślnie 5)' },
  { key: 'pageSize', type: 'number', required: false, description: 'wierszy na stronę (1–100, domyślnie 100)' },
  { key: 'strefa', type: 'string', required: false, description: 'strefa czasowa dat panelu (domyślnie Europe/Warsaw)' },
]

const BASE = {
  version: '1.0.0',
  kind: 'channel',
  channel: 'IDOSELL',
  // [NIEPEWNE] dokumentacja nie podaje limitu; 429 niesie (zwykle) Retry-After
  rateLimit: { requestsPerMinute: 60, maxConcurrent: 1, minPollIntervalMs: 60_000 },
  secrets: [{ name: 'IDOSELL_API_KEY', required: true, description: 'klucz Admin API z panelu IdoSell (nagłówek X-API-KEY)', envSuffix: 'KEY' }],
  channelBehavior: IDOSELL_BEHAVIOR,
} as const satisfies Partial<AdapterManifest>

export const IDOSELL_MANIFEST: AdapterManifest = {
  ...BASE,
  adapterKey: 'idosell.admin.v1',
  displayName: 'IdoSell (Admin API, odczyt)',
  capabilities: ['orders.feed', 'offers.read'],
  config: CONFIG,
  readOnly: true,
}

export const IDOSELL_ZAPIS_MANIFEST: AdapterManifest = {
  ...BASE,
  adapterKey: 'idosell.admin.zapis.v1',
  displayName: 'IdoSell (Admin API, z zapisem za wyłącznikiem)',
  capabilities: ['orders.feed', 'offers.read', 'stock.write', 'order.status.write'],
  config: [...CONFIG, { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'wyłącznik zapisu stanów i statusów w sklepie (domyślnie wyłączony)' }],
  readOnly: false,
}

// ─── Pomocnicze ──────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {})
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : [])
const LOCAL_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

function localOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().replace('T', ' ')
  return LOCAL_RE.test(s) ? s : null
}

function utcOf(local: string, tz: string, what: string): Date {
  const d = localToUtc(local, tz)
  if (!d || Number.isNaN(d.getTime())) throw new UnreadableDataError(`nieczytelna data: ${what}`)
  return d
}

/** Kwota dodatkowa (dostawa, płatność): brak = 0 (pozycji nie ma), nieczytelna = błąd. */
function costOf(v: unknown, what: string): number {
  return v === undefined || v === null || v === '' ? 0 : readNumber(v, what)
}

/** Szczegóły zamówienia: `orderDetails` (dokumentacja v8) albo `order` (starsze odpowiedzi wg konektora OIP). */
const detailsOf = (row: Record<string, unknown>) => obj(row['orderDetails'] ?? row['order'])

/** Status: tekst albo obiekt `{ orderStatus }` (starsze odpowiedzi). */
function statusOf(d: Record<string, unknown>): string | null {
  const s = d['orderStatus']
  return isObj(s) ? str(s['orderStatus']) : str(s)
}

/** Data ostatniej zmiany (lokalnie): `orderChangeDate`, gdy późniejsza od `orderAddDate`; brak czytelnej daty dodania = błąd. */
function changedLocal(d: Record<string, unknown>, id: string): string {
  const add = localOf(d['orderAddDate'])
  if (!add) throw new UnreadableDataError(`brak daty zamówienia ${id}`)
  const raw = d['orderChangeDate']
  if (raw === undefined || raw === null || raw === '') return add
  const ch = localOf(raw)
  if (!ch) throw new UnreadableDataError(`nieczytelna data zmiany zamówienia ${id}`)
  return ch > add ? ch : add
}

function serialOf(row: Record<string, unknown>): string | null {
  const s = str(row['orderSerialNumber'])
  return s && /^\d+$/.test(s) ? s : null
}

export interface IdoSellMapCfg {
  strefa: string
}

/** Wpłaty netto zaksięgowane (bez zwrotów) — do stanu płatności. [NIEPEWNE] NIEPEWNE.wplataPotwierdzona */
function paidSum(d: Record<string, unknown>, id: string): number {
  let sum = 0
  for (const p of arr(d['prepaids'])) {
    if (str(p['paymentStatus']) !== NIEPEWNE.wplataPotwierdzona) continue
    const type = str(p['paymentType']) ?? 'payment'
    const v = readNumber(p['paymentValue'], `wpłata zamówienia ${id}`)
    if (NIEPEWNE.wplatyPlus.includes(type)) sum += v
    else if (type === 'repayment') sum -= v
  }
  return Math.round(sum * 100) / 100
}

const RODZAJ_PLATNOSCI: Record<string, string> = { cash_on_delivery: 'Za pobraniem', prepaid: 'Przedpłata', tradecredit: 'Kredyt kupiecki' }

function paymentOf(d: Record<string, unknown>, total: number, id: string): { state: PaymentState; method: string } {
  const p = obj(d['payments'])
  const type = str(p['orderPaymentType'])
  const payform = arr(d['prepaids']).map((x) => optText(x['payformName'], 100)).find((x) => !!x) ?? null
  const method = payform ?? (type ? (RODZAJ_PLATNOSCI[type] ?? type) : '(brak)')
  if (type === 'cash_on_delivery') return { state: 'COD', method }
  const paid = paidSum(d, id)
  if (paid > 0 && paid + 0.01 >= total) return { state: 'PAID', method }
  if (paid > 0) return { state: 'PARTIAL', method }
  return { state: 'UNPAID', method }
}

function lineOf(p: Record<string, unknown>, i: number, orderId: string, warnings: string[]): ChannelOrderLine {
  const pid = str(p['productId'])
  if (!pid || !/^\d+$/.test(pid)) throw new UnreadableDataError(`pozycja ${i + 1} zamówienia ${orderId} bez numeru produktu`)
  const rawSize = str(p['sizeId'])
  if (rawSize && !SIZE_RE.test(rawSize)) throw new UnreadableDataError(`pozycja ${i + 1} zamówienia ${orderId}: nieczytelny rozmiar`)
  const qty = readNumber(p['productQuantity'], `ilość pozycji ${i + 1} zamówienia ${orderId}`)
  if (!Number.isInteger(qty)) throw new UnreadableDataError(`ilość pozycji ${i + 1} zamówienia ${orderId} nie jest liczbą całkowitą`)
  if (qty <= 0) throw new UnreadableDataError(`ilość pozycji ${i + 1} zamówienia ${orderId} ≤ 0`)
  if (str(p['bundleId'])) warnings.push(`pozycja ${i + 1}: część zestawu IdoSell (bundleId) — sprawdź, czy zestaw nie zdejmuje stanu podwójnie`)
  const pos = str(p['basketPosition'])
  return {
    // pozycja w koszyku jest stała dla zamówienia; bez niej numer produktu z rozmiarem i miejscem na liście
    externalLineId: pos ?? `${idosellOfferId(pid, rawSize)}#${i + 1}`,
    offerExternalId: idosellOfferId(pid, rawSize),
    qty,
    unitPriceGross: readNumber(p['productOrderPrice'], `cena pozycji ${i + 1} zamówienia ${orderId}`),
    vatRate: str(p['productVat']),
    ...opisLinii(optText(p['productName']), optText(p['productSizeCodeExternal'] ?? p['productCode'], 200), null),
  }
}

/** Kwoty zamówienia w walucie zamówienia (jak ceny pozycji); bez niej waluta rozliczeniowa sklepu. */
function kwotyOf(d: Record<string, unknown>, id: string): { cur: Record<string, unknown>; total: number } {
  const pay = obj(d['payments'])
  const cur = isObj(pay['orderCurrency']) ? pay['orderCurrency'] : obj(pay['orderBaseCurrency'])
  const products = readNumber(cur['orderProductsCost'], `kwota produktów zamówienia ${id}`)
  const extra = ['orderDeliveryCost', 'orderPayformCost', 'orderInsuranceCost'].reduce((s, k) => s + costOf(cur[k], `${k} zamówienia ${id}`), 0)
  return { cur, total: Math.round((products + extra) * 100) / 100 }
}

/** Rewizja: ISO UTC daty ostatniej zmiany + „#” + opłacone (0/1), jak Shoper — nowsza data wygrywa, przy tej samej opłacenie. */
export function idosellRevision(row: Record<string, unknown>, strefa: string): string {
  const id = serialOf(row) ?? '?'
  const d = detailsOf(row)
  const local = changedLocal(d, id)
  const paid = paymentOf(d, kwotyOf(d, id).total, id).state === 'PAID'
  return `${utcOf(local, strefa, `data zmiany ${id}`).toISOString()}#${paid ? 1 : 0}`
}

/** Zamówienie IdoSell (wiersz wyszukiwania) → ChannelOrder. Czysta funkcja; nieczytelne pole = UnreadableDataError (nigdy 0). */
export function idosellOrderFromApi(row: Record<string, unknown>, cfg: IdoSellMapCfg): ChannelOrder {
  const externalId = serialOf(row)
  if (!externalId) throw new UnreadableDataError('zamówienie IdoSell bez numeru (orderSerialNumber)')
  const d = detailsOf(row)
  const warnings: string[] = []
  const status = statusOf(d)
  if (!status) throw new UnreadableDataError(`zamówienie ${externalId} bez statusu`)
  const known = IDOSELL_STATUS[status]
  if (!known) warnings.push(`nieznany status IdoSell „${status.slice(0, 40)}” — traktowany jak otwarte, bez kolejności`)
  const items = arr(d['productsResults'])
  if (!items.length) throw new UnreadableDataError(`zamówienie ${externalId} bez pozycji`)
  const lines = items.map((p, i) => lineOf(p, i, externalId, warnings))
  const add = localOf(d['orderAddDate'])
  if (!add) throw new UnreadableDataError(`brak daty zamówienia ${externalId}`)
  const pay = obj(d['payments'])
  const { cur, total } = kwotyOf(d, externalId)
  if (str(pay['orderWorthCalculateType']) === 'net') warnings.push('zamówienie liczone od cen netto (orderWorthCalculateType: net) — sprawdź kwoty brutto')
  let currency = str(cur['currencyId'] ?? cur['billingCurrency'])
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    warnings.push('nieczytelna waluta zamówienia — przyjęto PLN')
    currency = 'PLN'
  }
  const p = paymentOf(d, total, externalId)
  const billing = obj(obj(row['clientResult'] ?? row['client'])['clientBillingAddress'])
  return {
    externalId,
    number: optText(row['orderId'], 64),
    revision: idosellRevision(row, cfg.strefa),
    createdAt: utcOf(add, cfg.strefa, `data zamówienia ${externalId}`),
    channelStatus: status,
    statusRank: known?.rank ?? null,
    lifecycle: known?.lifecycle ?? 'OPEN',
    paymentState: p.state,
    paymentMethod: p.method,
    totalGross: total,
    currency,
    deliveryMethod: optText(obj(d['dispatch'])['courierName'], 200),
    shippingCostGross: optAmount(cur['orderDeliveryCost']),
    // jedyny dozwolony odczyt z adresu: czy jest NIP (wartości nie zachowujemy)
    wantInvoiceNip: !!str(billing['clientNip']),
    lines,
    warnings,
  }
}

/** Oferty jednego produktu IdoSell: wiersz na rozmiar; nieczytelny rozmiar trafia do `problems`, nie jako 0. */
export function idosellOffersFromApi(prod: Record<string, unknown>, magazyn: number): { rows: ChannelOfferRow[]; problems: OfferReadProblem[] } {
  const pid = str(prod['productId'])
  if (!pid || !/^\d+$/.test(pid)) return { rows: [], problems: [{ externalId: '?', message: 'produkt IdoSell bez numeru' }] }
  const attrs = new Map(arr(prod['productSizesAttributes']).map((a) => [str(a['sizeId']) ?? ROZMIAR_UNIW, a] as const))
  const stocksData = prod['productStocksData']
  const ourStock = isObj(stocksData) ? arr(stocksData['productStocksQuantities']).find((q) => Number(q['stockId']) === magazyn) : undefined
  const qtyBySize = new Map((ourStock ? arr(ourStock['productSizesData']) : []).map((s) => [str(s['sizeId']) ?? ROZMIAR_UNIW, s] as const))
  const sizes = new Set<string>([...attrs.keys(), ...qtyBySize.keys(), ...arr(prod['productSizes']).map((s) => str(s['sizeId']) ?? ROZMIAR_UNIW)])
  if (!sizes.size) sizes.add(ROZMIAR_UNIW)
  const langs = arr(prod['productDescriptionsLangData'])
  const name = optText((langs.find((l) => str(l['langId']) === NIEPEWNE.jezyk) ?? langs[0])?.['productName'])
  const deleted = prod['productIsDeleted'] === true || str(prod['productIsDeleted']) === 'y'
  const active = !deleted && str(prod['productIsVisible']) !== 'n'
  const images = arr(prod['productImages'])
    .map((i) => str(i['productImageLargeUrl']))
    .filter((u): u is string => !!u && /^https:\/\//i.test(u))
    .slice(0, 10)
  const rows: ChannelOfferRow[] = []
  const problems: OfferReadProblem[] = []
  for (const size of [...sizes].sort()) {
    const externalId = idosellOfferId(pid, size)
    if (!SIZE_RE.test(size)) {
      problems.push({ externalId, message: 'nieczytelny rozmiar produktu' })
      continue
    }
    const a = attrs.get(size) ?? {}
    const s = qtyBySize.get(size)
    let qty: number | null
    if (!isObj(stocksData)) qty = null // [NIEPEWNE] NIEPEWNE.brakDanychMagazynu: sklep nie prowadzi stanu
    else if (!s) {
      problems.push({ externalId, message: `brak stanu rozmiaru w magazynie ${magazyn} (sprawdź numer magazynu konta)` })
      continue
    } else {
      let n = Number.NaN
      try {
        n = readNumber(s['productSizeQuantity'], 'stan rozmiaru')
      } catch {
        // niżej: nieczytelny
      }
      if (!Number.isInteger(n) || n < 0) {
        problems.push({ externalId, message: 'nieczytelny stan rozmiaru' })
        continue
      }
      qty = n
    }
    const ean = normalizeEan(a['productSizeCodeProducer'])
    rows.push({
      externalId,
      sku: optText(a['productSizeCodeExternal'] ?? s?.['productSizeCodeExternal'] ?? prod['productDisplayedCode'], 200),
      ean: NIEPEWNE.eanZKoduProducenta && ean.valid ? ean.ean : null,
      name,
      qty,
      active,
      priceGross: optAmount(a['productRetailPrice'] ?? prod['productRetailPrice']),
      vatRate: str(prod['productVat']),
      ...(images.length ? { imageUrls: images } : {}),
    })
  }
  return { rows, problems }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

const pageSizeOf = (v: unknown) => {
  const n = Number(v ?? 100)
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 100
}

export function toAdapterError(e: unknown): unknown {
  if (e instanceof IdoSellHttpError) return new AdapterError(e.message, e.retryable ? 'PRZEJSCIOWY' : 'TRWALY', e.retryAfterMs)
  return e
}

/** odstęp między żądaniami z limitu manifestu, gdy host nie stroi klienta (jak Empik). */
export function idosellMinIntervalMs(manifest: Pick<AdapterManifest, 'rateLimit'>): number {
  const rpm = manifest.rateLimit?.requestsPerMinute
  return rpm && rpm > 0 ? Math.ceil(60_000 / rpm) : 1_000
}

const ORDERS = 'orders/orders/search'
const PRODUCTS = 'products/products/search'

export class IdoSellAdapter implements ChannelAdapter, OrderFeed, OfferReader {
  protected readonly session: IdoSellSesja
  protected readonly api: IdoSellOdczyt
  protected readonly strefa: string
  protected readonly magazyn: number
  private readonly perPage: number
  private readonly overlapMs: number

  constructor(
    readonly manifest: AdapterManifest,
    protected readonly ctx: AdapterContext,
  ) {
    this.perPage = pageSizeOf(ctx.config['pageSize'])
    this.strefa = typeof ctx.config['strefa'] === 'string' && ctx.config['strefa'] ? ctx.config['strefa'] : 'Europe/Warsaw'
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: this.strefa })
    } catch {
      throw new AdapterConfigError(`Konto ${ctx.integration.id}: nieznana strefa czasowa „${this.strefa}”`)
    }
    const mag = Number(ctx.config['magazyn'] ?? 1)
    if (!Number.isInteger(mag) || mag < 1) throw new AdapterConfigError(`Konto ${ctx.integration.id}: numer magazynu IdoSell to liczba całkowita ≥ 1`)
    this.magazyn = mag
    const key = ctx.secrets['IDOSELL_API_KEY']
    if (!key) throw new AdapterConfigError(`Konto ${ctx.integration.id}: brak sekretu IDOSELL_API_KEY`)
    try {
      this.session = new IdoSellSesja(String(ctx.config['baseUrl']), String(ctx.config['wersjaApi'] ?? IDOSELL_WERSJA), key, ctx.fetch as FetchLike, ctx.http?.minIntervalMs ?? idosellMinIntervalMs(manifest), ctx.http?.retry)
    } catch (e) {
      throw new AdapterConfigError(`Konto ${ctx.integration.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.api = new IdoSellOdczyt(this.session)
    const o = Number(ctx.config['overlapMinutes'] ?? 5)
    this.overlapMs = (Number.isFinite(o) && o >= 0 ? o : 5) * 60_000
  }

  protected async search(path: string, params: Record<string, unknown>) {
    try {
      return await this.api.search(path, params)
    } catch (e) {
      throw toAdapterError(e)
    }
  }

  async testConnection(): Promise<ConnectionTest> {
    const check = async (path: string, what: string) => {
      try {
        const r = await this.api.search(path, { resultsPage: 0, resultsLimit: 1 })
        return { ok: true as const, count: r.all }
      } catch (e) {
        const status = e instanceof IdoSellHttpError ? e.status : null
        if (status === 401) return { ok: false as const, message: 'klucz API odrzucony przez IdoSell' }
        if (status === 403) return { ok: false as const, message: `klucz API bez uprawnienia do odczytu: ${what}` }
        return { ok: false as const, message: `${what}: ${e instanceof Error ? e.message : String(e)}` }
      }
    }
    const orders = await check(ORDERS, 'zamówienia')
    if (!orders.ok) return { ok: false, message: orders.message }
    const products = await check(PRODUCTS, 'produkty')
    if (!products.ok) return { ok: false, message: products.message, details: { orders: orders.count } }
    return { ok: true, message: 'odczyt zamówień i produktów działa', details: { orders: orders.count, products: products.count, magazyn: this.magazyn } }
  }

  private feedItem(row: Record<string, unknown>): OrderFeedItem | null {
    const id = serialOf(row)
    if (!id) return null // bez numeru nie da się ani zapisać, ani ponowić
    try {
      const order = idosellOrderFromApi(row, { strefa: this.strefa })
      return { externalId: id, revision: order.revision, order }
    } catch {
      // nieczytelne zamówienie: host pobierze je osobno (getOrder) i zapisze błąd elementu
      let revision = ''
      try {
        revision = idosellRevision(row, this.strefa)
      } catch {
        // zostaje pusta
      }
      return { externalId: id, revision }
    }
  }

  /**
   * Wyszukiwanie po dacie zmiany (`ordersDateType: modified`) od kursora, posortowane rosnąco po numerze zamówienia.
   * Strony po numerze: zamówienie z wyniku nie wypada (data zmiany tylko rośnie), nowe dochodzą na końcu; duble
   * odsiewa host (ta sama rewizja = bez zmian). Kursor jak Woo/Shoper: `{ a: od, p: strona od 1, m: najpóźniejsza zmiana }`.
   */
  async listOrderChanges(cursor: string | null, opts: OrderFeedOptions): Promise<OrderFeedPage> {
    const start = new Date(this.ctx.now().getTime() - opts.initialLookbackMs).toISOString()
    let cur
    try {
      cur = cursor ? parseWooCursor(cursor) : { a: start, p: 1, m: start }
    } catch {
      throw new AdapterError('zły kursor IdoSell', 'TRWALY')
    }
    const since = sinceLocal(new Date(cur.a), this.strefa)
    const nowIso = this.ctx.now().toISOString()
    const r = await this.search(ORDERS, {
      resultsPage: cur.p - 1, // IdoSell liczy strony od 0
      resultsLimit: this.perPage,
      ordersRange: { ordersDateRange: { ordersDateType: 'modified', ordersDateBegin: since } },
      ordersBy: [{ elementName: 'id', sortDirection: 'ASC' }],
    })
    let maxSeen = cur.m
    const items = new Map<string, OrderFeedItem>()
    let older = 0
    for (const row of r.rows) {
      let local: string | null = null
      try {
        local = changedLocal(detailsOf(row), serialOf(row) ?? '?')
      } catch {
        // nieczytelna data: nie wiadomo, czy starsza — przepuszczamy (getOrder rozstrzygnie)
      }
      if (local !== null && local < since) {
        older++
        continue
      }
      const it = this.feedItem(row)
      if (!it) continue
      const prev = items.get(it.externalId)
      if (!prev || it.revision > prev.revision) items.set(it.externalId, it)
      const iso = it.revision.split('#')[0]!
      if (iso && iso > maxSeen) maxSeen = iso < nowIso ? iso : nowIso
    }
    const warnings = older ? [`IdoSell zwrócił ${older} zamówień zmienionych przed kursorem (pominięte) — sprawdź filtr daty zmiany`] : []
    // bez liczby stron w odpowiedzi pełna strona = czytamy dalej (jak Woo); inaczej zamówienia ze
    // stron 2…n wypadłyby za kursor bez śladu
    const pages = r.pages ?? (r.rows.length < this.perPage ? cur.p : cur.p + 1)
    if (cur.p < pages && r.rows.length > 0) {
      return { items: [...items.values()], nextCursor: JSON.stringify({ a: cur.a, p: cur.p + 1, m: maxSeen }), hasMore: true, ...(warnings.length ? { warnings } : {}) }
    }
    const back = new Date(Date.parse(maxSeen) - this.overlapMs).toISOString()
    const nextAfter = back > cur.a ? back : cur.a
    return { items: [...items.values()], nextCursor: JSON.stringify({ a: nextAfter, p: 1, m: maxSeen }), hasMore: false, ...(warnings.length ? { warnings } : {}) }
  }

  /** Surowe zamówienie po numerze (wyszukiwanie z `ordersSerialNumbers`); null = sklep go nie zna. */
  protected async rawOrder(externalId: string): Promise<Record<string, unknown> | null> {
    if (!/^\d{1,15}$/.test(externalId)) throw new AdapterError(`zły numer zamówienia IdoSell „${externalId.slice(0, 40)}”`, 'TRWALY')
    const r = await this.search(ORDERS, { ordersSerialNumbers: [Number(externalId)] })
    return r.rows.find((x) => serialOf(x) === externalId) ?? null
  }

  async getOrder(externalId: string): Promise<ChannelOrder | null> {
    const row = await this.rawOrder(externalId)
    return row ? idosellOrderFromApi(row, { strefa: this.strefa }) : null
  }

  async listOffers(cursor: string | null): Promise<OfferPageWithProblems> {
    const page = cursor === null ? 1 : Number(cursor)
    if (!Number.isInteger(page) || page < 1) throw new AdapterError('zły kursor ofert IdoSell', 'TRWALY')
    const r = await this.search(PRODUCTS, { resultsPage: page - 1, resultsLimit: this.perPage, ordersBy: [{ elementName: 'id', sortDirection: 'ASC' }] })
    const items: ChannelOfferRow[] = []
    const unreadable: OfferReadProblem[] = []
    for (const prod of r.rows) {
      const o = idosellOffersFromApi(prod, this.magazyn)
      items.push(...o.rows)
      unreadable.push(...o.problems)
    }
    const pages = r.pages ?? (r.rows.length < this.perPage ? page : page + 1) // jak przy zamówieniach
    return { items, nextCursor: page < pages && r.rows.length > 0 ? String(page + 1) : null, ...(unreadable.length ? { unreadable } : {}) }
  }
}

// ─── Zapis za wyłącznikiem ───────────────────────────────────────────────────

export const ZAPIS_WYLACZONY = 'zapis wyłączony na tym koncie'
/** Rozmiarów na jedno żądanie zapisu stanu (= CHANNEL_LIMITS.IDOSELL.batch). */
const PACZKA = 100
const worse = (a: FailureKind, b: FailureKind): FailureKind => (a === 'TRWALY' || b === 'TRWALY' ? 'TRWALY' : a === 'NIEJEDNOZNACZNY' || b === 'NIEJEDNOZNACZNY' ? 'NIEJEDNOZNACZNY' : 'PRZEJSCIOWY')
const faultOf = (v: unknown): number => {
  const c = Number(obj(v)['faultCode'] ?? 0)
  return Number.isFinite(c) ? c : -1
}

/** Wynik HTTP całego żądania zapisu → rodzaj błędu (null = odpowiedź do rozbioru per pozycja). */
function httpFailure(status: number): { kind: FailureKind; why: string } | null {
  if (status === 200 || status === 207) return null
  if (status === 429) return { kind: 'PRZEJSCIOWY', why: 'HTTP 429 (limit zapytań)' }
  // zapis bezwzględny (ustaw wartość): 5xx po wysłaniu ponawiamy tą samą wartością bez ryzyka dubla
  if (status >= 500) return { kind: 'PRZEJSCIOWY', why: `HTTP ${status}` }
  if (status === 401 || status === 403) return { kind: 'TRWALY', why: `HTTP ${status} (klucz API bez prawa zapisu)` }
  if (status === 422) return { kind: 'TRWALY', why: 'HTTP 422 (sklep odrzucił dane)' }
  return { kind: 'TRWALY', why: `HTTP ${status}` }
}

interface Pozycja {
  ext: string
  productId: number
  sizeId: string
  qty: number
}

export class IdoSellZapisAdapter extends IdoSellAdapter implements StockWriter, OrderStatusWriter {
  private readonly writer: IdoSellZapis
  private readonly zapisWlaczony: boolean

  constructor(manifest: AdapterManifest, ctx: AdapterContext) {
    super(manifest, ctx)
    this.writer = new IdoSellZapis(this.session)
    this.zapisWlaczony = ctx.config['zapisWlaczony'] === true
  }

  /** Test odczytu jak w `idosell.admin.v1` plus stan wyłącznika zapisu; żadnego żądania zapisu. */
  override async testConnection(): Promise<ConnectionTest> {
    const t = await super.testConnection()
    return { ...t, details: { ...(t.details ?? {}), zapisWlaczony: this.zapisWlaczony } }
  }

  /**
   * Paczka stanów: `PUT products/stocks` z operacją „set” (wartość bezwzględna, powtórka daje ten sam skutek) w magazynie
   * konta, po PACZKA rozmiarów na żądanie. Wynik per oferta z błędów produktu i rozmiaru w odpowiedzi (207 = część
   * nieudana). Po 429 dalszych paczek nie wysyłamy: wracają jako PRZEJSCIOWY z czasem ponowienia.
   */
  async pushStock(items: StockWriteItem[], reference: string): Promise<WriteOutcome> {
    if (!this.zapisWlaczony) return { kind: 'TRWALY', reference, message: ZAPIS_WYLACZONY }
    const failed: FailedWriteItem[] = []
    const ok: Pozycja[] = []
    for (const it of items) {
      const o = parseOfferId(it.offerExternalId)
      if (!o) failed.push({ offerExternalId: it.offerExternalId, kind: 'TRWALY', message: 'zły identyfikator oferty IdoSell' })
      else if (!Number.isInteger(it.qty) || it.qty < 0) failed.push({ offerExternalId: it.offerExternalId, kind: 'TRWALY', message: 'zły stan (oczekiwana liczba całkowita ≥ 0)' })
      else ok.push({ ext: it.offerExternalId, ...o, qty: it.qty })
    }
    let retryAfterMs: number | undefined
    let limited = false
    for (let i = 0; i < ok.length; i += PACZKA) {
      const chunk = ok.slice(i, i + PACZKA)
      if (limited) {
        failed.push(...chunk.map((c) => ({ offerExternalId: c.ext, kind: 'PRZEJSCIOWY' as const, message: 'nie wysłano: limit zapytań IdoSell (429) w tej paczce' })))
        continue
      }
      const r = await this.pushChunk(chunk)
      failed.push(...r.failed)
      if (r.limited) {
        limited = true
        retryAfterMs = r.retryAfterMs
      }
    }
    if (!failed.length) return { kind: 'OK', reference }
    const kind = failed.map((f) => f.kind).reduce(worse)
    const ids = failed.slice(0, 20).map((f) => `${f.offerExternalId} (${f.message})`).join(', ')
    return {
      kind,
      reference,
      message: `zapis stanu nieudany dla ${failed.length} z ${items.length} ofert: ${ids}${failed.length > 20 ? ', …' : ''}`.slice(0, 1000),
      failedItems: failed,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : limited ? { retryAfterMs: 60_000 } : {}),
    }
  }

  private async pushChunk(chunk: Pozycja[]): Promise<{ failed: FailedWriteItem[]; limited: boolean; retryAfterMs?: number }> {
    const all = (kind: FailureKind, message: string) => chunk.map((c) => ({ offerExternalId: c.ext, kind, message }))
    const byProduct = new Map<number, Pozycja[]>()
    for (const c of chunk) byProduct.set(c.productId, [...(byProduct.get(c.productId) ?? []), c])
    const body = {
      params: {
        products: [...byProduct].map(([productId, sizes]) => ({
          ident: { identType: 'id', identValue: String(productId) },
          sizes: sizes.map((s) => ({
            ident: { identType: 'id', identValue: s.sizeId }, // [NIEPEWNE] NIEPEWNE.rozmiarPoId
            quantity: { stocks: [{ stock_id: this.magazyn, quantity_operation: { operation: 'set', quantity: s.qty } }] },
          })),
        })),
      },
    }
    let res
    try {
      res = await this.writer.put<Record<string, unknown>>('products/stocks', body)
    } catch (e) {
      // sieć albo timeout po wysłaniu: stan ustawiany bezwzględnie, powtórka tą samą wartością jest bezpieczna
      if (e instanceof IdoSellHttpError) return { failed: all('PRZEJSCIOWY', e.message), limited: false }
      throw e
    }
    const hf = httpFailure(res.status)
    if (hf) return { failed: all(hf.kind, `IdoSell products/stocks: ${hf.why}`), limited: res.status === 429, ...(res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}) }
    const results = arr(res.body?.['results'] ?? res.body?.['Results'])
    if (!res.body || (!results.length && chunk.length)) {
      // 200/207 bez wyników per pozycja: nie wiemy, co sklep zapisał — powtórka bezpieczna (zapis bezwzględny)
      const fc = faultOf(res.body?.['errors'])
      return { failed: all(fc > 0 ? 'TRWALY' : 'PRZEJSCIOWY', fc > 0 ? `IdoSell odrzucił paczkę stanów (kod ${fc})` : 'brak wyniku zapisu w odpowiedzi sklepu'), limited: false }
    }
    const byId = new Map(results.map((r) => [str(obj(r['ident'])['identValue']), r] as const))
    const out: FailedWriteItem[] = []
    for (const [productId, sizes] of byProduct) {
      const r = byId.get(String(productId))
      if (!r) {
        out.push(...sizes.map((s) => ({ offerExternalId: s.ext, kind: 'PRZEJSCIOWY' as const, message: 'brak produktu w odpowiedzi sklepu' })))
        continue
      }
      const pf = faultOf(r['error'])
      if (pf !== 0) {
        out.push(...sizes.map((s) => ({ offerExternalId: s.ext, kind: 'TRWALY' as const, message: `sklep odrzucił produkt (kod ${pf})` })))
        continue
      }
      const sizeRes = new Map(arr(r['sizes']).map((x) => [str(obj(x['ident'])['identValue']), x] as const))
      // przy `isSizesErrors: true` rozmiar bez wpisu w odpowiedzi nie jest dowodem zapisu (nie trafi
      // do rejestru synchronizacji jako wysłany); przy `false` sklep zgłasza tylko rozmiary z błędami, brak wpisu = OK
      const sizesErrors = r['isSizesErrors'] === true
      for (const s of sizes) {
        const e = sizeRes.get(s.sizeId)
        if (!e) {
          if (sizesErrors) out.push({ offerExternalId: s.ext, kind: 'PRZEJSCIOWY', message: 'brak wyniku rozmiaru w odpowiedzi sklepu' })
          continue
        }
        const sf = faultOf(e['error'])
        if (sf !== 0) out.push({ offerExternalId: s.ext, kind: 'TRWALY', message: `sklep odrzucił rozmiar (kod ${sf})` })
      }
    }
    return { failed: out, limited: false }
  }

  /**
   * Status zamówienia: świeży odczyt, ten sam status albo zamówienie zamknięte w sklepie (anulowane, połączone) albo
   * cofnięcie kolejności = OK bez zapisu; inaczej `PUT orders/orders` z samym `orderStatus`. Powtórka jest bezpieczna
   * (ustawienie wartości), a ponowny odczyt nie wyśle drugiego zapisu. Uwaga: zmiana statusu w IdoSell może wysłać
   * klientowi e-mail ze sklepu (ustawienia powiadomień panelu) — opisane w docs/integracje/idosell.md.
   */
  async setOrderStatus(orderExternalId: string, channelStatus: string, reference: string, guard: StatusWriteGuard = {}): Promise<WriteOutcome> {
    if (!this.zapisWlaczony) return { kind: 'TRWALY', reference, message: ZAPIS_WYLACZONY }
    if (!/^\d{1,15}$/.test(orderExternalId) || !IDOSELL_STATUSY_ZAPISU.some((s) => s.id === channelStatus)) return { kind: 'TRWALY', reference, message: 'zły numer zamówienia albo status IdoSell' }
    // bez `unpaidGuard` w manifeście host nie wysyła anulowania nieopłaconego; gdyby jednak przyszło, nie zgadujemy płatności
    if (guard.onlyIfUnpaid) return { kind: 'TRWALY', reference, message: 'IdoSell: anulowanie nieopłaconego bez sprawdzenia płatności — zrób to w panelu sklepu' }
    let row: Record<string, unknown> | null
    try {
      row = await this.rawOrder(orderExternalId)
    } catch (e) {
      const a = toAdapterError(e)
      if (a instanceof AdapterError) return { kind: a.kind, reference, message: a.message, ...(a.retryAfterMs ? { retryAfterMs: a.retryAfterMs } : {}) }
      throw e
    }
    if (!row) return { kind: 'TRWALY', reference, message: `nie ma zamówienia ${orderExternalId} w sklepie` }
    const now = statusOf(detailsOf(row))
    if (now === channelStatus) return { kind: 'OK', reference, externalRef: `bez-zmian:${now}` }
    const known = now ? IDOSELL_STATUS[now] : undefined
    if (known?.lifecycle === 'CANCELLED') return { kind: 'OK', reference, externalRef: `bez-zmian:${now}` } // zamknięte w sklepie
    const rankTarget = IDOSELL_STATUS[channelStatus]?.rank
    if (known?.rank != null && rankTarget != null && rankTarget < known.rank) return { kind: 'OK', reference, externalRef: `bez-zmian:${now}` } // bez cofania
    let res
    try {
      res = await this.writer.put<Record<string, unknown>>('orders/orders', { params: { orders: [{ orderSerialNumber: Number(orderExternalId), orderStatus: channelStatus }] } })
    } catch (e) {
      if (e instanceof IdoSellHttpError) return { kind: 'PRZEJSCIOWY', reference, message: e.message }
      throw e
    }
    const hf = httpFailure(res.status)
    if (hf) return { kind: hf.kind, reference, message: `zmiana statusu zamówienia ${orderExternalId} nieudana: ${hf.why}`, ...(res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}) }
    const r = arr(obj(res.body?.['results'])['ordersResults']).find((x) => str(x['orderSerialNumber']) === orderExternalId) ?? arr(obj(res.body?.['results'])['ordersResults'])[0]
    if (!r) return { kind: 'PRZEJSCIOWY', reference, message: `brak wyniku zmiany statusu zamówienia ${orderExternalId} w odpowiedzi sklepu` }
    const fc = faultOf(r)
    if (fc !== 0) return { kind: 'TRWALY', reference, message: `sklep odrzucił zmianę statusu zamówienia ${orderExternalId} (kod ${fc})` }
    return { kind: 'OK', reference }
  }
}

export const IDOSELL_DEFINITION: AdapterDefinition = { manifest: IDOSELL_MANIFEST, create: (ctx) => new IdoSellAdapter(IDOSELL_MANIFEST, ctx) }
export const IDOSELL_ZAPIS_DEFINITION: AdapterDefinition = { manifest: IDOSELL_ZAPIS_MANIFEST, create: (ctx) => new IdoSellZapisAdapter(IDOSELL_ZAPIS_MANIFEST, ctx) }
