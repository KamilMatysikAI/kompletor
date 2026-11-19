// znacznik ostatniego udanego przebiegu zadania cienia (`ShadowJobState`).
// `Job` nie ma `lastOkAt`, a decyzja „czy faktury BL są czytane na bieżąco” potrzebuje chwili startu ostatniego
// kompletnego odczytu: wszystko, co powstało w BL przed tą chwilą, jest już w kopii faktur.
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'

/** Zapis chwili STARTU udanego przebiegu. Nie cofa znacznika (przebieg starszy niż zapisany nic nie zmienia). */
export async function zapiszUdanyPrzebieg(db: PrismaClient, job: string, startedAt: Date): Promise<void> {
  const organizationId = organizationIdOf(db)
  await db.$executeRaw`INSERT INTO "ShadowJobState" ("organizationId", job, "lastOkAt", "updatedAt")
    VALUES (${organizationId}, ${job}, ${startedAt}, now())
    ON CONFLICT ("organizationId", job) DO UPDATE SET "lastOkAt" = GREATEST("ShadowJobState"."lastOkAt", EXCLUDED."lastOkAt"), "updatedAt" = now()`
}

/** Chwila startu ostatniego udanego przebiegu albo null (nigdy się nie udał). */
export async function ostatniUdanyPrzebieg(db: PrismaClient, job: string): Promise<Date | null> {
  const s = await db.shadowJobState.findFirst({ where: { job }, select: { lastOkAt: true } })
  return s?.lastOkAt ?? null
}
