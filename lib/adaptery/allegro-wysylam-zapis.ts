// Wysyłam z Allegro z nadawaniem ZA WYŁĄCZNIKIEM: `allegro.wysylam.zapis.v1`. Rozszerza tryb
// „przygotuj, nie wysyłaj” (`allegro.wysylam.v1`, bez zmian) o utworzenie przesyłki, etykietę, numer nadania
// i anulowanie. Woła go tylko host przesyłek (lib/wysylka/nadanie.ts) z jego bramkami (konto w PRACA, reguła przewoźnika
// z `zapisWlaczony: true`); bez wyłącznika `createShipment` i `cancelShipment` zwracają TRWALY bez żądania.
//
// Utworzenie: `POST /shipment-management/shipments/create-commands` asynchronicznie, wynik z `GET .../{commandId}`
// (IN_PROGRESS → SUCCESS z `shipmentId` albo ERROR). `commandId` = deterministyczny z referencji hosta i numeru próby
// (1…5): przed wysłaniem adapter czyta próby po kolei — SUCCESS = przesyłka już jest (zero drugiej płatnej etykiety),
// IN_PROGRESS = czekamy na nią, ERROR = następny numer, 404 = wolny numer (zawsze cała piątka). Dzięki temu ponowienie po odmowie hosta (ta sama
// referencja, lib/wysylka/nadanie.ts) nie trafia w zużyty commandId, a zgubiona odpowiedź nie tworzy drugiej przesyłki.
// Treść komendy: propozycja Allegro (`delivery-proposals`: metoda, punkt, nadawca) + gabaryt A/B/C, waga i pobranie
// z hosta (lib/wysylka/zlecenie-allegro.ts) + adres z karty zamówienia (poprawka adresu). Dane odbiorcy wyłącznie
// w pamięci tego wywołania; w wynikach i błędach tylko identyfikatory i kody błędów Allegro.
//
// Zakres: funkcja „Nadawanie Wysyłam z Allegro” (`shipments:read` + `shipments:write`, lib/zrodla/allegro-zakresy.ts).
//
// Zamówienie odbioru przez kuriera (zdolność shipment.pickup, osobne pole konta „Zamawianie kuriera z Kompletora”):
// odbiór dotyczy konkretnych przesyłek (`PickupOrderRequest.przesylki`), tylko tych, których przewoźnik w Allegro
// (`carrier` przesyłki) to przewoźnik z pola `przewoznikOdbioru` (domyślnie ALLEGRO, czyli Allegro One); paczki do
// automatów i punktów innych przewoźników zostają poza zamówieniem. Terminy: `POST /shipment-management/pickup-proposals`
// (tylko podpowiedź: termin Allegro, który pokrywa okno, zastępuje godziny z okna; bez takiego terminu idą godziny
// z okna i rozstrzyga odpowiedź na samo zamówienie). Zamówienie: `POST /shipment-management/pickups/create-commands`,
// wynik z `GET .../{commandId}` (IN_PROGRESS → SUCCESS z `pickupId` i `carrierPickupId` albo ERROR). commandId jak
// przy przesyłkach: deterministyczny z referencji hosta i numeru próby, więc powtórka i zgubiona odpowiedź nie zamawiają
// drugiego odbioru. Kształt z specyfikacji REST API (PickupProposalsRequestDto, PickupCreateCommandDto,
// CreatePickupCommandStatusDto) i poradnika Wysyłam z Allegro.
import { type FetchLike, SourceError, Throttle } from '../zrodla/http'
import { ALLEGRO_API_URL } from '../zrodla/allegro'
import { ALLEGRO_CARRIER_ID_RE, ALLEGRO_PICKUP_ID_RE, ALLEGRO_WAYBILL_RE } from '../zrodla/allegro-wysylam'
import { etykietaFunkcji } from '../zrodla/allegro-zakresy'
import { AllegroWriter, type AllegroWriteResult, kodyBledowAllegro, WRITE_TIMEOUT_MS } from '../zrodla/allegro-zapis'
import { buildCreateCommandPayload } from '../wysylka/zlecenie-allegro'
import { type AllegroDeliveryOption, dopasujWymiaryDoLimitu, parseDeliveryOptions } from '../wysylka/allegro'
import { telefonBezPrefiksu, telefonZPrefiksem } from '../wysylka/telefon'
import { asOutcome, sleep, writeWithToken } from './allegro-zapis'
import { ALLEGRO_WYSYLAM_MANIFEST, AllegroWysylamAdapter } from './allegro-wysylam'
import {
  AdapterError,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type GrupaOdbioru,
  type OdbiorPrzyjety,
  type LabelFormat,
  type PickupAvailability,
  type PickupGrouping,
  type PickupOrderer,
  type PickupOrderRequest,
  type PotwierdzenieRecznego,
  type RecipientAddress,
  type ReferenceFinder,
  type ReferenceLookup,
  type ShipmentCreateRequest,
  type ShipmentCreator,
  type ShipmentTracker,
  type OdczytPrzesylki,
  type StanDrogi,
  type StanPrzesylki,
  type WriteOutcome,
  type WynikOdbioru,
} from './kontrakt'
import { deriveReference } from './rejestr'

export const ALLEGRO_WYSYLAM_ZAPIS_KEY = 'allegro.wysylam.zapis.v1'
export const FUNKCJA_WYSYLAM = etykietaFunkcji('wysylamZAllegro')
const ZAKRES = `funkcja „${FUNKCJA_WYSYLAM}”: połącz konto z Allegro ponownie z zaznaczoną funkcją`
export const NADAWANIE_WYLACZONE = 'nadawanie Wysyłam z Allegro wyłączone w ustawieniach przewoźnika (zapis wyłączony)'
/** Najwięcej prób (commandId) na referencję; po pięciu odmowach Allegro decyduje człowiek. */
export const MAX_PROB_KOMENDY = 5
/** Odpytań wyniku komendy po wysłaniu (domyślnie co 2 s, `ctx.http.pollDelayMs`): ok. 12 s przy kliknięciu. */
export const SHIPMENT_POLLS = 6
/** deadline ścienny odpytywania po wysłaniu; po nim W_TOKU, resztę przejmuje „Sprawdź u przewoźnika”. */
export const CZEKAJ_MS = 30_000
/**
 * Odpytywanie wyniku komendy odbioru: Allegro przekazuje zamówienie do przewoźnika asynchronicznie, więc dłużej niż
 * przy przesyłkach (ok. 45 s; wiersz zlecenia w toku przechodzi w niewiadomą dopiero po 5 minutach).
 */
export const ODBIOR_POLLS = 22
export const ODBIOR_CZEKAJ_MS = 45_000
/** Ile przesyłek czytamy naraz przy sprawdzaniu przewoźnika przed zamówieniem odbioru. */
const ODCZYT_PRZESYLEK_NARAZ = 5
/** Limit czasu jednego odczytu stanu komendy (zwykły zapis ma `WRITE_TIMEOUT_MS`). */
export const KOMENDA_TIMEOUT_MS = 15_000
/** Odczyt klientem tylko-do-odczytu (`call`): 3 próby po 60 s + przerwy 2 i 4 s. */
const ODCZYT_NAJDLUZEJ_MS = 3 * 60_000 + 6_000
/**
 * Najgorszy czas żywego „Utwórz przesyłkę” Wysyłam z Allegro, od rezerwacji wiersza (TWORZENIE) do zapisu wyniku w hoście:
 * próby 1…5 (odczyt komend), propozycja dostawy, POST, odpytywanie (deadline + ostatni odczyt w locie + przerwa),
 * odszukanie po referencji w `executeWrite` (5 odczytów) i numer nadania; plus jedno odświeżenie tokena po 401 (
 * `writeWithToken` po 401 wysyła POST drugi raz, więc drugi `WRITE_TIMEOUT_MS`). Przerwy `Throttle` nie są
 * liczone (przy kliknięciu kolejka pusta); pokrywa je zapas hosta. Manifest podaje tę sumę jako `shipmentMaxCreateMs`, a host
 * (`progZawieszenia`, lib/wysylka/nadanie.ts) czeka dłużej, zanim pokaże „Sprawdź u przewoźnika”.
 */
export const NAJDLUZSZE_UTWORZENIE_MS =
  MAX_PROB_KOMENDY * KOMENDA_TIMEOUT_MS + ODCZYT_NAJDLUZEJ_MS + 2 * WRITE_TIMEOUT_MS + (CZEKAJ_MS + KOMENDA_TIMEOUT_MS + 2_000) + MAX_PROB_KOMENDY * KOMENDA_TIMEOUT_MS + ODCZYT_NAJDLUZEJ_MS + WRITE_TIMEOUT_MS

