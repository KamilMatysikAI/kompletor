// Propagacja `available` na kanały (spec 6). Rdzeń liczy targety i prowadzi kolejkę jobów; wysyłka idzie przez
// interfejs `AdapterStanow`. Kanał w trybie CIEN zapisuje tylko „wysłałbym”; kanał w PRACA dostaje adapter od hosta
// zapisu (lib/kanaly/zapis-host.ts: zdolność stock.write + `zapisWlaczony`), bez adaptera to błąd (nic nie
// wychodzi). Wynik per oferta: NIEJEDNOZNACZNY = alert i job odstawiony (bez ponowienia, ponawia „Wypchnij teraz”).
// wysyłka, limity i zdrowie liczone per konto kanału (dwa sklepy Woo albo dwa konta Allegro mają osobne
// kolejki i limity); `db` to klient jednej firmy (RLS).
import type { Channel } from '@prisma/client'
import type { FailureKind } from '../adaptery/kontrakt'
import { organizationIdOf } from '../db'
import { toWarsaw } from './kalendarz'
import { alert, availableOf, type Db, type Tx } from './stan'

/** Konto kanału: typ kanału + konto w ChannelConfig. */
export interface ChannelAccount {
  channel: Channel
  channelAccountId: string
}

export interface PushItem {
  offerId: string
  externalId: string
  channelAccountId: string
  targetQty: number
  /** Job wymuszony (kanał sam zmienił stan, „Wypchnij teraz”, noc, powrót kanału): rejestr synchronizacji nie pomija. */
  force?: boolean
}

export interface PushResult {
  offerId: string
  ok: boolean
  error?: string
  /** Rodzaj niepowodzenia; brak = przejściowy (ponowienie z odstępem). */
  kind?: FailureKind
  /**
   * oferta pominięta przez rejestr synchronizacji (lib/kanaly/rejestr-synchronizacji.ts), bo kanał ma już
   * dokładnie tę treść z ostatniego udanego zapisu. Wymaga `ok: true`; bez wywołania kanału i bez wpisu PRACA w dzienniku.
   */
  skipped?: boolean
  /** czas ponowienia podany przez kanał albo host (Retry-After, limit tempa); host stanów czeka co najmniej tyle. */
  retryAfterMs?: number
  /**
   * zapis nie wyszedł, bo host go odłożył (limit tempa konta albo zdolności, konto wyłączone po błędach).
   * Job czeka `retryAfterMs` bez liczenia próby i bez alertu (nic nie zginęło, nic nie wysłano).
   */
  odlozone?: boolean
  /**
   * kanał odmówił czegoś, czego powtórka nie zmieni (zakończenie albo wznowienie oferty, dobowy limit
   * zakończeń): job od razu odstawiony (jak po TRWALY_MAX próbach) z alertem, bez ponowień co 5 min.
   */
  odstaw?: boolean
}

export interface AdapterStanow {
  /** Wysyła paczkę; zwraca wynik per oferta. Wyjątek = cała paczka nieudana. */
  push(items: PushItem[]): Promise<PushResult[]>
}

/** Job z niejednoznacznym wynikiem zapisu czeka na człowieka („Wypchnij teraz”) zamiast ponowienia. */
export const PARKED_MS = 30 * 24 * 3600_000
/** Po tylu trwałych błędach zapisu stanu job jest odstawiony jak niejednoznaczny. */
export const TRWALY_MAX = 8

/** Kanały, które same zdejmują stan przy zamówieniu: wzrost dopiero po odczycie zamówień (6.2). */
export const SELF_DECREMENTING: Channel[] = ['WOO', 'ALLEGRO', 'EMPIK', 'SHOPER', 'PRESTASHOP', 'IDOSELL']

