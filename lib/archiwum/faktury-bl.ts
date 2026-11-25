// etap 3: archiwum z faktur BaseLinkera (`getInvoices`), jedyne źródło sprzedaży sprzed okna API Allegro.
//
// Faktura BL nie podaje kanału. Kanał odtwarzamy deterministycznie odejmowaniem: faktura, która ma parę w zamówieniu
// innego kanału (archiwum Woo, Empiku, EasyTools albo `Order`), należy do tamtego kanału i NIE trafia do archiwum
// z faktur; faktura bez pary = Allegro z `channelInferred = true`. Para to (1) ta sama waluta, (2) kwota brutto różna
// najwyżej o `TOLERANCJA_GR`, (3) data sprzedaży na fakturze w oknie [złożenie − `OKNO_PRZED_MS`, złożenie +
// `OKNO_PO_MS`]. Gdy kandydatów jest kilku, wygrywa zgodny zestaw SKU pozycji, potem mniejsza różnica czasu, potem
// mniejsze id (przydział zachłanny, jeden do jednego, ta sama kolejność przy każdym przebiegu).
//
// Plik wejściowy: JSON Lines (albo lista JSON) faktur przyciętych do pól z `POLA_FAKTURY` / `POLA_POZYCJI`; dane
// nabywcy, `payment` (adres PayPal kupującego), `issuer`, `seller` i `additional_info` są odrzucane także tutaj.
import { UnreadableDataError } from '../adaptery/kontrakt'
import type { PrismaClient } from '@prisma/client'
import { idPola, type ZrodloArchiwum } from './import'
import type { PozycjaArchiwum, WynikMapowaniaWoo, ZamowienieArchiwum } from './woo'
import { czytnikListy, ZRODLO_ALLEGRO_API, ZRODLO_ALLEGRO_ZRZUT } from './zrodla'
import type { KanalZrodlaBl } from './zrodla-bl'

export const ZRODLO_FAKTURA_BL = 'BL_FAKTURA'
export const TOLERANCJA_GR = 1
export const OKNO_PRZED_MS = 1 * 86_400_000
export const OKNO_PO_MS = 21 * 86_400_000

export const POLA_FAKTURY = [
  'invoice_id', 'order_id', 'series_id', 'type', 'number', 'date_add', 'date_sell', 'currency', 'total_price_brutto',
  'total_price_netto', 'correcting_to_invoice_id', 'external_invoice_number', 'items',
] as const
export const POLA_POZYCJI = ['name', 'sku', 'ean', 'price_brutto', 'tax_rate', 'quantity', 'is_shipment', 'order_product_id'] as const

export interface PozycjaFaktury {
  id: string
  name: string
  sku: string | null
  ean: string | null
  qty: number
  /** wartość całej pozycji brutto (cena × ilość), grosze */
  bruttoGr: number
  vatRate: string | null
  wysylka: boolean
}

export interface FakturaBl {
  invoiceId: number
  orderId: number | null
  numer: string
  typ: 'normal' | 'correcting'
  korektaDo: number | null
  czasSprzedazy: Date
  bruttoGr: number
  waluta: string
  pozycje: PozycjaFaktury[]
}

const gr = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? Math.round(n * 100) : NaN
}
const tekst = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : null)
const calk = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Odcina wszystko spoza listy pól (dane nabywcy, `payment`, wystawca). */
export function bezDanychOsobowychFaktury(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of POLA_FAKTURY) if (k in raw && k !== 'items') out[k] = raw[k]
  const items = Array.isArray(raw['items']) ? raw['items'] : []
  out['items'] = items
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => {
      const o: Record<string, unknown> = {}
      for (const k of POLA_POZYCJI) if (k in p) o[k] = p[k]
      return o
    })
  return out
}

