// Oś statusów przesyłki i historia zdarzeń śledzenia: przy włączonym „Śledź paczki aż do doręczenia” Kompletor pyta
// przewoźnika także po „Wysłane”, aż do stanu końcowego (doręczona, zwrot, anulowana), z odstępem zależnym od stanu
// i w oknie 30 dni; każdy nowy stan to wpis w historii przesyłki. Wyłączony (domyślnie) = próbkowanie i skutki jak
// dotąd. Statusu zamówienia po „Wysłane” oś nie zmienia (to osobny etap). Atrapy InPost ShipX i DPDInfoServices, dane
// fikcyjne, zero połączeń z przewoźnikami.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Carrier, OrderStatus, ShipmentTrackState } from '@prisma/client'
import { SLEDZENIE_CO_MS, sledzeniePrzesylek } from '@/lib/pakowanie/wyslane-po-przyjezdzie'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { listChangedOrders, ordersByNumber } from '@/lib/api/zamowienia'
import { automatyWysylki, parseAutomatyWysylki, zapiszAutomatyWysylki, zapiszSledzeniePrzewoznikow } from '@/lib/wysylka/automaty'
import { DPD_ZAPIS_KEY } from '@/lib/adaptery/dpd'
import { INPOST_SHIPX_ZAPIS_MANIFEST } from '@/lib/adaptery/inpost-zapis'
import type { FetchLike } from '@/lib/zrodla/http'
import { PRZYKLADOWE_ODBIORY } from './pakowanie-fixtures'
import { DPD_LOGIN, DPD_PASSWORD, DPD_DEMO, DPD_FID } from './dpd-atrapa'
import { DPD_INFO_HASLO, DPD_INFO_LOGIN, DPD_INFO_URL, dpdSledzenieAtrapa } from './dpd-sledzenie-atrapa'
import { INPOST_ORG, INPOST_SANDBOX, INPOST_TOKEN, inpostAtrapa } from './inpost-atrapa'
import { ORG_B, testDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const H = 3600_000
const D = 24 * H
const INPOST_KEY = INPOST_SHIPX_ZAPIS_MANIFEST.adapterKey
const ENV = { EKRANY_PRACA: '1', INPOST_TOKEN, DPD_LOGIN, DPD_PASSWORD, DPD_SLEDZENIE_LOGIN: DPD_INFO_LOGIN, DPD_SLEDZENIE_HASLO: DPD_INFO_HASLO }

async function kontoPraca() {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1', statusMode: 'PRACA', trackingMode: 'PRACA', config: { zapisWlaczony: true } } })
}
async function regulaInpost() {
  await db.carrierRule.updateMany({ where: { carrier: 'PACZKOMATY' }, data: { shippingModule: 'INPOST_SHIPX', adapterKey: INPOST_KEY, config: { baseUrl: INPOST_SANDBOX, organizationId: INPOST_ORG, zapisWlaczony: true } } })
}
async function regulaDpd() {
  await db.carrierRule.updateMany({
    where: { carrier: 'DPD' },
    data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: DPD_ZAPIS_KEY, config: { baseUrl: DPD_DEMO, payerFid: DPD_FID, zapisWlaczony: true, envPrefix: 'DPD', sledzenieUrl: DPD_INFO_URL } },
  })
  await zapiszSledzeniePrzewoznikow(db, { [DPD_ZAPIS_KEY]: true }, [DPD_ZAPIS_KEY, INPOST_KEY], 'u-admin')
}
async function wlaczDoKonca(tak = true) {
  await zapiszAutomatyWysylki(db, { wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: true, sledzenieDoDoreczenia: tak }, 'u-admin')
}

let nr = 0
async function paczka(carrier: Carrier, o: { status?: OrderStatus; createdAt?: Date } = {}): Promise<{ id: string; ref: string; sid: string }> {
  const pid = await product(db, `P-${++nr}-${Math.random().toString(36).slice(2, 6)}`, 50)
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { channel: 'WOO_SD', paymentState: 'PAID', ...(carrier === 'DPD' ? { deliveryMethod: 'Kurier DPD' } : {}) }), { now: T0 })
  const id = r.orderId!
  await db.order.update({ where: { id }, data: { carrier, status: o.status ?? 'DO_WYSLANIA' } })
  // zamówienie w „Wysłane” ma zdarzenie przejścia (śledzenie po „Wysłane” bez osi liczy od niego limit dni)
  if (o.status === 'WYSLANE') await db.orderEvent.create({ data: { orderId: id, kind: 'WYSLANE', actorId: 'test' } })
  await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED', wfirmaDocId: `FV/T/${nr}` } })
  const dpd = carrier === 'DPD'
  const ref = dpd ? `0000${100000 + nr}U` : `${900_000 + nr}`
  const s = await db.shipment.create({
    data: { orderId: id, packageNo: 1, reference: `ref-${id}`, state: 'UTWORZONA', adapterKey: dpd ? DPD_ZAPIS_KEY : INPOST_KEY, carrier, externalRef: ref, trackingNumber: `NR${100000 + nr}`, ...(o.createdAt ? { createdAt: o.createdAt } : {}) },
  })
  return { id, ref, sid: s.id }
}

