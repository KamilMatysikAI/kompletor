// wFirma API2 — klient ZAPISU faktur, dokumentów WZ bez faktury i korekt faktur
// przy zwrocie (ta sama ścieżka `invoices/add` z typem korekty, lib/wfirma/korekta-zapis.ts). Jedyny plik
// w repo z dozwoloną ścieżką zapisu wFirmy. Wyłącznie ścieżki z WRITE_RULES (wystawienie faktury, pobranie jej PDF,
// wystawienie WZ); inne = błąd przed wysłaniem. Jedyny wyjątek: usunięcie faktury roboczej próby (`usunFaktureRobocza`,
// osobna reguła, odczyt i sprawdzenie dokumentu tuż przed żądaniem). Odczyty
// (`invoices/find`, WZ) idą dalej przez `WfirmaReadOnly` ze strażnikiem odczytu.
//
// Wystawienie NIGDY nie jest ponawiane w kliencie: o drugiej próbie decyduje rdzeń po `invoices/find` z prefiksem
// `id_external` (lib/rdzen/rozchod.ts, `resolveUnknownInvoices`). Klasyfikacja wyniku dla rdzenia:
//   OK      — wFirma zwróciła id dokumentu,
//   ERROR   — wFirma jednoznacznie odrzuciła dokument (status ERROR, HTTP 4xx): dokument nie powstał,
//   LIMIT   — HTTP 429 albo kod z „LIMIT”: odrzucone przed przetworzeniem, kolejka firmy się wstrzymuje,
//   TIMEOUT — wszystko inne (sieć, timeout, 5xx, nieczytelna odpowiedź, OK bez id): nie wiadomo, czy powstał.
// Treści odpowiedzi nie logujemy (może nieść dane kontrahenta); komunikat błędu to kody i nazwy pól, przycięte.
import { fetchWithTimeout, ReadOnlyViolation, SourceError, Throttle, type FetchLike } from './http'
import type { WfirmaKeys } from './wfirma'

const BASE = 'https://api2.wfirma.pl'

const WRITE_RULES: readonly RegExp[] = [/^invoices\/add$/, /^invoices\/download\/\d+$/, /^warehouse_documents\/add$/]

/**
 * Usuwanie dokumentu: jedna ścieżka, poza WRITE_RULES i poza `post`, dostępna wyłącznie przez `usunFaktureRobocza`, która
 * tuż przed żądaniem czyta dokument i odmawia wszystkiego, co nie jest fakturą roboczą próby (`normal_draft`, numer pusty
 * albo z numeracji roboczych „WRF n”, `id_external` z prefiksem `PREFIKS_ROBOCZEJ`). Żadna inna metoda klienta nie usuwa
 * dokumentów.
 */
const REGULA_USUWANIA_ROBOCZEJ = /^invoices\/delete\/\d+$/

/**
 * Najdłuższy `id_external`, jaki wFirma zapisuje bez obcięcia: dłuższy wraca obcięty do 32 znaków (odczyt prawdziwej
 * faktury roboczej 15.11.2026), więc wyszukanie po pełnej wartości przestaje go znajdować.
 */
export const MAX_ID_EXTERNAL = 32
/**
 * Prefiks `id_external` faktury roboczej próby: `pr/<orderId>` (cuid zamówienia 25 znaków = 28 znaków). Nigdy format
 * faktury paczki `<orderId>/<paczka>/<próba>` (cuid zaczyna się literą „c”), korekty `zwrot/…` ani WZ `wz/…`.
 */
export const PREFIKS_ROBOCZEJ = 'pr/'
/**
 * Prefiks z pierwszej próby (`proba-robocza/<orderId>`, 39 znaków, w wFirmie obcięty do 32). Nowych roboczych z nim nie
 * wystawiamy; uznawany wyłącznie przy usuwaniu i odczycie, gdy reszta wskazuje dokładnie jedno zamówienie tej firmy.
 */
export const PREFIKS_ROBOCZEJ_STARY = 'proba-robocza/'
/** Typ faktury roboczej VAT w wFirmie (nie zajmuje numeru w serii faktur, nie idzie do KSeF). */
export const TYP_ROBOCZEJ = 'normal_draft'
/** Numeracja roboczych wFirmy, osobna od serii faktur (np. „WRF 15”). */
const NUMER_ROBOCZEJ = /^WRF \d+(\/\d+)*$/

/** Numer pusty albo z numeracji roboczych („WRF n”); numer w każdym innym kształcie = dokument w serii faktur. */
export const numerRoboczej = (numer: string | null) => numer === null || NUMER_ROBOCZEJ.test(numer)

