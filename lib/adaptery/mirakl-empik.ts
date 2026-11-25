// Adapter Empik (Mirakl) `mirakl.empik.v1`: dziennik zamówień przez OR11 `GET /orders` po
// `start_update_date`, tylko odczyt, istniejący klucz (nowego NIE generować — zerwałby BL).
// Klucz adaptera (`mirakl.empik.v1`; plik zadania miał roboczo `empik.mirakl.v1`).
// Mapowanie wg spec v1.5 rozdz. 3.1: od WAITING_ACCEPTANCE zamówienie rezerwuje; STAGING (weryfikacja Mirakla)
// jeszcze nie; CANCELED, REFUSED, REFUNDED → CANCELLED; SHIPPED, TO_COLLECT, RECEIVED, CLOSED → FULFILLED.
// Płatność: do WAITING_DEBIT_PAYMENT włącznie nieopłacone, od SHIPPING opłacone (Empik pobrał pieniądze).
// Pozycje odrzucone/anulowane (REFUSED, CANCELED) pomijane. Oferta = product_sku (ChannelOffer.externalId).
// Dane klienta (`customer`, adresy) nie są czytane w dzienniku. Odbiorcę czyta osobna zdolność `orders.recipient`
// (`miraklRecipientFromApi`): OR11 po `order_ids` tym samym klientem (jego limiter), na żądanie hosta.
import type { Carrier } from '@prisma/client'
import { ReadOnlyViolation, SourceError, type FetchLike } from '../zrodla/http'
import { MiraklReadOnly, MiraklWriter, miraklAccountKey, type MiraklWriteResult, miraklQueryZapisu, ODCZYT_OFERT_MIRAKL_RE } from '../zrodla/mirakl'
import { empikOfferFromApi } from '../import/normalizacja'
import {
  ACCEPT_ALREADY_DECIDED,
  AdapterError,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type ChannelAdapter,
  type ChannelBehavior,
  type ChannelOrder,
  type ChannelOrderLine,
  type ConnectionTest,
  type OrderFeed,
  type OrderFeedItem,
  type OrderFeedOptions,
  type OrderFeedPage,
  type OrderLifecycle,
  type OrderRecipient,
  joinName,
  missingAddressProblems,
  type ChannelOfferRow,
  type OfferPageWithProblems,
  type OfferReadProblem,
  type OfferReader,
  optAmount,
  opisLinii,
  optText,
  readDate,
  readInt,
  readNumber,
  readRecipientObject,
  readRecipientText,
  type RecipientAddress,
  type RecipientInvoice,
  type RecipientPickupPoint,
  type RecipientProblem,
  type RecipientReader,
  UnreadableDataError,
  type OrderAcceptDecision,
  type OrderAcceptor,
  type OrderStatusWriter,
  type StockImportStatus,
  type StockImportStatusReader,
  type StockWriteItem,
  type StockWriter,
  type TrackingInfo,
  type TrackingWriter,
  type WriteOutcome,
  POLE_WYSTAWIANIA_OFERT,
  WYSTAWIANIE_WYLACZONE,
  wystawianieOfertWlaczone,
} from './kontrakt'

const CONFIG: AdapterManifest['config'] = [
  { key: 'baseUrl', type: 'string', required: true, description: 'adres API Mirakla (https://…/api)', pattern: /^https:\/\/\S+$/i, envSuffix: 'BASE_URL' },
  { key: 'envPrefix', type: 'string', required: false, description: 'self-host: przedrostek zmiennych env konta (np. EMPIK_MIRAKL)', pattern: /^[A-Z][A-Z0-9_]{0,40}$/ },
  { key: 'pollIntervalSec', type: 'number', required: false, description: 'co ile sekund czytać zamówienia (≥ 60, domyślnie 60)' },
  { key: 'overlapMinutes', type: 'number', required: false, description: 'zakładka czasowa odczytu (domyślnie 5)' },
  { key: 'pageSize', type: 'number', required: false, description: 'zamówień na stronę (1–100, domyślnie 100)' },
  // przyjmowanie zamówień (lib/empik/akceptacja.ts). Działa też na koncie tylko do odczytu: wtedy Kompletor
  // zapisuje, co by zrobił, i pilnuje alertu po czasie.
  {
    key: 'akceptacjaBraki',
    type: 'string',
    required: false,
    description: 'co zrobić, gdy na pozycji zamówienia Empik brakuje towaru (domyślnie: zostaw do decyzji z alertem)',
    pattern: /^(czekaj|odrzuc)$/,
    options: [
      { value: 'czekaj', label: 'Zostaw zamówienie do decyzji i wyślij alert' },
      { value: 'odrzuc', label: 'Odrzuć pozycję bez towaru, resztę przyjmij' },
    ],
  },
  { key: 'akceptacjaAlertGodzin', type: 'number', required: false, description: 'po ilu godzinach czekania na przyjęcie wysłać alert (1–96, domyślnie 12; Empik anuluje po 5 dniach)' },
]

export const MIRAKL_EMPIK_MANIFEST: AdapterManifest = {
  adapterKey: 'mirakl.empik.v1',
  version: '1.1.0',
  displayName: 'Empik Marketplace (Mirakl)',
  kind: 'channel',
  channel: 'EMPIK',
  capabilities: ['orders.feed', 'orders.recipient', 'offers.read', 'offers.prepare'],
  // OR11: zalecane co 5 min, maks. raz na minutę; limit godzinowy bez publicznych liczb
  // odbiorca na żądanie też OR11: ten sam odstęp, pilnowany przez hosta
  rateLimit: { requestsPerMinute: 30, maxConcurrent: 1, minPollIntervalMs: 60_000, recipientMinIntervalMs: 60_000 },
  config: CONFIG,
  secrets: [{ name: 'MIRAKL_API_KEY', required: true, description: 'klucz API sklepu (nagłówek Authorization)', envSuffix: 'API_KEY' }],
  readOnly: true,
}

/**
 * Empik z zapisem ZA WYŁĄCZNIKIEM: przyjęcie zamówienia (OR21), stany (STO01), numer nadania (OR23),
 * „wysłane” (OR24). Zapis wymaga trzech niezależnych warunków: konto ma ten klucz, ma `zapisWlaczony: true` i host
 * wywoła zapis (akceptację woła tylko konto w PRACY, lib/empik/akceptacja.ts). Bez wyłącznika każda metoda zapisu
 * zwraca TRWALY i nie wysyła żadnego żądania.
 */
/**
 * statusy Empiku, które Kompletor ustawia (tylko OR24 „wysłane”; resztę Empik prowadzi sam: przyjęcie idzie
 * osobno przez OR21, anulowanie robi Empik albo klient). Domyślna mapa: „Wysłane” → SHIPPED, żeby konto z zapisem nie
 * stało bez statusu (bez „wysłane” Empik nie rozlicza zamówienia). Numer nadania (OR23) idzie osobnym zapisem po
 * utworzeniu przesyłki, więc w Empiku jest przed „wysłane”.
 */
export const EMPIK_STATUSY_KANALU = [{ id: 'SHIPPED', label: 'Wysłane' }] as const

export const EMPIK_BEHAVIOR: ChannelBehavior = {
  // Mirakl zdejmuje ilość oferty przy zamówieniu (tak samo jak lista SELF_DECREMENTING w lib/rdzen/propagacja.ts)
  stockModel: 'self-decrementing',
  channelStatuses: EMPIK_STATUSY_KANALU,
  defaultStatusMap: { WYSLANE: 'SHIPPED' },
  // Mirakl: najpierw numer nadania (OR23), potem „wysłane” (OR24, „Validate the shipment of an order in the
  // SHIPPING status”); host trzyma status, dopóki numer nadania tego zamówienia czeka w kolejce
  trackingBeforeStatus: true,
}

