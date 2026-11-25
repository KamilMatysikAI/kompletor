// API obsługi klienta (zakres `obsluga:odczyt`): POST /api/v1/obsluga/zamowienia-klienta i /zamowienie.
//  1. klucz obsługi: tylko ten jeden zakres (walidacja i warunek w bazie), zakłada go tylko osoba z „Dane klienta”,
//     nie dostaje innych tras; klucz bez zakresu nie dostaje tras obsługi;
//  2. zamówienia po e-mailu i telefonie: dokładnie po znormalizowanej wartości (skrót), tylko tego klienta, bez danych
//     osobowych w odpowiedzi, wyłącznie pola z listy, filtr kont, dane usunięte nie wychodzą;
//  3. zamówienie po numerze (sklepu, widocznym w kanale, BL) tylko z pasującym kontaktem; brak numeru i zły kontakt
//     = ten sam 404;
//  4. izolacja dwóch firm (ten sam e-mail i ten sam numer w obu);
//  5. dziennik podglądów: wpis na każde zapytanie, autor = klucz, bez wartości kontaktu i numeru;
//  6. limit zapytań na klucz, błędy wejścia bez echa wartości, brak klucza skrótów = 503;
//  7. historia statusów, przesyłki ze stanem paczki (stały tekst, bez opisu przewoźnika), faktury;
//  8. konta klucza: klucz widzi wyłącznie zamówienia swoich kont (po stronie serwera), `konta` z żądania tylko zawęża;
//  9. klucz obsługi nie dostaje serwera MCP (już przy wejściu).
// Dane wyłącznie fikcyjne (example.test, numery TEST-*), bez sieci.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { Prisma, type MemberRole, type PrismaClient } from '@prisma/client'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { createApiKey, listApiKeys } from '@/lib/api/zarzadzanie'
import { FAKTURA_FIELDS, HISTORIA_FIELDS, OBSLUGA_LINE_FIELDS, OBSLUGA_ORDER_FIELDS, OBSLUGA_PER_MINUTE, resetObslugaLimiters, SHIPMENT_FIELDS } from '@/lib/api/obsluga'
import { CEL_OBSLUGI } from '@/lib/klienci/obsluga'
import { dziennikPodgladow, PODGLAD_AUDIT } from '@/lib/klienci/odczyt'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()
const ENV = { CUSTOMER_DATA_KEYS: `1:${'5'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'd'.repeat(64) }
process.env.CUSTOMER_DATA_KEYS = ENV.CUSTOMER_DATA_KEYS
process.env.CUSTOMER_LOOKUP_KEY = ENV.CUSTOMER_LOOKUP_KEY

const { resetApiLimiters } = await import('@/lib/api/klucze')
const szukaj = await import('@/app/api/v1/obsluga/zamowienia-klienta/route')
const jedno = await import('@/app/api/v1/obsluga/zamowienie/route')
const stany = await import('@/app/api/v1/stany/route')
const lista = await import('@/app/api/v1/zamowienia/route')
const mcp = await import('@/app/api/mcp/route')

const sys = testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
  resetApiLimiters()
  resetObslugaLimiters()
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

let n = 0
async function osoba(org: string, role: MemberRole): Promise<string> {
  n++
  const email = `osoba-${n}-${org}@example.invalid`
  const u = await createUserWithHash(sys, { email, name: email, passwordHash: 'x' })
  await grantMembership(sys, { email, organizationId: org, role })
  return u.id
}

/** Klucz obsługi; bez `konta` = jawnie wszystkie konta firmy. */
async function kluczObslugi(db: PrismaClient, org: string, konta?: string[]): Promise<{ token: string; id: string }> {
  const k = await createApiKey(db, { name: 'Chatbot testowy', scopes: ['obsluga:odczyt'], ...(konta ? { konta } : { wszystkieKonta: true }) }, await osoba(org, 'WLASCICIEL'))
  return { token: k.token, id: k.id }
}

const IP = '198.51.100.9'
function req(p: string, token: string | null, body: unknown): NextRequest {
  const headers: Record<string, string> = { 'x-forwarded-for': IP, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
  return new NextRequest(`http://localhost:3100${p}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body), duplex: 'half' } as never)
}
const postSzukaj = (token: string | null, body: unknown) => szukaj.POST(req('/api/v1/obsluga/zamowienia-klienta', token, body))
const postJedno = (token: string | null, body: unknown) => jedno.POST(req('/api/v1/obsluga/zamowienie', token, body))

const klient = (imie: string, email: string, telefon: string) => ({
  dostawa: { imieNazwisko: imie, firma: null, ulica: 'ul. Fikcyjna 7', numerDomu: null, numerLokalu: null, kodPocztowy: '60-002', miasto: 'Testowo', kraj: 'PL', telefon, email },
  punktOdbioru: null,
  faktura: { nazwa: 'Firma Fikcyjna', nip: '5260001246', ulica: 'ul. Fikcyjna 7', kodPocztowy: '60-002', miasto: 'Testowo', kraj: 'PL' },
  problemy: [],
})

