// Pętla workera dla wielu firm. Kod systemowy: kolejka Job jest wspólna (klient systemowy bierze
// zadanie dowolnej firmy przez FOR UPDATE SKIP LOCKED), a handler dostaje klienta TEJ firmy (RLS). Awaria jednej
// firmy — błąd handlera, zła konfiguracja, brak klucza — kończy się błędem jej zadania (Job.lastError), a
// harmonogram i zadania pozostałych firm idą dalej (try/catch per firma i per zadanie).
import type { Prisma, PrismaClient } from '@prisma/client'
import { blConfigured } from '../cien/harmonogram'
import { createOrgClient, type ClientOpts } from '../db'
import { envSecretsAllowed, listActiveOrganizations, type OrgRef } from '../organizacje'
import type { Env } from '../sekrety'
import { claimNext, complete, enqueue, fail, release } from './kolejka'
import type { Handler } from './zadania'
import { feedyFirmy } from '../produkty/zdjecia-feed'

/** Klienci firm tworzeni na żądanie i trzymani do końca procesu (pula per firma, mała). */
export class OrgClients {
  private readonly map = new Map<string, PrismaClient>()
  constructor(private readonly opts: ClientOpts = {}) {}

  get(organizationId: string): PrismaClient {
    let db = this.map.get(organizationId)
    if (!db) {
      db = createOrgClient(organizationId, { poolMax: 3, ...this.opts })
      this.map.set(organizationId, db)
    }
    return db
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.map.values()].map((d) => d.$disconnect().catch(() => {})))
    this.map.clear()
  }
}

export interface WorkerDeps {
  system: PrismaClient
  orgs: OrgClients
  handlers: Record<string, Handler>
  env: Env
  workerId: string
  log?: (s: string) => void
}

export interface ScheduleEntry {
  kind: string
  everyMs: number
  /** Payload zadania okresowego (np. import katalogu bez sprzedaży: `{ salesDays: 0 }`). */
  payload?: Prisma.InputJsonValue
  /** Zadanie tylko dla firmy z tą integracją (np. porównanie z BL); bez niej nie powstaje wiersz `Job`. */
  requires?: 'baselinker' | 'empik' | 'feed' // „empik” = firma z aktywnym kontem Empik; „feed” = firma z adresem feedu produktowego
}

/** Jak długo pamiętamy, czy firma ma BL: bez tego `cien-bl-faktury` co 2 min = 2 zapytania na firmę. */
export const BL_CONFIGURED_TTL_MS = 10 * 60_000

export type BlConfiguredCache = Map<string, { at: number; value: boolean }>

/** Wynik `compute` dla firmy z pamięci młodszej niż TTL, inaczej liczony od nowa. Błąd nie jest pamiętany. */
export async function cachedBlConfigured(cache: BlConfiguredCache, organizationId: string, nowMs: number, compute: () => Promise<boolean>): Promise<boolean> {
  const hit = cache.get(organizationId)
  if (hit && nowMs - hit.at < BL_CONFIGURED_TTL_MS) return hit.value
  const value = await compute()
  cache.set(organizationId, { at: nowMs, value })
  return value
}

/**
 * Pamięć `blConfigured` związana z mapą `lastPlanned` wywołującego: pętla workera trzyma jedną mapę przez cały proces
 * (pamięć trwa), a każde wywołanie z nową mapą (testy, jednorazowe planowanie) liczy od nowa.
 */
const blCaches = new WeakMap<Map<string, number>, BlConfiguredCache>()

export async function activeOrganizations(deps: WorkerDeps): Promise<OrgRef[]> {
  return listActiveOrganizations(deps.system)
}

/**
 * Harmonogram: zadania okresowe każdej firmy (dedupeKey w obrębie firmy — nie piętrzą się). Błąd jednej firmy
 * (np. baza odrzuca jej zapis) zostaje w wyniku i logu, reszta firm dostaje swoje zadania.
 */
