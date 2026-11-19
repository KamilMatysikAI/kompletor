// Uwierzytelnione połączenie z KSeF API 2.x tokenem firmy. Pochodzenie: nasz klient KSeF z DewFlow
// (lib/ksef/client.ts: challenge → /auth/ksef-token z tokenem zaszyfrowanym RSA-OAEP → status → redeem → odświeżanie
// przy 401), działający produkcyjnie; tu tylko ścieżka tokenu (bez XAdES) i sieć przez wstrzykiwany `FetchLike`.
//
// Połączenie powstaje wyłącznie z wyniku `bramkaWysylki` (./bramka.ts) z `dozwolona: true`, a każdy adres przechodzi
// przez `sprawdzAdres` środowiska. Token firmy przychodzi z zaszyfrowanej konfiguracji (sekret `KSEF_TOKEN`) i nie
// trafia do komunikatów błędów ani logów; komunikaty niosą tylko kod HTTP i opis KSeF.
//
// Czas: limity czekania liczy `zegar` (domyślnie `Date.now`, w testach sztuczny), nigdy `now` z
// wysyłki: ten służy tylko do wyboru certyfikatu MF. Ponowienia jak w DewFlow (`lib/ksef/client.ts`, `backoff.ts`)
// GET i zasoby publiczne ponawiane przy błędzie sieci i 5xx (1/3/9 s), przy 429 czekamy tyle, ile każe KSeF
// (`Retry-After` albo „po N sekundach”, bez podpowiedzi 45 s, najwyżej 60 s); POST (zapis) bez ponowień.
// `sygnal` przerywa połączenie z zewnątrz (twardy limit zadania workera `ksef-wysylka`).
import { X509Certificate, constants as cryptoConstants, publicEncrypt } from 'node:crypto'
import type { FetchLike } from '../../zrodla/http'
import type { SrodowiskoFirmy } from '../konfiguracja'
import { readKsefError } from './bledy'
import { sprawdzAdres, type WynikBramki } from './bramka'
import type { KsefRequestInit, KsefTransport } from './sesja'
import { pickPublicKeyCertificate, type KsefPublicKeyCertificate } from './szyfrowanie'

const TIMEOUT_MS = 30_000
/** Odstępy ponowień GET przy błędzie sieci i 5xx (DewFlow `RETRY_DELAYS_MS`): najwyżej 4 próby. */
export const PONOWIENIA_MS = [1_000, 3_000, 9_000]
/** 429 bez czytelnej podpowiedzi (DewFlow `KSEF_RATE_LIMIT_FALLBACK_MS`). */
export const CZEKANIE_429_MS = 45_000
/** Górna granica czekania przy 429: cała próba ma się zmieścić przed uznaniem jej za porzuconą (5 min). */
export const CZEKANIE_429_MAX_MS = 60_000
const STATUS_CO_MS = 2_000
export const STATUS_MAX_MS = 30_000
const MARGINES_429_MS = 1_000

/**
 * Czas czekania z odpowiedzi 429 w ms (nagłówek `Retry-After`: sekundy albo data HTTP, potem treść „po N sekundach”
 * albo `retryAfter`), z marginesem 1 s i przycięty do `CZEKANIE_429_MAX_MS`; null = brak podpowiedzi. Logika jak
 * DewFlow `parseRetryAfterMs`.
 */
export function czasZRetryAfter(naglowek: string | null | undefined, tresc: string | null | undefined, nowMs: number): number | null {
  const przytnij = (ms: number) => Math.min(Math.max(Math.round(ms), 0) + MARGINES_429_MS, CZEKANIE_429_MAX_MS)
  const h = naglowek?.trim()
  if (h) {
    if (/^\d+$/.test(h)) return przytnij(Number(h) * 1000)
    const data = Date.parse(h)
    if (!Number.isNaN(data)) return przytnij(Math.max(data - nowMs, 0))
  }
  if (tresc) {
    const pl = /po\s+(\d+)\s*sekund/i.exec(tresc)
    if (pl) return przytnij(Number(pl[1]) * 1000)
    const js = /"retryAfter"\s*:\s*(\d+)/i.exec(tresc)
    if (js) return przytnij(Number(js[1]) * 1000)
  }
  return null
}

/** Czekanie przerywane sygnałem (domyślne `sleep` połączenia). */
function czekajZSygnalem(ms: number, sygnal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (sygnal?.aborted) return resolve()
    const done = () => {
      clearTimeout(t)
      sygnal?.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    sygnal?.addEventListener('abort', done, { once: true })
  })
}

