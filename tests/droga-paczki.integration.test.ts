// Droga paczki na karcie zamówienia i na liście przesyłek: stan z osi statusów, data ostatniej zmiany, link do strony
// śledzenia u przewoźnika i historia zdarzeń, także przy wyłączonym „Śledź paczki aż do doręczenia” i bez zdarzeń.
// Tylko odczyt z bazy (klient firmy, RLS), dane fikcyjne, zero połączeń z przewoźnikami.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Carrier, ShipmentState, ShipmentTrackState } from '@prisma/client'
import { ALLEGRO_WYSYLAM_ZAPIS_KEY } from '@/lib/adaptery/allegro-wysylam-zapis'
import { BASE_COURIER_ZAPIS_KEY } from '@/lib/adaptery/basecourier-zapis'
import { DPD_ZAPIS_KEY } from '@/lib/adaptery/dpd'
import { INPOST_SHIPX_ZAPIS_KEY } from '@/lib/adaptery/inpost-zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { zapiszAutomatyWysylki, zapiszSledzeniePrzewoznikow } from '@/lib/wysylka/automaty'
import { drogaPaczek, HISTORIA_NA_KARCIE } from '@/lib/wysylka/droga-paczki'
import { filtryPrzesylekZ, pokazDrogeNaLiscie, SORT_PRZESYLEK_DOMYSLNY, stronaPrzesylek } from '@/lib/wysylka/lista'
import { ORG_B, testDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
const b = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await b.$disconnect()
})

const H = 3600_000
let nr = 0

async function zamowienie(): Promise<string> {
  const pid = await product(db, `DP-${++nr}-${Math.random().toString(36).slice(2, 6)}`, 50)
  const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { channel: 'WOO_SD', paymentState: 'PAID' }), { now: T0 })
  await db.order.update({ where: { id: r.orderId! }, data: { status: 'WYSLANE' } })
  return r.orderId!
}

async function przesylka(orderId: string, o: { carrier?: Carrier; modul?: string; numer?: string | null; state?: ShipmentState; trackState?: ShipmentTrackState; since?: Date; packageNo?: number; createdAt?: Date } = {}) {
  return db.shipment.create({
    data: {
      orderId,
      packageNo: o.packageNo ?? 1,
      reference: `ref-${orderId}-${++nr}`,
      state: o.state ?? 'UTWORZONA',
      adapterKey: o.modul ?? INPOST_SHIPX_ZAPIS_KEY,
      carrier: o.carrier ?? 'PACZKOMATY',
      trackingNumber: o.numer === undefined ? `6000000000000000000${10000 + nr}` : o.numer,
      ...(o.trackState ? { trackState: o.trackState, trackStateSince: o.since ?? T0 } : {}),
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    },
  })
}

const sledzenieDoKonca = () => zapiszAutomatyWysylki(db, { wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: true, sledzenieDoDoreczenia: true }, 'u-admin')

const zdarzenie = (shipmentId: string, state: ShipmentTrackState, occurredAt: Date, carrierCode = '') => db.shipmentTrackEvent.create({ data: { shipmentId, state, occurredAt, carrierCode, carrierStatus: carrierCode || null } })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(b)
})

