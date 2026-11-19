// karta zamówienia docelowa. Edycja pozycji przez rdzeń (rezerwacje, braki, kwota, dziennik), blokada po
// wydruku, rewizja z kanału po edycji lokalnej, podział i dosłanie, konto w cieniu i uprawnienia ról, izolacja firm.
// Dane fikcyjne, zero połączeń zewnętrznych.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { permissionsOf } from '@/lib/auth/uprawnienia'
import { daneKarty } from '@/lib/karta/dane'
import { historiaZamowienia } from '@/lib/karta/historia'
import { dodajNotatke, OKNO_EDYCJI_MS, poprawNotatke } from '@/lib/karta/notatki'
import { oznaczOplacone, zapiszPlatnosc } from '@/lib/karta/platnosci'
import { daneKlienta, PODGLAD_AUDIT } from '@/lib/klienci/odczyt'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { dodajPozycje, podzielZamowienie, usunPozycje, zmienIlosc } from '@/lib/karta/pozycje'
import { shipLater, swapProduct } from '@/lib/rdzen/brakuje'
import { addOrderLine, AUDIT_POZYCJA, changeLineQty, EdycjaError, KOMUNIKAT_ZBIERANE, POWOD_ZMIANY_W_KANALE, removeOrderLine, splitOrder } from '@/lib/rdzen/edycja'
import { startPicking } from '@/lib/rdzen/przejscia'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { expectInvariants, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
  await sys.$disconnect()
})

const ENV = { EKRANY_PRACA: '1' }
const BIURO = permissionsOf({ role: 'BIURO', permissions: [], deniedPermissions: [] })
const MAGAZYN = permissionsOf({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] })
const WLASCICIEL = permissionsOf({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] })
const ctx = { actorId: 'user:u-test', now: T0 }

async function praca(klient = db): Promise<void> {
  await klient.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
}

const reserved = async (orderId: string) => (await db.reservation.findMany({ where: { orderId, state: 'ACTIVE' } })).reduce((s, r) => s + r.qtyBase, 0)
const shortQty = async (orderId: string) => (await db.shortage.findMany({ where: { orderId, state: { in: ['OPEN', 'SHIP_LATER'] } } })).reduce((s, r) => s + r.qtyBase, 0)
const total = async (orderId: string) => Number((await db.order.findUniqueOrThrow({ where: { id: orderId } })).totalGross)

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
})

