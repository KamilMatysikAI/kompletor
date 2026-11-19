// Klient HTTP do serwera Kompletora. Natywny fetch (Node ≥ 20), bez zależności.
import type { RaportStanu, RaportWyniku, ZleceniaPoParsowaniu } from './kontrakt.js'
import { parsujZlecenia } from './kontrakt.js'

export interface PortSerwera {
  pobierzZlecenia(): Promise<ZleceniaPoParsowaniu>
  wyslijWynik(idZlecenia: string, raport: RaportWyniku): Promise<void>
  wyslijStan(raport: RaportStanu): Promise<void>
  pobierzPlik(plikUrl: string, maksBajtow: number): Promise<Buffer>
}

export class BladSerwera extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Z nagłówka `Retry-After` przy 429 (sekundy; data HTTP przeliczona na sekundy). */
    readonly ponowZaSekund?: number,
  ) {
    super(message)
    this.name = 'BladSerwera'
  }
}

/** `Retry-After`: liczba sekund albo data HTTP; nieczytelny albo brak = undefined. */
export function sekundyRetryAfter(wartosc: string | null, teraz: number = Date.now()): number | undefined {
  const w = wartosc?.trim()
  if (!w) return undefined
  if (/^\d+$/.test(w)) return Number(w)
  const data = Date.parse(w)
  if (Number.isNaN(data)) return undefined
  return Math.max(0, Math.ceil((data - teraz) / 1000))
}

export interface OpcjeKlienta {
  serwer: string
  token: string
  stanowisko: string
  timeoutMs: number
  /** Obce hosty, z których wolno pobierać pliki (bez tokenu); format jak w konfiguracji. */
  dozwoloneHostyPlikow?: string[]
  fetch?: typeof fetch
}

/** Czyta treść strumieniowo i przerywa po przekroczeniu limitu — 200 MB bez Content-Length nie trafia do pamięci. */
async function czytajZLimitem(odp: Response, maksBajtow: number): Promise<Buffer> {
  if (!odp.body) return Buffer.alloc(0)
  const czytnik = odp.body.getReader()
  const kawalki: Uint8Array[] = []
  let razem = 0
  for (;;) {
    const { done, value } = await czytnik.read()
    if (done) break
    razem += value.byteLength
    if (razem > maksBajtow) {
      await czytnik.cancel().catch(() => undefined)
      throw new BladSerwera(`Plik za duży (ponad ${maksBajtow} B)`)
    }
    kawalki.push(value)
  }
  return Buffer.concat(kawalki)
}

export class KlientSerwera implements PortSerwera {
  private readonly baza: URL
  private readonly fetch: typeof fetch

  constructor(private readonly opcje: OpcjeKlienta) {
    this.baza = new URL(opcje.serwer.endsWith('/') ? opcje.serwer : opcje.serwer + '/')
    this.fetch = opcje.fetch ?? globalThis.fetch
  }

  async pobierzZlecenia(): Promise<ZleceniaPoParsowaniu> {
    const url = new URL('api/druk/zlecenia', this.baza)
    url.searchParams.set('stanowisko', this.opcje.stanowisko)
    const odp = await this.zadanie(url, { method: 'GET' })
    let json: unknown
    try {
      json = await odp.json()
    } catch {
      throw new BladSerwera('Serwer zwrócił odpowiedź, która nie jest JSON-em')
    }
    try {
      return parsujZlecenia(json)
    } catch (e) {
      throw new BladSerwera((e as Error).message)
    }
  }

  async wyslijWynik(idZlecenia: string, raport: RaportWyniku): Promise<void> {
    const url = new URL(`api/druk/zlecenia/${encodeURIComponent(idZlecenia)}/wynik`, this.baza)
    await this.zadanie(url, { method: 'POST', body: JSON.stringify(raport) })
  }

  async wyslijStan(raport: RaportStanu): Promise<void> {
    await this.zadanie(new URL('api/druk/stan', this.baza), { method: 'POST', body: JSON.stringify(raport) })
  }