export class BladKsefApi extends Error {
  constructor(
    message: string,
    /** Kod HTTP; brak = sieć albo limit czasu (stan nieznany). */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'BladKsefApi'
  }
}

export interface OpcjePolaczenia {
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  /** Chwila do wyboru certyfikatu MF (ważność klucza); NIE do liczenia limitów czasu. */
  now?: () => Date
  /** Zegar limitów czasu w ms (domyślnie `Date.now`); testy podają sztuczny, przesuwany przez `sleep`. */
  zegar?: () => number
  /** Przerwanie z zewnątrz (twardy limit zadania): kolejne żądania i czekania kończą się `BladKsefApi` bez kodu. */
  sygnal?: AbortSignal
}

type Dozwolona = Extract<WynikBramki, { dozwolona: true }>

export class KsefPolaczenie implements KsefTransport {
  private accessToken = ''
  private refreshToken = ''

  private constructor(
    readonly srodowisko: SrodowiskoFirmy,
    private readonly baza: string,
    private readonly fetchImpl: FetchLike,
    private readonly sleepImpl: (ms: number) => Promise<void>,
    private readonly zegar: () => number,
    private readonly sygnal: AbortSignal | undefined,
  ) {}

  private sprawdzSygnal(): void {
    if (this.sygnal?.aborted) throw new BladKsefApi('KSeF: przerwano (limit czasu zadania wysyłki)')
  }

  private async czekaj(ms: number): Promise<void> {
    await this.sleepImpl(ms)
    this.sprawdzSygnal()
  }

