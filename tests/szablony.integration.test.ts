// szablony przepływów na bazie. Firma demo bez BaseLinkera i bez wFirmy (magazyn prowadzony przez Kompletor,
// konto sklepu w trybie pracy, domyślne reguły przewoźników) wybiera szablon i prowadzi zamówienie od przyjęcia do końca
// na funkcjach rdzenia; przesyłka i status u kuriera to wpisy dziennika jak z atrapy przewoźnika (bez prawdziwego
// przewoźnika). „Wczytaj szablon” w firmie z własnymi regułami i statusami niczego nie nadpisuje. Kreator: preset nowej
// firmy z szablonem zakłada statusy i włączone reguły.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { DEFAULT_CHANNEL_ADAPTER } from '@/lib/adaptery'
import { zapiszRegule } from '@/lib/automaty/dane'
import { planujAkcje } from '@/lib/akcje/silnik'
import { kliknijPrzycisk, przetworzCzas, przetworzZdarzenia, przyciskiZamowienia } from '@/lib/automaty/silnik'
import { podgladSzablonu, szablonPrzeplywu, wczytajSzablon } from '@/lib/automaty/szablony'
import { applyOrgPreset, presetNowejFirmy } from '@/lib/organizacje'
import { etykietaStatusuFirmy } from '@/lib/panel/statusy'
import { statusyFirmy } from '@/lib/panel/statusy-firmy-dane'
import { addBusinessDays } from '@/lib/rdzen/kalendarz'
import { DEFAULT_CARRIER_RULES } from '@/lib/rdzen/przewoznicy'
import { moveOrder } from '@/lib/rdzen/przejscia'
import { packOrder } from '@/lib/rdzen/rozchod'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, ORG_B, TEST_ORGS, testDb, testSystemDb, truncateAll } from './db'
import { order, product } from './rdzen-fixtures'

const db = testDb()
afterAll(async () => {
  await db.$disconnect()
})

const ENV = { EKRANY_PRACA: '1' }
const USER = 'u-test'
// firma neutralna: domyślne reguły przewoźników (bez reguł ACME z TEST_ORGS) i domyślne statusy
const ORGS = TEST_ORGS.map((o) => ({ ...o, carrierRules: DEFAULT_CARRIER_RULES }))

async function seed(c: PrismaClient) {
  await c.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Magazyn', stockSource: 'KOMPLETOR' } })
  await c.channelConfig.createMany({
    data: [
      { channel: 'WOO', channelAccountId: 'sd', name: 'Sklep demo', adapterKey: DEFAULT_CHANNEL_ADAPTER.WOO, statusMode: 'PRACA' },
      { channel: 'ALLEGRO', channelAccountId: 'allegro', name: 'Allegro demo', adapterKey: DEFAULT_CHANNEL_ADAPTER.ALLEGRO, statusMode: 'PRACA' },
    ],
  })
  await c.organization.updateMany({ data: { settings: { faktury: { program: 'brak' } } } })
}

beforeEach(async () => {
  await truncateAll(undefined, ORGS)
  await seed(db)
})

const przebieg = async () => {
  const w = await przetworzZdarzenia(db, { env: ENV, opoznienieMs: 0 })
  expect(w.bledy).toEqual([])
  return w
}

async function zam(over: Parameters<typeof order>[1] = {}, cyfrowy = false) {
  const sku = `P-${Math.random().toString(36).slice(2, 8)}`
  const p = cyfrowy
    ? (await db.product.create({ data: { sku, kind: 'DIGITAL', unit: 'SZT', nameAccounting: `Usługa ${sku}`, title: `Usługa ${sku}`, priceGross: '10.00', vatRate: '23' } })).id
    : await product(db, sku, 10)
  return (await ingestOrder(db, order([{ productId: p, qty: 1 }], over))).orderId!
}

/** Status firmy widoczny na liście zamówień (nazwa) i etap rdzenia. */
async function widac(id: string) {
  const o = await db.order.findUniqueOrThrow({ where: { id }, select: { status: true, carrier: true, companyStatus: true } })
  return { etap: o.status, nazwa: etykietaStatusuFirmy((await statusyFirmy(db)).statusy, o).nazwa }
}

