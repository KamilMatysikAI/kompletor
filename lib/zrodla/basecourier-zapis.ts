// Base Courier (dawna BL Paczka) — klient ZAPISU, za wyłącznikiem. Każde zamówienie przesyłki kosztuje
// pieniądze (saldo „skarbonki” albo płatność odroczona), więc ten plik jest osobno od klienta odczytu
// (lib/zrodla/basecourier.ts), a konstruktor wymaga jawnego `wylacznik: true`. Tworzy go wyłącznie adapter
// `basecourier.zapis.v1`, i tylko przy `zapisWlaczony: true` w regule przewoźnika firmy; woła go tylko host przesyłek
// (lib/wysylka/nadanie.ts).
//
// Kształt żądań i odpowiedzi z oficjalnej dokumentacji API (OpenAPI 3.0, https://api.basecourier.com/api/docs, kopia
// z 15.11.2026) i kodu wtyczki WooCommerce „BLPaczka” (BL Logistics, svn wordpress.org, trunk r3788011), sprawdzony
// odczytem na koncie produkcyjnym (bez tworzenia przesyłek; opis w docs/integracje/basecourier.md):
//   createOrderV2.json   {CourierSearch, Cart:[{Order}], CartOrder} → {success, message, data:{Order:[{id,…}], waybill_link, validationErrors}}
//   getWaybill.json      {Order:{id, printer_type: A4|LBL}}          → {success, message, data:{"0":{filename, mime, file}, labels:[…]}}
//                                                                      (dokumentacja) albo data:[{…}] (wtyczka)
//   cancelOrder.json     {Order:{id}}                                → {success, message}
//   getOrderDetails.json {Order:{id}} (forma wtyczki; tablica z dokumentacji daje odmowę) → {success, message, data:{Order}}
//   getOrders.json       {Order:{page}}                              → {success, data:[{Order, CartOrder}], pagination}
// Numer listu: pole `waybill_no`. Szczegóły zamówienia InPost mają je puste, a lista zamówień ma numer (odczyt
// 15.11.2026), więc numer bierzemy zapasowo z listy. Do potwierdzenia pierwszą przesyłką na sandboxie
// (sandbox.basecourier.com, osobne konto): kształt odpowiedzi utworzenia i etykiety oraz kodowanie pliku etykiety.
//
// Bez ponawiania utworzenia: API nie ma klucza idempotencji, więc zgubiona odpowiedź (timeout, błąd sieci, 5xx,
// nieczytelna treść) to NIEJEDNOZNACZNY, a rozstrzyga człowiek (host: „Rozstrzygnij ręcznie”). Ponowienie
// w ciemno = druga płatna przesyłka. Odpowiedzi niosą dane odbiorcy: z treści bierzemy tylko identyfikatory, a komunikat
// API przechodzi przez `bezDanych` (bez wartości odbiorcy, e-maili i długich ciągów cyfr).
import { AdapterError, type WriteOutcome } from '../adaptery/kontrakt'
import { BASE_COURIER_URL_RE, BASE_COURIER_ZLY_ADRES } from './basecourier'
import { fetchWithTimeout, ReadOnlyViolation, SourceError, type FetchLike } from './http'

/**
 * Jedyne operacje klienta zapisu; reszta API (zbiorcze etykiety, wycena) = wyjątek przed wysyłką. `getWaybillTracking.json`
 * (od 19.11.2026) to odczyt historii statusów: odpowiedź niesie też adres, bierzemy z niej tylko kody statusów.
 * `getOrders.json` to odczyt listy (z danymi odbiorców): bierzemy z niej tylko id i numer listu.
 * `getPickupDateOptions.json` to odczyt terminów podjazdu kuriera (dni i godziny), bez danych osobowych.
 */
const ZAPIS = new Set(['createOrderV2.json', 'getWaybill.json', 'cancelOrder.json', 'getOrderDetails.json', 'getOrderDetailsByWaybillNo.json', 'getOrders.json', 'getWaybillTracking.json', 'getPickupDateOptions.json'])

