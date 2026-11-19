// GLS Polska ADE: klient SOAP usługi ade_webapi2, kod własny Kompletora. Wiedza o API: konektor Open
// Integration Platform (integrators/courier/gls/v1.0.0/src/integration.py i config.py, commit ae43d1e, Apache-2.0,
// THIRD_PARTY_NOTICES.md): sesja `adeLogin` → metody → `adeLogout`, nazwy metod i pól przesyłki, adres testowy.
// Metody odszukania (`adePreparingBox_GetConsignIDs`, `adePickup_GetIDs`, `adePickup_GetConsignIDs`) i adres produkcyjny
// są spoza konektora [NIEPEWNE: do potwierdzenia w WSDL na koncie testowym, docs/integracje/gls.md].
//
// Dwa klienty o rozłącznych listach metod:
//   GlsOdczyt — sesja i metody, które niczego nie tworzą (lista i treść przesyłek, etykiety już nadanych paczek),
//     z ponawianiem przy sieci, 429 i 5xx. Metoda spoza listy = ReadOnlyViolation przed wysyłką.
//   GlsZapis — powstaje tylko z jawnym `wylacznik: true`: wstawienie do przygotowalni (`adePreparingBox_Insert`) i
//     potwierdzenie nadania (`adePickup_Create`). Jedno żądanie, bez ponawiania: sieć, timeout i 5xx po wysłaniu =
//     NIEJEDNOZNACZNY. Fault z kodem ADE (`err_*`) = odmowa przed wykonaniem, klasyfikuje go adapter; Fault bez kodu ADE
//     (`SOAP-ENV:Server`, nieczytelny) = NIEJEDNOZNACZNY, bo błąd serwera mógł paść po wykonaniu.
// Odpowiedź czytana z sufitem rozmiaru (MAX_ODPOWIEDZI_B) przed dopasowaniem wyrażeń regularnych.
// Hasło idzie tylko w treści `adeLogin`; nie trafia do komunikatów (`clean`). Identyfikator sesji też nie.
import type { FailureKind } from '../adaptery/kontrakt'
import { fetchWithTimeout, ReadOnlyViolation, SourceError, withRetry, type FetchLike, type RetryOptions } from './http'
import { escXml, pole } from './orlenpaczka'

/** Adres testowy z konektora OIP (config.py) i produkcyjny ADE Plus [NIEPEWNE: produkcyjny do potwierdzenia u GLS]. */
export const GLS_TEST = 'https://ade-test.gls-poland.com/adeplus/pm1/ade_webapi2.php'
export const GLS_PROD = 'https://adeplus.gls-poland.com/adeplus/pm1/ade_webapi2.php'
export const GLS_URL_RE = /^https:\/\/(ade-test|adeplus)\.gls-poland\.com\/adeplus\/pm1\/ade_webapi2\.php$/

/** Przestrzeń nazw metod RPC [NIEPEWNE: z WSDL usługi; PHP SoapServer czyta metodę po nazwie elementu]. */
export const GLS_NS = 'urn:ade_webapi2'

export const METODY_SESJI = ['adeLogin', 'adeLogout'] as const
export const METODY_ODCZYTU = ['adePreparingBox_GetConsignIDs', 'adePreparingBox_GetConsign', 'adePickup_GetIDs', 'adePickup_GetConsignIDs', 'adePickup_GetConsignBinds', 'adePickup_GetConsign', 'adePickup_GetParcelLabel', 'adePickup_GetParcelsLabels'] as const
export const METODY_ZAPISU = ['adePreparingBox_Insert', 'adePickup_Create'] as const
export type MetodaOdczytu = (typeof METODY_ODCZYTU)[number] | (typeof METODY_SESJI)[number]
export type MetodaZapisu = (typeof METODY_ZAPISU)[number]

export interface GlsLogowanie {
  login: string
  haslo: string
}

/** Wartość pola koperty: tekst, liczba, flaga, struktura (pola po kolei), lista (`<items>`), brak = pominięte. */
export type WartoscSoap = string | number | boolean | null | undefined | readonly WartoscSoap[] | { readonly [k: string]: WartoscSoap }

const NAZWA_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/

/** Sufit rozmiaru odpowiedzi ADE (etykieta wielopaczkowa w base64 mieści się z zapasem). */
export const MAX_ODPOWIEDZI_B = 20 * 1024 * 1024

