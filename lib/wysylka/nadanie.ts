// Host przesyłek (z luk wobec BL): utworzenie przesyłki u przewoźnika z gabarytem, numer nadania, prawdziwa
// etykieta i „Do wysłania”. JEDYNE miejsce poza adapterami, które woła `createShipment` i `getLabel` (strażniki w
// lib/adaptery/dpd.test.ts i inpost.test.ts).
//
// Bramki (każda z powodem dla ekranu, przycisk zostaje widoczny):
//   1. zamówienie dotyczy przesyłki (nie anulowane, nie odbiór osobisty, ma przewoźnika) i jest w statusie nadania;
//   2. konto kanału w trybie PRACA na instancji z EKRANY_PRACA=1 (konto w cieniu nadaje BaseLinker: druga przesyłka
//      z Kompletora byłaby podwójną, płatną etykietą);
//   3. reguła przewoźnika wskazuje adapter z `shipment.create` (wersja „zapis”), z `zapisWlaczony: true` w konfiguracji.
//
// Idempotencja: wiersz Shipment (TWORZENIE) powstaje PRZED wywołaniem przewoźnika, pod blokadą zamówienia, a indeks
// częściowy pozwala na jedną aktywną przesyłkę paczki. Podwójne kliknięcie (także równoległe) widzi wiersz i nie woła
// przewoźnika drugi raz. Referencja (klucz idempotencji u przewoźnika) jest deterministyczna i ta sama przy ponowieniu
// po odmowie. Wynik przez `executeWrite`: NIEJEDNOZNACZNY = odszukanie po referencji, a bez rozstrzygnięcia przesyłka
// zostaje NIEJEDNOZNACZNA z alertem i przyciskami „Sprawdź u przewoźnika” i „Rozstrzygnij ręcznie” (nigdy ślepe
// ponowienie = druga etykieta). Każdy zapis stanu ma warunek na stan: UTWORZONA i ANULOWANA
// są ostateczne, więc spóźniony wynik ani drugie „Sprawdź” nie cofają przesyłki i nie dublują zdarzeń.
//
// Dane odbiorcy: z `odbiorcaPrzesylki` (lib/klienci/wejscia.ts, ślad w dzienniku podglądów), tylko w pamięci. Etykieta
// (ma adres) w bazie wyłącznie zaszyfrowana (lib/klienci/etykieta.ts). Komunikaty i alerty bez danych klienta.
import { statusyKuriera } from './status-kuriera'
import type { Carrier, OrderStatus, Prisma, PrismaClient, Shipment, ShipmentState, ShippingModule } from '@prisma/client'
import { appModeOf } from '@/lib/organizacje'
import { defaultRegistry } from '../adaptery/domyslne'
import { AdapterError, hasReferenceFinder, hasShipmentCanceller, hasShipmentCreator, type ChannelAdapter, type LabelFormat, type PotwierdzenieRecznego, type ShipmentCreator, type WriteOutcome } from '../adaptery/kontrakt'
import { AdapterConfigError, deriveReference, type AdapterRegistry } from '../adaptery/rejestr'
import { executeWrite } from '../adaptery/zapis'
import { organizationIdOf } from '../db'
import { ETYKIETA_USUNIETA, zaszyfrujEtykiete } from '../klienci/etykieta'
import { BladSzyfruKlienta, KOMUNIKAT_BRAK_KLUCZA } from '../klienci/szyfr'
import { odbiorcaPrzesylki } from '../klienci/wejscia'
import { wersjaRekorduKlienta } from '../klienci/zapis'
import { BladOdczytuOdbiorcy, BrakZamowieniaOdbiorcy, OdmowaOdczytuOdbiorcy } from '../odbiorca/pobierz'
import { kontoZamowienia, pracaDostepna } from '../praca/wlacznik'
import { moveOrder } from '../rdzen/przejscia'
import { kluczBlokadyPrzesylki } from '../rdzen/brakuje'
import { regulaDlaZamowienia } from '../rdzen/przewoznicy'
import { flagsOf } from '../rdzen/rezerwacja'
import { advisoryLock, alert, runTx } from '../rdzen/stan'
import { TransitionError } from '../rdzen/statusy'
import type { Env, SecretSource } from '../sekrety'
import { GABARYTY, gabarytyDla, type Gabaryt } from '../stanowisko/gabaryty'
import { wczytajZamowienia, type ZamowienieStanowiska } from '../stanowisko/zamowienia'
import type { FetchLike } from '../zrodla/http'
import { adapterPrzewoznika, kluczReguly, kontoReguly, type RegulaNadania } from './adapter-przewoznika'
import { automatyWysylki } from './automaty'
import { createWysylamAdapter, WYSYLAM_KEY_RE } from './allegro-konto'
import { paczkaDodatkowej, STATUSY_DODATKOWEJ, walidujDodatkowa } from './dodatkowa'
import { powodNieDotyczy, przesylkaDoNadania } from './podglad'
import { linkSledzeniaPanelu } from './link-sledzenia'
import { zglosNumerNadania } from './zdarzenia'
import { odciskReferencji } from './zlecenie-orlenpaczka'
import { odciskGls } from './gls'

type Db = PrismaClient

export interface DepsNadania {
  registry?: AdapterRegistry
  secrets?: SecretSource
  fetch?: FetchLike
  now?: () => Date
  env?: Env
  /** Strojenie klienta przewoźnika (testy: odpytywanie komend Allegro bez czekania). */
  http?: { pollDelayMs?: number; minIntervalMs?: number }
  /** Tylko testy wyścigów: wołane po odczycie odbiorcy, przed rezerwacją przesyłki (np. zmiana sposobu wysyłki w tym oknie). */
  poOdczycieOdbiorcy?: () => Promise<void>
}

const AKTYWNE = ['TWORZENIE', 'UTWORZONA', 'NIEJEDNOZNACZNA'] as const
/** Stany, z których wynik przewoźnika (albo człowieka) wolno jeszcze zapisać; UTWORZONA i ANULOWANA są ostateczne. */
const NIEROZSTRZYGNIETE: ShipmentState[] = ['TWORZENIE', 'NIEJEDNOZNACZNA']
export const STATUSY_NADANIA: readonly OrderStatus[] = ['DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA']
/**
 * TWORZENIE dłużej niż próg = proces mógł paść w połowie: ekran pokazuje „Sprawdź u przewoźnika”. Próg jest powyżej
 * najgorszego czasu oryginalnego wywołania przewoźnika, żeby „Sprawdź” nie ścigało się z żywym wywołaniem.
 * Próg per moduł z manifestu (`shipmentMaxCreateMs` +
 * `MARGINES_ZAWIESZENIA_MS`), nie niższy niż domyślny. Domyślny 4 min: InPost i DPD mają najwyżej 3 min (zapis 60 s
 * + odszukanie 60 s + numer nadania 60 s), Base Courier ok. 3 min (jedno żądanie 60 s + szczegóły 60 s +
 * lista zamówień do 3 × 20 s). Wysyłam z Allegro deklaruje `NAJDLUZSZE_UTWORZENIE_MS` (ok. 12 min,
 * lib/adaptery/allegro-wysylam-zapis.ts). Zapisy stanu i tak mają warunek na stan, więc wyścig daje najwyżej zbędne odszukanie.
 */
export const TWORZENIE_ZAWIESZONE_MS = 4 * 60_000
/** Zapas nad najgorszym czasem żywego wywołania deklarowanym w manifeście modułu przewoźnika. */
export const MARGINES_ZAWIESZENIA_MS = 60_000

/** Próg „Sprawdź u przewoźnika” dla przesyłki w TWORZENIE, po module (manifest z rejestru, bez sekretów i sieci). */
export function progZawieszenia(adapterKey: string, registry: AdapterRegistry = defaultRegistry()): number {
  const max = registry.get(adapterKey)?.manifest.shipmentMaxCreateMs
  return typeof max === 'number' && Number.isFinite(max) && max > 0 ? Math.max(TWORZENIE_ZAWIESZONE_MS, max + MARGINES_ZAWIESZENIA_MS) : TWORZENIE_ZAWIESZONE_MS
}

const zawieszonaPrzesylka = (s: Pick<Shipment, 'state' | 'updatedAt' | 'adapterKey'>, now: Date, registry?: AdapterRegistry) =>
  s.state === 'TWORZENIE' && now.getTime() - s.updatedAt.getTime() > progZawieszenia(s.adapterKey, registry)
export const ALERT_PRZESYLKI = 'PRZESYLKA_NIEJEDNOZNACZNA'
/** Zdarzenie zamówienia „dodano przesyłkę dodatkową” (bez mapowania w automatach i bez pola `nadanie`). */
export const PRZESYLKA_DODATKOWA = 'PRZESYLKA_DODATKOWA'
/** Wpis AuditLog ręcznego rozstrzygnięcia przesyłki niejednoznacznej: kto, kiedy, wariant. */
export const ROZSTRZYGNIECIE_AUDIT = 'PRZESYLKA_ROZSTRZYGNIECIE'
type Tx = Prisma.TransactionClient

const envDeps = (d: DepsNadania): Env => d.env ?? d.secrets?.env ?? process.env
const zrodloSekretow = (d: DepsNadania): SecretSource => d.secrets ?? { env: envDeps(d), envFallback: appModeOf(envDeps(d)) === 'self-host' }
const teraz = (d: DepsNadania) => (d.now ?? (() => new Date()))()
// 1000 znaków, bo odszukanie Orlen Paczki podaje listę sprawdzonych paczek z godzinami
const krotko = (m: string) => m.replace(/\s+/g, ' ').slice(0, 1000)

// ─── Bramki ──────────────────────────────────────────────────────────────────

export interface BramkaNadania {
  /** null = wolno kliknąć „Utwórz przesyłkę”; inaczej powód dla ekranu. */
  powod: string | null
  /** Przesyłka w ogóle nie dotyczy zamówienia (blok przycisków znika). */
  nieDotyczy: boolean
  gabaryty: { kod: Gabaryt; nazwa: string }[]
  carrier: Carrier | null
  regula: (RegulaNadania & { adapterKey: string }) | null
  /** Nazwa przewoźnika z manifestu adaptera (do przycisku). */
  modul: string | null
}

/** Reguła przewoźnika zamówienia z ustawieniami (wybór: `regulaDlaZamowienia`, lib/rdzen/przewoznicy.ts). */
async function regulaZamowienia(db: Db, z: Pick<ZamowienieStanowiska, 'channel' | 'carrier' | 'metodaDostawy' | 'shippingModule' | 'przewoznikRecznie'>): Promise<{ regula: RegulaNadania | null; powod: string | null }> {
  const rules = await db.carrierRule.findMany({ orderBy: { priority: 'asc' }, select: { id: true, priority: true, channel: true, pattern: true, carrier: true, shippingModule: true, adapterKey: true, config: true } })
  const w = regulaDlaZamowienia(rules, z)
  if (!w.regula) return { regula: null, powod: w.powod }
  const r = w.regula
  const config = r.config && typeof r.config === 'object' && !Array.isArray(r.config) ? (r.config as Record<string, unknown>) : {}
  return { regula: { id: r.id, carrier: r.carrier, shippingModule: r.shippingModule, adapterKey: r.adapterKey, config }, powod: null }
}

/**
 * adapter przewoźnika do nadania. Wysyłam z Allegro powstaje na koncie Allegro zamówienia (te same tokeny
 * co odczyt zamówień), z ustawieniami reguły przewoźnika (wyłącznik nadawania, format etykiety); pozostali przewoźnicy
 * z reguły (sekrety firmy).
 */
/** Reguła przewoźnika firmy po id (RLS: tylko własne). */
export async function regulaPoId(db: Db, id: string): Promise<RegulaNadania | null> {
  const r = await db.carrierRule.findUnique({ where: { id }, select: { id: true, carrier: true, shippingModule: true, adapterKey: true, config: true } })
  if (!r) return null
  const config = r.config && typeof r.config === 'object' && !Array.isArray(r.config) ? (r.config as Record<string, unknown>) : {}
  return { id: r.id, carrier: r.carrier, shippingModule: r.shippingModule, adapterKey: r.adapterKey, config }
}

export async function adapterNadania(db: Db, regula: RegulaNadania, orderId: string, registry: AdapterRegistry, deps: DepsNadania): Promise<ChannelAdapter> {
  const key = kluczReguly(regula)
  if (key && WYSYLAM_KEY_RE.test(key)) {
    const o = await db.order.findUnique({ where: { id: orderId }, select: { channel: true, channelAccountId: true } })
    if (!o || o.channel !== 'ALLEGRO') throw new AdapterConfigError('Wysyłam z Allegro nadaje tylko zamówienia z Allegro')
    const config: Record<string, unknown> = { zapisWlaczony: regula.config['zapisWlaczony'] === true }
    if (regula.config['formatEtykiety'] === 'ZPL' || regula.config['formatEtykiety'] === 'PDF') config['formatEtykiety'] = regula.config['formatEtykiety']
    return createWysylamAdapter(db, registry, o.channelAccountId, zrodloSekretow(deps), { fetch: deps.fetch, now: deps.now, adapterKey: key, config, ...(deps.http ? { http: deps.http } : {}) })
  }
  return adapterPrzewoznika(db, regula, registry, zrodloSekretow(deps), { fetch: deps.fetch, now: deps.now })
}

