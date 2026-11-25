// Lista zamówień v2: panel statusów z licznikami jak w BaseLinkerze
// (grupa × przewoźnik: jeden klik = kolejka jednego kuriera), filtry, wyszukiwarka, sortowanie i paginacja po stronie
// bazy. Liczniki panelu liczy jedno zapytanie `groupBy(status, carrier)` (indeks organizationId, status, carrier),
// a strona listy to `findMany` z `skip/take`, więc 1 630 zamówień miesięcznie (i rok takich) nie zwalnia ekranu.
// Każda funkcja bierze klienta firmy z sesji (RLS); klient systemowy jest odrzucany (`organizationIdOf`).
// Dane osobowe: lista nie odszyfrowuje klientów. Filtr „Kraj” idzie po jawnym kodzie kraju (OrderCustomer.country),
// wyszukiwanie klienta po skrócie e-maila/telefonu albo po liście zamówień z wyszukiwania fragmentem (lib/klienci).
import type { Carrier, Channel, InvoiceState, OrderStatus, PaymentState, Prisma, PrismaClient, ReturnStatus, ShipmentState } from '@prisma/client'
import { cache } from 'react'
import { organizationIdOf } from '@/lib/db'
import { fromWarsaw } from '@/lib/rdzen/kalendarz'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { PRZED_SPAKOWANIEM, zamowieniaZFakturaBl } from '@/lib/rdzen/faktura-bl'
import { accountKey, accounts, OPEN_SHORTAGE, viewWhere, type AccountRef } from './dane'
import type { SortTabeli } from './tabela'
import { kluczRdzenia, warunekStatusuFirmy, type GrupaStatusowT, type StatusFirmyT } from './statusy'
import { statusyFirmy, wierszeStatusow, zlozLicznikiStatusow, zlozPrzewoznikowStatusow, type StatusyFirmy } from './statusy-firmy-dane'
import { warunekPoTerminie } from './termin-wysylki'
import { daneTerminowNaZadanie, type DaneTerminow } from './termin-wysylki-dane'
import { WALUTA_DOMYSLNA, walutyZamowien } from '../rdzen/waluta'
import { linkSledzeniaPanelu } from '@/lib/wysylka/link-sledzenia'

type Db = PrismaClient

// ─── Panel statusów ──────────────────────────────────────────────────────────

export type KluczGrupy = 'wymaga' | 'nowe' | 'do_realizacji' | 'zebrane' | 'spakowane' | 'do_wyslania' | 'wyslane' | 'problemowe' | 'anulowane' | 'wszystkie'

export interface GrupaPanelu {
  klucz: KluczGrupy
  etykieta: string
  /** null = grupa liczona osobnym warunkiem („Wymaga działania”) albo wszystkie zamówienia */
  statusy: readonly OrderStatus[] | null
  /** pod grupą liczniki per przewoźnik (kolejka jednego kuriera) */
  perPrzewoznik: boolean
}

/** Kolejność i nazwy jak w panelu BL (Do realizacji → Zebrane → Spakowane → Do wysłania → Zakończone → Problemowe). */
export const GRUPY_PANELU: readonly GrupaPanelu[] = [
  { klucz: 'wymaga', etykieta: 'Wymaga działania', statusy: null, perPrzewoznik: false },
  { klucz: 'nowe', etykieta: 'Nowe', statusy: ['NOWE'], perPrzewoznik: false },
  { klucz: 'do_realizacji', etykieta: 'Do realizacji', statusy: ['DO_REALIZACJI'], perPrzewoznik: true },
  { klucz: 'zebrane', etykieta: 'Zbierane i zebrane', statusy: ['ZBIERANIE', 'ZEBRANE'], perPrzewoznik: true },
  { klucz: 'spakowane', etykieta: 'Spakowane', statusy: ['SPAKOWANE'], perPrzewoznik: true },
  { klucz: 'do_wyslania', etykieta: 'Do wysłania', statusy: ['DO_WYSLANIA', 'DO_ODBIORU'], perPrzewoznik: true },
  { klucz: 'wyslane', etykieta: 'Wysłane', statusy: ['WYSLANE', 'ODEBRANE'], perPrzewoznik: false },
  { klucz: 'problemowe', etykieta: 'Problemowe', statusy: ['DO_WYJASNIENIA', 'REKLAMACJA'], perPrzewoznik: false },
  { klucz: 'anulowane', etykieta: 'Anulowane', statusy: ['ANULOWANE'], perPrzewoznik: false },
  { klucz: 'wszystkie', etykieta: 'Wszystkie', statusy: null, perPrzewoznik: false },
]