const status = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id }, select: { status: true } })).status
const przesylka = (id: string) => db.shipment.findUniqueOrThrow({ where: { id } })
const historia = (shipmentId: string) => db.shipmentTrackEvent.findMany({ where: { shipmentId }, orderBy: { occurredAt: 'asc' } })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.carrierPickup.createMany({ data: PRZYKLADOWE_ODBIORY })
  await kontoPraca()
  await regulaInpost()
})

describe('wyłącznik „Śledź paczki aż do doręczenia”', () => {
  it('domyślnie wyłączony; zapis bez pola zostawia poprzednią wartość; ślad w AuditLog', async () => {
    expect((await automatyWysylki(db)).sledzenieDoDoreczenia).toBe(false)
    expect(parseAutomatyWysylki({ wysylkaAutomaty: { sledzenieDoDoreczenia: 'tak' } }).sledzenieDoDoreczenia).toBe(false)
    await wlaczDoKonca()
    expect((await automatyWysylki(db)).sledzenieDoDoreczenia).toBe(true)
    await zapiszAutomatyWysylki(db, { wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: false }, 'u-admin')
    expect(await automatyWysylki(db)).toMatchObject({ anulowanieWKanale: false, sledzenieDoDoreczenia: true })
    expect(await db.auditLog.count({ where: { entity: 'Organization.wysylkaAutomaty' } })).toBe(2)
  })

  it('wyłączony: paczka po „Wysłane” pytana tylko o status (zdarzenie zamówienia), oś i historia puste; „taken_by_courier” = Wysłane jak dotąd', async () => {
    const wyslana = await paczka('PACZKOMATY', { status: 'WYSLANE' })
    const czeka = await paczka('PACZKOMATY')
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(wyslana.ref), 'delivered')
    shipx.ustawStatus(Number(czeka.ref), 'taken_by_courier')
    const t = new Date(Date.now() + 3 * H)
    expect(await sledzeniePrzesylek(db, { fetch: shipx.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })).toMatchObject({ sprawdzone: 2, przeniesione: 1, bledy: [] })
    expect(await status(czeka.id)).toBe('WYSLANE')
    expect(await status(wyslana.id)).toBe('WYSLANE')
    expect(shipx.calls.some((c) => c.path.endsWith(`/${wyslana.ref}`))).toBe(true)
    for (const p of [wyslana, czeka]) {
      expect((await przesylka(p.sid)).trackState).toBeNull()
      expect((await przesylka(p.sid)).nextTrackAt).toBeNull()
    }
    expect(await db.shipmentTrackEvent.count()).toBe(0)
    expect(await db.orderEvent.count({ where: { kind: 'PRZESYLKA_STATUS' } })).toBe(2)
    expect(await db.orderEvent.count({ where: { orderId: wyslana.id, kind: 'PRZESYLKA_STATUS', data: { path: ['stan'], equals: 'DORECZONA' } } })).toBe(1)
  })
})