export function assertBaseCourierZapis(endpoint: string): void {
  if (!ZAPIS.has(endpoint)) throw new ReadOnlyViolation(`Base Courier (zapis): endpoint „${endpoint}” poza listą operacji zapisu`)
}

/**
 * Id zamówienia Base Courier (wtyczka rzutuje je na int tylko w `getWaybill`). Najwyżej 15 cyfr: `Number()` bez utraty
 * precyzji; w `getOrderDetails` i `cancelOrder` id idzie jako tekst, jak we wtyczce.
 */
export const BASE_COURIER_ID_RE = /^\d{1,15}$/

/**
 * czy odpowiedź „niepowodzenie” bez zamówienia w treści i BEZ błędów walidacji (np. „brak środków
 * w skarbonce”, odmowa płatności odroczonej, inny 4xx) na pewno nie zostawia zamówienia w Base Courier. Wtyczka BLPaczka
 * nie daje na to dowodu (osobne `Cart` i `CartOrder.payment` sugerują dwa kroki), a pomyłka = druga płatna przesyłka,
 * więc do testu na sandboxie taka odpowiedź jest NIEJEDNOZNACZNA (rozstrzyga człowiek).
 * Na `true` dopiero po teście na sandboxie: pusta skarbonka → w panelu Base Courier brak zamówienia
 * (docs/integracje/basecourier.md, „Źródło i niepewności”).
 */
export const ODMOWA_BEZ_ZAMOWIENIA_PEWNA = false
/** Numer listu przewozowego InPost/DPD: litery i cyfry. */
export const NUMER_LISTU_RE = /^[0-9A-Za-z]{6,40}$/

/** Rozmiar etykiety: `LBL` = A6 na drukarkę etykiet, `A4` = kartka (API ma też `ZPL` i `EPL`; Kompletor bierze PDF). */
export type PrinterType = 'A4' | 'LBL'

export interface BaseCourierZapisOptions {
  baseUrl: string
  login: string
  apiKey: string
  /** Jawna zgoda w kodzie wywołującym: bez `true` klient nie powstaje. */
  wylacznik: true
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** Nadpisanie `ODMOWA_BEZ_ZAMOWIENIA_PEWNA` (testy obu wariantów); domyślnie stała. */
  odmowaBezZamowieniaPewna?: boolean
}

/** Dane przesyłki z odpowiedzi Base Courier, bez danych odbiorcy. */
export interface PrzesylkaBaseCourier {
  id: string
  /** Numer listu przewozowego; null = przewoźnik jeszcze go nie nadał. */
  numer: string | null
  /** Pole „Zawartość przesyłki” (niesie referencję Kompletora); undefined = API go nie zwróciło. */
  zawartosc: string | undefined
}

/** Jeden wpis historii przesyłki: kod przewoźnika, kod wspólny Base Courier (null = brak) i znacznik doręczenia. */
export interface StatusBaseCourier {
  status: string | null
  kod: number | null
  doreczona: boolean
  /** Opis statusu od przewoźnika (np. „Odebrana od nadawcy”), oczyszczony; null = brak albo odrzucony. */
  opis: string | null
}

/** Opis statusu do pokazania: bez znaczników w nawiasach kwadratowych, najwyżej 120 znaków; z e-mailem albo długim ciągiem cyfr = odrzucony. */
export function opisStatusu(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!t || t.includes('@') || /\d{7,}/.test(t)) return null
  return t
}

/** Najdłużej trwające żywe utworzenie (jedno żądanie z limitem czasu, bez ponawiania); host czeka dłużej (nadanie.ts). */
export const BASE_COURIER_TIMEOUT_MS = 60_000
/** Lista zamówień przy szukaniu numeru listu: najwyżej tyle stron (po 20, najnowsze pierwsze), każda z krótszym limitem. */
export const BASE_COURIER_LISTA_STRONY = 3
export const BASE_COURIER_LISTA_TIMEOUT_MS = 20_000
/** Limit czasu odczytu terminów podjazdu (przed każdą przesyłką z podjazdem). */
export const BASE_COURIER_TERMINY_TIMEOUT_MS = 15_000

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const EMAIL_RE = /[^\s@,;()]+@[^\s@,;()]+/g
const CYFRY_RE = /\d[\d\s-]{6,}\d/g

