// DPD Polska bezpośrednio — klient ZAPISU DPDServices za wyłącznikiem. Konstruktor wymaga jawnego
// `wylacznik: true`, a tworzy go tylko adapter `dpd.services.zapis.v1` przy `zapisWlaczony: true` w konfiguracji firmy;
// host dziś go nie woła. Dozwolone wyłącznie `generatePackagesNumbers` (numery listów, kosztuje) i `generateSpedLabels`
// (etykieta). Bez ponawiania: timeout, błąd sieci i 5xx po wysłaniu to NIEJEDNOZNACZNY, bo DPD nie ma odczytu paczki
// po referencji [NIEPEWNE] i ponowienie mogłoby utworzyć drugą paczkę. Treść odpowiedzi nie trafia do komunikatów.
import type { FailureKind } from '../adaptery/kontrakt'
import { czyStronaZapory, DPD_ZAPORA, DpdPolaczenie, type DpdLogowanie } from './dpd'
import { fetchWithTimeout, ReadOnlyViolation, SourceError, type FetchLike } from './http'

/** Najdłuższy powód odmowy w komunikacie; przycinany dopiero po wycięciu wartości z żądania oraz loginu i hasła. */
export const POWOD_MAX = 300

/** Pole słownikowe (nazwa pola, kod błędu, status): krótki identyfikator, bez spacji i `@`. */
const SLOWNIKOWE = /^[\w.[\]-]{1,80}$/

/**
 * Opis błędu z odpowiedzi DPD przy odmowie (HTTP 4xx): `errors[]`, `packages[].validationInfo[]` albo pojedyncze pola
 * (np. `status: DISALLOWED_FID`); brak JSON-u = null. Pola słownikowe (`field`, `code`, `errorCode`, `status`) idą po
 * wycięciu wartości z żądania. Pola wolnotekstowe (`userMessage`, `message`, `info`, `error`, `detail`, `title`) idą
 * tylko wtedy, gdy po wycięciu nie mają cyfr ani `@`: DPD odsyła dane odbiorcy po swojej normalizacji (telefon bez
 * prefiksu, kod bez kreski), więc samo wycinanie nie wystarcza. Bez przycinania: robi to `powodOdmowy`.
 */
export function powodOdmowyDpd(text: string, body?: unknown): string | null {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  if (!j || typeof j !== 'object') return null
  const o = j as Record<string, unknown>
  const wartosci = wartosciZadania(body)
  const surowy = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 500).replace(/\s+/g, ' ').trim() : '')
  const slownik = (v: unknown) => {
    const s = surowy(v)
    return SLOWNIKOWE.test(s) ? maskuj(s, wartosci) : wolny(s)
  }
  const wolny = (v: unknown) => {
    const s = maskuj(surowy(v), wartosci)
    return /[\d@]/.test(s) ? '' : s
  }
  const czesci: string[] = []
  const dodaj = (c: string) => {
    if (c && !czesci.includes(c)) czesci.push(c)
  }
  const errors = Array.isArray(o['errors']) ? o['errors'] : []
  for (const e of errors.slice(0, 6)) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    dodaj([slownik(r['field']), slownik(r['code']), wolny(r['userMessage']) || wolny(r['message'])].filter(Boolean).join(': '))
  }
  const paczki = Array.isArray(o['packages']) ? o['packages'] : []
  for (const pk of paczki.slice(0, 2)) {
    const info = pk && typeof pk === 'object' && Array.isArray((pk as Record<string, unknown>)['validationInfo']) ? ((pk as Record<string, unknown>)['validationInfo'] as unknown[]) : []
    for (const v of info.slice(0, 6)) {
      if (!v || typeof v !== 'object') continue
      const r = v as Record<string, unknown>
      dodaj([slownik(r['errorCode']), wolny(r['info'])].filter(Boolean).join(': '))
    }
  }
  // zamówienie kuriera odsyła `status` jako obiekt { status, errorDetails[{ code, fields, description }] }
  const st = o['status'] && typeof o['status'] === 'object' && !Array.isArray(o['status']) ? (o['status'] as Record<string, unknown>) : null
  if (st) {
    dodaj(slownik(st['status']))
    const det = Array.isArray(st['errorDetails']) ? st['errorDetails'] : []
    for (const e of det.slice(0, 6)) {
      if (!e || typeof e !== 'object') continue
      const d = e as Record<string, unknown>
      // `fields` wg specyfikacji to tekst („pickupTimeFrom / pickupTimeTo”); tablicę też przyjmujemy (starsze odpowiedzi)
      const pola = Array.isArray(d['fields']) ? (d['fields'] as unknown[]).map(slownik).filter(Boolean).join(' / ') : slownik(d['fields'])
      dodaj([pola, slownik(d['code']), wolny(d['description'])].filter(Boolean).join(': '))
    }
  }
  for (const k of ['status', 'code']) dodaj(slownik(o[k]))
  for (const k of ['error', 'message', 'userMessage', 'detail', 'title']) dodaj(wolny(o[k]))
  const wynik = czesci.join('; ')
  return wynik || null
}