export function fakturaBlZSurowej(raw: Record<string, unknown>): FakturaBl {
  const r = bezDanychOsobowychFaktury(raw)
  const invoiceId = calk(r['invoice_id'])
  if (!invoiceId) throw new UnreadableDataError('faktura BL bez invoice_id')
  const typ = r['type'] === 'correcting' ? 'correcting' : r['type'] === 'normal' || r['type'] === undefined ? 'normal' : null
  if (!typ) throw new UnreadableDataError(`faktura ${invoiceId}: nieznany typ`)
  const t = calk(r['date_sell']) ?? calk(r['date_add'])
  if (!t) throw new UnreadableDataError(`faktura ${invoiceId}: brak daty sprzedaży`)
  const bruttoGr = gr(r['total_price_brutto'])
  if (!Number.isFinite(bruttoGr)) throw new UnreadableDataError(`faktura ${invoiceId}: nieczytelna kwota`)
  const waluta = (tekst(r['currency'], 3) ?? 'PLN').toUpperCase()
  const pozycje: PozycjaFaktury[] = (r['items'] as Record<string, unknown>[]).map((p, i) => {
    const qty = Number(p['quantity'])
    const cena = gr(p['price_brutto'])
    if (!Number.isFinite(qty) || !Number.isFinite(cena)) throw new UnreadableDataError(`faktura ${invoiceId}: nieczytelna pozycja ${i + 1}`)
    return {
      id: tekst(p['order_product_id'], 40) ?? String(i + 1),
      name: tekst(p['name']) ?? '(pozycja bez nazwy)',
      sku: tekst(p['sku'], 100),
      ean: tekst(p['ean'], 40),
      qty,
      bruttoGr: Math.round(cena * qty),
      vatRate: p['tax_rate'] === undefined || p['tax_rate'] === null || p['tax_rate'] === '' ? null : String(p['tax_rate']).slice(0, 10),
      wysylka: Number(p['is_shipment']) === 1 || p['is_shipment'] === true,
    }
  })
  return {
    invoiceId,
    orderId: calk(r['order_id']),
    numer: tekst(r['number'], 60) ?? String(invoiceId),
    typ,
    korektaDo: calk(r['correcting_to_invoice_id']),
    czasSprzedazy: new Date(t * 1000),
    bruttoGr,
    waluta,
    pozycje,
  }
}

/** Faktury z pliku: JSON Lines albo lista JSON. Nieczytelny wiersz = błąd całego pliku (nic się nie importuje). */
export function fakturyZPliku(tekstPliku: string): Record<string, unknown>[] {
  const t = tekstPliku.trim()
  if (!t) return []
  let lista: unknown[]
  if (t.startsWith('[')) {
    try {
      lista = JSON.parse(t) as unknown[]
    } catch {
      throw new Error('plik faktur: to nie jest JSON')
    }
  } else {
    lista = t.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
      try {
        return JSON.parse(l) as unknown
      } catch {
        throw new Error(`plik faktur: wiersz ${i + 1} nie jest JSON`)
      }
    })
  }
  if (!Array.isArray(lista)) throw new Error('plik faktur: oczekiwana lista')
  return lista.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)).map(bezDanychOsobowychFaktury)
}

/** Zamówienie innego kanału, z którym faktura może tworzyć parę. */
export interface KandydatPary {
  kanal: string
  id: string
  czas: Date
  bruttoGr: number
  waluta: string
  /** SKU pozycji (bez wysyłki); pusta lista = nie porównujemy */
  skus: readonly string[]
}

const normSku = (s: string) => s.replace(/\s+/g, '').toUpperCase()
const zestaw = (skus: readonly (string | null)[]) => skus.filter((s): s is string => !!s && !!s.trim()).map(normSku).sort().join('|')

/** SKU pozycji faktury bez wysyłki, w postaci do porównania z kandydatem. */
export const skusFaktury = (f: FakturaBl) => f.pozycje.filter((p) => !p.wysylka).map((p) => p.sku)

/**
 * Pary faktura → zamówienie innego kanału (opis reguły w nagłówku pliku). Faktury korygujące nie są parowane.
 * Wynik: invoiceId → kandydat. Deterministyczny: ta sama kolejność wejścia lub inna daje ten sam wynik.
 */
