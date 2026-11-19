// przyjmowanie zamówień Empiku (OR21) przez zadanie workera, wyłącznie na atrapie Mirakl (empik.example).
// Droga jak na produkcji: odczyt dziennika (pollAccount, adapter mirakl.empik.zapis.v1) → kopia w stanie
// WAITING_ACCEPTANCE i zamówienie z rezerwacją → runEmpikAcceptance. Zero wywołań prawdziwego Empiku.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChannelMode } from '@prisma/client'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { pollAccount } from '@/lib/cien/odczyt-zamowien'
import { ALERT_BLAD, ALERT_CZEKA, ALERT_DECYZJA, EV_BLAD, EV_DO_DECYZJI, EV_NIEAKTUALNE, EV_PODGLAD, EV_PRZYJETE, planAkceptacji, runEmpikAcceptance, odstepPoOdmowie, ustawieniaAkceptacji, wyczyscPauzyKont } from '@/lib/empik/akceptacja'
import { handlers } from '@/lib/worker/zadania'
import { HARMONOGRAM_RDZENIA } from '@/lib/worker/harmonogram'
import { setSecret } from '@/lib/sekrety'
import { ORG_A, testDb, truncateAll } from './db'
import { MIRAKL_HOST, MIRAKL_KEY, MiraklAtrapa } from './mirakl-atrapa'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { product, seedBase, stockOf } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const T = new Date('2026-11-06T09:00:00.000Z')
const ENV = { APP_ENCRYPTION_KEY: '3'.repeat(64) }
const SRC = { env: ENV, envFallback: false }
const SCOPE = { channel: 'EMPIK' as const, channelAccountId: 'empik' }
const registry = defaultRegistry()
// klient HTTP bez odstępu 2 s i bez ponowień (wspólny odstęp konta zostaje w produkcji)
const FAST = { minIntervalMs: 0, retry: { attempts: 1, baseDelayMs: 0 } }

let at: MiraklAtrapa
let A: string
let B: string

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  at = new MiraklAtrapa()
  wyczyscPauzyKont()
  A = await product(db, 'A', 5)
  B = await product(db, 'B', 0)
  await db.channelOffer.createMany({
    data: [
      { ...SCOPE, externalId: 'PA', productId: A },
      { ...SCOPE, externalId: 'PB', productId: B },
    ],
  })
  await setSecret(db, 'MIRAKL_API_KEY', MIRAKL_KEY, ENV, SCOPE)
})

async function konto(opts: { mode?: ChannelMode; config?: Record<string, unknown>; adapterKey?: string } = {}) {
  await db.channelConfig.update({
    where: { organizationId_channel_channelAccountId: { organizationId: ORG_A, ...SCOPE } },
    data: { adapterKey: opts.adapterKey ?? 'mirakl.empik.zapis.v1', statusMode: opts.mode ?? 'CIEN', config: { baseUrl: MIRAKL_HOST, ...(opts.config ?? { zapisWlaczony: true }) } },
  })
}

async function odczyt(now = T) {
  const acc = (await loadChannelAccounts(db)).find((a) => a.channel === 'EMPIK')!
  return pollAccount(db, acc, { registry, secrets: SRC, fetch: at.fetch, http: FAST, now: () => now, initialLookbackMs: 7 * 24 * 3600_000 })
}

const przebieg = (now = T) => runEmpikAcceptance(db, { registry, secrets: SRC, fetch: at.fetch, http: FAST, now: () => now })
const zdarzenia = (kind: string) => db.orderEvent.findMany({ where: { kind }, select: { orderId: true, data: true } })
const orderOf = async (externalId: string) => (await db.order.findFirstOrThrow({ where: { channel: 'EMPIK', externalId }, select: { id: true } })).id

