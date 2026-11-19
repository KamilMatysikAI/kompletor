// „Przyjechał <przewoźnik>” = „Wysłane”, śledzenie przesyłki jako siatka i anulowanie nieopłaconych
// w kanale. Na bazie, z fałszywym kanałem (lib/adaptery/falszywy.ts, bez sieci) i atrapą InPost ShipX. Żadnych
// prawdziwych sklepów, przewoźników ani danych klientów (zamówienia i numery fikcyjne).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Carrier, OrderStatus, Prisma, PrismaClient } from '@prisma/client'
import { FakeChannelState, fakeDefinition } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { planujAkcje } from '@/lib/akcje/silnik'
import { ALERT_ANULOWANIE_RECZNE, wykonajZapisy, zaplanujZapisy } from '@/lib/kanaly/zapis-host'
import { markCarrierArrived, packingQueue } from '@/lib/pakowanie/dane'
import { RAPORT_ZAWIESZONY_MS, raportyPrzyjazdow, sledzeniePrzesylek, wyslanePoPrzyjezdzie, wyslijPoOdbiorze, ZADANIE_WYSLANE_PO_PRZYJEZDZIE, zadanieWyslanePoPrzyjezdzie } from '@/lib/pakowanie/wyslane-po-przyjezdzie'
import { ingestOrder, runReservationExpiry } from '@/lib/rdzen/zamowienia'
import { zapiszAutomatyWysylki } from '@/lib/wysylka/automaty'
import { PRZYKLADOWE_ODBIORY } from './pakowanie-fixtures'
import { INPOST_ORG, INPOST_SANDBOX, INPOST_TOKEN, inpostAtrapa } from './inpost-atrapa'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase, T0, type TestChannel } from './rdzen-fixtures'

const db = testDb()
const sys = testSystemDb()
afterAll(() => db.$disconnect())

const ENV = { EKRANY_PRACA: '1' }
const H = 3600_000
// czwartek 15.10.2026: pakowanie rano, kurier DPD 13:00 (T0 = 10:00 Warszawa)
const PAKOWANIE = new Date(T0.getTime() + H)
const PRZYJAZD = new Date(T0.getTime() + 3 * H)

let state: FakeChannelState
let registry: AdapterRegistry

async function kontoPraca(label: 'sd' | 'lampy', o: { adapterKey?: string; zapis?: boolean } = {}) {
  await db.channelConfig.updateMany({
    where: { channel: 'WOO', channelAccountId: label },
    data: { adapterKey: o.adapterKey ?? 'fake.v1', statusMode: 'PRACA', trackingMode: 'PRACA', config: { zapisWlaczony: o.zapis ?? true } as Prisma.InputJsonValue },
  })
}

let nr = 0
/** Zamówienie spakowane (albo „Do wysłania”) przed przyjazdem, z przesyłką z numerem nadania i fakturą (mail „Faktura”). */
async function paczka(
  carrier: Carrier,
  o: { status?: OrderStatus; przesylka?: 'UTWORZONA' | 'NIEJEDNOZNACZNA' | 'TWORZENIE' | 'BRAK' | 'BEZ_NUMERU'; channel?: TestChannel; packedAt?: Date; faktura?: boolean; c?: PrismaClient } = {},
): Promise<string> {
  const c = o.c ?? db
  const pid = await product(c, `P-${++nr}-${Math.random().toString(36).slice(2, 6)}`, 50)
  const r = await ingestOrder(c, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { channel: o.channel ?? 'WOO_SD', paymentState: 'PAID' }), { now: T0 })
  const id = r.orderId!
  await c.order.update({ where: { id }, data: { carrier, status: o.status ?? 'DO_WYSLANIA' } })
  await c.orderEvent.create({ data: { orderId: id, kind: 'SPAKOWANE', actorId: 'test', createdAt: o.packedAt ?? PAKOWANIE } })
  if (o.faktura !== false) await c.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED', wfirmaDocId: `FV/T/${nr}` } })
  const p = o.przesylka ?? 'UTWORZONA'
  if (p !== 'BRAK') {
    await c.shipment.create({
      data: {
        orderId: id,
        packageNo: 1,
        reference: `ref-${id}`,
        state: p === 'BEZ_NUMERU' ? 'UTWORZONA' : p,
        adapterKey: carrier === 'DPD' ? 'dpd.services.zapis.v1' : 'inpost.shipx.zapis.v1',
        carrier,
        externalRef: p === 'NIEJEDNOZNACZNA' || p === 'TWORZENIE' ? null : `${900_000 + nr}`,
        trackingNumber: p === 'UTWORZONA' ? `NR${100000 + nr}` : null,
      },
    })
  }
  return id
}