describe('rdzeń: edycja pozycji z rezerwacjami', () => {
  it('dodaj, zmień ilość, usuń: rezerwacja w tej samej transakcji, kwota, historia, dziennik, flaga edycji', async () => {
    const a = await product(db, 'KZ-A', 10)
    const b = await product(db, 'KZ-B', 3)
    const r = await ingestOrder(db, order([{ productId: a, qty: 2 }], { totalGross: 32.99 }), { now: T0 }) // 2 × 10 zł + wysyłka 12,99
    const id = r.orderId!
    const { lineId } = await addOrderLine(db, id, { productId: b, qty: 2, priceGrossGr: 1550 }, ctx)
    expect((await stockOf(db, b)).reserved).toBe(2)
    expect(await total(id)).toBeCloseTo(63.99)
    await changeLineQty(db, id, lineId, 3, ctx)
    expect((await stockOf(db, b)).reserved).toBe(3)
    expect(await total(id)).toBeCloseTo(79.49)
    await changeLineQty(db, id, lineId, 1, ctx)
    expect((await stockOf(db, b)).reserved).toBe(1)
    expect(await total(id)).toBeCloseTo(48.49)
    const first = (await db.orderLine.findFirstOrThrow({ where: { orderId: id, externalLineId: 'L1' } })).id
    await removeOrderLine(db, id, first, ctx)
    expect((await stockOf(db, a)).reserved).toBe(0)
    expect(await total(id)).toBeCloseTo(28.49)
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    const f = flagsOf(o)
    expect(f.edytowaneLokalnie).toBe(true)
    expect(f.pozycjeKanalu).toEqual({ L1: [a, 2] }) // zdjęcie kanału sprzed pierwszej edycji
    expect(f.kwotaZaplacona).toBe('32.99')
    expect(f.usunieteLokalnie).toEqual([first])
    expect((await db.orderEvent.findMany({ where: { orderId: id, actorId: 'user:u-test' }, orderBy: { createdAt: 'asc' } })).map((e) => e.kind)).toEqual(['POZYCJA_DODANA', 'ZMIANA_ILOSCI', 'ZMIANA_ILOSCI', 'POZYCJA_USUNIETA'])
    const audyt = await db.auditLog.findMany({ where: { entity: AUDIT_POZYCJA }, orderBy: { createdAt: 'asc' } })
    expect(audyt).toHaveLength(4)
    expect(audyt[0]).toMatchObject({ entityId: lineId, actorId: 'user:u-test', after: { productId: b, qty: 2, zamowienie: id } })
    await expect(removeOrderLine(db, id, lineId, ctx)).rejects.toThrow(/ostatnią/) // ostatniej pozycji nie usuwa
    await expectInvariants(db)
  })

  it('brak towaru: dodanie ponad stan zakłada „brakuje”, zmniejszenie najpierw zamyka brak', async () => {
    const a = await product(db, 'KZ-C', 5)
    const b = await product(db, 'KZ-D', 1)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    const { lineId, reserved: res, short } = await addOrderLine(db, id, { productId: b, qty: 3, priceGrossGr: 500 }, ctx)
    expect({ res, short }).toEqual({ res: 1, short: 2 })
    expect(flagsOf(await db.order.findUniqueOrThrow({ where: { id } })).brakuje).toBe(true)
    await changeLineQty(db, id, lineId, 2, ctx)
    expect(await shortQty(id)).toBe(1)
    expect((await stockOf(db, b)).reserved).toBe(1)
    await changeLineQty(db, id, lineId, 1, ctx)
    expect(await shortQty(id)).toBe(0)
    expect(flagsOf(await db.order.findUniqueOrThrow({ where: { id } })).brakuje).toBe(false)
    await expectInvariants(db)
  })

  it('podmiana produktu (istniejące swapProduct) po dodaniu pozycji bez towaru', async () => {
    const a = await product(db, 'KZ-E', 5)
    const brak = await product(db, 'KZ-F', 0)
    const zam = await product(db, 'KZ-G', 4)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    const { lineId } = await addOrderLine(db, id, { productId: brak, qty: 2, priceGrossGr: 700 }, ctx)
    await swapProduct(db, lineId, zam, ctx)
    expect((await stockOf(db, zam)).reserved).toBe(2)
    expect(await shortQty(id)).toBe(0)
    await expectInvariants(db)
  })

  it('złe dane: ilość, cena, produkt spoza katalogu, pozycja z innego zamówienia', async () => {
    const a = await product(db, 'KZ-H', 5)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    const inne = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    const obca = (await db.orderLine.findFirstOrThrow({ where: { orderId: inne } })).id
    await expect(addOrderLine(db, id, { productId: a, qty: 0, priceGrossGr: 100 }, ctx)).rejects.toBeInstanceOf(EdycjaError)
    await expect(addOrderLine(db, id, { productId: a, qty: 1, priceGrossGr: -1 }, ctx)).rejects.toBeInstanceOf(EdycjaError)
    await expect(addOrderLine(db, id, { productId: 'nieistnieje', qty: 1, priceGrossGr: 100 }, ctx)).rejects.toThrow(/katalogu/)
    await expect(changeLineQty(db, id, obca, 2, ctx)).rejects.toThrow(/Nie ma takiej pozycji/)
    expect(await reserved(inne)).toBe(1)
  })
})

