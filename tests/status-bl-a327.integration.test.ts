// status „Kompletor” w BL dla zamówień zrealizowanych w Kompletorze. Atrapa BL (bez sieci), dane fikcyjne.
// Sprawdza: wyłącznik (zero wywołań), wybór kandydatów (tryb pracy, para BL, okno, punkt cięcia), świeży odczyt przed
// zapisem, pominięcia (status BL obsłużony, paczka w BL, faktura BL), idempotencję, błędy bez pętli i alerty, izolację firm.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { OrderStatus } from '@prisma/client'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ZAMKNIETE_PRZY_PRZEJSCIU } from '@/lib/kanaly/zamkniete-przy-przejsciu'
import {
  ALERT_STATUS_BL,
  MAX_PROB,
  ODSTEP_PONOWIENIA_MS,
  parseStatusBl,
  przebiegStatusuBl,
  statusBlFirmy,
  ZDARZENIE_STATUS_BL,
  ZDARZENIE_STATUS_BL_BLAD,
  ZDARZENIE_STATUS_BL_POMINIETY,
  zapiszStatusBl,
  type KlientStatusuBl,
} from '@/lib/kanaly/status-bl'
import { SourceError } from '@/lib/zrodla/http'
import { ORG_B, testDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const KOMPLETOR = 388071
const NOWE = 100
const WYSLANE_BL = 101
const ANULOWANE_BL = 102
const DO_REALIZACJI = 103
const NOW = new Date(T0.getTime() + 3600_000)

/** Atrapa BL: zamówienia {id → status}, paczki, licznik wywołań, wstrzykiwane błędy setOrderStatus. */
class AtrapaBl implements KlientStatusuBl {
  statusy = new Map<number, number>()
  paczki = new Map<number, number>()
  wywolania: string[] = []
  bladZapisu: Error | null = null
  async call<T>(method: string, p: Record<string, unknown> = {}): Promise<T> {
    this.wywolania.push(method)
    if (method === 'getOrderStatusList')
      return { statuses: [{ id: NOWE, name: 'Nowe zamówienia' }, { id: WYSLANE_BL, name: 'Wysłane' }, { id: ANULOWANE_BL, name: 'Anulowane' }, { id: DO_REALIZACJI, name: 'Do realizacji Paczkomaty' }, { id: KOMPLETOR, name: 'Kompletor' }] } as T
    const id = Number(p['order_id'])
    if (method === 'getOrders') return { orders: this.statusy.has(id) ? [{ order_id: id, order_status_id: this.statusy.get(id) }] : [] } as T
    if (method === 'getOrderPackages') return { packages: Array.from({ length: this.paczki.get(id) ?? 0 }, (_, i) => ({ package_id: i + 1 })) } as T
    if (method === 'setOrderStatus') {
      if (this.bladZapisu) throw this.bladZapisu
      this.statusy.set(id, Number(p['status_id']))
      return { status: 'SUCCESS' } as T
    }
    throw new Error(`atrapa: nieobsługiwana metoda ${method}`)
  }
}

let blSeq = 9000
let tea = ''

/** Zamówienie wysłane w Kompletorze o `kiedy`, z parą w BL w statusie `statusBl`. */
async function wyslane(o: { status?: OrderStatus; kiedy?: Date; statusBl?: number | null; channel?: 'WOO_SD' | 'ALLEGRO'; ciecie?: boolean } = {}) {
  const id = (await ingestOrder(db, order([{ productId: tea, qty: 1 }], { channel: o.channel ?? 'WOO_SD' }), { now: T0 })).orderId!
  const blOrderId = o.statusBl === null ? null : ++blSeq
  const status = o.status ?? 'WYSLANE'
  await db.order.update({ where: { id }, data: { status, blOrderId } })
  await db.orderEvent.create({ data: { orderId: id, kind: status, actorId: 'test', createdAt: o.kiedy ?? T0 } })
  if (o.ciecie) await db.orderEvent.create({ data: { orderId: id, kind: ZAMKNIETE_PRZY_PRZEJSCIU, actorId: 'test', createdAt: T0, data: { na: status } } })
  if (blOrderId !== null) bl.statusy.set(blOrderId, o.statusBl ?? NOWE)
  return { id, blOrderId }
}

const zdarzenia = (orderId: string, kind: string) => db.orderEvent.findMany({ where: { orderId, kind }, orderBy: { createdAt: 'asc' } })
let bl: AtrapaBl

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.channelConfig.updateMany({ where: { channel: { in: ['WOO', 'ALLEGRO'] } }, data: { statusMode: 'PRACA' } })
  tea = await product(db, 'HERB-A327', 100)
  bl = new AtrapaBl()
})

