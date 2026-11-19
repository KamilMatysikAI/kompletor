// POST /api/v1/zamowienia (zakres `zamowienia:zapis`): zamówienie EasyTools z fizycznym dodatkiem (Zestaw
// startowy, Przykładowe lampy). Tylko kanał EASYTOOLS i tylko produkty z katalogu firmy: SKU albo id produktu.
// E-book (DIGITAL) nigdy nie trafia do logistyki = 422.
//
// Schemat ścisły: nieznane pole = 400. Pola adresowe i kontaktowe są odrzucane osobnym komunikatem — Kompletor nie
// przechowuje adresów ani danych kontaktowych (adres wysyłki EasyTools: warunek przepięcia w docs/api.md).
// Wejście do rdzenia wyłącznie przez `ingestOrder` (source „api”): idempotencja po `eventKey` zależnym od treści, więc
// powtórzony POST to DUPLIKAT z tym samym zamówieniem (200). Ten sam numer z inną treścią = 409 z id i statusem
// istniejącego zamówienia, bez żadnej zmiany (przeglądu: klucz z zewnątrz nie edytuje pozycji ani płatności
// zamówienia, które może być już w pakowaniu; zmiany robi obsługa w panelu). Sprawdzenie w transakcji ingestOrder pod
// blokadą zamówienia (Ctx.onlyNew), więc dwa równoległe POST-y z różną treścią nie dadzą cichej edycji.
import { createHash } from 'node:crypto'
import type { PaymentState, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { ingestOrder, OrderExistsError, type IncomingLine, type IncomingOrder, type IngestOutcome } from '@/lib/rdzen/zamowienia'
import { ApiInputError } from './odpowiedzi'

export const MAX_BODY_BYTES = 64 * 1024
export const MAX_LINES = 100
export const API_SOURCE = 'api'

export const PAYMENTS: PaymentState[] = ['PAID', 'UNPAID', 'COD']
const TOP_FIELDS = new Set(['numer', 'zlozono', 'platnosc', 'platnoscMetoda', 'sumaBrutto', 'sposobDostawy', 'chceFakture', 'pozycje'])
export const LINE_FIELDS = new Set(['sku', 'produktId', 'ilosc', 'cenaBrutto', 'vat'])
const PERSONAL_FIELDS = new Set([
  'email',
  'e-mail',
  'mail',
  'telefon',
  'phone',
  'imie',
  'imię',
  'nazwisko',
  'adres',
  'address',
  'ulica',
  'miasto',
  'kod',
  'kodpocztowy',
  'nip',
  'firma',
  'odbiorca',
  'klient',
  'kupujacy',
  'name',
  'fullname',
])

/** Pole wygląda na dane osobowe (adres, kontakt) — odrzucamy je z osobnym komunikatem. */
export function isPersonalField(k: string): boolean {
  const n = k.toLowerCase().replace(/[\s_-]/g, '')
  return PERSONAL_FIELDS.has(k.toLowerCase()) || PERSONAL_FIELDS.has(n) || /^(delivery|invoice)[_-]?/i.test(k) || /(email|phone|telefon|adres|address)/i.test(n)
}

const PERSONAL_MSG = (field: string) =>
  `Pole ${field} odrzucone: API nie przyjmuje adresów ani danych kontaktowych klientów (Kompletor bierze je z kanału sprzedaży i trzyma zaszyfrowane). Wyślij tylko numer, płatność, sposób dostawy i pozycje.`

export interface EasyToolsLineIn {
  sku?: string
  produktId?: string
  ilosc: number
  cenaBrutto: number
  vat?: string
}

export interface EasyToolsOrderIn {
  numer: string
  zlozono: Date
  platnosc: PaymentState
  platnoscMetoda: string
  sumaBrutto: number
  sposobDostawy: string
  chceFakture: boolean
  pozycje: EasyToolsLineIn[]
}

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function checkFields(o: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const k of Object.keys(o)) {
    const field = where ? `${where}.${k}` : k
    if (isPersonalField(k)) throw new ApiInputError(PERSONAL_MSG(field), field)
    if (!allowed.has(k)) throw new ApiInputError(`Nieznane pole ${field}`, field)
  }
}