/** Limity API platform (nie firmy): paczka i odstęp, liczone per konto kanału. */
export const CHANNEL_LIMITS: Partial<Record<Channel, { batch: number; minIntervalMs: number }>> = {
  WOO: { batch: 100, minIntervalMs: 0 },
  ALLEGRO: { batch: 1000, minIntervalMs: 0 },
  EMPIK: { batch: 10_000, minIntervalMs: 60_000 }, // STO01/OF24 maks. raz na minutę
  SHOPER: { batch: 25, minIntervalMs: 0 },
  PRESTASHOP: { batch: 50, minIntervalMs: 0 },
  IDOSELL: { batch: 100, minIntervalMs: 0 }, // PUT products/stocks, paczki po 100 rozmiarów
}

const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000]
const SAME_TARGET_SKIP_MS = 3600_000
const CHANNEL_ALERT_AFTER_MS = 15 * 60_000

/** target = max(0, floor((available − bufor) / qtyBasePerOffer)) (6.1). */
export function targetFor(available: number, buffer: number, qtyBasePerOffer: number): number {
  return Math.max(0, Math.floor((available - buffer) / Math.max(1, qtyBasePerOffer)))
}

/**
 * 6.1 pkt 4 (v1.5): kanał, który sam zmienia stan (Woo, Allegro, Empik), przy anulowaniu zamówienia albo odrzuceniu
 * pozycji oddaje sobie sztuki — nasz `lastPushedQty` przestaje być prawdą o kanale. Zdarzenie FORCE_PUSH (w transakcji
 * zmiany) daje job wymuszony dla ofert tych pozycji: wysyłka nawet bez zmiany targetu (pomija „ten sam target < 1 h”).
 * `lineIds` = tylko te pozycje (odrzucenie), brak = całe zamówienie (anulowanie).
 */
export async function forcePushForOrder(
  tx: Tx,
  order: { id: string; channel: Channel; channelAccountId: string },
  now: Date,
  lineIds?: string[],
): Promise<number> {
  if (!SELF_DECREMENTING.includes(order.channel)) return 0
  const lines = await tx.orderLine.findMany({ where: { orderId: order.id, offerId: { not: null }, ...(lineIds ? { id: { in: lineIds } } : {}) }, select: { offerId: true } })
  if (!lines.length) return 0
  const offers = await tx.channelOffer.findMany({
    where: { channel: order.channel, channelAccountId: order.channelAccountId, externalId: { in: lines.map((l) => l.offerId!) }, active: true, product: { kind: { not: 'DIGITAL' } } },
    select: { id: true, productId: true },
  })
  // zestaw wirtualny nie ma wiersza Stock: zdarzenie na składniku, fanout liczy target zestawu ze składników
  const comps = await tx.bundleComponent.findMany({ where: { bundleId: { in: offers.map((o) => o.productId) } }, select: { bundleId: true, componentId: true } })
  const viaComponent = new Map(comps.map((c) => [c.bundleId, c.componentId]))
  if (offers.length)
    await tx.outboxEvent.createMany({ data: offers.map((o) => ({ kind: 'FORCE_PUSH' as const, productId: viaComponent.get(o.productId) ?? o.productId, offerId: o.id, createdAt: now })) })
  return offers.length
}

// ─── stock-fanout ────────────────────────────────────────────────────────────

export interface FanoutStats {
  events: number
  jobs: number
  heldIncreases: number
}

/**
 * Zdarzenia AVAILABLE_CHANGED → targety ofert bezpośrednich i ofert zestawów wirtualnych zawierających
 * produkt → `StockSyncJob` (jeden oczekujący na ofertę, ostatnia wartość wygrywa). Przy
 * `allocationPendingSince` wstrzymane są tylko wzrosty (4.4 pkt 2).
 */
