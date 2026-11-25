// DPD Polska bezpośrednio: klient ZAMÓWIENIA KURIERA (DPDServices REST `POST /public/courierorder/v1/packagesPickupCall`)
// za wyłącznikiem. Konstruktor wymaga jawnego `wylacznik: true`, a tworzy go tylko adapter `dpd.services.zapis.v1` przy
// włączonym zapisie i włączonym zamawianiu kuriera w koncie. Jedyna dozwolona ścieżka to zamówienie kuriera.
// Bez ponawiania: przerwane połączenie, 5xx, strona zapory i nieczytelna odpowiedź po wysłaniu to NIEJEDNOZNACZNY,
// bo DPD mógł przyjąć zlecenie, a drugie żądanie zamówiłoby drugi podjazd. Rozstrzyga człowiek (panel albo telefon DPD).
// Powód odmowy: tylko opis błędu z odpowiedzi DPD, bez wartości z żądania (dane nadawcy) i bez loginu i hasła.
import { czyStronaZapory, DPD_ZAPORA, DpdPolaczenie } from './dpd'
import { czyPewnaOdmowaKuriera, wynikOdmowyDpd, type OpcjeZapisuDpd, type WynikZapisuDpd } from './dpd-zapis'
import { fetchWithTimeout, ReadOnlyViolation, SourceError } from './http'

export const DPD_SCIEZKA_KURIER = '/public/courierorder/v1/packagesPickupCall'
const NIE_WIADOMO = 'nie wiadomo, czy DPD przyjął zamówienie kuriera; sprawdź w panelu DPD albo telefonicznie, nie zamawiaj drugi raz'

export class DpdKurier {
  private readonly conn: DpdPolaczenie
  private readonly timeoutMs: number

  constructor(o: OpcjeZapisuDpd) {
    if ((o as { wylacznik?: unknown }).wylacznik !== true) throw new Error('Zamawianie kuriera DPD wyłączone: klient wymaga jawnego wyłącznika')
    this.conn = new DpdPolaczenie(o.baseUrl, o.auth, o.fetchImpl ?? fetch)
    this.timeoutMs = o.timeoutMs ?? 60_000
  }

  /** Zamówienie kuriera: jedno żądanie, bez ponawiania. */
  zamow(body: unknown): Promise<WynikZapisuDpd> {
    return this.post(DPD_SCIEZKA_KURIER, body)
  }

  /** Ścieżka spoza listy (przesyłki, etykiety, protokół) = wyjątek przed wysyłką. */
  async post(path: string, body: unknown): Promise<WynikZapisuDpd> {
    if (path !== DPD_SCIEZKA_KURIER) throw new ReadOnlyViolation(`DPD: ścieżka „${path}” nie jest dozwolona dla zamawiania kuriera`)
    let res: Response
    try {
      res = await fetchWithTimeout(this.conn.fetchImpl, this.conn.url(path), this.conn.init(body), this.timeoutMs)
    } catch (e) {
      const m = e instanceof SourceError ? this.conn.clean(e.message) : 'przerwane połączenie'
      return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `DPD zamówienie kuriera: ${m}; ${NIE_WIADOMO}` }
    }
    if (res.status >= 500) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `DPD zamówienie kuriera: HTTP ${res.status}; ${NIE_WIADOMO}` }
    if (res.status === 429) return { ok: false, kind: 'PRZEJSCIOWY', message: 'DPD zamówienie kuriera: HTTP 429 (za dużo żądań), DPD go nie przyjął; spróbuj za chwilę' }
    if (!res.ok) {
      const tresc = await res.text().catch(() => '')
      return wynikOdmowyDpd(res, tresc, body, (s) => this.conn.clean(s), {
        odmowa: 'DPD odrzucił zamówienie kuriera',
        zapora: `DPD zamówienie kuriera: ${DPD_ZAPORA}; ${NIE_WIADOMO}`,
        slad: `DPD zamówienie kuriera: odmowa z numerem zlecenia w odpowiedzi; ${NIE_WIADOMO}`,
        pewnaOdmowa: czyPewnaOdmowaKuriera,
      })
    }
    const text = await res.text().catch(() => '')
    try {
      return { ok: true, body: JSON.parse(text) as unknown }
    } catch {
      if (czyStronaZapory(text)) return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `DPD zamówienie kuriera: ${DPD_ZAPORA}; ${NIE_WIADOMO}` }
      return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `DPD zamówienie kuriera: nieczytelna odpowiedź po wysłaniu; ${NIE_WIADOMO}` }
    }
  }
}