export const ALLEGRO_WYSYLAM_ZAPIS_MANIFEST: AdapterManifest = {
  ...ALLEGRO_WYSYLAM_MANIFEST,
  adapterKey: ALLEGRO_WYSYLAM_ZAPIS_KEY,
  version: '1.0.0',
  displayName: 'Wysyłam z Allegro (nadawanie, etykieta i anulowanie za wyłącznikiem)',
  // shipment.track = historia statusów Allegro (`/order/carriers/{carrier}/tracking`), sam odczyt; zwraca też
  // doręczenie, więc host pyta dalej po „Wysłane” (`trackReportsDelivered`)
  // shipment.pickup: zamówienie odbioru przez kuriera, za osobnym polem konta `zamawianieKuriera`
  capabilities: ['shipment.prepare', 'shipment.create', 'shipment.cancel', 'reference.find', 'shipment.track', 'shipment.pickup'],
  trackReportsDelivered: true,
  pickupPerShipment: true,
  // zgodnie z domyślnym `przewoznikOdbioru` (ALLEGRO = Allegro One): przycisk tylko przy pasku kuriera Allegro
  pickupCarriers: ['ALLEGRO'],
  // tworzenie przesyłek 120/min wg manifestu Allegro w Open Integration Platform (ae43d1e, `rate_limits.per_action`);
  // dokumentacja Allegro podaje tylko limit 9000/min na Client ID, więc konto bierze ułamek jak `allegro.v1` (300/min)
  rateLimit: { ...ALLEGRO_WYSYLAM_MANIFEST.rateLimit, requestsPerMinute: 300, perCapability: { 'shipment.create': { requestsPerMinute: 120 } } },
  shipmentMaxCreateMs: NAJDLUZSZE_UTWORZENIE_MS,
  config: [
    ...ALLEGRO_WYSYLAM_MANIFEST.config,
    { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'wyłącznik nadawania (z reguły przewoźnika): tak = Kompletor tworzy i anuluje przesyłki Wysyłam z Allegro' },
    {
      key: 'formatEtykiety',
      type: 'string',
      required: false,
      description: 'format etykiety ustalany przy tworzeniu przesyłki: PDF (domyślnie) albo ZPL (drukarka termiczna)',
      options: [
        { value: 'PDF', label: 'PDF' },
        { value: 'ZPL', label: 'ZPL' },
      ],
    },
    {
      key: 'zamawianieKuriera',
      type: 'boolean',
      required: false,
      description:
        'Zamawianie kuriera z Kompletora: tak = przycisk „Zamów kuriera” przy pasku Allegro w kolejce pakowania zamawia w Allegro odbiór paczek Wysyłam z Allegro przez kuriera; firma ze stałymi odbiorami zostawia wyłączone',
    },
    {
      key: 'przewoznikOdbioru',
      type: 'string',
      required: false,
      pattern: /^[A-Z0-9_]{2,40}$/,
      description: 'Przewoźnik Allegro, po którego paczki zamawiasz kuriera (identyfikator przewoźnika w Allegro; puste = ALLEGRO, czyli Allegro One Kurier). Paczki innych przewoźników w Allegro (np. InPost, DPD) zostają poza zamówieniem; automaty Allegro One Box jadą z kurierem Allegro One',
    },
    { key: 'nadawca', type: 'string', required: false, description: 'JSON z danymi nadawcy firmy (adres odbioru paczek; wstawia host przy zamawianiu kuriera)' },
  ],
  readOnly: false,
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const codes = (r: AllegroWriteResult) => {
  const c = kodyBledowAllegro(r.body)
  return c.length ? ` (${c.join(', ')})` : ''
}

/** commandId próby `n` utworzenia przesyłki pod referencją hosta (UUID). */
export const commandIdUtworzenia = (reference: string, n: number) => deriveReference([reference, 'allegro-przesylka', n])
export const commandIdAnulowania = (reference: string) => deriveReference([reference, 'allegro-anulowanie'])
/** commandId próby `n` zamówienia odbioru przez kuriera pod referencją zlecenia hosta (UUID). */
export const commandIdOdbioru = (reference: string, n: number) => deriveReference([reference, 'allegro-odbior', n])

export const ODBIOR_WYLACZONY = 'Zamawianie kuriera Wysyłam z Allegro z Kompletora jest wyłączone (nadawanie albo „Zamawianie kuriera z Kompletora” w ustawieniach Wysyłam z Allegro)'
/** Allegro przyjmuje najwyżej 100 przesyłek w pytaniu o terminy odbioru (`PickupProposalsRequestDto.shipmentIds`). */
export const ODBIOR_MAX_PRZESYLEK = 100
/** Prób (commandId) zamówienia odbioru na referencję zlecenia; po nich decyduje człowiek (panel Allegro albo „drugi”). */
export const MAX_PROB_ODBIORU = 10
/** [NIEPEWNE] identyfikator przewoźnika Allegro One w polu `carrier` przesyłki (przykład ze specyfikacji: ALLEGRO). */
export const PRZEWOZNIK_ODBIORU_DOMYSLNY = 'ALLEGRO'
/**
 * Limit czasu na odczyt przewoźnika przesyłek przed zamówieniem (zanim cokolwiek zostanie wysłane): po nim odmowa
 * „spróbuj za chwilę”, bo wiersz zlecenia u hosta czeka w stanie „w toku” najwyżej kilka minut.
 */
export const ODCZYT_PRZESYLEK_MS = 45_000

/** Numery przesyłek w kształcie UUID, bez powtórek (bez rozróżniania wielkości liter), w pisowni z bazy. */
const unikalnePrzesylki = (przesylki: readonly string[]): string[] => {
  const m = new Map<string, string>()
  for (const id of przesylki) if (typeof id === 'string' && UUID_RE.test(id) && !m.has(id.toLowerCase())) m.set(id.toLowerCase(), id)
  return [...m.values()]
}

type KomendaOdbioru = { status: 'BRAK' } | { status: 'W_TOKU' } | { status: 'OK'; pickupId: string | null; carrierPickupId: string | null } | { status: 'BLAD'; kody: string[] }

/**
 * Adres odbioru paczek (`AddressDto`: ulica, miasto, kod, kraj, e-mail i telefon z prefiksem wymagane, nazwa albo firma)
 * z danych nadawcy firmy (host: profil firmy z nadpisaniem nadawcy). Braki po nazwie pola, bez wartości.
 */
export function adresOdbioruAllegro(n: Record<string, unknown>): { adres: Record<string, string> } | { blad: string } {
  const t = (k: string) => (typeof n[k] === 'string' || typeof n[k] === 'number' ? String(n[k]).trim() : '')
  const kraj = (t('countryCode') || 'PL').toUpperCase()
  const telefon = t('phone') ? telefonZPrefiksem(t('phone'), { krajDomyslny: kraj }) : null
  const pola: [string, string, string][] = [
    ['company', t('name'), 'nazwa'],
    ['street', t('address'), 'ulica'],
    ['postalCode', t('postalCode'), 'kod pocztowy'],
    ['city', t('city'), 'miasto'],
    ['countryCode', /^[A-Z]{2}$/.test(kraj) ? kraj : '', 'kraj'],
    ['email', t('email'), 'e-mail'],
    ['phone', telefon ?? '', 'telefon z numerem kierunkowym'],
  ]
  const braki = pola.filter(([, v]) => !v).map(([, , nazwa]) => nazwa)
  if (braki.length) return { blad: braki.join(', ') }
  return { adres: Object.fromEntries(pola.map(([k, v]) => [k, v])) }
}

export type TerminOdbioru = { date: string; minTime?: string; maxTime?: string }
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/
const GODZ_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const minuty = (g: string) => Number(g.slice(0, 2)) * 60 + Number(g.slice(3, 5))
const godzina = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const opisTerminu = (t: TerminOdbioru) => (t.minTime && t.maxTime ? `${t.date} ${t.minTime}–${t.maxTime}` : t.date)
const kluczTerminu = (t: TerminOdbioru) => `${t.date}|${t.minTime ?? ''}|${t.maxTime ?? ''}`

/**
 * Terminy odbioru wspólne dla przesyłek z odpowiedzi `pickup-proposals`. Specyfikacja podaje tablicę obiektów
 * `{proposals: [{shipmentId, pickupTimes: [{date, minTime, maxTime}]}], address}`; odczyt przyjmuje też sam obiekt
 * zamiast tablicy. Przesyłki bez żadnego terminu nie zawężają wyniku (np. Allegro nie zna ich terminów); terminy
 * z nieczytelną datą pomijane, z nieczytelnymi godzinami = sama data. Wynik posortowany po dacie i godzinie.
 */
export function wspolneTerminyOdbioru(odpowiedz: unknown, ids: readonly string[]): TerminOdbioru[] {
  const terminy = new Map<string, TerminOdbioru[]>(ids.map((id) => [id, []]))
  const elementy = Array.isArray(odpowiedz) ? odpowiedz : odpowiedz && typeof odpowiedz === 'object' ? [odpowiedz] : []
  for (const el of elementy) {
    const propozycje = obj(el)['proposals']
    for (const pr of Array.isArray(propozycje) ? propozycje : []) {
      const id = str(obj(pr)['shipmentId'])
      const lista = id ? (terminy.get(id) ?? terminy.get(id.toLowerCase())) : undefined
      if (!lista) continue
      const czasy = obj(pr)['pickupTimes']
      for (const raw of Array.isArray(czasy) ? czasy : []) {
        const d = str(obj(raw)['date'])
        const a = str(obj(raw)['minTime'])?.slice(0, 5) ?? null
        const b = str(obj(raw)['maxTime'])?.slice(0, 5) ?? null
        if (!d || !DATA_RE.test(d.slice(0, 10))) continue
        const t = a && b && GODZ_RE.test(a) && GODZ_RE.test(b) && minuty(a) < minuty(b) ? { date: d.slice(0, 10), minTime: a, maxTime: b } : { date: d.slice(0, 10) }
        if (!lista.some((x) => kluczTerminu(x) === kluczTerminu(t))) lista.push(t)
      }
    }
  }
  const zTerminami = [...terminy.values()].filter((t) => t.length)
  if (!zTerminami.length) return []
  const [pierwsze, ...reszta] = zTerminami
  return pierwsze!.filter((t) => reszta.every((r) => r.some((x) => kluczTerminu(x) === kluczTerminu(t)))).sort((x, y) => kluczTerminu(x).localeCompare(kluczTerminu(y)))
}

/**
 * Termin do komendy odbioru. Termin Allegro tego dnia, który pokrywa się z oknem (największa część wspólna), zastępuje
 * godziny z okna (`zAllegro`); bez takiego terminu idą dzień i godziny z okna, a rozstrzyga odpowiedź Allegro na samo
 * zamówienie (lista bywa niepełna albo niedostępna). `podpowiedz` = najbliższe terminy Allegro do komunikatu odmowy.
 */
export function terminOdbioru(wspolne: readonly TerminOdbioru[], data: string, odMin: number, doMin: number): { termin: TerminOdbioru; zAllegro: boolean; podpowiedz: string | null } {
  const zOkna: TerminOdbioru = { date: data, minTime: godzina(odMin), maxTime: godzina(doMin) }
  const czesc = (t: TerminOdbioru) => (t.minTime && t.maxTime ? Math.max(0, Math.min(doMin, minuty(t.maxTime)) - Math.max(odMin, minuty(t.minTime))) : 0)
  const tegoDnia = wspolne.filter((t) => t.date === data && t.minTime && t.maxTime)
  const najlepszy = tegoDnia.reduce<TerminOdbioru | null>((a, b) => (!a || czesc(b) > czesc(a) ? b : a), null)
  const podpowiedz = wspolne.length ? wspolne.filter((t) => t.date >= data).slice(0, 4).map(opisTerminu).join(', ') || null : null
  if (najlepszy && czesc(najlepszy) > 0) return { termin: najlepszy, zAllegro: true, podpowiedz }
  return { termin: zOkna, zAllegro: false, podpowiedz }
}

/** Dni z przedziałami do okna „Zamów kuriera” (przesunięcie od dziś); terminy bez godzin i sprzed dziś pominięte. */
export function dniZTerminow(wspolne: readonly TerminOdbioru[], dzis: string): { dzienOd: number; przedzialy: { odMin: number; doMin: number }[] }[] {
  const dni = new Map<number, { odMin: number; doMin: number }[]>()
  const d0 = Date.parse(`${dzis}T12:00:00Z`)
  for (const t of wspolne) {
    if (!t.minTime || !t.maxTime) continue
    const off = Math.round((Date.parse(`${t.date}T12:00:00Z`) - d0) / 86_400_000)
    if (!Number.isFinite(off) || off < 0 || off > 30) continue
    const l = dni.get(off) ?? []
    l.push({ odMin: minuty(t.minTime), doMin: minuty(t.maxTime) })
    dni.set(off, l)
  }
  return [...dni.entries()].sort((a, b) => a[0] - b[0]).map(([dzienOd, przedzialy]) => ({ dzienOd, przedzialy }))
}

/** Kod Allegro: przesyłki z jednej komendy odbioru wymagają osobnych odbiorów (bez opisu w specyfikacji i poradniku). */
export const KOD_OSOBNE_ODBIORY = 'REQUIRES_SEPARATE_PICKUPS'
/** Nagłówek składu zamówienia w komunikacie odmowy (`skladOdbioru`). */
export const SKLAD = 'Skład dla administratora:'
const KLUCZ_CZESCI_RE = /^[A-Za-z0-9_]{1,40}$/

/**
 * Podział przesyłek na odbiory. Specyfikacja nie opisuje, kiedy Allegro wymaga osobnych odbiorów, więc podział idzie po
 * dwóch sygnałach z Allegro, w tej kolejności:
 *   1. przewoźnicy biorący udział w transporcie przesyłki (`ShipmentDto.transport`, zapasowo
 *      `packages[].transportingInfo[].carrierId`): odbiór w Allegro ma jednego przewoźnika odbierającego
 *      (`PickupDto.pickupCarrier`), więc różny skład przewoźników = osobne odbiory;
 *   2. tylko dla przesyłek bez danych o transporcie (`x`): elementy odpowiedzi `pickup-proposals` (tablica
 *      `{proposals, address}`); dwa elementy z takimi przesyłkami = osobne odbiory (token `pN`: numer elementu po
 *      najmniejszym numerze przesyłki, więc ta sama lista daje ten sam podział).
 * Elementy propozycji nie dzielą przesyłek o znanym transporcie: pierwsze żywe zamówienie dostało trzy
 * elementy dla trzech przesyłek tego samego przewoźnika, a przewoźnik zwrócił na trzy komendy ten sam numer zlecenia,
 * czyli jeden podjazd. Nic drobniej (np. po metodzie dostawy): zbyt drobny podział to więcej zamówionych odbiorów,
 * a odbiór może kosztować i nie ma go jak anulować przez API; za gruby kończy się odmową Allegro, która niczego nie
 * zamawia. `klucz` = przewoźnicy (`x` = nieznani) i token elementu; grupy po kluczu, przesyłki w kolejności wejścia.
 * `poElementach` (podział awaryjny po odmowie REQUIRES_SEPARATE_PICKUPS grupy jednego przewoźnika): elementy propozycji
 * dzielą wszystkie przesyłki, także o znanym transporcie (zachowanie).
 */
export function grupujPrzesylkiOdbioru(przesylki: readonly { id: string; transport: string | null }[], propozycje: unknown, o: { poElementach?: boolean } = {}): { klucz: string; przesylki: string[] }[] {
  const elementy = Array.isArray(propozycje) ? propozycje : propozycje && typeof propozycje === 'object' ? [propozycje] : []
  const dzielone = (x: { transport: string | null }) => o.poElementach === true || x.transport === null
  const nasze = new Set(przesylki.filter(dzielone).map((x) => x.id.toLowerCase()))
  const element = new Map<string, number>()
  elementy.forEach((el, i) => {
    const pr = obj(el)['proposals']
    for (const x of Array.isArray(pr) ? pr : []) {
      const id = str(obj(x)['shipmentId'])?.toLowerCase()
      if (id && nasze.has(id) && !element.has(id)) element.set(id, i)
    }
  })
  const uzyte = [...new Set(element.values())]
  const token = new Map<number, string>()
  if (uzyte.length > 1) {
    const najmniejszy = (i: number) => [...element.entries()].filter(([, e]) => e === i).map(([id]) => id).sort()[0] ?? ''
    uzyte.sort((a, b) => najmniejszy(a).localeCompare(najmniejszy(b))).forEach((i, n) => token.set(i, `p${n + 1}`))
  }
  const grupy = new Map<string, string[]>()
  for (const x of przesylki) {
    const e = element.get(x.id.toLowerCase())
    const t = dzielone(x) && uzyte.length > 1 ? (e === undefined ? 'p0' : token.get(e)!) : ''
    const klucz = [x.transport ?? 'x', t].filter(Boolean).join('.')
    grupy.set(klucz, [...(grupy.get(klucz) ?? []), x.id])
  }
  return [...grupy.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([klucz, ids]) => ({ klucz, przesylki: ids }))
}

const ZNACZNIK_RE = /^[A-Za-z0-9_+]{1,80}$/
const POWODY_PRZEWOZNIKA = ['anulowana', 'bez przewoźnika', 'nieznany (Allegro nie zna przesyłki)']
const liczebnik = (n: number, [jeden, kilka, wiele]: [string, string, string]) =>
  n === 1 ? jeden : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? kilka : wiele
const zliczenia = (m: ReadonlyMap<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k}×${n}`).join(', ')

/**
 * Skład zamówienia odbioru do komunikatu odmowy (specyfikacja nie mówi, po czym Allegro dzieli odbiory, więc odmowa
 * ma pokazać, co Allegro zwróciło): liczba elementów odpowiedzi `pickup-proposals` z liczbą przesyłek i przesyłek
 * z terminami w każdym, przewoźnicy transportu (`ShipmentDto.transport` / `transportingInfo`) i przewoźnik przesyłek,
 * z licznikami. Same identyfikatory usług i liczby: bez numerów przesyłek, adresów i danych osób; znacznik spoza
 * wzorca identyfikatora = „inny”. `stanPropozycji` = kod HTTP odpowiedzi o terminy, null = brak odpowiedzi.
 */
export function skladOdbioru(o: { propozycje: unknown; stanPropozycji: number | null; transport: ReadonlyMap<string, string | null>; przewoznik: string; przesylek: number; inni: ReadonlyMap<string, number> }): string {
  let prop: string
  if (o.stanPropozycji === null) prop = 'propozycje: brak odpowiedzi'
  else if (o.stanPropozycji < 200 || o.stanPropozycji >= 300) prop = `propozycje: HTTP ${o.stanPropozycji}`
  else {
    const el = Array.isArray(o.propozycje) ? o.propozycje : o.propozycje && typeof o.propozycje === 'object' ? [o.propozycje] : []
    const wpisy = el.map((e) => {
      const pr = obj(e)['proposals']
      return Array.isArray(pr) ? pr : []
    })
    const zTerminami = wpisy.map((w) => w.filter((x) => {
      const t = obj(x)['pickupTimes']
      return Array.isArray(t) && t.length > 0
    }).length)
    prop = `propozycje: ${el.length} ${liczebnik(el.length, ['grupa', 'grupy', 'grup'])}${el.length ? ` (przesyłek ${wpisy.map((w) => w.length).join(', ')}; z terminami ${zTerminami.join(', ')})` : ''}`
  }
  const tr = new Map<string, number>()
  for (const t of o.transport.values()) {
    const k = t === null ? 'brak' : ZNACZNIK_RE.test(t) ? t : 'inny'
    tr.set(k, (tr.get(k) ?? 0) + 1)
  }
  const przew = new Map<string, number>()
  if (o.przesylek) przew.set(ZNACZNIK_RE.test(o.przewoznik) ? o.przewoznik : 'inny', o.przesylek)
  for (const [c, n] of o.inni) {
    const k = ZNACZNIK_RE.test(c) || POWODY_PRZEWOZNIKA.includes(c) ? c : 'inny'
    przew.set(k, (przew.get(k) ?? 0) + n)
  }
  return [prop, tr.size ? `transport: ${zliczenia(tr)}` : null, przew.size ? `przewoźnik: ${zliczenia(przew)}` : null].filter(Boolean).join('; ')
}

/** Przewoźnicy transportu przesyłki z `ShipmentDto` (posortowani, `+`); null = Allegro ich nie podało. */
export function przewoznicyTransportu(body: Record<string, unknown>): string | null {
  const ids = new Set<string>()
  const t = body['transport']
  for (const x of Array.isArray(t) ? t : []) if (typeof x === 'string' && KLUCZ_CZESCI_RE.test(x.trim())) ids.add(x.trim().toUpperCase())
  if (!ids.size) {
    const pk = body['packages']
    for (const p of Array.isArray(pk) ? pk : []) {
      const ti = obj(p)['transportingInfo']
      for (const x of Array.isArray(ti) ? ti : []) {
        const c = str(obj(x)['carrierId'])?.trim()
        if (c && KLUCZ_CZESCI_RE.test(c)) ids.add(c.toUpperCase())
      }
    }
  }
  return ids.size ? [...ids].sort().join('+') : null
}

type Komenda = { status: 'BRAK' } | { status: 'W_TOKU' } | { status: 'OK'; shipmentId: string | null } | { status: 'BLAD'; kody: string[] }

/** Odbiorca z karty zamówienia nadpisuje pola propozycji Allegro (punkt odbioru zostaje z propozycji). */
export function odbiorcaAllegro(proposed: Record<string, unknown>, r: Readonly<RecipientAddress>): Record<string, unknown> {
  const ulica = [r.ulica, r.numerDomu ? `${r.numerDomu}${r.numerLokalu ? `/${r.numerLokalu}` : ''}` : null].filter(Boolean).join(' ')
  const pola: Record<string, string | null> = {
    name: r.imieNazwisko,
    company: r.firma,
    street: ulica || null,
    postalCode: r.kodPocztowy,
    city: r.miasto,
    countryCode: r.kraj,
    phone: r.telefon,
    email: r.email,
  }
  const out = { ...proposed }
  for (const [k, v] of Object.entries(pola)) if (v) out[k] = v
  return out
}

/**
 * Allegro od 01.10.2026 odrzuca komendę bez prefiksu kraju w `sender.phone` i `receiver.phone`. Telefon
 * nadawcy (z propozycji Allegro albo profilu) i odbiorcy (z karty zamówienia albo propozycji) przechodzi przez wspólny
 * odczyt (lib/wysylka/telefon.ts) do postaci „+48600100200”; +48 dopisujemy tylko osobie z `countryCode` PL albo bez kraju. Brak telefonu zostaje bez zmian (rozstrzyga Allegro);
 * nieczytelny albo bez prefiksu = błąd z polem do poprawy, bez wysyłki komendy i bez wartości numeru w komunikacie.
 */
export function telefonyAllegro(input: Record<string, unknown>): { input: Record<string, unknown> } | { blad: string } {
  const out = { ...input }
  for (const [pole, kto] of [['sender', 'nadawcy'], ['receiver', 'odbiorcy']] as const) {
    const osoba = input[pole]
    if (!osoba || typeof osoba !== 'object' || Array.isArray(osoba)) continue
    const tel = (osoba as Record<string, unknown>)['phone']
    if (tel === undefined || tel === null || (typeof tel === 'string' && !tel.trim())) continue
    const kraj = (osoba as Record<string, unknown>)['countryCode']
    const z = typeof tel === 'string' || typeof tel === 'number' ? telefonZPrefiksem(String(tel), { krajDomyslny: typeof kraj === 'string' ? kraj : null }) : null
    if (!z) return { blad: telefonBezPrefiksu(kto) }
    out[pole] = { ...(osoba as Record<string, unknown>), phone: z }
  }
  return { input: out }
}

/**
 * kody historii statusów Allegro (`ParcelTrackingStatus.code` w specyfikacji REST API, swagger 22.11.2026):
 * PENDING = przesyłka przygotowana, czeka na nadanie; IN_TRANSIT = w drodze, w tym przyjęcie przez przewoźnika;
 * RELEASED_FOR_DELIVERY = wydana do doręczenia; AVAILABLE_FOR_PICKUP = czeka w punkcie; NOTICE_LEFT = awizo po nieudanym
 * doręczeniu; DELIVERED = doręczona albo odebrana. Każdy z tych pięciu (poza PENDING) znaczy, że przewoźnik fizycznie
 * miał paczkę. ISSUE (problem, np. odmowa przyjęcia, zagubienie) i RETURNED (zwrot) bez wcześniejszego „u przewoźnika”
 * oraz kody spoza listy = NIEZNANY: host nic wtedy nie zmienia.
 */
const ALLEGRO_PRZEKAZANA = new Set(['IN_TRANSIT', 'RELEASED_FOR_DELIVERY', 'AVAILABLE_FOR_PICKUP', 'NOTICE_LEFT'])
/** Opisy kodów po polsku do historii zamówienia. Opisu z Allegro (`description`, wolny tekst) nie bierzemy: bywa o odbiorcy. */
export const OPIS_KODU_ALLEGRO: Readonly<Record<string, string>> = {
  PENDING: 'Przygotowana, czeka na nadanie',
  IN_TRANSIT: 'W drodze',
  RELEASED_FOR_DELIVERY: 'Wydana do doręczenia',
  AVAILABLE_FOR_PICKUP: 'Czeka w punkcie odbioru',
  NOTICE_LEFT: 'Awizo',
  ISSUE: 'Problem z przesyłką',
  DELIVERED: 'Doręczona',
  RETURNED: 'Zwrot do nadawcy',
}
/** Surowy kod do historii: tylko identyfikator wielkimi literami (nic, co mogłoby nieść dane osoby). */
const KOD_RE = /^[A-Z][A-Z0-9_]{0,39}$/

/**
 * Stan przesyłki z historii statusów jednego numeru (`trackingDetails.statuses`). Kolejność w tablicy nie jest obiecana,
 * więc najnowszy wpis wg `occurredAt` (przy remisie późniejszy w tablicy). Pusta historia albo same PENDING =
 * PRZED_NADANIEM; doręczenie gdziekolwiek w historii = DORECZONA (jak Base Courier).
 */
export function stanAllegro(statuses: unknown): { stan: StanPrzesylki; status: string | null; opis: string | null } {
  const lista: { kod: string | null; t: number; i: number }[] = []
  ;(Array.isArray(statuses) ? statuses : []).forEach((s, i) => {
    const kod = str(obj(s)['code'])
    const t = Date.parse(String(obj(s)['occurredAt'] ?? ''))
    lista.push({ kod: kod && KOD_RE.test(kod) ? kod : null, t: Number.isNaN(t) ? -Infinity : t, i })
  })
  const ost = lista.reduce<(typeof lista)[number] | null>((a, b) => (!a || b.t > a.t || (b.t === a.t && b.i > a.i) ? b : a), null)
  const status = ost?.kod ?? null
  const wynik = (stan: StanPrzesylki) => ({ stan, status, opis: status ? (OPIS_KODU_ALLEGRO[status] ?? null) : null })
  if (lista.some((x) => x.kod === 'DELIVERED')) return wynik('DORECZONA')
  if (lista.some((x) => x.kod !== null && ALLEGRO_PRZEKAZANA.has(x.kod))) return wynik('PRZEKAZANA')
  if (lista.every((x) => x.kod === 'PENDING')) return wynik('PRZED_NADANIEM')
  return wynik('NIEZNANY')
}

/**
 * Kody Allegro na osi statusów (OpenAPI Allegro, `ParcelTrackingStatus`). IN_TRANSIT obejmuje i odbiór przez kuriera,
 * i sortownie: pierwsze IN_TRANSIT = przekazana, kolejne = w drodze. ISSUE (odmowa albo zaginięcie) = problem.
 */
const ALLEGRO_OS: Readonly<Record<string, StanDrogi>> = {
  PENDING: 'UTWORZONA',
  IN_TRANSIT: 'W_DRODZE',
  RELEASED_FOR_DELIVERY: 'W_DORECZENIU',
  AVAILABLE_FOR_PICKUP: 'W_PUNKCIE',
  NOTICE_LEFT: 'NIEUDANE_DORECZENIE',
  DELIVERED: 'DORECZONA',
  RETURNED: 'ZWROT',
  ISSUE: 'PROBLEM',
}

const osAllegro = (kod: string): StanDrogi | undefined => (Object.hasOwn(ALLEGRO_OS, kod) ? ALLEGRO_OS[kod] : undefined)

/**
 * Stan na osi z historii: ostatni (wg czasu) znany kod, jego czas i kod; pusta historia = utworzona, same nieznane =
 * nieznany. Zwrot „przykleja się”: po pierwszym RETURNED stan to ZWROT (czas i kod tego zdarzenia), także gdy
 * później jest DELIVERED (doręczenie do nadawcy). `przekazanaO` = pierwszy znany kod inny niż PENDING.
 */
export function stanDrogiAllegro(statusy: readonly { kod: string; czas: string | null }[]): { stanDrogi: StanDrogi; czas: string | null; kod: string | null; przekazanaO: string | null } {
  const wg = [...statusy].sort((a, b) => (a.czas ?? '').localeCompare(b.czas ?? ''))
  if (!wg.length) return { stanDrogi: 'UTWORZONA', czas: null, kod: null, przekazanaO: null }
  const przekazanaO = wg.find((s) => s.kod !== 'PENDING' && osAllegro(s.kod) !== undefined)?.czas ?? null
  const zwrot = wg.find((s) => osAllegro(s.kod) === 'ZWROT')
  if (zwrot) return { stanDrogi: 'ZWROT', czas: zwrot.czas, kod: zwrot.kod, przekazanaO }
  for (let i = wg.length - 1; i >= 0; i--) {
    const kod = wg[i]!.kod
    const os = osAllegro(kod)
    if (!os) continue
    const pierwszeWDrodze = kod === 'IN_TRANSIT' && !wg.slice(0, i).some((s) => s.kod === 'IN_TRANSIT')
    return { stanDrogi: pierwszeWDrodze ? 'PRZEKAZANA' : os, czas: wg[i]!.czas, kod, przekazanaO }
  }
  return { stanDrogi: 'NIEZNANY', czas: wg.at(-1)!.czas, kod: wg.at(-1)!.kod, przekazanaO }
}

export class AllegroWysylamZapisAdapter extends AllegroWysylamAdapter implements ShipmentCreator, ReferenceFinder, ShipmentTracker, PickupOrderer, PickupAvailability, PickupGrouping {
  private writerInstance: AllegroWriter | null = null

  constructor(ctx: AdapterContext) {
    super(ctx, ALLEGRO_WYSYLAM_ZAPIS_MANIFEST)
  }

  private get enabled(): boolean {
    return this.ctx.config['zapisWlaczony'] === true
  }

  private get pollDelayMs(): number {
    return this.ctx.http?.pollDelayMs ?? 2_000
  }

  private get writer(): AllegroWriter {
    this.writerInstance ??= new AllegroWriter(String(this.ctx.config['apiUrl'] ?? ALLEGRO_API_URL), String(this.ctx.config['userAgent']), this.ctx.fetch as FetchLike, new Throttle(this.ctx.http?.minIntervalMs ?? 100))
    return this.writerInstance
  }

  private write(method: 'GET' | 'POST', path: string, body: unknown, o: { binary?: boolean; timeoutMs?: number } = {}): Promise<AllegroWriteResult> {
    return writeWithToken(this.writer, this.tokens, method, path, body, o)
  }

  /** Stan komendy (utworzenia albo anulowania). Błąd odczytu = AdapterError. */
  private async komenda(rodzaj: 'create' | 'cancel', commandId: string): Promise<Komenda> {
    const r = await this.write('GET', `/shipment-management/shipments/${rodzaj}-commands/${commandId}`, undefined, { timeoutMs: KOMENDA_TIMEOUT_MS })
    if (r.status === 404) return { status: 'BRAK' }
    if (r.status === 403) throw new AdapterError(`Allegro: HTTP 403 przy odczycie komendy przesyłki — ${ZAKRES}`, 'TRWALY')
    if (r.status < 200 || r.status >= 300 || !r.body) throw new AdapterError(`Allegro: wynik komendy przesyłki HTTP ${r.status}`, r.status === 429 || r.status >= 500 ? 'PRZEJSCIOWY' : 'TRWALY', r.retryAfterMs ?? undefined)
    const status = str(r.body['status'])
    if (status === 'SUCCESS') return { status: 'OK', shipmentId: str(r.body['shipmentId']) }
    if (status === 'ERROR') return { status: 'BLAD', kody: kodyBledowAllegro(r.body) }
    return { status: 'W_TOKU' }
  }

  /**
   * Odpytywanie komendy po wysłaniu; `W_TOKU` po limicie odpytań albo po deadline ściennym `CZEKAJ_MS` (przegląd
   * wolne Allegro nie trzyma akcji serwera) = nadal nie wiadomo.
   */
  private async czekaj(rodzaj: 'create' | 'cancel', commandId: string): Promise<Komenda> {
    let k: Komenda = { status: 'W_TOKU' }
    const koniec = Date.now() + CZEKAJ_MS
    for (let i = 0; i < SHIPMENT_POLLS && Date.now() < koniec; i++) {
      await sleep(this.pollDelayMs)
      try {
        k = await this.komenda(rodzaj, commandId)
      } catch {
        // po wysłaniu komendy żaden błąd odczytu wyniku nie znaczy „nie powstała”: próbujemy dalej, a po limicie W_TOKU
        // (= NIEJEDNOZNACZNY i odszukanie), nigdy PRZEJSCIOWY ani TRWALY
        continue
      }
      if (k.status !== 'W_TOKU' && k.status !== 'BRAK') return k
    }
    return k
  }

  /** Stan wszystkich prób 1…5 referencji (bez przerwy na pierwszym 404: Allegro mogło zapomnieć starą komendę). */
  private async proby(reference: string): Promise<{ n: number; k: Komenda }[]> {
    const out: { n: number; k: Komenda }[] = []
    for (let n = 1; n <= MAX_PROB_KOMENDY; n++) out.push({ n, k: await this.komenda('create', commandIdUtworzenia(reference, n)) })
    return out
  }

  /**
   * Próba do użycia: udana (przesyłka jest) przed będącą w toku, ta przed pierwszą wolną (404).
   * Wszystkie pięć z błędem = null. Przegląd całej piątki: gdy Allegro przestało znać komendę `n=1` (stary ERROR),
   * a przesyłka istnieje pod `n=2`, zatrzymanie na pierwszym 404 wysłałoby drugą, płatną przesyłkę.
   */
  private async proba(reference: string): Promise<{ n: number; k: Komenda } | null> {
    const p = await this.proby(reference)
    return p.find((x) => x.k.status === 'OK') ?? p.find((x) => x.k.status === 'W_TOKU') ?? p.find((x) => x.k.status === 'BRAK') ?? null
  }

  private static wynik(k: Komenda, reference: string, what: string): WriteOutcome {
    if (k.status === 'OK') return k.shipmentId ? { kind: 'OK', reference, externalRef: k.shipmentId } : { kind: 'NIEJEDNOZNACZNY', reference, message: `${what}: Allegro potwierdziło przesyłkę bez jej numeru` }
    if (k.status === 'BLAD') return { kind: 'TRWALY', reference, message: `${what}: Allegro odrzuciło przesyłkę${k.kody.length ? ` (${k.kody.join(', ')})` : ''}` }
    return { kind: 'NIEJEDNOZNACZNY', reference, message: `${what}: Allegro jeszcze tworzy przesyłkę — „Sprawdź u przewoźnika” za chwilę` }
  }

  async createShipment(req: ShipmentCreateRequest, reference: string): Promise<WriteOutcome> {
    if (!this.enabled) return { kind: 'TRWALY', reference, message: NADAWANIE_WYLACZONE }
    const what = 'Wysyłam z Allegro'
    const order = req.orderExternalId ?? ''
    if (!UUID_RE.test(order)) return { kind: 'TRWALY', reference, message: `${what}: brak numeru formularza Allegro zamówienia (przesyłkę Wysyłam z Allegro tworzy się tylko dla zamówień z Allegro)` }
    try {
      const p = await this.proba(reference)
      if (!p) return { kind: 'TRWALY', reference, message: `${what}: ${MAX_PROB_KOMENDY} prób odrzuconych przez Allegro — sprawdź przesyłkę w Allegro i popraw dane` }
      if (p.k.status === 'OK') return AllegroWysylamZapisAdapter.wynik(p.k, reference, what)
      const commandId = commandIdUtworzenia(reference, p.n)
      if (p.k.status === 'W_TOKU') return AllegroWysylamZapisAdapter.wynik(await this.czekaj('create', commandId), reference, what)

      // propozycja dostawy z Allegro (metoda, punkt, nadawca): tylko w pamięci tego wywołania
      const pr = await this.call<unknown>(`/shipment-management/delivery-proposals/${order}`, ZAKRES)
      if (pr.status === 404) return { kind: 'TRWALY', reference, message: `${what}: Allegro nie ma propozycji dostawy dla tego zamówienia (inna metoda dostawy niż Wysyłam z Allegro?)` }
      if (pr.status < 200 || pr.status >= 300) return { kind: 'TRWALY', reference, message: `${what}: propozycja dostawy HTTP ${pr.status}` }
      const suggested = obj(obj(pr.body)['suggestedInput'])
      const tel = telefonyAllegro({ ...suggested, receiver: odbiorcaAllegro(obj(suggested['receiver']), req.recipient) })
      if ('blad' in tel) return { kind: 'TRWALY', reference, message: `${what}: ${tel.blad}` }
      const input = tel.input
      // limit wymiarów metody dostawy z tej samej propozycji (metody zagraniczne mają mniejsze skrytki niż gabaryt
      // roboczy); nieczytelne limity nie blokują nadania: idą wymiary gabarytu, a odmowę Allegro pokaże komunikat.
      // Przycinane są tylko wymiary robocze gabarytu (ostrzeżenie `wymiary_domyslne`), nigdy wpisane przez człowieka.
      let dop: ReturnType<typeof dopasujWymiaryDoLimitu> | null = null
      let wyslane: { length: number; width: number; height: number } | null = null
      let limitNieczytelny = false
      const g = req.parcel
      if (g.sideXCm !== null && g.sideYCm !== null && g.sideZCm !== null) {
        let opcjeDostawy: AllegroDeliveryOption[] = []
        try {
          opcjeDostawy = parseDeliveryOptions(pr.body)
        } catch {
          opcjeDostawy = []
          limitNieczytelny = true
        }
        const gabaryt = { length: g.sideZCm, width: g.sideYCm, height: g.sideXCm }
        dop = dopasujWymiaryDoLimitu(gabaryt, opcjeDostawy)
        wyslane = g.problems.some((p) => p.kod === 'wymiary_domyslne') ? dop.wymiary : gabaryt
      }
      let payload: Record<string, unknown>
      try {
        payload = buildCreateCommandPayload(req.parcel, input, { commandId, labelFormat: this.ctx.config['formatEtykiety'] === 'ZPL' ? 'ZPL' : 'PDF', referenceNumber: reference.slice(0, 8), ...(wyslane ? { wymiary: wyslane } : {}) }, req.potwierdzoneOstrzezenia ?? [])
      } catch (e) {
        // komunikaty zlecenia mają tylko kody problemów, bez wartości pól
        return { kind: 'TRWALY', reference, message: `${what}: ${e instanceof Error ? e.message : String(e)}` }
      }
      let r: AllegroWriteResult | null = null
      try {
        r = await this.write('POST', '/shipment-management/shipments/create-commands', payload)
      } catch (e) {
        if (!(e instanceof SourceError)) throw e
        // brak odpowiedzi: wynik komendy rozstrzyga (ten sam commandId nie utworzy drugiej przesyłki)
      }
      if (r && !(r.status >= 200 && r.status < 300) && r.status !== 409) {
        if (r.status === 403) return { kind: 'TRWALY', reference, message: `${what}: HTTP 403 — ${ZAKRES}` }
        if (r.status === 429) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: HTTP 429 (limit zapytań)`, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) }
        if (r.status < 500) return { kind: 'TRWALY', reference, message: `${what}: Allegro odrzuciło komendę (HTTP ${r.status}${codes(r)})` }
        // 5xx: komenda mogła wejść — wynik komendy rozstrzyga niżej
      }
      const k = await this.czekaj('create', commandId)
      if (k.status === 'BRAK') {
        if (!r) return { kind: 'NIEJEDNOZNACZNY', reference, message: `${what}: brak odpowiedzi Allegro, a komenda przesyłki jeszcze nie jest widoczna` }
        // 2xx/409 bez widocznej komendy to opóźnienie Allegro, nie sprzeczność; ponowienie użyje tego samego commandId
        if (r.status < 500) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: Allegro przyjęło komendę, ale jeszcze jej nie pokazuje: kliknij ponownie za chwilę` }
        return { kind: 'PRZEJSCIOWY', reference, message: `${what}: Allegro odpowiedziało błędem (HTTP ${r.status}) i nie pokazuje komendy przesyłki: kliknij ponownie za chwilę` }
      }
      const wynik = AllegroWysylamZapisAdapter.wynik(k, reference, what)
      const liczba = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',')
      const cmTxt = (w: { length: number; width: number; height: number }) => `${liczba(w.length)}×${liczba(w.width)}×${liczba(w.height)}`
      // ślad dla obsługi: do Allegro poszły inne wymiary niż robocze z ostrzeżenia, które człowiek potwierdził
      if (wynik.kind === 'OK' && dop?.przyciete && wyslane === dop.wymiary && g.sideXCm !== null && g.sideYCm !== null && g.sideZCm !== null) {
        // potwierdzenie przed wysłaniem wymagałoby zmiany hosta (ostrzeżenia zbiera on przed wywołaniem adaptera, bez
        // propozycji Allegro); do tego czasu ślad po fakcie z limitem, żeby pakujący sprawdził karton przed nadaniem
        return { ...wynik, info: `Wymiary przycięte do limitu metody dostawy: ${cmTxt({ length: g.sideZCm, width: g.sideYCm, height: g.sideXCm })} → ${cmTxt(dop.wymiary)} cm. Paczka musi się zmieścić w ${cmTxt(dop.wymiary)} cm: sprawdź karton, zanim go nadasz.` }
      }
      // odmowa wymiarów: same liczby (wysłane i limit metody), żeby dało się ją rozstrzygnąć bez zgadywania
      if (wynik.kind === 'TRWALY' && k.status === 'BLAD' && k.kody.includes('DIMENSIONS_VALIDATION_ERROR') && dop && wyslane) {
        const limit = dop.limit ? `${cmTxt(dop.limit)} cm` : limitNieczytelny ? 'nieczytelny w propozycji Allegro' : dop.niejednoznaczny ? 'niejednoznaczny (kilka metod z różnymi limitami)' : 'Allegro nie podało'
        return { ...wynik, message: `${wynik.message}. Wysłane wymiary: ${cmTxt(wyslane)} cm; limit tej metody dostawy wg Allegro: ${limit}` }
      }
      return wynik
    } catch (e) {
      return asOutcome(e, reference, what)
    }
  }

  /**
   * Odszukanie po referencji: udana próba = przesyłka jest; próba w toku = nadal nie wiadomo (wyjątek); żadnej
   * zarejestrowanej albo same odrzucone = dowód, że przesyłki nie ma (Allegro zna każdą przyjętą komendę).
   */
  async findByReference(reference: string): Promise<ReferenceLookup> {
    // cała piątka; `found:false` tylko, gdy żadna próba nie jest udana ani w toku
    const p = await this.proby(reference)
    const ok = p.find((x) => x.k.status === 'OK')
    if (ok && ok.k.status === 'OK') {
      if (!ok.k.shipmentId) throw new AdapterError('Allegro potwierdziło przesyłkę bez jej numeru', 'NIEJEDNOZNACZNY')
      return { found: true, externalRef: ok.k.shipmentId }
    }
    if (p.some((x) => x.k.status === 'W_TOKU')) throw new AdapterError('Allegro jeszcze tworzy przesyłkę: sprawdź za chwilę', 'NIEJEDNOZNACZNY')
    return { found: false }
  }

  /**
   * „Rozstrzygnij ręcznie” z numerem przesyłki z panelu Allegro. Dowodem są komendy
   * utworzenia tej referencji (te same `commandIdUtworzenia`, tylko odczyt, zero nowych komend): udana komenda musi
   * wskazywać dokładnie wpisaną przesyłkę, inaczej odmowa (wklejone id z sąsiedniego wiersza panelu). Komenda w toku =
   * odmowa „spróbuj za chwilę”; żadnej udanej ani w toku = przesyłka Kompletora nie powstała w Allegro (Allegro zna
   * każdą przyjętą komendę, jak w `findByReference`). Przy zgodnym numerze numer nadania dociąga host (`getTrackingNumber`).
   */
  async confirmManual(identyfikator: string, reference: string): Promise<PotwierdzenieRecznego> {
    if (!this.enabled) return { odmowa: 'Nadawanie Wysyłam z Allegro jest wyłączone w ustawieniach przewoźnika: Kompletor nie może sprawdzić przesyłki w Allegro.' }
    const id = identyfikator.trim()
    if (!UUID_RE.test(id)) return { odmowa: 'Podaj numer przesyłki z panelu Allegro (identyfikator w postaci 8-4-4-4-12 znaków).' }
    const p = await this.proby(reference)
    const ok = p.find((x) => x.k.status === 'OK')
    if (ok && ok.k.status === 'OK') {
      if (!ok.k.shipmentId) return { odmowa: 'Allegro potwierdziło przesyłkę tej referencji bez jej numeru: spróbuj za kilka minut.' }
      if (ok.k.shipmentId.toLowerCase() !== id.toLowerCase())
        return { odmowa: `Pod referencją tej przesyłki Allegro ma inną przesyłkę (${ok.k.shipmentId}) niż wpisana: sprawdź numer w panelu Allegro. Nic nie zapisano.` }
      return { externalRef: ok.k.shipmentId, info: 'Sprawdzone w Allegro: to przesyłka utworzona przez Kompletor dla tej referencji.', referencjaSprawdzona: true }
    }
    if (p.some((x) => x.k.status === 'W_TOKU')) return { odmowa: 'Allegro jeszcze tworzy przesyłkę tej referencji: spróbuj za chwilę.' }
    return { odmowa: `Allegro nie ma przesyłki utworzonej przez Kompletor dla tej referencji: przesyłka ${id} nie pochodzi z tego zamówienia w Kompletorze. Sprawdź numer w panelu Allegro; jeśli przesyłki tego zamówienia tam nie ma, wybierz „Nie powstała”.` }
  }

  // ─── Zamówienie odbioru przez kuriera ─────────────────────────────────────

  private get odbiorWlaczony(): boolean {
    return this.enabled && this.ctx.config['zamawianieKuriera'] === true
  }

  private get przewoznikOdbioru(): string {
    const v = this.ctx.config['przewoznikOdbioru']
    return typeof v === 'string' && /^[A-Z0-9_]{2,40}$/.test(v.trim()) ? v.trim() : PRZEWOZNIK_ODBIORU_DOMYSLNY
  }

  /** Adres odbioru z danych nadawcy firmy (`config.nadawca`, wstawia host). */
  private adresOdbioru(): { adres: Record<string, string> } | { blad: string } {
    let nadawca: Record<string, unknown> = {}
    try {
      nadawca = obj(typeof this.ctx.config['nadawca'] === 'string' ? (JSON.parse(this.ctx.config['nadawca']) as unknown) : null)
    } catch {
      return { blad: 'nieczytelne dane nadawcy w konfiguracji' }
    }
    const a = adresOdbioruAllegro(nadawca)
    return 'blad' in a ? { blad: `brak danych adresu odbioru paczek (Ustawienia → Dokumenty i faktury → Dane firmy): ${a.blad}` } : a
  }

  /** Stan komendy zamówienia odbioru. Błąd odczytu = AdapterError. */
  private async komendaOdbioru(commandId: string): Promise<KomendaOdbioru> {
    const r = await this.write('GET', `/shipment-management/pickups/create-commands/${commandId}`, undefined, { timeoutMs: KOMENDA_TIMEOUT_MS })
    if (r.status === 404) return { status: 'BRAK' }
    if (r.status === 403) throw new AdapterError(`Allegro: HTTP 403 przy odczycie zamówienia odbioru — ${ZAKRES}`, 'TRWALY')
    if (r.status < 200 || r.status >= 300 || !r.body) throw new AdapterError(`Allegro: wynik zamówienia odbioru HTTP ${r.status}`, r.status === 429 || r.status >= 500 ? 'PRZEJSCIOWY' : 'TRWALY', r.retryAfterMs ?? undefined)
    const status = str(r.body['status'])
    if (status === 'SUCCESS') return { status: 'OK', pickupId: str(r.body['pickupId']), carrierPickupId: str(r.body['carrierPickupId']) }
    if (status === 'ERROR') return { status: 'BLAD', kody: kodyBledowAllegro(r.body) }
    return { status: 'W_TOKU' }
  }

  /** Odpytywanie komendy odbioru po wysłaniu (ODBIOR_POLLS, ODBIOR_CZEKAJ_MS); błąd odczytu = próbujemy dalej. */
  private async czekajOdbior(commandId: string): Promise<KomendaOdbioru> {
    let k: KomendaOdbioru = { status: 'W_TOKU' }
    const koniec = Date.now() + ODBIOR_CZEKAJ_MS
    for (let i = 0; i < ODBIOR_POLLS && Date.now() < koniec; i++) {
      await sleep(this.pollDelayMs)
      try {
        k = await this.komendaOdbioru(commandId)
      } catch {
        continue
      }
      if (k.status !== 'W_TOKU' && k.status !== 'BRAK') return k
    }
    return k
  }

  private static wynikOdbioru(k: KomendaOdbioru, reference: string, what: string, extra: { okno?: { odMin: number; doMin: number } | null; /** termin wysłany w komendzie (przy odmowie: zapis na ekranie) */ wyslane?: { odMin: number; doMin: number } | null; przesylek?: number | null; podpowiedz?: string | null; wyslana?: boolean; sklad?: string | null; skladOsobnych?: string | null }): WynikOdbioru {
    if (k.status === 'OK') {
      const numer = k.carrierPickupId ?? k.pickupId
      if (!numer) return { kind: 'NIEJEDNOZNACZNY', reference, message: `${what}: Allegro potwierdziło odbiór bez jego numeru; sprawdź odbiór w Allegro (Wysyłam z Allegro), nie zamawiaj drugi raz` }
      return { kind: 'OK', reference, externalRef: numer, sumaKontrolna: k.pickupId, ...(extra.okno ? { okno: extra.okno } : {}), ...(extra.przesylek ? { przesylek: extra.przesylek } : {}) }
    }
    if (k.status === 'BLAD' && k.kody.includes(KOD_OSOBNE_ODBIORY))
      return {
        kind: 'TRWALY',
        reference,
        message: `${what}: Allegro wymaga osobnych odbiorów dla części tych przesyłek (${KOD_OSOBNE_ODBIORY}), a Kompletor nie rozpoznał, jak je podzielić; nic nie zamówiono i nic nie będzie ponawiane. Zamów odbiór tych przesyłek w Allegro (Wysyłam z Allegro → Zamów kuriera) i zgłoś to administratorowi Kompletora${extra.skladOsobnych ? `. ${SKLAD} ${extra.skladOsobnych}` : ''}`,
      }
    if (k.status === 'BLAD')
      return { kind: 'TRWALY', reference, ...(extra.wyslane ? { okno: extra.wyslane } : {}), message: `${what}: Allegro odrzuciło zamówienie odbioru${k.kody.length ? ` (${k.kody.join(', ')})` : ''}${extra.podpowiedz ? `. Terminy odbioru proponowane przez Allegro: ${extra.podpowiedz}` : ''}${extra.sklad ? `. ${SKLAD} ${extra.sklad}` : ''}` }
    // komenda wysłana, a Allegro nie pokazało wyniku: nie wiadomo, czy kurier jest zamówiony (rozstrzyga człowiek;
    // ten sam commandId przy ponownym zamówieniu tej referencji odczyta wynik zamiast zamawiać drugi raz)
    if (extra.wyslana) return { kind: 'NIEJEDNOZNACZNY', reference, message: `${what}: Allegro jeszcze nie potwierdziło odbioru; sprawdź za kilka minut w Allegro (Wysyłam z Allegro), czy odbiór jest zamówiony, nie zamawiaj drugi raz w ciemno` }
    return { kind: 'NIEJEDNOZNACZNY', reference, message: `${what}: Allegro jeszcze przetwarza wcześniejsze zamówienie odbioru; sprawdź w Allegro (Wysyłam z Allegro) za kilka minut` }
  }

  /**
   * Przesyłki do zamówienia: UUID, bez powtórek, przewoźnik w Allegro = `przewoznikOdbioru`, nieanulowane. Odczyt
   * szczegółów przesyłki (`GET /shipment-management/shipments/{id}`, tylko `carrier` i anulowanie) z limitem czasu.
   * `inni` = przewoźnicy pominiętych przesyłek z liczbą (identyfikatory przewoźników, bez danych osób).
   */
  private async przesylkiPrzewoznika(przesylki: readonly string[]): Promise<{ ids: string[]; transport: Map<string, string | null>; inni: Map<string, number> } | { przekroczony: true }> {
    const wszystkie = unikalnePrzesylki(przesylki)
    const cel = this.przewoznikOdbioru
    const ids: string[] = []
    const transport = new Map<string, string | null>()
    const inni = new Map<string, number>()
    const koniec = Date.now() + ODCZYT_PRZESYLEK_MS
    for (let i = 0; i < wszystkie.length; i += ODCZYT_PRZESYLEK_NARAZ) {
      if (Date.now() > koniec) return { przekroczony: true }
      const czesc = wszystkie.slice(i, i + ODCZYT_PRZESYLEK_NARAZ)
      const odczyty = await Promise.all(czesc.map((id) => this.przesylka(id)))
      czesc.forEach((id, j) => {
        const p = odczyty[j]
        const c = !p ? 'nieznany (Allegro nie zna przesyłki)' : p.anulowana ? 'anulowana' : (p.carrier ?? 'bez przewoźnika')
        if (c === cel) {
          ids.push(id)
          transport.set(id, p?.transport ?? null)
        } else inni.set(c, (inni.get(c) ?? 0) + 1)
      })
    }
    return { ids, transport, inni }
  }

  /**
   * Zamówienie odbioru przez kuriera przesyłek Wysyłam z Allegro czekających na kuriera (`req.przesylki`). Dwa warunki
   * konta: nadawanie włączone i „Zamawianie kuriera z Kompletora” = tak; inaczej odmowa bez żądania. Najpierw próby
   * 1…MAX_PROB_ODBIORU komendy tej referencji (udana = odbiór już jest, w toku = czekamy), potem przewoźnik przesyłek,
   * terminy z Allegro (podpowiedź), komenda i odpytywanie. Brak odpowiedzi albo brak wyniku po wysłaniu komendy =
   * NIEJEDNOZNACZNY; odmowy przed wysłaniem = TRWALY albo PRZEJSCIOWY (nic nie zamówiono).
   */
  async zamowOdbior(req: PickupOrderRequest, reference: string): Promise<WynikOdbioru> {
    const what = 'zamówienie kuriera Wysyłam z Allegro'
    if (!this.odbiorWlaczony) return { kind: 'TRWALY', reference, message: ODBIOR_WYLACZONY }
    if (!(req.przesylki ?? []).some((id) => UUID_RE.test(id))) return { kind: 'TRWALY', reference, message: `${what}: brak przesyłek Wysyłam z Allegro czekających na kuriera (najpierw utwórz przesyłki)` }
    const a = this.adresOdbioru()
    if ('blad' in a) return { kind: 'TRWALY', reference, message: `${what}: ${a.blad}` }
    try {
      const proby: { n: number; k: KomendaOdbioru }[] = []
      for (let n = 1; n <= MAX_PROB_ODBIORU; n++) proby.push({ n, k: await this.komendaOdbioru(commandIdOdbioru(reference, n)) })
      const p = proby.find((x) => x.k.status === 'OK') ?? proby.find((x) => x.k.status === 'W_TOKU') ?? proby.find((x) => x.k.status === 'BRAK')
      if (!p) return { kind: 'TRWALY', reference, message: `${what}: ${MAX_PROB_ODBIORU} prób tego dnia odrzuconych przez Allegro; zamów odbiór w Allegro (Wysyłam z Allegro) albo „Zamów drugi raz” po sprawdzeniu` }
      if (p.k.status === 'OK') return AllegroWysylamZapisAdapter.wynikOdbioru(p.k, reference, what, {})
      const commandId = commandIdOdbioru(reference, p.n)
      if (p.k.status === 'W_TOKU') return AllegroWysylamZapisAdapter.wynikOdbioru(await this.czekajOdbior(commandId), reference, what, {})

      const f = await this.przesylkiPrzewoznika(req.przesylki ?? [])
      if ('przekroczony' in f) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: Allegro długo odpowiada przy sprawdzaniu przesyłek; nic nie zamówiono, spróbuj za chwilę` }
      const pominiete = [...f.inni.entries()].map(([c, n]) => `${c} ×${n}`).join(', ')
      if (!f.ids.length)
        return { kind: 'TRWALY', reference, message: `${what}: żadna z przesyłek czekających na kuriera nie jest przesyłką przewoźnika ${this.przewoznikOdbioru}${pominiete ? ` (przewoźnicy przesyłek w Allegro: ${pominiete})` : ''}; nic nie zamówiono` }
      // propozycje terminów: najwyżej ODBIOR_MAX_PRZESYLEK przesyłek (limit Allegro); komenda odbioru obejmuje wszystkie
      const doTerminow = f.ids.slice(0, ODBIOR_MAX_PRZESYLEK)

      // terminy proponowane przez Allegro: tylko podpowiedź (POST bez skutku, niczego nie zamawia); błąd nie blokuje
      let wspolne: TerminOdbioru[] = []
      let propozycje: unknown = null
      let stanPropozycji: number | null = null
      try {
        const pr = await this.write('POST', '/shipment-management/pickup-proposals', { shipmentIds: doTerminow, readyDate: req.data, address: a.adres }, { timeoutMs: KOMENDA_TIMEOUT_MS })
        if (pr.status === 403) return { kind: 'TRWALY', reference, message: `${what}: HTTP 403 — ${ZAKRES}` }
        stanPropozycji = pr.status
        if (pr.status >= 200 && pr.status < 300) {
          propozycje = pr.lista ?? pr.body
          wspolne = wspolneTerminyOdbioru(propozycje, doTerminow)
        }
      } catch (e) {
        if (!(e instanceof SourceError)) throw e
      }
      // skład do odmowy: przy osobnych odbiorach zawsze, przy innej odmowie tylko bez wspólnych terminów
      const sklad = skladOdbioru({ propozycje, stanPropozycji, transport: f.transport, przewoznik: this.przewoznikOdbioru, przesylek: f.ids.length, inni: f.inni })
      const t = terminOdbioru(wspolne, req.data, req.odMin, req.doMin)
      const okno = t.zAllegro && t.termin.minTime && t.termin.maxTime ? { odMin: minuty(t.termin.minTime), doMin: minuty(t.termin.maxTime) } : null
      const wyslane = t.termin.minTime && t.termin.maxTime ? { odMin: minuty(t.termin.minTime), doMin: minuty(t.termin.maxTime) } : null
      const extra = { okno: okno && (okno.odMin !== req.odMin || okno.doMin !== req.doMin) ? okno : null, wyslane, przesylek: f.ids.length, podpowiedz: t.zAllegro ? null : t.podpowiedz, sklad: wspolne.length ? null : sklad, skladOsobnych: sklad }

      let r: AllegroWriteResult | null = null
      try {
        r = await this.write('POST', '/shipment-management/pickups/create-commands', { commandId, input: { shipmentIds: f.ids, pickupTime: t.termin, address: a.adres } })
      } catch (e) {
        if (!(e instanceof SourceError)) throw e
        // brak odpowiedzi: wynik komendy rozstrzyga niżej (ten sam commandId nie zamówi drugiego odbioru)
      }
      if (r && !(r.status >= 200 && r.status < 300) && r.status !== 409) {
        if (r.status === 403) return { kind: 'TRWALY', reference, message: `${what}: HTTP 403 — ${ZAKRES}` }
        if (r.status === 429) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: HTTP 429 (limit zapytań); nic nie zamówiono, spróbuj za chwilę`, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) }
        if (r.status < 500) {
          const s = codes(r).includes(KOD_OSOBNE_ODBIORY) ? extra.skladOsobnych : extra.sklad
          return { kind: 'TRWALY', reference, ...(wyslane ? { okno: wyslane } : {}), message: `${what}: Allegro odrzuciło zamówienie odbioru (HTTP ${r.status}${codes(r)})${extra.podpowiedz ? `. Terminy odbioru proponowane przez Allegro: ${extra.podpowiedz}` : ''}${s ? `. ${SKLAD} ${s}` : ''}` }
        }
        // 5xx: komenda mogła wejść, wynik komendy rozstrzyga niżej
      }
      return AllegroWysylamZapisAdapter.wynikOdbioru(await this.czekajOdbior(commandId), reference, what, { ...extra, wyslana: true })
    } catch (e) {
      return asOutcome(e, reference, what)
    }
  }

  /**
   * Terminy odbioru proponowane przez Allegro dla przesyłek czekających na kuriera (podpowiedź w oknie „Zamów kuriera”,
   * jedna próba z limitem czasu, niczego nie zamawia). Bez przesyłek albo bez terminów = BRAK (okno pokazuje pola
   * godzin). Bez filtra przewoźnika (to tylko podpowiedź): przesyłki bez terminów nie zawężają listy.
   */
  async dostepnoscOdbioru(o: { timeoutMs: number; przesylki?: readonly string[] }): Promise<{ stan: 'OK'; dni: { dzienOd: number; przedzialy: { odMin: number; doMin: number }[] }[] } | { stan: 'BRAK' }> {
    if (!this.odbiorWlaczony) throw new AdapterError(ODBIOR_WYLACZONY, 'TRWALY')
    const ids = unikalnePrzesylki(o.przesylki ?? []).slice(0, ODBIOR_MAX_PRZESYLEK)
    if (!ids.length) return { stan: 'BRAK' }
    const a = this.adresOdbioru()
    if ('blad' in a) throw new AdapterError(a.blad, 'TRWALY')
    let pr: AllegroWriteResult
    try {
      pr = await this.write('POST', '/shipment-management/pickup-proposals', { shipmentIds: ids, address: a.adres }, { timeoutMs: o.timeoutMs })
    } catch (e) {
      if (e instanceof SourceError) throw new AdapterError('Allegro nie odpowiedziało na pytanie o terminy odbioru', 'PRZEJSCIOWY')
      throw e
    }
    if (pr.status < 200 || pr.status >= 300) throw new AdapterError(`Allegro: terminy odbioru HTTP ${pr.status}${codes(pr)}`, pr.status === 429 || pr.status >= 500 ? 'PRZEJSCIOWY' : 'TRWALY')
    const dzis = (this.ctx.now ?? (() => new Date()))().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' })
    const dni = dniZTerminow(wspolneTerminyOdbioru(pr.lista ?? pr.body, ids), dzis)
    return dni.length ? { stan: 'OK', dni } : { stan: 'BRAK' }
  }

  /**
   * Podział przesyłek czekających na kuriera na odbiory (`grupujPrzesylkiOdbioru`), sam odczyt: szczegóły odbiorów już
   * zamówionych (`GET /shipment-management/pickups/{pickupId}`, ich `shipmentIds` wypadają z listy), przewoźnik i
   * transport przesyłek, jedno pytanie o terminy (najwyżej ODBIOR_MAX_PRZESYLEK przesyłek; reszta dzieli się po
   * transporcie). Terminy w grupie = wspólne dla jej przesyłek. Błąd odczytu odbioru albo przesyłek = wyjątek (host
   * niczego nie zamawia); błąd pytania o terminy = podział po samym transporcie, bez terminów.
   */
  async grupyOdbioru(o: { przesylki: readonly string[]; wOdbiorze: readonly OdbiorPrzyjety[]; timeoutMs?: number; drobniej?: boolean }): Promise<{ grupy: GrupaOdbioru[]; powod: string | null }> {
    if (!this.odbiorWlaczony) throw new AdapterError(ODBIOR_WYLACZONY, 'TRWALY')
    const a = this.adresOdbioru()
    if ('blad' in a) throw new AdapterError(a.blad, 'TRWALY')
    // ten sam odbiór w kilku wierszach (np. po rozstrzygnięciu): najwyższa liczba przesyłek
    const odbiory = new Map<string, number>()
    for (const w of o.wOdbiorze) odbiory.set(w.id, Math.max(odbiory.get(w.id) ?? 0, w.przesylek))
    const zajete = new Set<string>()
    for (const [pickupId, przesylek] of odbiory) {
      if (!ALLEGRO_PICKUP_ID_RE.test(pickupId)) throw new AdapterError('nieczytelny identyfikator zamówionego już odbioru: nie wiadomo, które przesyłki obejmuje; nic nie zamówiono, zamów odbiór w Allegro (Wysyłam z Allegro)', 'TRWALY')
      const r = await this.odczyt<unknown>(`/shipment-management/pickups/${pickupId}`)
      if (r.status === 403) throw new AdapterError(`Allegro: HTTP 403 przy sprawdzaniu zamówionego odbioru — ${ZAKRES}`, 'TRWALY')
      // odbiór anulowany albo usunięty w Allegro: ponawianie nic nie da, stan trzeba sprawdzić w Allegro
      if (r.status === 404) throw new AdapterError('Allegro nie zna już zamówionego wcześniej odbioru (anulowany w Allegro?): nie wiadomo, które przesyłki czekają; nic nie zamówiono, sprawdź i zamów odbiór w Allegro (Wysyłam z Allegro)', 'TRWALY')
      const ids = obj(r.body)['shipmentIds']
      if (r.status < 200 || r.status >= 300 || !Array.isArray(ids))
        throw new AdapterError(`Allegro: nie udało się sprawdzić, które przesyłki są już w zamówionym odbiorze (HTTP ${r.status}); nic nie zamówiono, spróbuj za chwilę`, 'PRZEJSCIOWY')
      const wOdbiorze = new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0).map((id) => id.toLowerCase()))
      // odbiór bez przesyłek albo z mniejszą liczbą niż zamówiona: lista niepewna, nie wiadomo, co jest już w odbiorze
      if (!wOdbiorze.size || wOdbiorze.size < przesylek)
        throw new AdapterError(`Allegro zwróciło ${wOdbiorze.size} z ${przesylek} przesyłek zamówionego odbioru: nie wiadomo, które przesyłki są już w odbiorze; nic nie zamówiono, sprawdź odbiór w Allegro (Wysyłam z Allegro)`, 'TRWALY')
      for (const id of wOdbiorze) zajete.add(id)
    }
    const wolne = unikalnePrzesylki(o.przesylki).filter((id) => !zajete.has(id.toLowerCase()))
    if (!wolne.length) return { grupy: [], powod: null }
    const f = await this.przesylkiPrzewoznika(wolne)
    if ('przekroczony' in f) throw new AdapterError('Allegro długo odpowiada przy sprawdzaniu przesyłek; nic nie zamówiono, spróbuj za chwilę', 'PRZEJSCIOWY')
    const pominiete = [...f.inni.entries()].map(([c, n]) => `${c} ×${n}`).join(', ')
    if (!f.ids.length) return { grupy: [], powod: `żadna z przesyłek czekających na kuriera nie jest przesyłką przewoźnika ${this.przewoznikOdbioru}${pominiete ? ` (przewoźnicy przesyłek w Allegro: ${pominiete})` : ''}` }
    const doTerminow = f.ids.slice(0, ODBIOR_MAX_PRZESYLEK)
    let propozycje: unknown = null
    try {
      const pr = await this.write('POST', '/shipment-management/pickup-proposals', { shipmentIds: doTerminow, address: a.adres }, { timeoutMs: o.timeoutMs ?? KOMENDA_TIMEOUT_MS })
      if (pr.status >= 200 && pr.status < 300) propozycje = pr.lista ?? pr.body
    } catch (e) {
      if (!(e instanceof SourceError)) throw e
    }
    const dzis = (this.ctx.now ?? (() => new Date()))().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' })
    const grupy = grupujPrzesylkiOdbioru(
      f.ids.map((id) => ({ id, transport: f.transport.get(id) ?? null })),
      propozycje,
      { poElementach: o.drobniej === true },
    )
    return {
      grupy: grupy.map((g, i) => {
        const przewoznik = g.klucz.split('.')[0]!
        return {
          klucz: g.klucz,
          opis: grupy.length > 1 ? `odbiór ${i + 1} z ${grupy.length} (${przewoznik === 'x' ? 'transport bez nazwy przewoźnika' : `transport ${przewoznik}`})` : 'odbiór',
          przesylki: g.przesylki,
          dni: propozycje === null ? [] : dniZTerminow(wspolneTerminyOdbioru(propozycje, g.przesylki.filter((id) => doTerminow.includes(id))), dzis),
        }
      }),
      powod: null,
    }
  }

  async getLabel(externalRef: string, format: LabelFormat): Promise<{ contentType: string; base64: string }> {
    if (!UUID_RE.test(externalRef)) throw new AdapterError('zły numer przesyłki Allegro (oczekiwany UUID)', 'TRWALY')
    let r: AllegroWriteResult
    try {
      r = await this.write('POST', '/shipment-management/label', { shipmentIds: [externalRef], pageSize: 'A6', cutLine: false }, { binary: true })
    } catch (e) {
      if (e instanceof SourceError) throw new AdapterError(`etykieta Allegro: ${e.message}`, 'PRZEJSCIOWY')
      throw e
    }
    if (r.status === 403) throw new AdapterError(`etykieta Allegro: HTTP 403 — ${ZAKRES}`, 'TRWALY')
    if (r.status < 200 || r.status >= 300 || !r.bytes?.length) throw new AdapterError(`etykieta Allegro: HTTP ${r.status}${codes(r)}`, r.status === 429 || r.status >= 500 ? 'PRZEJSCIOWY' : 'TRWALY')
    const ct = r.contentType?.split(';')[0]?.trim() || (format === 'ZPL' ? 'text/plain' : 'application/pdf')
    return { contentType: ct, base64: r.bytes.toString('base64') }
  }

  /** Numer nadania z przesyłki (`packages[].waybill`); null = Allegro jeszcze go nie nadało. */
  async getTrackingNumber(externalRef: string): Promise<string | null> {
    return (await this.przesylka(externalRef))?.waybill ?? null
  }

  /**
   * Szczegóły przesyłki (`GET /shipment-management/shipments/{id}`): numer nadania, przewoźnik i anulowanie. Z odpowiedzi
   * bierzemy tylko te trzy pola (nadawca i odbiorca zostają w tej metodzie). null = Allegro nie zna przesyłki (404).
   */
  private async przesylka(externalRef: string): Promise<{ waybill: string | null; carrier: string | null; anulowana: boolean; transport: string | null } | null> {
    if (!UUID_RE.test(externalRef)) throw new AdapterError('zły numer przesyłki Allegro (oczekiwany UUID)', 'TRWALY')
    const r = await this.call<unknown>(`/shipment-management/shipments/${externalRef}`, ZAKRES)
    if (r.status === 404) return null
    if (r.status < 200 || r.status >= 300) throw new AdapterError(`przesyłka Allegro: HTTP ${r.status}`, 'PRZEJSCIOWY')
    const body = obj(r.body)
    const pk = body['packages']
    let waybill: string | null = null
    for (const p of Array.isArray(pk) ? pk : []) {
      const w = str(obj(p)['waybill'])
      if (w && ALLEGRO_WAYBILL_RE.test(w)) {
        waybill = w
        break
      }
    }
    const c = str(body['carrier'])
    return { waybill, carrier: c && ALLEGRO_CARRIER_ID_RE.test(c) ? c : null, anulowana: str(body['canceledDate']) !== null, transport: przewoznicyTransportu(body) }
  }

  /**
   * stan przesyłki u przewoźnika, sam odczyt. Dwa GET: szczegóły przesyłki (numer nadania i `carrier`, który
   * dokumentacja Allegro każe podać jako `{carrierId}`) i historia statusów `GET /order/carriers/{carrier}/tracking?waybill=…`
   * (bez osobnego zakresu OAuth: w specyfikacji `bearer-token-for-user: []`). Bez wyłącznika nadawania: odczyt nie
   * zmienia niczego w Allegro, a wyłączenie nadawania nie może zatrzymać śledzenia paczek już nadanych.
   * Bez numeru nadania albo bez historii (`trackingDetails: null`) = PRZED_NADANIEM. 403 przy historii to błąd tego
   * odczytu, nie konta (`PRZEJSCIOWY`): nie liczy się do wyłączenia konta Allegro, które obsługuje też zamówienia.
   */
  async trackShipment(externalRef: string): Promise<OdczytPrzesylki> {
    const p = await this.przesylka(externalRef)
    if (!p) throw new AdapterError('śledzenie Allegro: Allegro nie zna tej przesyłki (404)', 'TRWALY')
    if (p.anulowana) throw new AdapterError('śledzenie Allegro: przesyłka anulowana w Allegro, a w Kompletorze nadal utworzona: sprawdź ją na karcie zamówienia', 'TRWALY')
    if (!p.waybill) return { stan: 'PRZED_NADANIEM', status: null, opis: null, stanDrogi: 'UTWORZONA' }
    if (!p.carrier) throw new AdapterError('śledzenie Allegro: przesyłka bez identyfikatora przewoźnika (pole carrier)', 'TRWALY')
    const r = await this.odczyt<unknown>(`/order/carriers/${p.carrier}/tracking`, [['waybill', p.waybill]])
    if (r.status === 403) throw new AdapterError('śledzenie Allegro: odmowa dostępu do historii statusów (kod 403)', 'PRZEJSCIOWY')
    if (r.status < 200 || r.status >= 300) throw new AdapterError(`śledzenie Allegro: HTTP ${r.status}`, 'TRWALY')
    const wb = obj(r.body)['waybills']
    if (!Array.isArray(wb)) throw new AdapterError('śledzenie Allegro: odpowiedź bez listy numerów (waybills)', 'TRWALY')
    const moj = wb.map(obj).find((w) => str(w['waybill'])?.toUpperCase() === p.waybill!.toUpperCase())
    const szczegoly = moj ? moj['trackingDetails'] : null
    if (!szczegoly || typeof szczegoly !== 'object') return { stan: 'PRZED_NADANIEM', status: null, opis: null, stanDrogi: 'UTWORZONA' }
    const surowe = obj(szczegoly)['statuses']
    // oś statusów (śledzenie aż do doręczenia, domyślnie wyłączone): stan drogi z tej samej historii
    const statusy = (Array.isArray(surowe) ? surowe : []).map((x) => ({ kod: str(obj(x)['code']) ?? '', czas: str(obj(x)['occurredAt']) })).filter((x) => x.kod)
    return { ...stanAllegro(surowe), ...stanDrogiAllegro(statusy) }
  }

  async cancelShipment(externalRef: string, reference: string): Promise<WriteOutcome> {
    if (!this.enabled) return { kind: 'TRWALY', reference, message: NADAWANIE_WYLACZONE }
    const what = 'anulowanie przesyłki Wysyłam z Allegro'
    if (!UUID_RE.test(externalRef)) return { kind: 'TRWALY', reference, message: `${what}: zły numer przesyłki` }
    const commandId = commandIdAnulowania(reference)
    try {
      let k = await this.komenda('cancel', commandId)
      if (k.status === 'BRAK') {
        let r: AllegroWriteResult | null = null
        try {
          r = await this.write('POST', '/shipment-management/shipments/cancel-commands', { commandId, input: { shipmentId: externalRef } })
        } catch (e) {
          if (!(e instanceof SourceError)) throw e
        }
        if (r && !(r.status >= 200 && r.status < 300) && r.status !== 409) {
          if (r.status === 403) return { kind: 'TRWALY', reference, message: `${what}: HTTP 403 — ${ZAKRES}` }
          if (r.status === 429 || r.status >= 500) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: HTTP ${r.status}` }
          return { kind: 'TRWALY', reference, message: `${what}: Allegro odrzuciło (HTTP ${r.status}${codes(r)})` }
        }
        k = await this.czekaj('cancel', commandId)
      } else if (k.status === 'W_TOKU') k = await this.czekaj('cancel', commandId)
      if (k.status === 'OK') return { kind: 'OK', reference, externalRef }
      if (k.status === 'BLAD') return { kind: 'TRWALY', reference, message: `${what}: Allegro odmówiło${k.kody.length ? ` (${k.kody.join(', ')})` : ''} — przesyłka mogła już zostać nadana` }
      // komenda anulowania z tym samym commandId jest bezpieczna do powtórki
      return { kind: 'PRZEJSCIOWY', reference, message: `${what}: Allegro jeszcze przetwarza anulowanie` }
    } catch (e) {
      return asOutcome(e, reference, what)
    }
  }
}

export const ALLEGRO_WYSYLAM_ZAPIS_DEFINITION: AdapterDefinition = { manifest: ALLEGRO_WYSYLAM_ZAPIS_MANIFEST, create: (ctx) => new AllegroWysylamZapisAdapter(ctx) }