/** Atrapa przewoźnika: wpisy dziennika, które piszą nadanie i śledzenie (lib/wysylka/nadanie.ts, wyslane-po-przyjezdzie.ts). */
const przesylkaUtworzona = (orderId: string) => db.orderEvent.create({ data: { orderId, kind: 'PRZESYLKA_UTWORZONA', actorId: 'system:atrapa-przewoznika', data: { przesylka: 'atrapa-1', przewoznik: 'PACZKOMATY', nadanie: '600000000000000000000000' } } })
const kurierOdebral = (orderId: string) => db.orderEvent.create({ data: { orderId, kind: 'PRZESYLKA_STATUS', actorId: 'system:sledzenie-przesylki', data: { przesylka: 'atrapa-1', status: 'taken_by_courier', stan: 'PRZEKAZANA' } } })


describe('szablony przepływów: zamówienie od przyjęcia do końca', () => {
  it('Kurier i paczkomaty: opłacone → zbieranie → spakowane → do wysłania → wysłane; brak płatności: mail po 2 dniach, anulowanie po 5', async () => {
    const podglad = await podgladSzablonu(db, 'kurier-i-paczkomaty')
    expect(podglad.tryb).toBe('PELNY')
    const w = await wczytajSzablon(db, 'kurier-i-paczkomaty', USER)
    expect(w).toMatchObject({ tryb: 'PELNY', reguly: szablonPrzeplywu('kurier-i-paczkomaty')!.automationRules.length, pominiete: 0 })
    expect(await db.automationRule.count({ where: { enabled: true } })).toBe(w.reguly)

    const id = await zam({ deliveryMethod: 'Paczkomaty InPost' })
    const nieoplacone = await zam({ paymentState: 'UNPAID', paymentMethod: 'przelew', deliveryMethod: 'Paczkomaty InPost' })
    await przebieg()
    expect(await widac(id)).toEqual({ etap: 'DO_REALIZACJI', nazwa: 'Do realizacji' })
    expect(await widac(nieoplacone)).toEqual({ etap: 'NOWE', nazwa: 'Nowe' })

    await moveOrder(db, id, 'ZBIERANIE')
    expect(await widac(id)).toEqual({ etap: 'ZBIERANIE', nazwa: 'Zbieranie' })
    await packOrder(db, id)
    await przebieg()
    expect(await widac(id)).toEqual({ etap: 'SPAKOWANE', nazwa: 'Spakowane' })

    await przesylkaUtworzona(id)
    await przebieg()
    expect(await widac(id)).toEqual({ etap: 'DO_WYSLANIA', nazwa: 'Do wysłania' })
    await kurierOdebral(id)
    await przebieg()
    expect(await widac(id)).toEqual({ etap: 'WYSLANE', nazwa: 'Wysłane' })

    // reguły czasowe liczą dni robocze (przypomnienie, jedno; potem anulowanie), więc „za ile” też w dniach
    // roboczych: stałe 4 i 9 dni kalendarzowych nie wystarczały w święto przed weekendem (np. 11 listopada w środę)
    const zaDniRobocze = (n: number) => addBusinessDays(new Date(), n)
    await przetworzCzas(db, { env: ENV, now: zaDniRobocze(3) })
    await przetworzCzas(db, { env: ENV, now: zaDniRobocze(3) })
    expect(await db.plannedAction.count({ where: { targetId: nieoplacone, rule: 'mail.brak-platnosci', occasion: { startsWith: 'automat:' } } })).toBe(1)
    await przetworzCzas(db, { env: ENV, now: zaDniRobocze(7) })
    expect((await widac(nieoplacone)).etap).toBe('ANULOWANE')
  })

  it('Odbiór osobisty: spakowane → do odbioru + mail „Gotowe do odbioru” → przycisk „Klient odebrał” → odebrane', async () => {
    await wczytajSzablon(db, 'odbior-osobisty', USER)
    const id = await zam({ deliveryMethod: 'Odbiór osobisty w sklepie' })
    await przebieg()
    expect(await widac(id)).toEqual({ etap: 'DO_REALIZACJI', nazwa: 'Do realizacji' })
    await packOrder(db, id)
    await przebieg()
    expect(await widac(id)).toEqual({ etap: 'DO_ODBIORU', nazwa: 'Do odbioru' })
    // mail „Gotowe do odbioru”: wbudowany plan maili wysyła go przy „Do odbioru”, krok reguły go nie dubluje
    await planujAkcje(db, {})
    await planujAkcje(db, {})
    expect(await db.plannedAction.count({ where: { targetId: id, rule: 'mail.gotowe-do-odbioru' } })).toBe(1)
    const p = await przyciskiZamowienia(db, id, 'pakowanie', { env: ENV })
    expect(p.map((x) => x.etykieta)).toEqual(['Klient odebrał'])
    expect(p[0]!.powod).toBeFalsy()
    expect((await kliknijPrzycisk(db, p[0]!.regulaId, id, 'klik-odbior-0001', 'pakowanie', { env: ENV })).blad).toBeNull()
    expect(await widac(id)).toEqual({ etap: 'ODEBRANE', nazwa: 'Odebrane' })
  })

  it('Allegro z Wysyłam z Allegro: przyciski gabarytów tylko przy Allegro, dalej jak kurier', async () => {
    await wczytajSzablon(db, 'allegro-wysylam-z-allegro', USER)
    const allegro = await zam({ channel: 'ALLEGRO' })
    const sklep = await zam({ deliveryMethod: 'Paczkomaty InPost' })
    await przebieg()
    expect(await widac(allegro)).toEqual({ etap: 'DO_REALIZACJI', nazwa: 'Do realizacji' })
    await packOrder(db, allegro)
    await przebieg()
    const p = await przyciskiZamowienia(db, allegro, 'pakowanie', { env: ENV })
    expect(p.map((x) => x.etykieta)).toEqual(['Gabaryt A', 'Gabaryt B', 'Gabaryt C'])
    // nadawanie nieskonfigurowane (demo bez kont przewoźników): przycisk widać, z powodem; nic nie idzie do przewoźnika
    expect(p.every((x) => !!x.powod)).toBe(true)
    expect(await przyciskiZamowienia(db, sklep, 'pakowanie', { env: ENV })).toEqual([])
    await przesylkaUtworzona(allegro)
    await przebieg()
    await kurierOdebral(allegro)
    await przebieg()
    expect(await widac(allegro)).toEqual({ etap: 'WYSLANE', nazwa: 'Wysłane' })
    expect(await db.shipment.count()).toBe(0)
    expect(await db.channelWrite.count()).toBe(0)
  })

  it('Minimalny bez wysyłki: nowe → opłacone → zrealizowane, etapy magazynu ukryte', async () => {
    await wczytajSzablon(db, 'bez-wysylki', USER)
    const id = await zam({ paymentState: 'UNPAID', paymentMethod: 'przelew', deliveryMethod: 'E-mail' }, true)
    await przebieg()
    expect(await widac(id)).toEqual({ etap: 'NOWE', nazwa: 'Nowe' })
    const { markPaid } = await import('@/lib/rdzen/zamowienia')
    await markPaid(db, id)
    await przebieg()
    expect(await widac(id)).toEqual({ etap: 'DO_REALIZACJI', nazwa: 'Opłacone' })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).carrier).toBe('BEZ_WYSYLKI')
    await packOrder(db, id) // „Zrealizuj” na karcie: zamówienie bez paczki od razu spakowane
    await przebieg()
    expect(await widac(id)).toEqual({ etap: 'ODEBRANE', nazwa: 'Zrealizowane' })
    const st = (await statusyFirmy(db)).statusy
    expect(st.filter((s) => s.active).map((s) => s.name)).toEqual(['Nowe', 'Opłacone', 'Zrealizowane', 'Anulowane', 'Do wyjaśnienia', 'Reklamacja'])
  })
})

