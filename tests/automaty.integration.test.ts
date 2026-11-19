// automatyczne akcje na bazie. Firma bez BaseLinkera i bez wFirmy (magazyn prowadzony przez Kompletor,
// konta w trybie pracy) buduje własny przepływ: 2 grupy, reguła „opłacono + przesyłka zawiera »odbiór« → »Do odbioru
// w sklepie«”, reguła czasowa „3 dni robocze w »Nowe« → e-mail”, przycisk „Paczka mała”. Bezpieczniki: przejście
// niedozwolone = krok pominięty z wpisem w historii, pętla dwóch reguł zatrzymana po limicie z alertem, to samo
// zdarzenie dwa razy = jedno wykonanie, podgląd na sucho bez żadnego zapisu, firma bez reguł = nic.
// Bez prawdziwych kanałów, przewoźników i programu do faktur (nadawanie nieskonfigurowane = przycisk z powodem).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { DOMYSLNE_GRUPY_STATUSOW, DOMYSLNE_STATUSY } from '@/lib/panel/statusy'
import { historiaZamowienia } from '@/lib/karta/historia'
import { ingestOrder, markPaid } from '@/lib/rdzen/zamowienia'
import { planujAkcje } from '@/lib/akcje/silnik'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { DEFAULT_CHANNEL_ADAPTER } from '@/lib/adaptery'
import { ekranAutomatow, usunRegule, zapiszGrupe, zapiszRegule, AutomatyError } from '@/lib/automaty/dane'
import { kliknijPrzycisk, podgladNaSucho, przetworzCzas, przetworzZdarzenia, przyciskiZamowienia, wykonajDlaZdarzenia, regulyWKolejnosci } from '@/lib/automaty/silnik'
import { statusyFirmy } from '@/lib/panel/statusy-firmy-dane'
import { LIMIT_LANCUCHA } from '@/lib/automaty/schemat'
import { ORG_A, ORG_B, TEST_ORGS, testDb, truncateAll } from './db'
import { order, product } from './rdzen-fixtures'

const db = testDb()
const b = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await b.$disconnect()
})

const ENV = { EKRANY_PRACA: '1' }
const USER = 'u-test'
const STATUSY = [
  ...DOMYSLNE_STATUSY,
  { key: 'DO_ODBIORU_W_SKLEPIE', name: 'Do odbioru w sklepie', customerName: null, color: 'zielony', groupKey: 'W_REALIZACJI', sortOrder: 25, baseStatus: 'DO_REALIZACJI' as const, carriers: [], active: true },
  { key: 'X1', name: 'Pętla 1', customerName: null, color: 'szary', groupKey: null, sortOrder: 26, baseStatus: 'DO_REALIZACJI' as const, carriers: [], active: true },
  { key: 'X2', name: 'Pętla 2', customerName: null, color: 'szary', groupKey: null, sortOrder: 27, baseStatus: 'DO_REALIZACJI' as const, carriers: [], active: true },
]
const ORGS = TEST_ORGS.map((o) => (o.id === ORG_A ? { ...o, statuses: STATUSY, statusGroups: [...DOMYSLNE_GRUPY_STATUSOW] } : o))

async function seed(c: PrismaClient) {
  // magazyn prowadzony przez Kompletor (bez wFirmy), sklep bez BaseLinkera, konto w trybie pracy
  await c.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Magazyn', stockSource: 'KOMPLETOR' } })
  await c.channelConfig.create({ data: { channel: 'WOO', channelAccountId: 'sd', name: 'Sklep demo', adapterKey: DEFAULT_CHANNEL_ADAPTER.WOO, statusMode: 'PRACA' } })
}

beforeEach(async () => {
  await truncateAll(undefined, ORGS)
  await seed(db)
  await seed(b)
})

async function zam(over: Parameters<typeof order>[1] = {}) {
  const p = await product(db, `P-${Math.random().toString(36).slice(2, 8)}`, 10)
  const r = await ingestOrder(db, order([{ productId: p, qty: 1 }], over))
  return r.orderId!
}

const przebieg = () => przetworzZdarzenia(db, { env: ENV, opoznienieMs: 0 })
const licz = async (c: PrismaClient) => ({
  zamowienia: await c.order.count(),
  zdarzenia: await c.orderEvent.count(),
  wykonania: await c.automationRun.count(),
  plany: await c.plannedAction.count(),
  przesylki: await c.shipment.count(),
  zapisy: await c.channelWrite.count(),
  alerty: await c.alert.count(),
  dziennik: await c.auditLog.count(),
  statusy: JSON.stringify(await c.order.findMany({ select: { id: true, status: true, companyStatus: true, flags: true }, orderBy: { id: 'asc' } })),
})