/** Widoki z pulpitu i dawnych zakładek (stare linki dalej działają). */
const STARE_WIDOKI = ['w_pakowaniu', 'do_spakowania', 'do_wyjasnienia', 'nieoplacone', 'blad_faktury'] as const
/**
 * widoki liczone z danych spoza statusu: „Po terminie” (termin wysyłki z harmonogramu odbiorów, pozycja
 * w menu) i „Przesyłki bez ruchu” (alert nad listą: wysłane, przesyłka starsza niż `DNI_BEZ_RUCHU`, bez doręczenia).
 */
const WIDOKI_TERMINOW = ['po_terminie', 'bez_ruchu'] as const
export type WidokTerminu = (typeof WIDOKI_TERMINOW)[number]
export type Widok = KluczGrupy | (typeof STARE_WIDOKI)[number] | WidokTerminu
/** Przesyłka „bez ruchu”: utworzona ponad tyle dni temu, a zamówienie dalej „Wysłane”, nie „Odebrane”. */
export const DNI_BEZ_RUCHU = 5

export const NAZWY_STARYCH: Record<(typeof STARE_WIDOKI)[number] | WidokTerminu, string> = {
  po_terminie: 'Po terminie wysyłki',
  bez_ruchu: 'Przesyłki bez ruchu',
  w_pakowaniu: 'W pakowaniu',
  do_spakowania: 'Do spakowania',
  do_wyjasnienia: 'Do wyjaśnienia',
  nieoplacone: 'Nieopłacone z rezerwacją',
  blad_faktury: 'Faktura się nie wystawiła',
}

/** lista bez parametru `widok` pokazuje „Wszystkie”; „Wymaga działania” to drugi widok. */
export const WIDOK_DOMYSLNY: KluczGrupy = 'wszystkie'

export function widokZ(v: string | undefined): Widok {
  if (v && GRUPY_PANELU.some((g) => g.klucz === v)) return v as KluczGrupy
  if (v && ([...STARE_WIDOKI, ...WIDOKI_TERMINOW] as readonly string[]).includes(v)) return v as Widok
  return WIDOK_DOMYSLNY
}

export function nazwaWidoku(w: Widok): string {
  return GRUPY_PANELU.find((g) => g.klucz === w)?.etykieta ?? NAZWY_STARYCH[w as keyof typeof NAZWY_STARYCH] ?? w
}

/** Warunek „przesyłka bez ruchu” (`DNI_BEZ_RUCHU` od utworzenia przesyłki; śledzenie u przewoźnika nie jest potrzebne). */
export function warunekBezRuchu(now: Date): Prisma.OrderWhereInput {
  return { status: 'WYSLANE', carrierShipments: { some: { state: 'UTWORZONA', createdAt: { lt: new Date(now.getTime() - DNI_BEZ_RUCHU * DOBA_MS) } } } }
}

function warunekWidoku(w: Widok, t?: DaneTerminow): Prisma.OrderWhereInput {
  if (w === 'po_terminie') return t ? warunekPoTerminie(t.harmonogramy, t.przyjazdy, t.now, t.cien) : { id: '__brak__' }
  if (w === 'bez_ruchu') return warunekBezRuchu(t?.now ?? new Date())
  const g = GRUPY_PANELU.find((x) => x.klucz === w)
  if (g?.statusy) return { status: { in: [...g.statusy] } }
  if (w === 'wymaga' || w === 'wszystkie') return viewWhere(w)
  return viewWhere(w as Parameters<typeof viewWhere>[0])
}

