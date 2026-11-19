// Trasy obsługi klienta (zakres `obsluga:odczyt`, klucz tylko z tym zakresem) dla chatbota obsługi sklepu:
//   POST /api/v1/obsluga/zamowienia-klienta  { email | telefon, konta?, limit? }  → 200 { zamowienia }
//   POST /api/v1/obsluga/zamowienie          { numer, email | telefon, konta? }  → 200 { zamowienia } albo 404
// E-mail i telefon w treści żądania (nie w adresie: logi proxy, historia), dopasowanie dokładne po skrócie HMAC
// znormalizowanej wartości (lib/klienci/obsluga.ts). Odpowiedź budowana pole po polu z jawnej listy
// (OBSLUGA_ORDER_FIELDS): bez adresu, imienia, e-maila, telefonu, NIP-u, flag, notatek i treści zdarzeń.
//
// Ochrona przed wyliczaniem: osobny limit na klucz (30/min i 600/h, w pamięci procesu jak reszta API), stały kształt
// odpowiedzi, błąd wejścia bez echa wartości, „brak numeru” i „kontakt nie pasuje” = ta sama ścieżka i ten sam 404.
import type { Carrier, Channel, OrderStatus, PaymentState, Prisma, PrismaClient } from '@prisma/client'
import { SlidingLimiter } from '@/lib/auth/limiter'
import { kontaktObslugi, MAX_TRAFIEN_OBSLUGI, type KontaktObslugi, type KontoObslugi } from '@/lib/klienci/obsluga'
import { STATUS_LABEL } from '@/lib/panel/format'
import { wybierzStatusFirmy } from '@/lib/panel/statusy'
import { statusyFirmy } from '@/lib/panel/statusy-firmy-dane'
import { readJsonBody } from './zapis'
import { ApiInputError, apiError } from './odpowiedzi'
import { CHANNELS, money, ORDER_STATUSES, shipmentsOf, trackingNumbers, type ShipmentOut } from './zamowienia'

export const OBSLUGA_PER_MINUTE = 30
export const OBSLUGA_PER_HOUR = 600
export const OBSLUGA_MAX_BODY = 4 * 1024
export const OBSLUGA_DEFAULT_LIMIT = 10
export const MAX_KONT = 20
export const MAX_HISTORIA = 30
export const MAX_FAKTUR = 5

export const OBSLUGA_ORDER_FIELDS = [
  'kanal',
  'konto',
  'numer',
  'numerWidoczny',
  'numerBl',
  'zlozono',
  'zmieniono',
  'status',
  'statusNazwa',
  'statusDlaKlienta',
  'historia',
  'platnosc',
  'platnoscMetoda',
  'sumaBrutto',
  'przewoznik',
  'sposobDostawy',
  'numerNadania',
  'pozycje',
  'przesylki',
  'faktury',
] as const
export const OBSLUGA_LINE_FIELDS = ['nazwa', 'ilosc'] as const
export const HISTORIA_FIELDS = ['status', 'statusNazwa', 'kiedy'] as const
export const FAKTURA_FIELDS = ['numer', 'wystawiono'] as const

export interface HistoriaOut {
  status: OrderStatus
  statusNazwa: string
  kiedy: string
}

export interface FakturaOut {
  numer: string
  /** data wystawienia (ISO 8601) albo null, gdy program jej nie podał */
  wystawiono: string | null
}

export interface ObslugaOrderOut {
  kanal: Channel
  konto: string
  numer: string
  /** numer, który klient widzi w mailu sklepu (numer kanału albo numer sklepu, gdy kanał nie ma osobnego) */
  numerWidoczny: string
  numerBl: number | null
  zlozono: string
  zmieniono: string
  status: OrderStatus
  statusNazwa: string
  /** nazwa dla klienta ze statusów firmy (Ustawienia → Statusy), null = firma jej nie ustawiła */
  statusDlaKlienta: string | null
  historia: HistoriaOut[]
  platnosc: PaymentState
  platnoscMetoda: string
  sumaBrutto: number
  przewoznik: Carrier | null
  sposobDostawy: string | null
  numerNadania: string | null
  pozycje: { nazwa: string | null; ilosc: number }[]
  przesylki: ShipmentOut[]
  faktury: FakturaOut[]
}

// ─── Limity ─────────────────────────────────────────────────────────────────

