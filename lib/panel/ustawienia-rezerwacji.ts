// Ustawienia → Zasady rezerwacji: odczyty ekranu. Zapis wyłącznie przez `updatePolicy`
// (lib/rdzen/polityka.ts — walidacja i wpis do AuditLog); tu tylko czytamy przez klienta firmy z sesji (RLS).
import type { Channel, PrismaClient } from '@prisma/client'
import { organizationIdOf, systemPrisma } from '@/lib/db'
import { accountDisplayName, CHANNEL_LABEL } from '@/lib/panel/format'
import { getPolicyVersioned, type Policy } from '@/lib/rdzen/polityka'
import { policyChanges, policyOf, type PolicyChange } from './ustawienia-rezerwacji-opis'

export const POLICY_HISTORY_LIMIT = 10

export interface PolicyHistoryEntry {
  id: string
  at: Date
  who: string
  changes: PolicyChange[]
}

export interface SafetyBufferRow {
  id: string // kanał:konto
  channel: Channel
  channelLabel: string
  name: string
  buffer: number
  active: boolean
}

export interface ReservationSettings {
  policy: Policy
  version: string
  history: PolicyHistoryEntry[]
  buffers: SafetyBufferRow[]
}

/**
 * Nazwy osób z historii. Tabela kont (`User`) jest poza zasięgiem roli aplikacji, więc nazwę czytamy klientem
 * systemowym — ale wyłącznie dla osób, które mają (albo miały) członkostwo w TEJ firmie (Membership pod RLS).
 * Identyfikatory techniczne (testy, worker, skrypty) pokazujemy jako „system”.
 */
async function actorNames(db: PrismaClient, ids: string[], sys: () => PrismaClient): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!ids.length) return out
  const members = await db.membership.findMany({ where: { userId: { in: ids } }, select: { userId: true } })
  const memberIds = members.map((m) => m.userId)
  if (memberIds.length) {
    const users = await sys().user.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } })
    for (const u of users) out.set(u.id, u.name)
  }
  return out
}

/** Nazwy osób firmy klienta `db` po User.id (dziennik podglądów danych klientów); obce id = brak w mapie. */
export async function nazwyOsobFirmy(db: PrismaClient, ids: string[], opts: { sys?: () => PrismaClient } = {}): Promise<Map<string, string>> {
  return actorNames(db, ids, opts.sys ?? systemPrisma)
}

export async function reservationSettings(db: PrismaClient, opts: { sys?: () => PrismaClient } = {}): Promise<ReservationSettings> {
  const organizationId = organizationIdOf(db) // klient systemowy (przez wszystkie firmy) → błąd
  const [versioned, logs, configs] = await Promise.all([
    getPolicyVersioned(db),
    db.auditLog.findMany({
      where: { entity: 'ReservationPolicy', entityId: organizationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: POLICY_HISTORY_LIMIT,
    }),
    // Konto AI to integracja, nie kanał sprzedaży (jak w lib/panel/dane.ts accounts()).
    db.channelConfig.findMany({ where: { channel: { not: 'AI' } }, orderBy: [{ channel: 'asc' }, { name: 'asc' }] }),
  ])
  const names = await actorNames(db, [...new Set(logs.map((l) => l.actorId))], opts.sys ?? systemPrisma)
  return {
    policy: policyOf(versioned.policy),
    version: versioned.version,
    history: logs.map((l) => ({
      id: l.id,
      at: l.createdAt,
      who: names.get(l.actorId) ?? 'system',
      changes: policyChanges(l.before, l.after),
    })),
    buffers: configs
      .filter((c) => c.channel !== 'RECZNE')
      .map((c) => ({
        id: `${c.channel}:${c.channelAccountId}`,
        channel: c.channel,
        channelLabel: CHANNEL_LABEL[c.channel],
        name: accountDisplayName(c.channel, c.channelAccountId, c.name, c.config),
        buffer: c.defaultSafetyBuffer,
        active: c.active,
      })),
  }
}
