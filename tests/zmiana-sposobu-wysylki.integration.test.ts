// Zmiana sposobu wysyłki na karcie zamówienia przed nadaniem (np. Paczkomat InPost → kurier DPD) i nadanie nową usługą
// na atrapie DPDServices. Bramki: tryb „Tylko podgląd”, przesyłka już utworzona, status, pobranie, punkt i adres,
// Allegro. Ślad w historii bez danych osobowych; kolejna rewizja z kanału wyboru nie cofa. Dane wyłącznie fikcyjne,
// zero połączeń z przewoźnikami.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberRole, PrismaClient } from '@prisma/client'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { ODMOWA_CIEN } from '@/lib/karta/bramka'
import { daneKlienta } from '@/lib/klienci/odczyt'
import type { PoprawkaDostawy } from '@/lib/klienci/poprawka'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { changeLineQty, splitOrder } from '@/lib/rdzen/edycja'
import { shipLater } from '@/lib/rdzen/brakuje'
import { lockOrder } from '@/lib/rdzen/przejscia'
import { advisoryLock, runTx } from '@/lib/rdzen/stan'
import { bramkaNadania, utworzPrzesylke, type DepsNadania } from '@/lib/wysylka/nadanie'
import { stanZmianySposobu, zmienSposobWysylki } from '@/lib/wysylka/zmiana-sposobu'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, dpdAtrapa, NADAWCA_TESTOWY } from './dpd-atrapa'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
})

