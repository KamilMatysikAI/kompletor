// podgląd przesyłki (także Wysyłam z Allegro). Idempotencja, izolacja dwóch firm, „nie dotyczy”, kolejność źródeł gabarytu, brak danych
// osobowych w wierszu, brak skutków w zamówieniu. Dane fikcyjne, zero połączeń zewnętrznych.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { BladPrzesylki, podgladPrzesylki, powodNieDotyczy, prepareForOrder, PUNKT_PRZY_NADANIU } from '@/lib/wysylka/podglad'
import { rejectShortagesAtAcceptance, shipLater } from '@/lib/rdzen/brakuje'
import { powodDokumentuLubPrzesylki, splitOrder } from '@/lib/rdzen/edycja'
import { allocate } from '@/lib/rdzen/przydzial'
import { ingestOrder, markPaid } from '@/lib/rdzen/zamowienia'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const PACZKOMAT = 'Paczkomaty InPost'
const KLUCZE = `1:${'4'.repeat(64)}`
const DPD = 'Kurier DPD'

async function zamowienie(deliveryMethod: string, opts: { qty?: number; paymentState?: 'PAID' | 'COD'; paymentMethod?: string; channel?: 'ALLEGRO' } = {}, klient = db): Promise<string> {
  const pid = await product(klient, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const r = await ingestOrder(klient, order([{ productId: pid, qty: opts.qty ?? 2, unitPriceGross: 25 }], { deliveryMethod, paymentState: opts.paymentState ?? 'PAID', paymentMethod: opts.paymentMethod ?? 'Przelew', ...(opts.channel ? { channel: opts.channel } : {}) }), { now: T0 })
  return r.orderId!
}

async function cwiczenie(orderId: string, parcelSize: string, startedAt = T0): Promise<void> {
  await db.packDrill.create({ data: { orderId, actorId: 'u1', startedAt, finishedAt: startedAt, outcome: 'SPAKOWANE', parcelSize } })
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
})

