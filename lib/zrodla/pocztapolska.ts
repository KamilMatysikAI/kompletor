// Poczta Polska: klienty SOAP 1.1 usług eNadawca (nadawanie, HTTP Basic) i Śledzenie (WSSE UsernameToken),
// kod własny Kompletora. Wiedza o API: konektor Open Integration Platform
// (integrators/courier/pocztapolska/v1.0.0/src/integration.py i docs/courier/pocztapolska, commit ae43d1e, Apache-2.0,
// THIRD_PARTY_NOTICES.md), przepisane i zmienione. [NIEPEWNE: kształt elementów (element czy atrybut XML) i nazwy pól
// odpowiedzi do potwierdzenia z WSDL `en.wsdl` na koncie testowym eNadawcy; konto testowe wydaje Poczta Polska.]
//
// Klienty o rozłącznych listach metod:
//   EnadawcaOdczyt — metody, które niczego nie tworzą ani nie zmieniają (urzędy nadania, lista buforów, zawartość
//     bufora, dane przesyłki po GUID); z ponawianiem przy sieci, 429 i 5xx. Metoda spoza listy = ReadOnlyViolation.
//   EnadawcaZapis — powstaje tylko z jawnym `wylacznik: true`. Bufor partii, dodanie przesyłki, usunięcie z bufora
//     WYŁĄCZNIE po GUID (`clearEnvelopeByGuids`), wydruk etykiety, zamówienie kuriera, wysłanie partii. Jedno żądanie,
//     bez ponawiania: sieć, timeout i 5xx po wysłaniu = NIEJEDNOZNACZNY. `clearEnvelope` (czyści cały bufor konta, także
//     paczki innych zamówień) nie jest na żadnej liście: klient go nie wyśle.
//   SledzenieOdczyt — `sprawdzPrzesylke` z nagłówkiem WSSE.
// Hasła nie trafiają do komunikatów (`clean`); treść odpowiedzi (dane adresata) też nie: tylko kody i stałe teksty.
import type { FailureKind } from '../adaptery/kontrakt'
import { fetchWithTimeout, ReadOnlyViolation, SourceError, withRetry, type FetchLike, type RetryOptions } from './http'
import { blad, escXml, faultKlienta } from './orlenpaczka'

/** Adresy usług: eNadawca produkcja (stary i nowy adres z 2025 r.), środowisko testowe, Śledzenie. Inne odrzucone. */
export const ENADAWCA_PROD = 'https://e-nadawca.poczta-polska.pl/websrv/en.php'
export const ENADAWCA_PROD_NOWY = 'https://e-nadawca.api.poczta-polska.pl/websrv/en.php'
export const ENADAWCA_TEST = 'https://en-testwebapi.poczta-polska.pl/websrv/labs.php'
export const ENADAWCA_URL_RE = /^https:\/\/(e-nadawca\.poczta-polska\.pl\/websrv\/en\.php|e-nadawca\.api\.poczta-polska\.pl\/websrv\/en\.php|en-testwebapi\.poczta-polska\.pl\/websrv\/labs\.php)$/
export const SLEDZENIE_URL = 'https://tt.poczta-polska.pl/Sledzenie/services/Sledzenie'

export const ENADAWCA_NS = 'http://e-nadawca.poczta-polska.pl'
export const SLEDZENIE_NS = 'http://sledzenie.pocztapolska.pl'

export const METODY_ODCZYTU_PP = ['getUrzedyNadania', 'getEnvelopeBuforList', 'getEnvelopeBufor', 'getAddresLabelByGuidCompact'] as const
export const METODY_ZAPISU_PP = ['createEnvelopeBufor', 'addShipment', 'clearEnvelopeByGuids', 'getPrintForParcel', 'zamowKuriera', 'sendEnvelope'] as const
export type MetodaOdczytuPP = (typeof METODY_ODCZYTU_PP)[number]
export type MetodaZapisuPP = (typeof METODY_ZAPISU_PP)[number]

export interface LogowaniePP {
  login: string
  haslo: string
}

/**
 * Węzeł XML żądania: tekst/liczba/bool = element z tekstem; obiekt = element z dziećmi (klucze `@x` = atrybuty);
 * tablica = powtórzony element; null/undefined = pominięty.
 */
export type WezelXml = string | number | boolean | null | undefined | WezelXml[] | { [k: string]: WezelXml }

const NAZWA_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/

