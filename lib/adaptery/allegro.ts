// Adapter Allegro `allegro.v1`: dziennik zamówień przez dziennik zdarzeń `GET /order/events`, tylko odczyt.
// Kompletor ma własną parę tokenów z osobnej autoryzacji device flow (`npm run cien -- allegro-autoryzuj`) w tej samej
// aplikacji Allegro co inne narzędzia firmy — nigdy nie dostaje ani nie odświeża cudzych tokenów (refresh token jest
// jednorazowy). Tokeny wyłącznie w zaszyfrowanych sekretach konta, nigdy z env.
//
// Dziennik: kursor = ostatni przetworzony eventId (+ faza). Pierwszy odczyt: NAJPIERW `GET /order/event-stats`
// (ostatnie zdarzenie = przyszły kursor), DOPIERO potem lista `GET /order/checkout-forms` od `teraz − lookback` — każda
// zmiana w trakcie listy ma zdarzenie po zapamiętanym, więc między listą a dziennikiem nie ma dziury. Zdarzenia bywają
// podwójne i poza kolejnością: id formularza deduplikowane na stronie, pełne zamówienie zawsze z
// `GET /order/checkout-forms/{id}` (host woła getOrder), rewizja = `updatedAt`. Retencja dziennika 60 dni: kursor
// starszy albo odrzucony przez API → lista zapasowa od ostatniego udanego odczytu i ostrzeżenie (nigdy cicha luka).
//
// Mapowanie: BOUGHT, FILLED_IN (przed płatnością) i READY_FOR_PROCESSING → OPEN (rezerwuje od zakupu, także
// nieopłacone); CANCELLED → CANCELLED; `fulfillment.status` SENT, PICKED_UP (i RETURNED) → FULFILLED, CANCELLED →
// CANCELLED; nieznany status = ostrzeżenie i stan nieterminalny. Dane kupującego (`buyer`, adresy, e-mail, telefon,
// login, wiadomość do sprzedającego) nie są czytane w dzienniku — nie wychodzą z allegroOrderFromApi. Odbiorcę czyta
// osobna zdolność `orders.recipient` (`allegroRecipientFromApi`) tym samym GET formularza, na żądanie hosta.
// Scalanie płatności (nowy formularz z tymi samymi `lineItem.id`) rozstrzyga host: lib/cien/odczyt-zamowien.ts.
import { createHash } from 'node:crypto'
import type { PaymentState } from '@prisma/client'
import { ReadOnlyViolation, SourceError, type FetchLike } from '../zrodla/http'
import {
  ALLEGRO_API_URL,
  ALLEGRO_API_URL_RE,
  ALLEGRO_AUTH_URL,
  ALLEGRO_AUTH_URL_RE,
  ALLEGRO_OFFERS_READ_SCOPE,
  ALLEGRO_ORDERS_READ_SCOPE,
  ALLEGRO_USER_AGENT_RE,
  AllegroOAuthError,
  type AllegroOAuthClient,
  allegroEanOfertyZApi,
  AllegroReadOnly,
  type AllegroResponse,
  ODCZYT_OFERT_ALLEGRO_RE,
  refreshAllegroToken,
} from '../zrodla/allegro'
import {
  AdapterError,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type ChannelAdapter,
  type ChannelOrder,
  type ChannelOrderLine,
  type ConnectionTest,
  type OrderFeed,
  type ChannelReturn,
  type ChannelReturnLine,
  type ReturnPage,
  type ReturnReader,
  type OrderFeedItem,
  type OrderFeedOptions,
  type OrderFeedPage,
  type OrderLifecycle,
  type OrderRecipient,
  joinName,
  missingAddressProblems,
  type ChannelOfferRow,
  type OfferPageWithProblems,
  type OfferEan,
  type OfferEanReader,
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
  type RecipientProblem,
  type RecipientReader,
  UnreadableDataError,
} from './kontrakt'
import { AdapterConfigError } from './rejestr'

export const ALLEGRO_SECRETS = {
  clientId: 'ALLEGRO_CLIENT_ID',
  clientSecret: 'ALLEGRO_CLIENT_SECRET',
  access: 'ALLEGRO_ACCESS_TOKEN',
  refresh: 'ALLEGRO_REFRESH_TOKEN',
  expiresAt: 'ALLEGRO_TOKEN_EXPIRES_AT',
  /** Odcisk (SHA-256) refresh tokena odrzuconego przez Allegro — nie próbujemy go drugi raz (bez pętli ponowień). */
  rejected: 'ALLEGRO_REFRESH_REJECTED',
  /** zakres OAuth ostatniej autoryzacji (spacjami, lib/zrodla/allegro-zakresy.ts) — ekran konta i adapter zapisu. */
  scope: 'ALLEGRO_TOKEN_SCOPE',
  /** trwająca autoryzacja z panelu (device flow: kod urządzenia, link, termin), zaszyfrowany JSON; po końcu kasowany. */
  autoryzacja: 'ALLEGRO_AUTORYZACJA',
} as const
const S = ALLEGRO_SECRETS
/**
 * Nazwy rotowane razem; pierwsza (refresh token) to wiersz blokady rotacji.
 * także zakres, bo Allegro zwraca `scope` przy odświeżeniu, a „Kompletor może” na ekranie konta ma odpowiadać stanowi
 * po stronie Allegro, nie temu, o co prosiła ostatnia autoryzacja.
 */
const TOKEN_NAMES = [S.refresh, S.access, S.expiresAt, S.rejected, S.scope] as const

const AUTH_HINT = 'przycisk „Połącz z Allegro” na ekranie konta (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto Allegro)'

