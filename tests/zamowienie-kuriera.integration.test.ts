// Zamówienie kuriera DPD z kolejki pakowania (lib/wysylka/zamowienie-kuriera.ts) na atrapie DPDServices: wyłącznik konta
// (wyłączone = ekran i baza jak dotąd), propozycja z harmonogramu odbiorów i paczek czekających na kuriera, jedno
// zamówienie na dzień (drugie kliknięcie i kliknięcia równoległe bez drugiego żądania), świadome drugie zamówienie,
// konto bez zapisu, tryb podglądu, odmowa DPD, przerwane połączenie. Dane fikcyjne, zero połączeń z DPD.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { zapiszKontaPrzewoznikow } from '@/lib/wysylka/konta'
import { stanZamawianiaKuriera, zamowKuriera, type DepsKuriera, type ZamowienieKuriera } from '@/lib/wysylka/zamowienie-kuriera'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, dpdAtrapa, json, NADAWCA_TESTOWY } from './dpd-atrapa'
import { order, product, seedBase } from './rdzen-fixtures'

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
})

const ENV = { EKRANY_PRACA: '1', DPD_LOGIN, DPD_PASSWORD }
// piątek 20.11.2026 15:00 w Warszawie: po odbiorze DPD (13:00), więc propozycja = poniedziałek 23.11
const PIATEK = new Date('2026-11-20T14:00:00Z')
const KONTO = { baseUrl: DPD_DEMO, payerFid: DPD_FID, zapisWlaczony: true, zamawianieKuriera: true, defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20 }
const KURIER = '/public/courierorder/v1/packagesPickupCall'

let atrapa: ReturnType<typeof dpdAtrapa>
const deps = (): DepsKuriera => ({ fetch: atrapa.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => PIATEK })
const zadania = () => atrapa.calls.filter((c) => c.path === KURIER)
const ZLECENIE: ZamowienieKuriera = { carrier: 'DPD', data: '2026-11-23', odMin: 13 * 60, doMin: 15 * 60, liczba: 2, wagaKg: 3.5, userId: 'u-test', userName: 'Magazyn Test' }
const zamow = (z: Partial<ZamowienieKuriera> = {}) => zamowKuriera(db, { ...ZLECENIE, ...z }, deps())
const OK = (nr = 'ZK-1') => json({ status: { status: 'OK' }, orderNumber: nr, checkSum: 'cs-1' })

async function firma(konto: Record<string, unknown> = KONTO, praca = true): Promise<void> {
  await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: konto as never } })
  if (praca) await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: { nadawca: NADAWCA_TESTOWY } } })
  await db.carrierPickup.deleteMany({ where: { carrier: 'DPD' } })
  await db.carrierPickup.create({ data: { carrier: 'DPD', weekdays: [1, 2, 3, 4, 5], pickupMinute: 13 * 60, promiseUntilMinute: 12 * 60, active: true } })
}

/** Spakowane zamówienie z przesyłką DPD z numerem listu (czeka na kuriera). */
async function paczka(wagaKg: number): Promise<void> {
  const pid = await product(db, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: 'Kurier DPD', paymentState: 'PAID', totalGross: 30 }), { now: PIATEK })
  await db.order.update({ where: { id: r.orderId! }, data: { status: 'SPAKOWANE' } })
  await db.shipment.create({ data: { orderId: r.orderId!, packageNo: 1, reference: `ref-${r.orderId}`, state: 'UTWORZONA', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', weightKg: wagaKg, externalRef: `000${Math.floor(Math.random() * 1e9)}U` } })
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  atrapa = dpdAtrapa()
})

describe('wyłącznik „Zamawianie kuriera z Kompletora”', () => {
  it('wyłączony (domyślnie): brak stanu dla ekranu, zamówienie odmawia bez żądania i bez wiersza', async () => {
    await firma({ ...KONTO, zamawianieKuriera: undefined })
    expect((await stanZamawianiaKuriera(db, deps())).size).toBe(0)
    expect(await zamow()).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('wyłączone') })
    expect(atrapa.calls).toEqual([])
    expect(await db.courierPickupOrder.count()).toBe(0)
  })

  it('konto bez zapisu: przycisk z powodem, zamówienie = 0 żądań z powodem', async () => {
    await firma({ ...KONTO, zapisWlaczony: false })
    expect((await stanZamawianiaKuriera(db, deps())).get('DPD')).toMatchObject({ powod: expect.stringContaining('Nadawanie') })
    expect(await zamow()).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('Nadawanie') })
    expect(atrapa.calls).toEqual([])
  })

  it('żadne konto sprzedaży w trybie pracy: odmowa bez żądania', async () => {
    await firma(KONTO, false)
    expect(await zamow()).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('trybie pracy') })
    expect(atrapa.calls).toEqual([])
  })
})