/**
 * ślad utworzenia w odpowiedzi odmownej. Specyfikacja DPD dla 400 `generatePackagesNumbers` podaje ten sam
 * schemat co dla 200 (`packages[].parcels[].waybill`), więc 4xx z numerem listu (albo numerem zlecenia kuriera) nie
 * wyklucza, że coś powstało.
 */
export function czySladUtworzenia(text: string): boolean {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return false
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return false
  const o = j as Record<string, unknown>
  const niepusty = (v: unknown) => (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && v > 0)
  // (drobne z przeglądu 2529bcbc): `orderNumber: '0'` (same zera) to nie numer zlecenia, tylko pusta wartość
  const numerZlecenia = (v: unknown) => (typeof v === 'string' && !/^\s*0*\s*$/.test(v)) || (typeof v === 'number' && v > 0)
  if (numerZlecenia(o['orderNumber'])) return true
  const paczki = Array.isArray(o['packages']) ? o['packages'] : []
  return paczki.some((pk) => {
    if (!pk || typeof pk !== 'object') return false
    const p = pk as Record<string, unknown>
    if (niepusty(p['packageId'])) return true
    const parcels = Array.isArray(p['parcels']) ? p['parcels'] : []
    return parcels.some((x) => !!x && typeof x === 'object' && (niepusty((x as Record<string, unknown>)['waybill']) || niepusty((x as Record<string, unknown>)['parcelId'])))
  })
}

/**
 * Powód odmowy do komunikatu: opis błędu DPD (albo opis odpowiedzi bez opisu), z wyciętymi wartościami żądania
 * i sekretami, przycięty do `POWOD_MAX` na końcu. Kolejność ważna: przycięcie przed wycięciem zostawiłoby urwany
 * e-mail albo telefon, którego pełna wartość już nie pasuje.
 */
export function powodOdmowy(res: Response, tresc: string, body: unknown, clean: (s: string) => string): string {
  // login i hasło wycinane przed wartościami żądania (zakrycie części loginu zostawiłoby resztę) i drugi raz na końcu
  const czysta = clean(tresc)
  const powod = powodOdmowyDpd(czysta, body) ?? bezWartosciZadania(opisOdpowiedziBezOpisu(res, czysta), body)
  return clean(powod).slice(0, POWOD_MAX)
}

/**
 * Wynik odmowy HTTP 4xx (bez 429), wspólny dla zapisu przesyłki i zamówienia kuriera. Strona zapory i odpowiedź ze
 * śladem utworzenia to NIEJEDNOZNACZNY (jak przy 200), reszta TRWALY z powodem.
 */
/**
 * statusy zamówienia kuriera (`status.status`), które według specyfikacji znaczą „nie przyjęto”: taka odmowa
 * jest pewna także wtedy, gdy odpowiedź ma pole `orderNumber` (DPD odsyła je w odmowie walidacji godzin podjazdu).
 */
const STATUSY_PEWNEJ_ODMOWY_KURIERA = new Set(['VALIDATION_ERROR', 'DISALLOWED_FID', 'DISABLED_API', 'NOT_FOUND'])

/** Status zamówienia kuriera z listy pewnych odmów (`STATUSY_PEWNEJ_ODMOWY_KURIERA`). */
export function czyPewnyStatusOdmowyKuriera(status: string): boolean {
  return STATUSY_PEWNEJ_ODMOWY_KURIERA.has(status)
}

export function czyPewnaOdmowaKuriera(text: string): boolean {
  try {
    const j: unknown = JSON.parse(text)
    const st = j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>)['status'] : null
    const kod = st && typeof st === 'object' && !Array.isArray(st) ? (st as Record<string, unknown>)['status'] : null
    return typeof kod === 'string' && STATUSY_PEWNEJ_ODMOWY_KURIERA.has(kod)
  } catch {
    return false
  }
}

