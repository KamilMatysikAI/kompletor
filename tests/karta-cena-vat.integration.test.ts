// cena i VAT pozycji z karty zamówienia (rdzeń z historią, dziennikiem zmian i uprawnieniem), bramka edycji
// raz przed pętlą zapisu sekcji i wyszukiwarka okna „Zamień produkt”. Dane fikcyjne, zero połączeń
// zewnętrznych (kanał, wFirma i kurierzy nietknięci: zmiana jest tylko w Kompletorze).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { permissionsOf } from '@/lib/auth/uprawnienia'
import { historiaZamowienia } from '@/lib/karta/historia'
import { daneKarty } from '@/lib/karta/dane'
import { BLEDY_KARTY } from '@/lib/karta/komunikaty'
import { zmienCene } from '@/lib/karta/pozycje'
import { szukajZamiennika } from '@/lib/karta/szukaj-produktu'
import { zapiszPozycje, zmianyZFormularza } from '@/lib/karta/zapis-pozycji'
import { AUDIT_POZYCJA, changeLinePrice, KOMUNIKAT_KONFLIKT_POZYCJI, KOMUNIKAT_PRZESYLKA_POZYCJE_BEZ_ANULOWANIA, OSTRZEZENIE_PRZESYLKA_POZYCJE } from '@/lib/rdzen/edycja'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_B, testDb, truncateAll } from './db'
import { bundle, expectInvariants, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const ENV = { EKRANY_PRACA: '1' }
const WLASCICIEL = permissionsOf({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] })
const BIURO = permissionsOf({ role: 'BIURO', permissions: [], deniedPermissions: [] })
const linie = async (orderId: string) => db.orderLine.findMany({ where: { orderId }, orderBy: { externalLineId: 'asc' } })
const suma = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id } })).totalGross.toString()

async function praca(): Promise<void> {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
})

describe('pola ceny i VAT z formularza', () => {
  it('czyta cena_/vat_ obok ilości; reszta pól pominięta', () => {
    const f = new FormData()
    f.set('ilosc_l1', '2')
    f.set('cena_l1', ' 24,90 ')
    f.set('vat_l1', '8')
    f.set('cena_zle id', '1')
    expect(zmianyZFormularza(f)).toEqual([{ lineId: 'l1', ilosc: '2', cena: '24,90', vat: '8' }])
  })
})

