// Adaptery przewoźnika GLS Polska przez ADE, SOAP ade_webapi2:
//   `gls.ade.v1` — domyślny, tylko do odczytu: liczy przesyłkę (lib/wysylka/gls.ts), test połączenia samym
//     `adeLogin` + `adeLogout`. Klient odczytu odmawia każdej metody, która tworzy albo zmienia.
//   `gls.ade.zapis.v1` — nadanie w jednej sesji ADE: wstawienie do przygotowalni (`adePreparingBox_Insert`) → potwierdzenie
//     nadania (`adePickup_Create`) → identyfikator przesyłki w potwierdzeniu (`adePickup_GetConsignBinds`) → numery paczek
//     (`adePickup_GetConsign`); sesja zamykana zawsze (`adeLogout` w `finally`). Etykieta jedno- i wielopaczkowa,
//     odszukanie po referencji, sprawdzenie identyfikatora przy „Rozstrzygnij ręcznie”. Bez `zapisWlaczony: true` żadne
//     żądanie nie wychodzi (test pilnuje).
//
// Oparte na wiedzy z Open Integration Platform, integrators/courier/gls/v1.0.0/src/integration.py (commit ae43d1e,
// Copyright 2024-2026 Pinquark.com, Apache License 2.0), przepisane i zmienione: własny kod TypeScript w kontrakcie
// Kompletora, klasy błędów, idempotencja i odszukanie po referencji po naszemu (u nich ich nie ma). Atrybucja:
// THIRD_PARTY_NOTICES.md.
//
// Idempotencja: odcisk referencji hosta w polu `references` przesyłki. Przed wstawieniem adapter szuka odcisku najpierw
// w ostatnich potwierdzeniach nadania (znaleziona = OK z jej identyfikatorem, bez nowego wstawienia),
// potem w przygotowalni: przygotowanie z odciskiem dokańcza (`adePickup_Create` na tym samym identyfikatorze) zamiast
// wstawiać drugie, ale tylko gdy kod pocztowy, pobranie, waga i data zgadzają się z bieżącym zleceniem.
// `findByReference`: przesyłka z odciskiem w ostatnich potwierdzeniach nadania = znaleziona; samo przygotowanie bez
// nadania = błąd dla człowieka (potwierdzenie mogło być w toku po stronie ADE); brak w obu miejscach = błąd, nie
// `found: false`. Listy ADE czytane stronami do pustej strony, przekroczenie limitu stron albo czasu = błąd.
// Anulowania nie ma: ADE nie usuwa przesyłki po potwierdzeniu nadania [NIEPEWNE], a przesyłka utworzona przez Kompletor
// jest zawsze potwierdzona (oba kroki w jednej sesji). Przygotowanie bez nadania usuwa się w panelu ADE.
import { parseNadawca } from '../wysylka/zlecenie-dpd'
import { odbiorcaGls, odciskGls, ustawieniaGls, wyliczPrzesylkeGls, zlecenieGls, type UstawieniaGls, type ZlecenieGls } from '../wysylka/gls'
import { SourceError } from '../zrodla/http'
import { GLS_PROD, GLS_TEST, GLS_URL_RE, GlsFault, GlsOdczyt, GlsZapis, wartosci, wynik, type GlsLogowanie } from '../zrodla/gls'
import { klasaKoduGls } from './gls-kody'
import {
  AdapterError,
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
  type WriteOutcome,
} from './kontrakt'

export const GLS_KEY = 'gls.ade.v1'
export const GLS_ZAPIS_KEY = 'gls.ade.zapis.v1'

/** Identyfikator przesyłki w ADE (liczba). */
export const ID_GLS_RE = /^\d{1,20}$/

const CONFIG: readonly ConfigField[] = [
  {
    key: 'srodowisko',
    type: 'string',
    required: false,
    description: 'środowisko ADE: test (domyślnie, osobne dane dostępu od GLS) albo produkcja',
    zKontaPrzewoznika: true,
    options: [
      { value: 'test', label: 'Testowe (ADE test)' },
      { value: 'produkcja', label: 'Produkcyjne (prawdziwe paczki)' },
    ],
  },
  { key: 'baseUrl', type: 'string', required: false, description: 'self-host: adres usługi zamiast środowiska (tylko adres produkcyjny albo testowy ADE)', pattern: GLS_URL_RE, envSuffix: 'BASE_URL' },
  { key: 'envPrefix', type: 'string', required: false, description: 'self-host: przedrostek zmiennych env (np. GLS)', pattern: /^[A-Z][A-Z0-9_]{0,40}$/ },
  { key: 'defaultWeightKg', type: 'number', required: false, description: 'waga paczki w kg, gdy produkty nie mają wagi (limit paczki GLS 31,5 kg)' },
  { key: 'codLimit', type: 'number', required: false, description: 'najwyższa kwota pobrania w zł wg umowy z GLS (domyślnie 10 000)' },
]