export function str(o: Record<string, unknown>, k: string, field: string, max: number, opts: { re?: RegExp; optional?: boolean } = {}): string | undefined {
  const v = o[k]
  if (v === undefined && opts.optional) return undefined
  if (typeof v !== 'string' || !v.trim()) throw new ApiInputError(`${field}: wymagany niepusty tekst`, field)
  const s = v.trim()
  if (s.length > max) throw new ApiInputError(`${field}: najwyżej ${max} znaków`, field)
  if (opts.re && !opts.re.test(s)) throw new ApiInputError(`${field}: niedozwolone znaki`, field)
  return s
}

export function amount(o: Record<string, unknown>, k: string, field: string): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1_000_000) throw new ApiInputError(`${field}: kwota brutto jako liczba od 0`, field)
  if (Math.abs(Math.round(v * 100) - v * 100) > 1e-6) throw new ApiInputError(`${field}: najwyżej 2 miejsca po przecinku`, field)
  return Math.round(v * 100) / 100
}

/** Ścisła walidacja treści (już sparsowanego JSON-a). Błąd = ApiInputError (400). */
export function parseEasyToolsOrder(body: unknown): EasyToolsOrderIn {
  if (!isObj(body)) throw new ApiInputError('Treść: obiekt JSON z polami zamówienia')
  checkFields(body, TOP_FIELDS, '')
  const numer = str(body, 'numer', 'numer', 64, { re: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/ })!
  const zRaw = str(body, 'zlozono', 'zlozono', 40, { re: /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/ })!
  const zlozono = new Date(zRaw)
  if (Number.isNaN(zlozono.getTime())) throw new ApiInputError('zlozono: data ISO 8601 ze strefą, np. 2026-11-02T10:15:00Z', 'zlozono')
  const platnosc = body.platnosc
  if (typeof platnosc !== 'string' || !PAYMENTS.includes(platnosc as PaymentState)) throw new ApiInputError(`platnosc: jedno z ${PAYMENTS.join(', ')}`, 'platnosc')
  const platnoscMetoda = str(body, 'platnoscMetoda', 'platnoscMetoda', 100)!
  const sumaBrutto = amount(body, 'sumaBrutto', 'sumaBrutto')
  const sposobDostawy = str(body, 'sposobDostawy', 'sposobDostawy', 200)!
  if (body.chceFakture !== undefined && typeof body.chceFakture !== 'boolean') throw new ApiInputError('chceFakture: true albo false', 'chceFakture')
  const chceFakture = body.chceFakture === true
  const raw = body.pozycje
  if (!Array.isArray(raw) || !raw.length) throw new ApiInputError('pozycje: niepusta lista', 'pozycje')
  if (raw.length > MAX_LINES) throw new ApiInputError(`pozycje: najwyżej ${MAX_LINES}`, 'pozycje')
  const pozycje = parseLines(raw)
  return { numer, zlozono, platnosc: platnosc as PaymentState, platnoscMetoda, sumaBrutto, sposobDostawy, chceFakture, pozycje }
}

