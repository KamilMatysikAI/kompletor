// Ekran „Publikacja” (Etap 3a): część z bazą i kanałem. Konta firmy (Allegro, Empik, sklep Woo) jako
// `KontoPublikacji`, produkt Kompletora jako `ProduktDoOferty`, podgląd przez adapter konta (publiczny odczyt
// `odczytDoOfert`, tylko GET z listy ścieżek) i wystawienie przez `zapisOfert` adaptera (osobny wyłącznik konta
// `wystawianieOfertWlaczone`, sprawdzany tu, w lib/oferty/wystawianie.ts i w samym adapterze).
// Konto bez połączenia (brak kluczy, zła konfiguracja) i firma bez kont dostają podgląd z samych danych produktu.
import type { PrismaClient } from '@prisma/client'
import { createAccountAdapter, loadChannelAccounts, type ChannelAccountSettings } from '@/lib/adaptery/konta'
import { type AdapterContext, type ChannelAdapter, WYSTAWIANIE_OFERT_KLUCZ, wystawianieOfertWlaczone } from '@/lib/adaptery/kontrakt'
import type { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { stanAllegro } from '@/lib/kanaly/allegro-autoryzacja'
import { kodKonta, parseKodKonta, type KontoRef } from '@/lib/kanaly/konta'
import { PowiazaniaError, powiazZOferta } from '@/lib/produkty/powiazania'
import type { SecretSource } from '@/lib/sekrety'
import type { AllegroGet } from '@/lib/zrodla/allegro'
import type { FetchLike } from '@/lib/zrodla/http'
import type { MiraklGet } from '@/lib/zrodla/mirakl'
import type { WooGet } from '@/lib/zrodla/woo'
import { przygotujPodgladAllegro, zrodloAllegroZApi, type ZrodloAllegroOfert } from './allegro-podglad'
import { przygotujPodgladEmpik, zrodloEmpikZApi, type ZrodloEmpikOfert } from './empik-podglad'
import { produktDoOferty } from './produkt-z-bazy'
import { KANAL_OFERT, kafelZPodgladu, ofertaDoPowiazania, type KafelPublikacji, type KanalOferty, type KontoPublikacji, NAZWA_KANALU, type PodgladKanalu, type WyborReczny } from './publikacja'
import type { ProduktDoOferty } from './typy'
import { ustawieniaOfertZSettings, type UstawieniaOfertKanalow } from './ustawienia'
import { przygotujPodgladWoo, zrodloWooZApi, type ZrodloWooOfert } from './woo-podglad'
import type { ZaleznosciPrzebiegu } from './masowo'
import { wystawOferteAllegro, wystawOferteEmpik, wystawProduktWoo, type WynikWystawienia, type WyslijZapis } from './wystawianie'

export interface ZaleznosciPublikacji {
  registry: AdapterRegistry
  src: SecretSource
  fetch?: FetchLike
  http?: AdapterContext['http']
  /** Zakres ofert konta Allegro (testy); domyślnie z autoryzacji konta (`stanAllegro`). */
  zakresOfertAllegro?: (acc: ChannelAccountSettings) => Promise<boolean | null>
}

const tekst = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Konto kanału → konto ekranu (bez sieci poza odczytem zakresu Allegro z zapisanych kluczy). */
export function kontoPublikacji(acc: ChannelAccountSettings, kanal: KanalOferty, registry: AdapterRegistry, zakresOfert: boolean | null): KontoPublikacji {
  const manifest = registry.get(acc.adapterKey)?.manifest ?? null
  return {
    kod: kodKonta({ channel: acc.channel, channelAccountId: acc.channelAccountId }),
    kanal,
    nazwa: acc.name,
    aktywne: acc.active && !acc.wylaczonePoBledach,
    zZapisem: !!manifest && !manifest.readOnly && manifest.config.some((f) => f.key === WYSTAWIANIE_OFERT_KLUCZ),
    wystawianieWlaczone: wystawianieOfertWlaczone(acc.config),
    zakresOfert: kanal === 'allegro' ? zakresOfert : null,
    cennikDostawId: tekst(acc.config['cennikDostawId']),
    zwrotyId: tekst(acc.config['zwrotyId']),
    reklamacjeId: tekst(acc.config['reklamacjeId']),
    bezPolaczenia: false,
  }
}

/** Kafel bez konta (firma nie ma żadnego konta Allegro, Empiku ani sklepu): podgląd z danych produktu. */
export const kontoBezKonta = (kanal: KanalOferty): KontoPublikacji => ({
  kod: null,
  kanal,
  nazwa: NAZWA_KANALU[kanal],
  aktywne: false,
  zZapisem: false,
  wystawianieWlaczone: false,
  zakresOfert: null,
  cennikDostawId: null,
  zwrotyId: null,
  reklamacjeId: null,
  bezPolaczenia: true,
})

async function zakresDomyslny(db: PrismaClient, acc: ChannelAccountSettings, src: SecretSource): Promise<boolean | null> {
  try {
    const st = await stanAllegro(db, { channel: acc.channel, channelAccountId: acc.channelAccountId }, src)
    return st.funkcje ? st.funkcje.includes('zapisStanow') : null
  } catch {
    return null
  }
}

/**
 * Konta ekranu „Publikacja”: konta Allegro, Empiku i sklepów Woo firmy (także wyłączone, z powodem przy „Wystaw”).
 * Firma bez żadnego z nich dostaje trzy kafle bez konta (podgląd z danych produktu, np. firma demonstracyjna).
 */
export async function kontaPublikacji(db: PrismaClient, deps: ZaleznosciPublikacji): Promise<{ konto: KontoPublikacji; acc: ChannelAccountSettings | null }[]> {
  const all = (await loadChannelAccounts(db, { activeOnly: false })).filter((a) => KANAL_OFERT[a.channel])
  if (!all.length) return (['woo', 'allegro', 'empik'] as const).map((k) => ({ konto: kontoBezKonta(k), acc: null }))
  const out: { konto: KontoPublikacji; acc: ChannelAccountSettings | null }[] = []
  for (const acc of all) {
    const kanal = KANAL_OFERT[acc.channel]!
    const zakres = kanal === 'allegro' ? await (deps.zakresOfertAllegro ? deps.zakresOfertAllegro(acc) : zakresDomyslny(db, acc, deps.src)) : null
    out.push({ konto: kontoPublikacji(acc, kanal, deps.registry, zakres), acc })
  }
  const kolej: Record<KanalOferty, number> = { woo: 0, allegro: 1, empik: 2 }
  return out.sort((a, b) => kolej[a.konto.kanal] - kolej[b.konto.kanal] || a.konto.nazwa.localeCompare(b.konto.nazwa, 'pl'))
}

/** Produkt Kompletora do oferty: karta, zdjęcia (kolejność z karty), dostępny stan (fizyczny minus rezerwacje). */
export async function produktDoPublikacji(db: PrismaClient, productId: string): Promise<ProduktDoOferty | null> {
  const p = await db.product.findFirst({ where: { id: productId }, select: { id: true, sku: true, title: true, ean: true, description: true, weightG: true, priceGross: true, details: true } })
  if (!p) return null
  const [zdjecia, stany] = await Promise.all([
    db.productImage.findMany({ where: { productId }, select: { id: true, position: true, sourceUrl: true } }),
    db.stock.findMany({ where: { productId }, select: { physical: true, reserved: true } }),
  ])
  const stan = Math.max(0, stany.reduce((s, x) => s + x.physical - x.reserved, 0))
  return produktDoOferty(p, zdjecia, { stan })
}

export async function ustawieniaOfertFirmy(db: PrismaClient): Promise<UstawieniaOfertKanalow> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  return ustawieniaOfertZSettings(org?.settings ?? null)
}