describe('firma bez BL i wFirmy buduje własny przepływ', () => {
  it('2 grupy, reguła opłacenia, reguła czasowa, przycisk; idempotencja i historia na karcie', async () => {
    const g1 = await zapiszGrupe(db, { name: 'Przyjęcie zamówień' }, USER)
    const g2 = await zapiszGrupe(db, { name: 'Przyciski' }, USER)
    const r1 = await zapiszRegule(db, { groupId: g1, enabled: true, regula: { name: 'Odbiór w sklepie', event: 'OPLACONO', conditions: [{ typ: 'przesylka', frazy: ['odbiór'] }], actions: [{ typ: 'ustawStatus', status: 'DO_ODBIORU_W_SKLEPIE' }] } }, USER)
    await zapiszRegule(db, { groupId: g1, enabled: true, regula: { name: 'Przypomnienie o płatności', event: 'W_STATUSIE_DNI', conditions: [{ typ: 'dniWStatusie', dni: 3, robocze: true }, { typ: 'status', wartosci: ['NOWE'] }], actions: [{ typ: 'wyslijEmail', szablon: 'brak-platnosci' }] } }, USER)
    const r3 = await zapiszRegule(db, { groupId: g2, enabled: true, regula: { name: 'Paczka mała', event: 'PRZYCISK', buttonLabel: 'Paczka mała', buttonPlaces: ['karta', 'pakowanie'], conditions: [], actions: [{ typ: 'utworzPrzesylke', gabaryt: 'A' }] } }, USER)

    const ekran = await ekranAutomatow(db)
    expect(ekran.grupy.map((g) => g.name)).toEqual(['Przyjęcie zamówień', 'Przyciski'])
    expect(ekran.reguly.map((r) => r.name)).toEqual(['Odbiór w sklepie', 'Przypomnienie o płatności', 'Paczka mała'])
    expect(ekran.reguly[0]!.pigulki).toEqual([{ etykieta: 'Przesyłka zawiera frazę', wartosc: 'odbiór', nie: false }])
    expect(ekran.reguly[0]!.kroki).toEqual([{ czasownik: 'Ustaw', co: 'Status', wartosc: 'Do odbioru w sklepie' }])

    // opłacone, odbiór osobisty → „Do odbioru w sklepie”; kurier → nic
    const odbior = await zam({ deliveryMethod: 'Odbiór osobisty w sklepie' })
    const kurier = await zam({ deliveryMethod: 'Kurier DPD' })
    const nieoplacone = await zam({ paymentState: 'UNPAID', paymentMethod: 'przelew' })
    const w = await przebieg()
    expect(w.bledy).toEqual([])
    expect((await db.order.findUnique({ where: { id: odbior } }))?.companyStatus).toBe('DO_ODBIORU_W_SKLEPIE')
    expect((await db.order.findUnique({ where: { id: kurier } }))?.companyStatus).toBeNull()
    expect(await db.automationRun.count({ where: { ruleId: r1.id } })).toBe(1)
    const hist = (await historiaZamowienia(db, odbior)).map((h) => h.opis)
    expect(hist).toContain('Reguła „Odbiór w sklepie” ustawiła status „Do odbioru w sklepie”')

    // to samo zdarzenie drugi raz (powtórny przebieg z zakładką kursora) = bez nowego wykonania
    await przebieg()
    await przebieg()
    expect(await db.automationRun.count({ where: { ruleId: r1.id } })).toBe(1)

    // reguła czasowa: 3 dni robocze w „Nowe” → plan maila „Brak płatności” (konto w pracy = czeka na pocztę firmy)
    // 10 dni: 3 dni robocze mieszczą się także przy weekendzie ze świętem obok (10.11.2026: 5 dni nie wystarczało przez 11.11)
    const za10dni = new Date(Date.now() + 10 * 86_400_000 + 3600_000)
    await przetworzCzas(db, { env: ENV, now: new Date() })
    expect(await db.plannedAction.count({ where: { targetId: nieoplacone, occasion: { startsWith: 'automat:' } } })).toBe(0)
    await przetworzCzas(db, { env: ENV, now: za10dni })
    await przetworzCzas(db, { env: ENV, now: za10dni })
    const plany = await db.plannedAction.findMany({ where: { targetId: nieoplacone, occasion: { startsWith: 'automat:' } } })
    expect(plany).toHaveLength(1)
    expect(plany[0]).toMatchObject({ rule: 'mail.brak-platnosci', mode: 'PRACA', state: 'PLANNED' })

    // przycisk „Paczka mała”: widoczny na karcie i stanowisku, nieaktywny z powodem (nadawanie nieskonfigurowane)
    const przyciski = await przyciskiZamowienia(db, kurier, 'pakowanie', { env: ENV })
    expect(przyciski).toHaveLength(1)
    expect(przyciski[0]).toMatchObject({ regulaId: r3.id, etykieta: 'Paczka mała' })
    expect(przyciski[0]!.powod).toBeTruthy()
    const klik = await kliknijPrzycisk(db, r3.id, kurier, 'klik-0000000001', 'pakowanie', { env: ENV })
    expect(klik.blad).toBe(przyciski[0]!.powod)
    expect(await db.shipment.count()).toBe(0)
    // podwójne kliknięcie tym samym kluczem = jedno wykonanie
    await kliknijPrzycisk(db, r3.id, kurier, 'klik-0000000001', 'pakowanie', { env: ENV })
    expect(await db.automationRun.count({ where: { ruleId: r3.id } })).toBe(1)
  })

  it('przejście niedozwolone: krok pominięty, status bez zmian, wpis w historii', async () => {
    const r = await zapiszRegule(db, { enabled: true, regula: { name: 'Od razu wysłane', event: 'PRZYCISK', buttonPlaces: ['karta'], conditions: [], actions: [{ typ: 'ustawStatus', status: 'WYSLANE' }] } }, USER)
    const id = await zam()
    const przed = await db.order.findUnique({ where: { id }, select: { status: true, companyStatus: true } })
    expect(przed?.status).toBe('DO_REALIZACJI')
    const k = await kliknijPrzycisk(db, r.id, id, 'klik-niedozwolone1', 'karta', { env: ENV })
    expect(k.blad).toMatch(/przejście niedozwolone/)
    expect(await db.order.findUnique({ where: { id }, select: { status: true, companyStatus: true } })).toEqual(przed)
    expect((await historiaZamowienia(db, id)).map((h) => h.opis).some((o) => o.startsWith('Reguła „Od razu wysłane” pominięta: przejście niedozwolone'))).toBe(true)
    expect((await db.automationRun.findFirst({ where: { ruleId: r.id } }))?.result).toBe('POMINIETA')
  })

  it('edytor nie zapisze kroku, którego z warunku statusu nigdy nie da się wykonać', async () => {
    await expect(zapiszRegule(db, { regula: { name: 'Zła', event: 'USTAWIONO_STATUS', conditions: [{ typ: 'status', wartosci: ['WYSLANE'] }], actions: [{ typ: 'ustawStatus', status: 'NOWE' }] } }, USER)).rejects.toBeInstanceOf(AutomatyError)
  })

  it('pętla dwóch reguł: stop łańcucha po limicie, alert dla biura', async () => {
    const start = await zapiszRegule(db, { enabled: true, regula: { name: 'Start', event: 'PRZYCISK', buttonPlaces: ['karta'], conditions: [], actions: [{ typ: 'ustawStatus', status: 'X1' }] } }, USER)
    await zapiszRegule(db, { enabled: true, regula: { name: 'Tam', event: 'USTAWIONO_STATUS', conditions: [{ typ: 'status', wartosci: ['X1'] }], actions: [{ typ: 'ustawStatus', status: 'X2' }] } }, USER)
    const s = await zapiszRegule(db, { enabled: true, regula: { name: 'Z powrotem', event: 'USTAWIONO_STATUS', conditions: [{ typ: 'status', wartosci: ['X2'] }], actions: [{ typ: 'ustawStatus', status: 'X1' }] } }, USER)
    // różne warunki statusu = rozłączne, bez ostrzeżenia o konflikcie
    expect(s.ostrzezenia).toEqual([])
    const id = await zam()
    await przebieg()
    expect((await kliknijPrzycisk(db, start.id, id, 'klik-petla-000001', 'karta', { env: ENV })).blad).toBeNull()
    const w = await przebieg()
    expect(w.bledy).toEqual([])
    expect(w.przerwanych).toBe(1)
    const zmiany = await db.orderEvent.count({ where: { orderId: id, kind: 'AUTOMAT' } })
    expect(zmiany).toBe(LIMIT_LANCUCHA)
    expect(await db.alert.count({ where: { kind: 'AUTOMAT_PETLA', ref: id } })).toBe(1)
    expect(await db.automationRun.count({ where: { orderId: id, result: 'PRZERWANY_LANCUCH' } })).toBe(1)
    // następne przebiegi nie wznawiają pętli
    await przebieg()
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'AUTOMAT' } })).toBe(zmiany)
  })

  it('to samo zdarzenie dwa razy (dwa przebiegi naraz) = jedno wykonanie', async () => {
    const r = await zapiszRegule(db, { enabled: true, regula: { name: 'Gwiazdka', event: 'OPLACONO', conditions: [], actions: [{ typ: 'oznacz', znacznik: 'gwiazdka', wartosc: true }] } }, USER)
    const id = await zam()
    const reguly = await regulyWKolejnosci(db, { enabled: true })
    const statusy = (await statusyFirmy(db)).statusy
    const z = { orderId: id, zdarzenie: 'OPLACONO' as const, okazja: 'ev:test:OPLACONO', lancuch: 0 }
    await Promise.all([wykonajDlaZdarzenia(db, z, reguly, statusy, { env: ENV }), wykonajDlaZdarzenia(db, z, reguly, statusy, { env: ENV })])
    expect(await db.automationRun.count({ where: { ruleId: r.id } })).toBe(1)
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'AUTOMAT' } })).toBe(1)
    expect((await db.order.findUnique({ where: { id } }))?.flags).toMatchObject({ gwiazdka: true })
  })

  it('ostrzeżenie o konflikcie przy zapisie i na liście', async () => {
    await zapiszRegule(db, { enabled: true, regula: { name: 'A', event: 'OPLACONO', conditions: [{ typ: 'zrodlo', wartosci: ['WOO'] }], actions: [{ typ: 'ustawStatus', status: 'X1' }] } }, USER)
    const b2 = await zapiszRegule(db, { enabled: true, regula: { name: 'B', event: 'OPLACONO', conditions: [{ typ: 'pobranie', wartosc: false }], actions: [{ typ: 'ustawStatus', status: 'X2' }] } }, USER)
    expect(b2.ostrzezenia.map((o) => o.rodzaj)).toEqual(['KONFLIKT'])
    const e = await ekranAutomatow(db)
    expect(e.reguly.find((r) => r.name === 'A')!.ostrzezenia[0]!.komunikat).toContain('zostanie status z „B”')
  })

  it('podgląd na sucho na 7 dniach: liczby bez żadnego zapisu', async () => {
    for (let i = 0; i < 3; i++) await zam({ deliveryMethod: 'Odbiór osobisty w sklepie' })
    await zam({ deliveryMethod: 'Kurier DPD' })
    const regula = { name: 'Odbiór', event: 'OPLACONO' as const, conditions: [{ typ: 'przesylka' as const, frazy: ['odbiór'] }], actions: [{ typ: 'ustawStatus' as const, status: 'DO_ODBIORU_W_SKLEPIE' }, { typ: 'utworzPrzesylke' as const }] }
    const przed = await licz(db)
    const p = await podgladNaSucho(db, regula, { env: ENV })
    expect(await licz(db)).toEqual(przed)
    expect(p.zamowien).toBe(3)
    expect(p.kroki.ustawStatus).toBe(3)
    expect(p.pominiete).toBe(3) // nadawanie nieskonfigurowane
    expect(p.zdanie).toMatch(/^Przez ostatnie 7 dni reguła zadziałałaby na 3 zamówieniach: zmieniłaby status 3 zamówień\. 3 kroki zostałyby pominięte/)
  })

  it('firma bez reguł: przebieg nic nie czyta i nic nie zapisuje poza kursorem; izolacja firm', async () => {
    await zapiszRegule(b, { enabled: true, regula: { name: 'Gwiazdka B', event: 'OPLACONO', conditions: [], actions: [{ typ: 'oznacz', znacznik: 'gwiazdka', wartosc: true }] } }, USER)
    await zam()
    const przed = await licz(db)
    const w = await przebieg()
    expect(w).toEqual({ zdarzen: 0, wykonan: 0, przerwanych: 0, bledy: [] })
    expect(await licz(db)).toEqual(przed)
    expect(await db.automationCursor.count()).toBe(1)
    expect(await db.automationRule.count()).toBe(0) // reguła firmy B niewidoczna w A
  })

  it('usunięcie reguły z historią wykonań = wyłączona i ukryta, historia zostaje', async () => {
    const r = await zapiszRegule(db, { enabled: true, regula: { name: 'Gwiazdka', event: 'OPLACONO', conditions: [], actions: [{ typ: 'oznacz', znacznik: 'gwiazdka', wartosc: true }] } }, USER)
    const id = await zam()
    await przebieg()
    expect(await usunRegule(db, r.id, USER)).toBe('ukryta')
    expect((await ekranAutomatow(db)).reguly).toEqual([])
    expect((await historiaZamowienia(db, id)).some((h) => h.opis === 'Reguła „Gwiazdka”: gwiazdka ustawiona')).toBe(true)
    const r2 = await zapiszRegule(db, { regula: { name: 'Nowa', event: 'ANULOWANO', conditions: [], actions: [{ typ: 'anulujFakture' }] } }, USER)
    expect(await usunRegule(db, r2.id, USER)).toBe('usunieta')
  })
})