class ZaDuzaOdpowiedz extends Error {}

/** Treść odpowiedzi czytana strumieniem do `max` bajtów; więcej = ZaDuzaOdpowiedz (reszty nie pobiera). */
async function czytajOdpowiedz(res: Response, max: number): Promise<string> {
  const dl = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(dl) && dl > max) {
    await res.body?.cancel().catch(() => undefined)
    throw new ZaDuzaOdpowiedz()
  }
  if (!res.body) return res.text()
  const reader = res.body.getReader()
  const czesci: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > max) {
      await reader.cancel().catch(() => undefined)
      throw new ZaDuzaOdpowiedz()
    }
    czesci.push(value)
  }
  return Buffer.concat(czesci).toString('utf-8')
}

const mb = (b: number) => `${Math.round((b / 1048576) * 100) / 100} MB`

function element(nazwa: string, v: WartoscSoap): string {
  if (v === null || v === undefined) return ''
  if (!NAZWA_RE.test(nazwa)) throw new Error(`zła nazwa pola SOAP: ${nazwa}`)
  if (Array.isArray(v)) return `<${nazwa}>${v.map((x) => element('items', x)).join('')}</${nazwa}>`
  if (typeof v === 'object') return `<${nazwa}>${Object.entries(v).map(([k, x]) => element(k, x)).join('')}</${nazwa}>`
  const t = typeof v === 'boolean' ? (v ? '1' : '0') : String(v)
  return `<${nazwa}>${escXml(t)}</${nazwa}>`
}

/** Koperta SOAP 1.1 w stylu RPC: metoda w przestrzeni nazw usługi, parametry bez przedrostka, listy jako `items`. */
export function kopertaGls(metoda: string, parametry: Readonly<Record<string, WartoscSoap>>): string {
  if (!NAZWA_RE.test(metoda)) throw new Error('zła nazwa metody SOAP')
  const pola = Object.entries(parametry).map(([k, v]) => element(k, v)).join('')
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="${GLS_NS}">` +
    `<SOAP-ENV:Body><ns1:${metoda}>${pola}</ns1:${metoda}></SOAP-ENV:Body></SOAP-ENV:Envelope>`
  )
}

/** Kody Fault SOAP 1.1 oznaczające odmowę przed wykonaniem (także z podkodem po kropce, np. `Client.Auth`). */
const FAULT_PRZED_WYKONANIEM = /^(?:Client|VersionMismatch|MustUnderstand)(?:\.[A-Za-z0-9_.-]+)?$/

/** Kod błędu ADE z Faultu (`faultcode`, np. `err_sess_expired`), bez przedrostka; null = odpowiedź bez Faultu. */
export function kodFaultu(xml: string): string | null {
  if (!/<(?:[\w.-]+:)?Fault\b/.test(xml)) return null
  const kod = (pole(xml, 'faultcode') ?? '').replace(/^[\w.-]+:/, '').trim()
  return /^[A-Za-z0-9_.-]{1,80}$/.test(kod) ? kod : 'fault'
}

/** Wszystkie teksty elementów o tej nazwie (np. `items` listy identyfikatorów), w kolejności dokumentu. */
export function wartosci(xml: string, nazwa: string): string[] {
  if (!NAZWA_RE.test(nazwa)) return []
  const re = new RegExp(`<(?:[\\w.-]+:)?${nazwa}(?:\\s[^<>]*?)?>([^<]*)</(?:[\\w.-]+:)?${nazwa}>`, 'g')
  return [...xml.matchAll(re)].map((m) => m[1]!.trim())
}

/** Wartość prosta odpowiedzi: pierwsze z pól `nazwy` albo sam `return` (konektor OIP używa wyniku wprost). */
export function wynik(xml: string, ...nazwy: string[]): string | null {
  for (const n of [...nazwy, 'return']) {
    const v = pole(xml, n)
    if (v) return v
  }
  return null
}

// ─── Połączenie ──────────────────────────────────────────────────────────────

class Polaczenie {
  constructor(
    readonly url: string,
    private readonly auth: GlsLogowanie,
    readonly fetchImpl: FetchLike,
  ) {
    if (!auth.login || !auth.haslo) throw new Error('Brak loginu albo hasła ADE GLS')
    if (!/^[A-Za-z0-9._@-]{1,60}$/.test(auth.login)) throw new Error('Zły login ADE GLS')
    if (!GLS_URL_RE.test(url)) throw new Error('Zły adres API GLS (tylko adres produkcyjny albo testowy ADE)')
  }

  clean(message: string, sesja?: string | null): string {
    return [this.auth.haslo, escXml(this.auth.haslo), sesja ?? ''].reduce((m, s) => (s ? m.split(s).join('***') : m), message)
  }

  logowanie(): Record<string, WartoscSoap> {
    return { user_name: this.auth.login, user_password: this.auth.haslo }
  }

  init(metoda: string, body: string): RequestInit {
    return { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${GLS_NS}#${metoda}"` }, body }
  }
}