describe('rdzeń: blokada po wydruku i rewizja z kanału', () => {
  it('po rozpoczęciu zbierania edycja odmawia jasnym komunikatem, rezerwacje bez zmian', async () => {
    const a = await product(db, 'KZ-I', 5)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    await startPicking(db, id)
    await expect(addOrderLine(db, id, { productId: a, qty: 1, priceGrossGr: 100 }, ctx)).rejects.toThrow(KOMUNIKAT_ZBIERANE)
    const line = (await db.orderLine.findFirstOrThrow({ where: { orderId: id } })).id
    await expect(changeLineQty(db, id, line, 2, ctx)).rejects.toThrow(KOMUNIKAT_ZBIERANE)
    expect(await reserved(id)).toBe(1)
  })

  it('nowa rewizja bez zmiany pozycji w kanale: edycja z karty zostaje; ze zmianą: „Do wyjaśnienia” bez nadpisania', async () => {
    const a = await product(db, 'KZ-J', 10)
    const b = await product(db, 'KZ-K', 10)
    const inc = order([{ productId: a, qty: 1 }])
    const id = (await ingestOrder(db, inc, { now: T0 })).orderId!
    const line = (await db.orderLine.findFirstOrThrow({ where: { orderId: id } })).id
    await changeLineQty(db, id, line, 3, ctx)
    await addOrderLine(db, id, { productId: b, qty: 1, priceGrossGr: 900 }, ctx)
    // rewizja 2: kanał zmienił tylko status płatności, pozycje te same
    await ingestOrder(db, { ...inc, externalRevision: '2' }, { now: T0 })
    let o = await db.order.findUniqueOrThrow({ where: { id }, include: { lines: true } })
    expect(o.status).toBe('DO_REALIZACJI')
    expect(o.lines.find((l) => l.id === line)!.qty).toBe(3)
    expect(o.lines.filter((l) => !l.removed)).toHaveLength(2)
    // rewizja 3: klient dopisał w kanale ilość
    await ingestOrder(db, { ...inc, externalRevision: '3', lines: [{ ...inc.lines[0]!, qty: 2 }] }, { now: T0 })
    o = await db.order.findUniqueOrThrow({ where: { id }, include: { lines: true } })
    expect(o.status).toBe('DO_WYJASNIENIA')
    expect(flagsOf(o).doWyjasnienia).toContain(POWOD_ZMIANY_W_KANALE)
    expect(o.lines.find((l) => l.id === line)!.qty).toBe(3) // edycja nie nadpisana
    expect(await reserved(id)).toBe(4)
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'ZMIANA_W_KANALE_PO_EDYCJI' } })).toBe(1)
    // ta sama treść kanału jeszcze raz: bez drugiego wpisu (zdjęcie kanału odświeżone)
    await ingestOrder(db, { ...inc, externalRevision: '4', lines: [{ ...inc.lines[0]!, qty: 2 }] }, { now: T0 })
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'ZMIANA_W_KANALE_PO_EDYCJI' } })).toBe(1)
    await expectInvariants(db)
  })

  it('zamówienie bez edycji z karty: rewizja kanału działa jak dotąd (zmiana ilości bez „Do wyjaśnienia”)', async () => {
    const a = await product(db, 'KZ-L', 10)
    const inc = order([{ productId: a, qty: 1 }])
    const id = (await ingestOrder(db, inc, { now: T0 })).orderId!
    await ingestOrder(db, { ...inc, externalRevision: '2', lines: [{ ...inc.lines[0]!, qty: 2 }] }, { now: T0 })
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o.status).toBe('DO_REALIZACJI')
    expect(await reserved(id)).toBe(2)
  })
})