describe('cena i VAT pozycji', () => {
  it('zmiana ceny i VAT jednym zapisem: kwota zamówienia o różnicę × ilość, historia, dziennik, kwota zapłacona zapamiętana', async () => {
    await praca()
    const a = await product(db, 'A139-A', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 3, unitPriceGross: 10 }]), { now: T0 })).orderId!
    const [la] = await linie(id)
    expect(await suma(id)).toBe('100')
    const w = await zapiszPozycje(db, { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL, zmiany: [{ lineId: la!.id, ilosc: '3', cena: '12,50', vat: '8' }] }, ENV)
    expect(w).toMatchObject({ blad: null, zmiana: true, zapisane: 1, info: 'pozycje.jedna' })
    const l = await db.orderLine.findUniqueOrThrow({ where: { id: la!.id } })
    expect(l.unitPriceGross.toString()).toBe('12.5')
    expect(l.vatRate).toBe('8')
    expect(await suma(id)).toBe('107.5') // 100 + (12,50 − 10) × 3
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    // opłacone zamówienie: rozliczenie (dopłata / zwrot różnicy) liczy się od kwoty sprzed edycji
    expect(flagsOf(o)).toMatchObject({ edytowaneLokalnie: true, kwotaZaplacona: '100.00' })
    const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: id, kind: 'ZMIANA_CENY' } })
    expect(ev.actorId).toBe('user:u-test')
    expect(ev.data).toMatchObject({ cenaZ: '10.00', cenaNa: '12.50', vatZ: null, vatNa: '8' })
    const audyt = await db.auditLog.findFirstOrThrow({ where: { entity: AUDIT_POZYCJA, entityId: la!.id } })
    expect(audyt.before).toMatchObject({ cena: '10.00', vat: null, suma: '100.00' })
    expect(audyt.after).toMatchObject({ cena: '12.50', vat: '8', suma: '107.50', zamowienie: id })
    // historia karty mówi słowami, co się zmieniło
    const h = await historiaZamowienia(db, id, {})
    expect(h.map((x) => x.opis).join('\n')).toMatch(/Zmiana ceny albo VAT w Kompletorze: cena 10,00 → 12,50 zł, VAT z katalogu → 8/)
    // ta sama cena i stawka drugi raz: bez zmian
    expect(await zapiszPozycje(db, { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL, zmiany: [{ lineId: la!.id, cena: '12.50', vat: '8' }] }, ENV)).toMatchObject({ blad: null, zmiana: false, info: 'pozycje.brak' })
    // stan magazynu nietknięty (cena nie rusza rezerwacji)
    expect((await stockOf(db, a)).reserved).toBe(3)
    await expectInvariants(db)
  })

  it('uprawnienie: biuro bez „cena i VAT” zmienia ilość, cena odrzucona z komunikatem; z nadanym uprawnieniem przechodzi', async () => {
    await praca()
    const a = await product(db, 'A139-B', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    const [la] = await linie(id)
    const w = await zapiszPozycje(db, { orderId: id, userId: 'u-biuro', uprawnienia: BIURO, zmiany: [{ lineId: la!.id, ilosc: '2', cena: '15' }] }, ENV)
    expect(w).toMatchObject({ zapisane: 1, odrzucone: 1 })
    expect(w.blad).toMatch(/SKU A139-B: cena i VAT: Nie masz uprawnienia/)
    const l = await db.orderLine.findUniqueOrThrow({ where: { id: la!.id } })
    expect(l.qty).toBe(2)
    expect(l.unitPriceGross.toString()).toBe('10')
    const z = await zmienCene(db, { orderId: id, userId: 'u-biuro', uprawnienia: BIURO, lineId: la!.id, cena: '15', vat: '' }, ENV)
    expect(z.blad).toBe(BLEDY_KARTY['bez-uprawnienia'])
    const zUpr = permissionsOf({ role: 'BIURO', permissions: ['zamowienia.ceny_pozycji'], deniedPermissions: [] })
    expect(await zmienCene(db, { orderId: id, userId: 'u-biuro', uprawnienia: zUpr, lineId: la!.id, cena: '15', vat: '' }, ENV)).toMatchObject({ blad: null, zmiana: true })
    expect(await suma(id)).toBe('120') // 100 + 10 (druga sztuka) + (15 − 10) × 2
    await expectInvariants(db)
  })

  it('odmowy: zła cena, stawka spoza listy, dokument sprzedaży w drodze, część pozycji dosłana, VAT zestawu', async () => {
    await praca()
    const a = await product(db, 'A139-C', 10)
    const b = await product(db, 'A139-D', 10)
    const s = await bundle(db, 'A139-ZES', [{ id: a, qty: 1 }])
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }, { productId: b, qty: 2 }, { productId: s, qty: 1 }]), { now: T0 })).orderId!
    const [la, lb, ls] = await linie(id)
    const z = { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL }
    expect((await zmienCene(db, { ...z, lineId: la!.id, cena: '12,345', vat: '' }, ENV)).blad).toMatch(/Cena: liczba nieujemna/)
    expect((await zmienCene(db, { ...z, lineId: la!.id, cena: '', vat: '7' }, ENV)).blad).toMatch(/Stawka VAT/)
    // zestaw: cena tak, VAT nie (stawki ze składników)
    expect((await zmienCene(db, { ...z, lineId: ls!.id, cena: '', vat: '8' }, ENV)).blad).toMatch(/Zestaw: stawki VAT wynikają ze składników/)
    expect(await zmienCene(db, { ...z, lineId: ls!.id, cena: '30', vat: '' }, ENV)).toMatchObject({ blad: null, zmiana: true })
    // część pozycji poza paczką (dosłana albo zamieniona): zwrot liczył się po starej cenie
    await db.orderLine.update({ where: { id: lb!.id }, data: { qtyRejected: 1 } })
    expect((await zmienCene(db, { ...z, lineId: lb!.id, cena: '20', vat: '' }, ENV)).blad).toMatch(/dosłana albo zamieniona/)
    await db.orderLine.update({ where: { id: lb!.id }, data: { qtyRejected: 0 } })
    // dokument sprzedaży wystawiony albo w drodze
    await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED' } })
    expect((await zmienCene(db, { ...z, lineId: la!.id, cena: '20', vat: '' }, ENV)).blad).toMatch(/Dokument sprzedaży jest już wystawiony/)
    expect((await db.orderLine.findUniqueOrThrow({ where: { id: la!.id } })).unitPriceGross.toString()).toBe('10')
    await expectInvariants(db)
  })

  it('konto w podglądzie: cena nie zmienia się (bramka trybu PRACA), izolacja firm', async () => {
    const a = await product(db, 'A139-E', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    const [la] = await linie(id)
    expect((await zmienCene(db, { orderId: id, userId: 'u', uprawnienia: WLASCICIEL, lineId: la!.id, cena: '20', vat: '' }, ENV)).blad).toBe(BLEDY_KARTY['tryb-podgladu'])
    await praca()
    expect((await zmienCene(dbB, { orderId: id, userId: 'u', uprawnienia: WLASCICIEL, lineId: la!.id, cena: '20', vat: '' }, ENV)).blad).toBe(BLEDY_KARTY['brak-zamowienia'])
    expect((await db.orderLine.findUniqueOrThrow({ where: { id: la!.id } })).unitPriceGross.toString()).toBe('10')
  })
})

