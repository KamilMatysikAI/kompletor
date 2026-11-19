// Orlen Paczka: klient SOAP 1.1 usługi WebServicePwR, kod własny Kompletora. Wiedza o API: dokumentacja
// Orlen Paczki „API ORLEN Paczka v1.26.004” (orlenpaczka.pl, 08.2026) i konektor Open Integration Platform
// (integrators/courier/orlenpaczka/v1.0.0/src/integration.py, commit ae43d1e, Apache-2.0, THIRD_PARTY_NOTICES.md).
//
// Dwa klienty o rozłącznych listach metod:
//   OrlenOdczyt — wyłącznie metody, które niczego nie tworzą ani nie zmieniają (stan konta, lista nadanych numerów,
//     status paczki); z ponawianiem przy sieci, 429 i 5xx. Metoda spoza listy = ReadOnlyViolation przed wysyłką.
//   OrlenZapis — powstaje tylko z jawnym `wylacznik: true` (adapter `orlenpaczka.zapis.v1` przy `zapisWlaczony`).
//     Nadanie (płatne), anulowanie i duplikat etykiety. Jedno żądanie, bez ponawiania: sieć, timeout i 5xx po wysłaniu
//     zwracają NIEJEDNOZNACZNY, bo drugie nadanie to druga płatna paczka.
// Sekrety (PartnerID, PartnerKey) idą w treści koperty; nie trafiają do komunikatów (`clean`). Treść odpowiedzi
// (może mieć dane odbiorcy) nie trafia do komunikatów błędów: tylko kody i stałe teksty.
import type { FailureKind } from '../adaptery/kontrakt'
import { fetchWithTimeout, ReadOnlyViolation, SourceError, withRetry, type FetchLike, type RetryOptions } from './http'

/** Adresy usługi z dokumentacji (pkt 3.1): produkcja i środowisko testowe. Inne adresy odrzucone. */
export const ORLEN_PROD = 'https://api.orlenpaczka.pl/WebServicePwRProd/WebServicePwR.asmx'
export const ORLEN_TEST = 'https://api-test.orlenpaczka.pl/WebServicePwR/WebServicePwR.asmx'
export const ORLEN_URL_RE = /^https:\/\/(api\.orlenpaczka\.pl\/WebServicePwRProd|api-test\.orlenpaczka\.pl\/WebServicePwR)\/WebServicePwR\.asmx$/

/** Przestrzeń nazw usługi (przykład odpowiedzi w dokumentacji, pkt 4.16) [NIEPEWNE: SOAPAction do potwierdzenia w WSDL]. */
export const ORLEN_NS = 'https://91.242.220.103/WebServicePwR'

export const METODY_ODCZYTU = ['GivePartnerStatus', 'GetGeneratedParcels', 'GiveMePackStatus'] as const
export const METODY_ZAPISU = ['GenerateBusinessPack', 'PutCustomerPackCanceled', 'LabelPrintDuplicateListTwo'] as const
export type MetodaOdczytu = (typeof METODY_ODCZYTU)[number]
export type MetodaZapisu = (typeof METODY_ZAPISU)[number]

export interface OrlenLogowanie {
  partnerId: string
  partnerKey: string
}

/** Wartość parametru koperty: tekst, liczba, lista (`<string>` w środku) albo brak (pole pominięte). */
export type ParametrSoap = string | number | boolean | readonly string[] | null | undefined