/** Pola kontrolne dokumentu z `invoices/get/<id>` (bez danych nabywcy). */
export interface DokumentKontrolny {
  id: string
  typ: string
  numer: string | null
  idExternal: string
}

/** Pola kontrolne z odpowiedzi `invoices/get/<id>`; null = odpowiedź bez dokumentu. */
export function dokumentKontrolny(json: unknown): DokumentKontrolny | null {
  for (const [k, v] of Object.entries(obj(obj(json)['invoices']))) {
    if (k === 'parameters') continue
    const inv = obj(obj(v)['invoice'])
    const id = inv['id'] === undefined || inv['id'] === null ? '' : String(inv['id'])
    if (!/^\d+$/.test(id) || id === '0') continue
    const numer = typeof inv['fullnumber'] === 'string' && inv['fullnumber'].trim() ? inv['fullnumber'].trim() : null
    return { id, typ: typeof inv['type'] === 'string' ? inv['type'] : '', numer, idExternal: typeof inv['id_external'] === 'string' ? inv['id_external'] : '' }
  }
  return null
}

/** Dokument roboczy: typ `normal_draft` i numer pusty albo z numeracji roboczych. */
export function jestRobocza(d: DokumentKontrolny | null): boolean {
  return !!d && d.typ === TYP_ROBOCZEJ && numerRoboczej(d.numer)
}

/** Czy dokument jest fakturą roboczą próby: `jestRobocza` i `id_external` `pr/<…>` w limicie długości wFirmy. */
export function jestRoboczaProby(d: DokumentKontrolny | null): boolean {
  return !!d && jestRobocza(d) && d.idExternal.startsWith(PREFIKS_ROBOCZEJ) && d.idExternal.length > PREFIKS_ROBOCZEJ.length && d.idExternal.length <= MAX_ID_EXTERNAL
}

/** Sprawdzenie roboczej w starym formacie (`proba-robocza/…`): czy reszta wskazuje dokładnie jedno zamówienie firmy. */
export type StaraRoboczaProby = (idExternal: string) => Promise<boolean>

export type WynikUsuniecia = { kind: 'USUNIETA'; dokument: DokumentKontrolny } | { kind: 'ODMOWA'; message: string; dokument: DokumentKontrolny | null } | { kind: 'BLAD'; message: string }

const LIMIT = /LIMIT/i

export type WynikWystawienia =
  | { kind: 'OK'; id: string; numer: string | null }
  | { kind: 'ERROR'; message: string }
  | { kind: 'LIMIT'; message: string; retryAfterMs?: number }
  | { kind: 'TIMEOUT'; message: string }

/** Sekundy z nagłówka Retry-After (liczba) → ms; inaczej brak. */
function retryAfter(res: Response): number | undefined {
  const v = Number(res.headers.get('retry-after'))
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : undefined
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/**
 * Błędy walidacji wFirmy z odpowiedzi `invoices/add` (pole + komunikat), bez wartości pól. wFirma oddaje je
 * w `invoices.0.invoice.errors` jako kolekcję `{ "0": { error: { field, message } } }`.
 */
export function bledyWalidacji(json: unknown, modul: 'invoices' | 'warehouse_documents' = 'invoices'): string[] {
  const out: string[] = []
  const zbierz = (v: unknown, glebokosc: number) => {
    if (glebokosc > 6 || !v || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'error') {
        const e = obj(x)
        const pole = typeof e['field'] === 'string' ? e['field'] : ''
        const msg = typeof e['message'] === 'string' ? e['message'] : ''
        if (pole || msg) out.push(maskujDane(`${pole ? `${pole}: ` : ''}${msg}`).slice(0, 160))
        continue
      }
      zbierz(x, glebokosc + 1)
    }
  }
  zbierz(obj(json)[modul], 0)
  return [...new Set(out)].slice(0, 8)
}

/**
 * komunikat walidacji wFirmy może zacytować wartość pola (NIP, e-mail, telefon, kod).
 * Trafia do bazy, alertu i na kartę, więc adresy e-mail i ciągi co najmniej 7 cyfr (z odstępami i myślnikami) → „…”.
 */
export function maskujDane(t: string): string {
  return t.replace(/[^\s@,;()]+@[^\s@,;()]+/g, '…').replace(/\+?\d[\d\s-]{5,}\d/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '…' : m))
}

/** Id i numer faktury z odpowiedzi `invoices/add` (`invoices.0.invoice.{id, fullnumber}`). */
export function fakturaZOdpowiedzi(json: unknown): { id: string; numer: string | null } | null {
  return dokumentZOdpowiedzi(json, 'invoices', 'invoice')
}

