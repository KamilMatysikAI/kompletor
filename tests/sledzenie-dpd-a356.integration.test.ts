// paczki DPD (także nadane przez Base Courier) śledzone prosto w DPD (DPDInfoServices), gdy firma ma kompletne
// konto DPD; brak konta, brak zdarzeń albo błąd DPD = dotychczasowa droga (Base Courier). Atrapa DPD i Base Courier
// (tests/dpd-info-atrapa.ts), baza testowa, dane fikcyjne, zero połączeń z DPD i Base Courier.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { sledzeniePrzesylek, SLEDZENIE_PO_WYSYLCE_CO_MS } from '@/lib/pakowanie/wyslane-po-przyjezdzie'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { statusyKuriera } from '@/lib/wysylka/status-kuriera'
import { BC_KEY, BC_LOGIN, BC_SANDBOX } from './basecourier-atrapa'
import { DPD_INFO_FID, DPD_INFO_HASLO, DPD_INFO_LOGIN, FAULT_LOGOWANIA, sledzenieAtrapa } from './dpd-info-atrapa'
import { PRZYKLADOWE_ODBIORY } from './pakowanie-fixtures'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
})

const H = 3600_000
const ENV = { EKRANY_PRACA: '1', BASE_COURIER_LOGIN: BC_LOGIN, BASE_COURIER_API_KEY: BC_KEY, DPD_LOGIN: DPD_INFO_LOGIN, DPD_PASSWORD: DPD_INFO_HASLO }
const KONFIG_BC = { baseUrl: BC_SANDBOX, zapisWlaczony: true }
/** Konto DPD firmy jak na ekranie kont: środowisko produkcyjne i FID. */
const KONTO_DPD = { przewoznicy: { ustawienia: { dpd: { srodowisko: 'produkcja', masterFid: DPD_INFO_FID, payerFid: DPD_INFO_FID } } } }

let at: ReturnType<typeof sledzenieAtrapa>
const teraz = () => new Date(Date.now() + 3 * H)
const deps = (o: { env?: Record<string, string>; now?: () => Date } = {}) => {
  const env = o.env ?? ENV
  return { fetch: at.fetchImpl, env, secrets: { env, envFallback: true }, now: o.now ?? teraz, dpd: { retry: { attempts: 1, baseDelayMs: 0 } } }
}

let nr = 0
/** Zamówienie DPD „Do wysłania” (albo „Wysłane”) z przesyłką Base Courier: id zamówienia BC i numer listu DPD. */
async function paczkaBc(o: { status?: 'DO_WYSLANIA' | 'WYSLANE'; carrier?: 'DPD' | 'DPD_EMPIK' } = {}): Promise<{ id: string; bcId: string; list: string }> {
  const pid = await product(db, `P-${++nr}-${Math.random().toString(36).slice(2, 6)}`, 50)
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { paymentState: 'PAID', deliveryMethod: (o.carrier ?? 'DPD') === 'DPD' ? 'Kurier DPD' : 'Dostawa do salonu Empik' }), { now: T0 })
  const id = r.orderId!
  const carrier = o.carrier ?? 'DPD'
  await db.order.update({ where: { id }, data: { carrier, status: o.status ?? 'DO_WYSLANIA' } })
  await db.orderEvent.create({ data: { orderId: id, kind: 'SPAKOWANE', actorId: 'test', createdAt: new Date(Date.now() - H) } })
  if (o.status === 'WYSLANE') await db.orderEvent.create({ data: { orderId: id, kind: 'WYSLANE', actorId: 'test' } })
  await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED', wfirmaDocId: `FV/T/${nr}` } })
  const bcId = String(24_500_000 + nr)
  const list = `10554824${String(40000 + nr).padStart(5, '0')}U`
  await db.shipment.create({ data: { orderId: id, packageNo: 1, reference: `ref-${id}`, state: 'UTWORZONA', adapterKey: 'basecourier.zapis.v1', carrier, externalRef: bcId, trackingNumber: list } })
  return { id, bcId, list }
}

const status = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id }, select: { status: true } })).status
const zdarzeniaStatusu = async (orderId: string) =>
  (await db.orderEvent.findMany({ where: { orderId, kind: 'PRZESYLKA_STATUS' }, orderBy: { createdAt: 'asc' }, select: { data: true } })).map((e) => e.data as Record<string, unknown>)