const XML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
export const escXml = (s: string) => s.replace(/[&<>"']/g, (c) => XML_ESC[c]!)
const NAZWA_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/

/** Koperta SOAP 1.1 z parametrami w kolejności podanej przez wołającego (ASMX czyta je po nazwach). */
export function koperta(metoda: string, parametry: Readonly<Record<string, ParametrSoap>>): string {
  if (!NAZWA_RE.test(metoda)) throw new Error('zła nazwa metody SOAP')
  const pola = Object.entries(parametry)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => {
      if (!NAZWA_RE.test(k)) throw new Error(`zła nazwa pola SOAP: ${k}`)
      if (Array.isArray(v)) return `<${k}>${v.map((x) => `<string>${escXml(String(x))}</string>`).join('')}</${k}>`
      return `<${k}>${escXml(String(v))}</${k}>`
    })
    .join('')
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soap:Body><${metoda} xmlns="${ORLEN_NS}">${pola}</${metoda}></soap:Body></soap:Envelope>`
  )
}

// ─── Odczyt odpowiedzi ───────────────────────────────────────────────────────
// Usługa zwraca DataSet .NET (schemat `xs:schema` + `diffgr:diffgram` z wierszami) albo zwykłe pola. Nie zależymy od
// nazw wierszy (różnią się między metodami i wersjami): czytamy „płaskie rekordy”, czyli elementy, których dziećmi są
// wyłącznie elementy z tekstem.

const ENCJE: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function dekoduj(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENCJE[e.toLowerCase()] ?? m
  })
}

/** Treść bez schematu DataSet (jego `xs:element name=…` nie są danymi). */
const bezSchematu = (xml: string) => xml.replace(/<(?:[\w.-]+:)?schema\b[\s\S]*?<\/(?:[\w.-]+:)?schema>/g, '')

const LISC = /<(?:[\w.-]+:)?([\w.-]+)(?:\s[^<>]*?)?(?:\/>|>([^<]*)<\/(?:[\w.-]+:)?\1>)/g
const REKORD = /<(?:[\w.-]+:)?([\w.-]+)(?:\s[^<>]*?)?>((?:\s*<(?:[\w.-]+:)?[\w.-]+(?:\s[^<>]*?)?(?:\/>|>[^<]*<\/(?:[\w.-]+:)?[\w.-]+>))+\s*)<\/(?:[\w.-]+:)?\1>/g

export type RekordSoap = Readonly<Record<string, string>>

/** Płaskie rekordy odpowiedzi w kolejności dokumentu (pierwsze wystąpienie pola w rekordzie wygrywa). */
export function rekordy(xml: string): RekordSoap[] {
  const out: RekordSoap[] = []
  for (const m of bezSchematu(xml).matchAll(REKORD)) {
    const r: Record<string, string> = {}
    for (const l of m[2]!.matchAll(LISC)) if (!(l[1]! in r)) r[l[1]!] = dekoduj(l[2] ?? '').trim()
    out.push(r)
  }
  return out
}

/** Tekst pierwszego elementu o tej nazwie (bez przedrostka przestrzeni nazw); null = brak. */
export function pole(xml: string, nazwa: string): string | null {
  if (!NAZWA_RE.test(nazwa)) return null
  const m = new RegExp(`<(?:[\\w.-]+:)?${nazwa}(?:\\s[^<>]*?)?(?:/>|>([^<]*)</(?:[\\w.-]+:)?${nazwa}>)`).exec(bezSchematu(xml))
  return m ? dekoduj(m[1] ?? '').trim() : null
}

/** Pierwszy rekord z kodem błędu `Err` (wynik metody); null = odpowiedź bez wyniku. */
export function rekordWyniku(xml: string): RekordSoap | null {
  return rekordy(xml).find((r) => 'Err' in r) ?? null
}

/** SOAP Fault (np. zła koperta): kod i opis bez treści żądania. */
export function blad(xml: string): string | null {
  if (!/<(?:[\w.-]+:)?Fault\b/.test(xml)) return null
  return (pole(xml, 'faultstring') ?? 'błąd SOAP').slice(0, 200)
}

/** Fault po stronie klienta: `faultcode` SOAP 1.1 `…:Client` albo `Value` SOAP 1.2 `…:Sender`. */
export function faultKlienta(xml: string): boolean {
  if (!/<(?:[\w.-]+:)?Fault\b/.test(xml)) return false
  const kod = (pole(xml, 'faultcode') ?? pole(xml, 'Value') ?? '').trim()
  return /^(?:[\w.-]+:)?(?:Client|Sender)(?:\.[\w.]+)?$/.test(kod)
}

// ─── Połączenie ──────────────────────────────────────────────────────────────

export class OrlenPolaczenie {
  constructor(
    readonly url: string,
    private readonly auth: OrlenLogowanie,
    readonly fetchImpl: FetchLike,
  ) {
    if (!auth.partnerId || !auth.partnerKey) throw new Error('Brak PartnerID albo PartnerKey Orlen Paczki')
    if (!/^[A-Za-z0-9._-]{1,30}$/.test(auth.partnerId)) throw new Error('Zły PartnerID Orlen Paczki (litery i cyfry)')
    if (!ORLEN_URL_RE.test(url)) throw new Error('Zły adres API Orlen Paczki (tylko adres produkcyjny albo testowy z dokumentacji)')
  }

  /** Bez wartości sekretów, nawet gdy trafią do komunikatu biblioteki sieciowej. */
  clean(message: string): string {
    return [this.auth.partnerKey, escXml(this.auth.partnerKey), this.auth.partnerId].reduce((m, s) => (s ? m.split(s).join('***') : m), message)
  }

  /** Parametry z logowaniem na początku (jak w przykładach dokumentacji). */
  zLogowaniem(p: Readonly<Record<string, ParametrSoap>>): Record<string, ParametrSoap> {
    return { PartnerID: this.auth.partnerId, PartnerKey: this.auth.partnerKey, ...p }
  }

  /** `redirect: 'error'`: przekierowanie zaniosłoby kopertę z kluczem pod inny adres. */
  init(metoda: string, body: string): RequestInit {
    return { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${ORLEN_NS}/${metoda}"` }, body }
  }
}

