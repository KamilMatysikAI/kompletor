// pozycje zamówienia z karty po przesyłce i po dokumencie sprzedaży (blokada w rdzeniu pod blokadą
// zamówienia i na karcie z powodem) oraz wyszukiwarka produktu w „Dodaj pozycję”. Dane fikcyjne, zero połączeń
// zewnętrznych (kanał, wFirma, KSeF i przewoźnicy nietknięci).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { permissionsOf } from '@/lib/auth/uprawnienia'
import { daneKarty } from '@/lib/karta/dane'
import { dodajPozycje } from '@/lib/karta/pozycje'
import { szukajProduktuDoZamowienia } from '@/lib/karta/szukaj-produktu'
import { zapiszPozycje } from '@/lib/karta/zapis-pozycji'
import {
  addOrderLine,
  changeLinePrice,
  changeLineQty,
  KOMUNIKAT_DOKUMENT_POZYCJE,
  KOMUNIKAT_FAKTURA_NIEWIADOMA_POZYCJE,
  KOMUNIKAT_PRZESYLKA_POZYCJE,
  KOMUNIKAT_PRZESYLKA_POZYCJE_BEZ_ANULOWANIA,
  OSTRZEZENIE_PRZESYLKA_POZYCJE,
  removeOrderLine,
  splitOrder,
} from '@/lib/rdzen/edycja'
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
const linie = async (orderId: string) => db.orderLine.findMany({ where: { orderId, removed: false }, orderBy: { externalLineId: 'asc' } })
const suma = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id } })).totalGross.toString()
async function praca(): Promise<void> {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
}
async function zamowienie(o: { pobranie?: boolean } = {}): Promise<{ id: string; a: string; b: string; la: string; lb: string }> {
  await praca()
  const a = await product(db, `E3-A-${Math.random().toString(36).slice(2, 7)}`, 10)
  const b = await product(db, `E3-B-${Math.random().toString(36).slice(2, 7)}`, 10)
  const platnosc = o.pobranie ? { paymentState: 'COD' as const, paymentMethod: 'Za pobraniem' } : {}
  const id = (await ingestOrder(db, order([{ productId: a, qty: 2, unitPriceGross: 10 }, { productId: b, qty: 1, unitPriceGross: 20 }], platnosc), { now: T0 })).orderId!
  const [la, lb] = await linie(id)
  return { id, a, b, la: la!.id, lb: lb!.id }
}
const karta = async (id: string) => (await daneKarty(db, id, { userId: 'u', uprawnienia: WLASCICIEL }, { env: ENV }))!.edycja

/** Każda zmiana pozycji (dodanie, ilość, cena, usunięcie) odmawia tym samym komunikatem; stan, kwota i pozycje bez zmian. */
async function wszystkieOdmawiaja(z: Awaited<ReturnType<typeof zamowienie>>, komunikat: string): Promise<void> {
  const przed = { suma: await suma(z.id), stan: await stockOf(db, z.a), linie: (await linie(z.id)).map((l) => [l.id, l.qty]) }
  await expect(addOrderLine(db, z.id, { productId: z.b, qty: 1, priceGrossGr: 500 })).rejects.toThrow(komunikat)
  const nowa = (await db.orderLine.findUniqueOrThrow({ where: { id: z.la } })).qty + 1
  await expect(changeLineQty(db, z.id, z.la, nowa)).rejects.toThrow(komunikat)
  await expect(changeLinePrice(db, z.id, z.la, { priceGrossGr: 1500 })).rejects.toThrow(komunikat)
  await expect(removeOrderLine(db, z.id, z.lb)).rejects.toThrow(komunikat)
  // karta: „Edytuj” pozycji nieaktywne z tym powodem, zapis sekcji i „Dodaj pozycję” odrzucone
  expect(await karta(z.id)).toMatchObject({ mozna: false, powod: komunikat })
  const w = await zapiszPozycje(db, { orderId: z.id, userId: 'u', uprawnienia: WLASCICIEL, zmiany: [{ lineId: z.la, ilosc: String(nowa) }] }, ENV)
  expect(w.zapisane).toBe(0)
  expect(w.blad).toContain(komunikat)
  const sku = (await db.product.findUniqueOrThrow({ where: { id: z.b } })).sku
  expect((await dodajPozycje(db, { orderId: z.id, userId: 'u', uprawnienia: WLASCICIEL, sku, ilosc: '1', cena: '' }, ENV)).blad).toBe(komunikat)
  expect({ suma: await suma(z.id), stan: await stockOf(db, z.a), linie: (await linie(z.id)).map((l) => [l.id, l.qty]) }).toEqual(przed)
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
})