class ObslugaLimiters {
  readonly perMinute = new SlidingLimiter(OBSLUGA_PER_MINUTE, 60_000)
  readonly perHour = new SlidingLimiter(OBSLUGA_PER_HOUR, 3600_000)
}
let limiters = new ObslugaLimiters()

/** Tylko testy: liczniki od zera. */
export function resetObslugaLimiters(): void {
  limiters = new ObslugaLimiters()
}

/** Limit tras obsługi na klucz: null = można, inaczej gotowa odpowiedź 429. Liczy każde żądanie z ważnym kluczem. */
export function obslugaLimit(keyId: string, now = Date.now()): Response | null {
  if (!limiters.perMinute.hit(keyId, now)) return apiError(429, 'Za dużo zapytań o klientów, spróbuj później', { ponowZaSekund: 60 }, { 'Retry-After': '60' })
  if (!limiters.perHour.hit(keyId, now)) return apiError(429, 'Za dużo zapytań o klientów w tej godzinie, spróbuj później', { ponowZaSekund: 600 }, { 'Retry-After': '600' })
  return null
}

// ─── Wejście ────────────────────────────────────────────────────────────────

export interface ObslugaWejscie {
  kontakt: KontaktObslugi
  numer?: string
  konta?: KontoObslugi[]
  limit: number
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function parseKonta(v: unknown): KontoObslugi[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || !v.length || v.length > MAX_KONT) throw new ApiInputError(`konta: lista 1–${MAX_KONT} obiektów { kanal?, konto }`, 'konta')
  return v.map((k, i) => {
    const f = `konta[${i}]`
    if (!isObj(k)) throw new ApiInputError(`${f}: obiekt { kanal?, konto }`, f)
    for (const x of Object.keys(k)) if (x !== 'kanal' && x !== 'konto') throw new ApiInputError(`Nieznane pole ${f}.${x.slice(0, 40)}`, `${f}.${x.slice(0, 40)}`)
    if (typeof k.konto !== 'string' || !k.konto.trim() || k.konto.length > 100) throw new ApiInputError(`${f}.konto: niepusty tekst do 100 znaków`, `${f}.konto`)
    if (k.kanal !== undefined && (typeof k.kanal !== 'string' || !CHANNELS.includes(k.kanal as Channel))) throw new ApiInputError(`${f}.kanal: jeden z ${CHANNELS.join(', ')}`, `${f}.kanal`)
    return { konto: k.konto.trim(), ...(k.kanal ? { kanal: k.kanal as Channel } : {}) }
  })
}

/** Treść żądania (już sparsowany JSON). Błędy bez wartości z żądania (e-mail, telefon, numer nie wracają w odpowiedzi). */
export function parseObslugaWejscie(body: unknown, trasa: 'zamowienia-klienta' | 'zamowienie'): ObslugaWejscie {
  if (!isObj(body)) throw new ApiInputError('Treść: obiekt JSON')
  const allowed = new Set(trasa === 'zamowienie' ? ['numer', 'email', 'telefon', 'konta'] : ['email', 'telefon', 'konta', 'limit'])
  for (const k of Object.keys(body)) if (!allowed.has(k)) throw new ApiInputError(`Nieznane pole ${k.slice(0, 40)}`, k.slice(0, 40))
  const hasEmail = body.email !== undefined
  const hasPhone = body.telefon !== undefined
  if (hasEmail === hasPhone) throw new ApiInputError('Podaj dokładnie jedno z pól: email albo telefon', hasEmail ? 'telefon' : 'email')
  const rodzaj = hasEmail ? 'email' : 'telefon'
  const raw = body[rodzaj]
  const kontakt = typeof raw === 'string' && raw.length <= 254 ? kontaktObslugi(rodzaj, raw) : null
  if (!kontakt) throw new ApiInputError(rodzaj === 'email' ? 'email: pełny adres e-mail' : 'telefon: numer 9–15 cyfr (z kierunkowym albo bez)', rodzaj)
  let numer: string | undefined
  if (trasa === 'zamowienie') {
    const n = body.numer
    const s = typeof n === 'number' && Number.isInteger(n) && n > 0 ? String(n) : typeof n === 'string' ? n.trim() : ''
    if (!s || s.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._/#-]*$/.test(s)) throw new ApiInputError('numer: numer zamówienia (litery, cyfry, . _ / # -, do 100 znaków)', 'numer')
    numer = s
  }
  let limit = trasa === 'zamowienie' ? MAX_TRAFIEN_OBSLUGI : OBSLUGA_DEFAULT_LIMIT
  if (body.limit !== undefined) {
    if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > MAX_TRAFIEN_OBSLUGI) throw new ApiInputError(`limit: liczba całkowita 1–${MAX_TRAFIEN_OBSLUGI}`, 'limit')
    limit = body.limit
  }
  return { kontakt, ...(numer ? { numer } : {}), konta: parseKonta(body.konta), limit }
}

