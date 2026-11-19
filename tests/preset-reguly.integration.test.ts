// reguły automatycznych akcji z presetu firmy, na małym presecie w teście (bez pliku presetu firmy):
//  1. Zakładanie reguł presetu: idempotentnie (drugi przebieg = 0 zmian), na sucho bez zapisu, zmiany z panelu zostają.
//  2. Wyłącznik wbudowanego planu maili per firma.
//  3. Konto w podglądzie: reguły ze zdarzeń nie piszą historii zamówienia (pominięcia techniczne tylko w wyniku wykonania).
// Wszystko na atrapach: zero sieci, zero zapisów do sklepów, kurierów i programu do faktur.
import type { PrismaClient } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_CHANNEL_ADAPTER } from '@/lib/adaptery'
import { planujAkcje } from '@/lib/akcje/silnik'
import { ustawPlanWbudowany, usunGrupe, usunRegule } from '@/lib/automaty/dane'
import { opisRaportu, zastosujAutomatyPresetu, type AutomatyPresetu } from '@/lib/automaty/preset'
import { przetworzCzas, przetworzZdarzenia } from '@/lib/automaty/silnik'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { order, product } from './rdzen-fixtures'

const db = testDb({ poolMax: 40 })
afterAll(() => db.$disconnect())

const ENV = { EKRANY_PRACA: '1' }

// ─── 1. Zakładanie reguł presetu ─────────────────────────────────────────────

const MALY: AutomatyPresetu = {
  automationGroups: [
    { key: 'test-grupa', name: 'Pakowanie' },
    { key: 'test-pusta', name: 'Nieużywana' },
  ],
  automationRules: [
    { key: 'test-01', enabled: true, name: 'Opłacone → Do realizacji', event: 'OPLACONO', conditions: [{ typ: 'oplacone', wartosc: true }], actions: [{ typ: 'ustawStatus', status: 'RDZEN:DO_REALIZACJI' }] },
    { key: 'test-02', groupKey: 'test-grupa', enabled: false, description: 'Wyłączona: przycisk jest na karcie.', name: 'Przycisk', event: 'PRZYCISK', buttonLabel: 'Paczka', buttonPlaces: ['karta'], conditions: [], actions: [{ typ: 'utworzPrzesylke', gabaryt: 'A' }] },
    { key: 'test-03', enabled: true, name: 'Zły status', event: 'OPLACONO', conditions: [], actions: [{ typ: 'ustawStatus', status: 'NIE_MA_TAKIEGO' }] },
  ],
}

