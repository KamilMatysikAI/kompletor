// Worker: osobny proces obok aplikacji Next. Bierze zadania z kolejki Job (wszystkich firm) i wykonuje je pojedynczo,
// każde klientem swojej firmy (lib/worker/petla.ts). Uruchomienie: npm run worker (env z .env).
// Zatrzymanie: Ctrl+C — kończy bieżące zadanie i wychodzi.
import 'dotenv/config'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import { createSystemClient, verifyOrgClient } from '../lib/db'
import type { OrgRef } from '../lib/organizacje'
import { appModeOf } from '../lib/organizacje'
import { encryptionKeysStatus, keyCoverage, SecretError, secretKeyVersionsInDb } from '../lib/sekrety'
import { harmonogramZEnv } from '../lib/worker/harmonogram'
import { reapStale } from '../lib/worker/kolejka'
import { activeOrganizations, OrgClients, planSchedule, runNextJob, type WorkerDeps } from '../lib/worker/petla'
import { handlers } from '../lib/worker/zadania'
import { przeniesZdjeciaZDysku } from '../lib/produkty/zdjecia'
import { FEED_JOB } from '../lib/produkty/zdjecia-feed'
import { loopAlive } from './zycie'

const POLL_MS = Number(process.env.WORKER_POLL_MS) || 2_000
const STALE_MS = 60 * 60_000
const ORGS_REFRESH_MS = 60_000

// Plik życia workera: zapisywany co 30 s z timera, więc długie zadanie (import katalogu) go nie
// postarza, a martwy albo zablokowany proces — tak. Timer pisze tylko, gdy pętla zadań przeszła obrót
// w ciągu 2 h (worker/zycie.ts), więc pętla zawieszona np. na połączeniu z bazą też gasi plik. Healthcheck kontenera
// (docker/healthcheck.sh) uznaje workera za żywego, gdy plik ma mniej niż 3 min. Puste = wyłączone (lokalnie).
const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE || ''