export function parujFaktury(faktury: readonly FakturaBl[], kandydaci: readonly KandydatPary[], o: { tolerancjaGr?: number; oknoPrzedMs?: number; oknoPoMs?: number } = {}): Map<number, KandydatPary> {
  const tol = o.tolerancjaGr ?? TOLERANCJA_GR
  const przed = o.oknoPrzedMs ?? OKNO_PRZED_MS
  const po = o.oknoPoMs ?? OKNO_PO_MS
  // indeks kandydatów po (waluta, kwota w groszach) z tolerancją
  const idx = new Map<string, KandydatPary[]>()
  for (const k of kandydaci) {
    const kl = `${k.waluta}|${k.bruttoGr}`
    const l = idx.get(kl)
    if (l) l.push(k)
    else idx.set(kl, [k])
  }
  type Kraw = { f: FakturaBl; k: KandydatPary; sku: number; dt: number }
  const krawedzie: Kraw[] = []
  for (const f of faktury) {
    if (f.typ !== 'normal') continue
    const zf = zestaw(skusFaktury(f))
    for (let d = -tol; d <= tol; d++) {
      for (const k of idx.get(`${f.waluta}|${f.bruttoGr + d}`) ?? []) {
        const dt = f.czasSprzedazy.getTime() - k.czas.getTime()
        if (dt < -przed || dt > po) continue
        const zk = zestaw(k.skus)
        krawedzie.push({ f, k, sku: zf && zk && zf === zk ? 0 : 1, dt: Math.abs(dt) })
      }
    }
  }
  krawedzie.sort((a, b) => a.sku - b.sku || a.dt - b.dt || a.f.invoiceId - b.f.invoiceId || (a.k.kanal + a.k.id < b.k.kanal + b.k.id ? -1 : a.k.kanal + a.k.id > b.k.kanal + b.k.id ? 1 : 0))
  const wynik = new Map<number, KandydatPary>()
  const zajete = new Set<string>()
  for (const e of krawedzie) {
    const kk = `${e.k.kanal}|${e.k.id}`
    if (wynik.has(e.f.invoiceId) || zajete.has(kk)) continue
    wynik.set(e.f.invoiceId, e.k)
    zajete.add(kk)
  }
  return wynik
}

/** Kanał kandydata z bazy (`archiwum:<K>:<konto>` albo `zamowienie:<K>:<konto>`) → `<K>`. */
export const kanalKandydata = (k: KandydatPary): string => k.kanal.split(':')[1] ?? k.kanal

export interface WynikParowaniaZeZrodlami {
  /** pary faktur bez wpisu w pliku źródeł (jak `parujFaktury`, na kandydatach, których nie zajęły faktury z wpisem) */
  pary: Map<number, KandydatPary>
  /** faktury z wpisem kanału z archiwum (innego niż Allegro), które znalazły zamówienie swojego kanału */
  wlasne: Map<number, KandydatPary>
  /** faktury z wpisem kanału z archiwum bez zamówienia swojego kanału w bazie (sprzedaż nie jest liczona nigdzie) */
  bezOdpowiednika: FakturaBl[]
}

/**
 * Parowanie z plikiem źródeł BL (przegląd zrodla-bl): najpierw faktury z wpisem kanału innego niż Allegro, każda
 * tylko z kandydatami SWOJEGO kanału; zajmują swoje pary (wynik służy do zajęcia kandydata i do licznika „bez
 * odpowiednika”). Potem faktury bez wpisu z kandydatami, którzy zostali, więc faktura spoza pliku nie zabierze pary
 * fakturze sklepu. Faktury z wpisem ALLEGRO i `POMIN` nie biorą udziału (nie przekazuje się ich tutaj).
 */
export function parujZeZrodlami(bezWpisu: readonly FakturaBl[], zWpisem: readonly { f: FakturaBl; kanal: string }[], kandydaci: readonly KandydatPary[], o: Parameters<typeof parujFaktury>[2] = {}): WynikParowaniaZeZrodlami {
  const wlasne = new Map<number, KandydatPary>()
  const zajete = new Set<string>()
  for (const K of [...new Set(zWpisem.map((x) => x.kanal))].sort()) {
    const p = parujFaktury(zWpisem.filter((x) => x.kanal === K).map((x) => x.f), kandydaci.filter((k) => kanalKandydata(k) === K), o)
    for (const [id, k] of p) {
      wlasne.set(id, k)
      zajete.add(`${k.kanal}|${k.id}`)
    }
  }
  const pary = parujFaktury(bezWpisu, zajete.size ? kandydaci.filter((k) => !zajete.has(`${k.kanal}|${k.id}`)) : kandydaci, o)
  return { pary, wlasne, bezOdpowiednika: zWpisem.filter((x) => !wlasne.has(x.f.invoiceId)).map((x) => x.f) }
}

/** Suma korekt (wartość ujemna faktur korygujących) po fakturze pierwotnej, grosze, jako kwota dodatnia zwrotu. */
export function zwrotyZKorekt(faktury: readonly FakturaBl[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const f of faktury) {
    if (f.typ !== 'correcting' || !f.korektaDo) continue
    out.set(f.korektaDo, (out.get(f.korektaDo) ?? 0) + Math.max(0, -f.bruttoGr))
  }
  return out
}

