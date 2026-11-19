// jeden zapis sekcji „Pozycje” karty zamówienia (ilości, usunięcie, decyzje o brakach). Każda zmiana
// osobno przez rdzeń, jedna odrzucona nie blokuje reszty, pozycje spoza zamówienia odrzucone, uprawnienia jak
// w pojedynczych akcjach. Dane fikcyjne, zero połączeń zewnętrznych.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { permissionsOf } from '@/lib/auth/uprawnienia'
import { zapiszPozycje, zmianyZFormularza } from '@/lib/karta/zapis-pozycji'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_B, testDb, truncateAll } from './db'
import { expectInvariants, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const ENV = { EKRANY_PRACA: '1' }
const WLASCICIEL = permissionsOf({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] })
const linie = async (orderId: string) => db.orderLine.findMany({ where: { orderId }, orderBy: { externalLineId: 'asc' } })

async function praca(): Promise<void> {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
})

describe('zmiany z formularza', () => {
  it('czyta pola ilosc_/usun_/decyzja_/sku_ po id pozycji, resztę pomija', () => {
    const f = new FormData()
    f.set('zamowienie', 'o1')
    f.set('ilosc_l1', ' 3 ')
    f.set('usun_l2', 'tak')
    f.set('decyzja_l3', 'ZAMIEN')
    f.set('sku_l3', 'SKU-9')
    f.set('ilosc_zle id!', '5')
    f.set('$ACTION_ID_x', '1')
    expect(zmianyZFormularza(f)).toEqual([
      { lineId: 'l1', ilosc: '3' },
      { lineId: 'l2', usun: true },
      { lineId: 'l3', decyzja: 'ZAMIEN', sku: 'SKU-9' },
    ])
  })
})