describe('śledzenie aż do doręczenia (wyłącznik włączony)', () => {
  it('InPost: odbiór → Wysłane, potem w doręczeniu i doręczona; historia bez dubli, odstęp wg stanu, koniec po doręczeniu; status zamówienia zostaje „Wysłane”', async () => {
    await wlaczDoKonca()
    const p = await paczka('PACZKOMATY')
    const shipx = inpostAtrapa()
    let t = new Date(Date.now() + 3 * H)
    const deps = () => ({ fetch: shipx.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })

    shipx.ustawStatus(Number(p.ref), 'taken_by_courier')
    expect(await sledzeniePrzesylek(db, deps())).toMatchObject({ sprawdzone: 1, przeniesione: 1, bledy: [] })
    expect(await status(p.id)).toBe('WYSLANE')
    let s = await przesylka(p.sid)
    expect(s).toMatchObject({ trackState: 'PRZEKAZANA', carrierStatus: 'taken_by_courier' })
    expect(s.handedOverAt?.getTime()).toBe(t.getTime())
    expect(s.trackStateSince?.getTime()).toBe(t.getTime())
    expect(s.nextTrackAt?.getTime()).toBe(t.getTime() + 3 * H)
    expect(s.deliveredAt).toBeNull()
    const przekazanoO = t.getTime()

    // przed terminem następnego odczytu: nie pytamy
    t = new Date(t.getTime() + H)
    expect((await sledzeniePrzesylek(db, deps())).sprawdzone).toBe(0)

    // w doręczeniu (dwa odczyty z tym samym statusem = jeden wpis historii)
    t = new Date(t.getTime() + 2 * H + 60_000)
    shipx.ustawStatus(Number(p.ref), 'out_for_delivery')
    expect(await sledzeniePrzesylek(db, deps())).toMatchObject({ sprawdzone: 1, przeniesione: 0, bledy: [] })
    s = await przesylka(p.sid)
    expect(s.trackState).toBe('W_DORECZENIU')
    expect(s.nextTrackAt?.getTime()).toBe(t.getTime() + H)
    t = new Date(t.getTime() + H)
    expect((await sledzeniePrzesylek(db, deps())).sprawdzone).toBe(1)
    expect(await historia(p.sid)).toHaveLength(2)

    // doręczona: data doręczenia, koniec odpytywania, status zamówienia bez zmian (etap reguł firmy jest osobno)
    t = new Date(t.getTime() + H)
    shipx.ustawStatus(Number(p.ref), 'delivered')
    expect((await sledzeniePrzesylek(db, deps())).sprawdzone).toBe(1)
    s = await przesylka(p.sid)
    expect(s).toMatchObject({ trackState: 'DORECZONA', nextTrackAt: null })
    expect(s.deliveredAt?.getTime()).toBe(t.getTime())
    expect(s.handedOverAt?.getTime()).toBe(przekazanoO)
    expect(await status(p.id)).toBe('WYSLANE')
    const h = await historia(p.sid)
    expect(h.map((e) => [e.state, e.carrierStatus, e.carrierCode])).toEqual([
      ['PRZEKAZANA', 'taken_by_courier', 'taken_by_courier'],
      ['W_DORECZENIU', 'out_for_delivery', 'out_for_delivery'],
      ['DORECZONA', 'delivered', 'delivered'],
    ])
    // zdarzenie zamówienia „status przesyłki” (automatyczne akcje) tylko przed „Wysłane”, jak dotąd
    expect(await db.orderEvent.count({ where: { orderId: p.id, kind: 'PRZESYLKA_STATUS' } })).toBe(1)

    const n = shipx.calls.length
    t = new Date(t.getTime() + 2 * D)
    expect((await sledzeniePrzesylek(db, deps())).sprawdzone).toBe(0)
    expect(shipx.calls).toHaveLength(n)
  })

  it('okno 30 dni: paczka sprzed 31 dni nie jest pytana, sprzed 20 dni tak; zwrot do nadawcy kończy odpytywanie', async () => {
    await wlaczDoKonca()
    const now = Date.now()
    const stara = await paczka('PACZKOMATY', { status: 'WYSLANE', createdAt: new Date(now - 31 * D) })
    const mloda = await paczka('PACZKOMATY', { status: 'WYSLANE', createdAt: new Date(now - 20 * D) })
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(stara.ref), 'out_for_delivery')
    shipx.ustawStatus(Number(mloda.ref), 'returned_to_sender')
    let t = new Date(now + H)
    const deps = () => ({ fetch: shipx.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })
    expect(await sledzeniePrzesylek(db, deps())).toMatchObject({ sprawdzone: 1, przeniesione: 0, bledy: [] })
    expect((await przesylka(stara.sid)).trackState).toBeNull()
    expect(await przesylka(mloda.sid)).toMatchObject({ trackState: 'ZWROT', nextTrackAt: null, deliveredAt: null })
    expect(await status(mloda.id)).toBe('WYSLANE')
    t = new Date(t.getTime() + D)
    expect((await sledzeniePrzesylek(db, deps())).sprawdzone).toBe(0)
  })

  it('błąd jednej przesyłki nie zatrzymuje reszty; przesyłka z błędem czeka pół godziny', async () => {
    await wlaczDoKonca()
    const zla = await paczka('PACZKOMATY', { status: 'WYSLANE' })
    const dobra = await paczka('PACZKOMATY', { status: 'WYSLANE' })
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(dobra.ref), 'ready_to_pickup')
    const fetchImpl: FetchLike = async (url, init) => {
      if (String(url).includes(`/shipments/${zla.ref}`)) return new Response('{"error":"awaria"}', { status: 503 })
      return shipx.fetchImpl(url, init)
    }
    const t = new Date(Date.now() + 3 * H)
    const w = await sledzeniePrzesylek(db, { fetch: fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })
    expect(w.bledy).toHaveLength(1)
    expect(await przesylka(dobra.sid)).toMatchObject({ trackState: 'W_PUNKCIE' })
    expect((await przesylka(dobra.sid)).nextTrackAt?.getTime()).toBe(t.getTime() + 6 * H)
    const z = await przesylka(zla.sid)
    expect(z.trackState).toBeNull()
    expect(z.nextTrackAt?.getTime()).toBe(t.getTime() + SLEDZENIE_CO_MS)
    expect(z.trackingStoppedAt).toBeNull()
  })

  it('DPD: stan i czas z ostatniego zdarzenia przewoźnika (czas polski), data przekazania i doręczenia z czasu zdarzeń', async () => {
    await wlaczDoKonca()
    await regulaDpd()
    // przesyłka utworzona przed zdarzeniami przewoźnika (zdarzenia sprzed utworzenia nie dają stanu końcowego)
    const p = await paczka('DPD', { createdAt: new Date('2026-11-12T06:00:00Z') })
    const at = dpdSledzenieAtrapa()
    at.zdarzenia.set(p.ref, [
      { kod: '030103', opis: 'Zarejestrowano dane przesyłki', czas: '2026-11-12T08:00:00' },
      { kod: '040101', opis: 'Przesyłka odebrana przez Kuriera', czas: '2026-11-12T14:00:00' },
    ])
    // stały zegar (zdarzenia mają stałe daty): pierwszy odczyt 13.11 08:00, drugi 12:00 czasu polskiego
    let t = new Date('2026-11-13T07:00:00Z')
    const deps = () => ({ fetch: at.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })
    expect(await sledzeniePrzesylek(db, deps())).toMatchObject({ sprawdzone: 1, przeniesione: 1, bledy: [] })
    let s = await przesylka(p.sid)
    expect(s.trackState).toBe('PRZEKAZANA')
    expect(s.handedOverAt?.toISOString()).toBe('2026-11-12T13:00:00.000Z')
    at.zdarzenia.get(p.ref)!.push({ kod: '190101', opis: 'Przesyłka doręczona', czas: '2026-11-13T11:40:00' })
    t = new Date(t.getTime() + 4 * H)
    expect((await sledzeniePrzesylek(db, deps())).sprawdzone).toBe(1)
    s = await przesylka(p.sid)
    expect(s.trackState).toBe('DORECZONA')
    expect(s.deliveredAt?.toISOString()).toBe('2026-11-13T10:40:00.000Z')
    const h = await historia(p.sid)
    expect(h.map((e) => [e.state, e.carrierCode])).toEqual([['PRZEKAZANA', '040101'], ['DORECZONA', '190101']])
    expect(h[1]!.occurredAt.toISOString()).toBe('2026-11-13T10:40:00.000Z')
  })
})