describe('prepareForOrder', () => {
  it('zapisuje podgląd paczkomatu bez danych klienta (punkt sprawdzi nadanie) i nie zmienia zamówienia ani rezerwacji', async () => {
    const id = await zamowienie(PACZKOMAT)
    const przed = await db.order.findUniqueOrThrow({ where: { id }, include: { reservations: true, events: true, lines: true } })
    const r = await prepareForOrder(db, id, 'INPOST_B')
    expect(r.wynik).toBe('przygotowane')
    const w = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    expect(w).toMatchObject({ organizationId: ORG_A, packageNo: 1, adapterKey: 'basecourier.v1', carrier: 'PACZKOMATY', courierCode: 'paczkomaty', parcelSize: 'INPOST_B', sideXCm: 19, sideYCm: 38, sideZCm: 64, codAmount: null })
    expect((w.problems as { kod: string }[]).map((p) => p.kod)).toEqual(expect.arrayContaining(['punkt_przy_nadaniu', 'waga_domyslna']))
    expect((w.problems as { kod: string; poziom: string }[]).filter((p) => p.poziom === 'BLAD')).toEqual([])
    expect(await db.order.findUniqueOrThrow({ where: { id }, include: { reservations: true, events: true, lines: true } })).toEqual(przed)
  })

  it('idempotentne: ponowne przygotowanie nadpisuje jeden wiersz, także równolegle', async () => {
    const id = await zamowienie(PACZKOMAT)
    await prepareForOrder(db, id, 'INPOST_A')
    const pierwszy = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    await prepareForOrder(db, id, 'INPOST_C')
    const drugi = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    expect(await db.preparedShipment.count({ where: { orderId: id } })).toBe(1)
    expect(drugi).toMatchObject({ id: pierwszy.id, parcelSize: 'INPOST_C', sideXCm: 41 })
    await Promise.all([prepareForOrder(db, id, 'INPOST_A'), prepareForOrder(db, id, 'INPOST_B')])
    expect(await db.preparedShipment.count({ where: { orderId: id } })).toBe(1)
  })

  it('gabaryt: argument, potem ostatnie ćwiczenie, potem podpowiedź z ostrzeżeniem', async () => {
    const id = await zamowienie(PACZKOMAT, { qty: 5 })
    const zPodpowiedzi = await prepareForOrder(db, id)
    expect(zPodpowiedzi).toMatchObject({ parcel: { gabaryt: 'INPOST_B' } })
    if (zPodpowiedzi.wynik !== 'przygotowane') throw new Error('nie przygotowane')
    expect(zPodpowiedzi.parcel.problems.map((p) => p.kod)).toContain('gabaryt_podpowiedz')
    await cwiczenie(id, 'INPOST_A', new Date(T0.getTime() - 60_000))
    await cwiczenie(id, 'INPOST_C')
    const zCwiczenia = await prepareForOrder(db, id)
    expect(zCwiczenia).toMatchObject({ parcel: { gabaryt: 'INPOST_C' } })
    if (zCwiczenia.wynik !== 'przygotowane') throw new Error('nie przygotowane')
    expect(zCwiczenia.parcel.problems.map((p) => p.kod)).not.toContain('gabaryt_podpowiedz')
    expect(await prepareForOrder(db, id, 'INPOST_A')).toMatchObject({ parcel: { gabaryt: 'INPOST_A' } })
  })

  it('gabaryt spoza przewoźnika = komunikat, bez zapisu', async () => {
    const id = await zamowienie(PACZKOMAT)
    await expect(prepareForOrder(db, id, 'DPD')).rejects.toBeInstanceOf(BladPrzesylki)
    await expect(prepareForOrder(db, id, 'nieznany')).rejects.toBeInstanceOf(BladPrzesylki)
    expect(await db.preparedShipment.count()).toBe(0)
  })

  it('pobranie: COD = totalGross; COD z brakiem = problem, kwota pusta', async () => {
    const id = await zamowienie(DPD, { paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    await prepareForOrder(db, id)
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    const w = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    expect(Number(w.codAmount)).toBe(Number(o.totalGross))
    expect(w).toMatchObject({ carrier: 'DPD', courierCode: 'dpd', parcelSize: 'DPD' })

    const l = await db.orderLine.findFirstOrThrow({ where: { orderId: id } })
    await db.shortage.create({ data: { orderId: id, orderLineId: l.id, productId: l.productId!, qtyBase: 1, state: 'OPEN' } })
    await prepareForOrder(db, id)
    const po = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    expect(po.codAmount).toBeNull()
    expect((po.problems as { kod: string }[]).map((p) => p.kod)).toContain('pobranie')
  })

  async function zBrakiem(id: string): Promise<string> {
    const l = await db.orderLine.findFirstOrThrow({ where: { orderId: id } })
    await db.shortage.create({ data: { orderId: id, orderLineId: l.id, productId: l.productId!, qtyBase: 1, state: 'OPEN' } })
    return l.id
  }
  const COD = { paymentState: 'COD', paymentMethod: 'Za pobraniem' } as const
  const problemPobrania = async (orderId: string) => {
    const w = await db.preparedShipment.findFirstOrThrow({ where: { orderId } })
    expect(w.codAmount).toBeNull()
    return (w.problems as { kod: string; tekst: string }[]).find((p) => p.kod === 'pobranie')?.tekst
  }

  it('„dośle później”: rodzic i podzamówienie bez pewnej kwoty pobrania', async () => {
    const id = await zamowienie(DPD, { ...COD, qty: 3 })
    const linia = await zBrakiem(id)
    const { childOrderId } = await shipLater(db, linia, { now: T0 })
    await prepareForOrder(db, id)
    expect(await problemPobrania(id)).toMatch(/w kilku paczkach/)
    // podzamówienie bez towaru nie ma jeszcze czego wysłać (SHIP_LATER to nie pozycja do zebrania)
    expect(await prepareForOrder(db, childOrderId)).toMatchObject({ wynik: 'nie_dotyczy' })
    await allocate(db, (await db.orderLine.findFirstOrThrow({ where: { orderId: childOrderId } })).productId!)
    await prepareForOrder(db, childOrderId)
    expect(await problemPobrania(childOrderId)).toMatch(/w kilku paczkach/)
    // fikstura nie ma kosztu wysyłki z kanału, więc kwoty paczki nie da się wyliczyć; powód w tekście
    expect(await problemPobrania(id)).toMatch(/kosztu wysyłki/)
  })

  // kwota pobrania paczki z jej pozycji, wysyłka w paczce 1, suma = kwota zamówienia
  async function zamowienieZWysylka(qty: number): Promise<{ id: string; lineId: string }> {
    const pid = await product(db, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
    const r = await ingestOrder(db, order([{ productId: pid, qty, unitPriceGross: 19.9 }], { deliveryMethod: DPD, ...COD, totalGross: qty * 19.9 + 12.99, shippingCostGross: 12.99 }))
    return { id: r.orderId!, lineId: (await db.orderLine.findFirstOrThrow({ where: { orderId: r.orderId! } })).id }
  }
  const kwotaPobrania = async (orderId: string) => Number((await db.preparedShipment.findFirstOrThrow({ where: { orderId } })).codAmount)
  const problemPobraniaLubBrak = async (orderId: string) =>
    ((await db.preparedShipment.findFirstOrThrow({ where: { orderId } })).problems as { kod: string; tekst: string }[]).find((p) => p.kod === 'pobranie')?.tekst

  it('„dośle później” z kosztem wysyłki: paczka 2 = jej pozycje, paczka 1 = reszta z wysyłką', async () => {
    const { id, lineId } = await zamowienieZWysylka(3)
    await db.shortage.create({ data: { orderId: id, orderLineId: lineId, productId: (await db.orderLine.findUniqueOrThrow({ where: { id: lineId } })).productId!, qtyBase: 1, state: 'OPEN' } })
    const { childOrderId } = await shipLater(db, lineId, { now: T0 })
    await prepareForOrder(db, id)
    expect(await kwotaPobrania(id)).toBe(52.79)
    await allocate(db, (await db.orderLine.findFirstOrThrow({ where: { orderId: childOrderId } })).productId!)
    await prepareForOrder(db, childOrderId)
    expect(await kwotaPobrania(childOrderId)).toBe(19.9)
    expect(Math.round((await kwotaPobrania(id)) * 100) + Math.round((await kwotaPobrania(childOrderId)) * 100)).toBe(Math.round(3 * 1990 + 1299))
  })

  it('podział zamówienia: kwoty paczek z pozycji; odrzucenie przy akceptacji obok = nieznana kwota z powodem', async () => {
    const { id, lineId } = await zamowienieZWysylka(4)
    const { childOrderId } = await splitOrder(db, id, { [lineId]: 2 })
    await prepareForOrder(db, id)
    await prepareForOrder(db, childOrderId)
    expect([await kwotaPobrania(id), await kwotaPobrania(childOrderId)]).toEqual([52.79, 39.8])

    await db.orderLine.update({ where: { id: lineId }, data: { qtyRejected: { increment: 1 } } })
    await prepareForOrder(db, id)
    expect(await problemPobrania(id)).toMatch(/w kilku paczkach.*nie pokrywają się/)
  })

  // etykieta przewoźnika ma kwotę pobrania z chwili utworzenia przesyłki. Podział
  // albo „dośle później” po niej dałby paczce 2 automatyczną kwotę obok starej etykiety paczki 1 (klient płaci dwa razy).
  const etykieta = (orderId: string, packageNo: number, codAmount: string | null, state: 'UTWORZONA' | 'ANULOWANA' = 'UTWORZONA') =>
    db.shipment.create({ data: { orderId, packageNo, reference: `ref-a093-${orderId}-${packageNo}-${Math.random()}`, adapterKey: 'dpd', carrier: 'DPD', state, codAmount } })

  it('etykieta paczki 1 przed podziałem = podział i „dośle później” odmawiają, a anulowana etykieta nie blokuje', async () => {
    const { id, lineId } = await zamowienieZWysylka(4)
    await etykieta(id, 1, '92.59')
    await expect(splitOrder(db, id, { [lineId]: 2 })).rejects.toThrow(/przesyłkę u przewoźnika/)
    await db.shortage.create({ data: { orderId: id, orderLineId: lineId, productId: (await db.orderLine.findUniqueOrThrow({ where: { id: lineId } })).productId!, qtyBase: 1, state: 'OPEN' } })
    await expect(shipLater(db, lineId, { now: T0 })).rejects.toThrow(/przesyłkę u przewoźnika/)
    expect(await db.order.count({ where: { parentOrderId: id } })).toBe(0)
    await db.shipment.updateMany({ where: { orderId: id }, data: { state: 'ANULOWANA' } })
    const { childOrderId } = await shipLater(db, lineId, { now: T0 })
    expect(childOrderId).toBeTruthy()
  })

  it('etykieta z kwotą sprzed podziału (powstała mimo blokady) = nieznana kwota dla całej rodziny; poprawna etykieta paczki 1 nie przeszkadza', async () => {
    const { id, lineId } = await zamowienieZWysylka(4)
    const { childOrderId } = await splitOrder(db, id, { [lineId]: 2 })
    // stan jak przed poprawką: etykieta paczki 1 z kwotą całego zamówienia (92,59 zł) zamiast 52,79 zł
    const s = await etykieta(id, 1, '92.59')
    await prepareForOrder(db, childOrderId)
    expect(await problemPobrania(childOrderId)).toMatch(/w kilku paczkach.*paczka 1 ma już przesyłkę z pobraniem 92,59 zł.*52,79 zł/)
    await prepareForOrder(db, id)
    expect(await problemPobrania(id)).toMatch(/paczka 1 ma już przesyłkę/)
    // po anulowaniu i ponownym utworzeniu etykieta paczki 1 ma 52,79 zł: paczka 2 dostaje 39,80 zł
    await db.shipment.update({ where: { id: s.id }, data: { state: 'ANULOWANA' } })
    await etykieta(id, 1, '52.79')
    await prepareForOrder(db, childOrderId)
    expect(await kwotaPobrania(childOrderId)).toBe(39.8)
    // drugi podział po etykiecie paczki 1: odmowa (etykieta 52,79 zł nie pasowałaby już do nowych paczek)
    await expect(splitOrder(db, id, { [lineId]: 1 })).rejects.toThrow(/przesyłkę u przewoźnika/)
  })

  // dodatkowa przesyłka (dosyłka) do paczki: zawsze bez pobrania, nie jest etykietą paczki
  const dosylka = (orderId: string, packageNo: number, state: 'UTWORZONA' | 'BLAD' = 'UTWORZONA') =>
    db.shipment.create({ data: { orderId, packageNo, extraNo: 1, extraKind: 'DOSYLKA', extraReason: 'reklamacja: brak produktu', reference: `ref-dos-${orderId}-${packageNo}-${Math.random()}`, adapterKey: 'dpd', carrier: 'DPD', state, codAmount: null } })

  it('paczka 1 nadana i z dosyłką, paczka 2 nienadana: kwoty paczek bez zmian, paczka 2 dostaje swoją kwotę', async () => {
    const { id, lineId } = await zamowienieZWysylka(4)
    const { childOrderId } = await splitOrder(db, id, { [lineId]: 2 })
    await etykieta(id, 1, '52.79')
    await dosylka(id, 1)
    await prepareForOrder(db, childOrderId)
    expect(await kwotaPobrania(childOrderId)).toBe(39.8)
    expect(await problemPobraniaLubBrak(childOrderId)).toBeUndefined()
    await prepareForOrder(db, id)
    expect(await kwotaPobrania(id)).toBe(52.79)
  })

  it('sama dosyłka (główna anulowana) nie blokuje podziału ani zmiany pozycji zamówienia za pobraniem', async () => {
    const { id, lineId } = await zamowienieZWysylka(4)
    await etykieta(id, 1, '92.59', 'ANULOWANA')
    await dosylka(id, 1)
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(await powodDokumentuLubPrzesylki(db, o)).toBeNull()
    const { childOrderId } = await splitOrder(db, id, { [lineId]: 2 })
    expect(childOrderId).toBeTruthy()
  })

  it('etykieta paczki 2 bez pobrania przy zamówieniu za pobraniem = nieznana kwota', async () => {
    const { id, lineId } = await zamowienieZWysylka(4)
    const { childOrderId } = await splitOrder(db, id, { [lineId]: 2 })
    await etykieta(childOrderId, 2, null)
    await prepareForOrder(db, id)
    expect(await problemPobrania(id)).toMatch(/paczka 2 ma już przesyłkę bez pobrania/)
  })

  it('wariant 2: stan płatności zamówienia głównego po podziale; paczka dodatkowa liczy się ze stanem zamówienia głównego', async () => {
    const pid = await product(db, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
    const wejscie = order([{ productId: pid, qty: 4, unitPriceGross: 19.9 }], { deliveryMethod: DPD, ...COD, totalGross: 4 * 19.9 + 12.99, shippingCostGross: 12.99 })
    const id = (await ingestOrder(db, wejscie)).orderId!
    const lineId = (await db.orderLine.findFirstOrThrow({ where: { orderId: id } })).id
    const { childOrderId } = await splitOrder(db, id, { [lineId]: 2 })
    // drogi w kodzie: rewizja z kanału z „opłacone” i „Oznacz jako opłacone” nie zmieniają zamówienia za pobraniem (COD liczy się jak opłacone)
    await ingestOrder(db, { ...wejscie, externalRevision: '2', paymentState: 'PAID', paymentMethod: 'BLIK' })
    await markPaid(db, id, 'PAID')
    expect((await db.order.findUniqueOrThrow({ where: { id } })).paymentState).toBe('COD')
    expect((await db.order.findUniqueOrThrow({ where: { id: childOrderId } })).paymentState).toBe('COD')
    // gdyby zmiana jednak przyszła (np. przywrócenie po anulowaniu z innym stanem): pieniądze rodziny są na zamówieniu głównym
    await db.order.update({ where: { id }, data: { paymentState: 'PAID', paymentMethod: 'BLIK' } })
    await prepareForOrder(db, childOrderId)
    const w = await db.preparedShipment.findFirstOrThrow({ where: { orderId: childOrderId } })
    expect(w.codAmount).toBeNull()
    expect((w.problems as { kod: string }[]).map((p) => p.kod)).not.toContain('pobranie')
  })

  it('pozycja odrzucona przy akceptacji: bez pewnej kwoty pobrania', async () => {
    const id = await zamowienie(DPD, { ...COD, qty: 3 })
    await zBrakiem(id)
    await rejectShortagesAtAcceptance(db, id, { now: T0 })
    await prepareForOrder(db, id)
    expect(await problemPobrania(id)).toMatch(/odrzucone przy akceptacji/)
  })

  it('brak po pakowaniu: tekst o spakowanej paczce, nie o przyszłości', async () => {
    const id = await zamowienie(DPD, COD)
    const l = await db.orderLine.findFirstOrThrow({ where: { orderId: id } })
    await db.shortage.create({ data: { orderId: id, orderLineId: l.id, productId: l.productId!, qtyBase: 1, state: 'COD_REDUCED' } })
    await prepareForOrder(db, id)
    expect(await problemPobrania(id)).toMatch(/spakowana z brakami/)
  })

  it('reguła taka jak przy przyjęciu: dwie reguły tego samego przewoźnika rozróżnia metoda dostawy', async () => {
    await db.carrierRule.updateMany({ where: { carrier: 'PACZKOMATY' }, data: { config: {} } })
    const ogolna = await db.carrierRule.findFirstOrThrow({ where: { carrier: 'PACZKOMATY' } })
    await db.carrierRule.create({ data: { priority: ogolna.priority - 1, channel: null, pattern: 'paczkomat.*eco', carrier: 'PACZKOMATY', shippingModule: ogolna.shippingModule, adapterKey: ogolna.adapterKey, config: { courierCode: 'paczkomaty_eco' } } })
    const eco = await zamowienie('Paczkomat InPost ECO')
    const zwykly = await zamowienie(PACZKOMAT)
    await prepareForOrder(db, eco, 'INPOST_A')
    await prepareForOrder(db, zwykly, 'INPOST_A')
    expect(await db.preparedShipment.findFirstOrThrow({ where: { orderId: eco } })).toMatchObject({ courierCode: 'paczkomaty_eco' })
    expect(await db.preparedShipment.findFirstOrThrow({ where: { orderId: zwykly } })).toMatchObject({ courierCode: 'paczkomaty' })
  })

  it('ustawienia i kod kuriera z konfiguracji reguły przewoźnika', async () => {
    await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { config: { defaultSideXCm: 60, defaultSideYCm: 50, defaultSideZCm: 40, defaultWeightKg: 3 } } })
    await db.carrierRule.updateMany({ where: { carrier: 'PACZKOMATY' }, data: { config: { courierCode: 'paczkomaty_eco' } } })
    const dpd = await zamowienie(DPD)
    await prepareForOrder(db, dpd)
    expect(await db.preparedShipment.findFirstOrThrow({ where: { orderId: dpd } })).toMatchObject({ sideXCm: 60, sideYCm: 50, sideZCm: 40 })
    const pacz = await zamowienie(PACZKOMAT)
    await prepareForOrder(db, pacz)
    expect(await db.preparedShipment.findFirstOrThrow({ where: { orderId: pacz } })).toMatchObject({ courierCode: 'paczkomaty_eco' })
  })

  it('nieznane zamówienie = komunikat', async () => {
    await expect(prepareForOrder(db, 'nieistniejace')).rejects.toBeInstanceOf(BladPrzesylki)
  })
})

describe('nie dotyczy', () => {
  it('odbiór osobisty: jawny wynik bez wiersza', async () => {
    const id = await zamowienie('Odbiór osobisty')
    expect(await prepareForOrder(db, id)).toEqual({ wynik: 'nie_dotyczy', powod: 'Odbiór osobisty: przesyłka nie powstaje.' })
    expect(await db.preparedShipment.count()).toBe(0)
  })

  it('zmiana przewoźnika usuwa stary podgląd', async () => {
    const id = await zamowienie(PACZKOMAT)
    await prepareForOrder(db, id, 'INPOST_A')
    await db.order.update({ where: { id }, data: { carrier: 'OSOBISTY' } })
    expect((await prepareForOrder(db, id)).wynik).toBe('nie_dotyczy')
    expect(await db.preparedShipment.count()).toBe(0)
  })

  it('zamówienie bez wysyłki, Allegro, anulowane, nieustalony przewoźnik', () => {
    const baza = { status: 'DO_REALIZACJI' as const, carrier: 'DPD' as const, tylkoBezStanu: false, liczbaPozycji: 1 }
    expect(powodNieDotyczy(baza)).toBeNull()
    expect(powodNieDotyczy({ ...baza, carrier: 'BEZ_WYSYLKI' })).toMatch(/bez wysyłki/)
    expect(powodNieDotyczy({ ...baza, tylkoBezStanu: true })).toMatch(/bez wysyłki/)
    expect(powodNieDotyczy({ ...baza, carrier: 'ALLEGRO' })).toBeNull() // Wysyłam z Allegro ma podgląd
    expect(powodNieDotyczy({ ...baza, status: 'ANULOWANE' })).toMatch(/anulowane/)
    expect(powodNieDotyczy({ ...baza, carrier: 'BRAK' } as never)).toMatch(/nieustalony/)
    expect(powodNieDotyczy({ ...baza, carrier: null } as never)).toMatch(/nieustalony/)
  })

  it('firma bez modułu wysyłki dla przewoźnika (powód bez „Base Courier”)', async () => {
    await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { shippingModule: 'BRAK', adapterKey: null } })
    const id = await zamowienie(DPD)
    expect(await prepareForOrder(db, id)).toMatchObject({ wynik: 'nie_dotyczy', powod: expect.stringContaining('nie ma modułu wysyłki') })
    expect((await podgladPrzesylki(db, id))!.nieDotyczy).toContain('nie ma modułu wysyłki')
    expect((await podgladPrzesylki(db, id))!.nieDotyczy).not.toContain('Base Courier')
  })

  it('reguły zmieniły się od przyjęcia: nie dotyczy z powodem, bez przycisku w próżnię', async () => {
    const id = await zamowienie(DPD)
    await db.order.update({ where: { id }, data: { carrier: 'PACZKOMATY' } })
    expect(await prepareForOrder(db, id)).toMatchObject({ wynik: 'nie_dotyczy', powod: expect.stringContaining('Reguły przewoźnika zmieniły się') })
    expect((await podgladPrzesylki(db, id))!.nieDotyczy).toContain('Reguły przewoźnika zmieniły się')
  })
})