describe('rdzeń: podział zamówienia i dosłanie', () => {
  it('podział: nowa paczka z rezerwacjami przeniesionymi w jednej transakcji, suma rezerwacji bez zmian', async () => {
    const a = await product(db, 'KZ-M', 10)
    const b = await product(db, 'KZ-N', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 3 }, { productId: b, qty: 1 }]), { now: T0 })).orderId!
    const la = (await db.orderLine.findFirstOrThrow({ where: { orderId: id, externalLineId: 'L1' } })).id
    const lb = (await db.orderLine.findFirstOrThrow({ where: { orderId: id, externalLineId: 'L2' } })).id
    const { childOrderId, packageNo } = await splitOrder(db, id, { [la]: 2 }, ctx)
    expect(packageNo).toBe(2)
    expect((await stockOf(db, a)).reserved).toBe(3)
    expect(await reserved(id)).toBe(2) // 1 × A + 1 × B
    expect(await reserved(childOrderId)).toBe(2)
    const child = await db.order.findUniqueOrThrow({ where: { id: childOrderId }, include: { lines: true } })
    expect(child).toMatchObject({ parentOrderId: id, packageNo: 2, status: 'DO_REALIZACJI' })
    expect(Number(child.totalGross)).toBe(0)
    expect((await db.orderLine.findUniqueOrThrow({ where: { id: la } })).qtyRejected).toBe(2)
    await expect(splitOrder(db, id, { [la]: 1, [lb]: 1 }, ctx)).rejects.toThrow(/co najmniej jedna/)
    await expectInvariants(db)
  })

  it('dosłanie (istniejące shipLater) po dodaniu pozycji bez towaru: podzamówienie „Paczka 2”', async () => {
    const a = await product(db, 'KZ-O', 5)
    const brak = await product(db, 'KZ-P', 0)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    const { lineId } = await addOrderLine(db, id, { productId: brak, qty: 2, priceGrossGr: 400 }, ctx)
    const { childOrderId } = await shipLater(db, lineId, ctx)
    expect((await db.order.findUniqueOrThrow({ where: { id: childOrderId } })).packageNo).toBe(2)
    expect(await shortQty(id)).toBe(0)
    await expectInvariants(db)
  })
})

describe('karta: bramka PRACA, ustawienie firmy i uprawnienia ról', () => {
  it('konto w cieniu: każda akcja odmawia także przy ręcznym wywołaniu, zamówienie bez zmian', async () => {
    const a = await product(db, 'KZ-Q', 5)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    const line = (await db.orderLine.findFirstOrThrow({ where: { orderId: id } })).id
    const z = { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL }
    for (const w of [
      await dodajPozycje(db, { ...z, sku: 'KZ-Q', ilosc: '1', cena: '' }, ENV),
      await zmienIlosc(db, { ...z, lineId: line, ilosc: '2' }, ENV),
      await usunPozycje(db, { ...z, lineId: line }, ENV),
      await podzielZamowienie(db, { ...z, wybor: { [line]: '1' } }, ENV),
    ])
      expect(w).toMatchObject({ zmiana: false, blad: expect.stringMatching(/tylko dla kont w trybie PRACA/) })
    await praca()
    expect((await zmienIlosc(db, { ...z, lineId: line, ilosc: '2' }, { BASELINKER_TOKEN: 'test-bl' })).blad).toMatch(/tylko dla kont w trybie PRACA/) // firma z BL bez EKRANY_PRACA
    expect(await reserved(id)).toBe(1)
    expect(await db.orderEvent.count({ where: { orderId: id, actorId: 'user:u-test' } })).toBe(0)
  })

  it('trzy role: właściciel i biuro edytują i dzielą, magazyn dostaje odmowę', async () => {
    await praca()
    const a = await product(db, 'KZ-R', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })).orderId!
    const line = (await db.orderLine.findFirstOrThrow({ where: { orderId: id } })).id
    const z = (u: ReadonlySet<string>) => ({ orderId: id, userId: 'u-test', uprawnienia: u })
    expect((await zmienIlosc(db, { ...z(MAGAZYN), lineId: line, ilosc: '3' }, ENV)).blad).toMatch(/uprawnienia/)
    expect((await dodajPozycje(db, { ...z(MAGAZYN), sku: 'KZ-R', ilosc: '1', cena: '' }, ENV)).blad).toMatch(/uprawnienia/)
    expect((await podzielZamowienie(db, { ...z(MAGAZYN), wybor: { [line]: '1' } }, ENV)).blad).toMatch(/uprawnienia/)
    expect(await zmienIlosc(db, { ...z(BIURO), lineId: line, ilosc: '3' }, ENV)).toMatchObject({ blad: null, zmiana: true })
    expect(await dodajPozycje(db, { ...z(WLASCICIEL), sku: 'KZ-R', ilosc: '1', cena: '12,50' }, ENV)).toMatchObject({ blad: null, zmiana: true })
    expect((await dodajPozycje(db, { ...z(BIURO), sku: 'BRAK-SKU', ilosc: '1', cena: '' }, ENV)).blad).toMatch(/SKU/)
    expect((await dodajPozycje(db, { ...z(BIURO), sku: 'KZ-R', ilosc: '1', cena: '1,234' }, ENV)).blad).toMatch(/Cena/)
    const podzial = await podzielZamowienie(db, { ...z(BIURO), wybor: { [line]: '1' } }, ENV)
    expect(podzial).toMatchObject({ blad: null, zmiana: true, childOrderId: expect.any(String) })
    expect(await reserved(id)).toBe(3) // 2 z L1 (3 − 1 przeniesiona) + 1 dodana
    await expectInvariants(db)
  })

  it('ustawienie firmy edycjaZamowienKanalow = false: zamówienia z kanałów bez edycji', async () => {
    await praca()
    await db.organization.updateMany({ data: { settings: { karta: { edycjaZamowienKanalow: false } } } })
    const a = await product(db, 'KZ-S', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    const line = (await db.orderLine.findFirstOrThrow({ where: { orderId: id } })).id
    expect((await zmienIlosc(db, { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL, lineId: line, ilosc: '2' }, ENV)).blad).toMatch(/tylko w zamówieniach ręcznych/)
  })

  it('izolacja firm: zamówienie firmy A niewidoczne z karty firmy B', async () => {
    await praca()
    await praca(dbB)
    const a = await product(db, 'KZ-T', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    const line = (await db.orderLine.findFirstOrThrow({ where: { orderId: id } })).id
    expect((await zmienIlosc(dbB, { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL, lineId: line, ilosc: '2' }, ENV)).blad).toBe('Nie ma takiego zamówienia.')
    expect(await reserved(id)).toBe(1)
  })
})

