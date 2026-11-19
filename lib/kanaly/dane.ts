// Odczyty ekranów Ustawienia → Kanały sprzedaży. Klient firmy (RLS). Sekrety tylko jako nazwy i daty
// zapisu (listSecrets): wartości nie wychodzą do ekranu ani do HTML.
import { maEnvPrefix } from './tryb'
import { type WykryteKlucze, wykryteZBazy } from './woo-meta'
import type { Channel, ChannelMode, PrismaClient } from '@prisma/client'
import type { AdapterManifest, ConfigField, SecretField } from '../adaptery/kontrakt'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { listSecrets } from '../sekrety'
import { kodKonta, polaSekretow, polaUstawien } from './konta'
import { nazwaPlatformy } from './platformy'
import { DO_PRZYPISANIA, doPrzypisania, OFFERS_RUN_KIND, type PozycjaDoPrzypisania, type WynikOfert } from './oferty'

export interface KontoWiersz {
  kod: string
  channel: Channel
  channelAccountId: string
  name: string
  adapterKey: string
  rodzaj: string
  active: boolean
  stockMode: ChannelMode
  statusMode: ChannelMode
  trackingMode: ChannelMode
  testOk: boolean | null
  testMessage: string | null
  testCheckedAt: Date | null
  lastReadAt: Date | null
  readError: string | null
  offers: number
  toAssign: number
}

