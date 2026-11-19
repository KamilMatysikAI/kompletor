// Lista przesyłek ze wszystkich przewoźników. BaseLinker ma osobną stronę na każdego kuriera, u nas
// jest jedna lista z filtrem przewoźnika i konta. Tylko odczyt z bazy (bez pytania przewoźnika): stan przesyłki
// z naszej bazy, a ostatni status u przewoźnika z odczytu śledzenia (`shipment.track`), gdy przewoźnik je ma.
// Bez danych klienta: numer nadania, numer zamówienia, przewoźnik i konto (etykieta z adresem zostaje zaszyfrowana).
// Sortowanie i paginacja w bazie (indeks firma + data utworzenia), więc 2 000 przesyłek w miesiącu nie spowalnia listy.
import type { Carrier, Prisma, PrismaClient, ShipmentState, ShipmentTrackState } from '@prisma/client'
import { defaultRegistry } from '../adaptery/domyslne'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { CARRIER_LABEL } from '../panel/format'
import type { SortTabeli } from '../panel/tabela'
import { fromWarsaw } from '../rdzen/kalendarz'
import { kluczReguly, kontoReguly } from './adapter-przewoznika'
import { anulowanaBezDrogi } from './droga-paczki'
import { linkSledzeniaPanelu } from './link-sledzenia'
import { OPIS_STANU_DROGI, STANY_DROGI } from './stany-przesylki'
import { jestRodzajDodatkowej, NAZWA_RODZAJU } from './dodatkowa'

type Db = PrismaClient

export const STANY_PRZESYLKI: readonly ShipmentState[] = ['TWORZENIE', 'UTWORZONA', 'NIEJEDNOZNACZNA', 'BLAD', 'ANULOWANA']

export const STAN_PRZESYLKI: Record<ShipmentState, string> = {
  TWORZENIE: 'Powstaje u przewoźnika',
  UTWORZONA: 'Utworzona',
  NIEJEDNOZNACZNA: 'Do sprawdzenia u przewoźnika',
  BLAD: 'Nie powstała',
  ANULOWANA: 'Anulowana',
}

/** Filtr „Droga paczki”: stan na osi statusów albo `BRAK` (utworzona przesyłka bez odczytu drogi, np. śledzenie do doręczenia wyłączone). */
export type FiltrDrogi = ShipmentTrackState | 'BRAK'
export const FILTRY_DROGI: readonly FiltrDrogi[] = [...STANY_DROGI, 'BRAK']
export const FILTR_DROGI_OPIS: Record<FiltrDrogi, string> = { ...OPIS_STANU_DROGI, BRAK: 'Bez odczytu drogi paczki' }

/**
 * Czy kolumna „Stan” pokazuje stan drogi paczki. Nie przy stanie nieznanym (zostaje „Utworzona” i surowy status
 * przewoźnika pod nią) i nie przy przesyłce anulowanej, która nie pojechała (wystarczy „Anulowana”).
 */
export function pokazDrogeNaLiscie(stan: ShipmentState, droga: ShipmentTrackState | null): boolean {
  return !!droga && droga !== 'NIEZNANY' && !anulowanaBezDrogi(stan, droga)
}

/** Przewoźnicy, którzy mają przesyłki (odbiór osobisty i bez wysyłki nie mają). */
export const PRZEWOZNICY_PRZESYLEK: readonly Carrier[] = ['PACZKOMATY', 'INPOST_KURIER', 'DPD', 'DPD_EMPIK', 'ALLEGRO']

const DZIEN = /^\d{4}-\d{2}-\d{2}$/
const DOBA_MS = 24 * 60 * 60_000
const KONTO_RE = /^[a-z0-9._-]{1,60}(~[A-Z][A-Z0-9]{0,15})?$/

export interface FiltryPrzesylek {
  przewoznik?: Carrier
  /** `<klucz modułu>` albo `<klucz modułu>~<SUFIKS>` (drugie konto przewoźnika) */
  konto?: string
  stan?: ShipmentState
  /** stan drogi paczki u przewoźnika (oś statusów) */
  droga?: FiltrDrogi
  od?: string
  do?: string
  /** fragment numeru nadania (albo identyfikatora przesyłki u przewoźnika) */
  numer?: string
  /** fragment numeru zamówienia (w kanale albo w Kompletorze) */
  zamowienie?: string
}