/** Tryb PRACA konta zamówienia (nadanie i anulowanie u przewoźnika): null = wolno, inaczej powód. Tylko odczyt. */
export async function bramkaTrybu(
  db: Db,
  z: { channel: import('@prisma/client').Channel; channelAccountId: string } | null,
  deps: DepsNadania,
  co: 'nadawanie' | 'anulowanie',
): Promise<string | null> {
  if (!z) return 'Nie ma takiego zamówienia.'
  const Co = co === 'nadawanie' ? 'Nadawanie' : 'Anulowanie'
  let praca: boolean
  const konto = await kontoZamowienia(db, z, envDeps(deps))
  try {
    praca = pracaDostepna(konto, envDeps(deps))
  } catch {
    return `Zła wartość EKRANY_PRACA na tej instancji: ${co} wyłączone.`
  }
  // zamówienie bez konta kanału (np. ręczne) to nie „cień”
  if (!praca && !konto) return `Zamówienie nie ma konta sprzedaży w Kompletorze: ${co} z Kompletora działa dla zamówień z aktywnego konta sprzedaży.`
  // konto w trybie PRACA, ale firma przechodzi z BaseLinkera, a instancja nie ma jeszcze włączonej pracy
  if (!praca && konto?.statusMode === 'PRACA')
    return `Firma przechodzi z BaseLinkera, a na tym serwerze Kompletora praca nie jest jeszcze włączona: ${co} z Kompletora ruszy, gdy administrator ją włączy.`
  if (!praca) return `Konto sklepu jest w trybie „Tylko podgląd”: przesyłki nadaje dziś BaseLinker. ${Co} z Kompletora działa po włączeniu konta.`
  return null
}

/** Czy i dlaczego nie wolno utworzyć przesyłki zamówienia. Tylko odczyt, bez sieci. */
export async function bramkaNadania(db: Db, orderId: string, deps: DepsNadania = {}): Promise<BramkaNadania | null> {
  organizationIdOf(db)
  const [z] = await wczytajZamowienia(db, [orderId])
  if (!z) return null
  const gabaryty = gabarytyDla(z.carrier).map((kod) => ({ kod, nazwa: GABARYTY[kod] }))
  const wynik = (powod: string | null, extra: Partial<BramkaNadania> = {}): BramkaNadania => ({ powod, nieDotyczy: false, gabaryty, carrier: z.carrier, regula: null, modul: null, ...extra })
  const nd = powodNieDotyczy({ status: z.status, carrier: z.carrier, tylkoBezStanu: z.tylkoBezStanu, liczbaPozycji: z.pozycje.length })
  if (nd) return wynik(nd, { nieDotyczy: true })
  const { regula, powod } = await regulaZamowienia(db, z)
  if (!regula) return wynik(powod)
  const key = kluczReguly(regula)
  if (!key) return wynik('Reguła przewoźnika nie ma modułu wysyłki: ustaw moduł w Ustawienia → Wysyłka i druk → Przewoźnicy.')
  const def = (deps.registry ?? defaultRegistry()).get(key)
  const modul = def?.manifest.displayName ?? key
  const zRegula = (p: string | null) => wynik(p, { regula: { ...regula, adapterKey: key }, modul })
  if (!def || !def.manifest.capabilities.includes('shipment.create') || def.manifest.readOnly)
    return zRegula(`Moduł „${modul}” tylko liczy przesyłkę, nie nadaje jej. Do nadawania z Kompletora potrzebna jest wersja modułu z tworzeniem przesyłek (Ustawienia → Wysyłka i druk → Przewoźnicy).`)
  if (WYSYLAM_KEY_RE.test(key) && z.channel !== 'ALLEGRO') return zRegula('Wysyłam z Allegro nadaje tylko zamówienia z Allegro: dla tego zamówienia ustaw innego przewoźnika w Ustawienia → Wysyłka i druk → Przewoźnicy.')
  if (!STATUSY_NADANIA.includes(z.status)) return zRegula(z.status === 'NOWE' ? 'Zamówienie czeka na płatność: przesyłkę tworzy się po opłaceniu.' : 'W tym statusie zamówienia przesyłki się nie tworzy.')
  const tryb = await bramkaTrybu(db, z, deps, 'nadawanie')
  if (tryb) return zRegula(tryb)
  if (regula.config['zapisWlaczony'] !== true)
    return zRegula(`Nadawanie przez „${modul}” jest wyłączone w ustawieniach przewoźnika. Włącza je właściciel firmy po teście na koncie testowym przewoźnika.`)
  return zRegula(null)
}

// ─── Utworzenie ──────────────────────────────────────────────────────────────

export type WynikNadania =
  | { wynik: 'UTWORZONA'; przesylka: Shipment; istniala: boolean; info: string | null }
  | { wynik: 'NIEJEDNOZNACZNA'; przesylka: Shipment; istniala: boolean }
  | { wynik: 'W_TOKU'; przesylka: Shipment }
  | { wynik: 'ODMOWA'; powod: string; doPotwierdzenia?: { kod: string; tekst: string }[] }
  | { wynik: 'BLAD'; przesylka: Shipment; powod: string }

export interface ZlecenieNadania {
  orderId: string
  gabaryt?: string | null
  /** Kody ostrzeżeń przesyłki, które człowiek świadomie przyjął (wartości robocze wymiarów, wagi). */
  potwierdzoneOstrzezenia?: readonly string[]
  /** User.id z sesji (do śladu i `requestedBy`). */
  userId: string
}

const aktywnaPaczki = (db: Db | import('@prisma/client').Prisma.TransactionClient, orderId: string, packageNo: number) =>
  db.shipment.findFirst({ where: { orderId, packageNo, extraNo: 0, state: { in: [...AKTYWNE] } }, orderBy: { createdAt: 'desc' } })

/** Wynik dla przesyłki, którą zapisał już ktoś inny (równoległe kliknięcie, „Sprawdź”, rozstrzygnięcie ręczne). */
function wynikIstniejacej(s: Shipment): WynikNadania {
  if (s.state === 'TWORZENIE') return { wynik: 'W_TOKU', przesylka: s }
  if (s.state === 'UTWORZONA') return { wynik: 'UTWORZONA', przesylka: s, istniala: true, info: null }
  if (s.state === 'NIEJEDNOZNACZNA') return { wynik: 'NIEJEDNOZNACZNA', przesylka: s, istniala: true }
  if (s.state === 'BLAD') return { wynik: 'BLAD', przesylka: s, powod: s.lastError ?? 'Przewoźnik nie utworzył przesyłki.' }
  return { wynik: 'ODMOWA', powod: 'Przesyłka została oznaczona jako niepowstała: utwórz ją ponownie.' }
}

/** Wersja rekordu klienta: zmiana między odczytem odbiorcy a rezerwacją = poprawka adresu w trakcie nadania. */
const wersjaKlienta = wersjaRekorduKlienta
const ZMIANA_ODBIORCY = 'Dane odbiorcy zmieniły się w trakcie tworzenia przesyłki (poprawka adresu): kliknij „Utwórz przesyłkę” ponownie.'
export const ZMIANA_SPOSOBU = 'Sposób wysyłki zmienił się w trakcie tworzenia przesyłki: kliknij „Utwórz przesyłkę” ponownie.'
export const ZMIANA_POZYCJI = 'Pozycje zamówienia zmieniły się w trakcie tworzenia przesyłki: kliknij „Utwórz przesyłkę” ponownie.'
/**
 * Podpis pozycji zamówienia (kwota, suma sztuk w paczce, liczba nieusuniętych pozycji). Kwota pobrania i zawartość
 * paczki liczą się przed rezerwacją wiersza, więc rezerwacja porównuje podpis z odczytu sprzed bramki ze świeżym.
 */
async function podpisPozycji(db: Db | Tx, orderId: string): Promise<string | null> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { totalGross: true, lines: { where: { removed: false }, select: { qty: true, qtyRejected: true } } } })
  if (!o) return null
  const sztuki = o.lines.reduce((s, l) => s + l.qty - l.qtyRejected, 0)
  return `${o.totalGross.toString()}:${sztuki}:${o.lines.length}`
}
/** Przewoźnik, moduł i znacznik wyboru na karcie: od nich zależy reguła nadania (`regulaDlaZamowienia`). */
const sposobWysylki = (o: { carrier: Carrier | null; shippingModule: ShippingModule | null; flags: Prisma.JsonValue }) =>
  `${o.carrier ?? ''}:${o.shippingModule ?? ''}:${flagsOf(o).przewoznikRecznie === true}`

/**
 * „Utwórz przesyłkę” z gabarytem. Kolejność: bramki → odbiorca z danych klienta → parametry liczone od nowa (z punktem
 * odbioru) → problemy BLAD i niepotwierdzone ostrzeżenia = odmowa bez zapisu → rezerwacja wiersza pod blokadą → adapter
 * → `executeWrite` → zapis wyniku. Istniejąca aktywna przesyłka = zwrot bez wołania przewoźnika.
 */
export async function utworzPrzesylke(db: Db, z: ZlecenieNadania, deps: DepsNadania = {}): Promise<WynikNadania> {
  const organizationId = organizationIdOf(db)
  // sposób wysyłki odczytany PRZED bramką: rezerwacja pod blokadą porównuje go ze świeżym
  const o = await db.order.findUnique({ where: { id: z.orderId }, select: { id: true, packageNo: true, externalId: true, carrier: true, shippingModule: true, flags: true } })
  if (!o) return { wynik: 'ODMOWA', powod: 'Nie ma takiego zamówienia.' }
  // pozycje odczytane PRZED parametrami przesyłki: rezerwacja pod blokadą porównuje je ze świeżymi (zmiana pozycji na karcie)
  const pozycjePrzed = await podpisPozycji(db, o.id)
  const juz = await aktywnaPaczki(db, o.id, o.packageNo)
  if (juz) return wynikIstniejacej(juz)

  const registry = deps.registry ?? defaultRegistry()
  const b = await bramkaNadania(db, o.id, { ...deps, registry })
  if (!b) return { wynik: 'ODMOWA', powod: 'Nie ma takiego zamówienia.' }
  if (b.powod || !b.regula) return { wynik: 'ODMOWA', powod: b.powod ?? 'Nadawanie niedostępne.' }

  let odb: Awaited<ReturnType<typeof odbiorcaPrzesylki>>
  const wersjaPrzed = await wersjaKlienta(db, o.id)
  try {
    odb = await odbiorcaPrzesylki(db, o.id, { modul: 'wysylka', registry, secrets: zrodloSekretow(deps), fetch: deps.fetch, now: deps.now, env: envDeps(deps) })
  } catch (e) {
    // odmowa bramki odczytu z kanału, błąd kanału, brak klucza: komunikaty bez danych klienta, nic nie zapisane
    if (e instanceof OdmowaOdczytuOdbiorcy || e instanceof BladOdczytuOdbiorcy || e instanceof BrakZamowieniaOdbiorcy) return { wynik: 'ODMOWA', powod: `Brak danych odbiorcy: ${e.message}` }
    if (e instanceof BladSzyfruKlienta) return { wynik: 'ODMOWA', powod: KOMUNIKAT_BRAK_KLUCZA }
    throw e
  }
  if (!odb.recipient) return { wynik: 'ODMOWA', powod: 'Brak danych odbiorcy: odśwież dane klienta z kanału albo popraw adres na karcie zamówienia.' }
  // odbiorca z bazy, a rekord zmienił się w trakcie odczytu = poprawka w toku (z kanału rekord zapisał sam odczyt)
  const wersjaOdbiorcy = await wersjaKlienta(db, o.id)
  if (odb.zrodlo === 'BAZA' && wersjaOdbiorcy !== wersjaPrzed) return { wynik: 'ODMOWA', powod: ZMIANA_ODBIORCY }
  const p = await przesylkaDoNadania(db, o.id, z.gabaryt, odb.punktOdbioru?.kod ?? null)
  if (p.wynik !== 'przygotowane') return { wynik: 'ODMOWA', powod: p.powod }
  await deps.poOdczycieOdbiorcy?.()
  const potwierdzone = z.potwierdzoneOstrzezenia ?? []
  const bledy = p.parcel.problems.filter((x) => x.poziom === 'BLAD')
  if (bledy.length) return { wynik: 'ODMOWA', powod: `Przesyłka nie jest gotowa: ${bledy.map((x) => x.tekst).join(' ')}` }
  const doPotwierdzenia = p.parcel.problems.filter((x) => x.poziom === 'OSTRZEZENIE' && !potwierdzone.includes(x.kod))
  if (doPotwierdzenia.length) return { wynik: 'ODMOWA', powod: 'Potwierdź przed nadaniem wartości robocze przesyłki.', doPotwierdzenia: doPotwierdzenia.map((x) => ({ kod: x.kod, tekst: x.tekst })) }

  // Rezerwacja: jeden wiersz aktywny na paczkę (blokada zamówienia + indeks częściowy). Po odmowie (BLAD) ta sama
  // referencja wraca do użycia; nowa referencja dopiero po anulowaniu przesyłki.
  const now = teraz(deps)
  const rez = await runTx(db, async (tx) => {
    await advisoryLock(tx, kluczBlokadyPrzesylki(o.id))
    const akt = await aktywnaPaczki(tx, o.id, o.packageNo)
    if (akt) return { istniala: akt }
    // poprawka adresu (pod tą samą blokadą, lib/klienci/poprawka.ts) zapisana po naszym odczycie odbiorcy
    if ((await wersjaKlienta(tx, o.id)) !== wersjaOdbiorcy) return { zmiana: true as const }
    // zmiana sposobu wysyłki (lib/wysylka/zmiana-sposobu.ts, ta sama blokada przesyłki) po bramce, także
    // bez zmiany danych odbiorcy (odbiór osobisty, Wysyłam z Allegro, inny moduł): bramka liczyła starego przewoźnika
    const swiezy = await tx.order.findUnique({ where: { id: o.id }, select: { carrier: true, shippingModule: true, flags: true } })
    if (!swiezy || swiezy.carrier !== b.carrier || sposobWysylki(swiezy) !== sposobWysylki(o)) return { zmianaSposobu: true as const }
    // zmiana pozycji (lib/rdzen/edycja.ts, ta sama blokada przesyłki) po odczycie: kwota pobrania i zawartość są sprzed niej
    if ((await podpisPozycji(tx, o.id)) !== pozycjePrzed) return { zmianaPozycji: true as const }
    const dane = { state: 'TWORZENIE' as const, adapterKey: b.regula!.adapterKey, carrier: b.carrier!, parcelSize: p.parcel.gabaryt, weightKg: p.parcel.weightKg, codAmount: p.parcel.codAmount, requestedBy: z.userId, lastError: null, failureKind: null, accountSuffix: kontoReguly(b.regula!) }
    const blad = await tx.shipment.findFirst({ where: { orderId: o.id, packageNo: o.packageNo, extraNo: 0, state: 'BLAD' }, orderBy: { createdAt: 'desc' } })
    // wiersz po błędzie innego modułu (sposób wysyłki zmieniony na karcie) = pierwsza próba u nowego przewoźnika:
    // ta referencja do niego nie szła, więc bez `ponowienie` i z licznikiem prób od 1
    if (blad && blad.adapterKey !== dane.adapterKey) return { nowa: await tx.shipment.update({ where: { id: blad.id }, data: { ...dane, attempt: 1 } }) }
    if (blad) return { nowa: await tx.shipment.update({ where: { id: blad.id }, data: { ...dane, attempt: { increment: 1 } } }), ponowienie: true }
    const anulowane = await tx.shipment.count({ where: { orderId: o.id, packageNo: o.packageNo, extraNo: 0, state: 'ANULOWANA' } })
    const reference = deriveReference([organizationId, o.id, o.packageNo, 'przesylka', anulowane + 1])
    return { nowa: await tx.shipment.create({ data: { orderId: o.id, packageNo: o.packageNo, reference, ...dane, createdAt: now } }) }
  }).catch(async (e: unknown) => {
    // równoległe kliknięcie wygrało wyścig o indeks częściowy: zwracamy jego przesyłkę
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
      const akt = await aktywnaPaczki(db, o.id, o.packageNo)
      if (akt) return { istniala: akt }
    }
    throw e
  })
  if ('istniala' in rez && rez.istniala) return wynikIstniejacej(rez.istniala)
  if ('zmiana' in rez) return { wynik: 'ODMOWA', powod: ZMIANA_ODBIORCY }
  if ('zmianaSposobu' in rez) return { wynik: 'ODMOWA', powod: ZMIANA_SPOSOBU }
  if ('zmianaPozycji' in rez) return { wynik: 'ODMOWA', powod: ZMIANA_POZYCJI }
  const s = (rez as { nowa: Shipment }).nowa
  // ten sam wiersz po BLAD = ta referencja już szła do przewoźnika
  const ponowienie = 'ponowienie' in rez && rez.ponowienie === true

  let adapter: ChannelAdapter
  try {
    adapter = await adapterNadania(db, b.regula, o.id, registry, deps)
  } catch (e) {
    // nic nie wyszło do przewoźnika: odmowa konfiguracji (brak sekretu, zła konfiguracja)
    const m = e instanceof AdapterConfigError ? e.message : 'nie udało się przygotować połączenia z przewoźnikiem'
    return zapiszBlad(db, s, { kind: 'TRWALY', reference: s.reference, message: `Konfiguracja przewoźnika: ${m}` })
  }
  if (!hasShipmentCreator(adapter)) return zapiszBlad(db, s, { kind: 'TRWALY', reference: s.reference, message: 'Moduł przewoźnika nie tworzy przesyłek.' })

  const out = await executeWrite(adapter, s.reference, () =>
    adapter.createShipment({ parcel: p.parcel, carrier: b.carrier!, recipient: odb.recipient!, potwierdzoneOstrzezenia: potwierdzone, orderExternalId: o.externalId, ponowienie }, s.reference),
  )
  return zapiszWynik(db, s, adapter, out, { userId: z.userId, deps })
}