describe('Wczytaj szablon w firmie z własnymi regułami', () => {
  it('nic nie nadpisuje: statusy i reguły firmy bez zmian, szablon w nowej wyłączonej grupie na statusach firmy', async () => {
    // firma zmieniła nazwę „Do wysłania” i ma własną regułę
    await db.orderStatusDef.update({ where: { organizationId_key: { organizationId: ORG_A, key: 'DO_WYSLANIA' } }, data: { name: 'Czeka na kuriera' } })
    const wlasna = await zapiszRegule(db, { enabled: true, regula: { name: 'Gwiazdka dla opłaconych', event: 'OPLACONO', conditions: [], actions: [{ typ: 'oznacz', znacznik: 'gwiazdka', wartosc: true }] } }, USER)
    const migawka = async () => ({
      statusy: JSON.stringify(await db.orderStatusDef.findMany({ orderBy: { key: 'asc' }, select: { key: true, name: true, customerName: true, color: true, groupKey: true, sortOrder: true, baseStatus: true, carriers: true, active: true } })),
      grupyStatusow: JSON.stringify(await db.orderStatusGroup.findMany({ orderBy: { key: 'asc' }, select: { key: true, name: true, sortOrder: true, collapsed: true } })),
      wlasna: JSON.stringify(await db.automationRule.findUnique({ where: { id: wlasna.id }, select: { name: true, enabled: true, event: true, conditions: true, actions: true, groupId: true, sortOrder: true } })),
    })
    const przed = await migawka()
    const plan = await podgladSzablonu(db, 'kurier-i-paczkomaty')
    expect(plan.tryb).toBe('DODANIE')
    expect(plan.dopasowania.find((d) => d.szablon === 'DO_WYSLANIA')).toMatchObject({ klucz: 'DO_WYSLANIA', nazwa: 'Czeka na kuriera', takiSam: false })
    // podgląd nic nie zapisuje
    expect(await db.automationRule.count()).toBe(1)

    const w = await wczytajSzablon(db, 'kurier-i-paczkomaty', USER)
    expect(w).toMatchObject({ tryb: 'DODANIE', statusy: 0, pominiete: 0, grupa: 'Szablon: Kurier i paczkomaty' })
    expect(await migawka()).toEqual(przed)
    const grupa = await db.automationGroup.findFirstOrThrow({ where: { name: 'Szablon: Kurier i paczkomaty' } })
    const nowe = await db.automationRule.findMany({ where: { groupId: grupa.id } })
    expect(nowe).toHaveLength(w.reguly)
    expect(nowe.every((r) => !r.enabled)).toBe(true)
    expect(await db.automationRule.count({ where: { enabled: true } })).toBe(1)
    expect(await db.auditLog.count({ where: { entity: 'AUTOMAT_SZABLON' } })).toBe(1)

    // drugi raz: kolejna grupa, stara nietknięta
    const w2 = await wczytajSzablon(db, 'kurier-i-paczkomaty', USER)
    expect(w2.grupa).toBe('Szablon: Kurier i paczkomaty (2)')
    expect(await db.automationRule.count({ where: { groupId: grupa.id } })).toBe(w.reguly)
    expect(await migawka()).toEqual(przed)
  })

  it('izolacja firm: wczytanie w firmie A nie dotyka firmy B', async () => {
    const b = testDb({ organizationId: ORG_B })
    try {
      await wczytajSzablon(db, 'odbior-osobisty', USER)
      expect(await b.automationRule.count()).toBe(0)
      expect(await b.orderStatusDef.count({ where: { key: 'DO_ODBIORU', customerName: 'Gotowe do odbioru' } })).toBe(0)
    } finally {
      await b.$disconnect()
    }
  })
})

