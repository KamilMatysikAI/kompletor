// Automat „Zamawiaj kuriera automatycznie” (lib/wysylka/zamowienie-kuriera.ts, `zamowKurieraAutomatycznie`) na atrapie
// DPDServices i prawdziwej bazie: zamówienie po pierwszej paczce z opóźnieniem, nigdy drugie zlecenie na dzień
// (jakikolwiek wiersz dnia, wyścig dwóch przebiegów, przebieg równoległy z kliknięciem), wynik niepewny i przerwany
// zapis zatrzymują dzień, pewna odmowa = najwyżej jedno ponowienie, liczenie paczek po ostatnim odbiorze, dzień wolny,
// wyłączone ustawienie i izolacja firm. Dane fikcyjne, zero połączeń z DPD.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { fromWarsaw } from '@/lib/rdzen/kalendarz'
import { ALERT_KURIERA_AUTOMAT, RECZNIE, zamowKuriera, zamowKurieraAutomatycznie, type DepsKuriera } from '@/lib/wysylka/zamowienie-kuriera'
import { AUTOMAT_ID } from '@/lib/wysylka/kurier-regula'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, json, NADAWCA_TESTOWY, type DpdReply } from './dpd-atrapa'
import { order, product, seedBase } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const ENV = { EKRANY_PRACA: '1', DPD_LOGIN, DPD_PASSWORD }
const KONTO = { baseUrl: DPD_DEMO, payerFid: DPD_FID, zapisWlaczony: true, zamawianieKuriera: true, zamawianieKurieraAutomat: true, defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20 }
const KURIER = '/public/courierorder/v1/packagesPickupCall'
const DOSTEPNOSC = '/public/courierorder/v1/courierOrderAvailability'
// surowa odpowiedź z produkcji: `offset` w minutach, bez dni
const LISTA_PROD = json({ status: 'OK', ranges: [{ offset: 360, range: '09:00-17:00' }, { offset: 180, range: '11:00-14:00' }, { offset: 180, range: '14:00-17:00' }] })
const OK = (nr = 'ZK-1') => json({ status: { status: 'OK' }, orderNumber: nr, checkSum: 'cs-1' })
// pewna odmowa godzin (jak w odpowiedzi DPD na niedozwolony przedział): tylko po niej automat ponawia
const ODMOWA = json({ status: { status: 'VALIDATION_ERROR', errorDetails: [{ code: 'INCORRECT_PICKUP_TIME', description: 'Incorrect pickup time', fields: ['pickupTimeFrom'] }] } })

// wtorek 24.11.2026 (Warszawa); harmonogram DPD pn–pt, odbiór 13:00, „wyślemy dziś do” 12:00
const DZIS = '2026-11-24'
const o = (day: string, hm: string) => fromWarsaw(day, (Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))) * 60_000)
let teraz = o(DZIS, '09:30')

/** Atrapa DPD: dostępność zawsze z listy, zamówienia z kolejki (domyślnie OK); każde zamówienie odpowiada z opóźnieniem. */
let calls: { path: string; method: string; body: unknown }[] = []
let kolejka: DpdReply[] = []
const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
  const path = new URL(url).pathname
  calls.push({ path, method: init?.method ?? 'GET', body: init?.body === undefined ? null : (JSON.parse(String(init.body)) as unknown) })
  let r: DpdReply = json({ status: 'OK' })
  if (path === DOSTEPNOSC) r = LISTA_PROD
  if (path === KURIER) {
    await new Promise((res) => setTimeout(res, 40))
    r = kolejka.shift() ?? OK(`ZK-${calls.length}`)
  }
  if ('error' in r) throw r.error
  return new Response(r.body, { status: r.status })
}
const deps = (): DepsKuriera => ({ fetch: fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => teraz })
const zamowienia = () => calls.filter((c) => c.path === KURIER)
const automat = (d: PrismaClient = db) => zamowKurieraAutomatycznie(d, deps())
const alerty = (d: PrismaClient = db) => d.alert.findMany({ where: { kind: ALERT_KURIERA_AUTOMAT }, orderBy: { createdAt: 'asc' } })

async function firma(d: PrismaClient, org: string, konto: Record<string, unknown> = KONTO): Promise<void> {
  await d.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: konto as never } })
  await d.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
  await sys.organization.update({ where: { id: org }, data: { settings: { nadawca: NADAWCA_TESTOWY } } })
  await d.carrierPickup.deleteMany({ where: { carrier: 'DPD' } })
  await d.carrierPickup.create({ data: { carrier: 'DPD', weekdays: [1, 2, 3, 4, 5], pickupMinute: 13 * 60, promiseUntilMinute: 12 * 60, active: true } })
}