describe('bramka edycji raz przed pętlą', () => {
  it('konto w podglądzie i trzy zmiany pozycji: jedna odmowa dla całej sekcji, decyzja o braku dalej zapisana (na sucho)', async () => {
    const a = await product(db, 'A139-F', 10)
    const b = await product(db, 'A139-G', 10)
    const c = await product(db, 'A139-H', 0)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }, { productId: b, qty: 1 }, { productId: c, qty: 1 }]), { now: T0 })).orderId!
    const [la, lb, lc] = await linie(id)
    const w = await zapiszPozycje(
      db,
      { orderId: id, userId: 'u-test', uprawnienia: WLASCICIEL, zmiany: [{ lineId: la!.id, ilosc: '2' }, { lineId: lb!.id, usun: true }, { lineId: lc!.id, cena: '11', decyzja: 'POCZEKAJ' }] },
      ENV,
    )
    expect(w).toMatchObject({ zapisane: 1, odrzucone: 1 })
    expect(w.blad).toBe(`Zapisano 1 zmianę, nie zapisano: Zmiany pozycji: ${BLEDY_KARTY['tryb-podgladu']}`)
    expect((await db.shortageDecision.findFirstOrThrow({ where: { orderLineId: lc!.id } })).dryRun).toBe(true)
    expect((await stockOf(db, a)).reserved).toBe(1)
    expect((await db.orderLine.findUniqueOrThrow({ where: { id: lb!.id } })).removed).toBe(false)
  })

  it('bez zmian pozycji (same decyzje) bramka edycji nie jest pytana: osoba bez edycji pozycji zapisuje decyzję', async () => {
    await praca()
    const c = await product(db, 'A139-I', 0)
    const id = (await ingestOrder(db, order([{ productId: c, qty: 1 }]), { now: T0 })).orderId!
    const [lc] = await linie(id)
    const tylkoBraki = new Set(['panel.podglad', 'braki.decyzje'])
    // ilość równa obecnej i cena równa obecnej to nie zmiana
    const w = await zapiszPozycje(db, { orderId: id, userId: 'u-test', uprawnienia: tylkoBraki, zmiany: [{ lineId: lc!.id, ilosc: '1', cena: '10,00', decyzja: 'POCZEKAJ' }] }, ENV)
    expect(w).toMatchObject({ blad: null, zapisane: 1 })
  })
})