/** Klucz konta przewoźnika przesyłki: moduł i sufiks drugiego konta. */
export const kluczKonta = (adapterKey: string, sufiks: string | null | undefined): string => (sufiks ? `${adapterKey}~${sufiks}` : adapterKey)

type Parametry = Record<string, string | string[] | undefined>

export function filtryPrzesylekZ(sp: Parametry): FiltryPrzesylek {
  const j = (k: string) => {
    const v = sp[k]
    const s = (Array.isArray(v) ? v[0] : v)?.trim()
    return s ? s.slice(0, 60) : undefined
  }
  const przewoznik = j('przewoznik')
  const stan = j('stan')
  const droga = j('droga')
  const konto = j('konto')
  const od = j('od')
  const do_ = j('do')
  return {
    przewoznik: (PRZEWOZNICY_PRZESYLEK as readonly string[]).includes(przewoznik ?? '') ? (przewoznik as Carrier) : undefined,
    konto: konto && KONTO_RE.test(konto) ? konto : undefined,
    stan: (STANY_PRZESYLKI as readonly string[]).includes(stan ?? '') ? (stan as ShipmentState) : undefined,
    droga: (FILTRY_DROGI as readonly string[]).includes(droga ?? '') ? (droga as FiltrDrogi) : undefined,
    od: od && DZIEN.test(od) ? od : undefined,
    do: do_ && DZIEN.test(do_) ? do_ : undefined,
    numer: j('numer')?.replace(/\s+/g, ''),
    zamowienie: j('zamowienie'),
  }
}

/** Liczba ustawionych filtrów (bez wyszukiwania po numerze nadania), do „Filtry (n)”. */
export function ileFiltrowPrzesylek(f: FiltryPrzesylek): number {
  return [f.przewoznik, f.konto, f.stan, f.droga, f.od, f.do, f.zamowienie].filter(Boolean).length
}

export function warunekPrzesylek(f: FiltryPrzesylek): Prisma.ShipmentWhereInput {
  const and: Prisma.ShipmentWhereInput[] = []
  if (f.przewoznik) and.push({ carrier: f.przewoznik })
  if (f.konto) {
    const [adapterKey, sufiks] = f.konto.split('~')
    and.push({ adapterKey, accountSuffix: sufiks ?? null })
  }
  if (f.stan) and.push({ state: f.stan })
  if (f.droga) and.push(f.droga === 'BRAK' ? { state: 'UTWORZONA', trackState: null } : { trackState: f.droga })
  if (f.od) and.push({ createdAt: { gte: fromWarsaw(f.od, 0) } })
  if (f.do) and.push({ createdAt: { lt: new Date(fromWarsaw(f.do, 0).getTime() + DOBA_MS) } })
  if (f.numer) and.push({ OR: [{ trackingNumber: { contains: f.numer, mode: 'insensitive' } }, { externalRef: { equals: f.numer } }] })
  if (f.zamowienie) {
    const q = f.zamowienie
    and.push({ order: { OR: [{ channelNumber: { contains: q, mode: 'insensitive' } }, { externalId: { contains: q, mode: 'insensitive' } }] } })
  }
  return and.length ? { AND: and } : {}
}

export const SORT_PRZESYLEK = ['data', 'przewoznik', 'numer', 'stan'] as const
export const SORT_PRZESYLEK_DOMYSLNY: SortTabeli = { klucz: 'data', kierunek: 'malejaco' }

function kolejnosc(s: SortTabeli): Prisma.ShipmentOrderByWithRelationInput[] {
  const k = s.kierunek === 'rosnaco' ? 'asc' : 'desc'
  switch (s.klucz) {
    case 'przewoznik':
      return [{ carrier: k }, { createdAt: 'desc' }, { id: 'desc' }]
    case 'numer':
      return [{ trackingNumber: { sort: k, nulls: 'last' } }, { id: 'desc' }]
    case 'stan':
      return [{ state: k }, { createdAt: 'desc' }, { id: 'desc' }]
    default:
      return [{ createdAt: k }, { id: k }]
  }
}

export interface KontoListy {
  klucz: string
  nazwa: string
  /** czy nadawanie z Kompletora jest włączone na tym koncie (wyłącznik w Ustawienia → Przewoźnicy → Konta) */
  nadawanie: boolean
}

