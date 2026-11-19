// Adaptery przewoźnika Poczta Polska, Pocztex Kurier przez eNadawcę (SOAP):
//   `pocztapolska.enadawca.v1` — domyślny, tylko do odczytu: liczy przesyłkę (lib/wysylka/pocztapolska.ts), test
//     połączenia listą urzędów nadania konta. Śledzenie (`shipment.track`, usługa Śledzenie z WSSE) ma wersja z zapisem.
//   `pocztapolska.enadawca.zapis.v1` — przesyłka do bufora partii (`addShipment`), etykieta (`getPrintForParcel`),
//     usunięcie z bufora (anulowanie przed wysłaniem partii), „Wyślij partię” (`sendEnvelope`, opcjonalnie z zamówieniem
//     kuriera). Bez `zapisWlaczony: true` żadne żądanie zapisu nie wychodzi (test pilnuje).
//
// Oparte na wiedzy z Open Integration Platform, integrators/courier/pocztapolska/v1.0.0/src/integration.py (commit
// ae43d1e, Copyright 2024-2026 Pinquark.com, Apache License 2.0), przepisane i zmienione: własny kod TypeScript w
// kontrakcie Kompletora, bufor partii zamiast czyszczenia bufora konta, idempotencja i klasy błędów po naszemu.
// Atrybucja: THIRD_PARTY_NOTICES.md.
//
// Bufor partii: eNadawca trzyma przesyłki w buforze konta, dopóki nadawca nie „wyśle” go do urzędu nadania. Konektor
// OIP przed każdą przesyłką woła `clearEnvelope`, które czyści CAŁY bufor (także paczki innych zamówień i paczki
// dodane ręcznie w eNadawcy). U nas: osobny bufor Kompletora na dzień nadania i urząd („Kompletor RRRR-MM-DD”), a
// usuwanie wyłącznie po GUID przesyłek tej partii (`clearEnvelopeByGuids`). `clearEnvelope` nie jest dozwolone w
// kliencie.
//
// Idempotencja (u nich jej nie ma): GUID przesyłki wynika z referencji hosta (lib/wysylka/pocztapolska.ts), więc
// ponowienie wysyła ten sam GUID. Odszukanie po referencji czyta bufory Kompletora i dane przesyłki po GUID; wynik może
// tylko POTWIERDZIĆ przesyłkę, brak trafienia jest błędem (człowiek), nigdy `found: false`. Przed każdym `addShipment`
// adapter sam sprawdza, czy przesyłka o tym GUID już jest (nie polega na tym, jak eNadawca opisze powtórzony GUID), a
// przy trafieniu porównuje adres, masę i format z bieżącym zamówieniem.
import { createHash } from 'node:crypto'
import { parseNadawca } from '../wysylka/zlecenie-dpd'
import { adresatPP, guidZReferencji, GUID_PP_RE, nadawcaPP, ustawieniaPP, wyliczPrzesylkePP, zleceniePP, type UstawieniaPP } from '../wysylka/pocztapolska'
import { SourceError } from '../zrodla/http'
import {
  bledy,
  bloki,
  ENADAWCA_PROD,
  ENADAWCA_TEST,
  ENADAWCA_URL_RE,
  EnadawcaOdczyt,
  EnadawcaZapis,
  SledzenieOdczyt,
  wartosc,
  type LogowaniePP,
} from '../zrodla/pocztapolska'
import {
  AdapterError,
  BladKontaSledzenia,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type ChannelAdapter,
  type ConfigField,
  type ConnectionTest,
  type LabelFormat,
  type PotwierdzenieRecznego,
  type PreparedParcel,
  type ReferenceFinder,
  type ReferenceLookup,
  type ShipmentCreateRequest,
  type ShipmentCreator,
  type ShipmentInput,
  type ShipmentPreparer,
  type ShipmentTracker,
  type OdczytPrzesylki,
  type StanDrogi,
  type StanPrzesylki,
  type WriteOutcome,
} from './kontrakt'
import { jestNieZnaleziono, klasyfikujBledy } from './pocztapolska-kody'

export const PP_KEY = 'pocztapolska.enadawca.v1'
export const PP_ZAPIS_KEY = 'pocztapolska.enadawca.zapis.v1'

const CONFIG: readonly ConfigField[] = [
  {
    key: 'srodowisko',
    type: 'string',
    required: false,
    description: 'środowisko eNadawcy: test (domyślnie, osobne konto testowe od Poczty Polskiej) albo produkcja',
    options: [
      { value: 'test', label: 'Testowe (konto testowe eNadawcy)' },
      { value: 'produkcja', label: 'Produkcyjne (prawdziwe przesyłki)' },
    ],
  },
  { key: 'baseUrl', type: 'string', required: false, description: 'self-host: adres usługi zamiast środowiska (tylko adresy eNadawcy Poczty Polskiej)', pattern: ENADAWCA_URL_RE, envSuffix: 'BASE_URL' },
  { key: 'envPrefix', type: 'string', required: false, description: 'self-host: przedrostek zmiennych env (np. ENADAWCA)', pattern: /^[A-Z][A-Z0-9_]{0,40}$/ },
  { key: 'urzadNadania', type: 'string', required: false, description: 'numer urzędu nadania z umowy (lista w eNadawcy; „Sprawdź połączenie” pokazuje urzędy konta)', pattern: /^\d{1,12}$/ },
  { key: 'defaultWeightKg', type: 'number', required: false, description: 'waga paczki w kg, gdy produkty nie mają wagi' },
  { key: 'defaultSideXCm', type: 'number', required: false, description: 'wymiar paczki w cm (bok 1), z niego liczy się format S…2XL' },
  { key: 'defaultSideYCm', type: 'number', required: false, description: 'wymiar paczki w cm (bok 2)' },
  { key: 'defaultSideZCm', type: 'number', required: false, description: 'wymiar paczki w cm (bok 3)' },
]

const SECRETS: AdapterManifest['secrets'] = [
  { name: 'ENADAWCA_LOGIN', required: true, description: 'login konta eNadawcy (API)', envSuffix: 'LOGIN' },
  { name: 'ENADAWCA_HASLO', required: true, description: 'hasło konta eNadawcy (API)', envSuffix: 'HASLO' },
  { name: 'SLEDZENIE_LOGIN', required: false, description: 'login usługi Śledzenie Poczty Polskiej; brak = śledzenie wyłączone (login eNadawcy nie jest tam wysyłany)', envSuffix: 'SLEDZENIE_LOGIN' },
  { name: 'SLEDZENIE_HASLO', required: false, description: 'hasło usługi Śledzenie; brak = śledzenie wyłączone', envSuffix: 'SLEDZENIE_HASLO' },
]

const SLEDZENIE_ODMOWA = 'Śledzenie Poczty Polskiej: odmowa dostępu, sprawdź dane usługi Śledzenie (SLEDZENIE_LOGIN, SLEDZENIE_HASLO)'
const SLEDZENIE_WYLACZONE = 'śledzenie Poczty Polskiej wyłączone: brak loginu i hasła usługi Śledzenie (SLEDZENIE_LOGIN, SLEDZENIE_HASLO) w ustawieniach konta; login eNadawcy nie jest wysyłany do innej usługi'

// Dokumentacja nie podaje limitów: ostrożnie, jedno żądanie naraz.
const RATE = { requestsPerMinute: 30, maxConcurrent: 1, minPollIntervalMs: 0 }

export const PP_MANIFEST: AdapterManifest = {
  adapterKey: PP_KEY,
  version: '1.0.0',
  displayName: 'Poczta Polska (eNadawca)',
  kind: 'carrier',
  // shipment.track tylko w wersji z zapisem (jak u innych przewoźników): śledzi przesyłki, które ona utworzyła
  capabilities: ['shipment.prepare'],
  rateLimit: RATE,
  config: CONFIG,
  secrets: SECRETS,
  readOnly: true,
}