export const MIRAKL_EMPIK_ZAPIS_MANIFEST: AdapterManifest = {
  ...MIRAKL_EMPIK_MANIFEST,
  adapterKey: 'mirakl.empik.zapis.v1',
  channelBehavior: EMPIK_BEHAVIOR,
  version: '1.1.0',
  displayName: 'Empik Marketplace (Mirakl, z zapisem za wyłącznikiem)',
  // `stock.import.status` = wynik importu stanów (STO02/STO03), czytany przez host po przyjęciu pliku
  capabilities: ['orders.feed', 'orders.recipient', 'offers.read', 'offers.prepare', 'stock.write', 'stock.import.status', 'order.status.write', 'order.accept', 'order.tracking.write', 'offers.publish'],
  // import stanów STO01 najwyżej raz na minutę (Mirakl, ten sam limit co CHANNEL_LIMITS.EMPIK w rdzeniu);
  // pozostałe zdolności bez osobnego limitu (OR11 pilnuje `minPollIntervalMs`, limit godzinowy bez publicznych liczb)
  rateLimit: { ...MIRAKL_EMPIK_MANIFEST.rateLimit, perCapability: { 'stock.write': { requestsPerMinute: 1 }, 'offers.publish': { requestsPerMinute: 2, maxConcurrent: 1 } } },
  config: [
    ...CONFIG,
    { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'wyłącznik: tak = Kompletor przyjmuje zamówienia, wysyła stany, numery nadania i „wysłane” do Empiku; brak = nic nie wysyła' },
    {
      key: 'kodyPrzewoznikow',
      type: 'string',
      required: false,
      description: 'kody przewoźników z listy Empiku jako JSON, tylko gdy inne niż domyślne (paczkomaty: paczkomatyinpost, DPD i salon Empik: dpd, InPost kurier: inpostpaczkakurierska, GLS: gls, Orlen: ORLEN, Poczta: pocztex), np. {"DPD":"dpd"}; przewoźnik bez kodu idzie z nazwą i adresem śledzenia',
      pattern: /^\{[\s\S]{0,1000}\}$/,
    },
    { key: 'magazynEmpik', type: 'string', required: false, description: 'kod magazynu w Empiku dla stanów (puste = stan całej oferty)', pattern: /^[A-Za-z0-9_-]{1,40}$/ },
    POLE_WYSTAWIANIA_OFERT, // osobny wyłącznik wystawiania ofert i wniosków o produkt
  ],
  readOnly: false,
}

const STATE: Record<string, { lifecycle: OrderLifecycle; rank: number | null; paid: boolean }> = {
  STAGING: { lifecycle: 'DRAFT', rank: null, paid: false },
  WAITING_ACCEPTANCE: { lifecycle: 'OPEN', rank: 10, paid: false },
  WAITING_DEBIT: { lifecycle: 'OPEN', rank: 20, paid: false },
  WAITING_DEBIT_PAYMENT: { lifecycle: 'OPEN', rank: 20, paid: false },
  SHIPPING: { lifecycle: 'OPEN', rank: 30, paid: true },
  SHIPPED: { lifecycle: 'FULFILLED', rank: 40, paid: true },
  TO_COLLECT: { lifecycle: 'FULFILLED', rank: 45, paid: true },
  RECEIVED: { lifecycle: 'FULFILLED', rank: 50, paid: true },
  CLOSED: { lifecycle: 'FULFILLED', rank: 60, paid: true },
  REFUSED: { lifecycle: 'CANCELLED', rank: null, paid: false },
  CANCELED: { lifecycle: 'CANCELLED', rank: null, paid: false },
  REFUNDED: { lifecycle: 'CANCELLED', rank: null, paid: true },
  // incydent otwiera klient po otrzymaniu przesyłki, zwrot pieniędzy czeka po wysyłce: towar już wyjechał, więc
  // widziane pierwszy raz nie rezerwują; kolejność między RECEIVED a CLOSED
  INCIDENT_OPEN: { lifecycle: 'FULFILLED', rank: 55, paid: true },
  INCIDENT_CLOSED: { lifecycle: 'FULFILLED', rank: 55, paid: true },
  WAITING_REFUND: { lifecycle: 'FULFILLED', rank: 55, paid: true },
  WAITING_REFUND_PAYMENT: { lifecycle: 'FULFILLED', rank: 55, paid: true },
}
const SKIPPED_LINE_STATES = new Set(['REFUSED', 'CANCELED'])