describe('jeden zapis sekcji „Pozycje”', () => {
  it('ilość, usunięcie i decyzja o braku jednym zapisem; rezerwacje i decyzja zapisane', async () => {
    await praca()
    const a = await product(db, 'A127-A', 10)
    const b = await product(db, 'A127-B', 10)
    const c = await product(db, 'A127-C', 0)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }, { productId: b, qty: 2 }, { productId: c, qty: 1 }]), { now: T0 })).orderId!
    const [la, lb, lc] = await linie(id)
    expect(await db.shortage.count({ where: { orderLineId: lc!.id, state: 'OPEN' } })).toBe(1)
    const w = await zapiszPozycje(
      db,
      {
        orderId: id,
        userId: 'u-test',
        uprawnienia: WLASCICIEL,
        zmiany: [
          { lineId: la!.id, ilosc: '3' },
          { lineId: lb!.id, ilosc: '2', usun: true },
          { lineId: lc!.id, ilosc: '1', decyzja: 'POCZEKAJ' },
        ],
      },
      ENV,
    )
    expect(w).toMatchObject({ blad: null, zmiana: true, zapisane: 3, odrzucone: 0 })
    expect((await stockOf(db, a)).reserved).toBe(3)
    expect((await stockOf(db, b)).reserved).toBe(0)
    expect((await db.orderLine.findUniqueOrThrow({ where: { id: lb!.id } })).removed).toBe(true)
    expect((await db.shortageDecision.findFirstOrThrow({ where: { orderLineId: lc!.id } })).action).toBe('POCZEKAJ')
    await expectInvariants(db)
  })

  it('jedna zła pozycja nie blokuje reszty: dobra zapisana, zła w komunikacie; bez zmian = „Brak zmian”', async () => {
    await praca()
    const a = await product(db, 'A127-D', 10)
    const b = await product(db, 'A127-E', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }, { productId: b, qty: 1 }]), { now: T0 })).orderId!
    const [la, lb] = await linie(id)
    const z = { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL }
    const w = await zapiszPozycje(db, { ...z, zmiany: [{ lineId: la!.id, ilosc: '0' }, { lineId: lb!.id, ilosc: '4' }] }, ENV)
    expect(w.zapisane).toBe(1)
    expect(w.odrzucone).toBe(1)
    expect(w.zmiana).toBe(true)
    // pozycja nazwana jak w tabeli (SKU), nie numerem na liście zmian
    expect(w.blad).toMatch(/^Zapisano 1 zmianę, nie zapisano: SKU A127-D: /)
    expect((await stockOf(db, a)).reserved).toBe(1)
    expect((await stockOf(db, b)).reserved).toBe(4)
    expect(await zapiszPozycje(db, { ...z, zmiany: [{ lineId: la!.id, ilosc: '1' }, { lineId: lb!.id, ilosc: '4' }] }, ENV)).toMatchObject({ blad: null, zmiana: false, info: 'pozycje.brak' })
    await expectInvariants(db)
  })

  it('pozycja z innego zamówienia i nieznana decyzja: odrzucone, cudza pozycja bez decyzji', async () => {
    await praca()
    const c = await product(db, 'A127-F', 0)
    const id1 = (await ingestOrder(db, order([{ productId: c, qty: 1 }], { externalId: 'A127-1' }), { now: T0 })).orderId!
    const id2 = (await ingestOrder(db, order([{ productId: c, qty: 1 }], { externalId: 'A127-2' }), { now: T0 })).orderId!
    const [cudza] = await linie(id2)
    const [moja] = await linie(id1)
    const w = await zapiszPozycje(db, { orderId: id1, userId: 'u-test', uprawnienia: WLASCICIEL, zmiany: [{ lineId: cudza!.id, decyzja: 'POCZEKAJ' }, { lineId: moja!.id, decyzja: 'KASUJ' }] }, ENV)
    expect(w).toMatchObject({ zmiana: false, zapisane: 0, odrzucone: 2 })
    expect(w.blad).toMatch(/nie ma takiej pozycji w tym zamówieniu/)
    expect(w.blad).toMatch(/nieznana decyzja/)
    expect(await db.shortageDecision.count()).toBe(0)
  })

  it('inny SKU zamiennika przy tej samej decyzji „Zamień produkt” to zmiana (konto w podglądzie)', async () => {
    const c = await product(db, 'A127-I', 0)
    await product(db, 'A127-Z1', 5)
    const z2 = await product(db, 'A127-Z2', 5)
    const id = (await ingestOrder(db, order([{ productId: c, qty: 1 }]), { now: T0 })).orderId!
    const [lc] = await linie(id)
    const z = { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL }
    expect(await zapiszPozycje(db, { ...z, zmiany: [{ lineId: lc!.id, decyzja: 'ZAMIEN', sku: 'A127-Z1' }] }, ENV)).toMatchObject({ blad: null, zapisane: 1 })
    // ta sama decyzja i ten sam zamiennik: bez zmian
    expect(await zapiszPozycje(db, { ...z, zmiany: [{ lineId: lc!.id, decyzja: 'ZAMIEN', sku: 'A127-Z1' }] }, ENV)).toMatchObject({ blad: null, zmiana: false, zapisane: 0 })
    expect(await zapiszPozycje(db, { ...z, zmiany: [{ lineId: lc!.id, decyzja: 'ZAMIEN', sku: 'A127-Z2' }] }, ENV)).toMatchObject({ blad: null, zapisane: 1 })
    const dec = await db.shortageDecision.findFirstOrThrow({ where: { orderLineId: lc!.id } })
    expect(dec).toMatchObject({ action: 'ZAMIEN', replacementProductId: z2, dryRun: true })
  })

  it('zapisana „Zamień produkt” bez pola SKU w formularzu nie daje błędu przy zapisie sekcji', async () => {
    const c = await product(db, 'A127-J', 0)
    await product(db, 'A127-Z3', 5)
    const id = (await ingestOrder(db, order([{ productId: c, qty: 1 }]), { now: T0 })).orderId!
    const [lc] = await linie(id)
    const z = { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL }
    expect(await zapiszPozycje(db, { ...z, zmiany: [{ lineId: lc!.id, decyzja: 'ZAMIEN', sku: 'A127-Z3' }] }, ENV)).toMatchObject({ blad: null, zapisane: 1 })
    // po spakowaniu pole SKU nie jest renderowane, select zostaje na ZAMIEN
    expect(await zapiszPozycje(db, { ...z, zmiany: [{ lineId: lc!.id, decyzja: 'ZAMIEN' }] }, ENV)).toMatchObject({ blad: null, zmiana: false, zapisane: 0 })
  })

  it('uprawnienia: bez braków decyzja odrzucona (ilość przechodzi); tylko decyzje = pola ilości pominięte; izolacja firm', async () => {
    await praca()
    const a = await product(db, 'A127-G', 10)
    const c = await product(db, 'A127-H', 0)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }, { productId: c, qty: 1 }]), { now: T0 })).orderId!
    const [la, lc] = await linie(id)
    const bezBrakow = new Set([...WLASCICIEL].filter((p) => p !== 'braki.decyzje'))
    const w = await zapiszPozycje(db, { orderId: id, userId: 'u-test', uprawnienia: bezBrakow, zmiany: [{ lineId: la!.id, ilosc: '2' }, { lineId: lc!.id, decyzja: 'POCZEKAJ' }] }, ENV)
    expect(w).toMatchObject({ zapisane: 1, odrzucone: 1, zmiana: true })
    expect(w.blad).toMatch(/uprawnienia/)
    expect((await stockOf(db, a)).reserved).toBe(2)
    const tylko = await zapiszPozycje(db, { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL, tylkoDecyzje: true, zmiany: [{ lineId: la!.id, ilosc: '5', usun: true }, { lineId: lc!.id, decyzja: 'POCZEKAJ' }] }, ENV)
    expect(tylko).toMatchObject({ blad: null, zapisane: 1 })
    expect((await stockOf(db, a)).reserved).toBe(2)
    expect((await db.orderLine.findUniqueOrThrow({ where: { id: la!.id } })).removed).toBe(false)
    // firma B nie widzi pozycji firmy A: każda zmiana odrzucona, nic się nie zmienia
    const obca = await zapiszPozycje(dbB, { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL, zmiany: [{ lineId: la!.id, ilosc: '7' }] }, ENV)
    expect(obca).toMatchObject({ zapisane: 0, odrzucone: 1 })
    expect((await stockOf(db, a)).reserved).toBe(2)
    await expectInvariants(db)
  })
})