describe('Empik: przyjmowanie zamówień (OR21)', () => {
  it('zadanie w harmonogramie co minutę i zarejestrowany handler', () => {
    expect(HARMONOGRAM_RDZENIA).toContainEqual({ kind: 'empik-akceptacja', everyMs: 60_000, requires: 'empik' })
    expect(typeof handlers['empik-akceptacja']).toBe('function')
  })

  it('konto w cieniu: zapisuje tylko „zaakceptowałbym” raz, zero zapisów do Empiku', async () => {
    await konto()
    at.putOrder({ id: 'E-1', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-1-1', sku: 'PA', qty: 2 }] })
    expect(await odczyt()).toMatchObject({ items: 1, bledyTrwale: 0 })
    expect(await stockOf(db, A)).toMatchObject({ reserved: 2 })
    expect(await przebieg()).toMatchObject({ czeka: 1, podglad: 1, przyjete: 0, bledy: [] })
    expect(await przebieg()).toMatchObject({ czeka: 1, podglad: 0 })
    const ev = await zdarzenia(EV_PODGLAD)
    expect(ev).toHaveLength(1)
    expect(ev[0]!.data).toMatchObject({ zamowienie: 'E-1', decyzje: [{ pozycja: 'E-1-1', przyjeta: true }], powod: 'konto w podglądzie' })
    expect(at.zapisy()).toEqual([])
    expect(at.stateOf('E-1')).toBe('WAITING_ACCEPTANCE')
  })

  it('konto w pracy z włączonym zapisem: przyjmuje raz; po odczycie kopia wychodzi ze stanu czekania', async () => {
    await konto({ mode: 'PRACA' })
    at.putOrder({ id: 'E-2', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-2-1', sku: 'PA', qty: 1 }] })
    await odczyt()
    expect(await przebieg()).toMatchObject({ przyjete: 1, bledy: [] })
    expect(at.zapisy().map((z) => `${z.method} ${z.path}`)).toEqual(['PUT /orders/E-2/accept'])
    expect(at.stateOf('E-2')).toBe('WAITING_DEBIT')
    // kopia jeszcze w WAITING_ACCEPTANCE (odczyt nie przyszedł): drugi przebieg nie wysyła drugiej decyzji
    expect(await przebieg()).toMatchObject({ przyjete: 0, czeka: 1 })
    expect(at.zapisy()).toHaveLength(1)
    at.orders.get('E-2')!['last_updated_date'] = '2026-11-06T08:59:00Z'
    await odczyt(new Date(T.getTime() + 60_000))
    expect(await przebieg(new Date(T.getTime() + 120_000))).toMatchObject({ czeka: 0 })
    expect(await zdarzenia(EV_PRZYJETE)).toEqual([{ orderId: await orderOf('E-2'), data: { zamowienie: 'E-2', decyzje: [{ pozycja: 'E-2-1', przyjeta: true }], juzRozstrzygniete: false } }])
  })

  it('reguła „odrzuc”: pozycja w całości bez towaru odrzucona w Empiku i w rdzeniu (brak anulowany, wymuszony stan)', async () => {
    await konto({ mode: 'PRACA', config: { zapisWlaczony: true, akceptacjaBraki: 'odrzuc' } })
    at.putOrder({ id: 'E-3', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-3-1', sku: 'PA', qty: 2 }, { id: 'E-3-2', sku: 'PB', qty: 1 }] })
    await odczyt()
    const id = await orderOf('E-3')
    expect(await db.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(1)
    expect(await przebieg()).toMatchObject({ przyjete: 1, odrzuconePozycje: 1, bledy: [] })
    expect(at.zapisy()[0]!.body).toEqual({ order_lines: [{ id: 'E-3-1', accepted: true }, { id: 'E-3-2', accepted: false }] })
    expect(await db.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(0)
    expect((await db.orderLine.findFirstOrThrow({ where: { orderId: id, externalLineId: 'E-3-2' } })).qtyRejected).toBe(1)
    const pb = await db.channelOffer.findFirstOrThrow({ where: { externalId: 'PB' } })
    expect(await db.outboxEvent.count({ where: { kind: 'FORCE_PUSH', offerId: pb.id } })).toBe(1)
  })

  it('reguła domyślna „czekaj”: brak towaru = bez zapisu, zdarzenie i alert do decyzji raz; po dostawie przyjmuje sam', async () => {
    await konto({ mode: 'PRACA' })
    at.putOrder({ id: 'E-4', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-4-1', sku: 'PB', qty: 1 }] })
    await odczyt()
    expect(await przebieg()).toMatchObject({ doDecyzji: 1, przyjete: 0 })
    expect(await przebieg()).toMatchObject({ doDecyzji: 1, alerty: 0 })
    expect(at.zapisy()).toEqual([])
    expect(await zdarzenia(EV_DO_DECYZJI)).toHaveLength(1)
    const al = await db.alert.findMany({ where: { kind: ALERT_DECYZJA } })
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toContain('E-4-1: brak towaru')
    // rezerwacja zamiast braku (np. przyjęta dostawa): następny przebieg przyjmuje
    const id = await orderOf('E-4')
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: id } })
    await db.shortage.updateMany({ where: { orderId: id }, data: { state: 'RESOLVED' } })
    await db.reservation.create({ data: { orderId: id, orderLineId: line.id, productId: B, warehouseId: DEFAULT_WAREHOUSE, qtyBase: 1 } })
    expect(await przebieg()).toMatchObject({ przyjete: 1 })
  })

  it('pozycja z brakiem części sztuk i pozycja bez produktu: zawsze do decyzji, także przy „odrzuc”', async () => {
    const u = ustawieniaAkceptacji({ akceptacjaBraki: 'odrzuc' })
    await konto({ mode: 'PRACA', config: { zapisWlaczony: true, akceptacjaBraki: 'odrzuc' } })
    at.putOrder({ id: 'E-5', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-5-1', sku: 'PA', qty: 7 }] })
    at.putOrder({ id: 'E-6', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-6-1', sku: 'NIEZNANA', qty: 1 }] })
    await odczyt()
    expect(await planAkceptacji(db, await orderOf('E-5'), u)).toMatchObject({ decyzje: null, powod: expect.stringContaining('części sztuk') })
    expect(await planAkceptacji(db, await orderOf('E-6'), u)).toMatchObject({ decyzje: null, powod: expect.stringContaining('bez produktu') })
    expect(await przebieg()).toMatchObject({ doDecyzji: 2, przyjete: 0, bledy: [] })
    expect(at.zapisy()).toEqual([])
  })

  it('alert, gdy zamówienie czeka dłużej niż ustawienie konta (także w cieniu), jeden na zamówienie', async () => {
    await konto({ config: { akceptacjaAlertGodzin: 3 } })
    at.putOrder({ id: 'E-7', state: 'WAITING_ACCEPTANCE', createdAt: '2026-11-06T07:00:00Z', lines: [{ id: 'E-7-1', sku: 'PA', qty: 1 }] })
    at.putOrder({ id: 'E-8', state: 'WAITING_ACCEPTANCE', createdAt: '2026-11-06T05:30:00Z', lines: [{ id: 'E-8-1', sku: 'PA', qty: 1 }] })
    await odczyt()
    await przebieg()
    await przebieg()
    const al = await db.alert.findMany({ where: { kind: ALERT_CZEKA } })
    expect(al.map((a) => a.ref)).toEqual(['EMPIK/empik/E-8'])
    expect(al[0]!.message).toContain('czeka na przyjęcie 3 h')
    expect(ustawieniaAkceptacji({})).toEqual({ braki: 'czekaj', alertGodzin: 12 })
    expect(ustawieniaAkceptacji({ akceptacjaAlertGodzin: 500, akceptacjaBraki: 'cos' })).toEqual({ braki: 'czekaj', alertGodzin: 12 })
  })

  it('konto w pracy z wyłączonym zapisem albo z adapterem tylko do odczytu: podgląd, zero zapisów', async () => {
    for (const k of [{ config: {} }, { adapterKey: 'mirakl.empik.v1', config: {} }]) {
      await truncateAll(db)
      await seedBase(db)
      at = new MiraklAtrapa()
      const a = await product(db, 'A', 5)
      await db.channelOffer.create({ data: { ...SCOPE, externalId: 'PA', productId: a } })
      await setSecret(db, 'MIRAKL_API_KEY', MIRAKL_KEY, ENV, SCOPE)
      await konto({ mode: 'PRACA', ...k })
      at.putOrder({ id: 'E-9', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-9-1', sku: 'PA', qty: 1 }] })
      await odczyt()
      expect(await przebieg()).toMatchObject({ podglad: 1, przyjete: 0, bledy: [] })
      expect(await przebieg()).toMatchObject({ podglad: 0, bledy: [] })
      expect(at.zapisy()).toEqual([])
    }
  })

  it('częściowa akceptacja wyłączona w Empiku: alert do decyzji, bez kolejnych prób', async () => {
    await konto({ mode: 'PRACA', config: { zapisWlaczony: true, akceptacjaBraki: 'odrzuc' } })
    at.putOrder({ id: 'E-10', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-10-1', sku: 'PA', qty: 1 }, { id: 'E-10-2', sku: 'PB', qty: 1 }] })
    await odczyt()
    at.injectWriteFailure('CZESCIOWA_WYLACZONA')
    expect(await przebieg()).toMatchObject({ przyjete: 0, bledy: [] })
    expect(await przebieg(new Date(T.getTime() + 3600_000))).toMatchObject({ przyjete: 0 })
    expect(at.zapisy()).toHaveLength(1)
    expect(await db.alert.count({ where: { kind: ALERT_DECYZJA } })).toBe(1)
    expect((await zdarzenia(EV_BLAD))[0]!.data).toMatchObject({ czesciowa: true })
    expect(await db.shortage.count({ where: { state: 'OPEN' } })).toBe(1) // rdzeń bez zmian
  })

  it('jedno zamówienie z błędem Empiku nie zatrzymuje drugiego; ponowienie po 30 min', async () => {
    await konto({ mode: 'PRACA' })
    at.putOrder({ id: 'E-11', state: 'WAITING_ACCEPTANCE', createdAt: '2026-11-06T06:00:00Z', lines: [{ id: 'E-11-1', sku: 'PA', qty: 1 }] })
    at.putOrder({ id: 'E-12', state: 'WAITING_ACCEPTANCE', createdAt: '2026-11-06T07:00:00Z', lines: [{ id: 'E-12-1', sku: 'PA', qty: 1 }] })
    await odczyt()
    at.injectWriteFailure('TRWALY') // pierwsze (starsze) zamówienie
    const r = await przebieg()
    expect(r).toMatchObject({ przyjete: 1 })
    expect(r.bledy).toEqual([expect.stringContaining('EMPIK/empik/E-11: TRWALY')])
    expect(at.stateOf('E-12')).toBe('WAITING_DEBIT')
    expect(await przebieg(new Date(T.getTime() + 10 * 60_000))).toMatchObject({ przyjete: 0, bledy: [] }) // przed 30 min: bez próby
    expect(await przebieg(new Date(T.getTime() + 31 * 60_000))).toMatchObject({ przyjete: 1, bledy: [] })
    expect(at.stateOf('E-11')).toBe('WAITING_DEBIT')
  })

  it('ta sama odmowa Empiku drugi raz z rzędu wydłuża odstęp (30 min, 2 h, 6 h, 12 h); inny komunikat liczy od nowa', async () => {
    expect([1, 2, 3, 4, 9].map(odstepPoOdmowie)).toEqual([30 * 60_000, 2 * 3600_000, 6 * 3600_000, 12 * 3600_000, 12 * 3600_000])
    await konto({ mode: 'PRACA' })
    at.putOrder({ id: 'E-21', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-21-1', sku: 'PA', qty: 1 }] })
    await odczyt()
    const min = (m: number) => new Date(T.getTime() + m * 60_000)
    const proby = () => at.zapisy().filter((z) => z.path === '/orders/E-21/accept').length
    at.injectWriteFailure('TRWALY')
    await przebieg()
    expect(proby()).toBe(1)
    at.injectWriteFailure('TRWALY')
    await przebieg(min(31)) // po 30 min: druga próba, ta sama odmowa
    expect(proby()).toBe(2)
    await przebieg(min(31 + 60)) // godzina po drugiej identycznej odmowie: jeszcze nie (odstęp 2 h)
    expect(proby()).toBe(2)
    at.injectWriteFailure('TRWALY')
    await przebieg(min(31 + 121)) // po 2 h: trzecia próba
    expect(proby()).toBe(3)
    await przebieg(min(31 + 121 + 300)) // 5 h po trzeciej: odstęp 6 h
    expect(proby()).toBe(3)
    await przebieg(min(31 + 121 + 361)) // po 6 h: przyjęte
    expect(proby()).toBe(4)
    expect(at.stateOf('E-21')).toBe('WAITING_DEBIT')
    expect(await db.alert.count({ where: { kind: ALERT_BLAD } })).toBe(1) // jeden alert na zamówienie, bez lawiny
  })

  it('zgubiona odpowiedź Empiku: następny przebieg kończy się „już rozstrzygnięte”, bez drugiej decyzji w rdzeniu', async () => {
    await konto({ mode: 'PRACA', config: { zapisWlaczony: true, akceptacjaBraki: 'odrzuc' } })
    at.putOrder({ id: 'E-13', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-13-1', sku: 'PA', qty: 1 }, { id: 'E-13-2', sku: 'PB', qty: 1 }] })
    await odczyt()
    at.injectWriteFailure('SIEC_PO_WYKONANIU')
    expect(await przebieg()).toMatchObject({ ponowienie: 1, przyjete: 0 })
    expect(await przebieg()).toMatchObject({ przyjete: 1, odrzuconePozycje: 0 })
    expect((await zdarzenia(EV_PRZYJETE))[0]!.data).toMatchObject({ juzRozstrzygniete: true })
    expect(await db.shortage.count({ where: { state: 'OPEN' } })).toBe(1) // stan pozycji ustali odczyt dziennika (REFUSED)
    // odczyt nowej rewizji z pozycją REFUSED zdejmuje brak także bez odrzucenia w rdzeniu
    at.orders.get('E-13')!['last_updated_date'] = '2026-11-06T08:59:30Z'
    await odczyt(new Date(T.getTime() + 60_000))
    expect(await db.shortage.count({ where: { state: 'OPEN' } })).toBe(0)
    expect(await stockOf(db, A)).toMatchObject({ reserved: 1 })
  })

  it('po odrzuceniu w Empiku i w rdzeniu nowa rewizja z REFUSED nie psuje rezerwacji; przerwane odrzucenie dokończy następny przebieg', async () => {
    await konto({ mode: 'PRACA', config: { zapisWlaczony: true, akceptacjaBraki: 'odrzuc' } })
    at.putOrder({ id: 'E-14', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-14-1', sku: 'PA', qty: 2 }, { id: 'E-14-2', sku: 'PB', qty: 1 }] })
    await odczyt()
    const id = await orderOf('E-14')
    expect(await przebieg()).toMatchObject({ przyjete: 1, odrzuconePozycje: 1 })
    expect((await zdarzenia(EV_PRZYJETE))[0]!.data).toMatchObject({ dokonczone: true })
    at.orders.get('E-14')!['last_updated_date'] = '2026-11-06T08:59:30Z'
    await odczyt(new Date(T.getTime() + 60_000))
    expect(await db.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(0)
    expect(await stockOf(db, A)).toMatchObject({ reserved: 2 })
    // przerwane odrzucenie (zdarzenie bez zdjętego znacznika): następny przebieg kończy je raz
    at.putOrder({ id: 'E-15', state: 'WAITING_ACCEPTANCE', updatedAt: '2026-11-06T09:01:00Z', lines: [{ id: 'E-15-1', sku: 'PB', qty: 1 }] })
    await odczyt(new Date(T.getTime() + 120_000))
    const id2 = await orderOf('E-15')
    await db.orderEvent.create({ data: { orderId: id2, kind: EV_PRZYJETE, actorId: 'system:empik-akceptacja', data: { zamowienie: 'E-15', decyzje: [{ pozycja: 'E-15-1', przyjeta: false }], dokonczone: false } } })
    expect(await przebieg(new Date(T.getTime() + 180_000))).toMatchObject({ odrzuconePozycje: 1, przyjete: 0 })
    expect(await db.shortage.count({ where: { orderId: id2, state: 'OPEN' } })).toBe(0)
    expect((await db.orderLine.findFirstOrThrow({ where: { orderId: id2 } })).qtyRejected).toBe(1)
    expect(await przebieg(new Date(T.getTime() + 240_000))).toMatchObject({ odrzuconePozycje: 0 })
  })

  it('zamówienie anulowane w Empiku przed przyjęciem = zdarzenie „nieaktualne”, nie „przyjęte”, bez kolejnych prób', async () => {
    await konto({ mode: 'PRACA' })
    at.putOrder({ id: 'E-16', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-16-1', sku: 'PA', qty: 1 }] })
    await odczyt()
    at.orders.get('E-16')!['order_state'] = 'CANCELED' // Empik anulował, kopia jeszcze w czekaniu
    expect(await przebieg()).toMatchObject({ przyjete: 0, bledy: [] })
    expect(await zdarzenia(EV_PRZYJETE)).toEqual([])
    expect((await zdarzenia(EV_NIEAKTUALNE))[0]!.data).toMatchObject({ powod: expect.stringContaining('CANCELED') })
    await przebieg()
    expect(at.zapisy()).toHaveLength(1)
  })

  it('brak oznaczony „wyślij później” = do decyzji ze zdarzeniem i alertem, nie cisza', async () => {
    await konto({ mode: 'PRACA' })
    at.putOrder({ id: 'E-17', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-17-1', sku: 'PB', qty: 1 }] })
    await odczyt()
    await db.shortage.updateMany({ where: { orderId: await orderOf('E-17') }, data: { state: 'SHIP_LATER' } })
    expect(await przebieg()).toMatchObject({ doDecyzji: 1, przyjete: 0 })
    expect((await zdarzenia(EV_DO_DECYZJI))[0]!.data).toMatchObject({ powod: expect.stringContaining('wyślij później') })
    expect(await db.alert.count({ where: { kind: ALERT_DECYZJA } })).toBe(1)
    expect(at.zapisy()).toEqual([])
  })

  it('429 z Retry-After wstrzymuje konto do tego czasu; limit wywołań OR21 na przebieg', async () => {
    await konto({ mode: 'PRACA' })
    for (const n of [21, 22, 23]) at.putOrder({ id: `E-${n}`, state: 'WAITING_ACCEPTANCE', createdAt: `2026-11-06T07:0${n - 20}:00Z`, lines: [{ id: `E-${n}-1`, sku: 'PA', qty: 1 }] })
    await odczyt()
    at.injectWriteFailure('LIMIT')
    expect(await przebieg()).toMatchObject({ przyjete: 0, ponowienie: 1 })
    expect(at.zapisy()).toHaveLength(1) // po 429 bez kolejnych zamówień w tym przebiegu
    expect(await przebieg(new Date(T.getTime() + 30_000))).toMatchObject({ przyjete: 0, ponowienie: 3 }) // Retry-After 60 s
    expect(at.zapisy()).toHaveLength(1)
    const r = await runEmpikAcceptance(db, { registry, secrets: SRC, fetch: at.fetch, http: FAST, now: () => new Date(T.getTime() + 61_000), maxOr21: 2 })
    expect(r).toMatchObject({ przyjete: 2, ponowienie: 1 })
    expect(await przebieg(new Date(T.getTime() + 120_000))).toMatchObject({ przyjete: 1 })
  })

  it('zamówienie anulowane w Kompletorze czeka na decyzję; pozycja bez stanu (DIGITAL) przyjęta bez rezerwacji', async () => {
    await konto({ mode: 'PRACA' })
    const e = await db.product.create({ data: { sku: 'EBOOK', kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book testowy', title: 'E-book testowy', priceGross: '10.00', vatRate: '5' } })
    await db.channelOffer.create({ data: { ...SCOPE, externalId: 'PE', productId: e.id } })
    at.putOrder({ id: 'E-31', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-31-1', sku: 'PE', qty: 1 }] })
    at.putOrder({ id: 'E-32', state: 'WAITING_ACCEPTANCE', lines: [{ id: 'E-32-1', sku: 'PA', qty: 1 }] })
    await odczyt()
    await db.order.update({ where: { id: await orderOf('E-32') }, data: { status: 'ANULOWANE' } })
    expect(await przebieg()).toMatchObject({ przyjete: 1, doDecyzji: 1 })
    expect(at.stateOf('E-31')).toBe('WAITING_DEBIT')
    expect(at.stateOf('E-32')).toBe('WAITING_ACCEPTANCE')
    expect((await zdarzenia(EV_DO_DECYZJI))[0]!.data).toMatchObject({ powod: expect.stringContaining('anulowane w Kompletorze') })
  })
})