describe('zamówienie kuriera DPD', () => {
  it('stan dla okna: propozycja z harmonogramu (piątek po odbiorze → poniedziałek 13:00–15:00) i paczki czekające na kuriera', async () => {
    await firma()
    await paczka(1.5)
    await paczka(2)
    expect((await stanZamawianiaKuriera(db, deps())).get('DPD')).toMatchObject({ powod: null, propozycja: { data: '2026-11-23', odMin: 780, doMin: 900 }, paczki: { liczba: 2, wagaKg: 3.5 }, zlecenia: [] })
  })

  it('zamówienie: jedno żądanie z oknem i paczkami, numer zlecenia w bazie i na pasku; drugie kliknięcie = to samo zlecenie bez żądania', async () => {
    await firma()
    atrapa = dpdAtrapa([OK('ZK-77')])
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: false, zlecenie: { numer: 'ZK-77', dzien: '2026-11-23', odMin: 780, doMin: 900 } })
    expect(zadania()).toHaveLength(1)
    expect(zadania()[0]!.body).toMatchObject({ pickupDate: '2026-11-23', pickupTimeFrom: '13:00', pickupTimeTo: '15:00', packagesForCollection: { packagesParams: { parcel: { count: 2, weight: 3.5 } } } })
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: true, zlecenie: { numer: 'ZK-77' } })
    expect(zadania()).toHaveLength(1)
    expect((await stanZamawianiaKuriera(db, deps())).get('DPD')!.zlecenia).toEqual([expect.objectContaining({ stan: 'ZAMOWIONY', numer: 'ZK-77', kto: 'Magazyn Test' })])
  })

  it('liczba i waga z podpowiedzi: rzeczywiste wagi paczek (największa paczka); zmienione w oknie: równo z okna', async () => {
    await firma()
    await paczka(1)
    await paczka(4)
    atrapa = dpdAtrapa([OK('ZK-3'), OK('ZK-4')])
    await zamow({ liczba: 2, wagaKg: 5 })
    expect(zadania()[0]!.body).toMatchObject({ packagesForCollection: { packagesParams: { parcel: { count: 2, weight: 5, maxWeight: 4 } } } })
    await zamow({ drugi: true, liczba: 3, wagaKg: 6 })
    expect(zadania()[1]!.body).toMatchObject({ packagesForCollection: { packagesParams: { parcel: { count: 3, weight: 6, maxWeight: 2 } } } })
  })

  it('równoległe kliknięcia: jedno żądanie do DPD', async () => {
    await firma()
    atrapa = dpdAtrapa([OK('ZK-5')])
    const w = await Promise.all([zamow(), zamow(), zamow()])
    expect(zadania()).toHaveLength(1)
    expect(w.filter((x) => x.wynik === 'ZAMOWIONY' && !x.istnialo)).toHaveLength(1)
    expect(await db.courierPickupOrder.count()).toBe(1)
  })

  it('świadome drugie zamówienie tego dnia: druga próba, drugie żądanie z inną referencją', async () => {
    await firma()
    atrapa = dpdAtrapa([OK('ZK-1'), OK('ZK-2')])
    await zamow()
    expect(await zamow({ drugi: true, odMin: 16 * 60, doMin: 17 * 60 })).toMatchObject({ wynik: 'ZAMOWIONY', istnialo: false, zlecenie: { numer: 'ZK-2', proba: 2 } })
    expect(zadania()).toHaveLength(2)
    const w = await db.courierPickupOrder.findMany({ orderBy: { attempt: 'asc' } })
    expect(w.map((x) => x.attempt)).toEqual([1, 2])
    expect(new Set(w.map((x) => x.reference)).size).toBe(2)
  })

  it('odmowa DPD: czytelny powód bez danych nadawcy, wiersz BLAD; kolejne kliknięcie używa tego samego wiersza', async () => {
    await firma()
    atrapa = dpdAtrapa([json({ status: { status: 'VALIDATION_ERROR', errorDetails: [{ code: 'E', description: `zły telefon ${NADAWCA_TESTOWY.phone}`, fields: ['sender.phone'] }] } }), OK('ZK-9')])
    const w = await zamow()
    expect(w).toMatchObject({ wynik: 'BLAD', powod: expect.stringContaining('VALIDATION_ERROR') })
    expect((w as { powod: string }).powod).not.toContain(NADAWCA_TESTOWY.phone)
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY', zlecenie: { numer: 'ZK-9', proba: 1 } })
    expect(await db.courierPickupOrder.count()).toBe(1)
  })

  it('przerwane połączenie: NIEJEDNOZNACZNY z alertem, kolejne kliknięcia bez żądania', async () => {
    await firma()
    atrapa = dpdAtrapa([{ error: new Error('socket hang up') }])
    expect(await zamow()).toMatchObject({ wynik: 'NIEJEDNOZNACZNY', istnialo: false })
    expect(await db.alert.count({ where: { kind: 'KURIER_NIEJEDNOZNACZNY', closedAt: null } })).toBe(1)
    expect(await zamow()).toMatchObject({ wynik: 'NIEJEDNOZNACZNY', istnialo: true })
    expect(zadania()).toHaveLength(1)
  })

  it('złe dane z okna (data w przeszłości, odwrócone godziny, 0 paczek) = odmowa bez żądania', async () => {
    await firma()
    expect(await zamow({ data: '2026-11-19' })).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('przeszłości') })
    expect(await zamow({ odMin: 900, doMin: 800 })).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('godziny') })
    expect(await zamow({ liczba: 0 })).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('liczba paczek') })
    expect(atrapa.calls).toEqual([])
  })
})