/** Odmowa ADE (Fault z kodem) przy odczycie: osobny typ, żeby adapter sklasyfikował kod. */
export class GlsFault extends SourceError {
  constructor(
    readonly metoda: string,
    readonly kod: string,
  ) {
    super(`GLS ${metoda}: odmowa ADE (${kod})`, false)
  }
}

export interface OpcjeGls {
  url: string
  auth: GlsLogowanie
  fetchImpl?: FetchLike
  retry?: RetryOptions
  timeoutMs?: number
  /** Sufit rozmiaru odpowiedzi w bajtach (domyślnie MAX_ODPOWIEDZI_B). */
  maxOdpowiedziB?: number
}

/**
 * Odczyt i sesja. `sesja(fn)` loguje, woła `fn` i ZAWSZE wylogowuje (także po błędzie `fn`); błąd wylogowania nie
 * przykrywa wyniku (ADE zamyka sesję sam po 30 minutach, limit 10 sesji naraz na firmę).
 */
export class GlsOdczyt {
  readonly conn: Polaczenie
  private readonly retry: RetryOptions
  private readonly timeoutMs: number
  private readonly maxB: number

  constructor(o: OpcjeGls) {
    this.conn = new Polaczenie(o.url, o.auth, o.fetchImpl ?? fetch)
    this.retry = o.retry ?? { attempts: 3, baseDelayMs: 500 }
    this.timeoutMs = o.timeoutMs ?? 30_000
    this.maxB = o.maxOdpowiedziB ?? MAX_ODPOWIEDZI_B
  }

  async wywolaj(metoda: string, parametry: Readonly<Record<string, WartoscSoap>>, sesja: string | null = null): Promise<string> {
    if (!([...METODY_ODCZYTU, ...METODY_SESJI] as readonly string[]).includes(metoda)) throw new ReadOnlyViolation(`GLS: metoda „${metoda}” nie jest dozwolona w trybie odczytu`)
    const body = kopertaGls(metoda, parametry)
    return withRetry(async () => {
      let res: Response
      try {
        res = await fetchWithTimeout(this.conn.fetchImpl, this.conn.url, this.conn.init(metoda, body), this.timeoutMs)
      } catch (e) {
        throw new SourceError(`GLS ${metoda}: ${this.conn.clean(e instanceof Error ? e.message : String(e), sesja)}`, true)
      }
      let text = ''
      try {
        text = await czytajOdpowiedz(res, this.maxB)
      } catch (e) {
        if (e instanceof ZaDuzaOdpowiedz) throw new SourceError(`GLS ${metoda}: odpowiedź większa niż ${mb(this.maxB)}`, false)
      }
      const kod = kodFaultu(text)
      if (kod) throw new GlsFault(metoda, kod)
      if (res.status === 429 || res.status >= 500) throw new SourceError(`GLS ${metoda}: HTTP ${res.status}`, true)
      if (!res.ok) throw new SourceError(`GLS ${metoda}: HTTP ${res.status}`, false)
      if (!text.trim()) throw new SourceError(`GLS ${metoda}: pusta odpowiedź`, true)
      return text
    }, this.retry)
  }

  async sesja<T>(fn: (sesja: string) => Promise<T>): Promise<T> {
    const xml = await this.wywolaj('adeLogin', this.conn.logowanie())
    const sesja = wynik(xml, 'session')
    if (!sesja || !/^[A-Za-z0-9._-]{4,200}$/.test(sesja)) throw new SourceError('GLS adeLogin: odpowiedź bez identyfikatora sesji', false)
    try {
      return await fn(sesja)
    } finally {
      await this.wywolaj('adeLogout', { session: sesja }, sesja).catch(() => undefined)
    }
  }
}