// Poprawki po przeglądzie.
describe('bezpieczniki po', () => {
  const wCieniu = (c: PrismaClient) => c.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'CIEN' } })
  const pominiecia = (id: string) => db.orderEvent.findMany({ where: { orderId: id, kind: 'AUTOMAT_POMINIETY' }, select: { data: true } })

  it('konto w cieniu — anulowanie i sama zmiana nazwy statusu pominięte z powodem, zamówienie bez zmian', async () => {
    const anul = await zapiszRegule(db, { enabled: true, regula: { name: 'Anuluj', event: 'PRZYCISK', buttonPlaces: ['karta'], conditions: [], actions: [{ typ: 'anulujZamowienie' }] } }, USER)
    const nazwa = await zapiszRegule(db, { enabled: true, regula: { name: 'Nazwa', event: 'PRZYCISK', buttonPlaces: ['karta'], conditions: [], actions: [{ typ: 'ustawStatus', status: 'X1' }] } }, USER)
    const id = await zam()
    await wCieniu(db)
    const przed = await db.order.findUnique({ where: { id }, select: { status: true, companyStatus: true } })
    const k1 = await kliknijPrzycisk(db, anul.id, id, 'klik-cien-anul-01', 'karta', { env: ENV })
    expect(k1.blad).toMatch(/trybie pracy/)
    expect(k1.kroki).toEqual([expect.objectContaining({ krok: 'anulujZamowienie', wynik: 'POMINIETY' })])
    const k2 = await kliknijPrzycisk(db, nazwa.id, id, 'klik-cien-nazwa1', 'karta', { env: ENV })
    expect(k2.blad).toMatch(/trybie pracy/)
    expect(await db.order.findUnique({ where: { id }, select: { status: true, companyStatus: true } })).toEqual(przed)
    expect((await pominiecia(id)).length).toBe(2)
    expect(await db.orderEvent.count({ where: { orderId: id, kind: { in: ['ANULOWANE', 'AUTOMAT'] } } })).toBe(0)
  })

  it('firma B — anulowanie przez „ustaw status” w trybie pracy działa, w cieniu nie', async () => {
    const r = await zapiszRegule(b, { enabled: true, regula: { name: 'Anuluj B', event: 'PRZYCISK', buttonPlaces: ['karta'], conditions: [], actions: [{ typ: 'anulujZamowienie' }] } }, USER)
    const p = await product(b, `PB-${Math.random().toString(36).slice(2, 8)}`, 10)
    const praca = (await ingestOrder(b, order([{ productId: p, qty: 1 }]))).orderId!
    const cien = (await ingestOrder(b, order([{ productId: p, qty: 1 }]))).orderId!
    expect((await kliknijPrzycisk(b, r.id, praca, 'klik-b-praca-0001', 'karta', { env: ENV })).blad).toBeNull()
    expect((await b.order.findUnique({ where: { id: praca } }))?.status).toBe('ANULOWANE')
    await wCieniu(b)
    expect((await kliknijPrzycisk(b, r.id, cien, 'klik-b-cien-00001', 'karta', { env: ENV })).blad).toMatch(/trybie pracy/)
    expect((await b.order.findUnique({ where: { id: cien } }))?.status).toBe('DO_REALIZACJI')
  })

  it('reguła czasowa „Brak płatności” po przypomnieniu z wbudowanego planu = jeden mail', async () => {
    await zapiszRegule(db, { enabled: true, regula: { name: 'Przypomnienie', event: 'W_STATUSIE_DNI', conditions: [{ typ: 'dniWStatusie', dni: 3, robocze: true }, { typ: 'status', wartosci: ['NOWE'] }], actions: [{ typ: 'wyslijEmail', szablon: 'brak-platnosci' }] } }, USER)
    const id = await zam({ paymentState: 'UNPAID', paymentMethod: 'przelew' })
    const teraz = new Date()
    await db.order.update({ where: { id }, data: { reminderSentAt: teraz } })
    await planujAkcje(db, { now: teraz })
    const za10dni = new Date(teraz.getTime() + 10 * 86_400_000 + 3600_000) // 10 dni: weekend i święto obok (jak wyżej)
    const w = await przetworzCzas(db, { env: ENV, now: za10dni })
    expect(w.bledy).toEqual([])
    expect(w.wykonan).toBe(1)
    const run = await db.automationRun.findFirst({ where: { orderId: id } })
    expect(run?.result).toBe('POMINIETA')
    expect(JSON.stringify(run?.steps)).toContain('wbudowany plan maili')
    expect(await db.plannedAction.count({ where: { targetId: id, rule: 'mail.brak-platnosci' } })).toBe(1)
    expect(await db.plannedAction.count({ where: { targetId: id, occasion: { startsWith: 'automat:' } } })).toBe(0)
  })

  it('„Gotowe do odbioru” z już zaplanowanym mailem wbudowanego planu = krok pominięty', async () => {
    const r = await zapiszRegule(db, { enabled: true, regula: { name: 'Do odbioru', event: 'PRZYCISK', buttonPlaces: ['karta'], conditions: [], actions: [{ typ: 'wyslijEmail', szablon: 'gotowe-do-odbioru' }] } }, USER)
    const id = await zam()
    await db.plannedAction.create({ data: { rule: 'mail.gotowe-do-odbioru', targetType: 'ZAMOWIENIE', targetId: id, occasion: 'DO_ODBIORU', mode: 'PRACA', state: 'DONE', reason: 'test', vars: {}, dueAt: new Date() } })
    const k = await kliknijPrzycisk(db, r.id, id, 'klik-odbior-00001', 'karta', { env: ENV })
    expect(k.blad).toMatch(/wbudowany plan maili/)
    expect(await db.plannedAction.count({ where: { targetId: id } })).toBe(1)
  })

  // przegląd poprawek: lustro — reguła wysyła PRZED wbudowanym planem, plan nie dokłada drugiego maila
  it('reguła „Brak płatności” po 1 dniu, potem przypomnienie rdzenia = wbudowany plan nie dokłada maila', async () => {
    await zapiszRegule(db, { enabled: true, regula: { name: 'Szybkie przypomnienie', event: 'W_STATUSIE_DNI', conditions: [{ typ: 'dniWStatusie', dni: 1, robocze: false }, { typ: 'status', wartosci: ['NOWE'] }], actions: [{ typ: 'wyslijEmail', szablon: 'brak-platnosci' }] } }, USER)
    const id = await zam({ paymentState: 'UNPAID', paymentMethod: 'przelew' })
    const jutro = new Date(Date.now() + 86_400_000 + 3600_000)
    const w = await przetworzCzas(db, { env: ENV, now: jutro })
    expect(w.bledy).toEqual([])
    expect(await db.plannedAction.count({ where: { targetId: id, rule: 'mail.brak-platnosci', occasion: { startsWith: 'automat:' } } })).toBe(1)
    // dzień później rdzeń ustawia przypomnienie, wbudowany plan widzi wiersz reguły
    const pojutrze = new Date(jutro.getTime() + 86_400_000)
    await db.order.update({ where: { id }, data: { reminderSentAt: pojutrze } })
    const p = await planujAkcje(db, { now: pojutrze })
    expect(p.nowe['mail.brak-platnosci']).toBe(0)
    await planujAkcje(db, { now: pojutrze })
    expect(await db.plannedAction.count({ where: { targetId: id, rule: 'mail.brak-platnosci' } })).toBe(1)
  })

  it('„Gotowe do odbioru” z reguły przed statusem Do odbioru = wbudowany plan nie dokłada maila', async () => {
    const r = await zapiszRegule(db, { enabled: true, regula: { name: 'Gotowe', event: 'PRZYCISK', buttonPlaces: ['karta'], conditions: [], actions: [{ typ: 'wyslijEmail', szablon: 'gotowe-do-odbioru' }] } }, USER)
    const id = await zam()
    expect((await kliknijPrzycisk(db, r.id, id, 'klik-gotowe-0001', 'karta', { env: ENV })).blad).toBeNull()
    expect(await db.plannedAction.count({ where: { targetId: id, occasion: { startsWith: 'automat:' } } })).toBe(1)
    await db.order.update({ where: { id }, data: { status: 'DO_ODBIORU' } })
    const p = await planujAkcje(db)
    expect(p.nowe['mail.gotowe-do-odbioru']).toBe(0)
    expect(await db.plannedAction.count({ where: { targetId: id, rule: 'mail.gotowe-do-odbioru' } })).toBe(1)
  })

  it('„Faktura” z reguły przed wysyłką = bez drugiego maila tej faktury; druga faktura zamówienia dostaje mail', async () => {
    const r = await zapiszRegule(db, { enabled: true, regula: { name: 'Faktura od razu', event: 'PRZYCISK', buttonPlaces: ['karta'], conditions: [], actions: [{ typ: 'wyslijEmail', szablon: 'faktura' }] } }, USER)
    const id = await zam()
    await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED', wfirmaDocId: 'FV-1' } })
    expect((await kliknijPrzycisk(db, r.id, id, 'klik-faktura-001', 'karta', { env: ENV })).blad).toBeNull()
    const zReguly = await db.plannedAction.findMany({ where: { targetId: id, occasion: { startsWith: 'automat:' } } })
    expect(zReguly).toHaveLength(1)
    expect(zReguly[0]!.vars).toMatchObject({ wfirmaDocId: 'FV-1' })
    await db.order.update({ where: { id }, data: { status: 'WYSLANE' } })
    expect((await planujAkcje(db)).nowe['mail.faktura']).toBe(0)
    expect(await db.plannedAction.count({ where: { targetId: id, rule: 'mail.faktura' } })).toBe(1)
    // druga faktura tego zamówienia (inna paczka): wbudowany plan wysyła ją normalnie
    await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 2, attemptNo: 1, idExternal: `${id}/2/1`, state: 'ISSUED', wfirmaDocId: 'FV-2' } })
    expect((await planujAkcje(db)).nowe['mail.faktura']).toBe(1)
    const plany = await db.plannedAction.findMany({ where: { targetId: id, rule: 'mail.faktura' }, select: { occasion: true } })
    expect(plany.map((x) => x.occasion).filter((o) => !o.startsWith('automat:'))).toEqual(['FV:FV-2'])
  })

  it('firma bez reguł — wbudowany plan bez zmian (przypomnienie, gotowe do odbioru, faktura)', async () => {
    const p = await product(b, `PB-${Math.random().toString(36).slice(2, 8)}`, 10)
    const nieoplacone = (await ingestOrder(b, order([{ productId: p, qty: 1 }], { paymentState: 'UNPAID', paymentMethod: 'przelew' }))).orderId!
    const odbior = (await ingestOrder(b, order([{ productId: p, qty: 1 }]))).orderId!
    const wyslane = (await ingestOrder(b, order([{ productId: p, qty: 1 }]))).orderId!
    const teraz = new Date()
    await b.order.update({ where: { id: nieoplacone }, data: { reminderSentAt: teraz } })
    await b.order.update({ where: { id: odbior }, data: { status: 'DO_ODBIORU' } })
    await b.invoiceAttempt.create({ data: { orderId: wyslane, packageNo: 1, attemptNo: 1, idExternal: `${wyslane}/1/1`, state: 'ISSUED', wfirmaDocId: 'FV-B' } })
    await b.order.update({ where: { id: wyslane }, data: { status: 'WYSLANE' } })
    const w = await planujAkcje(b, { now: new Date(Date.now() + 1000) })
    expect(w.nowe).toMatchObject({ 'mail.brak-platnosci': 1, 'mail.gotowe-do-odbioru': 1, 'mail.faktura': 1 })
    expect(await b.plannedAction.count({ where: { occasion: { startsWith: 'automat:' } } })).toBe(0)
  })

  it('trwająca transakcja zatrzymuje kursor na swoim początku; po zatwierdzeniu reguła działa', async () => {
    const r = await zapiszRegule(db, { enabled: true, regula: { name: 'Zebrane', event: 'ZEBRANO', conditions: [], actions: [{ typ: 'oznacz', znacznik: 'gwiazdka', wartosc: true }] } }, USER)
    const a = await zam()
    const z = await zam()
    await przebieg() // kursor za przyjęciami
    const druga = testDb()
    let zwolnij!: () => void
    let wpisano!: () => void
    const czekaj = new Promise<void>((res) => (zwolnij = res))
    const gotowe = new Promise<void>((res) => (wpisano = res))
    const tx = druga.$transaction(
      async (t) => {
        await t.orderEvent.create({ data: { orderId: a, kind: 'ZEBRANE', actorId: 'test:dluga', data: {} } })
        wpisano()
        await czekaj
      },
      { timeout: 20_000 },
    )
    try {
      await gotowe
      await new Promise((res) => setTimeout(res, 50))
      await db.orderEvent.create({ data: { orderId: z, kind: 'ZEBRANE', actorId: 'test:krotka', data: {} } }) // zatwierdzona, później niż start transakcji
      const w1 = await przebieg()
      expect(w1.bledy).toEqual([])
      // bez horyzontu z bazy kursor przeszedłby za wpis „z” i wpis „a” (z wcześniejszą chwilą) przepadłby
      expect(await db.automationRun.count({ where: { ruleId: r.id } })).toBe(0)
    } finally {
      zwolnij()
      await tx
      await druga.$disconnect()
    }
    const w2 = await przebieg()
    expect(w2.bledy).toEqual([])
    expect(await db.automationRun.count({ where: { ruleId: r.id } })).toBe(2)
    for (const id of [a, z]) expect((await db.order.findUnique({ where: { id } }))?.flags).toMatchObject({ gwiazdka: true })
  })

  it('płatność po przyjęciu, przed przebiegiem = „opłacono” raz; opłacone przy przyjęciu też raz; podgląd bez dubla', async () => {
    const r = await zapiszRegule(db, { enabled: true, regula: { name: 'Opłacone', event: 'OPLACONO', conditions: [], actions: [{ typ: 'oznacz', znacznik: 'gwiazdka', wartosc: true }] } }, USER)
    const pozniej = await zam({ paymentState: 'UNPAID', paymentMethod: 'przelew' })
    await markPaid(db, pozniej, 'PAID')
    const odRazu = await zam()
    const regula = (await regulyWKolejnosci(db, { id: r.id }))[0]!
    const p = await podgladNaSucho(db, regula, { env: ENV })
    expect(p.zamowien).toBe(2)
    expect(p.kroki.oznacz).toBe(2)
    await przebieg()
    await przebieg()
    expect(await db.automationRun.count({ where: { ruleId: r.id, orderId: pozniej } })).toBe(1)
    expect(await db.automationRun.count({ where: { ruleId: r.id, orderId: odRazu } })).toBe(1)
    expect((await db.automationRun.findFirst({ where: { ruleId: r.id, orderId: pozniej } }))?.occasion).toBe(`oplacono:${pozniej}`)
  })

  it('wykonanie zawieszone w trakcie > 10 min = PRZERWANA i jeden alert', async () => {
    const r = await zapiszRegule(db, { enabled: true, regula: { name: 'Zawieszona', event: 'PRZYCISK', buttonPlaces: ['karta'], conditions: [], actions: [{ typ: 'wyslijEmail', szablon: 'faktura' }, { typ: 'oznacz', znacznik: 'gwiazdka', wartosc: true }] } }, USER)
    const id = await zam()
    const teraz = new Date()
    await db.automationRun.create({ data: { ruleId: r.id, orderId: id, occasion: 'przycisk:stary', event: 'PRZYCISK', result: 'W_TOKU', createdAt: new Date(teraz.getTime() - 11 * 60_000) } })
    await db.automationRun.create({ data: { ruleId: r.id, orderId: id, occasion: 'przycisk:swiezy', event: 'PRZYCISK', result: 'W_TOKU', createdAt: new Date(teraz.getTime() - 60_000) } })
    const w = await przetworzCzas(db, { env: ENV, now: teraz })
    expect(w.przerwanych).toBe(1)
    expect((await db.automationRun.findFirst({ where: { occasion: 'przycisk:stary' } }))?.result).toBe('PRZERWANA')
    expect((await db.automationRun.findFirst({ where: { occasion: 'przycisk:swiezy' } }))?.result).toBe('W_TOKU')
    const al = await db.alert.findMany({ where: { kind: 'AUTOMAT_PRZERWANY', ref: id } })
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toContain('„Faktura”')
    await przetworzCzas(db, { env: ENV, now: teraz })
    expect(await db.alert.count({ where: { kind: 'AUTOMAT_PRZERWANY' } })).toBe(1)
  })

  it('przycisk z karty nie działa ze stanowiska', async () => {
    const r = await zapiszRegule(db, { enabled: true, regula: { name: 'Tylko karta', event: 'PRZYCISK', buttonPlaces: ['karta'], conditions: [], actions: [{ typ: 'oznacz', znacznik: 'gwiazdka', wartosc: true }] } }, USER)
    const id = await zam()
    expect((await kliknijPrzycisk(db, r.id, id, 'klik-stanowisko01', 'pakowanie', { env: ENV })).blad).toMatch(/tu nie ma/)
    expect(await db.automationRun.count()).toBe(0)
    expect((await kliknijPrzycisk(db, r.id, id, 'klik-karta-000001', 'karta', { env: ENV })).blad).toBeNull()
  })

  it('firma bez reguł zapisuje kursor najwyżej raz na 5 min', async () => {
    await przebieg()
    const k1 = await db.automationCursor.findFirst()
    await przebieg()
    const k2 = await db.automationCursor.findFirst()
    expect(k2?.updatedAt.getTime()).toBe(k1?.updatedAt.getTime())
  })
})
