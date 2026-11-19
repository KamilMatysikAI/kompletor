// Odbiorca na żądanie na bazie: bramka (wyłącznik instancji, konto w PRACY), jawne „BRAK” dla kanałów bez
// źródła, ślad AuditLog bez danych i dowód, że fikcyjne dane odbiorcy nie zostają w żadnej tabeli (AuditLog, Alert,
// OrderEvent, Job, ChannelOrderSnapshot, Order.flags i cała reszta) ani w logach konsoli — przy sukcesie i przy błędzie.
// Izolacja dwóch firm. Atrapa kanału zamiast sieci, dane wyłącznie zmyślone.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, PrismaClient } from '@prisma/client'
import { AdapterError, type OrderRecipient } from '@/lib/adaptery/kontrakt'
import { FakeChannelState, fakeDefinition } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { BladOdczytuOdbiorcy, BrakZamowieniaOdbiorcy, ODBIORCA_AUDIT_ENTITY, OdmowaOdczytuOdbiorcy, pobierzOdbiorce, type PobierzOdbiorceDeps } from '@/lib/odbiorca/pobierz'
import { TempoOdbiorcy } from '@/lib/odbiorca/tempo'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { seedBase } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

// Fikcyjny odbiorca: wartości unikalne, łatwe do wyszukania w całej bazie i w logach.
const NAZWISKO = 'Zofia Zmyślona-Odbiorczyni'
const TELEFON = '600999111'
const EMAIL = 'zofia.zmyslona@example.invalid'
const ULICA = 'ul. Wymyślona 77'
const NIP = '9999999999'
const SZUKANE = [NAZWISKO, TELEFON, EMAIL, ULICA, NIP]

const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: NAZWISKO, firma: null, ulica: ULICA, numerDomu: null, numerLokalu: null, kodPocztowy: '00-950', miasto: 'Zmyślonowo', kraj: 'PL', telefon: TELEFON, email: EMAIL },
  punktOdbioru: { kod: 'ZMY01M', nazwa: 'Paczkomat zmyślony' },
  faktura: { nazwa: 'Firma Zmyślona', nip: NIP, ulica: ULICA, kodPocztowy: '00-950', miasto: 'Zmyślonowo', kraj: 'PL' },
  problemy: ['adres_bez_podzialu'],
}

const T = new Date('2026-11-02T10:00:00.000Z')
const ON = { DANE_ODBIORCY_Z_KANALU: '1' }

let state: FakeChannelState
let registry: AdapterRegistry
let logs: string[]
const deps = (over: Partial<PobierzOdbiorceDeps> = {}): PobierzOdbiorceDeps => ({ registry, secrets: { env: ON, envFallback: false }, actorId: 'user-test', powod: 'PRZESYLKA', now: () => T, ...over })

async function konto(d: PrismaClient, org: string, channel: Channel, channelAccountId: string, data: { statusMode?: 'CIEN' | 'PRACA'; adapterKey?: string; active?: boolean }) {
  await d.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: org, channel, channelAccountId } }, data })
}

async function zamowienie(d: PrismaClient, channel: Channel, channelAccountId: string, externalId: string): Promise<string> {
  const o = await d.order.create({ data: { channel, channelAccountId, externalId, paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: 50, createdAtChannel: T } })
  return o.id
}

/** Cała baza testów (wszystkie firmy, klient systemowy), każdy wiersz każdej tabeli jako tekst. */
async function trafieniaWBazie(): Promise<string[]> {
  const s = testSystemDb()
  const tables = await s.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  const hits: string[] = []
  for (const { tablename } of tables) {
    const rows = await s.$queryRawUnsafe<{ r: string }[]>(`SELECT t::text AS r FROM "${tablename}" t`)
    for (const { r } of rows) for (const x of SZUKANE) if (r.includes(x)) hits.push(`${tablename}: ${x}`)
  }
  return hits
}

