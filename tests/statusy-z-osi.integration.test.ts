// Statusy zamówień z osi statusów przesyłki (reguły firmy po „Wysłane”): doręczona → „Odebrane” (przełącznik
// „Doręczona paczka = Odebrane”), zwrot i problem → powiadomienie dla biura bez zmiany statusu (przełącznik
// „Powiadamiaj o zwrocie i problemie z paczką”), zmiana stanu po „Wysłane” → wpis w historii zamówienia. Obie reguły
// domyślnie wyłączone, tylko ze śledzeniem aż do doręczenia, tylko dla sklepów w trybie pracy i przewoźników z listy
// (domyślnie bez DPD). Raz na wiersz historii przesyłki; nieudane reguły ponawia następny przebieg. Atrapy InPost ShipX
// i DPDInfoServices, dane fikcyjne, zero połączeń z przewoźnikami.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Carrier, OrderStatus } from '@prisma/client'
import { REGULY_DROGI_PROB, sledzeniePrzesylek } from '@/lib/pakowanie/wyslane-po-przyjezdzie'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { receiveReturn } from '@/lib/rdzen/zwroty'
import { planujAkcje } from '@/lib/akcje/silnik'
import { ustawPlanWbudowany } from '@/lib/automaty/dane'
import { zastosujAutomatyPresetu } from '@/lib/automaty/preset'
import { kliknijPrzycisk, przetworzZdarzenia } from '@/lib/automaty/silnik'
import { moveOrder } from '@/lib/rdzen/przejscia'
import { automatyWysylki, regulyDrogiPrzewoznikow, zapiszAutomatyWysylki, zapiszRegulyDrogi, zapiszSledzeniePrzewoznikow } from '@/lib/wysylka/automaty'
import { ALERT_PROBLEM_PRZESYLKI, ALERT_ZWROT_PRZESYLKI } from '@/lib/wysylka/reguly-drogi'
import { DPD_ZAPIS_KEY } from '@/lib/adaptery/dpd'
import { INPOST_SHIPX_ZAPIS_MANIFEST } from '@/lib/adaptery/inpost-zapis'
import { PRZYKLADOWE_ODBIORY } from './pakowanie-fixtures'
import { DPD_LOGIN, DPD_PASSWORD, DPD_DEMO, DPD_FID } from './dpd-atrapa'
import { DPD_INFO_HASLO, DPD_INFO_LOGIN, DPD_INFO_URL, dpdSledzenieAtrapa } from './dpd-sledzenie-atrapa'
import { INPOST_ORG, INPOST_SANDBOX, INPOST_TOKEN, inpostAtrapa } from './inpost-atrapa'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const H = 3600_000
const INPOST_KEY = INPOST_SHIPX_ZAPIS_MANIFEST.adapterKey
const ENV = { EKRANY_PRACA: '1', INPOST_TOKEN, DPD_LOGIN, DPD_PASSWORD, DPD_SLEDZENIE_LOGIN: DPD_INFO_LOGIN, DPD_SLEDZENIE_HASLO: DPD_INFO_HASLO }

async function kontoSklepu(tryb: 'PRACA' | 'CIEN' = 'PRACA') {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1', statusMode: tryb, trackingMode: tryb, config: { zapisWlaczony: true } } })
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
async function ustaw(o: { doKonca?: boolean; odebrane?: boolean; powiadomienia?: boolean }) {
  await zapiszAutomatyWysylki(db, { wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: true, sledzenieDoDoreczenia: o.doKonca ?? true, odebranePoDoreczeniu: o.odebrane ?? false, powiadomieniaODrodze: o.powiadomienia ?? false }, 'u-admin')
}

let nr = 0
async function paczka(carrier: Carrier, o: { status?: OrderStatus } = {}): Promise<{ id: string; ref: string; sid: string }> {
  const pid = await product(db, `P-${++nr}-${Math.random().toString(36).slice(2, 6)}`, 50)
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { channel: 'WOO_SD', paymentState: 'PAID', ...(carrier === 'DPD' ? { deliveryMethod: 'Kurier DPD' } : {}) }), { now: T0 })
  const id = r.orderId!
  await db.order.update({ where: { id }, data: { carrier, status: o.status ?? 'WYSLANE' } })
  await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED', wfirmaDocId: `FV/T/${nr}` } })
  const dpd = carrier === 'DPD'
  const ref = dpd ? `0000${200000 + nr}U` : `${910_000 + nr}`
  const s = await db.shipment.create({
    data: { orderId: id, packageNo: 1, reference: `ref-${id}`, state: 'UTWORZONA', adapterKey: dpd ? DPD_ZAPIS_KEY : INPOST_KEY, carrier, externalRef: ref, trackingNumber: `NR${200000 + nr}`, createdAt: new Date(Date.now() - 3 * H) },
  })
  return { id, ref, sid: s.id }
}

