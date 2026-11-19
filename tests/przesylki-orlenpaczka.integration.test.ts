// Orlen Paczka w hoście przesyłek (`lib/wysylka/nadanie.ts`) na atrapie SOAP (tests/orlenpaczka-atrapa.ts)
// i bazie testowej: podgląd z rozmiarem S/M/L, bramka modułu tylko do podglądu i wyłącznika, nadanie z numerem paczki
// i etykietą, zgubiona odpowiedź = odszukanie po odcisku referencji (bez drugiej paczki), „Rozstrzygnij ręcznie” z
// numerem sprawdzonym na etykiecie, izolacja firm. Firma bez BL i bez wFirmy (sama reguła przewoźnika). Dane fikcyjne,
// zero połączeń z Orlen Paczką (także z sandboxem).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { deriveReference } from '@/lib/adaptery/rejestr'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { opisZdarzenia } from '@/lib/karta/historia'
import { bramkaNadania, opisRozstrzygniecia, rozstrzygnijRecznie, sprawdzPrzesylke, utworzPrzesylke, widokPrzesylki, type DepsNadania } from '@/lib/wysylka/nadanie'
import { prepareForOrder } from '@/lib/wysylka/podglad'
import { odciskReferencji } from '@/lib/wysylka/zlecenie-orlenpaczka'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { etykietaOdp, etykietaZpl, kodOdp, NADAWCA_ORLEN, odpowiedz, ORLEN_NUMER, ORLEN_PARTNER_ID, ORLEN_PARTNER_KEY, ORLEN_PUNKT, orlenAtrapa, type OrlenReply } from './orlenpaczka-atrapa'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: 'Anna Fikcyjna', firma: null, ulica: 'ul. Atrapowa', numerDomu: '9', numerLokalu: null, kodPocztowy: '60-002', miasto: 'Poznań', kraj: 'PL', telefon: '+48 511 222 333', email: 'anna@example.test' },
  punktOdbioru: { kod: ORLEN_PUNKT, nazwa: 'Orlen Testowa' },
  faktura: null,
  problemy: [],
}
const ENV = { EKRANY_PRACA: '1', CUSTOMER_DATA_KEYS: `1:${'3'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'c'.repeat(64), ORLEN_PARTNER_ID, ORLEN_PARTNER_KEY }
const KONFIG = { zapisWlaczony: true, defaultWeightKg: 1 }
const POTWIERDZONE = ['waga_domyslna', 'gabaryt_podpowiedz']
const METODA = 'Orlen Paczka punkt'

let atrapa: ReturnType<typeof orlenAtrapa>
const deps = (): DepsNadania => ({ fetch: atrapa.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true } })
const nadania = () => atrapa.calls.filter((c) => c.metoda === 'GenerateBusinessPack').length

/** Firma: reguła „orlen” → Orlen Paczka (moduł ORLEN_PACZKA), konto WOO/sd w PRACA, nadawca w ustawieniach firmy. */
async function firma(o: { adapterKey?: string; config?: Record<string, unknown> } = {}): Promise<void> {
  await db.carrierRule.create({ data: { priority: 5, channel: null, pattern: 'orlen', carrier: 'ORLEN_PACZKA', shippingModule: 'ORLEN_PACZKA', adapterKey: o.adapterKey ?? 'orlenpaczka.zapis.v1', config: (o.config ?? KONFIG) as object } })
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: { nadawca: NADAWCA_ORLEN } } })
}

async function zamowienie(): Promise<string> {
  const pid = await product(db, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: METODA, paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })
  await zapiszRekordKlienta(db, r.orderId!, rekordZOdbiorcy(ODBIORCA), { source: 'RECZNE', fetchedAt: T0, env: ENV })
  return r.orderId!
}

/** Referencja pierwszej przesyłki paczki (jak w hoście), żeby atrapa mogła wydrukować etykietę z odciskiem. */
async function referencja(orderId: string): Promise<string> {
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { packageNo: true } })
  return deriveReference([ORG_A, orderId, o.packageNo, 'przesylka', 1])
}

const lista = (numery: string[]): OrlenReply => odpowiedz('GetGeneratedParcels', 'GetGeneratedParcels', numery.map((n) => ({ Err: '000', ErrDes: 'saved', PackCode_RUCH: n, Data: '2026-11-08T10:00:00' })))
const utworz = (orderId: string) => utworzPrzesylke(db, { orderId, potwierdzoneOstrzezenia: POTWIERDZONE, userId: 'u-test' }, deps())

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
  atrapa = orlenAtrapa()
  vi.stubEnv('CUSTOMER_DATA_KEYS', ENV.CUSTOMER_DATA_KEYS)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Orlen Paczka: podgląd i bramki', () => {
  it('zamówienie z metodą „orlen” dostaje przewoźnika Orlen Paczka; podgląd liczy rozmiar S z podpowiedzi, bez sieci', async () => {
    await firma({ adapterKey: 'orlenpaczka.v1', config: { defaultWeightKg: 1 } })
    const id = await zamowienie()
    expect((await db.order.findUniqueOrThrow({ where: { id } })).carrier).toBe('ORLEN_PACZKA')
    const r = await prepareForOrder(db, id)
    expect(r).toMatchObject({ wynik: 'przygotowane', parcel: { courierCode: 'S', gabaryt: 'ORLEN_S' } })
    const w = await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })
    expect(w).toMatchObject({ adapterKey: 'orlenpaczka.v1', carrier: 'ORLEN_PACZKA', courierCode: 'S', parcelSize: 'ORLEN_S', codAmount: null })
    expect(atrapa.calls).toEqual([])
  })

  it('moduł tylko do podglądu i wyłączony zapis: przycisk z powodem, zero żądań', async () => {
    await firma({ adapterKey: 'orlenpaczka.v1' })
    const id = await zamowienie()
    expect((await bramkaNadania(db, id, deps()))!.powod).toMatch(/tylko liczy przesyłkę/)
    await db.carrierRule.updateMany({ where: { carrier: 'ORLEN_PACZKA' }, data: { adapterKey: 'orlenpaczka.zapis.v1', config: { zapisWlaczony: false } } })
    expect((await bramkaNadania(db, id, deps()))!.powod).toMatch(/wyłączone w ustawieniach przewoźnika/)
    expect(await utworz(id)).toMatchObject({ wynik: 'ODMOWA' })
    expect(atrapa.calls).toEqual([])
  })
})

describe('Orlen Paczka: nadanie', () => {
  it('numer paczki, etykieta, odcisk referencji w SenderOrders; druga firma bez zmian i bez żądań', async () => {
    await firma()
    const id = await zamowienie()
    const ref = await referencja(id)
    const w = await utworz(id)
    expect(w).toMatchObject({ wynik: 'UTWORZONA', przesylka: { state: 'UTWORZONA', externalRef: ORLEN_NUMER, trackingNumber: ORLEN_NUMER, carrier: 'ORLEN_PACZKA', adapterKey: 'orlenpaczka.zapis.v1', reference: ref } })
    expect(atrapa.metody()).toEqual(['GenerateBusinessPack', 'LabelPrintDuplicateListTwo'])
    expect(atrapa.calls[0]!.pola).toMatchObject({ DestinationCode: ORLEN_PUNKT, BoxSize: 'S', SenderOrders: odciskReferencji(ref), PhoneNumber: '511222333', LastName: 'Fikcyjna' })
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(s.labelCiphertext).not.toBeNull()
    // podwójne kliknięcie nie woła Orlenu drugi raz
    expect(await utworz(id)).toMatchObject({ wynik: 'UTWORZONA', istniala: true })
    expect(nadania()).toBe(1)
    expect(await dbB.shipment.count()).toBe(0)
    expect(await dbB.carrierRule.count({ where: { carrier: 'ORLEN_PACZKA' } })).toBe(0)
  })

  it('zgubiona odpowiedź: odszukanie po odcisku na etykiecie potwierdza paczkę, jedno nadanie', async () => {
    await firma()
    const id = await zamowienie()
    const ref = await referencja(id)
    atrapa = orlenAtrapa([], {
      GenerateBusinessPack: [{ error: new Error('The operation was aborted') }],
      GetGeneratedParcels: [lista([ORLEN_NUMER])],
      LabelPrintDuplicateListTwo: [etykietaOdp(etykietaZpl(odciskReferencji(ref)))],
    })
    const w = await utworz(id)
    expect(w).toMatchObject({ wynik: 'UTWORZONA', przesylka: { externalRef: ORLEN_NUMER } })
    expect(nadania()).toBe(1)
  })

  it('bez potwierdzenia: NIEJEDNOZNACZNA, „Sprawdź” później znajduje paczkę; ręczne rozstrzygnięcie sprawdza numer na etykiecie', async () => {
    await firma()
    const id = await zamowienie()
    const ref = await referencja(id)
    atrapa = orlenAtrapa([], {
      GenerateBusinessPack: [{ status: 502, body: '' }],
      GetGeneratedParcels: [lista([ORLEN_NUMER]), lista([ORLEN_NUMER])],
      LabelPrintDuplicateListTwo: [etykietaOdp('', '211'), etykietaOdp(etykietaZpl(odciskReferencji(ref)))],
    })
    const w = await utworz(id)
    expect(w).toMatchObject({ wynik: 'NIEJEDNOZNACZNA' })
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(await sprawdzPrzesylke(db, s.id, { userId: 'u-test', deps: deps() })).toMatchObject({ wynik: 'UTWORZONA' })
    expect(nadania()).toBe(1)

    // druga paczka zamówienia: ręczne rozstrzygnięcie z obcym numerem = odmowa, z właściwym = utworzona
    // atrapa daje każdej paczce ten sam numer: pierwsza dostaje inny, bo numer innej przesyłki w Kompletorze jest odmawiany
    await db.shipment.update({ where: { id: s.id }, data: { externalRef: '2100000000036', trackingNumber: '2100000000036' } })
    const id2 = await zamowienie()
    const ref2 = await referencja(id2)
    atrapa = orlenAtrapa([], {
      GenerateBusinessPack: [{ status: 502, body: '' }],
      GetGeneratedParcels: [lista([])],
      LabelPrintDuplicateListTwo: [etykietaOdp(etykietaZpl('KMPINNA')), etykietaOdp(etykietaZpl(odciskReferencji(ref2)))],
    })
    expect(await utworz(id2)).toMatchObject({ wynik: 'NIEJEDNOZNACZNA' })
    const s2 = await db.shipment.findFirstOrThrow({ where: { orderId: id2 } })
    expect(await rozstrzygnijRecznie(db, s2.id, { wariant: 'ISTNIEJE', numer: '2100000000029' }, { userId: 'u-test', deps: deps() })).toMatchObject({ wynik: 'ODMOWA' })
    expect(await rozstrzygnijRecznie(db, s2.id, { wariant: 'ISTNIEJE', numer: ORLEN_NUMER }, { userId: 'u-test', deps: deps() })).toMatchObject({ wynik: 'UTWORZONA' })
    expect(nadania()).toBe(1)
  })
})

describe('Orlen Paczka: poprawki po przeglądzie', () => {
  it('Orlen zmienił punkt odbioru (kod 006): przesyłka utworzona, informacja w przesyłce, w zdarzeniu, na karcie i w historii', async () => {
    await firma()
    const id = await zamowienie()
    atrapa = orlenAtrapa([], { GenerateBusinessPack: [kodOdp('GenerateBusinessPack', 'GenerateBusinessPack', '006', { PackCode_RUCH: ORLEN_NUMER, DestinationCode: 'WS-222333-C1-01' })] })
    const w = await utworz(id)
    expect(w).toMatchObject({ wynik: 'UTWORZONA', przesylka: { state: 'UTWORZONA', externalRef: ORLEN_NUMER } })
    expect((w as { info?: string | null }).info).toContain('WS-222333-C1-01')
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(s.lastError).toContain('WS-222333-C1-01')
    expect(s.lastError).toContain(ORLEN_PUNKT)
    const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: id, kind: 'PRZESYLKA_UTWORZONA' } })
    expect((ev.data as { uwaga?: string }).uwaga).toContain('zmienił punkt odbioru')
    expect(opisZdarzenia(ev.kind, ev.data)).toContain('WS-222333-C1-01')
    const widok = await widokPrzesylki(db, id)
    expect(widok!.uwaga).toContain('WS-222333-C1-01')
    // bez zmiany punktu: bez uwagi
    const id2 = await zamowienie()
    atrapa = orlenAtrapa()
    expect(await utworz(id2)).toMatchObject({ wynik: 'UTWORZONA' })
    expect((await widokPrzesylki(db, id2))!.uwaga).toBeNull()
    expect((await db.shipment.findFirstOrThrow({ where: { orderId: id2 } })).lastError).toBeNull()
  })

  it('alert i „Sprawdź u przewoźnika” bez odsyłania do panelu Orlenu; wynik odszukania z numerami i godzinami paczek z API', async () => {
    await firma()
    const id = await zamowienie()
    atrapa = orlenAtrapa([], {
      GenerateBusinessPack: [{ status: 502, body: '' }],
      GetGeneratedParcels: [lista(['2100000000029']), lista(['2100000000029'])],
      LabelPrintDuplicateListTwo: [etykietaOdp(etykietaZpl('KMPINNA')), etykietaOdp(etykietaZpl('KMPINNA'))],
    })
    expect(await utworz(id)).toMatchObject({ wynik: 'NIEJEDNOZNACZNA' })
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(s.lastError).toContain('2100000000029 08.11 10:00')
    const a = await db.alert.findFirstOrThrow({ where: { dedupeKey: `przesylka:${s.id}` } })
    expect(a.message).toContain('WebTrucker')
    expect(a.message).not.toContain('Sprawdź w panelu przewoźnika')
    const r = await sprawdzPrzesylke(db, s.id, { userId: 'u-test', deps: deps() })
    expect(r.wynik).toBe('NADAL_NIEJASNE')
    expect(r.komunikat).toContain('2100000000029 08.11 10:00')
    expect(r.komunikat).toContain('WebTrucker')
    expect(r.komunikat).not.toContain('Jeśli w panelu przewoźnika widać')
    expect(opisRozstrzygniecia('orlenpaczka.zapis.v1', s.reference).wskazowka).toContain('WebTrucker')
    expect(nadania()).toBe(1)
  })

  it('„Rozstrzygnij ręcznie” z paczką w drodze (213) spoza listy paczek konta = odmowa; literówka w EAN-13 = odmowa bez zapytania', async () => {
    await firma()
    const id = await zamowienie()
    atrapa = orlenAtrapa([], { GenerateBusinessPack: [{ status: 502, body: '' }], GetGeneratedParcels: [lista([])] })
    expect(await utworz(id)).toMatchObject({ wynik: 'NIEJEDNOZNACZNA' })
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    atrapa = orlenAtrapa([], { LabelPrintDuplicateListTwo: [etykietaOdp('', '213')], GetGeneratedParcels: [lista(['2100000000029'])] })
    const odm = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: ORLEN_NUMER }, { userId: 'u-test', deps: deps() })
    expect(odm).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringContaining('w drodze') })
    expect(atrapa.metody()).not.toContain('GiveMePackStatus')
    atrapa = orlenAtrapa()
    expect(await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: '2100000000013' }, { userId: 'u-test', deps: deps() })).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringContaining('cyfrę kontrolną') })
    expect(atrapa.calls).toEqual([])
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('NIEJEDNOZNACZNA')
    // 213 z numerem na liście paczek konta: przyjęty z dopiskiem, że referencji nie porównano
    atrapa = orlenAtrapa([], { LabelPrintDuplicateListTwo: [etykietaOdp('', '213'), etykietaOdp('', '213')], GetGeneratedParcels: [lista([ORLEN_NUMER]), lista([ORLEN_NUMER])] })
    const ok = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: ORLEN_NUMER }, { userId: 'u-test', deps: deps() })
    expect(ok).toMatchObject({ wynik: 'UTWORZONA', komunikat: expect.stringContaining('nie porównano') })
    expect(ok.komunikat).not.toContain('należy do konta')
  })
})