/** Pozycje: `sku` albo `produktId`, ilość całkowita, cena brutto za sztukę, opcjonalnie stawka VAT (też kształt ogólny). */
export function parseLines(raw: unknown[]): EasyToolsLineIn[] {
  return raw.map((l, i): EasyToolsLineIn => {
    const w = `pozycje[${i}]`
    if (!isObj(l)) throw new ApiInputError(`${w}: obiekt`, w)
    checkFields(l, LINE_FIELDS, w)
    const sku = str(l, 'sku', `${w}.sku`, 100, { optional: true })
    const produktId = str(l, 'produktId', `${w}.produktId`, 64, { optional: true, re: /^[A-Za-z0-9_-]+$/ })
    if (!sku === !produktId) throw new ApiInputError(`${w}: podaj sku albo produktId (jedno z nich)`, w)
    const ilosc = l.ilosc
    if (typeof ilosc !== 'number' || !Number.isInteger(ilosc) || ilosc < 1 || ilosc > 10_000) throw new ApiInputError(`${w}.ilosc: liczba całkowita od 1`, `${w}.ilosc`)
    const cenaBrutto = amount(l, 'cenaBrutto', `${w}.cenaBrutto`)
    let vat: string | undefined
    if (l.vat !== undefined) {
      vat = typeof l.vat === 'number' ? String(l.vat) : typeof l.vat === 'string' ? l.vat.trim() : ''
      if (!/^(\d{1,2}|zw|np|oo)$/i.test(vat)) throw new ApiInputError(`${w}.vat: stawka, np. "23", "8", "5", "0" albo "zw"`, `${w}.vat`)
    }
    return { ...(sku ? { sku } : {}), ...(produktId ? { produktId } : {}), ilosc, cenaBrutto, ...(vat ? { vat } : {}) }
  })
}

/**
 * Odczyt treści z limitem: `Content-Length` sprawdzany przed odczytem, a sam odczyt przerywany po MAX_BODY_BYTES
 * (nagłówek może kłamać albo go nie być przy chunked). Za duża = 413, zły JSON = 400.
 */
export async function readJsonBody(req: Request, max = MAX_BODY_BYTES): Promise<unknown> {
  const len = req.headers.get('content-length')
  if (len !== null && !/^\d+$/.test(len)) throw new ApiInputError('Zły nagłówek Content-Length')
  if (len !== null && Number(len) > max) throw new ApiInputError(`Treść większa niż ${Math.round(max / 1024)} KB`, undefined, 413)
  const reader = req.body?.getReader()
  if (!reader) throw new ApiInputError('Brak treści żądania (JSON)')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      throw new ApiInputError(`Treść większa niż ${Math.round(max / 1024)} KB`, undefined, 413)
    }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiInputError('Treść nie jest poprawnym JSON-em')
  }
}

export interface EasyToolsResult {
  status: 201 | 200
  body: { id: string; status: string; outcome: IngestOutcome; zarezerwowano: number; brakuje: number }
}

/** Klucz zdarzenia zależny od treści: ta sama treść = ten sam klucz (DUPLIKAT), inna przy istniejącym numerze = 409. */
export function eventKeyOf(o: EasyToolsOrderIn): string {
  const canon = JSON.stringify([o.numer, o.zlozono.toISOString(), o.platnosc, o.platnoscMetoda, o.sumaBrutto, o.sposobDostawy, o.chceFakture, o.pozycje.map((l) => [l.sku ?? null, l.produktId ?? null, l.ilosc, l.cenaBrutto, l.vat ?? null])])
  return `${o.numer}:${createHash('sha256').update(canon, 'utf8').digest('hex').slice(0, 32)}`
}

/** Konto kanału EASYTOOLS firmy (ChannelConfig). Brak albo kilka aktywnych = 422 (konfiguracja do poprawy). */
async function easyToolsAccount(db: PrismaClient): Promise<string> {
  const accs = await db.channelConfig.findMany({ where: { channel: 'EASYTOOLS', active: true }, select: { channelAccountId: true } })
  if (accs.length !== 1)
    throw new ApiInputError(accs.length ? 'Firma ma kilka aktywnych kont EasyTools — zostaw jedno w konfiguracji' : 'Firma nie ma aktywnego konta kanału EasyTools', undefined, 422)
  return accs[0]!.channelAccountId
}