// ─── Źródła kanału (odczyt) ──────────────────────────────────────────────────

const bezPolaczenia = () => Promise.reject(new Error('brak połączenia z kontem'))
export const ZRODLO_ALLEGRO_BEZ_POLACZENIA: ZrodloAllegroOfert = { kategoria: bezPolaczenia, dopasujKategorie: bezPolaczenia, produktyPoEan: bezPolaczenia, parametryKategorii: bezPolaczenia, sciezkaKategorii: bezPolaczenia }
export const ZRODLO_EMPIK_BEZ_POLACZENIA: ZrodloEmpikOfert = { produktyPoEan: bezPolaczenia }
export const ZRODLO_WOO_BEZ_POLACZENIA: ZrodloWooOfert = { kategorie: bezPolaczenia, produktPoSku: bezPolaczenia }

type OdczytAdaptera = { odczytDoOfert: (...a: never[]) => Promise<unknown> }
type ZapisAdaptera = { zapisOfert: WyslijZapis }
export const maOdczytOfert = (a: ChannelAdapter | null): a is ChannelAdapter & OdczytAdaptera => !!a && typeof (a as Partial<OdczytAdaptera>).odczytDoOfert === 'function'
export const maZapisOfert = (a: ChannelAdapter | null): a is ChannelAdapter & ZapisAdaptera => !!a && typeof (a as Partial<ZapisAdaptera>).zapisOfert === 'function'

