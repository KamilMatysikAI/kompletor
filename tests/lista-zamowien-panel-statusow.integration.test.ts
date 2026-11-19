// lista zamówień v2 przez klienta firmy (RLS). Dane wyłącznie testowe (zmyślone produkty i zamówienia).
//  1. panel statusów: liczniki grupa × przewoźnik, firma B nie wlicza się do firmy A;
//  2. filtry (status, przewoźnik „bez przewoźnika” z null, zakres dat, faktura, kraj, numer nadania), sortowanie, strony;
//  3. akcje masowe: zmiana statusu z powodem per zamówienie (jedno złe nie zatrzymuje reszty), w tle z postępem
//     i wznowieniem po przerwie, cudza akcja niewidoczna; dwa workery na jednej akcji bez dubli wyników; błąd przy
//     ostatniej próbie zadania i akcja bez ruchu > 1 h kończą się stanem BLAD; stare raporty usuwane;
//  4. klient: kraj dostawy jawnie przy zapisie, wyszukiwanie fragmentem nazwiska (z uprawnieniem, ślad bez frazy);
//  5. wydajność: 2 000 zamówień, strona i liczniki w czasie interaktywnym.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { MemberRole } from '@prisma/client'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { krajeKlientow } from '@/lib/klienci/kraje'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zamowieniaKlientaFragmentem } from '@/lib/klienci/szukaj-fragment'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { filtryZ, idPasujacych, licznikiPanelu, SORT_DOMYSLNY, stronaListy } from '@/lib/panel/zamowienia-lista'
import { STATUS_RECZNIE } from '@/lib/praca/status-dowolny'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ostatnieAkcje, sprzatajAkcje, stanAkcji, wykonajOdRazu, wykonajWTle, zlecWTle } from '@/lib/zamowienia/masowo'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()

