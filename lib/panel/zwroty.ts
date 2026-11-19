// Odczyty ekranu „Zwroty i reklamacje” (z własnymi zwrotami na pierwszym planie): zwroty
// i reklamacje Kompletora (tabela `Return`, 5 statusów jak w BL z licznikami), a obok podgląd sygnałów z kopii zamówień
// kanałów i reklamacji z kopii nagłówków BL. Tylko `findMany` i `count` przez klienta firmy z sesji (RLS);
// klient systemowy jest odrzucany (`organizationIdOf`). Obie kopie są bez danych osobowych, ekran też ich nie pokazuje.
import type { Channel, Prisma, PrismaClient, ReturnKind, ReturnStatus } from '@prisma/client'
import { blStatusFamily } from '@/lib/cien/bl-porownanie'
import { organizationIdOf } from '@/lib/db'
import { ALLEGRO_ZWROT_KONCOWKA, STATUSY_SYGNALOW, type SygnalZwrotu, sygnalZwrotu } from '@/lib/zwroty/sygnaly'

type Db = PrismaClient

/** Najwięcej wierszy na liście (liczniki liczą wszystkie). */
export const ZWROTY_LIMIT = 200

export const ZWROTY_LISTS = { wlasne: 'Zwroty i reklamacje', sygnaly: 'Sygnały z kanałów', reklamacje: 'Reklamacje w BaseLinkerze' } as const
export type ZwrotyLista = keyof typeof ZWROTY_LISTS

export const RETURN_STATUSES: ReturnStatus[] = ['ZGLOSZONY', 'PRZYJETY', 'KOREKTA', 'ZAKONCZONY', 'ODRZUCONY']

/** Warunek „kopia kanału ze statusem zwrotu/reklamacji” — z tych samych list, z których liczy `sygnalZwrotu`. */
export function signalWhere(): Prisma.ChannelOrderSnapshotWhereInput {
  const exact = Object.entries(STATUSY_SYGNALOW).map(([channel, list]) => ({ channel: channel as Channel, channelStatus: { in: [...(list ?? [])] } }))
  return { OR: [...exact, { channel: 'ALLEGRO', channelStatus: { endsWith: ALLEGRO_ZWROT_KONCOWKA } }] }
}

export interface ChannelRef {
  channel: Channel
  channelAccountId: string
  externalId: string
  /** Zamówienie u nas; null = kopia sprzed pierwszego odczytu (bez linku). */
  orderId: string | null
}

export interface SignalRow extends ChannelRef {
  id: string
  signal: SygnalZwrotu
  channelStatus: string
  totalGross: string
  at: Date
}

export interface BlComplaintRow {
  blOrderId: number
  channel: Channel
  channelAccountId: string
  externalRef: string | null
  statusName: string
  totalGross: string | null
  dateAdd: Date
  fetchedAt: Date
  /** Kopia zamówienia kanału po `blOrderId`; null = kanał nieczytany przez nas albo zamówienie spoza okna odczytu. */
  channelCopy: ChannelRef | null
}

export interface OwnReturnRow {
  id: string
  kind: ReturnKind
  status: ReturnStatus
  reason: string | null
  source: string
  createdAt: Date
  order: { id: string; channel: Channel; channelAccountId: string; externalId: string }
  /** Liczba pozycji (ilości są w różnych jednostkach bazowych, więc ich nie sumujemy). */
  lines: number
}

export interface ZwrotyPanel {
  list: ZwrotyLista
  counts: Record<ZwrotyLista, number>
  signals: SignalRow[]
  complaints: BlComplaintRow[]
  own: OwnReturnRow[]
  ownByStatus: Record<ReturnStatus, number>
}

const str = (v: { toString(): string } | null) => (v === null ? null : v.toString())

/**
 * Kopie BL w rodzinie REKLAMACJA (mapa spec 7.1): wstępnie po prefiksie w bazie, ostatecznie `blStatusFamily`. Jedyna
 * reguła rodziny to `^reklamac`, więc licznik z `count` po prefiksie jest zgodny z listą (strona
 * z `take`, bez czytania całej kopii BL).
 */
const COMPLAINT_WHERE = { statusName: { startsWith: 'reklamac', mode: 'insensitive' } } as const