export async function planSchedule(
  deps: WorkerDeps,
  orgs: OrgRef[],
  schedule: ScheduleEntry[],
  lastPlanned: Map<string, number>,
  nowMs = Date.now(),
): Promise<{ planned: number; errors: string[] }> {
  let planned = 0
  const errors: string[] = []
  let activeCount: number | null = null
  let blCache = blCaches.get(lastPlanned)
  if (!blCache) blCaches.set(lastPlanned, (blCache = new Map()))
  for (const org of orgs) {
    for (const h of schedule) {
      const key = `${org.id}:${h.kind}`
      if (nowMs - (lastPlanned.get(key) ?? 0) < h.everyMs) continue
      try {
        // krok 7: zadania BL tylko dla firm z tokenem i inventory BL — inaczej handler i tak
        // kończy cicho, a co 10 min powstawałby pusty wiersz kolejki. Wynik pamiętany per firma przez BL_CONFIGURED_TTL_MS.
        if (h.requires === 'baselinker') {
          const ok = await cachedBlConfigured(blCache, org.id, nowMs, async () => {
            activeCount ??= await deps.system.organization.count({ where: { active: true } })
            return blConfigured(deps.orgs.get(org.id), { env: deps.env, envFallback: envSecretsAllowed(deps.env, org, activeCount) })
          })
          if (!ok) {
            lastPlanned.set(key, nowMs)
            continue
          }
        }
        // przyjmowanie zamówień Empiku tylko dla firm z aktywnym kontem Empik
        if (h.requires === 'empik') {
          const ok = await cachedBlConfigured(blCache, `${org.id}:empik`, nowMs, async () => (await deps.orgs.get(org.id).channelConfig.count({ where: { channel: 'EMPIK', active: true } })) > 0)
          if (!ok) {
            lastPlanned.set(key, nowMs)
            continue
          }
        }
        // zdjęcia z feedu tylko dla firm z adresem feedu w ustawieniach
        if (h.requires === 'feed') {
          const ok = await cachedBlConfigured(blCache, `${org.id}:feed`, nowMs, async () => (await feedyFirmy(deps.orgs.get(org.id))).length > 0)
          if (!ok) {
            lastPlanned.set(key, nowMs)
            continue
          }
        }
        const id = await enqueue(deps.orgs.get(org.id), h.kind, h.payload ?? null, { dedupeKey: `harmonogram:${h.kind}`, maxAttempts: 1 })
        lastPlanned.set(key, nowMs)
        if (id) planned++
      } catch (e) {
        const msg = `${org.slug}: harmonogram ${h.kind}: ${e instanceof Error ? e.message : String(e)}`
        errors.push(msg)
        deps.log?.(`[worker] ${msg}`)
      }
    }
  }
  return { planned, errors }
}

export type JobOutcome =
  | { kind: 'NONE' }
  | { kind: 'DONE' | 'RETRY' | 'FAILED' | 'RELEASED'; jobId: string; organizationId: string; jobKind: string; error?: string }

/** Opóźnienie ponownego wzięcia zadania firmy, której worker jeszcze nie widzi (lista firm odświeżana co 60 s). */
export const RELEASE_DELAY_MS = 30_000

/**
 * Jedno zadanie z kolejki wszystkich firm, wykonane klientem jego firmy. `orgs` to ostatnio znana lista aktywnych
 * firm; firma spoza niej (np. założona przed chwilą) → świeży odczyt listy, a gdy dalej jej nie ma, zadanie wraca do
 * kolejki bez zużycia próby (claimNext i tak bierze tylko zadania firm aktywnych).
 * Fallback kluczy z env liczy WSZYSTKIE aktywne firmy w bazie, nie te, które akurat przeszły weryfikację.
 */
export async function runNextJob(deps: WorkerDeps, orgs: OrgRef[]): Promise<JobOutcome> {
  const job = await claimNext(deps.system, deps.workerId)
  if (!job) return { kind: 'NONE' }
  const base = { jobId: job.id, organizationId: job.organizationId, jobKind: job.kind }
  try {
    let org = orgs.find((o) => o.id === job.organizationId)
    if (!org) org = (await activeOrganizations(deps)).find((o) => o.id === job.organizationId)
    if (!org) {
      await release(deps.system, job, RELEASE_DELAY_MS)
      return { kind: 'RELEASED', ...base }
    }
    const handler = deps.handlers[job.kind]
    if (!handler) throw new Error(`nieznany rodzaj zadania: ${job.kind}`)
    const activeCount = await deps.system.organization.count({ where: { active: true } })
    const secrets = { env: deps.env, envFallback: envSecretsAllowed(deps.env, org, activeCount) }
    await handler(deps.orgs.get(org.id), job.payload, { organizationId: org.id, secrets, job: { id: job.id, attempts: job.attempts, maxAttempts: job.maxAttempts } })
    await complete(deps.system, job.id)
    return { kind: 'DONE', ...base }
  } catch (e) {
    const outcome = await fail(deps.system, job, e)
    return { kind: outcome, ...base, error: e instanceof Error ? e.message : String(e) }
  }
}
