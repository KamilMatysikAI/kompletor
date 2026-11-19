// wFirma API2 — klient TYLKO DO ODCZYTU (*/find, */get). Ten sam klucz wystawia faktury, więc odczyt
// idzie wolno (limity wFirmy są ruchome) i nigdy nie woła add/edit/delete.
import { fetchWithTimeout, ReadOnlyViolation, SourceError, Throttle, withRetry, type FetchLike } from './http'

const BASE = 'https://api2.wfirma.pl'
const READ_ONLY_PATH = /^[a-z_]+\/(find|get\/\d+)$/

export function assertWfirmaReadOnly(path: string): void {
  if (!READ_ONLY_PATH.test(path)) {
    throw new ReadOnlyViolation(`wFirma: ścieżka „${path}” nie jest odczytem (dozwolone tylko */find i */get/<id>)`)
  }
}

// Limit wFirmy („AUTH FAILED LIMIT WAIT 5 MINUTES”, „TOTAL REQUESTS LIMIT EXCEEDED”) NIE jest ponawiany:
// tym samym kluczem BL wystawia faktury, a każde żądanie w trakcie blokady może ją przedłużyć (spec 3.4, 8.1;
// przegląd r2, uwaga 5). Import kończy się błędem źródła, ponowienie robi kolejny przebieg po czasie.
const LIMIT = /LIMIT/i
const RETRYABLE = /SNAPSHOT LOCK|EXECUTION TIME/i

export interface WfirmaKeys {
  accessKey: string
  secretKey: string
  appKey: string
  companyId: string
}

export class WfirmaReadOnly {
  private readonly throttle: Throttle

  constructor(
    private readonly keys: WfirmaKeys,
    private readonly fetchImpl: FetchLike = fetch,
    minIntervalMs = 1_200,
  ) {
    if (!keys.accessKey || !keys.secretKey || !keys.appKey) throw new Error('Brak kluczy wFirmy')
    if (!keys.companyId) throw new Error('Brak WFIRMA_COMPANY_ID')
    this.throttle = new Throttle(minIntervalMs)
  }

  async call<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
    assertWfirmaReadOnly(path)
    return withRetry(
      async () => {
        await this.throttle.wait()
        const url = `${BASE}/${path}?inputFormat=json&outputFormat=json&company_id=${encodeURIComponent(this.keys.companyId)}`
        const res = await fetchWithTimeout(
          this.fetchImpl,
          url,
          {
            method: 'POST',
            headers: {
              accessKey: this.keys.accessKey,
              secretKey: this.keys.secretKey,
              appKey: this.keys.appKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          },
          90_000,
        )
        if (res.status === 429) throw new SourceError(`wFirma ${path}: HTTP 429 (limit) — bez ponawiania`, false)
        if (res.status >= 500) throw new SourceError(`wFirma ${path}: HTTP ${res.status}`, true)
        if (!res.ok) throw new SourceError(`wFirma ${path}: HTTP ${res.status}`, false)
        const json = (await res.json()) as Record<string, unknown>
        const code = String((json['status'] as Record<string, unknown> | undefined)?.['code'] ?? '')
        if (code !== 'OK') {
          if (LIMIT.test(code)) throw new SourceError(`wFirma ${path}: ${code} — limit, bez ponawiania`, false)
          throw new SourceError(`wFirma ${path}: ${code}`, RETRYABLE.test(code))
        }
        return json as T
      },
      { attempts: 4, baseDelayMs: 5_000 },
    )
  }
}

/** Odpowiedzi wFirmy mają kolekcje jako obiekty {"0": {good: …}, "parameters": …}. */
export function wfirmaItems<T>(collection: unknown, key: string): T[] {
  if (!collection || typeof collection !== 'object') return []
  const out: T[] = []
  for (const [k, v] of Object.entries(collection as Record<string, unknown>)) {
    if (k === 'parameters') continue
    const item = (v as Record<string, unknown> | null)?.[key]
    if (item) out.push(item as T)
  }
  return out
}