/** Odczyt adaptera jako funkcja GET danego kanału (wywołanie przez obiekt: osłona adaptera i `this`). */
function getAllegro(a: ChannelAdapter & OdczytAdaptera): AllegroGet {
  const x = a as unknown as { odczytDoOfert: AllegroGet }
  return (path, query) => x.odczytDoOfert(path, query)
}
function getMirakl(a: ChannelAdapter & OdczytAdaptera): MiraklGet {
  const x = a as unknown as { odczytDoOfert: MiraklGet }
  return (path, query) => x.odczytDoOfert(path, query)
}
function getWoo(a: ChannelAdapter & OdczytAdaptera): WooGet {
  const x = a as unknown as { odczytDoOfert: WooGet }
  return (path, query) => x.odczytDoOfert(path, query)
}

async function adapterKonta(db: PrismaClient, acc: ChannelAccountSettings | null, deps: ZaleznosciPublikacji): Promise<ChannelAdapter | null> {
  if (!acc || !acc.active || acc.wylaczonePoBledach) return null
  try {
    return await createAccountAdapter(db, deps.registry, acc, deps.src, { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.http ? { http: deps.http } : {}) })
  } catch {
    return null // brak kluczy albo zła konfiguracja: podgląd z danych produktu (powód w kaflu)
  }
}

async function podgladKanalu(kanal: KanalOferty, produkt: ProduktDoOferty, adapter: ChannelAdapter | null, ustawienia: UstawieniaOfertKanalow, reczne?: WyborReczny): Promise<PodgladKanalu> {
  const odczyt = maOdczytOfert(adapter) ? adapter : null
  if (kanal === 'allegro') return przygotujPodgladAllegro({ produkt, recznaKategoriaId: reczne?.kategoriaId ?? null, reczneParametry: reczne?.parametry ?? {} }, odczyt ? zrodloAllegroZApi(getAllegro(odczyt)) : ZRODLO_ALLEGRO_BEZ_POLACZENIA, ustawienia)
  if (kanal === 'empik') return przygotujPodgladEmpik({ produkt }, odczyt ? zrodloEmpikZApi(getMirakl(odczyt)) : ZRODLO_EMPIK_BEZ_POLACZENIA, ustawienia)
  return przygotujPodgladWoo({ produkt }, odczyt ? zrodloWooZApi(getWoo(odczyt)) : ZRODLO_WOO_BEZ_POLACZENIA, ustawienia)
}

/** Komunikat dla kafla, gdy z kontem nie da się połączyć (bez treści błędu: mogłaby nieść fragment klucza). */
const PROBLEM_BEZ_POLACZENIA = { kod: 'konto_bez_polaczenia', waga: 'ostrzezenie' as const, komunikat: 'Nie udało się połączyć z kontem kanału (brak kluczy, konto wyłączone albo zła konfiguracja): podgląd powstał z samych danych produktu, bez sprawdzenia katalogu i kategorii kanału.' }

export interface KontekstPublikacji {
  produkt: ProduktDoOferty
  konto: KontoPublikacji
  acc: ChannelAccountSettings | null
  adapter: ChannelAdapter | null
  podglad: PodgladKanalu
  ustawienia: UstawieniaOfertKanalow
}

/**
 * (3b-2, pkt 4): pamięć jednego przebiegu masowego. Lista kont (z odczytem zakresu Allegro), ustawienia ofert
 * i adapter każdego konta powstają raz na przebieg, a nie dla każdej pary produkt × konto. Tylko na czas jednego zadania
 * w tle: ekran „Publikacja” liczy zawsze od nowa (zmiana ustawień widoczna od razu).
 */
export interface PamiecPrzebiegu {
  konta?: Promise<{ konto: KontoPublikacji; acc: ChannelAccountSettings | null }[]>
  ustawienia?: Promise<UstawieniaOfertKanalow>
  adaptery: Map<string, Promise<ChannelAdapter | null>>
}