export function wynikOdmowyDpd(res: Response, tresc: string, body: unknown, clean: (s: string) => string, opis: { odmowa: string; zapora: string; slad: string; pewnaOdmowa?: (tresc: string) => boolean }): WynikZapisuDpd {
  if (czyStronaZapory(tresc)) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `${opis.zapora} (HTTP ${res.status})` }
  const powod = powodOdmowy(res, tresc, body, clean)
  // powód zostaje także przy śladzie utworzenia (odmowa walidacji z numerem w odpowiedzi ma być do naprawienia)
  if (czySladUtworzenia(tresc) && !opis.pewnaOdmowa?.(tresc)) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `${opis.slad} (HTTP ${res.status}${powod ? `, ${powod}` : ''})` }
  return { ok: false, kind: 'TRWALY', message: `${opis.odmowa}: HTTP ${res.status}${powod ? ` (${powod})` : ''}` }
}

/**
 * Odmowa bez rozpoznanego opisu błędu: typ treści, nagłówek serwera i, dla JSON-u, same nazwy pól wierzchu. Treści
 * odpowiedzi nie przepisujemy: DPD potrafi odesłać w niej dane odbiorcy z żądania.
 */
export function opisOdpowiedziBezOpisu(res: Response, text: string): string {
  const typ = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
  const serwer = (res.headers.get('server') ?? '').trim().slice(0, 40)
  let pola = ''
  try {
    const j: unknown = JSON.parse(text)
    if (j && typeof j === 'object' && !Array.isArray(j)) pola = Object.keys(j).slice(0, 8).join(', ').slice(0, 120)
  } catch {
    pola = ''
  }
  return [typ ? `typ ${typ}` : 'bez typu treści', serwer ? `serwer ${serwer}` : '', pola ? `pola odpowiedzi: ${pola}` : text.trim() ? 'treść pominięta' : 'pusta treść'].filter(Boolean).join(', ')
}

/** Klucze żądania ze stałymi słownikowymi (usługa, atrybut, polityka, kraj): ich wartości nie są danymi odbiorcy. */
const KLUCZE_SLOWNIKOWE = new Set(['code', 'countryCode', 'generationPolicy', 'policy', 'type', 'outputDocFormat', 'format', 'outputType', 'variant'])

/**
 * Wartości tekstowe i liczbowe z treści żądania (odbiorca, nadawca, referencja): wycinane z opisu błędu, gdyby DPD je
 * odesłał. Pomijane: stałe słownikowe (`DPD_PICKUP`, `PUDO`, `ALL_OR_NOTHING`) i liczby do 4 cyfr (waga, wymiary).
 */
function wartosciZadania(body: unknown, out: string[] = [], klucz = ''): string[] {
  if (typeof body === 'string' || typeof body === 'number') {
    const s = String(body).trim()
    if (KLUCZE_SLOWNIKOWE.has(klucz) && /^[A-Z][A-Z0-9_]*$/.test(s)) return out
    if (/^\d{1,4}([.,]\d+)?$/.test(s)) return out
    if (normalizuj(s).n.length >= 3) out.push(s)
    // DPD potrafi odesłać samo nazwisko albo samą ulicę: każde słowo od 4 liter osobno
    if (typeof body === 'string' && /\s/.test(s)) for (const t of s.split(/\s+/)) if (/\p{L}/u.test(t) && normalizuj(t).n.length >= 4) out.push(t)
  } else if (Array.isArray(body)) for (const v of body) wartosciZadania(v, out, klucz)
  else if (body && typeof body === 'object') for (const [k, v] of Object.entries(body)) wartosciZadania(v, out, k)
  return out
}

/** Znaki pomijane przy porównaniu: DPD odsyła telefon bez spacji i plusa, kod pocztowy bez kreski. */
const POMIJANE = /[\s\-+().,/\\'"]/

/** Postać do porównania: małe litery, bez polskich znaków i separatorów; `pos[i]` = indeks znaku w oryginale. */
function normalizuj(s: string): { n: string; pos: number[] } {
  let n = ''
  const pos: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (POMIJANE.test(c)) continue
    const z = c.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '')
    for (const x of z) {
      n += x
      pos.push(i)
    }
  }
  return { n, pos }
}

