// Wspólne: limit tempa, ponawianie z backoffem, timeout. Bez logowania nagłówków i treści żądań (sekrety).

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export class ReadOnlyViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReadOnlyViolation'
  }
}

export class SourceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** kod HTTP odpowiedzi, gdy błąd pochodzi z odpowiedzi serwera (brak = sieć, timeout, zła treść). */
    readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'SourceError'
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Pilnuje minimalnego odstępu między żądaniami jednego klienta (limity BL, wFirmy, Mirakl). */
export class Throttle {
  private last = 0 // zarezerwowany termin ostatniego wywołania
  private lastStart = 0 // faktyczny start ostatniego wywołania
  constructor(private readonly minIntervalMs: number) {}
  async wait(): Promise<void> {
    // rezerwacja terminu przed czekaniem: równoległe wywołania (dwa zadania na wspólnym odstępie konta) nie strzelają razem
    const at = Math.max(Date.now(), this.last + this.minIntervalMs)
    this.last = at
    // odstęp liczony też od FAKTYCZNEGO startu poprzedniego wywołania: spóźniony start poprzednika (zegar, obciążenie)
    // nie skraca przerwy, a timer budzący kilka ms przed terminem nie wypuszcza za wcześnie
    for (;;) {
      const now = Date.now()
      const target = Math.max(at, this.lastStart + this.minIntervalMs)
      if (now >= target) break
      await sleep(target - now)
    }
    this.lastStart = Date.now()
    if (this.lastStart > this.last) this.last = this.lastStart
  }
}

export interface RetryOptions {
  attempts: number
  baseDelayMs: number
}

/**
 * Ponawia tylko błędy oznaczone jako przejściowe: SourceError.retryable (w tym błąd sieci i timeout z
 * fetchWithTimeout) i AbortError. Błąd w kodzie (SyntaxError z res.json(), TypeError) leci od razu.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const retryable = e instanceof SourceError ? e.retryable : (e as { name?: string } | null)?.name === 'AbortError'
      if (!retryable || i === opts.attempts - 1) throw e
      await sleep(opts.baseDelayMs * 2 ** i)
    }
  }
  throw lastErr
}

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    throw new SourceError(`błąd sieci: ${e instanceof Error ? e.message : String(e)}`, true)
  } finally {
    clearTimeout(t)
  }
}