/** Spakowane zamówienie z przesyłką DPD z numerem listu, utworzoną o `kiedy`. */
async function paczka(kiedy: Date, o2: { wagaKg?: number; status?: string | null; sprawdzona?: Date | null; d?: PrismaClient } = {}): Promise<string> {
  const d = o2.d ?? db
  const pid = await product(d, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const r = await ingestOrder(d, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: 'Kurier DPD', paymentState: 'PAID', totalGross: 30 }), { now: kiedy })
  await d.order.update({ where: { id: r.orderId! }, data: { status: 'SPAKOWANE' } })
  const s = await d.shipment.create({
    data: { orderId: r.orderId!, packageNo: 1, reference: `ref-${r.orderId}`, state: 'UTWORZONA', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', weightKg: o2.wagaKg ?? 1.5, externalRef: `000${Math.floor(Math.random() * 1e9)}U`, createdAt: kiedy, carrierStatus: o2.status ?? null, trackedAt: o2.sprawdzona ?? null },
  })
  return s.id
}

async function wiersz(dzien: string, stan: string, o2: { od?: number; do?: number; kto?: string; failureKind?: string | null; attempt?: number; lastError?: string | null } = {}): Promise<string> {
  const w = await db.courierPickupOrder.create({
    data: { carrier: 'DPD', adapterKey: 'dpd.services.zapis.v1', accountKey: '', pickupDay: dzien, attempt: o2.attempt ?? 1, reference: `r-${Math.random().toString(36).slice(2)}`, state: stan, fromMinute: o2.od ?? 9 * 60, toMinute: o2.do ?? 17 * 60, parcels: 1, weightKg: 1, requestedBy: o2.kto ?? 'u-test', requestedName: 'Magazyn Test', failureKind: o2.failureKind ?? null, lastError: o2.lastError ?? null },
  })
  return w.id
}

const przyjechal = (dzien: string, kiedy: Date) => db.carrierPickupEvent.create({ data: { carrier: 'DPD', pickupDay: dzien, arrivedAt: kiedy, actorId: 'u-test', actorName: 'Magazyn Test' } })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
  calls = []
  kolejka = []
  teraz = o(DZIS, '09:30')
  await firma(db, ORG_A)
})

describe('automat: zamówienie i bramki bez sieci', () => {
  it('ustawienie wyłączone (albo samo zamawianie wyłączone) = zero żądań i zero wierszy', async () => {
    await paczka(o(DZIS, '09:00'))
    for (const k of [{ ...KONTO, zamawianieKurieraAutomat: undefined }, { ...KONTO, zamawianieKurieraAutomat: false }, { ...KONTO, zamawianieKuriera: undefined }]) {
      await firma(db, ORG_A, k)
      await automat()
    }
    expect(calls).toEqual([])
    expect(await db.courierPickupOrder.count()).toBe(0)
  })

  it('pierwsza paczka: czeka kilka minut, potem jedno zamówienie na dziś 09:00–17:00; kolejne przebiegi nic nie wysyłają', async () => {
    await paczka(o(DZIS, '09:28'))
    expect(await automat()).toMatchObject([{ decyzja: 'CZEKA' }])
    expect(calls).toEqual([])
    teraz = o(DZIS, '09:40')
    await paczka(o(DZIS, '09:35'), { wagaKg: 2 })
    expect(await automat()).toMatchObject([{ decyzja: 'ZAMOW', wynik: 'ZAMOWIONY' }])
    expect(zamowienia()).toHaveLength(1)
    expect(zamowienia()[0]!.body).toMatchObject({ pickupDate: DZIS, pickupTimeFrom: '09:00', pickupTimeTo: '17:00', packagesForCollection: { packagesParams: { parcel: { count: 2, weight: 3.5 } } } })
    expect(await db.courierPickupOrder.findMany()).toMatchObject([{ state: 'ZAMOWIONY', requestedBy: AUTOMAT_ID, pickupDay: DZIS, attempt: 1 }])
    teraz = o(DZIS, '11:00')
    await paczka(o(DZIS, '10:30'))
    await automat()
    await automat()
    expect(zamowienia()).toHaveLength(1)
  })

  it('jakiekolwiek zlecenie na ten dzień (zamówione, w toku, niewiadoma, ręczne „nie przyjął”) = zero żądań', async () => {
    await paczka(o(DZIS, '09:00'))
    for (const [stan, fk] of [['ZAMOWIONY', null], ['TWORZENIE', null], ['NIEJEDNOZNACZNY', 'NIEJEDNOZNACZNY'], ['BLAD', RECZNIE]] as const) {
      await db.courierPickupOrder.deleteMany()
      await wiersz(DZIS, stan, { failureKind: fk })
      const w = await automat()
      expect(w[0]!.decyzja, stan).toBe('STOP')
    }
    expect(zamowienia()).toEqual([])
  })

  it('dzień wolny (11.11): nic na święto, zamówienie dopiero na następny dzień odbioru', async () => {
    teraz = o('2026-11-11', '09:30')
    await paczka(o('2026-11-11', '09:00'))
    await automat()
    expect(zamowienia().map((c) => (c.body as { pickupDate: string }).pickupDate)).toEqual(['2026-11-12'])
  })
})