/**
 * Odmowa zapisywana tylko z TWORZENIE: spóźniony wynik oryginalnego wywołania nie cofa przesyłki,
 * którą w międzyczasie rozstrzygnęło „Sprawdź u przewoźnika” albo człowiek. Stan już zmieniony = zwrot bez zapisu.
 */
async function zapiszBlad(db: Db, s: Shipment, out: Extract<WriteOutcome, { message: string }>): Promise<WynikNadania> {
  const powod = krotko(out.message)
  const u = await db.shipment.updateMany({ where: { id: s.id, state: 'TWORZENIE' }, data: { state: 'BLAD', failureKind: out.kind, lastError: powod } })
  const w = await db.shipment.findUniqueOrThrow({ where: { id: s.id } })
  return u.count ? { wynik: 'BLAD', przesylka: w, powod } : wynikIstniejacej(w)
}

/**
 * paczek nadanych przez API Orlen Paczki nie widać w panelu WebTrucker (pkt 3.2
 * dokumentacji), więc dla Orlenu nie odsyłamy do panelu: dane do porównania daje „Sprawdź u przewoźnika”.
 */
export const ORLEN_GDZIE_SPRAWDZIC =
  'Paczek nadanych przez Kompletor (API Orlen Paczki) nie widać w panelu Orlen Paczki (WebTrucker), więc brak paczki w tym panelu niczego nie dowodzi. Kliknij „Sprawdź u przewoźnika”: Kompletor pokaże numery i godziny paczek nadanych przez API w ostatnich dniach. „Nie powstała” wybierz dopiero wtedy, gdy każda z nich ma swoje zamówienie w Kompletorze (w razie wątpliwości wykaz paczek z API da opiekun handlowy Orlen Paczki).'

const jestOrlen = (adapterKey: string) => adapterKey.startsWith('orlenpaczka.')

/** Gdzie są przyciski „Sprawdź u przewoźnika” i „Rozstrzygnij ręcznie”: dodatkowa przesyłka ma je w oknie „Dodaj przesyłkę”. */
const gdzieRozstrzygnac = (s: Pick<Shipment, 'extraNo'>) => (s.extraNo > 0 ? 'w oknie „Dodaj przesyłkę” na karcie zamówienia' : 'na karcie zamówienia')
const jakaPrzesylka = (s: Pick<Shipment, 'extraNo'>) => (s.extraNo > 0 ? `dodatkowa przesyłka nr ${s.extraNo}` : 'przesyłka')

const KOMUNIKAT_ALERTU = (s: Shipment) =>
  jestOrlen(s.adapterKey)
    ? `Nie wiadomo, czy ${s.extraNo > 0 ? `dodatkowa paczka nr ${s.extraNo}` : 'paczka'} Orlen Paczki powstała (referencja ${s.reference}). ${ORLEN_GDZIE_SPRAWDZIC}${s.extraNo > 0 ? ' Przycisk jest w oknie „Dodaj przesyłkę” na karcie zamówienia.' : ''} Nie twórz przesyłki drugi raz.`
    : `Nie wiadomo, czy ${jakaPrzesylka(s)} powstała u przewoźnika (${s.adapterKey}). Sprawdź w panelu przewoźnika po referencji ${s.reference}, potem kliknij „Sprawdź u przewoźnika” albo „Rozstrzygnij ręcznie” ${gdzieRozstrzygnac(s)}. Nie twórz przesyłki drugi raz.`

const zamknijAlert = (db: Db | Tx, shipmentId: string, now: Date) => db.alert.updateMany({ where: { dedupeKey: `przesylka:${shipmentId}`, closedAt: null }, data: { closedAt: now } })

async function zapiszWynik(db: Db, s: Shipment, adapter: ChannelAdapter & ShipmentCreator, out: WriteOutcome, o: { userId: string; deps: DepsNadania }): Promise<WynikNadania> {
  if (out.kind === 'OK') return zakonczUtworzona(db, s, adapter, out.externalRef ?? null, { ...o, ...(out.info ? { uwaga: krotko(out.info) } : {}) })
  if (out.kind === 'NIEJEDNOZNACZNY') {
    // stan i alert w jednej transakcji: przesyłka NIEJEDNOZNACZNA nigdy bez alertu
    const zmieniono = await runTx(db, async (tx) => {
      const u = await tx.shipment.updateMany({ where: { id: s.id, state: 'TWORZENIE' }, data: { state: 'NIEJEDNOZNACZNA', failureKind: out.kind, lastError: krotko(out.message) } })
      if (u.count) await alert(tx, ALERT_PRZESYLKI, s.orderId, KOMUNIKAT_ALERTU(s), `przesylka:${s.id}`)
      return u.count > 0
    })
    const w = await db.shipment.findUniqueOrThrow({ where: { id: s.id } })
    if (!zmieniono) return wynikIstniejacej(w)
    return { wynik: 'NIEJEDNOZNACZNA', przesylka: w, istniala: false }
  }
  // odłożone przez osłonę (limit tempa, konto wyłączone po błędach) = nic nie wyszło do
  // przewoźnika. Wiersz idzie do BLAD/PRZEJSCIOWY (ten sam wiersz i ta sama referencja przy ponowieniu, więc bez dubla),
  // z komunikatem, kiedy spróbować, zamiast surowego błędu. Automatyczne ponowienie bez kliknięcia: zadanie następcze.
  if (out.kind === 'PRZEJSCIOWY' && out.odlozone && /wyczerpany|równoległych/.test(out.message)) {
    const za = Math.max(1, Math.ceil((out.retryAfterMs ?? 1_000) / 1000))
    const co = out.message.replace(/;\s*(nic nie wysłano, )?ponowienie za .*$/, '')
    return zapiszBlad(db, s, { ...out, message: `Limit tempa przewoźnika: ${co}. Nic nie wysłano; kliknij „Utwórz przesyłkę” ponownie za ${za} s (nie powstanie druga paczka).` })
  }
  return zapiszBlad(db, s, out)
}

/**
 * Przesyłka powstała: zapis id i numeru nadania, zdarzenie NUMER_NADANIA_GOTOWY (gdy numer jest), próba „Do wysłania”
 * (rdzeń pilnuje faktury: bez niej status zostaje i ekran to mówi) i pobranie etykiety. Etykieta i numer, których
 * przewoźnik jeszcze nie dał, nie cofają przesyłki: „Pobierz etykietę” na karcie spróbuje ponownie.
 */
