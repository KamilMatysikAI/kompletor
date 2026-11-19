// przesyłki naprawdę — host `lib/wysylka/nadanie.ts` na atrapie DPDServices (tests/dpd-atrapa.ts) i bazie
// testowej. Bramki (cień, moduł tylko do podglądu, wyłącznik), jedna przesyłka na kliknięcie także równolegle, zgubiona
// odpowiedź = odszukanie po referencji (bez drugiej przesyłki), odmowa = ponowienie tą samą referencją, numer nadania
// i zdarzenie NUMER_NADANIA_GOTOWY, etykieta zaszyfrowana i prawdziwa w druku, atrapa tylko bez przesyłki, poprawka
// adresu z wpisem w dzienniku podglądów, izolacja firm. Dane wyłącznie fikcyjne, zero połączeń z DPD (także demo).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberRole, PrismaClient } from '@prisma/client'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { dziennikPodgladow } from '@/lib/klienci/odczyt'
import { daneDoPoprawki, poprawDostawe, PRZESYLKA_JEST } from '@/lib/klienci/poprawka'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { usunDaneKlientow } from '@/lib/klienci/retencja'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { etykietaZamowienia } from '@/lib/wysylka/etykieta-przewoznika'
import { bramkaDodatkowej, bramkaNadania, moznaPoprawicAdres, ROZSTRZYGNIECIE_AUDIT, rozstrzygnijRecznie, sprawdzPrzesylke, TWORZENIE_ZAWIESZONE_MS, utworzDodatkowa, utworzPrzesylke, widokPrzesylki, type DepsNadania } from '@/lib/wysylka/nadanie'
import { NUMER_NADANIA_GOTOWY } from '@/lib/wysylka/zdarzenia'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, DPD_WAYBILL, dpdAtrapa, json, NADAWCA_TESTOWY, type DpdReply } from './dpd-atrapa'
import { INPOST_ORG, INPOST_SANDBOX, INPOST_TOKEN, inpostAtrapa } from './inpost-atrapa'
import { order, product, seedBase, T0 } from './rdzen-fixtures'
import { pobierzEtykiete } from '@/lib/wysylka/nadanie'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const NAZWISKO = 'Anna Fikcyjna'
const ULICA = 'ul. Atrapowa'
const TELEFON = '+48 511 222 333'
const EMAIL = 'anna@example.test'
const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: NAZWISKO, firma: null, ulica: ULICA, numerDomu: '9', numerLokalu: null, kodPocztowy: '60-002', miasto: 'Poznań', kraj: 'PL', telefon: TELEFON, email: EMAIL },
  punktOdbioru: null,
  faktura: null,
  problemy: [],
}
const ENV = { EKRANY_PRACA: '1', CUSTOMER_DATA_KEYS: `1:${'3'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'c'.repeat(64), DPD_LOGIN, DPD_PASSWORD }
const KONFIG = { baseUrl: DPD_DEMO, payerFid: DPD_FID, zapisWlaczony: true, defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20, defaultWeightKg: 1 }
const POTWIERDZONE = ['waga_domyslna', 'gabaryt_podpowiedz']
const ETYKIETA = '%PDF-fikcyjna-etykieta'

let atrapa: ReturnType<typeof dpdAtrapa>
const deps = (): DepsNadania => ({ fetch: atrapa.fetchImpl, env: ENV, secrets: { env: ENV, envFallback: true } })
const numery = () => atrapa.calls.filter((c) => c.path.endsWith('/generatePackagesNumbers')).length

async function osoba(email: string, role: MemberRole, org = ORG_A): Promise<string> {
  const u = await createUserWithHash(sys, { email, name: email, passwordHash: 'x' })
  await grantMembership(sys, { email, organizationId: org, role })
  return u.id
}

/** Firma: DPD bezpośrednio z zapisem, konto WOO/sd w PRACA, nadawca w ustawieniach firmy. */
async function firma(c: PrismaClient = db, o: { praca?: boolean; config?: Record<string, unknown>; adapterKey?: string } = {}): Promise<void> {
  await c.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: o.adapterKey ?? 'dpd.services.zapis.v1', config: (o.config ?? KONFIG) as object } })
  await c.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: o.praca === false ? 'CIEN' : 'PRACA' } })
  const id = c === db ? ORG_A : ORG_B
  await sys.organization.update({ where: { id }, data: { settings: { nadawca: NADAWCA_TESTOWY } } })
}

async function zamowienie(c: PrismaClient = db, odbiorca: OrderRecipient = ODBIORCA): Promise<string> {
  const pid = await product(c, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const r = await ingestOrder(c, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: 'Kurier DPD', paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })
  await zapiszRekordKlienta(c, r.orderId!, rekordZOdbiorcy(odbiorca), { source: 'RECZNE', fetchedAt: T0, env: ENV })
  return r.orderId!
}

const utworz = (orderId: string, c: PrismaClient = db, userId = 'u-test') => utworzPrzesylke(c, { orderId, potwierdzoneOstrzezenia: POTWIERDZONE, userId }, deps())
const odpowiedzSzukania = (packages: unknown[]): DpdReply => json({ status: 'OK', documentData: Buffer.from('%PDF-x').toString('base64'), session: { packages } })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
  atrapa = dpdAtrapa()
  // druk (jak panel) czyta klucz danych klientów z env procesu
  vi.stubEnv('CUSTOMER_DATA_KEYS', ENV.CUSTOMER_DATA_KEYS)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('bramki: przycisk widoczny, z powodem, bez żądania do przewoźnika', () => {
  it('konto w cieniu: odmowa z powodem „Tylko podgląd”, zero żądań', async () => {
    await firma(db, { praca: false })
    const id = await zamowienie()
    expect((await bramkaNadania(db, id, deps()))!.powod).toMatch(/„Tylko podgląd”/)
    expect(await utworz(id)).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringMatching(/„Tylko podgląd”/) })
    expect(atrapa.calls).toEqual([])
  })

  it('moduł tylko do podglądu (dpd.services.v1) i wyłączony zapis: odmowa z powodem', async () => {
    await firma(db, { adapterKey: 'dpd.services.v1' })
    const id = await zamowienie()
    expect((await bramkaNadania(db, id, deps()))!.powod).toMatch(/tylko liczy przesyłkę/)
    await firma(db, { config: { ...KONFIG, zapisWlaczony: false } })
    expect((await bramkaNadania(db, id, deps()))!.powod).toMatch(/wyłączone w ustawieniach przewoźnika/)
    expect(await utworz(id)).toMatchObject({ wynik: 'ODMOWA' })
    expect(atrapa.calls).toEqual([])
  })

  it('wartości robocze bez potwierdzenia: odmowa z listą ostrzeżeń, zero żądań i zero wierszy', async () => {
    await firma()
    const id = await zamowienie()
    const w = await utworzPrzesylke(db, { orderId: id, userId: 'u' }, deps())
    expect(w).toMatchObject({ wynik: 'ODMOWA', doPotwierdzenia: expect.arrayContaining([expect.objectContaining({ kod: 'waga_domyslna' })]) })
    expect(atrapa.calls).toEqual([])
    expect(await db.shipment.count()).toBe(0)
  })
})

describe('utworzenie przesyłki', () => {
  it('numer nadania, etykieta zaszyfrowana, zdarzenie NUMER_NADANIA_GOTOWY, historia; bez danych klienta w jawnych kolumnach', async () => {
    await firma()
    const id = await zamowienie()
    const w = await utworz(id)
    expect(w).toMatchObject({ wynik: 'UTWORZONA', istniala: false })
    expect(atrapa.calls.map((c) => c.path)).toEqual(['/public/shipment/v1/generatePackagesNumbers', '/public/shipment/v1/generateSpedLabels'])
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(s).toMatchObject({ state: 'UTWORZONA', externalRef: DPD_WAYBILL, trackingNumber: DPD_WAYBILL, labelFormat: 'PDF', carrier: 'DPD', adapterKey: 'dpd.services.zapis.v1' })
    // referencja z hosta trafiła do DPD jako packages[].reference
    expect(atrapa.calls[0]!.body).toMatchObject({ packages: [{ reference: s.reference }] })
    const ev = await db.auditLog.findMany({ where: { entity: NUMER_NADANIA_GOTOWY } })
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ entityId: s.id, after: { shipmentId: s.id, orderId: id, trackingNumber: DPD_WAYBILL, carrier: 'DPD' } })
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'PRZESYLKA_UTWORZONA' } })).toBe(1)
    // jawne kolumny (bez szyfrogramu) bez danych odbiorcy; szyfrogram nie zawiera tekstu etykiety
    const { labelCiphertext, labelIv: _iv, labelAuthTag: _tag, ...jawne } = s
    const tekst = JSON.stringify(jawne)
    for (const x of [NAZWISKO, ULICA, TELEFON, EMAIL]) expect(tekst).not.toContain(x)
    expect(Buffer.from(labelCiphertext!).toString('utf8')).not.toContain('PDF-fikcyjna')
    expect((await widokPrzesylki(db, id))!).toMatchObject({ stan: 'UTWORZONA', numer: DPD_WAYBILL, etykieta: true })
    expect(await moznaPoprawicAdres(db, id)).toBe(false)
  })

  it('podwójne kliknięcie (równolegle i po kolei) = jedna przesyłka i jedno żądanie generatePackagesNumbers', async () => {
    await firma()
    const id = await zamowienie()
    const [a, b] = await Promise.all([utworz(id), utworz(id)])
    expect([a.wynik, b.wynik].sort()).toEqual(expect.arrayContaining(['UTWORZONA']))
    const c = await utworz(id)
    expect(c).toMatchObject({ wynik: 'UTWORZONA', istniala: true })
    expect(numery()).toBe(1)
    expect(await db.shipment.count({ where: { orderId: id } })).toBe(1)
  })

  it('zgubiona odpowiedź: odszukanie bez potwierdzenia = NIEJEDNOZNACZNA z alertem, kolejne kliknięcie nic nie wysyła; „Sprawdź” po potwierdzeniu = UTWORZONA', async () => {
    await firma()
    const id = await zamowienie()
    atrapa = dpdAtrapa([{ error: new TypeError('fetch failed') }, odpowiedzSzukania([])])
    const w = await utworz(id)
    expect(w.wynik).toBe('NIEJEDNOZNACZNA')
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(s.state).toBe('NIEJEDNOZNACZNA')
    expect(await db.alert.count({ where: { kind: 'PRZESYLKA_NIEJEDNOZNACZNA', closedAt: null } })).toBe(1)
    expect(numery()).toBe(1)
    expect((await utworz(id)).wynik).toBe('NIEJEDNOZNACZNA')
    expect(numery()).toBe(1)
    expect(await etykietaZamowienia.etykieta(db, id, T0).catch((e: Error) => e.message)).toMatch(/Sprawdź u przewoźnika/)

    atrapa = dpdAtrapa([odpowiedzSzukania([{ reference: s.reference, parcels: [{ waybill: DPD_WAYBILL }] }])])
    const r = await sprawdzPrzesylke(db, s.id, { userId: 'u', deps: deps() })
    expect(r.wynik).toBe('UTWORZONA')
    expect(numery()).toBe(0)
    expect(await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ state: 'UTWORZONA', trackingNumber: DPD_WAYBILL })
    expect(await db.alert.count({ where: { kind: 'PRZESYLKA_NIEJEDNOZNACZNA', closedAt: null } })).toBe(0)
  })

  it('odmowa DPD (400) = BLAD z powodem; ponowienie tą samą referencją, próba 2', async () => {
    await firma()
    const id = await zamowienie()
    atrapa = dpdAtrapa([{ status: 400, body: '{}' }])
    expect(await utworz(id)).toMatchObject({ wynik: 'BLAD', powod: expect.stringMatching(/HTTP 400/) })
    const s1 = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(s1).toMatchObject({ state: 'BLAD', failureKind: 'TRWALY', attempt: 1 })
    expect(await moznaPoprawicAdres(db, id)).toBe(true)
    atrapa = dpdAtrapa()
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const s2 = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(s2).toMatchObject({ id: s1.id, reference: s1.reference, attempt: 2, state: 'UTWORZONA' })
    expect(atrapa.calls[0]!.body).toMatchObject({ packages: [{ reference: s1.reference }] })
  })

  it('brak danych odbiorcy = odmowa bez żądania', async () => {
    await firma()
    const pid = await product(db, 'HERB-BEZ', 50)
    const r = await ingestOrder(db, order([{ productId: pid, qty: 1 }], { deliveryMethod: 'Kurier DPD' }), { now: T0 })
    // bez rekordu klienta i z wyłączonym odczytem z kanału (DANE_ODBIORCY_Z_KANALU): czytelna odmowa, nie wyjątek
    expect(await utworz(r.orderId!)).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringMatching(/Brak danych odbiorcy/) })
    expect(atrapa.calls).toEqual([])
  })
})

describe('druk etykiety', () => {
  it('z przesyłką: prawdziwa etykieta z bazy (bez drugiego żądania do DPD); bez przesyłki: atrapa PRÓBA', async () => {
    await firma()
    const bez = await zamowienie()
    await db.preparedShipment.create({ data: { orderId: bez, packageNo: 1, adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD' } })
    const atr = await etykietaZamowienia.etykieta(db, bez, T0)
    expect(atr.opis).toMatch(/PRÓBNA/)

    const id = await zamowienie()
    await utworz(id)
    const n = atrapa.calls.length
    const e1 = await etykietaZamowienia.etykieta(db, id, T0)
    const e2 = await etykietaZamowienia.etykieta(db, id, T0)
    expect(e1.pdf!.toString()).toBe(ETYKIETA)
    expect(e2.pdf!.toString()).toBe(ETYKIETA)
    expect(e1.opis).toContain(DPD_WAYBILL)
    expect(atrapa.calls.length).toBe(n)
  })

  it('usunięcie danych klienta (RODO, retencja) kasuje też etykietę; numer nadania zostaje, druk mówi dlaczego', async () => {
    await firma()
    const id = await zamowienie()
    await utworz(id)
    expect(await usunDaneKlientow(db, ENV, { where: { purgedAt: null, orderId: id }, now: T0 })).toEqual({ usuniete: 1, bledy: 0 })
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(s).toMatchObject({ labelCiphertext: null, labelKeyVersion: null, trackingNumber: DPD_WAYBILL })
    expect(await etykietaZamowienia.etykieta(db, id, T0).catch((e: Error) => e.message)).toMatch(/Pobierz etykietę/)
    const n = atrapa.calls.length
    expect((await pobierzEtykiete(db, s.id, deps())).blad).toMatch(/zostały usunięte/)
    expect(atrapa.calls.length).toBe(n)
  })
})

describe('poprawka adresu przed nadaniem', () => {
  it('zapis RECZNE, wpisy w dzienniku podglądów (cel POPRAWKA, nazwy pól bez wartości), nowy adres idzie do DPD', async () => {
    await firma()
    const uid = await osoba('biuro@example.test', 'WLASCICIEL')
    const id = await zamowienie()
    const stare = await daneDoPoprawki(db, id, { actorId: uid, env: ENV })
    expect(stare).toMatchObject({ ulica: ULICA, numerDomu: '9' })
    const w = await poprawDostawe(db, id, { ...stare!, numerDomu: '11', numerLokalu: '2' }, { actorId: uid, env: ENV })
    expect(w).toEqual({ wynik: 'ZAPISANO', pola: ['numer_domu', 'numer_lokalu'] })
    const dz = await dziennikPodgladow(db, { actorId: uid })
    expect(dz.filter((x) => x.cel === 'POPRAWKA').length).toBeGreaterThanOrEqual(2)
    const wpisy = await db.auditLog.findMany({ where: { entity: 'KLIENT_PODGLAD', actorId: uid } })
    expect(JSON.stringify(wpisy)).not.toContain(ULICA)
    expect(wpisy.some((x) => (x.after as { pola?: string }).pola === 'numer_domu,numer_lokalu')).toBe(true)
    await utworz(id)
    const rcv = (atrapa.calls[0]!.body as { packages: { receiver: { address: string } }[] }).packages[0]!.receiver
    expect(rcv.address).toBe(`${ULICA} 11/2`)
  })

  it('bez uprawnienia do pełnych danych: odmowa', async () => {
    await firma()
    const uid = await osoba('magazyn@example.test', 'MAGAZYN')
    const id = await zamowienie()
    const w = await poprawDostawe(db, id, { imieNazwisko: 'X', firma: null, ulica: 'Y', numerDomu: '1', numerLokalu: null, kodPocztowy: '60-001', miasto: 'Z', telefon: null, punkt: null }, { actorId: uid, env: ENV })
    expect(w.wynik).toBe('ODMOWA')
  })
})

describe('izolacja firm', () => {
  it('firma B nie widzi przesyłki firmy A; bramka B liczy własne reguły (Base Courier = tylko podgląd)', async () => {
    await firma()
    const id = await zamowienie()
    await utworz(id)
    expect(await dbB.shipment.count()).toBe(0)
    expect(await widokPrzesylki(dbB, id)).toBeNull()
    const idB = await zamowienie(dbB)
    await dbB.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    expect((await bramkaNadania(dbB, idB, deps()))!.powod).toMatch(/tylko liczy przesyłkę/)
  })
})

describe('InPost ShipX: numer nadania przychodzi po utworzeniu', () => {
  it('paczkomat z gabarytem A: punkt z danych klienta, numer dociągnięty przy pobraniu etykiety, zdarzenie raz', async () => {
    const shipx = inpostAtrapa()
    const env = { ...ENV, INPOST_TOKEN }
    const d: DepsNadania = { fetch: shipx.fetchImpl, env, secrets: { env, envFallback: true } }
    await db.carrierRule.updateMany({ where: { carrier: 'PACZKOMATY' }, data: { shippingModule: 'INPOST_SHIPX', adapterKey: 'inpost.shipx.zapis.v1', config: { baseUrl: INPOST_SANDBOX, organizationId: INPOST_ORG, zapisWlaczony: true } } })
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    const pid = await product(db, 'HERB-PACZ', 50)
    const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: 'Paczkomaty InPost', paymentState: 'PAID' }), { now: T0 })
    const id = r.orderId!
    await zapiszRekordKlienta(db, id, rekordZOdbiorcy({ ...ODBIORCA, punktOdbioru: { kod: 'POZ08M', nazwa: null } }), { source: 'RECZNE', fetchedAt: T0, env })
    const w = await utworzPrzesylke(db, { orderId: id, gabaryt: 'INPOST_A', potwierdzoneOstrzezenia: POTWIERDZONE, userId: 'u' }, d)
    expect(w.wynik).toBe('UTWORZONA')
    const post = shipx.calls.find((c) => c.method === 'POST')!
    expect(post.body).toMatchObject({ custom_attributes: { target_point: 'POZ08M' } })
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    // pierwszy odczyt po utworzeniu bez numeru; pobranie etykiety w tym samym kliknięciu dociąga numer i daje zdarzenie
    expect(s).toMatchObject({ state: 'UTWORZONA', externalRef: '900001', trackingNumber: '6200000900001', parcelSize: 'INPOST_A' })
    expect(s.labelCiphertext).not.toBeNull()
    expect(shipx.calls.filter((c) => c.method === 'GET' && c.path === '/v1/shipments/900001')).toHaveLength(2)
    expect(await db.auditLog.count({ where: { entity: NUMER_NADANIA_GOTOWY } })).toBe(1)
    // ponowne „Pobierz etykietę”: bez drugiego zdarzenia i bez drugiej przesyłki
    expect(await pobierzEtykiete(db, s.id, d)).toEqual({ blad: null })
    expect(await db.auditLog.count({ where: { entity: NUMER_NADANIA_GOTOWY } })).toBe(1)
    expect(shipx.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })
})

// ─── Przegląd 06.11: ────────────────────────────────────────

type Fetch = ReturnType<typeof dpdAtrapa>['fetchImpl']
const depsZ = (f: Fetch): DepsNadania => ({ fetch: f, env: ENV, secrets: { env: ENV, envFallback: true } })

/** Pierwsze `n` żądań czeka, aż przyjdą wszystkie: oba „Sprawdź” przeczytały stan przed pierwszym zapisem. */
function bariera(n: number, f: Fetch): Fetch {
  const czekaja: (() => void)[] = []
  let licz = 0
  return async (url, init) => {
    if (licz < n) {
      licz++
      await new Promise<void>((r) => {
        czekaja.push(r)
        if (czekaja.length === n) czekaja.forEach((x) => x())
      })
    }
    return f(url, init)
  }
}

/** Przesyłka NIEJEDNOZNACZNA: zgubiona odpowiedź przy tworzeniu, odszukanie bez potwierdzenia. */
async function niejednoznaczna() {
  await firma()
  const id = await zamowienie()
  atrapa = dpdAtrapa([{ error: new TypeError('fetch failed') }, odpowiedzSzukania([])])
  expect((await utworz(id)).wynik).toBe('NIEJEDNOZNACZNA')
  return { id, s: await db.shipment.findFirstOrThrow({ where: { orderId: id } }) }
}

const zdarzenia = async (id: string) => ({
  utworzona: await db.orderEvent.count({ where: { orderId: id, kind: 'PRZESYLKA_UTWORZONA' } }),
  numer: await db.auditLog.count({ where: { entity: NUMER_NADANIA_GOTOWY } }),
})

describe('zdarzenia przesyłki najwyżej raz', () => {
  it('dwa „Sprawdź u przewoźnika” naraz (Promise.all, oba odczyty przed zapisem) = jedno PRZESYLKA_UTWORZONA i jedno NUMER_NADANIA_GOTOWY', async () => {
    const { id, s } = await niejednoznaczna()
    const potw = () => odpowiedzSzukania([{ reference: s.reference, parcels: [{ waybill: DPD_WAYBILL }] }])
    atrapa = dpdAtrapa([potw(), potw()])
    const d = depsZ(bariera(2, atrapa.fetchImpl))
    const [a, b] = await Promise.all([sprawdzPrzesylke(db, s.id, { userId: 'u1', deps: d }), sprawdzPrzesylke(db, s.id, { userId: 'u2', deps: d })])
    expect([a.wynik, b.wynik]).toEqual(['UTWORZONA', 'UTWORZONA'])
    expect(await zdarzenia(id)).toEqual({ utworzona: 1, numer: 1 })
    expect(await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ state: 'UTWORZONA', trackingNumber: DPD_WAYBILL })
    expect(await db.alert.count({ where: { kind: 'PRZESYLKA_NIEJEDNOZNACZNA', closedAt: null } })).toBe(0)
  })
})

describe('spóźniony wynik nie cofa przesyłki UTWORZONA', () => {
  /** Atrapa, która przy pierwszym żądaniu zapisuje przesyłkę jako UTWORZONA (równoległe „Sprawdź”), a potem odpowiada `r`. */
  const wTrakcie = (r: DpdReply): Fetch => {
    let raz = false
    return async (url, init) => {
      if (!raz) {
        raz = true
        await db.shipment.updateMany({ data: { state: 'UTWORZONA', externalRef: DPD_WAYBILL, trackingNumber: DPD_WAYBILL } })
        if ('error' in r) throw r.error
        return new Response(r.body, { status: r.status })
      }
      return atrapa.fetchImpl(url, init)
    }
  }

  it('zgubiona odpowiedź (NIEJEDNOZNACZNY) po zapisaniu UTWORZONA w międzyczasie: stan zostaje, bez alertu', async () => {
    await firma()
    const id = await zamowienie()
    atrapa = dpdAtrapa([odpowiedzSzukania([])])
    const w = await utworzPrzesylke(db, { orderId: id, potwierdzoneOstrzezenia: POTWIERDZONE, userId: 'u' }, depsZ(wTrakcie({ error: new TypeError('fetch failed') })))
    expect(w).toMatchObject({ wynik: 'UTWORZONA', istniala: true })
    expect(await db.shipment.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ state: 'UTWORZONA', trackingNumber: DPD_WAYBILL })
    expect(await db.alert.count({ where: { kind: 'PRZESYLKA_NIEJEDNOZNACZNA' } })).toBe(0)
  })

  it('odmowa (400) po zapisaniu UTWORZONA w międzyczasie: stan zostaje UTWORZONA, nie BLAD', async () => {
    await firma()
    const id = await zamowienie()
    atrapa = dpdAtrapa()
    const w = await utworzPrzesylke(db, { orderId: id, potwierdzoneOstrzezenia: POTWIERDZONE, userId: 'u' }, depsZ(wTrakcie({ status: 400, body: '{}' })))
    expect(w.wynik).toBe('UTWORZONA')
    expect((await db.shipment.findFirstOrThrow({ where: { orderId: id } })).state).toBe('UTWORZONA')
  })

  it('„Sprawdź” z błędem odszukania po zapisaniu UTWORZONA w międzyczasie: stan zostaje UTWORZONA', async () => {
    const { s } = await niejednoznaczna()
    atrapa = dpdAtrapa()
    const r = await sprawdzPrzesylke(db, s.id, { userId: 'u', deps: depsZ(wTrakcie({ status: 503, body: '' })) })
    expect(r.wynik).toBe('UTWORZONA')
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('UTWORZONA')
  })
})

describe('rozstrzygnięcie ręczne przesyłki niejednoznacznej', () => {
  it('„nie powstała”: ANULOWANA, AuditLog z osobą i wariantem, alert zamknięty; następne utworzenie z NOWĄ referencją', async () => {
    const { id, s } = await niejednoznaczna()
    const r = await rozstrzygnijRecznie(db, s.id, { wariant: 'NIE_POWSTALA' }, { userId: 'u-biuro', deps: deps() })
    expect(r.wynik).toBe('ANULOWANA')
    expect(await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ state: 'ANULOWANA' })
    const slad = await db.auditLog.findMany({ where: { entity: ROZSTRZYGNIECIE_AUDIT } })
    expect(slad).toHaveLength(1)
    expect(slad[0]).toMatchObject({ entityId: s.id, actorId: 'user:u-biuro', after: { wariant: 'NIE_POWSTALA', orderId: id, reference: s.reference, poprzedniStan: 'NIEJEDNOZNACZNA' } })
    expect(await db.alert.count({ where: { kind: 'PRZESYLKA_NIEJEDNOZNACZNA', closedAt: null } })).toBe(0)
    expect(await moznaPoprawicAdres(db, id)).toBe(true)
    // drugie rozstrzygnięcie tej samej przesyłki: odmowa, bez drugiego wpisu
    expect((await rozstrzygnijRecznie(db, s.id, { wariant: 'NIE_POWSTALA' }, { userId: 'u', deps: deps() })).wynik).toBe('ODMOWA')
    expect(await db.auditLog.count({ where: { entity: ROZSTRZYGNIECIE_AUDIT } })).toBe(1)
    atrapa = dpdAtrapa()
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    const nowa = await db.shipment.findFirstOrThrow({ where: { orderId: id, state: 'UTWORZONA' } })
    expect(nowa.id).not.toBe(s.id)
    expect(nowa.reference).not.toBe(s.reference)
    expect(atrapa.calls[0]!.body).toMatchObject({ packages: [{ reference: nowa.reference }] })
    expect(numery()).toBe(1)
  })

  it('„istnieje, numer X”: zły numer = odmowa bez zapisu; dobry = UTWORZONA z numerem, zdarzenia raz, AuditLog, etykieta, alert zamknięty', async () => {
    const { id, s } = await niejednoznaczna()
    atrapa = dpdAtrapa()
    expect(await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: 'abc 1' }, { userId: 'u', deps: deps() })).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/numer listu/) })
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('NIEJEDNOZNACZNA')
    expect(atrapa.calls).toEqual([])
    const r = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: ` ${DPD_WAYBILL} ` }, { userId: 'u-biuro', deps: deps() })
    expect(r.wynik).toBe('UTWORZONA')
    const po = await db.shipment.findUniqueOrThrow({ where: { id: s.id } })
    expect(po).toMatchObject({ state: 'UTWORZONA', externalRef: DPD_WAYBILL, trackingNumber: DPD_WAYBILL })
    expect(po.labelCiphertext).not.toBeNull()
    expect(await zdarzenia(id)).toEqual({ utworzona: 1, numer: 1 })
    const slad = await db.auditLog.findMany({ where: { entity: ROZSTRZYGNIECIE_AUDIT } })
    expect(slad).toHaveLength(1)
    expect(slad[0]).toMatchObject({ actorId: 'user:u-biuro', after: { wariant: 'ISTNIEJE', numer: DPD_WAYBILL } })
    expect(await db.alert.count({ where: { kind: 'PRZESYLKA_NIEJEDNOZNACZNA', closedAt: null } })).toBe(0)
    // do przewoźnika poszła tylko etykieta; przesyłka UTWORZONA nie daje się już rozstrzygać
    expect(numery()).toBe(0)
    expect((await rozstrzygnijRecznie(db, s.id, { wariant: 'NIE_POWSTALA' }, { userId: 'u', deps: deps() })).wynik).toBe('ODMOWA')
  })

  it('„istnieje” z numerem listu innej przesyłki w Kompletorze (inne zamówienie, także anulowana): odmowa bez pytania DPD i bez zmiany stanu', async () => {
    const { id, s } = await niejednoznaczna()
    const inne = await zamowienie()
    const cudzy = '0000999999999U'
    const anulowanyNumer = '0000888888888U'
    await db.shipment.create({ data: { orderId: inne, packageNo: 1, reference: 'ref-innej-utworzonej', state: 'UTWORZONA', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', externalRef: cudzy, trackingNumber: cudzy } })
    await db.shipment.create({ data: { orderId: inne, packageNo: 1, reference: 'ref-innej-anulowanej', state: 'ANULOWANA', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', externalRef: anulowanyNumer, trackingNumber: anulowanyNumer } })
    const inneZew = (await db.order.findUniqueOrThrow({ where: { id: inne } })).externalId
    atrapa = dpdAtrapa()
    for (const numer of [cudzy, anulowanyNumer]) {
      const r = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer }, { userId: 'u', deps: deps() })
      expect(r).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringContaining('Ten numer ma już w Kompletorze inna paczka') })
      expect(r.komunikat).toContain(`zamówienia ${inneZew}`)
      expect(r.komunikat).toContain(s.reference)
    }
    expect((await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: anulowanyNumer }, { userId: 'u', deps: deps() })).komunikat).toContain('(anulowanej)')
    expect(atrapa.calls).toEqual([])
    expect(await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ state: 'NIEJEDNOZNACZNA', externalRef: null, trackingNumber: null })
    expect(await db.auditLog.count({ where: { entity: ROZSTRZYGNIECIE_AUDIT } })).toBe(0)
    expect(await zdarzenia(id)).toEqual({ utworzona: 0, numer: 0 })
    // własny numer tej przesyłki przechodzi jak dotąd
    expect((await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: DPD_WAYBILL }, { userId: 'u', deps: deps() })).wynik).toBe('UTWORZONA')
  })

  it('numer innej firmy nie blokuje (izolacja): ten sam numer listu w firmie B nie daje odmowy w firmie A', async () => {
    const { s } = await niejednoznaczna()
    await firma(dbB)
    const zB = await zamowienie(dbB)
    await dbB.shipment.create({ data: { orderId: zB, packageNo: 1, reference: 'ref-firmy-b', state: 'UTWORZONA', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', externalRef: DPD_WAYBILL, trackingNumber: DPD_WAYBILL } })
    atrapa = dpdAtrapa()
    expect((await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: DPD_WAYBILL }, { userId: 'u', deps: deps() })).wynik).toBe('UTWORZONA')
  })

  it('ta sama pula numerów DPD i DPD_EMPIK: numer przesyłki salonu Empik przy DPD = odmowa i odwrotnie; numer innego modułu nie blokuje', async () => {
    const { s } = await niejednoznaczna()
    const inne = await zamowienie()
    const empikowy = '0000777777777U'
    const zwykly = '0000666666666U'
    await db.shipment.create({ data: { orderId: inne, packageNo: 1, reference: 'ref-salonu-empik', state: 'UTWORZONA', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD_EMPIK', externalRef: empikowy, trackingNumber: empikowy } })
    await db.shipment.create({ data: { orderId: inne, packageNo: 1, reference: 'ref-zwyklej-dpd', state: 'ANULOWANA', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', externalRef: zwykly, trackingNumber: zwykly } })
    // ten sam numer listu u niespokrewnionego modułu i przewoźnika (np. paczkomat): nie należy do puli DPD
    const inny = await zamowienie()
    await db.shipment.create({ data: { orderId: inny, packageNo: 1, reference: 'ref-paczkomatu', state: 'UTWORZONA', adapterKey: 'inpost.shipx.zapis.v1', carrier: 'PACZKOMATY', externalRef: DPD_WAYBILL, trackingNumber: DPD_WAYBILL } })
    atrapa = dpdAtrapa()
    expect(s.carrier).toBe('DPD')
    const r = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: empikowy }, { userId: 'u', deps: deps() })
    expect(r).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringContaining('Ten numer ma już w Kompletorze inna paczka') })
    // odwrotnie: niejasna przesyłka salonu Empik, numer zwykłej DPD
    await db.shipment.update({ where: { id: s.id }, data: { carrier: 'DPD_EMPIK' } })
    const r2 = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: zwykly }, { userId: 'u', deps: deps() })
    expect(r2).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringContaining('(anulowanej)') })
    expect(atrapa.calls).toEqual([])
    expect(await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ state: 'NIEJEDNOZNACZNA', externalRef: null, trackingNumber: null })
    await db.shipment.update({ where: { id: s.id }, data: { carrier: 'DPD' } })
    expect((await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: DPD_WAYBILL }, { userId: 'u', deps: deps() })).wynik).toBe('UTWORZONA')
  })

  it('dwa rozstrzygnięcia naraz („istnieje” i „nie powstała”): wygrywa jedno, jeden wpis AuditLog', async () => {
    const { s } = await niejednoznaczna()
    atrapa = dpdAtrapa()
    const [a, b] = await Promise.all([
      rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: DPD_WAYBILL }, { userId: 'u1', deps: deps() }),
      rozstrzygnijRecznie(db, s.id, { wariant: 'NIE_POWSTALA' }, { userId: 'u2', deps: deps() }),
    ])
    expect([a.wynik, b.wynik].filter((x) => x === 'ODMOWA')).toHaveLength(1)
    expect(await db.auditLog.count({ where: { entity: ROZSTRZYGNIECIE_AUDIT } })).toBe(1)
    expect(['UTWORZONA', 'ANULOWANA']).toContain((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).state)
  })

  it('BLAD ani świeżego TWORZENIE nie rozstrzyga się ręcznie; zawieszone TWORZENIE tak', async () => {
    await firma()
    const id = await zamowienie()
    atrapa = dpdAtrapa([{ status: 400, body: '{}' }])
    await utworz(id)
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect((await rozstrzygnijRecznie(db, s.id, { wariant: 'NIE_POWSTALA' }, { userId: 'u', deps: deps() })).wynik).toBe('ODMOWA')
    await db.shipment.update({ where: { id: s.id }, data: { state: 'TWORZENIE' } })
    expect((await rozstrzygnijRecznie(db, s.id, { wariant: 'NIE_POWSTALA' }, { userId: 'u', deps: deps() })).komunikat).toMatch(/właśnie powstaje/)
    const pozniej: DepsNadania = { ...deps(), now: () => new Date(Date.now() + TWORZENIE_ZAWIESZONE_MS + 60_000) }
    expect((await rozstrzygnijRecznie(db, s.id, { wariant: 'NIE_POWSTALA' }, { userId: 'u', deps: pozniej })).wynik).toBe('ANULOWANA')
  })
})

describe('komunikaty', () => {
  it('odmowa DPD z echem adresu w treści: powód bez danych odbiorcy w bazie i w wyniku', async () => {
    await firma()
    const id = await zamowienie()
    atrapa = dpdAtrapa([{ status: 400, body: JSON.stringify({ status: 'INCORRECT_DATA', receiver: { name: NAZWISKO, address: ULICA, phone: TELEFON, email: EMAIL } }) }])
    const w = await utworz(id)
    expect(w.wynik).toBe('BLAD')
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    for (const x of [NAZWISKO, ULICA, TELEFON, EMAIL]) {
      expect(s.lastError ?? '').not.toContain(x)
      expect(JSON.stringify(w)).not.toContain(x)
    }
  })

  it('wyłączony zapis po nadaniu: „Pobierz etykietę” mówi, że nadawanie jest wyłączone w ustawieniach', async () => {
    await firma()
    const id = await zamowienie()
    await utworz(id)
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    await firma(db, { config: { ...KONFIG, zapisWlaczony: false } })
    expect((await pobierzEtykiete(db, s.id, deps())).blad).toMatch(/wyłączone w ustawieniach przewoźnika/)
  })

  it('zamówienie bez konta kanału: powód o koncie sprzedaży, nie o trybie cienia', async () => {
    await firma()
    const id = await zamowienie()
    await db.channelConfig.deleteMany({ where: { channel: 'WOO', channelAccountId: 'sd' } })
    const p = (await bramkaNadania(db, id, deps()))!.powod
    expect(p).toMatch(/nie ma konta sprzedaży/)
    expect(p).not.toMatch(/cienia|Tylko podgląd/)
  })
})

describe('poprawka adresu a nadanie', () => {
  it('poprawka zapisana, gdy nadanie czeka na blokadę po odczycie odbiorcy: odmowa bez żądania do DPD; ponowne kliknięcie przechodzi', async () => {
    await firma()
    const id = await zamowienie()
    // trzymamy blokadę przesyłki zamówienia (jak poprawka w toku); nadanie przeczyta odbiorcę i stanie na blokadzie
    let zwolnij: () => void = () => {}
    let mam: () => void = () => {}
    const zablokowane = new Promise<void>((r) => (mam = r))
    const trzyma = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`przesylka:${id}`}, 0))) s`
        mam()
        await new Promise<void>((r) => (zwolnij = r))
        await tx.orderCustomer.update({ where: { orderId: id }, data: { revision: { increment: 1 } } })
      },
      { timeout: 60_000 },
    )
    await zablokowane
    const nadanie = utworz(id)
    for (let i = 0; i < 400; i++) {
      const [w] = await sys.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
      if (Number(w!.n) > 0) break
      await new Promise((r) => setTimeout(r, 25))
    }
    zwolnij()
    await trzyma
    expect(await nadanie).toMatchObject({ wynik: 'ODMOWA', powod: expect.stringMatching(/zmieniły się w trakcie/) })
    expect(atrapa.calls).toEqual([])
    expect(await db.shipment.count({ where: { orderId: id } })).toBe(0)
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
  })

  it('poprawka po utworzeniu przesyłki (ekran pokazał formularz wcześniej): odmowa w transakcji zapisu, rekord bez zmian', async () => {
    await firma()
    const uid = await osoba('biuro2@example.test', 'WLASCICIEL')
    const id = await zamowienie()
    const stare = await daneDoPoprawki(db, id, { actorId: uid, env: ENV })
    await utworz(id)
    const przed = await db.orderCustomer.findUniqueOrThrow({ where: { orderId: id } })
    const w = await poprawDostawe(db, id, { ...stare!, numerDomu: '99' }, { actorId: uid, env: ENV })
    expect(w).toEqual({ wynik: 'ODMOWA', powod: PRZESYLKA_JEST })
    expect((await db.orderCustomer.findUniqueOrThrow({ where: { orderId: id } })).revision).toBe(przed.revision)
  })
})

