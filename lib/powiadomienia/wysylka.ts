// Wysyłka alertów na Zulip: zadanie workera `powiadomienia-zulip`, co 60 s per firma.
// Dwie bramki, obie domyślnie zamknięte: env instancji POWIADOMIENIA_WYSYLKA=1 i włącznik firmy w Ustawieniach →
// Powiadomienia. Wychodzą tylko alerty utworzone od chwili ostatniego włączenia (`enabledAt`).
// Bez duplikatów: wiersz AlertDelivery w stanie SENDING powstaje PRZED wywołaniem (unikalność alertId w firmie chroni
// przed równoległym przebiegiem), SENT po 200. Ponowienie tylko wtedy, gdy wiadomość na pewno nie doszła (429, 5xx,
// brak połączenia), najwyżej 5 prób. Timeout po wysłaniu i porzucony SENDING = UNCERTAIN bez ponowienia — Zulip nie ma
// klucza idempotencji, a spam jest gorszy niż brak wiadomości. 401/403 wyłącza wysyłkę firmy do naprawy konfiguracji.
// Treść bez danych klientów: `Alert.message` nie jest nawet czytany (lib/powiadomienia/tresc.ts).
import { Prisma, type PrismaClient } from '@prisma/client'
import { resolveSecrets, type Env } from '../sekrety'
import type { FetchLike } from '../zrodla/http'
import { NotificationConfigError, parseZulipSite, publicUrlZEnv, routesOf, wysylkaZEnv } from './adres'
import { groupOf, type Routes } from './grupy'
import { alertMessage } from './tresc'
import { sendZulipMessage, ZULIP_TIMEOUT_MS, type ZulipResult } from './zulip'

export const ZULIP_KEY = 'ZULIP_API_KEY'
/** Początek `lastError` przy automatycznym wyłączeniu po 401/403 (po nim ekran rozpoznaje wznowienie). */
export const AUTH_DISABLED_PREFIX = 'Zulip odrzucił klucz albo bota'
export const PER_RUN = 20
export const PER_HOUR = 100
export const MAX_ATTEMPTS = 5
export const STALE_SENDING_MS = 10 * 60_000
/** Odstępy ponowień (po 1., 2., 3., 4. próbie). */
export const RETRY_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000] as const

export type DeliveryState = 'SENDING' | 'SENT' | 'FAILED' | 'UNCERTAIN'

export interface RunDeps {
  fetch: FetchLike
  now?: () => Date
  timeoutMs?: number
}

export interface RunResult {
  /** Dlaczego nic nie wyszło (bramka, konfiguracja); null = przebieg wykonany. */
  skipped: null | 'env' | 'firma' | 'konfiguracja' | 'limit'
  sent: number
  retry: number
  failed: number
  uncertain: number
  noRoute: number
  /** Porzucone SENDING (przerwany worker) oznaczone jako UNCERTAIN. */
  stale: number
  /** Alerty czekające na kolejny przebieg (limit na przebieg albo godzinę). */
  deferred: number
  errors: string[]
  /** 401/403: wysyłka firmy wyłączona. */
  disabled: boolean
}

const empty = (skipped: RunResult['skipped'] = null): RunResult => ({ skipped, sent: 0, retry: 0, failed: 0, uncertain: 0, noRoute: 0, stale: 0, deferred: 0, errors: [], disabled: false })

/** Błąd do `lastError`: bez klucza (na wszelki wypadek wycinany) i przycięty. */
function safeError(msg: string, apiKey: string | null): string {
  let m = msg
  if (apiKey && apiKey.length >= 4) m = m.split(apiKey).join('***')
  return m.slice(0, 300)
}

async function setConfigError(db: PrismaClient, message: string, now: Date, disable: boolean): Promise<void> {
  // klient firmy (RLS) widzi tylko wiersz swojej firmy
  await db.notificationSettings.updateMany({
    data: { lastError: message.slice(0, 300), lastErrorAt: now, ...(disable ? { enabled: false } : {}) },
  })
}

interface Candidate {
  alertId: string
  kind: string
  ref: string
  createdAt: Date
  /** Wiersz AlertDelivery do ponowienia; null = nowy alert. */
  deliveryId: string | null
}

/**
 * Przebieg wysyłki jednej firmy (klient firmy, RLS). Wynik jako liczniki. Błąd jednego alertu nie zatrzymuje reszty.
 */