describe('karta zamówienia: blok „Przesyłki”', () => {
  it('stan z osi, data wejścia w stan, link InPost i historia od najnowszego zdarzenia', async () => {
    await sledzenieDoKonca()
    const id = await zamowienie()
    const s = await przesylka(id, { trackState: 'W_DORECZENIU', since: new Date(T0.getTime() + 30 * H) })
    await zdarzenie(s.id, 'PRZEKAZANA', new Date(T0.getTime() + 2 * H), 'collected_from_sender')
    await zdarzenie(s.id, 'W_DRODZE', new Date(T0.getTime() + 10 * H), 'adopted_at_sorting_center')
    await zdarzenie(s.id, 'W_DORECZENIU', new Date(T0.getTime() + 30 * H), 'out_for_delivery')
    const [p, ...reszta] = await drogaPaczek(db, id)
    expect(reszta).toHaveLength(0)
    expect(p).toMatchObject({ przewoznik: 'Paczkomaty', numer: s.trackingNumber, link: `https://inpost.pl/sledzenie-przesylek?number=${s.trackingNumber}`, stronaLinku: 'InPost', stan: 'W_DORECZENIU', stanOpis: 'Wydana do doręczenia', ton: 'info', etykietaDaty: 'W tym stanie od', uwaga: null, starszychZdarzen: 0, anulowana: false })
    expect(p!.odKiedy.getTime()).toBe(T0.getTime() + 30 * H)
    expect(p!.historia.map((e) => e.stan)).toEqual(['W_DORECZENIU', 'W_DRODZE', 'PRZEKAZANA'])
    expect(p!.historia[0]).toMatchObject({ opis: 'Wydana do doręczenia', uPrzewoznika: 'out_for_delivery' })
  })

  it('śledzenie do doręczenia wyłączone, brak zdarzeń: numer i link, pusta historia ze spokojnym zdaniem', async () => {
    const id = await zamowienie()
    await przesylka(id, { carrier: 'DPD', modul: DPD_ZAPIS_KEY, numer: '0000000000001U' })
    const [p] = await drogaPaczek(db, id)
    expect(p).toMatchObject({ link: 'https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=0000000000001U', stan: null, stanOpis: 'Utworzona u przewoźnika', historia: [] })
    expect(p!.uwaga).toMatch(/^Kompletor nie śledzi drogi tej paczki do doręczenia/)
  })

  it('przewoźnik bez potwierdzonego adresu śledzenia: numer bez linku', async () => {
    const id = await zamowienie()
    await przesylka(id, { carrier: 'POCZTA_POLSKA', numer: '00000000000000000001' })
    const [p] = await drogaPaczek(db, id)
    expect(p).toMatchObject({ numer: '00000000000000000001', link: null, stronaLinku: null })
    expect(p!.uwaga).toMatch(/na stronie przewoźnika po numerze nadania/)
  })

  it('ten sam przewoźnik, różny moduł: w panelu link także przy paczce nadanej przez pośrednika (Wysyłam z Allegro, Base Courier), gdy przewoźnik ma znany adres śledzenia', async () => {
    const id = await zamowienie()
    const wlasny = await przesylka(id, { carrier: 'PACZKOMATY', modul: INPOST_SHIPX_ZAPIS_KEY })
    const allegro = await przesylka(id, { carrier: 'PACZKOMATY', modul: ALLEGRO_WYSYLAM_ZAPIS_KEY, packageNo: 2 })
    const dpd = await przesylka(id, { carrier: 'DPD', modul: DPD_ZAPIS_KEY, numer: '0000000000002U', packageNo: 3 })
    const bc = await przesylka(id, { carrier: 'DPD', modul: BASE_COURIER_ZAPIS_KEY, numer: '0000000000003U', packageNo: 4 })
    const karta = new Map((await drogaPaczek(db, id)).map((p) => [p.id, p]))
    expect(karta.get(wlasny.id)).toMatchObject({ link: `https://inpost.pl/sledzenie-przesylek?number=${wlasny.trackingNumber}`, stronaLinku: 'InPost' })
    expect(karta.get(dpd.id)).toMatchObject({ link: 'https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=0000000000002U', stronaLinku: 'DPD' })
    // numer paczki nadanej przez pośrednika jest numerem przewoźnika, więc panel prowadzi do jego strony śledzenia
    expect(karta.get(allegro.id)).toMatchObject({ numer: allegro.trackingNumber, link: `https://inpost.pl/sledzenie-przesylek?number=${allegro.trackingNumber}`, stronaLinku: 'InPost' })
    expect(karta.get(bc.id)).toMatchObject({ numer: bc.trackingNumber, link: 'https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=0000000000003U', stronaLinku: 'DPD' })
    const lista = await stronaPrzesylek(db, filtryPrzesylekZ({}), { sort: SORT_PRZESYLEK_DOMYSLNY, pomin: 0, ile: 50 })
    const link = (sid: string) => lista.wiersze.find((r) => r.id === sid)!.link
    expect(link(wlasny.id)).toMatch(/^https:\/\/inpost\.pl\//)
    expect(link(dpd.id)).toMatch(/^https:\/\/tracktrace\.dpd\.com\.pl\//)
    expect(link(allegro.id)).toMatch(/^https:\/\/inpost\.pl\//)
    expect(link(bc.id)).toMatch(/^https:\/\/tracktrace\.dpd\.com\.pl\//)
  })

  it('śledzenie do doręczenia włączone, moduł nieśledzony: zdanie, że Kompletor nie sprawdza tego przewoźnika; po zaznaczeniu modułu zdanie o czekaniu na przewoźnika', async () => {
    await sledzenieDoKonca()
    const id = await zamowienie()
    const dpd = await przesylka(id, { carrier: 'DPD', modul: DPD_ZAPIS_KEY, numer: '0000000000004U' })
    const bc = await przesylka(id, { carrier: 'DPD', modul: BASE_COURIER_ZAPIS_KEY, numer: '0000000000005U', packageNo: 2 })
    const inpost = await przesylka(id, { packageNo: 3 })
    const uwagi = async () => new Map((await drogaPaczek(db, id)).map((p) => [p.id, p.uwaga]))
    const NIE_SPRAWDZA = /^Kompletor nie sprawdza drogi paczek tego przewoźnika/
    let u = await uwagi()
    // DPD domyślnie poza listą pytanych modułów; Base Courier (od 19.11.2026) i InPost pytane od początku
    expect(u.get(dpd.id)).toMatch(NIE_SPRAWDZA)
    expect(u.get(bc.id)).toMatch(/^Przewoźnik nie podał jeszcze stanu paczki/)
    expect(u.get(inpost.id)).toMatch(/^Przewoźnik nie podał jeszcze stanu paczki/)
    await zapiszSledzeniePrzewoznikow(db, { [DPD_ZAPIS_KEY]: true, [INPOST_SHIPX_ZAPIS_KEY]: false }, [DPD_ZAPIS_KEY, INPOST_SHIPX_ZAPIS_KEY], 'u-admin')
    u = await uwagi()
    expect(u.get(dpd.id)).toMatch(/^Przewoźnik nie podał jeszcze stanu paczki/)
    expect(u.get(bc.id)).toMatch(/^Przewoźnik nie podał jeszcze stanu paczki/)
    expect(u.get(inpost.id)).toMatch(NIE_SPRAWDZA)
  })

  it('kilka przesyłek tej samej paczki: aktywna przed anulowaną (mimo późniejszej daty); anulowana z numerem zostaje (bez linku), bez numeru i nieudana znikają', async () => {
    const id = await zamowienie()
    const anul = await przesylka(id, { state: 'ANULOWANA', createdAt: new Date(T0.getTime() + H) })
    await przesylka(id, { state: 'ANULOWANA', numer: null, createdAt: new Date(T0.getTime() + 2 * H) })
    await przesylka(id, { state: 'BLAD', numer: null, createdAt: new Date(T0.getTime() + 3 * H) })
    const nowa = await przesylka(id, { trackState: 'DORECZONA', createdAt: new Date(T0.getTime() + 4 * H) })
    const lista = await drogaPaczek(db, id)
    expect(lista.map((p) => p.id)).toEqual([nowa.id, anul.id])
    expect(lista[0]).toMatchObject({ stanOpis: 'Doręczona', ton: 'sukces' })
    expect(lista[1]).toMatchObject({ stanOpis: 'Anulowana', numer: anul.trackingNumber, link: null, anulowana: true })
  })

  it('historia ucięta do ostatnich zdarzeń, licznik starszych', async () => {
    const id = await zamowienie()
    const s = await przesylka(id, { trackState: 'W_DRODZE' })
    await db.shipmentTrackEvent.createMany({ data: Array.from({ length: HISTORIA_NA_KARCIE + 5 }, (_, i) => ({ shipmentId: s.id, state: 'W_DRODZE' as const, occurredAt: new Date(T0.getTime() + i * H), carrierCode: `k${i}` })) })
    const [p] = await drogaPaczek(db, id)
    expect(p!.historia).toHaveLength(HISTORIA_NA_KARCIE)
    expect(p!.starszychZdarzen).toBe(5)
    expect(p!.historia[0]!.uPrzewoznika).toBe(`k${HISTORIA_NA_KARCIE + 4}`)
  })

  it('inna firma nie widzi przesyłek ani historii (RLS)', async () => {
    const id = await zamowienie()
    const s = await przesylka(id, { trackState: 'W_DRODZE' })
    await zdarzenie(s.id, 'W_DRODZE', T0, 'x')
    expect(await drogaPaczek(b, id)).toEqual([])
  })
})

describe('lista przesyłek: droga paczki', () => {
  it('kolumna ma stan drogi i link; filtr po stanie i „bez odczytu”', async () => {
    const id = await zamowienie()
    const wDrodze = await przesylka(id, { trackState: 'W_DRODZE', since: new Date(T0.getTime() + 5 * H) })
    const zwrot = await przesylka(id, { trackState: 'ZWROT', packageNo: 2, carrier: 'DPD', modul: DPD_ZAPIS_KEY, numer: '0000000000009U' })
    const bez = await przesylka(id, { packageNo: 3, carrier: 'ALLEGRO', modul: ALLEGRO_WYSYLAM_ZAPIS_KEY, numer: 'A000TESTOWY' })
    const nieznany = await przesylka(id, { trackState: 'NIEZNANY', packageNo: 4 })
    // anulowana bez numeru i drogi nie wpada do „Bez odczytu drogi paczki”
    await przesylka(id, { state: 'ANULOWANA', numer: null, packageNo: 5 })
    const strona = (sp: Record<string, string>) => stronaPrzesylek(db, filtryPrzesylekZ(sp), { sort: SORT_PRZESYLEK_DOMYSLNY, pomin: 0, ile: 50 })
    const wszystkie = await strona({})
    const w = wszystkie.wiersze.find((r) => r.id === wDrodze.id)!
    expect(w).toMatchObject({ droga: 'W_DRODZE', drogaOpis: 'W drodze', link: `https://inpost.pl/sledzenie-przesylek?number=${wDrodze.trackingNumber}` })
    expect(w.drogaOd!.getTime()).toBe(T0.getTime() + 5 * H)
    // bez odczytu drogi; link panelu jak na produkcji od 22.11.2026 (komponent NumerNadania): strona śledzenia Allegro
    expect(wszystkie.wiersze.find((r) => r.id === bez.id)).toMatchObject({ droga: null, drogaOpis: null, link: 'https://allegro.pl/allegrodelivery/sledzenie-paczki?numer=A000TESTOWY' })
    expect((await strona({ droga: 'ZWROT' })).wiersze.map((r) => r.id)).toEqual([zwrot.id])
    expect((await strona({ droga: 'BRAK' })).wiersze.map((r) => r.id)).toEqual([bez.id])
    expect((await strona({ droga: 'DORECZONA' })).razem).toBe(0)
    // stan nieznany: w kolumnie zostaje „Utworzona”, stan drogi tylko w filtrze
    const n = wszystkie.wiersze.find((r) => r.id === nieznany.id)!
    expect(n).toMatchObject({ stan: 'UTWORZONA', stanOpis: 'Utworzona', droga: 'NIEZNANY' })
    expect(pokazDrogeNaLiscie(n.stan, n.droga)).toBe(false)
    expect(pokazDrogeNaLiscie(w.stan, w.droga)).toBe(true)
    expect((await strona({ droga: 'NIEZNANY' })).wiersze.map((r) => r.id)).toEqual([nieznany.id])
  })
})