//
// Zapis z warunkiem na stan (TWORZENIE albo NIEJEDNOZNACZNA) pod blokadą zamówienia: dwa „Sprawdź”
// naraz albo „Sprawdź” ścigające się z oryginalnym wywołaniem dają jedno PRZESYLKA_UTWORZONA i jedno
// NUMER_NADANIA_GOTOWY; przegrany dostaje przesyłkę zapisaną przez zwycięzcę, bez zdarzeń, „Do wysłania” i etykiety.
// `slad` = rozstrzygnięcie ręczne: wpis AuditLog w tej samej transakcji.
async function zakonczUtworzona(
  db: Db,
  s: Shipment,
  adapter: ChannelAdapter & ShipmentCreator,
  externalRef: string | null,
  o: { userId: string; deps: DepsNadania; slad?: Record<string, string>; uwaga?: string },
): Promise<WynikNadania> {
  const now = teraz(o.deps)
  if (!externalRef) {
    // odszukanie potwierdziło przesyłkę, ale bez identyfikatora: bez niego nie ma etykiety ani numeru
    const zmieniono = await runTx(db, async (tx) => {
      const u = await tx.shipment.updateMany({ where: { id: s.id, state: { in: NIEROZSTRZYGNIETE } }, data: { state: 'NIEJEDNOZNACZNA', failureKind: 'NIEJEDNOZNACZNY', lastError: 'Przewoźnik potwierdził przesyłkę bez jej numeru: sprawdź w panelu przewoźnika.' } })
      if (u.count) await alert(tx, ALERT_PRZESYLKI, s.orderId, `${s.extraNo > 0 ? `Dodatkowa przesyłka nr ${s.extraNo}` : 'Przesyłka'} ${s.reference} istnieje u przewoźnika, ale bez numeru: sprawdź w panelu przewoźnika i użyj „Rozstrzygnij ręcznie” ${gdzieRozstrzygnac(s)}.`, `przesylka:${s.id}`)
      return u.count > 0
    })
    const w = await db.shipment.findUniqueOrThrow({ where: { id: s.id } })
    if (!zmieniono) return wynikIstniejacej(w)
    return { wynik: 'NIEJEDNOZNACZNA', przesylka: w, istniala: false }
  }
  const numer = await numerNadania(adapter, externalRef)
  const actorId = `user:${o.userId}`
  const w = await runTx(db, async (tx) => {
    await advisoryLock(tx, kluczBlokadyPrzesylki(s.orderId))
    const u = await tx.shipment.updateMany({ where: { id: s.id, state: { in: NIEROZSTRZYGNIETE } }, data: { state: 'UTWORZONA', externalRef, trackingNumber: numer.numer, failureKind: null, lastError: [o.uwaga, numer.blad].filter(Boolean).join(' ') || null } })
    if (!u.count) return null
    // `uwaga` = informacja przewoźnika przy udanym nadaniu (np. zmieniony punkt odbioru); karta czyta ją ze zdarzenia.
    // Przesyłka dodatkowa ma własne zdarzenie bez pola `nadanie` (numer zamówienia w API, automaty „utworzono
    // przesyłkę”) i bez zgłoszenia numeru do sklepu: w kanale zostaje numer głównej przesyłki.
    if (s.extraNo > 0) {
      await tx.orderEvent.create({ data: { orderId: s.orderId, kind: PRZESYLKA_DODATKOWA, actorId, data: { przesylka: s.id, przewoznik: s.carrier, numerDodatkowej: s.extraNo, rodzaj: s.extraKind, ...(numer.numer ? { numerNadaniaDodatkowej: numer.numer } : {}), ...(o.slad ? { rozstrzygniecie: 'RECZNE' } : {}), ...(o.uwaga ? { uwaga: o.uwaga } : {}) } } })
    } else await tx.orderEvent.create({ data: { orderId: s.orderId, kind: 'PRZESYLKA_UTWORZONA', actorId, data: { przesylka: s.id, przewoznik: s.carrier, ...(numer.numer ? { nadanie: numer.numer } : {}), ...(o.slad ? { rozstrzygniecie: 'RECZNE' } : {}), ...(o.uwaga ? { uwaga: o.uwaga } : {}) } } })
    if (numer.numer && s.extraNo === 0) await zglosNumerNadania(tx, { shipmentId: s.id, orderId: s.orderId, packageNo: s.packageNo, carrier: s.carrier, adapterKey: s.adapterKey, trackingNumber: numer.numer }, actorId)
    if (o.slad) await tx.auditLog.create({ data: { entity: ROZSTRZYGNIECIE_AUDIT, entityId: s.id, actorId, after: { ...o.slad, orderId: s.orderId, reference: s.reference } } })
    await zamknijAlert(tx, s.id, now)
    return tx.shipment.findUniqueOrThrow({ where: { id: s.id } })
  })
  if (!w) {
    const fresh = await db.shipment.findUniqueOrThrow({ where: { id: s.id } })
    // przewoźnik potwierdził przesyłkę, którą człowiek oznaczył jako niepowstałą: może być druga, płatna paczka
    if (fresh.state === 'ANULOWANA')
      await alert(db, ALERT_PRZESYLKI, s.orderId, `Przewoźnik potwierdził przesyłkę ${s.reference} (numer ${numer.numer ?? externalRef}), choć oznaczono ją ręcznie jako niepowstałą. ${jestOrlen(s.adapterKey) ? 'Sprawdź na karcie zamówienia i w liście paczek nadanych przez API (w panelu Orlen Paczki ich nie widać)' : 'Sprawdź w panelu przewoźnika'}, czy zamówienie nie ma dwóch przesyłek.`, `przesylka-anulowana:${s.id}`)
    return wynikIstniejacej(fresh)
  }
  const info: string[] = []
  // dodatkowa przesyłka nie zmienia statusu zamówienia
  const st = s.extraNo > 0 ? null : await doWyslania(db, s.orderId, actorId, numer.numer)
  if (st) info.push(st)
  const e = await pobierzEtykiete(db, w.id, { ...o.deps, adapter })
  if (e.blad) info.push(e.blad)
  if (o.uwaga) info.unshift(o.uwaga)
  const fresh = await db.shipment.findUniqueOrThrow({ where: { id: w.id } })
  return { wynik: 'UTWORZONA', przesylka: fresh, istniala: false, info: info.length ? info.join(' ') : null }
}

async function numerNadania(adapter: ChannelAdapter & ShipmentCreator, externalRef: string): Promise<{ numer: string | null; blad: string | null }> {
  if (typeof adapter.getTrackingNumber !== 'function') return { numer: externalRef, blad: null }
  try {
    const n = await adapter.getTrackingNumber(externalRef)
    return { numer: n, blad: n ? null : 'Przewoźnik jeszcze nie nadał numeru: „Pobierz etykietę” spróbuje ponownie.' }
  } catch (e) {
    return { numer: null, blad: `Numer nadania niedostępny: ${krotko(e instanceof Error ? e.message : String(e))}` }
  }
}

// ─── Dodatkowa przesyłka do tego samego zamówienia ───────────────────────────

export interface ModulDodatkowej {
  regulaId: string
  nazwa: string
  /** Reguła zamówienia (domyślny wybór w oknie). */
  zamowienia: boolean
}

export const KOMUNIKAT_DODATKOWA_WYLACZONA =
  'Dodawanie kolejnej przesyłki do zamówienia jest w tej firmie wyłączone (Ustawienia → Wysyłka i druk → Przewoźnicy, „Pozwalaj dodać kolejną przesyłkę do zamówienia”).'

export interface BramkaDodatkowej {
  /** null = wolno dodać; inaczej powód dla ekranu (przycisk zostaje widoczny). */
  powod: string | null
  /** Numer, który dostanie następna dodatkowa przesyłka (okno odsyła go z powrotem: podwójne kliknięcie = jedna). */
  nastepnyNumer: number
  moduly: ModulDodatkowej[]
  gabaryty: { kod: Gabaryt; nazwa: string }[]
  /**
   * Dodatkowa przesyłka w trakcie albo niejasna u przewoźnika: okno pokazuje „Sprawdź u przewoźnika”, a gdy
   * `rozstrzygalna` (niejasna albo zawieszona w tworzeniu), także „Rozstrzygnij ręcznie” z referencją i wskazówką.
   */
  doSprawdzenia: { shipmentId: string; numer: number; referencja: string; rozstrzygalna: boolean; rozstrzygniecie: { etykietaNumeru: string; wskazowka: string } } | null
}

/**
 * Czy i dlaczego nie wolno dodać przesyłki do zamówienia. Moduły do wyboru: reguły firmy dla przewoźnika zamówienia
 * (inny moduł tego samego przewoźnika, np. drugie konto), z tworzeniem przesyłek i włączonym nadawaniem. Inny przewoźnik
 * niż w zamówieniu wymaga innego odbiorcy (adres zamiast punktu) i dziś nie jest dostępny. Tylko odczyt, bez sieci.
 * Funkcja firmy domyślnie wyłączona (Ustawienia → Przewoźnicy, przełącznik `dodatkowaPrzesylka`): wyłączona = odmowa.
 * Dodatkowa przesyłka w trakcie albo niejasna wraca z `doSprawdzenia` także przy wyłączonym przełączniku (zawsze
 * z powodem, więc nowej i tak nie utworzy): wyłączenie funkcji nie zabiera „Sprawdź u przewoźnika” i „Rozstrzygnij ręcznie”.
 */
export async function bramkaDodatkowej(db: Db, orderId: string, deps: DepsNadania = {}): Promise<BramkaDodatkowej | null> {
  organizationIdOf(db)
  const [z] = await wczytajZamowienia(db, [orderId])
  if (!z) return null
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { packageNo: true } })
  const najwyzszy = await db.shipment.aggregate({ where: { orderId, packageNo: o.packageNo }, _max: { extraNo: true } })
  // po błędzie przewoźnika okno wraca do tego samego numeru (ta sama referencja), zamiast otwierać kolejną paczkę
  const poBledzie = await db.shipment.findFirst({ where: { orderId, packageNo: o.packageNo, extraNo: { gte: 1 }, state: 'BLAD' }, orderBy: { extraNo: 'asc' }, select: { extraNo: true } })
  const nastepnyNumer = poBledzie?.extraNo ?? (najwyzszy._max.extraNo ?? 0) + 1
  const gabaryty = gabarytyDla(z.carrier).map((kod) => ({ kod, nazwa: GABARYTY[kod] }))
  // dodatkowa w trakcie albo niejasna u przewoźnika: kolejna mogłaby dać drugą etykietę na to samo
  const wToku = await db.shipment.findFirst({ where: { orderId, packageNo: o.packageNo, extraNo: { gte: 1 }, state: { in: NIEROZSTRZYGNIETE } }, orderBy: { extraNo: 'asc' }, select: { id: true, extraNo: true, state: true, updatedAt: true, adapterKey: true, reference: true } })
  const doSprawdzenia = wToku
    ? {
        shipmentId: wToku.id,
        numer: wToku.extraNo,
        referencja: wToku.reference,
        rozstrzygalna: wToku.state === 'NIEJEDNOZNACZNA' || zawieszonaPrzesylka(wToku, teraz(deps), deps.registry),
        rozstrzygniecie: (({ etykietaNumeru, wskazowka }) => ({ etykietaNumeru, wskazowka }))(opisRozstrzygniecia(wToku.adapterKey, wToku.reference)),
      }
    : null
  const wynik = (powod: string | null, moduly: ModulDodatkowej[] = []): BramkaDodatkowej => ({ powod, nastepnyNumer, moduly, gabaryty, doSprawdzenia })
  if (wToku)
    return wynik(
      doSprawdzenia?.rozstrzygalna
        ? `Nie wiadomo, czy dodatkowa przesyłka nr ${wToku.extraNo} powstała u przewoźnika. Kliknij „Sprawdź u przewoźnika”. Jeśli to nie wystarczy, sprawdź ją w panelu przewoźnika i użyj „Rozstrzygnij ręcznie”. Kolejną przesyłkę dodasz po wyjaśnieniu tej.`
        : `Dodatkowa przesyłka nr ${wToku.extraNo} właśnie powstaje u przewoźnika: odśwież za chwilę.`,
    )
  // wyłączony przełącznik blokuje nowe dodatkowe przesyłki; niejasną (wyżej) nadal da się sprawdzić i rozstrzygnąć
  if (!(await automatyWysylki(db)).dodatkowaPrzesylka) return { powod: KOMUNIKAT_DODATKOWA_WYLACZONA, nastepnyNumer: 0, moduly: [], gabaryty: [], doSprawdzenia: null }
  const nd = powodNieDotyczy({ status: z.status, carrier: z.carrier, tylkoBezStanu: z.tylkoBezStanu, liczbaPozycji: z.pozycje.length })
  if (nd) return wynik(nd)
  if (!STATUSY_DODATKOWEJ.includes(z.status)) return wynik('Dodatkową przesyłkę dodaje się do zamówienia spakowanego albo wysłanego, które ma już utworzoną przesyłkę.')
  const glowna = await aktywnaPaczki(db, orderId, o.packageNo)
  if (!glowna || glowna.state !== 'UTWORZONA') return wynik('Najpierw utwórz główną przesyłkę zamówienia („Utwórz przesyłkę”).')
  const tryb = await bramkaTrybu(db, z, deps, 'nadawanie')
  if (tryb) return wynik(tryb)
  const registry = deps.registry ?? defaultRegistry()
  const { regula: regulaZam } = await regulaZamowienia(db, z)
  const reguly = await db.carrierRule.findMany({ where: { carrier: z.carrier! }, orderBy: { priority: 'asc' }, select: { id: true, channel: true, carrier: true, shippingModule: true, adapterKey: true, config: true } })
  const moduly: ModulDodatkowej[] = []
  const widziane = new Set<string>()
  for (const r of reguly) {
    if (r.channel && r.channel !== z.channel) continue
    const config = r.config && typeof r.config === 'object' && !Array.isArray(r.config) ? (r.config as Record<string, unknown>) : {}
    const key = kluczReguly(r)
    const def = key ? registry.get(key) : undefined
    if (!key || !def || def.manifest.readOnly || !def.manifest.capabilities.includes('shipment.create') || config['zapisWlaczony'] !== true) continue
    if (WYSYLAM_KEY_RE.test(key) && z.channel !== 'ALLEGRO') continue
    // jedna pozycja na moduł i konto (kilka reguł kanału często wskazuje ten sam moduł)
    const id = `${key}:${kontoReguly({ config }) ?? ''}`
    if (widziane.has(id) && r.id !== regulaZam?.id) continue
    widziane.add(id)
    const konto = kontoReguly({ config })
    moduly.push({ regulaId: r.id, nazwa: `${def.manifest.displayName ?? key}${konto ? ` (konto ${konto})` : ''}`, zamowienia: r.id === regulaZam?.id })
  }
  moduly.sort((a, b) => Number(b.zamowienia) - Number(a.zamowienia))
  if (!moduly.length) return wynik('Żaden moduł tego przewoźnika nie ma włączonego nadawania (Ustawienia → Wysyłka i druk → Przewoźnicy).')
  return wynik(null, moduly)
}

/** Czy zamówienie ma dodatkową przesyłkę w trakcie albo niejasną u przewoźnika (karta pokazuje wtedy okno do jej wyjaśnienia). */
export async function dodatkowaDoWyjasnienia(db: Db, orderId: string): Promise<boolean> {
  return (await db.shipment.count({ where: { orderId, extraNo: { gte: 1 }, state: { in: NIEROZSTRZYGNIETE } } })) > 0
}

export interface ZlecenieDodatkowej {
  orderId: string
  /** Numer z okna (`nastepnyNumer` bramki): ten sam numer drugi raz = zwrot istniejącej, bez przewoźnika. */
  numer: number
  regulaId: string
  rodzaj: unknown
  powod: unknown
  gabaryt: unknown
  koszt: unknown
  potwierdzam: unknown
  potwierdzoneOstrzezenia?: readonly string[]
  userId: string
}