const status = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id }, select: { status: true } })).status

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.carrierPickup.createMany({ data: PRZYKLADOWE_ODBIORY })
  state = new FakeChannelState()
  registry = new AdapterRegistry([fakeDefinition(state, 'WOO'), fakeDefinition(state, 'WOO', 'fake.bezanulowania.v1', { unpaidGuard: false })])
})

describe('„Przyjechał <przewoźnik>” = „Wysłane”', () => {
  it('5 DPD i 2 InPost: „Przyjechał DPD” → 5 w Wysłane, InPost bez zmian; mail i zapis w sklepie po jednym; drugi raz bez dubli', async () => {
    await kontoPraca('sd')
    const dpd = [] as string[]
    for (let i = 0; i < 5; i++) dpd.push(await paczka('DPD'))
    const inpost = [await paczka('PACZKOMATY'), await paczka('PACZKOMATY')]

    const r = await markCarrierArrived(db, { carrier: 'DPD', actorId: 'u-mag', actorName: 'Magazyn', now: PRZYJAZD })
    expect(r.created).toBe(true)
    expect(r.arrival.wysylka).toMatchObject({ stan: 'CZEKA' })
    const job = await db.job.findFirstOrThrow({ where: { kind: ZADANIE_WYSLANE_PO_PRZYJEZDZIE } })
    const raport = await zadanieWyslanePoPrzyjezdzie(db, job.payload, { env: ENV })
    expect(raport).toMatchObject({ stan: 'ZROBIONE', przeniesiono: 5, pominieto: 0 })
    for (const id of dpd) expect(await status(id)).toBe('WYSLANE')
    for (const id of inpost) expect(await status(id)).toBe('DO_WYSLANIA')
    // historia jak przy ręcznym kliknięciu: zdarzenie WYSLANE z numerem nadania, kto kliknął przyjazd
    const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: dpd[0], kind: 'WYSLANE' } })
    expect(ev.actorId).toBe('user:u-mag')
    expect(ev.data).toMatchObject({ z: 'DO_WYSLANIA', na: 'WYSLANE', nadanie: expect.stringMatching(/^NR\d+$/) })

    // skutki przez istniejące drogi: plan maila „Faktura” i zapis statusu + numeru do sklepu przez host
    const plan = await zaplanujZapisy(db, registry, { now: new Date(PRZYJAZD.getTime() + 60_000) })
    expect(plan).toMatchObject({ statusy: 5, nadania: 5 })
    await planujAkcje(db, { now: new Date(PRZYJAZD.getTime() + 60_000) })
    for (const id of dpd) {
      expect(await db.channelWrite.count({ where: { orderId: id, kind: 'STATUS' } })).toBe(1)
      expect(await db.channelWrite.count({ where: { orderId: id, kind: 'NADANIE' } })).toBe(1)
      expect(await db.plannedAction.count({ where: { targetId: id, rule: 'mail.faktura' } })).toBe(1)
    }
    for (const id of inpost) expect(await db.channelWrite.count({ where: { orderId: id } })).toBe(0)
    const run = await wykonajZapisy(db, { registry, secrets: { env: {}, envFallback: false }, now: new Date(PRZYJAZD.getTime() + 2 * 60_000) })
    expect(run.wyslane).toBe(10)

    // drugie kliknięcie: odbiór dnia już zamknięty, bez nowego zadania; ponowny przebieg i plan bez dubli
    const again = await markCarrierArrived(db, { carrier: 'DPD', actorId: 'u-mag', actorName: 'Magazyn', now: new Date(PRZYJAZD.getTime() + 5 * 60_000) })
    expect(again.created).toBe(false)
    expect(await db.job.count({ where: { kind: ZADANIE_WYSLANE_PO_PRZYJEZDZIE } })).toBe(1)
    expect(await wyslanePoPrzyjezdzie(db, (job.payload as { eventId: string }).eventId, { env: ENV })).toMatchObject({ przeniesiono: 0, pominieto: 0 })
    expect((await zaplanujZapisy(db, registry, { now: new Date(PRZYJAZD.getTime() + 10 * 60_000) })).statusy).toBe(0)
    await planujAkcje(db, { now: new Date(PRZYJAZD.getTime() + 10 * 60_000) })
    expect(await db.plannedAction.count({ where: { rule: 'mail.faktura' } })).toBe(5)
    expect(await db.orderEvent.count({ where: { kind: 'WYSLANE' } })).toBe(5)
    expect(state.writeCalls.filter((w) => w.op === 'status')).toHaveLength(5)
  })

  it('pominięte z powodem: bez numeru nadania, przesyłka do rozstrzygnięcia albo właśnie powstająca, bez faktury; sklep w podglądzie tylko liczbą; spakowane po przyjeździe zostaje poza raportem', async () => {
    await kontoPraca('sd')
    const ok = await paczka('DPD')
    const brak = await paczka('DPD', { przesylka: 'BRAK' })
    const niejasna = await paczka('DPD', { przesylka: 'NIEJEDNOZNACZNA' })
    // przesyłka w tworzeniu w progu modułu to „właśnie powstaje”, nie „do rozstrzygnięcia”
    const powstaje = await paczka('DPD', { przesylka: 'TWORZENIE' })
    const bezNumeru = await paczka('DPD', { przesylka: 'BEZ_NUMERU' })
    // spakowane, magazyn z wFirmy, bez faktury: rdzeń nie wyda towaru („najpierw faktura”)
    const bezFaktury = await paczka('DPD', { status: 'SPAKOWANE', faktura: false })
    // sklep w podglądzie (statusy prowadzi BaseLinker)
    const podglad = await paczka('DPD', { channel: 'WOO_LAMPY' })
    const poPrzyjezdzie = await paczka('DPD', { packedAt: new Date(PRZYJAZD.getTime() + H) })

    const r = await markCarrierArrived(db, { carrier: 'DPD', actorId: 'u-mag', actorName: 'Magazyn', now: PRZYJAZD })
    const ev = await db.carrierPickupEvent.findFirstOrThrow({ where: { carrier: 'DPD' } })
    expect(r.created).toBe(true)
    const raport = await wyslanePoPrzyjezdzie(db, ev.id, { env: ENV })
    expect(raport.przeniesiono).toBe(1)
    // zamówienie sklepu w podglądzie nie jest kandydatem i nie ląduje na liście pominiętych
    expect(raport.pominieto).toBe(5)
    expect(raport.wPodgladzie).toBe(1)
    expect(await status(ok)).toBe('WYSLANE')
    const teksty = raport.pominiete.map((p) => p.powod).join(' | ')
    expect(teksty).toMatch(/Brak numeru nadania/)
    expect(teksty).toMatch(/do rozstrzygnięcia ręcznie/)
    expect(teksty).toMatch(/właśnie powstaje u przewoźnika/)
    expect(teksty).toMatch(/nie nadał jeszcze numeru/)
    expect(teksty).toMatch(/Najpierw faktura/)
    expect(teksty).not.toMatch(/trybie podglądu/)
    expect(raport.pominiete.filter((p) => /do rozstrzygnięcia/.test(p.powod))).toHaveLength(1)
    for (const id of [brak, niejasna, powstaje, bezNumeru, podglad, poPrzyjezdzie]) expect(await status(id)).toBe('DO_WYSLANIA')
    expect(await status(bezFaktury)).toBe('SPAKOWANE')
    // bez danych klientów: numer zamówienia i powód
    for (const p of raport.pominiete) expect(Object.keys(p).sort()).toEqual(['nr', 'powod'])
    // raport przy pasku kuriera (kolejka pakowania)
    const q = await packingQueue(db, { tab: 'naprawde', zone: 'wszystkie' }, new Date(PRZYJAZD.getTime() + 60_000))
    const pasek = q.groups.find((g) => g.carrier === 'DPD')
    expect(pasek?.lastArrival?.wysylka).toMatchObject({ stan: 'ZROBIONE', przeniesiono: 1, pominieto: 5, wPodgladzie: 1 })
    // raport zostaje w historii, rola aplikacji nie kasuje
    await expect(db.carrierPickupShipping.deleteMany({})).rejects.toThrow()
  })

  it('operacja, która się nie skończyła (zadanie nie powstało albo padło): raport „nie udało się” zamiast wiecznego „Przenoszę…”', async () => {
    await kontoPraca('sd')
    await markCarrierArrived(db, { carrier: 'DPD', actorId: 'u-mag', actorName: 'Magazyn', now: PRZYJAZD })
    const ev = await db.carrierPickupEvent.findFirstOrThrow({ where: { carrier: 'DPD' } })
    const row = await db.carrierPickupShipping.findFirstOrThrow({ where: { eventId: ev.id } })
    expect(row.state).toBe('CZEKA')
    const zaChwile = (await raportyPrzyjazdow(db, [ev.id], new Date(row.updatedAt.getTime() + 60_000))).get(ev.id)
    expect(zaChwile?.stan).toBe('CZEKA')
    const poProgu = (await raportyPrzyjazdow(db, [ev.id], new Date(row.updatedAt.getTime() + RAPORT_ZAWIESZONY_MS + 60_000))).get(ev.id)
    expect(poProgu?.stan).toBe('BLAD')
    // ponowienie zadania liczy od nowa i kończy raport
    expect(await wyslanePoPrzyjezdzie(db, ev.id, { env: ENV })).toMatchObject({ stan: 'ZROBIONE' })
    expect((await raportyPrzyjazdow(db, [ev.id], new Date(Date.now() + RAPORT_ZAWIESZONY_MS + 60_000))).get(ev.id)?.stan).toBe('ZROBIONE')
  })

  it('automat wyłączony w ustawieniach: przyjazd zamyka tylko odbiór, nic nie przechodzi do Wysłane', async () => {
    await kontoPraca('sd')
    const id = await paczka('DPD')
    await zapiszAutomatyWysylki(db, { wyslanePoPrzyjezdzie: false, sledzenie: true, anulowanieWKanale: true }, 'u-admin')
    const r = await markCarrierArrived(db, { carrier: 'DPD', actorId: 'u-mag', actorName: 'Magazyn', now: PRZYJAZD })
    expect(r.created).toBe(true)
    expect(r.arrival.wysylka).toBeNull()
    expect(await db.job.count({ where: { kind: ZADANIE_WYSLANE_PO_PRZYJEZDZIE } })).toBe(0)
    expect(await status(id)).toBe('DO_WYSLANIA')
    expect(await db.auditLog.count({ where: { entity: 'Organization.wysylkaAutomaty' } })).toBe(1)
  })

  it('firma bez BaseLinkera i bez wFirmy (zamówienie ręczne, magazyn Kompletora, bez programu do faktur): spakowane → przyjazd → Wysłane, bez zapisu do kanału', async () => {
    await sys.warehouse.updateMany({ where: { organizationId: ORG_A }, data: { stockSource: 'KOMPLETOR', wfirmaWarehouseId: null } })
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { faktury: { program: 'brak' } } } })
    await db.channelConfig.updateMany({ where: { channel: 'RECZNE' }, data: { statusMode: 'PRACA' } })
    const id = await paczka('DPD', { channel: 'RECZNE', status: 'SPAKOWANE', faktura: false })
    await markCarrierArrived(db, { carrier: 'DPD', actorId: 'u-mag', actorName: 'Magazyn', now: PRZYJAZD })
    const ev = await db.carrierPickupEvent.findFirstOrThrow({ where: { carrier: 'DPD' } })
    // bez EKRANY_PRACA: firma bez BaseLinkera ma tryb pracy bez wyłącznika instancji
    const raport = await wyslanePoPrzyjezdzie(db, ev.id, { env: {} })
    expect(raport).toMatchObject({ przeniesiono: 1, pominieto: 0 })
    expect(await status(id)).toBe('WYSLANE')
    // magazyn Kompletora zdjął towar przy wydaniu (ta sama droga co przycisk „Do wysyłki”)
    expect((await db.orderEvent.findFirstOrThrow({ where: { orderId: id, kind: 'DO_WYSLANIA' } })).data).toMatchObject({ wydaneZeStanu: 1 })
    await zaplanujZapisy(db, defaultRegistry(), { now: new Date(PRZYJAZD.getTime() + 60_000) })
    expect(await db.channelWrite.count()).toBe(0)
  })
})