export const ALLEGRO_MANIFEST: AdapterManifest = {
  adapterKey: 'allegro.v1',
  version: '1.0.0',
  displayName: 'Allegro (REST, dziennik zdarzeń zamówień)',
  kind: 'channel',
  channel: 'ALLEGRO',
  // `returns.read` = GET /order/customer-returns (zwroty klientów), ten sam zakres co zamówienia [NIEPEWNE]
  capabilities: ['orders.feed', 'orders.recipient', 'offers.read', 'returns.read', 'offers.prepare'],
  // limit Allegro ok. 9000 zapytań/min na Client ID (wspólny z innymi narzędziami firmy) — bierzemy mały ułamek
  rateLimit: { requestsPerMinute: 300, maxConcurrent: 1, minPollIntervalMs: 60_000 },
  config: [
    { key: 'apiUrl', type: 'string', required: false, description: `adres API (domyślnie ${ALLEGRO_API_URL}; sandbox https://api.allegro.pl.allegrosandbox.pl)`, pattern: ALLEGRO_API_URL_RE },
    { key: 'authUrl', type: 'string', required: false, description: `adres autoryzacji (domyślnie ${ALLEGRO_AUTH_URL}; sandbox https://allegro.pl.allegrosandbox.pl)`, pattern: ALLEGRO_AUTH_URL_RE },
    { key: 'userAgent', type: 'string', required: true, description: 'User-Agent „NazwaAplikacji/Wersja (+URL)”', pattern: ALLEGRO_USER_AGENT_RE },
    { key: 'envPrefix', type: 'string', required: false, description: 'self-host: przedrostek zmiennych env konta dla Client ID i Secret (np. ALLEGRO_SD)', pattern: /^[A-Z][A-Z0-9_]{0,40}$/ },
    { key: 'pollIntervalSec', type: 'number', required: false, description: 'co ile sekund czytać zamówienia (≥ 60, domyślnie 60)' },
  ],
  secrets: [
    { name: S.clientId, required: true, description: 'Client ID aplikacji Allegro', envSuffix: 'CLIENT_ID' },
    { name: S.clientSecret, required: true, description: 'Client Secret aplikacji Allegro', envSuffix: 'CLIENT_SECRET' },
    { name: S.access, required: true, description: `access token konta (${AUTH_HINT})` },
    { name: S.refresh, required: true, description: `refresh token konta (${AUTH_HINT})` },
    { name: S.expiresAt, required: false, description: 'koniec ważności access tokena (ISO; zapisuje autoryzacja i odświeżenie)' },
    { name: S.rejected, required: false, description: 'odcisk refresh tokena odrzuconego przez Allegro (zapisuje adapter)' },
    { name: S.scope, required: false, description: 'zakres przyznany przez Allegro (zapisuje autoryzacja i odświeżenie tokena)' },
    { name: S.autoryzacja, required: false, description: 'trwająca autoryzacja z panelu (zapisuje panel, kasuje po końcu)' },
  ],
  readOnly: true,
}

/** Odśwież, gdy do końca ważności access tokena zostało mniej niż tyle. */
export const REFRESH_BEFORE_MS = 5 * 60_000
/** Retencja dziennika zdarzeń Allegro (60 dni) z zapasem doby: starszy kursor → lista zapasowa. */
export const EVENTS_RETENTION_MS = 59 * 24 * 3600_000
const EVENTS_LIMIT = 1000
const LIST_LIMIT = 100
const LIST_MAX_WINDOW = 10_000 // offset + limit ≤ 10 000
const FALLBACK_OVERLAP_MS = 5 * 60_000

// ─── Mapowanie ───────────────────────────────────────────────────────────────