describe('płatność: dopłata, zwrot różnicy, oznacz jako opłacone', () => {
  it('po edycji „Do dopłaty”, dopłata rozlicza; po usunięciu „Do zwrotu”, zwrot najwyżej do różnicy', async () => {
    await praca()
    const a = await product(db, 'KZ-PL1', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }, { productId: a, qty: 1 }], { totalGross: 20 }), { now: T0 })).orderId!
    const [l1] = await db.orderLine.findMany({ where: { orderId: id }, orderBy: { externalLineId: 'asc' } })
    const z = { orderId: id, userId: 'u-test', uprawnienia: BIURO }
    await changeLineQty(db, id, l1!.id, 2, ctx)
    let d = await daneKarty(db, id, { userId: 'u-test', uprawnienia: BIURO }, { env: ENV })
    expect(d!.platnosc).toMatchObject({ zamowienieGr: 3000, zaplaconoGr: 2000, roznicaGr: 1000 })
    // dopłata = ręczne potwierdzenie pieniędzy: to samo uprawnienie co „Oznacz jako opłacone” (domyślnie tylko właściciel)
    expect((await zapiszPlatnosc(db, { ...z, uprawnienia: MAGAZYN, rodzaj: 'DOPLATA', kwota: '10', metoda: 'przelew' }, ENV)).blad).toMatch(/uprawnienia/)
    expect((await zapiszPlatnosc(db, { ...z, rodzaj: 'DOPLATA', kwota: '10', metoda: 'przelew' }, ENV)).blad).toMatch(/uprawnienia/)
    const w = { ...z, uprawnienia: WLASCICIEL }
    expect((await zapiszPlatnosc(db, { ...w, rodzaj: 'DOPLATA', kwota: '0', metoda: 'przelew' }, ENV)).blad).toMatch(/Kwota/)
    expect((await zapiszPlatnosc(db, { ...w, rodzaj: 'DOPLATA', kwota: '10', metoda: 'bitcoin' }, ENV)).blad).toMatch(/metodę/)
    expect(await zapiszPlatnosc(db, { ...w, rodzaj: 'DOPLATA', kwota: '10,00', metoda: 'przelew' }, ENV)).toMatchObject({ blad: null, zmiana: true })
    d = await daneKarty(db, id, { userId: 'u-test', uprawnienia: BIURO }, { env: ENV })
    expect(d!.platnosc.roznicaGr).toBe(0)
    await removeOrderLine(db, id, l1!.id, ctx)
    d = await daneKarty(db, id, { userId: 'u-test', uprawnienia: BIURO }, { env: ENV })
    expect(d!.platnosc.roznicaGr).toBe(-2000)
    expect((await zapiszPlatnosc(db, { ...z, uprawnienia: WLASCICIEL, rodzaj: 'ZWROT', kwota: '25', metoda: 'przelew' }, ENV)).blad).toMatch(/większa niż różnica/)
    expect((await zapiszPlatnosc(db, { ...z, rodzaj: 'ZWROT', kwota: '20', metoda: 'przelew' }, ENV)).blad).toMatch(/uprawnienia/) // zwroty.pieniadze: domyślnie tylko właściciel
    expect(await zapiszPlatnosc(db, { ...z, uprawnienia: WLASCICIEL, rodzaj: 'ZWROT', kwota: '20', metoda: 'przelew' }, ENV)).toMatchObject({ blad: null, zmiana: true })
    const zwrot = await db.orderPayment.findFirstOrThrow({ where: { orderId: id, kind: 'ZWROT' } })
    expect(zwrot).toMatchObject({ exportedAt: null, actorId: 'user:u-test' }) // pozycja do eksportu przelewów
    expect(await db.orderEvent.count({ where: { orderId: id, kind: { in: ['DOPLATA_ZAPISANA', 'ZWROT_ROZNICY'] } } })).toBe(2)
  })

  it('edycja zamówienia nieopłaconego, potem wpłata w kanale: podstawą jest kwota kanału, „Do dopłaty” różnica', async () => {
    const a = await product(db, 'KZ-PL3', 10)
    const inc = order([{ productId: a, qty: 1 }], { paymentState: 'UNPAID', totalGross: 10 })
    const id = (await ingestOrder(db, inc, { now: T0 })).orderId!
    const line = (await db.orderLine.findFirstOrThrow({ where: { orderId: id } })).id
    await changeLineQty(db, id, line, 2, ctx) // 10 zł → 20 zł w Kompletorze, kanał dalej 10 zł
    expect(flagsOf(await db.order.findUniqueOrThrow({ where: { id } })).kwotaZaplacona).toBeUndefined()
    await ingestOrder(db, { ...inc, externalRevision: '2', paymentState: 'PAID' }, { now: T0 })
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o.paymentState).toBe('PAID')
    expect(flagsOf(o).kwotaZaplacona).toBe('10.00')
    const d = await daneKarty(db, id, { userId: 'u-test', uprawnienia: BIURO }, { env: ENV })
    expect(d!.platnosc).toMatchObject({ zamowienieGr: 2000, zaplaconoGr: 1000, roznicaGr: 1000 })
    await expectInvariants(db)
  })

  it('oznacz jako opłacone (istniejące markPaid) tylko w PRACA i z uprawnieniem; konto w cieniu odmawia', async () => {
    const a = await product(db, 'KZ-PL2', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }], { paymentState: 'UNPAID' }), { now: T0 })).orderId!
    expect((await oznaczOplacone(db, { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL }, ENV)).blad).toMatch(/tylko dla kont w trybie PRACA/)
    expect((await zapiszPlatnosc(db, { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL, rodzaj: 'DOPLATA', kwota: '5', metoda: 'przelew' }, ENV)).blad).toMatch(/tylko dla kont w trybie PRACA/)
    await praca()
    expect((await oznaczOplacone(db, { orderId: id, userId: 'u-test', uprawnienia: BIURO }, ENV)).blad).toMatch(/uprawnienia/)
    expect(await oznaczOplacone(db, { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL }, ENV)).toMatchObject({ blad: null, zmiana: true })
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o).toMatchObject({ paymentState: 'PAID', status: 'DO_REALIZACJI' })
    expect(await oznaczOplacone(db, { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL }, ENV)).toMatchObject({ blad: null, zmiana: false }) // drugi klik
  })
})