beforeEach(async () => {
  process.env.EKRANY_PRACA = '1'
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

async function osoba(email: string, role: MemberRole, permissions: string[] = []): Promise<string> {
  const u = await createUserWithHash(sys, { email, name: email, passwordHash: 'x' })
  await grantMembership(sys, { email, organizationId: ORG_A, role, permissions })
  return u.id
}

async function zamowienie(db: typeof a, pid: string, over: { externalId?: string; createdAtChannel?: Date; totalGross?: number } = {}): Promise<string> {
  return (await ingestOrder(db, order([{ productId: pid, qty: 1 }], over))).orderId!
}

describe('panel statusów i filtry', () => {
  it('liczniki per przewoźnik, filtry, sortowanie i strony', async () => {
    const p = await product(a, 'PRZYPRAWA', 1000)
    const pb = await product(b, 'KAWA', 1000)
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push(await zamowienie(a, p, { createdAtChannel: new Date(T0.getTime() + i * 86_400_000), totalGross: 10 + i * 10 }))
    await zamowienie(b, pb)
    // stan ustawiony wprost (test listy, nie rdzenia)
    await sys.order.update({ where: { id: ids[0] }, data: { status: 'DO_REALIZACJI', carrier: 'DPD' } })
    await sys.order.update({ where: { id: ids[1] }, data: { status: 'DO_REALIZACJI', carrier: 'PACZKOMATY' } })
    await sys.order.update({ where: { id: ids[2] }, data: { status: 'DO_REALIZACJI', carrier: null } })
    await sys.order.update({ where: { id: ids[3] }, data: { status: 'ZEBRANE', carrier: 'DPD', wantInvoiceNip: true } })
    await sys.order.update({ where: { id: ids[4] }, data: { status: 'WYSLANE', carrier: 'DPD' } })
    await sys.order.update({ where: { id: ids[5] }, data: { status: 'DO_WYJASNIENIA', carrier: 'BRAK' } })
    await sys.shipment.create({ data: { organizationId: ORG_A, orderId: ids[4]!, packageNo: 1, reference: 'ref-a126-1', adapterKey: 'dpd', carrier: 'DPD', state: 'UTWORZONA', trackingNumber: '0000123456789X' } })
    await sys.orderCustomer.updateMany({ where: { orderId: ids[3] }, data: { country: 'DE' } })
    const k = await a.orderCustomer.count()
    if (k === 0) {
      // seedBase nie zapisuje klientów: rekord z samym krajem (szyfrogram pusty, test filtra)
      await sys.orderCustomer.create({ data: { organizationId: ORG_A, orderId: ids[3]!, keyVersion: 1, ciphertext: Buffer.alloc(1), iv: Buffer.alloc(12), authTag: Buffer.alloc(16), source: 'RECZNE', fetchedAt: T0, country: 'DE' } })
    }

    const l = await licznikiPanelu(a)
    expect(l.grupy).toMatchObject({ do_realizacji: 3, zebrane: 1, wyslane: 1, problemowe: 1, wszystkie: 6 })
    expect(l.przewoznicy.do_realizacji).toEqual({ DPD: 1, PACZKOMATY: 1, BRAK: 1 })

    const strona = (sp: Record<string, string>, ile = 50, pomin = 0, sort = SORT_DOMYSLNY) => stronaListy(a, filtryZ(sp), { sort, pomin, ile })
    expect((await strona({ widok: 'do_realizacji', przewoznik: 'BRAK' })).wiersze.map((w) => w.id)).toEqual([ids[2]])
    expect((await strona({ widok: 'problemowe', przewoznik: 'BRAK' })).wiersze.map((w) => w.id)).toEqual([ids[5]])
    expect((await strona({ widok: 'wszystkie', status: 'ZEBRANE' })).razem).toBe(1)
    expect((await strona({ widok: 'wszystkie', faktura: 'chce_bez' })).wiersze.map((w) => w.id)).toEqual([ids[3]])
    expect((await strona({ widok: 'wszystkie', kraj: 'DE' })).wiersze.map((w) => [w.id, w.country])).toEqual([[ids[3], 'DE']])
    const zNadaniem = await strona({ widok: 'wszystkie', q: '123456789' })
    expect(zNadaniem.wiersze.map((w) => [w.id, w.shipment?.trackingNumber])).toEqual([[ids[4], '0000123456789X']])
    // zakres dat w czasie polskim: dzień T0+1 i T0+2
    const d1 = new Date(T0.getTime() + 86_400_000).toISOString().slice(0, 10)
    const d2 = new Date(T0.getTime() + 2 * 86_400_000).toISOString().slice(0, 10)
    expect((await strona({ widok: 'wszystkie', od: d1, do: d2 })).wiersze.map((w) => w.id).sort()).toEqual([ids[1], ids[2]].sort())
    // sortowanie po kwocie rosnąco, strona 2 po 2
    const s = await strona({ widok: 'wszystkie' }, 2, 2, { klucz: 'kwota', kierunek: 'rosnaco' })
    expect(s.wiersze.map((w) => w.totalGross)).toEqual([30, 40])
    expect(s.razem).toBe(6)
    // „na wszystkich stronach”: te same zamówienia co filtr, firma B poza zasięgiem
    expect((await idPasujacych(a, filtryZ({ widok: 'wszystkie' }), 100)).ids).toHaveLength(6)
  })

  it('wydajność: 2 000 zamówień — strona 50 i liczniki panelu', async () => {
    const p = await product(a, 'PRZYPRAWA', 100_000)
    const proto = await zamowienie(a, p)
    const wzor = await sys.order.findUniqueOrThrow({ where: { id: proto } })
    const statusy = ['NOWE', 'DO_REALIZACJI', 'ZEBRANE', 'SPAKOWANE', 'WYSLANE'] as const
    const przew = ['DPD', 'PACZKOMATY', 'ALLEGRO', null] as const
    await sys.order.createMany({
      data: Array.from({ length: 2000 }, (_, i) => ({
        organizationId: ORG_A,
        channel: wzor.channel,
        channelAccountId: wzor.channelAccountId,
        externalId: `PERF-${i}`,
        status: statusy[i % statusy.length],
        carrier: przew[i % przew.length],
        paymentState: 'PAID' as const,
        paymentMethod: 'BLIK',
        totalGross: (i % 300) + 0.99,
        createdAtChannel: new Date(T0.getTime() - i * 3_600_000),
      })),
    })
    await sys.$executeRawUnsafe('ANALYZE "Order"')
    const t0 = Date.now()
    const [l, s] = await Promise.all([licznikiPanelu(a), stronaListy(a, filtryZ({ widok: 'wszystkie', q: 'PERF-19' }), { sort: { klucz: 'kwota', kierunek: 'malejaco' }, pomin: 0, ile: 50 })])
    const s2 = await stronaListy(a, filtryZ({ widok: 'do_realizacji', przewoznik: 'DPD' }), { sort: SORT_DOMYSLNY, pomin: 50, ile: 50 })
    const ms = Date.now() - t0
    expect(l.grupy.wszystkie).toBe(2001)
    expect(s.razem).toBeGreaterThan(0)
    expect(s2.wiersze).toHaveLength(50)
    // lokalnie ok. 100–300 ms; próg z zapasem na obciążoną maszynę testową
    expect(ms).toBeLessThan(3000)
  })
})

describe('akcje masowe', () => {
  it('zmiana statusu: per zamówienie, z powodem w historii; zamówienie bez dozwolonego przejścia dostaje powód, reszta idzie', async () => {
    const u = await osoba('wlasciciel-a126@example.invalid', 'WLASCICIEL')
    await a.channelConfig.updateMany({ data: { statusMode: 'PRACA' } })
    const p = await product(a, 'PRZYPRAWA', 100)
    const ok1 = await zamowienie(a, p)
    const ok2 = await zamowienie(a, p)
    const zle = await zamowienie(a, p)
    await sys.order.update({ where: { id: zle }, data: { status: 'WYSLANE' } }) // z „Wysłane” nie wolno na „Anulowane”
    const prawa = new Set(['zamowienia.status_dowolny', 'zamowienia.anuluj_po_fakturze'])
    const w = await wykonajOdRazu(a, 'STATUS', { status: 'ANULOWANE', powod: 'Test akcji masowej' }, [ok1, zle, ok2, 'nieistnieje1'], { id: u, uprawnienia: prawa })
    expect(w).toMatchObject({ razem: 4, ok: 2, bledy: 2 })
    expect(w.pozycje.find((x) => x.id === zle)?.ok).toBe(false)
    expect(w.pozycje.find((x) => x.id === 'nieistnieje1')?.komunikat).toMatch(/Nie ma takiego/)
    for (const id of [ok1, ok2]) {
      expect((await a.order.findUniqueOrThrow({ where: { id } })).status).toBe('ANULOWANE')
      const e = await a.orderEvent.findFirst({ where: { orderId: id, kind: STATUS_RECZNIE } })
      expect(e?.data).toMatchObject({ na: 'ANULOWANE', powod: 'Test akcji masowej' })
    }
    // bez uprawnienia: każda pozycja z odmową, nic się nie zmienia
    const bez = await wykonajOdRazu(a, 'PRZESYLKI', {}, [zle], { id: u, uprawnienia: new Set() })
    expect(bez.pozycje[0]).toMatchObject({ ok: false, komunikat: expect.stringMatching(/uprawnienia/) })
  })

  it('w tle: postęp per zamówienie, wznowienie po przerwie bez powtórki, cudza akcja niewidoczna', async () => {
    const u = await osoba('wlasciciel2-a126@example.invalid', 'WLASCICIEL')
    const inna = await osoba('biuro-a126@example.invalid', 'BIURO')
    await a.channelConfig.updateMany({ data: { statusMode: 'PRACA' } })
    const p = await product(a, 'PRZYPRAWA', 1000)
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(await zamowienie(a, p))
    const id = await zlecWTle(a, 'STATUS', { status: 'ANULOWANE', powod: 'Akcja w tle' }, ids, u)
    expect(await a.job.count({ where: { kind: 'zamowienia-masowo' } })).toBe(1)
    // przerwa po dwóch zamówieniach: wynik pierwszych dwóch już zapisany
    await a.orderBulkAction.update({ where: { id }, data: { state: 'TRWA', results: ids.slice(0, 2).map((x) => ({ id: x, nr: x, ok: true, komunikat: 'Status zmieniony.' })), done: 2, ok: 2 } })
    await wykonajWTle(a, { akcja: id })
    const s = await stanAkcji(a, id, u)
    expect(s).toMatchObject({ stan: 'GOTOWE', razem: 4, zrobione: 4, ok: 4, bledy: 0 })
    // pierwsze dwa nie były wykonywane drugi raz (zostały w statusie z przyjęcia), dwa ostatnie anulowane
    const st = await a.order.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })
    expect(st.filter((x) => x.status === 'ANULOWANE').map((x) => x.id).sort()).toEqual(ids.slice(2).sort())
    expect(await stanAkcji(a, id, inna)).toBeNull()
    expect((await ostatnieAkcje(a, u)).map((x) => x.id)).toEqual([id])
    // ponowne uruchomienie zakończonej akcji nic nie robi
    await wykonajWTle(a, { akcja: id })
    expect((await stanAkcji(a, id, u))?.zrobione).toBe(4)
    // firma B nie widzi akcji firmy A
    expect(await b.orderBulkAction.count()).toBe(0)
  })

  it('dwa workery na tej samej akcji: każde zamówienie ma jeden wynik, liczniki zgodne', async () => {
    const u = await osoba('wlasciciel3-a126@example.invalid', 'WLASCICIEL')
    await a.channelConfig.updateMany({ data: { statusMode: 'PRACA' } })
    const p = await product(a, 'PRZYPRAWA', 1000)
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push(await zamowienie(a, p))
    const id = await zlecWTle(a, 'STATUS', { status: 'ANULOWANE', powod: 'Dwa workery' }, ids, u)
    const drugi = testDb()
    try {
      await Promise.all([wykonajWTle(a, { akcja: id }), wykonajWTle(drugi, { akcja: id })])
    } finally {
      await drugi.$disconnect()
    }
    const w = await a.orderBulkAction.findUniqueOrThrow({ where: { id } })
    const wyniki = w.results as { id: string }[]
    expect(wyniki).toHaveLength(6)
    expect(new Set(wyniki.map((x) => x.id)).size).toBe(6)
    expect(w).toMatchObject({ state: 'GOTOWE', done: 6, ok: 6, failed: 0 })
    const st = await a.order.findMany({ where: { id: { in: ids } }, select: { status: true } })
    expect(st.every((x) => x.status === 'ANULOWANE')).toBe(true)
  })

  it('błąd poza pozycją: przy ostatniej próbie zadania akcja kończy się stanem BLAD, wcześniej czeka na ponowienie', async () => {
    const u = await osoba('wlasciciel4-a126@example.invalid', 'WLASCICIEL')
    const p = await product(a, 'PRZYPRAWA', 1000)
    const ids = [await zamowienie(a, p), await zamowienie(a, p)]
    const id = await zlecWTle(a, 'STATUS', { status: 'ANULOWANE', powod: 'Awaria bazy' }, ids, u)
    // klient, którego zapytanie o wynik pada (np. zerwane połączenie)
    const padajacy = new Proxy(a, { get: (t, k) => (k === '$queryRaw' ? () => Promise.reject(new Error('połączenie zerwane')) : Reflect.get(t, k)) }) as typeof a
    await expect(wykonajWTle(padajacy, { akcja: id }, { attempts: 1, maxAttempts: 3 })).rejects.toThrow(/zerwane/)
    expect((await stanAkcji(a, id, u))?.stan).toBe('TRWA') // kolejka ponowi
    await expect(wykonajWTle(padajacy, { akcja: id }, { attempts: 3, maxAttempts: 3 })).rejects.toThrow(/zerwane/)
    expect(await stanAkcji(a, id, u)).toMatchObject({ stan: 'BLAD', zrobione: 0, blad: expect.stringMatching(/przerwana: wyniki są dla 0 z 2/) })
    // BLAD jest końcowy: kolejne uruchomienie nic nie robi
    await wykonajWTle(a, { akcja: id })
    expect((await stanAkcji(a, id, u))?.stan).toBe('BLAD')
  })

  it('sprzątanie: akcja bez ruchu ponad godzinę → BLAD z liczbą wyników, raporty starsze niż 30 dni usuwane', async () => {
    const u = await osoba('wlasciciel5-a126@example.invalid', 'WLASCICIEL')
    const p = await product(a, 'PRZYPRAWA', 1000)
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(await zamowienie(a, p))
    const now = new Date()
    const wisi = await zlecWTle(a, 'STATUS', { status: 'ANULOWANE', powod: 'Wisi' }, ids, u)
    const swieza = await zlecWTle(a, 'STATUS', { status: 'ANULOWANE', powod: 'Świeża' }, ids, u)
    const stara = await zlecWTle(a, 'STATUS', { status: 'ANULOWANE', powod: 'Stara' }, ids, u)
    // stan ustawiony wprost (baza testowa): akcja bez ruchu od 61 min i raport sprzed 31 dni
    await sys.orderBulkAction.update({ where: { id: wisi }, data: { state: 'TRWA', done: 2, ok: 2 } })
    await sys.$executeRaw`UPDATE "OrderBulkAction" SET "updatedAt" = ${new Date(now.getTime() - 61 * 60_000)} WHERE id = ${wisi}`
    await sys.orderBulkAction.update({ where: { id: stara }, data: { state: 'GOTOWE', finishedAt: new Date(now.getTime() - 31 * 86_400_000) } })
    expect(await sprzatajAkcje(a, now)).toEqual({ przerwane: 1, usuniete: 1 })
    expect(await stanAkcji(a, wisi, u)).toMatchObject({ stan: 'BLAD', blad: expect.stringMatching(/wyniki są dla 2 z 4/) })
    expect((await stanAkcji(a, swieza, u))?.stan).toBe('CZEKA')
    expect(await stanAkcji(a, stara, u)).toBeNull()
    // przerwana akcja pokazuje się w pasku postępu jako zakończona (finishedAt = teraz)
    expect((await ostatnieAkcje(a, u, now)).map((x) => x.id)).toContain(wisi)
    // firma B nie sprząta akcji firmy A
    expect(await sprzatajAkcje(b, now)).toEqual({ przerwane: 0, usuniete: 0 })
  })
})