const STATUS: Record<string, { lifecycle: OrderLifecycle; rank: number | null }> = {
  BOUGHT: { lifecycle: 'OPEN', rank: 1 },
  FILLED_IN: { lifecycle: 'OPEN', rank: 2 },
  READY_FOR_PROCESSING: { lifecycle: 'OPEN', rank: 3 },
  CANCELLED: { lifecycle: 'CANCELLED', rank: null },
}
const FULFILLMENT: Record<string, { lifecycle: OrderLifecycle | null; rank: number | null }> = {
  NEW: { lifecycle: null, rank: 10 },
  PROCESSING: { lifecycle: null, rank: 20 },
  READY_FOR_SHIPMENT: { lifecycle: null, rank: 30 },
  READY_FOR_PICKUP: { lifecycle: null, rank: 35 },
  SENT: { lifecycle: 'FULFILLED', rank: 40 },
  PICKED_UP: { lifecycle: 'FULFILLED', rank: 50 },
  RETURNED: { lifecycle: 'FULFILLED', rank: 60 }, // towar już wyszedł (zwrot to osobny proces)
  SUSPENDED: { lifecycle: null, rank: null },
  CANCELLED: { lifecycle: 'CANCELLED', rank: null },
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/**
 * zwroty klientów z odpowiedzi `/order/customer-returns` → `ChannelReturn` bez danych kupującego. Zwrot bez
 * id, bez numeru zamówienia albo bez poprawnej pozycji trafia do `unreadable` (opis bez danych), reszta strony idzie.
 */
export function allegroReturnsFromApi(rows: unknown[]): { items: ChannelReturn[]; unreadable: string[] } {
  const items: ChannelReturn[] = []
  const unreadable: string[] = []
  for (const raw of rows) {
    const r = obj(raw)
    const id = str(r['id'])
    const orderId = str(r['orderId'])
    if (!id || !/^[A-Za-z0-9-]{1,64}$/.test(id)) {
      unreadable.push('zwrot Allegro bez poprawnego id')
      continue
    }
    if (!orderId || !/^[A-Za-z0-9-]{1,64}$/.test(orderId)) {
      unreadable.push(`zwrot Allegro ${id} bez numeru zamówienia`)
      continue
    }
    const lines: ChannelReturnLine[] = []
    let zla = false
    for (const it of Array.isArray(r['items']) ? (r['items'] as unknown[]) : []) {
      const i = obj(it)
      const offerId = str(i['offerId'])
      const qty = Number(i['quantity'])
      if (!offerId || !Number.isInteger(qty) || qty <= 0) {
        zla = true
        continue
      }
      lines.push({ offerId, qty, reasonType: str(obj(i['reason'])['type']) })
    }
    if (!lines.length || zla) {
      unreadable.push(`zwrot Allegro ${id}: pozycja bez oferty albo z niepoprawną ilością`)
      continue
    }
    const at = str(r['createdAt'])
    items.push({ externalId: id, orderExternalId: orderId, createdAt: at && !Number.isNaN(Date.parse(at)) ? new Date(at) : null, status: str(r['status']), lines })
  }
  return { items, unreadable }
}
const round2 = (n: number) => Math.round(n * 100) / 100

function paymentOf(raw: Record<string, unknown>, total: number, id: string): { state: PaymentState; method: string } {
  const p = obj(raw['payment'])
  const type = str(p['type'])
  const provider = str(p['provider'])
  const method = type ? `${type}${provider ? ` (${provider})` : ''}` : '(brak)'
  if (type === 'CASH_ON_DELIVERY') return { state: 'COD', method }
  const paidRaw = obj(p['paidAmount'])['amount']
  const paidOnly = paidRaw === undefined || paidRaw === null ? null : readNumber(paidRaw, `kwota wpłaty zamówienia ${id}`)
  if (paidOnly === null) return { state: str(p['finishedAt']) ? 'PAID' : 'UNPAID', method }
  // wyrównanie (portfel, Allegro Monet) liczy się do zapłaty obok paidAmount
  const recRaw = obj(p['reconciliation'])['amount']
  const paid = paidOnly + (recRaw === undefined || recRaw === null ? 0 : readNumber(recRaw, `kwota wyrównania zamówienia ${id}`))
  if (paid <= 0) return { state: 'UNPAID', method }
  return { state: paid + 0.005 >= total ? 'PAID' : 'PARTIAL', method }
}

function lineOf(l: Record<string, unknown>, i: number, orderId: string, warnings: string[]): ChannelOrderLine {
  const id = str(l['id'])
  if (!id) throw new UnreadableDataError(`pozycja ${i + 1} zamówienia ${orderId} bez id`)
  const qty = readInt(l['quantity'], `ilość pozycji ${id}`)
  if (qty <= 0) throw new UnreadableDataError(`ilość pozycji ${id} ≤ 0`)
  const unit = readNumber(obj(l['price'])['amount'], `cena pozycji ${id}`)
  const offerId = str(obj(l['offer'])['id'])
  if (!offerId) warnings.push(`pozycja ${id}: bez id oferty`)
  const rate = str(obj(l['tax'])['rate'])
  const offer = obj(l['offer'])
  // sygnatura sprzedawcy (offer.external.id) to u większości sprzedawców SKU; EAN-u checkout-form nie podaje
  return { externalLineId: id, offerExternalId: offerId, qty, unitPriceGross: round2(unit), vatRate: rate, ...opisLinii(optText(offer['name']), optText(obj(offer['external'])['id'], 200), null) }
}

/** Formularz zakupu (checkoutForm) → ChannelOrder. Nieczytelne pole = UnreadableDataError (nigdy 0). */
export function allegroOrderFromApi(raw: Record<string, unknown>): ChannelOrder {
  const externalId = str(raw['id'])
  if (!externalId) throw new UnreadableDataError('zamówienie Allegro bez id')
  const status = str(raw['status'])
  if (!status) throw new UnreadableDataError(`zamówienie ${externalId} bez statusu`)
  const warnings: string[] = []
  const known = STATUS[status]
  if (!known) warnings.push(`nieznany status Allegro „${status}” — traktowany jak otwarte, bez kolejności`)
  const fStatus = str(obj(raw['fulfillment'])['status'])
  const f = fStatus ? FULFILLMENT[fStatus] : undefined
  if (fStatus && !f) warnings.push(`nieznany status realizacji Allegro „${fStatus}” — bez kolejności`)
  const linesRaw = raw['lineItems']
  if (!Array.isArray(linesRaw) || !linesRaw.length) throw new UnreadableDataError(`zamówienie ${externalId} bez pozycji`)
  const lines = (linesRaw as Record<string, unknown>[]).map((l, i) => lineOf(obj(l), i, externalId, warnings))
  const bought = (linesRaw as Record<string, unknown>[]).map((l) => str(obj(l)['boughtAt'])).filter((x): x is string => !!x)
  const createdAt = bought.length
    ? new Date(Math.min(...bought.map((b) => readDate(b, `data zakupu ${externalId}`).getTime())))
    : readDate(raw['updatedAt'], `data zmiany ${externalId}`)
  const toPay = obj(obj(raw['summary'])['totalToPay'])
  const totalGross = readNumber(toPay['amount'], `kwota zamówienia ${externalId}`)
  const pay = paymentOf(raw, totalGross, externalId)
  let lifecycle: OrderLifecycle = known?.lifecycle ?? 'OPEN'
  if (lifecycle === 'OPEN' && f?.lifecycle) lifecycle = f.lifecycle
  // kolejność: BOUGHT < FILLED_IN < READY_FOR_PROCESSING (realizacja NEW…PICKED_UP); nieznany = bez kolejności
  const statusRank = !known || known.rank === null ? null : status === 'READY_FOR_PROCESSING' && fStatus ? (f?.rank ?? null) : known.rank
  return {
    externalId,
    number: null,
    revision: readDate(raw['updatedAt'], `data zmiany ${externalId}`).toISOString(),
    createdAt,
    channelStatus: fStatus ? `${status}/${fStatus}` : status,
    statusRank,
    lifecycle,
    paymentState: pay.state,
    paymentMethod: pay.method,
    totalGross,
    currency: str(toPay['currency']) ?? 'PLN',
    deliveryMethod: str(obj(obj(raw['delivery'])['method'])['name']),
    shippingCostGross: optAmount(obj(obj(raw['delivery'])['cost'])['amount']),
    wantInvoiceNip: obj(raw['invoice'])['required'] === true,
    lines,
    warnings,
  }
}

// ─── Odbiorca na żądanie ─────────────────────────────────────────

/**
 * Formularz zakupu → odbiorca. Dostawa z `delivery.address`, e-mail z `buyer.email` (Allegro go maskuje: przekazujemy
 * jak jest), punkt z `delivery.pickupPoint`. Faktura tylko przy `invoice.required`: firma (`company.name`, `taxId`)
 * albo osoba (`naturalPerson`). Allegro daje ulicę z numerem w jednym polu: całość w `ulica`, `adres_bez_podzialu`.
 */
export function allegroRecipientFromApi(raw: Record<string, unknown>): OrderRecipient {
  const problemy: RecipientProblem[] = []
  const delivery = readRecipientObject(raw['delivery'], 'delivery') ?? {}
  const a = readRecipientObject(delivery['address'], 'delivery.address')
  const buyer = readRecipientObject(raw['buyer'], 'buyer') ?? {}
  const email = readRecipientText(buyer['email'], 'buyer.email')
  let dostawa: RecipientAddress | null = null
  if (a) {
    const t = (f: string) => readRecipientText(a[f], `delivery.address.${f}`)
    dostawa = {
      imieNazwisko: joinName(t('firstName'), t('lastName')),
      firma: t('companyName'),
      ulica: t('street'),
      numerDomu: null,
      numerLokalu: null,
      kodPocztowy: t('zipCode'),
      miasto: t('city'),
      kraj: t('countryCode'),
      telefon: t('phoneNumber'),
      email,
    }
    if (dostawa.ulica) problemy.push('adres_bez_podzialu')
    problemy.push(...missingAddressProblems(dostawa))
  } else problemy.push('adres_niedostepny_w_kanale')

  const pp = readRecipientObject(delivery['pickupPoint'], 'delivery.pickupPoint')
  const kodPunktu = pp ? readRecipientText(pp['id'], 'delivery.pickupPoint.id') : null
  const ppa = pp ? readRecipientObject(pp['address'], 'delivery.pickupPoint.address') : null
  const adresPunktu = ppa
    ? { ulica: readRecipientText(ppa['street'], 'delivery.pickupPoint.address.street'), kodPocztowy: readRecipientText(ppa['zipCode'], 'delivery.pickupPoint.address.zipCode'), miasto: readRecipientText(ppa['city'], 'delivery.pickupPoint.address.city') }
    : null
  const punktOdbioru = pp && kodPunktu ? { kod: kodPunktu, nazwa: readRecipientText(pp['name'], 'delivery.pickupPoint.name'), adres: adresPunktu } : null
  if (pp && !kodPunktu) problemy.push('punkt_nieznany')

  let faktura: RecipientInvoice | null = null
  const inv = readRecipientObject(raw['invoice'], 'invoice') ?? {}
  const required = inv['required']
  if (required !== undefined && required !== null && typeof required !== 'boolean') throw new UnreadableDataError('nieczytelne pole odbiorcy: invoice.required')
  if (required === true) {
    const ia = readRecipientObject(inv['address'], 'invoice.address') ?? {}
    const t = (f: string) => readRecipientText(ia[f], `invoice.address.${f}`)
    const company = readRecipientObject(ia['company'], 'invoice.address.company')
    const person = readRecipientObject(ia['naturalPerson'], 'invoice.address.naturalPerson')
    const nip = company ? readRecipientText(company['taxId'], 'invoice.address.company.taxId') : null
    const nazwa = company
      ? readRecipientText(company['name'], 'invoice.address.company.name')
      : person
        ? joinName(readRecipientText(person['firstName'], 'invoice.address.naturalPerson.firstName'), readRecipientText(person['lastName'], 'invoice.address.naturalPerson.lastName'))
        : null
    faktura = { nazwa, nip, ulica: t('street'), kodPocztowy: t('zipCode'), miasto: t('city'), kraj: t('countryCode') }
    if (company && !nip) problemy.push('brak_nip')
  }
  const login = readRecipientText(buyer['login'], 'buyer.login')
  const uwagi = readRecipientText(raw['messageToSeller'], 'messageToSeller')
  return { dostawa, punktOdbioru, faktura, problemy, login, uwagi }
}

// ─── Kursor ──────────────────────────────────────────────────────────────────

/**
 * Kursor (nieprzezroczysty dla hosta): faza L = lista formularzy (pierwszy odczyt albo zapasowy), E = dziennik.
 * `e` = ostatni przetworzony eventId (w fazie L: z event-stats, od niego ruszy dziennik); `t` = ostatni udany odczyt
 * dziennika (granica retencji i początek listy zapasowej).
 */
interface AllegroCursor {
  v: 1
  p: 'L' | 'E'
  e: string | null
  t: string
  a?: string // L: updatedAt.gte
  o?: number // L: offset
  m?: string // L: najpóźniejszy widziany updatedAt
}

export function parseAllegroCursor(c: string): AllegroCursor {
  try {
    const x = JSON.parse(c) as AllegroCursor
    const okDate = (d: unknown) => typeof d === 'string' && !Number.isNaN(Date.parse(d))
    const base = x && x.v === 1 && (x.e === null || typeof x.e === 'string') && okDate(x.t)
    if (base && x.p === 'E') return x
    if (base && x.p === 'L' && okDate(x.a) && okDate(x.m) && Number.isInteger(x.o) && x.o! >= 0) return x
  } catch {
    // niżej
  }
  throw new AdapterError('zły kursor Allegro — po sprawdzeniu wyzeruj kursor konta (ChannelCursor.cursor = NULL); powtórka odczytu jest bezpieczna', 'TRWALY')
}

const fingerprint = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32)

