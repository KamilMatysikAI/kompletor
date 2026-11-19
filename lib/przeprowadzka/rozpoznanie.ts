// Przeprowadzka z BL: rozpoznanie konfiguracji konta BL i plan konfiguracji Kompletora — BEZ zapisu.
//
// `pobierzKonfiguracje` czyta konfigurację BL (katalogi, magazyny, grupy cen, źródła zamówień, statusy, kurierów,
// serie) metodami z listy (metody.ts); błąd jednej metody = pozycja w `issues`, reszta idzie dalej. `planuj` to czysta
// funkcja: z odczytu, decyzji człowieka (plik mapy) i zamówień (już bez danych osobowych) robi plan — konta kanałów
// (wszystkie w trybie CIEN), mapę statusów, reguły przewoźników i listę spraw do decyzji. Niczego nie zgaduje:
// przewoźnik rozpoznany tylko z jawnej nazwy w metodzie dostawy, reszta do decyzji.
//
// [NIEPEWNE] — kształt odpowiedzi metod, których repo dotąd nie używało (do potwierdzenia na prawdziwym koncie BL):
// getInventories (pola `name`, `warehouses`, `default_warehouse`), getInventoryWarehouses, getInventoryPriceGroups,
// getInventoryCategories, getInventoryManufacturers, getExternalStoragesList, getOrderSources, getOrderStatusGroups,
// getOrderExtraFields, getCouriersList, getCourierAccounts, getSeries. Parsery niżej są tolerancyjne (obiekt albo
// tablica, brak pola = pusto) i nigdy nie przepisują całych obiektów odpowiedzi.
import type { Carrier } from '@prisma/client'
import { DEFAULT_CHANNEL_ADAPTER } from '../adaptery'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { channelOfOrder, type ChannelMap, type ChannelT } from '../import/normalizacja'
import type { FetchIssue } from '../import/pobieranie'
import { type CarrierRuleT, validateCarrierRule } from '../rdzen/przewoznicy'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'
import { bezOgonkow, type BlStatus, type DecyzjaStatusu, type MapaCzlowieka, mapaStatusow, PUSTA_MAPA } from './statusy'
import type { BlZamowienie } from './zamowienia'

// ─── Odczyt konfiguracji BL ──────────────────────────────────────────────────

export interface BlKatalog {
  id: string
  nazwa: string
  domyslnaGrupaCen: string | null
  domyslnyMagazyn: string | null
  magazyny: string[]
}

export interface BlKonfiguracja {
  katalogi: BlKatalog[]
  magazyny: { id: string; nazwa: string; domyslny: boolean }[]
  grupyCen: { id: string; nazwa: string; waluta: string | null }[]
  kategorie: number | null
  producenci: number | null
  magazynyZewnetrzne: { id: string; nazwa: string }[]
  zrodla: { typ: string; id: string; nazwa: string }[]
  statusy: BlStatus[]
  polaDodatkowe: string[]
  kurierzy: { kod: string; nazwa: string }[]
  kontaKurierow: { kod: string; konta: number }[]
  serie: number | null
}

const str = (v: unknown): string | null => (v === null || v === undefined || (typeof v !== 'string' && typeof v !== 'number') ? null : String(v).trim() || null)
const rows = (v: unknown): Record<string, unknown>[] =>
  (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
const count = (v: unknown): number | null => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : null)
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500)

async function safe<T>(issues: FetchIssue[], kind: string, f: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await f()
  } catch (e) {
    issues.push({ kind, ref: kind, message: errMsg(e) })
    return fallback
  }
}

/** Kurierzy, o których konta pytamy BL: tylko ci, których nazwa albo kod pada w metodach dostawy z zamówień. */
const MAX_KURIEROW = 10

/**
 * `katalog`: id katalogu albo funkcja wybierająca go z listy katalogów BL (zapisany wybór
 * z ekranu, którego w BL już nie ma, wraca do domyślnego zamiast blokować tryb próbny).
 */