describe('klient na liście', () => {
  const ENV = { CUSTOMER_DATA_KEYS: `1:${'3'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'b'.repeat(64) }
  const dostawa = (imie: string, kraj: string) => ({ dostawa: { imieNazwisko: imie, firma: null, ulica: 'ul. Fikcyjna 1', numerDomu: null, numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', kraj, telefon: null, email: null }, punktOdbioru: null, faktura: null, problemy: [] })

  it('kraj dostawy zapisuje się jawnie; fragment nazwiska znajduje zamówienia tylko z uprawnieniem', async () => {
    const p = await product(a, 'PRZYPRAWA', 100)
    const z1 = await zamowienie(a, p)
    const z2 = await zamowienie(a, p)
    const z3 = await zamowienie(a, p)
    await zapiszRekordKlienta(a, z1, rekordZOdbiorcy(dostawa('Anna Kowalska-Testowa', 'DE') as never), { source: 'RECZNE', fetchedAt: T0, env: ENV })
    await zapiszRekordKlienta(a, z2, rekordZOdbiorcy(dostawa('Ąnna KOWALSKA', 'PL') as never), { source: 'RECZNE', fetchedAt: T0, env: ENV })
    await zapiszRekordKlienta(a, z3, rekordZOdbiorcy(dostawa('Jan Inny', 'PL') as never), { source: 'RECZNE', fetchedAt: T0, env: ENV })
    expect(await krajeKlientow(a)).toEqual(['DE', 'PL'])
    expect((await stronaListy(a, filtryZ({ widok: 'wszystkie', kraj: 'DE' }), { sort: SORT_DOMYSLNY, pomin: 0, ile: 50 })).wiersze.map((w) => w.id)).toEqual([z1])

    const szef = await osoba('szef-a126@example.invalid', 'WLASCICIEL')
    const mag = await osoba('magazyn-a126@example.invalid', 'MAGAZYN')
    const r = await zamowieniaKlientaFragmentem(a, 'kowalska', { actorId: szef, env: ENV })
    expect(r.stan === 'OK' && r.orderIds.sort()).toEqual([z1, z2].sort())
    expect(await zamowieniaKlientaFragmentem(a, 'kowalska', { actorId: mag, env: ENV })).toEqual({ stan: 'BEZ_UPRAWNIEN' })
    expect(await zamowieniaKlientaFragmentem(a, 'ko', { actorId: szef, env: ENV })).toEqual({ stan: 'ZA_KROTKA' })
    const slad = await sys.auditLog.findFirst({ where: { actorId: szef }, orderBy: { createdAt: 'desc' } })
    expect(JSON.stringify(slad?.after)).not.toMatch(/kowalsk/i)
  })
})