  async pobierzPlik(plikUrl: string, maksBajtow: number): Promise<Buffer> {
    let url: URL
    try {
      url = new URL(plikUrl, this.baza)
    } catch {
      throw new BladSerwera(`Niepoprawny adres pliku: ${plikUrl.slice(0, 200)}`)
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BladSerwera(`Niedozwolony adres pliku: ${url.protocol}`)
    // Pliki tylko z adresu serwera albo z hostów wpisanych w konfiguracji (dozwoloneHostyPlikow). Inaczej zlecenie
    // z przejętego serwera mogłoby kazać agentowi odpytywać router, NAS czy panel drukarki w sieci magazynu.
    const wlasny = url.origin === this.baza.origin
    if (!wlasny && !this.hostDozwolony(url)) throw new BladSerwera(`Niedozwolony host pliku: ${url.host}`)
    // Token stanowiska tylko do własnego serwera; obcy host (np. podpisany link do magazynu plików) dostaje żądanie bez niego.
    const odp = await this.zadanie(url, { method: 'GET' }, wlasny)
    const deklarowany = Number(odp.headers.get('content-length'))
    if (deklarowany > maksBajtow) throw new BladSerwera(`Plik za duży (${deklarowany} B, limit ${maksBajtow} B)`)
    const dane = await czytajZLimitem(odp, maksBajtow)
    if (dane.length === 0) throw new BladSerwera('Pobrany plik jest pusty')
    return dane
  }

  private hostDozwolony(url: URL): boolean {
    const lista = this.opcje.dozwoloneHostyPlikow ?? []
    const host = url.host.toLowerCase()
    const nazwa = url.hostname.toLowerCase()
    // Wpis bez portu pasuje do hosta na domyślnym porcie protokołu; wpis z portem — tylko do tego portu.
    return lista.some((w) => (w.includes(':') ? w === host : w === nazwa && url.port === ''))
  }

  private async zadanie(url: URL, init: RequestInit, zTokenem = true): Promise<Response> {
    const naglowki: Record<string, string> = { Accept: 'application/json, application/pdf, */*' }
    if (zTokenem) naglowki.Authorization = `Bearer ${this.opcje.token}`
    if (init.body) naglowki['Content-Type'] = 'application/json'
    let odp: Response
    try {
      // Bez podążania za przekierowaniami: adres docelowy jest sprawdzony wyżej, a przekierowanie
      // mogłoby zaprowadzić żądanie na host, którego agent nie sprawdził. Ochrona tokenu nie zależy wtedy od tego,
      // że fetch sam zdejmuje nagłówek Authorization przy zmianie hosta.
      odp = await this.fetch(url, { ...init, headers: naglowki, redirect: 'manual', signal: AbortSignal.timeout(this.opcje.timeoutMs) })
    } catch (e) {
      const err = e as Error
      const powod = err.name === 'TimeoutError' ? `brak odpowiedzi w ${Math.round(this.opcje.timeoutMs / 1000)} s` : err.message
      throw new BladSerwera(`Brak połączenia z serwerem (${url.host}): ${powod}`)
    }
    if (odp.status >= 300 && odp.status < 400) {
      await odp.body?.cancel().catch(() => undefined)
      let dokad = ''
      try {
        dokad = new URL(odp.headers.get('location') ?? '', url).origin
      } catch {
        dokad = ''
      }
      throw new BladSerwera(
        `Serwer odpowiedział przekierowaniem ${odp.status} dla ${url.pathname}${dokad ? ` na ${dokad}` : ''} — agent nie podąża za ` +
          'przekierowaniami; sprawdź adres „serwer” w agent-druku.json (np. https zamiast http)',
        odp.status,
      )
    }
    if (!odp.ok) {
      // Treść odpowiedzi nie trafia do komunikatu w całości — bywa długą stroną HTML.
      const tekst = (await odp.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ').trim()
      const podpowiedz =
        odp.status === 401 || odp.status === 403 ? ' — sprawdź token stanowiska w agent-druku.json' : ''
      const ponowZa = odp.status === 429 ? sekundyRetryAfter(odp.headers.get('retry-after')) : undefined
      throw new BladSerwera(`Serwer odpowiedział ${odp.status} dla ${url.pathname}${podpowiedz}${tekst ? `: ${tekst}` : ''}`, odp.status, ponowZa)
    }
    return odp
  }
}