function element(nazwa: string, v: WezelXml): string {
  if (v === null || v === undefined) return ''
  if (!NAZWA_RE.test(nazwa)) throw new Error(`zła nazwa pola SOAP: ${nazwa}`)
  if (Array.isArray(v)) return v.map((x) => element(nazwa, x)).join('')
  if (typeof v !== 'object') return `<${nazwa}>${escXml(String(v))}</${nazwa}>`
  let atrybuty = ''
  let dzieci = ''
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith('@')) {
      const a = k.slice(1)
      if (!/^[A-Za-z][\w:]{0,60}$/.test(a)) throw new Error(`zła nazwa atrybutu SOAP: ${a}`)
      if (x !== null && x !== undefined) atrybuty += ` ${a}="${escXml(String(x))}"`
    } else dzieci += element(k, x)
  }
  return `<${nazwa}${atrybuty}>${dzieci}</${nazwa}>`
}

/** Koperta SOAP 1.1; `naglowek` = gotowy XML nagłówka (WSSE). Pola żądania bez przestrzeni nazw (unqualified). */
export function kopertaPP(ns: string, metoda: string, parametry: Readonly<Record<string, WezelXml>>, naglowek = ''): string {
  if (!NAZWA_RE.test(metoda)) throw new Error('zła nazwa metody SOAP')
  const pola = Object.entries(parametry).map(([k, v]) => element(k, v)).join('')
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tns="${ns}">` +
    `<soap:Header>${naglowek}</soap:Header><soap:Body><tns:${metoda}>${pola}</tns:${metoda}></soap:Body></soap:Envelope>`
  )
}

// ─── Odczyt odpowiedzi ───────────────────────────────────────────────────────

const ENCJE: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const dekoduj = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENCJE[e.toLowerCase()] ?? m
  })

/**
 * Każdy element o nazwie lokalnej `nazwa` W CAŁOŚCI (znacznik otwierający z atrybutami + wnętrze), w kolejności
 * dokumentu, bez zagnieżdżeń tej samej nazwy. Cały element, bo eNadawca może podawać pola (np. `guid`) jako atrybut
 * elementu albo jako element podrzędny: `wartosc` czyta oba kształty.
 */
export function bloki(xml: string, nazwa: string): string[] {
  if (!NAZWA_RE.test(nazwa)) return []
  const re = new RegExp(`<(?:[\\w.-]+:)?${nazwa}(?:\\s[^<>]*?)?(?:/>|>[\\s\\S]*?</(?:[\\w.-]+:)?${nazwa}>)`, 'g')
  return [...xml.matchAll(re)].map((m) => m[0])
}

/** Tekst pierwszego elementu-liścia o tej nazwie albo atrybutu o tej nazwie na pierwszym elemencie; null = brak. */
export function wartosc(xml: string, nazwa: string): string | null {
  if (!NAZWA_RE.test(nazwa)) return null
  const el = new RegExp(`<(?:[\\w.-]+:)?${nazwa}(?:\\s[^<>]*?)?>([^<]*)</(?:[\\w.-]+:)?${nazwa}>`).exec(xml)
  if (el) return dekoduj(el[1]!).trim()
  const at = new RegExp(`<[\\w.:-]+\\s[^<>]*?\\b${nazwa}="([^"]*)"`).exec(xml)
  return at ? dekoduj(at[1]!).trim() : null
}

export interface BladEnadawcy {
  numer: number | null
  opis: string
  guid: string | null
}

/** Elementy `error` (errorNumber, errorDesc, guid) w kolejności dokumentu. */
export function bledy(xml: string): BladEnadawcy[] {
  return bloki(xml, 'error')
    .map((b) => {
      const n = wartosc(b, 'errorNumber')
      return { numer: n !== null && /^-?\d+$/.test(n) ? Number(n) : null, opis: (wartosc(b, 'errorDesc') ?? '').slice(0, 300), guid: wartosc(b, 'guid') }
    })
    .filter((b) => b.numer !== null || b.opis)
}

/** Najwięcej bajtów odpowiedzi SOAP (etykieta PDF w base64 mieści się z zapasem); większa = błąd, nie czytamy dalej. */
export const MAKS_ODPOWIEDZI_PP = 10 * 1024 * 1024