async function blComplaints(db: Db, take: number) {
  const rows = await db.blOrderSnapshot.findMany({
    where: COMPLAINT_WHERE,
    orderBy: [{ dateAdd: 'desc' }, { blOrderId: 'desc' }],
    take,
    select: { blOrderId: true, channel: true, channelAccountId: true, externalRef: true, statusName: true, totalGross: true, dateAdd: true, fetchedAt: true },
  })
  return rows.filter((r) => r.statusName !== null && blStatusFamily(r.statusName).family === 'REKLAMACJA')
}

/** `orderId`: ekran otwarty z karty zamówienia („Zgłoś zwrot”) pokazuje tylko to zamówienie. */
export async function zwrotyPanel(db: Db, list: ZwrotyLista, opts: { orderId?: string; status?: ReturnStatus } = {}): Promise<ZwrotyPanel> {
  organizationIdOf(db)
  const zam = opts.orderId ? { orderId: opts.orderId } : {}
  const zamStatus = { ...zam, ...(opts.status ? { status: opts.status } : {}) }
  const where = { ...signalWhere(), ...zam }
  const [signalCount, complaintCount, ownCount, ...byStatus] = await Promise.all([
    db.channelOrderSnapshot.count({ where }),
    opts.orderId ? Promise.resolve(0) : db.blOrderSnapshot.count({ where: COMPLAINT_WHERE }),
    db.return.count({ where: zamStatus }),
    ...RETURN_STATUSES.map((status) => db.return.count({ where: { status, ...zam } })),
  ])
  const ownByStatus = Object.fromEntries(RETURN_STATUSES.map((s, i) => [s, byStatus[i] ?? 0])) as Record<ReturnStatus, number>
  const out: ZwrotyPanel = { list, counts: { sygnaly: signalCount, reklamacje: complaintCount, wlasne: ownCount }, signals: [], complaints: [], own: [], ownByStatus }

  if (list === 'sygnaly') {
    const rows = await db.channelOrderSnapshot.findMany({
      where,
      orderBy: [{ revisionSeenAt: { sort: 'desc', nulls: 'last' } }, { lastSeenAt: 'desc' }, { id: 'asc' }],
      take: ZWROTY_LIMIT,
      select: { id: true, channel: true, channelAccountId: true, externalId: true, orderId: true, channelStatus: true, totalGross: true, revisionSeenAt: true, lastSeenAt: true },
    })
    for (const r of rows) {
      const signal = sygnalZwrotu(r.channel, r.channelStatus)
      if (!signal) continue // zapytanie i klasyfikacja mają te same listy; tu tylko dla typu
      out.signals.push({ id: r.id, channel: r.channel, channelAccountId: r.channelAccountId, externalId: r.externalId, orderId: r.orderId, signal, channelStatus: r.channelStatus, totalGross: r.totalGross.toString(), at: r.revisionSeenAt ?? r.lastSeenAt })
    }
  }

  if (list === 'reklamacje') {
    const page = await blComplaints(db, ZWROTY_LIMIT)
    const ids = page.map((c) => c.blOrderId)
    // po samym blOrderId: jedno konto BL na firmę = blOrderId unikalny (przy dwóch kontach BL wygra najnowsza kopia)
    const copies = ids.length
      ? await db.channelOrderSnapshot.findMany({
          where: { blOrderId: { in: ids } },
          orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
          select: { blOrderId: true, channel: true, channelAccountId: true, externalId: true, orderId: true },
        })
      : []
    const byBl = new Map<number, ChannelRef>()
    for (const c of copies) if (!byBl.has(c.blOrderId!)) byBl.set(c.blOrderId!, { channel: c.channel, channelAccountId: c.channelAccountId, externalId: c.externalId, orderId: c.orderId })
    out.complaints = page.map((c) => ({ ...c, statusName: c.statusName!, totalGross: str(c.totalGross), channelCopy: byBl.get(c.blOrderId) ?? null }))
    if (opts.orderId) {
      out.complaints = out.complaints.filter((c) => c.channelCopy?.orderId === opts.orderId)
      out.counts.reklamacje = out.complaints.length
    }
  }

  if (list === 'wlasne') {
    const rows = await db.return.findMany({
      where: zamStatus,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: ZWROTY_LIMIT,
      select: {
        id: true,
        kind: true,
        status: true,
        reason: true,
        source: true,
        createdAt: true,
        order: { select: { id: true, channel: true, channelAccountId: true, externalId: true } },
        lines: { select: { id: true } },
      },
    })
    out.own = rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, reason: r.reason, source: r.source, createdAt: r.createdAt, order: r.order, lines: r.lines.length }))
  }

  return out
}