describe('wyszukiwarka okna „Zamień produkt”', () => {
  it('SKU, nazwa i EAN; tylko aktywne produkty magazynowe; powód przy tym samym produkcie, innej jednostce i za małym stanie', async () => {
    const wlasny = await product(db, 'A139-HERB-1', 0)
    await product(db, 'A139-HERB-2', 5)
    await product(db, 'A139-HERB-3', 1)
    await product(db, 'A139-HERB-G', 500, { unit: 'KG' })
    await db.product.update({ where: { id: await product(db, 'A139-HERB-OFF', 9) }, data: { active: false } })
    await db.product.update({ where: { id: await product(db, 'A139-EAN', 9) }, data: { ean: '5901234123457' } })
    await bundle(db, 'A139-HERB-ZESTAW', [{ id: wlasny, qty: 1 }])
    const dla = { sku: 'A139-HERB-1', jednostka: 'SZT' as const, potrzeba: 2 }
    const r = await szukajZamiennika(db, 'herb', dla)
    expect(r.blad).toBeNull()
    expect(r.produkty.map((p) => [p.sku, p.powod])).toEqual([
      ['A139-HERB-1', 'to ten sam produkt'],
      ['A139-HERB-2', null],
      ['A139-HERB-3', 'za mało na stanie (potrzeba 2)'],
      ['A139-HERB-G', 'inna jednostka (sztuki i gramy)'],
    ])
    expect(r.produkty.find((p) => p.sku === 'A139-HERB-2')).toMatchObject({ dostepne: 5, nazwa: 'Towar testowy A139-HERB-2' })
    expect((await szukajZamiennika(db, '5901234123457', dla)).produkty.map((p) => p.sku)).toEqual(['A139-EAN'])
    expect((await szukajZamiennika(db, 'h', dla)).blad).toMatch(/co najmniej 2 znaki/)
    // izolacja firm: firma B nie widzi produktów firmy A
    expect((await szukajZamiennika(dbB, 'herb', dla)).produkty).toEqual([])
  })
})