// ───: reszta (zamówienia ręczne) ─────────

describe('„istnieje, numer X” potwierdza przewoźnik, zanim cokolwiek zapiszemy', () => {
  const bezZmian = async (id: string, sid: string) => {
    expect((await db.shipment.findUniqueOrThrow({ where: { id: sid } })).state).toBe('NIEJEDNOZNACZNA')
    expect(await zdarzenia(id)).toEqual({ utworzona: 0, numer: 0 })
    expect(await db.auditLog.count({ where: { entity: ROZSTRZYGNIECIE_AUDIT } })).toBe(0)
  }

  it('DPD: numer listu bez etykiety (status inny niż OK) = odmowa bez zapisu; tylko jedno żądanie etykiety, bez generatePackagesNumbers', async () => {
    const { id, s } = await niejednoznaczna()
    atrapa = dpdAtrapa([json({ status: 'ERROR', errorCode: 'WAYBILL_NOT_FOUND' })])
    const r = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: '0000999999999U' }, { userId: 'u', deps: deps() })
    expect(r).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/DPD nie potwierdził numeru listu 0000999999999U/) })
    expect(atrapa.calls.map((c) => c.path)).toEqual(['/public/shipment/v1/generateSpedLabels'])
    expect(atrapa.calls[0]!.body).toMatchObject({ labelSearchParams: { session: { packages: [{ parcels: [{ waybill: '0000999999999U' }] }] } } })
    await bezZmian(id, s.id)
  })

  it('DPD: odmowa HTTP 400 = odmowa bez zapisu; sieć = odmowa „spróbuj ponownie” bez zapisu', async () => {
    const { id, s } = await niejednoznaczna()
    atrapa = dpdAtrapa([{ status: 400, body: '{}' }])
    expect(await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: DPD_WAYBILL }, { userId: 'u', deps: deps() })).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/nie potwierdził/) })
    atrapa = dpdAtrapa([{ error: new TypeError('fetch failed') }, { error: new TypeError('fetch failed') }, { error: new TypeError('fetch failed') }])
    expect(await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: DPD_WAYBILL }, { userId: 'u', deps: deps() })).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/Spróbuj ponownie/) })
    await bezZmian(id, s.id)
  })

  it('etykieta z błędem w zagnieżdżonym statusie listu (bez statusu na wierzchu, z documentData) = odmowa bez zapisu', async () => {
    const { id, s } = await niejednoznaczna()
    const doc = Buffer.from('%PDF-strona-z-komunikatem').toString('base64')
    atrapa = dpdAtrapa([json({ documentData: doc, session: { packages: [{ parcels: [{ waybill: '0000123456780U', status: 'ERROR', errorCode: 'PARCEL_NOT_FOUND' }] }] } })])
    expect(await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: '0000123456780U' }, { userId: 'u', deps: deps() })).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/DPD nie potwierdził numeru listu/) })
    await bezZmian(id, s.id)
  })

  it('DPD z innym numerem listu pod referencją tej przesyłki = odmowa bez zapisu; ten sam numer = UTWORZONA z potwierdzeniem; bez nowej paczki', async () => {
    const { id, s } = await niejednoznaczna()
    const etykieta = () => json({ status: 'OK', documentData: Buffer.from('%PDF-x').toString('base64') })
    // literówka w ostatniej cyfrze: sąsiedni list tej samej firmy istnieje (etykieta OK), ale referencja wskazuje nasz
    atrapa = dpdAtrapa([etykieta(), odpowiedzSzukania([{ reference: s.reference, parcels: [{ waybill: DPD_WAYBILL }] }])])
    const zly = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: '0000123456780U' }, { userId: 'u', deps: deps() })
    expect(zly).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringContaining(`inny numer (${DPD_WAYBILL})`) })
    expect(atrapa.calls.map((c) => c.path)).toEqual(['/public/shipment/v1/generateSpedLabels', '/public/shipment/v1/generateSpedLabels'])
    expect(atrapa.calls[1]!.body).toMatchObject({ labelSearchParams: { session: { packages: [{ reference: s.reference }] } } })
    await bezZmian(id, s.id)
    atrapa = dpdAtrapa([etykieta(), odpowiedzSzukania([{ reference: s.reference, parcels: [{ waybill: DPD_WAYBILL }] }])])
    const ok = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: DPD_WAYBILL }, { userId: 'u', deps: deps() })
    expect(ok).toMatchObject({ wynik: 'UTWORZONA', komunikat: expect.stringMatching(/zgadza się z referencją/) })
    expect(numery()).toBe(0)
  })

  it('odszukanie DPD po referencji bez rozstrzygnięcia (kształt [NIEPEWNE]) = przyjęcie z dopiskiem', async () => {
    const { s } = await niejednoznaczna()
    atrapa = dpdAtrapa()
    const r = await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: DPD_WAYBILL }, { userId: 'u', deps: deps() })
    expect(r).toMatchObject({ wynik: 'UTWORZONA', komunikat: expect.stringMatching(/Nie dało się porównać numeru z referencją/) })
    const slad = await db.auditLog.findFirstOrThrow({ where: { entity: ROZSTRZYGNIECIE_AUDIT } })
    expect(slad.after).toMatchObject({ sprawdzenie: expect.stringMatching(/Nie dało się porównać/) })
    expect(numery()).toBe(0)
  })

  it('DPD: wyłączone nadawanie = odmowa bez żądania', async () => {
    const { id, s } = await niejednoznaczna()
    await firma(db, { config: { ...KONFIG, zapisWlaczony: false } })
    atrapa = dpdAtrapa()
    expect(await rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer: DPD_WAYBILL }, { userId: 'u', deps: deps() })).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/wyłączone/) })
    expect(atrapa.calls).toEqual([])
    await bezZmian(id, s.id)
  })

  it('InPost: nieznane id, cudza referencja i brak numeru nadania = odmowa bez zapisu; właściwe id z numerem = UTWORZONA', async () => {
    const shipx = inpostAtrapa()
    const env = { ...ENV, INPOST_TOKEN }
    // przesyłka założona poza Kompletorem (Manager Paczek) nie ma referencji: atrapa oddaje ją bez pola
    let bezReferencji = ''
    const fetchW: typeof shipx.fetchImpl = async (url, init) => {
      const res = await shipx.fetchImpl(url, init)
      if (!bezReferencji || new URL(url).pathname !== `/v1/shipments/${bezReferencji}`) return res
      const b = (await res.json()) as Record<string, unknown>
      return new Response(JSON.stringify({ ...b, reference: null, tracking_number: '620000099999' }), { status: res.status })
    }
    const d: DepsNadania = { fetch: fetchW, env, secrets: { env, envFallback: true } }
    await db.carrierRule.updateMany({ where: { carrier: 'PACZKOMATY' }, data: { shippingModule: 'INPOST_SHIPX', adapterKey: 'inpost.shipx.zapis.v1', config: { baseUrl: INPOST_SANDBOX, organizationId: INPOST_ORG, zapisWlaczony: true } } })
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    const pid = await product(db, 'HERB-W7', 50)
    const r = await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: 'Paczkomaty InPost', paymentState: 'PAID' }), { now: T0 })
    const id = r.orderId!
    await zapiszRekordKlienta(db, id, rekordZOdbiorcy({ ...ODBIORCA, punktOdbioru: { kod: 'POZ08M', nazwa: null } }), { source: 'RECZNE', fetchedAt: T0, env })
    // przesyłka NIEJEDNOZNACZNA bez udziału ShipX (jak po zgubionej odpowiedzi): wiersz z referencją hosta
    const s = await db.shipment.create({ data: { orderId: id, packageNo: 1, reference: 'ref-a125-w7', state: 'NIEJEDNOZNACZNA', adapterKey: 'inpost.shipx.zapis.v1', carrier: 'PACZKOMATY', requestedBy: 'u' } })
    // dwie przesyłki w atrapie ShipX: cudza (inna referencja) i właściwa (referencja tej przesyłki)
    const nowaWAtrapie = async (reference: string) => {
      const res = await shipx.fetchImpl(`${INPOST_SANDBOX}/v1/organizations/${INPOST_ORG}/shipments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference }) })
      return String(((await res.json()) as { id: number }).id)
    }
    const cudza = await nowaWAtrapie('ref-cudza')
    const nasza = await nowaWAtrapie(s.reference)
    const roz = (numer: string) => rozstrzygnijRecznie(db, s.id, { wariant: 'ISTNIEJE', numer }, { userId: 'u', deps: d })
    expect(await roz('123456')).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/InPost nie potwierdził przesyłki o id 123456/) })
    expect(await roz(cudza)).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/inną referencję/) })
    // bez referencji, choć z numerem nadania = odmowa (to nie jest przesyłka Kompletora), nic nie zapisane
    bezReferencji = await nowaWAtrapie('dowolna')
    expect(await roz(bezReferencji)).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/nie ma referencji Kompletora/) })
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('NIEJEDNOZNACZNA')
    // pierwszy odczyt właściwej: ShipX jeszcze bez numeru nadania
    expect(await roz(nasza)).toMatchObject({ wynik: 'ODMOWA', komunikat: expect.stringMatching(/nie nadał jeszcze numeru/) })
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('NIEJEDNOZNACZNA')
    expect(await zdarzenia(id)).toEqual({ utworzona: 0, numer: 0 })
    const ok = await roz(nasza)
    expect(ok).toMatchObject({ wynik: 'UTWORZONA', komunikat: expect.stringMatching(/Sprawdzone w InPost: numer nadania 6200000/) })
    expect(await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ state: 'UTWORZONA', externalRef: nasza, trackingNumber: `6200000${nasza}` })
    expect(await zdarzenia(id)).toEqual({ utworzona: 1, numer: 1 })
  })
})

describe('zamówienie ręczne → przesyłka → etykieta (firma bez kanałów sprzedaży i bez BaseLinkera)', () => {
  // instancja bez EKRANY_PRACA: firma bez BaseLinkera i tak pracuje w Kompletorze
  const ENV_BEZ_BL = { CUSTOMER_DATA_KEYS: ENV.CUSTOMER_DATA_KEYS, CUSTOMER_LOOKUP_KEY: ENV.CUSTOMER_LOOKUP_KEY, DPD_LOGIN, DPD_PASSWORD }
  const depsBezBl = (): DepsNadania => ({ fetch: atrapa.fetchImpl, env: ENV_BEZ_BL, secrets: { env: ENV_BEZ_BL, envFallback: true } })

  async function reczne(o: { sposob: string; numer?: string }) {
    const pid = await product(db, `HERB-R-${Math.random().toString(36).slice(2, 8)}`, 50)
    const { przyjmijZamowienie } = await import('@/lib/zamowienia/ogolne')
    const r = await przyjmijZamowienie(
      db,
      { kanal: 'RECZNE', numer: o.numer ?? `R-A125-${Math.random().toString(36).slice(2, 8)}`, zrodlo: 'telefon', zlozono: null, platnosc: 'PAID', platnoscMetoda: 'Opłacone', sumaBrutto: 45, dostawa: { sposob: o.sposob, przewoznik: 'DPD', koszt: 15 }, chceFakture: false, klient: rekordZOdbiorcy(ODBIORCA), pozycje: [{ produktId: pid, ilosc: 1, cenaBrutto: 30 }] },
      { source: 'panel', actorId: 'user:u-biuro', env: ENV_BEZ_BL, pierwszeKonto: true },
    )
    return r.body.id
  }

  it('metoda dostawy bez reguły („Wysyłka do klienta”), przewoźnik wybrany w formularzu: bramka puszcza, jedna przesyłka, numer, etykieta w druku', async () => {
    await firma()
    // w tej firmie żadne konto kanału sprzedaży nie pracuje: tylko zamówienia ręczne
    await db.channelConfig.updateMany({ where: { channel: { not: 'RECZNE' } }, data: { statusMode: 'CIEN' } })
    const id = await reczne({ sposob: 'Wysyłka do klienta' })
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(o).toMatchObject({ channel: 'RECZNE', channelAccountId: 'reczne', carrier: 'DPD', shippingModule: 'DPD_BEZPOSREDNIO' })
    const b = (await bramkaNadania(db, id, depsBezBl()))!
    expect(b.powod).toBeNull()
    expect(b.regula).toMatchObject({ carrier: 'DPD', adapterKey: 'dpd.services.zapis.v1' })
    const w = await utworzPrzesylke(db, { orderId: id, potwierdzoneOstrzezenia: POTWIERDZONE, userId: 'u-biuro' }, depsBezBl())
    expect(w.wynik === 'ODMOWA' ? w.powod : w.wynik).toBe('UTWORZONA')
    expect(w).toMatchObject({ wynik: 'UTWORZONA', istniala: false })
    expect(numery()).toBe(1)
    // odbiorca z danych wpisanych w formularzu (rekord RECZNE), nie z kanału
    expect(JSON.stringify(atrapa.calls[0]!.body)).toContain(NAZWISKO)
    const s = await db.shipment.findFirstOrThrow({ where: { orderId: id } })
    expect(s).toMatchObject({ state: 'UTWORZONA', trackingNumber: DPD_WAYBILL })
    const e = await etykietaZamowienia.etykieta(db, id, T0)
    expect(e.pdf!.toString()).toBe(ETYKIETA)
    // ponowne kliknięcie nic nie wysyła
    expect(await utworzPrzesylke(db, { orderId: id, potwierdzoneOstrzezenia: POTWIERDZONE, userId: 'u-biuro' }, depsBezBl())).toMatchObject({ wynik: 'UTWORZONA', istniala: true })
    expect(numery()).toBe(1)
  })

  it('te same bramki co zamówienie z kanału: wyłączone nadawanie u przewoźnika i moduł tylko do podglądu = odmowa z powodem, zero żądań', async () => {
    await firma(db, { config: { ...KONFIG, zapisWlaczony: false } })
    const id = await reczne({ sposob: 'Wysyłka do klienta' })
    expect((await bramkaNadania(db, id, depsBezBl()))!.powod).toMatch(/wyłączone w ustawieniach przewoźnika/)
    expect(await utworzPrzesylke(db, { orderId: id, potwierdzoneOstrzezenia: POTWIERDZONE, userId: 'u' }, depsBezBl())).toMatchObject({ wynik: 'ODMOWA' })
    await firma(db, { adapterKey: 'dpd.services.v1' })
    expect((await bramkaNadania(db, id, depsBezBl()))!.powod).toMatch(/tylko liczy przesyłkę/)
    expect(atrapa.calls).toEqual([])
  })

  it('firma przechodząca z BaseLinkera bez włączonej pracy na serwerze: powód o serwerze, nie o „trybie cienia”', async () => {
    await firma()
    const id = await reczne({ sposob: 'Kurier DPD' })
    const zBl = { ...ENV_BEZ_BL, BASELINKER_TOKEN: 'token-testowy' }
    const p = (await bramkaNadania(db, id, { fetch: atrapa.fetchImpl, env: zBl, secrets: { env: zBl, envFallback: true } }))!.powod
    expect(p).toMatch(/przechodzi z BaseLinkera/)
    expect(p).not.toMatch(/cienia|Tylko podgląd/)
    expect(atrapa.calls).toEqual([])
  })

  it('reguła tego przewoźnika z innym modułem niż zamówienie i metoda bez reguły: odmowa z powodem, bez żądania', async () => {
    await firma()
    const id = await reczne({ sposob: 'Wysyłka do klienta' })
    await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { shippingModule: 'BASE_COURIER', adapterKey: 'basecourier.v1' } })
    // osobny powód z nazwami obu modułów, nie „brak reguły”
    expect((await bramkaNadania(db, id, depsBezBl()))!.powod).toMatch(/Zamówienie przyjęto z modułem wysyłki „DPD”, a reguła tego przewoźnika ma dziś „Base Courier”/)
    expect(atrapa.calls).toEqual([])
  })
})

describe('drobne z', () => {
  it('zgubiona odpowiedź = NIEJEDNOZNACZNA i alert razem; „Sprawdź” z błędem odszukania nie dubluje alertu', async () => {
    const { s } = await niejednoznaczna()
    expect(await db.alert.count({ where: { kind: 'PRZESYLKA_NIEJEDNOZNACZNA', ref: s.orderId, closedAt: null } })).toBe(1)
    atrapa = dpdAtrapa([{ status: 500, body: '{}' }, { status: 500, body: '{}' }, { status: 500, body: '{}' }])
    expect((await sprawdzPrzesylke(db, s.id, { userId: 'u', deps: deps() })).wynik).toBe('NADAL_NIEJASNE')
    expect(await db.alert.count({ where: { kind: 'PRZESYLKA_NIEJEDNOZNACZNA', ref: s.orderId } })).toBe(1)
  })

  it('próg „Sprawdź” dla zawieszonego tworzenia: domyślnie 4 min (DPD), przed progiem odmowa, po nim widok i rozstrzygnięcie', async () => {
    await firma()
    const id = await zamowienie()
    const s = await db.shipment.create({ data: { orderId: id, packageNo: 1, reference: 'ref-a125-d12', state: 'TWORZENIE', adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', requestedBy: 'u' } })
    const po = (ms: number) => new Date(s.updatedAt.getTime() + ms)
    expect(TWORZENIE_ZAWIESZONE_MS).toBe(4 * 60_000)
    expect((await widokPrzesylki(db, id, po(3 * 60_000)))!.doSprawdzenia).toBe(false)
    expect((await widokPrzesylki(db, id, po(4 * 60_000 + 1_000)))!.doSprawdzenia).toBe(true)
    expect((await rozstrzygnijRecznie(db, s.id, { wariant: 'NIE_POWSTALA' }, { userId: 'u', deps: { ...deps(), now: () => po(3 * 60_000) } })).komunikat).toMatch(/właśnie powstaje/)
    expect((await rozstrzygnijRecznie(db, s.id, { wariant: 'NIE_POWSTALA' }, { userId: 'u', deps: { ...deps(), now: () => po(4 * 60_000 + 1_000) } })).wynik).toBe('ANULOWANA')
  })

  it('po „nie powstała” karta ma ślad (ręcznie, kto); po nowej przesyłce śladu nie ma', async () => {
    const { id, s } = await niejednoznaczna()
    const { sladAnulowanej } = await import('@/lib/wysylka/nadanie')
    const { poprzedniaPrzesylka } = await import('@/lib/wysylka/poprzednia')
    const u = await osoba('biuro-a125@example.invalid', 'BIURO')
    expect(await sladAnulowanej(db, id)).toBeNull()
    await rozstrzygnijRecznie(db, s.id, { wariant: 'NIE_POWSTALA' }, { userId: u, deps: deps() })
    expect(await sladAnulowanej(db, id)).toMatchObject({ recznie: true, actorId: `user:${u}` })
    expect(await poprzedniaPrzesylka(db, id, { sys: () => sys })).toMatchObject({ recznie: true, kto: 'biuro-a125@example.invalid' })
    atrapa = dpdAtrapa()
    expect((await utworz(id)).wynik).toBe('UTWORZONA')
    expect(await sladAnulowanej(db, id)).toBeNull()
  })

  it('przesyłka należy do zamówienia (akcje karty odmawiają przesyłki z innego zamówienia)', async () => {
    const { id, s } = await niejednoznaczna()
    const { przesylkaZamowienia } = await import('@/lib/wysylka/nadanie')
    const inne = await zamowienie()
    expect(await przesylkaZamowienia(db, s.id, id)).toBe(true)
    expect(await przesylkaZamowienia(db, s.id, inne)).toBe(false)
    expect(await przesylkaZamowienia(dbB, s.id, id)).toBe(false)
  })
})

describe('dodatkowa przesyłka do punktu DPD Pickup i salonu Empik', () => {
  /** Zamówienie do punktu z główną przesyłką DPD utworzoną na atrapie, potem „Wysłane”; funkcja dodatkowej przesyłki włączona. */
  async function zGlownaDoPunktu(deliveryMethod: string, punkt: string): Promise<string> {
    await db.carrierRule.updateMany({ where: { carrier: { in: ['DPD', 'DPD_EMPIK'] } }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1', config: KONFIG as object } })
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: { nadawca: NADAWCA_TESTOWY, wysylkaAutomaty: { dodatkowaPrzesylka: true } } } })
    const pid = await product(db, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
    const id = (await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod, paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })).orderId!
    await zapiszRekordKlienta(db, id, rekordZOdbiorcy({ ...ODBIORCA, punktOdbioru: { kod: punkt, nazwa: null } }), { source: 'RECZNE', fetchedAt: T0, env: ENV })
    const w = await utworzPrzesylke(db, { orderId: id, potwierdzoneOstrzezenia: [...POTWIERDZONE, 'empik_niepotwierdzone'], userId: 'u-test' }, deps())
    expect(w.wynik).toBe('UTWORZONA')
    await db.order.update({ where: { id }, data: { status: 'WYSLANE' } })
    return id
  }

  for (const [nazwa, metoda, punkt] of [
    ['DPD Pickup', 'Kurier DPD', 'PL11033'],
    ['salon Empik', 'Dostawa do salonu Empik', 'PL99001'],
  ] as const)
    it(`${nazwa}: dosyłka to osobna przesyłka jednopaczkowa do tego samego punktu, bez błędu „tylko przesyłka jednopaczkowa”`, async () => {
      const id = await zGlownaDoPunktu(metoda, punkt)
      atrapa = dpdAtrapa()
      const b = (await bramkaDodatkowej(db, id, deps()))!
      expect(b.powod).toBeNull()
      const w = await utworzDodatkowa(
        db,
        { orderId: id, numer: b.nastepnyNumer, regulaId: b.moduly[0]!.regulaId, rodzaj: 'DOSYLKA', powod: 'reklamacja: brak jednego produktu', gabaryt: 'DPD', koszt: '', potwierdzam: true, potwierdzoneOstrzezenia: [...POTWIERDZONE, 'empik_niepotwierdzone'], userId: 'u-test' },
        deps(),
      )
      expect(w.wynik).toBe('UTWORZONA')
      const d = await db.shipment.findFirstOrThrow({ where: { orderId: id, extraNo: 1 } })
      expect(d).toMatchObject({ state: 'UTWORZONA', codAmount: null })
      const nadanie = atrapa.calls.filter((c) => c.path.endsWith('/generatePackagesNumbers'))
      expect(nadanie).toHaveLength(1)
      const pkg = (nadanie[0]!.body as { packages: { reference: string; parcels: unknown[]; services?: unknown[] }[] }).packages
      expect(pkg).toHaveLength(1)
      expect(pkg[0]!.reference).toBe(d.reference)
      expect(pkg[0]!.parcels).toHaveLength(1)
      expect(pkg[0]!.services).toEqual([{ code: 'DPD_PICKUP', attributes: [{ code: 'PUDO', value: punkt }] }])
    })
})
