// lista zamówień przez klienta firmy (RLS). Dane wyłącznie testowe (zmyślone produkty, klienci,
// zamówienia).
//  1. jedno pole szukania: numer, e-mail (skrót), telefon (skrót), NIP (skrót), SKU, numer przesyłki, nazwisko
//     (fragment tylko z „także w danych klientów”); bez uprawnienia tylko zamówienia; eksport
//     i „na wszystkich stronach” liczą ten sam zbiór; `kb` spoza słownika, cudzy token, 9 cyfr;
//  2. termin wysyłki i widok „Po terminie” wg harmonogramu odbiorów, licznik w menu = widok;
//  3. liczniki menu z jednego groupBy równe dotychczasowym (grupy, przewoźnicy, statusy firmy);
//  4. alerty: liczniki, „Ignoruj” per osoba i firma, ponowne pokazanie po zmianie liczby.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { MemberRole } from '@prisma/client'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { zapieczetujFraze } from '@/lib/klienci/fraza-token'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { daneAlertow, ukryteAlertyZ, wybierzAlerty, zIgnorowanym } from '@/lib/panel/alerty-listy'
import { stanZamowienia } from '@/lib/panel/stan-zamowienia'
import { zlozLicznikiStatusow, zlozPrzewoznikowStatusow } from '@/lib/panel/statusy-firmy-dane'
import { filtryZSzukaniem } from '@/lib/panel/szukaj-lista'
import { terminWysylki } from '@/lib/panel/termin-wysylki'
import { daneTerminow } from '@/lib/panel/termin-wysylki-dane'
import { filtryZ, idPasujacych, licznikiPanelu, SORT_DOMYSLNY, stronaListy, zlozLiczniki } from '@/lib/panel/zamowienia-lista'
import { fromWarsaw } from '@/lib/rdzen/kalendarz'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
const ENV = { CUSTOMER_DATA_KEYS: `1:${'4'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'c'.repeat(64) }

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

async function osoba(email: string, role: MemberRole): Promise<string> {
  const u = await createUserWithHash(sys, { email, name: email, passwordHash: 'x' })
  await grantMembership(sys, { email, organizationId: ORG_A, role })
  return u.id
}

async function zamowienie(db: typeof a, pid: string, over: { externalId?: string; createdAtChannel?: Date } = {}): Promise<string> {
  return (await ingestOrder(db, order([{ productId: pid, qty: 1 }], over))).orderId!
}

const klient = (imie: string, email: string, telefon: string, nip: string | null) => ({
  dostawa: { imieNazwisko: imie, firma: null, ulica: 'ul. Fikcyjna 1', numerDomu: null, numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL', telefon, email },
  punktOdbioru: null,
  faktura: nip ? { nazwa: 'Firma Testowa', nip, ulica: 'ul. Fikcyjna 1', kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL' } : null,
  problemy: [],
})

describe('jedno pole szukania (R6)', () => {
  it('numer, e-mail, telefon, NIP, SKU, numer przesyłki i nazwisko; suma z zamówieniami; bez uprawnienia tylko zamówienia', async () => {
    const przyprawa = await product(a, 'SKU-PRZYPRAWA-A160', 100)
    const kawa = await product(a, 'SKU-KAWA-A160', 100)
    const zNumer = await zamowienie(a, kawa, { externalId: 'NR-777001' })
    const zEmail = await zamowienie(a, kawa)
    const zTel = await zamowienie(a, kawa)
    const zNip = await zamowienie(a, kawa)
    const zSku = await zamowienie(a, przyprawa)
    const zPrzes = await zamowienie(a, kawa)
    const zB = await zamowienie(b, await product(b, 'SKU-PRZYPRAWA-A160', 100)) // firma B poza zasięgiem
    await zapiszRekordKlienta(a, zEmail, rekordZOdbiorcy(klient('Anna Szukana', 'anna.szukana@example.test', '+48 511 222 333', null) as never), { source: 'RECZNE', fetchedAt: T0, env: ENV })
    await zapiszRekordKlienta(a, zTel, rekordZOdbiorcy(klient('Piotr Inny', 'piotr@example.test', '600 700 800', null) as never), { source: 'RECZNE', fetchedAt: T0, env: ENV })
    await zapiszRekordKlienta(a, zNip, rekordZOdbiorcy(klient('Ewa Firmowa', 'ewa@example.test', '601 701 801', '5260001246') as never), { source: 'RECZNE', fetchedAt: T0, env: ENV })
    await sys.shipment.create({ data: { organizationId: ORG_A, orderId: zPrzes, packageNo: 1, reference: 'ref-a160-1', adapterKey: 'dpd', carrier: 'DPD', state: 'UTWORZONA', trackingNumber: '0000999888777A' } })

    const szef = await osoba('szef-a160@example.invalid', 'WLASCICIEL')
    const mag = await osoba('magazyn-a160@example.invalid', 'MAGAZYN')
    const k = (actorId: string, canKlient: boolean) => ({ db: a, actorId, organizationId: ORG_A, canKlient, env: ENV })
    const szukaj = async (fraza: string, actorId = szef, canKlient = true, klienci = false) => {
      const sp = canKlient ? { widok: 'wszystkie', qz: zapieczetujFraze(ENV, ORG_A, actorId, fraza, new Date(), { klienci }) } : { widok: 'wszystkie', q: fraza }
      const { f, szukanie } = await filtryZSzukaniem(sp, k(actorId, canKlient))
      const s = await stronaListy(a, f, { sort: SORT_DOMYSLNY, pomin: 0, ile: 50 })
      return { ids: s.wiersze.map((w) => w.id).sort(), szukanie, f }
    }
    expect((await szukaj('NR-777001')).ids).toEqual([zNumer])
    expect((await szukaj(' Anna.Szukana@Example.test ')).ids).toEqual([zEmail])
    expect((await szukaj('511222333')).ids).toEqual([zEmail]) // telefon klientki z pierwszego rekordu
    expect((await szukaj('600-700-800')).ids).toEqual([zTel])
    expect((await szukaj('PL 526-000-12-46')).ids).toEqual([zNip])
    expect((await szukaj('SKU-PRZYPRAWA')).ids).toEqual([zSku])
    expect((await szukaj('999888777')).ids).toEqual([zPrzes])
    const slady = () => sys.auditLog.count({ where: { actorId: szef, entityId: 'wyszukiwanie' } })
    // fraza z literami bez „także w danych klientów” nie odszyfrowuje klientów i nie pisze wpisu w dzienniku
    const przed = await slady()
    const produkt = await szukaj('SKU-PRZYPRAWA')
    expect(produkt.ids).toEqual([zSku])
    expect(produkt.szukanie).toMatchObject({ klientow: null, przejrzane: null, wKlientach: false })
    expect((await szukaj('szukana')).ids).toEqual([])
    expect(await slady()).toBe(przed)
    const fr = await szukaj('szukana', szef, true, true)
    expect(fr.ids).toEqual([zEmail])
    expect(fr.szukanie).toMatchObject({ fraza: 'szukana', klientow: 1, wKlientach: true })
    expect(await slady()).toBe(przed + 1)
    expect(fr.ids).not.toContain(zB)

    // bez uprawnienia do danych klientów: fraza jawnie, tylko zamówienia (e-mail niczego nie znajduje)
    expect((await szukaj('NR-777001', mag, false)).ids).toEqual([zNumer])
    expect((await szukaj('anna.szukana@example.test', mag, false)).ids).toEqual([])
    // token cudzy (inna osoba) = wygasłe wyszukiwanie, lista bez frazy
    const cudzy = await filtryZSzukaniem({ widok: 'wszystkie', qz: zapieczetujFraze(ENV, ORG_A, mag, 'NR-777001') }, k(szef, true))
    expect(cudzy.szukanie.komunikat).toMatch(/wygasło/)
    expect(cudzy.f.q).toBeUndefined()

    // „na wszystkich stronach” i eksport liczą ten sam zbiór co ekran
    const { f } = await szukaj('600 700 800')
    expect((await idPasujacych(a, f, 100)).ids).toEqual([zTel])
    // ślad wyszukiwania bez frazy
    const wpisy = await sys.auditLog.findMany({ where: { actorId: szef, entityId: 'wyszukiwanie' } })
    expect(wpisy.length).toBeGreaterThan(0)
    expect(JSON.stringify(wpisy.map((s) => s.after))).not.toMatch(/szukan|example|526/i)
  })

  it('kb spoza słownika nie wywraca listy, cudzy token bez uprawnienia z komunikatem, 9 cyfr najpierw jako numer', async () => {
    const szef = await osoba('szef2-a160@example.invalid', 'WLASCICIEL')
    const mag = await osoba('magazyn2-a160@example.invalid', 'MAGAZYN')
    const k = (actorId: string, canKlient: boolean) => ({ db: a, actorId, organizationId: ORG_A, canKlient, env: ENV })
    for (const kb of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const r = await filtryZSzukaniem({ widok: 'wszystkie', kb }, k(szef, true))
      expect(r.szukanie.komunikat).toBeNull()
    }
    expect((await filtryZSzukaniem({ kb: 'krotka' }, k(szef, true))).szukanie.komunikat).toMatch(/3 litery/)

    // osoba bez dostępu do danych klientów z cudzym albo starym tokenem dostaje komunikat, lista bez frazy
    const obcy = await filtryZSzukaniem({ widok: 'wszystkie', qz: zapieczetujFraze(ENV, ORG_A, szef, 'Kowalska') }, k(mag, false))
    expect(obcy.szukanie.komunikat).toMatch(/innej osoby/)
    expect(obcy.f.q).toBeUndefined()

    // 9 cyfr pasujące do numeru zamówienia nie szukają telefonu (bez wpisu w dzienniku)
    const kawa = await product(a, 'SKU-KAWA-D6', 100)
    const zNumer = await zamowienie(a, kawa, { externalId: 'A512345678' })
    const zKlient = await zamowienie(a, kawa)
    await zapiszRekordKlienta(a, zKlient, rekordZOdbiorcy(klient('Jan Telefoniczny', 'jan.d6@example.test', '512 345 678', null) as never), { source: 'RECZNE', fetchedAt: T0, env: ENV })
    const ids = async (fraza: string) => {
      const { f } = await filtryZSzukaniem({ widok: 'wszystkie', qz: zapieczetujFraze(ENV, ORG_A, szef, fraza) }, k(szef, true))
      return (await stronaListy(a, f, { sort: SORT_DOMYSLNY, pomin: 0, ile: 50 })).wiersze.map((w) => w.id)
    }
    const slady = () => sys.auditLog.count({ where: { actorId: szef, entityId: 'wyszukiwanie' } })
    const przed = await slady()
    expect(await ids('512345678')).toEqual([zNumer])
    expect(await slady()).toBe(przed)
    // ten sam numer w zapisie telefonicznym szuka klienta
    expect(await ids('+48 512 345 678')).toEqual([zKlient])
    expect(await slady()).toBe(przed + 1)
  })
})

describe('termin wysyłki i „Po terminie” (R9)', () => {
  it('termin w wierszu, widok i licznik menu wg godzin odbioru; nieopłacone i wysłane bez terminu', async () => {
    // T0 = czwartek 15.10 10:00 Warszawa; DPD pn–pt, „wyślemy dziś do” 12:00, odbiór 13:00
    // konta w pracy (w podglądzie termin liczy się ze statusu BL: tests/karta-zdjecia-termin)
    await a.channelConfig.updateMany({ data: { statusMode: 'PRACA' } })
    await a.carrierPickup.create({ data: { carrier: 'DPD', weekdays: [1, 2, 3, 4, 5], pickupMinute: 13 * 60, promiseUntilMinute: 12 * 60, active: true } })
    const p = await product(a, 'PRZYPRAWA', 1000)
    const stare = await zamowienie(a, p, { createdAtChannel: fromWarsaw('2026-10-13', 9 * 3_600_000) })
    const dzis = await zamowienie(a, p, { createdAtChannel: fromWarsaw('2026-10-15', 9 * 3_600_000) })
    const jutro = await zamowienie(a, p, { createdAtChannel: fromWarsaw('2026-10-15', 12 * 3_600_000 + 60_000) })
    const nieopl = await zamowienie(a, p, { createdAtChannel: fromWarsaw('2026-10-12', 9 * 3_600_000) })
    const wyslane = await zamowienie(a, p, { createdAtChannel: fromWarsaw('2026-10-12', 9 * 3_600_000) })
    const inny = await zamowienie(a, p, { createdAtChannel: fromWarsaw('2026-10-12', 9 * 3_600_000) })
    await sys.order.updateMany({ where: { id: { in: [stare, dzis, jutro, nieopl, wyslane] } }, data: { carrier: 'DPD', status: 'DO_REALIZACJI', paymentState: 'PAID' } })
    await sys.order.update({ where: { id: nieopl }, data: { status: 'NOWE', paymentState: 'UNPAID' } })
    await sys.order.update({ where: { id: wyslane }, data: { status: 'WYSLANE' } })
    await sys.order.update({ where: { id: inny }, data: { carrier: 'PACZKOMATY', status: 'DO_REALIZACJI', paymentState: 'PAID' } }) // bez harmonogramu

    const now = fromWarsaw('2026-10-15', 10 * 3_600_000)
    const t = await daneTerminow(a, now)
    const wiersze = (await stronaListy(a, filtryZ({ widok: 'wszystkie' }), { sort: SORT_DOMYSLNY, pomin: 0, ile: 50 })).wiersze
    const termin = (id: string) => terminWysylki(wiersze.find((w) => w.id === id)!, t.harmonogramy, t.przyjazdy, now)?.rodzaj ?? null
    expect([stare, dzis, jutro, nieopl, wyslane, inny].map(termin)).toEqual(['po_terminie', 'dzis', 'jutro', null, null, null])

    // widok i licznik (z bieżącą chwilą testu: wszystkie zamówienia z października są dawno po terminie)
    const widok = await stronaListy(a, filtryZ({ widok: 'po_terminie' }), { sort: SORT_DOMYSLNY, pomin: 0, ile: 50 })
    expect(widok.wiersze.map((w) => w.id).sort()).toEqual([stare, dzis, jutro].sort())
    expect((await licznikiPanelu(a)).poTerminie).toBe(3)
    // firma bez harmonogramu: bez pozycji „Po terminie”
    expect((await licznikiPanelu(b)).poTerminie).toBeUndefined()
  })
})

describe('liczniki menu z jednego zapytania', () => {
  it('grupy, przewoźnicy i statusy firmy jak z dwóch dawnych zapytań', async () => {
    const p = await product(a, 'PRZYPRAWA', 1000)
    const ids: string[] = []
    for (let i = 0; i < 8; i++) ids.push(await zamowienie(a, p))
    const plan = [
      ['DO_REALIZACJI', 'DPD', null],
      ['DO_REALIZACJI', 'DPD', 'DR_DPD'],
      ['DO_REALIZACJI', 'PACZKOMATY', null],
      ['DO_REALIZACJI', null, null],
      ['ZEBRANE', 'DPD', null],
      ['WYSLANE', 'DPD', null],
      ['WYSLANE', 'DPD', 'WYSL'],
      ['DO_WYJASNIENIA', 'BRAK', null],
    ] as const
    for (const [i, [status, carrier, companyStatus]] of plan.entries()) await sys.order.update({ where: { id: ids[i] }, data: { status, carrier, companyStatus } })
    const l = await licznikiPanelu(a)
    // to samo co dawny groupBy(status, carrier)
    const stare = await a.order.groupBy({ by: ['status', 'carrier'], _count: { _all: true } })
    const oczekiwane = zlozLiczniki(
      stare.map((r) => ({ status: r.status, carrier: r.carrier, n: r._count._all })),
      l.grupy.wymaga,
    )
    expect(l.grupy).toEqual(oczekiwane.grupy)
    expect(l.przewoznicy).toEqual(oczekiwane.przewoznicy)
    expect(l.grupy).toMatchObject({ do_realizacji: 4, zebrane: 1, wyslane: 2, problemowe: 1, wszystkie: 8 })
    expect(l.przewoznicy.do_realizacji).toEqual({ DPD: 2, PACZKOMATY: 1, BRAK: 1 })
    // statusy firmy: ten sam wynik co osobny groupBy(status, carrier, companyStatus), jak
    const w = (await a.order.groupBy({ by: ['status', 'carrier', 'companyStatus'], _count: { _all: true } })).map((r) => ({ status: r.status, carrier: r.carrier, companyStatus: r.companyStatus, n: r._count._all }))
    const defs = l.firmy?.statusy ?? []
    expect(l.firmy?.ile ?? {}).toEqual(Object.fromEntries(zlozLicznikiStatusow(defs, w)))
    expect(l.firmy?.przewoznicy ?? {}).toEqual(Object.fromEntries(zlozPrzewoznikowStatusow(defs, w)))
  })
})

describe('kolumna „Stan” i alerty (R8, R9)', () => {
  it('ikony z danych wiersza; alerty liczą braki, przesyłki bez ruchu i „Ignoruj” per osoba', async () => {
    const p = await product(a, 'PRZYPRAWA', 1000)
    const z = await zamowienie(a, p)
    const zw = await zamowienie(a, p)
    await sys.order.update({ where: { id: z }, data: { status: 'WYSLANE', carrier: 'DPD', paymentState: 'PAID' } })
    await sys.shipment.create({ data: { organizationId: ORG_A, orderId: z, packageNo: 1, reference: 'ref-a160-2', adapterKey: 'dpd', carrier: 'DPD', state: 'UTWORZONA', trackingNumber: 'X1', createdAt: new Date(Date.now() - 9 * 86_400_000) } })
    await sys.order.update({ where: { id: zw }, data: { status: 'WYSLANE', paymentState: 'PAID' } })
    await sys.return.create({ data: { organizationId: ORG_A, orderId: zw, status: 'ZGLOSZONY' } })
    const w = (await stronaListy(a, filtryZ({ widok: 'wszystkie' }), { sort: SORT_DOMYSLNY, pomin: 0, ile: 50 })).wiersze
    const s = (id: string, program = 'brak') => stanZamowienia(w.find((x) => x.id === id)!, program).map((i) => i.ton)
    expect(s(z)).toEqual(['sukces', 'sukces', 'neutralny', 'neutralny'])
    expect(s(zw)[3]).toBe('ostrzezenie')

    const d = await daneAlertow(a)
    expect(d).toMatchObject({ bezRuchu: 1, poTerminie: undefined })
    expect((await stronaListy(a, filtryZ({ widok: 'bez_ruchu' }), { sort: SORT_DOMYSLNY, pomin: 0, ile: 50 })).wiersze.map((x) => x.id)).toEqual([z])
    const alerty = wybierzAlerty(d, {})
    expect(alerty.map((x) => x.rodzaj)).toContain('bez_ruchu')
    // „Ignoruj” na koncie osoby, w tej firmie
    const u = await osoba('biuro-a160@example.invalid', 'BIURO')
    const json = zIgnorowanym(null, ORG_A, 'bez_ruchu', String(d.bezRuchu))
    await sys.user.update({ where: { id: u }, data: { ukryteAlerty: json! } })
    const zapis = (await sys.user.findUniqueOrThrow({ where: { id: u } })).ukryteAlerty
    expect(wybierzAlerty(d, ukryteAlertyZ(zapis, ORG_A)).map((x) => x.rodzaj)).not.toContain('bez_ruchu')
    expect(wybierzAlerty(d, ukryteAlertyZ(zapis, ORG_B)).map((x) => x.rodzaj)).toContain('bez_ruchu')
    expect(wybierzAlerty({ ...d, bezRuchu: 2 }, ukryteAlertyZ(zapis, ORG_A)).map((x) => x.rodzaj)).toContain('bez_ruchu')
  })
})