// ─── poprawki po przeglądzie osi statusów (kolejka, stan, daty, historia) ───────────────────────────────────────────
const M = 60_000
const deps = (fetch: FetchLike, t: () => Date, env: Record<string, string> = ENV) => ({ fetch, env, secrets: { env, envFallback: true }, now: t, http: { minIntervalMs: 0 } })
/** Przesyłka po „Wysłane”, już odczytana na osi (stan, ostatni odczyt i termin podane wprost). */
async function wDrodze(carrier: Carrier, o: { trackedAt: Date; nextTrackAt: Date; trackState?: ShipmentTrackState; status?: OrderStatus }) {
  const p = await paczka(carrier, { status: o.status ?? 'WYSLANE' })
  await db.shipment.update({ where: { id: p.sid }, data: { trackState: o.trackState ?? 'W_DRODZE', trackStateSince: o.trackedAt, handedOverAt: o.trackedAt, trackedAt: o.trackedAt, nextTrackAt: o.nextTrackAt } })
  return p
}

describe('kolejka po „Wysłane”: konto z błędem, limity i pierwszeństwo', () => {
  it('przesyłki konta z błędem (ponad 100) nie zagładzają kolejki: przesyłka innego konta jest odczytana najpóźniej w drugim przebiegu', async () => {
    await wlaczDoKonca()
    await regulaDpd()
    const { DPD_SLEDZENIE_LOGIN: _l, DPD_SLEDZENIE_HASLO: _h, ...bezDanychDpd } = ENV
    const t0 = Date.now() + 3 * H
    for (let i = 0; i < 105; i++) await wDrodze('DPD', { trackedAt: new Date(t0 - 4 * H), nextTrackAt: new Date(t0 - H) })
    const inna = await wDrodze('PACZKOMATY', { trackedAt: new Date(t0 - 3 * H), nextTrackAt: new Date(t0 - 30 * M) })
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(inna.ref), 'out_for_delivery')
    let t = new Date(t0)
    const w1 = await sledzeniePrzesylek(db, deps(shipx.fetchImpl, () => t, bezDanychDpd))
    expect(w1.bledy).toHaveLength(1)
    expect(w1.bledy[0]).toMatch(/DPD/)
    t = new Date(t0 + 15 * M)
    const w2 = await sledzeniePrzesylek(db, deps(shipx.fetchImpl, () => t, bezDanychDpd))
    expect(w2.sprawdzone).toBe(1)
    expect(await przesylka(inna.sid)).toMatchObject({ trackState: 'W_DORECZENIU', carrierStatus: 'out_for_delivery' })
    // błąd konta nie jest błędem przesyłki: licznik błędów przesyłek DPD zostaje 0, żadna nie jest zakończona
    expect(await db.shipment.count({ where: { carrier: 'DPD', OR: [{ trackFailures: { gt: 0 } }, { trackingStoppedAt: { not: null } }] } })).toBe(0)
  }, 120_000)

  it('limit 50 + 100: kolejka „Wysłane” ma pierwszeństwo i bierze 50, po „Wysłane” do 100 ponad nią', async () => {
    await wlaczDoKonca()
    const t0 = Date.now() + 3 * H
    const przed: string[] = []
    const po: string[] = []
    const shipx = inpostAtrapa()
    for (let i = 0; i < 55; i++) {
      const p = await paczka('PACZKOMATY')
      shipx.ustawStatus(Number(p.ref), 'confirmed')
      przed.push(p.sid)
    }
    // po „Wysłane” pytane dawniej niż kolejka „Wysłane” (null): pierwszeństwo wynika z kolejności kolejek, nie z wieku
    for (let i = 0; i < 105; i++) {
      const p = await wDrodze('PACZKOMATY', { trackedAt: new Date(t0 - 5 * H), nextTrackAt: new Date(t0 - H) })
      shipx.ustawStatus(Number(p.ref), 'adopted_at_sorting_center')
      po.push(p.sid)
    }
    const w = await sledzeniePrzesylek(db, deps(shipx.fetchImpl, () => new Date(t0)))
    expect(w.sprawdzone).toBe(150)
    expect(await db.shipment.count({ where: { id: { in: przed }, trackedAt: new Date(t0) } })).toBe(50)
    expect(await db.shipment.count({ where: { id: { in: po }, trackedAt: new Date(t0) } })).toBe(100)
  }, 180_000)
})