describe('reguły z presetu firmy: zakładanie idempotentne', () => {
  it('na sucho nic nie zapisuje; zapis zakłada brakujące; drugi przebieg = 0 zmian; zmiana i usunięcie z panelu zostają', async () => {
    await truncateAll()
    const sys = testSystemDb()
    const sucho = await zastosujAutomatyPresetu(sys, ORG_A, MALY, { sucho: true })
    expect(sucho.regulyNowe).toEqual(['test-01', 'test-02'])
    expect(sucho.bledy.map((x) => x.klucz)).toEqual(['test-03'])
    expect(await db.automationRule.count()).toBe(0)
    expect(await db.automationGroup.count()).toBe(0)
    const r1 = await zastosujAutomatyPresetu(sys, ORG_A, MALY)
    expect([r1.grupyNowe, r1.regulyNowe]).toEqual([['test-grupa'], ['test-01', 'test-02']])
    expect(opisRaportu(r1)).toMatch(/reguł nowych 2/)
    const reguly = await db.automationRule.findMany({ orderBy: { sortOrder: 'asc' }, select: { presetKey: true, enabled: true, groupId: true, name: true, description: true } })
    expect(reguly.map((x) => [x.presetKey, x.enabled, !!x.groupId, x.description])).toEqual([
      ['test-01', true, false, null],
      ['test-02', false, true, 'Wyłączona: przycisk jest na karcie.'],
    ])
    // grupa bez nowej reguły nie powstaje
    expect((await db.automationGroup.findMany({ select: { presetKey: true } })).map((g) => g.presetKey)).toEqual(['test-grupa'])
    // panel: zmiana nazwy jednej reguły, usunięcie (ukrycie) drugiej
    await db.automationRule.updateMany({ where: { presetKey: 'test-01' }, data: { name: 'Moja nazwa', enabled: false } })
    await db.automationRule.updateMany({ where: { presetKey: 'test-02' }, data: { hidden: true } })
    const przed = JSON.stringify(await db.automationRule.findMany({ orderBy: { id: 'asc' } }))
    const r2 = await zastosujAutomatyPresetu(sys, ORG_A, MALY)
    expect([r2.grupyNowe, r2.regulyNowe, r2.regulyIstniejace]).toEqual([[], [], ['test-01', 'test-02']])
    expect(JSON.stringify(await db.automationRule.findMany({ orderBy: { id: 'asc' } }))).toBe(przed)
    expect(await db.automationGroup.count()).toBe(1)
    expect(await db.auditLog.count({ where: { entity: 'AutomationRule.preset' } })).toBe(1)
  })

  it('grupa usunięta w panelu nie wraca, reguła z presetu usunięta w panelu (bez wykonań) też nie; tryb „tylko firma bez reguł” nic nie dokłada', async () => {
    await truncateAll()
    const sys = testSystemDb()
    await zastosujAutomatyPresetu(sys, ORG_A, MALY)
    const g = await db.automationGroup.findFirstOrThrow({ where: { presetKey: 'test-grupa' } })
    await usunGrupe(db, g.id, 'u-test')
    const r1 = await db.automationRule.findFirstOrThrow({ where: { presetKey: 'test-01' } })
    expect(await usunRegule(db, r1.id, 'u-test')).toBe('ukryta')
    const r2 = await zastosujAutomatyPresetu(sys, ORG_A, MALY)
    expect([r2.grupyNowe, r2.regulyNowe]).toEqual([[], []])
    expect(await db.automationGroup.count()).toBe(0)
    expect(await db.automationRule.count({ where: { hidden: false } })).toBe(1)
    // seed przy zakładaniu firmy / starcie kontenera: firma z regułami (także ukrytymi) nie dostaje nic
    const r3 = await zastosujAutomatyPresetu(sys, ORG_A, { automationRules: [{ key: 'test-04', enabled: true, name: 'Nowa', event: 'OPLACONO', conditions: [], actions: [{ typ: 'oznacz', znacznik: 'gwiazdka' }] }] }, { tylkoFirmaBezRegul: true })
    expect([r3.regulyNowe, r3.pominiety]).toEqual([[], expect.stringMatching(/ma już/)])
    expect(opisRaportu(r3)).toMatch(/pominięty/)
  })

})

// ─── 2. Wyłącznik wbudowanego planu maili ────────────────────────────────────