/**
 * Komunikat API bez danych: wartości z `wrazliwe` (odbiorca, nadawca, konto), e-maile i ciągi cyfr (telefon, konto)
 * zastąpione „…”, najwyżej 200 znaków. Komunikat Base Courier mówi człowiekowi, co poprawić (np. „Brak środków”).
 */
export function bezDanych(tekst: string, wrazliwe: readonly string[] = []): string {
  let t = tekst
  for (const w of wrazliwe) {
    const s = w.trim()
    if (s.length >= 3) t = t.split(s).join('…')
  }
  return t.replace(EMAIL_RE, '…').replace(CYFRY_RE, '…').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** `data.validationErrors` niepuste (obiekt albo tablica z czymkolwiek). */
function maWalidacje(data: unknown): boolean {
  const ve = isRecord(data) ? data['validationErrors'] : undefined
  return Array.isArray(ve) ? ve.length > 0 : isRecord(ve) ? Object.keys(ve).length > 0 : false
}

/**
 * Nazwy pól z `validationErrors.CourierSearch.<pole>` i `validationErrors.Cart[].<model>.<pole>` (nigdy wartości, mogą
 * mieć dane odbiorcy), najwyżej 10.
 */
export function polaWalidacji(data: unknown): string[] {
  const ve = isRecord(data) ? data['validationErrors'] : undefined
  const cart = isRecord(ve) ? ve['Cart'] : undefined
  const out = new Set<string>()
  const cs = isRecord(ve) ? ve['CourierSearch'] : undefined
  if (isRecord(cs)) for (const pole of Object.keys(cs)) if (/^[a-z_]{1,40}$/.test(pole)) out.add(pole)
  const pozycje = Array.isArray(cart) ? cart : isRecord(cart) ? Object.values(cart) : []
  for (const poz of pozycje) {
    if (!isRecord(poz)) continue
    for (const model of Object.values(poz)) {
      if (!isRecord(model)) continue
      for (const pole of Object.keys(model)) if (/^[a-z_]{1,40}$/.test(pole)) out.add(pole)
    }
  }
  return [...out].slice(0, 10)
}

/** `data.Order` jako tablica (createOrderV2) albo obiekt (getOrderDetails) → pierwszy rekord. */
function pierwszyOrder(data: unknown): Record<string, unknown> | null {
  const o = isRecord(data) ? data['Order'] : undefined
  if (Array.isArray(o)) return isRecord(o[0]) ? o[0] : null
  return isRecord(o) ? o : null
}

const tekstPola = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)

/** Numer listu z rekordu zamówienia: pole `waybill_no` (dokumentacja i odczyt), pozostałe nazwy na zapas. */
function numerListu(o: Record<string, unknown>): string | null {
  for (const k of ['waybill_no', 'waybill_number', 'waybill', 'tracking_number']) {
    const v = tekstPola(o[k])
    if (v && NUMER_LISTU_RE.test(v)) return v
  }
  return null
}

/**
 * ślad zamówienia w treści odpowiedzi utworzenia, niezależnie od `success` i statusu HTTP. Wtyczka
 * czyta id z `data.Order[0].id`, a to samo id wraca w `data.blpaczka_order_id` i `data.CartOrder.id`; `waybill_link`
 * też dowodzi, że zamówienie powstało. `numer` = id do wpisania w „Rozstrzygnij ręcznie” (null, gdy jest sam link bez
 * cyfr id albo rekord bez id).
 */
export function sladZamowienia(json: unknown): { numer: string | null } | null {
  if (!isRecord(json)) return null
  const data = json['data']
  if (!isRecord(data)) return null
  const zId = (v: unknown) => {
    const t = tekstPola(v)
    return t && BASE_COURIER_ID_RE.test(t) ? t : null
  }
  const o = pierwszyOrder(data)
  const co = data['CartOrder']
  const numer = zId(o?.['id']) ?? zId(data['blpaczka_order_id']) ?? zId(isRecord(co) ? co['id'] : undefined)
  if (numer) return { numer }
  if (o && Object.keys(o).length) return { numer: null }
  const link = tekstPola(data['waybill_link'])
  if (link) return { numer: /(\d{1,15})\D*$/.exec(link)?.[1] ?? null }
  return null
}