/** id i numer WZ z odpowiedzi `warehouse_documents/add` (`warehouse_documents.0.warehouse_document.{id, fullnumber}`). */
export function wzZOdpowiedzi(json: unknown): { id: string; numer: string | null } | null {
  return dokumentZOdpowiedzi(json, 'warehouse_documents', 'warehouse_document')
}

function dokumentZOdpowiedzi(json: unknown, modul: string, klucz: string): { id: string; numer: string | null } | null {
  for (const [k, v] of Object.entries(obj(obj(json)[modul]))) {
    if (k === 'parameters') continue
    const inv = obj(obj(v)[klucz])
    const id = inv['id'] === undefined || inv['id'] === null ? '' : String(inv['id'])
    if (/^\d+$/.test(id) && id !== '0') return { id, numer: typeof inv['fullnumber'] === 'string' && inv['fullnumber'].trim() ? inv['fullnumber'].trim() : null }
  }
  return null
}

export class WfirmaZapis {
  private readonly throttle: Throttle

  constructor(
    private readonly keys: WfirmaKeys,
    private readonly fetchImpl: FetchLike = fetch,
    minIntervalMs: number | Throttle = 1_200,
    // 60 s, a nie 90 s — żądanie plus odczyt WZ musi zmieścić się w oknie sprzątacza
    // `reapStaleInvoices` (2 min), inaczej żywa próba mogłaby stać się niewiadomą w trakcie
    private readonly timeoutMs = 60_000,
  ) {
    if (!keys.accessKey || !keys.secretKey || !keys.appKey) throw new Error('Brak kluczy wFirmy')
    if (!keys.companyId) throw new Error('Brak WFIRMA_COMPANY_ID')
    this.throttle = typeof minIntervalMs === 'number' ? new Throttle(minIntervalMs) : minIntervalMs
  }

  /** Czy ścieżka jest dozwolona do zapisu (test i strażnik przed wysłaniem). */
  static allowed(path: string): boolean {
    return WRITE_RULES.some((r) => r.test(path))
  }

  private async post(path: string, body: unknown, accept: string): Promise<Response> {
    if (!WfirmaZapis.allowed(path)) throw new ReadOnlyViolation(`wFirma: zapis „${path}” niedozwolony`)
    await this.throttle.wait()
    const url = `${BASE}/${path}?inputFormat=json&outputFormat=json&company_id=${encodeURIComponent(this.keys.companyId)}`
    return fetchWithTimeout(
      this.fetchImpl,
      url,
      {
        method: 'POST',
        headers: { accessKey: this.keys.accessKey, secretKey: this.keys.secretKey, appKey: this.keys.appKey, 'Content-Type': 'application/json', Accept: accept },
        body: JSON.stringify(body),
      },
      this.timeoutMs,
    )
  }

  /** `invoices/add` z treścią złożoną przez `zlozFakture` (lib/wfirma/faktura.ts). Bez ponowień — patrz nagłówek. */
  async wystawFakture(tresc: { invoices: { invoice: Record<string, unknown> } }): Promise<WynikWystawienia> {
    return this.dodajFakture(tresc, 'fakturę')
  }

  /** korekta faktury (`invoices/add` z treścią z `zlozKorekte`, lib/wfirma/korekta-zapis.ts). Bez ponowień. */
  async wystawKorekte(tresc: { invoices: { invoice: Record<string, unknown> } }): Promise<WynikWystawienia> {
    return this.dodajFakture(tresc, 'korektę')
  }