describe('wbudowany plan maili: wyłącznik firmy', () => {
  async function zamowienieZPrzypomnieniem(c: PrismaClient) {
    await c.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Magazyn', stockSource: 'KOMPLETOR' } })
    await c.channelConfig.create({ data: { channel: 'WOO', channelAccountId: 'sd', name: 'Sklep', adapterKey: DEFAULT_CHANNEL_ADAPTER.WOO, statusMode: 'PRACA' } })
    const pr = await product(c, `P-${Math.random().toString(36).slice(2, 8)}`, 10)
    const id = (await ingestOrder(c, order([{ productId: pr, qty: 1 }], { paymentState: 'UNPAID', paymentMethod: 'przelew' }))).orderId!
    await c.order.update({ where: { id }, data: { reminderSentAt: new Date() } })
    return id
  }

  it('włączony (domyślnie): plan wysyła „Brak płatności”, a reguła go nie dubluje; wyłączony: tylko reguła', async () => {
    await truncateAll()
    const id = await zamowienieZPrzypomnieniem(db)
    await zastosujAutomatyPresetu(testSystemDb(), ORG_A, {
      automationRules: [{ key: 'test-mail', enabled: true, name: 'Nowe 1 dzień → Brak płatności', event: 'W_STATUSIE_DNI', conditions: [{ typ: 'dniWStatusie', dni: 1, robocze: false }, { typ: 'status', wartosci: ['NOWE'] }], actions: [{ typ: 'wyslijEmail', szablon: 'brak-platnosci' }] }],
    })
    // włączony: plan planuje, reguła pomija (bez wpisu w historii zamówienia, bo to wykonanie ze zdarzenia)
    expect((await planujAkcje(db)).nowe['mail.brak-platnosci']).toBe(1)
    const za2dni = new Date(Date.now() + 2 * 86_400_000)
    await przetworzCzas(db, { env: ENV, now: za2dni })
    expect(await db.plannedAction.count({ where: { targetId: id, rule: 'mail.brak-platnosci' } })).toBe(1)
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'AUTOMAT_POMINIETY' } })).toBe(0)
    // wyłączony: plan nic nie dokłada, reguła planuje sama (plan i wykonania wyczyszczone, ten sam pobyt w statusie)
    await ustawPlanWbudowany(db, false, 'u-test')
    expect(await db.auditLog.count({ where: { entity: 'Organization.akcje.planWbudowany' } })).toBe(1)
    await ustawPlanWbudowany(db, false, 'u-test')
    expect(await db.auditLog.count({ where: { entity: 'Organization.akcje.planWbudowany' } })).toBe(1)
    await db.plannedAction.deleteMany({})
    await db.automationRun.deleteMany({})
    const w = await planujAkcje(db)
    expect([w.nowe['mail.brak-platnosci'], w.nowe['mail.faktura'], w.nowe['mail.gotowe-do-odbioru'], w.nowe['mail.blad-faktury']]).toEqual([0, 0, 0, 0])
    await przetworzCzas(db, { env: ENV, now: za2dni })
    const plany = await db.plannedAction.findMany({ where: { targetId: id }, select: { rule: true, occasion: true, mode: true } })
    expect(plany.map((x) => [x.rule, x.occasion.startsWith('automat:'), x.mode])).toEqual([['mail.brak-platnosci', true, 'PRACA']])
  })
})

// ─── 3. Konto w podglądzie: reguły ze zdarzeń bez śladu w historii ───────────

describe('konto sklepu w podglądzie: historia zamówienia bez zmian', () => {
  it('reguła ustawiająca status ze zdarzenia: krok pominięty w wyniku wykonania, historia zamówienia i status bez zmian', async () => {
    await truncateAll()
    await db.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Magazyn', stockSource: 'KOMPLETOR' } })
    await db.channelConfig.create({ data: { channel: 'WOO', channelAccountId: 'sd', name: 'Sklep', adapterKey: DEFAULT_CHANNEL_ADAPTER.WOO, statusMode: 'CIEN' } })
    await zastosujAutomatyPresetu(testSystemDb(), ORG_A, {
      automationRules: [{ key: 'test-cien', enabled: true, name: 'Opłacone → Do wyjaśnienia', event: 'OPLACONO', conditions: [], actions: [{ typ: 'ustawStatus', status: 'RDZEN:DO_WYJASNIENIA' }] }],
    })
    const pr = await product(db, 'P-CIEN', 10)
    const id = (await ingestOrder(db, order([{ productId: pr, qty: 1 }]))).orderId!
    const przed = await db.order.findUniqueOrThrow({ where: { id }, select: { status: true, companyStatus: true } })
    const zdarzen = await db.orderEvent.count({ where: { orderId: id } })
    const w = await przetworzZdarzenia(db, { env: ENV, opoznienieMs: 0 })
    expect(w.wykonan).toBe(1)
    const run = await db.automationRun.findFirstOrThrow({ where: { orderId: id } })
    expect(run.result).toBe('POMINIETA')
    expect(JSON.stringify(run.steps)).toMatch(/trybie pracy/)
    expect(await db.orderEvent.count({ where: { orderId: id } })).toBe(zdarzen)
    expect(await db.order.findUniqueOrThrow({ where: { id }, select: { status: true, companyStatus: true } })).toEqual(przed)
  })
})
