// Plik życia workera: timer pisze go co 30 s, ale tylko wtedy, gdy pętla zadań niedawno przeszła
// obrót (`lastTick`). Sam timer mówił „proces żyje”, nie „pętla chodzi” — przy zawieszonym połączeniu z bazą worker
// był `healthy`. Limit = górne oszacowanie najdłuższego zadania (import katalogu), bo w trakcie zadania pętla stoi.

export const MAX_TICK_AGE_MS = 2 * 3600_000

/** Czy zapisać plik życia: ostatni obrót pętli młodszy niż `maxAgeMs`. */
export function loopAlive(now: number, lastTick: number, maxAgeMs: number = MAX_TICK_AGE_MS): boolean {
  return now - lastTick < maxAgeMs
}