const NAZWISKO = 'Ewa Fikcyjna'
const ULICA = 'ul. Atrapowa'
const TELEFON = '+48 511 222 444'
const PACZKOMAT = 'TST01M'
const ODBIORCA_PACZKOMAT: OrderRecipient = {
  dostawa: { imieNazwisko: NAZWISKO, firma: null, ulica: null, numerDomu: null, numerLokalu: null, kodPocztowy: null, miasto: null, kraj: 'PL', telefon: TELEFON, email: 'ewa@example.test' },
  punktOdbioru: { kod: PACZKOMAT, nazwa: null },
  faktura: null,
  problemy: [],
}
const ENV = { EKRANY_PRACA: '1', CUSTOMER_DATA_KEYS: `1:${'4'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'd'.repeat(64), DPD_LOGIN, DPD_PASSWORD }
const KONFIG_DPD = { baseUrl: DPD_DEMO, payerFid: DPD_FID, zapisWlaczony: true, defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20, defaultWeightKg: 1 }
const POTWIERDZONE = ['waga_domyslna', 'gabaryt_podpowiedz']
const ADRES_DPD: PoprawkaDostawy = { imieNazwisko: NAZWISKO, firma: null, ulica: ULICA, numerDomu: '7', numerLokalu: null, kodPocztowy: '60-003', miasto: 'Poznań', telefon: TELEFON, punkt: null }

let atrapa: ReturnType<typeof dpdAtrapa>
const deps = (): DepsNadania => ({ fetch: atrapa.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true } })

async function osoba(email: string, role: MemberRole = 'WLASCICIEL'): Promise<string> {
  const u = await createUserWithHash(sys, { email, name: email, passwordHash: 'x' })
  await grantMembership(sys, { email, organizationId: ORG_A, role })
  return u.id
}

/** Firma: DPD bezpośrednio z zapisem, konto WOO/sd i Allegro w PRACA (albo w podglądzie). */
async function firma(o: { praca?: boolean } = {}): Promise<void> {
  await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: KONFIG_DPD } })
  await db.channelConfig.updateMany({ where: { OR: [{ channel: 'WOO', channelAccountId: 'sd' }, { channel: 'ALLEGRO' }] }, data: { statusMode: o.praca === false ? 'CIEN' : 'PRACA' } })
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: { nadawca: NADAWCA_TESTOWY } } })
}

async function zamowienie(o: { deliveryMethod?: string; paymentState?: 'PAID' | 'COD'; paymentMethod?: string; channel?: 'WOO_SD' | 'ALLEGRO'; odbiorca?: OrderRecipient; externalId?: string } = {}): Promise<string> {
  const pid = await product(db, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const r = await ingestOrder(
    db,
    order([{ productId: pid, qty: 1, unitPriceGross: 30 }], {
      deliveryMethod: o.deliveryMethod ?? 'Paczkomaty InPost',
      paymentState: o.paymentState ?? 'PAID',
      paymentMethod: o.paymentMethod ?? 'Przelew',
      ...(o.channel ? { channel: o.channel } : {}),
      ...(o.externalId ? { externalId: o.externalId } : {}),
    }),
    { now: T0 },
  )
  await zapiszRekordKlienta(db, r.orderId!, rekordZOdbiorcy(o.odbiorca ?? ODBIORCA_PACZKOMAT), { source: 'KANAL', fetchedAt: T0, env: ENV })
  return r.orderId!
}

const zmien = (orderId: string, klucz: string, dostawa: PoprawkaDostawy | null, actorId: string) => zmienSposobWysylki(db, orderId, { klucz, dostawa }, { actorId, env: ENV })
const rekord = async (orderId: string, actorId: string) => {
  const d = await daneKlienta(db, orderId, { actorId, zakres: 'PELNY', cel: 'PODGLAD', env: ENV })
  return d.stan === 'PELNY' ? d.rekord : null
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  atrapa = dpdAtrapa()
  vi.stubEnv('CUSTOMER_DATA_KEYS', ENV.CUSTOMER_DATA_KEYS)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Paczkomat InPost → kurier DPD przed nadaniem', () => {
  it('zmiana zapisuje przewoźnika i moduł, czyści punkt paczkomatu, wpis w historii bez danych osobowych; nadanie idzie kurierem DPD pod adres', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie()
    expect((await db.order.findUniqueOrThrow({ where: { id } })).carrier).toBe('PACZKOMATY')

    const w = await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)
    expect(w).toMatchObject({ wynik: 'ZAPISANO' })

    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o).toMatchObject({ carrier: 'DPD', shippingModule: 'DPD_BEZPOSREDNIO', deliveryMethod: 'Paczkomaty InPost' })
    expect(flagsOf(o).przewoznikRecznie).toBe(true)
    const r = await rekord(id, uid)
    expect(r!.punktOdbioru).toBeNull()
    expect(r!.dostawa).toMatchObject({ ulica: ULICA, kodPocztowy: '60-003', miasto: 'Poznań' })

    const ev = await db.orderEvent.findMany({ where: { orderId: id, kind: 'SPOSOB_WYSYLKI_ZMIENIONY' } })
    expect(ev).toHaveLength(1)
    expect(ev[0]!.actorId).toBe(`user:${uid}`)
    expect(ev[0]!.data).toMatchObject({ z: 'PACZKOMATY', na: 'DPD', naModul: 'DPD_BEZPOSREDNIO' })
    const tekst = JSON.stringify(ev[0]!.data)
    for (const x of [NAZWISKO, ULICA, TELEFON, PACZKOMAT, '60-003']) expect(tekst).not.toContain(x)

    expect((await bramkaNadania(db, id, deps()))!.powod).toBeNull()
    const n = await utworzPrzesylke(db, { orderId: id, potwierdzoneOstrzezenia: POTWIERDZONE, userId: uid }, deps())
    expect(n).toMatchObject({ wynik: 'UTWORZONA' })
    const body = JSON.stringify(atrapa.calls[0]!.body)
    expect(body).not.toContain('DPD_PICKUP')
    expect(body).not.toContain(PACZKOMAT)
    expect((await db.shipment.findFirstOrThrow({ where: { orderId: id } })).carrier).toBe('DPD')
  })

  it('kolejna rewizja zamówienia z kanału nie cofa wyboru (przewoźnik, moduł i znacznik zostają)', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie({ externalId: 'zm-1' })
    await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)
    const pid = (await db.orderLine.findFirstOrThrow({ where: { orderId: id } })).productId!
    await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { externalId: 'zm-1', externalRevision: 'r2', deliveryMethod: 'Paczkomaty InPost', paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o).toMatchObject({ carrier: 'DPD', shippingModule: 'DPD_BEZPOSREDNIO' })
    expect(flagsOf(o).przewoznikRecznie).toBe(true)
  })

  it('podział zamówienia po zmianie: druga paczka dziedziczy wybór (nadanie bez „reguły zmieniły się”)', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const pid = await product(db, 'HERB-PODZIAL', 50)
    const r = await ingestOrder(db, order([{ productId: pid, qty: 2, unitPriceGross: 30 }], { deliveryMethod: 'Paczkomaty InPost', paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })
    const id = r.orderId!
    await zapiszRekordKlienta(db, id, rekordZOdbiorcy(ODBIORCA_PACZKOMAT), { source: 'KANAL', fetchedAt: T0, env: ENV })
    await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: id } })
    const { childOrderId } = await splitOrder(db, id, { [line.id]: 1 }, { actorId: uid })
    const child = await db.order.findUniqueOrThrow({ where: { id: childOrderId } })
    expect(child.carrier).toBe('DPD')
    expect(flagsOf(child).przewoznikRecznie).toBe(true)
    // karta każdej paczki mówi, że zmiana dotyczy tylko jej (pozostałe paczki zmienia się na ich kartach)
    expect((await stanZmianySposobu(db, id, ENV))!.uwagi.join(' ')).toMatch(/tylko tej paczki.*\(1\)/)
    expect((await stanZmianySposobu(db, childOrderId, ENV))!.uwagi.join(' ')).toMatch(/tylko tej paczki.*\(1\)/)
  })
})

describe('odmowy bez zmian w zamówieniu', () => {
  const bezZmian = async (id: string) => {
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o.carrier).toBe('PACZKOMATY')
    expect(flagsOf(o).przewoznikRecznie).toBeUndefined()
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'SPOSOB_WYSYLKI_ZMIENIONY' } })).toBe(0)
  }

  it('konto w trybie „Tylko podgląd”: odmowa z powodem, stan karty mówi to samo', async () => {
    await firma({ praca: false })
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie()
    expect(await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)).toMatchObject({ wynik: 'ODMOWA', powod: ODMOWA_CIEN })
    expect((await stanZmianySposobu(db, id, ENV))!.powod).toBe(ODMOWA_CIEN)
    await bezZmian(id)
  })

  it('z paczkomatu na kuriera bez adresu: odmowa „adres”', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie()
    expect(await zmien(id, 'DPD:DPD_BEZPOSREDNIO', { ...ADRES_DPD, ulica: null, numerDomu: null, kodPocztowy: null, miasto: null }, uid)).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringMatching(/adres/i) })
    await bezZmian(id)
    expect((await rekord(id, uid))!.punktOdbioru).toMatchObject({ kod: PACZKOMAT })
  })

  it('przesyłka już utworzona: odmowa, zmiana dopiero po anulowaniu przesyłki', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie()
    await db.shipment.create({ data: { orderId: id, packageNo: 1, reference: 'ref-zm-1', state: 'UTWORZONA', adapterKey: 'basecourier.v1', carrier: 'PACZKOMATY', requestedBy: 'u', trackingNumber: 'T1' } })
    expect(await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringMatching(/anuluj/i) })
    expect((await stanZmianySposobu(db, id, ENV))!.powod).toMatch(/anuluj/i)
    await bezZmian(id)
  })

  it('pobranie na usługę bez pobrania (Orlen Paczka): odmowa z komunikatem', async () => {
    await firma()
    await db.carrierRule.create({ data: { priority: 900, carrier: 'ORLEN_PACZKA', shippingModule: 'ORLEN_PACZKA', adapterKey: 'orlenpaczka.v1' } })
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie({ paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    expect(await zmien(id, 'ORLEN_PACZKA:ORLEN_PACZKA', { ...ADRES_DPD, punkt: 'WS-116263-C3-01' }, uid)).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringMatching(/pobrani/i) })
    await bezZmian(id)
  })

  it('usługa spoza reguł firmy albo Wysyłam z Allegro dla zamówienia ze sklepu: odmowa', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie()
    expect(await zmien(id, 'GLS:GLS_ADE', ADRES_DPD, uid)).toMatchObject({ wynik: 'ODMOWA' })
    expect(await zmien(id, 'ALLEGRO:WYSYLAM_Z_ALLEGRO', null, uid)).toMatchObject({ wynik: 'ODMOWA' })
    await bezZmian(id)
  })

  it('osoba bez uprawnienia do pełnych danych klienta: odmowa', async () => {
    await firma()
    const uid = await osoba('magazyn@example.test', 'MAGAZYN')
    const id = await zamowienie()
    expect(await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)).toMatchObject({ wynik: 'ODMOWA' })
    await bezZmian(id)
  })
})

describe('Allegro', () => {
  it('zamówienie z Allegro z Wysyłam z Allegro: stan karty opisuje ograniczenie; nadanie własnym DPD działa i mówi o koszcie', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie({ channel: 'ALLEGRO', deliveryMethod: 'Allegro Paczkomaty InPost' })
    const s = (await stanZmianySposobu(db, id, ENV))!
    expect(s.obecna).toBe('ALLEGRO:WYSYLAM_Z_ALLEGRO')
    expect(s.uwagi.join(' ')).toMatch(/Allegro/)
    const w = await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)
    expect(w).toMatchObject({ wynik: 'ZAPISANO', info: expect.stringMatching(/koszt/i) })
    expect((await db.order.findUniqueOrThrow({ where: { id } })).carrier).toBe('DPD')
  })
})

describe('stan bloku na karcie', () => {
  it('lista usług z reguł firmy z obecną, rodzajem dostawy i pobraniem; ta sama usługa = bez zmian', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie()
    const s = (await stanZmianySposobu(db, id, ENV))!
    expect(s.powod).toBeNull()
    expect(s.obecna).toBe('PACZKOMATY:BASE_COURIER')
    expect(s.opcje.map((o) => o.klucz)).toEqual(expect.arrayContaining(['PACZKOMATY:BASE_COURIER', 'DPD:DPD_BEZPOSREDNIO', 'OSOBISTY:BRAK']))
    expect(s.opcje.map((o) => o.klucz)).not.toContain('ALLEGRO:WYSYLAM_Z_ALLEGRO')
    expect(await zmien(id, 'PACZKOMATY:BASE_COURIER', { ...ADRES_DPD, punkt: PACZKOMAT }, uid)).toEqual({ wynik: 'BEZ_ZMIAN' })
    expect(s.ukryj).toBe(false)
  })

  it('zamówienie wysłane albo anulowane: blok ukryty; w trybie „Tylko podgląd” widoczny z powodem', async () => {
    await firma()
    const id = await zamowienie()
    await db.order.update({ where: { id }, data: { status: 'WYSLANE' } })
    expect((await stanZmianySposobu(db, id, ENV))!).toMatchObject({ ukryj: true, powod: expect.any(String) })
    await firma({ praca: false })
    const id2 = await zamowienie()
    expect((await stanZmianySposobu(db, id2, ENV))!).toMatchObject({ ukryj: false, powod: ODMOWA_CIEN })
  })
})

// ─── Runda poprawek po przeglądzie (brakujące gałęzie) ───────────────────────────────────

describe('wyścigi i znacznik wyboru', () => {
  it('zmiana na odbiór osobisty między bramką a rezerwacją przesyłki: odmowa, nic nie poszło do przewoźnika', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie()
    expect(await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)).toMatchObject({ wynik: 'ZAPISANO' })
    let wstrzyknieta: unknown = null
    const n = await utworzPrzesylke(
      db,
      { orderId: id, potwierdzoneOstrzezenia: POTWIERDZONE, userId: uid },
      {
        ...deps(),
        // druga osoba zmienia sposób wysyłki po bramce i odczycie odbiorcy, przed rezerwacją (dane odbiorcy bez zmian)
        poOdczycieOdbiorcy: async () => {
          wstrzyknieta = await zmien(id, 'OSOBISTY:BRAK', null, uid)
        },
      },
    )
    expect(wstrzyknieta).toMatchObject({ wynik: 'ZAPISANO' })
    expect(n).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringMatching(/Sposób wysyłki zmienił się w trakcie tworzenia przesyłki/) })
    expect(atrapa.calls).toHaveLength(0)
    expect(await db.shipment.count({ where: { orderId: id } })).toBe(0)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).carrier).toBe('OSOBISTY')
  })

  it('zgubiony znacznik przy tym samym sposobie wysyłki: ponowna zmiana go dopisuje zamiast „bez zmian”', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie()
    await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)
    await db.order.update({ where: { id }, data: { flags: {} } })
    expect((await bramkaNadania(db, id, deps()))!.powod).toMatch(/Reguły przewoźnika zmieniły się/)
    expect(await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)).toMatchObject({ wynik: 'ZAPISANO' })
    expect(flagsOf(await db.order.findUniqueOrThrow({ where: { id } })).przewoznikRecznie).toBe(true)
    expect((await bramkaNadania(db, id, deps()))!.powod).toBeNull()
  })

  it('zmiana czeka na blokadę zamówienia, więc równoległy zapis flag nie gubi znacznika', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie()
    let zmiana: ReturnType<typeof zmien> | null = null
    await db.$transaction(
      async (tx) => {
        const o = await lockOrder(tx, id)
        zmiana = zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)
        await new Promise((r) => setTimeout(r, 1500))
        // inna transakcja pod blokadą zamówienia zapisuje flagi z odczytu sprzed zmiany (odczyt–modyfikacja–zapis)
        await tx.order.update({ where: { id }, data: { flags: { ...(flagsOf(o) as object), testInnaFlaga: true } } })
      },
      { timeout: 30_000 },
    )
    expect(await zmiana!).toMatchObject({ wynik: 'ZAPISANO' })
    const f = flagsOf(await db.order.findUniqueOrThrow({ where: { id } })) as Record<string, unknown>
    expect(f['przewoznikRecznie']).toBe(true)
    expect(f['testInnaFlaga']).toBe(true)
  })
})

describe('status firmy przypisany wprost', () => {
  it('status firmy z listą przewoźników bez nowego przewoźnika: przypisanie zdjęte; ogólny i obejmujący nowego zostaje', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    await db.orderStatusDef.create({ data: { key: 'DR_PACZKOMATY', name: 'Do realizacji Paczkomaty', sortOrder: 10, baseStatus: 'DO_REALIZACJI', carriers: ['PACZKOMATY'] } })
    await db.orderStatusDef.create({ data: { key: 'DR_OBA', name: 'Do realizacji InPost i DPD', sortOrder: 11, baseStatus: 'DO_REALIZACJI', carriers: ['PACZKOMATY', 'DPD'] } })
    await db.orderStatusDef.create({ data: { key: 'DR_PILNE', name: 'Do realizacji pilne', sortOrder: 12, baseStatus: 'DO_REALIZACJI', carriers: [] } })
    for (const [klucz, po] of [
      ['DR_PACZKOMATY', null],
      ['DR_OBA', 'DR_OBA'],
      ['DR_PILNE', 'DR_PILNE'],
    ] as const) {
      const id = await zamowienie()
      expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_REALIZACJI')
      await db.order.update({ where: { id }, data: { companyStatus: klucz } })
      expect(await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)).toMatchObject({ wynik: 'ZAPISANO' })
      expect((await db.order.findUniqueOrThrow({ where: { id } })).companyStatus).toBe(po)
    }
  })
})

describe('gałęzie bez zmiany danych odbiorcy', () => {
  it('odbiór osobisty: zapis bez ruszania danych odbiorcy (punkt zostaje), znacznik i wpis w historii; przy pobraniu zdanie o płatności przy odbiorze', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie({ paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    const w = await zmien(id, 'OSOBISTY:BRAK', null, uid)
    expect(w).toMatchObject({ wynik: 'ZAPISANO', info: expect.stringMatching(/przy odbiorze/i) })
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o).toMatchObject({ carrier: 'OSOBISTY', shippingModule: 'BRAK' })
    expect(flagsOf(o).przewoznikRecznie).toBe(true)
    expect((await rekord(id, uid))!.punktOdbioru).toMatchObject({ kod: PACZKOMAT })
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'SPOSOB_WYSYLKI_ZMIENIONY' } })).toBe(1)
  })

  it('Allegro: DPD i z powrotem na Wysyłam z Allegro; komunikat mówi, że Allegro nada na swoje dane odbiorcy', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie({ channel: 'ALLEGRO', deliveryMethod: 'Allegro Paczkomaty InPost' })
    expect(await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)).toMatchObject({ wynik: 'ZAPISANO' })
    const w = await zmien(id, 'ALLEGRO:WYSYLAM_Z_ALLEGRO', null, uid)
    expect(w).toMatchObject({ wynik: 'ZAPISANO', info: expect.stringMatching(/dane odbiorcy z zamówienia w Allegro/) })
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o).toMatchObject({ carrier: 'ALLEGRO', shippingModule: 'WYSYLAM_Z_ALLEGRO' })
    expect((await bramkaNadania(db, id, deps()))!.powod ?? '').not.toMatch(/Reguły przewoźnika zmieniły się/)
  })
})

describe('odmowy: statusy, inna firma', () => {
  it('statusy WYSLANE, ANULOWANE i DO_WYJASNIENIA: odmowa w rdzeniu, bez zapisu', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    for (const status of ['WYSLANE', 'ANULOWANE', 'DO_WYJASNIENIA'] as const) {
      const id = await zamowienie()
      await db.order.update({ where: { id }, data: { status } })
      expect(await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)).toMatchObject({ wynik: 'ODMOWA', powod: expect.any(String) })
      const o = await db.order.findUniqueOrThrow({ where: { id } })
      expect(o.carrier).toBe('PACZKOMATY')
      expect(flagsOf(o).przewoznikRecznie).toBeUndefined()
    }
  })

  it('zamówienie innej firmy: odmowa, zamówienie bez zmian', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie()
    const dbB = testDb({ organizationId: ORG_B })
    try {
      expect(await zmienSposobWysylki(dbB, id, { klucz: 'DPD:DPD_BEZPOSREDNIO', dostawa: ADRES_DPD }, { actorId: uid, env: ENV })).toMatchObject({ wynik: 'ODMOWA' })
    } finally {
      await dbB.$disconnect()
    }
    expect((await db.order.findUniqueOrThrow({ where: { id } })).carrier).toBe('PACZKOMATY')
  })
})

describe('paczki z podziału i dosłania', () => {
  it('dosłanie brakującej pozycji po zmianie dziedziczy wybór', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const jest = await product(db, 'HERB-JEST', 50)
    const brak = await product(db, 'HERB-BRAK', 0)
    const r = await ingestOrder(db, order([{ productId: jest, qty: 1 }, { productId: brak, qty: 1 }], { deliveryMethod: 'Paczkomaty InPost', paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })
    const id = r.orderId!
    await zapiszRekordKlienta(db, id, rekordZOdbiorcy(ODBIORCA_PACZKOMAT), { source: 'KANAL', fetchedAt: T0, env: ENV })
    expect(await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)).toMatchObject({ wynik: 'ZAPISANO' })
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: id, productId: brak } })
    const { childOrderId } = await shipLater(db, line.id, { actorId: uid })
    const child = await db.order.findUniqueOrThrow({ where: { id: childOrderId } })
    expect(child).toMatchObject({ carrier: 'DPD', shippingModule: 'DPD_BEZPOSREDNIO' })
    expect(flagsOf(child).przewoznikRecznie).toBe(true)
  })

  it('paczka wydzielona przed zmianą zostaje przy starym przewoźniku', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const pid = await product(db, 'HERB-PRZED', 50)
    const r = await ingestOrder(db, order([{ productId: pid, qty: 2 }], { deliveryMethod: 'Paczkomaty InPost', paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })
    const id = r.orderId!
    await zapiszRekordKlienta(db, id, rekordZOdbiorcy(ODBIORCA_PACZKOMAT), { source: 'KANAL', fetchedAt: T0, env: ENV })
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: id } })
    const { childOrderId } = await splitOrder(db, id, { [line.id]: 1 }, { actorId: uid })
    expect(await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)).toMatchObject({ wynik: 'ZAPISANO' })
    const child = await db.order.findUniqueOrThrow({ where: { id: childOrderId } })
    expect(child.carrier).toBe('PACZKOMATY')
    expect(flagsOf(child).przewoznikRecznie).toBeUndefined()
  })
})

describe('przesyłka z błędem u poprzedniego przewoźnika', () => {
  it('wiersz BLAD starego modułu: nadanie nowym przewoźnikiem jako pierwsza próba (licznik prób od 1), modułem nowego przewoźnika', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie()
    await db.shipment.create({ data: { orderId: id, packageNo: 1, reference: 'ref-zm-blad', state: 'BLAD', adapterKey: 'basecourier.v1', carrier: 'PACZKOMATY', requestedBy: 'u', attempt: 2, lastError: 'odmowa przewoźnika' } })
    expect(await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)).toMatchObject({ wynik: 'ZAPISANO' })
    const n = await utworzPrzesylke(db, { orderId: id, potwierdzoneOstrzezenia: POTWIERDZONE, userId: uid }, deps())
    expect(n).toMatchObject({ wynik: 'UTWORZONA' })
    const s = await db.shipment.findMany({ where: { orderId: id } })
    expect(s.map((x) => ({ state: x.state, adapterKey: x.adapterKey, carrier: x.carrier, attempt: x.attempt }))).toEqual([{ state: 'UTWORZONA', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', attempt: 1 }])
  })
})

// ─── zmiana pozycji i „Utwórz przesyłkę” pod tą samą blokadą przesyłki ──────────────

describe('zmiana pozycji w trakcie tworzenia przesyłki (E3)', () => {
  it('pozycje zmienione po odczycie przed bramką: nadanie odmawia, nic nie poszło do przewoźnika; ponowne kliknięcie tworzy przesyłkę z nową kwotą', async () => {
    await firma()
    const uid = await osoba('biuro@example.test')
    const id = await zamowienie()
    expect(await zmien(id, 'DPD:DPD_BEZPOSREDNIO', ADRES_DPD, uid)).toMatchObject({ wynik: 'ZAPISANO' })
    const [l] = await db.orderLine.findMany({ where: { orderId: id, removed: false } })
    let zmiana: unknown = null
    const n = await utworzPrzesylke(
      db,
      { orderId: id, potwierdzoneOstrzezenia: POTWIERDZONE, userId: uid },
      {
        ...deps(),
        // druga osoba zmienia ilość po odczycie parametrów przesyłki, przed rezerwacją wiersza
        poOdczycieOdbiorcy: async () => {
          zmiana = await changeLineQty(db, id, l!.id, 2)
        },
      },
    )
    expect(zmiana).not.toBeNull()
    expect(n).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringMatching(/Pozycje zamówienia zmieniły się w trakcie tworzenia przesyłki/) })
    expect(atrapa.calls).toHaveLength(0)
    expect(await db.shipment.count({ where: { orderId: id } })).toBe(0)
    expect(await utworzPrzesylke(db, { orderId: id, potwierdzoneOstrzezenia: POTWIERDZONE, userId: uid }, deps())).toMatchObject({ wynik: 'UTWORZONA' })
  })

  it('przesyłka TWORZENIE wstawiona pod blokadą przesyłki w trakcie zmiany pozycji (za pobraniem): zmiana czeka na blokadę i odmawia', async () => {
    await firma()
    const id = await zamowienie({ paymentState: 'COD', paymentMethod: 'Za pobraniem' })
    const [l] = await db.orderLine.findMany({ where: { orderId: id, removed: false } })
    let wziete!: () => void
    let pusc!: () => void
    const maBlokade = new Promise<void>((r) => (wziete = r))
    const koniec = new Promise<void>((r) => (pusc = r))
    const nadanie = runTx(db, async (tx) => {
      await advisoryLock(tx, `przesylka:${id}`)
      await tx.shipment.create({ data: { orderId: id, packageNo: 1, reference: 'ref-w1-wyscig', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', state: 'TWORZENIE', codAmount: 30 } })
      wziete()
      await koniec
    })
    await maBlokade
    const edycja = changeLineQty(db, id, l!.id, 2).then(
      () => 'ZAPISANO',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    await new Promise((r) => setTimeout(r, 400))
    pusc()
    await nadanie
    expect(await edycja).toMatch(/pobrani/)
    expect((await db.orderLine.findUniqueOrThrow({ where: { id: l!.id } })).qty).toBe(1)
  })
})