describe('konto w podglądzie widzi przyciski nieaktywne z powodem', () => {
  it('cień: powody płatności, statusu i pozycji, przyciski „Co dalej” wszystkie nieaktywne; praca: bez podglądu, akcja serwera dalej odmawia w cieniu', async () => {
    const a = await product(db, 'KZ-PG1', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }], { paymentState: 'UNPAID' }), { now: T0 })).orderId!
    let d = await daneKarty(db, id, { userId: 'u-test', uprawnienia: WLASCICIEL }, { env: ENV })
    expect(d!.praca).toBe(false)
    expect(d!.coDalej).toBeNull()
    expect(d!.cien).toMatch(/Tylko podgląd/)
    expect(d!.podglad!.powody.platnosc).toMatch(/^Wpłatę zapisujesz .*Ustawienia → Sprzedaż i kanały → Kanały sprzedaży\.$/)
    const przyciski = d!.podglad!.coDalej!.przyciski
    expect(przyciski.length).toBeGreaterThan(0)
    expect(przyciski.every((p) => p.powod === d!.podglad!.powody.status)).toBe(true)
    expect(d!.podglad!.coDalej!.stanowisko).toBe(false)
    // bez uprawnienia do przejść: powód o uprawnieniu zamiast trybu
    const bez = await daneKarty(db, id, { userId: 'u-test', uprawnienia: new Set(['panel.podglad']) }, { env: ENV })
    expect(bez!.podglad!.coDalej!.przyciski.every((p) => /uprawnienia/.test(p.powod ?? ''))).toBe(true)
    // bramka serwera bez zmian: zapis wpłaty w cieniu odmawia
    expect((await oznaczOplacone(db, { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL }, ENV)).blad).toMatch(/tylko dla kont w trybie PRACA/)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).paymentState).toBe('UNPAID')
    await praca()
    d = await daneKarty(db, id, { userId: 'u-test', uprawnienia: WLASCICIEL }, { env: ENV })
    expect(d!.podglad).toBeNull()
    expect(d!.coDalej!.przyciski.some((p) => p.powod === null)).toBe(true)
  })
})