describe('status w BL dla zamówień zrealizowanych w Kompletorze', () => {
  it('ustawienia: domyślnie wyłączone; włączenie wymaga numeru statusu; zapis z audytem', async () => {
    expect(await statusBlFirmy(db)).toEqual({ wlaczony: false, statusId: null })
    expect(parseStatusBl({ statusBl: { wlaczony: true } })).toEqual({ wlaczony: false, statusId: null })
    expect(parseStatusBl({ statusBl: { wlaczony: true, statusId: '388071' } })).toEqual({ wlaczony: true, statusId: KOMPLETOR })
    await expect(zapiszStatusBl(db, { wlaczony: true, statusId: 'abc' }, 'u1')).rejects.toThrow(/numer statusu/)
    expect(await zapiszStatusBl(db, { wlaczony: true, statusId: '388071' }, 'u1')).toEqual({ wlaczony: true, statusId: KOMPLETOR })
    expect(await statusBlFirmy(db)).toEqual({ wlaczony: true, statusId: KOMPLETOR })
    expect(await db.auditLog.count({ where: { entity: 'Organization.statusBl' } })).toBe(1)
    // firma B nie widzi ustawienia firmy A
    expect(await statusBlFirmy(dbB)).toEqual({ wlaczony: false, statusId: null })
  })

  it('wyłączone = zero wywołań BL', async () => {
    await wyslane()
    const r = await przebiegStatusuBl(db, bl, { now: NOW })
    expect(r.kandydaci).toBe(0)
    expect(bl.wywolania).toEqual([])
  })

  it('ustawia status, pomija nie swoje i powtórka niczego nie zmienia', async () => {
    await zapiszStatusBl(db, { wlaczony: true, statusId: KOMPLETOR }, 'u1')
    const ok = await wyslane()
    const odebrane = await wyslane({ status: 'ODEBRANE', statusBl: DO_REALIZACJI })
    const juz = await wyslane({ statusBl: KOMPLETOR })
    const ciecie = await wyslane({ ciecie: true })
    const stare = await wyslane({ kiedy: new Date(NOW.getTime() - 8 * 86_400_000) })
    const bezPary = await wyslane({ statusBl: null })
    const wBl = await wyslane({ statusBl: WYSLANE_BL })
    const anul = await wyslane({ statusBl: ANULOWANE_BL })
    const zPaczka = await wyslane()
    bl.paczki.set(zPaczka.blOrderId!, 1)
    const spakowane = await wyslane({ status: 'SPAKOWANE' })
    // konto w podglądzie (EMPIK zostaje w CIEN): nawet wysłane nie idzie
    const empikId = (await ingestOrder(db, order([{ productId: tea, qty: 1 }], { channel: 'EMPIK' }), { now: T0 })).orderId!
    await db.order.update({ where: { id: empikId }, data: { status: 'WYSLANE', blOrderId: 7777 } })
    await db.orderEvent.create({ data: { orderId: empikId, kind: 'WYSLANE', actorId: 'test', createdAt: T0 } })
    bl.statusy.set(7777, NOWE)

    const r = await przebiegStatusuBl(db, bl, { now: NOW })
    expect(r).toMatchObject({ kandydaci: 6, ustawione: 2, juzBylo: 1, pominiete: 3, bledy: 0, stop: null })
    expect(bl.statusy.get(ok.blOrderId!)).toBe(KOMPLETOR)
    expect(bl.statusy.get(odebrane.blOrderId!)).toBe(KOMPLETOR)
    for (const x of [ciecie, stare, wBl, anul, zPaczka, spakowane]) expect(bl.statusy.get(x.blOrderId!)).not.toBe(KOMPLETOR)
    expect(bl.statusy.get(7777)).toBe(NOWE)
    expect(bezPary.blOrderId).toBeNull()
    expect((await zdarzenia(juz.id, ZDARZENIE_STATUS_BL))[0]?.data).toMatchObject({ wynik: 'JUZ' })
    expect((await zdarzenia(wBl.id, ZDARZENIE_STATUS_BL_POMINIETY))[0]?.data).toMatchObject({ powod: expect.stringContaining('Wysłane') })
    expect(await db.alert.count({ where: { kind: ALERT_STATUS_BL, ref: zPaczka.id } })).toBe(1)
    expect(bl.wywolania.filter((m) => m === 'setOrderStatus')).toHaveLength(2)

    // powtórka: nic do zrobienia, zero zapisów
    const n = bl.wywolania.length
    const r2 = await przebiegStatusuBl(db, bl, { now: new Date(NOW.getTime() + 60_000) })
    expect(r2.kandydaci).toBe(0)
    expect(bl.wywolania.length).toBe(n)
  })

  it('błąd przejściowy: ślad i ponowienie po odstępie, po MAX_PROB alert i koniec; błąd trwały od razu', async () => {
    await zapiszStatusBl(db, { wlaczony: true, statusId: KOMPLETOR }, 'u1')
    const a = await wyslane()
    bl.bladZapisu = new SourceError('BL setOrderStatus: ERROR_INTERNAL', true)
    let t = NOW.getTime()
    for (let i = 1; i <= MAX_PROB; i++) {
      const r = await przebiegStatusuBl(db, bl, { now: new Date(t) })
      expect(r.bledy).toBe(1)
      // w odstępie: nie ponawia
      expect((await przebiegStatusuBl(db, bl, { now: new Date(t + 60_000) })).kandydaci).toBe(0)
      t += ODSTEP_PONOWIENIA_MS
    }
    expect(await zdarzenia(a.id, ZDARZENIE_STATUS_BL_BLAD)).toHaveLength(MAX_PROB)
    expect(await db.alert.count({ where: { kind: ALERT_STATUS_BL, ref: a.id } })).toBe(1)
    expect((await przebiegStatusuBl(db, bl, { now: new Date(t + 3600_000) })).kandydaci).toBe(0)

    const b = await wyslane()
    bl.bladZapisu = new SourceError('BL setOrderStatus: ERROR_ORDER_NOT_FOUND', false)
    const r = await przebiegStatusuBl(db, bl, { now: new Date(t + 3600_000) })
    expect(r.bledy).toBe(1)
    expect(await zdarzenia(b.id, ZDARZENIE_STATUS_BL_POMINIETY)).toHaveLength(1)
    expect(await db.alert.count({ where: { kind: ALERT_STATUS_BL, ref: b.id } })).toBe(1)
  })

  it('brak statusu w BL = alert i żadnego zapisu', async () => {
    await zapiszStatusBl(db, { wlaczony: true, statusId: 123456 }, 'u1')
    await wyslane()
    const r = await przebiegStatusuBl(db, bl, { now: NOW })
    expect(r.stop).toMatch(/123456/)
    expect(bl.wywolania).toEqual(['getOrderStatusList'])
    expect(await db.alert.count({ where: { kind: ALERT_STATUS_BL } })).toBe(1)
  })

  it('faktura z BL: pominięte, bez zapisu', async () => {
    await zapiszStatusBl(db, { wlaczony: true, statusId: KOMPLETOR }, 'u1')
    const f = await wyslane()
    await db.orderEvent.create({ data: { orderId: f.id, kind: 'FAKTURA_BL', actorId: 'test', data: { docId: 'FV/BL/1' } } })
    const r = await przebiegStatusuBl(db, bl, { now: NOW })
    expect(r).toMatchObject({ ustawione: 0, pominiete: 1 })
    expect(bl.statusy.get(f.blOrderId!)).toBe(NOWE)
  })
})
