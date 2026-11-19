// tryb pracy bez zapisu stanów (statusy i numery nadania w pracy, stany ofert w podglądzie) z panelu.
// Na bazie i fałszywym adapterze (kanał w pamięci, bez sieci). Sprawdza: przełączenia z panelu (warunki, pola trybu,
// goRef, AuditLog, idempotencja), host zapisu (stany tylko „wysłałbym”, statusy i numery nadania wychodzą), ekran
// zapisu (powód braku stanów), zbiorcze „Włącz tryb pracy” (nie dołącza stanów), punkt cięcia (konto pracujące
// pomija) i bramki zamówień (konto pracujące). Żadnych prawdziwych sklepów ani danych klientów.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { FakeChannelState, fakeDefinition } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { punktCiecia } from '@/lib/kanaly/punkt-ciecia'
import { trybKonta, zmienTrybKonta } from '@/lib/kanaly/tryb'
import { adapterStanowKonta, ekranZapisu, POWOD_PRACA_BEZ_STANOW, przebiegZapisuKanalow, ZDARZENIE_NUMER_NADANIA } from '@/lib/kanaly/zapis-host'
import { kontoZamowienia, pracaDostepna } from '@/lib/praca/wlacznik'
import { runFanout, runStockPush } from '@/lib/rdzen/propagacja'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { wlaczPraceFirmy } from '@/lib/start/tryb-firmy'
import { ORG_A, testDb, truncateAll } from './db'
import { ACC, offer, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const SRC = { env: {}, envFallback: false }
const S = 1000
const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)
const SD = ACC.WOO_SD
const where = { organizationId_channel_channelAccountId: { organizationId: ORG_A, ...SD } }
const actor = 'test'

let state: FakeChannelState
let registry: AdapterRegistry

const ctx = (now: Date) => ({ registry, secrets: SRC, now })
const opts = (extra: Partial<{ firmaZBl: boolean; env: Record<string, string> }> = {}) => ({ actorId: actor, env: {}, registry, firmaZBl: false, now: T0, ...extra })
const tryby = async () => {
  const r = await db.channelConfig.findUniqueOrThrow({ where })
  return { stockMode: r.stockMode, statusMode: r.statusMode, trackingMode: r.trackingMode }
}

async function konto(data: { config?: Record<string, unknown>; testOk?: boolean | null }) {
  await db.channelConfig.update({ where, data: { adapterKey: 'fake.v1', ...(data.config ? { config: data.config as Prisma.InputJsonValue } : {}) } })
  const testOk = data.testOk === undefined ? true : data.testOk
  await db.channelAccountStatus.upsert({ where, create: { ...SD, testOk }, update: { testOk } })
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  state = new FakeChannelState()
  registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
})

describe('przełączenie z panelu', () => {
  it('podgląd → bez stanów: statusy i numery nadania w pracy, stany w podglądzie; goRef, AuditLog, idempotencja', async () => {
    await konto({ testOk: null })
    await expect(zmienTrybKonta(db, SD, 'BEZ_STANOW', opts())).rejects.toThrow(/Sprawdź połączenie/)
    expect(await tryby()).toEqual({ stockMode: 'CIEN', statusMode: 'CIEN', trackingMode: 'CIEN' })
    await konto({ testOk: true })
    expect(await zmienTrybKonta(db, SD, 'BEZ_STANOW', opts())).toBe('ZMIENIONO')
    expect(await tryby()).toEqual({ stockMode: 'CIEN', statusMode: 'PRACA', trackingMode: 'PRACA' })
    const row = await db.channelConfig.findUniqueOrThrow({ where })
    expect(trybKonta(row)).toBe('BEZ_STANOW')
    expect(row).toMatchObject({ goBy: actor, goRef: 'panel:praca-bez-stanow' })
    expect(await zmienTrybKonta(db, SD, 'BEZ_STANOW', opts())).toBe('BEZ_ZMIAN')
    const audit = await db.auditLog.findMany({ where: { entityId: `${SD.channel}/${SD.channelAccountId}` }, orderBy: { createdAt: 'asc' } })
    expect(audit).toHaveLength(1)
    expect(audit[0]!.before).toMatchObject({ stockMode: 'CIEN', statusMode: 'CIEN', trackingMode: 'CIEN' })
    expect(audit[0]!.after).toMatchObject({ stockMode: 'CIEN', statusMode: 'PRACA', trackingMode: 'PRACA', zrodlo: 'panel' })
  })

  it('dołącz stany (bez stanów → praca) z warunkami; wyłącz tylko stany (praca → bez stanów) bez warunków; powrót do podglądu', async () => {
    await konto({ testOk: true })
    await zmienTrybKonta(db, SD, 'BEZ_STANOW', opts())
    expect(await zmienTrybKonta(db, SD, 'PRACA', opts())).toBe('ZMIENIONO')
    expect(await tryby()).toEqual({ stockMode: 'PRACA', statusMode: 'PRACA', trackingMode: 'PRACA' })
    // połączenie przestało działać: zdjęcie samych stanów dalej wolno (tylko wyłącza zapis), dołączenie już nie
    await konto({ testOk: false })
    expect(await zmienTrybKonta(db, SD, 'BEZ_STANOW', opts())).toBe('ZMIENIONO')
    expect((await db.channelConfig.findUniqueOrThrow({ where })).goRef).toBe('panel:praca-bez-stanow')
    await expect(zmienTrybKonta(db, SD, 'PRACA', opts())).rejects.toThrow(/połączenia/)
    expect(await zmienTrybKonta(db, SD, 'CIEN', opts())).toBe('ZMIENIONO')
    expect(await tryby()).toEqual({ stockMode: 'CIEN', statusMode: 'CIEN', trackingMode: 'CIEN' })
  })

  it('firma z BaseLinkerem: bez stanów wymaga wyłącznika instancji jak tryb pracy', async () => {
    await konto({ testOk: true })
    await expect(zmienTrybKonta(db, SD, 'BEZ_STANOW', opts({ firmaZBl: true }))).rejects.toThrow(/przechodzących z BaseLinkera/)
    expect(await zmienTrybKonta(db, SD, 'BEZ_STANOW', opts({ firmaZBl: true, env: { EKRANY_PRACA: '1' } }))).toBe('ZMIENIONO')
  })

  it('zapis włączony bez mapy statusów blokuje także pracę bez stanów', async () => {
    await konto({ testOk: true, config: { zapisWlaczony: true, statusy: {} } })
    await expect(zmienTrybKonta(db, SD, 'BEZ_STANOW', opts())).rejects.toThrow(/Zmapuj statusy/)
  })

  it('zbiorcze „Włącz tryb pracy” nie dołącza stanów kontu pracującemu bez stanów', async () => {
    await konto({ testOk: true })
    await zmienTrybKonta(db, SD, 'BEZ_STANOW', opts())
    const w = await wlaczPraceFirmy(db, opts())
    expect(w.wlaczone).not.toContain('WOO_SD test')
    expect(await tryby()).toEqual({ stockMode: 'CIEN', statusMode: 'PRACA', trackingMode: 'PRACA' })
  })
})