export async function readObslugaBody(req: Request): Promise<unknown> {
  return readJsonBody(req, OBSLUGA_MAX_BODY)
}

// ─── Odpowiedź ──────────────────────────────────────────────────────────────

const SELECT = {
  id: true,
  channel: true,
  channelAccountId: true,
  externalId: true,
  channelNumber: true,
  blOrderId: true,
  status: true,
  companyStatus: true,
  carrier: true,
  deliveryMethod: true,
  paymentState: true,
  paymentMethod: true,
  totalGross: true,
  createdAtChannel: true,
  updatedAt: true,
  lines: {
    where: { removed: false },
    select: { productId: true, qty: true, channelName: true },
    orderBy: [{ createdAt: 'asc' }, { externalLineId: 'asc' }],
  },
} satisfies Prisma.OrderSelect

const STATUS_SET: ReadonlySet<string> = new Set(ORDER_STATUSES)
const isStatus = (v: unknown): v is OrderStatus => typeof v === 'string' && STATUS_SET.has(v)

/**
 * Historia statusów z przejść zapisanych w zdarzeniach zamówienia (`data.z` → `data.na`, lib/rdzen/przejscia.ts) i
 * anulowań; z bazy wychodzą tylko te dwa pola i czas, bez autora i reszty treści. Pierwszy wpis = status sprzed
 * pierwszego przejścia z czasem złożenia (zamówienie bez przejścia statusu i bez anulowania: obecny status, także gdy
 * ma inne zdarzenia z tekstowymi `z`/`na`, np. zmianę przewoźnika albo zamianę produktu). Kolejne takie same statusy zlane w
 * jeden; najwyżej MAX_HISTORIA ostatnich.
 */
export async function historiaStatusow(db: PrismaClient, orders: { id: string; createdAtChannel: Date; status: OrderStatus }[]): Promise<Map<string, HistoriaOut[]>> {
  const out = new Map<string, HistoriaOut[]>()
  if (!orders.length) return out
  const rows = await db.$queryRaw<{ orderId: string; kind: string; z: string | null; na: string | null; createdAt: Date }[]>`
    SELECT "orderId", kind,
      CASE WHEN jsonb_typeof(data->'z') = 'string' THEN data->>'z' END AS z,
      CASE WHEN jsonb_typeof(data->'na') = 'string' THEN data->>'na' END AS na,
      "createdAt"
    FROM "OrderEvent"
    WHERE "orderId" = ANY(${orders.map((o) => o.id)}::text[])
      AND (kind = 'ANULOWANE' OR (jsonb_typeof(data->'z') = 'string' AND jsonb_typeof(data->'na') = 'string'))
    ORDER BY "orderId", "createdAt", id`
  const byOrder = new Map<string, typeof rows>()
  for (const r of rows) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r])
  for (const o of orders) {
    const lista: HistoriaOut[] = []
    const dodaj = (s: OrderStatus, kiedy: Date) => {
      if (lista.at(-1)?.status === s) return
      lista.push({ status: s, statusNazwa: STATUS_LABEL[s], kiedy: kiedy.toISOString() })
    }
    const zdarzenia = byOrder.get(o.id) ?? []
    const pierwsze = zdarzenia.find((r) => isStatus(r.z) && isStatus(r.na))
    const anulowanie = zdarzenia.some((r) => r.kind === 'ANULOWANE' && r.z === null)
    // status z chwili złożenia: sprzed pierwszego przejścia; bez przejścia i bez anulowania = obecny (nie zmieniał się)
    if (pierwsze && isStatus(pierwsze.z)) dodaj(pierwsze.z, o.createdAtChannel)
    else if (!anulowanie) dodaj(o.status, o.createdAtChannel)
    for (const r of zdarzenia) {
      if (isStatus(r.z) && isStatus(r.na) && r.z !== r.na) dodaj(r.na, r.createdAt)
      else if (r.kind === 'ANULOWANE' && r.z === null) dodaj('ANULOWANE', r.createdAt)
    }
    out.set(o.id, lista.slice(-MAX_HISTORIA))
  }
  return out
}