async function zamowienie(db: PrismaClient, pid: string, over: Parameters<typeof order>[1] = {}): Promise<string> {
  return (await ingestOrder(db, order([{ productId: pid, qty: 2 }], over))).orderId!
}
async function zKlientem(db: PrismaClient, orderId: string, imie: string, email: string, telefon: string): Promise<void> {
  const r = await zapiszRekordKlienta(db, orderId, rekordZOdbiorcy(klient(imie, email, telefon) as never), { source: 'RECZNE', fetchedAt: T0, env: ENV })
  expect(r).toBe('ZAPISANO')
}

const ALA = { imie: 'Ala Fikcyjna', email: 'ala.fikcyjna@example.test', telefon: '+48 511 000 111' }
const OLA = { imie: 'Ola Inna', email: 'ola.inna@example.test', telefon: '600 000 222' }

describe('klucz obsługi klienta', () => {
  it('tylko jeden zakres; zakłada osoba z „Dane klienta”; warunek w bazie odrzuca mieszany klucz', async () => {
    const szef = await osoba(ORG_A, 'WLASCICIEL')
    const mag = await osoba(ORG_A, 'MAGAZYN')
    await expect(createApiKey(a, { name: 'x', scopes: ['obsluga:odczyt', 'zamowienia:odczyt'] }, szef)).rejects.toThrow(/nie może mieć innych zakresów/)
    await expect(createApiKey(a, { name: 'x', scopes: ['obsluga:odczyt'] }, mag)).rejects.toThrow(/Dane klienta/)
    await expect(createApiKey(a, { name: 'x', scopes: ['obsluga:odczyt'] }, 'bez-czlonkostwa')).rejects.toThrow(/Dane klienta/)
    const k = await createApiKey(a, { name: 'Chatbot', scopes: ['obsluga:odczyt'], wszystkieKonta: true }, szef)
    expect((await sys.apiKey.findUniqueOrThrow({ where: { id: k.id } })).scopes).toEqual(['obsluga:odczyt'])
    // zwykły klucz bez członkostwa dalej powstaje jak dotąd
    await expect(createApiKey(a, { name: 'y', scopes: ['stany:odczyt'] }, 'bez-czlonkostwa')).resolves.toBeTruthy()
    // zapis z pominięciem walidacji: warunek w bazie
    await expect(sys.apiKey.create({ data: { organizationId: ORG_A, name: 'z', prefix: 'kmp_zzzzzzzz', tokenHash: 'f'.repeat(64), scopes: ['obsluga:odczyt', 'stany:odczyt'], createdBy: szef } })).rejects.toThrow()
    await expect(sys.apiKey.create({ data: { organizationId: ORG_A, name: 'z', prefix: 'kmp_zzzzzzzz', tokenHash: 'e'.repeat(64), scopes: ['nieznany'], createdBy: szef } })).rejects.toThrow()
  })

  it('klucz obsługi nie dostaje innych tras; inny klucz nie dostaje tras obsługi', async () => {
    const { token } = await kluczObslugi(a, ORG_A)
    expect((await stany.GET(new NextRequest('http://localhost:3100/api/v1/stany?sku=X', { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': IP } }))).status).toBe(403)
    expect((await lista.GET(new NextRequest('http://localhost:3100/api/v1/zamowienia', { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': IP } }))).status).toBe(403)
    const zwykly = (await createApiKey(a, { name: 'ogólny', scopes: ['zamowienia:odczyt', 'stany:odczyt', 'produkty:odczyt', 'raporty:odczyt', 'mcp:odczyt'] }, 'u')).token
    const r = await postSzukaj(zwykly, { email: ALA.email })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'Klucz nie ma zakresu obsluga:odczyt' })
    expect((await postJedno(zwykly, { numer: '1', email: ALA.email })).status).toBe(403)
    expect((await postSzukaj(null, { email: ALA.email })).status).toBe(401)
  })
})

describe('zamówienia klienta po e-mailu albo telefonie', () => {
  it('tylko zamówienia tego klienta, pola z listy, bez danych osobowych; telefon w innym zapisie; filtr kont', async () => {
    const pid = await product(a, 'TEST-OBS-1', 100)
    const z1 = await zamowienie(a, pid, { createdAtChannel: new Date('2026-11-01T10:00:00Z') })
    const z2 = await zamowienie(a, pid, { channel: 'ALLEGRO', createdAtChannel: new Date('2026-11-03T10:00:00Z') })
    const zOla = await zamowienie(a, pid)
    const zBez = await zamowienie(a, pid) // bez danych klienta
    await zKlientem(a, z1, ALA.imie, ALA.email, ALA.telefon)
    await zKlientem(a, z2, ALA.imie, ALA.email, ALA.telefon)
    await zKlientem(a, zOla, OLA.imie, OLA.email, OLA.telefon)
    const { token } = await kluczObslugi(a, ORG_A)

    const r = await postSzukaj(token, { email: '  Ala.Fikcyjna@EXAMPLE.test ' })
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const text = await r.text()
    const body = JSON.parse(text) as { zamowienia: Record<string, unknown>[] }
    expect(Object.keys(body)).toEqual(['zamowienia'])
    // najnowsze pierwsze
    const numery = await sys.order.findMany({ where: { id: { in: [z1, z2] } }, select: { id: true, externalId: true } })
    const nr = new Map(numery.map((o) => [o.id, o.externalId]))
    expect(body.zamowienia.map((o) => o.numer)).toEqual([nr.get(z2), nr.get(z1)])
    for (const o of body.zamowienia) {
      expect(Object.keys(o)).toEqual([...OBSLUGA_ORDER_FIELDS])
      for (const l of o.pozycje as Record<string, unknown>[]) expect(Object.keys(l)).toEqual([...OBSLUGA_LINE_FIELDS])
      expect(o.pozycje).toEqual([{ nazwa: 'Towar testowy TEST-OBS-1', ilosc: 2 }])
    }
    for (const zakazane of ['ala', 'Fikcyjna', '511', 'Testowo', '60-002', '5260001246', 'example.test', OLA.email]) expect(text.toLowerCase()).not.toContain(zakazane.toLowerCase())

    const tel = await postSzukaj(token, { telefon: '511-000-111' })
    expect(((await tel.json()) as { zamowienia: unknown[] }).zamowienia).toHaveLength(2)
    const tel2 = await postSzukaj(token, { telefon: '0048511000111' })
    expect(((await tel2.json()) as { zamowienia: unknown[] }).zamowienia).toHaveLength(2)
    // fragment adresu ani inny adres nie pasują (dopasowanie dokładne)
    for (const email of ['ala.fikcyjna@example.tes', 'la.fikcyjna@example.test', 'ala.fikcyjna+1@example.test']) {
      expect(((await (await postSzukaj(token, { email })).json()) as { zamowienia: unknown[] }).zamowienia).toEqual([])
    }
    expect(((await (await postSzukaj(token, { telefon: '511000112' })).json()) as { zamowienia: unknown[] }).zamowienia).toEqual([])

    // filtr kont: tylko Allegro; nieznane konto = pusto
    const allegro = (await (await postSzukaj(token, { email: ALA.email, konta: [{ kanal: 'ALLEGRO', konto: 'allegro' }] })).json()) as { zamowienia: { kanal: string }[] }
    expect(allegro.zamowienia.map((o) => o.kanal)).toEqual(['ALLEGRO'])
    const sklep = (await (await postSzukaj(token, { email: ALA.email, konta: [{ konto: 'sd' }] })).json()) as { zamowienia: { kanal: string }[] }
    expect(sklep.zamowienia.map((o) => o.kanal)).toEqual(['WOO'])
    expect(((await (await postSzukaj(token, { email: ALA.email, konta: [{ kanal: 'WOO', konto: 'allegro' }] })).json()) as { zamowienia: unknown[] }).zamowienia).toEqual([])
    // limit
    expect(((await (await postSzukaj(token, { email: ALA.email, limit: 1 })).json()) as { zamowienia: unknown[] }).zamowienia).toHaveLength(1)
    expect(zBez).toBeTruthy()
  })

  it('dane klienta usunięte (retencja, RODO) nie dają trafienia', async () => {
    const pid = await product(a, 'TEST-OBS-2', 100)
    const z = await zamowienie(a, pid)
    await zKlientem(a, z, ALA.imie, ALA.email, ALA.telefon)
    const { token } = await kluczObslugi(a, ORG_A)
    expect(((await (await postSzukaj(token, { email: ALA.email })).json()) as { zamowienia: unknown[] }).zamowienia).toHaveLength(1)
    await sys.orderCustomer.update({ where: { orderId: z }, data: { purgedAt: new Date() } })
    expect(((await (await postSzukaj(token, { email: ALA.email })).json()) as { zamowienia: unknown[] }).zamowienia).toEqual([])
  })
})

describe('zamówienie po numerze z kontaktem', () => {
  it('numer sklepu, numer widoczny w kanale i numer BL; zły kontakt i brak numeru = ten sam 404', async () => {
    const pid = await product(a, 'TEST-OBS-3', 100)
    const z = await zamowienie(a, pid, { externalId: 'TEST-90001' })
    await sys.order.update({ where: { id: z }, data: { channelNumber: 'TEST-W-501', blOrderId: 7700123 } })
    const zOla = await zamowienie(a, pid, { externalId: 'TEST-90002' })
    await zKlientem(a, z, ALA.imie, ALA.email, ALA.telefon)
    await zKlientem(a, zOla, OLA.imie, OLA.email, OLA.telefon)
    const { token } = await kluczObslugi(a, ORG_A)

    for (const numer of ['TEST-90001', 'TEST-W-501', '7700123', 7700123]) {
      const r = await postJedno(token, { numer, email: ALA.email })
      expect(r.status, String(numer)).toBe(200)
      const body = (await r.json()) as { zamowienia: { numer: string; numerWidoczny: string; numerBl: number }[] }
      expect(body.zamowienia.map((o) => [o.numer, o.numerWidoczny, o.numerBl])).toEqual([['TEST-90001', 'TEST-W-501', 7700123]])
    }
    expect((await postJedno(token, { numer: 'TEST-90001', telefon: '511 000 111' })).status).toBe(200)

    const nieMa = await postJedno(token, { numer: 'TEST-99999', email: ALA.email })
    const zlyKontakt = await postJedno(token, { numer: 'TEST-90001', email: OLA.email })
    const cudzy = await postJedno(token, { numer: 'TEST-90002', email: ALA.email })
    const odpowiedzi = await Promise.all([nieMa, zlyKontakt, cudzy].map(async (r) => ({ status: r.status, body: await r.text(), ct: r.headers.get('content-type'), cc: r.headers.get('cache-control') })))
    expect(new Set(odpowiedzi.map((x) => JSON.stringify(x))).size).toBe(1)
    expect(odpowiedzi[0]).toMatchObject({ status: 404, body: JSON.stringify({ error: 'Nie znaleziono zamówienia' }) })
    // filtr kont też zawęża wynik po numerze
    expect((await postJedno(token, { numer: 'TEST-90001', email: ALA.email, konta: [{ kanal: 'ALLEGRO', konto: 'allegro' }] })).status).toBe(404)
  })

  it('historia statusów, przesyłki i faktury w odpowiedzi', async () => {
    const pid = await product(a, 'TEST-OBS-4', 100)
    const z = await zamowienie(a, pid, { externalId: 'TEST-90010' })
    await zKlientem(a, z, ALA.imie, ALA.email, ALA.telefon)

    const ev = (kind: string, data: object, at: string) => sys.orderEvent.create({ data: { organizationId: ORG_A, orderId: z, kind, actorId: 'user:osoba-tajna', data, createdAt: new Date(at) } })
    await ev('ZBIERANIE', { z: 'DO_REALIZACJI', na: 'ZBIERANIE', wydruk: 3 }, '2026-10-15T09:00:00Z')
    await ev('NOTATKA', { tresc: 'notatka wewnętrzna' }, '2026-10-15T09:30:00Z')
    await ev('ZMIANA_RANGI', { z: 1, na: 2 }, '2026-10-15T09:40:00Z') // liczby (ranga kanału), nie status
    await ev('WYSLANE', { z: 'ZBIERANIE', na: 'WYSLANE', nadanie: 'TESTNR0001' }, '2026-10-15T10:00:00Z')
    await sys.order.update({ where: { id: z }, data: { status: 'WYSLANE', carrier: 'DPD' } })
    const teraz = new Date()
    const s1 = await sys.shipment.create({ data: { organizationId: ORG_A, orderId: z, packageNo: 1, reference: 'ref-obs-1', adapterKey: 'dpd', carrier: 'DPD', state: 'UTWORZONA', trackingNumber: 'TESTNR0001', carrierStatus: 'KOD-PRZEWOZNIKA-1', trackedAt: teraz, createdAt: new Date('2026-10-15T10:00:00Z') } })
    const s2 = await sys.shipment.create({ data: { organizationId: ORG_A, orderId: z, packageNo: 2, reference: 'ref-obs-2', adapterKey: 'inpost', carrier: 'PACZKOMATY', state: 'UTWORZONA', trackingNumber: 'TESTNR0002', trackedAt: new Date('2026-10-15T11:00:00Z'), createdAt: new Date('2026-10-15T10:05:00Z') } })
    await sys.shipment.create({ data: { organizationId: ORG_A, orderId: z, packageNo: 3, reference: 'ref-obs-3', adapterKey: 'dpd', carrier: 'DPD', state: 'ANULOWANA', trackingNumber: 'TESTNR-ANUL' } })
    await sys.shipment.create({ data: { organizationId: ORG_A, orderId: z, packageNo: 4, reference: 'ref-obs-4', adapterKey: 'dpd', carrier: 'DPD', state: 'UTWORZONA' } })
    // odczyt niedawny, ale bez żadnego zdarzenia stanu (nieudana próba u przewoźnika też podbija trackedAt)
    await sys.shipment.create({ data: { organizationId: ORG_A, orderId: z, packageNo: 5, reference: 'ref-obs-5', adapterKey: 'dpd', carrier: 'DPD', state: 'UTWORZONA', trackingNumber: 'TESTNR0005', trackedAt: teraz } })
    // odczyt niedawny, zamówienie wysłane, a ostatni stan paczki dalej „przed nadaniem”
    const s6 = await sys.shipment.create({ data: { organizationId: ORG_A, orderId: z, packageNo: 6, reference: 'ref-obs-6', adapterKey: 'inpost', carrier: 'PACZKOMATY', state: 'UTWORZONA', trackingNumber: 'TESTNR0006', trackedAt: teraz } })
    // stany paczek ze śledzenia: starszy i nowszy dla s1 (wygrywa nowszy), s2 przed nadaniem; opis przewoźnika z danymi odbiorcy nie wychodzi
    await ev('PRZESYLKA_STATUS', { przesylka: s1.id, status: 'KOD-PRZEWOZNIKA-0', stan: 'PRZED_NADANIEM' }, '2026-10-15T11:00:00Z')
    await ev('PRZESYLKA_STATUS', { przesylka: s1.id, status: 'KOD-PRZEWOZNIKA-1', stan: 'PRZEKAZANA', opis: 'Odebrał Odbiorca-Tajny, ul. Tajna 1' }, '2026-10-15T15:45:00Z')
    await ev('PRZESYLKA_STATUS', { przesylka: s2.id, status: 'KOD-PRZEWOZNIKA-2', stan: 'PRZED_NADANIEM' }, '2026-10-15T11:00:00Z')
    await ev('PRZESYLKA_STATUS', { przesylka: s6.id, status: 'KOD-PRZEWOZNIKA-6', stan: 'PRZED_NADANIEM' }, '2026-10-15T11:00:00Z')
    await sys.invoiceAttempt.create({ data: { organizationId: ORG_A, orderId: z, packageNo: 1, attemptNo: 1, idExternal: `${z}/1/1`, state: 'ISSUED', number: 'FV 1/10/2026' } })
    await sys.invoiceAttempt.create({ data: { organizationId: ORG_A, orderId: z, packageNo: 1, attemptNo: 2, idExternal: `${z}/1/2`, state: 'FAILED', number: 'FV-NIEUDANA' } })
    const { token } = await kluczObslugi(a, ORG_A)
    const r = await postJedno(token, { numer: 'TEST-90010', email: ALA.email })
    const text = await r.text()
    const o = (JSON.parse(text) as { zamowienia: Record<string, unknown>[] }).zamowienia[0]!
    expect(o.status).toBe('WYSLANE')
    expect(o.numerNadania).toBe('TESTNR0001')
    expect(o.historia).toEqual([
      { status: 'DO_REALIZACJI', statusNazwa: 'Do realizacji', kiedy: T0.toISOString() },
      { status: 'ZBIERANIE', statusNazwa: 'Zbieranie', kiedy: '2026-10-15T09:00:00.000Z' },
      { status: 'WYSLANE', statusNazwa: 'Wysłane', kiedy: '2026-10-15T10:00:00.000Z' },
    ])
    for (const h of o.historia as Record<string, unknown>[]) expect(Object.keys(h)).toEqual([...HISTORIA_FIELDS])
    const p = o.przesylki as Record<string, unknown>[]
    expect(p).toHaveLength(5) // anulowana pominięta
    for (const x of p) expect(Object.keys(x)).toEqual([...SHIPMENT_FIELDS])
    expect(p[0]).toEqual({
      przewoznik: 'DPD',
      numerNadania: 'TESTNR0001',
      stan: 'PRZEKAZANA',
      stanNazwa: 'U przewoźnika, w drodze',
      stanOd: '2026-10-15T15:45:00.000Z',
      sprawdzono: teraz.toISOString(),
      sledzona: true,
      linkSledzenia: 'https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=TESTNR0001',
      rodzaj: 'GLOWNA',
    })
    // sprawdzana dawno = Kompletor jej już nie odświeża
    expect(p[1]).toMatchObject({ przewoznik: 'PACZKOMATY', numerNadania: 'TESTNR0002', stan: 'UTWORZONA', stanNazwa: 'Etykieta utworzona, paczka czeka na kuriera', stanOd: '2026-10-15T11:00:00.000Z', sledzona: false })
    // bez odczytu u przewoźnika: stan pusty
    expect(p[2]).toMatchObject({ przewoznik: 'DPD', numerNadania: null, stan: null, stanNazwa: null, stanOd: null, sprawdzono: null, sledzona: false, linkSledzenia: null })
    // świeża próba odczytu bez zdarzenia stanu: nie śledzona (stan nieznany, nie świeży)
    expect(p[3]).toMatchObject({ numerNadania: 'TESTNR0005', stan: null, sprawdzono: teraz.toISOString(), sledzona: false })
    // zamówienie wysłane, paczka dalej przed nadaniem: stan nie jest pewny
    expect(p[4]).toMatchObject({ numerNadania: 'TESTNR0006', stan: 'UTWORZONA', sprawdzono: teraz.toISOString(), sledzona: false })
    expect(o.faktury).toEqual([{ numer: 'FV 1/10/2026', wystawiono: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }])
    for (const f of o.faktury as Record<string, unknown>[]) expect(Object.keys(f)).toEqual([...FAKTURA_FIELDS])
    for (const zakazane of ['osoba-tajna', 'notatka', 'FV-NIEUDANA', 'wydruk', 'Odbiorca-Tajny', 'Tajna 1', 'KOD-PRZEWOZNIKA', 'TESTNR-ANUL']) expect(text).not.toContain(zakazane)
  })
})

describe('izolacja firm', () => {
  it('ten sam e-mail i numer w dwóch firmach: klucz widzi tylko swoją firmę', async () => {
    const pa = await product(a, 'TEST-OBS-5', 100)
    const pb = await product(b, 'TEST-OBS-5', 100)
    const za = await zamowienie(a, pa, { externalId: 'TEST-91000', totalGross: 11 })
    const zb = await zamowienie(b, pb, { externalId: 'TEST-91000', totalGross: 22 })
    await zKlientem(a, za, ALA.imie, ALA.email, ALA.telefon)
    await zKlientem(b, zb, ALA.imie, ALA.email, ALA.telefon)
    const ka = await kluczObslugi(a, ORG_A)
    const kb = await kluczObslugi(b, ORG_B)
    const sumy = async (t: string, body: unknown, f = postSzukaj) => ((await (await f(t, body)).json()) as { zamowienia: { sumaBrutto: number }[] }).zamowienia.map((o) => o.sumaBrutto)
    expect(await sumy(ka.token, { email: ALA.email })).toEqual([11])
    expect(await sumy(kb.token, { email: ALA.email })).toEqual([22])
    expect(await sumy(ka.token, { numer: 'TEST-91000', email: ALA.email }, postJedno)).toEqual([11])
    expect(await sumy(kb.token, { numer: 'TEST-91000', telefon: ALA.telefon }, postJedno)).toEqual([22])
    // ślady tylko w firmie klucza
    expect(await a.auditLog.count({ where: { entity: PODGLAD_AUDIT, actorId: `api:${kb.id}` } })).toBe(0)
    expect(await b.auditLog.count({ where: { entity: PODGLAD_AUDIT, actorId: `api:${kb.id}` } })).toBe(2)
  })
})

describe('dziennik, limity, błędy', () => {
  it('każde zapytanie = jeden wpis bez wartości kontaktu i numeru', async () => {
    const pid = await product(a, 'TEST-OBS-6', 100)
    const z = await zamowienie(a, pid, { externalId: 'TEST-92000' })
    await zKlientem(a, z, ALA.imie, ALA.email, ALA.telefon)
    const { token, id } = await kluczObslugi(a, ORG_A)
    await postSzukaj(token, { email: ALA.email })
    await postSzukaj(token, { telefon: OLA.telefon })
    await postJedno(token, { numer: 'TEST-92000', email: ALA.email })
    await postJedno(token, { numer: 'TEST-92000', email: OLA.email })
    const wpisy = await sys.auditLog.findMany({ where: { entity: PODGLAD_AUDIT, actorId: `api:${id}` }, orderBy: { createdAt: 'asc' } })
    expect(wpisy.map((w) => [w.entityId, w.after])).toEqual([
      ['wyszukiwanie', { cel: CEL_OBSLUGI, trasa: 'zamowienia-klienta', rodzaj: 'email', trafienia: 1 }],
      ['wyszukiwanie', { cel: CEL_OBSLUGI, trasa: 'zamowienia-klienta', rodzaj: 'telefon', trafienia: 0 }],
      ['wyszukiwanie', { cel: CEL_OBSLUGI, trasa: 'zamowienie', rodzaj: 'email', trafienia: 1 }],
      ['wyszukiwanie', { cel: CEL_OBSLUGI, trasa: 'zamowienie', rodzaj: 'email', trafienia: 0 }],
    ])
    const raw = JSON.stringify(wpisy.map((w) => [w.entityId, w.after]))
    for (const zakazane of [ALA.email, OLA.email, '511000111', '600000222', 'TEST-92000']) expect(raw).not.toContain(zakazane)
  })

  it(`limit ${OBSLUGA_PER_MINUTE} zapytań na minutę na klucz, potem 429; inny klucz bez zmian`, async () => {
    const k1 = await kluczObslugi(a, ORG_A)
    const k2 = await kluczObslugi(a, ORG_A)
    for (let i = 0; i < OBSLUGA_PER_MINUTE; i++) expect((await postSzukaj(k1.token, { email: 'zly' })).status).toBe(400)
    const r = await postSzukaj(k1.token, { email: ALA.email })
    expect(r.status).toBe(429)
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await postJedno(k1.token, { numer: '1', email: ALA.email })).status).toBe(429)
    expect((await postSzukaj(k2.token, { email: ALA.email })).status).toBe(200)
  })

  it('błędy wejścia 400 bez echa wartości; za duża treść 413; brak klucza skrótów 503', async () => {
    const { token } = await kluczObslugi(a, ORG_A)
    const bledy: [unknown, (typeof postSzukaj)][] = [
      [{ email: 'tajny-adres-bez-malpy' }, postSzukaj],
      [{ telefon: '12345' }, postSzukaj],
      [{ email: ALA.email, telefon: ALA.telefon }, postSzukaj],
      [{}, postSzukaj],
      [{ email: ALA.email, imie: 'Ala' }, postSzukaj],
      [{ email: ALA.email, limit: 999 }, postSzukaj],
      [{ email: ALA.email, konta: [{ konto: 'sd', ulica: 'x' }] }, postSzukaj],
      [{ email: ALA.email, konta: [{ kanal: 'NIEZNANY', konto: 'sd' }] }, postSzukaj],
      [{ email: ALA.email }, postJedno],
      [{ numer: 'TEST 1; DROP', email: ALA.email }, postJedno],
      [{ numer: 'TEST-1', email: ALA.email, limit: 5 }, postJedno],
      ['nie json', postSzukaj],
    ]
    for (const [body, f] of bledy) {
      const r = await f(token, body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      const t = await r.text()
      for (const zakazane of ['tajny-adres', ALA.email, '12345', 'DROP', 'Ala']) expect(t).not.toContain(zakazane)
    }
    expect((await postSzukaj(token, JSON.stringify({ email: ALA.email, x: 'a'.repeat(5000) }))).status).toBe(413)
    vi.stubEnv('CUSTOMER_LOOKUP_KEY', '')
    try {
      const r = await postSzukaj(token, { email: ALA.email })
      expect(r.status).toBe(503)
    } finally {
      vi.unstubAllEnvs()
      process.env.CUSTOMER_LOOKUP_KEY = ENV.CUSTOMER_LOOKUP_KEY
    }
  })
})

describe('historia bez zmiany statusu', () => {
  it('zamówienie z samą zmianą przewoźnika albo samą zamianą produktu: obecny status z czasem złożenia', async () => {
    const pid = await product(a, 'TEST-OBS-5', 100)
    const z1 = await zamowienie(a, pid, { externalId: 'TEST-90030' })
    const z2 = await zamowienie(a, pid, { externalId: 'TEST-90031' })
    await zKlientem(a, z1, ALA.imie, ALA.email, ALA.telefon)
    await zKlientem(a, z2, ALA.imie, ALA.email, ALA.telefon)
    await sys.orderEvent.create({ data: { organizationId: ORG_A, orderId: z1, kind: 'SPOSOB_WYSYLKI_ZMIENIONY', actorId: 'panel', data: { z: 'DPD', na: 'INPOST' }, createdAt: new Date('2026-10-15T09:00:00Z') } })
    await sys.orderEvent.create({ data: { organizationId: ORG_A, orderId: z2, kind: 'ZAMIANA_PRODUKTU', actorId: 'panel', data: { z: 'produkt-a', na: 'produkt-b', units: 1 }, createdAt: new Date('2026-10-15T09:00:00Z') } })
    const { token } = await kluczObslugi(a, ORG_A)
    for (const numer of ['TEST-90030', 'TEST-90031']) {
      const o = ((await (await postJedno(token, { numer, email: ALA.email })).json()) as { zamowienia: Record<string, unknown>[] }).zamowienia[0]!
      expect(o.status, numer).toBe('DO_REALIZACJI')
      expect(o.historia, numer).toEqual([{ status: 'DO_REALIZACJI', statusNazwa: 'Do realizacji', kiedy: T0.toISOString() }])
    }
  })
})

describe('konta klucza obsługi', () => {
  it('zakładanie: konkretne konta albo jawnie wszystkie, nie oba; konto musi istnieć; klucz ogólny bez kont', async () => {
    const szef = await osoba(ORG_A, 'WLASCICIEL')
    const obs = (extra: object) => createApiKey(a, { name: 'Chatbot', scopes: ['obsluga:odczyt'], ...extra }, szef)
    await expect(obs({})).rejects.toThrow(/zaznacz konta sprzedaży/)
    await expect(obs({ konta: [] })).rejects.toThrow(/zaznacz konta sprzedaży/)
    await expect(obs({ konta: ['WOO:sd'], wszystkieKonta: 'tak' })).rejects.toThrow(/nie oba/)
    for (const zle of ['WOO:nieznane', 'NIEZNANY:sd', 'sd', 'WOO:', 'AI:sd']) await expect(obs({ konta: [zle] }), zle).rejects.toThrow(/Nieznane konto/)
    await expect(createApiKey(a, { name: 'ogólny', scopes: ['stany:odczyt'], konta: ['WOO:sd'] }, szef)).rejects.toThrow(/tylko dla klucza obsługi/)
    await expect(createApiKey(a, { name: 'ogólny', scopes: ['stany:odczyt'], wszystkieKonta: 'tak' }, szef)).rejects.toThrow(/tylko dla klucza obsługi/)

    const k = await obs({ konta: ['WOO:sd', 'ALLEGRO:allegro', 'WOO:sd'] })
    const row = await sys.apiKey.findUniqueOrThrow({ where: { id: k.id } })
    expect(row.accounts).toEqual({ konta: expect.arrayContaining([{ kanal: 'WOO', konto: 'sd' }, { kanal: 'ALLEGRO', konto: 'allegro' }]) })
    expect((row.accounts as { konta: unknown[] }).konta).toHaveLength(2)
    const w = await obs({ wszystkieKonta: 'tak' })
    expect((await sys.apiKey.findUniqueOrThrow({ where: { id: w.id } })).accounts).toEqual({ wszystkie: true })
    const ogolny = await createApiKey(a, { name: 'ogólny', scopes: ['stany:odczyt'] }, szef)
    expect((await sys.apiKey.findUniqueOrThrow({ where: { id: ogolny.id } })).accounts).toBeNull()
    const audit = await sys.auditLog.findFirstOrThrow({ where: { entity: 'ApiKey', entityId: w.id } })
    expect(audit.after).toMatchObject({ konta: { wszystkie: true } })
    const lista = new Map((await listApiKeys(a)).map((x) => [x.id, x.konta]))
    expect(lista.get(w.id)).toEqual({ wszystkie: true })
    expect(lista.get(k.id)).toMatchObject({ wszystkie: false })
    expect(lista.get(ogolny.id)).toBeNull()
  })

  it('klucz konta A nie widzi zamówień konta B tej samej firmy: po e-mailu, telefonie i numerze; parametr nie poszerza', async () => {
    const pid = await product(a, 'TEST-OBS-6', 100)
    const zSklep = await zamowienie(a, pid, { externalId: 'TEST-90040' })
    const zAllegro = await zamowienie(a, pid, { channel: 'ALLEGRO', externalId: 'TEST-90041' })
    await sys.order.update({ where: { id: zAllegro }, data: { channelNumber: 'TEST-WIDOCZNY-41', blOrderId: 7700141 } })
    await zKlientem(a, zSklep, ALA.imie, ALA.email, ALA.telefon)
    await zKlientem(a, zAllegro, ALA.imie, ALA.email, ALA.telefon)
    const { token } = await kluczObslugi(a, ORG_A, ['WOO:sd'])
    const kanaly = async (body: object) =>
      ((await (await postSzukaj(token, body)).json()) as { zamowienia: { kanal: string; numer: string }[] }).zamowienia.map((o) => `${o.kanal}:${o.numer}`)

    expect(await kanaly({ email: ALA.email })).toEqual(['WOO:TEST-90040'])
    expect(await kanaly({ telefon: ALA.telefon })).toEqual(['WOO:TEST-90040'])
    // próba poszerzenia: konto spoza klucza = pusto, jak brak danych
    expect(await kanaly({ email: ALA.email, konta: [{ kanal: 'ALLEGRO', konto: 'allegro' }] })).toEqual([])
    expect(await kanaly({ email: ALA.email, konta: [{ konto: 'allegro' }] })).toEqual([])
    expect(await kanaly({ email: ALA.email, konta: [{ konto: 'sd' }, { konto: 'allegro' }] })).toEqual(['WOO:TEST-90040'])
    expect(await kanaly({ email: ALA.email, konta: [{ kanal: 'ALLEGRO', konto: 'sd' }] })).toEqual([])

    const brak = await (await postJedno(token, { numer: 'TEST-NIE-ISTNIEJE', email: ALA.email })).text()
    const numery: unknown[] = ['TEST-90041', 'TEST-WIDOCZNY-41', 7700141, '7700141']
    for (const numer of numery) {
      for (const extra of [{}, { konta: [{ kanal: 'ALLEGRO', konto: 'allegro' }] }]) {
        const r = await postJedno(token, { numer, email: ALA.email, ...extra })
        expect(r.status, String(numer)).toBe(404)
        expect(await r.text()).toBe(brak)
      }
    }
    expect((await postJedno(token, { numer: 'TEST-90041', telefon: ALA.telefon })).status).toBe(404)
    expect((await postJedno(token, { numer: 'TEST-90040', email: ALA.email })).status).toBe(200)
  })

  it('klucz „wszystkie konta firmy” widzi każde konto; parametr zawęża', async () => {
    const pid = await product(a, 'TEST-OBS-7', 100)
    const zSklep = await zamowienie(a, pid, { externalId: 'TEST-90050' })
    const zLampy = await zamowienie(a, pid, { channel: 'WOO_LAMPY', externalId: 'TEST-90051' })
    const zAllegro = await zamowienie(a, pid, { channel: 'ALLEGRO', externalId: 'TEST-90052' })
    for (const z of [zSklep, zLampy, zAllegro]) await zKlientem(a, z, ALA.imie, ALA.email, ALA.telefon)
    const { token } = await kluczObslugi(a, ORG_A)
    const numery = async (body: object) => ((await (await postSzukaj(token, body)).json()) as { zamowienia: { numer: string }[] }).zamowienia.map((o) => o.numer).sort()
    expect(await numery({ email: ALA.email })).toEqual(['TEST-90050', 'TEST-90051', 'TEST-90052'])
    expect(await numery({ email: ALA.email, konta: [{ konto: 'lampy' }] })).toEqual(['TEST-90051'])
  })

  it('klucz obsługi bez zapisanych kont albo z uszkodzoną wartością nie widzi niczego', async () => {
    const pid = await product(a, 'TEST-OBS-8', 100)
    const z = await zamowienie(a, pid, { externalId: 'TEST-90060' })
    await zKlientem(a, z, ALA.imie, ALA.email, ALA.telefon)
    const { token, id } = await kluczObslugi(a, ORG_A, ['WOO:sd'])
    expect(((await (await postSzukaj(token, { email: ALA.email })).json()) as { zamowienia: unknown[] }).zamowienia).toHaveLength(1)
    for (const accounts of [Prisma.DbNull, { wszystkie: 'tak' }, { konta: 'WOO:sd' }, []]) {
      await sys.apiKey.update({ where: { id }, data: { accounts: accounts as never } })
      expect(((await (await postSzukaj(token, { email: ALA.email })).json()) as { zamowienia: unknown[] }).zamowienia, JSON.stringify(accounts)).toEqual([])
      expect((await postJedno(token, { numer: 'TEST-90060', email: ALA.email })).status).toBe(404)
    }
  })
})

describe('klucz obsługi a serwer MCP', () => {
  it('odmowa 403 już przy wejściu, także dla listy narzędzi', async () => {
    const { token } = await kluczObslugi(a, ORG_A)
    for (const method of ['initialize', 'tools/list', 'ping']) {
      const r = await mcp.POST(
        new NextRequest('http://localhost:3100/api/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': IP, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
          duplex: 'half',
        } as never),
      )
      expect(r.status, method).toBe(403)
      expect(await r.text()).not.toContain('inputSchema')
    }
  })
})

describe('dziennik podglądów: filtr autora', () => {
  it('„ludzie” bez wpisów kluczy API, „klucze” tylko one', async () => {
    const { token } = await kluczObslugi(a, ORG_A)
    await postSzukaj(token, { email: ALA.email })
    await a.auditLog.create({ data: { entity: PODGLAD_AUDIT, entityId: 'zamowienie-testowe', actorId: 'osoba-testowa', after: { cel: 'PODGLAD' } } })
    expect((await dziennikPodgladow(a, { autor: 'ludzie' })).map((w) => w.kto)).toEqual(['osoba-testowa'])
    expect((await dziennikPodgladow(a, { autor: 'klucze' })).every((w) => w.kto.startsWith('api:'))).toBe(true)
    expect(await dziennikPodgladow(a, { autor: 'klucze' })).toHaveLength(1)
    expect(await dziennikPodgladow(a)).toHaveLength(2)
  })
})