describe('kreator: nowa firma z szablonem', () => {
  it('preset nowej firmy z szablonem: statusy szablonu i włączone reguły; drugie zastosowanie = 0 zmian', async () => {
    const sz = szablonPrzeplywu('bez-wysylki')!
    const preset = presetNowejFirmy({ slug: 'nowa-szablon', name: 'Nowa firma', szablon: sz })
    const s1 = await applyOrgPreset(testSystemDb(), preset)
    expect(s1.automationRules).toBe(sz.automationRules.length)
    const n = testDb({ organizationId: preset.id })
    try {
      expect((await n.orderStatusDef.findUniqueOrThrow({ where: { organizationId_key: { organizationId: preset.id, key: 'DO_REALIZACJI' } } })).name).toBe('Opłacone')
      expect(await n.automationRule.count({ where: { enabled: true } })).toBe(sz.automationRules.length)
      expect((await n.automationGroup.findMany({ orderBy: { sortOrder: 'asc' } })).map((g) => g.name)).toEqual(sz.automationGroups.map((g) => g.name))
      const s2 = await applyOrgPreset(testSystemDb(), preset)
      expect(s2.automationRules).toBeUndefined()
      expect(await n.automationRule.count()).toBe(sz.automationRules.length)
    } finally {
      await n.$disconnect()
    }
  })
})