describe('poprawki po', () => {
  // formularz karty tak, jak wysyła go przeglądarka: pola z wartościami i ukryte *_bylo_ z chwili renderu
  const formularz = (lineId: string, r: { ilosc: string; cena: string; vat: string }, wpis: { ilosc?: string; cena?: string; vat?: string } = {}) => {
    const f = new FormData()
    f.set(`ilosc_${lineId}`, wpis.ilosc ?? r.ilosc)
    f.set(`ilosc_bylo_${lineId}`, r.ilosc)
    f.set(`cena_${lineId}`, wpis.cena ?? r.cena)
    f.set(`cena_bylo_${lineId}`, r.cena)
    f.set(`vat_${lineId}`, wpis.vat ?? r.vat)
    f.set(`vat_bylo_${lineId}`, r.vat)
    return zmianyZFormularza(f)
  }

  it('drugi zapis z tym samym zrzutem formularza nie cofa cudzej ceny; zmiana tej samej pozycji = odmowa „odśwież kartę”', async () => {
    await praca()
    const a = await product(db, 'A139-W1', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 3, unitPriceGross: 10 }]), { now: T0 })).orderId!
    const [la] = await linie(id)
    const render = { ilosc: '3', cena: '10,00', vat: '' }
    const z = { orderId: id, userId: 'u-a', uprawnienia: WLASCICIEL }
    // osoba B zmienia cenę na 12,00
    expect(await zapiszPozycje(db, { ...z, userId: 'u-b', zmiany: formularz(la!.id, render, { cena: '12,00' }) }, ENV)).toMatchObject({ blad: null, zapisane: 1 })
    expect(await suma(id)).toBe('106')
    // osoba A (ten sam render) zmienia tylko ilość 3 → 4: cena B zostaje, ilość się zapisuje
    expect(await zapiszPozycje(db, { ...z, zmiany: formularz(la!.id, render, { ilosc: '4' }) }, ENV)).toMatchObject({ blad: null, zapisane: 1 })
    let l = await db.orderLine.findUniqueOrThrow({ where: { id: la!.id } })
    expect([l.qty, l.unitPriceGross.toString()]).toEqual([4, '12'])
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'ZMIANA_CENY' } })).toBe(1)
    // A zmienia ilość i cenę z tego samego renderu: obie części to konflikt, nic się nie zmienia
    const w = await zapiszPozycje(db, { ...z, zmiany: formularz(la!.id, render, { ilosc: '5', cena: '11,00' }) }, ENV)
    expect(w).toMatchObject({ zapisane: 0, odrzucone: 2 })
    expect(w.blad).toContain(KOMUNIKAT_KONFLIKT_POZYCJI)
    l = await db.orderLine.findUniqueOrThrow({ where: { id: la!.id } })
    expect([l.qty, l.unitPriceGross.toString()]).toEqual([4, '12'])
    // rdzeń sprawdza to samo pod blokadą (wyścig między odczytem a zapisem)
    await expect(changeLinePrice(db, id, la!.id, { priceGrossGr: 1100, bylo: { priceGrossGr: 1000 } })).rejects.toThrow(KOMUNIKAT_KONFLIKT_POZYCJI)
    expect(await changeLinePrice(db, id, la!.id, { priceGrossGr: 1100, bylo: { priceGrossGr: 1200 } })).toEqual({ zmiana: true })
    await expectInvariants(db)
  })

  it('przesyłka z pobraniem blokuje zmianę ceny w rdzeniu i na karcie; opłacone z góry z przesyłką: cena się zmienia, karta ostrzega', async () => {
    await praca()
    const a = await product(db, 'A139-W2', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1, unitPriceGross: 10 }], { paymentState: 'COD', paymentMethod: 'Za pobraniem' }), { now: T0 })).orderId!
    const [la] = await linie(id)
    const stany = ['TWORZENIE', 'UTWORZONA', 'NIEJEDNOZNACZNA'] as const
    for (const [i, state] of stany.entries()) {
      const s = await db.shipment.create({ data: { orderId: id, packageNo: 1, reference: `ref-a139-${i}`, adapterKey: 'dpd', carrier: 'DPD', state } })
      const w = await zapiszPozycje(db, { orderId: id, userId: 'u', uprawnienia: WLASCICIEL, zmiany: [{ lineId: la!.id, cena: '15' }] }, ENV)
      expect(w.blad).toContain(KOMUNIKAT_PRZESYLKA_POZYCJE_BEZ_ANULOWANIA) // wspólna blokada zmian pozycji po przesyłce z pobraniem
      const d = await daneKarty(db, id, { userId: 'u', uprawnienia: WLASCICIEL }, { env: ENV })
      expect(d!.edycja).toMatchObject({ mozna: false, powod: KOMUNIKAT_PRZESYLKA_POZYCJE_BEZ_ANULOWANIA })
      await db.shipment.update({ where: { id: s.id }, data: { state: 'ANULOWANA' } })
    }
    expect((await db.orderLine.findUniqueOrThrow({ where: { id: la!.id } })).unitPriceGross.toString()).toBe('10')
    // bez aktywnej przesyłki: cena się zmienia
    expect((await daneKarty(db, id, { userId: 'u', uprawnienia: WLASCICIEL }, { env: ENV }))!.edycja).toMatchObject({ ceny: true, mozna: true })
    expect(await zapiszPozycje(db, { orderId: id, userId: 'u', uprawnienia: WLASCICIEL, zmiany: [{ lineId: la!.id, cena: '15' }] }, ENV)).toMatchObject({ blad: null, zapisane: 1 })
    // opłacone z góry: przesyłka bez kwoty nie blokuje ceny
    const b = await product(db, 'A139-W2-OPL', 10)
    const id2 = (await ingestOrder(db, order([{ productId: b, qty: 1, unitPriceGross: 10 }]), { now: T0 })).orderId!
    const [lb] = await linie(id2)
    await db.shipment.create({ data: { orderId: id2, packageNo: 1, reference: 'ref-a139-opl', adapterKey: 'dpd', carrier: 'DPD', state: 'UTWORZONA' } })
    expect((await daneKarty(db, id2, { userId: 'u', uprawnienia: WLASCICIEL }, { env: ENV }))!.edycja).toMatchObject({ ceny: true, mozna: true, ostrzezenie: OSTRZEZENIE_PRZESYLKA_POZYCJE })
    expect(await zapiszPozycje(db, { orderId: id2, userId: 'u', uprawnienia: WLASCICIEL, zmiany: [{ lineId: lb!.id, cena: '15' }] }, ENV)).toMatchObject({ blad: null, zapisane: 1 })
  })

  it('VAT „23.00” z kanału i „23” z formularza: brak zmiany, wpisu historii i flagi „edytowane lokalnie”', async () => {
    await praca()
    const a = await product(db, 'A139-W4', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1, unitPriceGross: 10 }]), { now: T0 })).orderId!
    const [la] = await linie(id)
    await db.orderLine.update({ where: { id: la!.id }, data: { vatRate: '23.00' } })
    const z = { orderId: id, userId: 'u', uprawnienia: WLASCICIEL }
    // stary formularz bez ukrytych pól i nowy z nimi
    expect(await zapiszPozycje(db, { ...z, zmiany: [{ lineId: la!.id, ilosc: '1', cena: '10,00', vat: '23' }] }, ENV)).toMatchObject({ blad: null, zmiana: false, info: 'pozycje.brak' })
    expect(await zapiszPozycje(db, { ...z, zmiany: formularz(la!.id, { ilosc: '1', cena: '10,00', vat: '23' }) }, ENV)).toMatchObject({ blad: null, zmiana: false })
    expect(await changeLinePrice(db, id, la!.id, { vatRate: '23' })).toEqual({ zmiana: false })
    expect(flagsOf(await db.order.findUniqueOrThrow({ where: { id } })).edytowaneLokalnie).toBeFalsy()
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'ZMIANA_CENY' } })).toBe(0)
    // zmiana samej ceny zostawia stawkę z kanału bez przepisywania
    expect(await changeLinePrice(db, id, la!.id, { priceGrossGr: 1100, vatRate: '23' })).toEqual({ zmiana: true })
    const l = await db.orderLine.findUniqueOrThrow({ where: { id: la!.id } })
    expect([l.vatRate, l.unitPriceGross.toString()]).toEqual(['23.00', '11'])
    expect((await db.orderEvent.findFirstOrThrow({ where: { orderId: id, kind: 'ZMIANA_CENY' } })).data).toMatchObject({ vatZ: '23.00', vatNa: '23.00' })
    await expectInvariants(db)
  })

  it('zmienCene wymaga tej samej bramki co karta: edycji pozycji i uprawnienia do cen', async () => {
    await praca()
    const a = await product(db, 'A139-D2', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: T0 })).orderId!
    const [la] = await linie(id)
    const tylkoCeny = new Set(['panel.podglad', 'zamowienia.ceny_pozycji'])
    expect((await zmienCene(db, { orderId: id, userId: 'u', uprawnienia: tylkoCeny, lineId: la!.id, cena: '15', vat: '' }, ENV)).blad).toBe(BLEDY_KARTY['bez-uprawnienia'])
    expect((await db.orderLine.findUniqueOrThrow({ where: { id: la!.id } })).unitPriceGross.toString()).toBe('10')
  })
})