/** Faktura (bez pary w innym kanale) → wiersz archiwum Allegro z kanałem odtworzonym. */
export function archiwumZFakturyBl(f: FakturaBl, zwrotGr = 0): WynikMapowaniaWoo {
  if (f.typ !== 'normal') throw new UnreadableDataError(`faktura ${f.invoiceId}: korekta nie jest zamówieniem`)
  const warnings: string[] = []
  const towary = f.pozycje.filter((p) => !p.wysylka)
  const wysylkaGr = f.pozycje.filter((p) => p.wysylka).reduce((a, p) => a + p.bruttoGr, 0)
  const sumaPoz = f.pozycje.reduce((a, p) => a + p.bruttoGr, 0)
  if (Math.abs(sumaPoz - f.bruttoGr) > Math.max(2, f.pozycje.length)) warnings.push(`faktura ${f.invoiceId}: suma pozycji różni się od kwoty faktury o ${sumaPoz - f.bruttoGr} gr`)
  const zwrot = Math.min(Math.max(0, zwrotGr), f.bruttoGr)
  // zwrot rozkładany na pozycje towarowe proporcjonalnie (wysyłka najpierw nie jest zwracana: jak w etapie 1)
  const naTowary = Math.min(zwrot, towary.reduce((a, p) => a + Math.max(0, p.bruttoGr), 0))
  const sumaT = towary.reduce((a, p) => a + Math.max(0, p.bruttoGr), 0)
  let rozdane = 0
  const lines: PozycjaArchiwum[] = towary.map((p, i) => {
    const czesc = i === towary.length - 1 ? naTowary - rozdane : sumaT > 0 ? Math.floor((naTowary * Math.max(0, p.bruttoGr)) / sumaT) : 0
    rozdane += czesc
    return { externalLineId: p.id, offerId: null, name: p.name, sku: p.sku, ean: p.ean, qtyOffer: p.qty, lineGrossGr: p.bruttoGr, vatRate: p.vatRate, refundGr: czesc }
  })
  const z: ZamowienieArchiwum = {
    externalId: String(f.invoiceId),
    channelNumber: null,
    status: zwrot >= f.bruttoGr && f.bruttoGr > 0 ? 'ANULOWANE' : 'WYSLANE',
    channelStatus: 'faktura BL',
    createdAtChannel: f.czasSprzedazy,
    closedAt: null,
    paymentState: 'PAID',
    totalGrossGr: f.bruttoGr,
    shippingGrossGr: wysylkaGr,
    refundGrossGr: zwrot,
    currency: f.waluta,
    deliveryMethod: null,
    sourceRevision: `${f.bruttoGr}|${zwrot}|${f.pozycje.length}`,
    lines,
    warnings,
  }
  return { rodzaj: 'zamowienie', zamowienie: z }
}

/** Liczba id w jednym `deleteMany` przy wycofaniu (limit parametrów zapytania Postgresa to 65 535). */
export const KAWALEK_WYCOFANIA = 5000

/** Najwcześniejsze zamówienie konta Allegro w archiwum z API albo zrzutu (koniec zakresu faktur), null = brak. */
export async function pierwszeZamowienieAllegroZApi(db: PrismaClient, konto: string): Promise<{ createdAtChannel: Date } | null> {
  return db.archivedOrder.findFirst({ where: { channel: 'ALLEGRO', channelAccountId: konto, source: { in: [ZRODLO_ALLEGRO_API, ZRODLO_ALLEGRO_ZRZUT] } }, orderBy: { createdAtChannel: 'asc' }, select: { createdAtChannel: true } })
}