/** Przewoźnicy w panelu; `BRAK` obejmuje też zamówienia bez ustalonego przewoźnika (null). */
export const PRZEWOZNICY: readonly Carrier[] = ['PACZKOMATY', 'INPOST_KURIER', 'DPD', 'DPD_EMPIK', 'ALLEGRO', 'OSOBISTY', 'BEZ_WYSYLKI', 'BRAK']

function warunekPrzewoznika(c: string): Prisma.OrderWhereInput | null {
  if (!(PRZEWOZNICY as readonly string[]).includes(c)) return null
  return c === 'BRAK' ? { OR: [{ carrier: 'BRAK' }, { carrier: null }] } : { carrier: c as Carrier }
}

export interface LicznikiPanelu {
  /** grupa → liczba */
  grupy: Record<KluczGrupy, number>
  /** grupa z perPrzewoznik → przewoźnik → liczba (tylko niezerowe) */
  przewoznicy: Partial<Record<KluczGrupy, Partial<Record<Carrier, number>>>>
  /**
   * statusy firmy (gdy firma je ma): grupy i statusy w kolejności, liczba zamówień per klucz statusu
   * (`RDZEN:<status>` = zamówienia bez pasującego statusu firmy). Panel pokazuje wtedy statusy firmy zamiast grup rdzenia.
   */
  firmy?: {
    grupy: GrupaStatusowT[]
    statusy: StatusFirmyT[]
    ile: Record<string, number>
    /** klucz statusu firmy → przewoźnik → liczba (tylko niezerowe; `BRAK` obejmuje brak przewoźnika) */
    przewoznicy: Record<string, Partial<Record<Carrier, number>>>
  }
  /** zamówienia po terminie wysyłki; brak = firma nie ma aktywnego harmonogramu odbiorów (pozycji w menu nie ma) */
  poTerminie?: number
}

/** Czysta część liczników (testy jednostkowe): wiersze `groupBy(status, carrier)` → grupy i przewoźnicy. */
export function zlozLiczniki(wiersze: { status: OrderStatus; carrier: Carrier | null; n: number }[], wymaga: number): LicznikiPanelu {
  const grupy = Object.fromEntries(GRUPY_PANELU.map((g) => [g.klucz, 0])) as Record<KluczGrupy, number>
  const przewoznicy: LicznikiPanelu['przewoznicy'] = {}
  for (const w of wiersze) {
    grupy.wszystkie += w.n
    for (const g of GRUPY_PANELU) {
      if (!g.statusy?.includes(w.status)) continue
      grupy[g.klucz] += w.n
      if (g.perPrzewoznik) {
        const c: Carrier = w.carrier ?? 'BRAK'
        const m = (przewoznicy[g.klucz] ??= {})
        m[c] = (m[c] ?? 0) + w.n
      }
    }
  }
  grupy.wymaga = wymaga
  return { grupy, przewoznicy }
}

/** statusy firmy raz na żądanie (`cache`, klucz = klient firmy z sesji): menu w layoucie, liczniki i lista. */
export const statusyFirmyNaZadanie = cache((db: Db): Promise<StatusyFirmy> => statusyFirmy(db))

/**
 * Liczniki statusów w menu (bez filtrów listy, jak w BL: stan całej firmy). React
 * `cache` liczy je raz na żądanie, choć wołają je layout (menu) i lista zamówień; klucz to klient firmy z sesji
 * (`prismaForOrg` zwraca tę samą instancję dla firmy). `grupy.wymaga` to też licznik „Zamówienia” w menu, więc
 * zapytanie „Wymaga działania” (dwa EXISTS po brakach i fakturach) idzie raz, a nie trzy razy.
 * firma ze statusami własnymi dostaje `firmy` (grupy, statusy, liczniki per status firmy z tej samej funkcji
 * co ekran ustawień, `zlozLicznikiStatusow`) i podział statusów na przewoźników (menu).
 */