/**
 * „Dodaj przesyłkę”: dodatkowa przesyłka u przewoźnika do tego samego zamówienia. Kolejność jak przy głównej: walidacja
 * okna → bramka → odbiorca → paczka (bez pobrania) → rezerwacja wiersza pod blokadą przesyłki zamówienia → adapter →
 * `executeWrite` → zapis wyniku. Referencja `[firma, zamówienie, paczka, 'dodatkowa', numer]` jest stała dla numeru,
 * więc ponowienie po błędzie nie daje drugiej paczki u przewoźnika. Po utworzeniu: zdarzenie PRZESYLKA_DODATKOWA
 * i etykieta; bez zmiany statusu, bez zapisu numeru do sklepu i bez automatów.
 */
export async function utworzDodatkowa(db: Db, z: ZlecenieDodatkowej, deps: DepsNadania = {}): Promise<WynikNadania> {
  const organizationId = organizationIdOf(db)
  if (!Number.isInteger(z.numer) || z.numer < 1 || z.numer > 99) return { wynik: 'ODMOWA', powod: 'Odśwież kartę zamówienia i dodaj przesyłkę ponownie.' }
  const o = await db.order.findUnique({ where: { id: z.orderId }, select: { id: true, packageNo: true, externalId: true, carrier: true } })
  if (!o) return { wynik: 'ODMOWA', powod: 'Nie ma takiego zamówienia.' }
  const istniejaca = await db.shipment.findFirst({ where: { orderId: o.id, packageNo: o.packageNo, extraNo: z.numer } })
  // ponowne kliknięcie tego samego okna: przesyłka o tym numerze już jest (BLAD wraca do ponowienia tą samą referencją)
  if (istniejaca && istniejaca.state !== 'BLAD') return wynikIstniejacej(istniejaca)
  const v = walidujDodatkowa(o.carrier, z)
  if (!v.ok) return { wynik: 'ODMOWA', powod: v.powod }
  const registry = deps.registry ?? defaultRegistry()
  const b = await bramkaDodatkowej(db, o.id, { ...deps, registry })
  if (!b) return { wynik: 'ODMOWA', powod: 'Nie ma takiego zamówienia.' }
  if (b.powod) return { wynik: 'ODMOWA', powod: b.powod }
  if (!istniejaca && z.numer !== b.nastepnyNumer) return { wynik: 'ODMOWA', powod: 'W międzyczasie dodano inną przesyłkę do tego zamówienia: odśwież kartę i sprawdź, czy kolejna jest potrzebna.' }
  if (!b.moduly.some((m) => m.regulaId === z.regulaId)) return { wynik: 'ODMOWA', powod: 'Wybierz moduł przewoźnika z listy.' }
  const regula = await regulaPoId(db, z.regulaId)
  const key = regula ? kluczReguly(regula) : null
  if (!regula || !key) return { wynik: 'ODMOWA', powod: 'Wybierz moduł przewoźnika z listy.' }

  let odb: Awaited<ReturnType<typeof odbiorcaPrzesylki>>
  try {
    odb = await odbiorcaPrzesylki(db, o.id, { modul: 'wysylka', registry, secrets: zrodloSekretow(deps), fetch: deps.fetch, now: deps.now, env: envDeps(deps) })
  } catch (e) {
    if (e instanceof OdmowaOdczytuOdbiorcy || e instanceof BladOdczytuOdbiorcy || e instanceof BrakZamowieniaOdbiorcy) return { wynik: 'ODMOWA', powod: `Brak danych odbiorcy: ${e.message}` }
    if (e instanceof BladSzyfruKlienta) return { wynik: 'ODMOWA', powod: KOMUNIKAT_BRAK_KLUCZA }
    throw e
  }
  if (!odb.recipient) return { wynik: 'ODMOWA', powod: 'Brak danych odbiorcy: odśwież dane klienta z kanału albo popraw adres na karcie zamówienia.' }
  const [zs] = await wczytajZamowienia(db, [o.id])
  const parcel = zs ? paczkaDodatkowej(zs, key, regula.config, v.wejscie.gabaryt, odb.punktOdbioru?.kod ?? null) : null
  if (!parcel) return { wynik: 'ODMOWA', powod: 'Ten moduł przewoźnika nie liczy paczki: wybierz inny moduł.' }
  const bledy = parcel.problems.filter((x) => x.poziom === 'BLAD')
  if (bledy.length) return { wynik: 'ODMOWA', powod: `Przesyłka nie jest gotowa: ${bledy.map((x) => x.tekst).join(' ')}` }
  const potwierdzone = z.potwierdzoneOstrzezenia ?? []
  const doPotwierdzenia = parcel.problems.filter((x) => x.poziom === 'OSTRZEZENIE' && !potwierdzone.includes(x.kod))
  if (doPotwierdzenia.length) return { wynik: 'ODMOWA', powod: 'Potwierdź przed nadaniem wartości robocze przesyłki.', doPotwierdzenia: doPotwierdzenia.map((x) => ({ kod: x.kod, tekst: x.tekst })) }

  const now = teraz(deps)
  const dane = {
    state: 'TWORZENIE' as const,
    adapterKey: key,
    carrier: regula.carrier,
    parcelSize: parcel.gabaryt,
    weightKg: parcel.weightKg,
    codAmount: null,
    requestedBy: z.userId,
    lastError: null,
    failureKind: null,
    accountSuffix: kontoReguly(regula),
    extraKind: v.wejscie.rodzaj,
    extraReason: v.wejscie.powod,
    extraRuleId: regula.id,
    extraCostNet: v.wejscie.kosztNetto,
  }
  const rez = await runTx(db, async (tx) => {
    await advisoryLock(tx, kluczBlokadyPrzesylki(o.id))
    const w = await tx.shipment.findFirst({ where: { orderId: o.id, packageNo: o.packageNo, extraNo: z.numer } })
    if (w && w.state !== 'BLAD') return { istniala: w }
    // główna przesyłka anulowana albo zamówienie zmienione po bramce: bez dodatkowej
    const glowna = await aktywnaPaczki(tx, o.id, o.packageNo)
    const swiezy = await tx.order.findUnique({ where: { id: o.id }, select: { status: true } })
    if (!glowna || glowna.state !== 'UTWORZONA' || !swiezy || !STATUSY_DODATKOWEJ.includes(swiezy.status)) return { zmiana: true as const }
    // ponowienie po błędzie: ten sam wiersz; przy innym module (jak przy głównej po zmianie sposobu wysyłki) bez `ponowienie` i z licznikiem od 1
    if (w && w.adapterKey !== key) return { nowa: await tx.shipment.update({ where: { id: w.id }, data: { ...dane, attempt: 1 } }) }
    if (w) return { nowa: await tx.shipment.update({ where: { id: w.id }, data: { ...dane, attempt: { increment: 1 } } }), ponowienie: true }
    const reference = deriveReference([organizationId, o.id, o.packageNo, 'dodatkowa', z.numer])
    return { nowa: await tx.shipment.create({ data: { orderId: o.id, packageNo: o.packageNo, extraNo: z.numer, reference, ...dane, createdAt: now } }) }
  }).catch(async (e: unknown) => {
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
      const w = await db.shipment.findFirst({ where: { orderId: o.id, packageNo: o.packageNo, extraNo: z.numer } })
      if (w) return { istniala: w }
    }
    throw e
  })
  if ('istniala' in rez && rez.istniala) return wynikIstniejacej(rez.istniala)
  if ('zmiana' in rez) return { wynik: 'ODMOWA', powod: 'Zamówienie albo jego główna przesyłka zmieniły się w trakcie: odśwież kartę zamówienia.' }
  const s = (rez as { nowa: Shipment }).nowa
  const ponowienie = 'ponowienie' in rez && rez.ponowienie === true

  let adapter: ChannelAdapter
  try {
    adapter = await adapterNadania(db, regula, o.id, registry, deps)
  } catch (e) {
    const m = e instanceof AdapterConfigError ? e.message : 'nie udało się przygotować połączenia z przewoźnikiem'
    return zapiszBlad(db, s, { kind: 'TRWALY', reference: s.reference, message: `Konfiguracja przewoźnika: ${m}` })
  }
  if (!hasShipmentCreator(adapter)) return zapiszBlad(db, s, { kind: 'TRWALY', reference: s.reference, message: 'Moduł przewoźnika nie tworzy przesyłek.' })
  const out = await executeWrite(adapter, s.reference, () =>
    adapter.createShipment({ parcel, carrier: regula.carrier, recipient: odb.recipient!, potwierdzoneOstrzezenia: potwierdzone, orderExternalId: o.externalId, ponowienie }, s.reference),
  )
  return zapiszWynik(db, s, adapter, out, { userId: z.userId, deps })
}

/** „Do wysłania” po utworzeniu przesyłki (akcja BL 24), gdy rdzeń pozwala; komunikat, gdy nie (np. bez faktury). */
async function doWyslania(db: Db, orderId: string, actorId: string, numer: string | null): Promise<string | null> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { status: true } })
  if (!o || o.status !== 'SPAKOWANE') return o && o.status !== 'DO_WYSLANIA' ? 'Status „Do wysłania” ustawi się po spakowaniu i fakturze.' : null
  try {
    await moveOrder(db, orderId, 'DO_WYSLANIA', { actorId, ...(numer ? { trackingNo: numer } : {}) })
    return null
  } catch (e) {
    if (e instanceof TransitionError) return `Status zostaje „Spakowane”: ${e.message}.`
    throw e
  }
}

// ─── Etykieta i numer po utworzeniu ──────────────────────────────────────────

/** Format etykiety z reguły (`formatEtykiety`: PDF domyślnie, ZPL dla termicznej Zebry). */
async function formatEtykiety(db: Db, s: Shipment): Promise<LabelFormat> {
  if (s.extraNo > 0) return (s.extraRuleId ? (await regulaPoId(db, s.extraRuleId))?.config['formatEtykiety'] : null) === 'ZPL' ? 'ZPL' : 'PDF'
  const [z] = await wczytajZamowienia(db, [s.orderId])
  const r = z ? (await regulaZamowienia(db, z)).regula : null
  return r?.config['formatEtykiety'] === 'ZPL' ? 'ZPL' : 'PDF'
}

async function adapterPrzesylki(db: Db, s: Shipment, deps: DepsNadania): Promise<ChannelAdapter & ShipmentCreator> {
  return adapterDlaPrzesylki(db, s, deps)
}

/** Adapter, którym utworzono przesyłkę (reguła przewoźnika zamówienia); także do śledzenia przesyłki. */
export async function adapterDlaPrzesylki(db: Db, s: Shipment, deps: DepsNadania): Promise<ChannelAdapter & ShipmentCreator> {
  // dodatkowa przesyłka: moduł z reguły wybranej przy jej dodaniu, nie z reguły zamówienia
  if (s.extraNo > 0) {
    const r = s.extraRuleId ? await regulaPoId(db, s.extraRuleId) : null
    if (!r) throw new AdapterConfigError('Nie ma już reguły przewoźnika, którą utworzono tę przesyłkę: sprawdź w panelu przewoźnika.')
    if (kluczReguly(r) !== s.adapterKey) throw new AdapterConfigError('Reguła przewoźnika tej przesyłki wskazuje dziś inny moduł niż ten, którym ją utworzono: sprawdź w panelu przewoźnika.')
    const a = await adapterNadania(db, r, s.orderId, deps.registry ?? defaultRegistry(), deps)
    if (!hasShipmentCreator(a)) throw new AdapterConfigError('Moduł przewoźnika nie tworzy przesyłek.')
    return a
  }
  const [z] = await wczytajZamowienia(db, [s.orderId])
  if (!z) throw new AdapterConfigError('Nie ma zamówienia przesyłki')
  const { regula, powod } = await regulaZamowienia(db, z)
  if (!regula) throw new AdapterConfigError(powod ?? 'Brak reguły przewoźnika')
  if (kluczReguly(regula) !== s.adapterKey) throw new AdapterConfigError('Reguła przewoźnika wskazuje dziś inny moduł niż ten, którym utworzono przesyłkę: sprawdź w panelu przewoźnika.')
  const a = await adapterNadania(db, regula, s.orderId, deps.registry ?? defaultRegistry(), deps)
  if (!hasShipmentCreator(a)) throw new AdapterConfigError('Moduł przewoźnika nie tworzy przesyłek.')
  return a
}

/**
 * Etykieta od przewoźnika (getLabel nie tworzy przesyłki: wolno powtarzać) i brakujący numer nadania. Etykieta zapisana
 * zaszyfrowana; ponowny druk bierze ją z bazy bez pytania przewoźnika. Błąd = `labelError` i komunikat, przesyłka zostaje.
 */