export function assertOrlenOdczyt(metoda: string): asserts metoda is MetodaOdczytu {
  if (!(METODY_ODCZYTU as readonly string[]).includes(metoda)) throw new ReadOnlyViolation(`Orlen Paczka: metoda „${metoda}” nie jest dozwolona w trybie odczytu`)
}

export interface OpcjeOdczytu {
  url: string
  auth: OrlenLogowanie
  fetchImpl?: FetchLike
  retry?: RetryOptions
  timeoutMs?: number
}

export class OrlenOdczyt {
  private readonly conn: OrlenPolaczenie
  private readonly retry: RetryOptions
  private readonly timeoutMs: number

  constructor(o: OpcjeOdczytu) {
    this.conn = new OrlenPolaczenie(o.url, o.auth, o.fetchImpl ?? fetch)
    this.retry = o.retry ?? { attempts: 3, baseDelayMs: 500 }
    this.timeoutMs = o.timeoutMs ?? 30_000
  }

  /** Treść odpowiedzi (XML). Błąd: SourceError z `retryable` (sieć, 429, 5xx) albo bez (4xx, Fault, pusta odpowiedź). */
  async wywolaj(metoda: string, parametry: Readonly<Record<string, ParametrSoap>> = {}): Promise<string> {
    assertOrlenOdczyt(metoda)
    const body = koperta(metoda, this.conn.zLogowaniem(parametry))
    return withRetry(async () => {
      let res: Response
      try {
        res = await fetchWithTimeout(this.conn.fetchImpl, this.conn.url, this.conn.init(metoda, body), this.timeoutMs)
      } catch (e) {
        throw new SourceError(`Orlen Paczka ${metoda}: ${this.conn.clean(e instanceof Error ? e.message : String(e))}`, true)
      }
      const text = await res.text().catch(() => '')
      if (res.status === 429 || res.status >= 500) {
        // ASMX zwraca Fault z HTTP 500: zła koperta nie przejdzie po ponowieniu
        const f = blad(text)
        throw new SourceError(`Orlen Paczka ${metoda}: HTTP ${res.status}${f ? ` (${this.conn.clean(f)})` : ''}`, !f)
      }
      if (!res.ok) throw new SourceError(`Orlen Paczka ${metoda}: HTTP ${res.status}`, false)
      if (!text.trim()) throw new SourceError(`Orlen Paczka ${metoda}: pusta odpowiedź`, true)
      return text
    }, this.retry)
  }
}