export type WynikZapisuGls = { ok: true; xml: string } | { ok: false; kind: FailureKind; message: string; kod?: string }

export class GlsZapis {
  private readonly conn: Polaczenie
  private readonly timeoutMs: number
  private readonly maxB: number

  constructor(o: OpcjeGls & { wylacznik: true }) {
    if ((o as { wylacznik?: unknown }).wylacznik !== true) throw new Error('Zapis GLS wyłączony: klient zapisu wymaga jawnego wyłącznika')
    this.conn = new Polaczenie(o.url, o.auth, o.fetchImpl ?? fetch)
    this.timeoutMs = o.timeoutMs ?? 60_000
    this.maxB = o.maxOdpowiedziB ?? MAX_ODPOWIEDZI_B
  }

  /**
   * Jedno żądanie, bez ponawiania. Metoda spoza listy (zamówienie kuriera, usunięcie) = wyjątek przed wysyłką. Fault z
   * kodem ADE (`err_*`) = TRWALY z kodem (adapter zawęża klasę); Fault bez kodu ADE (`SOAP-ENV:Server`, nieczytelny),
   * sieć, timeout, 5xx bez Faultu, pusta i za duża odpowiedź = NIEJEDNOZNACZNY; 429 = PRZEJSCIOWY; inne 4xx = TRWALY.
   */
  async wywolaj(metoda: MetodaZapisu, parametry: Readonly<Record<string, WartoscSoap>>, sesja: string): Promise<WynikZapisuGls> {
    if (!(METODY_ZAPISU as readonly string[]).includes(metoda)) throw new ReadOnlyViolation(`GLS: metoda „${metoda}” nie jest dozwolona dla zapisu`)
    const body = kopertaGls(metoda, parametry)
    let res: Response
    try {
      res = await fetchWithTimeout(this.conn.fetchImpl, this.conn.url, this.conn.init(metoda, body), this.timeoutMs)
    } catch (e) {
      const m = e instanceof SourceError ? this.conn.clean(e.message, sesja) : 'nieznany błąd'
      return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `GLS ${metoda}: ${m}; nie wiadomo, czy ADE wykonało żądanie` }
    }
    let text = ''
    try {
      text = await czytajOdpowiedz(res, this.maxB)
    } catch (e) {
      if (e instanceof ZaDuzaOdpowiedz) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `GLS ${metoda}: odpowiedź większa niż ${mb(this.maxB)}; nie wiadomo, czy ADE wykonało żądanie` }
    }
    const kod = kodFaultu(text)
    // tylko kod z rodziny ADE (`err_*`) to odmowa przed wykonaniem; błąd serwera SOAP mógł paść po wykonaniu.
    // Fault `Client`, `VersionMismatch`, `MustUnderstand` (SOAP 1.1) = serwer odrzucił samo żądanie przed
    // wykonaniem (np. zła przestrzeń nazw), więc TRWALY; `Server` i inne nieznane zostają NIEJEDNOZNACZNY.
    if (kod && FAULT_PRZED_WYKONANIEM.test(kod)) return { ok: false, kind: 'TRWALY', message: `GLS ${metoda}: ADE odrzuciło żądanie przed wykonaniem (${kod})` }
    if (kod && !kod.startsWith('err_')) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `GLS ${metoda}: błąd serwera ADE bez kodu odmowy (${kod}); nie wiadomo, czy ADE wykonało żądanie` }
    if (kod) return { ok: false, kind: 'TRWALY', kod, message: `GLS ${metoda}: odmowa ADE (${kod})` }
    if (res.status >= 500) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `GLS ${metoda}: HTTP ${res.status}; nie wiadomo, czy ADE wykonało żądanie` }
    if (res.status === 429) return { ok: false, kind: 'PRZEJSCIOWY', message: `GLS ${metoda}: HTTP 429` }
    if (!res.ok) return { ok: false, kind: 'TRWALY', message: `GLS ${metoda}: HTTP ${res.status}` }
    if (!text.trim()) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `GLS ${metoda}: pusta odpowiedź po wysłaniu` }
    return { ok: true, xml: text }
  }
}