export async function runZulipDeliveries(db: PrismaClient, env: Env, deps: RunDeps): Promise<RunResult> {
  if (!wysylkaZEnv(env)) return empty('env') // przed jakimkolwiek odczytem
  const now = (deps.now ?? (() => new Date()))()
  const settings = await db.notificationSettings.findFirst()
  if (!settings?.enabled || !settings.enabledAt) return empty('firma')

  // porzucone SENDING (worker przerwany w trakcie wywołania): wiadomość mogła dojść — bez ponowienia
  const stale = await db.alertDelivery.updateMany({
    where: { state: 'SENDING', lastAttemptAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
    data: { state: 'UNCERTAIN', nextAttemptAt: null, lastError: 'przebieg przerwany w trakcie wysyłki — wiadomość mogła dojść' },
  })

  let site: string
  let apiKey: string | null = null
  try {
    if (!settings.zulipSite || !settings.zulipBotEmail) throw new NotificationConfigError('Brak adresu Zulipa albo adresu bota')
    site = parseZulipSite(settings.zulipSite, env) // drugi raz przed wysyłką: lista hostów mogła się zmienić
    // tylko sekret firmy w bazie (jak pokazuje ekran), bez fallbacku na env serwera
    apiKey = (await resolveSecrets(db, [ZULIP_KEY], { env, envFallback: false }))[ZULIP_KEY] || null
    if (!apiKey) throw new NotificationConfigError(`Brak klucza bota Zulipa: ustawia go administrator instalacji (Pomoc → Dokumentacja dla administratora → Powiadomienia; sekret firmy ${ZULIP_KEY})`)
  } catch (e) {
    if (!(e instanceof NotificationConfigError)) throw e
    if (settings.lastError !== e.message) await setConfigError(db, e.message, now, false)
    return { ...empty('konfiguracja'), stale: stale.count }
  }
  // konfiguracja znów poprawna (np. ustawiony brakujący klucz): stary błąd znika z ekranu
  if (settings.lastError) await db.notificationSettings.updateMany({ data: { lastError: null, lastErrorAt: null } })

  const out: RunResult = { ...empty(), stale: stale.count }
  const hourAgo = new Date(now.getTime() - 3600_000)
  const usedHour = await db.alertDelivery.count({ where: { lastAttemptAt: { gte: hourAgo } } })
  const budget = Math.max(0, Math.min(PER_RUN, PER_HOUR - usedHour))

  // ponowienia (najstarsze pierwsze), potem nowe alerty od włączenia bez wiersza dostarczenia (najstarsze pierwsze)
  const retries = await db.alertDelivery.findMany({
    where: { state: 'FAILED', nextAttemptAt: { lte: now } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: budget + 1,
    select: { id: true, alertId: true },
  })
  const retryAlerts = retries.length
    ? await db.alert.findMany({ where: { id: { in: retries.map((r) => r.alertId) } }, select: { id: true, kind: true, ref: true, createdAt: true, closedAt: true } })
    : []
  const byId = new Map(retryAlerts.map((a) => [a.id, a]))
  const candidates: Candidate[] = []
  for (const r of retries) {
    const a = byId.get(r.alertId)
    if (!a) {
      await db.alertDelivery.updateMany({ where: { id: r.id, state: 'FAILED' }, data: { nextAttemptAt: null, lastError: 'alert usunięty' } })
      continue
    }
    if (a.closedAt) {
      // sprawa zamknięta w panelu, zanim przyszła kolej ponowienia — bez wiadomości
      await db.alertDelivery.updateMany({ where: { id: r.id, state: 'FAILED' }, data: { nextAttemptAt: null, lastError: 'alert zamknięty przed wysyłką' } })
      continue
    }
    candidates.push({ alertId: a.id, kind: a.kind, ref: a.ref, createdAt: a.createdAt, deliveryId: r.id })
  }
  const fresh = await db.$queryRaw<{ id: string; kind: string; ref: string; createdAt: Date }[]>`
    SELECT a.id, a.kind, a.ref, a."createdAt" FROM "Alert" a
    WHERE a."createdAt" >= ${settings.enabledAt}
      AND a."closedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "AlertDelivery" d WHERE d."alertId" = a.id AND d."organizationId" = a."organizationId")
    ORDER BY a."createdAt", a.id
    LIMIT ${budget + 1}`
  for (const a of fresh) candidates.push({ alertId: a.id, kind: a.kind, ref: a.ref, createdAt: a.createdAt, deliveryId: null })

  if (budget === 0) {
    out.skipped = candidates.length ? 'limit' : null
    out.deferred = candidates.length
    return out
  }
  const routes: Routes = routesOf(settings.routes)
  const org = await db.organization.findFirst({ select: { name: true } })
  const publicUrl = publicUrlZEnv(env)
  const target = { site, botEmail: settings.zulipBotEmail!, apiKey }

  let used = 0
  for (const c of candidates) {
    if (used >= budget) {
      out.deferred++
      continue
    }
    try {
      const group = groupOf(c.kind)
      const route = routes[group]
      if (!route) {
        // grupa bez trasy: pominięta na stałe (bez ponawiania), widoczna w ostatnich dostarczeniach
        if (c.deliveryId) {
          await db.alertDelivery.updateMany({ where: { id: c.deliveryId, state: 'FAILED' }, data: { nextAttemptAt: null, lastError: `grupa ${group} bez trasy` } })
        } else if (!(await claimNew(db, c, group, 'FAILED', now, `grupa ${group} bez trasy`))) continue
        out.noRoute++
        continue
      }
      const content = alertMessage(c, org?.name ?? '', publicUrl) // przed zapisem SENDING: błąd tu = nic nie wysłane
      let deliveryId: string | null
      let attempts: number
      if (c.deliveryId) {
        const r = await db.alertDelivery.updateMany({
          where: { id: c.deliveryId, state: 'FAILED', nextAttemptAt: { lte: now } },
          data: { state: 'SENDING', attempts: { increment: 1 }, lastAttemptAt: now, nextAttemptAt: null },
        })
        if (r.count !== 1) continue // wziął go równoległy przebieg
        deliveryId = c.deliveryId
        attempts = (await db.alertDelivery.findUniqueOrThrow({ where: { id: deliveryId }, select: { attempts: true } })).attempts
      } else {
        deliveryId = await claimNew(db, c, group, 'SENDING', now, null)
        if (!deliveryId) continue
        attempts = 1
      }
      used++
      const res = await sendZulipMessage(target, { stream: route.stream, topic: route.topic, content }, deps.fetch, deps.timeoutMs ?? ZULIP_TIMEOUT_MS)
      const stop = await finish(db, deliveryId, attempts, res, now, apiKey, out)
      if (stop) break
    } catch (e) {
      // wiersz mógł zostać w SENDING — po 10 min przejdzie w UNCERTAIN, bez ponowienia
      out.errors.push(`${c.alertId}: ${safeError(e instanceof Error ? e.message : String(e), apiKey)}`)
    }
  }
  return out
}

/** Nowy wiersz dostarczenia; null = już jest (równoległy przebieg wziął ten alert). */
async function claimNew(db: PrismaClient, c: Candidate, group: string, state: DeliveryState, now: Date, lastError: string | null): Promise<string | null> {
  try {
    const row = await db.alertDelivery.create({
      data: { alertId: c.alertId, kind: c.kind.slice(0, 64), group, state, attempts: state === 'SENDING' ? 1 : 0, lastAttemptAt: state === 'SENDING' ? now : null, lastError },
      select: { id: true },
    })
    return row.id
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null
    throw e
  }
}

/** Zapis wyniku wywołania; true = przerwać przebieg (401/403). */
async function finish(db: PrismaClient, id: string, attempts: number, res: ZulipResult, now: Date, apiKey: string, out: RunResult): Promise<boolean> {
  switch (res.kind) {
    case 'SENT':
      await db.alertDelivery.update({ where: { id }, data: { state: 'SENT', sentAt: now, nextAttemptAt: null, lastError: null } })
      out.sent++
      return false
    case 'RETRY': {
      const last = attempts >= MAX_ATTEMPTS
      const delay = Math.max(RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!, res.retryAfterMs ?? 0)
      await db.alertDelivery.update({
        where: { id },
        data: { state: 'FAILED', nextAttemptAt: last ? null : new Date(now.getTime() + delay), lastError: safeError(last ? `${res.error} (po ${attempts} próbach)` : res.error, apiKey) },
      })
      if (last) out.failed++
      else out.retry++
      return false
    }
    case 'UNCERTAIN':
      await db.alertDelivery.update({ where: { id }, data: { state: 'UNCERTAIN', nextAttemptAt: null, lastError: safeError(res.error, apiKey) } })
      out.uncertain++
      return false
    case 'REJECTED':
      await db.alertDelivery.update({ where: { id }, data: { state: 'FAILED', nextAttemptAt: null, lastError: safeError(res.error, apiKey) } })
      out.failed++
      return false
    case 'AUTH':
      await db.alertDelivery.update({ where: { id }, data: { state: 'FAILED', nextAttemptAt: null, lastError: safeError(res.error, apiKey) } })
      await setConfigError(db, `${AUTH_DISABLED_PREFIX} (${res.error}) — wysyłka wyłączona; popraw konfigurację i włącz ponownie`, now, true)
      out.failed++
      out.disabled = true
      return true
  }
}

/** Handler zadania workera; `fetch` wstrzykiwany w testach (atrapa Zulipa). */
export function zadaniePowiadomien(deps: RunDeps = { fetch: (u, i) => globalThis.fetch(u, i) }) {
  return async (db: PrismaClient, env: Env): Promise<RunResult> => runZulipDeliveries(db, env, deps)
}
