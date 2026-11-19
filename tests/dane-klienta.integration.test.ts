// na bazie: zapis danych klienta z kolejki (atrapa kanału), idempotencja i nowa rewizja, bramka cienia,
// brak klucza, uprawnienia (Magazyn tylko skrót), dziennik podglądów, wyszukiwanie po skrótach, izolacja dwóch firm
// (RLS), retencja RAPORT i USUWAJ, rotacja klucza, przesyłka i faktura z bazy i z fallbackiem, KSeF z nabywcą z bazy.
// Po każdym scenariuszu skan wszystkich tabel poza OrderCustomer i wszystkich wywołań console pod kątem fikcyjnych
// wartości. Dane wyłącznie fikcyjne, zero połączeń z kanałami.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberRole, PrismaClient } from '@prisma/client'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { FakeChannelState, fakeDefinition } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { KLIENT_ZAPIS_JOB } from '@/lib/klienci/kolejka'
import { daneKlienta, dziennikPodgladow, PODGLAD_AUDIT, powodBrakuKlienta, szukajPoKliencie } from '@/lib/klienci/odczyt'
import { przebiegRetencji, usunDaneKlientow } from '@/lib/klienci/retencja'
import { reencryptCustomers } from '@/lib/klienci/szyfr'
import { zapiszUstawieniaKlientow } from '@/lib/klienci/ustawienia'
import { kontrahentFaktury, nabywcaKsef, odbiorcaPrzesylki } from '@/lib/klienci/wejscia'
import { wykonajZapisKlienta, zapiszRekordKlienta, ZAPIS_AUDIT } from '@/lib/klienci/zapis'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { NABYWCA_ZASTEPCZY, prepareKsefForOrder } from '@/lib/ksef/szkice'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { drukujKarty } from '@/lib/stanowisko/karty'
import { utworzZlecenie, zapiszWynik } from '@/lib/druk/zlecenia'
import { drukarka, stanowiskoZTokenem } from './druk-pomocnicze'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'

vi.mock('server-only', () => ({}))
import { order, product, seedBase } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const NAZWISKO = 'Jan Testowy'
const ULICA = 'ul. Fikcyjna 17'
const EMAIL = 'jan@example.test'
const TELEFON = '+48 500 000 000'
const NIP = '5260001246'
const SZUKANE = [NAZWISKO, ULICA, EMAIL, TELEFON, '500000000', NIP, 'Testowa Spółka']

const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: NAZWISKO, firma: null, ulica: ULICA, numerDomu: '17', numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL', telefon: TELEFON, email: EMAIL },
  punktOdbioru: { kod: 'POZ01M', nazwa: 'Paczkomat testowy' },
  faktura: { nazwa: 'Testowa Spółka z o.o.', nip: NIP, ulica: ULICA, kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL' },
  problemy: [],
}

const K1 = '1'.repeat(64)
const K2 = '2'.repeat(64)
const ENV = { DANE_KLIENTA_ZAPIS: '1', CUSTOMER_DATA_KEYS: `1:${K1}`, CUSTOMER_LOOKUP_KEY: 'a'.repeat(64) }
const T = new Date('2026-11-04T10:00:00.000Z')

let state: FakeChannelState
let registry: AdapterRegistry
let logs: string[]
const secrets = (env: Record<string, string> = ENV) => ({ env, envFallback: false })
const ids: Record<string, string> = {}

async function osoba(email: string, role: MemberRole, org = ORG_A): Promise<string> {
  const u = await createUserWithHash(sys, { email, name: email, passwordHash: 'x' })
  await grantMembership(sys, { email, organizationId: org, role })
  return u.id
}

async function przyjmij(c: PrismaClient, externalId: string, over: Parameters<typeof order>[1] = {}): Promise<string> {
  const pid = await product(c, `HERB-${Math.random().toString(36).slice(2, 8)}`, 50)
  const r = await ingestOrder(c, { ...order([{ productId: pid, qty: 1 }], { createdAtChannel: T, ...over }), externalId }, { now: T })
  return r.orderId!
}