export const licznikiPanelu = cache(async (db: Db): Promise<LicznikiPanelu> => {
  organizationIdOf(db)
  // jedno groupBy(status, carrier, companyStatus) na indeksie pokrywającym zamiast dwóch;
  // liczniki rdzenia sumują wiersze po `companyStatus`, statusy firmy biorą je wprost. Licznik „Po terminie” tylko
  // u firmy z aktywnym harmonogramem odbiorów.
  const [rows, wymaga, sf, terminy] = await Promise.all([wierszeStatusow(db), db.order.count({ where: viewWhere('wymaga') }), statusyFirmyNaZadanie(db), daneTerminowNaZadanie(db)])
  const out = zlozLiczniki(sumujPoStatusieIPrzewozniku(rows), wymaga)
  if (sf.statusy.length) out.firmy = { ...sf, ile: Object.fromEntries(zlozLicznikiStatusow(sf.statusy, rows)), przewoznicy: Object.fromEntries(zlozPrzewoznikowStatusow(sf.statusy, rows)) }
  if (terminy.harmonogramy.length) out.poTerminie = await db.order.count({ where: warunekPoTerminie(terminy.harmonogramy, terminy.przyjazdy, terminy.now, terminy.cien) })
  return out
})

/** Wiersze groupBy(status, carrier, companyStatus) → (status, carrier) dla liczników grup rdzenia. */
export function sumujPoStatusieIPrzewozniku(rows: readonly { status: OrderStatus; carrier: Carrier | null; n: number }[]): { status: OrderStatus; carrier: Carrier | null; n: number }[] {
  const m = new Map<string, { status: OrderStatus; carrier: Carrier | null; n: number }>()
  for (const r of rows) {
    const k = `${r.status}|${r.carrier ?? ''}`
    const w = m.get(k)
    if (w) w.n += r.n
    else m.set(k, { status: r.status, carrier: r.carrier, n: r.n })
  }
  return [...m.values()]
}

/** klucz statusu firmy z adresu (`sf`): klucz statusu albo `RDZEN:<status>`. */
const KLUCZ_SF_RE = /^(RDZEN:)?[A-Z0-9][A-Z0-9_]{0,39}$/

/** Warunek „status firmy `sf`” albo „grupa statusów firmy `sg`” (grupa = suma jej statusów). */
export function warunekStatusowFirmy(defs: readonly StatusFirmyT[], f: Pick<FiltryListy, 'sf' | 'sg'>): Prisma.OrderWhereInput | null {
  if (f.sf) return warunekStatusuFirmy(defs, f.sf)
  if (f.sg) {
    const w = defs.filter((d) => d.groupKey === f.sg)
    return w.length ? { OR: w.map((d) => warunekStatusuFirmy(defs, d.key)) } : { id: '__brak__' }
  }
  return null
}

export { kluczRdzenia }

// ─── Filtry ──────────────────────────────────────────────────────────────────

export const STATUSY: readonly OrderStatus[] = ['NOWE', 'DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE', 'REKLAMACJA', 'DO_WYJASNIENIA', 'ANULOWANE']
const PLATNOSCI: readonly PaymentState[] = ['PAID', 'UNPAID', 'COD', 'PARTIAL']
export const FAKTURA_FILTR = { chce: 'Klient chce fakturę', chce_bez: 'Chce fakturę, a nie wystawiona', wystawiona: 'Faktura wystawiona', blad: 'Faktura się nie wystawiła' } as const
export type FiltrFaktury = keyof typeof FAKTURA_FILTR

