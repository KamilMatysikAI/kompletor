// DPD Polska: zdarzenia przesyłki z usługi DPDInfoServices (SOAP), TYLKO DO ODCZYTU. Jedyna metoda:
// `getEventsForWaybillV1(waybill, eventsSelectType, language, authDataV1)` → `CustomerEventsResponseV3` z listą
// `eventsList` (pola `businessCode`, `waybill`, `description`, `eventTime`, …). Źródło: „DPDInfoServices. Specyfikacja
// biznesowa”, wersja 1.0.7 z 06.02.2015, rozdz. 9.1.6 i 10 (przestrzeń nazw `http://events.dpdinfoservices.dpd.com.pl/`,
// przykładowe koperty w rozdz. 11). Usługa ma osobne dane logowania (login, hasło, kanał kliencki) od DPD, inne niż
// DPDServices REST; `getEventsForWaybill` według specyfikacji działa bez uwzględniania kanału.
// [NIEPEWNE] Adres usługi nie stoi w specyfikacji: firma wpisuje go z danych od DPD, a adapter przyjmuje tylko adres
// https w domenie dpd.com.pl (login i hasło nie mogą pójść gdzie indziej). Do potwierdzenia na danych od DPD przed
// włączeniem śledzenia: adres, zachowanie przy nieznanym numerze listu (pusta lista czy Fault).
import { fetchWithTimeout, type FetchLike, type RetryOptions, SourceError, withRetry } from './http'

/** Tylko https w domenie DPD Polska, bez zapytania i fragmentu. */
export const DPD_INFO_URL_RE = /^https:\/\/([a-z0-9-]+\.)*dpd\.com\.pl(\/[A-Za-z0-9._/-]*)?$/
export const DPD_INFO_NS = 'http://events.dpdinfoservices.dpd.com.pl/'
const METODA = 'getEventsForWaybillV1'
const NUMER_LISTU_RE = /^[A-Za-z0-9]{6,40}$/
/** Większej odpowiedzi nie czytamy (lista zdarzeń jednej paczki to kilka KB). */
export const MAKS_ODPOWIEDZI = 2 * 1024 * 1024

export interface DpdInfoLogowanie {
  login: string
  haslo: string
  /** Kanał kliencki z danych od DPD; getEventsForWaybill go nie wymaga, więc może być pusty. */
  kanal: string | null
}

export interface ZdarzenieDpd {
  kod: string
  opis: string | null
  czas: string | null
}

/**
 * Czego dotyczy błąd usługi: KONTO = odrzucone dane logowania (401/403, Fault o logowaniu albo uprawnieniach; minie po
 * poprawie ustawień, przesyłki zostają w śledzeniu); PRZESYLKA = zły numer listu (koniec śledzenia tej przesyłki);
 * null = przejściowy (sieć, 429, 5xx, inny Fault, pusta albo nieczytelna treść; następny przebieg pyta znowu).
 */
export type ZakresBleduDpd = 'KONTO' | 'PRZESYLKA' | null