const ZAPIS_TIMEOUT_MS = 60_000
const ODCZYT_TIMEOUT_MS = 30_000
const ODCZYT_PROBY = 3
const ODCZYT_PRZERWA_MS = 500
/** Ile ostatnich buforów Kompletora przeszukuje odszukanie po referencji (dni nadania wstecz). */
export const ODSZUKANIE_BUFOROW = 5
/** Sufit buforów przeszukiwanych przy anulowaniu i rozstrzygnięciu ręcznym (`wszystkie`): więcej = jasny błąd zamiast setek odczytów. */
export const MAKS_BUFOROW_PRZESZUKANIA = 30
/**
 * Najgorszy „Utwórz przesyłkę”, żeby host nie uznał TWORZENIA za zawieszone za wcześnie. Ponowienie:
 * odszukanie przed dodaniem (lista buforów + 5 buforów + odczyt po GUID = 7 odczytów, bez trafienia), potem dwa razy
 * „bufor dnia (lista + założenie), addShipment z nieznanym błędem, sprawdzenie (ten bufor + odczyt po GUID), różnica
 * danych = usunięcie” (2 × 3 odczyty, 2 × 3 zapisy). Razem 13 odczytów (każdy do 3 prób po 30 s z przerwami) i 6 zapisów
 * po 60 s: ok. 26 min. Zwykła ścieżka bez błędu: lista buforów i najwyżej 2 zapisy (założenie bufora, addShipment).
 */
const NAJGORSZE_ODCZYTY = 7 + 2 * 3
const NAJGORSZE_ZAPISY = 2 * 3
export const NAJDLUZSZE_UTWORZENIE_MS = NAJGORSZE_ZAPISY * ZAPIS_TIMEOUT_MS + NAJGORSZE_ODCZYTY * ODCZYT_PROBY * ODCZYT_TIMEOUT_MS + NAJGORSZE_ODCZYTY * 4 * ODCZYT_PRZERWA_MS

export const PP_ZAPIS_MANIFEST: AdapterManifest = {
  adapterKey: PP_ZAPIS_KEY,
  version: '1.0.0',
  displayName: 'Poczta Polska (eNadawca, nadawanie za wyłącznikiem)',
  kind: 'carrier',
  capabilities: ['shipment.prepare', 'shipment.track', 'shipment.create', 'shipment.cancel', 'reference.find'],
  rateLimit: RATE,
  config: [
    ...CONFIG,
    { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'wyłącznik: true = adapter może dodawać przesyłki do eNadawcy, pobierać etykiety i wysyłać partie; brak = nic nie wysyła' },
    { key: 'zamowKuriera', type: 'boolean', required: false, description: 'przy „Wyślij partię” zamów też odbiór kurierem (bez tego paczki zawozisz do urzędu nadania)' },
    { key: 'godzinaOdbioru', type: 'string', required: false, description: 'godzina odbioru przez kuriera (GG:MM), gdy zamawiasz kuriera', pattern: /^([01]\d|2[0-3]):[0-5]\d$/ },
    { key: 'nadawca', type: 'string', required: false, description: 'JSON z danymi nadawcy firmy (wstawia host przy tworzeniu adaptera)' },
  ],
  secrets: SECRETS,
  readOnly: false,
  shipmentMaxCreateMs: NAJDLUZSZE_UTWORZENIE_MS,
}

/** Adres usługi: jawny `baseUrl` (self-host) albo środowisko; brak = testowe (bez ryzyka prawdziwej przesyłki). */
export function adresEnadawcy(config: Readonly<Record<string, unknown>>): string {
  if (typeof config['baseUrl'] === 'string' && config['baseUrl']) return config['baseUrl']
  return config['srodowisko'] === 'produkcja' ? ENADAWCA_PROD : ENADAWCA_TEST
}

/** Data w Polsce (RRRR-MM-DD): dzień nadania partii. */
export const dzienPl = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
/**
 * Znacznik firmy w nazwie bufora: 6 znaków ze skrótu identyfikatora firmy. Dwie firmy albo staging i produkcja na
 * jednym koncie eNadawcy mają osobne bufory, więc „Wyślij partię” jednej nie wyśle paczek drugiej.
 */
export const znacznikFirmy = (organizationId: string) => createHash('sha256').update(`kompletor-firma:${organizationId}`).digest('hex').slice(0, 6)
export const opisPartii = (znacznik: string, dzien: string) => `Kompletor ${znacznik} ${dzien}`
const OPIS_PARTII_RE = /^Kompletor ([0-9a-f]{6}) (\d{4}-\d{2}-\d{2})$/

/** Trafienie odszukania po GUID: numer nadania, bufor (null = przesyłka w wysłanej partii) i cały element z danymi. */
interface TrafieniePP {
  numer: string | null
  idBufor: string | null
  blok: string
}

/** Pola porównywane przy ponowieniu: kod pocztowy, ulica z numerem, masa, format. */
const POLA_ZGODNOSCI = ['kod pocztowy', 'ulica', 'numer domu', 'numer lokalu', 'masa', 'format'] as const
const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[\s-]+/g, '')

type PoleZgodnosci = (typeof POLA_ZGODNOSCI)[number]

/** Wartości pól porównania z przesyłki w eNadawcy; null = pole nieczytelne (brak elementu w odpowiedzi). */
function polaEnadawcy(blok: string): [PoleZgodnosci, string | null][] {
  const blokAdresu = bloki(blok, 'adres')[0] ?? null
  const odczyt = (b: string | null, n: string) => (b === null ? null : wartosc(b, n))
  return [
    ['kod pocztowy', odczyt(blokAdresu, 'kodPocztowy')],
    ['ulica', odczyt(blokAdresu, 'ulica')],
    ['numer domu', odczyt(blokAdresu, 'numerDomu')],
    // czytelny adres bez lokalu = lokal pusty (eNadawca pomija puste pola)
    ['numer lokalu', blokAdresu !== null && wartosc(blokAdresu, 'ulica') !== null ? (wartosc(blokAdresu, 'numerLokalu') ?? '') : null],
    ['masa', wartosc(blok, 'masa')],
    ['format', wartosc(blok, 'format')],
  ]
}

/** Pola przesyłki w eNadawcy, których Kompletor nie odczytał (kształt odpowiedzi do potwierdzenia na koncie testowym). */
export function nieczytelnePola(blok: string): string[] {
  return polaEnadawcy(blok).filter(([, w]) => w === null).map(([p]) => p)
}

/**
 * Różnice między przesyłką w eNadawcy a bieżącym zleceniem. Pole nieczytelne w odpowiedzi eNadawcy NIE jest
 * pomijane: wraca w `nieczytelne` i adapter traktuje je jak różnicę, bo nie da się potwierdzić, że dane
 * w eNadawcy są aktualne.
 */
export function roznicePrzesylki(blok: string, przesylka: Readonly<Record<string, unknown>>): { rozne: string[]; nieczytelne: string[] } {
  const adres = (przesylka['adres'] ?? {}) as Record<string, unknown>
  const teraz: Record<PoleZgodnosci, string> = {
    'kod pocztowy': String(adres['kodPocztowy'] ?? ''),
    ulica: String(adres['ulica'] ?? ''),
    'numer domu': String(adres['numerDomu'] ?? ''),
    'numer lokalu': String(adres['numerLokalu'] ?? ''),
    masa: String(przesylka['masa'] ?? ''),
    format: String(przesylka['format'] ?? ''),
  }
  const rozne: string[] = []
  const nieczytelne: string[] = []
  for (const [pole, wEnadawcy] of polaEnadawcy(blok)) {
    const t = teraz[pole]
    if (wEnadawcy === null) nieczytelne.push(pole)
    else if (pole === 'kod pocztowy' ? wEnadawcy.replace(/\D/g, '') !== t.replace(/\D/g, '') : norm(wEnadawcy) !== norm(t)) rozne.push(pole)
  }
  return { rozne, nieczytelne }
}