/** cykl życia stanu zamówienia Mirakl (null = stan nieznany adapterowi). */
export function miraklStateLifecycle(state: string): OrderLifecycle | null {
  return Object.hasOwn(STATE, state) ? STATE[state]!.lifecycle : null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const round2 = (n: number) => Math.round(n * 100) / 100

/** Zamówienie OR11 → ChannelOrder. Nieczytelne pole = UnreadableDataError (nigdy 0). */
export function miraklOrderFromApi(raw: Record<string, unknown>): ChannelOrder {
  const externalId = str(raw['order_id'])
  if (!externalId) throw new UnreadableDataError('zamówienie Empik bez order_id')
  const state = str(raw['order_state'])
  if (!state) throw new UnreadableDataError(`zamówienie ${externalId} bez order_state`)
  const warnings: string[] = []
  const known = STATE[state]
  if (!known) warnings.push(`nieznany stan Mirakl „${state}” — traktowany jak otwarte, bez kolejności`)
  const linesRaw = raw['order_lines']
  if (!Array.isArray(linesRaw)) throw new UnreadableDataError(`zamówienie ${externalId} bez order_lines`)
  const lines: ChannelOrderLine[] = []
  for (const [i, l] of (linesRaw as Record<string, unknown>[]).entries()) {
    const id = str(l['order_line_id'])
    if (!id) throw new UnreadableDataError(`pozycja ${i + 1} zamówienia ${externalId} bez order_line_id`)
    const lineState = str(l['order_line_state'])
    if (lineState && SKIPPED_LINE_STATES.has(lineState)) {
      warnings.push(`pozycja ${id}: ${lineState} — pominięta`)
      continue
    }
    const qty = readInt(l['quantity'], `ilość pozycji ${id}`)
    if (qty <= 0) throw new UnreadableDataError(`ilość pozycji ${id} ≤ 0`)
    const unit = l['price_unit'] !== undefined ? readNumber(l['price_unit'], `cena pozycji ${id}`) : readNumber(l['price'], `kwota pozycji ${id}`) / qty
    const sku = str(l['product_sku'])
    if (!sku) warnings.push(`pozycja ${id}: bez product_sku`)
    lines.push({ externalLineId: id, offerExternalId: sku, qty, unitPriceGross: round2(unit), vatRate: null, ...opisLinii(optText(l['product_title']), optText(l['offer_sku'], 200), null) })
  }
  return {
    externalId,
    revision: readDate(raw['last_updated_date'] ?? raw['created_date'], `data zmiany ${externalId}`).toISOString(),
    createdAt: readDate(raw['created_date'], `data zamówienia ${externalId}`),
    channelStatus: state,
    statusRank: known?.rank ?? null,
    lifecycle: known?.lifecycle ?? 'OPEN',
    paymentState: known?.paid ? 'PAID' : 'UNPAID',
    paymentMethod: str(raw['payment_type']) ?? 'Empik',
    totalGross: readNumber(raw['total_price'], `kwota zamówienia ${externalId}`),
    currency: str(raw['currency_iso_code']) ?? 'PLN',
    deliveryMethod: str(raw['shipping_type_label']) ?? str(raw['shipping_type_code']),
    shippingCostGross: optAmount(raw['shipping_price']),
    wantInvoiceNip: false,
    lines,
    warnings,
  }
}

// ─── Odbiorca na żądanie ─────────────────────────────────────────

// Mirakl podaje `country_iso_code` zwykle w ISO alpha-3; kontrakt chce alpha-2. Nieznany kod zostaje jak w kanale.
const ALPHA3: Record<string, string> = { POL: 'PL', DEU: 'DE', CZE: 'CZ', SVK: 'SK', LTU: 'LT', AUT: 'AT', FRA: 'FR' }
const countryOf = (v: string | null) => (v && ALPHA3[v.toUpperCase()] ? ALPHA3[v.toUpperCase()]! : v)

/**
 * Kod punktu odbioru z OR11. Kształt potwierdzony odczytem na żywym koncie (20.11.2026, 15 zamówień): Empik podaje kod
 * w `order_additional_fields[]` jako pole `code: "delivery-point-name"` z `value` (paczkomat InPost np. „POZ01M”, salon
 * Empik kod punktu DPD Pickup np. „PL12345”). `shipping_pudo_id` jest pusty. Przy dostawie do punktu
 * `customer.shipping_address` opisuje PUNKT, nie klienta: `lastname` = kod punktu, bez `firstname`, ulica, kod i
 * miasto punktu, `additional_info` = opis punktu (tylko paczkomat), `phone` = telefon klienta. Klient (imię, nazwisko,
 * adres) jest w `customer.firstname/lastname` i `customer.billing_address`.
 */
export const EMPIK_POLE_PUNKTU = 'delivery-point-name'
/** Prawdziwy e-mail klienta (`order_additional_fields`); `customer_notification_email` to adres zastępczy Mirakla. */
export const EMPIK_POLE_EMAIL = 'customer-email'
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/

/** Wartość pola dodatkowego zamówienia po `code` (tekst albo null); zły typ listy albo wartości = UnreadableDataError. */
function poleDodatkowe(raw: Record<string, unknown>, code: string): string | null {
  const pola = raw['order_additional_fields']
  if (pola === undefined || pola === null) return null
  if (!Array.isArray(pola)) throw new UnreadableDataError('nieczytelne pole odbiorcy: order_additional_fields')
  const f = pola.find((x): x is Record<string, unknown> => !!x && typeof x === 'object' && (x as Record<string, unknown>)['code'] === code)
  return f ? readRecipientText(f['value'], `order_additional_fields.${code}`) : null
}
/** Sposoby dostawy Empiku do punktu (kod OR11 `shipping_type_code`); etykieta jako zapas, gdy kodu brak. */
const DOSTAWA_DO_PUNKTU_KODY = new Set(['PACKSTATION', 'STORE'])
const DOSTAWA_DO_PUNKTU_ETYKIETA = /paczkomat|salon/i
/** Kod punktu do przewoźnika: litery, cyfry, „-” i „_”; inny = nie do użycia (nie zgadujemy). */
const KOD_PUNKTU_RE = /^[A-Za-z0-9_-]{2,40}$/

export function miraklWymagaPunktu(raw: Record<string, unknown>): boolean {
  const code = str(raw['shipping_type_code'])
  if (code) return DOSTAWA_DO_PUNKTU_KODY.has(code.toUpperCase())
  const label = str(raw['shipping_type_label'])
  return !!label && DOSTAWA_DO_PUNKTU_ETYKIETA.test(label)
}

/** Sam kod punktu z pola `delivery-point-name` (bez nazwy i adresu); kod spoza wzorca = null. */
export function miraklKodPunktu(raw: Record<string, unknown>): string | null {
  const kod = poleDodatkowe(raw, EMPIK_POLE_PUNKTU)
  return kod && KOD_PUNKTU_RE.test(kod) ? kod : null
}

// OR11 podaje kraj zwykle tylko nazwą (`country`, np. „Polska”), `country_iso_code` bywa pusty
const KRAJ_Z_NAZWY: Record<string, string> = { polska: 'PL', poland: 'PL' }
const krajZNazwy = (v: string | null) => (v ? (KRAJ_Z_NAZWY[v.trim().toLowerCase()] ?? null) : null)

/**
 * Zamówienie OR11 → odbiorca. Każde pole czytane osobno, brak = null. Mirakl może ukrywać adres przed przyjęciem
 * zamówienia: brak adresu dostawy = `adres_niedostepny_w_kanale`, nie błąd. NIP-u OR11 nie podaje.
 * - Dostawa do punktu (paczkomat, salon Empik; sposób dostawy albo kod punktu): `shipping_address` to dane punktu
 *   (kształt przy `EMPIK_POLE_PUNKTU`). Punkt = kod z pola dodatkowego, nazwa = opis punktu, adres punktu z
 *   `shipping_address`. Odbiorca = imię i nazwisko klienta (`customer.*`, zapasowo `billing_address`), adres dostawy =
 *   adres punktu (tak jak Allegro przy punkcie), telefon klienta. Kod punktu nigdy nie trafia do imienia ani firmy.
 * - Dane do faktury z `billing_address`: firma albo imię i nazwisko klienta z adresem rozliczeniowym (bez nich
 *   faktura imienna brałaby nabywcę z adresu dostawy, czyli przy punkcie z adresu paczkomatu).
 * - E-mail: prawdziwy z pola dodatkowego `customer-email`, gdy wygląda na adres; inaczej adres zastępczy Mirakla
 *   (`customer_notification_email`).
 */
export function miraklRecipientFromApi(raw: Record<string, unknown>): OrderRecipient {
  const problemy: RecipientProblem[] = []
  const customer = readRecipientObject(raw['customer'], 'customer') ?? {}
  const imieKlienta = joinName(readRecipientText(customer['firstname'], 'customer.firstname'), readRecipientText(customer['lastname'], 'customer.lastname'))
  const emailPrawdziwy = poleDodatkowe(raw, EMPIK_POLE_EMAIL)
  const email = (emailPrawdziwy && EMAIL_RE.test(emailPrawdziwy) ? emailPrawdziwy : null) ?? readRecipientText(raw['customer_notification_email'], 'customer_notification_email')
  const addr = (name: 'shipping_address' | 'billing_address') => {
    const a = readRecipientObject(customer[name], `customer.${name}`)
    if (!a) return null
    const t = (f: string) => readRecipientText(a[f], `customer.${name}.${f}`)
    const ulica = [t('street_1'), t('street_2')].filter((x): x is string => !!x).join(' ') || null
    return {
      imie: joinName(t('firstname'), t('lastname')),
      firma: t('company'),
      ulica,
      kod: t('zip_code'),
      miasto: t('city'),
      kraj: countryOf(t('country_iso_code')) ?? krajZNazwy(t('country')),
      telefon: t('phone') ?? t('phone_secondary'),
      opis: t('additional_info'),
    }
  }
  const ship = addr('shipping_address')
  const bill = addr('billing_address')
  const kodPunktu = miraklKodPunktu(raw)
  const doPunktu = !!kodPunktu || miraklWymagaPunktu(raw)
  const maAdres = (a: ReturnType<typeof addr>) => !!a && !!(a.ulica || a.kod || a.miasto)

  let punktOdbioru: RecipientPickupPoint | null = null
  if (kodPunktu) {
    punktOdbioru = {
      kod: kodPunktu,
      nazwa: doPunktu && ship?.opis ? ship.opis : null,
      adres: ship && maAdres(ship) ? { ulica: ship.ulica, kodPocztowy: ship.kod, miasto: ship.miasto } : null,
    }
  } else if (doPunktu) problemy.push('punkt_nieznany')

  let dostawa: RecipientAddress | null = null
  if (ship && maAdres(ship)) {
    dostawa = {
      // przy punkcie `shipping_address` niesie kod punktu w nazwisku: odbiorcą jest klient, nie punkt
      imieNazwisko: doPunktu ? (imieKlienta ?? bill?.imie ?? null) : (ship.imie ?? imieKlienta),
      firma: doPunktu ? null : ship.firma,
      ulica: ship.ulica,
      numerDomu: null,
      numerLokalu: null,
      kodPocztowy: ship.kod,
      miasto: ship.miasto,
      kraj: ship.kraj,
      telefon: ship.telefon ?? bill?.telefon ?? null,
      email,
    }
    if (dostawa.ulica) problemy.push('adres_bez_podzialu')
    problemy.push(...missingAddressProblems(dostawa))
  } else problemy.push('adres_niedostepny_w_kanale')

  // Dane do faktury z adresu rozliczeniowego: firma (bez NIP-u, którego OR11 nie podaje) albo osoba prywatna.
  const nazwaFaktury = bill?.firma ?? bill?.imie ?? imieKlienta
  const faktura: RecipientInvoice | null =
    bill && maAdres(bill) && nazwaFaktury ? { nazwa: nazwaFaktury, nip: null, ulica: bill.ulica, kodPocztowy: bill.kod, miasto: bill.miasto, kraj: bill.kraj } : null
  if (bill?.firma && faktura) problemy.push('nip_niedostepny_w_kanale')
  return { dostawa, punktOdbioru, faktura, problemy }
}

interface MiraklCursor {
  a: string // start_update_date (ISO UTC)
  o: number // offset
  m: string // najpóźniejsza widziana zmiana
}

export function parseMiraklCursor(c: string): MiraklCursor {
  try {
    const x = JSON.parse(c) as MiraklCursor
    if (typeof x.a === 'string' && typeof x.m === 'string' && Number.isInteger(x.o) && x.o >= 0 && !Number.isNaN(Date.parse(x.a)) && !Number.isNaN(Date.parse(x.m))) return x
  } catch {
    // niżej
  }
  throw new AdapterError('zły kursor Mirakl', 'TRWALY')
}

const pageSizeOf = (v: unknown) => {
  const n = Number(v ?? 100)
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 100
}

function toAdapterError(e: unknown): unknown {
  if (e instanceof SourceError) return new AdapterError(e.message, e.retryable ? 'PRZEJSCIOWY' : 'TRWALY')
  return e
}

class MiraklEmpikAdapter implements ChannelAdapter, OrderFeed, RecipientReader, OfferReader {
  protected readonly api: MiraklReadOnly
  private readonly overlapMs: number
  protected readonly max: number

  constructor(
    protected readonly ctx: AdapterContext,
    readonly manifest: AdapterManifest = MIRAKL_EMPIK_MANIFEST,
  ) {
    this.max = pageSizeOf(ctx.config['pageSize'])
    this.api = new MiraklReadOnly(String(ctx.config['baseUrl']), ctx.secrets['MIRAKL_API_KEY']!, ctx.fetch as FetchLike, ctx.http?.minIntervalMs, ctx.http?.retry)
    const o = Number(ctx.config['overlapMinutes'] ?? 5)
    this.overlapMs = (Number.isFinite(o) && o >= 0 ? o : 5) * 60_000
  }

  /** publiczny odczyt do ofertowania (P31 katalog po EAN, H11 kategorie); inna ścieżka = błąd przed wysłaniem. */
  odczytDoOfert<T = Record<string, unknown>>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    if (!ODCZYT_OFERT_MIRAKL_RE.test(path)) return Promise.reject(new ReadOnlyViolation(`Mirakl: odczyt do ofert poza dozwolonymi ścieżkami (${path.slice(0, 60)})`))
    return this.api.get<T>(path, query)
  }

  /**
   * etap 2: strona OR11 do archiwum zamówień (tylko `GET /orders` z zakresem daty utworzenia i
   * stronicowaniem; inny parametr = błąd przed wysłaniem). OR11 nie ma listy pól: odpowiedź zawiera dane klienta, więc
   * importer archiwum od razu ją przycina do listy dozwolonych pól (lib/archiwum/kanaly.ts).
   */
  async odczytListyZamowienArchiwum(query: Record<string, string | number>): Promise<{ orders: unknown[]; totalCount: number | null }> {
    if (Object.keys(query).some((k) => !/^(start_date|end_date|sort|order|max|offset)$/.test(k)))
      throw new ReadOnlyViolation('Mirakl: lista zamówień do archiwum tylko z zakresem dat i stronicowaniem')
    let r: { orders?: unknown; total_count?: unknown }
    try {
      r = await this.api.get('/orders', query)
    } catch (e) {
      throw toAdapterError(e)
    }
    if (!Array.isArray(r.orders)) throw new AdapterError('Mirakl OR11: brak listy orders', 'PRZEJSCIOWY')
    return { orders: r.orders as unknown[], totalCount: typeof r.total_count === 'number' && Number.isInteger(r.total_count) ? r.total_count : null }
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const r = await this.api.get<{ total_count?: unknown }>('/orders', { max: 1 })
      return { ok: true, message: 'odczyt zamówień (OR11) działa', details: { orders: typeof r.total_count === 'number' ? r.total_count : null } }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  async listOrderChanges(cursor: string | null, opts: OrderFeedOptions): Promise<OrderFeedPage> {
    const start = new Date(this.ctx.now().getTime() - opts.initialLookbackMs).toISOString()
    const cur: MiraklCursor = cursor ? parseMiraklCursor(cursor) : { a: start, o: 0, m: start }
    let r: { orders?: unknown; total_count?: unknown }
    try {
      // OR11 sortuje po dacie utworzenia (podajemy jawnie: liczy się pole niezmienne, nie kierunek), potem po id
      // (dokumentacja OR11, 25.10.2026): zamówienie,
      // które w trakcie stronicowania wejdzie do wyniku (zmiana), wstawia się przed bieżącym offsetem i przesuwa resztę
      // do przodu — skutek to powtórka jednego zamówienia (bezpieczna), nie pominięcie. Mirakl sam cofa start o margines.
      r = await this.api.get('/orders', { start_update_date: cur.a, max: this.max, offset: cur.o, sort: 'dateCreated' })
    } catch (e) {
      throw toAdapterError(e)
    }
    if (!Array.isArray(r.orders)) throw new AdapterError('Mirakl OR11: brak listy orders', 'PRZEJSCIOWY')
    const total = typeof r.total_count === 'number' && Number.isInteger(r.total_count) ? r.total_count : null
    const items: OrderFeedItem[] = []
    let maxSeen = cur.m
    for (const raw of r.orders as Record<string, unknown>[]) {
      const id = str(raw?.['order_id'])
      if (!id) continue
      try {
        const order = miraklOrderFromApi(raw)
        items.push({ externalId: id, revision: order.revision, order })
        if (order.revision > maxSeen) maxSeen = order.revision
      } catch {
        items.push({ externalId: id, revision: '' }) // host pobierze osobno i zapisze błąd elementu
      }
    }
    const nextOffset = cur.o + r.orders.length
    const more = r.orders.length > 0 && (total !== null ? nextOffset < total : r.orders.length === this.max)
    if (more) return { items, nextCursor: JSON.stringify({ a: cur.a, o: nextOffset, m: maxSeen }), hasMore: true }
    const back = new Date(Date.parse(maxSeen) - this.overlapMs).toISOString()
    return { items, nextCursor: JSON.stringify({ a: back > cur.a ? back : cur.a, o: 0, m: maxSeen }), hasMore: false }
  }

  async getOrder(externalId: string): Promise<ChannelOrder | null> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(externalId)) throw new AdapterError(`zły numer zamówienia Empik „${externalId}”`, 'TRWALY')
    let r: { orders?: unknown }
    try {
      r = await this.api.get('/orders', { order_ids: externalId })
    } catch (e) {
      throw toAdapterError(e)
    }
    if (!Array.isArray(r.orders)) throw new AdapterError('Mirakl OR11: brak listy orders', 'PRZEJSCIOWY')
    const raw = (r.orders as Record<string, unknown>[]).find((o) => str(o?.['order_id']) === externalId)
    return raw ? miraklOrderFromApi(raw) : null
  }

  /** OR11 po `order_ids` przez klienta adaptera (jego limiter tempa i ponowienia), jak getOrder. */
  async getOrderRecipient(externalId: string): Promise<OrderRecipient> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(externalId)) throw new AdapterError('zły numer zamówienia Empik', 'TRWALY')
    let r: { orders?: unknown }
    try {
      r = await this.api.get('/orders', { order_ids: externalId })
    } catch (e) {
      throw toAdapterError(e)
    }
    if (!Array.isArray(r?.orders)) throw new AdapterError('Mirakl OR11: brak listy orders', 'PRZEJSCIOWY')
    const raw = (r.orders as unknown[]).find((o) => o && typeof o === 'object' && str((o as Record<string, unknown>)['order_id']) === externalId)
    if (!raw) throw new AdapterError(`Empik: zamówienia ${externalId} nie ma w kanale`, 'TRWALY')
    return miraklRecipientFromApi(raw as Record<string, unknown>)
  }

  // oferty sklepu (OF21 `GET /offers`, jak fetchEmpikOffers w imporcie), tylko GET. Kursor = offset (tekst).
  // Oferta = product_sku (tak samo jak pozycja zamówienia OR11), SKU = shop_sku.
  async listOffers(cursor: string | null): Promise<OfferPageWithProblems> {
    const offset = cursor === null ? 0 : Number(cursor)
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new AdapterError('zły kursor ofert Mirakl', 'TRWALY')
    let r: { offers?: unknown; total_count?: unknown }
    try {
      r = await this.api.get('/offers', { max: this.max, offset })
    } catch (e) {
      throw toAdapterError(e)
    }
    if (!Array.isArray(r.offers)) throw new AdapterError('Mirakl OF21: brak listy offers', 'PRZEJSCIOWY')
    const items: ChannelOfferRow[] = []
    const unreadable: OfferReadProblem[] = []
    for (const raw of r.offers as Record<string, unknown>[]) {
      const id = str(raw?.['product_sku'])
      if (!id) {
        unreadable.push({ externalId: '?', message: 'oferta Empik bez product_sku' })
        continue
      }
      try {
        const o = empikOfferFromApi(raw)
        items.push({ externalId: id, sku: o.shopSku, ean: o.ean, name: o.name || null, qty: raw['quantity'] === null ? null : readInt(raw['quantity'], `stan oferty ${id}`), active: o.active })
      } catch (e) {
        if (!(e instanceof UnreadableDataError)) throw e
        unreadable.push({ externalId: id, message: e.message })
      }
    }
    const total = typeof r.total_count === 'number' && Number.isInteger(r.total_count) ? r.total_count : null
    const next = offset + r.offers.length
    const more = r.offers.length > 0 && (total !== null ? next < total : r.offers.length === this.max)
    return { items, nextCursor: more ? String(next) : null, unreadable }
  }
}