/** Treść odpowiedzi z limitem rozmiaru (nagłówek Content-Length i liczenie bajtów strumienia); null = za duża. */
export async function tekstZLimitem(res: Response, maks = MAKS_ODPOWIEDZI_PP): Promise<string | null> {
  const dlugosc = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(dlugosc) && dlugosc > maks) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) return ''
  const czytnik = res.body.getReader()
  const kawalki: Uint8Array[] = []
  let razem = 0
  for (;;) {
    const { done, value } = await czytnik.read()
    if (done) break
    razem += value.byteLength
    if (razem > maks) {
      await czytnik.cancel().catch(() => {})
      return null
    }
    kawalki.push(value)
  }
  return Buffer.concat(kawalki).toString('utf8')
}

// ─── Połączenie ──────────────────────────────────────────────────────────────

class Polaczenie {
  constructor(
    readonly url: string,
    private readonly auth: LogowaniePP,
    readonly fetchImpl: FetchLike,
  ) {
    if (!auth.login || !auth.haslo) throw new Error('Brak loginu albo hasła eNadawcy')
    if (/[:\s]/.test(auth.login)) throw new Error('Zły login eNadawcy (bez dwukropka i spacji)')
  }

  clean(message: string): string {
    return [this.auth.haslo, escXml(this.auth.haslo), Buffer.from(`${this.auth.login}:${this.auth.haslo}`).toString('base64')].reduce((m, s) => (s ? m.split(s).join('***') : m), message)
  }

  wsse(): string {
    return (
      '<wsse:Security soap:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
      `<wsse:UsernameToken><wsse:Username>${escXml(this.auth.login)}</wsse:Username>` +
      `<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${escXml(this.auth.haslo)}</wsse:Password></wsse:UsernameToken></wsse:Security>`
    )
  }

  /** `redirect: 'error'`: przekierowanie zaniosłoby hasło pod inny adres. Basic tylko dla eNadawcy (WSSE ma hasło w kopercie). */
  init(ns: string, metoda: string, body: string, basic: boolean): RequestInit {
    const headers: Record<string, string> = { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${ns}/${metoda}"` }
    if (basic) headers['Authorization'] = `Basic ${Buffer.from(`${this.auth.login}:${this.auth.haslo}`).toString('base64')}`
    return { method: 'POST', redirect: 'error', headers, body }
  }
}

async function odczyt(conn: Polaczenie, ns: string, metoda: string, body: string, basic: boolean, timeoutMs: number, retry: RetryOptions, nazwa: string): Promise<string> {
  return withRetry(async () => {
    let res: Response
    try {
      res = await fetchWithTimeout(conn.fetchImpl, conn.url, conn.init(ns, metoda, body, basic), timeoutMs)
    } catch (e) {
      throw new SourceError(`${nazwa} ${metoda}: ${conn.clean(e instanceof Error ? e.message : String(e))}`, true)
    }
    const text = await tekstZLimitem(res).catch(() => '')
    if (text === null) throw new SourceError(`${nazwa} ${metoda}: odpowiedź większa niż ${MAKS_ODPOWIEDZI_PP / 1024 / 1024} MB`, false)
    if (res.status === 401 || res.status === 403) throw new SourceError(`${nazwa} ${metoda}: HTTP ${res.status}, zły login albo hasło`, false, res.status)
    if (res.status === 429 || res.status >= 500) {
      const f = blad(text)
      throw new SourceError(`${nazwa} ${metoda}: HTTP ${res.status}${f ? ` (${conn.clean(f)})` : ''}`, !f)
    }
    if (!res.ok) throw new SourceError(`${nazwa} ${metoda}: HTTP ${res.status}`, false)
    if (!text.trim()) throw new SourceError(`${nazwa} ${metoda}: pusta odpowiedź`, true)
    return text
  }, retry)
}

export interface OpcjePP {
  url: string
  auth: LogowaniePP
  fetchImpl?: FetchLike
  retry?: RetryOptions
  timeoutMs?: number
}

export class EnadawcaOdczyt {
  private readonly conn: Polaczenie
  constructor(private readonly o: OpcjePP) {
    if (!ENADAWCA_URL_RE.test(o.url)) throw new Error('Zły adres API eNadawcy (tylko adres produkcyjny albo testowy Poczty Polskiej)')
    this.conn = new Polaczenie(o.url, o.auth, o.fetchImpl ?? fetch)
  }

