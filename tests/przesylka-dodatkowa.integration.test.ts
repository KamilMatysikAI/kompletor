// Dodatkowa przesyłka do tego samego zamówienia (dosyłka, paczka zastępcza, druga paczka) za hostem przesyłek
// (`utworzDodatkowa`, lib/wysylka/nadanie.ts) na atrapie Base Courier (tests/basecourier-atrapa.ts) i bazie testowej.
// Zasady: status zamówienia, magazyn, dokumenty i kanał bez zmian; numer nadania zamówienia zostaje numerem głównej
// przesyłki także po anulowaniu dosyłki; bez automatów; numer z okna chroni przed drugą etykietą; druk i akcje biorą
// główną przesyłkę; indeks jednej aktywnej głównej przesyłki działa po migracji; izolacja firm. Dane fikcyjne, zero
// połączeń z Base Courier.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderStatus, PrismaClient } from '@prisma/client'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { ordersByNumber } from '@/lib/api/zamowienia'
import { filtryZ, SORT_DOMYSLNY, stronaListy } from '@/lib/panel/zamowienia-lista'
import { zdarzeniaZDziennika, ZMIANY_STATUSU } from '@/lib/automaty/silnik'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { STATUSY_DODATKOWEJ } from '@/lib/wysylka/dodatkowa'
import { drogaPaczek } from '@/lib/wysylka/droga-paczki'
import { etykietaPrzesylki } from '@/lib/wysylka/etykieta-przewoznika'
import { zapiszAutomatyWysylki } from '@/lib/wysylka/automaty'
import { adapterDlaPrzesylki, ALERT_PRZESYLKI, anulujPrzesylke, bramkaDodatkowej, dodatkowaDoWyjasnienia, KOMUNIKAT_DODATKOWA_WYLACZONA, PRZESYLKA_DODATKOWA, rozstrzygnijRecznie, sprawdzPrzesylke, utworzDodatkowa, utworzPrzesylke, widokPrzesylki, type DepsNadania, type ZlecenieDodatkowej } from '@/lib/wysylka/nadanie'
import { filtryPrzesylekZ, SORT_PRZESYLEK_DOMYSLNY, stronaPrzesylek } from '@/lib/wysylka/lista'
import { raportDodatkowych } from '@/lib/wysylka/raport-dodatkowych'
import { NUMER_NADANIA_GOTOWY } from '@/lib/wysylka/zdarzenia'
import { BC_KEY, BC_LOGIN, BC_SANDBOX, bcAtrapa } from './basecourier-atrapa'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { NADAWCA_TESTOWY } from './dpd-atrapa'
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
  punktOdbioru: { kod: 'POZ08M', nazwa: null },
  faktura: null,
  problemy: [],
}
const ENV = { EKRANY_PRACA: '1', CUSTOMER_DATA_KEYS: `1:${'3'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'c'.repeat(64), BASE_COURIER_LOGIN: BC_LOGIN, BASE_COURIER_API_KEY: BC_KEY }
const KONFIG = { baseUrl: BC_SANDBOX, zapisWlaczony: true, kontoPobran: '11 1111 1111 1111 1111 1111 1111', defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20, defaultWeightKg: 1 }
const POTWIERDZONE = ['waga_domyslna', 'gabaryt_podpowiedz']

let bc: ReturnType<typeof bcAtrapa>
const deps = (): DepsNadania => ({ fetch: bc.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true } })
const utworzonych = () => bc.ile('createOrderV2.json')

async function firma(c: PrismaClient = db): Promise<void> {
  await c.carrierRule.updateMany({ where: { carrier: 'PACZKOMATY' }, data: { shippingModule: 'BASE_COURIER', adapterKey: 'basecourier.zapis.v1', config: KONFIG as object } })
  await c.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
  await sys.organization.update({ where: { id: c === db ? ORG_A : ORG_B }, data: { settings: { nadawca: NADAWCA_TESTOWY, wysylkaAutomaty: { dodatkowaPrzesylka: true } } } })
}

/** Zamówienie z główną przesyłką utworzoną u przewoźnika, potem ustawiony status. */
async function zGlowna(status: OrderStatus = 'WYSLANE'): Promise<{ id: string; glowna: string; numerGlownej: string }> {
  const pid = await product(db, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const id = (await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: 'Paczkomaty InPost', paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })).orderId!
  await zapiszRekordKlienta(db, id, rekordZOdbiorcy(ODBIORCA), { source: 'RECZNE', fetchedAt: T0, env: ENV })
  const w = await utworzPrzesylke(db, { orderId: id, gabaryt: 'INPOST_A', potwierdzoneOstrzezenia: POTWIERDZONE, userId: 'u-test' }, deps())
  expect(w.wynik).toBe('UTWORZONA')
  await db.order.update({ where: { id }, data: { status } })
  const s = await db.shipment.findFirstOrThrow({ where: { orderId: id, extraNo: 0 } })
  return { id, glowna: s.id, numerGlownej: s.trackingNumber! }
}

async function zlecenie(orderId: string, o: Partial<ZlecenieDodatkowej> = {}): Promise<ZlecenieDodatkowej> {
  const b = (await bramkaDodatkowej(db, orderId, deps()))!
  return { orderId, numer: b.nastepnyNumer, regulaId: b.moduly[0]?.regulaId ?? '', rodzaj: 'DOSYLKA', powod: 'reklamacja: brak jednego produktu', gabaryt: 'INPOST_A', koszt: '14,50', potwierdzam: true, potwierdzoneOstrzezenia: POTWIERDZONE, userId: 'u-test', ...o }
}
const dodaj = async (orderId: string, o: Partial<ZlecenieDodatkowej> = {}, c: PrismaClient = db) => utworzDodatkowa(c, await zlecenie(orderId, o), deps())

/** Liczniki tabel rdzenia magazynu, dokumentów, kanału i automatów (całej firmy). */
async function liczniki() {
  const [ruchy, rezerwacje, braki, oczekujace, faktury, ksef, wz, zapisyKanalu, pushe, outbox, maile, automaty, plany, stany, numery] = await Promise.all([
    db.stockMovement.count(),
    db.reservation.count(),
    db.shortage.count(),
    db.pendingMovement.count(),
    db.invoiceAttempt.count(),
    db.ksefInvoiceDraft.count(),
    db.wzAttempt.count(),
    db.channelWrite.count(),
    db.channelPushLog.count(),
    db.outboxEvent.count(),
    db.mailDelivery.count(),
    db.automationRun.count(),
    db.plannedAction.count(),
    db.stock.findMany({ select: { productId: true, physical: true, reserved: true, pendingDelta: true }, orderBy: { productId: 'asc' } }),
    db.auditLog.count({ where: { entity: NUMER_NADANIA_GOTOWY } }),
  ])
  return { ruchy, rezerwacje, braki, oczekujace, faktury, ksef, wz, zapisyKanalu, pushe, outbox, maile, automaty, plany, stany, numery }
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
  await firma()
  bc = bcAtrapa()
  vi.stubEnv('CUSTOMER_DATA_KEYS', ENV.CUSTOMER_DATA_KEYS)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dodatkowa przesyłka nie zmienia zamówienia', () => {
  for (const st of STATUSY_DODATKOWEJ) {
    it(`status ${st}: status bez zmian, bez rozchodu, rezerwacji, faktury, korekty, braku, zapisu do kanału, maila i automatu`, async () => {
      const z = await zGlowna(st)
      const przed = await liczniki()
      const zdarzeniaPrzed = await db.orderEvent.count({ where: { orderId: z.id } })
      const w = await dodaj(z.id)
      expect(w).toMatchObject({ wynik: 'UTWORZONA', istniala: false })
      expect((await db.order.findUniqueOrThrow({ where: { id: z.id } })).status).toBe(st)
      expect(await liczniki()).toEqual(przed)
      // jedyne nowe zdarzenie zamówienia: PRZESYLKA_DODATKOWA bez `nadanie`, bez zdarzeń dla automatów i bez zmiany statusu
      const nowe = await db.orderEvent.findMany({ where: { orderId: z.id }, orderBy: { createdAt: 'asc' }, skip: zdarzeniaPrzed })
      expect(nowe.map((e) => e.kind)).toEqual([PRZESYLKA_DODATKOWA])
      expect(nowe[0]!.data).not.toHaveProperty('nadanie')
      for (const e of nowe) expect(zdarzeniaZDziennika(e)).toEqual([])
      expect((ZMIANY_STATUSU as readonly string[]).includes(PRZESYLKA_DODATKOWA)).toBe(false)
    })
  }

  it('status przed spakowaniem (do realizacji): odmowa bez wywołania przewoźnika', async () => {
    const z = await zGlowna('DO_REALIZACJI')
    const n = utworzonych()
    expect(await dodaj(z.id)).toMatchObject({ wynik: 'ODMOWA' })
    expect(utworzonych()).toBe(n)
  })
})

describe('numer w sklepie i API zostaje numerem głównej przesyłki', () => {
  it('po dodaniu i po anulowaniu dosyłki: numerNadania zamówienia, zapisy numeru do kanału i widok głównej bez zmian', async () => {
    const z = await zGlowna('WYSLANE')
    const zapisyPrzed = await db.channelWrite.findMany({ select: { id: true, state: true, key: true } })
    const o = await db.order.findUniqueOrThrow({ where: { id: z.id } })
    const api = async () => (await ordersByNumber(db, { numer: o.channelNumber ?? o.externalId }))[0]!
    const numerPrzed = (await api()).numerNadania
    expect(numerPrzed).toBe(z.numerGlownej)
    expect((await dodaj(z.id)).wynik).toBe('UTWORZONA')
    const d = await db.shipment.findFirstOrThrow({ where: { orderId: z.id, extraNo: 1 } })
    expect(d.trackingNumber).not.toBe(z.numerGlownej)
    expect((await api()).numerNadania).toBe(numerPrzed)
    expect((await widokPrzesylki(db, z.id))!.numer).toBe(z.numerGlownej)
    // anulowanie dosyłki po „Wysłane” (Base Courier anuluje): bez pustego `nadanie`, bez zamykania zapisów numeru głównej
    expect(await anulujPrzesylke(db, d.id, { userId: 'u', deps: deps() })).toMatchObject({ wynik: 'ANULOWANA' })
    const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: z.id, kind: 'PRZESYLKA_ANULOWANA' } })
    expect(ev.data).not.toHaveProperty('nadanie')
    expect((await api()).numerNadania).toBe(numerPrzed)
    expect(await db.channelWrite.findMany({ select: { id: true, state: true, key: true } })).toEqual(zapisyPrzed)
    expect((await db.order.findUniqueOrThrow({ where: { id: z.id } })).status).toBe('WYSLANE')
    // główna nadal aktywna, a anulowania głównej po „Wysłane” wciąż nie ma
    expect(await anulujPrzesylke(db, z.glowna, { userId: 'u', deps: deps() })).toMatchObject({ wynik: 'ODMOWA' })
  })
})

describe('zabezpieczenie przed dublem', () => {
  it('drugie kliknięcie z tym samym numerem i dwa równoległe: jedna etykieta u przewoźnika', async () => {
    const z = await zGlowna()
    const zl = await zlecenie(z.id)
    const n = utworzonych()
    const [a, b] = await Promise.all([utworzDodatkowa(db, zl, deps()), utworzDodatkowa(db, zl, deps())])
    expect([a.wynik, b.wynik]).toContain('UTWORZONA')
    expect(await utworzDodatkowa(db, zl, deps())).toMatchObject({ wynik: 'UTWORZONA', istniala: true })
    expect(utworzonych()).toBe(n + 1)
    expect(await db.shipment.count({ where: { orderId: z.id, extraNo: { gte: 1 } } })).toBe(1)
    // okno otwarte przed pierwszą (stary numer 1) przy kolejnej świadomej dosyłce z numerem 2: nowy numer to 2
    expect((await bramkaDodatkowej(db, z.id, deps()))!.nastepnyNumer).toBe(2)
  })

  it('numer nieaktualny (inna dosyłka w międzyczasie): odmowa bez przewoźnika', async () => {
    const z = await zGlowna()
    expect((await dodaj(z.id)).wynik).toBe('UTWORZONA')
    const n = utworzonych()
    expect(await dodaj(z.id, { numer: 5 })).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringMatching(/odśwież kartę/) })
    expect(utworzonych()).toBe(n)
  })

  it('bez potwierdzenia, bez powodu, bez rodzaju albo z kosztem-literówką: odmowa bez przewoźnika i bez wiersza', async () => {
    const z = await zGlowna()
    const n = utworzonych()
    for (const o of [{ potwierdzam: false }, { powod: '' }, { powod: 'ab' }, { rodzaj: 'INNA' }, { koszt: '15000' }, { gabaryt: 'DPD' }] as Partial<ZlecenieDodatkowej>[])
      expect(await dodaj(z.id, o), JSON.stringify(o)).toMatchObject({ wynik: 'ODMOWA' })
    expect(utworzonych()).toBe(n)
    expect(await db.shipment.count({ where: { orderId: z.id, extraNo: { gte: 1 } } })).toBe(0)
  })

  it('błąd przewoźnika: okno wraca do tego samego numeru, ponowienie tym samym wierszem i referencją, jedna przesyłka', async () => {
    const z = await zGlowna()
    bc.awarie['createOrderV2.json'] = [{ status: 200, body: JSON.stringify({ success: false, message: 'Błąd walidacji', data: { validationErrors: { Cart: [{ Order: { taker_phone: ['Telefon jest wymagany'] } }] } } }) }]
    expect((await dodaj(z.id)).wynik).toBe('BLAD')
    const blad = await db.shipment.findFirstOrThrow({ where: { orderId: z.id, extraNo: 1 } })
    expect(blad.state).toBe('BLAD')
    expect((await bramkaDodatkowej(db, z.id, deps()))!.nastepnyNumer).toBe(1)
    expect((await dodaj(z.id)).wynik).toBe('UTWORZONA')
    const po = await db.shipment.findMany({ where: { orderId: z.id, extraNo: { gte: 1 } } })
    expect(po).toHaveLength(1)
    expect(po[0]).toMatchObject({ id: blad.id, reference: blad.reference, state: 'UTWORZONA' })
    expect(bc.zamowienia.filter((x) => x.status === 'created')).toHaveLength(2) // główna + jedna dosyłka
  })

  it('dosyłka niejasna u przewoźnika (zgubiona odpowiedź): kolejnej nie da się dodać, okno pokazuje „Sprawdź u przewoźnika”', async () => {
    const z = await zGlowna()
    bc.awarie['createOrderV2.json'] = ['zgubiona']
    expect((await dodaj(z.id)).wynik).toBe('NIEJEDNOZNACZNA')
    const b = (await bramkaDodatkowej(db, z.id, deps()))!
    expect(b.powod).toMatch(/Sprawdź u przewoźnika/)
    expect(b.doSprawdzenia).toMatchObject({ numer: 1 })
    const n = utworzonych()
    expect(await dodaj(z.id, { numer: 2 })).toMatchObject({ wynik: 'ODMOWA' })
    expect(utworzonych()).toBe(n)
  })
})

describe('niejasna dodatkowa przesyłka: wyjście w oknie „Dodaj przesyłkę”', () => {
  /** Zamówienie z główną i dosyłką nr 1, której odpowiedź przewoźnika zginęła (u przewoźnika powstała). */
  async function zNiejasna() {
    const z = await zGlowna()
    bc.awarie['createOrderV2.json'] = ['zgubiona']
    expect((await dodaj(z.id)).wynik).toBe('NIEJEDNOZNACZNA')
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: z.id, extraNo: 1 } })
    expect(s.state).toBe('NIEJEDNOZNACZNA')
    return { ...z, s, uPrzewoznika: bc.zamowienia.at(-1)! }
  }

  it('okno dostaje referencję i wskazówkę do „Rozstrzygnij ręcznie”, a alert wskazuje okno, nie przyciski karty', async () => {
    const { id, s } = await zNiejasna()
    const b = (await bramkaDodatkowej(db, id, deps()))!
    expect(b.powod).toMatch(/Rozstrzygnij ręcznie/)
    expect(b.doSprawdzenia).toMatchObject({ shipmentId: s.id, numer: 1, referencja: s.reference, rozstrzygalna: true, rozstrzygniecie: { etykietaNumeru: expect.stringContaining('Base Courier') } })
    expect(b.doSprawdzenia!.rozstrzygniecie.wskazowka).toContain(s.reference)
    const a = await db.alert.findFirstOrThrow({ where: { kind: ALERT_PRZESYLKI, closedAt: null } })
    expect(a.message).toContain('dodatkowa przesyłka nr 1')
    expect(a.message).toContain('w oknie „Dodaj przesyłkę”')
    // widok przesyłki na karcie zostaje przy głównej
    expect((await widokPrzesylki(db, id))!.doSprawdzenia).toBe(false)
  })

  it('„Rozstrzygnij ręcznie”: istnieje, numer listu z panelu = dosyłka UTWORZONA; status, numer w sklepie i zdarzenia głównej bez zmian; można dodać kolejną', async () => {
    const { id, s, uPrzewoznika, numerGlownej } = await zNiejasna()
    const statusPrzed = (await db.order.findUniqueOrThrow({ where: { id } })).status
    const przed = await liczniki()
    const r = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: uPrzewoznika.waybill_no }, { userId: 'u-test', deps: deps() })
    expect(r.wynik).toBe('UTWORZONA')
    expect(await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ state: 'UTWORZONA', trackingNumber: uPrzewoznika.waybill_no, extraNo: 1 })
    expect(await liczniki()).toEqual(przed)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe(statusPrzed)
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'PRZESYLKA_UTWORZONA' } })).toBe(1) // tylko główna
    expect(await db.orderEvent.count({ where: { orderId: id, kind: PRZESYLKA_DODATKOWA } })).toBe(1)
    expect(await db.alert.count({ where: { kind: ALERT_PRZESYLKI, closedAt: null } })).toBe(0)
    expect((await widokPrzesylki(db, id))!.numer).toBe(numerGlownej)
    const b = (await bramkaDodatkowej(db, id, deps()))!
    expect(b).toMatchObject({ powod: null, nastepnyNumer: 2, doSprawdzenia: null })
  })

  it('„Rozstrzygnij ręcznie”: nie powstała = dosyłka ANULOWANA, okno pozwala dodać nową z nową referencją, jedna nowa etykieta', async () => {
    const { id, s, glowna } = await zNiejasna()
    const r = await rozstrzygnijRecznie(db, s.id, { wariant: 'NIE_POWSTALA' }, { userId: 'u-test', deps: deps() })
    expect(r).toMatchObject({ wynik: 'ANULOWANA', komunikat: expect.stringContaining('dodatkowa przesyłka nr 1 nie powstała') })
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('ANULOWANA')
    expect((await db.shipment.findUniqueOrThrow({ where: { id: glowna } })).state).toBe('UTWORZONA')
    expect(await db.alert.count({ where: { kind: ALERT_PRZESYLKI, closedAt: null } })).toBe(0)
    const b = (await bramkaDodatkowej(db, id, deps()))!
    expect(b).toMatchObject({ powod: null, nastepnyNumer: 2, doSprawdzenia: null })
    const n = utworzonych()
    expect((await dodaj(id)).wynik).toBe('UTWORZONA')
    expect(utworzonych()).toBe(n + 1)
    const nowa = await db.shipment.findFirstOrThrow({ where: { orderId: id, extraNo: 2 } })
    expect(nowa.reference).not.toBe(s.reference)
  })

  it('„Rozstrzygnij ręcznie”: numer głównej przesyłki z tej samej karty = odmowa bez pytania przewoźnika; dosyłka zostaje niejasna', async () => {
    const { id, s, numerGlownej, glowna } = await zNiejasna()
    const zapytan = bc.calls.length
    const r = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: numerGlownej }, { userId: 'u-test', deps: deps() })
    expect(r).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringContaining('przesyłki głównej tego samego zamówienia') })
    expect(r.komunikat).toContain(s.reference)
    expect(bc.calls.length).toBe(zapytan)
    expect(await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ state: 'NIEJEDNOZNACZNA', trackingNumber: null, externalRef: null })
    expect(await db.shipment.findUniqueOrThrow({ where: { id: glowna } })).toMatchObject({ state: 'UTWORZONA', trackingNumber: numerGlownej })
    expect(await db.orderEvent.count({ where: { orderId: id, kind: PRZESYLKA_DODATKOWA } })).toBe(0)
    // identyfikator głównej u przewoźnika (nie tylko numer nadania) też należy do innej paczki
    const g = await db.shipment.findUniqueOrThrow({ where: { id: glowna } })
    if (g.externalRef && g.externalRef !== numerGlownej) expect((await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: g.externalRef }, { userId: 'u-test', deps: deps() })).wynik).toBe('ODMOWA')
    expect((await bramkaDodatkowej(db, id, deps()))!.doSprawdzenia).toMatchObject({ shipmentId: s.id, rozstrzygalna: true })
  })

  it('„Rozstrzygnij ręcznie”: numer anulowanej dosyłki innego zamówienia = odmowa z numerem tamtego zamówienia', async () => {
    const inne = await zGlowna()
    expect((await dodaj(inne.id)).wynik).toBe('UTWORZONA')
    const d = await db.shipment.findFirstOrThrow({ where: { orderId: inne.id, extraNo: 1 } })
    await db.shipment.update({ where: { id: d.id }, data: { state: 'ANULOWANA' } })
    const { s } = await zNiejasna()
    const r = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: d.trackingNumber! }, { userId: 'u-test', deps: deps() })
    const zew = (await db.order.findUniqueOrThrow({ where: { id: inne.id } })).externalId
    expect(r).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringContaining(`dodatkowej przesyłki nr 1 (anulowanej) zamówienia ${zew}`) })
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('NIEJEDNOZNACZNA')
  })

  it('„Sprawdź u przewoźnika” przy niejasnej dosyłce nie wysyła drugiego zamówienia i zostawia wyjście ręczne', async () => {
    const { id, s } = await zNiejasna()
    const n = utworzonych()
    expect((await sprawdzPrzesylke(db, s.id, { userId: 'u-test', deps: deps() })).wynik).toBe('NADAL_NIEJASNE')
    expect(utworzonych()).toBe(n)
    expect((await bramkaDodatkowej(db, id, deps()))!.doSprawdzenia).toMatchObject({ rozstrzygalna: true })
  })

  it('odmowa po zmianie stanu (numer z okna już anulowany): bramka podaje nowy numer, więc ponowny odczyt okna nie zostaje przy starym', async () => {
    const z = await zGlowna()
    expect((await dodaj(z.id)).wynik).toBe('UTWORZONA')
    const d1 = await db.shipment.findFirstOrThrow({ where: { orderId: z.id, extraNo: 1 } })
    await db.shipment.update({ where: { id: d1.id }, data: { state: 'ANULOWANA' } })
    const stary = await dodaj(z.id, { numer: 1 })
    expect(stary.wynik).toBe('ODMOWA')
    expect((await bramkaDodatkowej(db, z.id, deps()))!.nastepnyNumer).toBe(2)
  })
})

describe('waga domyślna z ustawień przewoźnika (INFO)', () => {
  it('nie wymaga potwierdzenia: dosyłka bez zaznaczonej wagi powstaje jak główna przesyłka', async () => {
    const z = await zGlowna()
    const n = utworzonych()
    // KONFIG ma defaultWeightKg, produkt bez wagi: `waga_domyslna` jest INFO, człowiek jej nie zaznacza w oknie
    const w = await dodaj(z.id, { potwierdzoneOstrzezenia: ['gabaryt_podpowiedz'] })
    expect(w).toMatchObject({ wynik: 'UTWORZONA', istniala: false })
    expect(utworzonych()).toBe(n + 1)
  })
})

describe('wyłącznik funkcji firmy', () => {
  it('domyślnie wyłączona: bramka i „Dodaj przesyłkę” odmawiają bez przewoźnika i bez wiersza; po włączeniu jak zwykle', async () => {
    const z = await zGlowna('WYSLANE')
    const zlec = await zlecenie(z.id)
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { nadawca: NADAWCA_TESTOWY } } })
    const n = utworzonych()
    expect((await bramkaDodatkowej(db, z.id, deps()))!.powod).toBe(KOMUNIKAT_DODATKOWA_WYLACZONA)
    expect(await utworzDodatkowa(db, zlec, deps())).toEqual({ wynik: 'ODMOWA', powod: KOMUNIKAT_DODATKOWA_WYLACZONA })
    expect(utworzonych()).toBe(n)
    expect(await db.shipment.count({ where: { orderId: z.id, extraNo: { gte: 1 } } })).toBe(0)
    await zapiszAutomatyWysylki(db, { wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: true, dodatkowaPrzesylka: true }, 'u-admin')
    expect((await bramkaDodatkowej(db, z.id, deps()))!.powod).toBeNull()
    expect((await utworzDodatkowa(db, zlec, deps())).wynik).toBe('UTWORZONA')
  })

  it('wyłączenie po niejasnej dosyłce: okno dalej ma „Sprawdź u przewoźnika” i „Rozstrzygnij ręcznie”, nowej dosyłki nie da się dodać', async () => {
    const z = await zGlowna('WYSLANE')
    bc.awarie['createOrderV2.json'] = ['zgubiona']
    expect((await dodaj(z.id)).wynik).toBe('NIEJEDNOZNACZNA')
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: z.id, extraNo: 1 } })
    const uPrzewoznika = bc.zamowienia.at(-1)!
    await zapiszAutomatyWysylki(db, { wyslanePoPrzyjezdzie: true, sledzenie: true, anulowanieWKanale: true, dodatkowaPrzesylka: false }, 'u-admin')
    expect(await dodatkowaDoWyjasnienia(db, z.id)).toBe(true)
    const b = (await bramkaDodatkowej(db, z.id, deps()))!
    expect(b.powod).toMatch(/Rozstrzygnij ręcznie/)
    expect(b.doSprawdzenia).toMatchObject({ shipmentId: s.id, numer: 1, referencja: s.reference, rozstrzygalna: true })
    // nowa dosyłka zablokowana (zarówno niejasna, jak i wyłącznik), bez przewoźnika i bez wiersza
    const n = utworzonych()
    expect(await utworzDodatkowa(db, { ...(await zlecenie(z.id)), numer: 2, regulaId: s.extraRuleId! }, deps())).toMatchObject({ wynik: 'ODMOWA' })
    expect(utworzonych()).toBe(n)
    expect(await db.shipment.count({ where: { orderId: z.id, extraNo: 2 } })).toBe(0)
    // „Sprawdź” i „Rozstrzygnij ręcznie” działają po wyłączeniu
    expect((await sprawdzPrzesylke(db, s.id, { userId: 'u-test', deps: deps() })).wynik).toBe('NADAL_NIEJASNE')
    const r = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: uPrzewoznika.waybill_no }, { userId: 'u-test', deps: deps() })
    expect(r.wynik).toBe('UTWORZONA')
    expect(utworzonych()).toBe(n)
    // po wyjaśnieniu: okno wraca do komunikatu wyłączonej funkcji
    expect(await dodatkowaDoWyjasnienia(db, z.id)).toBe(false)
    expect(await bramkaDodatkowej(db, z.id, deps())).toMatchObject({ powod: KOMUNIKAT_DODATKOWA_WYLACZONA, doSprawdzenia: null })
  })
})

describe('lista zamówień', () => {
  const wiersz = async (id: string) => (await stronaListy(db, filtryZ({ widok: 'wszystkie' }), { sort: SORT_DOMYSLNY, pomin: 0, ile: 50 })).wiersze.find((w) => w.id === id)!
  it('przesyłka zamówienia na liście to główna, także gdy później dodano dosyłkę i gdy dosyłka skończyła się błędem', async () => {
    const z = await zGlowna('WYSLANE')
    expect((await wiersz(z.id)).shipment).toMatchObject({ state: 'UTWORZONA', trackingNumber: z.numerGlownej })
    expect((await dodaj(z.id)).wynik).toBe('UTWORZONA')
    const d = await db.shipment.findFirstOrThrow({ where: { orderId: z.id, extraNo: 1 } })
    expect(d.trackingNumber).not.toBe(z.numerGlownej)
    expect((await wiersz(z.id)).shipment).toMatchObject({ state: 'UTWORZONA', trackingNumber: z.numerGlownej })
    // dosyłka w błędzie (np. odrzucona przez przewoźnika): kropka i numer na liście dalej z głównej
    await db.shipment.update({ where: { id: d.id }, data: { state: 'BLAD', trackingNumber: null, createdAt: new Date(Date.now() + 60_000) } })
    expect((await wiersz(z.id)).shipment).toMatchObject({ state: 'UTWORZONA', trackingNumber: z.numerGlownej })
  })
})

describe('bramki i izolacja', () => {
  it('bez utworzonej głównej przesyłki: odmowa', async () => {
    const z = await zGlowna('SPAKOWANE')
    await db.shipment.update({ where: { id: z.glowna }, data: { state: 'ANULOWANA' } })
    expect((await bramkaDodatkowej(db, z.id, deps()))!.powod).toMatch(/Najpierw utwórz główną przesyłkę/)
    expect(await dodaj(z.id)).toMatchObject({ wynik: 'ODMOWA' })
  })

  it('firma B nie widzi zamówienia firmy A ani jej reguł przewoźnika: odmowa bez przewoźnika', async () => {
    const z = await zGlowna()
    const zl = await zlecenie(z.id)
    const n = utworzonych()
    expect(await bramkaDodatkowej(dbB, z.id, deps())).toBeNull()
    expect(await utworzDodatkowa(dbB, zl, deps())).toMatchObject({ wynik: 'ODMOWA', powod: 'Nie ma takiego zamówienia.' })
    expect(utworzonych()).toBe(n)
    expect(await dbB.shipment.count()).toBe(0)
  })
})

describe('druk, akcje i moduł przesyłki przy głównej i dosyłce', () => {
  it('etykieta zamówienia, widok przycisków i „ostatnia przesyłka” to główna; adapter dosyłki z jej reguły', async () => {
    const z = await zGlowna('DO_WYSLANIA')
    expect((await dodaj(z.id)).wynik).toBe('UTWORZONA')
    const d = await db.shipment.findFirstOrThrow({ where: { orderId: z.id, extraNo: 1 } })
    // dosyłka utworzona później: główna i tak zostaje przesyłką zamówienia
    const e = await etykietaPrzesylki(db, z.id, ENV)
    expect(e).not.toBeNull()
    expect((await widokPrzesylki(db, z.id))!.id).toBe(z.glowna)
    expect((await adapterDlaPrzesylki(db, d, deps())).manifest.adapterKey).toBe('basecourier.zapis.v1')
    // reguła dosyłki usunięta: jasny błąd zamiast modułu z reguły zamówienia
    await db.shipment.update({ where: { id: d.id }, data: { extraRuleId: 'nie-ma-takiej' } })
    await expect(adapterDlaPrzesylki(db, { ...d, extraRuleId: 'nie-ma-takiej' }, deps())).rejects.toThrow(/Nie ma już reguły przewoźnika/)
    // karta: główna na górze, dosyłka pod nią z rodzajem, powodem i kosztem
    const droga = await drogaPaczek(db, z.id)
    expect(droga.map((p) => p.dodatkowa?.rodzaj ?? 'główna')).toEqual(['główna', 'Dosyłka'])
    expect(droga[1]!.dodatkowa).toMatchObject({ numer: 1, powod: 'reklamacja: brak jednego produktu', kosztNetto: 14.5 })
    // lista „Przesyłki”: dopisek przy dosyłce
    const lista = await stronaPrzesylek(db, filtryPrzesylekZ({}), { sort: SORT_PRZESYLEK_DOMYSLNY, pomin: 0, ile: 50 })
    expect(lista.wiersze.map((w) => w.dodatkowa).sort()).toEqual(['Dosyłka nr 1', null].sort())
  })
})

describe('raport dodatkowych przesyłek', () => {
  it('liczba i koszt netto wg rodzaju, liczba bez kosztu, bez anulowanych', async () => {
    const z = await zGlowna()
    expect((await dodaj(z.id)).wynik).toBe('UTWORZONA')
    expect((await dodaj(z.id, { rodzaj: 'DOSYLKA', koszt: '10' })).wynik).toBe('UTWORZONA')
    expect((await dodaj(z.id, { rodzaj: 'ZASTEPCZA', koszt: '' })).wynik).toBe('UTWORZONA')
    expect((await dodaj(z.id, { rodzaj: 'DODATKOWA', koszt: '99,99' })).wynik).toBe('UTWORZONA')
    await db.shipment.updateMany({ where: { orderId: z.id, extraNo: 4 }, data: { state: 'ANULOWANA' } })
    const r = await raportDodatkowych(db, '2020-01-01', '2099-12-31')
    expect(r.rodzaje).toEqual([
      { rodzaj: 'DOSYLKA', nazwa: 'Dosyłka', liczba: 2, kosztNetto: 24.5, bezKosztu: 0 },
      { rodzaj: 'ZASTEPCZA', nazwa: 'Paczka zastępcza', liczba: 1, kosztNetto: 0, bezKosztu: 1 },
    ])
    expect(r.razem).toEqual({ liczba: 3, kosztNetto: 24.5, bezKosztu: 1 })
    // firma B: pusto
    expect((await raportDodatkowych(dbB, '2020-01-01', '2099-12-31')).razem.liczba).toBe(0)
  })
})

describe('indeksy po migracji', () => {
  it('druga aktywna GŁÓWNA przesyłka paczki nadal odrzucana; dodatkowa obok głównej przechodzi; ten sam numer dodatkowej drugi raz nie', async () => {
    const z = await zGlowna()
    const baza = { orderId: z.id, packageNo: 1, state: 'UTWORZONA' as const, adapterKey: 'basecourier.zapis.v1', carrier: 'PACZKOMATY' as const }
    await expect(db.shipment.create({ data: { ...baza, reference: 'idx-glowna-2' } })).rejects.toMatchObject({ code: 'P2002' })
    await db.shipment.create({ data: { ...baza, reference: 'idx-d-1', extraNo: 1, extraKind: 'DOSYLKA', extraReason: 'reklamacja testowa' } })
    await expect(db.shipment.create({ data: { ...baza, state: 'ANULOWANA', reference: 'idx-d-1b', extraNo: 1, extraKind: 'DOSYLKA', extraReason: 'reklamacja testowa' } })).rejects.toMatchObject({ code: 'P2002' })
    // warunek pól: dodatkowa bez powodu albo główna z rodzajem = odmowa bazy
    await expect(db.shipment.create({ data: { ...baza, reference: 'idx-d-2', extraNo: 2, extraKind: 'DOSYLKA' } })).rejects.toThrow()
    await expect(db.shipment.create({ data: { ...baza, state: 'ANULOWANA', reference: 'idx-g-x', extraKind: 'DOSYLKA' } })).rejects.toThrow()
    // kilka historycznych (anulowanych) głównych na jedno zamówienie: dozwolone jak przed migracją
    await db.shipment.createMany({ data: [1, 2, 3].map((i) => ({ ...baza, state: 'ANULOWANA' as const, reference: `idx-hist-${i}` })) })
    expect(await db.shipment.count({ where: { orderId: z.id, extraNo: 0 } })).toBe(4)
  })
})