/** Numery wystawionych faktur zamówienia (program księgowy i KSeF), bez korekt; najnowsze pierwsze. */
export async function fakturyZamowien(db: PrismaClient, orderIds: string[]): Promise<Map<string, FakturaOut[]>> {
  const out = new Map<string, FakturaOut[]>()
  if (!orderIds.length) return out
  const [wf, ksef] = await Promise.all([
    db.invoiceAttempt.findMany({ where: { orderId: { in: orderIds }, state: 'ISSUED', number: { not: null } }, select: { orderId: true, number: true, updatedAt: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] }),
    db.ksefInvoiceDraft.findMany({
      where: { orderId: { in: orderIds }, rodzaj: 'VAT', numer: { not: null }, status: { in: ['PRZYJETA', 'POZA_KSEF'] } },
      select: { orderId: true, numer: true, dataWystawienia: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    }),
  ])
  const add = (orderId: string, f: FakturaOut) => {
    const l = out.get(orderId) ?? []
    if (l.length < MAX_FAKTUR && !l.some((x) => x.numer === f.numer)) l.push(f)
    out.set(orderId, l)
  }
  for (const k of ksef) {
    const d = k.dataWystawienia && /^\d{4}-\d{2}-\d{2}/.test(k.dataWystawienia) ? k.dataWystawienia.slice(0, 10) : null
    add(k.orderId, { numer: k.numer!.slice(0, 60), wystawiono: d })
  }
  for (const a of wf) add(a.orderId, { numer: a.number!.slice(0, 60), wystawiono: a.updatedAt.toISOString().slice(0, 10) })
  return out
}

/** Zamówienia o tych id (już zawężonych do kontaktu) w kształcie obsługi, w podanej kolejności. */
export async function zamowieniaObslugi(db: PrismaClient, orderIds: string[]): Promise<ObslugaOrderOut[]> {
  if (!orderIds.length) return []
  const rows = await db.order.findMany({ where: { id: { in: orderIds } }, select: SELECT })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const ordered = orderIds.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => !!r)
  const productIds = [...new Set(ordered.flatMap((r) => r.lines.map((l) => l.productId)).filter((x): x is string => !!x))]
  const ids = ordered.map((r) => r.id)
  const [products, tracking, shipments, historia, faktury, sf] = await Promise.all([
    productIds.length ? db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, title: true } }) : Promise.resolve([]),
    trackingNumbers(db, ids),
    shipmentsOf(db, ids),
    historiaStatusow(db, ordered),
    fakturyZamowien(db, ids),
    statusyFirmy(db),
  ])
  const tytuly = new Map(products.map((p) => [p.id, p.title]))
  return ordered.map((r) => {
    const firmy = wybierzStatusFirmy(sf.statusy, { status: r.status, carrier: r.carrier, companyStatus: r.companyStatus })
    // allowlista: każde pole wypisane jawnie, kolejność jak w OBSLUGA_ORDER_FIELDS
    const out: ObslugaOrderOut = {
      kanal: r.channel,
      konto: r.channelAccountId,
      numer: r.externalId,
      numerWidoczny: r.channelNumber?.trim() || r.externalId,
      numerBl: r.blOrderId,
      zlozono: r.createdAtChannel.toISOString(),
      zmieniono: r.updatedAt.toISOString(),
      status: r.status,
      statusNazwa: STATUS_LABEL[r.status],
      statusDlaKlienta: firmy?.customerName?.trim() || null,
      historia: historia.get(r.id) ?? [],
      platnosc: r.paymentState,
      platnoscMetoda: r.paymentMethod,
      sumaBrutto: money(r.totalGross),
      przewoznik: r.carrier,
      sposobDostawy: r.deliveryMethod,
      numerNadania: tracking.get(r.id) ?? null,
      pozycje: r.lines.map((l) => ({ nazwa: (l.productId ? tytuly.get(l.productId) : undefined) ?? l.channelName?.slice(0, 200) ?? null, ilosc: l.qty })),
      przesylki: shipments.get(r.id) ?? [],
      faktury: faktury.get(r.id) ?? [],
    }
    return out
  })
}