export type WynikZapisuOrlen = { ok: true; xml: string } | { ok: false; kind: FailureKind; message: string }

export interface OpcjeZapisu {
  url: string
  auth: OrlenLogowanie
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** Jawna zgoda wołającego; bez niej klient nie powstaje. */
  wylacznik: true
}

export class OrlenZapis {
  private readonly conn: OrlenPolaczenie
  private readonly timeoutMs: number

  constructor(o: OpcjeZapisu) {
    if ((o as { wylacznik?: unknown }).wylacznik !== true) throw new Error('Zapis Orlen Paczki wyłączony: klient zapisu wymaga jawnego wyłącznika')
    this.conn = new OrlenPolaczenie(o.url, o.auth, o.fetchImpl ?? fetch)
    this.timeoutMs = o.timeoutMs ?? 60_000
  }

  /**
   * Jedno żądanie, bez ponawiania. Metoda spoza listy (zamówienie kuriera, protokół, zwroty, tworzenie klienta) =
   * wyjątek przed wysyłką. Sieć, timeout i 5xx = NIEJEDNOZNACZNY (nie wiadomo, czy Orlen wykonał żądanie); 429 =
   * PRZEJSCIOWY; inne 4xx = TRWALY. O sensie wyniku (kod `Err`) decyduje adapter.
   */
  async wywolaj(metoda: MetodaZapisu, parametry: Readonly<Record<string, ParametrSoap>>, timeoutMs = this.timeoutMs): Promise<WynikZapisuOrlen> {
    if (!(METODY_ZAPISU as readonly string[]).includes(metoda)) throw new ReadOnlyViolation(`Orlen Paczka: metoda „${metoda}” nie jest dozwolona dla zapisu`)
    const body = koperta(metoda, this.conn.zLogowaniem(parametry))
    let res: Response
    try {
      res = await fetchWithTimeout(this.conn.fetchImpl, this.conn.url, this.conn.init(metoda, body), timeoutMs)
    } catch (e) {
      const m = e instanceof SourceError ? this.conn.clean(e.message) : 'nieznany błąd'
      return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `Orlen Paczka ${metoda}: ${m}; nie wiadomo, czy Orlen wykonał żądanie` }
    }
    const text = await res.text().catch(() => '')
    // Fault klienta (SOAP 1.1 `Client`, SOAP 1.2 `Sender`) to zła koperta albo SOAPAction, odrzucona
    // przed wykonaniem metody (SOAP 1.1 pkt 4.4.1: „nie wysyłać ponownie bez zmian”); dokumentacja Orlenu Faultów nie
    // opisuje. Fault serwera i 5xx bez Faultu zostają NIEJEDNOZNACZNY.
    if (res.status >= 500 && faultKlienta(text)) return { ok: false, kind: 'TRWALY', message: `Orlen Paczka ${metoda}: HTTP ${res.status}, Orlen odrzucił żądanie przed wykonaniem (${this.conn.clean(blad(text) ?? 'błąd SOAP')})` }
    if (res.status >= 500) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `Orlen Paczka ${metoda}: HTTP ${res.status}; nie wiadomo, czy Orlen wykonał żądanie` }
    if (res.status === 429) return { ok: false, kind: 'PRZEJSCIOWY', message: `Orlen Paczka ${metoda}: HTTP 429` }
    if (!res.ok) return { ok: false, kind: 'TRWALY', message: `Orlen Paczka ${metoda}: HTTP ${res.status}` }
    if (!text.trim()) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `Orlen Paczka ${metoda}: pusta odpowiedź po wysłaniu` }
    return { ok: true, xml: text }
  }
}