// WORKER_LOG_DONE=1: loguj też każde udane zadanie rdzenia z harmonogramu (diagnoza lokalna).
const LOG_DONE_RDZEN = process.env.WORKER_LOG_DONE === '1'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function main(): Promise<void> {
  appModeOf(process.env) // zły APP_MODE = błąd na starcie, nie w połowie pracy
  const keys = encryptionKeysStatus(process.env) // zły zestaw kluczy głównych = błąd na starcie, nie w Job.lastError każdej firmy
  if (keys.status === 'error') throw new SecretError(keys.message ?? 'zły zestaw kluczy głównych')
  const HARMONOGRAM = harmonogramZEnv(process.env) // zła wartość KATALOG_IMPORT_* = błąd na starcie
  const system = createSystemClient({ poolMax: 3 })
  // klucze z env muszą otworzyć wpisy z bazy (np. zostawiony sam stary APP_ENCRYPTION_KEY przy wpisach v2);
  // baza niedostępna na starcie = tylko log, worker i tak ją toleruje
  try {
    const cov = keyCoverage(keys.ring ?? null, await secretKeyVersionsInDb(system))
    if (cov.status === 'error') throw new SecretError(cov.message ?? 'klucze z env nie otworzą sekretów z bazy')
  } catch (e) {
    if (e instanceof SecretError) throw e
    console.error(`[worker] sprawdzenie kluczy względem bazy pominięte: ${msg(e)}`)
  }
  const orgs = new OrgClients()
  const deps: WorkerDeps = { system, orgs, handlers, env: process.env, workerId: `${os.hostname()}:${process.pid}`, log: (s) => console.warn(s) }
  let stop = false
  process.on('SIGINT', () => (stop = true))
  process.on('SIGTERM', () => (stop = true))
  let lastTick = Date.now()
  const beat = () => {
    if (loopAlive(Date.now(), lastTick)) void writeFile(HEARTBEAT_FILE, new Date().toISOString()).catch(() => undefined)
  }
  const heartbeat = HEARTBEAT_FILE ? setInterval(beat, 30_000) : null
  if (HEARTBEAT_FILE) beat()
  console.log(`[worker] start ${deps.workerId}, rodzaje zadań: ${Object.keys(handlers).join(', ')}`)
  console.log(`[worker] harmonogram: ${HARMONOGRAM.map((h) => `${h.kind} co ${Math.round(h.everyMs / 1000)} s`).join(', ')}`)
  let lastReap = 0
  let lastOrgs = 0
  let active: OrgRef[] = []
  const verified = new Set<string>()
  const lastPlanned = new Map<string, number>()
  while (!stop) {
    lastTick = Date.now()
    if (Date.now() - lastOrgs > ORGS_REFRESH_MS) {
      try {
        active = await activeOrganizations(deps)
        lastOrgs = Date.now()
        for (const o of active) {
          if (verified.has(o.id)) continue
          // połączenie firmy musi mieć izolację (rola bez obejścia RLS) — inaczej firma nie dostaje zadań
          await verifyOrgClient(orgs.get(o.id)).then(
            () => {
              verified.add(o.id)
              // zdjęcia sprzed przeniesienia do bazy, zapisane w katalogu tego kontenera — raz po starcie, w tle
              // (entrypoint przenosi do 60 s, tu reszta bez limitu); idempotentne, pliki zostają na dysku
              void przeniesZdjeciaZDysku(orgs.get(o.id)).then(
                (r) => {
                  if (r.przeniesione || r.bledy.length) console.log(`[worker] firma ${o.slug}: zdjęcia z dysku do bazy ${r.przeniesione}, błędy ${r.bledy.length}`)
                  for (const b of r.bledy.slice(0, 5)) console.error(`[worker] zdjęcie ${b.imageId}: ${b.komunikat}`)
                },
                (e: unknown) => console.error(`[worker] firma ${o.slug}: zdjęcia z dysku do bazy: ${msg(e)}`),
              )
            },
            (e: unknown) => console.error(`[worker] firma ${o.slug}: ${msg(e)}`),
          )
        }
        if (!active.length) console.warn('[worker] brak aktywnych firm — załóż firmę: npm run org:create')
      } catch (e) {
        console.error('[worker] lista firm:', msg(e))
      }
    }
    if (Date.now() - lastReap > 60_000) {
      const n = await reapStale(system, STALE_MS).catch(() => 0)
      if (n) console.warn(`[worker] przywrócono ${n} porzuconych zadań`)
      // techniczne wiersze kolejki z harmonogramu (DONE starsze niż doba) — nie dane, tylko ślad wykonania; także
      // zdjęcia z feedu (planowane co godzinę, wynik przebiegu jest w ImportRun)
      await system.job
        .deleteMany({
          where: { status: 'DONE', OR: [{ kind: { startsWith: 'rdzen-' } }, { kind: { startsWith: 'cien-' } }, { kind: FEED_JOB }], updatedAt: { lt: new Date(Date.now() - 24 * 3600_000) } },
        })
        .catch(() => 0)
      lastReap = Date.now()
    }
    const ready = active.filter((o) => verified.has(o.id))
    await planSchedule(deps, ready, HARMONOGRAM, lastPlanned).catch((e: unknown) => console.error('[worker] harmonogram:', msg(e)))
    const out = await runNextJob(deps, active).catch((e: unknown) => {
      console.error('[worker] błąd pobrania zadania:', msg(e))
      return { kind: 'NONE' as const }
    })
    if (out.kind === 'NONE') {
      await new Promise((r) => setTimeout(r, POLL_MS))
      continue
    }
    // Udane zadania rdzenia z harmonogramu (co 5–30 s) nie zapełniają logu; błędy zawsze, reszta zadań zawsze.
    if (out.kind === 'DONE') {
      if (LOG_DONE_RDZEN || !out.jobKind.startsWith('rdzen-')) console.log(`[worker] ${out.organizationId} ${out.jobKind} ${out.jobId}: zrobione`)
    } else if (out.kind === 'RELEASED') console.warn(`[worker] ${out.organizationId} ${out.jobKind} ${out.jobId}: firma jeszcze niewidoczna, zadanie wraca do kolejki`)
    else console.error(`[worker] ${out.organizationId} ${out.jobKind} ${out.jobId}: błąd (${out.kind}): ${out.error}`)
  }
  if (heartbeat) clearInterval(heartbeat)
  await orgs.closeAll()
  await system.$disconnect()
  console.log('[worker] koniec')
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