export async function pobierzEtykiete(db: Db, shipmentId: string, deps: DepsNadania & { adapter?: ChannelAdapter & ShipmentCreator; actorId?: string } = {}): Promise<{ blad: string | null }> {
  const s = await db.shipment.findUnique({ where: { id: shipmentId } })
  if (!s || s.state !== 'UTWORZONA' || !s.externalRef) return { blad: 'Etykietę pobiera się dla utworzonej przesyłki.' }
  // po usunięciu danych klienta (retencja, RODO) etykieta z adresem nie wraca do bazy
  if (s.labelError === ETYKIETA_USUNIETA) return { blad: 'Dane klienta tego zamówienia zostały usunięte: etykiety nie pobieramy ponownie.' }
  let adapter: ChannelAdapter & ShipmentCreator
  try {
    adapter = deps.adapter ?? (await adapterPrzesylki(db, s, deps))
  } catch (e) {
    const m = `Etykieta niedostępna: ${krotko(e instanceof Error ? e.message : String(e))}`
    await db.shipment.update({ where: { id: s.id }, data: { labelError: m } })
    return { blad: m }
  }
  if (!s.trackingNumber) {
    const n = await numerNadania(adapter, s.externalRef)
    if (n.numer) {
      await runTx(db, async (tx) => {
        await advisoryLock(tx, kluczBlokadyPrzesylki(s.orderId))
        const u = await tx.shipment.updateMany({ where: { id: s.id, trackingNumber: null }, data: { trackingNumber: n.numer, lastError: null } })
        if (u.count && s.extraNo === 0) await zglosNumerNadania(tx, { shipmentId: s.id, orderId: s.orderId, packageNo: s.packageNo, carrier: s.carrier, adapterKey: s.adapterKey, trackingNumber: n.numer! }, deps.actorId ?? 'system:wysylka')
      })
    }
  }
  const format = await formatEtykiety(db, s)
  try {
    const l = await adapter.getLabel(s.externalRef, format)
    const plik = Buffer.from(l.base64, 'base64')
    if (!plik.length) throw new Error('pusta etykieta')
    const zapisany: 'PDF' | 'ZPL' = format === 'ZPL' && l.contentType !== 'application/pdf' ? 'ZPL' : 'PDF'
    const szyfr = zaszyfrujEtykiete(envDeps(deps), organizationIdOf(db), s.id, plik)
    await db.shipment.update({ where: { id: s.id }, data: { ...szyfr, labelFormat: zapisany, labelFetchedAt: teraz(deps), labelError: null } })
    return { blad: null }
  } catch (e) {
    const tresc = e instanceof Error ? e.message : String(e)
    // DPD pobiera etykietę tą samą drogą co zapis, więc wyłączony zapis blokuje też etykietę
    const m = /zapis wyłączony/.test(tresc) ? 'Etykieta niedostępna: nadawanie u przewoźnika jest wyłączone w ustawieniach przewoźnika (Ustawienia → Wysyłka i druk → Przewoźnicy), a ten przewoźnik daje etykietę tylko przy włączonym nadawaniu.' : `Etykieta jeszcze niedostępna: ${krotko(tresc)}`
    await db.shipment.update({ where: { id: s.id }, data: { labelError: m } })
    return { blad: m }
  }
}

// ─── Rozstrzygnięcie przesyłki niejednoznacznej ──────────────────────────────

/**
 * „Sprawdź u przewoźnika” dla przesyłki NIEJEDNOZNACZNEJ albo zawieszonej w TWORZENIE: odszukanie po referencji.
 * Znaleziona = UTWORZONA (numer, etykieta, zdarzenie); „nie powstała” (tylko gdy przewoźnik umie to stwierdzić) = BLAD
 * do ponownego utworzenia tą samą referencją; brak rozstrzygnięcia = zostaje, z komunikatem.
 */
export async function sprawdzPrzesylke(db: Db, shipmentId: string, o: { userId: string; deps?: DepsNadania }): Promise<{ wynik: 'UTWORZONA' | 'NIE_POWSTALA' | 'NADAL_NIEJASNE'; komunikat: string }> {
  const deps = o.deps ?? {}
  const s = await db.shipment.findUnique({ where: { id: shipmentId } })
  if (!s) return { wynik: 'NADAL_NIEJASNE', komunikat: 'Nie ma takiej przesyłki.' }
  const zawieszona = zawieszonaPrzesylka(s, teraz(deps), deps.registry)
  if (s.state !== 'NIEJEDNOZNACZNA' && !zawieszona) return { wynik: 'NADAL_NIEJASNE', komunikat: s.state === 'TWORZENIE' ? 'Przesyłka właśnie powstaje: odśwież za chwilę.' : 'Tej przesyłki nie trzeba sprawdzać.' }
  let adapter: ChannelAdapter & ShipmentCreator
  try {
    adapter = await adapterPrzesylki(db, s, deps)
  } catch (e) {
    return { wynik: 'NADAL_NIEJASNE', komunikat: krotko(e instanceof Error ? e.message : String(e)) }
  }
  if (!hasReferenceFinder(adapter)) return { wynik: 'NADAL_NIEJASNE', komunikat: `Ten przewoźnik nie pozwala odszukać przesyłki po referencji: sprawdź w jego panelu (referencja ${s.reference}).` }
  let found: Awaited<ReturnType<typeof adapter.findByReference>>
  try {
    found = await adapter.findByReference(s.reference)
  } catch (e) {
    const m = krotko(e instanceof Error ? e.message : String(e))
    // tylko z nierozstrzygniętej; przesyłka zapisana w międzyczasie jako UTWORZONA zostaje.
    // alert w tej samej transakcji co zmiana stanu (dedupe: alert już otwartej NIEJEDNOZNACZNEJ zostaje jeden)
    const zmieniono = await runTx(db, async (tx) => {
      const u = await tx.shipment.updateMany({ where: { id: s.id, state: { in: NIEROZSTRZYGNIETE } }, data: { state: 'NIEJEDNOZNACZNA', lastError: m } })
      if (u.count && s.state === 'TWORZENIE') await alert(tx, ALERT_PRZESYLKI, s.orderId, KOMUNIKAT_ALERTU(s), `przesylka:${s.id}`)
      return u.count > 0
    })
    if (!zmieniono) return wynikSprawdzenia(wynikIstniejacej(await db.shipment.findUniqueOrThrow({ where: { id: s.id } })))
    return { wynik: 'NADAL_NIEJASNE', komunikat: jestOrlen(s.adapterKey) ? `${m} ${ORLEN_GDZIE_SPRAWDZIC}` : `${m} Jeśli w panelu przewoźnika widać, czy przesyłka powstała, użyj „Rozstrzygnij ręcznie”.` }
  }
  if (!found.found) {
    const zapisano = await runTx(db, async (tx) => {
      await advisoryLock(tx, kluczBlokadyPrzesylki(s.orderId))
      const c = await tx.shipment.updateMany({ where: { id: s.id, state: { in: NIEROZSTRZYGNIETE } }, data: { state: 'BLAD', failureKind: 'PRZEJSCIOWY', lastError: 'Przewoźnik potwierdził, że przesyłka nie powstała: można ją utworzyć ponownie.' } })
      if (c.count) await zamknijAlert(tx, s.id, teraz(deps))
      return c.count > 0
    })
    if (!zapisano) return wynikSprawdzenia(wynikIstniejacej(await db.shipment.findUniqueOrThrow({ where: { id: s.id } })))
    return { wynik: 'NIE_POWSTALA', komunikat: 'Przesyłka nie powstała u przewoźnika: możesz utworzyć ją ponownie.' }
  }
  return wynikSprawdzenia(await zakonczUtworzona(db, s, adapter, found.externalRef ?? null, { userId: o.userId, deps }))
}

function wynikSprawdzenia(w: WynikNadania): { wynik: 'UTWORZONA' | 'NIE_POWSTALA' | 'NADAL_NIEJASNE'; komunikat: string } {
  if (w.wynik === 'UTWORZONA') return { wynik: 'UTWORZONA', komunikat: w.istniala ? 'Przesyłka jest już zapisana jako utworzona.' : (w.info ?? 'Przesyłka jest u przewoźnika: numer i etykieta zapisane.') }
  if (w.wynik === 'BLAD') return { wynik: 'NIE_POWSTALA', komunikat: 'Przesyłka nie powstała u przewoźnika: możesz utworzyć ją ponownie.' }
  if (w.wynik === 'ODMOWA') return { wynik: 'NIE_POWSTALA', komunikat: w.powod }
  if (w.wynik === 'W_TOKU') return { wynik: 'NADAL_NIEJASNE', komunikat: 'Przesyłka właśnie powstaje: odśwież za chwilę.' }
  return { wynik: 'NADAL_NIEJASNE', komunikat: 'Przewoźnik potwierdził przesyłkę bez numeru: sprawdź w jego panelu i użyj „Rozstrzygnij ręcznie”.' }
}

// ─── Rozstrzygnięcie ręczne ─────────────────────────────

export type RozstrzygniecieReczne = { wariant: 'ISTNIEJE'; numer: string } | { wariant: 'NIE_POWSTALA' }

/**
 * Identyfikator przesyłki wpisany przez człowieka z panelu przewoźnika: DPD = numer listu (ten sam wzorzec co
 * `numerListuDlaReferencji`), InPost ShipX = id przesyłki (liczba; numer nadania dociąga host). Inne moduły: litery,
 * cyfry, „-” i „_”.
 */
export function identyfikatorPoprawny(adapterKey: string, numer: string): boolean {
  if (adapterKey.startsWith('dpd.')) return /^[0-9A-Z]{6,40}$/.test(numer)
  if (adapterKey.startsWith('inpost.shipx')) return /^\d{1,20}$/.test(numer)
  // numer paczki Orlen Paczki (EAN-13); adapter sprawdza go na etykiecie paczki
  if (adapterKey.startsWith('orlenpaczka.')) return /^\d{13}$/.test(numer)
  // identyfikator przesyłki w ADE GLS (liczba); adapter sprawdza referencję tej przesyłki w ADE
  if (adapterKey.startsWith('gls.ade')) return /^\d{1,20}$/.test(numer)
  // numer nadania Poczty Polskiej albo GUID przesyłki z eNadawcy; adapter porównuje go z przesyłką tej referencji
  if (adapterKey.startsWith('pocztapolska.')) return /^[0-9A-Za-z]{10,40}$/.test(numer)
  // numer zamówienia Base Courier (cyfry) albo numer listu przewozowego; adapter sprawdza go u przewoźnika
  if (adapterKey.startsWith('basecourier.')) return /^[0-9A-Za-z]{1,40}$/.test(numer)
  return /^[0-9A-Za-z_-]{4,60}$/.test(numer)
}

/** odcisk referencji w polu „Referencje” przesyłki ADE GLS; zła referencja = sama referencja. */
function odciskDlaGls(reference: string): string {
  try {
    return odciskGls(reference)
  } catch {
    return reference
  }
}

/** odcisk referencji z etykiety Orlen Paczki (SenderOrders) do szukania w panelu; zła referencja = sama referencja. */
function odciskDlaEkranu(reference: string): string {
  try {
    return odciskReferencji(reference)
  } catch {
    return reference
  }
}

/** opis pola numeru przy „Rozstrzygnij ręcznie” i podpowiedź, gdzie szukać przesyłki w panelu przewoźnika. */
export function opisRozstrzygniecia(adapterKey: string, reference: string): { etykietaNumeru: string; wskazowka: string; odmowaNumeru: string } {
  if (adapterKey.startsWith('basecourier.'))
    return {
      etykietaNumeru: 'Numer zamówienia albo numer listu z panelu Base Courier',
      wskazowka: `W panelu Base Courier szukaj przesyłki z referencją ${reference} w polu „Zawartość przesyłki”. Kompletor sprawdzi wpisany numer w Base Courier, zanim go zapisze.`,
      odmowaNumeru: 'Podaj numer zamówienia z panelu Base Courier albo numer listu przewozowego (litery i cyfry, bez spacji).',
    }
  if (adapterKey.startsWith('gls.ade'))
    return {
      etykietaNumeru: 'Identyfikator przesyłki w ADE GLS (same cyfry)',
      wskazowka: `W panelu ADE GLS (potwierdzenia nadania) szukaj przesyłki z referencją ${odciskDlaGls(reference)} w polu „Referencje” i wpisz jej identyfikator. Kompletor sprawdzi w ADE, że przesyłka ma referencję tej przesyłki, zanim ją zapisze.`,
      odmowaNumeru: 'Podaj identyfikator przesyłki z ADE GLS (same cyfry).',
    }
  if (adapterKey.startsWith('pocztapolska.'))
    return {
      etykietaNumeru: 'Numer nadania z eNadawcy',
      wskazowka: `W eNadawcy szukaj przesyłki z numerem klienta ${reference.replace(/[^0-9a-zA-Z]/g, '').slice(0, 20)}. Kompletor sprawdzi wpisany numer w eNadawcy, zanim go zapisze.`,
      odmowaNumeru: 'Podaj numer nadania z eNadawcy (litery i cyfry, bez spacji).',
    }
  if (adapterKey.startsWith('orlenpaczka.'))
    return {
      etykietaNumeru: 'Numer paczki Orlen Paczki (13 cyfr)',
      wskazowka: `Paczek nadanych przez Kompletor nie widać w panelu Orlen Paczki (WebTrucker): numer weź z etykiety paczki albo z listy paczek, którą pokazuje „Sprawdź u przewoźnika” (numery nadane przez API zaczynają się od 21). Na etykiecie paczki Kompletora w danych referencyjnych nadawcy jest odcisk referencji ${odciskDlaEkranu(reference)}. Kompletor sprawdzi numer w Orlen Paczce, zanim go zapisze. „Nie powstała” wybierz dopiero wtedy, gdy każda paczka z tej listy ma swoje zamówienie w Kompletorze.`,
      odmowaNumeru: 'Podaj 13-cyfrowy numer paczki z Orlen Paczki (same cyfry).',
    }
  // Wysyłam z Allegro rozstrzyga się numerem przesyłki z Allegro (UUID), nie numerem listu
  if (WYSYLAM_KEY_RE.test(adapterKey))
    return {
      etykietaNumeru: 'Numer przesyłki z panelu Allegro',
      wskazowka: `W panelu Allegro (Wysyłam z Allegro) szukaj przesyłki tego zamówienia. Kompletor sprawdzi, że to przesyłka utworzona przez Kompletor dla referencji ${reference}, zanim ją zapisze.`,
      odmowaNumeru: 'Podaj numer przesyłki z panelu Allegro (identyfikator w postaci 8-4-4-4-12 znaków).',
    }
  if (adapterKey.startsWith('inpost.shipx'))
    return { etykietaNumeru: 'Id przesyłki z panelu InPost', wskazowka: `W panelu InPost szukaj przesyłki z referencją ${reference}.`, odmowaNumeru: 'Podaj id przesyłki z panelu InPost (same cyfry).' }
  return {
    etykietaNumeru: 'Numer listu przewozowego',
    wskazowka: `W panelu przewoźnika szukaj przesyłki z referencją ${reference}.`,
    odmowaNumeru: 'Podaj numer listu przewozowego z panelu przewoźnika (wielkie litery i cyfry, bez spacji).',
  }
}