describe('izolacja i dane osobowe', () => {
  it('firma B nie widzi zamówienia ani podglądu firmy A; ta sama paczka istnieje w obu firmach osobno', async () => {
    const a = await zamowienie(PACZKOMAT)
    await prepareForOrder(db, a, 'INPOST_A')
    await expect(prepareForOrder(dbB, a, 'INPOST_A')).rejects.toBeInstanceOf(BladPrzesylki)
    expect(await podgladPrzesylki(dbB, a)).toBeNull()
    expect(await dbB.preparedShipment.count()).toBe(0)
    const b = await zamowienie(PACZKOMAT, {}, dbB)
    await prepareForOrder(dbB, b, 'INPOST_B')
    expect(await dbB.preparedShipment.count()).toBe(1)
    expect(await db.preparedShipment.count()).toBe(1)
    await expect(dbB.preparedShipment.updateMany({ where: { orderId: a }, data: { parcelSize: 'x' } })).resolves.toEqual({ count: 0 })
    await expect(dbB.preparedShipment.create({ data: { organizationId: ORG_A, orderId: a, packageNo: 2, adapterKey: 'basecourier.v1', carrier: 'DPD' } })).rejects.toThrow()
    const all = await sys.preparedShipment.findMany({ select: { organizationId: true } })
    expect(all.map((x) => x.organizationId).sort()).toEqual([ORG_A, ORG_B].sort())
  })

  it('wiersz nie ma danych osobowych: tylko parametry przesyłki', async () => {
    const ODBIORCA = ['Jan Testowy', 'jan.testowy@example.invalid', '600100200', 'ul. Testowa 1']
    const id = await zamowienie(`${DPD} ${ODBIORCA[0]}`, { paymentMethod: `Za pobraniem ${ODBIORCA[1]}` })
    await prepareForOrder(db, id)
    const w = await sys.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    const json = JSON.stringify(w)
    for (const p of ODBIORCA) expect(json).not.toContain(p)
    expect(Object.keys(w).sort()).toEqual(['adapterKey', 'carrier', 'codAmount', 'courierCode', 'createdAt', 'id', 'orderId', 'organizationId', 'packageNo', 'parcelSize', 'problems', 'sideXCm', 'sideYCm', 'sideZCm', 'weightKg'].sort())
  })
})