  async wywolaj(metoda: string, parametry: Readonly<Record<string, WezelXml>> = {}): Promise<string> {
    if (!(METODY_ODCZYTU_PP as readonly string[]).includes(metoda)) throw new ReadOnlyViolation(`eNadawca: metoda „${metoda}” nie jest dozwolona w trybie odczytu`)
    return odczyt(this.conn, ENADAWCA_NS, metoda, kopertaPP(ENADAWCA_NS, metoda, parametry), true, this.o.timeoutMs ?? 30_000, this.o.retry ?? { attempts: 3, baseDelayMs: 500 }, 'eNadawca')
  }
}

export class SledzenieOdczyt {
  private readonly conn: Polaczenie
  constructor(private readonly o: Omit<OpcjePP, 'url'>) {
    this.conn = new Polaczenie(SLEDZENIE_URL, o.auth, o.fetchImpl ?? fetch)
  }

  async sprawdzPrzesylke(numer: string): Promise<string> {
    const body = kopertaPP(SLEDZENIE_NS, 'sprawdzPrzesylke', { numer }, this.conn.wsse())
    return odczyt(this.conn, SLEDZENIE_NS, 'sprawdzPrzesylke', body, false, this.o.timeoutMs ?? 30_000, this.o.retry ?? { attempts: 3, baseDelayMs: 500 }, 'Śledzenie Poczty Polskiej')
  }
}

export type WynikZapisuPP = { ok: true; xml: string } | { ok: false; kind: FailureKind; message: string }

export class EnadawcaZapis {
  private readonly conn: Polaczenie
  private readonly timeoutMs: number

  constructor(o: OpcjePP & { wylacznik: true }) {
    if ((o as { wylacznik?: unknown }).wylacznik !== true) throw new Error('Zapis eNadawcy wyłączony: klient zapisu wymaga jawnego wyłącznika')
    if (!ENADAWCA_URL_RE.test(o.url)) throw new Error('Zły adres API eNadawcy (tylko adres produkcyjny albo testowy Poczty Polskiej)')
    this.conn = new Polaczenie(o.url, o.auth, o.fetchImpl ?? fetch)
    this.timeoutMs = o.timeoutMs ?? 60_000
  }

  /** Jedno żądanie bez ponawiania. 401/403 i Fault klienta = TRWALY; sieć, timeout, 5xx = NIEJEDNOZNACZNY; 429 = PRZEJSCIOWY. */
  async wywolaj(metoda: MetodaZapisuPP, parametry: Readonly<Record<string, WezelXml>>, timeoutMs = this.timeoutMs): Promise<WynikZapisuPP> {
    if (!(METODY_ZAPISU_PP as readonly string[]).includes(metoda)) throw new ReadOnlyViolation(`eNadawca: metoda „${metoda}” nie jest dozwolona dla zapisu`)
    const body = kopertaPP(ENADAWCA_NS, metoda, parametry)
    let res: Response
    try {
      res = await fetchWithTimeout(this.conn.fetchImpl, this.conn.url, this.conn.init(ENADAWCA_NS, metoda, body, true), timeoutMs)
    } catch (e) {
      const m = e instanceof SourceError ? this.conn.clean(e.message) : 'nieznany błąd'
      return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `eNadawca ${metoda}: ${m}; nie wiadomo, czy Poczta Polska wykonała żądanie` }
    }
    const text = await tekstZLimitem(res).catch(() => '')
    // za duża odpowiedź po wysłaniu: nie wiadomo, co Poczta wykonała
    if (text === null) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `eNadawca ${metoda}: odpowiedź większa niż ${MAKS_ODPOWIEDZI_PP / 1024 / 1024} MB; nie wiadomo, czy Poczta Polska wykonała żądanie` }
    if (res.status === 401 || res.status === 403) return { ok: false, kind: 'TRWALY', message: `eNadawca ${metoda}: HTTP ${res.status}, zły login albo hasło eNadawcy` }
    if (res.status >= 500 && faultKlienta(text)) return { ok: false, kind: 'TRWALY', message: `eNadawca ${metoda}: HTTP ${res.status}, Poczta Polska odrzuciła żądanie przed wykonaniem (${this.conn.clean(blad(text) ?? 'błąd SOAP')})` }
    if (res.status >= 500) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `eNadawca ${metoda}: HTTP ${res.status}; nie wiadomo, czy Poczta Polska wykonała żądanie` }
    if (res.status === 429) return { ok: false, kind: 'PRZEJSCIOWY', message: `eNadawca ${metoda}: HTTP 429` }
    if (!res.ok) return { ok: false, kind: 'TRWALY', message: `eNadawca ${metoda}: HTTP ${res.status}` }
    if (!text.trim()) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `eNadawca ${metoda}: pusta odpowiedź po wysłaniu` }
    return { ok: true, xml: text }
  }
}