const trafieniaWLogach = () => logs.filter((l) => SZUKANE.some((x) => l.includes(x)))

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
  state = new FakeChannelState()
  registry = new AdapterRegistry([fakeDefinition(state, 'WOO', 'fake.v1', { recipient: true }), fakeDefinition(new FakeChannelState(), 'EMPIK', 'fakebez.v1')])
  await konto(db, ORG_A, 'WOO', 'sd', { adapterKey: 'fake.v1', statusMode: 'PRACA' })
  logs = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message} ${x.stack ?? ''}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
    })
  }
})
afterEach(() => vi.restoreAllMocks())

describe('skan bazy i logów', () => {
  it('kontrola: skan widzi dane wpisane w Alert, Order.flags i log (inaczej „nic nie znaleziono” nic nie dowodzi)', async () => {
    const id = await zamowienie(db, 'WOO', 'sd', '900')
    await db.alert.create({ data: { kind: 'TEST', ref: 'x', message: `odbiorca ${TELEFON}` } })
    await db.order.update({ where: { id }, data: { flags: { notatka: NAZWISKO } } })
    console.info(`test ${EMAIL}`)
    expect(await trafieniaWBazie()).toEqual(expect.arrayContaining(['Alert: 600999111', `Order: ${NAZWISKO}`]))
    expect(trafieniaWLogach()).toHaveLength(1)
  })
})

describe('odczyt w PRACY', () => {
  it('sukces: odbiorca tylko w wyniku; jeden wiersz AuditLog bez danych; nic w bazie ani w logach', async () => {
    const id = await zamowienie(db, 'WOO', 'sd', '901')
    state.recipients.set('901', ODBIORCA)
    const w = await pobierzOdbiorce(db, id, deps())
    // PRZESYLKA dostaje dostawę i punkt odbioru, bez danych faktury
    expect(w).toEqual({ zrodlo: 'KANAL', kanal: 'WOO/sd', odbiorca: { ...ODBIORCA, faktura: null } })
    expect(state.recipientCalls).toBe(1)
    const audit = await db.auditLog.findMany({ where: { entity: ODBIORCA_AUDIT_ENTITY } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ entityId: id, actorId: 'user-test', before: null, after: { powod: 'PRZESYLKA', kanal: 'WOO/sd', wynik: 'OK', problemy: 1 } })
    // drugi odczyt czyta kanał znowu (bez pamięci podręcznej) i daje drugi ślad
    const f = await pobierzOdbiorce(db, id, deps({ powod: 'FAKTURA' }))
    // FAKTURA dostaje dane faktury i adres, bez telefonu, e-maila i punktu odbioru
    expect(f).toEqual({ zrodlo: 'KANAL', kanal: 'WOO/sd', odbiorca: { ...ODBIORCA, dostawa: { ...ODBIORCA.dostawa!, telefon: null, email: null }, punktOdbioru: null } })
    expect(state.recipientCalls).toBe(2)
    expect(await db.auditLog.count({ where: { entity: ODBIORCA_AUDIT_ENTITY, entityId: id } })).toBe(2)
    expect(await trafieniaWBazie()).toEqual([])
    expect(trafieniaWLogach()).toEqual([])
  })

  it('błąd odczytu: log i ślad bez treści odpowiedzi kanału, wyjątek bez danych; nic w bazie', async () => {
    const id = await zamowienie(db, 'WOO', 'sd', '902')
    // nieostrożny adapter: komunikat z danymi z odpowiedzi kanału — host nie może go nigdzie przepuścić
    state.recipientFailures.push(new AdapterError(`kanał odpowiedział: ${NAZWISKO}, ${TELEFON}, ${EMAIL}`, 'PRZEJSCIOWY'))
    const e = await pobierzOdbiorce(db, id, deps()).then(() => null, (x: unknown) => x)
    expect(e).toBeInstanceOf(BladOdczytuOdbiorcy)
    expect(e).toMatchObject({ kanal: 'WOO/sd', rodzaj: 'PRZEJSCIOWY', klasa: 'AdapterError' })
    expect((e as Error).cause).toBeUndefined()
    for (const x of SZUKANE) expect(`${(e as Error).message} ${(e as Error).stack}`).not.toContain(x)
    expect(logs.some((l) => l.includes('[odbiorca]') && l.includes('WOO/sd'))).toBe(true)
    // nieczytelne dane z kanału: ten sam tor
    state.corruptedRecipients.add('902')
    await expect(pobierzOdbiorce(db, id, deps())).rejects.toMatchObject({ rodzaj: 'TRWALY', klasa: 'UnreadableDataError' })
    const audit = await db.auditLog.findMany({ where: { entity: ODBIORCA_AUDIT_ENTITY }, orderBy: { createdAt: 'asc' } })
    expect(audit.map((a) => (a.after as Record<string, unknown>)['wynik'])).toEqual(['BLAD', 'BLAD'])
    expect(await trafieniaWBazie()).toEqual([])
    expect(trafieniaWLogach()).toEqual([])
  })

  it('limit tempa konta przed odczytem; przekroczony = BladOdczytuOdbiorcy PRZEJSCIOWY, bez wywołania kanału', async () => {
    const id = await zamowienie(db, 'WOO', 'sd', '903')
    state.recipients.set('903', ODBIORCA)
    const klucze: string[] = []
    const tempo = new TempoOdbiorcy(() => 0, async () => undefined)
    const czekaj = tempo.czekaj.bind(tempo)
    tempo.czekaj = async (klucz, odstep, maks) => {
      klucze.push(klucz)
      // atrapa kanału nie deklaruje odstępu: wymuszamy 60 s, jak Mirakl OR11
      return czekaj(klucz, odstep || 60_000, maks ?? 60_000)
    }
    await pobierzOdbiorce(db, id, deps({ tempo }))
    await pobierzOdbiorce(db, id, deps({ tempo }))
    expect(klucze).toEqual([`${ORG_A}:WOO/sd`, `${ORG_A}:WOO/sd`])
    const e = await pobierzOdbiorce(db, id, deps({ tempo })).then(() => null, (x: unknown) => x)
    expect(e).toBeInstanceOf(BladOdczytuOdbiorcy)
    expect(e).toMatchObject({ rodzaj: 'PRZEJSCIOWY', klasa: 'TempoPrzekroczone' })
    expect(state.recipientCalls).toBe(2)
    const audit = await db.auditLog.findMany({ where: { entity: ODBIORCA_AUDIT_ENTITY }, orderBy: { createdAt: 'asc' } })
    expect(audit.map((a) => (a.after as Record<string, unknown>)['wynik'])).toEqual(['OK', 'OK', 'BLAD'])
  })
})