function przesylkaZRekordu(o: Record<string, unknown> | null): PrzesylkaBaseCourier | null {
  if (!o) return null
  const id = tekstPola(o['id'])
  if (!id || !BASE_COURIER_ID_RE.test(id)) return null
  const z = o['package_content']
  return { id, numer: numerListu(o), zawartosc: typeof z === 'string' ? z : undefined }
}

export class BaseCourierZapis {
  private readonly base: string
  private readonly login: string
  private readonly apiKey: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly odmowaPewna: boolean

  constructor(o: BaseCourierZapisOptions) {
    if ((o as { wylacznik?: unknown }).wylacznik !== true) throw new Error('Klient zapisu Base Courier wymaga jawnego wyłącznika (wylacznik: true)')
    if (!o.login || !o.apiKey) throw new Error('Brak loginu albo klucza API Base Courier')
    if (!BASE_COURIER_URL_RE.test(o.baseUrl)) throw new Error(BASE_COURIER_ZLY_ADRES)
    this.base = o.baseUrl.replace(/\/$/, '')
    this.login = o.login
    this.apiKey = o.apiKey
    this.fetchImpl = o.fetchImpl ?? fetch
    this.timeoutMs = o.timeoutMs ?? BASE_COURIER_TIMEOUT_MS
    this.odmowaPewna = o.odmowaBezZamowieniaPewna ?? ODMOWA_BEZ_ZAMOWIENIA_PEWNA
  }

  private clean(m: string): string {
    return m.split(this.apiKey).join('***').split(this.login).join('***')
  }