describe('oś po przeglądzie: stan, daty i historia', () => {
  it('nieznany odczyt po znanym stanie nie zmienia stanu ani „od kiedy”; po „Wysłane” 5 dni nieznanego stanu nie kończy śledzenia', async () => {
    await wlaczDoKonca()
    const t0 = Date.now() + 3 * H
    const p = await wDrodze('PACZKOMATY', { trackedAt: new Date(t0 - 4 * H), nextTrackAt: new Date(t0 - H), trackState: 'W_DORECZENIU' })
    await db.shipment.update({ where: { id: p.sid }, data: { carrierStatus: 'out_for_delivery' } })
    const shipx = inpostAtrapa() // bez statusu = 404 = nieznany
    let t = new Date(t0)
    expect((await sledzeniePrzesylek(db, deps(shipx.fetchImpl, () => t))).sprawdzone).toBe(1)
    let s = await przesylka(p.sid)
    expect(s.trackState).toBe('W_DORECZENIU')
    expect(s.trackStateSince?.getTime()).toBe(t0 - 4 * H)
    expect(s.trackingUnknownSince?.getTime()).toBe(t0)
    // wiersz historii: dotychczasowy stan, nowy (pusty) kod przewoźnika
    expect((await historia(p.sid)).map((e) => [e.state, e.carrierCode, e.carrierStatus])).toEqual([['W_DORECZENIU', '', null]])
    for (let d = 1; d <= 6; d++) {
      t = new Date(t0 + d * D)
      await sledzeniePrzesylek(db, deps(shipx.fetchImpl, () => t))
    }
    s = await przesylka(p.sid)
    expect(s.trackingStoppedAt).toBeNull()
    expect(s.trackState).toBe('W_DORECZENIU')
    expect(s.nextTrackAt?.getTime()).toBe(t.getTime() + H)
  })

  it('DPD „u przewoźnika” z kodem bez znaczenia dla osi: data przekazania z pierwszego zdarzenia, stan nieznany', async () => {
    await wlaczDoKonca()
    await regulaDpd()
    const p = await paczka('DPD', { createdAt: new Date('2026-11-12T06:00:00Z') })
    const at = dpdSledzenieAtrapa()
    at.zdarzenia.set(p.ref, [{ kod: '240304', opis: 'Dokumenty zwrotne', czas: '2026-11-12T15:00:00' }])
    const t = new Date('2026-11-13T07:00:00Z')
    expect(await sledzeniePrzesylek(db, deps(at.fetchImpl, () => t))).toMatchObject({ sprawdzone: 1, przeniesione: 1, bledy: [] })
    const s = await przesylka(p.sid)
    expect(s.trackState).toBe('NIEZNANY')
    expect(s.handedOverAt?.toISOString()).toBe('2026-11-12T14:00:00.000Z')
  })

  it('DPD odczytana pierwszy raz jako doręczona: data przekazania = odbiór przez kuriera, nie doręczenie', async () => {
    await wlaczDoKonca()
    await regulaDpd()
    const p = await paczka('DPD', { status: 'WYSLANE', createdAt: new Date('2026-11-12T06:00:00Z') })
    const at = dpdSledzenieAtrapa()
    at.zdarzenia.set(p.ref, [
      { kod: '040101', opis: 'Przesyłka odebrana przez Kuriera', czas: '2026-11-12T14:00:00' },
      { kod: '190101', opis: 'Przesyłka doręczona', czas: '2026-11-13T11:40:00' },
    ])
    const t = new Date('2026-11-13T12:00:00Z')
    expect((await sledzeniePrzesylek(db, deps(at.fetchImpl, () => t))).sprawdzone).toBe(1)
    const s = await przesylka(p.sid)
    expect(s.trackState).toBe('DORECZONA')
    expect(s.handedOverAt?.toISOString()).toBe('2026-11-12T13:00:00.000Z')
    expect(s.deliveredAt?.toISOString()).toBe('2026-11-13T10:40:00.000Z')
  })

  it('po zapisanym zwrocie odczyt „doręczona” (do nadawcy) zostawia zwrot, bez daty doręczenia', async () => {
    await wlaczDoKonca()
    const p = await paczka('PACZKOMATY')
    const t0 = Date.now() + 3 * H
    await db.shipment.update({ where: { id: p.sid }, data: { trackState: 'ZWROT', trackStateSince: new Date(t0 - D), handedOverAt: new Date(t0 - 2 * D) } })
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(p.ref), 'delivered')
    expect((await sledzeniePrzesylek(db, deps(shipx.fetchImpl, () => new Date(t0)))).sprawdzone).toBe(1)
    const s = await przesylka(p.sid)
    expect(s).toMatchObject({ trackState: 'ZWROT', deliveredAt: null, nextTrackAt: null })
    expect(s.trackStateSince?.getTime()).toBe(t0 - D)
  })

  it('stan końcowy ze zdarzeń sprzed utworzenia przesyłki = nieznany z ostrzeżeniem; po przekazaniu „anulowana” i „utworzona” nie są przyjmowane', async () => {
    await wlaczDoKonca()
    await regulaDpd()
    const t0 = Date.now() + 3 * H
    const stara = await paczka('DPD', { status: 'WYSLANE', createdAt: new Date(t0 - 2 * D) })
    const at = dpdSledzenieAtrapa()
    at.zdarzenia.set(stara.ref, [
      { kod: '040101', opis: 'Przesyłka odebrana przez Kuriera', czas: '2026-10-01T10:00:00' },
      { kod: '190101', opis: 'Przesyłka doręczona', czas: '2026-10-02T10:00:00' },
    ])
    const w = await sledzeniePrzesylek(db, deps(at.fetchImpl, () => new Date(t0)))
    expect(w.sprawdzone).toBe(1)
    expect(w.bledy).toHaveLength(1)
    expect(w.bledy[0]).toMatch(/sprzed utworzenia przesyłki \(190101\)/)
    const s = await przesylka(stara.sid)
    expect(s).toMatchObject({ trackState: 'NIEZNANY', deliveredAt: null, trackingStoppedAt: null })
    expect(s.handedOverAt?.getTime()).toBe(t0)

    const shipx = inpostAtrapa()
    const anul = await wDrodze('PACZKOMATY', { trackedAt: new Date(t0 - 4 * H), nextTrackAt: new Date(t0 - H) })
    const utw = await wDrodze('PACZKOMATY', { trackedAt: new Date(t0 - 4 * H), nextTrackAt: new Date(t0 - H), trackState: 'W_PUNKCIE' })
    shipx.ustawStatus(Number(anul.ref), 'canceled')
    shipx.ustawStatus(Number(utw.ref), 'created')
    expect((await sledzeniePrzesylek(db, deps(shipx.fetchImpl, () => new Date(t0)))).sprawdzone).toBe(2)
    expect(await przesylka(anul.sid)).toMatchObject({ trackState: 'W_DRODZE', trackingStoppedAt: null })
    expect(await przesylka(utw.sid)).toMatchObject({ trackState: 'W_PUNKCIE', trackingStoppedAt: null })
    expect((await historia(anul.sid)).map((e) => [e.state, e.carrierCode])).toEqual([['W_DRODZE', 'canceled']])
  })

  it('błąd tej przesyłki: rosnący odstęp, po 20 błędach z rzędu koniec; udany odczyt zeruje licznik', async () => {
    await wlaczDoKonca()
    const t0 = Date.now() + 3 * H
    const zla = await wDrodze('PACZKOMATY', { trackedAt: new Date(t0 - 4 * H), nextTrackAt: new Date(t0 - H) })
    const dobra = await wDrodze('PACZKOMATY', { trackedAt: new Date(t0 - 4 * H), nextTrackAt: new Date(t0 - H) })
    await db.shipment.update({ where: { id: dobra.sid }, data: { trackFailures: 7 } })
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(dobra.ref), 'out_for_delivery')
    const fetchImpl: FetchLike = async (url, init) => (String(url).includes(`/shipments/${zla.ref}`) ? new Response('{"error":"awaria"}', { status: 503 }) : shipx.fetchImpl(url, init))
    let t = new Date(t0)
    await sledzeniePrzesylek(db, deps(fetchImpl, () => t))
    expect(await przesylka(zla.sid)).toMatchObject({ trackFailures: 1, trackingStoppedAt: null })
    expect((await przesylka(zla.sid)).nextTrackAt?.getTime()).toBe(t0 + 30 * M)
    expect((await przesylka(dobra.sid)).trackFailures).toBe(0)
    t = new Date(t0 + 31 * M)
    await sledzeniePrzesylek(db, deps(fetchImpl, () => t))
    expect((await przesylka(zla.sid)).nextTrackAt?.getTime()).toBe(t.getTime() + H)
    await db.shipment.update({ where: { id: zla.sid }, data: { trackFailures: 19, nextTrackAt: new Date(t.getTime()) } })
    t = new Date(t.getTime() + 2 * H)
    await sledzeniePrzesylek(db, deps(fetchImpl, () => t))
    const z = await przesylka(zla.sid)
    expect(z.trackFailures).toBe(20)
    expect(z.trackingStoppedAt?.getTime()).toBe(t.getTime())
    expect(z.nextTrackAt?.getTime()).toBe(t.getTime() + 12 * H)
  })

  it('klucz historii z kodem: dwa kody w tej samej chwili i stanie = dwa wiersze; ponowiony zapis bez dubla', async () => {
    const p = await paczka('DPD')
    const at = new Date('2026-11-13T10:00:00Z')
    const wiersz = (carrierCode: string) => ({ shipmentId: p.sid, state: 'W_DRODZE' as const, carrierCode, carrierStatus: `${carrierCode} opis`, occurredAt: at })
    expect((await db.shipmentTrackEvent.createMany({ data: [wiersz('050101'), wiersz('160101')], skipDuplicates: true })).count).toBe(2)
    expect((await db.shipmentTrackEvent.createMany({ data: [wiersz('050101'), wiersz('160101')], skipDuplicates: true })).count).toBe(0)
    await expect(db.shipmentTrackEvent.create({ data: wiersz('050101') })).rejects.toThrow()
    // domyślny kod pusty (przewoźnik bez kodu) też jest częścią klucza
    expect((await db.shipmentTrackEvent.createMany({ data: [{ shipmentId: p.sid, state: 'W_DRODZE', occurredAt: at }, { shipmentId: p.sid, state: 'W_DRODZE', occurredAt: at }], skipDuplicates: true })).count).toBe(1)
    expect(await historia(p.sid)).toHaveLength(3)
  })

  it('izolacja firm: historia przesyłki firmy A niewidoczna dla firmy B', async () => {
    await wlaczDoKonca()
    const p = await paczka('PACZKOMATY', { status: 'WYSLANE' })
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(p.ref), 'out_for_delivery')
    await sledzeniePrzesylek(db, deps(shipx.fetchImpl, () => new Date(Date.now() + 3 * H)))
    const [e] = await historia(p.sid)
    expect(e).toBeDefined()
    const dbB = testDb({ organizationId: ORG_B })
    try {
      expect(await dbB.shipmentTrackEvent.count()).toBe(0)
      expect(await dbB.shipmentTrackEvent.findUnique({ where: { id: e!.id } })).toBeNull()
      expect(await dbB.shipmentTrackEvent.findMany({ where: { shipmentId: p.sid } })).toEqual([])
    } finally {
      await dbB.$disconnect()
    }
  })

  it('przesyłka zamówienia anulowanego: śledzona do końca, status zamówienia i zdarzenia zamówienia bez zmian', async () => {
    await wlaczDoKonca()
    const p = await paczka('PACZKOMATY', { status: 'ANULOWANE' })
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(p.ref), 'delivered')
    expect(await sledzeniePrzesylek(db, deps(shipx.fetchImpl, () => new Date(Date.now() + 3 * H)))).toMatchObject({ sprawdzone: 1, przeniesione: 0, bledy: [] })
    expect(await przesylka(p.sid)).toMatchObject({ trackState: 'DORECZONA', nextTrackAt: null })
    expect(await status(p.id)).toBe('ANULOWANE')
    expect(await db.orderEvent.count({ where: { orderId: p.id, kind: 'PRZESYLKA_STATUS' } })).toBe(0)
  })
})

