// limity tempa integracji (konto i pojedyncza zdolność) jako kubełek żetonów w Postgresie.
// Wzorzec z Open Integration Platform `platform/core/connector_rate_limiter.py` (commit ae43d1e, Apache-2.0,
// THIRD_PARTY_NOTICES.md), własna implementacja w TS: bez Redisa, jeden wiersz na (firma, konto, zakres).
//
// Dlaczego Postgres, a nie pamięć procesu: do tego samego konta wołają dwa procesy (panel: „Utwórz przesyłkę”, test
// połączenia; worker: odczyty, zapisy, automaty), a w hostingu może pracować więcej niż jeden worker. Licznik w pamięci
// dałby każdemu procesowi pełny limit platformy. Koszt: jedno zapytanie na wywołanie adaptera (obok żądania HTTP do
// platformy, które i tak trwa dłużej).
//
// Kubełek: pojemność = limit na minutę (pełna minuta zapasu na szczyt), uzupełnianie liniowe `limit / 60 000` żetonu na
// ms. Wywołanie zabiera jeden żeton; brak żetonu = czas do następnego (`retryAfterMs`). Zapis do kanału po odmowie jest
// odkładany (wynik PRZEJSCIOWY z `odlozone`), odczyt chwilę czeka (lib/integracje/oslona.ts). Współbieżność zdolności
// (`maxConcurrent`) pilnowana tylko w obrębie procesu (semafor niżej): to ochrona przed równoległym zalewem z jednego
// workera, a nie limit platformy.
import type { PrismaClient } from '@prisma/client'
import type { Capability, RateLimit } from '../adaptery/kontrakt'

/** Zakres kubełka całego konta (obok zakresów zdolności). */
export const ZAKRES_KONTA = '*'

export interface StanKubelka {
  tokens: number
  at: number
}

/**
 * Czysta część: stan po próbie zabrania żetonu. `granted` = żeton zabrany; inaczej `retryAfterMs` = czas do żetonu.
 * Zegar cofnięty (różne procesy) liczy się jak zero upływu.
 */
export function zabierzZeton(stan: StanKubelka | null, perMinute: number, now: number): { granted: boolean; retryAfterMs: number; stan: StanKubelka } {
  const rate = perMinute / 60_000
  const tokens = stan ? Math.min(perMinute, stan.tokens + Math.max(0, now - stan.at) * rate) : perMinute
  if (tokens >= 1) return { granted: true, retryAfterMs: 0, stan: { tokens: tokens - 1, at: now } }
  return { granted: false, retryAfterMs: Math.max(1, Math.ceil((1 - tokens) / rate)), stan: { tokens, at: now } }
}

/**
 * Atomowa próba zabrania żetonu z kubełka (firma z sesji klienta, RLS). Jedno zapytanie: wstawienie pełnego kubełka
 * minus jeden albo uzupełnienie i zabranie, gdy jest żeton. Dwa procesy naraz: blokada wiersza przy ON CONFLICT.
 */