/** Kandydaci do pary z bazy: archiwum innych źródeł i `Order` w oknie faktur (bez zamówień nieopłaconych i anulowanych). */
export async function kandydaciZBazy(db: PrismaClient, od: Date, doDnia: Date): Promise<KandydatPary[]> {
  const gte = new Date(od.getTime() - OKNO_PO_MS - 86_400_000)
  const lt = new Date(doDnia.getTime() + OKNO_PRZED_MS + 86_400_000)
  const nieoplacone = { status: 'ANULOWANE' as const, paymentState: { notIn: ['PAID' as const, 'COD' as const] } }
  const arch = await db.archivedOrder.findMany({
    where: { createdAtChannel: { gte, lt }, source: { not: ZRODLO_FAKTURA_BL }, NOT: nieoplacone },
    select: { channel: true, channelAccountId: true, externalId: true, createdAtChannel: true, totalGross: true, currency: true, lines: { select: { sku: true } } },
  })
  const ord = await db.order.findMany({
    where: { createdAtChannel: { gte, lt }, NOT: nieoplacone },
    select: { channel: true, channelAccountId: true, externalId: true, createdAtChannel: true, totalGross: true, lines: { select: { channelSku: true } } },
  })
  return [
    ...arch.map((a) => ({ kanal: `archiwum:${a.channel}:${a.channelAccountId}`, id: a.externalId, czas: a.createdAtChannel, bruttoGr: Math.round(Number(a.totalGross) * 100), waluta: a.currency.toUpperCase(), skus: a.lines.map((l) => l.sku).filter((s): s is string => !!s) })),
    ...ord.map((o) => ({ kanal: `zamowienie:${o.channel}:${o.channelAccountId}`, id: o.externalId, czas: o.createdAtChannel, bruttoGr: Math.round(Number(o.totalGross) * 100), waluta: 'PLN', skus: o.lines.map((l) => l.channelSku).filter((s): s is string => !!s) })),
  ]
}

/**
 * Źródło archiwum z faktur BL (kanał Allegro, odtworzony). `surowe` = przycięte rekordy z pliku (normalne i korekty),
 * `pary` = wynik `parujFaktury` na kandydatach z bazy: faktura z parą jest pomijana („para w innym kanale”).
 * `koniecKonta` = naturalny koniec zakresu konta liczony bez `--do` (pierwsze zamówienie Allegro w archiwum z API albo
 * zrzutu, przycięte do `coverageFrom`); null = nieznany (wtedy wycofanie tylko po parach).
 * `zrodla` (opcjonalne, plik źródeł z archiwum BL, `lib/archiwum/zrodla-bl.ts`): `order_id` faktury → kanał albo `POMIN`
 * (nazwy spoza mapy nie mają tu wpisu: wywołujący zatrzymuje przebieg wcześniej, `bladSpozaMapy`). Faktura z wpisem
 * nie wchodzi jako Allegro odtworzone: ALLEGRO = wiersz archiwum z kanałem podanym (`channelInferred = false`; waluta
 * z faktury, sprzeczna waluta pliku = ostrzeżenie mapowania), inny kanał i `POMIN` = pominięta („inny kanał wg źródeł
 * BL”; sprzedaż sklepów i Empiku przychodzi z ich archiwum, a brak odpowiednika liczy `parujZeZrodlami`) i wycofana,
 * jeśli była zapisana. Przegląd r2 (K-A): wycofanie z powodu wpisu w pliku działa tylko na faktury z `zakres` (ten sam
 * zakres dat przebiegu `[od, do)`, w którym wywołujący liczy pary i „bez odpowiednika”), więc faktura spoza zakresu nie
 * zniknie bez kontroli; brak `zakres` = bez takiego wycofania. Faktura bez `order_id` w pliku idzie dotychczasową drogą
 * (para albo Allegro odtworzone). Bez pliku zachowanie bez zmian.
 */