describe('wyłącznik wyłączony: zapisy pole po polu jak przed osią', () => {
  it('odczyt, błąd i nieznany od 5 dni: te same pola co dotąd, pola osi i licznik nietknięte, historia pusta', async () => {
    const t0 = Date.now() + 3 * H
    const odebrana = await paczka('PACZKOMATY')
    const zla = await paczka('PACZKOMATY')
    const nieznana = await paczka('PACZKOMATY')
    const wyslana = await paczka('PACZKOMATY', { status: 'WYSLANE' })
    await db.shipment.update({ where: { id: nieznana.sid }, data: { trackingUnknownSince: new Date(t0 - 6 * D), carrierStatus: null } })
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(odebrana.ref), 'taken_by_courier')
    shipx.ustawStatus(Number(wyslana.ref), 'delivered')
    const fetchImpl: FetchLike = async (url, init) => (String(url).includes(`/shipments/${zla.ref}`) ? new Response('{"error":"awaria"}', { status: 503 }) : shipx.fetchImpl(url, init))
    const w = await sledzeniePrzesylek(db, deps(fetchImpl, () => new Date(t0)))
    // wysłana pytana bez osi tylko o status (od 19.11.2026), więc 3 odczyty
    expect(w).toMatchObject({ sprawdzone: 3, przeniesione: 1 })
    expect(w.bledy).toHaveLength(1)
    const osPuste = { trackState: null, trackStateSince: null, handedOverAt: null, deliveredAt: null, nextTrackAt: null, trackFailures: 0 }
    const pola = (s: Awaited<ReturnType<typeof przesylka>>) => ({
      trackedAt: s.trackedAt?.getTime() ?? null,
      carrierStatus: s.carrierStatus,
      trackingUnknownSince: s.trackingUnknownSince?.getTime() ?? null,
      trackingStoppedAt: s.trackingStoppedAt?.getTime() ?? null,
      trackState: s.trackState,
      trackStateSince: s.trackStateSince,
      handedOverAt: s.handedOverAt,
      deliveredAt: s.deliveredAt,
      nextTrackAt: s.nextTrackAt,
      trackFailures: s.trackFailures,
    })
    expect(pola(await przesylka(odebrana.sid))).toEqual({ trackedAt: t0, carrierStatus: 'taken_by_courier', trackingUnknownSince: null, trackingStoppedAt: null, ...osPuste })
    expect(pola(await przesylka(zla.sid))).toEqual({ trackedAt: t0 + 1, carrierStatus: null, trackingUnknownSince: null, trackingStoppedAt: null, ...osPuste })
    expect(pola(await przesylka(nieznana.sid))).toEqual({ trackedAt: t0, carrierStatus: null, trackingUnknownSince: t0 - 6 * D, trackingStoppedAt: t0, ...osPuste })
    expect(pola(await przesylka(wyslana.sid))).toEqual({ trackedAt: t0, carrierStatus: 'delivered', trackingUnknownSince: null, trackingStoppedAt: null, ...osPuste })
    expect(await db.shipmentTrackEvent.count()).toBe(0)
  })
})