export class DpdInfoError extends SourceError {
  constructor(
    message: string,
    retryable: boolean,
    readonly zakres: ZakresBleduDpd = null,
  ) {
    super(message, retryable)
    this.name = 'DpdInfoError'
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** Koperta jak w przykładach specyfikacji (rozdz. 11): elementy parametrów bez przedrostka przestrzeni nazw. */
export function kopertaZdarzen(numer: string, auth: DpdInfoLogowanie): string {
  const kanal = auth.kanal ? `<channel>${esc(auth.kanal)}</channel>` : ''
  return (
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:even="${DPD_INFO_NS}"><soapenv:Header/><soapenv:Body>` +
    `<even:${METODA}><waybill>${esc(numer)}</waybill><eventsSelectType>ALL</eventsSelectType><language>PL</language>` +
    `<authDataV1>${kanal}<login>${esc(auth.login)}</login><password>${esc(auth.haslo)}</password></authDataV1>` +
    `</even:${METODA}></soapenv:Body></soapenv:Envelope>`
  )
}

const pole = (xml: string, nazwa: string): string | null => {
  const m = new RegExp(`<(?:[A-Za-z0-9_]+:)?${nazwa}>([^<]*)</(?:[A-Za-z0-9_]+:)?${nazwa}>`).exec(xml)
  return m ? unesc(m[1]!).trim() || null : null
}

/**
 * Fault o odrzuconym logowaniu albo braku uprawnień (treść `faultstring`). Specyfikacja nie podaje treści Faultów, więc
 * rozpoznanie jest wąskie; każdy inny Fault (awaria serwera, nieznany numer) jest przejściowy.
 */
const FAULT_LOGOWANIA_RE = /login|has[łl]o|password|uprawnie|autoryz|uwierzyteln|authenticat|authori[sz]|credential|access denied|odmowa dost/i

/**
 * Zdarzenia z odpowiedzi. Fault o logowaniu = błąd konta; każdy inny Fault i odpowiedź bez wyniku metody = przejściowy
 * (nie wiadomo, co z przesyłką). Brak `eventsList` w wyniku metody = pusta lista. Z treści Faultu w komunikacie tylko
 * 120 znaków `faultstring` (dane logowania czyści wołający).
 */
export function zdarzeniaZOdpowiedzi(xml: string): ZdarzenieDpd[] {
  if (/<(?:[A-Za-z0-9_]+:)?Fault[\s>]/.test(xml)) {
    const opis = pole(xml, 'faultstring')
    const logowanie = !!opis && FAULT_LOGOWANIA_RE.test(opis)
    throw new DpdInfoError(`DPD InfoServices odrzucił zapytanie${opis ? `: ${opis.slice(0, 120)}` : ''}`, !logowanie, logowanie ? 'KONTO' : null)
  }
  if (!new RegExp(`${METODA}Response`).test(xml)) throw new DpdInfoError('DPD InfoServices: nieczytelna odpowiedź', true)
  const wynik: ZdarzenieDpd[] = []
  const re = /<(?:[A-Za-z0-9_]+:)?eventsList>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?eventsList>/g
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const kod = pole(m[1]!, 'businessCode')
    if (kod && /^\d{6}$/.test(kod)) wynik.push({ kod, opis: pole(m[1]!, 'description'), czas: pole(m[1]!, 'eventTime') })
  }
  return wynik
}

/**
 * Treść odpowiedzi strumieniem: najwyżej `maks` bajtów i `timeoutMs` na całe czytanie (zegar `fetchWithTimeout` kończy
 * się na nagłówkach). Przekroczony czas, zerwane połączenie = przejściowy błąd; za duża treść = błąd bez ponawiania w
 * tym wywołaniu (następny przebieg pyta znowu). Czytanie przerwane w każdym z tych przypadków.
 */
export async function czytajTresc(res: Response, maks: number, timeoutMs: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const czesci: Uint8Array[] = []
  let razem = 0
  let zegar: ReturnType<typeof setTimeout> | undefined
  const czas = new Promise<never>((_, odrzuc) => {
    zegar = setTimeout(() => odrzuc(new DpdInfoError('DPD InfoServices: przekroczony czas czytania odpowiedzi', true)), timeoutMs)
  })
  czas.catch(() => undefined)
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>
      try {
        r = await Promise.race([reader.read(), czas])
      } catch (e) {
        if (e instanceof DpdInfoError) throw e
        throw new DpdInfoError('DPD InfoServices: przerwane czytanie odpowiedzi', true)
      }
      if (r.done) break
      razem += r.value.byteLength
      if (razem > maks) throw new DpdInfoError('DPD InfoServices: za duża odpowiedź', false)
      czesci.push(r.value)
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined)
    throw e
  } finally {
    clearTimeout(zegar)
  }
  const bufor = new Uint8Array(razem)
  let off = 0
  for (const c of czesci) {
    bufor.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder('utf-8').decode(bufor)
}

export class DpdSledzenie {
  constructor(
    private readonly url: string,
    private readonly auth: DpdInfoLogowanie,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
    private readonly retry: RetryOptions = { attempts: 2, baseDelayMs: 1_000 },
  ) {
    if (!DPD_INFO_URL_RE.test(url)) throw new Error('Zły adres usługi śledzenia DPD (tylko https w domenie dpd.com.pl)')
    if (!auth.login || !auth.haslo) throw new Error('Brak loginu albo hasła usługi śledzenia DPD')
  }

  /** Bez loginu i hasła, nawet gdy trafią do komunikatu biblioteki sieciowej. */
  private clean(m: string): string {
    return [this.auth.haslo, this.auth.login].reduce((s, x) => (x ? s.split(x).join('***') : s), m)
  }

  async zdarzenia(numer: string): Promise<ZdarzenieDpd[]> {
    if (!NUMER_LISTU_RE.test(numer)) throw new DpdInfoError('DPD: zły numer listu przewozowego', false, 'PRZESYLKA')
    return withRetry(async () => {
      let res: Response
      try {
        res = await fetchWithTimeout(
          this.fetchImpl,
          this.url,
          { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml', SOAPAction: '""' }, body: kopertaZdarzen(numer, this.auth) },
          this.timeoutMs,
        )
      } catch (e) {
        if (e instanceof SourceError) throw new DpdInfoError(`DPD InfoServices: ${this.clean(e.message)}`, e.retryable)
        throw e
      }
      // odmowa dostępu: bez czytania treści; komunikat bez „HTTP 401”, żeby nikt nie wziął go za odmowę konta nadawania
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => undefined)
        throw new DpdInfoError(`DPD InfoServices: odmowa dostępu (kod ${res.status}), sprawdź dane usługi śledzenia`, false, 'KONTO')
      }
      const dl = Number(res.headers.get('content-length'))
      if (Number.isFinite(dl) && dl > MAKS_ODPOWIEDZI) {
        await res.body?.cancel().catch(() => undefined)
        throw new DpdInfoError('DPD InfoServices: za duża odpowiedź', false)
      }
      const text = await czytajTresc(res, MAKS_ODPOWIEDZI, this.timeoutMs)
      if (res.status === 429) throw new DpdInfoError('DPD InfoServices: HTTP 429', true)
      // SOAP zgłasza błędy jako HTTP 500 z Fault: Fault rozstrzyga parser (logowanie = konto, reszta przejściowa)
      if (res.status >= 500 && !/Fault[\s>]/.test(text)) throw new DpdInfoError(`DPD InfoServices: HTTP ${res.status}`, true)
      // inny kod 4xx bez Faultu (zły adres usługi, zła metoda) = ustawienia konta, nie ta przesyłka
      if (!res.ok && res.status < 500) throw new DpdInfoError(`DPD InfoServices: kod ${res.status}, sprawdź adres usługi śledzenia`, false, 'KONTO')
      try {
        return zdarzeniaZOdpowiedzi(text)
      } catch (e) {
        if (e instanceof DpdInfoError) throw new DpdInfoError(this.clean(e.message), e.retryable, e.zakres)
        throw e
      }
    }, this.retry)
  }
}