  private async dodajFakture(tresc: { invoices: { invoice: Record<string, unknown> } }, co: 'fakturę' | 'korektę'): Promise<WynikWystawienia> {
    let res: Response
    try {
      res = await this.post('invoices/add', tresc, 'application/json')
    } catch (e) {
      if (e instanceof ReadOnlyViolation) throw e
      return { kind: 'TIMEOUT', message: e instanceof Error ? e.message.slice(0, 200) : 'błąd sieci' }
    }
    if (res.status === 429) return { kind: 'LIMIT', message: 'wFirma invoices/add: HTTP 429 (limit)', retryAfterMs: retryAfter(res) }
    if (res.status >= 500) return { kind: 'TIMEOUT', message: `wFirma invoices/add: HTTP ${res.status}` }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      return res.ok ? { kind: 'TIMEOUT', message: 'wFirma invoices/add: nieczytelna odpowiedź' } : { kind: 'ERROR', message: `wFirma odrzuciła ${co}: HTTP ${res.status}` }
    }
    const code = String(obj(obj(json)['status'])['code'] ?? '')
    if (LIMIT.test(code)) return { kind: 'LIMIT', message: `wFirma invoices/add: ${code.slice(0, 80)}`, retryAfterMs: retryAfter(res) }
    if (!res.ok) return { kind: 'ERROR', message: `wFirma odrzuciła ${co}: HTTP ${res.status}${code ? ` (${code.slice(0, 40)})` : ''}` }
    if (code === 'OK') {
      const f = fakturaZOdpowiedzi(json)
      return f ? { kind: 'OK', id: f.id, numer: f.numer } : { kind: 'TIMEOUT', message: 'wFirma invoices/add: OK bez id dokumentu' }
    }
    if (code === 'ERROR' || code === 'NOT FOUND' || code === 'INPUT ERROR' || code === 'DENIED' || /^AUTH/.test(code)) {
      const b = bledyWalidacji(json)
      return { kind: 'ERROR', message: `wFirma odrzuciła ${co} (${code.slice(0, 40)})${b.length ? `: ${b.join('; ')}` : ''}`.slice(0, 900) }
    }
    // SNAPSHOT LOCK, EXECUTION TIME i każdy inny kod: nie wiadomo, czy dokument powstał — rozstrzyga find
    return { kind: 'TIMEOUT', message: `wFirma invoices/add: ${code.slice(0, 80) || 'brak kodu'}` }
  }

  /**
   * `warehouse_documents/add` z treścią złożoną przez `wzAddBody` (lib/wfirma/wz.ts). Ta sama klasyfikacja
   * wyniku co faktura i tak samo bez ponowień: o drugiej próbie decyduje host po odszukaniu po `id_external`.
   */
  async wystawWz(tresc: Record<string, unknown>): Promise<WynikWystawienia> {
    const sciezka = 'warehouse_documents/add'
    let res: Response
    try {
      res = await this.post(sciezka, tresc, 'application/json')
    } catch (e) {
      if (e instanceof ReadOnlyViolation) throw e
      return { kind: 'TIMEOUT', message: e instanceof Error ? e.message.slice(0, 200) : 'błąd sieci' }
    }
    if (res.status === 429) return { kind: 'LIMIT', message: `wFirma ${sciezka}: HTTP 429 (limit)`, retryAfterMs: retryAfter(res) }
    if (res.status >= 500) return { kind: 'TIMEOUT', message: `wFirma ${sciezka}: HTTP ${res.status}` }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      return res.ok ? { kind: 'TIMEOUT', message: `wFirma ${sciezka}: nieczytelna odpowiedź` } : { kind: 'ERROR', message: `wFirma odrzuciła WZ: HTTP ${res.status}` }
    }
    const code = String(obj(obj(json)['status'])['code'] ?? '')
    if (LIMIT.test(code)) return { kind: 'LIMIT', message: `wFirma ${sciezka}: ${code.slice(0, 80)}`, retryAfterMs: retryAfter(res) }
    if (!res.ok) return { kind: 'ERROR', message: `wFirma odrzuciła WZ: HTTP ${res.status}${code ? ` (${code.slice(0, 40)})` : ''}` }
    if (code === 'OK') {
      const d = wzZOdpowiedzi(json)
      return d ? { kind: 'OK', id: d.id, numer: d.numer } : { kind: 'TIMEOUT', message: `wFirma ${sciezka}: OK bez id dokumentu` }
    }
    if (code === 'ERROR' || code === 'NOT FOUND' || code === 'INPUT ERROR' || code === 'DENIED' || /^AUTH/.test(code)) {
      const b = bledyWalidacji(json, 'warehouse_documents')
      return { kind: 'ERROR', message: `wFirma odrzuciła WZ (${code.slice(0, 40)})${b.length ? `: ${b.join('; ')}` : ''}`.slice(0, 900) }
    }
    return { kind: 'TIMEOUT', message: `wFirma ${sciezka}: ${code.slice(0, 80) || 'brak kodu'}` }
  }

  /**
   * Usunięcie faktury roboczej próby. Najpierw świeży odczyt `invoices/get/<id>` przez klienta odczytu; usuwa tylko
   * dokument spełniający `jestRoboczaProby` albo roboczy (`jestRobocza`) z `id_external` w starym formacie próby, który
   * `staraProba` potwierdzi; każdy inny (zwykła faktura, numer w serii, inny `id_external`, brak dokumentu, błąd
   * odczytu) = odmowa bez żądania usunięcia. Bez ponowień.
   */
  async usunFaktureRobocza(docId: string, odczyt: { call<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> }, staraProba?: StaraRoboczaProby): Promise<WynikUsuniecia> {
    if (!/^\d+$/.test(docId) || docId === '0') return { kind: 'ODMOWA', message: 'niepoprawny identyfikator dokumentu', dokument: null }
    let dokument: DokumentKontrolny | null
    try {
      dokument = dokumentKontrolny(await odczyt.call(`invoices/get/${docId}`, {}))
    } catch (e) {
      return { kind: 'ODMOWA', message: `nie udało się odczytać dokumentu przed usunięciem: ${e instanceof Error ? e.message.slice(0, 200) : 'błąd'}`, dokument: null }
    }
    if (!dokument || dokument.id !== docId) return { kind: 'ODMOWA', message: 'wFirma nie oddała tego dokumentu', dokument: null }
    let proby = jestRoboczaProby(dokument)
    if (!proby && staraProba && jestRobocza(dokument) && dokument.idExternal.startsWith(PREFIKS_ROBOCZEJ_STARY)) {
      try {
        proby = await staraProba(dokument.idExternal)
      } catch {
        proby = false
      }
    }
    if (!proby) return { kind: 'ODMOWA', message: `dokument nie jest fakturą roboczą próby (typ ${dokument.typ || 'brak'}, numer ${dokument.numer === null ? 'brak' : numerRoboczej(dokument.numer) ? 'roboczy' : 'w serii faktur'}, id_external ${dokument.idExternal.startsWith(PREFIKS_ROBOCZEJ) || dokument.idExternal.startsWith(PREFIKS_ROBOCZEJ_STARY) ? 'próby' : 'inny'})`, dokument }
    const sciezka = `invoices/delete/${docId}`
    if (!REGULA_USUWANIA_ROBOCZEJ.test(sciezka)) throw new ReadOnlyViolation(`wFirma: zapis „${sciezka}” niedozwolony`)
    await this.throttle.wait()
    let res: Response
    try {
      const url = `${BASE}/${sciezka}?inputFormat=json&outputFormat=json&company_id=${encodeURIComponent(this.keys.companyId)}`
      res = await fetchWithTimeout(this.fetchImpl, url, { method: 'POST', headers: { accessKey: this.keys.accessKey, secretKey: this.keys.secretKey, appKey: this.keys.appKey, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({}) }, this.timeoutMs)
    } catch (e) {
      return { kind: 'BLAD', message: `wFirma ${sciezka}: ${e instanceof Error ? e.message.slice(0, 200) : 'błąd sieci'} (nie wiadomo, czy usunięta: sprawdź ponownym --usun)` }
    }
    let code = ''
    try {
      code = String(obj(obj(await res.json())['status'])['code'] ?? '')
    } catch {
      /* nieczytelna odpowiedź */
    }
    if (res.ok && code === 'OK') return { kind: 'USUNIETA', dokument }
    return { kind: 'BLAD', message: `wFirma ${sciezka}: HTTP ${res.status}${code ? ` (${code.slice(0, 60)})` : ''}` }
  }

  /** PDF faktury (`invoices/download/<id>`): treść binarna. Błąd = wyjątek (pobranie można ponowić bez skutków). */
  async pobierzPdf(docId: string): Promise<{ contentType: string; base64: string }> {
    if (!/^\d+$/.test(docId)) throw new Error('wFirma: niepoprawny numer dokumentu')
    const body = { invoices: { parameters: { parameter: [{ name: 'page', value: 'invoice' }, { name: 'address', value: 0 }, { name: 'leaflet', value: 0 }, { name: 'duplicate', value: 0 }] } } }
    const res = await this.post(`invoices/download/${docId}`, body, 'application/pdf')
    if (res.status === 429) throw new SourceError('wFirma invoices/download: HTTP 429 (limit) — bez ponawiania', false)
    if (!res.ok) throw new SourceError(`wFirma invoices/download: HTTP ${res.status}`, res.status >= 500)
    const bytes = new Uint8Array(await res.arrayBuffer())
    // PDF zaczyna się od „%PDF-”; JSON z błędem (status ≠ OK) też przychodzi z 200
    if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') {
      let code = ''
      try {
        code = String(obj(obj(JSON.parse(new TextDecoder().decode(bytes)))['status'])['code'] ?? '')
      } catch {
        /* nie JSON */
      }
      throw new SourceError(`wFirma invoices/download: odpowiedź nie jest PDF-em${code ? ` (${code.slice(0, 40)})` : ''}`, false)
    }
    return { contentType: 'application/pdf', base64: Buffer.from(bytes).toString('base64') }
  }
}