const BEZ_PONAWIANIA = 'nie wiadomo, czy przesyłka powstała w eNadawcy: nie twórz jej drugi raz, kliknij „Sprawdź u przewoźnika”'

/** Stan śledzenia z kodu zdarzenia Poczty: przed odbiorem / w drodze. Statusy usługi wg konektora OIP. */
const STATUS_SLEDZENIA = { OK: 0, INNE_PRZESYLKI: 1, BRAK: -1, ZLY_NUMER: -2 } as const

/**
 * Kod zdarzenia usługi Śledzenie na osi statusów. Pełna lista kodów Poczty nie jest publiczna, więc tylko kody
 * potwierdzone: `P_NAD` nadanie (atrapa testów), `P_D` doręczenie i `P_A*` awizo (opis usługi w dokumentacji Poczty).
 * Każdy inny kod = nieznany (zwrot i odbiór w placówce czekają na listę kodów). Brak zdarzeń = utworzona.
 */
export function stanDrogiPoczty(kod: string | null | undefined): StanDrogi {
  if (!kod) return 'UTWORZONA'
  if (kod === 'P_NAD') return 'PRZEKAZANA'
  if (kod === 'P_D') return 'DORECZONA'
  if (kod.startsWith('P_A')) return 'NIEUDANE_DORECZENIE'
  return 'NIEZNANY'
}

function rodzaj(e: unknown): 'PRZEJSCIOWY' | 'TRWALY' {
  return e instanceof SourceError && e.retryable ? 'PRZEJSCIOWY' : 'TRWALY'
}

interface Partia {
  idBufor: string
  dzien: string
}

class PocztaPolskaAdapter implements ChannelAdapter, ShipmentPreparer, ShipmentTracker {
  readonly manifest: AdapterManifest = PP_MANIFEST
  protected readonly odczyt: EnadawcaOdczyt
  private readonly ustawienia: UstawieniaPP
  /** Numery nadania z bieżącego `addShipment` (GUID → numer), żeby host nie czytał ich ponownie. */
  protected readonly numery = new Map<string, string>()

  constructor(protected readonly ctx: AdapterContext) {
    const r = ctx.http?.retry
    const retry = { attempts: Math.max(1, Math.min(r?.attempts ?? ODCZYT_PROBY, ODCZYT_PROBY)), baseDelayMs: Math.max(0, Math.min(r?.baseDelayMs ?? ODCZYT_PRZERWA_MS, ODCZYT_PRZERWA_MS)) }
    this.odczyt = new EnadawcaOdczyt({ url: adresEnadawcy(ctx.config), auth: this.logowanie(), fetchImpl: ctx.fetch, timeoutMs: ODCZYT_TIMEOUT_MS, retry })
    this.ustawienia = ustawieniaPP(ctx.config)
  }

  protected logowanie(): LogowaniePP {
    return { login: this.ctx.secrets['ENADAWCA_LOGIN']!, haslo: this.ctx.secrets['ENADAWCA_HASLO']! }
  }

  protected get urzad(): string | null {
    const u = this.ctx.config['urzadNadania']
    return typeof u === 'string' && /^\d{1,12}$/.test(u) ? u : null
  }

  protected teraz(): Date {
    return (this.ctx.now ?? (() => new Date()))()
  }

  /** Lista urzędów nadania konta (getUrzedyNadania): zły login = TRWALY, sieć = PRZEJSCIOWY; urząd spoza listy = błąd konfiguracji. */
  async testConnection(): Promise<ConnectionTest> {
    const srodowisko = adresEnadawcy(this.ctx.config) === ENADAWCA_TEST ? 'test' : 'produkcja'
    try {
      const xml = await this.odczyt.wywolaj('getUrzedyNadania')
      const urzedy = bloki(xml, 'urzedyNadania').map((b) => wartosc(b, 'urzadNadania')).filter((u): u is string => !!u)
      if (!urzedy.length) return { ok: false, message: 'konto eNadawcy nie ma podpisanej umowy z żadnym urzędem nadania', details: { rodzaj: 'TRWALY', srodowisko } }
      if (this.urzad && !urzedy.includes(this.urzad)) return { ok: false, message: `urząd nadania ${this.urzad} nie jest na liście urzędów konta (${urzedy.join(', ')})`, details: { rodzaj: 'TRWALY', srodowisko } }
      return { ok: true, message: `konto eNadawcy odpowiada (środowisko ${srodowisko === 'test' ? 'testowe' : 'produkcyjne'}), urzędy nadania: ${urzedy.join(', ')}`, details: { srodowisko, urzedy: urzedy.join(', '), urzadNadania: this.urzad } }
    } catch (e) {
      return { ok: false, message: e instanceof SourceError ? e.message : 'błąd zapytania o konto eNadawcy', details: { rodzaj: rodzaj(e), srodowisko } }
    }
  }

  prepareShipment(input: ShipmentInput): PreparedParcel {
    return wyliczPrzesylkePP(input, this.ustawienia)
  }

  protected get znacznik(): string {
    return znacznikFirmy(this.ctx.integration.organizationId)
  }

  /** Bufory Kompletora tej firmy (getEnvelopeBuforList), najnowszy dzień najpierw; bufory spoza Kompletora i innych firm pomijane. */
  protected async buforyKompletora(): Promise<{ idBufor: string; dzien: string; urzad: string | null }[]> {
    let xml: string
    try {
      xml = await this.odczyt.wywolaj('getEnvelopeBuforList')
    } catch (e) {
      throw new AdapterError(`eNadawca: lista buforów niedostępna (${e instanceof Error ? e.message : 'błąd'})`, rodzaj(e))
    }
    const moj = this.znacznik
    return bloki(xml, 'bufor')
      .map((b) => ({ idBufor: wartosc(b, 'idBufor') ?? '', m: OPIS_PARTII_RE.exec(wartosc(b, 'opis') ?? ''), urzad: wartosc(b, 'urzadNadania') }))
      .filter((b) => /^\d+$/.test(b.idBufor) && b.m?.[1] === moj)
      .map((b) => ({ idBufor: b.idBufor, dzien: b.m![2]!, urzad: b.urzad }))
      .sort((a, b) => (a.dzien < b.dzien ? 1 : a.dzien > b.dzien ? -1 : 0))
  }