  /** Jedno żądanie, bez ponawiania. Błąd sieci i limit czasu = SourceError (żądanie mogło dojść). */
  private async call(endpoint: string, body: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<{ status: number; json: unknown; retryAfterMs?: number }> {
    assertBaseCourierZapis(endpoint)
    let res: Response
    try {
      res = await fetchWithTimeout(
        this.fetchImpl,
        `${this.base}/${endpoint}`,
        // `redirect: 'error'`: przekierowanie zaniosłoby treść z kluczem pod adres spoza listy
        { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...body, auth: { login: this.login, api_key: this.apiKey } }) },
        timeoutMs,
      )
    } catch (e) {
      throw new SourceError(`Base Courier ${endpoint}: ${this.clean(e instanceof Error ? e.message : String(e))}`, true)
    }
    const text = await res.text().catch(() => '')
    let json: unknown = undefined
    try {
      json = text.trim() ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    const ra = Number(res.headers.get('retry-after'))
    return { status: res.status, json, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterMs: ra * 1000 } : {}) }
  }

  /** Odczyt (etykieta, szczegóły, anulowanie): sieć, 429 i 5xx = PRZEJSCIOWY; odmowa = TRWALY; `success:false` = TRWALY z komunikatem. */
  private async odczyt(endpoint: string, body: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    let r: Awaited<ReturnType<BaseCourierZapis['call']>>
    try {
      r = await this.call(endpoint, body, timeoutMs)
    } catch (e) {
      if (e instanceof SourceError) throw new AdapterError(e.message, 'PRZEJSCIOWY')
      throw e
    }
    if (r.status === 429 || r.status >= 500) throw new AdapterError(`Base Courier ${endpoint}: HTTP ${r.status}`, 'PRZEJSCIOWY', r.retryAfterMs)
    if (r.status === 401 || r.status === 403) throw new AdapterError(`Base Courier ${endpoint}: odmowa logowania (sprawdź e-mail konta i klucz API)`, 'TRWALY')
    if (r.status < 200 || r.status >= 300) throw new AdapterError(`Base Courier ${endpoint}: HTTP ${r.status}`, 'TRWALY')
    if (!isRecord(r.json)) throw new AdapterError(`Base Courier ${endpoint}: nieczytelna odpowiedź`, 'PRZEJSCIOWY')
    if (r.json['success'] === false) {
      const m = typeof r.json['message'] === 'string' ? bezDanych(this.clean(r.json['message'])) : ''
      throw new AdapterError(`Base Courier ${endpoint}: odmowa${m ? ` (${m})` : ''}`, 'TRWALY')
    }
    return r.json
  }

  /**
   * Zamówienie przesyłki (`createOrderV2.json`). Referencja hosta jest już w treści (`package_content`), więc człowiek
   * znajdzie przesyłkę w panelu Base Courier. Najpierw treść, potem status:
   *   OK              — `success:true` i `data.Order[0].id` (id zamówienia Base Courier = externalRef);
   *   NIEJEDNOZNACZNY — ślad zamówienia w treści (`Order[0].id`, `blpaczka_order_id`, `CartOrder.id`, `waybill_link`) przy
   *                     czymkolwiek innym niż OK (`success:false`, 4xx, 5xx), z numerem w komunikacie; bez śladu: błąd
   *                     sieci, limit czasu, 5xx, pusta/nieczytelna treść, sukces bez id, a do testu na sandboxie także
   *                     odmowa bez walidacji (`ODMOWA_BEZ_ZAMOWIENIA_PEWNA`, np. brak środków) i inny 4xx;
   *   TRWALY          — pewny brak: HTTP 401/403 albo `data.validationErrors` (nazwy pól i komunikat bez danych);
   *   PRZEJSCIOWY     — HTTP 429 bez śladu zamówienia (odrzucone przed przyjęciem).
   * `wrazliwe` = wartości z treści (odbiorca, nadawca), wycinane z komunikatu API.
   */
  async createOrder(payload: Record<string, unknown>, reference: string, wrazliwe: readonly string[] = []): Promise<{ wynik: WriteOutcome; przesylka: PrzesylkaBaseCourier | null }> {
    const e = 'createOrderV2.json'
    let r: Awaited<ReturnType<BaseCourierZapis['call']>>
    try {
      r = await this.call(e, payload)
    } catch (x) {
      if (x instanceof ReadOnlyViolation) throw x
      return { wynik: { kind: 'NIEJEDNOZNACZNY', reference, message: x instanceof Error ? x.message : String(x) }, przesylka: null }
    }
    const nj = (m: string) => ({ wynik: { kind: 'NIEJEDNOZNACZNY' as const, reference, message: `Base Courier ${e}: ${m}` }, przesylka: null })
    const trwaly = (m: string) => ({ wynik: { kind: 'TRWALY' as const, reference, message: m }, przesylka: null })
    const json = isRecord(r.json) ? r.json : null
    const data = json?.['data']
    const komunikat = json && typeof json['message'] === 'string' ? bezDanych(this.clean(json['message']), wrazliwe) : ''
    const ok2xx = r.status >= 200 && r.status < 300
    // 1. pełny sukces
    const p = przesylkaZRekordu(pierwszyOrder(data))
    if (ok2xx && json?.['success'] === true && p) return { wynik: { kind: 'OK', reference, externalRef: p.id }, przesylka: p }
    // 2. ślad zamówienia przy czymkolwiek innym = nie wiadomo, czy przesyłka powstała (nigdy ponowienie)
    const slad = sladZamowienia(json)
    if (slad)
      return nj(
        `HTTP ${r.status}, odpowiedź ${json?.['success'] === true ? 'bez pełnego zamówienia' : '„niepowodzenie”'} ze śladem zamówienia w treści${komunikat ? ` (${komunikat})` : ''}. ` +
          (slad.numer ? `Numer zamówienia w Base Courier: ${slad.numer} (sprawdź go w panelu i wpisz w „Rozstrzygnij ręcznie”).` : 'Sprawdź w panelu Base Courier przesyłkę z referencją z „Zawartość przesyłki”.'),
      )
    // 3. bez śladu: po statusie i walidacji
    if (r.status >= 500) return nj(`HTTP ${r.status}`)
    if (r.status === 429) return { wynik: { kind: 'PRZEJSCIOWY', reference, message: `Base Courier ${e}: HTTP 429`, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) }, przesylka: null }
    if (r.status === 401 || r.status === 403) return trwaly(`Base Courier ${e}: odmowa logowania (sprawdź e-mail konta i klucz API)`)
    const pola = polaWalidacji(data)
    if (pola.length || maWalidacje(data)) return trwaly(`Base Courier odrzucił przesyłkę${komunikat ? `: ${komunikat}` : ''}${pola.length ? ` (pola: ${pola.join(', ')})` : ''}`)
    if (!json) return nj(`HTTP ${r.status}, pusta albo nieczytelna odpowiedź`)
    if (ok2xx && json['success'] !== false) return nj('odpowiedź bez numeru zamówienia Base Courier')
    // odmowa bez walidacji i bez śladu (np. brak środków) albo inny 4xx
    if (this.odmowaPewna) return trwaly(`Base Courier odrzucił przesyłkę${komunikat ? `: ${komunikat}` : ` (HTTP ${r.status})`}`)
    return nj(
      `${ok2xx ? '' : `HTTP ${r.status}, `}odmowa bez błędów walidacji${komunikat ? `: ${komunikat}` : ''}. Nie wiadomo, czy zamówienie nie zostało w Base Courier: sprawdź w panelu przesyłkę z referencją z „Zawartość przesyłki”, a jeśli jej nie ma, wybierz „nie powstała”.`,
    )
  }

  /**
   * Etykieta PDF (`getWaybill.json`); plik base64 w `data["0"].file` (dokumentacja: obiekt z kluczem "0" obok `labels`),
   * w `data[0].file` (tablica, wtyczka) albo w `data.file`; sprawdzany nagłówkiem „%PDF”.
   */
  async waybill(id: string, printerType: PrinterType): Promise<{ contentType: string; base64: string }> {
    if (!BASE_COURIER_ID_RE.test(id)) throw new AdapterError('Zły numer zamówienia Base Courier', 'TRWALY')
    const j = await this.odczyt('getWaybill.json', { Order: { id: Number(id), printer_type: printerType } })
    const d = j['data']
    const f = Array.isArray(d) ? (isRecord(d[0]) ? d[0] : null) : isRecord(d) ? (isRecord(d['0']) ? d['0'] : d) : null
    const file = f && typeof f['file'] === 'string' ? f['file'].trim() : ''
    if (!file) throw new AdapterError('Base Courier getWaybill.json: etykieta jeszcze niedostępna', 'PRZEJSCIOWY')
    const plik = Buffer.from(file, 'base64')
    if (plik.subarray(0, 4).toString('latin1') !== '%PDF') throw new AdapterError('Base Courier getWaybill.json: plik etykiety nie jest PDF', 'TRWALY')
    return { contentType: 'application/pdf', base64: plik.toString('base64') }
  }

  /**
   * Terminy podjazdu kuriera (`getPickupDateOptions.json`): surowa odpowiedź `{success, data:{dates, hours, minutes,
   * start_default_hour, end_default_hour}}` (czyta ją lib/wysylka/podjazd.ts). Krótki limit czasu: to tylko podpowiedź
   * dnia, jej brak nie blokuje przesyłki.
   */
  async terminyPodjazdu(): Promise<Record<string, unknown>> {
    return this.odczyt('getPickupDateOptions.json', {}, Math.min(this.timeoutMs, BASE_COURIER_TERMINY_TIMEOUT_MS))
  }

  /** Szczegóły zamówienia po id (`getOrderDetails.json`): tylko id, numer listu i zawartość, bez danych odbiorcy. */
  async details(id: string): Promise<PrzesylkaBaseCourier | null> {
    if (!BASE_COURIER_ID_RE.test(id)) throw new AdapterError('Zły numer zamówienia Base Courier', 'TRWALY')
    return przesylkaZRekordu(pierwszyOrder((await this.odczyt('getOrderDetails.json', { Order: { id } }))['data']))
  }

  /**
   * Numer listu z listy zamówień (`getOrders.json`), gdy szczegóły go nie mają (paczki InPost). Strony po 20, najnowsze
   * pierwsze, najwyżej `BASE_COURIER_LISTA_STRONY`, każda z limitem `BASE_COURIER_LISTA_TIMEOUT_MS`. Wynik: numer;
   * null = zamówienie jest na liście, ale bez numeru; undefined = zamówienia nie ma na przejrzanych stronach. Z rekordów
   * listy bierzemy tylko id i numer (reszta ma dane odbiorców).
   */
  async numerZListy(id: string): Promise<string | null | undefined> {
    if (!BASE_COURIER_ID_RE.test(id)) throw new AdapterError('Zły numer zamówienia Base Courier', 'TRWALY')
    for (let strona = 1; strona <= BASE_COURIER_LISTA_STRONY; strona++) {
      const j = await this.odczyt('getOrders.json', { Order: { page: strona } }, Math.min(this.timeoutMs, BASE_COURIER_LISTA_TIMEOUT_MS))
      const d = j['data']
      const rekordy = Array.isArray(d) ? d : []
      for (const r of rekordy) {
        const o = pierwszyOrder(r)
        if (o && tekstPola(o['id']) === id) return numerListu(o)
      }
      const pag = j['pagination']
      if (!rekordy.length || (isRecord(pag) && pag['next'] !== true)) break
    }
    return undefined
  }

  /**
   * Historia statusów przesyłki (`getWaybillTracking.json`, sam odczyt; kształt potwierdzony odczytem 19.11.2026):
   * `data.Tracking[].TrackingStatus` z polami `status` (kod przewoźnika) i `bl_status_mapped` (kod wspólny, liczba).
   * Odpowiedź niesie też dane odbiorcy w `data.Order`: bierzemy wyłącznie kody statusów i znacznik doręczenia.
   */
  async tracking(id: string): Promise<StatusBaseCourier[]> {
    if (!BASE_COURIER_ID_RE.test(id)) throw new AdapterError('Zły numer zamówienia Base Courier', 'TRWALY')
    const d0 = (await this.odczyt('getWaybillTracking.json', { Order: { id } }))['data']
    const d = Array.isArray(d0) ? d0[0] : d0
    const lista = isRecord(d) && Array.isArray(d['Tracking']) ? d['Tracking'] : []
    const wynik: StatusBaseCourier[] = []
    for (const w of lista) {
      const t = isRecord(w) && isRecord(w['TrackingStatus']) ? w['TrackingStatus'] : null
      if (!t) continue
      const m = t['bl_status_mapped']
      const kod = typeof m === 'number' ? m : typeof m === 'string' && /^\d{1,3}$/.test(m.trim()) ? Number(m.trim()) : null
      const status = typeof t['status'] === 'string' && /^[0-9A-Za-z_.-]{1,60}$/.test(t['status']) ? t['status'] : null
      wynik.push({ status, kod, doreczona: t['delivered'] === true, opis: opisStatusu(t['status_desc']) })
    }
    return wynik
  }

  /** Szczegóły po numerze listu (`getOrderDetailsByWaybillNo.json`, parametr `Order.waybill_no`). */
  async detailsByWaybill(numer: string): Promise<PrzesylkaBaseCourier | null> {
    if (!NUMER_LISTU_RE.test(numer)) throw new AdapterError('Zły numer listu przewozowego', 'TRWALY')
    return przesylkaZRekordu(pierwszyOrder((await this.odczyt('getOrderDetailsByWaybillNo.json', { Order: { waybill_no: numer } }))['data']))
  }

  /**
   * Anulowanie (`cancelOrder.json`). OK = `success:true`. Ponowienie po zgubionej odpowiedzi jest bezpieczne (drugie
   * anulowanie nic nie tworzy), więc sieć i 5xx = PRZEJSCIOWY; odmowa (np. paczka już nadana) = TRWALY z komunikatem.
   */
  async cancel(id: string, reference: string): Promise<WriteOutcome> {
    if (!BASE_COURIER_ID_RE.test(id)) return { kind: 'TRWALY', reference, message: 'Zły numer zamówienia Base Courier' }
    try {
      await this.odczyt('cancelOrder.json', { Order: { id } })
      return { kind: 'OK', reference }
    } catch (e) {
      if (e instanceof AdapterError) return { kind: e.kind, reference, message: e.message, ...(e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}) }
      throw e
    }
  }
}