  /** Jedno żądanie z limitem 30 s i sygnałem z zewnątrz; błąd sieci = `BladKsefApi` bez kodu (stan nieznany). */
  private async jedno(url: string, init: RequestInit): Promise<Response> {
    this.sprawdzSygnal()
    const ctrl = new AbortController()
    const przerwij = () => ctrl.abort()
    const t = setTimeout(przerwij, TIMEOUT_MS)
    this.sygnal?.addEventListener('abort', przerwij, { once: true })
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'error', signal: ctrl.signal })
    } catch (e) {
      this.sprawdzSygnal()
      throw new BladKsefApi(`KSeF: błąd sieci: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      clearTimeout(t)
      this.sygnal?.removeEventListener('abort', przerwij)
    }
  }

  /** Żądanie z limitem czasu; GET i zasoby publiczne ponawiane przy błędzie sieci, 429 i 5xx, POST (zapis) bez ponowień. */
  private async surowe(sciezka: string, init: RequestInit, ponawiaj: boolean): Promise<Response> {
    const url = `${this.baza}${sciezka}`
    sprawdzAdres(this.srodowisko, url)
    for (let i = 0; ; i++) {
      let res: Response
      try {
        res = await this.jedno(url, init)
      } catch (e) {
        if (!ponawiaj || this.sygnal?.aborted) throw e
        if (i < PONOWIENIA_MS.length) {
          await this.czekaj(PONOWIENIA_MS[i]!)
          continue
        }
        throw new BladKsefApi(`${e instanceof Error ? e.message : String(e)} (po ${i + 1} próbach)`)
      }
      if (ponawiaj && (res.status === 429 || res.status >= 500) && i < PONOWIENIA_MS.length) {
        let ms = PONOWIENIA_MS[i]!
        if (res.status === 429) {
          // treść 429 czytamy tylko dla podpowiedzi czasu; odpowiedź i tak odrzucamy
          const tresc = await res.text().catch(() => '')
          ms = czasZRetryAfter(res.headers.get('retry-after'), tresc, this.zegar()) ?? CZEKANIE_429_MS
        }
        await this.czekaj(ms)
        continue
      }
      return res
    }
  }

  private async blad(res: Response, co: string): Promise<never> {
    throw new BladKsefApi(`KSeF (${co}): HTTP ${res.status} ${await readKsefError(res)}`, res.status)
  }

  /** Pełne uwierzytelnienie tokenem firmy. `nip` = NIP sprzedawcy (kontekst), `token` = token KSeF firmy. */
  static async otworz(bramka: Dozwolona, dane: { nip: string; token: string }, o: OpcjePolaczenia = {}): Promise<KsefPolaczenie> {
    if (!dane.token.trim()) throw new BladKsefApi('KSeF: brak tokenu firmy (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży → Numeracja i KSeF)')
    const zegar = o.zegar ?? Date.now
    const p = new KsefPolaczenie(bramka.srodowisko, bramka.baza, o.fetch ?? fetch, o.sleep ?? ((ms) => czekajZSygnalem(ms, o.sygnal)), zegar, o.sygnal)
    const now = o.now ?? (() => new Date(zegar()))
    const nip = dane.nip.replace(/\D/g, '')
    const ch = await p.surowe('/auth/challenge', { method: 'POST', headers: { Accept: 'application/json' } }, true)
    if (!ch.ok) await p.blad(ch, 'wyzwanie')
    const challenge = (await ch.json()) as { challenge: string; timestampMs: number }
    const kl = await p.surowe('/security/public-key-certificates', { method: 'GET', headers: { Accept: 'application/json' } }, true)
    if (!kl.ok) await p.blad(kl, 'klucze publiczne')
    const { certificateDer, publicKeyId } = pickPublicKeyCertificate((await kl.json()) as KsefPublicKeyCertificate[], 'KsefTokenEncryption', now())
    const zaszyfrowany = publicEncrypt(
      { key: new X509Certificate(certificateDer).publicKey, oaepHash: 'sha256', padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING },
      Buffer.from(`${dane.token.trim()}|${challenge.timestampMs}`, 'utf8'),
    )
    const init = await p.surowe(
      '/auth/ksef-token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ challenge: challenge.challenge, contextIdentifier: { type: 'Nip', value: nip }, encryptedToken: zaszyfrowany.toString('base64'), publicKeyId }),
      },
      false,
    )
    if (init.status !== 202) await p.blad(init, 'uwierzytelnienie tokenem')
    const { referenceNumber, authenticationToken } = (await init.json()) as { referenceNumber: string; authenticationToken: { token: string } }
    // limit z zegara, nie z `now` (stała chwila wysyłki dawała pętlę bez końca przy statusie 100)
    const koniec = zegar() + STATUS_MAX_MS
    for (;;) {
      const st = await p.surowe(`/auth/${encodeURIComponent(referenceNumber)}`, { method: 'GET', headers: { Authorization: `Bearer ${authenticationToken.token}` } }, true)
      if (!st.ok) await p.blad(st, 'status uwierzytelnienia')
      const s = (await st.json()) as { status: { code: number; description: string; details?: string[] } }
      if (s.status.code === 200) break
      if (s.status.code !== 100) throw new BladKsefApi(`KSeF: uwierzytelnienie nieudane [${s.status.code}] ${s.status.description}${s.status.details?.length ? ` (${s.status.details.join('; ')})` : ''}`, 401)
      if (zegar() >= koniec) throw new BladKsefApi('KSeF: uwierzytelnienie trwa ponad 30 s (wciąż „w toku”)')
      await p.czekaj(STATUS_CO_MS)
    }
    const red = await p.surowe('/auth/token/redeem', { method: 'POST', headers: { Authorization: `Bearer ${authenticationToken.token}` } }, false)
    if (!red.ok) await p.blad(red, 'tokeny dostępowe')
    const t = (await red.json()) as { accessToken: { token: string }; refreshToken: { token: string } }
    p.accessToken = t.accessToken.token
    p.refreshToken = t.refreshToken.token
    return p
  }

  private async odswiez(): Promise<void> {
    const res = await this.surowe('/auth/token/refresh', { method: 'POST', headers: { Authorization: `Bearer ${this.refreshToken}` } }, false)
    if (!res.ok) await this.blad(res, 'odświeżenie tokena')
    this.accessToken = ((await res.json()) as { accessToken: { token: string } }).accessToken.token
  }

  /** `KsefTransport` dla sesji (./sesja.ts): token dostępowy, jedno odświeżenie przy 401; `auth: false` = zasób publiczny. */
  async request(path: string, init: KsefRequestInit = {}): Promise<Response> {
    const { auth, ...rest } = init
    const ponawiaj = (rest.method ?? 'GET').toUpperCase() === 'GET'
    if (auth === false) return this.surowe(path, rest, ponawiaj)
    const zTokenem = () => this.surowe(path, { ...rest, headers: { ...(rest.headers as Record<string, string> | undefined), Authorization: `Bearer ${this.accessToken}` } }, ponawiaj)
    let res = await zTokenem()
    if (res.status === 401) {
      await this.odswiez()
      res = await zTokenem()
    }
    return res
  }
}