describe('automat: wynik niepewny, odmowa, przerwany zapis', () => {
  it('przerwane połączenie = NIEJEDNOZNACZNY; dzień zatrzymany (kolejne przebiegi bez żądania)', async () => {
    await paczka(o(DZIS, '09:00'))
    kolejka = [{ error: new Error('socket hang up') }]
    expect(await automat()).toMatchObject([{ decyzja: 'ZAMOW', wynik: 'NIEJEDNOZNACZNY' }])
    teraz = o(DZIS, '09:50')
    await automat()
    await automat()
    expect(zamowienia()).toHaveLength(1)
    expect(await db.courierPickupOrder.findMany()).toMatchObject([{ state: 'NIEJEDNOZNACZNY', requestedBy: AUTOMAT_ID }])
  })

  it('pewna odmowa: alert, jedno ponowienie na inny przedział (11:00–14:00), po drugiej odmowie koniec z alertem', async () => {
    await paczka(o(DZIS, '09:00'))
    kolejka = [ODMOWA, ODMOWA]
    expect(await automat()).toMatchObject([{ decyzja: 'ZAMOW', wynik: 'BLAD' }])
    expect(await automat()).toMatchObject([{ decyzja: 'ZAMOW', wynik: 'BLAD' }])
    for (let i = 0; i < 3; i++) await automat()
    expect(zamowienia().map((c) => [(c.body as { pickupTimeFrom: string }).pickupTimeFrom, (c.body as { pickupTimeTo: string }).pickupTimeTo])).toEqual([
      ['09:00', '17:00'],
      ['11:00', '14:00'],
    ])
    const w = await db.courierPickupOrder.findMany({ orderBy: { attempt: 'asc' } })
    expect(w.map((x) => [x.attempt, x.state])).toEqual([
      [1, 'BLAD'],
      [2, 'BLAD'],
    ])
    const a = await alerty()
    expect(a.length).toBe(2)
    expect(a[0]!.message).toContain('spróbuje jeszcze raz')
    expect(a[1]!.message).toContain('już nie ponawia')
  })

  it('odmowa inna niż godziny (nieznany błąd DPD, limit żądań): bez ponowienia, STOP z alertem; to samo po takiej odmowie ręcznej', async () => {
    await paczka(o(DZIS, '09:00'))
    kolejka = [json({ orderNumber: '0', status: { status: 'UNKNOWN_ERROR' } })]
    expect(await automat()).toMatchObject([{ decyzja: 'ZAMOW', wynik: 'BLAD' }])
    for (let i = 0; i < 3; i++) expect(await automat()).toMatchObject([{ decyzja: 'STOP' }])
    expect(zamowienia()).toHaveLength(1)
    expect((await alerty()).some((a) => a.message.includes('innego niż godziny'))).toBe(true)
    await db.courierPickupOrder.deleteMany()
    calls.length = 0
    for (const powod of ['DPD odrzucił zamówienie kuriera: UNKNOWN_ERROR', 'DPD zamówienie kuriera: HTTP 429 (za dużo żądań), DPD go nie przyjął; spróbuj za chwilę']) {
      await db.courierPickupOrder.deleteMany()
      await wiersz(DZIS, 'BLAD', { failureKind: 'TRWALY', lastError: powod })
      expect(await automat()).toMatchObject([{ decyzja: 'STOP' }])
    }
    expect(zamowienia()).toEqual([])
  })

  it('wiersz TWORZENIE po restarcie (starszy niż 5 min) = NIEJEDNOZNACZNY z alertem, bez żądania', async () => {
    await paczka(o(DZIS, '09:00'))
    const id = await wiersz(DZIS, 'TWORZENIE', { kto: AUTOMAT_ID })
    await db.$executeRaw`UPDATE "CourierPickupOrder" SET "updatedAt" = ${o(DZIS, '09:10')} WHERE id = ${id}`
    await automat()
    expect(zamowienia()).toEqual([])
    expect(await db.courierPickupOrder.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'NIEJEDNOZNACZNY' })
    expect(await db.alert.count()).toBeGreaterThan(0)
  })
})