export type WynikRozstrzygniecia = { wynik: 'UTWORZONA' | 'ANULOWANA' | 'ODMOWA'; komunikat: string }

/**
 * numer wpisany przy „Rozstrzygnij ręcznie” potwierdza przewoźnik, zanim
 * host zapisze UTWORZONA. Kolejno: `confirmManual` modułu (InPost: przesyłka o tym id z referencją tej przesyłki i z
 * numerem nadania; DPD: etykieta tego numeru listu; Base Courier: zamówienie z referencją; Wysyłam z Allegro: komenda
 * utworzenia tej referencji wskazuje wpisaną przesyłkę), bez niej numer nadania od przewoźnika (`getTrackingNumber`
 * musi go zwrócić), a bez tego etykieta (`getLabel` musi się udać). Gdy moduł sam nie porównał
 * przesyłki z referencją (`referencjaSprawdzona`), a umie odszukać po referencji, host porównuje: inny numer pod tą
 * referencją = odmowa (numery DPD są seryjne, literówka trafia w sąsiedni list tej samej firmy); błąd odszukania
 * (kształt DPD [NIEPEWNE]) = przyjęcie z dopiskiem. Odmowa albo błąd = nic nie zapisane, przesyłka zostaje do
 * rozstrzygnięcia. `getLabel`, odszukanie i odczyty nie tworzą przesyłki: wolno powtarzać.
 */
async function potwierdzNumer(adapter: ChannelAdapter & ShipmentCreator, numer: string, s: Shipment): Promise<{ externalRef: string; info?: string } | { odmowa: string }> {
  let c: PotwierdzenieRecznego
  try {
    c = await potwierdzWModule(adapter, numer, s)
  } catch (e) {
    const m = krotko(e instanceof Error ? e.message : String(e))
    if (e instanceof AdapterError && e.kind === 'TRWALY') return { odmowa: `Przewoźnik nie potwierdził przesyłki o numerze ${numer} (${m}). Sprawdź numer w panelu przewoźnika. Nic nie zapisano.` }
    return { odmowa: `Nie udało się sprawdzić numeru u przewoźnika: ${m}. Spróbuj ponownie za chwilę. Nic nie zapisano.` }
  }
  if ('odmowa' in c) return c
  const wynik = { externalRef: c.externalRef, ...(c.info ? { info: c.info } : {}) }
  if (c.referencjaSprawdzona || !hasReferenceFinder(adapter)) return wynik
  const bezPorownania = { externalRef: c.externalRef, info: [c.info, 'Nie dało się porównać numeru z referencją tej przesyłki u przewoźnika: sprawdzono tylko, że numer istnieje.'].filter(Boolean).join(' ') }
  let f: Awaited<ReturnType<typeof adapter.findByReference>>
  try {
    f = await adapter.findByReference(s.reference)
  } catch {
    return bezPorownania
  }
  if (!f.found) return { odmowa: `Przewoźnik nie ma przesyłki z referencją tej przesyłki (${s.reference}), więc numer ${numer} należy do innej paczki. Sprawdź w panelu przewoźnika. Nic nie zapisano.` }
  if (!f.externalRef) return bezPorownania
  if (f.externalRef !== c.externalRef) return { odmowa: `Pod referencją tej przesyłki przewoźnik ma inny numer (${f.externalRef}) niż wpisany: sprawdź w panelu przewoźnika. Nic nie zapisano.` }
  return { externalRef: c.externalRef, info: [c.info, 'Numer zgadza się z referencją tej przesyłki u przewoźnika.'].filter(Boolean).join(' ') }
}

/** Sprawdzenie numeru przez sam moduł przewoźnika (bez porównania z odszukaniem po referencji). Wyjątki idą wyżej. */
async function potwierdzWModule(adapter: ChannelAdapter & ShipmentCreator, numer: string, s: Shipment): Promise<PotwierdzenieRecznego> {
  if (typeof adapter.confirmManual === 'function') return adapter.confirmManual(numer, s.reference)
  if (typeof adapter.getTrackingNumber === 'function') {
    const n = await adapter.getTrackingNumber(numer)
    return n
      ? { externalRef: numer, info: `Numer sprawdzony u przewoźnika (numer nadania ${n}).` }
      : { odmowa: 'Przewoźnik nie podał numeru nadania dla tego identyfikatora: sprawdź go w panelu przewoźnika albo spróbuj za kilka minut. Nic nie zapisano.' }
  }
  await adapter.getLabel(numer, 'PDF')
  return { externalRef: numer, info: 'Numer sprawdzony u przewoźnika (etykieta tego numeru jest dostępna).' }
}

/**
 * Czy wpisany numer należy już do innej przesyłki tej samej firmy (identyfikator u przewoźnika albo numer nadania),
 * w dowolnym stanie, także anulowanej i z innego zamówienia. Porównanie w obrębie tego samego przewoźnika ALBO tej
 * samej rodziny modułu (`adapterKey` do pierwszej kropki): DPD i DPD_EMPIK idą jednym modułem `dpd.*`, z jednego
 * konta i jednej puli numerów listów. Wtedy odmowa z komunikatem: numer innej paczki zapisany przy tej przesyłce
 * dałby jej etykietę i numer, a prawdziwa paczka zostałaby bez śladu.
 */