/**
 * Błąd całego konta (token, zakres, Client ID), także zgłoszony przy pojedynczym zamówieniu: host przerywa odczyt,
 * nie liczy próby elementu i daje alert konta od razu (lib/cien/odczyt-zamowien.ts).
 */
export class AllegroAccountError extends AdapterConfigError {
  constructor(message: string) {
    super(message)
    this.name = 'AllegroAccountError'
  }
}

/** Refresh token odrzucony (wygasł po 3 miesiącach, unieważniony, wylogowanie): potrzebna ponowna autoryzacja. */
export class AllegroReauthorizationError extends AllegroAccountError {
  constructor(channelAccountId: string | undefined) {
    // Administrator bez panelu: `npm run cien -- allegro-autoryzuj --konto <id>` (ten sam przebieg co przycisk).
    const konto = channelAccountId ? ` (konto ${channelAccountId})` : ''
    super(`Allegro wymaga ponownego połączenia konta${konto}: zgoda wygasła albo została cofnięta. Kliknij „Połącz ponownie z Allegro” w Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto Allegro`)
    this.name = 'AllegroReauthorizationError'
  }
}

// ─── Tokeny ──────────────────────────────────────────────────────────────────

/** Wewnętrzne: refresh token odrzucony przez Allegro (odcisk do znacznika). */
class RejectedRefresh extends Error {
  constructor(readonly fingerprint: string) {
    super('refresh token odrzucony')
  }
}