export async function pobierzKonfiguracje(bl: BaseLinkerReadOnly, issues: FetchIssue[], katalogArg?: string | ((katalogi: BlKatalog[]) => string | undefined)): Promise<BlKonfiguracja> {
  const katalogi = await safe(
    issues,
    'bl-katalogi',
    async () =>
      rows((await bl.call<{ inventories: unknown }>('getInventories')).inventories).map((i) => ({
        id: str(i['inventory_id']) ?? '',
        nazwa: str(i['name']) ?? '',
        domyslnaGrupaCen: str(i['default_price_group']),
        domyslnyMagazyn: str(i['default_warehouse']),
        magazyny: Array.isArray(i['warehouses']) ? (i['warehouses'] as unknown[]).map((w) => String(w)) : [],
      })),
    [] as BlKatalog[],
  )
  const magazyny = await safe(
    issues,
    'bl-magazyny',
    async () =>
      rows((await bl.call<{ warehouses: unknown }>('getInventoryWarehouses')).warehouses).map((w) => ({
        id: `${str(w['warehouse_type']) ?? 'bl'}_${str(w['warehouse_id']) ?? ''}`,
        nazwa: str(w['name']) ?? '',
        domyslny: w['is_default'] === true || w['is_default'] === 1 || w['is_default'] === '1',
      })),
    [] as BlKonfiguracja['magazyny'],
  )
  const grupyCen = await safe(
    issues,
    'bl-grupy-cen',
    async () =>
      rows((await bl.call<{ price_groups: unknown }>('getInventoryPriceGroups')).price_groups).map((g) => ({
        id: str(g['price_group_id']) ?? '',
        nazwa: str(g['name']) ?? '',
        waluta: str(g['currency']),
      })),
    [] as BlKonfiguracja['grupyCen'],
  )
  const katalog = typeof katalogArg === 'function' ? katalogArg(katalogi) : katalogArg
  const wybrany = katalog ?? (katalogi.length === 1 ? katalogi[0]!.id : undefined)
  const kategorie = wybrany
    ? await safe(issues, 'bl-kategorie', async () => count((await bl.call<{ categories: unknown }>('getInventoryCategories', { inventory_id: Number(wybrany) })).categories), null)
    : null
  const producenci = await safe(issues, 'bl-producenci', async () => count((await bl.call<{ manufacturers: unknown }>('getInventoryManufacturers')).manufacturers), null)
  const magazynyZewnetrzne = await safe(
    issues,
    'bl-magazyny-zewnetrzne',
    async () => rows((await bl.call<{ storages: unknown }>('getExternalStoragesList')).storages).map((x) => ({ id: str(x['storage_id']) ?? '', nazwa: str(x['name']) ?? '' })),
    [] as BlKonfiguracja['magazynyZewnetrzne'],
  )
  // getOrderSources: { sources: { <typ>: { <id>: <nazwa> } } }
  const zrodla = await safe(
    issues,
    'bl-zrodla',
    async () => {
      const r = await bl.call<{ sources: unknown }>('getOrderSources')
      const out: BlKonfiguracja['zrodla'] = []
      const src = r.sources && typeof r.sources === 'object' ? (r.sources as Record<string, unknown>) : {}
      for (const [typ, list] of Object.entries(src)) {
        if (!list || typeof list !== 'object') continue
        for (const [id, nazwa] of Object.entries(list as Record<string, unknown>)) out.push({ typ, id, nazwa: str(nazwa) ?? '' })
      }
      return out
    },
    [] as BlKonfiguracja['zrodla'],
  )
  const grupy = await safe(
    issues,
    'bl-grupy-statusow',
    async () => {
      // wg dokumentacji (api.baselinker.com, getOrderStatusGroups) grupa ma `group_id`, `name`, `is_main_group`,
      // a status wskazuje grupę polem `group_id` (getOrderStatusList). Starszy kształt z listą statusów w grupie zostaje.
      const r = await bl.call<{ status_groups?: unknown; groups?: unknown }>('getOrderStatusGroups')
      const byStatus = new Map<string, string>()
      const byId = new Map<string, { name: string; glowna: boolean }>()
      for (const g of rows(r.status_groups ?? r.groups)) {
        const name = str(g['name']) ?? str(g['title'])
        const gid = str(g['group_id']) ?? str(g['id'])
        if (name && gid) byId.set(gid, { name, glowna: Number(g['is_main_group']) === 1 })
        const ids = g['statuses'] ?? g['status_ids'] ?? g['order_status_ids']
        if (name && Array.isArray(ids)) for (const id of ids) byStatus.set(String(typeof id === 'object' && id ? (id as Record<string, unknown>)['id'] : id), name)
      }
      return { byStatus, byId }
    },
    { byStatus: new Map<string, string>(), byId: new Map<string, { name: string; glowna: boolean }>() },
  )
  const statusy = await safe(
    issues,
    'bl-statusy',
    async () =>
      rows((await bl.call<{ statuses: unknown }>('getOrderStatusList')).statuses).map((x): BlStatus => {
        const id = str(x['id']) ?? ''
        const gid = str(x['group_id'])
        const g = gid ? grupy.byId.get(gid) : undefined
        // grupa główna BL („Brak grupy”) = status bez grupy, jak „Nowe zamówienia” na górze panelu
        const group = g ? (g.glowna ? null : g.name) : (grupy.byStatus.get(id) ?? null)
        return { id, name: str(x['name']) ?? '', group, groupId: g && !g.glowna ? gid : null, color: str(x['color']), customerName: str(x['name_for_customer']) }
      }),
    [] as BlStatus[],
  )
  const polaDodatkowe = await safe(
    issues,
    'bl-pola-dodatkowe',
    async () => rows((await bl.call<{ extra_fields: unknown }>('getOrderExtraFields')).extra_fields).map((f) => str(f['name']) ?? '?'),
    [] as string[],
  )
  const kurierzy = await safe(
    issues,
    'bl-kurierzy',
    async () => rows((await bl.call<{ couriers: unknown }>('getCouriersList')).couriers).map((c) => ({ kod: str(c['code']) ?? '', nazwa: str(c['name']) ?? '' })),
    [] as BlKonfiguracja['kurierzy'],
  )
  const serie = await safe(issues, 'bl-serie', async () => count((await bl.call<{ series: unknown }>('getSeries')).series), null)
  return { katalogi, magazyny, grupyCen, kategorie, producenci, magazynyZewnetrzne, zrodla, statusy, polaDodatkowe, kurierzy, kontaKurierow: [], serie }
}