describe('bramka', () => {
  it('konto w cieniu: odmowa i zero wywołań atrapy (adapter nawet nie powstaje)', async () => {
    await konto(db, ORG_A, 'WOO', 'sd', { statusMode: 'CIEN' })
    const id = await zamowienie(db, 'WOO', 'sd', '903')
    state.recipients.set('903', ODBIORCA)
    await expect(pobierzOdbiorce(db, id, deps())).rejects.toMatchObject({ name: 'OdmowaOdczytuOdbiorcy', przyczyna: 'CIEN' })
    expect(state.recipientCalls).toBe(0)
    const a = await db.auditLog.findFirstOrThrow({ where: { entity: ODBIORCA_AUDIT_ENTITY } })
    expect(a.after).toEqual({ powod: 'PRZESYLKA', kanal: 'WOO/sd', wynik: 'ODMOWA', przyczyna: 'CIEN' })
  })

  it('konto nieaktywne albo bez konfiguracji: odmowa bez odczytu', async () => {
    await konto(db, ORG_A, 'WOO', 'sd', { active: false })
    const id = await zamowienie(db, 'WOO', 'sd', '904')
    await expect(pobierzOdbiorce(db, id, deps())).rejects.toMatchObject({ przyczyna: 'KONTO_NIEAKTYWNE' })
    const obce = await zamowienie(db, 'WOO', 'nieznane', '905')
    await expect(pobierzOdbiorce(db, obce, deps())).rejects.toMatchObject({ przyczyna: 'KONTO_NIEZNANE' })
    expect(state.recipientCalls).toBe(0)
  })

  it('brak DANE_ODBIORCY_Z_KANALU=1: odmowa bez odczytu; zła wartość = błąd', async () => {
    const id = await zamowienie(db, 'WOO', 'sd', '906')
    state.recipients.set('906', ODBIORCA)
    for (const env of [{}, { DANE_ODBIORCY_Z_KANALU: '0' }]) {
      await expect(pobierzOdbiorce(db, id, deps({ secrets: { env, envFallback: false } }))).rejects.toBeInstanceOf(OdmowaOdczytuOdbiorcy)
    }
    await expect(pobierzOdbiorce(db, id, deps({ secrets: { env: { DANE_ODBIORCY_Z_KANALU: 'tak' }, envFallback: false } }))).rejects.toThrow(/DANE_ODBIORCY_Z_KANALU/)
    expect(state.recipientCalls).toBe(0)
  })

  it('powód i aktor obowiązkowe', async () => {
    const id = await zamowienie(db, 'WOO', 'sd', '907')
    await expect(pobierzOdbiorce(db, id, deps({ powod: undefined as never }))).rejects.toThrow(/powód/)
    await expect(pobierzOdbiorce(db, id, deps({ actorId: ' ' }))).rejects.toThrow(/actorId/)
    expect(state.recipientCalls).toBe(0)
  })
})