export interface WierszPrzesylki {
  id: string
  utworzono: Date
  carrier: Carrier
  przewoznik: string
  konto: KontoListy
  orderId: string
  zamowienie: string
  numer: string | null
  stan: ShipmentState
  stanOpis: string
  /** surowy status u przewoźnika z ostatniego śledzenia; null = przewoźnik nie podaje albo jeszcze nie odczytano */
  statusPrzewoznika: string | null
  sledzonoO: Date | null
  /** stan drogi paczki na osi statusów (null = bez odczytu drogi) i od kiedy */
  droga: ShipmentTrackState | null
  drogaOpis: string | null
  drogaOd: Date | null
  /** strona śledzenia u przewoźnika (null = przewoźnik bez potwierdzonego adresu albo bez numeru) */
  link: string | null
  /** zapisana etykieta (do pobrania i druku bez pytania przewoźnika) */
  etykieta: boolean
  formatEtykiety: string | null
  gabaryt: string | null
  /** paczka zamówienia (zamówienie podzielone na kilka paczek) */
  paczka: number
  /** dodatkowa przesyłka do zamówienia („Dosyłka nr 1”); null = główna */
  dodatkowa: string | null
  blad: string | null
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/**
 * Nazwa modułu dla ekranu bez opisu technicznego z manifestu („DPD Polska (bezpośrednio, zapis za wyłącznikiem)” →
 * „DPD Polska”, „InPost ShipX z tworzeniem przesyłek (za wyłącznikiem)” → „InPost ShipX”).
 */
export function nazwaModulu(displayName: string): string {
  const n = displayName.replace(/\s*\(.*\)\s*$/, '').replace(/\s+z tworzeniem przesyłek$/i, '').trim()
  return n || displayName
}

/** Nazwy drugich kont przewoźników z ustawień firmy (`settings.przewoznicy.konta`). */
function nazwyKontDodanych(settings: unknown): Map<string, string> {
  const lista = asObject(asObject(settings)['przewoznicy'])['konta']
  const m = new Map<string, string>()
  if (Array.isArray(lista))
    for (const k of lista) {
      const o = asObject(k)
      if (typeof o['sufiks'] === 'string' && typeof o['nazwa'] === 'string') m.set(o['sufiks'], o['nazwa'])
    }
  return m
}

/**
 * Konta przewoźników firmy (z reguł przewoźnika i z przesyłek) z nazwą i stanem wyłącznika nadawania. Nadawanie konta
 * jest włączone, gdy którakolwiek reguła z tym modułem i kontem ma `zapisWlaczony: true` (ten sam wyłącznik co nadanie).
 * `zPrzesylek: false` (bramki druku, pliku etykiet, anulowania): tylko konta z reguł, bez przeglądania przesyłek firmy.
 * Konto spoza reguł i tak ma nadawanie wyłączone (`powodKontaWylaczonego(undefined)`); różni się
 * tylko nazwą w komunikacie. Lista przesyłek (filtr „Konto”) czyta też konta z przesyłek po indeksie (firma, moduł, konto).
 */
export async function kontaPrzewoznikow(db: Db, registry: AdapterRegistry = defaultRegistry(), o: { zPrzesylek?: boolean } = {}): Promise<Map<string, KontoListy>> {
  const [reguly, zPrzesylek, org] = await Promise.all([
    db.carrierRule.findMany({ select: { adapterKey: true, shippingModule: true, config: true } }),
    o.zPrzesylek === false ? Promise.resolve([]) : db.shipment.groupBy({ by: ['adapterKey', 'accountSuffix'] }),
    db.organization.findFirst({ select: { settings: true } }),
  ])
  const nazwy = nazwyKontDodanych(org?.settings)
  const out = new Map<string, KontoListy>()
  const dodaj = (adapterKey: string, sufiks: string | null, nadawanie: boolean) => {
    const klucz = kluczKonta(adapterKey, sufiks)
    const nazwa = `${nazwaModulu(registry.get(adapterKey)?.manifest.displayName ?? adapterKey)}: ${sufiks ? (nazwy.get(sufiks) ?? `konto ${sufiks}`) : 'konto główne'}`
    const b = out.get(klucz)
    out.set(klucz, { klucz, nazwa, nadawanie: (b?.nadawanie ?? false) || nadawanie })
  }
  for (const r of reguly) {
    const key = kluczReguly(r)
    if (!key) continue
    dodaj(key, kontoReguly({ config: asObject(r.config) }), asObject(r.config)['zapisWlaczony'] === true)
  }
  for (const s of zPrzesylek) dodaj(s.adapterKey, s.accountSuffix, false)
  return out
}

/** Strona listy przesyłek. `konta` = wynik `kontaPrzewoznikow` z tego samego żądania (bez drugiego odczytu reguł). */
export async function stronaPrzesylek(
  db: Db,
  f: FiltryPrzesylek,
  o: { sort: SortTabeli; pomin: number; ile: number; konta?: Map<string, KontoListy>; registry?: AdapterRegistry },
): Promise<{ wiersze: WierszPrzesylki[]; razem: number }> {
  const where = warunekPrzesylek(f)
  const [razem, rows, konta] = await Promise.all([
    db.shipment.count({ where }),
    db.shipment.findMany({
      where,
      orderBy: kolejnosc(o.sort),
      skip: o.pomin,
      take: o.ile,
      select: {
        id: true,
        createdAt: true,
        carrier: true,
        adapterKey: true,
        accountSuffix: true,
        orderId: true,
        trackingNumber: true,
        state: true,
        carrierStatus: true,
        trackedAt: true,
        trackState: true,
        trackStateSince: true,
        labelFormat: true,
        labelFetchedAt: true,
        parcelSize: true,
        packageNo: true,
        extraNo: true,
        extraKind: true,
        lastError: true,
        order: { select: { channelNumber: true, externalId: true } },
      },
    }),
    o.konta ? Promise.resolve(o.konta) : kontaPrzewoznikow(db, o.registry),
  ])
  const registry = o.registry ?? defaultRegistry()
  return {
    razem,
    wiersze: rows.map((s) => {
      const klucz = kluczKonta(s.adapterKey, s.accountSuffix)
      return {
        id: s.id,
        utworzono: s.createdAt,
        carrier: s.carrier,
        przewoznik: CARRIER_LABEL[s.carrier],
        konto: konta.get(klucz) ?? { klucz, nazwa: registry.get(s.adapterKey)?.manifest.displayName ?? s.adapterKey, nadawanie: false },
        orderId: s.orderId,
        zamowienie: s.order.channelNumber ?? s.order.externalId,
        numer: s.trackingNumber,
        stan: s.state,
        stanOpis: STAN_PRZESYLKI[s.state],
        statusPrzewoznika: s.carrierStatus,
        sledzonoO: s.trackedAt,
        droga: s.trackState,
        drogaOpis: s.trackState ? OPIS_STANU_DROGI[s.trackState] : null,
        drogaOd: s.trackState ? (s.trackStateSince ?? s.trackedAt) : null,
        // jak na karcie: utworzona albo anulowana, która mimo to pojechała
        link: s.state === 'UTWORZONA' || (s.state === 'ANULOWANA' && !anulowanaBezDrogi(s.state, s.trackState)) ? linkSledzeniaPanelu(s.carrier, s.trackingNumber, s.adapterKey) : null,
        etykieta: !!s.labelFetchedAt,
        formatEtykiety: s.labelFormat,
        gabaryt: s.parcelSize,
        paczka: s.packageNo,
        dodatkowa: s.extraNo > 0 ? `${s.extraKind && jestRodzajDodatkowej(s.extraKind) ? NAZWA_RODZAJU[s.extraKind] : 'Dodatkowa przesyłka'} nr ${s.extraNo}` : null,
        blad: s.state === 'BLAD' || s.state === 'NIEJEDNOZNACZNA' ? s.lastError : null,
      }
    }),
  }
}

/** Identyfikatory przesyłek pasujących do filtrów (akcja „na wszystkich stronach”), w kolejności listy. */
export async function idPrzesylek(db: Db, f: FiltryPrzesylek, sort: SortTabeli, limit: number): Promise<{ ids: string[]; razem: number }> {
  const where = warunekPrzesylek(f)
  const [razem, rows] = await Promise.all([db.shipment.count({ where }), db.shipment.findMany({ where, orderBy: kolejnosc(sort), take: limit, select: { id: true } })])
  return { ids: rows.map((r) => r.id), razem }
}

const ID_RE = /^[a-z0-9]{1,40}$/i

/** Identyfikatory przesyłek z formularza albo adresu (`z=a,b,c`): poprawne, bez powtórzeń, kolejność zachowana. */
export function idPrzesylekZ(v: unknown, limit: number): { ids: string[]; zaDuzo: boolean } {
  const surowe = Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' ? x.split(',') : [])) : typeof v === 'string' ? v.split(',') : []
  const ids = [...new Set(surowe.map((x) => x.trim()).filter((x) => ID_RE.test(x)))]
  return { ids: ids.slice(0, limit), zaDuzo: ids.length > limit }
}
