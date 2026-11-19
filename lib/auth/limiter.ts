// Ograniczenia logowania w pamięci procesu: limit prób per IP w oknie czasu i semafor na
// równoległe liczenie argon2 (19 MiB na próbę — bez semafora seria POST-ów zjada pamięć serwera). Jeden proces
// panelu = jeden licznik; przy kilku instancjach limit liczy się per instancja (wystarcza na start).

export class SlidingLimiter {
  private hits = new Map<string, number[]>()
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Rejestruje próbę; false = przekroczony limit (próba nie powinna iść dalej). */
  hit(key: string, now = Date.now()): boolean {
    const from = now - this.windowMs
    const list = (this.hits.get(key) ?? []).filter((t) => t > from)
    if (list.length >= this.max) {
      this.hits.set(key, list)
      return false
    }
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > this.maxKeys) this.prune(now)
    return true
  }

  prune(now = Date.now()): void {
    const from = now - this.windowMs
    for (const [k, v] of this.hits) if (!v.some((t) => t > from)) this.hits.delete(k)
    // nadal za dużo kluczy (atak z wielu adresów): najstarsze wypadają
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value as string)
  }
}

export class Semaphore {
  private active = 0
  private queue: (() => void)[] = []
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Zwalniający przekazuje miejsce czekającemu bez zmniejszania licznika, więc nowy wywołujący nie wciśnie się
    // między dekrementację a wybudzenie (drugi przegląd, drobne 3: inaczej chwilowo max+1).
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r))
    else this.active++
    try {
      return await fn()
    } finally {
      const next = this.queue.shift()
      if (next) next()
      else this.active--
    }
  }

  get running(): number {
    return this.active
  }
}

/**
 * IP klienta za odwrotnym proxy (Traefik w Coolify dopisuje adres na KOŃCU X-Forwarded-For; pierwsze wpisy może
 * podać sam klient, więc ich nie ufamy). Bez nagłówków: „nieznany” (wspólny kubełek).
 */
export function clientIp(h: { get(name: string): string | null }): string {
  const xff = h.get('x-forwarded-for')
  const last = xff?.split(',').map((s) => s.trim()).filter(Boolean).at(-1)
  return (last || h.get('x-real-ip')?.trim() || 'nieznany').slice(0, 64)
}