const status = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id }, select: { status: true } })).status
const przesylka = (id: string) => db.shipment.findUniqueOrThrow({ where: { id } })
const stany = (orderId: string) => db.orderEvent.findMany({ where: { orderId, kind: 'PRZESYLKA_STAN' }, orderBy: { createdAt: 'asc' } })
const alerty = (kind: string) => db.alert.findMany({ where: { kind } })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.carrierPickup.createMany({ data: PRZYKLADOWE_ODBIORY })
  await kontoSklepu()
  await regulaInpost()
})

function inpost() {
  const shipx = inpostAtrapa()
  let t = new Date(Date.now() + H)
  return {
    shipx,
    dalej: (ms = 7 * H) => (t = new Date(t.getTime() + ms)),
    przebieg: () => sledzeniePrzesylek(db, { fetch: shipx.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t, http: { minIntervalMs: 0 } }),
  }
}

describe('ustawienia reguł na osi', () => {
  it('domyślnie wyłączone; zapis bez nowych pól ich nie zmienia; lista przewoźników bez DPD', async () => {
    expect(await automatyWysylki(db)).toMatchObject({ odebranePoDoreczeniu: false, powiadomieniaODrodze: false })
    await ustaw({ odebrane: true, powiadomienia: true })
    await zapiszAutomatyWysylki(db, { wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: false }, 'u-admin')
    expect(await automatyWysylki(db)).toMatchObject({ anulowanieWKanale: false, sledzenieDoDoreczenia: true, odebranePoDoreczeniu: true, powiadomieniaODrodze: true })
    expect(await regulyDrogiPrzewoznikow(db)).toEqual({})
    await zapiszRegulyDrogi(db, { [DPD_ZAPIS_KEY]: true, 'obcy.v1': true }, [DPD_ZAPIS_KEY, INPOST_KEY], 'u-admin')
    expect(await regulyDrogiPrzewoznikow(db)).toEqual({ [DPD_ZAPIS_KEY]: true })
    expect(await db.auditLog.count({ where: { entity: 'Organization.wysylkaRegulyDrogi' } })).toBe(1)
  })
})

describe('reguły wyłączone (sama oś)', () => {
  it('doręczona: status zostaje „Wysłane”, bez alertów; zmiana stanu po „Wysłane” = jeden wpis w historii zamówienia na stan', async () => {
    await ustaw({})
    const p = await paczka('PACZKOMATY')
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'out_for_delivery')
    expect((await a.przebieg()).bledy).toEqual([])
    a.dalej()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    expect((await a.przebieg()).bledy).toEqual([])
    expect(await status(p.id)).toBe('WYSLANE')
    expect(await db.alert.count()).toBe(0)
    const h = await stany(p.id)
    expect(h.map((e) => (e.data as { stan: string }).stan)).toEqual(['W_DORECZENIU', 'DORECZONA'])
    expect(h.every((e) => e.actorId === 'system:sledzenie-przesylki')).toBe(true)
    // bez danych osobowych: przesyłka, wiersz historii, stan, kod przewoźnika
    expect(Object.keys(h[1]!.data as object).sort()).toEqual(['kod', 'przesylka', 'stan', 'zdarzenie'])
    const s = await przesylka(p.sid)
    expect(s.trackRulesPending).toBe(false)
    expect(s.trackRulesAt).not.toBeNull()
    // kolejny przebieg nic nie dokłada (stan końcowy, przesyłka już nie jest pytana)
    a.dalej()
    await a.przebieg()
    expect(await stany(p.id)).toHaveLength(2)
  })

  it('śledzenie aż do doręczenia wyłączone: żadnych wpisów, znacznik reguł nietknięty', async () => {
    await ustaw({ doKonca: false, odebrane: true, powiadomienia: true })
    const p = await paczka('PACZKOMATY')
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    await a.przebieg()
    expect(await status(p.id)).toBe('WYSLANE')
    expect(await stany(p.id)).toHaveLength(0)
    expect(await przesylka(p.sid)).toMatchObject({ trackRulesPending: false, trackRulesAt: null, trackState: null })
  })
})