// ─── Zapis za wyłącznikiem ───────────────────────────────────────
// Mirakl nie przyjmuje klucza idempotencji, więc każdy zapis jest tak zbudowany, żeby ponowienie było bezpieczne:
// stany to wartości bezwzględne (powtórka = ten sam stan), numer nadania nadpisuje poprzedni, a OR21/OR24 przy
// „zły stan zamówienia” czytają zamówienie (OR11) i zwracają OK, gdy kanał jest już dalej. Dlatego adapter nie zwraca
// NIEJEDNOZNACZNEGO i nie deklaruje `reference.find`: odszukaniem skutku jest odczyt stanu zamówienia w samej operacji.

export const ZAPIS_WYLACZONY = 'zapis wyłączony na tym koncie'
/** Przedrostek komunikatu, gdy sklep ma wyłączoną częściową akceptację (OR21 ORDER_PARTIAL_ACCEPTANCE_DISABLED). */
export const CZESCIOWA_AKCEPTACJA_WYLACZONA = 'częściowa akceptacja wyłączona w Empiku'

/** Stany po wysyłce: OR24 na takim zamówieniu = już zrobione. */
const PO_WYSYLCE = new Set(['SHIPPED', 'TO_COLLECT', 'RECEIVED', 'CLOSED', 'INCIDENT_OPEN', 'INCIDENT_CLOSED', 'WAITING_REFUND', 'WAITING_REFUND_PAYMENT', 'REFUNDED'])
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const TRACKING_RE = /^[A-Za-z0-9_-]{4,64}$/
const CARRIER_NAME: Record<Carrier, string> = {
  PACZKOMATY: 'InPost Paczkomaty',
  DPD: 'DPD',
  DPD_EMPIK: 'DPD (Salony Empik)',
  INPOST_KURIER: 'InPost Kurier',
  ORLEN_PACZKA: 'Orlen Paczka',
  GLS: 'GLS',
  POCZTA_POLSKA: 'Poczta Polska',
  ALLEGRO: 'Allegro',
  OSOBISTY: 'Odbiór osobisty',
  BRAK: 'Inny',
  BEZ_WYSYLKI: 'Bez wysyłki',
}

