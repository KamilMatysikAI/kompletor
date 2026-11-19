// Kolejka zadań w Postgresie (FOR UPDATE SKIP LOCKED): kilka workerów nie weźmie tego samego zadania,
// błąd zadania trafia do Job.lastError (nie tylko do logu), po maxAttempts zadanie staje jako FAILED.
// zadanie należy do firmy (Job.organizationId). `enqueue` woła klient firmy (firma z sesji, dedupeKey
// unikalny w obrębie firmy); `claimNext`/`complete`/`fail`/`reapStale` woła worker klientem systemowym (kolejka
// wszystkich firm), a handler dostaje klienta firmy zadania (lib/worker/petla.ts).
import type { Prisma, PrismaClient } from '@prisma/client'
import { isNonRetryable } from '../bledy'

export interface ClaimedJob {
  id: string
  organizationId: string
  kind: string
  payload: Prisma.JsonValue
  attempts: number
  maxAttempts: number
}

export async function enqueue(
  db: PrismaClient,
  kind: string,
  payload: Prisma.InputJsonValue | null = null,
  opts: { dedupeKey?: string; runAfter?: Date; maxAttempts?: number } = {},
): Promise<string | null> {
  try {
    const job = await db.job.create({
      data: {
        kind,
        payload: payload ?? undefined,
        dedupeKey: opts.dedupeKey ?? null,
        runAfter: opts.runAfter ?? new Date(),
        maxAttempts: opts.maxAttempts ?? 5,
      },
      select: { id: true },
    })
    return job.id
  } catch (e) {
    // To samo zadanie już czeka (dedupeKey) — idempotentnie nic nie dokładamy.
    if ((e as { code?: string }).code === 'P2002') return null
    throw e
  }
}

/**
 * rodzaje zadań „w tle” (zdjęcia z ofert i z feedu, packshot AI). Worker bierze je dopiero, gdy nie czeka
 * żadne dojrzałe zadanie innego rodzaju (faktura, WZ, etykieta, mail, synchronizacja), więc seria 200 zdjęć z wolnego
 * sklepu nie odsuwa dokumentów sprzedaży. Same zdjęcia się nie gubią: gdy nic pilnego nie czeka, idą w kolejności
 * `runAfter`. Teksty muszą się zgadzać ze stałymi `ZDJECIA_Z_OFERTY_JOB`, `FEED_JOB`, `PACKSHOT_JOB` (pilnuje tego
 * test `tests/kolejka.integration.test.ts`; import stałych stąd dałby cykl, bo te moduły importują `enqueue`).
 */
// masowe „Przygotuj oferty” (`OFERTY_MASOWO_JOB`) też w tle: sam odczyt kanałów, nie odsuwa dokumentów
export const RODZAJE_TLA = ['produkt-zdjecia-z-oferty', 'produkty-zdjecia-z-feedu', 'produkt-packshot', 'oferty-przygotuj-masowo'] as const

export async function claimNext(db: PrismaClient, workerId: string): Promise<ClaimedJob | null> {
  const tlo = [...RODZAJE_TLA]
  const rows = await db.$queryRaw<ClaimedJob[]>`
    UPDATE "Job" SET status = 'RUNNING', "lockedAt" = now(), "lockedBy" = ${workerId},
           attempts = attempts + 1, "updatedAt" = now()
    WHERE id = (
      SELECT id FROM "Job"
      WHERE status = 'PENDING' AND "runAfter" <= now()
        -- zadania firmy wyłączonej czekają na jej włączenie
        AND "organizationId" IN (SELECT o.id FROM "Organization" o WHERE o.active)
      -- najpierw zadania pilne, zadania w tle (RODZAJE_TLA) dopiero, gdy pilnych dojrzałych brak
      ORDER BY CASE WHEN kind = ANY(${tlo}::text[]) THEN 1 ELSE 0 END, "runAfter", "createdAt"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, "organizationId", kind, payload, attempts, "maxAttempts"`
  return rows[0] ?? null
}

/** Oddaje pobrane zadanie bez wykonania (np. firma jeszcze niewidoczna dla workera): bez zużycia próby. */
export async function release(db: PrismaClient, job: ClaimedJob, delayMs: number, now = new Date()): Promise<void> {
  await db.job.update({
    where: { id: job.id },
    data: { status: 'PENDING', lockedAt: null, lockedBy: null, attempts: { decrement: 1 }, runAfter: new Date(now.getTime() + delayMs) },
  })
}

export async function complete(db: PrismaClient, id: string): Promise<void> {
  await db.job.update({ where: { id }, data: { status: 'DONE', lockedAt: null, lastError: null, dedupeKey: null } })
}

export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000)
}

export async function fail(db: PrismaClient, job: ClaimedJob, error: unknown, now = new Date()): Promise<'RETRY' | 'FAILED'> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000)
  // Błąd nieponawialny (brak kluczy, odmowa importu) kończy zadanie od razu — bez kolejnych pełnych odczytów API.
  const final = job.attempts >= job.maxAttempts || isNonRetryable(error)
  await db.job.update({
    where: { id: job.id },
    data: final
      ? { status: 'FAILED', lockedAt: null, lastError: message, dedupeKey: null }
      : { status: 'PENDING', lockedAt: null, lastError: message, runAfter: new Date(now.getTime() + backoffMs(job.attempts)) },
  })
  return final ? 'FAILED' : 'RETRY'
}

/**
 * Zadania porzucone przez martwy proces (RUNNING dłużej niż limit): z wyczerpanymi próbami → FAILED
 * (inaczej zadanie, które zabija worker, krążyłoby bez końca — przegląd r2, uwaga 6), reszta → PENDING
 * z opóźnieniem jak po błędzie (backoffMs). Zwraca liczbę przywróconych i zamkniętych.
 */
export async function reapStale(db: PrismaClient, olderThanMs: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs)
  // Jedna transakcja: spójny licznik i jeden punkt awarii (drobna 11).
  const [failed, requeued] = await db.$transaction([
    db.$executeRaw`
    UPDATE "Job" SET status = 'FAILED', "lockedAt" = NULL, "lockedBy" = NULL, "dedupeKey" = NULL,
           "lastError" = 'porzucone przez worker (timeout), wyczerpane próby', "updatedAt" = ${now}
    WHERE status = 'RUNNING' AND "lockedAt" < ${cutoff} AND attempts >= "maxAttempts"`,
    // backoffMs w SQL: min(30 s · 2^(attempts−1), 1 h)
    db.$executeRaw`
    UPDATE "Job" SET status = 'PENDING', "lockedAt" = NULL, "lockedBy" = NULL,
           "lastError" = 'porzucone przez worker (timeout)', "updatedAt" = ${now},
           "runAfter" = ${now}::timestamp + LEAST(30000 * POWER(2, GREATEST(0, attempts - 1)), 3600000) * INTERVAL '1 millisecond'
    WHERE status = 'RUNNING' AND "lockedAt" < ${cutoff} AND attempts < "maxAttempts"`,
  ])
  return failed + requeued
}