  /**
   * Przesyłka o tym GUID: w buforach Kompletora (ostatnie dni albo `wszystkie`), potem dane przesyłki po GUID (wysłana
   * partia). null TYLKO, gdy eNadawca jednoznacznie odpowiada „nie znaleziono”; błąd odczytu, nierozpoznany błąd
   * i nieczytelna odpowiedź = wyjątek, bo to nie dowód, że przesyłki nie ma.
   */
  protected async szukajGuid(guid: string, opcje: { wszystkie?: boolean; bufor?: string } = {}): Promise<TrafieniePP | null> {
    // `bufor`: po błędzie zapisu wystarczy bufor, do którego dodawaliśmy, i odczyt po GUID (bez listy buforów)
    const bufory = opcje.bufor ? [{ idBufor: opcje.bufor, dzien: 'bieżący' }] : await this.buforyKompletora()
    const limit = opcje.bufor ? 1 : opcje.wszystkie ? MAKS_BUFOROW_PRZESZUKANIA : ODSZUKANIE_BUFOROW
    // przy `wszystkie` powyżej sufitu brak trafienia nie jest dowodem braku
    const niepelne = !!opcje.wszystkie && bufory.length > MAKS_BUFOROW_PRZESZUKANIA
    for (const b of bufory.slice(0, limit)) {
      let xml: string
      try {
        xml = await this.odczyt.wywolaj('getEnvelopeBufor', { idBufor: b.idBufor })
      } catch (e) {
        throw new AdapterError(`eNadawca: bufor ${b.dzien} niedostępny (${e instanceof Error ? e.message : 'błąd'})`, rodzaj(e))
      }
      const p = bloki(xml, 'przesylka').find((x) => (wartosc(x, 'guid') ?? '').toUpperCase() === guid)
      if (p) return { numer: wartosc(p, 'numerNadania') || null, idBufor: b.idBufor, blok: p }
    }
    let xml: string
    try {
      xml = await this.odczyt.wywolaj('getAddresLabelByGuidCompact', { guid })
    } catch (e) {
      throw new AdapterError(`eNadawca: dane przesyłki niedostępne (${e instanceof Error ? e.message : 'błąd'})`, rodzaj(e))
    }
    const tresc = bloki(xml, 'content').find((x) => (wartosc(x, 'guid') ?? '').toUpperCase() === guid)
    if (tresc) return { numer: wartosc(tresc, 'numerNadania') || null, idBufor: null, blok: tresc }
    const bl = bledy(xml)
    if (bl.length && bl.every((b) => jestNieZnaleziono(b))) {
      if (niepelne) throw new AdapterError(`eNadawca: Kompletor ma ponad ${MAKS_BUFOROW_PRZESZUKANIA} niewysłanych partii i przeszukał tylko najnowsze ${MAKS_BUFOROW_PRZESZUKANIA}: wyślij albo usuń stare partie Kompletora w eNadawcy i spróbuj ponownie`, 'TRWALY')
      return null
    }
    const kody = bl.map((b) => b.numer).filter((n) => n !== null)
    throw new AdapterError(
      bl.length
        ? `eNadawca: odczyt przesyłki po identyfikatorze zwrócił nierozpoznany błąd${kody.length ? ` (kod ${kody.join(', ')})` : ''}: nie wiadomo, czy przesyłka istnieje`
        : 'eNadawca: nieczytelna odpowiedź przy odczycie przesyłki po identyfikatorze: nie wiadomo, czy przesyłka istnieje',
      'TRWALY',
    )
  }

  async getTrackingNumber(externalRef: string): Promise<string | null> {
    if (!GUID_PP_RE.test(externalRef)) throw new AdapterError('zły identyfikator przesyłki eNadawcy', 'TRWALY')
    const zPamieci = this.numery.get(externalRef)
    if (zPamieci) return zPamieci
    return (await this.szukajGuid(externalRef))?.numer ?? null
  }

  /**
   * Stan przesyłki (usługa Śledzenie, WSSE). Bez numeru nadania albo „brak przesyłki” w śledzeniu = PRZED_NADANIEM
   * (Poczta jeszcze jej nie ma); jakiekolwiek zdarzenie = PRZEKAZANA; zły numer i inne statusy = TRWALY.
   */
  async trackShipment(externalRef: string): Promise<OdczytPrzesylki> {
    // bez osobnych danych usługi Śledzenie nie śledzimy; login eNadawcy nie idzie do innej usługi
    const s = this.ctx.secrets
    const login = s['SLEDZENIE_LOGIN']
    const haslo = s['SLEDZENIE_HASLO']
    if (!login || !haslo) throw new BladKontaSledzenia(SLEDZENIE_WYLACZONE, true)
    const numer = await this.getTrackingNumber(externalRef)
    if (!numer) return { stan: 'PRZED_NADANIEM', status: null, stanDrogi: 'UTWORZONA' }
    const sledzenie = new SledzenieOdczyt({
      auth: { login, haslo },
      fetchImpl: this.ctx.fetch,
      timeoutMs: ODCZYT_TIMEOUT_MS,
      retry: { attempts: 2, baseDelayMs: 0 },
    })
    let xml: string
    try {
      xml = await sledzenie.sprawdzPrzesylke(numer)
    } catch (e) {
      // odmowa usługi Śledzenie (osobne dane logowania) = błąd konta śledzenia, nie licz do wyłączenia konta eNadawcy
      if (e instanceof SourceError && (e.httpStatus === 401 || e.httpStatus === 403)) throw new BladKontaSledzenia(SLEDZENIE_ODMOWA, true)
      throw new AdapterError(e instanceof Error ? e.message : 'błąd śledzenia Poczty Polskiej', rodzaj(e))
    }
    const status = Number(wartosc(xml, 'status'))
    if (status === STATUS_SLEDZENIA.BRAK) return { stan: 'PRZED_NADANIEM', status: null, stanDrogi: 'UTWORZONA' }
    if (status !== STATUS_SLEDZENIA.OK && status !== STATUS_SLEDZENIA.INNE_PRZESYLKI) throw new AdapterError(`Śledzenie Poczty Polskiej odrzuciło numer (status ${Number.isFinite(status) ? status : 'nieczytelny'})`, 'TRWALY')
    const zdarzenia = bloki(xml, 'zdarzenie').map((z) => ({ czas: wartosc(z, 'czas') ?? '', kod: wartosc(z, 'kod') }))
    if (!zdarzenia.length) return { stan: 'PRZED_NADANIEM', status: null, stanDrogi: 'UTWORZONA' }
    zdarzenia.sort((a, b) => (a.czas < b.czas ? 1 : a.czas > b.czas ? -1 : 0))
    // każde zdarzenie = przesyłka u Poczty, więc czas przekazania = najwcześniejsze zdarzenie
    return {
      stan: 'PRZEKAZANA',
      status: zdarzenia[0]!.kod,
      stanDrogi: zdarzenia[0]!.kod ? stanDrogiPoczty(zdarzenia[0]!.kod) : 'NIEZNANY',
      czas: zdarzenia[0]!.czas || null,
      kod: zdarzenia[0]!.kod ?? null,
      przekazanaO: zdarzenia.at(-1)!.czas || null,
    }
  }
}

const WYLACZONY = 'zapis wyłączony'

/** Wysłany bufor Kompletora. */
export interface WyslanaPartia {
  idBufor: string
  przesylek: number
  idEnvelope: string | null
  status: string | null
}

/** Wynik „Wyślij partię”. */
export interface WynikPartii {
  dzien: string
  /** Liczba przesyłek we wszystkich wysłanych buforach dnia; 0 = nie było czego wysyłać. */
  przesylek: number
  /** Wysłane bufory Kompletora z tego dnia: zwykle jeden, po wyścigu dwóch procesów więcej (wysyłamy wszystkie). */
  partie: WyslanaPartia[]
  /** Pierwszej wysłanej partii (zgodność z pojedynczym buforem). */
  idEnvelope: string | null
  status: string | null
  /** NIEPEWNY = nie wiadomo, czy odbiór jest zamówiony: sprawdzić w eNadawcy, nie zamawiać drugi raz. */
  kurier: 'ZAMOWIONY' | 'NIE_ZAMAWIANO' | 'BLAD' | 'NIEPEWNY'
  uwaga: string | null
  /**
   * Dni z niewysłanymi buforami Kompletora sprzed `dzien` i bufory na inny urząd nadania jako „RRRR-MM-DD (urząd N)”
   * te paczki nie wyjdą, dopóki ktoś ich nie wyśle.
   */
  zalegle: string[]
}

type Zlecenie = ReturnType<typeof zleceniePP>