describe('„Doręczona paczka = Odebrane”', () => {
  it('InPost doręczona: „Wysłane” → „Odebrane” raz, przez rdzeń (wpis ODEBRANE), drugi przebieg bez zmian', async () => {
    await ustaw({ odebrane: true })
    const p = await paczka('PACZKOMATY')
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    expect((await a.przebieg()).bledy).toEqual([])
    expect(await status(p.id)).toBe('ODEBRANE')
    const ev = await db.orderEvent.findMany({ where: { orderId: p.id, kind: 'ODEBRANE' } })
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actorId: 'system:sledzenie-przesylki', data: { z: 'WYSLANE', na: 'ODEBRANE' } })
    a.dalej()
    await a.przebieg()
    expect(await db.orderEvent.count({ where: { orderId: p.id, kind: 'ODEBRANE' } })).toBe(1)
  })

  it('paczka odebrana i doręczona między odczytami (spakowane): „Wysłane”, potem „Odebrane” w tym samym przebiegu', async () => {
    await ustaw({ odebrane: true })
    const p = await paczka('PACZKOMATY', { status: 'DO_WYSLANIA' })
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    const w = await a.przebieg()
    expect(w).toMatchObject({ przeniesione: 1, bledy: [] })
    expect(await status(p.id)).toBe('ODEBRANE')
  })

  it('doręczenie odczytane, gdy „Wysłane” odmówione: po późniejszym „Wysłane” (ręcznie) zamówienie przechodzi w „Odebrane”', async () => {
    await ustaw({ odebrane: true })
    const p = await paczka('PACZKOMATY', { status: 'DO_WYSLANIA' })
    // odmowa rdzenia przy „Wysłane” (anulowanie w toku)
    await db.order.update({ where: { id: p.id }, data: { pendingAction: 'CANCEL:CANCELLED' } })
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    await a.przebieg()
    expect(await status(p.id)).toBe('DO_WYSLANIA')
    expect((await przesylka(p.sid)).trackState).toBe('DORECZONA')
    expect((await przesylka(p.sid)).trackRulesPending).toBe(false)
    await db.order.update({ where: { id: p.id }, data: { pendingAction: null } })
    await moveOrder(db, p.id, 'WYSLANE', { actorId: 'u-test' })
    expect((await przesylka(p.sid)).trackRulesPending).toBe(true)
    a.dalej()
    expect((await a.przebieg()).bledy).toEqual([])
    expect(await status(p.id)).toBe('ODEBRANE')
    expect(await stany(p.id)).toHaveLength(1)
    expect((await przesylka(p.sid)).trackRulesPending).toBe(false)
  })

  it('„Wysłane” bez doręczonej przesyłki nie stawia znacznika reguł', async () => {
    await ustaw({ odebrane: true })
    const p = await paczka('PACZKOMATY', { status: 'DO_WYSLANIA' })
    await moveOrder(db, p.id, 'WYSLANE', { actorId: 'u-test' })
    expect((await przesylka(p.sid)).trackRulesPending).toBe(false)
  })

  it('zamówienie w innym statusie (reklamacja, anulowane ręcznie): bez zmiany, bez błędu', async () => {
    await ustaw({ odebrane: true })
    const p = await paczka('PACZKOMATY', { status: 'REKLAMACJA' })
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    expect((await a.przebieg()).bledy).toEqual([])
    expect(await status(p.id)).toBe('REKLAMACJA')
    expect((await przesylka(p.sid)).trackRulesPending).toBe(false)
  })

  it('sklep w trybie podglądu: status bez zmian, bez alertów (wpis w historii zostaje)', async () => {
    await kontoSklepu('CIEN')
    await ustaw({ odebrane: true, powiadomienia: true })
    const p = await paczka('PACZKOMATY')
    const z = await paczka('PACZKOMATY')
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    a.shipx.ustawStatus(Number(z.ref), 'returned_to_sender')
    expect((await a.przebieg()).bledy).toEqual([])
    expect(await status(p.id)).toBe('WYSLANE')
    expect(await db.alert.count()).toBe(0)
    expect(await stany(p.id)).toHaveLength(1)
  })

  it('DPD domyślnie poza listą: doręczona bez „Odebrane”; po zaznaczeniu DPD na liście tak', async () => {
    await ustaw({ odebrane: true })
    await regulaDpd()
    const p = await paczka('DPD')
    const at = dpdSledzenieAtrapa()
    at.zdarzenia.set(p.ref, [
      { kod: '040101', opis: 'Przesyłka odebrana przez Kuriera', czas: '2026-11-12T14:00:00' },
      { kod: '190101', opis: 'Przesyłka doręczona', czas: '2026-11-13T11:40:00' },
    ])
    await db.shipment.update({ where: { id: p.sid }, data: { createdAt: new Date('2026-11-12T06:00:00Z') } })
    const t = new Date('2026-11-13T12:00:00Z')
    const deps = { fetch: at.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true }, now: () => t, http: { minIntervalMs: 0 } }
    expect((await sledzeniePrzesylek(db, deps)).bledy).toEqual([])
    expect((await przesylka(p.sid)).trackState).toBe('DORECZONA')
    expect(await status(p.id)).toBe('WYSLANE')
    expect((await przesylka(p.sid)).trackRulesPending).toBe(false)

    // druga paczka po zaznaczeniu DPD
    await zapiszRegulyDrogi(db, { [DPD_ZAPIS_KEY]: true }, [DPD_ZAPIS_KEY, INPOST_KEY], 'u-admin')
    const q = await paczka('DPD')
    await db.shipment.update({ where: { id: q.sid }, data: { createdAt: new Date('2026-11-12T06:00:00Z') } })
    at.zdarzenia.set(q.ref, at.zdarzenia.get(p.ref)!)
    expect((await sledzeniePrzesylek(db, deps)).bledy).toEqual([])
    expect(await status(q.id)).toBe('ODEBRANE')
  })

  it('reguła, która nie przeszła (znacznik zostaje), wykonuje się w następnym przebiegu, choć przesyłka nie jest już pytana', async () => {
    await ustaw({ odebrane: false })
    const p = await paczka('PACZKOMATY')
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    await a.przebieg()
    expect(await status(p.id)).toBe('WYSLANE')
    // jak po awarii w trakcie reguł: wiersz historii jest, znacznik ustawiony
    await db.shipment.update({ where: { id: p.sid }, data: { trackRulesPending: true, trackRulesAt: null } })
    await ustaw({ odebrane: true })
    const n = a.shipx.calls.length
    a.dalej()
    expect((await a.przebieg()).bledy).toEqual([])
    expect(a.shipx.calls).toHaveLength(n)
    expect(await status(p.id)).toBe('ODEBRANE')
    expect((await przesylka(p.sid)).trackRulesPending).toBe(false)
    // historia: ten sam wiersz nie daje drugiego wpisu
    expect(await stany(p.id)).toHaveLength(1)
  })
})

