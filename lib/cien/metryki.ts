// Metryki cienia: opóźnienie „zamówienie w kanale → rdzeń” i regularność odczytów, per konto kanału.
// także „zmiana w kanale → u nas” (rewizja = data zmiany w kanale, ISO; `revisionSeenAt` = kiedy ją
// zobaczyliśmy) — mierzalna przy mało nowych zamówieniach, bo liczy każdą zmianę statusu i płatności.
// Opóźnienie liczone tylko dla zamówień złożonych po pierwszym odczycie konta (starsze przyszły z okna wstecz,
// ich opóźnienie mierzyłoby długość okna, nie system).
import type { Channel, PrismaClient } from '@prisma/client'

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]!
}

export interface AccountMetrics {
  channel: Channel
  channelAccountId: string
  adapterKey: string
  firstPollAt: Date | null
  snapshots: number
  ingested: number
  skipped: Record<string, number>
  withError: number
  liveOrders: number
  latencyMs: { p50: number | null; p95: number | null; max: number | null }
  changeLatencyMs: { n: number; p50: number | null; p95: number | null; max: number | null }
  polls: { ok: number; failed: number; gapP95Ms: number | null; gapMaxMs: number | null }
  lastError: string | null
  retryPending: number
}

/** Rewizja jako chwila zmiany w kanale (ISO z datą i godziną); inna postać (numer) = null. */
export function revisionTime(revision: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(revision)) return null
  const t = Date.parse(/([zZ]|[+-]\d{2}:?\d{2})$/.test(revision) ? revision : `${revision}Z`)
  return Number.isFinite(t) ? t : null
}

/** Metryki kont, które mają kursor (były czytane), od `since` (domyślnie od pierwszego odczytu konta). */
export async function shadowMetrics(db: PrismaClient, opts: { since?: Date; until?: Date } = {}): Promise<AccountMetrics[]> {
  const cursors = await db.channelCursor.findMany({ orderBy: [{ channel: 'asc' }, { channelAccountId: 'asc' }] })
  const out: AccountMetrics[] = []
  for (const c of cursors) {
    const since = opts.since ?? c.firstPollAt ?? new Date(0)
    const until = opts.until ?? new Date()
    const where = { channel: c.channel, channelAccountId: c.channelAccountId }
    const snaps = await db.channelOrderSnapshot.findMany({ where, select: { createdAtChannel: true, firstSeenAt: true, ingestedRevision: true, skipReason: true, lastError: true, revision: true, revisionSeenAt: true } })
    const skipped: Record<string, number> = {}
    for (const s of snaps) if (s.skipReason) skipped[s.skipReason] = (skipped[s.skipReason] ?? 0) + 1
    const live = snaps.filter((s) => s.createdAtChannel >= since && s.createdAtChannel <= until)
    const lat = live.map((s) => Math.max(0, s.firstSeenAt.getTime() - s.createdAtChannel.getTime()))
    // zmiana po pierwszym odczycie konta (starsze widzieliśmy dopiero z okna wstecz); rewizja liczbowa (Empik bez daty) się nie liczy
    const changeLat: number[] = []
    for (const s of snaps) {
      const changedAt = revisionTime(s.revision)
      if (changedAt === null || !s.revisionSeenAt || changedAt < since.getTime() || changedAt > until.getTime()) continue
      changeLat.push(Math.max(0, s.revisionSeenAt.getTime() - changedAt))
    }
    const polls = await db.channelOrderPoll.findMany({ where: { ...where, startedAt: { gte: since, lte: until } }, orderBy: { startedAt: 'asc' }, select: { startedAt: true, ok: true } })
    const okPolls = polls.filter((p) => p.ok)
    const gaps: number[] = []
    for (let i = 1; i < okPolls.length; i++) gaps.push(okPolls[i]!.startedAt.getTime() - okPolls[i - 1]!.startedAt.getTime())
    const retry = Array.isArray(c.retryIds) ? c.retryIds.length : 0
    out.push({
      channel: c.channel,
      channelAccountId: c.channelAccountId,
      adapterKey: c.adapterKey,
      firstPollAt: c.firstPollAt,
      snapshots: snaps.length,
      ingested: snaps.filter((s) => s.ingestedRevision).length,
      skipped,
      withError: snaps.filter((s) => s.lastError).length,
      liveOrders: live.length,
      latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), max: lat.length ? Math.max(...lat) : null },
      changeLatencyMs: { n: changeLat.length, p50: percentile(changeLat, 50), p95: percentile(changeLat, 95), max: changeLat.length ? Math.max(...changeLat) : null },
      polls: { ok: okPolls.length, failed: polls.length - okPolls.length, gapP95Ms: percentile(gaps, 95), gapMaxMs: gaps.length ? Math.max(...gaps) : null },
      lastError: c.lastError,
      retryPending: retry,
    })
  }
  return out
}