/** Zadania KLIENT_ZAPIS firmy wykonane po kolei (jak worker). */
async function wykonajKolejke(c: PrismaClient, env: Record<string, string> = ENV): Promise<number> {
  let n = 0
  for (const j of await c.job.findMany({ where: { kind: KLIENT_ZAPIS_JOB, status: 'PENDING' }, orderBy: { createdAt: 'asc' } })) {
    try {
      await wykonajZapisKlienta(c, j.payload, { registry, secrets: secrets(env) })
      await c.job.update({ where: { id: j.id }, data: { status: 'DONE', dedupeKey: null } })
    } catch (e) {
      await c.job.update({ where: { id: j.id }, data: { status: 'FAILED', dedupeKey: null, lastError: e instanceof Error ? e.message : String(e) } })
    }
    n++
  }
  return n
}

async function trafieniaWBazie(): Promise<string[]> {
  const tables = await sys.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'OrderCustomer'`
  const hits: string[] = []
  for (const { tablename } of tables) {
    const rows = await sys.$queryRawUnsafe<{ r: string }[]>(`SELECT t::text AS r FROM "${tablename}" t`)
    for (const { r } of rows) for (const x of SZUKANE) if (r.includes(x)) hits.push(`${tablename}: ${x}`)
  }
  // OrderCustomer: szyfrogram i skróty, nigdy jawne wartości
  for (const { r } of await sys.$queryRawUnsafe<{ r: string }[]>(`SELECT t::text AS r FROM "OrderCustomer" t`)) for (const x of SZUKANE) if (r.includes(x)) hits.push(`OrderCustomer: ${x}`)
  return hits
}
const trafieniaWLogach = () => logs.filter((l) => SZUKANE.some((x) => l.includes(x)))

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
  vi.stubEnv('DANE_KLIENTA_ZAPIS', '1')
  state = new FakeChannelState()
  registry = new AdapterRegistry([fakeDefinition(state, 'WOO', 'fake.v1', { recipient: true })])
  for (const c of [db, dbB]) await c.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { adapterKey: 'fake.v1', statusMode: 'PRACA' } })
  ids.biuro = await osoba('biuro@firma-a.test', 'BIURO')
  ids.magazyn = await osoba('magazyn@firma-a.test', 'MAGAZYN')
  ids.wlasciciel = await osoba('wlasciciel@firma-a.test', 'WLASCICIEL')
  ids.biuroB = await osoba('biuro@firma-b.test', 'BIURO', ORG_B)
  logs = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message} ${x.stack ?? ''}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
    })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('zapis przy przyjęciu', () => {
  it('nowe zamówienie: zadanie z samym orderId w transakcji, worker zapisuje szyfrogram i skróty; nic jawnego w bazie i logach', async () => {
    state.recipients.set('W-1', ODBIORCA)
    const id = await przyjmij(db, 'W-1')
    const job = await db.job.findFirstOrThrow({ where: { kind: KLIENT_ZAPIS_JOB } })
    expect(job.payload).toEqual({ orderId: id })
    expect(await powodBrakuKlienta(db, id, ENV)).toBe('W_KOLEJCE')
    await wykonajKolejke(db)
    const row = await db.orderCustomer.findUniqueOrThrow({ where: { orderId: id } })
    expect(row).toMatchObject({ source: 'KANAL', revision: 1, keyVersion: 1 })
    expect(row.emailHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.phoneHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.nipHash).toMatch(/^[0-9a-f]{64}$/)
    expect(state.recipientCalls).toBe(1)
    expect(await trafieniaWBazie()).toEqual([])
    expect(trafieniaWLogach()).toEqual([])
  })

  it('idempotencja: powtórka nadpisuje (revision + 1); nowa rewizja z kanału = nowe zadanie; ta sama rewizja = bez zadania', async () => {
    state.recipients.set('W-2', ODBIORCA)
    const id = await przyjmij(db, 'W-2')
    await wykonajKolejke(db)
    await wykonajZapisKlienta(db, { orderId: id }, { registry, secrets: secrets() })
    expect((await db.orderCustomer.findUniqueOrThrow({ where: { orderId: id } })).revision).toBe(2)
    // starszy odczyt nie nadpisuje nowszego
    await wykonajZapisKlienta(db, { orderId: id }, { registry, secrets: secrets(), now: () => new Date(Date.now() - 24 * 3600_000) })
    expect((await db.orderCustomer.findUniqueOrThrow({ where: { orderId: id } })).revision).toBe(2)
    const zam = await db.order.findUniqueOrThrow({ where: { id } })
    const pid = await product(db, 'HERB-REW', 50)
    const base = { ...order([{ productId: pid, qty: 1 }], { createdAtChannel: T }), externalId: 'W-2', channelAccountId: zam.channelAccountId }
    await ingestOrder(db, { ...base, externalRevision: '2' }, { now: T })
    expect(await db.job.count({ where: { kind: KLIENT_ZAPIS_JOB, status: 'PENDING' } })).toBe(1)
    await wykonajKolejke(db)
    expect((await db.orderCustomer.findUniqueOrThrow({ where: { orderId: id } })).revision).toBe(3)
    await ingestOrder(db, { ...base, externalRevision: '2', eventKey: 'inny-klucz' }, { now: T })
    expect(await db.job.count({ where: { kind: KLIENT_ZAPIS_JOB, status: 'PENDING' } })).toBe(0)
  })

  it('wyłączona instancja (DANE_KLIENTA_ZAPIS puste): bez zadania; kanały bez źródła: bez wiersza i bez błędu', async () => {
    vi.stubEnv('DANE_KLIENTA_ZAPIS', '')
    const id = await przyjmij(db, 'W-3')
    expect(await db.job.count()).toBe(0)
    expect(await powodBrakuKlienta(db, id, {})).toBe('ZAPIS_WYLACZONY')
    vi.stubEnv('DANE_KLIENTA_ZAPIS', '1')
    const r = await przyjmij(db, 'R-1', { channel: 'RECZNE' })
    await wykonajKolejke(db)
    expect(await db.orderCustomer.count()).toBe(0)
    expect(await db.job.count({ where: { status: 'FAILED' } })).toBe(0)
    expect(await powodBrakuKlienta(db, r, ENV)).toBe('RECZNE_DO_WPISANIA')
  })

  it('konto w cieniu: bez ustawienia firmy brak zapisu i zapytania kanału; z „zapisem w cieniu” zapis', async () => {
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'CIEN' } })
    state.recipients.set('C-1', ODBIORCA)
    const id = await przyjmij(db, 'C-1')
    await wykonajKolejke(db)
    expect(await db.orderCustomer.count()).toBe(0)
    expect(state.recipientCalls).toBe(0)
    expect(await powodBrakuKlienta(db, id, ENV)).toBe('CIEN')
    await zapiszUstawieniaKlientow(db, { zapisWCieniu: true, retencjaZFakturaLat: 5, retencjaBezFakturyMiesiecy: 36, trybRetencji: 'RAPORT' }, ids.wlasciciel!)
    await wykonajZapisKlienta(db, { orderId: id }, { registry, secrets: secrets(), now: () => T })
    expect(await db.orderCustomer.count()).toBe(1)
    // PRZESYLKA i FAKTURA w cieniu bez zmian: odmowa (bramka)
    await db.orderCustomer.deleteMany()
    const p = await odbiorcaPrzesylki(db, id, { modul: 'wysylka', registry, secrets: secrets({ ...ENV, DANE_KLIENTA_ZAPIS: '0', DANE_ODBIORCY_Z_KANALU: '1' }) }).catch((e: Error) => e.name)
    expect(p).toBe('OdmowaOdczytuOdbiorcy')
  })

  it('brak klucza: odmowa bez danych w błędzie, ślad KLIENT_ZAPIS z klasą; reszta systemu działa', async () => {
    state.recipients.set('K-1', ODBIORCA)
    const id = await przyjmij(db, 'K-1')
    await wykonajKolejke(db, { DANE_KLIENTA_ZAPIS: '1', CUSTOMER_LOOKUP_KEY: 'a'.repeat(64) })
    const job = await db.job.findFirstOrThrow({ where: { kind: KLIENT_ZAPIS_JOB } })
    expect(job.status).toBe('FAILED')
    expect(job.lastError).toMatch(/CUSTOMER_DATA_KEYS/)
    expect((await db.auditLog.findFirstOrThrow({ where: { entity: ZAPIS_AUDIT, entityId: id } })).after).toMatchObject({ wynik: 'BLAD', klasa: 'BrakKluczaKlientow' })
    expect(await db.orderCustomer.count()).toBe(0)
    expect(await powodBrakuKlienta(db, id, ENV)).toBe('BLAD_ODCZYTU')
    // błąd trwały kanału (zamówienia nie ma): jeden ślad, zadanie bez ponowień
    const id2 = await przyjmij(db, 'K-2')
    await wykonajKolejke(db)
    expect((await db.auditLog.findFirstOrThrow({ where: { entity: ZAPIS_AUDIT, entityId: id2 } })).after).toMatchObject({ wynik: 'BLAD', rodzaj: 'TRWALY' })
    expect(await trafieniaWBazie()).toEqual([])
    expect(trafieniaWLogach()).toEqual([])
  })

  it('rekord RECZNE nie jest nadpisywany automatem', async () => {
    state.recipients.set('M-1', ODBIORCA)
    const id = await przyjmij(db, 'M-1')
    await zapiszRekordKlienta(db, id, rekordZOdbiorcy({ ...ODBIORCA, problemy: [] }), { source: 'RECZNE', fetchedAt: T, env: ENV })
    await wykonajKolejke(db)
    expect(state.recipientCalls).toBe(0)
    expect(await db.orderCustomer.findUniqueOrThrow({ where: { orderId: id } })).toMatchObject({ source: 'RECZNE', revision: 1 })
  })
})

describe('odczyt wg uprawnień i dziennik podglądów', () => {
  it('Biuro: pełny rekord; Magazyn prosi o PELNY i dostaje sam skrót; obcy = odmowa; każdy odczyt = wpis bez wartości', async () => {
    state.recipients.set('O-1', ODBIORCA)
    const id = await przyjmij(db, 'O-1')
    await wykonajKolejke(db)
    const pelny = await daneKlienta(db, id, { actorId: ids.biuro!, zakres: 'PELNY', cel: 'PODGLAD', env: ENV })
    expect(pelny.stan).toBe('PELNY')
    if (pelny.stan === 'PELNY') expect(pelny.rekord.dostawa?.ulica).toBe(ULICA)
    const mag = await daneKlienta(db, id, { actorId: ids.magazyn!, zakres: 'PELNY', cel: 'PODGLAD', env: ENV })
    expect(mag).toMatchObject({ stan: 'SKROT', skrot: { imie: 'Jan', nazwiskoSkrot: 'T.', miasto: 'Poznań' } })
    expect(JSON.stringify(mag)).not.toContain(ULICA)
    expect(JSON.stringify(mag)).not.toContain(EMAIL)
    expect(await daneKlienta(db, id, { actorId: ids.magazyn!, zakres: 'PELNY', cel: 'KOPIA', env: ENV })).toEqual({ stan: 'BEZ_UPRAWNIEN' })
    expect(await daneKlienta(db, id, { actorId: ids.biuroB!, zakres: 'PELNY', cel: 'PODGLAD', env: ENV })).toEqual({ stan: 'BEZ_UPRAWNIEN' })
    expect(await daneKlienta(db, id, { actorId: 'system:raporty', zakres: 'PELNY', cel: 'PODGLAD', env: ENV })).toEqual({ stan: 'BEZ_UPRAWNIEN' })
    expect(await daneKlienta(db, id, { actorId: ids.biuro!, zakres: 'PELNY', cel: 'PODGLAD', env: {} })).toEqual({ stan: 'BRAK_KLUCZA' })
    const wpisy = await db.auditLog.findMany({ where: { entity: PODGLAD_AUDIT }, orderBy: { createdAt: 'asc' } })
    expect(wpisy.map((w) => [w.actorId === ids.biuro ? 'biuro' : w.actorId === ids.magazyn ? 'magazyn' : w.actorId, (w.after as { zakres: string }).zakres])).toEqual([
      ['biuro', 'PELNY'],
      ['magazyn', 'SKROT'],
      ['magazyn', 'PELNY'],
      [ids.biuroB, 'PELNY'],
      ['system:raporty', 'PELNY'],
      ['biuro', 'PELNY'],
    ])
    expect(wpisy.every((w) => w.entityId === id)).toBe(true)
    expect((await dziennikPodgladow(db, { actorId: ids.magazyn })).map((w) => w.cel).sort()).toEqual(['KOPIA', 'PODGLAD'])
    expect(await trafieniaWBazie()).toEqual([])
    expect(trafieniaWLogach()).toEqual([])
  })
})

describe('wyszukiwanie', () => {
  it('po e-mailu i telefonie w każdym zapisie; nazwisko = INNA_FRAZA; jeden wpis bez frazy; Magazyn bez wyszukiwania', async () => {
    state.recipients.set('S-1', ODBIORCA)
    const id = await przyjmij(db, 'S-1')
    await wykonajKolejke(db)
    for (const f of ['0048500000000', '500 000 000', ' JAN@example.test ']) expect(await szukajPoKliencie(db, f, { actorId: ids.biuro!, env: ENV })).toMatchObject({ stan: 'OK', orderIds: [id] })
    expect(await szukajPoKliencie(db, 'Testowy', { actorId: ids.biuro!, env: ENV })).toEqual({ stan: 'INNA_FRAZA' })
    expect(await szukajPoKliencie(db, '500 000 000', { actorId: ids.magazyn!, env: ENV })).toEqual({ stan: 'BEZ_UPRAWNIEN' })
    const wpisy = await db.auditLog.findMany({ where: { entity: PODGLAD_AUDIT, entityId: 'wyszukiwanie' } })
    expect(wpisy).toHaveLength(3)
    expect(wpisy.every((w) => JSON.stringify(w.after) === JSON.stringify({ cel: 'WYSZUKIWANIE', trafienia: 1 }))).toBe(true)
    expect(await trafieniaWBazie()).toEqual([])
  })

  it('izolacja firm (RLS): firma B nie widzi wiersza A ani przez wyszukiwanie po tym samym telefonie', async () => {
    state.recipients.set('I-1', ODBIORCA)
    const idA = await przyjmij(db, 'I-1')
    await wykonajKolejke(db)
    expect(await dbB.orderCustomer.count()).toBe(0)
    expect(await dbB.orderCustomer.findUnique({ where: { orderId: idA } })).toBeNull()
    expect(await szukajPoKliencie(dbB, TELEFON, { actorId: ids.biuroB!, env: ENV })).toMatchObject({ stan: 'OK', orderIds: [] })
    expect(await daneKlienta(dbB, idA, { actorId: ids.biuroB!, zakres: 'PELNY', cel: 'PODGLAD', env: ENV })).toEqual({ stan: 'BRAK' })
    // ten sam klient w firmie B: osobny wiersz z innym skrótem (HMAC z firmą)
    const idB = await przyjmij(dbB, 'I-1')
    await wykonajKolejke(dbB)
    const [a, b] = await Promise.all([db.orderCustomer.findUniqueOrThrow({ where: { orderId: idA } }), dbB.orderCustomer.findUniqueOrThrow({ where: { orderId: idB } })])
    expect(a.phoneHash).not.toBe(b.phoneHash)
    await expect(db.orderCustomer.create({ data: { organizationId: ORG_B, orderId: idB, keyVersion: 1, ciphertext: new Uint8Array(1), iv: new Uint8Array(12), authTag: new Uint8Array(16), source: 'RECZNE', fetchedAt: T } })).rejects.toThrow()
  })
})

describe('retencja i usuwanie', () => {
  it('RAPORT liczy po terminie bez usuwania; USUWAJ czyści szyfrogram i skróty, jeden AuditLog z liczbą; dane nie wracają z kanału', async () => {
    state.recipients.set('R-2', ODBIORCA)
    const id = await przyjmij(db, 'R-2')
    await wykonajKolejke(db)
    await db.order.update({ where: { id }, data: { status: 'ANULOWANE' } })
    const pozniej = new Date(Date.now() + 40 * 31 * 24 * 3600_000)
    const r1 = await przebiegRetencji(db, ENV, { now: pozniej })
    expect(r1).toMatchObject({ tryb: 'RAPORT', poTerminie: 1, usuniete: 0 })
    expect((await db.customerDataSettings.findFirstOrThrow()).ostatniPoTerminie).toBe(1)
    expect((await db.orderCustomer.findUniqueOrThrow({ where: { orderId: id } })).purgedAt).toBeNull()
    await zapiszUstawieniaKlientow(db, { zapisWCieniu: false, retencjaZFakturaLat: 5, retencjaBezFakturyMiesiecy: 36, trybRetencji: 'USUWAJ' }, ids.wlasciciel!)
    const r2 = await przebiegRetencji(db, ENV, { now: pozniej })
    expect(r2).toMatchObject({ tryb: 'USUWAJ', usuniete: 1, bledy: 0 })
    const row = await db.orderCustomer.findUniqueOrThrow({ where: { orderId: id } })
    expect(row).toMatchObject({ emailHash: null, phoneHash: null, nipHash: null })
    expect(row.purgedAt).not.toBeNull()
    expect(await daneKlienta(db, id, { actorId: ids.biuro!, zakres: 'PELNY', cel: 'PODGLAD', env: ENV })).toMatchObject({ stan: 'USUNIETE' })
    expect((await db.auditLog.findFirstOrThrow({ where: { entity: 'KLIENT_USUNIECIE' } })).after).toEqual({ powod: 'RETENCJA', liczba: 1, bledy: 0 })
    await wykonajZapisKlienta(db, { orderId: id }, { registry, secrets: secrets(), now: () => new Date() })
    expect((await db.orderCustomer.findUniqueOrThrow({ where: { orderId: id } })).purgedAt).not.toBeNull()
    expect(await szukajPoKliencie(db, EMAIL, { actorId: ids.biuro!, env: ENV })).toMatchObject({ orderIds: [] })
  })

  it('usunięcie jednego klienta (RODO art. 17) w partii nie rusza innych', async () => {
    for (const x of ['U-1', 'U-2']) state.recipients.set(x, ODBIORCA)
    const a = await przyjmij(db, 'U-1')
    const b = await przyjmij(db, 'U-2')
    await wykonajKolejke(db)
    expect(await usunDaneKlientow(db, ENV, { where: { purgedAt: null, orderId: a }, now: T })).toEqual({ usuniete: 1, bledy: 0 })
    expect((await db.orderCustomer.findUniqueOrThrow({ where: { orderId: b } })).purgedAt).toBeNull()
  })
})

describe('rotacja kluczy', () => {
  it('reencryptCustomers: wpisy v1 → v2, odczyt po usunięciu v1 z env; nowy CUSTOMER_LOOKUP_KEY = przeliczone skróty', async () => {
    state.recipients.set('Z-1', ODBIORCA)
    const id = await przyjmij(db, 'Z-1')
    await wykonajKolejke(db)
    const env2 = { ...ENV, CUSTOMER_DATA_KEYS: `2:${K2},1:${K1}`, CUSTOMER_LOOKUP_KEY: 'b'.repeat(64) }
    const r = await reencryptCustomers(db, ORG_A, env2, { skroty: true })
    expect(r).toMatchObject({ keyVersion: 2, przeszyfrowane: 1, przeliczoneSkroty: 1, pozostale: 0 })
    const tylkoV2 = { ...env2, CUSTOMER_DATA_KEYS: `2:${K2}` }
    expect((await daneKlienta(db, id, { actorId: ids.biuro!, zakres: 'PELNY', cel: 'PODGLAD', env: tylkoV2 })).stan).toBe('PELNY')
    expect(await szukajPoKliencie(db, EMAIL, { actorId: ids.biuro!, env: tylkoV2 })).toMatchObject({ orderIds: [id] })
    expect(await szukajPoKliencie(db, EMAIL, { actorId: ids.biuro!, env: ENV })).toMatchObject({ orderIds: [] })
    await expect(reencryptCustomers(db, ORG_B, env2)).rejects.toThrow(/innej firmy/)
  })

  it('uszkodzony wpis nie zatrzymuje rotacji: licznik błędów, reszta przeszyfrowana, log bez danych', async () => {
    for (const ext of ['Z-2', 'Z-3']) state.recipients.set(ext, ODBIORCA)
    const zly = await przyjmij(db, 'Z-2')
    const dobry = await przyjmij(db, 'Z-3')
    await wykonajKolejke(db)
    await db.orderCustomer.update({ where: { orderId: zly }, data: { authTag: Buffer.alloc(16) } })
    const env2 = { ...ENV, CUSTOMER_DATA_KEYS: `2:${K2},1:${K1}` }
    const r = await reencryptCustomers(db, ORG_A, env2)
    expect(r).toMatchObject({ keyVersion: 2, przeszyfrowane: 1, bledy: 1, pozostale: 1 })
    expect((await db.orderCustomer.findUniqueOrThrow({ where: { orderId: dobry } })).keyVersion).toBe(2)
    expect(logs.some((l) => l.includes(zly))).toBe(true)
    expect(trafieniaWLogach()).toEqual([])
  })
})

describe('przesyłka, faktura i KSeF z bazy', () => {
  it('przesyłka z bazy bez danych faktury, faktura bez punktu i kontaktu; ślad system:<moduł>', async () => {
    state.recipients.set('P-1', ODBIORCA)
    const id = await przyjmij(db, 'P-1')
    await wykonajKolejke(db)
    const calls = state.recipientCalls
    const p = await odbiorcaPrzesylki(db, id, { modul: 'wysylka', registry, secrets: secrets() })
    expect(p.zrodlo).toBe('BAZA')
    expect(p.przejscie).toMatchObject({ ok: true, wartosc: { ulica: ULICA, numerDomu: '17', telefon: TELEFON } })
    const f = await kontrahentFaktury(db, id, { modul: 'faktury', registry, secrets: secrets() })
    expect(f).toMatchObject({ zrodlo: 'BAZA', przejscie: { ok: true, wartosc: { name: 'Testowa Spółka z o.o.', nip: NIP } } })
    expect(JSON.stringify(f)).not.toContain(EMAIL)
    expect(state.recipientCalls).toBe(calls)
    const aktorzy = (await db.auditLog.findMany({ where: { entity: PODGLAD_AUDIT, entityId: id } })).map((w) => [w.actorId, (w.after as { cel: string }).cel])
    expect(aktorzy).toEqual([
      ['system:wysylka', 'PRZESYLKA'],
      ['system:faktury', 'FAKTURA'],
    ])
  })

  it('fallback: brak wiersza → odczyt z kanału z zapisem; zapis wyłączony → odczyt na żądanie bez zapisu', async () => {
    vi.stubEnv('DANE_KLIENTA_ZAPIS', '')
    state.recipients.set('F-1', ODBIORCA)
    const id = await przyjmij(db, 'F-1')
    const z = await odbiorcaPrzesylki(db, id, { modul: 'wysylka', registry, secrets: secrets() })
    expect(z.zrodlo).toBe('KANAL')
    expect(await db.orderCustomer.count()).toBe(1)
    await db.orderCustomer.deleteMany()
    const bez = await kontrahentFaktury(db, id, { modul: 'faktury', registry, secrets: secrets({ ...ENV, DANE_KLIENTA_ZAPIS: '0', DANE_ODBIORCY_Z_KANALU: '1' }) })
    expect(bez).toMatchObject({ zrodlo: 'KANAL', przejscie: { ok: true } })
    expect(await db.orderCustomer.count()).toBe(0)
    expect(await trafieniaWBazie()).toEqual([])
    expect(trafieniaWLogach()).toEqual([])
  })

  it('KSeF: nabywca z bazy sprawdzany (zły NIP = problem), XML szkicu dalej z nabywcą zastępczym; bez danych = zastępczy', async () => {
    await sys.organization.update({
      where: { id: ORG_A },
      data: { settings: { faktury: { program: 'ksef' }, ksef: { sprzedawca: { nip: '1111111111', nazwa: 'Sprzedawca Fikcyjny', adres: { linia1: 'ul. Sprzedażna 1', linia2: '00-001 Warszawa' } }, seriaKod: 'FV' } } },
    })
    state.recipients.set('Q-1', ODBIORCA)
    const id = await przyjmij(db, 'Q-1', { wantInvoiceNip: true, totalGross: 10 })
    expect(await nabywcaKsef(db, id, ENV)).toBeNull()
    const bez = await prepareKsefForOrder(db, id, { now: T })
    expect(bez).toMatchObject({ wynik: 'przygotowana', nabywca: 'ZASTEPCZY' })
    await wykonajKolejke(db)
    vi.stubEnv('CUSTOMER_DATA_KEYS', ENV.CUSTOMER_DATA_KEYS)
    expect(await nabywcaKsef(db, id)).toMatchObject({ nip: NIP, nazwa: 'Testowa Spółka z o.o.' })
    const z = await prepareKsefForOrder(db, id, { now: T })
    expect(z).toMatchObject({ wynik: 'przygotowana', nabywca: 'BAZA' })
    if (z.wynik === 'przygotowana') expect(z.problemy.filter((p) => p.pole?.startsWith('Podmiot2'))).toEqual([])
    await zapiszRekordKlienta(db, id, rekordZOdbiorcy({ ...ODBIORCA, faktura: { ...ODBIORCA.faktura!, nip: '1234567890' } }), { source: 'RECZNE', fetchedAt: new Date(), env: ENV })
    const zly = await prepareKsefForOrder(db, id, { now: T })
    if (zly.wynik === 'przygotowana') expect(zly.problemy.map((p) => p.kod)).toContain('nip-zly')
    const szkic = await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: id } })
    expect(szkic.xml ?? '').not.toContain('Testowa')
    expect(JSON.stringify(szkic.problems)).not.toContain('1234567890')
    expect(NABYWCA_ZASTEPCZY).toBeTruthy()
    expect(await trafieniaWBazie()).toEqual([])
  })
})

async function tekstPdf(pdf: Buffer): Promise<string> {
  const zadanie = getDocument({ data: new Uint8Array(pdf), useSystemFonts: false })
  const d = await zadanie.promise
  let out = ''
  for (let i = 1; i <= d.numPages; i++) out += (await (await d.getPage(i)).getTextContent()).items.map((x) => ('str' in x ? x.str : '')).join(' ')
  await zadanie.destroy()
  return out.replace(/\s+/g, ' ')
}

describe('wydruk karty', () => {
  it('pełny adres z klienci.dane, skrót dla Magazynu; ślad WYDRUK; plik karty znika z bazy po wyniku druku', async () => {
    state.recipients.set('48213', ODBIORCA)
    const id = await przyjmij(db, '48213')
    await wykonajKolejke(db)
    vi.stubEnv('CUSTOMER_DATA_KEYS', ENV.CUSTOMER_DATA_KEYS) // wydruk czyta klucz z env procesu (jak panel)
    const biuro = await tekstPdf((await drukujKarty(db, [id], { userId: ids.biuro!, nazwa: 'Biuro' })).pdf)
    expect(biuro).toContain('ODBIORCA')
    expect(biuro).toContain(ULICA)
    const mag = await tekstPdf((await drukujKarty(db, [id], { userId: ids.magazyn!, nazwa: 'Magazyn' })).pdf)
    expect(mag).toContain('Odbiorca: Jan T., Poznań')
    expect(mag).not.toContain('Testowy')
    expect(mag).not.toContain(ULICA)
    expect(mag).not.toContain(TELEFON)
    const cele = (await db.auditLog.findMany({ where: { entity: PODGLAD_AUDIT, entityId: id }, orderBy: { createdAt: 'asc' } })).map((w) => (w.after as { cel: string; zakres: string }).zakres)
    expect(cele).toEqual(['PELNY', 'SKROT'])
    // serwer druku: bajty karty (mogą mieć adres) usunięte zaraz po wyniku, nie po 7 dniach
    const st = await stanowiskoZTokenem(db)
    await db.printStation.update({ where: { id: st.id }, data: { printers: [drukarka('A4')], lastReportAt: new Date() } })
    const pdf = (await drukujKarty(db, [id], { userId: ids.biuro!, nazwa: 'Biuro' })).pdf
    const w = await utworzZlecenie(db, { stationId: st.id, typ: 'karta', zrodlo: 'PANEL', rola: 'A4', klucz: 'k-1', kto: ids.biuro!, orderIds: [id], rysuj: async () => ({ pliki: { pdf } }) })
    expect(await db.printJobFile.count({ where: { jobId: w.zlecenie.id } })).toBe(1)
    await zapiszWynik(db, st.id, w.zlecenie.id, { wynik: 'OK' }, new Date())
    expect(await db.printJobFile.count({ where: { jobId: w.zlecenie.id } })).toBe(0)
    expect(await trafieniaWBazie()).toEqual([])
    expect(trafieniaWLogach()).toEqual([])
  })
})