async function numerInnejPrzesylki(db: Db, s: Shipment, numery: string[]): Promise<string | null> {
  const wartosci = [...new Set(numery.filter(Boolean))]
  if (!wartosci.length) return null
  const rodzina = `${s.adapterKey.split('.')[0]}.`
  const inna = await db.shipment.findFirst({
    where: {
      id: { not: s.id },
      AND: [
        { OR: [{ carrier: s.carrier }, { adapterKey: { startsWith: rodzina } }] },
        { OR: [{ externalRef: { in: wartosci } }, { trackingNumber: { in: wartosci } }] },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { orderId: true, extraNo: true, state: true, order: { select: { externalId: true } } },
  })
  if (!inna) return null
  const czyja = inna.extraNo > 0 ? `dodatkowej przesyłki nr ${inna.extraNo}` : 'przesyłki głównej'
  const zamowienie = inna.orderId === s.orderId ? 'tego samego zamówienia' : `zamówienia ${inna.order.externalId}`
  const anul = inna.state === 'ANULOWANA' ? ' (anulowanej)' : ''
  return `Ten numer ma już w Kompletorze inna paczka: ${czyja}${anul} ${zamowienie}. Wpisz numer tej przesyłki z panelu przewoźnika (szukaj po referencji ${s.reference}). Nic nie zapisano.`
}

/**
 * „Rozstrzygnij ręcznie” dla przesyłki NIEJEDNOZNACZNEJ albo zawieszonej w TWORZENIE (osoba z `przesylki.rozstrzyganie`,
 * po sprawdzeniu w panelu przewoźnika). Dla DPD to droga docelowa: odszukanie po referencji jest [NIEPEWNE] i może
 * nigdy nie potwierdzić paczki.
 *   ISTNIEJE + numer: jak potwierdzone odszukanie (UTWORZONA, numer nadania, zdarzenia, „Do wysłania”, etykieta);
 *   NIE_POWSTALA: ANULOWANA; następne „Utwórz przesyłkę” dostaje NOWĄ referencję (`anulowane + 1`).
 * Oba: wpis AuditLog `PRZESYLKA_ROZSTRZYGNIECIE` (kto, kiedy, wariant) i zamknięcie alertu w transakcji zapisu stanu.
 */
export async function rozstrzygnijRecznie(db: Db, shipmentId: string, r: RozstrzygniecieReczne, o: { userId: string; deps?: DepsNadania }): Promise<WynikRozstrzygniecia> {
  const deps = o.deps ?? {}
  const s = await db.shipment.findUnique({ where: { id: shipmentId } })
  if (!s) return { wynik: 'ODMOWA', komunikat: 'Nie ma takiej przesyłki.' }
  const zawieszona = zawieszonaPrzesylka(s, teraz(deps), deps.registry)
  if (s.state !== 'NIEJEDNOZNACZNA' && !zawieszona)
    return { wynik: 'ODMOWA', komunikat: s.state === 'TWORZENIE' ? 'Przesyłka właśnie powstaje: odśwież za chwilę.' : 'Ręcznie rozstrzyga się tylko przesyłkę, o której nie wiadomo, czy powstała.' }
  const actorId = `user:${o.userId}`
  const zmienione: WynikRozstrzygniecia = { wynik: 'ODMOWA', komunikat: 'Stan przesyłki zmienił się w międzyczasie: odśwież kartę zamówienia.' }
  if (r.wariant === 'NIE_POWSTALA') {
    const ok = await runTx(db, async (tx) => {
      await advisoryLock(tx, kluczBlokadyPrzesylki(s.orderId))
      const u = await tx.shipment.updateMany({ where: { id: s.id, state: { in: NIEROZSTRZYGNIETE } }, data: { state: 'ANULOWANA', failureKind: null, lastError: 'Rozstrzygnięte ręcznie: przesyłka nie powstała u przewoźnika (sprawdzone w jego panelu).' } })
      if (!u.count) return false
      await tx.auditLog.create({ data: { entity: ROZSTRZYGNIECIE_AUDIT, entityId: s.id, actorId, after: { wariant: 'NIE_POWSTALA', orderId: s.orderId, reference: s.reference, poprzedniStan: s.state } } })
      await tx.orderEvent.create({ data: { orderId: s.orderId, kind: 'PRZESYLKA_ANULOWANA', actorId, data: { przesylka: s.id, przewoznik: s.carrier, rozstrzygniecie: 'RECZNE' } } })
      await zamknijAlert(tx, s.id, teraz(deps))
      return true
    })
    if (!ok) return zmienione
    return { wynik: 'ANULOWANA', komunikat: s.extraNo > 0 ? `Zapisane: dodatkowa przesyłka nr ${s.extraNo} nie powstała. Możesz dodać przesyłkę od nowa.` : 'Zapisane: przesyłka nie powstała. Następne „Utwórz przesyłkę” użyje nowej referencji.' }
  }
  const numer = String(r.numer ?? '').replace(/\s+/g, '')
  if (!identyfikatorPoprawny(s.adapterKey, numer)) return { wynik: 'ODMOWA', komunikat: opisRozstrzygniecia(s.adapterKey, s.reference).odmowaNumeru }
  // numer innej przesyłki z Kompletora (np. główna z tej samej karty): DPD potwierdza tylko, że etykieta numeru istnieje
  const dubel = await numerInnejPrzesylki(db, s, [numer])
  if (dubel) return { wynik: 'ODMOWA', komunikat: dubel }
  let adapter: ChannelAdapter & ShipmentCreator
  try {
    adapter = await adapterPrzesylki(db, s, deps)
  } catch (e) {
    return { wynik: 'ODMOWA', komunikat: krotko(e instanceof Error ? e.message : String(e)) }
  }
  // wpisany numer zawsze potwierdza przewoźnik, zanim zapiszemy UTWORZONA (stan ostateczny):
  // literówka nie może dać cudzego numeru nadania w sklepie i u klienta ani etykiety innej paczki
  const c = await potwierdzNumer(adapter, numer, s)
  if ('odmowa' in c) return { wynik: 'ODMOWA', komunikat: c.odmowa }
  // identyfikator od przewoźnika może się różnić od wpisanego (np. numer listu zamiast id)
  const dubelRef = c.externalRef !== numer ? await numerInnejPrzesylki(db, s, [c.externalRef]) : null
  if (dubelRef) return { wynik: 'ODMOWA', komunikat: dubelRef }
  const externalRef = c.externalRef
  const sprawdzenie = c.info
  const w = await zakonczUtworzona(db, s, adapter, externalRef, { userId: o.userId, deps, slad: { wariant: 'ISTNIEJE', numer, poprzedniStan: s.state, ...(sprawdzenie ? { sprawdzenie } : {}) } })
  if (w.wynik === 'UTWORZONA' && !w.istniala) return { wynik: 'UTWORZONA', komunikat: `Zapisane: przesyłka istnieje u przewoźnika.${sprawdzenie ? ` ${sprawdzenie}` : ''}${w.info ? ` ${w.info}` : ''}` }
  return zmienione
}

// ─── Anulowanie u przewoźnika ────────────────────────────────────

export const ANULOWANIE_AUDIT = 'PRZESYLKA_ANULOWANIE'
export type WynikAnulowania = { wynik: 'ANULOWANA' | 'ODMOWA' | 'BLAD'; komunikat: string }

/**
 * „Anuluj przesyłkę” u przewoźnika, który to umie (`shipment.cancel`, dziś Wysyłam z Allegro). Referencja anulowania
 * jest deterministyczna z referencji przesyłki: podwójne kliknięcie i ponowienie wysyłają jedną komendę. Po OK przesyłka
 * jest ANULOWANA (następne „Utwórz przesyłkę” dostaje nową referencję), wpis w historii zamówienia i dzienniku zmian.
 * Status zamówienia zostaje (numer nadania mógł już trafić do kanału: zmienia go nowa przesyłka).
 */
export async function anulujPrzesylke(db: Db, shipmentId: string, o: { userId: string; deps?: DepsNadania }): Promise<WynikAnulowania> {
  const deps = o.deps ?? {}
  const s = await db.shipment.findUnique({ where: { id: shipmentId } })
  if (!s) return { wynik: 'ODMOWA', komunikat: 'Nie ma takiej przesyłki.' }
  if (s.state !== 'UTWORZONA' || !s.externalRef) return { wynik: 'ODMOWA', komunikat: 'Anuluje się tylko utworzoną przesyłkę.' }
  const ord = await db.order.findUnique({ where: { id: s.orderId }, select: { status: true, channel: true, channelAccountId: true } })
  if (s.extraNo === 0 && ord && (ord.status === 'WYSLANE' || ord.status === 'ODEBRANE')) return { wynik: 'ODMOWA', komunikat: 'Paczka jest już wysłana: anulowanie tylko w panelu przewoźnika.' }
  // ta sama bramka trybu co przy nadaniu; konto przełączone z powrotem na cień nie wysyła nic do przewoźnika
  const odmowaTrybu = await bramkaTrybu(db, ord, deps, 'anulowanie')
  if (odmowaTrybu) return { wynik: 'ODMOWA', komunikat: odmowaTrybu }
  let adapter: ChannelAdapter & ShipmentCreator
  try {
    adapter = await adapterPrzesylki(db, s, deps)
  } catch (e) {
    return { wynik: 'BLAD', komunikat: krotko(e instanceof Error ? e.message : String(e)) }
  }
  if (!hasShipmentCanceller(adapter)) return { wynik: 'ODMOWA', komunikat: 'Ten przewoźnik nie anuluje przesyłek z Kompletora: anuluj ją w jego panelu.' }
  const reference = deriveReference([s.reference, 'anulowanie'])
  let out: WriteOutcome
  try {
    out = await adapter.cancelShipment(s.externalRef, reference)
  } catch (e) {
    out = { kind: 'PRZEJSCIOWY', reference, message: krotko(e instanceof Error ? e.message : String(e)) }
  }
  if (out.kind !== 'OK') return { wynik: 'BLAD', komunikat: `Przewoźnik nie anulował przesyłki: ${krotko(out.message)}${out.kind === 'PRZEJSCIOWY' ? ' Spróbuj ponownie za chwilę.' : ''}` }
  const actorId = `user:${o.userId}`
  const zapisano = await runTx(db, async (tx) => {
    await advisoryLock(tx, kluczBlokadyPrzesylki(s.orderId))
    const u = await tx.shipment.updateMany({ where: { id: s.id, state: 'UTWORZONA' }, data: { state: 'ANULOWANA', lastError: 'Anulowana u przewoźnika.' } })
    if (!u.count) return false
    // numer anulowanej przesyłki nie idzie już do kanału (oczekujący zapis zamknięty bez alertu),
    // a numer nadania zamówienia (ostatnie zdarzenie z polem `nadanie`, lib/api/zamowienia.ts) jest czyszczony pustym
    // `nadanie`; stary numer zostaje w historii jako `anulowaneNadanie`. Wiersz WYSYLANIE (worker właśnie wysyła) zostaje.
    let zamknieteZapisy = 0
    if (s.trackingNumber && s.extraNo === 0) {
      const doZamkniecia = await tx.channelWrite.findMany({ where: { orderId: s.orderId, kind: 'NADANIE', key: s.trackingNumber, state: { in: ['OCZEKUJE', 'BLAD', 'NIEJEDNOZNACZNY'] } }, select: { id: true } })
      if (doZamkniecia.length) {
        zamknieteZapisy = (
          await tx.channelWrite.updateMany({
            where: { id: { in: doZamkniecia.map((w) => w.id) }, state: { in: ['OCZEKUJE', 'BLAD', 'NIEJEDNOZNACZNY'] } },
            data: { state: 'WYSLANE', doneAt: teraz(deps), lockedAt: null, lastError: null, result: 'pominięte: przesyłka anulowana' },
          })
        ).count
        // alert zapisu numeru (KANAL_ZAPIS_*, klucz `zapis:<id zapisu>:…`) zamykamy razem z wierszem
        await tx.alert.updateMany({ where: { closedAt: null, OR: doZamkniecia.map((w) => ({ dedupeKey: { startsWith: `zapis:${w.id}:` } })) }, data: { closedAt: teraz(deps) } })
      }
    }
    await tx.orderEvent.create({
      data: {
        orderId: s.orderId,
        kind: 'PRZESYLKA_ANULOWANA',
        actorId,
        // dodatkowa: bez pustego `nadanie` (numer głównej przesyłki w API i kanale zostaje)
        data: { przesylka: s.id, przewoznik: s.carrier, ...(s.extraNo > 0 ? { numerDodatkowej: s.extraNo, ...(s.trackingNumber ? { anulowaneNadanieDodatkowej: s.trackingNumber } : {}) } : s.trackingNumber ? { nadanie: '', anulowaneNadanie: s.trackingNumber } : {}), ...(zamknieteZapisy ? { zamknieteZapisyNumeru: zamknieteZapisy } : {}) },
      },
    })
    await tx.auditLog.create({ data: { entity: ANULOWANIE_AUDIT, entityId: s.id, actorId, after: { orderId: s.orderId, reference: s.reference, adapterKey: s.adapterKey } } })
    return true
  })
  return zapisano ? { wynik: 'ANULOWANA', komunikat: 'Przesyłka anulowana u przewoźnika. Możesz utworzyć nową.' } : { wynik: 'ANULOWANA', komunikat: 'Przesyłka była już anulowana.' }
}

/** Czy przesyłkę tego modułu da się anulować z Kompletora (po manifeście, bez sekretów i sieci). */
export function przewoznikAnuluje(adapterKey: string, registry: AdapterRegistry = defaultRegistry()): boolean {
  const m = registry.get(adapterKey)?.manifest
  return !!m && !m.readOnly && m.capabilities.includes('shipment.cancel')
}

// ─── Widok dla karty i stanowiska ────────────────────────────────────────────

export interface WidokPrzesylki {
  id: string
  stan: Shipment['state']
  przewoznik: Carrier
  gabaryt: string | null
  numer: string | null
  /** strona śledzenia u przewoźnika dla utworzonej przesyłki (`linkSledzeniaPanelu`); null = sam numer */
  link: string | null
  etykieta: boolean
  etykietaBlad: string | null
  blad: string | null
  /** informacja przewoźnika przy udanym nadaniu (np. zmieniony punkt odbioru) ze zdarzenia utworzenia. */
  uwaga: string | null
  /** pokazać „Anuluj przesyłkę” (utworzona u przewoźnika, który anuluje z Kompletora). */
  moznaAnulowac: boolean
  /** Pokazać „Sprawdź u przewoźnika” (niejednoznaczna albo zawieszona). */
  doSprawdzenia: boolean
  /** referencja Kompletora (klucz idempotencji, bez danych klienta) do odszukania w panelu przewoźnika. */
  referencja: string
  /** opis pola numeru i podpowiedź do „Rozstrzygnij ręcznie” zależnie od modułu przewoźnika. */
  rozstrzygniecie: { etykietaNumeru: string; wskazowka: string }
  utworzono: Date
  proba: number
  /** Ostatni stan u przewoźnika ze śledzenia (tekst do pokazania i chwila odczytu); null = jeszcze nie odczytano. */
  uKuriera: { nazwa: string; kiedy: Date } | null
}

/** Ostatnia przesyłka paczki (aktywna albo ostatnia nieudana) do wyświetlenia; bez danych klienta. */
export async function widokPrzesylki(db: Db, orderId: string, now = new Date(), registry: AdapterRegistry = defaultRegistry()): Promise<WidokPrzesylki | null> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { packageNo: true } })
  if (!o) return null
  const s = (await aktywnaPaczki(db, orderId, o.packageNo)) ?? (await db.shipment.findFirst({ where: { orderId, packageNo: o.packageNo, extraNo: 0, state: 'BLAD' }, orderBy: { updatedAt: 'desc' } }))
  if (!s) return null
  const zdarzenie =
    s.state === 'UTWORZONA' ? await db.orderEvent.findFirst({ where: { orderId, kind: 'PRZESYLKA_UTWORZONA', data: { path: ['przesylka'], equals: s.id } }, orderBy: { createdAt: 'desc' }, select: { data: true } }) : null
  const uwaga = (zdarzenie?.data as { uwaga?: unknown } | null | undefined)?.uwaga
  return {
    id: s.id,
    stan: s.state,
    przewoznik: s.carrier,
    gabaryt: s.parcelSize && s.parcelSize in GABARYTY ? GABARYTY[s.parcelSize as Gabaryt] : s.parcelSize,
    numer: s.trackingNumber,
    link: s.state === 'UTWORZONA' ? linkSledzeniaPanelu(s.carrier, s.trackingNumber, s.adapterKey) : null,
    etykieta: !!s.labelCiphertext,
    etykietaBlad: s.labelError,
    blad: s.lastError,
    uwaga: typeof uwaga === 'string' && uwaga ? uwaga : null,
    moznaAnulowac: s.state === 'UTWORZONA' && !!s.externalRef && przewoznikAnuluje(s.adapterKey, registry),
    doSprawdzenia: s.state === 'NIEJEDNOZNACZNA' || zawieszonaPrzesylka(s, now, registry),
    referencja: s.reference,
    rozstrzygniecie: (({ etykietaNumeru, wskazowka }) => ({ etykietaNumeru, wskazowka }))(opisRozstrzygniecia(s.adapterKey, s.reference)),
    utworzono: s.createdAt,
    proba: s.attempt,
    uKuriera: s.state === 'UTWORZONA' ? (({ nazwa, kiedy }) => ({ nazwa, kiedy }))((await statusyKuriera(db, [orderId])).get(orderId) ?? { nazwa: '', kiedy: s.createdAt }) : null,
  }
}

/** ślad poprzedniej przesyłki paczki, gdy ostatnia została anulowana (bez danych klienta). */
export interface SladAnulowanej {
  kiedy: Date
  /** true = oznaczona ręcznie jako niepowstała („Rozstrzygnij ręcznie”), false = anulowana u przewoźnika. */
  recznie: boolean
  /** `user:<id>` z dziennika zmian; null = brak wpisu. */
  actorId: string | null
}

/**
 * Ostatnia przesyłka paczki jest ANULOWANA i nie ma nowszej (aktywnej ani nieudanej): karta pokazuje nad „Utwórz
 * przesyłkę” jedną linię „poprzednią oznaczono jako niepowstałą (kto, kiedy)”, żeby zmiana zmiany nie nadała drugiej
 * paczki w ciemno. Tylko odczyt.
 */
export async function sladAnulowanej(db: Db, orderId: string): Promise<SladAnulowanej | null> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { packageNo: true } })
  if (!o || (await aktywnaPaczki(db, orderId, o.packageNo))) return null
  const s = await db.shipment.findFirst({ where: { orderId, packageNo: o.packageNo, extraNo: 0, state: { in: ['ANULOWANA', 'BLAD'] } }, orderBy: { updatedAt: 'desc' }, select: { id: true, state: true, updatedAt: true } })
  if (!s || s.state !== 'ANULOWANA') return null
  const a = await db.auditLog.findFirst({ where: { entityId: s.id, entity: { in: [ROZSTRZYGNIECIE_AUDIT, ANULOWANIE_AUDIT] } }, orderBy: { createdAt: 'desc' }, select: { entity: true, actorId: true, createdAt: true } })
  return { kiedy: a?.createdAt ?? s.updatedAt, recznie: a?.entity === ROZSTRZYGNIECIE_AUDIT, actorId: a?.actorId ?? null }
}

/**
 * przesyłka należy do tego zamówienia. Akcje karty dostają oba identyfikatory z ekranu, a host
 * działa po `shipmentId`; bez tej bramki akcja mogłaby zmienić przesyłkę innego zamówienia tej samej firmy (izolację firm
 * i tak daje RLS).
 */
export async function przesylkaZamowienia(db: Db, shipmentId: string, orderId: string): Promise<boolean> {
  return !!(await db.shipment.findFirst({ where: { id: shipmentId, orderId }, select: { id: true } }))
}

/**
 * blokada przesyłki zamówienia w cudzej transakcji (poprawka adresu) i sprawdzenie, czy paczka ma już aktywną
 * przesyłkę. Ta sama blokada co rezerwacja w `utworzPrzesylke`, więc poprawka i nadanie nie przeplatają się.
 */
export async function przesylkaPodBlokada(tx: Tx, orderId: string): Promise<boolean> {
  await advisoryLock(tx, kluczBlokadyPrzesylki(orderId))
  const o = await tx.order.findUnique({ where: { id: orderId }, select: { packageNo: true } })
  return !!o && !!(await aktywnaPaczki(tx, orderId, o.packageNo))
}

/** Czy wolno poprawić adres i punkt (przed nadaniem: brak aktywnej przesyłki paczki). */
export async function moznaPoprawicAdres(db: Db, orderId: string): Promise<boolean> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { packageNo: true } })
  return !!o && !(await aktywnaPaczki(db, orderId, o.packageNo))
}
