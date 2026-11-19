// Limity serwera MCP, w pamięci procesu jak `ApiLimiters` (lib/api/klucze.ts). Wspólny limit żądań na klucz
// (120/min) liczy `authenticateApiKey`; tu dochodzą: wywołania narzędzi na klucz (60/min) i dzienny limit cięższych
// narzędzi (raporty: 300 na dobę na klucz). Przekroczenie = błąd narzędzia z czasem ponowienia (nie 429 i nie 500),
// żeby model zobaczył powód i poczekał. Przy kilku instancjach limit liczy się per instancja (jak w API v1).

export const TOOL_CALLS_PER_MINUTE = 60
export const HEAVY_CALLS_PER_DAY = 300
const DAY_MS = 24 * 3600_000

/** Okno przesuwne z czasem do zwolnienia miejsca (SlidingLimiter z lib/auth/limiter.ts go nie podaje). */
export class RetryLimiter {
  private hits = new Map<string, number[]>()
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** null = przepuszczone (i zapisane); liczba = sekundy do zwolnienia miejsca. */
  hit(key: string, now: number): number | null {
    const from = now - this.windowMs
    const list = (this.hits.get(key) ?? []).filter((t) => t > from)
    if (list.length >= this.max) {
      this.hits.set(key, list)
      return Math.max(1, Math.ceil((list[0]! + this.windowMs - now) / 1000))
    }
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > this.maxKeys) {
      for (const [k, v] of this.hits) if (!v.some((t) => t > from)) this.hits.delete(k)
      while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value as string)
    }
    return null
  }
}

export class McpLimiters {
  readonly calls = new RetryLimiter(TOOL_CALLS_PER_MINUTE, 60_000)
  readonly heavy = new RetryLimiter(HEAVY_CALLS_PER_DAY, DAY_MS)
}

let limiters = new McpLimiters()

export function mcpLimiters(): McpLimiters {
  return limiters
}

/** Tylko testy: liczniki od zera. */
export function resetMcpLimiters(): void {
  limiters = new McpLimiters()
}