describe('praca bez stanów: co wychodzi do sklepu', () => {
  it('stany: host nie daje adaptera, rdzeń zapisuje tylko „wysłałbym”, zero wywołań kanału', async () => {
    await konto({ testOk: true, config: { zapisWlaczony: true } })
    await zmienTrybKonta(db, SD, 'BEZ_STANOW', opts())
    const a = await product(db, 'A', 5)
    const of = await offer(db, 'WOO_SD', '10', a)
    await db.channelOffer.update({ where: { id: of }, data: { lastPushedQty: 5, lastPushedAt: T0 } })
    await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: at(S) })
    await runFanout(db, { now: at(5 * S) })
    const ad = await adapterStanowKonta(db, SD, ctx(at(30 * S)))
    expect(ad).toBeNull()
    await runStockPush(db, SD, null, { now: at(30 * S) })
    expect(state.writeCalls.filter((c) => c.op === 'stock')).toEqual([])
    expect((await db.channelPushLog.findFirstOrThrow({ where: { offerId: of } })).mode).toBe('CIEN')
    expect((await db.channelOffer.findUniqueOrThrow({ where: { id: of } })).lastPushedQty).toBe(5)
  })

  it('statusy i numery nadania wychodzą; ekran zapisu: stany z powodem „pracuje bez stanów”', async () => {
    await konto({ testOk: true, config: { zapisWlaczony: true } })
    await zmienTrybKonta(db, SD, 'BEZ_STANOW', opts())
    const p = await product(db, 'B', 5)
    const r = await ingestOrder(db, order([{ productId: p, qty: 1 }]), { now: T0 })
    const o = await db.order.update({ where: { id: r.orderId! }, data: { status: 'WYSLANE' } })
    const after = { shipmentId: 'sh1', orderId: o.id, packageNo: 1, carrier: 'DPD', trackingNumber: '1000123456789U', adapterKey: 'dpd.services.zapis.v1' }
    await db.auditLog.create({ data: { entity: ZDARZENIE_NUMER_NADANIA, entityId: 'sh1', actorId: 'system', after } })
    await przebiegZapisuKanalow(db, ctx(at(M)))
    expect(state.statuses.get(o.externalId)).toBe('completed')
    expect(state.trackings.get(o.externalId)).toEqual([{ number: '1000123456789U', carrier: 'DPD', url: null }])
    const e = (await ekranZapisu(db, registry, SD, at(2 * M)))!
    expect(e.powody).toEqual({ stany: POWOD_PRACA_BEZ_STANOW, statusy: null, nadania: null })
  })

  it('ekran zapisu: wcześniejsza bramka (konto wyłączone) wygrywa z powodem „bez stanów”', async () => {
    await konto({ testOk: true, config: { zapisWlaczony: true } })
    await zmienTrybKonta(db, SD, 'BEZ_STANOW', opts())
    await db.channelConfig.update({ where, data: { active: false } })
    const e = (await ekranZapisu(db, registry, SD, at(M)))!
    expect(e.powody.stany).toBe('konto wyłączone')
  })
})

describe('praca bez stanów: zamówienia jak w trybie pracy', () => {
  it('bramka pracy (karta, pakowanie, nadawanie) przepuszcza; punkt cięcia pomija konto', async () => {
    await konto({ testOk: true })
    await zmienTrybKonta(db, SD, 'BEZ_STANOW', opts())
    const k = await kontoZamowienia(db, SD, {})
    expect(pracaDostepna(k ? { ...k, firmaZBl: false } : null, {})).toBe(true)
    const w = await punktCiecia(db, { naSucho: true, channel: SD.channel, channelAccountId: SD.channelAccountId, now: at(M) })
    expect(w.konta).toEqual([])
    expect(w.kontaWPracy).toBe(1)
  })
})