describe('pozycje po utworzeniu przesyłki (E3: blokada tylko, gdy etykieta niesie pieniądze)', () => {
  it('za pobraniem: aktywna przesyłka (tworzenie, utworzona, niepewna) blokuje dodanie, ilość, cenę i usunięcie; przewoźnik bez anulowania z Kompletora = komunikat z wyjściem bez anulowania; anulowana nie blokuje', async () => {
    const z = await zamowienie({ pobranie: true })
    const przed = await suma(z.id)
    for (const [i, state] of (['TWORZENIE', 'UTWORZONA', 'NIEJEDNOZNACZNA'] as const).entries()) {
      const s = await db.shipment.create({ data: { orderId: z.id, packageNo: 1, reference: `ref-e3-${i}`, adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', state, codAmount: 40 } })
      await wszystkieOdmawiaja(z, KOMUNIKAT_PRZESYLKA_POZYCJE_BEZ_ANULOWANIA)
      await db.shipment.update({ where: { id: s.id }, data: { state: 'ANULOWANA' } })
    }
    // zapis sekcji z kilkoma zmianami przy blokadzie = jeden komunikat, w całości
    await db.shipment.create({ data: { orderId: z.id, packageNo: 1, reference: 'ref-e3-d3', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', state: 'UTWORZONA', codAmount: 40 } })
    const w = await zapiszPozycje(db, { orderId: z.id, userId: 'u', uprawnienia: WLASCICIEL, zmiany: [{ lineId: z.la, ilosc: '5' }, { lineId: z.lb, ilosc: '3' }, { lineId: z.lb, usun: true }] }, ENV)
    expect(w).toMatchObject({ zapisane: 0, blad: `Nie zapisano: Zmiany pozycji: ${KOMUNIKAT_PRZESYLKA_POZYCJE_BEZ_ANULOWANIA}` })
    await db.shipment.updateMany({ where: { orderId: z.id, reference: 'ref-e3-d3' }, data: { state: 'ANULOWANA' } })
    expect(KOMUNIKAT_PRZESYLKA_POZYCJE_BEZ_ANULOWANIA).toMatch(/Dodaj zamówienie/)
    expect(KOMUNIKAT_PRZESYLKA_POZYCJE_BEZ_ANULOWANIA).toMatch(/w panelu przewoźnika/)
    expect(await karta(z.id)).toMatchObject({ mozna: true, powod: null, ostrzezenie: null })
    expect(await changeLineQty(db, z.id, z.la, 3)).toMatchObject({ reserved: 1 })
    expect(Number(await suma(z.id)) - Number(przed)).toBe(10) // +1 szt. po 10 zł
    await expectInvariants(db)
  })

  it('za pobraniem u przewoźnika z anulowaniem w Kompletorze (Wysyłam z Allegro): komunikat „anuluj przesyłkę i utwórz ponownie”', async () => {
    const z = await zamowienie({ pobranie: true })
    await db.shipment.create({ data: { orderId: z.id, packageNo: 1, reference: 'ref-e3-allegro', adapterKey: 'allegro.wysylam.zapis.v1', carrier: 'ALLEGRO', state: 'UTWORZONA', codAmount: 40 } })
    await wszystkieOdmawiaja(z, KOMUNIKAT_PRZESYLKA_POZYCJE)
    expect(KOMUNIKAT_PRZESYLKA_POZYCJE).toMatch(/Anuluj przesyłkę/)
    // jedna reguła z podziałem: przycisk „Podziel” znika, rdzeń podziału odmawia przy pobraniu z etykietą
    expect(await karta(z.id)).toMatchObject({ podzialPoEtykiecie: true })
    await expect(splitOrder(db, z.id, { [z.lb]: 1 })).rejects.toThrow(/pobraniem/)
  })

  it('opłacone z góry z aktywną przesyłką bez kwoty: zmiana pozycji przechodzi, karta ostrzega o paczce i gabarycie; przesyłka z kwotą pobrania blokuje mimo opłacenia', async () => {
    const z = await zamowienie()
    expect((await db.order.findUniqueOrThrow({ where: { id: z.id } })).paymentState).toBe('PAID')
    const s = await db.shipment.create({ data: { orderId: z.id, packageNo: 1, reference: 'ref-e3-oplacone', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', state: 'UTWORZONA' } })
    expect(await karta(z.id)).toMatchObject({ mozna: true, powod: null, ostrzezenie: OSTRZEZENIE_PRZESYLKA_POZYCJE })
    expect(await changeLineQty(db, z.id, z.la, 3)).toMatchObject({ reserved: 1 })
    const w = await zapiszPozycje(db, { orderId: z.id, userId: 'u', uprawnienia: WLASCICIEL, zmiany: [{ lineId: z.lb, ilosc: '2' }] }, ENV)
    expect(w).toMatchObject({ blad: null, zapisane: 1 })
    expect(await karta(z.id)).toMatchObject({ mozna: true, ostrzezenie: OSTRZEZENIE_PRZESYLKA_POZYCJE })
    await db.shipment.update({ where: { id: s.id }, data: { codAmount: 70 } })
    await wszystkieOdmawiaja(z, KOMUNIKAT_PRZESYLKA_POZYCJE_BEZ_ANULOWANIA)
    await db.shipment.update({ where: { id: s.id }, data: { state: 'ANULOWANA' } })
    expect(await karta(z.id)).toMatchObject({ mozna: true, powod: null, ostrzezenie: null })
  })

  it('podział zamówienia opłaconego przy przesyłce działa (ta sama reguła co pozycje: blokada tylko przy pobraniu)', async () => {
    const z = await zamowienie()
    await db.shipment.create({ data: { orderId: z.id, packageNo: 1, reference: 'ref-e3-podzial', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', state: 'UTWORZONA' } })
    expect(await karta(z.id)).toMatchObject({ mozna: true, powod: null, powodStatusu: null, podzialPoEtykiecie: false })
    await expect(splitOrder(db, z.id, { [z.lb]: 1 })).resolves.toMatchObject({ packageNo: 2 })
  })
})

describe('pozycje po dokumencie sprzedaży (E3)', () => {
  it('dokument wFirmy przed rozchodem (wystawiany albo wystawiony) blokuje; próba z jednoznacznym błędem nie', async () => {
    const z = await zamowienie()
    const p = await db.invoiceAttempt.create({ data: { orderId: z.id, packageNo: 1, attemptNo: 1, idExternal: `${z.id}/1/1`, state: 'SENDING', documentOnly: true } })
    await wszystkieOdmawiaja(z, KOMUNIKAT_DOKUMENT_POZYCJE)
    await db.invoiceAttempt.update({ where: { id: p.id }, data: { state: 'ISSUED' } })
    await wszystkieOdmawiaja(z, KOMUNIKAT_DOKUMENT_POZYCJE)
    await db.invoiceAttempt.update({ where: { id: p.id }, data: { state: 'FAILED', lastError: 'wFirma: błąd walidacji kontrahenta' } })
    expect(await karta(z.id)).toMatchObject({ mozna: true, powod: null })
    expect(await changeLineQty(db, z.id, z.la, 3)).toMatchObject({ reserved: 1 })
  })

  it('najnowsza próba wFirmy bez odpowiedzi (timeout) blokuje z podpowiedzią „Ponów fakturę”', async () => {
    const z = await zamowienie()
    await db.invoiceAttempt.create({ data: { orderId: z.id, packageNo: 1, attemptNo: 1, idExternal: `${z.id}/1/1`, state: 'FAILED', lastError: 'timeout: faktury nie znaleziono po 3 próbach' } })
    await wszystkieOdmawiaja(z, KOMUNIKAT_FAKTURA_NIEWIADOMA_POZYCJE)
  })

  it('faktura KSeF wysłana blokuje; odrzucona bez śladu wysyłki nie (Ponów składa XML z bazy); faktura z BaseLinkera blokuje', async () => {
    const z = await zamowienie()
    const s = await db.ksefInvoiceDraft.create({ data: { id: `ksef-${z.id}`, orderId: z.id, packageNo: 1, status: 'WYSLANA', numer: 'FV/E3/1', wersjaSchemy: 'FA(3)', bruttoGr: 4000, nettoGr: 3252, sesjaRef: 'sesja-fikcyjna' } })
    await wszystkieOdmawiaja(z, KOMUNIKAT_DOKUMENT_POZYCJE)
    await db.ksefInvoiceDraft.update({ where: { id: s.id }, data: { status: 'ODRZUCONA', sesjaRef: null, hasheWyslane: { set: [] } } })
    expect(await karta(z.id)).toMatchObject({ mozna: true, powod: null })
    expect(await changeLineQty(db, z.id, z.la, 3)).toMatchObject({ reserved: 1 })
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 1, blOrderId: 1, number: 'BL/E3', kind: 'normal', dateAdd: T0, fetchedAt: T0, orderId: z.id } })
    await wszystkieOdmawiaja(z, KOMUNIKAT_DOKUMENT_POZYCJE)
  })

  it('kopia faktury BL po numerze zamówienia BL, jeszcze nierozliczona (orderId pusty), blokuje; korekta BL nie', async () => {
    const z = await zamowienie()
    await db.order.update({ where: { id: z.id }, data: { blOrderId: 7101 } })
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 2, blOrderId: 7101, number: 'BL/KOR', kind: 'correcting', dateAdd: T0, fetchedAt: T0, orderId: z.id } })
    expect(await karta(z.id)).toMatchObject({ mozna: true, powod: null })
    expect(await changeLineQty(db, z.id, z.la, 3)).toMatchObject({ reserved: 1 })
    await db.blInvoiceSnapshot.create({ data: { blInvoiceId: 3, blOrderId: 7101, number: 'BL/E3/2', kind: 'normal', dateAdd: T0, fetchedAt: T0, orderId: null } })
    await wszystkieOdmawiaja(z, KOMUNIKAT_DOKUMENT_POZYCJE)
  })
})

describe('wyszukiwarka „Dodaj pozycję” (E3)', () => {
  it('SKU, nazwa albo EAN; aktywne produkty firmy z ceną i stanem dostępnym; za krótka fraza; inna firma nie widzi', async () => {
    const a = await product(db, 'E3-SZUKAJ-1', 7)
    await product(db, 'E3-SZUKAJ-2', 0)
    const nieaktywny = await product(db, 'E3-SZUKAJ-3', 5)
    await db.product.update({ where: { id: nieaktywny }, data: { active: false } })
    await db.product.update({ where: { id: a }, data: { priceGross: '24.90' } })
    const w = await szukajProduktuDoZamowienia(db, 'E3-SZUKAJ')
    expect(w.blad).toBeNull()
    expect(w.produkty.map((p) => p.sku).sort()).toEqual(['E3-SZUKAJ-1', 'E3-SZUKAJ-2'])
    expect(w.produkty.find((p) => p.sku === 'E3-SZUKAJ-1')).toMatchObject({ id: a, dostepne: 7, cena: 24.9, bezStanu: false })
    expect((await szukajProduktuDoZamowienia(db, 'E')).blad).toMatch(/co najmniej 2 znaki/)
    expect((await szukajProduktuDoZamowienia(dbB, 'E3-SZUKAJ')).produkty).toEqual([])
  })
})