/**
 * Para tokenów konta w pamięci adaptera. Odświeżenie: przy 401 albo < 5 min do końca ważności; najwyżej jedno naraz
 * w procesie (wspólna obietnica), między procesami — blokada hosta (`rotateSecrets`, lib/adaptery/rotacja-sekretow.ts).
 * Nowa para wraca dopiero po zapisie w bazie, więc nowy access token nigdy nie idzie do Allegro przed zapisem.
 */
export class AllegroTokens {
  access: string
  private refresh: string
  private expiresAt: Date | null
  private rejected: string | null
  private inflight: Promise<void> | null = null

  constructor(
    private readonly ctx: AdapterContext,
    private readonly oauth: AllegroOAuthClient,
  ) {
    this.access = ctx.secrets[S.access]!
    this.refresh = ctx.secrets[S.refresh]!
    const e = ctx.secrets[S.expiresAt]
    this.expiresAt = e && !Number.isNaN(Date.parse(e)) ? new Date(e) : null
    this.rejected = ctx.secrets[S.rejected] ?? null
  }

  /** Access token do użycia teraz (odświeżony, gdy wygasa). */
  async current(): Promise<{ token: string; refreshed: boolean }> {
    const refreshed = !!this.expiresAt && this.expiresAt.getTime() - this.ctx.now().getTime() < REFRESH_BEFORE_MS
    if (refreshed) await this.refreshOnce(this.access)
    return { token: this.access, refreshed }
  }

  /** Po 401 z tokenem `used`: odśwież (chyba że w międzyczasie już odświeżony). */
  async afterUnauthorized(used: string): Promise<string> {
    await this.refreshOnce(used)
    return this.access
  }