export async function runFanout(db: Db, ctx: { now?: Date; limit?: number } = {}): Promise<FanoutStats> {
  const now = ctx.now ?? new Date()
  return db.$transaction(
    async (tx) => {
      const events = await tx.$queryRaw<{ id: string; kind: string; productId: string; offerId: string | null; createdAt: Date }[]>`
        SELECT id, kind::text AS kind, "productId", "offerId", "createdAt" FROM "OutboxEvent"
        WHERE kind IN ('AVAILABLE_CHANGED', 'FORCE_PUSH') AND "processedAt" IS NULL AND "createdAt" <= ${now}
        ORDER BY "createdAt" LIMIT ${ctx.limit ?? 5000} FOR UPDATE SKIP LOCKED`
      if (!events.length) return { events: 0, jobs: 0, heldIncreases: 0 }
      const firstAt = new Map<string, Date>()
      for (const e of events) if (!firstAt.has(e.productId) || e.createdAt < firstAt.get(e.productId)!) firstAt.set(e.productId, e.createdAt)
      // 6.1 pkt 4: oferty, których stan zmienił sam kanał — job wymuszony
      const forced = new Set(events.filter((e) => e.kind === 'FORCE_PUSH' && e.offerId).map((e) => e.offerId!))
      const changed = [...firstAt.keys()]
      const bundles = await tx.bundleComponent.findMany({ where: { componentId: { in: changed } }, select: { bundleId: true, componentId: true } })
      const bundleIds = [...new Set(bundles.map((b) => b.bundleId))]
      const comps = bundleIds.length ? await tx.bundleComponent.findMany({ where: { bundleId: { in: bundleIds } } }) : []
      // Oferty produktów bez stanu (e-book) nie dostają stanu z magazynu: target 0 zdjąłby je ze sklepu.
      const offers = await tx.channelOffer.findMany({ where: { active: true, productId: { in: [...changed, ...bundleIds] }, product: { kind: { not: 'DIGITAL' } } } })
      const stockIds = [...new Set([...changed, ...comps.map((c) => c.componentId)])]
      const stocks = await tx.stock.findMany({ where: { productId: { in: stockIds } } })
      const sMap = new Map(stocks.map((s) => [s.productId, s]))
      const configs = await tx.channelConfig.findMany()
      const bufCfg = new Map(configs.map((c) => [`${c.channel}:${c.channelAccountId}`, c.defaultSafetyBuffer]))
      const jobs = new Map((await tx.stockSyncJob.findMany({ where: { offerId: { in: offers.map((o) => o.id) } } })).map((j) => [j.offerId, j]))
      let jobsN = 0
      let held = 0
      for (const o of offers) {
        let avail: number
        let pending = false
        let version = 0
        let first: Date
        const isBundle = bundleIds.includes(o.productId) && !sMap.has(o.productId)
        if (!isBundle) {
          const s = sMap.get(o.productId)
          avail = s ? availableOf(s) : 0
          pending = !!s?.allocationPendingSince
          version = s?.version ?? 0
          first = firstAt.get(o.productId)!
        } else {
          const cs = comps.filter((c) => c.bundleId === o.productId)
          avail = cs.length ? Infinity : 0
          first = now
          for (const c of cs) {
            const s = sMap.get(c.componentId)
            avail = Math.min(avail, Math.floor((s ? availableOf(s) : 0) / c.qtyBase))
            pending ||= !!s?.allocationPendingSince
            version += s?.version ?? 0
            const f = firstAt.get(c.componentId)
            if (f && f < first) first = f
          }
        }
        const buffer = o.safetyBuffer ?? bufCfg.get(`${o.channel}:${o.channelAccountId}`) ?? 0
        let target = targetFor(avail, buffer, o.qtyBasePerOffer)
        const job = jobs.get(o.id)
        const baseline = job ? job.targetQty : (o.lastPushedQty ?? 0)
        const force = forced.has(o.id)
        if (pending && target > Math.min(baseline, o.lastPushedQty ?? 0)) {
          held++
          // wzrost wstrzymany do końca przydziału dostawy; wymuszony job idzie z wartością sprzed wzrostu (kanał sam podniósł)
          if (!force) continue
          target = Math.min(baseline, o.lastPushedQty ?? 0)
        }
        if (job && job.targetQty === target && (!force || job.force)) continue // computedAt bez zmian (6.2: nie zagładzać wzrostu)
        await tx.stockSyncJob.upsert({
          where: { offerId: o.id },
          create: { offerId: o.id, channel: o.channel, channelAccountId: o.channelAccountId, targetQty: target, sourceVersion: version, computedAt: now, firstChangeAt: first, nextAttemptAt: now, force },
          update: { targetQty: target, sourceVersion: version, computedAt: now, firstChangeAt: job && job.firstChangeAt < first ? job.firstChangeAt : first, ...(force ? { force: true } : {}) },
        })
        jobsN++
      }
      await tx.outboxEvent.updateMany({ where: { id: { in: events.map((e) => e.id) } }, data: { processedAt: now } })
      return { events: events.length, jobs: jobsN, heldIncreases: held }
    },
    { maxWait: 30_000, timeout: 120_000 },
  )
}