export async function zajmijZeton(db: PrismaClient, klucz: string, zakres: string, perMinute: number, now: Date): Promise<{ granted: boolean; retryAfterMs: number }> {
  const rate = perMinute / 60_000
  const rows = await db.$queryRaw<{ granted: boolean; tokens: number }[]>`
    WITH t AS (SELECT ${now}::timestamp(3) AS teraz)
    INSERT INTO "IntegrationRateBucket" AS b ("integrationKey", scope, tokens, granted, "updatedAt")
    SELECT ${klucz}, ${zakres}, ${perMinute}::float8 - 1, true, teraz FROM t
    ON CONFLICT ("organizationId", "integrationKey", scope) DO UPDATE SET
      tokens = CASE
        WHEN LEAST(${perMinute}::float8, b.tokens + GREATEST(0, EXTRACT(EPOCH FROM (EXCLUDED."updatedAt" - b."updatedAt")) * 1000) * ${rate}::float8) >= 1
        THEN LEAST(${perMinute}::float8, b.tokens + GREATEST(0, EXTRACT(EPOCH FROM (EXCLUDED."updatedAt" - b."updatedAt")) * 1000) * ${rate}::float8) - 1
        ELSE LEAST(${perMinute}::float8, b.tokens + GREATEST(0, EXTRACT(EPOCH FROM (EXCLUDED."updatedAt" - b."updatedAt")) * 1000) * ${rate}::float8)
      END,
      granted = LEAST(${perMinute}::float8, b.tokens + GREATEST(0, EXTRACT(EPOCH FROM (EXCLUDED."updatedAt" - b."updatedAt")) * 1000) * ${rate}::float8) >= 1,
      "updatedAt" = GREATEST(b."updatedAt", EXCLUDED."updatedAt")
    RETURNING granted, tokens`
  const r = rows[0]
  if (!r) return { granted: true, retryAfterMs: 0 }
  if (r.granted) return { granted: true, retryAfterMs: 0 }
  return { granted: false, retryAfterMs: Math.max(1, Math.ceil((1 - Number(r.tokens)) / rate)) }
}

/** Oddanie żetonu (zdolność dostała żeton, a konto nie): kubełek wraca do stanu sprzed próby. */
async function oddajZeton(db: PrismaClient, klucz: string, zakres: string, perMinute: number): Promise<void> {
  await db.$executeRaw`UPDATE "IntegrationRateBucket" SET tokens = LEAST(${perMinute}::float8, tokens + 1)
    WHERE "integrationKey" = ${klucz} AND scope = ${zakres}`
}

export interface WynikLimitu {
  granted: boolean
  retryAfterMs: number
  /** Który limit odmówił (do komunikatu): limit zdolności albo konta. */
  zakres?: string
  perMinute?: number
}

/**
 * Limit wywołania zdolności `cap` konta `klucz`: najpierw limit zdolności (gdy manifest go ma), potem konta. Odmowa
 * konta oddaje żeton zdolności, więc nieudana próba niczego nie zużywa. `cap` null = tylko limit konta (np. etykieta).
 */
export async function sprawdzLimit(db: PrismaClient, klucz: string, rate: RateLimit, cap: Capability | null, now: Date): Promise<WynikLimitu> {
  const lc = cap ? rate.perCapability?.[cap] : undefined
  if (lc) {
    const r = await zajmijZeton(db, klucz, cap!, lc.requestsPerMinute, now)
    if (!r.granted) return { ...r, zakres: cap!, perMinute: lc.requestsPerMinute }
  }
  const k = await zajmijZeton(db, klucz, ZAKRES_KONTA, rate.requestsPerMinute, now)
  if (!k.granted) {
    if (lc) await oddajZeton(db, klucz, cap!, lc.requestsPerMinute)
    return { ...k, zakres: ZAKRES_KONTA, perMinute: rate.requestsPerMinute }
  }
  return { granted: true, retryAfterMs: 0 }
}

// ─── Współbieżność zdolności w procesie ──────────────────────────────────────

const zajete = new Map<string, number>()

/** Zajęcie miejsca zdolności w procesie; false = wszystkie zajęte. Zwolnienie: `zwolnijMiejsce`. */
export function zajmijMiejsce(klucz: string, cap: Capability, max: number | undefined): boolean {
  if (!max) return true
  const k = `${klucz}|${cap}`
  const n = zajete.get(k) ?? 0
  if (n >= max) return false
  zajete.set(k, n + 1)
  return true
}

export function zwolnijMiejsce(klucz: string, cap: Capability, max: number | undefined): void {
  if (!max) return
  const k = `${klucz}|${cap}`
  const n = (zajete.get(k) ?? 1) - 1
  if (n <= 0) zajete.delete(k)
  else zajete.set(k, n)
}