class PocztaPolskaZapisAdapter extends PocztaPolskaAdapter implements ShipmentCreator, ReferenceFinder {
  override readonly manifest: AdapterManifest = PP_ZAPIS_MANIFEST
  private klient: EnadawcaZapis | null = null
  private partia: Partia | null = null

  private get wlaczony(): boolean {
    return this.ctx.config['zapisWlaczony'] === true
  }

  private zapis(): EnadawcaZapis {
    if (!this.wlaczony) throw new AdapterError(WYLACZONY, 'TRWALY')
    this.klient ??= new EnadawcaZapis({ url: adresEnadawcy(this.ctx.config), auth: this.logowanie(), fetchImpl: this.ctx.fetch, timeoutMs: ZAPIS_TIMEOUT_MS, wylacznik: true })
    return this.klient
  }

  /** Bufor Kompletora tej firmy na dzień nadania i urząd: istniejący (lista buforów) albo nowy (`createEnvelopeBufor`). */
  private async partiaDnia(dzien: string, urzad: string): Promise<Partia | WriteOutcome> {
    if (this.partia?.dzien === dzien) return this.partia
    let jest: { idBufor: string } | undefined
    try {
      jest = (await this.buforyKompletora()).find((b) => b.dzien === dzien && (!b.urzad || b.urzad === urzad))
    } catch (e) {
      return { kind: e instanceof AdapterError && e.kind === 'PRZEJSCIOWY' ? 'PRZEJSCIOWY' : 'TRWALY', reference: '', message: e instanceof Error ? e.message : 'błąd odczytu eNadawcy' }
    }
    if (jest) return (this.partia = { idBufor: jest.idBufor, dzien })
    const r = await this.zapis().wywolaj('createEnvelopeBufor', { bufor: { dataNadania: dzien, urzadNadania: urzad, opis: opisPartii(this.znacznik, dzien), active: true } })
    // Bufor bez przesyłki nic nie kosztuje: niepewny wynik = ponowienie (lista buforów znajdzie założony).
    if (!r.ok) return { kind: r.kind === 'TRWALY' ? 'TRWALY' : 'PRZEJSCIOWY', reference: '', message: r.message }
    const b = klasyfikujBledy(bledy(r.xml))
    if (b) return { kind: b.klasa === 'TRWALY' ? 'TRWALY' : 'PRZEJSCIOWY', reference: '', message: `eNadawca nie założył bufora partii: ${b.message}`, ...(b.errorClass ? { errorClass: b.errorClass } : {}) }
    const id = wartosc(r.xml, 'idBufor')
    if (!id || !/^\d+$/.test(id)) return { kind: 'PRZEJSCIOWY', reference: '', message: 'eNadawca: odpowiedź bez numeru bufora partii' }
    return (this.partia = { idBufor: id, dzien })
  }

  async createShipment(req: ShipmentCreateRequest, reference: string): Promise<WriteOutcome> {
    if (!this.wlaczony) return { kind: 'TRWALY', reference, message: WYLACZONY }
    if (req.carrier !== 'POCZTA_POLSKA') return { kind: 'TRWALY', reference, message: 'moduł Poczta Polska nadaje tylko przesyłki przewoźnika „Poczta Polska”' }
    const urzad = this.urzad
    if (!urzad) return { kind: 'TRWALY', reference, message: 'brak urzędu nadania w ustawieniach konta eNadawcy (Konta przewoźników)', errorClass: 'KONFIGURACJA' }
    const a = adresatPP(req.recipient)
    if (!a.adres) return { kind: 'TRWALY', reference, message: a.braki.includes('kraj') ? 'adresat spoza Polski: moduł Poczty Polskiej nadaje tylko krajowo (kraj)' : `niepełne dane adresata: ${a.braki.join(', ')}` }
    let surowy: unknown = null
    try {
      surowy = typeof this.ctx.config['nadawca'] === 'string' ? (JSON.parse(this.ctx.config['nadawca']) as unknown) : null
    } catch {
      return { kind: 'TRWALY', reference, message: 'nieczytelne dane nadawcy w konfiguracji' }
    }
    const z = parseNadawca({ nadawca: surowy as never })
    if (!z.nadawca) return { kind: 'TRWALY', reference, message: `brak danych nadawcy firmy: ${z.braki.join(', ')}` }
    const n = nadawcaPP(z.nadawca)
    if (!n.adres) return { kind: 'TRWALY', reference, message: `dane nadawcy firmy nie pasują do eNadawcy: ${n.braki.join(', ')} (Ustawienia → Dokumenty i faktury → Dane firmy)` }
    const dzien = dzienPl(this.teraz())
    let zl: Zlecenie
    try {
      zl = zleceniePP(req.parcel, a.adres, n.adres, { reference, dataNadania: dzien, potwierdzoneOstrzezenia: req.potwierdzoneOstrzezenia ?? [] })
    } catch (e) {
      return { kind: 'TRWALY', reference, message: e instanceof Error ? e.message : 'zła treść przesyłki' }
    }
    // Pierwsza próba z nową referencją: przesyłki o tym GUID nigdzie nie ma, więc od razu `addShipment`; kontrolę
    // robi tylko błąd zapisu (DUPLIKAT, nieznany błąd). Ponowienie tej samej referencji (host: `ponowienie`, także po
    // TRWALY) najpierw sprawdza sam, czy przesyłka już jest, bez polegania na tym, jak eNadawca opisze powtórzony
    // GUID. Na tej kontroli opiera się „brak po nieznanym błędzie = TRWALY” w `poNiepewnymZapisie`. Błąd odczytu = nic nie
    // wysłano, wolno ponowić.
    if (req.ponowienie === true) {
      let jest: TrafieniePP | null
      try {
        jest = await this.szukajGuid(zl.guid)
      } catch (e) {
        return { kind: e instanceof AdapterError && e.kind === 'PRZEJSCIOWY' ? 'PRZEJSCIOWY' : 'TRWALY', reference, message: `${e instanceof Error ? e.message : 'błąd odczytu eNadawcy'}; nic nie wysłano do eNadawcy` }
      }
      if (jest) return this.potwierdz(jest, zl, reference, dzien, urzad, 0)
    }
    return this.dodaj(zl, reference, dzien, urzad, 0)
  }

  /** `addShipment` do bufora dnia. `proba` > 0 = ponowne dodanie po usunięciu starej wersji: bez kolejnej poprawki. */
  private async dodaj(zl: Zlecenie, reference: string, dzien: string, urzad: string, proba: number): Promise<WriteOutcome> {
    const p = await this.partiaDnia(dzien, urzad)
    if ('kind' in p) return { ...p, reference } as WriteOutcome
    const r = await this.zapis().wywolaj('addShipment', { przesylki: zl.przesylka, idBufor: p.idBufor })
    if (!r.ok) {
      // po niepewnym wyniku bufor z pamięci nie jest pewny; ponowienie czyta listę buforów od nowa
      if (r.kind === 'NIEJEDNOZNACZNY') this.partia = null
      return { kind: r.kind, reference, message: r.kind === 'NIEJEDNOZNACZNY' ? `${r.message}; ${BEZ_PONAWIANIA}` : r.message }
    }
    const wynik = bloki(r.xml, 'retval').find((x) => (wartosc(x, 'guid') ?? '').toUpperCase() === zl.guid) ?? bloki(r.xml, 'retval')[0] ?? ''
    const b = klasyfikujBledy(bledy(wynik))
    if (b?.klasa === 'BUFOR') {
      this.partia = null
      return { kind: 'PRZEJSCIOWY', reference, message: `${b.message}; przesyłka nie powstała, Kompletor założy nowy bufor przy ponowieniu` }
    }
    if (b && (b.klasa === 'DUPLIKAT' || !b.znany)) {
      if (!b.znany) this.partia = null
      return this.poNiepewnymZapisie(zl, reference, dzien, urzad, proba, b.klasa === 'DUPLIKAT' ? null : b.message, p.idBufor)
    }
    if (b) return { kind: b.klasa as Exclude<typeof b.klasa, 'DUPLIKAT' | 'BUFOR'>, reference, message: b.message, ...(b.errorClass ? { errorClass: b.errorClass } : {}) }
    const numer = wartosc(wynik, 'numerNadania')
    if (!numer) return { kind: 'NIEJEDNOZNACZNY', reference, message: `eNadawca: odpowiedź bez numeru nadania; ${BEZ_PONAWIANIA}` }
    this.numery.set(zl.guid, numer)
    return { kind: 'OK', reference, externalRef: zl.guid }
  }