export interface FiltryListy {
  widok: Widok
  q?: string
  status?: string
  kanal?: string // `${channel}:${channelAccountId}`
  przewoznik?: string
  platnosc?: string
  /** RRRR-MM-DD, czas polski, włącznie */
  od?: string
  do?: string
  faktura?: string
  kraj?: string
  /** status firmy (klucz albo `RDZEN:<status>`) i grupa statusów firmy z panelu statusów */
  sf?: string
  sg?: string
  /** wynik wyszukiwania klienta (skrót e-maila/telefonu albo fragment): tylko te zamówienia */
  ids?: readonly string[]
  /**
   * jedno pole szukania. Zamówienia klientów pasujących do frazy (skrót e-maila/telefonu/NIP-u albo fragment
   * nazwiska) dokładane do wyników frazy `q` (numer, numer przesyłki, produkt) sumą, nie zawężeniem.
   */
  idsKlienta?: readonly string[]
}

const DZIEN = /^\d{4}-\d{2}-\d{2}$/

/** Parametry adresu → filtry (wartości spoza list odrzucone, żeby śmieci z adresu nie trafiały do zapytania). */
export function filtryZ(sp: Record<string, string | string[] | undefined>): FiltryListy {
  const j = (k: string) => {
    const v = sp[k]
    const s = (Array.isArray(v) ? v[0] : v)?.trim()
    return s ? s.slice(0, 100) : undefined
  }
  const od = j('od')
  const do_ = j('do')
  const kraj = j('kraj')?.toUpperCase()
  const faktura = j('faktura')
  const sf = j('sf')
  const sg = j('sg')
  return {
    sf: sf && KLUCZ_SF_RE.test(sf) ? sf : undefined,
    sg: !sf && sg && /^[A-Z0-9][A-Z0-9_]{0,39}$/.test(sg) ? sg : undefined,
    widok: widokZ(j('widok')),
    q: j('q'),
    status: STATUSY.includes(j('status') as OrderStatus) ? j('status') : undefined,
    kanal: j('kanal'),
    przewoznik: (PRZEWOZNICY as readonly string[]).includes(j('przewoznik') ?? '') ? j('przewoznik') : undefined,
    platnosc: PLATNOSCI.includes(j('platnosc') as PaymentState) ? j('platnosc') : undefined,
    od: od && DZIEN.test(od) ? od : undefined,
    do: do_ && DZIEN.test(do_) ? do_ : undefined,
    faktura: faktura && faktura in FAKTURA_FILTR ? faktura : undefined,
    kraj: kraj && /^[A-Z]{2}$/.test(kraj) ? kraj : undefined,
  }
}

/** Liczba ustawionych filtrów (bez widoku i wyszukiwarki), do „Filtry (n)”. */
export function ileFiltrow(f: FiltryListy): number {
  return [f.status, f.kanal, f.przewoznik, f.platnosc, f.od, f.do, f.faktura, f.kraj].filter(Boolean).length
}

const DOBA_MS = 24 * 60 * 60_000

/** Największa wartość kolumny `Int` w Postgresie (numer zamówienia BL). */
const INT_MAX = 2_147_483_647

/**
 * zamówienie po każdym ze swoich numerów: identyfikator z kanału, numer widoczny w kanale i numer zamówienia
 * BL (lista i karta pokazują go jako numer główny, np. Empik „EMP 165103969”). Numer BL tylko całą liczbą, bo to `Int`.
 */
export function warunkiNumeru(fraza: string): Prisma.OrderWhereInput[] {
  const q = fraza.trim()
  if (!q) return []
  const out: Prisma.OrderWhereInput[] = []
  // numer przepisany z listy razem z przedrostkiem kanału („EMP 165103969”): szukamy też samego numeru
  const bezPrzedrostka = /^\p{L}{2,4}\s+(\S+)$/u.exec(q)?.[1]
  for (const n of bezPrzedrostka ? [q, bezPrzedrostka] : [q]) {
    out.push({ externalId: { contains: n, mode: 'insensitive' } }, { channelNumber: { contains: n, mode: 'insensitive' } })
    if (/^\d{1,10}$/.test(n) && Number(n) > 0 && Number(n) <= INT_MAX) out.push({ blOrderId: Number(n) })
  }
  return out
}