describe('notatki wewnętrzne', () => {
  it('dodaje każda rola z uprawnieniem (także w cieniu); poprawia tylko autor przez 15 minut; bez kasowania', async () => {
    const a = await product(db, 'KZ-N1', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    const bez = new Set(['panel.podglad'])
    expect((await dodajNotatke(db, { orderId: id, tresc: 'x', userId: 'u1', uprawnienia: bez })).blad).toMatch(/uprawnienia/)
    expect((await dodajNotatke(db, { orderId: id, tresc: '   ', userId: 'u1', uprawnienia: MAGAZYN })).blad).toMatch(/od 1 do 2000/)
    expect((await dodajNotatke(db, { orderId: id, tresc: 'a'.repeat(2001), userId: 'u1', uprawnienia: MAGAZYN })).blad).toMatch(/od 1 do 2000/)
    expect(await dodajNotatke(db, { orderId: id, tresc: 'Zapakować w folię', naKarcie: 'tak', userId: 'u1', uprawnienia: MAGAZYN })).toMatchObject({ blad: null, zmiana: true })
    const n = await db.orderNote.findFirstOrThrow({ where: { orderId: id } })
    expect(n).toMatchObject({ body: 'Zapakować w folię', showOnCard: true, actorId: 'user:u1' })
    expect((await poprawNotatke(db, { orderId: id, noteId: n.id, tresc: 'cudza', userId: 'u2', uprawnienia: BIURO })).blad).toMatch(/tylko jej autor/)
    expect(await poprawNotatke(db, { orderId: id, noteId: n.id, tresc: 'Zapakować w dwie folie', userId: 'u1', uprawnienia: MAGAZYN })).toMatchObject({ blad: null, zmiana: true })
    const pozniej = new Date(n.createdAt.getTime() + OKNO_EDYCJI_MS + 1000)
    expect((await poprawNotatke(db, { orderId: id, noteId: n.id, tresc: 'za późno', userId: 'u1', uprawnienia: MAGAZYN }, pozniej)).blad).toMatch(/15 minut/)
    expect((await db.orderNote.findUniqueOrThrow({ where: { id: n.id } })).body).toBe('Zapakować w dwie folie')
    // treść notatki nie trafia do zdarzeń zamówienia ani dziennika
    expect(JSON.stringify(await db.orderEvent.findMany({ where: { orderId: id } }))).not.toContain('folie')
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain('folie')
    // izolacja: firma B nie dopisze notatki do zamówienia firmy A
    expect((await dodajNotatke(dbB, { orderId: id, tresc: 'obca', userId: 'u3', uprawnienia: WLASCICIEL })).blad).toBe('Nie ma takiego zamówienia.')
  })
})

describe('dane klienta: historia i dziennik bez danych osobowych', () => {
  const NAZWISKO = 'Jan Kartowy'
  const ULICA = 'ul. Makietowa 9'
  const EMAIL = 'jan.kartowy@example.test'
  const TELEFON = '+48 500 111 222'
  const SZUKANE = [NAZWISKO, ULICA, EMAIL, TELEFON, '500111222']
  const ENV_KLIENT = { DANE_KLIENTA_ZAPIS: '1', CUSTOMER_DATA_KEYS: `1:${'3'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'c'.repeat(64) }
  let logs: string[]
  beforeEach(() => {
    logs = []
    for (const k of Object.keys(ENV_KLIENT) as (keyof typeof ENV_KLIENT)[]) vi.stubEnv(k, ENV_KLIENT[k])
    for (const m of ['log', 'info', 'warn', 'error'] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
      })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('edycja, płatność, podział i kopiowanie: danych klienta nie ma w żadnej tabeli poza szyfrogramem ani w logach; historia bez podglądów', async () => {
    await praca()
    const u = await createUserWithHash(sys, { email: 'kz-biuro@example.test', name: 'Basia', passwordHash: 'x' })
    await grantMembership(sys, { email: 'kz-biuro@example.test', organizationId: ORG_A, role: 'BIURO' })
    const a = await product(db, 'KZ-K1', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 3 }]), { now: T0 })).orderId!
    await zapiszRekordKlienta(
      db,
      id,
      rekordZOdbiorcy({
        dostawa: { imieNazwisko: NAZWISKO, firma: null, ulica: ULICA, numerDomu: '9', numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL', telefon: TELEFON, email: EMAIL },
        punktOdbioru: null,
        faktura: null,
        problemy: [],
      }),
      { source: 'RECZNE', fetchedAt: T0, env: ENV_KLIENT },
    )
    const line = (await db.orderLine.findFirstOrThrow({ where: { orderId: id } })).id
    const z = { orderId: id, userId: u.id, uprawnienia: BIURO }
    expect((await zmienIlosc(db, { ...z, lineId: line, ilosc: '4' }, ENV)).blad).toBeNull()
    expect((await zapiszPlatnosc(db, { ...z, uprawnienia: WLASCICIEL, rodzaj: 'DOPLATA', kwota: '10', metoda: 'BLIK' }, ENV)).blad).toBeNull()
    expect((await podzielZamowienie(db, { ...z, wybor: { [line]: '1' } }, ENV)).blad).toBeNull()
    const kopia = await daneKlienta(db, id, { actorId: u.id, zakres: 'PELNY', cel: 'KOPIA', env: ENV_KLIENT }) // „Kopiuj e-mail”
    expect(kopia.stan === 'PELNY' && kopia.rekord.email).toBe(EMAIL)
    expect(await db.auditLog.count({ where: { entity: PODGLAD_AUDIT, entityId: id } })).toBe(1)
    const h = await historiaZamowienia(db, id, { sys: () => sys })
    expect(h.map((w) => w.opis)).toEqual(expect.arrayContaining(['Zmiana ilości w Kompletorze: 3 → 4', 'Dopłata zapisana', 'Podział zamówienia: paczka 2']))
    expect(h.find((w) => w.opis.startsWith('Zmiana ilości'))!.kto).toBe('Basia')
    expect(JSON.stringify(h)).not.toMatch(/podgl/i)
    const tables = await sys.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('OrderCustomer', 'User')`
    const hits: string[] = []
    for (const { tablename } of tables) for (const { r } of await sys.$queryRawUnsafe<{ r: string }[]>(`SELECT t::text AS r FROM "${tablename}" t`)) for (const x of SZUKANE) if (r.includes(x)) hits.push(`${tablename}: ${x}`)
    expect(hits).toEqual([])
    expect(logs.filter((l) => SZUKANE.some((x) => l.includes(x)))).toEqual([])
  })
})