export async function submitEasyToolsOrder(db: PrismaClient, o: EasyToolsOrderIn): Promise<EasyToolsResult> {
  const account = await easyToolsAccount(db)
  const skus = [...new Set(o.pozycje.map((l) => l.sku).filter((x): x is string => !!x))]
  const ids = [...new Set(o.pozycje.map((l) => l.produktId).filter((x): x is string => !!x))]
  const products = await db.product.findMany({
    where: { OR: [...(skus.length ? [{ sku: { in: skus } }] : []), ...(ids.length ? [{ id: { in: ids } }] : [])] },
    select: { id: true, sku: true, kind: true },
  })
  const bySku = new Map(products.map((p) => [p.sku, p]))
  const byId = new Map(products.map((p) => [p.id, p]))
  const resolved = o.pozycje.map((l) => (l.sku ? bySku.get(l.sku) : byId.get(l.produktId!)))
  const unknown = o.pozycje.filter((_, i) => !resolved[i]).map((l) => l.sku ?? l.produktId!)
  if (unknown.length) throw new ApiInputError('Nieznane produkty (spoza katalogu firmy)', 'pozycje', 422, { nieznane: [...new Set(unknown)] })
  const digital = resolved.filter((p) => p!.kind === 'DIGITAL').map((p) => p!.sku)
  if (digital.length)
    throw new ApiInputError('Produkty bez stanu (e-book) nie trafiają do logistyki — usuń je z zamówienia', 'pozycje', 422, { bezStanu: [...new Set(digital)] })
  const lines: IncomingLine[] = o.pozycje.map((l, i) => ({
    externalLineId: `${o.numer}:${i + 1}`,
    productId: resolved[i]!.id,
    qty: l.ilosc,
    unitPriceGross: l.cenaBrutto,
    vatRate: l.vat ?? null,
  }))
  const input: IncomingOrder = {
    source: API_SOURCE,
    eventKey: eventKeyOf(o),
    channel: 'EASYTOOLS',
    channelAccountId: account,
    externalId: o.numer,
    createdAtChannel: o.zlozono,
    paymentState: o.platnosc,
    paymentMethod: o.platnoscMetoda,
    totalGross: o.sumaBrutto,
    deliveryMethod: o.sposobDostawy,
    wantInvoiceNip: o.chceFakture,
    lines,
  }
  const res = await ingestOrder(db, input, { onlyNew: true }).catch((e: unknown) => {
    if (e instanceof OrderExistsError)
      throw new ApiInputError(
        'Zamówienie o tym numerze już istnieje z inną treścią. API nie zmienia przyjętych zamówień: popraw je w panelu Kompletora albo wyślij nowy numer.',
        'numer',
        409,
        { id: e.orderId, status: e.status },
      )
    throw e
  })
  // DUPLIKAT nie niesie id zamówienia (IngestResult) — to samo zamówienie po kluczu kanału; liczby zawsze z bazy, więc
  // powtórka daje ten sam wynik co pierwsze wywołanie
  const order = await db.order.findUniqueOrThrow({
    where: { organizationId_channel_channelAccountId_externalId: { organizationId: organizationIdOf(db), channel: 'EASYTOOLS', channelAccountId: account, externalId: o.numer } },
    select: { id: true, status: true },
  })
  const [reserved, short] = await Promise.all([
    db.reservation.aggregate({ where: { orderId: order.id, state: { in: ['ACTIVE', 'CONSUMING', 'CONSUMED'] } }, _sum: { qtyBase: true } }),
    db.shortage.aggregate({ where: { orderId: order.id, state: { in: ['OPEN', 'SHIP_LATER'] } }, _sum: { qtyBase: true } }),
  ])
  return {
    status: res.outcome === 'NOWE' ? 201 : 200,
    body: { id: order.id, status: order.status, outcome: res.outcome, zarezerwowano: reserved._sum.qtyBase ?? 0, brakuje: short._sum.qtyBase ?? 0 },
  }
}