export async function listaKont(db: PrismaClient, registry: AdapterRegistry): Promise<KontoWiersz[]> {
  const [rows, statuses, cursors, offers, reads] = await Promise.all([
    db.channelConfig.findMany({ where: { channel: { not: 'AI' } }, orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
    db.channelAccountStatus.findMany(),
    db.channelCursor.findMany({ select: { channel: true, channelAccountId: true, lastOkAt: true, failingSince: true } }),
    db.channelOffer.groupBy({ by: ['channel', 'channelAccountId'], where: { active: true }, _count: { _all: true } }),
    db.channelOfferRead.groupBy({ by: ['channel', 'channelAccountId'], where: { state: { in: DO_PRZYPISANIA } }, _count: { _all: true } }),
  ])
  const k = (c: Channel, a: string) => `${c}/${a}`
  const st = new Map(statuses.map((s) => [k(s.channel, s.channelAccountId), s]))
  const cur = new Map(cursors.map((s) => [k(s.channel, s.channelAccountId), s]))
  const off = new Map(offers.map((s) => [k(s.channel, s.channelAccountId), s._count._all]))
  const rd = new Map(reads.map((s) => [k(s.channel, s.channelAccountId), s._count._all]))
  return rows.map((r) => {
    const key = k(r.channel, r.channelAccountId)
    const s = st.get(key)
    const c = cur.get(key)
    return {
      kod: kodKonta(r),
      channel: r.channel,
      channelAccountId: r.channelAccountId,
      name: r.name,
      adapterKey: r.adapterKey,
      // przegląd (UX): nazwa platformy po ludzku („Allegro”), nie opis techniczny adaptera
      rodzaj: nazwaPlatformy(r.channel) ?? registry.get(r.adapterKey)?.manifest.displayName ?? r.adapterKey,
      active: r.active,
      stockMode: r.stockMode,
      statusMode: r.statusMode,
      trackingMode: r.trackingMode,
      testOk: s?.testOk ?? null,
      testMessage: s?.testMessage ?? null,
      testCheckedAt: s?.testCheckedAt ?? null,
      lastReadAt: c?.lastOkAt ?? null,
      readError: c?.failingSince ? 'odczyt zamówień ma błędy' : null,
      offers: off.get(key) ?? 0,
      toAssign: rd.get(key) ?? 0,
    }
  })
}

export interface PoleUstawienia {
  field: ConfigField
  value: string
}

export interface PoleSekretu {
  field: SecretField
  /** Kiedy zapisano (bez wartości); null = brak klucza. */
  savedAt: Date | null
}

export interface OstatniPrzebieg {
  status: string
  startedAt: Date
  finishedAt: Date | null
  error: string | null
  stats: Partial<WynikOfert> | null
  issues: { kind: string; ref: string; message: string }[]
}

export interface KontoEkran {
  konto: KontoWiersz
  manifest: AdapterManifest | null
  ustawienia: PoleUstawienia[]
  sekrety: PoleSekretu[]
  /** Self-host: konto czyta klucze i ustawienia z env (przedrostek), ekran tylko o tym informuje. */
  envPrefix: string | null
  /** konfiguracja konta (bez sekretów) do warunków trybu pracy. */
  config: Record<string, unknown>
  createdInPanel: boolean
  testPending: boolean
  offersPending: boolean
  canReadOffers: boolean
  ostatniPrzebieg: OstatniPrzebieg | null
  doPrzypisania: PozycjaDoPrzypisania[]
  /** nazwy kluczy meta z ostatniego udanego testu połączenia (Woo), bez wartości. */
  wykryteMeta: WykryteKlucze | null
}

const PENDING_MS = 10 * 60_000

export async function kontoEkran(db: PrismaClient, registry: AdapterRegistry, ref: { channel: Channel; channelAccountId: string }, now = new Date()): Promise<KontoEkran | null> {
  const list = await listaKont(db, registry)
  const konto = list.find((x) => x.channel === ref.channel && x.channelAccountId === ref.channelAccountId)
  if (!konto) return null
  const [row, status, secrets] = await Promise.all([
    db.channelConfig.findFirstOrThrow({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId } }),
    db.channelAccountStatus.findFirst({ where: { channel: ref.channel, channelAccountId: ref.channelAccountId } }),
    listSecrets(db),
  ])
  const manifest = registry.get(row.adapterKey)?.manifest ?? null
  const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : {}
  const saved = new Map(secrets.filter((s) => s.channel === ref.channel && s.channelAccountId === ref.channelAccountId).map((s) => [s.name, s.updatedAt]))
  const run = status?.offersRunId ? await db.importRun.findFirst({ where: { id: status.offersRunId, kind: OFFERS_RUN_KIND }, include: { issues: { take: 20, orderBy: { createdAt: 'asc' } } } }) : null
  const recent = (t: Date | null | undefined) => !!t && now.getTime() - t.getTime() < PENDING_MS
  return {
    konto,
    manifest,
    ustawienia: manifest ? polaUstawien(manifest).map((f) => ({ field: f, value: config[f.key] === undefined || config[f.key] === null ? '' : String(config[f.key]) })) : [],
    sekrety: manifest ? polaSekretow(manifest).map((f) => ({ field: f, savedAt: saved.get(f.name) ?? null })) : [],
    envPrefix: maEnvPrefix(config) ? (config['envPrefix'] as string).trim() : null,
    config,
    createdInPanel: status?.createdInPanel ?? false,
    testPending: recent(status?.testRequestedAt) && (!status?.testCheckedAt || status.testCheckedAt < status.testRequestedAt!),
    offersPending: recent(status?.offersRequestedAt) && (!run || run.startedAt < status!.offersRequestedAt! || run.status === 'RUNNING'),
    canReadOffers: !!manifest?.capabilities.includes('offers.read'),
    ostatniPrzebieg: run
      ? {
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          error: run.error,
          stats: (run.stats as Partial<WynikOfert> | null) ?? null,
          issues: run.issues.map((i) => ({ kind: i.kind, ref: i.ref, message: i.message })),
        }
      : null,
    doPrzypisania: await doPrzypisania(db, ref),
    wykryteMeta: wykryteZBazy(status?.testMetaKeys),
  }
}

/** Wyszukiwarka produktów do przypisania oferty: SKU, nazwa, EAN. */
export async function szukajProduktow(db: PrismaClient, q: string, limit = 15): Promise<{ id: string; sku: string; title: string }[]> {
  const s = q.trim().slice(0, 100)
  if (s.length < 2) return []
  return db.product.findMany({
    where: { active: true, OR: [{ sku: { contains: s, mode: 'insensitive' } }, { title: { contains: s, mode: 'insensitive' } }, { ean: s }] },
    select: { id: true, sku: true, title: true },
    orderBy: { sku: 'asc' },
    take: limit,
  })
}