  /**
   * eNadawca zgłosił powtórzony GUID albo błąd spoza wzorców. Sprawdzamy w eNadawcy: trafienie = potwierdzenie
   * (bez drugiego dodania), błąd odczytu = NIEJEDNOZNACZNY, brak przy nieznanym błędzie = TRWALY (`powod`), brak przy
   * „duplikacie” = NIEJEDNOZNACZNY (eNadawca coś ma, my tego nie widzimy). Nierozpoznana odpowiedź odczytu po GUID też
   * = NIEJEDNOZNACZNY. Sprawdzamy tylko bufor, do którego dodawaliśmy, i odczyt po GUID (krótszy najgorszy czas);
   * przesyłkę z innego bufora znajdzie odszukanie hosta po NIEJEDNOZNACZNY (pięć ostatnich buforów).
   */
  private async poNiepewnymZapisie(zl: Zlecenie, reference: string, dzien: string, urzad: string, proba: number, powod: string | null, idBufor: string): Promise<WriteOutcome> {
    let t: TrafieniePP | null
    try {
      t = await this.szukajGuid(zl.guid, { bufor: idBufor })
    } catch {
      return { kind: 'NIEJEDNOZNACZNY', reference, message: `${powod ?? 'eNadawca zgłasza przesyłkę o tym identyfikatorze'}; Kompletor nie mógł sprawdzić, czy przesyłka powstała; ${BEZ_PONAWIANIA}` }
    }
    if (t) return this.potwierdz(t, zl, reference, dzien, urzad, proba)
    if (powod === null) return { kind: 'NIEJEDNOZNACZNY', reference, message: `eNadawca zgłasza przesyłkę o tym identyfikatorze, ale Kompletor jej nie odnalazł; ${BEZ_PONAWIANIA}` }
    return { kind: 'TRWALY', reference, message: powod }
  }

  /** Usunięcie tej jednej przesyłki z niewysłanego bufora (`clearEnvelopeByGuids`, powtarzalne). null = usunięta. */
  private async usunZBufora(guid: string, idBufor: string): Promise<{ kind: 'TRWALY' | 'PRZEJSCIOWY'; message: string } | null> {
    const c = await this.zapis().wywolaj('clearEnvelopeByGuids', { guid: [guid], idBufor })
    if (!c.ok) return { kind: c.kind === 'TRWALY' ? 'TRWALY' : 'PRZEJSCIOWY', message: c.message }
    const cb = klasyfikujBledy(bledy(c.xml))
    if (cb) return { kind: cb.klasa === 'PRZEJSCIOWY' || cb.klasa === 'NIEJEDNOZNACZNY' ? 'PRZEJSCIOWY' : 'TRWALY', message: cb.message }
    this.numery.delete(guid)
    return null
  }

  /**
   * Przesyłka o tym GUID już jest w eNadawcy: dane zgodne = OK bez drugiego dodania; różne albo nieczytelne
   * w niewysłanym buforze = usunięcie tej jednej przesyłki i jedno dodanie z bieżącymi danymi; różne w wysłanej partii =
   * TRWALY, same nieczytelne w wysłanej partii = NIEJEDNOZNACZNY (sprawdzenie w eNadawcy). Różnica także po ponownym
   * dodaniu = drugie usunięcie: udane = TRWALY „nic nie zostało, utwórz ponownie”, nieudane = NIEJEDNOZNACZNY.
   */
  private async potwierdz(t: TrafieniePP, zl: Zlecenie, reference: string, dzien: string, urzad: string, proba: number): Promise<WriteOutcome> {
    const { rozne, nieczytelne } = roznicePrzesylki(t.blok, zl.przesylka)
    if (!rozne.length && !nieczytelne.length) {
      if (t.numer) this.numery.set(zl.guid, t.numer)
      return { kind: 'OK', reference, externalRef: zl.guid, info: 'Przesyłka była już w eNadawcy po wcześniejszej próbie: nie utworzono drugiej.' }
    }
    const opis = [...rozne, ...nieczytelne.map((p) => `${p} (nieczytelne w eNadawcy)`)].join(', ')
    if (!t.idBufor) {
      if (rozne.length) return { kind: 'TRWALY', reference, message: `przesyłka jest już w wysłanej partii ze starymi danymi (różni się: ${rozne.join(', ')}): popraw ją w eNadawcy albo w placówce Poczty; Kompletor nie tworzy drugiej` }
      return { kind: 'NIEJEDNOZNACZNY', reference, message: `przesyłka jest już w wysłanej partii, ale Kompletor nie odczytał z eNadawcy wszystkich danych (${nieczytelne.join(', ')}): sprawdź w eNadawcy adres, masę i format przesyłki i rozstrzygnij ręcznie; Kompletor nie tworzy drugiej` }
    }
    if (proba > 0) {
      const u = await this.usunZBufora(zl.guid, t.idBufor)
      if (u) return { kind: 'NIEJEDNOZNACZNY', reference, message: `przesyłka w eNadawcy ma inne dane niż zamówienie (${opis}) także po ponownym dodaniu, a jej usunięcie nie powiodło się (${u.message}): usuń ją w eNadawcy, zanim klikniesz „Sprawdź u przewoźnika”; ${BEZ_PONAWIANIA}` }
      return { kind: 'TRWALY', reference, message: `przesyłka w eNadawcy miała inne dane niż zamówienie (${opis}) także po ponownym dodaniu: Kompletor ją usunął, w eNadawcy nic nie zostało; utwórz przesyłkę ponownie` }
    }
    // usunięcie po GUID jest powtarzalne; ponowienie najpierw sprawdzi, czy stara wersja dalej jest w buforze
    const u = await this.usunZBufora(zl.guid, t.idBufor)
    if (u) return { kind: u.kind, reference, message: `dane zamówienia zmieniły się albo są nieczytelne w eNadawcy (${opis}), a usunięcie starej wersji z partii nie powiodło się: ${u.message}` }
    const o = await this.dodaj(zl, reference, dzien, urzad, proba + 1)
    if (o.kind === 'OK') return { ...o, info: `Dane przesyłki w eNadawcy nie zgadzały się z zamówieniem (${opis}): Kompletor usunął starą przesyłkę z partii i dodał nową. Wydrukuj nową etykietę.` }
    return { ...o, message: `stara wersja przesyłki usunięta z partii (${opis}), nowa nie dodana: ${o.message}` } as WriteOutcome
  }