/** wpis PRZESYLKA_STAN w historii zamówienia pada w bazie na czas `fn` (wyzwalacz testowy): trwały błąd reguł. */
async function zAwariaWpisuStanu<T>(fn: () => Promise<T>, opts: { pomin?: string } = {}): Promise<T> {
  const sys = testSystemDb()
  await sys.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION os_awaria_wpisu_stanu() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN IF NEW."kind" = 'PRZESYLKA_STAN' AND NEW."orderId" <> '${opts.pomin ?? ''}' THEN RAISE EXCEPTION 'awaria historii (test)'; END IF; RETURN NEW; END $fn$`)
  await sys.$executeRawUnsafe('CREATE OR REPLACE TRIGGER os_awaria_wpisu_stanu BEFORE INSERT ON "OrderEvent" FOR EACH ROW EXECUTE FUNCTION os_awaria_wpisu_stanu()')
  try {
    return await fn()
  } finally {
    await sys.$executeRawUnsafe('DROP TRIGGER IF EXISTS os_awaria_wpisu_stanu ON "OrderEvent"')
    await sys.$executeRawUnsafe('DROP FUNCTION IF EXISTS os_awaria_wpisu_stanu()')
    await sys.$disconnect()
  }
}

describe('zaległe reguły: granica ponowień', () => {
  it('trwały błąd: ponowienie najwyżej REGULY_DROGI_PROB razy, potem jedna linia „pominięte” i znacznik schodzi', async () => {
    await ustaw({ odebrane: true })
    const p = await paczka('PACZKOMATY')
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    const linie = await zAwariaWpisuStanu(async () => {
      const w: string[][] = []
      for (let i = 0; i < REGULY_DROGI_PROB + 2; i++) {
        w.push((await a.przebieg()).bledy)
        a.dalej()
      }
      return w
    })
    // przebiegi 1..PROB-1: linia błędu, znacznik zostaje; przebieg PROB: „pominięte”; dalej cisza
    for (let i = 0; i < REGULY_DROGI_PROB - 1; i++) expect(linie[i]!.join('\n')).toMatch(/reguły przesyłki .*awaria historii/)
    expect(linie[REGULY_DROGI_PROB - 1]!.join('\n')).toMatch(new RegExp(`nie przeszły ${REGULY_DROGI_PROB} razy z rzędu, pominięte`))
    expect(linie.slice(REGULY_DROGI_PROB).flat()).toEqual([])
    expect(await przesylka(p.sid)).toMatchObject({ trackRulesPending: false, trackRulesFailures: REGULY_DROGI_PROB })
    expect(await status(p.id)).toBe('WYSLANE')
    // następna zmiana stanu paczki (nowy wiersz historii) daje reguły od nowa, z licznikiem od zera
    await db.shipment.update({ where: { id: p.sid }, data: { trackRulesPending: true, trackRulesAt: null, trackRulesFailures: 0 } })
    expect((await a.przebieg()).bledy).toEqual([])
    expect(await status(p.id)).toBe('ODEBRANE')
  })

  it('limit 50 na przebieg: przesyłki z nieudanymi próbami nie zagłodzą zaległej bez błędów', async () => {
    await ustaw({ odebrane: true })
    const zle: string[] = []
    for (let i = 0; i < 50; i++) zle.push((await paczka('PACZKOMATY')).sid)
    await db.shipment.updateMany({ where: { id: { in: zle } }, data: { trackState: 'DORECZONA', trackRulesPending: true, trackRulesFailures: 1 } })
    await db.shipmentTrackEvent.createMany({ data: zle.map((sid) => ({ shipmentId: sid, state: 'DORECZONA' as const, carrierCode: 'delivered', occurredAt: new Date() })) })
    // zaległa bez błędów, dodana ostatnia (najświeższy `updatedAt`)
    const dobra = await paczka('PACZKOMATY')
    await db.shipment.update({ where: { id: dobra.sid }, data: { trackState: 'DORECZONA', trackRulesPending: true } })
    await db.shipmentTrackEvent.create({ data: { shipmentId: dobra.sid, state: 'DORECZONA', carrierCode: 'delivered', occurredAt: new Date() } })
    const a = inpost()
    const w = await zAwariaWpisuStanu(() => a.przebieg(), { pomin: dobra.id })
    expect((await przesylka(dobra.sid)).trackRulesPending).toBe(false)
    expect(await status(dobra.id)).toBe('ODEBRANE')
    // w przebiegu najwyżej 50 zaległych: zostaje jedna z błędnych
    expect(w.bledy.filter((l) => /reguły przesyłki/.test(l))).toHaveLength(49)
    expect(await db.shipment.count({ where: { trackRulesPending: true } })).toBe(50)
  })
})

describe('mail „Faktura” przy „Odebrane” ze śledzenia', () => {
  async function regulaFaktury() {
    await zastosujAutomatyPresetu(testSystemDb(), ORG_A, {
      automationRules: [{ key: 'test-faktura', enabled: true, name: 'Wysłane, Odebrane → e-mail Faktura', event: 'USTAWIONO_STATUS', conditions: [{ typ: 'status', wartosci: ['WYSLANE', 'ODEBRANE'] }], actions: [{ typ: 'wyslijEmail', szablon: 'faktura' }] }],
    })
  }

  it('plan wbudowany włączony: jedna „Faktura” na dokument, reguła firmy nic nie dokłada', async () => {
    await ustaw({ odebrane: true })
    await regulaFaktury()
    const p = await paczka('PACZKOMATY', { status: 'DO_WYSLANIA' })
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'taken_by_courier')
    await a.przebieg()
    await planujAkcje(db)
    await przetworzZdarzenia(db, { env: ENV, opoznienieMs: 0 })
    a.dalej()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    await a.przebieg()
    expect(await status(p.id)).toBe('ODEBRANE')
    await planujAkcje(db)
    await przetworzZdarzenia(db, { env: ENV, opoznienieMs: 0 })
    expect(await db.plannedAction.count({ where: { targetId: p.id, rule: 'mail.faktura' } })).toBe(1)
  })

  it('plan wbudowany wyłączony: reguła „Wysłane, Odebrane → Faktura” daje jeden mail, nie drugi przy „Odebrane”', async () => {
    await ustaw({ odebrane: true })
    await regulaFaktury()
    await ustawPlanWbudowany(db, false, 'u-test')
    const p = await paczka('PACZKOMATY', { status: 'DO_WYSLANIA' })
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'taken_by_courier')
    await a.przebieg()
    await przetworzZdarzenia(db, { env: ENV, opoznienieMs: 0 })
    expect(await db.plannedAction.count({ where: { targetId: p.id, rule: 'mail.faktura' } })).toBe(1)
    a.dalej()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    await a.przebieg()
    expect(await status(p.id)).toBe('ODEBRANE')
    await przetworzZdarzenia(db, { env: ENV, opoznienieMs: 0 })
    expect(await db.plannedAction.count({ where: { targetId: p.id, rule: 'mail.faktura' } })).toBe(1)
  })

  it('ręczne „Odebrane” po „Wysłane” (plan wbudowany wyłączony, bez śledzenia): jeden mail', async () => {
    await regulaFaktury()
    await ustawPlanWbudowany(db, false, 'u-test')
    const p = await paczka('PACZKOMATY', { status: 'DO_WYSLANIA' })
    await moveOrder(db, p.id, 'WYSLANE', { actorId: 'u-test' })
    await przetworzZdarzenia(db, { env: ENV, opoznienieMs: 0 })
    expect(await db.plannedAction.count({ where: { targetId: p.id, rule: 'mail.faktura' } })).toBe(1)
    await moveOrder(db, p.id, 'ODEBRANE', { actorId: 'u-test' })
    await przetworzZdarzenia(db, { env: ENV, opoznienieMs: 0 })
    expect(await db.plannedAction.count({ where: { targetId: p.id, rule: 'mail.faktura' } })).toBe(1)
  })

  it('druga faktura tego samego zamówienia (inny dokument) dostaje swój mail', async () => {
    await regulaFaktury()
    await ustawPlanWbudowany(db, false, 'u-test')
    const p = await paczka('PACZKOMATY', { status: 'DO_WYSLANIA' })
    await moveOrder(db, p.id, 'WYSLANE', { actorId: 'u-test' })
    await przetworzZdarzenia(db, { env: ENV, opoznienieMs: 0 })
    await db.invoiceAttempt.create({ data: { orderId: p.id, packageNo: 1, attemptNo: 2, idExternal: `${p.id}/1/2`, state: 'ISSUED', wfirmaDocId: `FV/T/drugi-${p.id}` } })
    await moveOrder(db, p.id, 'ODEBRANE', { actorId: 'u-test' })
    await przetworzZdarzenia(db, { env: ENV, opoznienieMs: 0 })
    const plany = await db.plannedAction.findMany({ where: { targetId: p.id, rule: 'mail.faktura' }, select: { vars: true } })
    expect(plany.map((x) => (x.vars as { wfirmaDocId?: string }).wfirmaDocId).sort()).toEqual([`FV/T/${nr}`, `FV/T/drugi-${p.id}`].sort())
  })

  it('przycisk „Wyślij fakturę” po wysłanej fakturze planuje drugi mail (ponowna wysyłka na żądanie)', async () => {
    await zastosujAutomatyPresetu(testSystemDb(), ORG_A, {
      automationRules: [{ key: 'test-faktura-przycisk', enabled: true, name: 'Wyślij fakturę ponownie', event: 'PRZYCISK', buttonLabel: 'Wyślij fakturę', buttonPlaces: ['karta'], conditions: [], actions: [{ typ: 'wyslijEmail', szablon: 'faktura' }] }],
    })
    await ustawPlanWbudowany(db, false, 'u-test')
    const p = await paczka('PACZKOMATY')
    const r = await db.automationRule.findFirstOrThrow({ where: { event: 'PRZYCISK', name: 'Wyślij fakturę ponownie' } })
    expect((await kliknijPrzycisk(db, r.id, p.id, 'klik-0000000001', 'karta', { env: ENV })).blad).toBeNull()
    expect(await db.plannedAction.count({ where: { targetId: p.id, rule: 'mail.faktura' } })).toBe(1)
    await db.plannedAction.updateMany({ where: { targetId: p.id, rule: 'mail.faktura' }, data: { state: 'DONE' } })
    expect((await kliknijPrzycisk(db, r.id, p.id, 'klik-0000000002', 'karta', { env: ENV })).blad).toBeNull()
    expect(await db.plannedAction.count({ where: { targetId: p.id, rule: 'mail.faktura' } })).toBe(2)
  })
})

describe('„Powiadamiaj o zwrocie i problemie z paczką”', () => {
  it('zwrot: jeden alert na przesyłkę, status bez zmian; zamyka się przy przyjęciu zwrotu', async () => {
    await ustaw({ powiadomienia: true, odebrane: true })
    const p = await paczka('PACZKOMATY')
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'returned_to_sender')
    expect((await a.przebieg()).bledy).toEqual([])
    expect(await status(p.id)).toBe('WYSLANE')
    const al = await alerty(ALERT_ZWROT_PRZESYLKI)
    expect(al).toHaveLength(1)
    expect(al[0]).toMatchObject({ ref: p.id, closedAt: null, dedupeKey: `przesylka-zwrot:${p.sid}` })
    expect(al[0]!.message).toMatch(/wraca do nadawcy/)
    // ponowny wpis reguł tej przesyłki nie daje drugiego alertu
    await db.shipment.update({ where: { id: p.sid }, data: { trackRulesPending: true, trackRulesAt: null } })
    a.dalej()
    await a.przebieg()
    expect(await alerty(ALERT_ZWROT_PRZESYLKI)).toHaveLength(1)
    // przyjęcie zwrotu w magazynie zamyka powiadomienie
    // zwrot zgłoszony wprost (bez wydania fakturą w atrapie), z korektą faktury: przyjęcie bez ruchu magazynowego
    const linia = await db.orderLine.findFirstOrThrow({ where: { orderId: p.id } })
    const rid = (await db.return.create({ data: { orderId: p.id, invoiceDocId: 'FV/T/zwrot', lines: { create: [{ orderLineId: linia.id, productId: linia.productId!, qty: 1 }] } } })).id
    await receiveReturn(db, rid, 'NA_STAN', { now: new Date() })
    expect((await alerty(ALERT_ZWROT_PRZESYLKI))[0]!.closedAt).not.toBeNull()
  })

  it('zwrot z kodu „zapowiedzi” (termin odbioru minął): alert mówi, że paczka może jeszcze zostać odebrana', async () => {
    await ustaw({ powiadomienia: true })
    const p = await paczka('PACZKOMATY')
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'pickup_time_expired')
    await a.przebieg()
    expect(await status(p.id)).toBe('WYSLANE')
    expect((await alerty(ALERT_ZWROT_PRZESYLKI))[0]!.message).toMatch(/może jeszcze zostać odebrana/)
  })

  it('problem (reklamacja u przewoźnika): alert; po doręczeniu zamyka się, a zamówienie przechodzi w „Odebrane”', async () => {
    await ustaw({ powiadomienia: true, odebrane: true })
    const p = await paczka('PACZKOMATY')
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'claimed')
    await a.przebieg()
    expect(await status(p.id)).toBe('WYSLANE')
    expect(await alerty(ALERT_PROBLEM_PRZESYLKI)).toHaveLength(1)
    a.dalej()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    await a.przebieg()
    expect((await alerty(ALERT_PROBLEM_PRZESYLKI))[0]!.closedAt).not.toBeNull()
    expect(await status(p.id)).toBe('ODEBRANE')
  })

  it('powiadomienia wyłączone: zwrot bez alertu', async () => {
    await ustaw({ odebrane: true })
    const p = await paczka('PACZKOMATY')
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'returned_to_sender')
    await a.przebieg()
    expect(await db.alert.count()).toBe(0)
    expect(await status(p.id)).toBe('WYSLANE')
  })
})

describe('przypadki brzegowe reguł na osi', () => {
  it('zwrot już przyjęty w magazynie (paczka wróciła przed odczytem): bez powiadomienia o zwrocie', async () => {
    await ustaw({ powiadomienia: true, odebrane: true })
    const p = await paczka('PACZKOMATY')
    const linia = await db.orderLine.findFirstOrThrow({ where: { orderId: p.id } })
    const rid = (await db.return.create({ data: { orderId: p.id, invoiceDocId: 'FV/T/zwrot', lines: { create: [{ orderLineId: linia.id, productId: linia.productId!, qty: 1 }] } } })).id
    await receiveReturn(db, rid, 'NA_STAN', { now: new Date() })
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'returned_to_sender')
    expect((await a.przebieg()).bledy).toEqual([])
    expect(await alerty(ALERT_ZWROT_PRZESYLKI)).toHaveLength(0)
    expect(await stany(p.id)).toHaveLength(1)
  })

  it('alert problemu zostaje otwarty po przyjęciu zwrotu (zamyka go tylko doręczenie)', async () => {
    await ustaw({ powiadomienia: true, odebrane: true })
    const p = await paczka('PACZKOMATY')
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'claimed')
    await a.przebieg()
    expect(await alerty(ALERT_PROBLEM_PRZESYLKI)).toHaveLength(1)
    const linia = await db.orderLine.findFirstOrThrow({ where: { orderId: p.id } })
    const rid = (await db.return.create({ data: { orderId: p.id, invoiceDocId: 'FV/T/zwrot', lines: { create: [{ orderLineId: linia.id, productId: linia.productId!, qty: 1 }] } } })).id
    await receiveReturn(db, rid, 'NA_STAN', { now: new Date() })
    expect((await alerty(ALERT_PROBLEM_PRZESYLKI))[0]!.closedAt).toBeNull()
  })

  it('zamówienie główne i podzamówienie: każde przechodzi w „Odebrane” niezależnie, po doręczeniu własnej paczki', async () => {
    await ustaw({ odebrane: true })
    const glowne = await paczka('PACZKOMATY')
    const pod = await paczka('PACZKOMATY')
    await db.order.update({ where: { id: pod.id }, data: { parentOrderId: glowne.id } })
    const a = inpost()
    a.shipx.ustawStatus(Number(glowne.ref), 'delivered')
    a.shipx.ustawStatus(Number(pod.ref), 'out_for_delivery')
    expect((await a.przebieg()).bledy).toEqual([])
    // dziś bez warunku na podzamówienia: główne „Odebrane”, zanim dojdzie dosyłka
    expect(await status(glowne.id)).toBe('ODEBRANE')
    expect(await status(pod.id)).toBe('WYSLANE')
    a.dalej()
    a.shipx.ustawStatus(Number(pod.ref), 'delivered')
    await a.przebieg()
    expect(await status(pod.id)).toBe('ODEBRANE')
  })

  it('przesyłka anulowana i utworzona ponownie: liczy się tylko nowa (aktywna)', async () => {
    await ustaw({ odebrane: true })
    const p = await paczka('PACZKOMATY')
    await db.shipment.update({ where: { id: p.sid }, data: { state: 'ANULOWANA' } })
    const ref = `${980_000 + nr}`
    const nowa = await db.shipment.create({
      data: { orderId: p.id, packageNo: 1, reference: `ref2-${p.id}`, state: 'UTWORZONA', adapterKey: INPOST_KEY, carrier: 'PACZKOMATY', externalRef: ref, trackingNumber: `NR2${nr}`, createdAt: new Date(Date.now() - 2 * H) },
    })
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    a.shipx.ustawStatus(Number(ref), 'delivered')
    expect((await a.przebieg()).bledy).toEqual([])
    expect((await przesylka(p.sid)).trackState).toBeNull()
    expect((await przesylka(nowa.id)).trackState).toBe('DORECZONA')
    expect(await status(p.id)).toBe('ODEBRANE')
  })

  it('aktywna przesyłka bieżącej paczki bez stanu na osi (moduł bez śledzenia) blokuje „Odebrane”', async () => {
    await ustaw({ odebrane: true })
    const p = await paczka('PACZKOMATY')
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'out_for_delivery')
    await a.przebieg()
    // zamówienie przeszło na paczkę 2 nadaną modułem bez śledzenia; doręczenie starej przesyłki nie wystarcza
    await db.order.update({ where: { id: p.id }, data: { packageNo: 2 } })
    await db.shipment.create({ data: { orderId: p.id, packageNo: 2, reference: `ref3-${p.id}`, state: 'UTWORZONA', adapterKey: 'fake.v1', carrier: 'PACZKOMATY', externalRef: 'X-1', trackingNumber: 'NR-X-1' } })
    a.dalej()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    expect((await a.przebieg()).bledy).toEqual([])
    expect((await przesylka(p.sid)).trackState).toBe('DORECZONA')
    expect(await status(p.id)).toBe('WYSLANE')
    expect((await przesylka(p.sid)).trackRulesPending).toBe(false)
  })

  it('plan „Faktury” w podglądzie (SUCHO) sprzed przełączenia: reguła ze zdarzenia nie planuje drugiego maila tej faktury', async () => {
    await zastosujAutomatyPresetu(testSystemDb(), ORG_A, {
      automationRules: [{ key: 'test-faktura', enabled: true, name: 'Wysłane, Odebrane → e-mail Faktura', event: 'USTAWIONO_STATUS', conditions: [{ typ: 'status', wartosci: ['WYSLANE', 'ODEBRANE'] }], actions: [{ typ: 'wyslijEmail', szablon: 'faktura' }] }],
    })
    await ustawPlanWbudowany(db, false, 'u-test')
    const p = await paczka('PACZKOMATY')
    const doc = (await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: p.id } })).wfirmaDocId!
    // stan zastany: konto było w podglądzie, mail wysłał poprzedni system, u nas plan „wysłałbym” na zawsze PLANNED
    await db.plannedAction.create({ data: { rule: 'mail.faktura', targetType: 'ZAMOWIENIE', targetId: p.id, occasion: 'automat:stara:WYSLANE', mode: 'SUCHO', state: 'PLANNED', reason: 'tylko plan', vars: { wfirmaDocId: doc }, dueAt: new Date(), createdAt: new Date() } })
    await moveOrder(db, p.id, 'ODEBRANE', { actorId: 'u-test' })
    await przetworzZdarzenia(db, { env: ENV, opoznienieMs: 0 })
    expect(await db.plannedAction.count({ where: { targetId: p.id, rule: 'mail.faktura' } })).toBe(1)
  })
})

describe('dodatkowa przesyłka (dosyłka) na osi statusów', () => {
  /** Dosyłka nr 1 do zamówienia paczki `p` (InPost, ten sam moduł), utworzona u przewoźnika. */
  async function dosylka(p: { id: string }): Promise<{ sid: string; ref: string }> {
    const ref = `${990_000 + ++nr}`
    const regula = await db.carrierRule.findFirstOrThrow({ where: { carrier: 'PACZKOMATY' }, select: { id: true } })
    const s = await db.shipment.create({
      data: { orderId: p.id, packageNo: 1, extraNo: 1, extraKind: 'DOSYLKA', extraReason: 'reklamacja testowa', extraRuleId: regula.id, reference: `refd-${p.id}`, state: 'UTWORZONA', adapterKey: INPOST_KEY, carrier: 'PACZKOMATY', externalRef: ref, trackingNumber: `NRD${nr}`, createdAt: new Date(Date.now() - 2 * H) },
    })
    return { sid: s.id, ref }
  }

  it('doręczona dosyłka przy niedoręczonej głównej: status zostaje „Wysłane”', async () => {
    await ustaw({ odebrane: true })
    const p = await paczka('PACZKOMATY')
    const d = await dosylka(p)
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'out_for_delivery')
    a.shipx.ustawStatus(Number(d.ref), 'delivered')
    expect((await a.przebieg()).bledy).toEqual([])
    expect((await przesylka(d.sid)).trackState).toBe('DORECZONA')
    expect(await status(p.id)).toBe('WYSLANE')
  })

  it('doręczona główna przy niedoręczonej dosyłce: „Odebrane” (dosyłka nie wstrzymuje)', async () => {
    await ustaw({ odebrane: true })
    const p = await paczka('PACZKOMATY')
    const d = await dosylka(p)
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    a.shipx.ustawStatus(Number(d.ref), 'out_for_delivery')
    expect((await a.przebieg()).bledy).toEqual([])
    expect(await status(p.id)).toBe('ODEBRANE')
  })

  it('zwrot dosyłki: alert dla tej przesyłki, status bez zmian', async () => {
    await ustaw({ powiadomienia: true, odebrane: true })
    const p = await paczka('PACZKOMATY')
    const d = await dosylka(p)
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'delivered')
    a.shipx.ustawStatus(Number(d.ref), 'returned_to_sender')
    expect((await a.przebieg()).bledy).toEqual([])
    const al = await alerty(ALERT_ZWROT_PRZESYLKI)
    expect(al).toHaveLength(1)
    expect(al[0]).toMatchObject({ ref: p.id, dedupeKey: `przesylka-zwrot:${d.sid}` })
    // „Odebrane” z głównej zostaje, zwrot dosyłki go nie cofa
    expect(await status(p.id)).toBe('ODEBRANE')
  })

  it('kolejka „Wysłane”: odbiór dosyłki przez kuriera nie daje „Wysłane” spakowanemu zamówieniu', async () => {
    await ustaw({ odebrane: true })
    const p = await paczka('PACZKOMATY', { status: 'DO_WYSLANIA' })
    const d = await dosylka(p)
    const a = inpost()
    a.shipx.ustawStatus(Number(p.ref), 'confirmed')
    a.shipx.ustawStatus(Number(d.ref), 'taken_by_courier')
    expect((await a.przebieg()).bledy).toEqual([])
    expect(await status(p.id)).toBe('DO_WYSLANIA')
    expect(await db.orderEvent.count({ where: { orderId: p.id, kind: 'WYSLANE' } })).toBe(0)
  })
})