describe('podgladPrzesylki', () => {
  it('blok: przed policzeniem pusty, po policzeniu wymiary i problemy, gabaryty przewoźnika do wyboru', async () => {
    const id = await zamowienie(PACZKOMAT)
    const przed = await podgladPrzesylki(db, id)
    expect(przed).toMatchObject({ nieDotyczy: null, zapisana: null })
    expect(przed!.gabaryty.map((g) => g.kod)).toEqual(['INPOST_A', 'INPOST_B', 'INPOST_C'])
    await prepareForOrder(db, id, 'INPOST_A')
    const po = await podgladPrzesylki(db, id)
    expect(po!.zapisana).toMatchObject({ przewoznik: 'PACZKOMATY', gabaryt: 'InPost A', wymiary: '8 × 38 × 64 cm', pobranie: null })
    expect(po!.zapisana!.problemy.map((p) => p.tekst)).toContain(PUNKT_PRZY_NADANIU)
  })

  it('paczkomat z kodem w zapisanych danych klienta = bez problemu punktu; dane bez punktu = BLAD jak przy nadaniu; tylko baza, kod nie trafia do wiersza', async () => {
    vi.stubEnv('CUSTOMER_DATA_KEYS', KLUCZE)
    try {
      const zKodem = await zamowienie(PACZKOMAT)
      await zapiszRekordKlienta(db, zKodem, rekordZOdbiorcy({ dostawa: null, punktOdbioru: { kod: 'TST01M', nazwa: null }, faktura: null, problemy: [] }), { source: 'RECZNE', fetchedAt: T0, env: { CUSTOMER_DATA_KEYS: KLUCZE, CUSTOMER_LOOKUP_KEY: 'c'.repeat(64) } })
      const r = await prepareForOrder(db, zKodem, 'INPOST_A')
      expect(r).toMatchObject({ wynik: 'przygotowane', parcel: { pickupPoint: 'TST01M' } })
      const kody = r.wynik === 'przygotowane' ? r.parcel.problems.map((p) => p.kod) : []
      expect(kody).not.toContain('punkt')
      expect(kody).not.toContain('punkt_przy_nadaniu')
      expect(JSON.stringify(await db.preparedShipment.findFirstOrThrow({ where: { orderId: zKodem } }))).not.toContain('TST01M')

      const bezKodu = await zamowienie(PACZKOMAT)
      await zapiszRekordKlienta(db, bezKodu, rekordZOdbiorcy({ dostawa: null, punktOdbioru: null, faktura: null, problemy: [] }), { source: 'RECZNE', fetchedAt: T0, env: { CUSTOMER_DATA_KEYS: KLUCZE, CUSTOMER_LOOKUP_KEY: 'c'.repeat(64) } })
      const b = await prepareForOrder(db, bezKodu, 'INPOST_A')
      expect(b.wynik === 'przygotowane' && b.parcel.problems.filter((p) => p.poziom === 'BLAD').map((p) => p.kod)).toEqual(['punkt'])

      // kurier DPD (moduł nie wymaga punktu): podgląd w ogóle nie czyta danych klienta
      const kurier = await zamowienie(DPD)
      await prepareForOrder(db, kurier, null)
      expect(await db.auditLog.count({ where: { entity: 'KLIENT_PODGLAD', entityId: kurier } })).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('wartości robocze są oznaczone, a z konfiguracji nie', async () => {
    const id = await zamowienie(DPD)
    await prepareForOrder(db, id)
    expect((await podgladPrzesylki(db, id))!.zapisana).toMatchObject({ wymiary: '40 × 30 × 20 cm', wymiaryRobocze: true, wagaRobocza: true })
    await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { config: { defaultSideXCm: 60, defaultSideYCm: 50, defaultSideZCm: 40 } } })
    await prepareForOrder(db, id)
    expect((await podgladPrzesylki(db, id))!.zapisana).toMatchObject({ wymiary: '60 × 50 × 40 cm', wymiaryRobocze: false })
  })
})

describe('Wysyłam z Allegro', () => {
  const ALLEGRO = 'Allegro Paczkomaty InPost'
  const allegro = (opts: Parameters<typeof zamowienie>[1] = {}, klient = db) => zamowienie(ALLEGRO, { channel: 'ALLEGRO', ...opts }, klient)

  it('podgląd: gabaryt Allegro, wymiary robocze, adapterKey w wierszu, bez kodu kuriera i bez problemu punktu', async () => {
    const id = await allegro()
    const przed = await db.order.findUniqueOrThrow({ where: { id }, include: { reservations: true, events: true, lines: true } })
    expect(przed).toMatchObject({ channel: 'ALLEGRO', carrier: 'ALLEGRO', shippingModule: 'WYSYLAM_Z_ALLEGRO' })
    const r = await prepareForOrder(db, id, 'ALLEGRO_B')
    expect(r.wynik).toBe('przygotowane')
    const w = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    expect(w).toMatchObject({ organizationId: ORG_A, packageNo: 1, adapterKey: 'allegro.wysylam.v1', carrier: 'ALLEGRO', courierCode: null, parcelSize: 'ALLEGRO_B', sideXCm: 19, sideYCm: 38, sideZCm: 64, codAmount: null })
    const kody = (w.problems as { kod: string }[]).map((p) => p.kod)
    expect(kody).toEqual(expect.arrayContaining(['wymiary_domyslne', 'waga_domyslna']))
    expect(kody).not.toContain('punkt')
    expect(kody).not.toContain('kod_kuriera')
    expect(await db.order.findUniqueOrThrow({ where: { id }, include: { reservations: true, events: true, lines: true } })).toEqual(przed)
    const blok = await podgladPrzesylki(db, id)
    expect(blok).toMatchObject({ nieDotyczy: null, zapisana: { przewoznik: 'ALLEGRO', courierCode: null, gabaryt: 'Allegro B', wymiary: '19 × 38 × 64 cm', wymiaryRobocze: true, wagaRobocza: true } })
    expect(blok!.gabaryty.map((g) => g.kod)).toEqual(['ALLEGRO_A', 'ALLEGRO_B', 'ALLEGRO_C'])
  })

  it('idempotentne: jeden wiersz po kilku przygotowaniach, także równoległych; podpowiedź gabarytu bez argumentu', async () => {
    const id = await allegro({ qty: 5 })
    await prepareForOrder(db, id, 'ALLEGRO_A')
    const pierwszy = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    await prepareForOrder(db, id, 'ALLEGRO_C')
    await Promise.all([prepareForOrder(db, id, 'ALLEGRO_A'), prepareForOrder(db, id)])
    expect(await db.preparedShipment.count({ where: { orderId: id } })).toBe(1)
    const po = await prepareForOrder(db, id)
    expect(po).toMatchObject({ wynik: 'przygotowane', parcel: { gabaryt: 'ALLEGRO_B' } })
    if (po.wynik !== 'przygotowane') throw new Error('nie przygotowane')
    expect(po.parcel.problems.map((p) => p.kod)).toContain('gabaryt_podpowiedz')
    expect(await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ id: pierwszy.id, adapterKey: 'allegro.wysylam.v1', parcelSize: 'ALLEGRO_B' })
  })

  it('gabaryt spoza Allegro = komunikat, bez zapisu', async () => {
    const id = await allegro()
    await expect(prepareForOrder(db, id, 'INPOST_A')).rejects.toBeInstanceOf(BladPrzesylki)
    expect(await db.preparedShipment.count()).toBe(0)
  })

  it('pobranie: kwota zamówienia i ostrzeżenie o koncie do wypłaty', async () => {
    const id = await allegro({ paymentState: 'COD', paymentMethod: 'CASH_ON_DELIVERY' })
    await prepareForOrder(db, id, 'ALLEGRO_A')
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    const w = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    expect(Number(w.codAmount)).toBe(Number(o.totalGross))
    expect((w.problems as { kod: string }[]).map((p) => p.kod)).toContain('pobranie_konto')
  })

  it('zmiana z Base Courier na Allegro nadpisuje adapterKey w tym samym wierszu', async () => {
    const id = await allegro()
    await db.preparedShipment.create({ data: { organizationId: ORG_A, orderId: id, packageNo: 1, adapterKey: 'basecourier.v1', carrier: 'PACZKOMATY' } })
    await prepareForOrder(db, id, 'ALLEGRO_A')
    expect(await db.preparedShipment.findMany({ where: { orderId: id }, select: { adapterKey: true, carrier: true } })).toEqual([{ adapterKey: 'allegro.wysylam.v1', carrier: 'ALLEGRO' }])
  })

  it('firma bez modułu Wysyłam z Allegro: nie dotyczy z powodem, stary podgląd usunięty', async () => {
    const id = await allegro()
    await prepareForOrder(db, id, 'ALLEGRO_A')
    await db.carrierRule.updateMany({ where: { carrier: 'ALLEGRO' }, data: { shippingModule: 'BRAK', adapterKey: null } })
    expect(await prepareForOrder(db, id)).toMatchObject({ wynik: 'nie_dotyczy', powod: expect.stringContaining('modułu Wysyłam z Allegro') })
    expect(await db.preparedShipment.count()).toBe(0)
    expect((await podgladPrzesylki(db, id))!.nieDotyczy).toContain('modułu Wysyłam z Allegro')
  })

  it('reguła z Wysyłam z Allegro dla zamówienia spoza Allegro: nie dotyczy, bez zgadywania', async () => {
    await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { shippingModule: 'WYSYLAM_Z_ALLEGRO', adapterKey: 'allegro.wysylam.v1' } })
    const id = await zamowienie(DPD)
    expect(await prepareForOrder(db, id)).toMatchObject({ wynik: 'nie_dotyczy', powod: expect.stringContaining('tylko dla zamówień z Allegro') })
  })

  it('dwie firmy: B nie widzi podglądu Allegro firmy A; każda ma swój wiersz', async () => {
    const a = await allegro()
    await prepareForOrder(db, a, 'ALLEGRO_A')
    await expect(prepareForOrder(dbB, a, 'ALLEGRO_A')).rejects.toBeInstanceOf(BladPrzesylki)
    expect(await podgladPrzesylki(dbB, a)).toBeNull()
    expect(await dbB.preparedShipment.count()).toBe(0)
    const b = await allegro({}, dbB)
    await prepareForOrder(dbB, b, 'ALLEGRO_C')
    const all = await sys.preparedShipment.findMany({ select: { organizationId: true, adapterKey: true, parcelSize: true }, orderBy: { parcelSize: 'asc' } })
    expect(all).toEqual([
      { organizationId: ORG_A, adapterKey: 'allegro.wysylam.v1', parcelSize: 'ALLEGRO_A' },
      { organizationId: ORG_B, adapterKey: 'allegro.wysylam.v1', parcelSize: 'ALLEGRO_C' },
    ])
  })

  it('wiersz bez danych osobowych: tylko parametry przesyłki', async () => {
    const ODBIORCA = ['Jan Testowy', 'jan.testowy@example.invalid', '600100200', 'ul. Testowa 1']
    const id = await zamowienie(`${ALLEGRO} ${ODBIORCA[0]} ${ODBIORCA[3]}`, { channel: 'ALLEGRO', paymentState: 'COD', paymentMethod: `CASH_ON_DELIVERY ${ODBIORCA[1]} ${ODBIORCA[2]}` })
    await prepareForOrder(db, id, 'ALLEGRO_A')
    const w = await sys.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    const json = JSON.stringify(w)
    for (const p of ODBIORCA) expect(json).not.toContain(p)
    expect(Object.keys(w).sort()).toEqual(['adapterKey', 'carrier', 'codAmount', 'courierCode', 'createdAt', 'id', 'orderId', 'organizationId', 'packageNo', 'parcelSize', 'problems', 'sideXCm', 'sideYCm', 'sideZCm', 'weightKg'].sort())
  })
})