/** Pełna synchronizacja konta kanału (noc, powrót kanału): joby dla wszystkich aktywnych ofert, z wymuszeniem. */
export async function fullSyncChannel(db: Db, acc: ChannelAccount, ctx: { now?: Date } = {}): Promise<number> {
  const now = ctx.now ?? new Date()
  const { channel, channelAccountId } = acc
  const offers = await db.channelOffer.findMany({ where: { channel, channelAccountId, active: true, product: { kind: { not: 'DIGITAL' } } }, select: { productId: true } })
  const ids = [...new Set(offers.map((o) => o.productId))]
  // przez outbox, żeby target liczył się tą samą drogą (zestawy, bufory, wstrzymane wzrosty)
  await db.outboxEvent.createMany({ data: ids.map((productId) => ({ kind: 'AVAILABLE_CHANGED' as const, productId, createdAt: now })) })
  await runFanout(db, { now, limit: 100_000 })
  const r = await db.$executeRaw`UPDATE "StockSyncJob" j SET force = true FROM "ChannelOffer" o
    WHERE o.id = j."offerId" AND o.channel::text = ${channel} AND o."channelAccountId" = ${channelAccountId}`
  // oferty bez joba (target bez zmian) też idą: job wymuszony z bieżącym lastPushedQty
  const missing = await db.$queryRaw<{ id: string; lastPushedQty: number | null }[]>`
    SELECT o.id, o."lastPushedQty" FROM "ChannelOffer" o LEFT JOIN "StockSyncJob" j ON j."offerId" = o.id
    WHERE o.channel::text = ${channel} AND o."channelAccountId" = ${channelAccountId} AND o.active AND j."offerId" IS NULL AND o."lastPushedQty" IS NOT NULL`
  for (const m of missing)
    await db.stockSyncJob.create({
      data: { offerId: m.id, channel, channelAccountId, targetQty: m.lastPushedQty!, sourceVersion: 0, computedAt: now, firstChangeAt: now, nextAttemptAt: now, force: true },
    })
  return r + missing.length
}

/** Godzina (czas Warszawy) nocnej pełnej synchronizacji kont kanałów (6.1). */
export const NIGHT_SYNC_HOUR = 3

/**
 * Nocna synchronizacja należna: godzina ≥ NIGHT_SYNC_HOUR i dziś (czas Warszawy) jeszcze nie zrobiona. Worker woła
 * co godzinę z dryfem, więc „dokładnie godzina 3” gubiła noc (02:59 → 04:00) i dublowała ją po restarcie.
 */
export async function isNightSyncDue(db: Db, now: Date): Promise<boolean> {
  const w = toWarsaw(now)
  if (Math.floor(w.msOfDay / 3600_000) < NIGHT_SYNC_HOUR) return false
  const s = await db.wfirmaQueueState.findUnique({ where: { organizationId: organizationIdOf(db) }, select: { lastNightSyncAt: true } })
  return !s?.lastNightSyncAt || toWarsaw(s.lastNightSyncAt).day !== w.day
}