  /** Etykieta adresowa w PDF (`getPrintForParcel`, po GUID). eNadawca w tym module wydaje tylko PDF. */
  async getLabel(externalRef: string, format: LabelFormat): Promise<{ contentType: string; base64: string }> {
    if (!this.wlaczony) throw new AdapterError(WYLACZONY, 'TRWALY')
    if (!GUID_PP_RE.test(externalRef)) throw new AdapterError('zły identyfikator przesyłki eNadawcy', 'TRWALY')
    if (format !== 'PDF') throw new AdapterError('Poczta Polska: etykieta tylko w PDF (ustaw format etykiety PDF)', 'TRWALY')
    const r = await this.zapis().wywolaj('getPrintForParcel', { guid: externalRef, type: { kind: 'ADDRESS_LABEL', method: 'ALL_PARCELS_IN_ONE_FILE', format: 'PDF_FORMAT' } })
    // Wydruk niczego nie tworzy: niepewny wynik wolno pobrać ponownie.
    if (!r.ok) throw new AdapterError(r.message, r.kind === 'TRWALY' ? 'TRWALY' : 'PRZEJSCIOWY')
    const b = klasyfikujBledy(bledy(r.xml))
    if (b) throw new AdapterError(b.message, b.klasa === 'PRZEJSCIOWY' ? 'PRZEJSCIOWY' : 'TRWALY')
    const dane = wartosc(r.xml, 'print')
    // rozmiar ogranicza już limit odpowiedzi klienta SOAP (10 MB, czyli etykieta do ok. 7,5 MB)
    if (!dane || !/^[A-Za-z0-9+/=\s]+$/.test(dane)) throw new AdapterError('eNadawca: odpowiedź bez etykiety albo etykieta nieczytelna', 'TRWALY')
    const base64 = dane.replace(/\s/g, '')
    // base64 pliku PDF zaczyna się od „JVBER” (%PDF)
    if (!base64.startsWith('JVBER')) throw new AdapterError('eNadawca: etykieta nie jest plikiem PDF', 'TRWALY')
    return { contentType: 'application/pdf', base64 }
  }

  /**
   * Anulowanie przed wysłaniem partii: usunięcie z bufora TYLKO tej przesyłki (`clearEnvelopeByGuids` z jej GUID).
   * Szuka we wszystkich buforach Kompletora firmy. Partia wysłana = TRWALY z instrukcją. OK „już usunięta” tylko, gdy
   * eNadawca jednoznacznie odpowiada „nie znaleziono”; błąd odczytu albo nierozpoznana odpowiedź to nie dowód braku.
   */
  async cancelShipment(externalRef: string, reference: string): Promise<WriteOutcome> {
    if (!this.wlaczony) return { kind: 'TRWALY', reference, message: WYLACZONY }
    if (!GUID_PP_RE.test(externalRef)) return { kind: 'TRWALY', reference, message: 'zły identyfikator przesyłki eNadawcy' }
    let gdzie: TrafieniePP | null
    try {
      gdzie = await this.szukajGuid(externalRef, { wszystkie: true })
    } catch (e) {
      const powod = e instanceof Error ? e.message : 'błąd odczytu eNadawcy'
      return { kind: e instanceof AdapterError && e.kind === 'PRZEJSCIOWY' ? 'PRZEJSCIOWY' : 'TRWALY', reference, message: `${powod}; Kompletor nie wie, czy przesyłka jest w eNadawcy: sprawdź i usuń przesyłkę w eNadawcy, jeśli tam jest` }
    }
    if (!gdzie) return { kind: 'OK', reference, externalRef, info: 'eNadawca odpowiada, że nie ma tej przesyłki (już usunięta).' }
    if (!gdzie.idBufor) return { kind: 'TRWALY', reference, message: 'partia z tą przesyłką jest już wysłana do urzędu nadania: anulowanie tylko w eNadawcy albo w placówce' }
    const r = await this.zapis().wywolaj('clearEnvelopeByGuids', { guid: [externalRef], idBufor: gdzie.idBufor })
    // usunięcie po GUID jest powtarzalne: niepewny wynik = ponowienie
    if (!r.ok) return { kind: r.kind === 'TRWALY' ? 'TRWALY' : 'PRZEJSCIOWY', reference, message: r.message }
    const b = klasyfikujBledy(bledy(r.xml))
    if (b) return { kind: b.klasa === 'PRZEJSCIOWY' || b.klasa === 'NIEJEDNOZNACZNY' ? 'PRZEJSCIOWY' : 'TRWALY', reference, message: b.message }
    this.numery.delete(externalRef)
    return { kind: 'OK', reference, externalRef }
  }

  /** Odszukanie po referencji: GUID z referencji w buforach Kompletora i w danych przesyłek. Tylko potwierdza. */
  async findByReference(reference: string): Promise<ReferenceLookup> {
    if (!this.wlaczony) throw new AdapterError(WYLACZONY, 'TRWALY')
    let guid: string
    try {
      guid = guidZReferencji(reference)
    } catch {
      throw new AdapterError('zła referencja przesyłki eNadawcy', 'TRWALY')
    }
    const t = await this.szukajGuid(guid)
    if (t) {
      // bez danych zamówienia nie porównamy adresu; przesyłki z nieczytelnymi danymi nie potwierdzamy
      const nc = nieczytelnePola(t.blok)
      if (nc.length) throw new AdapterError(`eNadawca ma przesyłkę o identyfikatorze ${guid}, ale Kompletor nie odczytał jej danych (${nc.join(', ')}): sprawdź w eNadawcy adres, masę i format i rozstrzygnij ręcznie`, 'TRWALY')
      if (t.numer) this.numery.set(guid, t.numer)
      return { found: true, externalRef: guid }
    }
    throw new AdapterError(`eNadawca nie pokazuje przesyłki o identyfikatorze ${guid} w buforach Kompletora z ostatnich dni ani w wysłanych: to nie jest dowód, że nie powstała; sprawdź w eNadawcy po numerze klienta ${reference.replace(/[^0-9a-zA-Z]/g, '').slice(0, 20)}`, 'TRWALY')
  }

  /**
   * Numer wpisany przy „Rozstrzygnij ręcznie”: numer nadania albo GUID. Kompletor szuka przesyłki o GUID z referencji tej
   * przesyłki i porównuje numer; inny numer = odmowa bez zapisu. Błąd odczytu = wyjątek (host: „spróbuj ponownie”).
   */
  async confirmManual(identyfikator: string, reference: string): Promise<PotwierdzenieRecznego> {
    if (!this.wlaczony) return { odmowa: 'Nadawanie Poczty Polskiej jest wyłączone w ustawieniach przewoźnika: Kompletor nie może sprawdzić numeru w eNadawcy.' }
    const numer = identyfikator.trim().toUpperCase()
    let guid: string
    try {
      guid = guidZReferencji(reference)
    } catch {
      return { odmowa: 'Zła referencja przesyłki: nic nie zapisano.' }
    }
    const t = await this.szukajGuid(guid, { wszystkie: true })
    if (!t) return { odmowa: `eNadawca nie ma przesyłki utworzonej przez Kompletor dla tego zamówienia (identyfikator ${guid}): numer ${numer} to inna przesyłka albo dodana ręcznie. Nic nie zapisano.` }
    if (numer !== guid && (t.numer ?? '').toUpperCase() !== numer) return { odmowa: `Przesyłka Kompletora dla tego zamówienia ma w eNadawcy numer ${t.numer ?? 'jeszcze nienadany'}, nie ${numer}. Nic nie zapisano.` }
    if (t.numer) this.numery.set(guid, t.numer)
    return { externalRef: guid, info: 'Sprawdzone w eNadawcy: przesyłka ma identyfikator wyliczony z referencji tej przesyłki.', referencjaSprawdzona: true }
  }