export const nowaPamiecPrzebiegu = (): PamiecPrzebiegu => ({ adaptery: new Map() })

function kontaZPamieci(db: PrismaClient, deps: ZaleznosciPublikacji, pamiec?: PamiecPrzebiegu) {
  if (!pamiec) return kontaPublikacji(db, deps)
  return (pamiec.konta ??= kontaPublikacji(db, deps))
}

function adapterZPamieci(db: PrismaClient, klucz: string, acc: ChannelAccountSettings | null, deps: ZaleznosciPublikacji, pamiec?: PamiecPrzebiegu): Promise<ChannelAdapter | null> {
  if (!pamiec) return adapterKonta(db, acc, deps)
  let a = pamiec.adaptery.get(klucz)
  if (!a) pamiec.adaptery.set(klucz, (a = adapterKonta(db, acc, deps)))
  return a
}

/** Podgląd na jednym koncie (`klucz` = kod konta albo `brak:<kanał>`); null = nie ma produktu albo konta. */
export async function kontekstPublikacji(db: PrismaClient, productId: string, klucz: string, deps: ZaleznosciPublikacji, pamiec?: PamiecPrzebiegu, reczne?: WyborReczny): Promise<KontekstPublikacji | null> {
  const produkt = await produktDoPublikacji(db, productId)
  if (!produkt) return null
  const konta = await kontaZPamieci(db, deps, pamiec)
  const ref = klucz.startsWith('brak:') ? null : parseKodKonta(klucz)
  const wpis = konta.find((k) => (ref ? k.konto.kod === klucz : k.konto.kod === null && `brak:${k.konto.kanal}` === klucz))
  if (!wpis) return null
  const ustawienia = await (pamiec ? (pamiec.ustawienia ??= ustawieniaOfertFirmy(db)) : ustawieniaOfertFirmy(db))
  const adapter = await adapterZPamieci(db, klucz, wpis.acc, deps, pamiec)
  const konto = wpis.acc && !maOdczytOfert(adapter) ? { ...wpis.konto, bezPolaczenia: true } : wpis.konto
  const podglad = await podgladKanalu(konto.kanal, produkt, adapter, ustawienia, reczne)
  if (konto.bezPolaczenia && konto.kod) podglad.problemy.unshift(PROBLEM_BEZ_POLACZENIA)
  return { produkt, konto, acc: wpis.acc, adapter, podglad, ustawienia }
}

/**
 * (pkt 3): zależności zadania „Przygotuj oferty” — te same konta i ten sam kafel co ekran Publikacja.
 * Pkt 4: jedna pamięć na przebieg (konta, ustawienia, adaptery raz), więc odczyty konfiguracji nie rosną z liczbą produktów.
 */
export function zaleznosciPrzebieguOfert(db: PrismaClient, deps: ZaleznosciPublikacji, pamiec: PamiecPrzebiegu = nowaPamiecPrzebiegu()): ZaleznosciPrzebiegu {
  return {
    konta: async () => (await kontaZPamieci(db, deps, pamiec)).map((k) => ({ klucz: k.konto.kod ?? `brak:${k.konto.kanal}`, kanal: k.konto.kanal })),
    podglad: (productId, klucz) => kafelPublikacji(db, productId, klucz, deps, pamiec),
  }
}

/** Kafel ekranu dla konta (akcja serwera „Przygotuj podgląd”; w przebiegu masowym z pamięcią przebiegu). */
export async function kafelPublikacji(db: PrismaClient, productId: string, klucz: string, deps: ZaleznosciPublikacji, pamiec?: PamiecPrzebiegu, reczne?: WyborReczny): Promise<KafelPublikacji | null> {
  const k = await kontekstPublikacji(db, productId, klucz, deps, pamiec, reczne)
  return k ? kafelZPodgladu(k.konto, k.podglad, reczne) : null
}

/**
 * „Wystaw” na koncie: podgląd liczony od nowa (ekran mógł pokazać stan sprzed chwili), te same powody blokady co
 * w kaflu, potem funkcja wystawiania kanału z transportem adaptera. Nic nie wychodzi bez włączonego przełącznika.
 */