/**
 * Nocna pełna synchronizacja (6.1): wszystkie aktywne konta kanałów, które same zdejmują stan,
 * dostają joby wymuszone, raz na dobę (`isNightSyncDue`). Błąd jednego konta nie zatrzymuje reszty: alert, a noc liczy
 * się jako zrobiona (powtórka co godzinę wymuszałaby stany zdrowych kont; konto dogoni następna noc albo powrót kanału).
 * Gdy nie udało się żadne konto (awaria wspólna, np. baza), noc nie jest odhaczona: ponowienie za godzinę nikomu nie
 * zdubluje wymuszeń, a alert i tak jeden dziennie.
 */
export async function runNightlyFullSync(db: Db, ctx: { now?: Date } = {}): Promise<ChannelAccount[]> {
  const now = ctx.now ?? new Date()
  if (!(await isNightSyncDue(db, now))) return []
  const accs = await db.channelConfig.findMany({ where: { active: true, channel: { in: SELF_DECREMENTING } }, select: { channel: true, channelAccountId: true } })
  const done: ChannelAccount[] = []
  for (const a of accs) {
    try {
      await fullSyncChannel(db, a, { now })
      done.push(a)
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 500)
      await alert(db, 'NOC_SYNC_BLAD', accLabel(a), `Nocna synchronizacja konta ${accLabel(a)} nieudana: ${message}`, `noc-sync:${accLabel(a)}:${toWarsaw(now).day}`)
    }
  }
  if (accs.length && !done.length) return done
  const organizationId = organizationIdOf(db)
  await db.wfirmaQueueState.upsert({ where: { organizationId }, create: { organizationId, lastNightSyncAt: now }, update: { lastNightSyncAt: now } })
  return done
}

// ─── Odczyty zamówień kanału (warunek wzrostów, 6.2) ─────────────────────────

export async function recordOrderPoll(db: Db, p: { channel: Channel; channelAccountId: string; startedAt: Date; finishedAt: Date; ok: boolean; error?: string }): Promise<void> {
  await db.channelOrderPoll.create({ data: { ...p, error: p.error?.slice(0, 1000) ?? null } })
}

// ─── stock-push:<kanał> ──────────────────────────────────────────────────────

export interface PushStats {
  sent: number
  shadow: number
  skippedSame: number
  /** pominięte przez rejestr synchronizacji (treść jak w ostatnim udanym zapisie). */
  skippedUnchanged: number
  waitingForPoll: number
  failed: number
  throttled: boolean
}

/** Konta do wysyłki stanów firmy: mają joby albo trwającą awarię (alert po 15 min także bez jobów „na teraz”). */
export async function accountsToPush(db: Db): Promise<ChannelAccount[]> {
  const rows = await db.$queryRaw<ChannelAccount[]>`
    SELECT channel, "channelAccountId" FROM "StockSyncJob"
    UNION SELECT channel, "channelAccountId" FROM "ChannelHealth" WHERE "failingSince" IS NOT NULL
    ORDER BY 1, 2`
  return rows.filter((r) => SELF_DECREMENTING.includes(r.channel))
}

const accLabel = (a: ChannelAccount) => `${a.channel}/${a.channelAccountId}`