const SECRETS: AdapterManifest['secrets'] = [
  { name: 'GLS_ADE_LOGIN', required: true, description: 'login użytkownika ADE z dostępem do API (od GLS)', envSuffix: 'ADE_LOGIN' },
  { name: 'GLS_ADE_HASLO', required: true, description: 'hasło użytkownika ADE', envSuffix: 'ADE_HASLO' },
]

// ADE: najwyżej 10 sesji naraz na firmę (konektor OIP); jedno żądanie naraz.
const RATE = { requestsPerMinute: 60, maxConcurrent: 1, minPollIntervalMs: 0 }

export const GLS_MANIFEST: AdapterManifest = {
  adapterKey: GLS_KEY,
  version: '1.0.0',
  displayName: 'GLS (bezpośrednio, ADE)',
  kind: 'carrier',
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
/** Ile najnowszych przygotowań przegląda odszukanie. */
export const ODSZUKANIE_LIMIT = 20
/** Ile najnowszych potwierdzeń nadania przegląda odszukanie (Kompletor robi jedno potwierdzenie na przesyłkę). */
export const ODSZUKANIE_POTWIERDZEN = 20
/** Najwięcej przesyłek czytanych z tych potwierdzeń; więcej (zbiorcze potwierdzenia z panelu) = błąd, nie „brak”. */
export const ODSZUKANIE_PRZESYLEK = 100
/**
 * Okno przeglądu nadanych przy ponowieniu. Ponowienie = ten sam wiersz po BLAD (także po
 * „Sprawdź u przewoźnika” bez trafienia), bywa godziny po pierwszej próbie; ręczne „Nie powstała” daje nową
 * referencję i tu nie trafia. Dlatego 20 potwierdzeń (przy ok. 300 paczkach dziennie ok. 30–40 min pracy) to za
 * mało. 100 potwierdzeń = ok. 2,5–3 h pracy przy tym tempie; przegląd kosztuje ok. 100 × (Binds + GetConsign), czyli
 * ok. 200 żądań, ale tylko przy ponowieniu (rzadkie), nie przy każdym nadaniu. Starsza nadana przesyłka dalej
 * umyka (opis w docs/integracje/gls.md). Limit przesyłek 300 = zapas na kilka zbiorczych potwierdzeń z panelu ADE.
 */
export const ODSZUKANIE_PONOWIENIE = { potwierdzen: 100, przesylek: 300 } as const
/** Najwięcej stron jednej listy ADE (po ok. 100 identyfikatorów); więcej = błąd, nie „brak”. */
export const ODSZUKANIE_STRON = 200
/** Budżet czasu jednego przeglądu (przygotowalnia + potwierdzenia); po nim błąd, nie „brak”. */
export const ODSZUKANIE_BUDZET_MS = 5 * 60_000
const jedenOdczyt = ODCZYT_PROBY * ODCZYT_TIMEOUT_MS + ODCZYT_PRZERWA_MS * (2 ** (ODCZYT_PROBY - 1) - 1)
/**
 * Najgorszy czas „Utwórz przesyłkę” (ponowienie: przegląd nadanych i przygotowalni przed wstawieniem, potem odszukanie
 * po błędzie; każde w budżecie 5 min plus jeden odczyt 91,5 s rozpoczęty tuż przed jego końcem), dwa zapisy po 60 s,
 * logowanie i wylogowanie obu sesji oraz odczyt numerów (6 odczytów po 91,5 s): 120 + 2 × 391,5 + 549 = 1452 s,
 * czyli ok. 24 min. Pierwsza próba nie przegląda nadanych, ale budżet przeglądu dzieli
 * z przygotowalnią, więc górna granica jest ta sama.
 */
export const NAJDLUZSZE_UTWORZENIE_MS = 2 * ZAPIS_TIMEOUT_MS + 2 * (ODSZUKANIE_BUDZET_MS + jedenOdczyt) + 6 * jedenOdczyt

export const GLS_ZAPIS_MANIFEST: AdapterManifest = {
  adapterKey: GLS_ZAPIS_KEY,
  version: '1.0.0',
  displayName: 'GLS (bezpośrednio, ADE, nadawanie za wyłącznikiem)',
  kind: 'carrier',
  capabilities: ['shipment.prepare', 'shipment.create', 'reference.find'],
  rateLimit: RATE,
  config: [
    ...CONFIG,
    { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'wyłącznik: true = adapter może nadawać przesyłki GLS i pobierać etykiety; brak = nic nie wysyła' },
    { key: 'nadawca', type: 'string', required: false, description: 'JSON z danymi nadawcy firmy (wstawia host przy tworzeniu adaptera)' },
  ],
  secrets: SECRETS,
  readOnly: false,
  shipmentMaxCreateMs: NAJDLUZSZE_UTWORZENIE_MS,
}

/** Adres usługi: jawny `baseUrl` (self-host) albo środowisko; brak = testowe. */
export function adresGls(config: Readonly<Record<string, unknown>>): string {
  if (typeof config['baseUrl'] === 'string' && config['baseUrl']) return config['baseUrl']
  return config['srodowisko'] === 'produkcja' ? GLS_PROD : GLS_TEST
}

function logowanie(ctx: AdapterContext): GlsLogowanie {
  return { login: ctx.secrets['GLS_ADE_LOGIN']!, haslo: ctx.secrets['GLS_ADE_HASLO']! }
}

/** Wyjątek odczytu → AdapterError: Fault ADE wg tabeli kodów, sieć/5xx = PRZEJSCIOWY, reszta TRWALY. */
function bladOdczytu(e: unknown, co: string): AdapterError {
  if (e instanceof AdapterError) return e
  if (e instanceof GlsFault) {
    const k = klasaKoduGls(e.kod)
    return new AdapterError(`GLS: ${co}: ${k.opis}`, k.klasa)
  }
  return new AdapterError(`GLS: ${co}: ${e instanceof Error ? e.message : 'błąd'}`, e instanceof SourceError && e.retryable ? 'PRZEJSCIOWY' : 'TRWALY')
}

class GlsAdapter implements ChannelAdapter, ShipmentPreparer {
  readonly manifest: AdapterManifest = GLS_MANIFEST
  protected readonly odczyt: GlsOdczyt
  protected readonly ustawienia: UstawieniaGls

  constructor(protected readonly ctx: AdapterContext) {
    const r = ctx.http?.retry
    const retry = { attempts: Math.max(1, Math.min(r?.attempts ?? ODCZYT_PROBY, ODCZYT_PROBY)), baseDelayMs: Math.max(0, Math.min(r?.baseDelayMs ?? ODCZYT_PRZERWA_MS, ODCZYT_PRZERWA_MS)) }
    this.odczyt = new GlsOdczyt({ url: adresGls(ctx.config), auth: logowanie(ctx), fetchImpl: ctx.fetch, timeoutMs: ODCZYT_TIMEOUT_MS, retry })
    this.ustawienia = ustawieniaGls(ctx.config)
  }

  /** Sam `adeLogin` i `adeLogout`: zły login = TRWALY, sieć i sesja = PRZEJSCIOWY (`details.rodzaj`). */
  async testConnection(): Promise<ConnectionTest> {
    const srodowisko = adresGls(this.ctx.config) === GLS_PROD ? 'produkcja' : 'test'
    try {
      await this.odczyt.sesja(async () => undefined)
      return { ok: true, message: `konto ADE GLS odpowiada (środowisko ${srodowisko === 'test' ? 'testowe' : 'produkcyjne'})`, details: { srodowisko } }
    } catch (e) {
      const b = bladOdczytu(e, 'logowanie do ADE')
      return { ok: false, message: b.message, details: { rodzaj: b.kind === 'PRZEJSCIOWY' ? 'PRZEJSCIOWY' : 'TRWALY', srodowisko } }
    }
  }

  prepareShipment(input: ShipmentInput): PreparedParcel {
    return wyliczPrzesylkeGls(input, this.ustawienia)
  }
}

const WYLACZONY = 'zapis wyłączony'
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/
/** Tryb wydruku ADE: PDF z konektora OIP; ZPL [NIEPEWNE: nazwa trybu do potwierdzenia]. */
const TRYB_ETYKIETY: Partial<Record<LabelFormat, { mode: string; contentType: string }>> = {
  PDF: { mode: 'roll_160x100_vertical_pdf', contentType: 'application/pdf' },
  ZPL: { mode: 'roll_160x100_zebra', contentType: 'text/plain' },
}
const BEZ_PONAWIANIA = 'nie wiadomo, czy przesyłka GLS powstała: nie twórz jej drugi raz, kliknij „Sprawdź u przewoźnika”'

/** Przesyłka ADE (przygotowanie albo przesyłka w potwierdzeniu nadania): odcisk referencji, numery paczek i dane. */
interface PrzesylkaAde {
  id: string
  odcisk: string | null
  paczki: string[]
  /** Kod pocztowy odbiorcy (same znaki), ulica, kod punktu GLS, kwota pobrania, waga w kg, data; null = ADE nie podało. */
  kod: string | null
  ulica: string | null
  punkt: string | null
  pobranie: number | null
  waga: number | null
  data: string | null
}

/** Porządek malejący identyfikatorów ADE (do 20 cyfr) bez utraty dokładności `Number()`. */
export function malejacoIdGls(a: string, b: string): number {
  const x = BigInt(a)
  const y = BigInt(b)
  return x === y ? 0 : y > x ? 1 : -1
}

/** Identyfikatory z jednej strony listy ADE, w kolejności odpowiedzi, bez powtórzeń. */
function idZListy(xml: string): string[] {
  return [...new Set(wartosci(xml, 'items').concat(wartosci(xml, 'id')).filter((x) => ID_GLS_RE.test(x)))]
}

const liczbaAde = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null
  const n = Number(v.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** Tekst do porównania: bez różnicy wielkości liter i odstępów. */
const porownaj = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim().toUpperCase()

/**
 * Różnice przygotowania z poprzedniej próby względem bieżącego zlecenia; brak kodu, ulicy albo wagi w ADE =
 * różnica. Punkt GLS porównywany zawsze (zmiana punktu przy tym samym kodzie odbiorcy też blokuje dokończenie). Data
 * po pierwszych 10 znakach (ADE może oddać datę z godziną).
 */
export function roznicePrzygotowaniaGls(p: Pick<PrzesylkaAde, 'kod' | 'ulica' | 'punkt' | 'pobranie' | 'waga' | 'data'>, k: ZlecenieGls['kontrolne']): string[] {
  const rozne = (a: number | null, b: number) => a === null || Math.abs(a - b) > 0.005
  const out: string[] = []
  if (p.kod === null || p.kod.toUpperCase() !== k.kod.toUpperCase()) out.push('kod pocztowy odbiorcy')
  if (p.ulica === null || porownaj(p.ulica) !== porownaj(k.ulica)) out.push('ulica odbiorcy')
  if (porownaj(p.punkt) !== porownaj(k.punkt)) out.push('punkt GLS')
  if (rozne(p.pobranie ?? 0, k.pobranie)) out.push('kwota pobrania')
  if (rozne(p.waga, k.waga)) out.push('waga')
  if (p.data !== null && p.data.slice(0, 10) !== k.data.slice(0, 10)) out.push('data nadania')
  return out
}

class GlsZapisAdapter extends GlsAdapter implements ShipmentCreator, ReferenceFinder {
  override readonly manifest: AdapterManifest = GLS_ZAPIS_MANIFEST
  private klient: GlsZapis | null = null

  private get wlaczony(): boolean {
    return this.ctx.config['zapisWlaczony'] === true
  }

  private zapis(): GlsZapis {
    if (!this.wlaczony) throw new AdapterError(WYLACZONY, 'TRWALY')
    this.klient ??= new GlsZapis({ url: adresGls(this.ctx.config), auth: logowanie(this.ctx), fetchImpl: this.ctx.fetch, timeoutMs: ZAPIS_TIMEOUT_MS, wylacznik: true })
    return this.klient
  }

  /** Odczyt w przeglądzie z budżetem czasu: po terminie błąd (człowiek), nie cichy „brak”. */
  private async czytaj(metoda: string, parametry: Record<string, string | number>, sesja: string, koniec: number): Promise<string> {
    if (Date.now() > koniec) throw new AdapterError(`GLS: przegląd przesyłek w ADE trwał dłużej niż ${ODSZUKANIE_BUDZET_MS / 60_000} min i nie objął wszystkiego; sprawdź przesyłkę w panelu ADE`, 'TRWALY')
    return this.odczyt.wywolaj(metoda, { session: sesja, ...parametry }, sesja)
  }

  private async przesylka(sesja: string, metoda: 'adePreparingBox_GetConsign' | 'adePickup_GetConsign', id: string, koniec = Infinity): Promise<PrzesylkaAde> {
    const xml = await this.czytaj(metoda, { id }, sesja, koniec)
    const paczki = wartosci(xml, 'number').filter((n) => /^[0-9A-Za-z]{6,30}$/.test(n))
    // pola przesyłki bez listy paczek (paczka też ma `weight`)
    const glowne = xml.replace(/<(?:[\w.-]+:)?parcels\b[\s\S]*?<\/(?:[\w.-]+:)?parcels>/g, '')
    const kod = wartosci(glowne, 'rzipcode')[0]?.replace(/[^0-9A-Za-z]/g, '')
    const sds = /<(?:[\w.-]+:)?srv_sds(?:\s[^<>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?srv_sds>/.exec(glowne)?.[1] ?? ''
    return {
      id,
      odcisk: wartosci(xml, 'references')[0]?.toUpperCase() ?? null,
      paczki,
      kod: kod || null,
      ulica: wartosci(glowne, 'rstreet')[0] || null,
      punkt: wartosci(sds, 'id')[0] || null,
      pobranie: liczbaAde(wartosci(glowne, 'cod_amount')[0]),
      waga: liczbaAde(wartosci(glowne, 'weight')[0]),
      data: wartosci(glowne, 'date')[0] || null,
    }
  }

  /**
   * Najnowsze identyfikatory listy ADE (malejąco), najwyżej `ile`. Strony do pustej (albo bez nowych) przez `id_start` =
   * ostatni identyfikator poprzedniej strony, bo kierunek sortowania ADE nie jest potwierdzony (docs/integracje/gls.md);
   * strona pierwsza malejąca i pełna = najnowsze już są. Ponad ODSZUKANIE_STRON stron = błąd, nie „brak”.
   */
  private async najnowszeZListy(sesja: string, metoda: string, parametry: Record<string, string>, ile: number, koniec: number): Promise<string[]> {
    const zebrane = new Set<string>()
    let start = '0'
    for (let s = 0; s < ODSZUKANIE_STRON; s++) {
      const strona = idZListy(await this.czytaj(metoda, { ...parametry, id_start: start }, sesja, koniec))
      const nowe = strona.filter((id) => !zebrane.has(id))
      if (!nowe.length) return [...zebrane].sort(malejacoIdGls).slice(0, ile)
      for (const id of nowe) zebrane.add(id)
      if (s === 0 && strona.length >= ile && strona.every((id, i) => i === 0 || malejacoIdGls(strona[i - 1]!, id) < 0)) return strona.slice(0, ile)
      start = strona[strona.length - 1]!
    }
    throw new AdapterError(`GLS: lista ${metoda} w ADE ma więcej niż ${ODSZUKANIE_STRON} stron; przegląd nie objął wszystkiego, sprawdź przesyłkę w panelu ADE`, 'TRWALY')
  }

  /** Przygotowania (bez nadania) z odciskiem; przegląda ODSZUKANIE_LIMIT najnowszych. */
  private async wPrzygotowalni(sesja: string, odcisk: string, koniec: number): Promise<PrzesylkaAde[]> {
    const ids = await this.najnowszeZListy(sesja, 'adePreparingBox_GetConsignIDs', {}, ODSZUKANIE_LIMIT, koniec)
    const out: PrzesylkaAde[] = []
    for (const id of ids) {
      const c = await this.przesylka(sesja, 'adePreparingBox_GetConsign', id, koniec)
      if (c.odcisk === odcisk) out.push(c)
    }
    return out
  }

  /**
   * Przesyłki z odciskiem w `okno.potwierdzen` najnowszych potwierdzeniach nadania (wszystkie przesyłki każdego z nich,
   * także zbiorczych z panelu ADE). Przesyłki potwierdzenia jednym `adePickup_GetConsignBinds` (bez stron
   * `adePickup_GetConsignIDs`). Ponad `okno.przesylek` przesyłek = błąd, nie „brak”.
   */
  private async wNadanych(sesja: string, odcisk: string, koniec: number, okno: { potwierdzen: number; przesylek: number } = { potwierdzen: ODSZUKANIE_POTWIERDZEN, przesylek: ODSZUKANIE_PRZESYLEK }): Promise<PrzesylkaAde[]> {
    const potwierdzenia = await this.najnowszeZListy(sesja, 'adePickup_GetIDs', {}, okno.potwierdzen, koniec)
    const out: PrzesylkaAde[] = []
    let przejrzane = 0
    for (const p of potwierdzenia) {
      // tylko pola `id` (numery paczek w `number` też są cyframi, więc `items` się tu nie bierze)
      const ids = [...new Set(wartosci(await this.czytaj('adePickup_GetConsignBinds', { id: p }, sesja, koniec), 'id').filter((x) => ID_GLS_RE.test(x)))]
      if (przejrzane + ids.length > okno.przesylek) throw new AdapterError(`GLS: w ${okno.potwierdzen} ostatnich potwierdzeniach nadania jest ponad ${okno.przesylek} przesyłek; przegląd nie objął wszystkiego, sprawdź przesyłkę w panelu ADE`, 'TRWALY')
      for (const id of ids) {
        przejrzane++
        const c = await this.przesylka(sesja, 'adePickup_GetConsign', id, koniec)
        if (c.odcisk === odcisk) out.push(c)
      }
    }
    return out
  }

  /** Bez rzucania: wynik zapisu ADE → WriteOutcome (Fault wg tabeli kodów). */
  private static odmowa(r: Extract<Awaited<ReturnType<GlsZapis['wywolaj']>>, { ok: false }>, reference: string, dopisek = ''): WriteOutcome {
    if (r.kod) {
      const k = klasaKoduGls(r.kod)
      return { kind: k.klasa, reference, message: `GLS: ${k.opis}${dopisek}` }
    }
    return { kind: r.kind, reference, message: r.kind === 'NIEJEDNOZNACZNY' ? `${r.message}; ${BEZ_PONAWIANIA}` : `${r.message}${dopisek}` }
  }

  async createShipment(req: ShipmentCreateRequest, reference: string): Promise<WriteOutcome> {
    if (!this.wlaczony) return { kind: 'TRWALY', reference, message: WYLACZONY }
    if (req.carrier !== 'GLS') return { kind: 'TRWALY', reference, message: 'moduł GLS nadaje tylko przesyłki przewoźnika „GLS”' }
    const o = odbiorcaGls(req.recipient)
    if (!o.odbiorca) return { kind: 'TRWALY', reference, message: o.braki.includes('kraj') ? 'odbiorca spoza Polski: moduł GLS jest krajowy (kraj)' : `niepełne dane odbiorcy: ${o.braki.join(', ')}` }
    let surowy: unknown = null
    try {
      surowy = typeof this.ctx.config['nadawca'] === 'string' ? (JSON.parse(this.ctx.config['nadawca']) as unknown) : null
    } catch {
      return { kind: 'TRWALY', reference, message: 'nieczytelne dane nadawcy w konfiguracji' }
    }
    const n = parseNadawca({ nadawca: surowy as never })
    if (!n.nadawca) return { kind: 'TRWALY', reference, message: `brak danych nadawcy firmy: ${n.braki.join(', ')}` }
    let z: ReturnType<typeof zlecenieGls>
    try {
      z = zlecenieGls(req.parcel, o.odbiorca, n.nadawca, { reference, teraz: (this.ctx.now ?? (() => new Date()))(), potwierdzoneOstrzezenia: req.potwierdzoneOstrzezenia ?? [], codLimit: this.ustawienia.codLimit })
    } catch (e) {
      return { kind: 'TRWALY', reference, message: e instanceof Error ? e.message : 'zła treść przesyłki' }
    }
    const klient = this.zapis()
    try {
      return await this.odczyt.sesja(async (sesja) => {
        const koniec = Date.now() + ODSZUKANIE_BUDZET_MS
        // 0. Poprzednia próba już nadała (odpowiedź na potwierdzenie zgubiona, ADE skończyło później)? zwróć ją.
        //    tylko przy ponowieniu (host wie, że ta referencja już szła do ADE); pierwsza próba z nową referencją nie
        //    może mieć nadanej przesyłki, a przegląd historii potwierdzeń nie może jej blokować ani spowalniać.
        if (req.ponowienie) {
          const nadane = await this.wNadanych(sesja, z.odcisk, koniec, ODSZUKANIE_PONOWIENIE)
          if (nadane.length > 1) return { kind: 'TRWALY', reference, message: `GLS: kilka nadanych przesyłek z referencją tej przesyłki (${nadane.map((c) => c.id).join(', ')}), potrzebny człowiek` }
          if (nadane.length === 1) return { kind: 'OK', reference, externalRef: nadane[0]!.id }
        }
        // 1. przygotowanie z tą referencją już jest (przerwana poprzednia próba)? dokończ je zamiast wstawiać drugie,
        //    ale tylko z tymi samymi danymi co teraz (po poprawce zamówienia stare przygotowanie ma stary adres/pobranie)
        const istniejace = await this.wPrzygotowalni(sesja, z.odcisk, koniec)
        if (istniejace.length > 1) return { kind: 'TRWALY', reference, message: `GLS: kilka przygotowań z referencją tej przesyłki w przygotowalni ADE (${istniejace.map((c) => c.id).join(', ')}), potrzebny człowiek` }
        let idPrzygotowania: string | null = null
        if (istniejace.length === 1) {
          const stare = istniejace[0]!
          const roznice = roznicePrzygotowaniaGls(stare, z.kontrolne)
          if (roznice.length) return { kind: 'TRWALY', reference, message: `GLS: w ADE czeka przesyłka ${stare.id} z poprzedniej próby, ale z innymi danymi niż teraz (${roznice.join(', ')}). Usuń przygotowanie ${stare.id} w panelu ADE i ponów.` }
          idPrzygotowania = stare.id
        }
        if (!idPrzygotowania) {
          const r = await klient.wywolaj('adePreparingBox_Insert', { session: sesja, consign_prep_data: z.dane }, sesja)
          if (!r.ok) return GlsZapisAdapter.odmowa(r, reference)
          idPrzygotowania = wynik(r.xml, 'id')
          if (!idPrzygotowania || !ID_GLS_RE.test(idPrzygotowania)) return { kind: 'NIEJEDNOZNACZNY', reference, message: `GLS: odpowiedź na wstawienie bez identyfikatora; ${BEZ_PONAWIANIA}` }
        }
        // 2. potwierdzenie nadania (consign): od tej chwili przesyłka jest nadana
        const doPrzygotowania = ` (przygotowanie ${idPrzygotowania} czeka w przygotowalni ADE bez nadania; ponowienie je dokończy, nie wstawi drugiego)`
        const p = await klient.wywolaj('adePickup_Create', { session: sesja, consigns_ids: [idPrzygotowania], desc: 'Kompletor' }, sesja)
        if (!p.ok) return GlsZapisAdapter.odmowa(p, reference, doPrzygotowania)
        const idPotwierdzenia = wynik(p.xml, 'id')
        if (!idPotwierdzenia || !ID_GLS_RE.test(idPotwierdzenia)) return { kind: 'NIEJEDNOZNACZNY', reference, message: `GLS: odpowiedź na potwierdzenie nadania bez identyfikatora; ${BEZ_PONAWIANIA}` }
        // 3. identyfikator przesyłki w potwierdzeniu i numery paczek (sam odczyt; błąd = nadane, ale bez numeru)
        try {
          const binds = await this.odczyt.wywolaj('adePickup_GetConsignBinds', { session: sesja, id: idPotwierdzenia }, sesja)
          const id = idZListy(binds).sort(malejacoIdGls)[0]
          if (!id) throw new AdapterError('GLS: potwierdzenie nadania bez przesyłki', 'TRWALY')
          const c = await this.przesylka(sesja, 'adePickup_GetConsign', id)
          if (c.odcisk !== z.odcisk) throw new AdapterError('GLS: przesyłka w potwierdzeniu ma inną referencję', 'TRWALY')
          if (!c.paczki.length) throw new AdapterError('GLS: przesyłka bez numeru paczki', 'TRWALY')
          return { kind: 'OK', reference, externalRef: id }
        } catch (e) {
          return { kind: 'NIEJEDNOZNACZNY', reference, message: `GLS: przesyłka nadana (potwierdzenie ${idPotwierdzenia}), ale ${bladOdczytu(e, 'odczyt numeru').message}; odszukanie po referencji ją potwierdzi` }
        }
      })
    } catch (e) {
      // logowanie albo przegląd potwierdzeń i przygotowalni (sam odczyt, przed jakimkolwiek zapisem): nic nie wysłano
      const b = bladOdczytu(e, 'przed nadaniem')
      return { kind: b.kind === 'PRZEJSCIOWY' ? 'PRZEJSCIOWY' : 'TRWALY', reference, message: b.message }
    }
  }

  /** Numer pierwszej paczki przesyłki (do śledzenia na gls-group.com i do kanału). */
  async getTrackingNumber(externalRef: string): Promise<string | null> {
    if (!this.wlaczony) throw new AdapterError(WYLACZONY, 'TRWALY')
    if (!ID_GLS_RE.test(externalRef)) throw new AdapterError('zły identyfikator przesyłki GLS', 'TRWALY')
    try {
      return await this.odczyt.sesja(async (s) => (await this.przesylka(s, 'adePickup_GetConsign', externalRef)).paczki[0] ?? null)
    } catch (e) {
      throw bladOdczytu(e, 'numer paczki')
    }
  }

  /** Etykieta: jedna paczka = `adePickup_GetParcelLabel`, kilka = `adePickup_GetParcelsLabels` (jeden plik). */
  async getLabel(externalRef: string, format: LabelFormat): Promise<{ contentType: string; base64: string }> {
    if (!this.wlaczony) throw new AdapterError(WYLACZONY, 'TRWALY')
    if (!ID_GLS_RE.test(externalRef)) throw new AdapterError('zły identyfikator przesyłki GLS', 'TRWALY')
    const tryb = TRYB_ETYKIETY[format]
    if (!tryb) throw new AdapterError('format etykiety niedostępny w GLS (PDF albo ZPL)', 'TRWALY')
    try {
      return await this.odczyt.sesja(async (s) => {
        const c = await this.przesylka(s, 'adePickup_GetConsign', externalRef)
        if (!c.paczki.length) throw new AdapterError('GLS: przesyłka bez paczek', 'TRWALY')
        const xml =
          c.paczki.length === 1
            ? await this.odczyt.wywolaj('adePickup_GetParcelLabel', { session: s, number: c.paczki[0]!, mode: tryb.mode }, s)
            : await this.odczyt.wywolaj('adePickup_GetParcelsLabels', { session: s, numbers: c.paczki, mode: tryb.mode }, s)
        const dane = wynik(xml)
        if (!dane || !BASE64_RE.test(dane)) throw new AdapterError('GLS: odpowiedź bez etykiety', 'TRWALY')
        return { contentType: tryb.contentType, base64: dane.replace(/\s/g, '') }
      })
    } catch (e) {
      throw bladOdczytu(e, 'etykieta')
    }
  }

  async findByReference(reference: string): Promise<ReferenceLookup> {
    if (!this.wlaczony) throw new AdapterError(WYLACZONY, 'TRWALY')
    let odcisk: string
    try {
      odcisk = odciskGls(reference)
    } catch {
      throw new AdapterError('zła referencja przesyłki GLS', 'TRWALY')
    }
    let w: { nadane: PrzesylkaAde[]; przygotowane: PrzesylkaAde[] }
    try {
      w = await this.odczyt.sesja(async (s) => {
        const koniec = Date.now() + ODSZUKANIE_BUDZET_MS
        return { nadane: await this.wNadanych(s, odcisk, koniec), przygotowane: await this.wPrzygotowalni(s, odcisk, koniec) }
      })
    } catch (e) {
      throw bladOdczytu(e, 'odszukanie po referencji')
    }
    if (w.nadane.length > 1) throw new AdapterError(`GLS: kilka nadanych przesyłek z referencją tej przesyłki (${w.nadane.map((c) => c.id).join(', ')}), potrzebny człowiek`, 'TRWALY')
    if (w.nadane.length === 1) return { found: true, externalRef: w.nadane[0]!.id }
    if (w.przygotowane.length > 1) throw new AdapterError(`GLS: kilka przygotowań z referencją tej przesyłki (${w.przygotowane.map((c) => c.id).join(', ')}), potrzebny człowiek`, 'TRWALY')
    // samo przygotowanie nie dowodzi, że nadania nie było (potwierdzenie mogło być jeszcze w toku po stronie ADE)
    if (w.przygotowane.length === 1) {
      const id = w.przygotowane[0]!.id
      throw new AdapterError(
        `GLS: przesyłka ${id} czeka w przygotowalni ADE bez potwierdzenia nadania, a potwierdzenie mogło być jeszcze w toku. Za kilka minut kliknij „Sprawdź u przewoźnika” jeszcze raz. Gdy w panelu ADE przesyłka ${id} dalej czeka tylko w przygotowalni, wybierz „Rozstrzygnij ręcznie” → „Nie powstała” i utwórz przesyłkę ponownie: Kompletor dokończy przesyłkę ${id}, nie zrobi drugiej.`,
        'TRWALY',
      )
    }
    throw new AdapterError(`GLS: ani w przygotowalni, ani w ${ODSZUKANIE_POTWIERDZEN} ostatnich potwierdzeniach nadania nie ma przesyłki z referencją ${odcisk}; to nie jest dowód, że nie powstała (sprawdź w panelu ADE po polu „Referencje”)`, 'TRWALY')
  }

  /** Identyfikator przesyłki ADE wpisany przy „Rozstrzygnij ręcznie”: musi istnieć w ADE i nieść odcisk tej referencji. */
  async confirmManual(identyfikator: string, reference: string): Promise<PotwierdzenieRecznego> {
    if (!this.wlaczony) return { odmowa: 'Nadawanie GLS jest wyłączone w ustawieniach przewoźnika: Kompletor nie może sprawdzić przesyłki w ADE.' }
    const id = identyfikator.trim()
    if (!ID_GLS_RE.test(id)) return { odmowa: 'Podaj identyfikator przesyłki z ADE (same cyfry).' }
    let c: PrzesylkaAde
    try {
      c = await this.odczyt.sesja((s) => this.przesylka(s, 'adePickup_GetConsign', id))
    } catch (e) {
      const b = bladOdczytu(e, 'sprawdzenie przesyłki')
      if (b.kind === 'TRWALY') return { odmowa: `ADE nie potwierdziło przesyłki ${id} (${b.message}). Nic nie zapisano.` }
      throw b
    }
    if (c.odcisk !== odciskGls(reference)) return { odmowa: `Przesyłka ${id} w ADE nie ma referencji tej przesyłki: to inna przesyłka albo nie utworzył jej Kompletor. Nic nie zapisano.` }
    return { externalRef: id, info: 'Sprawdzone w ADE: przesyłka ma referencję tej przesyłki.', referencjaSprawdzona: true }
  }
}

export const GLS_DEFINITION: AdapterDefinition = { manifest: GLS_MANIFEST, create: (ctx) => new GlsAdapter(ctx) }
export const GLS_ZAPIS_DEFINITION: AdapterDefinition = { manifest: GLS_ZAPIS_MANIFEST, create: (ctx) => new GlsZapisAdapter(ctx) }