describe('brak źródła', () => {
  it('EASYTOOLS, ręczne i BL_INNE: jawne BRAK, bez wyjątku i bez odczytu; ślad BRAK', async () => {
    for (const [ch, acc] of [['EASYTOOLS', 'et'], ['RECZNE', 'panel'], ['BL_INNE', 'bl']] as const) {
      const id = await zamowienie(db, ch, acc, `X-${ch}`)
      expect(await pobierzOdbiorce(db, id, deps())).toEqual({ zrodlo: 'BRAK', kanal: `${ch}/${acc}`, przyczyna: 'KANAL_BEZ_ZRODLA' })
    }
    expect(await db.auditLog.count({ where: { entity: ODBIORCA_AUDIT_ENTITY } })).toBe(3)
    expect(state.recipientCalls).toBe(0)
  })

  it('adapter bez zdolności orders.recipient: BRAK, nie pusty adres', async () => {
    await konto(db, ORG_A, 'EMPIK', 'empik', { adapterKey: 'fakebez.v1', statusMode: 'PRACA' })
    const id = await zamowienie(db, 'EMPIK', 'empik', 'E-1')
    expect(await pobierzOdbiorce(db, id, deps())).toEqual({ zrodlo: 'BRAK', kanal: 'EMPIK/empik', przyczyna: 'ADAPTER_BEZ_ZDOLNOSCI' })
  })
})

describe('izolacja firm', () => {
  it('firma B nie czyta odbiorcy zamówienia firmy A ani jej śladu; każda czyta swój kanał', async () => {
    const idA = await zamowienie(db, 'WOO', 'sd', '911')
    state.recipients.set('911', ODBIORCA)
    await expect(pobierzOdbiorce(dbB, idA, deps())).rejects.toBeInstanceOf(BrakZamowieniaOdbiorcy)
    expect(state.recipientCalls).toBe(0)

    // firma B: to samo konto „sd”, ale w cieniu — jej ustawienia, nie firmy A, decydują
    const idB = await zamowienie(dbB, 'WOO', 'sd', '911')
    await konto(dbB, ORG_B, 'WOO', 'sd', { adapterKey: 'fake.v1' })
    await expect(pobierzOdbiorce(dbB, idB, deps())).rejects.toMatchObject({ przyczyna: 'CIEN' })
    expect(state.recipientCalls).toBe(0)

    await pobierzOdbiorce(db, idA, deps())
    expect(await db.auditLog.count({ where: { entity: ODBIORCA_AUDIT_ENTITY } })).toBe(1)
    expect(await dbB.auditLog.count({ where: { entity: ODBIORCA_AUDIT_ENTITY } })).toBe(1) // tylko własna odmowa
    expect(await dbB.auditLog.count({ where: { entity: ODBIORCA_AUDIT_ENTITY, entityId: idA } })).toBe(0)
    expect(await trafieniaWBazie()).toEqual([])
  })
})

