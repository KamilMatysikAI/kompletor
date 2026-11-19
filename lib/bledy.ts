// Błędy, których nie ma sensu ponawiać (brak kluczy, odmowa importu, zła konfiguracja). Kolejka workera
// (`lib/worker/kolejka.ts` → `fail`) zamyka takie zadanie jako FAILED po pierwszej próbie, zamiast pięć razy
// powtarzać pełny odczyt API.
export class NonRetryableError extends Error {
  readonly nonRetryable = true
  constructor(message: string) {
    super(message)
    this.name = 'NonRetryableError'
  }
}

export function isNonRetryable(e: unknown): boolean {
  return e instanceof NonRetryableError || (e as { nonRetryable?: unknown } | null)?.nonRetryable === true
}