/** Warunek zapytania z filtrów (wyszukiwanie po produkcie i numerze nadania w osobnych krokach, z limitem). */
/** `statusy`: statusy firmy już czytane na tym żądaniu (przeglądu: lista nie czyta ich drugi raz). */
export async function warunekListy(db: Db, f: FiltryListy, accs: AccountRef[], statusy?: Promise<StatusyFirmy>): Promise<Prisma.OrderWhereInput> {
  const and: Prisma.OrderWhereInput[] = [warunekWidoku(f.widok, f.widok === 'po_terminie' ? await daneTerminowNaZadanie(db) : undefined)]
  const q = f.q?.trim().slice(0, 100)
  if (q) {
    const [prods, przesylki] = await Promise.all([
      db.product.findMany({ where: { OR: [{ sku: { contains: q, mode: 'insensitive' } }, { title: { contains: q, mode: 'insensitive' } }, { ean: q }] }, select: { id: true }, take: 500 }),
      q.length >= 4 ? db.shipment.findMany({ where: { trackingNumber: { contains: q, mode: 'insensitive' } }, select: { orderId: true }, take: 200 }) : Promise.resolve([]),
    ])
    and.push({
      OR: [
        ...warunkiNumeru(q),
        ...(prods.length ? [{ lines: { some: { productId: { in: prods.map((p) => p.id) } } } }] : []),
        ...(przesylki.length ? [{ id: { in: [...new Set(przesylki.map((p) => p.orderId))] } }] : []),
        ...(f.idsKlienta?.length ? [{ id: { in: [...f.idsKlienta] } }] : []),
      ],
    })
  } else if (f.idsKlienta) and.push({ id: { in: [...f.idsKlienta] } })
  if (f.status) and.push({ status: f.status as OrderStatus })
  if (f.sf || f.sg) {
    const w = warunekStatusowFirmy((await (statusy ?? statusyFirmy(db))).statusy, f)
    if (w) and.push(w)
  }
  if (f.kanal) {
    const a = accs.find((x) => accountKey(x.channel, x.channelAccountId) === f.kanal)
    and.push(a ? { channel: a.channel, channelAccountId: a.channelAccountId } : { id: '__brak__' })
  }
  if (f.przewoznik) {
    const w = warunekPrzewoznika(f.przewoznik)
    if (w) and.push(w)
  }
  if (f.platnosc) and.push({ paymentState: f.platnosc as PaymentState })
  if (f.od) and.push({ createdAtChannel: { gte: fromWarsaw(f.od, 0) } })
  if (f.do) and.push({ createdAtChannel: { lt: new Date(fromWarsaw(f.do, 0).getTime() + DOBA_MS) } })
  switch (f.faktura as FiltrFaktury | undefined) {
    case 'chce':
      and.push({ wantInvoiceNip: true })
      break
    case 'chce_bez':
      and.push({ wantInvoiceNip: true, status: { not: 'ANULOWANE' }, invoices: { none: { state: 'ISSUED' } } })
      break
    case 'wystawiona':
      and.push({ invoices: { some: { state: 'ISSUED' } } })
      break
    case 'blad':
      and.push({ invoices: { some: { state: 'FAILED' } } })
      break
  }
  if (f.kraj) and.push({ customer: { country: f.kraj } })
  if (f.ids) and.push({ id: { in: [...f.ids] } })
  return { AND: and }
}

// ─── Strona listy ────────────────────────────────────────────────────────────

export const SORTOWANIE = ['data', 'kwota', 'numer'] as const
export const SORT_DOMYSLNY: SortTabeli = { klucz: 'data', kierunek: 'malejaco' }

function kolejnosc(s: SortTabeli): Prisma.OrderOrderByWithRelationInput[] {
  const d = s.kierunek === 'rosnaco' ? 'asc' : 'desc'
  const pole: Prisma.OrderOrderByWithRelationInput = s.klucz === 'kwota' ? { totalGross: d } : s.klucz === 'numer' ? { externalId: d } : { createdAtChannel: d }
  return [pole, { id: 'asc' }]
}