describe('automat: wyścigi', () => {
  it('dwa równoległe przebiegi automatu = dokładnie jedno żądanie i jeden wiersz', async () => {
    await paczka(o(DZIS, '09:00'))
    await Promise.all([automat(), automat(), automat()])
    expect(zamowienia()).toHaveLength(1)
    expect(await db.courierPickupOrder.count()).toBe(1)
  })

  it('kliknięcie „Zamów kuriera” równolegle z automatem = jedno żądanie', async () => {
    await paczka(o(DZIS, '09:00'))
    await Promise.all([automat(), zamowKuriera(db, { carrier: 'DPD', data: DZIS, odMin: 9 * 60, doMin: 17 * 60, liczba: 1, wagaKg: 1.5, userId: 'u-test', userName: 'Magazyn Test' }, deps()), automat()])
    expect(zamowienia()).toHaveLength(1)
    expect(await db.courierPickupOrder.count()).toBe(1)
  })
})

describe('automat: które paczki czekają na kuriera', () => {
  it('po „Przyjechał”: paczki sprzed przyjazdu nie zamawiają kuriera na jutro, paczka po przyjeździe tak', async () => {
    await paczka(o(DZIS, '08:00'))
    await przyjechal(DZIS, o(DZIS, '09:00'))
    await automat()
    expect(zamowienia()).toEqual([])
    await paczka(o(DZIS, '09:10'))
    await automat()
    expect(zamowienia().map((c) => (c.body as { pickupDate: string }).pickupDate)).toEqual(['2026-11-25'])
  })

  it('dzisiejszy podjazd jeszcze trwa (bez „Przyjechał”): nic na jutro; po końcu okna liczą się tylko paczki po nim', async () => {
    teraz = o(DZIS, '15:00')
    await wiersz(DZIS, 'ZAMOWIONY', { od: 14 * 60, do: 17 * 60 })
    await paczka(o(DZIS, '14:30'))
    expect(await automat()).toMatchObject([{ decyzja: 'CZEKA', powod: expect.stringContaining('z dziś') }])
    teraz = o(DZIS, '17:30')
    await automat()
    expect(zamowienia()).toEqual([])
    await paczka(o(DZIS, '17:10'))
    await automat()
    expect(zamowienia().map((c) => (c.body as { pickupDate: string }).pickupDate)).toEqual(['2026-11-25'])
  })

  it('bez śladu odbioru (bez „Przyjechał” i zleceń): paczki sprzed dzisiejszej północy niepewne, alert raz; zamówienie dopiero po dzisiejszej paczce i tylko z nią', async () => {
    await paczka(o('2026-11-23', '12:00'))
    for (let i = 0; i < 3; i++) expect(await automat()).toMatchObject([{ decyzja: 'STOP' }])
    expect(zamowienia()).toEqual([])
    expect((await alerty()).length).toBe(1)
    await paczka(o(DZIS, '09:00'))
    await automat()
    expect(zamowienia()).toHaveLength(1)
    const z = zamowienia()[0]!.body as { packagesForCollection: { packagesParams: { parcel: { count: number } } } }
    expect(z.packagesForCollection.packagesParams.parcel.count).toBe(1)
  })

  it('odebrane wg śledzenia i anulowane nie liczą się; same paczki z nierozpoznanym statusem = bez zamówienia, alert raz', async () => {
    await paczka(o(DZIS, '09:00'), { status: 'PRZEKAZANA', sprawdzona: o(DZIS, '09:20') })
    const anul = await paczka(o(DZIS, '09:00'))
    await db.shipment.update({ where: { id: anul }, data: { state: 'ANULOWANA' } })
    await automat()
    expect(zamowienia()).toEqual([])
    expect(await alerty()).toEqual([])
    await paczka(o(DZIS, '09:00'), { status: 'NIEZNANY', sprawdzona: o(DZIS, '09:20') })
    expect(await automat()).toMatchObject([{ decyzja: 'STOP', powod: expect.stringContaining('nie wiadomo') }])
    await automat()
    expect(zamowienia()).toEqual([])
    expect(await alerty()).toHaveLength(1)
  })
})

describe('automat: izolacja firm', () => {
  it('przebieg jednej firmy nie widzi paczek, zleceń ani kont drugiej', async () => {
    await firma(dbB, ORG_B)
    await paczka(o(DZIS, '09:00'), { d: dbB })
    expect(await automat(db)).toMatchObject([{ decyzja: 'CZEKA' }])
    expect(zamowienia()).toEqual([])
    expect(await dbB.courierPickupOrder.count()).toBe(0)
    await automat(dbB)
    expect(zamowienia()).toHaveLength(1)
    expect(await dbB.courierPickupOrder.count()).toBe(1)
    expect(await db.courierPickupOrder.count()).toBe(0)
    // firma A z paczką: osobne zlecenie, zlecenie firmy B jej nie blokuje
    await paczka(o(DZIS, '09:00'))
    await automat(db)
    expect(zamowienia()).toHaveLength(2)
    expect(await db.courierPickupOrder.count()).toBe(1)
  })
})