/**
 * Konta kurierów w BL (do raportu: „podłącz klucze kurierów”) — tylko kurierzy, których kod albo nazwa pada w metodach
 * dostawy z zamówień, najwyżej MAX_KURIEROW zapytań. Liczba kont, bez ich nazw i danych.
 */
export async function pobierzKontaKurierow(bl: BaseLinkerReadOnly, kurierzy: BlKonfiguracja['kurierzy'], metodyDostawy: string[], issues: FetchIssue[]): Promise<BlKonfiguracja['kontaKurierow']> {
  const metody = metodyDostawy.map(bezOgonkow)
  const wMetodach = kurierzy.filter((k) => k.kod && metody.some((m) => m.includes(bezOgonkow(k.kod)) || (k.nazwa && m.includes(bezOgonkow(k.nazwa))))).slice(0, MAX_KURIEROW)
  const out: BlKonfiguracja['kontaKurierow'] = []
  for (const k of wMetodach) {
    const n = await safe(issues, 'bl-konta-kuriera', async () => count((await bl.call<{ accounts: unknown }>('getCourierAccounts', { courier_code: k.kod })).accounts) ?? 0, null)
    if (n !== null) out.push({ kod: k.kod, konta: n })
  }
  return out
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export interface KontoPlan {
  channel: ChannelT
  channelAccountId: string
  name: string
  adapterKey: string
  blStorageId: string | null
  /** Źródło BL (typ i id z getOrderSources albo z zamówień). */
  zrodlo: { typ: string; id: string }
  /** Czy rejestr adapterów Kompletora zna adapter rodziny (`defaultRegistry()`). */
  maAdapter: boolean
  /** Źródło pominięte decyzją w pliku mapy (`zrodla: { "<typ>:<id>": "POMIN" }`). */
  pominiete: boolean
  ostrzezenie: string | null
}

export interface DecyzjaPrzewoznika {
  metoda: string
  zamowien: number
  podpowiedz: Carrier | null
  powod: string
}

export interface PlanKonfiguracji {
  katalog: (BlKatalog & { grupaCen: string; magazynStanu: string | null }) | null
  bladKatalogu: string | null
  konta: KontoPlan[]
  statusy: DecyzjaStatusu[]
  reguly: (CarrierRuleT & { metoda: string | null; pewnosc: 'PEWNE' | 'DECYZJA' })[]
  decyzjePrzewoznikow: DecyzjaPrzewoznika[]
  ostrzezenia: string[]
}

/** Rozpoznanie przewoźnika z nazwy metody dostawy: tylko jawne nazwy dają PEWNE, reszta to podpowiedź do decyzji. */
const PRZEWOZNICY: { re: RegExp; carrier: Carrier; pewne: boolean; opis: string }[] = [
  { re: /salon(u|ie)? empik|odbior w empik/, carrier: 'DPD_EMPIK', pewne: true, opis: 'salon Empik' },
  { re: /paczkomat/, carrier: 'PACZKOMATY', pewne: true, opis: 'paczkomat' },
  { re: /\bdpd\b/, carrier: 'DPD', pewne: true, opis: 'DPD' },
  { re: /osobist|odbior w (sklepie|firmie|magazynie)/, carrier: 'OSOBISTY', pewne: true, opis: 'odbiór osobisty' },
  { re: /inpost/, carrier: 'PACZKOMATY', pewne: false, opis: 'InPost bez słowa „paczkomat” (kurier InPost?)' },
  { re: /kurier/, carrier: 'DPD', pewne: false, opis: 'kurier bez nazwy przewoźnika' },
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Konto Kompletora dla źródła BL; nieznane adaptery → BL_INNE. Czysta funkcja (rejestr podany). */
export function kontoDlaZrodla(typ: string, id: string, nazwa: string, shopIds: string[], registry: Pick<AdapterRegistry, 'get'>, mapa: MapaCzlowieka = PUSTA_MAPA): KontoPlan {
  const map: ChannelMap = { shopAccounts: shopIds, empikAccountId: null }
  const { channel, accountId } = channelOfOrder(typ, id, map)
  const pominiete = mapa.zrodla[`${typ}:${id}`] === 'POMIN'
  const adapterKey = DEFAULT_CHANNEL_ADAPTER[channel]
  // `personal` (zamówienie dodane z ręki w BL) daje RECZNE, a zamówienie RECZNE w rdzeniu
  // wymaga produktu z katalogu (validateIncoming) — z ofertą BL padłoby jako BLAD. Zawsze BL_INNE, niezależnie od
  // tego, czy w rejestrze pojawi się adapter `manual.v1`.
  if (channel !== 'BL_INNE' && channel !== 'RECZNE' && registry.get(adapterKey)) {
    return {
      channel,
      channelAccountId: accountId,
      name: nazwa || `${channel} ${accountId}`,
      adapterKey,
      blStorageId: channel === 'WOO' ? `shop_${accountId}` : null,
      zrodlo: { typ, id },
      maAdapter: true,
      pominiete,
      ostrzezenie: null,
    }
  }
  return {
    channel: 'BL_INNE',
    channelAccountId: `${typ}:${id}`,
    name: `BL: ${nazwa || typ}`,
    adapterKey: DEFAULT_CHANNEL_ADAPTER.BL_INNE,
    blStorageId: null,
    zrodlo: { typ, id },
    maAdapter: !!registry.get(DEFAULT_CHANNEL_ADAPTER.BL_INNE),
    pominiete,
    ostrzezenie: `źródło „${typ}” bez adaptera w Kompletorze — konto BL_INNE: zamówienia przejdą, ale kanał obsługuje dalej BL`,
  }
}

export interface PlanujWejscie {
  konfiguracja: BlKonfiguracja
  katalog?: string
  mapa?: MapaCzlowieka
  /** Zamówienia już po parserze (bez danych osobowych): otwarte i ostatnie. */
  zamowienia: BlZamowienie[]
  registry: Pick<AdapterRegistry, 'get'>
}

export function planuj(w: PlanujWejscie): PlanKonfiguracji {
  const mapa = w.mapa ?? PUSTA_MAPA
  const k = w.konfiguracja
  const ostrzezenia: string[] = []

  // Katalog: jeden — bierzemy; wiele — wymagane --katalog.
  let katalog: PlanKonfiguracji['katalog'] = null
  let bladKatalogu: string | null = null
  const wybrany = w.katalog ? k.katalogi.find((x) => x.id === w.katalog) : k.katalogi.length === 1 ? k.katalogi[0] : undefined
  if (w.katalog && !wybrany) bladKatalogu = `katalogu ${w.katalog} nie ma w BL (są: ${k.katalogi.map((x) => x.id).join(', ') || 'brak'})`
  else if (!wybrany && k.katalogi.length > 1) bladKatalogu = `w BL jest ${k.katalogi.length} katalogów (${k.katalogi.map((x) => `${x.id} „${x.nazwa}”`).join(', ')}) — wskaż jeden: --katalog <id>`
  else if (!wybrany) bladKatalogu = 'BL nie zwrócił żadnego katalogu (getInventories)'
  if (wybrany) {
    const grupaCen = wybrany.domyslnaGrupaCen ?? k.grupyCen[0]?.id ?? ''
    if (!wybrany.domyslnaGrupaCen) ostrzezenia.push('katalog bez domyślnej grupy cen — ceny z pierwszej grupy BL')
    const magazynStanu = wybrany.domyslnyMagazyn ?? wybrany.magazyny[0] ?? k.magazyny.find((m) => m.domyslny)?.id ?? null
    if (wybrany.magazyny.length > 1) ostrzezenia.push(`katalog ma ${wybrany.magazyny.length} magazyny BL — stan startowy z „${magazynStanu ?? '?'}” (domyślny)`)
    katalog = { ...wybrany, grupaCen, magazynStanu }
  }

  // Konta: źródła z getOrderSources + źródła widziane w zamówieniach (BL nie zawsze zwraca wszystkie).
  const shopIds = [...new Set([...k.zrodla.filter((z) => z.typ === 'shop').map((z) => z.id), ...w.zamowienia.filter((o) => o.order_source === 'shop').map((o) => o.order_source_id)])]
  const konta = new Map<string, KontoPlan>()
  const dodaj = (typ: string, id: string, nazwa: string) => {
    const key = `${typ}:${id}`
    if (!konta.has(key)) konta.set(key, kontoDlaZrodla(typ, id, nazwa, shopIds, w.registry, mapa))
  }
  for (const z of k.zrodla) dodaj(z.typ, z.id, z.nazwa)
  for (const o of w.zamowienia) dodaj(o.order_source, o.order_source_id, '')
  const kontaList = [...konta.values()]
  const empik = kontaList.filter((x) => x.channel === 'EMPIK' && !x.pominiete)
  if (empik.length > 1) ostrzezenia.push(`${empik.length} konta Empik — import katalogu rozróżnia jedno (pierwsze: ${empik[0]!.channelAccountId})`)
  for (const x of kontaList) if (x.channel === 'WOO' && !k.magazynyZewnetrzne.some((m) => m.id === x.blStorageId)) ostrzezenia.push(`sklep ${x.name}: BL nie pokazuje magazynu ${x.blStorageId} — oferty sklepu nie zostaną pobrane`)

  // Statusy.
  const statusy = mapaStatusow(k.statusy, mapa)

  // Przewoźnicy: tylko metody widziane w zamówieniach (otwartych i ostatnich).
  const reguly: PlanKonfiguracji['reguly'] = []
  const decyzjePrzewoznikow: DecyzjaPrzewoznika[] = []
  const kontoZam = (o: BlZamowienie) => konta.get(`${o.order_source}:${o.order_source_id}`)
  if (w.zamowienia.some((o) => kontoZam(o)?.channel === 'ALLEGRO')) {
    // moduł wysyłki bez klucza API Allegro: BRAK (podłączenie „Wysyłam z Allegro” to osobny krok człowieka)
    reguly.push({ priority: 10, channel: 'ALLEGRO', pattern: null, carrier: 'ALLEGRO', shippingModule: 'BRAK', adapterKey: null, metoda: null, pewnosc: 'PEWNE' })
  }
  const metody = new Map<string, { metoda: string; zamowien: number }>()
  for (const o of w.zamowienia) {
    if (kontoZam(o)?.channel === 'ALLEGRO' || !o.delivery_method) continue
    const key = o.delivery_method.toLowerCase()
    const cur = metody.get(key) ?? { metoda: o.delivery_method, zamowien: 0 }
    cur.zamowien++
    metody.set(key, cur)
  }
  let prio = 100
  for (const { metoda, zamowien } of [...metody.values()].sort((a, b) => b.zamowien - a.zamowien || a.metoda.localeCompare(b.metoda))) {
    const norm = bezOgonkow(metoda)
    const decyzja = mapa.przewoznicy[norm]
    const hit = PRZEWOZNICY.find((p) => p.re.test(norm))
    const pattern = `^${escapeRe(metoda)}$`
    if (pattern.length > 200) {
      decyzjePrzewoznikow.push({ metoda, zamowien, podpowiedz: hit?.carrier ?? null, powod: 'nazwa metody dłuższa niż 200 znaków — regułę trzeba dodać ręcznie' })
      continue
    }
    const carrier = decyzja ?? (hit?.pewne ? hit.carrier : null)
    if (!carrier) {
      decyzjePrzewoznikow.push({ metoda, zamowien, podpowiedz: hit?.carrier ?? null, powod: hit ? `${hit.opis} — do potwierdzenia` : 'nieznany przewoźnik — do decyzji' })
      continue
    }
    const rule = { priority: prio, channel: null, pattern, carrier, shippingModule: 'BRAK' as const, adapterKey: null, metoda, pewnosc: decyzja ? ('DECYZJA' as const) : ('PEWNE' as const) }
    validateCarrierRule(rule)
    reguly.push(rule)
    prio += 10
  }
  return { katalog, bladKatalogu, konta: kontaList, statusy, reguly, decyzjePrzewoznikow, ostrzezenia }
}

/** Mapa kanałów dla importu katalogu (ChannelMap) z planu kont — zamiast konfiguracji firmy z bazy. */
export function channelMapZPlanu(plan: Pick<PlanKonfiguracji, 'konta'>): ChannelMap {
  const aktywne = plan.konta.filter((k) => !k.pominiete)
  return {
    shopAccounts: aktywne.filter((k) => k.channel === 'WOO').map((k) => k.channelAccountId),
    empikAccountId: aktywne.find((k) => k.channel === 'EMPIK')?.channelAccountId ?? null,
    names: Object.fromEntries(aktywne.map((k) => [`${k.channel}|${k.channelAccountId}`, k.name])),
  }
}

/** Konto planu dla zamówienia BL (po źródle). */
export function kontoZamowienia(plan: Pick<PlanKonfiguracji, 'konta'>, o: Pick<BlZamowienie, 'order_source' | 'order_source_id'>): KontoPlan | undefined {
  return plan.konta.find((k) => k.zrodlo.typ === o.order_source && k.zrodlo.id === o.order_source_id)
}