export async function wystawNaKoncie(db: PrismaClient, productId: string, klucz: string, deps: ZaleznosciPublikacji, actorId?: string, reczne?: WyborReczny): Promise<WynikWystawienia> {
  const w = await wystawBezPowiazania(db, productId, klucz, deps, reczne)
  if (!actorId || w.kind !== 'OK') return w
  const acc = parseKodKonta(klucz)
  const kanal = acc ? KANAL_OFERT[acc.channel] : undefined
  if (!acc || !kanal) return w
  return powiazPoWystawieniu(db, kanal, acc, productId, w, actorId)
}

type Powiaz = (db: PrismaClient, w: { productId: unknown; konto: KontoRef; externalId: unknown; sztuk: unknown; actorId: string }) => Promise<{ info: string }>

/**
 * (pkt 7): po udanym wystawieniu nowa oferta wiąże się z produktem tą samą funkcją co „Powiąż z ofertą”
 * z karty produktu (`powiazZOferta`: AuditLog, przeliczenie czekających zamówień, odmowa przy ofercie
 * powiązanej z innym produktem). Wynik wystawienia zostaje OK także wtedy, gdy powiązanie się nie uda: oferta już
 * jest w kanale, a komunikat mówi, gdzie powiązać ją ręcznie. Przelicznik 1 (jedna sztuka oferty = jedna produktu).
 */
export async function powiazPoWystawieniu(db: PrismaClient, kanal: KanalOferty, konto: KontoRef, productId: string, w: WynikWystawienia, actorId: string, powiaz: Powiaz = powiazZOferta): Promise<WynikWystawienia> {
  const ext = ofertaDoPowiazania(kanal, w)
  if (w.kind !== 'OK' || !ext) return w
  const reczne = 'Powiąż ją ręcznie: karta produktu → Powiązania → „Powiąż z ofertą”.'
  try {
    const r = await powiaz(db, { productId, konto, externalId: ext, sztuk: '1', actorId })
    return { ...w, komunikat: `${w.komunikat} Powiązanie z produktem: ${r.info}` }
  } catch (e) {
    if (e instanceof PowiazaniaError) return { ...w, komunikat: `${w.komunikat} Nie powiązano automatycznie: ${e.message} ${reczne}` }
    console.error(`[publikacja] powiązanie po wystawieniu ${konto.channel}/${konto.channelAccountId}: ${e instanceof Error ? e.name : 'błąd'}`)
    return { ...w, komunikat: `${w.komunikat} Nie udało się powiązać oferty z produktem. ${reczne}` }
  }
}

async function wystawBezPowiazania(db: PrismaClient, productId: string, klucz: string, deps: ZaleznosciPublikacji, reczne?: WyborReczny): Promise<WynikWystawienia> {
  const k = await kontekstPublikacji(db, productId, klucz, deps, undefined, reczne)
  if (!k) return { kind: 'TRWALY', komunikat: 'Nie ma takiego produktu albo konta.' }
  const kafel = kafelZPodgladu(k.konto, k.podglad, reczne)
  if (!kafel.wystaw.mozna) return { kind: k.konto.wystawianieWlaczone ? 'NIEGOTOWA' : 'WYLACZONE', komunikat: kafel.wystaw.powody.join(' ') }
  const a = k.adapter
  if (!maOdczytOfert(a) || !maZapisOfert(a)) return { kind: 'TRWALY', komunikat: 'To konto nie wystawia ofert: przełącz je na wersję z zapisem.' }
  const wyslij: WyslijZapis = (m, s, c, q) => a.zapisOfert(m, s, c, q)
  const wlaczone = wystawianieOfertWlaczone(k.acc?.config ?? {})
  const p = k.podglad
  if (p.kanal === 'allegro')
    return wystawOferteAllegro(p, k.produkt.sku, { wystawianieOfertWlaczone: wlaczone, wyslij, odczyt: getAllegro(a) }, { cennikDostawId: k.konto.cennikDostawId, zwrotyId: k.konto.zwrotyId, reklamacjeId: k.konto.reklamacjeId })
  if (p.kanal === 'empik') return wystawOferteEmpik(p, { wystawianieOfertWlaczone: wlaczone, wyslij, odczyt: zrodloEmpikZApi(getMirakl(a)) })
  return wystawProduktWoo(p, { wystawianieOfertWlaczone: wlaczone, wyslij, odczyt: zrodloWooZApi(getWoo(a)) })
}