/** Zakrywa `***` każde wystąpienie wartości z żądania, także po normalizacji DPD (wielkie litery, bez separatorów). */
function maskuj(opis: string, wartosci: readonly string[]): string {
  if (!opis || !wartosci.length) return opis
  const { n, pos } = normalizuj(opis)
  const zakryte = new Array<boolean>(opis.length).fill(false)
  for (const w of wartosci) {
    const nw = normalizuj(w).n
    if (nw.length < 3) continue
    for (let i = n.indexOf(nw); i >= 0; i = n.indexOf(nw, i + 1)) for (let k = pos[i]!; k <= pos[i + nw.length - 1]!; k++) zakryte[k] = true
  }
  let out = ''
  for (let i = 0; i < opis.length; i++) {
    if (!zakryte[i]) out += opis[i]
    else if (i === 0 || !zakryte[i - 1]) out += '***'
  }
  return out
}

export const bezWartosciZadania = (opis: string, body: unknown): string => maskuj(opis, wartosciZadania(body))

export const DPD_SCIEZKA_NUMERY = '/public/shipment/v1/generatePackagesNumbers'
export const DPD_SCIEZKA_ETYKIETY = '/public/shipment/v1/generateSpedLabels'
const WRITE_PATHS = new Set([DPD_SCIEZKA_NUMERY, DPD_SCIEZKA_ETYKIETY])

export type WynikZapisuDpd = { ok: true; body: unknown } | { ok: false; kind: FailureKind; message: string }

export interface OpcjeZapisuDpd {
  baseUrl: string
  auth: DpdLogowanie
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** Jawna zgoda wołającego; bez niej klient nie powstaje. */
  wylacznik: true
}

export class DpdZapis {
  private readonly conn: DpdPolaczenie
  private readonly timeoutMs: number

  constructor(o: OpcjeZapisuDpd) {
    if ((o as { wylacznik?: unknown }).wylacznik !== true) throw new Error('Zapis DPD wyłączony: klient zapisu wymaga jawnego wyłącznika')
    this.conn = new DpdPolaczenie(o.baseUrl, o.auth, o.fetchImpl ?? fetch)
    this.timeoutMs = o.timeoutMs ?? 60_000
  }

  /** Jedno żądanie, bez ponawiania. Ścieżka spoza listy (protokół, kurier, dopisanie paczek) = wyjątek przed wysyłką. */
  async post(path: string, body: unknown): Promise<WynikZapisuDpd> {
    if (!WRITE_PATHS.has(path)) throw new ReadOnlyViolation(`DPD: ścieżka „${path}” nie jest dozwolona dla zapisu`)
    let res: Response
    try {
      res = await fetchWithTimeout(this.conn.fetchImpl, this.conn.url(path), this.conn.init(body), this.timeoutMs)
    } catch (e) {
      const m = e instanceof SourceError ? this.conn.clean(e.message) : 'nieznany błąd'
      return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `DPD ${path}: ${m}; nie wiadomo, czy DPD wykonał żądanie` }
    }
    if (res.status >= 500) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `DPD ${path}: HTTP ${res.status}; nie wiadomo, czy DPD wykonał żądanie` }
    if (res.status === 429) return { ok: false, kind: 'PRZEJSCIOWY', message: `DPD ${path}: HTTP 429` }
    if (!res.ok) {
      // powód odmowy z odpowiedzi DPD (pola `errors[].field`, `userMessage`, `code`), żeby 403 i 400 dało się
      // naprawić bez zgadywania. Tylko opis błędu z JSON-u, nigdy surowa treść; bez wartości z żądania, loginu i hasła.
      // Bez opisu błędu (pusta treść, nieznany kształt) typ odpowiedzi i serwer mówią, kto odmówił.
      const tresc = await res.text().catch(() => '')
      return wynikOdmowyDpd(res, tresc, body, (s) => this.conn.clean(s), {
        odmowa: `DPD ${path}`,
        zapora: `DPD ${path}: ${DPD_ZAPORA}; sprawdź w panelu DPD, czy paczka nie powstała`,
        slad: `DPD ${path}: odmowa z numerem listu w odpowiedzi; sprawdź w panelu DPD, czy paczka nie powstała`,
      })
    }
    const text = await res.text().catch(() => '')
    try {
      return { ok: true, body: JSON.parse(text) as unknown }
    } catch {
      // strona zapory (WAF przed DPD). Zwykle zatrzymuje żądanie, ale ta sama strona może zasłonić odpowiedź
      // po wykonaniu zapisu, więc ostrożnie: NIEJEDNOZNACZNY (człowiek sprawdza w panelu DPD), nigdy cicha druga paczka.
      if (czyStronaZapory(text)) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `DPD ${path}: ${DPD_ZAPORA}; sprawdź w panelu DPD, czy paczka nie powstała` }
      return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `DPD ${path}: nieczytelna odpowiedź po wysłaniu` }
    }
  }
}