export interface WierszListy {
  id: string
  channel: Channel
  channelAccountId: string
  externalId: string
  /** numer zamówienia w BL (termin wysyłki konta w podglądzie wg statusu BL) */
  blOrderId: number | null
  /** paczka dodatkowa bierze dane klienta zamówienia głównego (kolumna „Klient”). */
  parentOrderId?: string | null
  /** numer widoczny w kanale (Woo z numeracją wtyczki), gdy inny niż externalId */
  channelNumber: string | null
  sourceLabel: string | null
  status: OrderStatus
  carrier: Carrier | null
  /** status firmy przypisany wprost (null = wyliczany) */
  companyStatus: string | null
  deliveryMethod: string | null
  paymentState: PaymentState
  paymentMethod: string
  totalGross: number
  createdAtChannel: Date
  reservationDeadline: Date | null
  /** nieudana płatność online: kiedy towar wróci do sprzedaży / kiedy wrócił (zamówienie czeka na płatność) */
  stockReleaseAt: Date | null
  stockReleasedAt: Date | null
  openShortages: number
  wantInvoice: boolean
  /** ostatnia próba faktury (null = brak) */
  invoice: InvoiceState | null
  /** przesyłka u przewoźnika (ostatnia) */
  shipment: { state: ShipmentState; trackingNumber: string | null; /** strona śledzenia u przewoźnika (`linkSledzeniaPanelu`), null = sam numer */ link: string | null; label: boolean } | null
  country: string | null
  clarify: string | null
  /** ostatni zwrot albo reklamacja (null = brak) */
  zwrot: { status: ReturnStatus; korekta: InvoiceState | null } | null
  /**
   * przed wysyłką, a brak towaru rozliczyła faktura BL (zdjęła flagę „brakuje”): w BaseLinkerze
   * zamówienie mogło nadal czekać na towar. Znacznik „sprawdź, czy towar dojechał”.
   */
  towarPoFakturzeBl?: boolean
  /** konto w trybie pracy, przed spakowaniem, faktura z BaseLinkera = kończy BL (numer faktury). */
  fakturaBl?: string | null
  /** waluta zamówienia z kopii kanału (lib/rdzen/waluta.ts); `totalGross` jest w tej walucie. */
  waluta: string
}

/** Statusy, w których zamówienie jeszcze nie wyszło (znacznik ma sens tylko tu). */
const PRZED_WYSYLKA: readonly OrderStatus[] = ['NOWE', 'DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYJASNIENIA']

const num = (v: { toString(): string } | null | undefined): number => (v === null || v === undefined ? 0 : Number(v.toString()))