describe('śledzenie przesyłki (siatka bez kliknięcia przyjazdu)', () => {
  it('InPost „taken_by_courier” = Wysłane; „confirmed” zostaje; przewoźnik bez śledzenia nie jest pytany', async () => {
    await kontoPraca('sd')
    await db.carrierRule.updateMany({ where: { carrier: 'PACZKOMATY' }, data: { shippingModule: 'INPOST_SHIPX', adapterKey: 'inpost.shipx.zapis.v1', config: { baseUrl: INPOST_SANDBOX, organizationId: INPOST_ORG, zapisWlaczony: true } } })
    const odebrana = await paczka('PACZKOMATY')
    const czeka = await paczka('PACZKOMATY')
    const dpd = await paczka('DPD')
    const ids = await db.shipment.findMany({ where: { orderId: { in: [odebrana, czeka] } }, select: { orderId: true, externalRef: true } })
    const shipx = inpostAtrapa()
    shipx.ustawStatus(Number(ids.find((s) => s.orderId === odebrana)!.externalRef), 'taken_by_courier')
    shipx.ustawStatus(Number(ids.find((s) => s.orderId === czeka)!.externalRef), 'confirmed')
    const env = { ...ENV, INPOST_TOKEN }
    // przesyłki utworzone „teraz” (zegar bazy): śledzenie pyta dopiero po 2 h
    const pozniej = new Date(Date.now() + 3 * H)
    const deps = { fetch: shipx.fetchImpl, env, secrets: { env, envFallback: true }, now: () => pozniej }
    const w = await sledzeniePrzesylek(db, deps)
    expect(w).toMatchObject({ sprawdzone: 2, przeniesione: 1, bledy: [] })
    expect(await status(odebrana)).toBe('WYSLANE')
    expect(await status(czeka)).toBe('DO_WYSLANIA')
    expect(await status(dpd)).toBe('DO_WYSLANIA')
    expect((await db.orderEvent.findFirstOrThrow({ where: { orderId: odebrana, kind: 'WYSLANE' } })).actorId).toBe('system:sledzenie-przesylki')
    expect((await db.shipment.findFirstOrThrow({ where: { orderId: czeka } })).carrierStatus).toBe('confirmed')
    // sam odczyt: tylko GET jednej przesyłki
    expect(shipx.calls.every((c) => c.method === 'GET' && /^\/v1\/shipments\/\d+$/.test(c.path))).toBe(true)
    // drugi przebieg zaraz potem: przesyłki sprawdzone przed chwilą nie są pytane ponownie
    expect((await sledzeniePrzesylek(db, deps)).sprawdzone).toBe(0)
    // przełącznik firmy wyłączony: brak zapytań
    await zapiszAutomatyWysylki(db, { wyslanePoPrzyjezdzie: true, sledzenie: false, anulowanieWKanale: true }, 'u-admin')
    const przed = shipx.calls.length
    expect((await sledzeniePrzesylek(db, { ...deps, now: () => new Date(pozniej.getTime() + H) })).sprawdzone).toBe(0)
    expect(shipx.calls.length).toBe(przed)
  })

  it('jedno zamówienie: drugie wywołanie nic nie zmienia (idempotentnie)', async () => {
    await kontoPraca('sd')
    const id = await paczka('DPD')
    expect(await wyslijPoOdbiorze(db, id, { actorId: 'x', env: ENV })).toMatchObject({ ok: true, zmiana: true })
    expect(await wyslijPoOdbiorze(db, id, { actorId: 'x', env: ENV })).toMatchObject({ ok: true, zmiana: false })
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'WYSLANE' } })).toBe(1)
  })

  it('przyjazd i śledzenie naraz na tym samym zamówieniu: jedno przejście, bez błędu', async () => {
    await kontoPraca('sd')
    const id = await paczka('DPD', { status: 'SPAKOWANE' })
    await sys.warehouse.updateMany({ where: { organizationId: ORG_A }, data: { stockSource: 'KOMPLETOR', wfirmaWarehouseId: null } })
    const [a, b] = await Promise.all([wyslijPoOdbiorze(db, id, { actorId: 'a', env: ENV }), wyslijPoOdbiorze(db, id, { actorId: 'b', env: ENV })])
    expect([a, b].every((w) => w.ok)).toBe(true)
    expect([a, b].filter((w) => w.ok && w.zmiana)).toHaveLength(1)
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'WYSLANE' } })).toBe(1)
    expect(await status(id)).toBe('WYSLANE')
  })
})