  private refreshOnce(stale: string): Promise<void> {
    if (this.access !== stale) return Promise.resolve()
    this.inflight ??= this.doRefresh(stale).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private reauth(): AllegroReauthorizationError {
    return new AllegroReauthorizationError(this.ctx.integration.channelAccountId)
  }

  /** Wymiana refresh tokena na nową parę (POST /auth/oauth/token); odrzucony = znacznik + błąd ponownej autoryzacji. */
  private async exchange(current: Readonly<Record<string, string>>): Promise<Record<string, string>> {
    const rt = current[S.refresh]
    if (!rt) throw this.reauth()
    if (current[S.rejected] && current[S.rejected] === fingerprint(rt)) throw this.reauth()
    try {
      const t = await refreshAllegroToken(this.oauth, rt)
      // zakres tylko, gdy Allegro go zwróciło (pusty sekret jest błędem zapisu; brak = zostaje poprzedni)
      return { [S.access]: t.accessToken, [S.refresh]: t.refreshToken, [S.expiresAt]: t.expiresAt.toISOString(), ...(t.scope ? { [S.scope]: t.scope } : {}) }
    } catch (e) {
      if (!(e instanceof AllegroOAuthError)) throw e
      if (e.code === 'invalid_grant' || e.code === 'invalid_token') throw new RejectedRefresh(fingerprint(rt))
      if (e.code === 'invalid_client') throw new AdapterError('Allegro odrzuciło Client ID albo Client Secret konta (odświeżenie tokena)', 'TRWALY')
      throw new AdapterError(`odświeżenie tokena Allegro: ${e.message}`, e.retryable ? 'PRZEJSCIOWY' : 'TRWALY')
    }
  }

  private async doRefresh(stale: string): Promise<void> {
    if (this.rejected && this.rejected === fingerprint(this.refresh)) throw this.reauth()
    try {
      await this.rotate(stale)
    } catch (e) {
      // trwały błąd odświeżenia (złe Client ID, brak sekretu) dotyczy konta, nie zamówienia
      if (e instanceof AdapterError && e.kind === 'TRWALY') throw new AllegroAccountError(e.message)
      if (!(e instanceof RejectedRefresh)) throw e
      // znacznik zapisany PO zwolnieniu blokady rotacji (osobne połączenie z puli nie czeka na nasze własne):
      // kolejne odczyty nie próbują już tym samym tokenem, aż autoryzacja zapisze nową parę.
      // Nieudany zapis znacznika kosztuje tylko jedną próbę odświeżenia na przebieg; alert konta i tak idzie z hosta.
      this.rejected = e.fingerprint
      await this.ctx.persistSecrets?.({ [S.rejected]: e.fingerprint }).catch(() => undefined)
      throw this.reauth()
    }
  }

  private async rotate(stale: string): Promise<void> {
    let fresh: Record<string, string>
    if (this.ctx.rotateSecrets) {
      fresh = await this.ctx.rotateSecrets({ names: TOKEN_NAMES, stale: { name: S.access, value: stale }, refresh: (cur) => this.exchange(cur) })
    } else if (this.ctx.persistSecrets) {
      // host bez blokady (testy, narzędzia): zapis przed użyciem, jedna ponowna próba w oknie 60 s starego tokena
      fresh = await this.exchange({ [S.refresh]: this.refresh, ...(this.rejected ? { [S.rejected]: this.rejected } : {}) })
      try {
        await this.ctx.persistSecrets(fresh)
      } catch {
        try {
          await this.ctx.persistSecrets(fresh)
        } catch {
          throw new AdapterError('nowa para tokenów Allegro nie zapisana (dwie próby) — nie używamy jej', 'PRZEJSCIOWY')
        }
      }
    } else throw new AdapterError('host nie zapisuje odświeżonych tokenów Allegro (brak persistSecrets)', 'TRWALY')
    const access = fresh[S.access]
    const refresh = fresh[S.refresh]
    if (!access || !refresh) throw this.reauth()
    this.access = access
    this.refresh = refresh
    const e = fresh[S.expiresAt]
    this.expiresAt = e && !Number.isNaN(Date.parse(e)) ? new Date(e) : null
    this.rejected = fresh[S.rejected] ?? this.rejected
  }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export function toAdapterError(e: unknown): unknown {
  if (e instanceof SourceError) return new AdapterError(e.message, e.retryable ? 'PRZEJSCIOWY' : 'TRWALY')
  return e
}

/** eksport dla wersji z zapisem (`allegro.zapis.v1`, lib/adaptery/allegro-zapis.ts), która ją rozszerza. */
export class AllegroAdapter implements ChannelAdapter, OrderFeed, RecipientReader, OfferReader, OfferEanReader, ReturnReader {
  readonly manifest: AdapterManifest
  protected readonly api: AllegroReadOnly
  protected readonly tokens: AllegroTokens

  constructor(
    protected readonly ctx: AdapterContext,
    manifest: AdapterManifest = ALLEGRO_MANIFEST,
  ) {
    this.manifest = manifest
    const userAgent = String(ctx.config['userAgent'])
    this.api = new AllegroReadOnly(String(ctx.config['apiUrl'] ?? ALLEGRO_API_URL), userAgent, ctx.fetch as FetchLike, ctx.http?.minIntervalMs, ctx.http?.retry)
    this.tokens = new AllegroTokens(ctx, {
      authUrl: String(ctx.config['authUrl'] ?? ALLEGRO_AUTH_URL),
      clientId: ctx.secrets[S.clientId]!,
      clientSecret: ctx.secrets[S.clientSecret]!,
      userAgent,
      fetch: ctx.fetch as FetchLike,
      now: ctx.now,
    })
  }

  /**
   * GET z tokenem: 401 → jedno odświeżenie na wywołanie (także gdy token odświeżono tuż przed żądaniem) i jedna
   * powtórka; 401 po odświeżeniu i 403 = błąd konta; 429 z rodzajem; reszta do wołającego.
   */
  protected async call<T>(path: string, query: [string, string][]): Promise<AllegroResponse<T>> {
    const get = async (token: string) => {
      try {
        return await this.api.get<T>(path, query, token)
      } catch (e) {
        throw toAdapterError(e)
      }
    }
    const { token: used, refreshed } = await this.tokens.current()
    let r = await get(used)
    if (r.status === 401 && !refreshed) r = await get(await this.tokens.afterUnauthorized(used))
    if (r.status === 401) throw new AllegroAccountError(`Allegro ${path}: HTTP 401 także po odświeżeniu tokena — konto wymaga sprawdzenia autoryzacji`)
    if (r.status === 429) throw new AdapterError(`Allegro ${path}: HTTP 429 (limit zapytań)`, 'PRZEJSCIOWY', r.retryAfterMs ?? 60_000)
    if (r.status === 403) {
      // lista ofert wymaga osobnego zakresu — komunikat mówi, jak go dodać (autoryzacja z --z-ofertami)
      const scope = path.startsWith('/sale/') ? `${ALLEGRO_OFFERS_READ_SCOPE}; „Połącz ponownie z Allegro” z zaznaczonym „Odczyt ofert” na ekranie konta` : ALLEGRO_ORDERS_READ_SCOPE
      throw new AllegroAccountError(`Allegro ${path}: HTTP 403 — token bez wymaganego zakresu (${scope}) albo bez dostępu do zasobu`)
    }
    return r
  }

  /**
   * publiczny odczyt do ofertowania (podgląd oferty i sprawdzenie dubla przed wystawieniem). Ten sam GET
   * z tokenem konta co `call`, ale tylko ścieżki z `ODCZYT_OFERT_ALLEGRO_RE`; inna ścieżka = błąd przed wysłaniem.
   */
  odczytDoOfert<T>(path: string, query: [string, string][]): Promise<AllegroResponse<T>> {
    if (!ODCZYT_OFERT_ALLEGRO_RE.test(path)) return Promise.reject(new ReadOnlyViolation(`Allegro: odczyt do ofert poza dozwolonymi ścieżkami (${path.slice(0, 60)})`))
    return this.call<T>(path, query)
  }

  protected expectBody<T>(r: AllegroResponse<T>, path: string): T {
    if (r.status < 200 || r.status >= 300) throw new AdapterError(`Allegro ${path}: HTTP ${r.status}`, 'TRWALY')
    if (r.body === null || typeof r.body !== 'object') throw new AdapterError(`Allegro ${path}: pusta odpowiedź`, 'PRZEJSCIOWY')
    return r.body
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const b = this.expectBody(await this.call<{ latestEvent?: unknown }>('/order/event-stats', []), '/order/event-stats')
      const at = str(obj(b.latestEvent)['occurredAt'])
      return { ok: true, message: 'odczyt zamówień (dziennik zdarzeń) działa', details: { latestEventAt: at } }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  async listOrderChanges(cursor: string | null, opts: OrderFeedOptions): Promise<OrderFeedPage> {
    const now = this.ctx.now()
    if (cursor === null) return this.startList(new Date(now.getTime() - opts.initialLookbackMs), now, [])
    const cur = parseAllegroCursor(cursor)
    if (cur.p === 'L') return this.listPage(cur, [])
    const fallback = (why: string) => {
      const from = new Date(Date.parse(cur.t) - FALLBACK_OVERLAP_MS)
      return this.startList(from, now, [`dziennik zdarzeń Allegro: ${why} — odczyt zapasowy listą zamówień od ${from.toISOString()} (ostatni udany odczyt)`])
    }
    if (now.getTime() - Date.parse(cur.t) > EVENTS_RETENTION_MS) return fallback('ostatni odczyt starszy niż retencja dziennika (60 dni)')
    const path = '/order/events'
    const r = await this.call<{ events?: unknown }>(path, [...(cur.e ? [['from', cur.e] as [string, string]] : []), ['limit', String(EVENTS_LIMIT)]])
    if (cur.e && (r.status === 400 || r.status === 404 || r.status === 422)) return fallback(`kursor ${cur.e} odrzucony (HTTP ${r.status})`)
    const body = this.expectBody(r, path)
    if (!Array.isArray(body.events)) throw new AdapterError('Allegro /order/events: brak listy events', 'PRZEJSCIOWY')
    const items = new Map<string, OrderFeedItem>()
    let last = cur.e
    for (const ev of body.events as unknown[]) {
      const e = obj(ev)
      const id = str(e['id'])
      if (id) last = id
      const formId = str(obj(obj(e['order'])['checkoutForm'])['id'])
      if (!formId) continue
      // zdarzenia podwójne: jedno pobranie formularza na stronę, na pozycji ostatniego zdarzenia
      items.delete(formId)
      items.set(formId, { externalId: formId, revision: str(e['occurredAt']) ?? '' })
    }
    const next: AllegroCursor = { v: 1, p: 'E', e: last, t: now.toISOString() }
    return { items: [...items.values()], nextCursor: JSON.stringify(next), hasMore: body.events.length >= EVENTS_LIMIT }
  }

  /** Początek listy (pierwszy odczyt albo zapasowy): NAJPIERW ostatnie zdarzenie dziennika, potem pierwsza strona. */
  private async startList(from: Date, now: Date, warnings: string[]): Promise<OrderFeedPage> {
    const stats = this.expectBody(await this.call<{ latestEvent?: unknown }>('/order/event-stats', []), '/order/event-stats')
    const latest = str(obj(stats.latestEvent)['id'])
    const a = from.toISOString()
    return this.listPage({ v: 1, p: 'L', e: latest, t: now.toISOString(), a, o: 0, m: a }, warnings)
  }

  private async listPage(cur: AllegroCursor, warnings: string[]): Promise<OrderFeedPage> {
    const path = '/order/checkout-forms'
    const offset = cur.o ?? 0
    const r = await this.call<{ checkoutForms?: unknown; totalCount?: unknown }>(path, [
      ['updatedAt.gte', cur.a!],
      ['sort', 'updatedAt'],
      ['limit', String(LIST_LIMIT)],
      ['offset', String(offset)],
    ])
    const body = this.expectBody(r, path)
    if (!Array.isArray(body.checkoutForms)) throw new AdapterError('Allegro /order/checkout-forms: brak listy', 'PRZEJSCIOWY')
    const forms = body.checkoutForms as unknown[]
    const total = typeof body.totalCount === 'number' && Number.isInteger(body.totalCount) ? body.totalCount : null
    const items: OrderFeedItem[] = []
    let maxSeen = cur.m!
    for (const f of forms) {
      const raw = obj(f)
      const id = str(raw['id'])
      if (!id) continue
      const upd = str(raw['updatedAt'])
      if (upd && !Number.isNaN(Date.parse(upd)) && new Date(upd).toISOString() > maxSeen) maxSeen = new Date(upd).toISOString()
      try {
        const order = allegroOrderFromApi(raw)
        items.push({ externalId: id, revision: order.revision, order })
      } catch {
        items.push({ externalId: id, revision: '' }) // host pobierze osobno (getOrder) i zapisze błąd elementu
      }
    }
    const nextOffset = offset + forms.length
    const more = forms.length === LIST_LIMIT && (total === null || nextOffset < total)
    const out = (next: AllegroCursor, hasMore: boolean): OrderFeedPage => ({ items, nextCursor: JSON.stringify(next), hasMore, ...(warnings.length ? { warnings } : {}) })
    if (more) {
      if (nextOffset + LIST_LIMIT <= LIST_MAX_WINDOW) return out({ ...cur, o: nextOffset, m: maxSeen }, true)
      // limit offset + limit ≤ 10 000: dalej od najpóźniejszego widzianego updatedAt (powtórki odsiewa host)
      if (maxSeen <= cur.a!) throw new AdapterError('Allegro /order/checkout-forms: ponad 10 000 zamówień z tą samą datą zmiany', 'TRWALY')
      return out({ ...cur, a: maxSeen, o: 0, m: maxSeen }, true)
    }
    // event-stats bez ostatniego zdarzenia przy niepustej liście: dziennik ruszy od początku retencji (kosztownie, bez szkody)
    if (!cur.e && nextOffset > 0) warnings.push(`Allegro nie podało ostatniego zdarzenia (event-stats) przy niepustej liście od ${cur.a} — dziennik ruszy od najstarszych zachowanych zdarzeń`)
    // lista skończona: dalej dziennik od zdarzenia zapamiętanego PRZED listą (w tym samym odczycie)
    return out({ v: 1, p: 'E', e: cur.e, t: cur.t }, true)
  }

  // zwroty klientów `GET /order/customer-returns` (filtr `createdAt.gte`, limit 100, offset). Tylko id zwrotu,
  // numer zamówienia, status i pozycje (oferta, ilość, typ powodu): dane kupującego, komentarz i numery paczek pomijamy.
  async listCustomerReturns(from: Date, cursor: string | null): Promise<ReturnPage> {
    const offset = cursor === null ? 0 : Number(cursor)
    if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new AdapterError('zły kursor zwrotów Allegro', 'TRWALY')
    const path = '/order/customer-returns'
    const limit = 100
    const body = this.expectBody(await this.call<{ customerReturns?: unknown; count?: unknown }>(path, [['createdAt.gte', from.toISOString()], ['limit', String(limit)], ['offset', String(offset)]]), path)
    if (!Array.isArray(body.customerReturns)) throw new AdapterError('Allegro /order/customer-returns: brak listy', 'PRZEJSCIOWY')
    const page = allegroReturnsFromApi(body.customerReturns as unknown[])
    const next = body.customerReturns.length === limit && offset + limit < 10_000 ? String(offset + limit) : null
    return { ...page, nextCursor: next }
  }

  /**
   * etap 2: strona listy formularzy zakupu do archiwum zamówień (tylko `GET /order/checkout-forms`, z filtrem
   * daty zakupu i stronicowaniem; inny parametr = błąd przed wysłaniem). Allegro nie ma listy pól: odpowiedź zawiera
   * dane kupującego, więc importer archiwum od razu ją przycina do listy dozwolonych pól (lib/archiwum/kanaly.ts).
   */
  async odczytListyZamowienArchiwum(query: [string, string][]): Promise<{ checkoutForms: unknown[]; totalCount: number | null }> {
    if (query.some(([k]) => !/^(lineItems\.boughtAt\.(gte|lte)|sort|limit|offset)$/.test(k)))
      throw new ReadOnlyViolation('Allegro: lista zamówień do archiwum tylko z filtrem daty zakupu i stronicowaniem')
    const path = '/order/checkout-forms'
    const body = this.expectBody(await this.call<{ checkoutForms?: unknown; totalCount?: unknown }>(path, query), path)
    if (!Array.isArray(body.checkoutForms)) throw new AdapterError('Allegro /order/checkout-forms: brak listy', 'PRZEJSCIOWY')
    return { checkoutForms: body.checkoutForms as unknown[], totalCount: typeof body.totalCount === 'number' && Number.isInteger(body.totalCount) ? body.totalCount : null }
  }

  async getOrder(externalId: string): Promise<ChannelOrder | null> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(externalId)) throw new AdapterError(`zły numer formularza Allegro „${externalId}”`, 'TRWALY')
    const path = `/order/checkout-forms/${externalId}`
    const r = await this.call<Record<string, unknown>>(path, [])
    if (r.status === 404) return null
    return allegroOrderFromApi(this.expectBody(r, '/order/checkout-forms/{id}'))
  }

  async getOrderRecipient(externalId: string): Promise<OrderRecipient> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(externalId)) throw new AdapterError('zły numer formularza Allegro', 'TRWALY')
    const r = await this.call<Record<string, unknown>>(`/order/checkout-forms/${externalId}`, [])
    if (r.status === 404) throw new AdapterError(`Allegro: formularza ${externalId} nie ma w kanale`, 'TRWALY')
    return allegroRecipientFromApi(this.expectBody(r, '/order/checkout-forms/{id}'))
  }

  // oferty konta `GET /sale/offers` (limit 1000, offset), tylko GET. Kursor = offset (tekst). Oferta = id
  // oferty (jak lineItem.offer.id w zamówieniu), SKU = `external.id` (sygnatura sprzedającego).
  // [NIEPEWNE] SKU z `external.id`: tak opisuje to dokumentacja Allegro, ale sygnaturę wpisuje sprzedawca i nie każdy
  // trzyma w niej kod towaru; oferta bez sygnatury idzie na listę „Do przypisania”. [NIEPEWNE] Token z autoryzacji
  // device flow z samym zakresem `allegro:api:orders:read` nie ma prawa do /sale/offers (potrzebny
  // `allegro:api:sale:offers:read`) — wtedy pobranie kończy się błędem 403 z czytelnym komunikatem, a nie pustą listą.
  // zakres dokłada autoryzacja `allegro-autoryzuj --z-ofertami` (scripts/allegro-autoryzacja.ts).
  async listOffers(cursor: string | null): Promise<OfferPageWithProblems> {
    const offset = cursor === null ? 0 : Number(cursor)
    if (!Number.isInteger(offset) || offset < 0 || offset > 10_000_000) throw new AdapterError('zły kursor ofert Allegro', 'TRWALY')
    const limit = 1000
    const body = this.expectBody(await this.call<{ offers?: unknown; totalCount?: unknown }>('/sale/offers', [['limit', String(limit)], ['offset', String(offset)]]), '/sale/offers')
    if (!Array.isArray(body.offers)) throw new AdapterError('Allegro /sale/offers: brak listy offers', 'PRZEJSCIOWY')
    const items: ChannelOfferRow[] = []
    const unreadable: OfferReadProblem[] = []
    for (const raw of body.offers as unknown[]) {
      const o = obj(raw)
      const id = str(o['id'])
      if (!id) {
        unreadable.push({ externalId: '?', message: 'oferta Allegro bez id' })
        continue
      }
      try {
        const stock = obj(o['stock'])
        items.push({
          externalId: id,
          sku: str(obj(o['external'])['id']),
          ean: null, // lista ofert nie podaje EAN: host dociąga go przez `getOfferEan`
          name: str(o['name']),
          qty: stock['available'] === null ? null : readInt(stock['available'], `stan oferty ${id}`),
          active: str(obj(o['publication'])['status']) === 'ACTIVE',
          // cena sprzedaży Allegro jest brutto (PLN); stawki VAT lista ofert nie podaje
          priceGross: allegroPrice(obj(obj(o['sellingMode'])['price'])),
          vatRate: null,
          imageUrls: [str(obj(o['primaryImage'])['url'])].filter((u): u is string => !!u && u.startsWith('https://')),
        })
      } catch (e) {
        if (!(e instanceof UnreadableDataError)) throw e
        unreadable.push({ externalId: id, message: e.message })
      }
    }
    const total = typeof body.totalCount === 'number' && Number.isInteger(body.totalCount) ? body.totalCount : null
    const next = offset + body.offers.length
    const more = body.offers.length > 0 && (total !== null ? next < total : body.offers.length === limit)
    return { items, nextCursor: more ? String(next) : null, unreadable }
  }

  // EAN oferty z jej szczegółów `GET /sale/product-offers/{offerId}` (ten sam zakres co lista ofert,
  // `allegro:api:sale:offers:read`; tylko GET). GTIN leży w parametrach produktu oferty (id 225693). Jedno wywołanie
  // na ofertę; które oferty odpytać i ile na przebieg, decyduje host (lib/kanaly/oferty.ts).
  async getOfferEan(offerExternalId: string): Promise<OfferEan> {
    if (!/^\d{1,20}$/.test(offerExternalId)) throw new AdapterError(`zły numer oferty Allegro „${offerExternalId.slice(0, 40)}”`, 'TRWALY')
    const path = `/sale/product-offers/${offerExternalId}`
    const r = await this.call<Record<string, unknown>>(path, [])
    if (r.status === 404) return { ean: null, powod: 'oferty nie ma już w Allegro' }
    return allegroEanOfertyZApi(this.expectBody(r, '/sale/product-offers/{id}'))
  }
}

function allegroPrice(p: Record<string, unknown>): number | null {
  const a = typeof p['amount'] === 'string' ? p['amount'] : ''
  if ((p['currency'] ?? 'PLN') !== 'PLN' || !/^\d{1,9}(\.\d{1,2})?$/.test(a)) return null
  return Number(a)
}

export const ALLEGRO_DEFINITION: AdapterDefinition = { manifest: ALLEGRO_MANIFEST, create: (ctx) => new AllegroAdapter(ctx) }