export async function stronaListy(db: Db, f: FiltryListy, o: { sort: SortTabeli; pomin: number; ile: number; statusy?: Promise<StatusyFirmy> }): Promise<{ wiersze: WierszListy[]; razem: number; konta: AccountRef[] }> {
  organizationIdOf(db)
  const konta = await accounts(db)
  const where = await warunekListy(db, f, konta, o.statusy)
  const [lista, razem] = await Promise.all([
    db.order.findMany({
      where,
      orderBy: kolejnosc(o.sort),
      skip: o.pomin,
      take: o.ile,
      include: {
        shortages: { where: OPEN_SHORTAGE, select: { id: true } },
        invoices: { orderBy: [{ createdAt: 'desc' }], select: { state: true }, take: 1 },
        // tylko przesyłka główna: dodatkowa (dosyłka) nie jest przesyłką zamówienia na liście
        carrierShipments: { where: { extraNo: 0 }, orderBy: [{ createdAt: 'desc' }], select: { state: true, trackingNumber: true, carrier: true, adapterKey: true, labelFetchedAt: true }, take: 1 },
        customer: { select: { country: true } },
        returns: { orderBy: [{ createdAt: 'desc' }], select: { status: true, correctionState: true }, take: 1 },
      },
    }),
    db.order.count({ where }),
  ])
  // znaczniki po fakturze BL (dwa zapytania na stronę; firma bez BL: puste wyniki, bez zmian na liście).
  // Tylko konta spoza podglądu: w podglądzie samonaprawa rozlicza braki fakturą BL przy zwykłych zamówieniach BL.
  // Konto bez konfiguracji jak w rdzeniu (`kontoWPodgladzie`): tryb pracy.
  const wPracy = (z: (typeof lista)[number]) => konta.find((k) => k.channel === z.channel && k.channelAccountId === z.channelAccountId)?.statusMode !== 'CIEN'
  const przed = lista.filter((z) => PRZED_WYSYLKA.includes(z.status) && wPracy(z))
  const [czekalNaTowar, zFakturaBl, waluty] = await Promise.all([
    przed.length
      ? db.shortage.findMany({ where: { orderId: { in: przed.map((z) => z.id) }, resolvedBy: 'system:faktura-bl' }, select: { orderId: true }, distinct: ['orderId'] })
      : [],
    zamowieniaZFakturaBl(
      db,
      lista.filter((z) => PRZED_SPAKOWANIEM.includes(z.status as (typeof PRZED_SPAKOWANIEM)[number]) && wPracy(z)),
    ),
    walutyZamowien(db, lista), // jedno zapytanie na stronę, po kluczu unikalnym kopii kanału
  ])
  const czekal = new Set(czekalNaTowar.map((s) => s.orderId))
  return {
    razem,
    konta,
    wiersze: lista.map((z) => ({
      id: z.id,
      channel: z.channel,
      channelAccountId: z.channelAccountId,
      externalId: z.externalId,
      blOrderId: z.blOrderId,
      parentOrderId: z.parentOrderId,
      channelNumber: z.channelNumber,
      sourceLabel: z.sourceLabel,
      status: z.status,
      carrier: z.carrier,
      companyStatus: z.companyStatus,
      deliveryMethod: z.deliveryMethod,
      paymentState: z.paymentState,
      paymentMethod: z.paymentMethod,
      totalGross: num(z.totalGross),
      createdAtChannel: z.createdAtChannel,
      reservationDeadline: z.reservationDeadline,
      stockReleaseAt: z.stockReleaseAt,
      stockReleasedAt: z.stockReleasedAt,
      openShortages: z.shortages.length,
      wantInvoice: z.wantInvoiceNip,
      invoice: z.invoices[0]?.state ?? null,
      shipment: z.carrierShipments[0] ? { state: z.carrierShipments[0].state, trackingNumber: z.carrierShipments[0].trackingNumber, link: z.carrierShipments[0].state === 'UTWORZONA' ? linkSledzeniaPanelu(z.carrierShipments[0].carrier, z.carrierShipments[0].trackingNumber, z.carrierShipments[0].adapterKey) : null, label: !!z.carrierShipments[0].labelFetchedAt } : null,
      country: z.customer?.country ?? null,
      clarify: flagsOf(z).doWyjasnienia ?? null,
      zwrot: z.returns[0] ? { status: z.returns[0].status, korekta: z.returns[0].correctionState } : null,
      ...(czekal.has(z.id) ? { towarPoFakturzeBl: true } : {}),
      ...(zFakturaBl.has(z.id) ? { fakturaBl: zFakturaBl.get(z.id)! } : {}),
      waluta: waluty.get(z.id) ?? WALUTA_DOMYSLNA,
    })),
  }
}

/** Identyfikatory wszystkich zamówień pasujących do filtrów (akcja „na wszystkich stronach”), z twardym limitem. */
export async function idPasujacych(db: Db, f: FiltryListy, limit: number): Promise<{ ids: string[]; razem: number }> {
  organizationIdOf(db)
  const where = await warunekListy(db, f, await accounts(db))
  const [rows, razem] = await Promise.all([db.order.findMany({ where, orderBy: [{ createdAtChannel: 'desc' }, { id: 'asc' }], take: limit, select: { id: true } }), db.order.count({ where })])
  return { ids: rows.map((r) => r.id), razem }
}