/** Zdarzenia paczki z 20.11.2026 (1055482442661U): rejestracja, odbiór przez kuriera, mail, oddział. */
const ODEBRANA = [
  { kod: '030103', opis: 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana', czas: '2026-11-20T11:46:37.848' },
  { kod: '040101', opis: 'Przesyłka odebrana przez Kuriera', czas: '2026-11-20T14:32:40.534' },
  { kod: '170310', opis: 'Powiadomienie mail', czas: '2026-11-20T14:35:08.41' },
  { kod: '330135', opis: 'Przyjęcie przesyłki w oddziale DPD ', czas: '2026-11-20T18:41:12.067' },
]

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.carrierPickup.createMany({ data: PRZYKLADOWE_ODBIORY })
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1', statusMode: 'PRACA', trackingMode: 'PRACA', config: { zapisWlaczony: true } as Prisma.InputJsonValue } })
  for (const carrier of ['DPD', 'DPD_EMPIK'] as const) await db.carrierRule.updateMany({ where: { carrier }, data: { shippingModule: 'BASE_COURIER', adapterKey: 'basecourier.zapis.v1', config: KONFIG_BC } })
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: KONTO_DPD as object } })
  at = sledzenieAtrapa()
})

describe('śledzenie DPD prosto z DPD', () => {
  it('paczka Base Courier + konto DPD: odbiór przez kuriera w DPD = „Wysłane”, Base Courier niepytany, status i opis z DPD na karcie', async () => {
    const p = await paczkaBc()
    at.zdarzenia.set(p.list, ODEBRANA)
    at.bcStatusy.set(p.bcId, [{ status: '030103', kod: 1, opis: 'Zarejestrowano dane przesyłki' }])

    expect(await sledzeniePrzesylek(db, deps())).toMatchObject({ sprawdzone: 1, przeniesione: 1, bledy: [] })
    expect(await status(p.id)).toBe('WYSLANE')
    expect(at.bcCalls).toEqual([])
    expect(at.dpdCalls).toHaveLength(1)
    // kanał = FID konta, numer listu z przesyłki
    expect(at.dpdCalls[0]!.body).toContain(`<channel>${DPD_INFO_FID}</channel>`)
    expect(at.dpdCalls[0]!.body).toContain(`<waybill>${p.list}</waybill>`)
    expect((await db.shipment.findFirstOrThrow({ where: { orderId: p.id } })).carrierStatus).toBe('330135')
    expect(await zdarzeniaStatusu(p.id)).toEqual([{ przesylka: expect.any(String), status: '330135', stan: 'PRZEKAZANA', opis: 'Przyjęcie przesyłki w oddziale DPD' }])
    const k = (await statusyKuriera(db, [p.id])).get(p.id)!
    expect(k).toMatchObject({ status: '330135', stan: 'PRZEKAZANA', nazwa: 'Przyjęcie przesyłki w oddziale DPD' })
  })

  it('sama rejestracja i mail 170310 w DPD: zostaje „Do wysłania” (170310 to nie odbiór ani doręczenie)', async () => {
    const p = await paczkaBc()
    at.zdarzenia.set(p.list, [ODEBRANA[0]!, { kod: '170310', opis: 'Powiadomienie mail', czas: '2026-11-20T11:50:00' }])
    expect(await sledzeniePrzesylek(db, deps())).toMatchObject({ sprawdzone: 1, przeniesione: 0, bledy: [] })
    expect(await status(p.id)).toBe('DO_WYSLANIA')
    expect((await zdarzeniaStatusu(p.id)).map((e) => [e['status'], e['stan']])).toEqual([['030103', 'PRZED_NADANIEM']])
    expect(at.bcCalls).toEqual([])
  })

  it('błąd DPD (5xx) = droga Base Courier w tym samym przebiegu, błąd jedną linią w wyniku (bez hasła)', async () => {
    const p = await paczkaBc()
    at.awarie.push({ status: 503, body: 'serwis' })
    at.bcStatusy.set(p.bcId, [{ status: '040101', kod: 2, opis: 'Przesyłka odebrana przez Kuriera' }, { status: '030103', kod: 1 }])
    const w = await sledzeniePrzesylek(db, deps())
    expect(w).toMatchObject({ sprawdzone: 1, przeniesione: 1 })
    expect(w.bledy).toHaveLength(1)
    expect(w.bledy[0]).toMatch(/^DPD InfoServices: 1 odczyt nieudany; użyto drogi modułu przesyłki/)
    expect(w.bledy.join(' ')).not.toContain(DPD_INFO_HASLO)
    expect(await status(p.id)).toBe('WYSLANE')
    expect(at.bcCalls.map((c) => [c.endpoint, c.id])).toEqual([['getWaybillTracking.json', p.bcId]])
    expect(await zdarzeniaStatusu(p.id)).toMatchObject([{ status: '040101', stan: 'PRZEKAZANA' }])
  })

  it('DPD bez zdarzeń dla listu = droga Base Courier bez błędu', async () => {
    const p = await paczkaBc()
    at.bcStatusy.set(p.bcId, [{ status: '030103', kod: 1 }])
    expect(await sledzeniePrzesylek(db, deps())).toMatchObject({ sprawdzone: 1, przeniesione: 0, bledy: [] })
    expect(at.dpdCalls).toHaveLength(1)
    expect(at.bcCalls).toHaveLength(1)
    expect(await status(p.id)).toBe('DO_WYSLANIA')
  })

  it('odrzucone logowanie DPD: DPD pominięty do końca przebiegu (jedno żądanie), reszta przez Base Courier', async () => {
    const a = await paczkaBc()
    const b = await paczkaBc()
    at.awarie.push({ status: 500, body: FAULT_LOGOWANIA })
    for (const p of [a, b]) at.bcStatusy.set(p.bcId, [{ status: '030103', kod: 1 }])
    const w = await sledzeniePrzesylek(db, deps())
    expect(w).toMatchObject({ sprawdzone: 2, przeniesione: 0 })
    expect(at.dpdCalls).toHaveLength(1)
    expect(at.bcCalls).toHaveLength(2)
    expect(w.bledy).toEqual([expect.stringMatching(/^DPD InfoServices: 1 odczyt nieudany, DPD pominięty do końca przebiegu/)])
  })

  it('firma bez konta DPD (brak kluczy albo konto demo): DPD niepytany, wszystko jak dotąd z Base Courier', async () => {
    const p = await paczkaBc()
    at.zdarzenia.set(p.list, ODEBRANA)
    at.bcStatusy.set(p.bcId, [{ status: '030103', kod: 1 }])
    const bezKluczy = { EKRANY_PRACA: '1', BASE_COURIER_LOGIN: BC_LOGIN, BASE_COURIER_API_KEY: BC_KEY }
    expect(await sledzeniePrzesylek(db, deps({ env: bezKluczy }))).toMatchObject({ sprawdzone: 1, przeniesione: 0, bledy: [] })
    expect(at.dpdCalls).toHaveLength(0)
    expect(await status(p.id)).toBe('DO_WYSLANIA')

    // konto DPD w środowisku demo: usługa śledzenia nie ma demo, więc też bez DPD
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { przewoznicy: { ustawienia: { dpd: { srodowisko: 'demo', masterFid: DPD_INFO_FID } } } } as object } })
    const pozniej = () => new Date(teraz().getTime() + 2 * SLEDZENIE_PO_WYSYLCE_CO_MS)
    expect(await sledzeniePrzesylek(db, deps({ now: pozniej }))).toMatchObject({ sprawdzone: 1, bledy: [] })
    expect(at.dpdCalls).toHaveLength(0)
    expect(at.bcCalls).toHaveLength(2)
  })

  it('po „Wysłane”: 170310 nie kończy śledzenia (PRZEKAZANA), dopiero 190101 = DORECZONA i koniec pytania', async () => {
    const p = await paczkaBc({ status: 'WYSLANE' })
    at.zdarzenia.set(p.list, ODEBRANA)
    expect(await sledzeniePrzesylek(db, deps())).toMatchObject({ sprawdzone: 1, bledy: [] })
    expect((await zdarzeniaStatusu(p.id)).map((e) => e['stan'])).toEqual(['PRZEKAZANA'])

    at.zdarzenia.set(p.list, [...ODEBRANA, { kod: '170102', opis: 'Wydanie przesyłki do doręczenia', czas: '2026-11-21T08:07:00' }, { kod: '190101', opis: 'Przesyłka doręczona ', czas: '2026-11-21T12:10:00' }, { kod: '170310', opis: 'Powiadomienie mail', czas: '2026-11-21T12:11:00' }])
    const potem = () => new Date(teraz().getTime() + SLEDZENIE_PO_WYSYLCE_CO_MS + H)
    expect(await sledzeniePrzesylek(db, deps({ now: potem }))).toMatchObject({ sprawdzone: 1, bledy: [] })
    // ostatnie zdarzenie to mail 170310 (neutralny): stan i status z 190101
    expect((await zdarzeniaStatusu(p.id)).map((e) => [e['status'], e['stan']])).toEqual([
      ['330135', 'PRZEKAZANA'],
      ['190101', 'DORECZONA'],
    ])
    const jeszczePozniej = () => new Date(teraz().getTime() + 3 * SLEDZENIE_PO_WYSYLCE_CO_MS + H)
    expect(await sledzeniePrzesylek(db, deps({ now: jeszczePozniej }))).toMatchObject({ sprawdzone: 0 })
    expect(at.dpdCalls).toHaveLength(2)
    expect(at.bcCalls).toHaveLength(0)
  })

  it('DPD do salonu Empik (przesyłka Base Courier) też pytana w DPD kontem głównym', async () => {
    const p = await paczkaBc({ carrier: 'DPD_EMPIK' })
    at.zdarzenia.set(p.list, ODEBRANA)
    expect(await sledzeniePrzesylek(db, deps())).toMatchObject({ sprawdzone: 1, przeniesione: 1, bledy: [] })
    expect(await status(p.id)).toBe('WYSLANE')
    expect(at.bcCalls).toEqual([])
  })
})
