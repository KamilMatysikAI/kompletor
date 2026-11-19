// DPD Polska bezpośrednio — klient ZAPISU DPDServices za wyłącznikiem. Konstruktor wymaga jawnego
// `wylacznik: true`, a tworzy go tylko adapter `dpd.services.zapis.v1` przy `zapisWlaczony: true` w konfiguracji firmy;
// host dziś go nie woła. Dozwolone wyłącznie `generatePackagesNumbers` (numery listów, kosztuje) i `generateSpedLabels`
// (etykieta). Bez ponawiania: timeout, błąd sieci i 5xx po wysłaniu to NIEJEDNOZNACZNY, bo DPD nie ma odczytu paczki
// po referencji [NIEPEWNE] i ponowienie mogłoby utworzyć drugą paczkę. Treść odpowiedzi nie trafia do komunikatów.
import type { FailureKind } from '../adaptery/kontrakt'
import { DpdPolaczenie, type DpdLogowanie } from './dpd'
import { fetchWithTimeout, ReadOnlyViolation, SourceError, type FetchLike } from './http'

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
    if (!res.ok) return { ok: false, kind: 'TRWALY', message: `DPD ${path}: HTTP ${res.status}` }
    const text = await res.text().catch(() => '')
    try {
      return { ok: true, body: JSON.parse(text) as unknown }
    } catch {
      return { ok: false, kind: 'NIEJEDNOZNACZNY', message: `DPD ${path}: nieczytelna odpowiedź po wysłaniu` }
    }
  }
}