describe('anulowanie nieopłaconych w kanale', () => {
  async function nieoplacone(channel: TestChannel = 'WOO_SD'): Promise<string> {
    const pid = await product(db, `U-${++nr}`, 10)
    const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { channel, paymentState: 'UNPAID' }), { now: T0 })
    return r.orderId!
  }
  const PO_TERMINIE = new Date(T0.getTime() + 20 * 24 * H)

  it('po terminie: anulowane u nas i jedno zlecenie „anulowane” w sklepie (atrapa); drugi przebieg bez dubli', async () => {
    await kontoPraca('sd')
    const id = await nieoplacone()
    const ex = await runReservationExpiry(db, { now: PO_TERMINIE })
    expect(ex.released).toBe(1)
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'ANULOWANE', cancelReason: 'EXPIRED_UNPAID' })
    const now = new Date(Date.now())
    await zaplanujZapisy(db, registry, { now })
    await zaplanujZapisy(db, registry, { now })
    const w = await db.channelWrite.findMany({ where: { orderId: id } })
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ kind: 'STATUS', key: 'ANULOWANE_NIEOPLACONE', channelStatus: 'cancelled', state: 'OCZEKUJE' })
    await wykonajZapisy(db, { registry, secrets: { env: {}, envFallback: false }, now })
    const ext = (await db.order.findUniqueOrThrow({ where: { id } })).externalId
    expect(state.statuses.get(ext)).toBe('cancelled')
    expect(await db.alert.count({ where: { kind: ALERT_ANULOWANIE_RECZNE } })).toBe(0)
  })

  it('sklep, który nie pozwala bezpiecznie anulować: alert dla biura (raz), zero zapisów; wyłączony automat: ani zapisu, ani alertu', async () => {
    await kontoPraca('sd', { adapterKey: 'fake.bezanulowania.v1' })
    const id = await nieoplacone()
    await runReservationExpiry(db, { now: PO_TERMINIE })
    const now = new Date(Date.now())
    await zaplanujZapisy(db, registry, { now })
    await zaplanujZapisy(db, registry, { now })
    expect(await db.channelWrite.count({ where: { orderId: id } })).toBe(0)
    const alerty = await db.alert.findMany({ where: { kind: ALERT_ANULOWANIE_RECZNE } })
    expect(alerty).toHaveLength(1)
    expect(alerty[0]!.message).toMatch(/Anuluj je ręcznie w sklepie/)
    expect(alerty[0]!.message).toMatch(/nie pozwala bezpiecznie anulować/)
    expect(state.writeCalls).toEqual([])

    await sys.alert.deleteMany({})
    await zapiszAutomatyWysylki(db, { wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: false }, 'u-admin')
    await kontoPraca('sd')
    await zaplanujZapisy(db, registry, { now })
    expect(await db.channelWrite.count({ where: { orderId: id } })).toBe(0)
    expect(await db.alert.count({ where: { kind: ALERT_ANULOWANIE_RECZNE } })).toBe(0)
  })

  // konto zablokowane konfiguracją (zapis wyłączony) w okresie przejścia prowadzi BaseLinker, który
  // sam anuluje zamówienie; alert „anuluj ręcznie” byłby fałszywy i leciałby na każde zamówienie co 5 minut.
  it('konto aktywne z wyłączonym zapisem: bez alertu i bez zapisu; konto w podglądzie: nic', async () => {
    await kontoPraca('sd', { zapis: false })
    await nieoplacone()
    await nieoplacone('WOO_LAMPY') // konto w podglądzie
    await runReservationExpiry(db, { now: PO_TERMINIE })
    await zaplanujZapisy(db, registry, { now: new Date(Date.now()) })
    expect(await db.alert.count({ where: { kind: ALERT_ANULOWANIE_RECZNE } })).toBe(0)
    expect(await db.channelWrite.count()).toBe(0)
    expect(state.writeCalls).toEqual([])
  })

  it('konto z zapisem, ale bez statusu sklepu dla anulowania nieopłaconego w mapie konta: alert z powodem, zero zapisów anulowania', async () => {
    await db.channelConfig.updateMany({
      where: { channel: 'WOO', channelAccountId: 'sd' },
      data: { adapterKey: 'fake.v1', statusMode: 'PRACA', trackingMode: 'PRACA', config: { zapisWlaczony: true, statusy: { WYSLANE: 'completed' } } as Prisma.InputJsonValue },
    })
    const id = await nieoplacone()
    await runReservationExpiry(db, { now: PO_TERMINIE })
    await zaplanujZapisy(db, registry, { now: new Date(Date.now()) })
    expect(await db.channelWrite.count({ where: { orderId: id } })).toBe(0)
    const alerty = await db.alert.findMany({ where: { kind: ALERT_ANULOWANIE_RECZNE } })
    expect(alerty).toHaveLength(1)
    expect(alerty[0]!.message).toMatch(/nie ma statusu sklepu/)
  })
})