export function zrodloFakturyBl(
  surowe: readonly Record<string, unknown>[],
  pary: ReadonlyMap<number, KandydatPary>,
  koniecKonta: Date | null = null,
  zrodla: { kanal: ReadonlyMap<number, KanalZrodlaBl>; waluta?: ReadonlyMap<number, string> } | null = null,
  zakres: { od: Date; do: Date } | null = null,
): ZrodloArchiwum {
  const wszystkie = surowe.map((r) => ({ r, f: (() => { try { return fakturaBlZSurowej(r) } catch { return null } })() }))
  const zwroty = zwrotyZKorekt(wszystkie.map((x) => x.f).filter((f): f is FakturaBl => !!f))
  // korekty nie są zamówieniami: zostają tylko jako zwroty faktury pierwotnej; nieczytelny rekord idzie do mapowania (błąd w raporcie)
  const zamowienia = wszystkie.filter((x) => !x.f || x.f.typ === 'normal').map((x) => x.r)
  const kanalZeZrodel = (f: FakturaBl): KanalZrodlaBl | undefined => (zrodla && f.orderId !== null ? zrodla.kanal.get(f.orderId) : undefined)
  // wiersze zapisane wcześniej z kanałem odtworzonym, które wg pliku źródeł należą do innego kanału: do wycofania,
  // tylko w zakresie dat przebiegu (przegląd r2 K-A: tam, gdzie liczony jest licznik „bez odpowiednika”)
  const wZakresie = (f: FakturaBl) => !!zakres && f.czasSprzedazy >= zakres.od && f.czasSprzedazy < zakres.do
  const innyKanal = zrodla ? wszystkie.filter((x) => x.f && x.f.typ === 'normal' && wZakresie(x.f) && (kanalZeZrodel(x.f) ?? 'ALLEGRO') !== 'ALLEGRO').map((x) => String(x.f!.invoiceId)) : []
  return {
    channel: 'ALLEGRO',
    source: ZRODLO_FAKTURA_BL,
    runKind: 'archiwum-faktury-bl',
    etykieta: 'Allegro (z faktur BL, kanał odtworzony)',
    czytaj: czytnikListy(zamowienia),
    oczysc: bezDanychOsobowychFaktury,
    mapuj: (raw) => {
      const f = fakturaBlZSurowej(raw)
      const kz = kanalZeZrodel(f)
      // z datą: importer liczy fakturę spoza `--od/--do` jako „poza zakresem dat”, tak jak opis parowania;
      // pary są liczone tylko w zakresie, więc „para w innym kanale” daty nie potrzebuje
      if (kz !== undefined && kz !== 'ALLEGRO') return { rodzaj: 'pominiete', powod: 'inny kanał wg źródeł BL', czas: f.czasSprzedazy }
      if (kz === undefined && pary.has(f.invoiceId)) return { rodzaj: 'pominiete', powod: 'para w innym kanale' }
      const m = archiwumZFakturyBl(f, zwroty.get(f.invoiceId) ?? 0)
      if (m.rodzaj === 'zamowienie') {
        m.zamowienie.blOrderId = f.orderId
        m.zamowienie.invoiceNumbers = [f.numer]
        if (kz === 'ALLEGRO') {
          // kanał podany przez plik źródeł: bez flagi, a rewizja inna niż przy kanale odtworzonym (zmiana flagi = zapis)
          m.zamowienie.kanalOdtworzony = false
          m.zamowienie.sourceRevision += '|zrodla-bl'
          const wp = f.orderId !== null ? zrodla?.waluta?.get(f.orderId) : undefined
          if (wp && wp !== f.waluta) m.zamowienie.warnings.push(`faktura ${f.invoiceId}: waluta w pliku źródeł BL (${wp.slice(0, 3)}) inna niż na fakturze (${f.waluta}), liczona waluta faktury`)
        }
      }
      return m
    },
    idSurowe: idPola('invoice_id'),
    maksNaStrone: 500,
    kanalOdtworzony: true,
    produktPoKodach: true,
    // przegląd etapu 3: wiersz z faktury zapisany wcześniej, a teraz z parą (np. po doimportowaniu sklepu) albo za
    // naturalnym końcem konta (wcześniejsze pierwsze zamówienie Allegro z API, coverageFrom), liczyłby się obok zamówienia
    // pary: usuwamy go (dane da się odtworzyć z pliku faktur), na sucho tylko liczymy. Przegląd końcowy: granica
    // od końca konta, nie od `--do` przebiegu; krótsze `--do` tylko zawęża zapis, więc import kawałkami nie kasuje
    // miesięcy zapisanych przez wcześniejszy kawałek
    // wybór w pamięci, usuwanie po id kawałkami (przegląd zrodla-bl: długa lista `in` przekroczyłaby limit
    // parametrów zapytania przy całym roku faktur)
    wycofaj: async (db, { konto, naSucho }) => {
      const doWycofania = new Set([...[...pary.keys()].map(String), ...innyKanal])
      const wiersze = await db.archivedOrder.findMany({ where: { source: ZRODLO_FAKTURA_BL, channel: 'ALLEGRO', channelAccountId: konto }, select: { id: true, externalId: true, createdAtChannel: true } })
      const ids = wiersze.filter((w) => doWycofania.has(w.externalId) || (!!koniecKonta && w.createdAtChannel >= koniecKonta)).map((w) => w.id)
      if (naSucho) return ids.length
      let usuniete = 0
      for (let i = 0; i < ids.length; i += KAWALEK_WYCOFANIA) usuniete += (await db.archivedOrder.deleteMany({ where: { id: { in: ids.slice(i, i + KAWALEK_WYCOFANIA) } } })).count
      return usuniete
    },
  }
}