  /**
   * „Wyślij partię”: WSZYSTKIE bufory Kompletora tej firmy z danego dnia i urzędu nadania do urzędu (`sendEnvelope`), a
   * dopiero po udanym wysłaniu opcjonalnie zamówienie kuriera (`zamowKuriera`, jedno na dzień). Rusza tylko bufory
   * Kompletora; bufory i przesyłki dodane w eNadawcy ręcznie zostają. Wysłanej partii nie da się cofnąć z Kompletora.
   * Sieć po wysłaniu = NIEJEDNOZNACZNY (sprawdź w eNadawcy). Niepewny wynik zamówienia kuriera = NIEPEWNY, nigdy
   * „niezamówiony”; ponowienie po wysłaniu nie ma już czego wysłać, więc nie zamawia kuriera drugi raz.
   * Zaległe bufory z wcześniejszych dni (np. przesyłka dodana tuż przed północą) zgłasza w `zalegle` i `uwaga`.
   */
  async wyslijPartie(dzien: string = dzienPl(this.teraz())): Promise<WynikPartii> {
    if (!this.wlaczony) throw new AdapterError(WYLACZONY, 'TRWALY')
    const urzad = this.urzad
    if (!urzad) throw new AdapterError('brak urzędu nadania w ustawieniach konta eNadawcy', 'TRWALY', undefined, 'KONFIGURACJA')
    const wszystkieMoje = await this.buforyKompletora()
    const mojeUrzedu = wszystkieMoje.filter((x) => !x.urzad || x.urzad === urzad)
    const zDnia = mojeUrzedu.filter((x) => x.dzien === dzien)
    // bufory firmy na inny urząd nadania (zmiana ustawienia w ciągu dnia) nie wychodzą, ale są zgłaszane
    const innyUrzad = [...new Set(wszystkieMoje.filter((x) => x.urzad && x.urzad !== urzad).map((x) => `${x.dzien} (urząd ${x.urzad})`))].sort()
    const zalegle = [...[...new Set(mojeUrzedu.filter((x) => x.dzien < dzien).map((x) => x.dzien))].sort(), ...innyUrzad]
    const uwagi: string[] = []
    const zamawiac = this.ctx.config['zamowKuriera'] === true
    const partie: WyslanaPartia[] = []
    // po błędzie w połowie ponowne „Wyślij partię” wyśle resztę i samo zamówi kuriera; ręcznie tylko, gdy nie wiadomo, czy partia wyszła
    const juzWyslane = (niepewne = false) =>
      (partie.length ? ` Wysłane wcześniej w tym przebiegu: ${partie.map((x) => `bufor ${x.idBufor}`).join(', ')}.` : '') +
      (!zamawiac
        ? ''
        : niepewne
          ? ' Kurier nie był zamawiany: jeśli w eNadawcy partia jest wysłana, zamów odbiór w eNadawcy; jeśli nie jest, ponów „Wyślij partię” (zamówi kuriera sam).'
          : ' Kurier nie był zamawiany: ponów „Wyślij partię”, kuriera nie zamawiaj ręcznie, zamówi się po wysłaniu reszty.')
    for (const b of zDnia) {
      let zawartosc: string
      try {
        zawartosc = await this.odczyt.wywolaj('getEnvelopeBufor', { idBufor: b.idBufor })
      } catch (e) {
        throw new AdapterError(`eNadawca: bufor ${dzien} (${b.idBufor}) niedostępny (${e instanceof Error ? e.message : 'błąd'}).${juzWyslane()}`, rodzaj(e))
      }
      const n = bloki(zawartosc, 'przesylka').length
      if (!n) continue
      const r = await this.zapis().wywolaj('sendEnvelope', { urzadNadania: urzad, idBufor: b.idBufor })
      if (!r.ok) throw new AdapterError(`${r.kind === 'NIEJEDNOZNACZNY' ? `${r.message}; sprawdź w eNadawcy, czy partia ${dzien} (bufor ${b.idBufor}) jest wysłana, zanim wyślesz ją drugi raz` : r.message}.${juzWyslane(r.kind === 'NIEJEDNOZNACZNY')}`, r.kind)
      const e = klasyfikujBledy(bledy(r.xml))
      if (e) throw new AdapterError(`eNadawca nie wysłał partii ${dzien} (bufor ${b.idBufor}): ${e.message}.${juzWyslane()}`, e.klasa === 'PRZEJSCIOWY' ? 'PRZEJSCIOWY' : 'TRWALY')
      if (this.partia?.idBufor === b.idBufor) this.partia = null
      partie.push({ idBufor: b.idBufor, przesylek: n, idEnvelope: wartosc(r.xml, 'idEnvelope'), status: wartosc(r.xml, 'envelopeStatus') })
    }
    const zDni = zalegle.filter((x) => !innyUrzad.includes(x))
    if (zDni.length) uwagi.push(`Niewysłane partie Kompletora z wcześniejszych dni: ${zDni.join(', ')}. Wyślij je osobno (Wyślij partię z ich datą), inaczej te paczki nie trafią do urzędu nadania.`)
    if (innyUrzad.length) uwagi.push(`Niewysłane partie Kompletora na inny urząd nadania niż w ustawieniach (${urzad}): ${innyUrzad.join(', ')}. Kompletor ich nie wysyła: wyślij je w eNadawcy albo przywróć tamten urząd w ustawieniach konta i wyślij partię.`)
    const przesylek = partie.reduce((s, x) => s + x.przesylek, 0)
    if (!partie.length) {
      uwagi.unshift(zDnia.length ? 'Partia jest pusta: nic nie wysłano.' : 'Brak partii Kompletora z tego dnia: nic nie wysłano.')
      return { dzien, przesylek: 0, partie, idEnvelope: null, status: null, kurier: 'NIE_ZAMAWIANO', uwaga: uwagi.join(' '), zalegle }
    }
    if (zDnia.length > 1) uwagi.unshift(`Tego dnia Kompletor miał ${zDnia.length} bufory: wysłano wszystkie z przesyłkami (${partie.length}).`)
    let kurier: WynikPartii['kurier'] = 'NIE_ZAMAWIANO'
    if (zamawiac) {
      const godzina = typeof this.ctx.config['godzinaOdbioru'] === 'string' ? this.ctx.config['godzinaOdbioru'] : null
      const k = await this.zapis().wywolaj('zamowKuriera', { idBufor: partie[partie.length - 1]!.idBufor, oczekiwanaDataOdbioru: dzien, oczekiwanaGodzinaOdbioru: godzina, szacowanaIloscPrzeslek: przesylek }, 5 * 60_000)
      const kb = k.ok ? klasyfikujBledy(bledy(k.xml)) : null
      if (k.ok && !kb) kurier = 'ZAMOWIONY'
      else if ((k.ok && kb!.znany && kb!.klasa === 'TRWALY') || (!k.ok && (k.kind === 'TRWALY' || k.kind === 'PRZEJSCIOWY'))) {
        // odrzucone przed wykonaniem (login, umowa, 429): odbioru na pewno nie ma
        kurier = 'BLAD'
        uwagi.push(`Kurier niezamówiony (${k.ok ? kb!.message : k.message}): zamów odbiór w eNadawcy albo zawieź paczki do urzędu.`)
      } else {
        kurier = 'NIEPEWNY'
        uwagi.push(`Nie wiadomo, czy kurier jest zamówiony (${k.ok ? kb!.message : k.message}): sprawdź w eNadawcy i nie zamawiaj drugi raz, zanim tego nie sprawdzisz.`)
      }
    }
    return { dzien, przesylek, partie, idEnvelope: partie[0]!.idEnvelope, status: partie[0]!.status, kurier, uwaga: uwagi.length ? uwagi.join(' ') : null, zalegle }
  }
}

export type PocztaPolskaZapis = PocztaPolskaZapisAdapter

export const PP_DEFINITION: AdapterDefinition = { manifest: PP_MANIFEST, create: (ctx) => new PocztaPolskaAdapter(ctx) }
export const PP_ZAPIS_DEFINITION: AdapterDefinition = { manifest: PP_ZAPIS_MANIFEST, create: (ctx) => new PocztaPolskaZapisAdapter(ctx) }