describe('włącznik zapisany na karcie konta przewoźnika (ustawienia konta)', () => {
  const registry = defaultRegistry()
  const KLUCZ = { APP_ENCRYPTION_KEY: 'b'.repeat(64), APP_MODE: 'self-host' }
  const karta = (pola: Record<string, string>) => zapiszKontaPrzewoznikow(db, registry, [{ id: 'dpd', sekrety: {}, pola, nadawanie: {} }], { actorId: 'u-test', env: KLUCZ })

  it('włączony kartą konta (reguła bez włącznika): przycisk i zamówienie', async () => {
    await firma({ ...KONTO, zamawianieKuriera: undefined })
    await karta({ zamawianieKuriera: 'tak' })
    expect(((await db.carrierRule.findFirstOrThrow({ where: { carrier: 'DPD' } })).config as Record<string, unknown>)['zamawianieKuriera']).toBeUndefined()
    expect((await stanZamawianiaKuriera(db, deps())).get('DPD')).toMatchObject({ powod: null })
    atrapa = dpdAtrapa([OK('ZK-K1')])
    expect(await zamow()).toMatchObject({ wynik: 'ZAMOWIONY', zlecenie: { numer: 'ZK-K1' } })
    expect(zadania()).toHaveLength(1)
  })

  it('wyłączony kartą konta przy włączniku w regule: wpis konta wygrywa (fałsz i wyczyszczone pole)', async () => {
    await firma()
    await karta({ zamawianieKuriera: 'nie' })
    expect((await stanZamawianiaKuriera(db, deps())).size).toBe(0)
    expect(await zamow()).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('wyłączone') })
    await karta({ zamawianieKuriera: '' })
    expect((await stanZamawianiaKuriera(db, deps())).size).toBe(0)
    expect(await zamow()).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringContaining('wyłączone') })
    expect(atrapa.calls).toEqual([])
  })
})

describe('zamówienie przerwane w toku (proces zatrzymany między rezerwacją a wynikiem)', () => {
  /** Wiersz TWORZENIE jak po przerwanym żądaniu; `minut` = ile minut przed „teraz” testu był ostatnio zmieniony. */
  async function utkniety(minut: number): Promise<string> {
    const w = await db.courierPickupOrder.create({
      data: { carrier: 'DPD', adapterKey: 'dpd.services.zapis.v1', accountKey: '', pickupDay: '2026-11-23', attempt: 1, reference: 'ref-utkniety', state: 'TWORZENIE', fromMinute: 780, toMinute: 900, parcels: 2, weightKg: 3.5, requestedBy: 'u-test', requestedName: 'Magazyn Test' },
    })
    await sys.$executeRaw`UPDATE "CourierPickupOrder" SET "updatedAt" = ${new Date(PIATEK.getTime() - minut * 60_000)} WHERE id = ${w.id}`
    return w.id
  }
  const alerty = () => db.alert.count({ where: { kind: 'KURIER_NIEJEDNOZNACZNY', closedAt: null } })

  it('starsze niż 5 minut: odczyt stanu zmienia na NIEJEDNOZNACZNY z jednym alertem; kliknięcie bez żądania', async () => {
    await firma()
    const id = await utkniety(10)
    expect((await stanZamawianiaKuriera(db, deps())).get('DPD')!.zlecenia).toEqual([expect.objectContaining({ id, stan: 'NIEJEDNOZNACZNY' })])
    expect(await alerty()).toBe(1)
    await stanZamawianiaKuriera(db, deps())
    expect(await alerty()).toBe(1)
    expect(await zamow()).toMatchObject({ wynik: 'NIEJEDNOZNACZNY', istnialo: true })
    expect(atrapa.calls).toEqual([])
    expect(await alerty()).toBe(1)
  })

  it('starsze niż 5 minut, pierwsze kliknięcie bez odczytu stanu: NIEJEDNOZNACZNY z alertem, bez żądania', async () => {
    await firma()
    await utkniety(6)
    expect(await zamow()).toMatchObject({ wynik: 'NIEJEDNOZNACZNY', istnialo: true })
    expect(atrapa.calls).toEqual([])
    expect(await alerty()).toBe(1)
  })

  it('świeże (2 minuty): zostaje „w toku”, bez alertu', async () => {
    await firma()
    await utkniety(2)
    expect((await stanZamawianiaKuriera(db, deps())).get('DPD')!.zlecenia).toEqual([expect.objectContaining({ stan: 'TWORZENIE' })])
    expect(await zamow()).toMatchObject({ wynik: 'W_TOKU', istnialo: true })
    expect(atrapa.calls).toEqual([])
    expect(await alerty()).toBe(0)
  })
})