/**
 * kody przewoźników z listy Empiku (SH21 `GET /api/shipping/carriers`, odczyt konta EMPIK 20.11.2026).
 * Empik odrzuca OR23 z samą nazwą przewoźnika (`carrier_name`, przewoźnik niezarejestrowany) kodem HTTP 400, więc
 * przewoźnik z tej listy idzie zawsze z `carrier_code`. Salon Empik (DPD_EMPIK) to w SH21 zwykłe DPD. Konto może
 * nadpisać kod polem `kodyPrzewoznikow`; przewoźnik bez kodu (np. odbiór osobisty) idzie z nazwą jak dotąd.
 */
export const EMPIK_KODY_PRZEWOZNIKOW: Readonly<Partial<Record<Carrier, string>>> = {
  PACZKOMATY: 'paczkomatyinpost',
  INPOST_KURIER: 'inpostpaczkakurierska',
  DPD: 'dpd',
  DPD_EMPIK: 'dpd',
  GLS: 'gls',
  ORLEN_PACZKA: 'ORLEN',
  POCZTA_POLSKA: 'pocztex',
}

/** Pole CSV w cudzysłowie (STO01: separator „;”); cudzysłów w treści podwojony. */
const csv = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`

/** Kody przewoźników z konfiguracji konta: JSON obiekt Carrier → kod Empiku; zły JSON = brak kodów (nazwa zamiast). */
export function carrierCodesOf(v: unknown): Partial<Record<Carrier, string>> {
  if (typeof v !== 'string' || !v.trim()) return {}
  try {
    const o = JSON.parse(v) as unknown
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    return Object.fromEntries(
      Object.entries(o as Record<string, unknown>).filter(([k, c]) => Object.hasOwn(CARRIER_NAME, k) && typeof c === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(c)),
    ) as Partial<Record<Carrier, string>>
  } catch {
    return {}
  }
}

/**
 * pkt 3: mapa product_sku → shop_sku z OF21 w pamięci procesu, wspólna dla adapterów jednego konta (host
 * tworzy adapter przy każdym przebiegu wysyłki stanów, a OF21 to pełna lista ofert: przy 1 000 ofert 10 żądań po 2 s).
 * Ważna godzinę; oferta spoza mapy wymusza jedno przeładowanie, a stary shop_sku po zmianie w Empiku
 * wraca jako odrzucony wiersz w wyniku importu (STO02), więc nie przechodzi po cichu.
 */
export const SHOP_SKU_TTL_MS = 3600_000
const shopSkuCache = new Map<string, { at: number; map: Map<string, string | null> }>()

/** Tylko testy: czyści pamięć ofert kont Empiku. */
export function wyczyscPamiecOfertEmpiku(): void {
  shopSkuCache.clear()
}

const IMPORT_REF_RE = /^STO01:([A-Za-z0-9_-]{1,64})$/

/**
 * Kody ofert z raportu błędów STO03 (CSV). Kształt raportu nie jest potwierdzony na koncie Empiku: bierzemy kolumnę
 * „offer-sku” z nagłówka, gdy jest; inaczej tylko liczba wierszy. Treści błędu nie zwracamy (zostaje w Empiku).
 */
export function kodyZRaportuBledow(csvText: string): { wiersze: number; kody: string[] } {
  const rows = csvText.split(/\r?\n/).filter((r) => r.trim())
  if (!rows.length) return { wiersze: 0, kody: [] }
  const sep = rows[0]!.includes(';') ? ';' : ','
  // separator w cudzysłowie (np. treść błędu ze średnikiem) nie przesuwa kolumn
  const cells = (r: string) => {
    const out: string[] = []
    let cur = ''
    let q = false
    for (let i = 0; i < r.length; i++) {
      const ch = r[i]!
      if (q) {
        if (ch === '"' && r[i + 1] === '"') {
          cur += '"'
          i++
        } else if (ch === '"') q = false
        else cur += ch
      } else if (ch === '"') q = true
      else if (ch === sep) {
        out.push(cur.trim())
        cur = ''
      } else cur += ch
    }
    out.push(cur.trim())
    return out
  }
  const head = cells(rows[0]!).map((h) => h.toLowerCase())
  const col = head.indexOf('offer-sku')
  const data = rows.slice(1)
  const kody = col < 0 ? [] : data.map((r) => cells(r)[col] ?? '').filter((k) => /^[A-Za-z0-9_.\/-]{1,100}$/.test(k)).slice(0, 20)
  return { wiersze: data.length, kody }
}

const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)

class MiraklEmpikZapisAdapter extends MiraklEmpikAdapter implements StockWriter, StockImportStatusReader, OrderStatusWriter, OrderAcceptor, TrackingWriter {
  private writerInstance: MiraklWriter | null = null
  /** product_sku (nasza oferta) → shop_sku (offer-sku w STO01), z OF21; budowane przy pierwszym zapisie stanu. */
  private shopSkus: Map<string, string | null> | null = null

  private get enabled(): boolean {
    return this.ctx.config['zapisWlaczony'] === true
  }

  // odstęp z limitu manifestu (30/min = 2 s) daje klasa bazowa, wspólny dla konta (odczyt i zapis)

  /** Tworzony dopiero przy pierwszym zapisie i tylko przy włączonym wyłączniku; ten sam odstęp co odczyt. */
  private get writer(): MiraklWriter {
    this.writerInstance ??= new MiraklWriter(String(this.ctx.config['baseUrl']), this.ctx.secrets['MIRAKL_API_KEY']!, this.ctx.fetch as FetchLike, this.api.throttle)
    return this.writerInstance
  }

  private off(reference: string): WriteOutcome {
    return { kind: 'TRWALY', reference, message: ZAPIS_WYLACZONY }
  }

  /**
   * transport wystawiania (OF01 import ofert, P41 wniosek o produkt) dla lib/oferty/wystawianie.ts. Tylko przy
   * włączonym `wystawianieOfertWlaczone` (niezależnie od `zapisWlaczony`). Brak odpowiedzi = wyjątek (NIEJEDNOZNACZNY).
   */
  async zapisOfert(metoda: 'POST', sciezka: string, cialo: unknown, query?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> | null }> {
    if (!wystawianieOfertWlaczone(this.ctx.config)) throw new ReadOnlyViolation(WYSTAWIANIE_WYLACZONE)
    if (metoda !== 'POST' || !/^\/(offers|products)\/imports$/.test(sciezka) || !(cialo instanceof FormData)) throw new ReadOnlyViolation('Mirakl: wystawianie tylko importem ofert albo produktów')
    // przed wysłaniem: `import_mode` tylko NORMAL (REPLACE kasowałby oferty spoza pliku)
    miraklQueryZapisu(sciezka, query)
    const r = await this.writer.send('POST', sciezka, cialo, query)
    return { status: r.status, body: r.body ?? (r.errorCode ? { errorCode: r.errorCode } : null) }
  }

  /** Jedno żądanie zapisu; błąd sieci/timeout = null (wywołujący wie, czy powtórka jest bezpieczna). */
  private async send(method: 'PUT' | 'POST', path: string, body: Record<string, unknown> | FormData | null): Promise<MiraklWriteResult | null> {
    try {
      return await this.writer.send(method, path, body)
    } catch (e) {
      if (e instanceof SourceError) return null
      throw e
    }
  }

  /** Stan zamówienia z OR11 (po `order_ids`); null = kanał nie zna zamówienia. Błąd odczytu = AdapterError. */
  private async orderState(externalId: string): Promise<string | null> {
    let r: { orders?: unknown }
    try {
      r = await this.api.get('/orders', { order_ids: externalId })
    } catch (e) {
      throw toAdapterError(e)
    }
    if (!Array.isArray(r?.orders)) throw new AdapterError('Mirakl OR11: brak listy orders', 'PRZEJSCIOWY')
    const raw = (r.orders as unknown[]).find((o) => o && typeof o === 'object' && str((o as Record<string, unknown>)['order_id']) === externalId) as Record<string, unknown> | undefined
    return raw ? (str(raw['order_state']) ?? '?') : null
  }

  /** „Zły stan zamówienia” z OR21/OR24: odczyt stanu rozstrzyga, czy kanał jest już dalej (OK), czy to odmowa. */
  private async afterInvalidState(orderExternalId: string, reference: string, what: string, done: (state: string) => boolean): Promise<WriteOutcome> {
    let state: string | null
    try {
      state = await this.orderState(orderExternalId)
    } catch (e) {
      return { kind: e instanceof AdapterError ? e.kind : 'PRZEJSCIOWY', reference, message: `${what}: zły stan zamówienia, odczyt stanu nieudany` }
    }
    if (state && done(state)) return { kind: 'OK', reference, externalRef: state }
    return { kind: 'TRWALY', reference, message: `${what}: Empik odmówił, zamówienie w stanie ${state ?? 'nieznanym'}` }
  }

  /** `brakFunkcji`: 403/404 to brak funkcji na koncie (np. STO01), nie odrzucony klucz: klasa KONFIGURACJA. */
  private static failure(r: MiraklWriteResult, reference: string, what: string, brakFunkcji = false): WriteOutcome {
    // oczyszczony komunikat Empiku w alercie (co odrzucono), bez reszty treści odpowiedzi
    const code = `${r.errorCode ? ` (${r.errorCode})` : ''}${r.errorMessage ? `, Empik: „${r.errorMessage}”` : ''}`
    if (brakFunkcji && (r.status === 403 || r.status === 404)) return { kind: 'TRWALY', reference, message: `${what}: HTTP ${r.status}${code}`, errorClass: 'KONFIGURACJA' }
    if (r.status === 429) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: HTTP 429`, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) }
    // 5xx: powtórka jest bezpieczna (komentarz sekcji), więc PRZEJSCIOWY, nie NIEJEDNOZNACZNY
    if (r.status >= 500) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: HTTP ${r.status}${code}` }
    return { kind: 'TRWALY', reference, message: `${what}: HTTP ${r.status}${code}` }
  }

  // STO01: import samych stanów (CSV), asynchroniczny; wynik przetwarzania Empik podaje później (STO02/STO03).
  async pushStock(items: StockWriteItem[], reference: string): Promise<WriteOutcome> {
    if (!this.enabled) return this.off(reference)
    if (!items.length) return { kind: 'OK', reference }
    const bad = items.filter((it) => !it.offerExternalId || !Number.isInteger(it.qty) || it.qty < 0)
    if (bad.length) return { kind: 'TRWALY', reference, message: `zła pozycja stanu: ${bad.slice(0, 10).map((b) => b.offerExternalId || '?').join(', ')}` }
    let skus: Map<string, string | null>
    try {
      skus = await this.loadShopSkus()
    } catch (e) {
      const ae = toAdapterError(e)
      return { kind: ae instanceof AdapterError ? ae.kind : 'PRZEJSCIOWY', reference, message: `odczyt ofert Empik przed zapisem stanów: ${ae instanceof Error ? ae.message : String(ae)}` }
    }
    // oferta założona w Empiku po zbudowaniu mapy — jedno przeładowanie OF21, dopiero potem „brak”
    if (items.some((it) => !skus.get(it.offerExternalId))) {
      try {
        skus = await this.loadShopSkus(true)
      } catch (e) {
        const ae = toAdapterError(e)
        return { kind: ae instanceof AdapterError ? ae.kind : 'PRZEJSCIOWY', reference, message: `odczyt ofert Empik przed zapisem stanów: ${ae instanceof Error ? ae.message : String(ae)}` }
      }
    }
    const lines: string[] = []
    const unknown: string[] = []
    const warehouse = typeof this.ctx.config['magazynEmpik'] === 'string' ? this.ctx.config['magazynEmpik'] : ''
    for (const it of items) {
      const sku = skus.get(it.offerExternalId)
      if (!sku) unknown.push(it.offerExternalId) // brak oferty albo dwie oferty jednego produktu: bez zgadywania
      else lines.push([csv(sku), csv(it.qty), csv(warehouse), csv('update')].join(';'))
    }
    if (!lines.length) return { kind: 'TRWALY', reference, message: `brak oferty w Empiku dla: ${unknown.slice(0, 20).join(', ')}` }
    const form = new FormData()
    const body = ['"offer-sku";"quantity";"warehouse-code";"update-delete"', ...lines].join('\n') + '\n'
    form.append('file', new Blob([body], { type: 'text/csv' }), `stany-${reference.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}.csv`)
    const r = await this.send('POST', '/offers/stock/imports', form)
    // brak odpowiedzi: stany bezwzględne, powtórka da ten sam wynik
    if (!r) return { kind: 'PRZEJSCIOWY', reference, message: 'import stanów Empik (STO01): brak odpowiedzi' }
    if (r.status === 201 || r.status === 200) {
      const id = r.body?.['import_id']
      const ref = typeof id === 'string' || typeof id === 'number' ? `STO01:${id}` : null
      if (!unknown.length) return { kind: 'OK', reference, ...(ref ? { externalRef: ref } : {}) }
      // wysłana część przeszła; nieudane tylko w failedItems (kontrakt), host oznacza
      // pozostałe pozycje jako wysłane i alarmuje per pozycja, nie per paczka
      return {
        kind: 'TRWALY',
        reference,
        message: `${unknown.length} z ${items.length} pozycji nieudanych (brak jednej oferty w Empiku): ${unknown.slice(0, 20).join(', ')}${unknown.length > 20 ? ', …' : ''}${ref ? `; reszta wysłana (${ref})` : ''}`,
        failedItems: unknown.map((offerExternalId) => ({ offerExternalId, kind: 'TRWALY' as const, message: 'brak jednej oferty w Empiku' })),
        ...(ref ? { externalRef: ref } : {}),
      }
    }
    // 403/404: konto bez STO01 (portal Empiku wymienia tylko OF01/02/03/21/22/24) — do włączenia po stronie Empiku
    return MiraklEmpikZapisAdapter.failure(r, reference, r.status === 403 || r.status === 404 ? 'import stanów Empik (STO01) niedostępny na tym koncie' : 'import stanów Empik (STO01)', true)
  }

  private get cacheKey(): string {
    // firma i konto w kluczu: dwie firmy z tym samym kontem Empiku (np. test) nie dzielą mapy
    return `${this.ctx.integration.organizationId}|${this.ctx.integration.id}|${miraklAccountKey(String(this.ctx.config['baseUrl']), this.ctx.secrets['MIRAKL_API_KEY']!)}`
  }

  private async loadShopSkus(force = false): Promise<Map<string, string | null>> {
    if (this.shopSkus && !force) return this.shopSkus
    const now = this.ctx.now().getTime()
    const hit = force ? undefined : shopSkuCache.get(this.cacheKey)
    if (hit && now - hit.at < SHOP_SKU_TTL_MS) return (this.shopSkus = hit.map)
    const map = new Map<string, string | null>()
    let cursor: string | null = null
    for (let page = 0; page < 1000; page++) {
      const p: OfferPageWithProblems = await this.listOffers(cursor)
      for (const o of p.items) map.set(o.externalId, map.has(o.externalId) ? null : o.sku) // dwie oferty jednego produktu = null
      if (!p.nextCursor) break
      cursor = p.nextCursor
    }
    this.shopSkus = map
    shopSkuCache.set(this.cacheKey, { at: now, map })
    return map
  }

  // STO02 (+ STO03 przy odrzuconych wierszach): tylko GET, bez wyłącznika zapisu (odczyt wyniku już wysłanego importu).
  async getStockImportStatus(externalRef: string): Promise<StockImportStatus> {
    const m = IMPORT_REF_RE.exec(externalRef)
    if (!m) throw new AdapterError(`zły identyfikator importu stanów Empik „${externalRef.slice(0, 80)}”`, 'TRWALY')
    const id = m[1]!
    let r: Record<string, unknown>
    try {
      r = await this.api.get(`/offers/stock/imports/${id}/status`)
    } catch (e) {
      // 401/403/404 przy odczycie wyniku to „wynik niedostępny”, nie „import odrzucony”
      if (e instanceof SourceError && !e.retryable && (e.httpStatus === 401 || e.httpStatus === 403 || e.httpStatus === 404)) {
        return { state: 'NIEDOSTEPNY', powod: e.httpStatus === 401 ? 'KLUCZ' : 'BRAK_DOSTEPU', message: `Mirakl STO02: HTTP ${e.httpStatus}` }
      }
      throw toAdapterError(e)
    }
    const status = str(r?.['status'])?.toUpperCase() ?? ''
    if (status === 'FAILED') return { state: 'NIEUDANE', message: 'Empik nie przetworzył pliku stanów (import odrzucony w całości)' }
    // WAITING, RUNNING i stany nieznane: host czyta dalej, do limitu czasu (developer.mirakl.com STO02, odczyt 08.11.2026)
    if (status !== 'COMPLETE') return { state: 'W_TOKU' }
    const przyjete = intOrNull(r['lines_in_success'])
    let odrzucone = intOrNull(r['lines_in_error'])
    let kody: string[] = []
    if ((odrzucone ?? 0) > 0 || r['has_error_report'] === true) {
      try {
        const rap = kodyZRaportuBledow(await this.api.getText(`/offers/stock/imports/${id}/error_report`))
        kody = rap.kody
        if (odrzucone === null) odrzucone = rap.wiersze
      } catch {
        // raport błędów niedostępny: zostaje liczba z STO02 (szczegóły w panelu Empiku)
      }
    }
    return { state: 'GOTOWE', przyjete, odrzucone: odrzucone ?? 0, kodyOdrzuconych: kody }
  }

  // OR21: decyzja dla wszystkich pozycji. Zamówienie już poza WAITING_ACCEPTANCE = OK (rozstrzygnięte wcześniej).
  async acceptOrder(orderExternalId: string, decisions: readonly OrderAcceptDecision[], reference: string): Promise<WriteOutcome> {
    if (!this.enabled) return this.off(reference)
    if (!ID_RE.test(orderExternalId)) return { kind: 'TRWALY', reference, message: 'zły numer zamówienia Empik' }
    const ids = decisions.map((d) => d.externalLineId)
    if (!decisions.length || new Set(ids).size !== ids.length || ids.some((i) => !ID_RE.test(i))) return { kind: 'TRWALY', reference, message: `zamówienie ${orderExternalId}: zła lista decyzji o pozycjach` }
    const what = `przyjęcie zamówienia ${orderExternalId} (OR21)`
    const r = await this.send('PUT', `/orders/${orderExternalId}/accept`, { order_lines: decisions.map((d) => ({ id: d.externalLineId, accepted: d.accepted })) })
    if (!r) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: brak odpowiedzi (powtórka bezpieczna: sprawdza stan zamówienia)` }
    if (r.status >= 200 && r.status < 300) return { kind: 'OK', reference }
    if (r.errorCode === 'ORDER_PARTIAL_ACCEPTANCE_DISABLED') return { kind: 'TRWALY', reference, message: `${CZESCIOWA_AKCEPTACJA_WYLACZONA}: ${what}` }
    if (r.errorCode === 'ORDER_INVALID_STATE' || r.status === 409) {
      const out = await this.afterInvalidState(orderExternalId, reference, what, (s) => s !== 'WAITING_ACCEPTANCE' && s !== 'STAGING')
      // stan kanału zostaje w wyniku (anulowane w Empiku to nie „przyjęte”)
      return out.kind === 'OK' ? { kind: 'OK', reference, externalRef: `${ACCEPT_ALREADY_DECIDED}:${out.externalRef ?? '?'}` } : out
    }
    return MiraklEmpikZapisAdapter.failure(r, reference, what)
  }

  // OR24: jedyny status, który Kompletor ustawia w Empiku (resztę Empik prowadzi sam).
  async setOrderStatus(orderExternalId: string, channelStatus: string, reference: string): Promise<WriteOutcome> {
    if (!this.enabled) return this.off(reference)
    if (!ID_RE.test(orderExternalId)) return { kind: 'TRWALY', reference, message: 'zły numer zamówienia Empik' }
    // bez wielkości liter — mapa zapisana z panelu przed poprawką ma „shipped”
    if (channelStatus.trim().toUpperCase() !== 'SHIPPED') return { kind: 'TRWALY', reference, message: `Empik: Kompletor ustawia tylko status SHIPPED (wysłane), nie „${channelStatus.slice(0, 40)}”` }
    const what = `wysłanie zamówienia ${orderExternalId} (OR24)`
    const r = await this.send('PUT', `/orders/${orderExternalId}/ship`, null)
    if (!r) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: brak odpowiedzi (powtórka bezpieczna: sprawdza stan zamówienia)` }
    if (r.status >= 200 && r.status < 300) return { kind: 'OK', reference }
    if (r.errorCode === 'ORDER_INVALID_STATE' || r.status === 409) return this.afterInvalidState(orderExternalId, reference, what, (s) => PO_WYSYLCE.has(s))
    return MiraklEmpikZapisAdapter.failure(r, reference, what)
  }

  // OR23: numer nadania nadpisuje poprzedni, więc powtórka jest bezpieczna.
  // Typ z kontraktu (TrackingInfo): `carrier` to enum Carrier albo nazwa; spoza CARRIER_NAME (także „BRAK” od hosta) = TRWALY.
  async setTracking(orderExternalId: string, tracking: TrackingInfo, reference: string): Promise<WriteOutcome> {
    if (!this.enabled) return this.off(reference)
    if (!ID_RE.test(orderExternalId)) return { kind: 'TRWALY', reference, message: 'zły numer zamówienia Empik' }
    if (!TRACKING_RE.test(tracking.number)) return { kind: 'TRWALY', reference, message: `zamówienie ${orderExternalId}: zły numer nadania` }
    if (!Object.hasOwn(CARRIER_NAME, tracking.carrier)) return { kind: 'TRWALY', reference, message: `zamówienie ${orderExternalId}: nieznany przewoźnik` }
    const carrier = tracking.carrier as Carrier
    const code = carrierCodesOf(this.ctx.config['kodyPrzewoznikow'])[carrier] ?? EMPIK_KODY_PRZEWOZNIKOW[carrier]
    let body: Record<string, unknown>
    if (code) body = { carrier_code: code, tracking_number: tracking.number }
    else {
      const url = tracking.url ?? null
      if (url !== null && !/^https:\/\/[^\s"<>]{1,500}$/i.test(url)) return { kind: 'TRWALY', reference, message: `zamówienie ${orderExternalId}: zły adres śledzenia` }
      body = { carrier_name: CARRIER_NAME[carrier], tracking_number: tracking.number, ...(url ? { carrier_url: url } : {}) }
    }
    const what = `numer nadania zamówienia ${orderExternalId} (OR23)`
    const r = await this.send('PUT', `/orders/${orderExternalId}/tracking`, body)
    if (!r) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: brak odpowiedzi` }
    if (r.status >= 200 && r.status < 300) return { kind: 'OK', reference }
    return MiraklEmpikZapisAdapter.failure(r, reference, what)
  }
}

export const MIRAKL_EMPIK_DEFINITION: AdapterDefinition = { manifest: MIRAKL_EMPIK_MANIFEST, create: (ctx) => new MiraklEmpikAdapter(ctx) }
export const MIRAKL_EMPIK_ZAPIS_DEFINITION: AdapterDefinition = { manifest: MIRAKL_EMPIK_ZAPIS_MANIFEST, create: (ctx) => new MiraklEmpikZapisAdapter(ctx, MIRAKL_EMPIK_ZAPIS_MANIFEST) }