describe('API zamówień a stan drogi paczki', () => {
  it('nowy stan paczki po „Wysłane” nie zmienia „zmieniono” zamówienia ani listy zmienionych; odczyt po numerze oddaje nowy stan', async () => {
    await wlaczDoKonca()
    const p = await paczka('PACZKOMATY', { status: 'WYSLANE' })
    const przed = await db.order.findUniqueOrThrow({ where: { id: p.id }, select: { updatedAt: true, externalId: true } })
    const odZmiany = new Date(przed.updatedAt.getTime() + 1)
    const shipx = inpostAtrapa()
    let t = new Date(Date.now() + 3 * H)
    const deps = () => ({ fetch: shipx.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t })
    for (const [kod, stan] of [['out_for_delivery', 'W_DORECZENIU'], ['delivered', 'DORECZONA']] as const) {
      shipx.ustawStatus(Number(p.ref), kod)
      expect(await sledzeniePrzesylek(db, deps())).toMatchObject({ sprawdzone: 1, bledy: [] })
      expect((await przesylka(p.sid)).trackState).toBe(stan)
      // zamówienie bez zmian: lista zmienionych od chwili po ostatniej zmianie zamówienia jest pusta
      expect((await db.order.findUniqueOrThrow({ where: { id: p.id }, select: { updatedAt: true } })).updatedAt).toEqual(przed.updatedAt)
      expect((await listChangedOrders(db, { changedFrom: odZmiany, limit: 100, after: null })).zamowienia).toEqual([])
      // odczyt po numerze: aktualny stan paczki przy niezmienionym „zmieniono”
      const [z] = await ordersByNumber(db, { numer: przed.externalId })
      expect(z!.zmieniono).toBe(przed.updatedAt.toISOString())
      expect(z!.przesylki).toMatchObject([{ numerNadania: (await przesylka(p.sid)).trackingNumber, stan }])
      t = new Date(t.getTime() + 4 * H)
    }
    expect(await status(p.id)).toBe('WYSLANE')
  })
})