export async function runStockPush(
  db: Db,
  acc: ChannelAccount,
  adapter: AdapterStanow | null,
  ctx: { now?: Date } = {},
): Promise<PushStats> {
  const now = ctx.now ?? new Date()
  const { channel, channelAccountId } = acc
  const healthKey = { organizationId_channel_channelAccountId: { organizationId: organizationIdOf(db), channel, channelAccountId } }
  const limits = CHANNEL_LIMITS[channel] ?? { batch: 100, minIntervalMs: 0 }
  const stats: PushStats = { sent: 0, shadow: 0, skippedSame: 0, skippedUnchanged: 0, waitingForPoll: 0, failed: 0, throttled: false }
  const health = await db.channelHealth.findUnique({ where: healthKey })
  // 15 min nieudanych prób → alert od razu, także gdy w tej chwili żaden job nie jest „na teraz” (odstępy)
  if (health?.failingSince && now.getTime() - health.failingSince.getTime() >= CHANNEL_ALERT_AFTER_MS)
    await alert(db, 'KANAL_NIEDOSTEPNY', accLabel(acc), `Kanał ${accLabel(acc)}: stany nieaktualne od ${health.failingSince.toISOString()}`, `kanal:${accLabel(acc)}:${health.failingSince.toISOString()}`)
  if (limits.minIntervalMs && health?.lastBatchAt && now.getTime() - health.lastBatchAt.getTime() < limits.minIntervalMs) {
    stats.throttled = true
    return stats
  }
  const jobs = await db.stockSyncJob.findMany({ where: { channel, channelAccountId, nextAttemptAt: { lte: now } }, orderBy: { firstChangeAt: 'asc' }, take: limits.batch })
  if (!jobs.length) return stats
  const offers = new Map((await db.channelOffer.findMany({ where: { id: { in: jobs.map((j) => j.offerId) } } })).map((o) => [o.id, o]))
  const configs = new Map((await db.channelConfig.findMany({ where: { channel, channelAccountId } })).map((c) => [c.channelAccountId, c]))
  const polls = await db.$queryRaw<{ channelAccountId: string; startedAt: Date }[]>`
    SELECT "channelAccountId", max("startedAt") AS "startedAt" FROM "ChannelOrderPoll"
    WHERE channel::text = ${channel} AND "channelAccountId" = ${channelAccountId} AND ok AND "finishedAt" IS NOT NULL AND "finishedAt" <= ${now} GROUP BY 1`
  const lastPoll = new Map(polls.map((p) => [p.channelAccountId, p.startedAt]))
  const toSend: { job: (typeof jobs)[number]; item: PushItem; shadow: boolean }[] = []
  for (const job of jobs) {
    const o = offers.get(job.offerId)
    if (!o || !o.active) {
      await db.stockSyncJob.deleteMany({ where: { offerId: job.offerId, computedAt: job.computedAt } })
      continue
    }
    if (!job.force && o.lastPushedQty === job.targetQty && o.lastPushedAt && now.getTime() - o.lastPushedAt.getTime() < SAME_TARGET_SKIP_MS) {
      await db.stockSyncJob.deleteMany({ where: { offerId: job.offerId, computedAt: job.computedAt } })
      stats.skippedSame++
      continue
    }
    const increase = o.lastPushedQty === null || job.targetQty > o.lastPushedQty
    if (increase && SELF_DECREMENTING.includes(channel)) {
      const p = lastPoll.get(o.channelAccountId)
      if (!p || p.getTime() <= job.computedAt.getTime()) {
        stats.waitingForPoll++
        continue
      }
    }
    const mode = configs.get(o.channelAccountId)?.stockMode ?? 'CIEN'
    toSend.push({ job, item: { offerId: o.id, externalId: o.externalId, channelAccountId: o.channelAccountId, targetQty: job.targetQty, ...(job.force ? { force: true } : {}) }, shadow: mode !== 'PRACA' })
  }
  const done = async (job: (typeof jobs)[number], shadow: boolean) => {
    // CIEN: tylko „wysłałbym” — lastPushedQty zostaje prawdą o tym, co NAPRAWDĘ poszło na kanał (inaczej po
    // przełączeniu w PRACA job „ten sam target” zostałby pominięty, a kanał trzymałby wyższy stan z BL)
    if (!shadow) await db.channelOffer.update({ where: { id: job.offerId }, data: { lastPushedQty: job.targetQty, lastPushedAt: now } })
    await db.channelPushLog.create({ data: { offerId: job.offerId, channel, channelAccountId, mode: shadow ? 'CIEN' : 'PRACA', targetQty: job.targetQty, delayMs: Math.max(0, now.getTime() - job.firstChangeAt.getTime()), createdAt: now } })
    // usuwamy tylko, jeśli w międzyczasie fanout nie wpisał nowszego targetu
    await db.stockSyncJob.deleteMany({ where: { offerId: job.offerId, computedAt: job.computedAt, targetQty: job.targetQty } })
  }
  for (const s of toSend.filter((x) => x.shadow)) {
    await done(s.job, true)
    stats.shadow++
  }
  const live = toSend.filter((x) => !x.shadow)
  if (live.length) {
    let results: PushResult[]
    try {
      if (!adapter) throw new Error(`Kanał ${accLabel(acc)} w trybie PRACA bez adaptera zapisu — nic nie wysłano`)
      results = await adapter.push(live.map((x) => x.item))
    } catch (e) {
      results = live.map((x) => ({ offerId: x.item.offerId, ok: false, error: (e as Error).message }))
    }
    const byId = new Map(results.map((r) => [r.offerId, r]))
    let anyOk = false
    for (const x of live) {
      const r = byId.get(x.item.offerId)
      if (r?.ok && r.skipped) {
        // kanał ma już tę wartość (rejestr synchronizacji): job zdjęty bez wywołania kanału i bez wpisu PRACA;
        // lastPushedQty = wartość z ostatniego udanego zapisu (ta sama treść), lastPushedAt bez zmian
        if (x.item.targetQty !== offers.get(x.job.offerId)?.lastPushedQty) await db.channelOffer.update({ where: { id: x.job.offerId }, data: { lastPushedQty: x.job.targetQty } })
        await db.stockSyncJob.deleteMany({ where: { offerId: x.job.offerId, computedAt: x.job.computedAt, targetQty: x.job.targetQty } })
        stats.skippedUnchanged++
      } else if (r?.ok) {
        anyOk = true
        await done(x.job, false)
        stats.sent++
      } else if (r?.odlozone) {
        // odłożone przez host — bez próby, bez alertu, bez wpływu na zdrowie kanału; job czeka i wraca sam
        await db.stockSyncJob.updateMany({
          where: { offerId: x.job.offerId, computedAt: x.job.computedAt },
          data: { lastError: `odłożone: ${(r.error ?? '').slice(0, 900)}`, nextAttemptAt: new Date(now.getTime() + Math.max(1_000, r.retryAfterMs ?? 60_000)) },
        })
      } else {
        stats.failed++
        const attempts = x.job.attempts + 1
        const error = (r?.error ?? 'brak wyniku').slice(0, 1000)
        // NIEJEDNOZNACZNY: nie wiadomo, czy kanał zapisał — bez ponowienia, alert; TRWALY: najdłuższy odstęp
        // trwały błąd po TRWALY_MAX próbach też odstawiony (bez ponawiania żądań do sklepu co 5 min) i z alertem
        const parked = r?.kind === 'NIEJEDNOZNACZNY' || !!r?.odstaw || (r?.kind === 'TRWALY' && attempts >= TRWALY_MAX)
        // Retry-After z kanału dłuższy niż własny odstęp wygrywa, inaczej druga próba znowu dostanie 429
        const delay = parked ? PARKED_MS : Math.max(r?.retryAfterMs ?? 0, r?.kind === 'TRWALY' ? BACKOFF_MS[BACKOFF_MS.length - 1]! : BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!)
        await db.stockSyncJob.updateMany({
          where: { offerId: x.job.offerId, computedAt: x.job.computedAt },
          data: { attempts, lastError: r?.kind ? `${r.kind}: ${error}`.slice(0, 1000) : error, nextAttemptAt: new Date(now.getTime() + delay) },
        })
        if (r?.odstaw)
          await alert(db, 'KANAL_STAN_BLAD', accLabel(acc), `Kanał ${accLabel(acc)}: oferta ${x.item.externalId}: ${error}. Kompletor nie ponawia; kolejne takie oferty są na ekranie konta („Oferty z błędem”). Po wyjaśnieniu kliknij „Wypchnij teraz”.`, `stan-odstaw:${accLabel(acc)}:${now.toISOString().slice(0, 10)}`)
        else if (r?.kind === 'TRWALY' && attempts === TRWALY_MAX)
          await alert(db, 'KANAL_STAN_BLAD', accLabel(acc), `Kanał ${accLabel(acc)}: stan oferty ${x.item.externalId} nie zapisuje się (${attempts} prób): ${error}. Popraw i kliknij „Wypchnij teraz”.`, `stan-blad:${x.job.offerId}:${x.job.computedAt.toISOString()}`)
        if (r?.kind === 'NIEJEDNOZNACZNY')
          await alert(db, 'KANAL_STAN_NIEJEDNOZNACZNY', accLabel(acc), `Kanał ${accLabel(acc)}: nie wiadomo, czy stan oferty ${x.item.externalId} (${x.item.targetQty} szt.) zapisał się w sklepie: ${error}. Sprawdź i kliknij „Wypchnij teraz”.`, `stan-niejednoznaczny:${x.job.offerId}:${x.job.computedAt.toISOString()}`)
      }
    }
    await updateHealth(db, acc, anyOk, stats.failed > 0 && !anyOk, now)
  }
  if (live.length) {
    // lastBatchAt (odstęp Empiku) tylko, gdy coś naprawdę poszło do kanału; licznik przebiegu na ekran konta zawsze
    const pass = { lastPassAt: now, lastPassSent: stats.sent, lastPassSkipped: stats.skippedUnchanged }
    const batch = stats.skippedUnchanged < live.length ? { lastBatchAt: now } : {}
    await db.channelHealth.upsert({ where: healthKey, create: { organizationId: healthKey.organizationId_channel_channelAccountId.organizationId, channel, channelAccountId, ...batch, ...pass }, update: { ...batch, ...pass } })
  }
  return stats
}

async function updateHealth(db: Db, acc: ChannelAccount, ok: boolean, allFailed: boolean, now: Date): Promise<void> {
  const { channel, channelAccountId } = acc
  const where = { organizationId_channel_channelAccountId: { organizationId: organizationIdOf(db), channel, channelAccountId } }
  const h = await db.channelHealth.upsert({ where, create: { organizationId: where.organizationId_channel_channelAccountId.organizationId, channel, channelAccountId }, update: {} })
  if (ok) {
    const recovered = !!h.failingSince
    await db.channelHealth.update({ where, data: { failingSince: null, lastOkAt: now, needsFullSync: recovered || h.needsFullSync } })
    return
  }
  if (!allFailed) return
  const since = h.failingSince ?? now
  if (!h.failingSince) await db.channelHealth.update({ where, data: { failingSince: now } })
  if (now.getTime() - since.getTime() >= CHANNEL_ALERT_AFTER_MS)
    await alert(db, 'KANAL_NIEDOSTEPNY', accLabel(acc), `Kanał ${accLabel(acc)}: stany nieaktualne od ${since.toISOString()}`, `kanal:${accLabel(acc)}:${since.toISOString()}`)
}

/** Konto kanału wróciło: zaległe joby od razu, potem pełna synchronizacja (6.4). */
export async function runRecoveredFullSyncs(db: Db, ctx: { now?: Date } = {}): Promise<ChannelAccount[]> {
  const rows = await db.channelHealth.findMany({ where: { needsFullSync: true } })
  const organizationId = organizationIdOf(db)
  for (const r of rows) {
    await fullSyncChannel(db, r, ctx)
    await db.channelHealth.update({
      where: { organizationId_channel_channelAccountId: { organizationId, channel: r.channel, channelAccountId: r.channelAccountId } },
      data: { needsFullSync: false },
    })
  }
  return rows.map((r) => ({ channel: r.channel, channelAccountId: r.channelAccountId }))
}
