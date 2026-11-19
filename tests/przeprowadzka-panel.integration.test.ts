// przeprowadzka z BaseLinkera z panelu, braki wobec polecenia (wybór katalogu, pomijanie źródeł, pełne
// listy spraw, raport Markdown do pobrania), „Przejście z BaseLinkera zakończone” (bramka trybu pracy firmy po
// przeprowadzce; ACME zostaje za wyłącznikiem EKRANY_PRACA) i resztki.
// BL wyłącznie jako atrapa (tests/bl-przeprowadzka-atrapa.ts), zero zapisów poza bazą testową.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`)
  },
  notFound: () => {
    throw new Error('NOT_FOUND')
  },
}))
const uprawnienia = { lista: new Set<string>() }
vi.mock('@/lib/panel/kontekst', () => ({
  requirePermission: async (p: string) => {
    if (!uprawnienia.lista.has(p)) throw new Error('NOT_FOUND')
    return { db: kontekstDb.db, user: { id: 'u-test' }, permissions: uprawnienia.lista }
  },
}))
const kontekstDb: { db: unknown } = { db: null }

import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { firmaPrzechodziZBl, ODMOWA_KATALOG_PRZED } from '@/lib/kanaly/firma'
import { blokadaInstancji, zmienTrybKonta } from '@/lib/kanaly/tryb'
import { listaStartu } from '@/lib/start/lista'
import { cofnijZakonczenie, ENCJA_ZAKONCZENIA, stanZakonczenia, zakonczPrzejscie } from '@/lib/przeprowadzka/zakonczenie'
import {
  katalogFirmy,
  katalogZFormularza,
  kontaWPracy,
  mapaFirmy,
  mapaZFormularza,
  ODMOWA_PO_ZAKONCZENIU,
  PRZERWANY_MS,
  PrzeprowadzkaError,
  przytnijRaporty,
  RAPORTY_W_BAZIE,
  raportPrzebiegu,
  stanPanelu,
  wykonajPrzeprowadzkeZPanelu,
  zapiszMapeFirmy,
  usunTokenBl,
  zapiszTokenBl,
  zlecPrzeprowadzke,
} from '@/lib/przeprowadzka/z-panelu'
import { RODZAJ_PRZEBIEGU } from '@/lib/przeprowadzka/zapis'
import { AtrapaBlPrzeprowadzki, NOW, PII_SENTINELS } from './bl-przeprowadzka-atrapa'
import { ORG_B, testDb, truncateAll } from './db'
import { ACME_PRESET } from './preset-testowy'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
kontekstDb.db = db
const registry = defaultRegistry()
const ENV = { APP_MODE: 'self-host', APP_ENCRYPTION_KEYS: `1:${'4'.repeat(64)}` }
const SEKRETY = { env: ENV, envFallback: false }
const TOKEN = '3001-abcdef0123456789'

afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

beforeEach(async () => {
  await truncateAll()
  uprawnienia.lista = new Set()
})

/** Decyzje, bez których atrapa blokuje import (status 5 i metoda „Poczta Polska”). */
function decyzjeAtrapy(): FormData {
  const f = new FormData()
  f.set('status:5', 'DO_REALIZACJI')
  f.set('przewoznik:Poczta Polska', 'BRAK')
  return f
}

async function proba(atrapa: AtrapaBlPrzeprowadzki) {
  const run = await zlecPrzeprowadzke(db, { zapisz: false, actorId: 'u-test', now: new Date() })
  await wykonajPrzeprowadzkeZPanelu(db, { runId: run }, { registry, secrets: SEKRETY, bl: () => atrapa.client(), now: NOW })
  return run
}

async function importuj(atrapa: AtrapaBlPrzeprowadzki) {
  const run = await zlecPrzeprowadzke(db, { zapisz: true, actorId: 'u-test', now: new Date() })
  await wykonajPrzeprowadzkeZPanelu(db, { runId: run }, { registry, secrets: SEKRETY, bl: () => atrapa.client(), now: NOW })
  return run
}

/** Pełna przeprowadzka na atrapie: klucz, decyzje, próba, import. */
async function przeprowadz(atrapa = new AtrapaBlPrzeprowadzki()) {
  await zapiszTokenBl(db, TOKEN, 'u-test', ENV)
  await zapiszMapeFirmy(db, mapaZFormularza(decyzjeAtrapy(), await mapaFirmy(db)), 'u-test')
  await proba(atrapa)
  expect((await stanPanelu(db)).proba!.s!.powodyOdmowy).toEqual([])
  await importuj(atrapa)
  expect((await stanPanelu(db)).import?.status).toBe('OK')
}

const pauza = () => new Promise((r) => setTimeout(r, 5))

describe('wybór katalogu BaseLinkera z panelu', () => {
  it('kilka katalogów: raport podaje listę i blokuje import; wybór w „Decyzjach” zbiera wybrany katalog; zmiana wyboru unieważnia próbę', async () => {
    const atrapa = new AtrapaBlPrzeprowadzki()
    atrapa.katalogi.push({ inventory_id: 701, name: 'Hurt', default_price_group: 10, default_warehouse: 'bl_501', warehouses: ['bl_501'] })
    await zapiszTokenBl(db, TOKEN, 'u-test', ENV)
    await zapiszMapeFirmy(db, mapaZFormularza(decyzjeAtrapy(), await mapaFirmy(db)), 'u-test')
    await proba(atrapa)
    let s = (await stanPanelu(db)).proba!.s!
    expect(s.katalogi).toEqual([
      { id: '700', nazwa: 'Katalog testowy' },
      { id: '701', nazwa: 'Hurt' },
    ])
    expect(s.katalog).toBeNull()
    expect(s.powodyOdmowy.join(' ')).toMatch(/katalogów/)

    const f = decyzjeAtrapy()
    f.set('katalog', '701')
    await pauza()
    await zapiszMapeFirmy(db, mapaZFormularza(f, await mapaFirmy(db)), 'u-test', katalogZFormularza(f))
    expect(await katalogFirmy(db)).toBe('701')
    // decyzje zostają obok wyboru katalogu (jeden zapis, jeden wpis w historii)
    expect((await mapaFirmy(db)).statusy).toEqual({ '5': 'DO_REALIZACJI' })
    await proba(atrapa)
    s = (await stanPanelu(db)).proba!.s!
    expect(s.katalog?.id).toBe('701')
    expect(s.powodyOdmowy).toEqual([])

    // zmiana samego katalogu po próbie: import wymaga nowej próby
    await pauza()
    const g = new FormData()
    g.set('katalog', '700')
    await zapiszMapeFirmy(db, mapaZFormularza(g, await mapaFirmy(db)), 'u-test', katalogZFormularza(g))
    await expect(zlecPrzeprowadzke(db, { zapisz: true, actorId: 'u-test' })).rejects.toThrow(/zmieniły się/)
    // ten sam wybór jeszcze raz: bez wpisu w historii
    const wpisy = await db.auditLog.count({ where: { entity: 'Organization.przeprowadzka' } })
    await zapiszMapeFirmy(db, mapaZFormularza(g, await mapaFirmy(db)), 'u-test', katalogZFormularza(g))
    expect(await db.auditLog.count({ where: { entity: 'Organization.przeprowadzka' } })).toBe(wpisy)
    // puste = bez wyboru; brak pola = bez zmiany; śmieci = odmowa
    expect(katalogZFormularza(new FormData())).toBeUndefined()
    const pusty = new FormData()
    pusty.set('katalog', '')
    expect(katalogZFormularza(pusty)).toBeNull()
    const zly = new FormData()
    zly.set('katalog', '70; DROP')
    expect(() => katalogZFormularza(zly)).toThrow(PrzeprowadzkaError)
  })
})

describe('pomijanie źródeł zamówień z panelu', () => {
  it('pole „Pomiń” zapisuje POMIN, odznaczone usuwa; pominięte źródło nie daje konta; śmieci odrzucone', async () => {
    const atrapa = new AtrapaBlPrzeprowadzki()
    await zapiszTokenBl(db, TOKEN, 'u-test', ENV)
    await zapiszMapeFirmy(db, mapaZFormularza(decyzjeAtrapy(), await mapaFirmy(db)), 'u-test')
    await proba(atrapa)
    const przed = (await stanPanelu(db)).proba!.s!
    expect(przed.zrodla!.map((z) => z.zrodlo)).toEqual(expect.arrayContaining(['shop:9001', 'allegro:31']))
    expect(przed.zrodla!.every((z) => !z.pominiete)).toBe(true)

    const f = decyzjeAtrapy()
    for (const z of przed.zrodla!) f.append('zrodlo', z.zrodlo)
    f.append('pomin', 'allegro:31')
    await pauza()
    await zapiszMapeFirmy(db, mapaZFormularza(f, await mapaFirmy(db)), 'u-test')
    expect((await mapaFirmy(db)).zrodla).toEqual({ 'allegro:31': 'POMIN' })
    await proba(atrapa)
    const po = (await stanPanelu(db)).proba!.s!
    expect(po.zrodla!.find((z) => z.zrodlo === 'allegro:31')?.pominiete).toBe(true)
    expect(po.coPrzejdzie['konta']).toBe(przed.coPrzejdzie['konta']! - 1)
    expect(po.coPrzejdzie['zamowieniaOtwarte']).toBeLessThan(przed.coPrzejdzie['zamowieniaOtwarte']!)

    // odznaczenie (źródło na ekranie, bez „pomin”) zdejmuje decyzję; źródło spoza ekranu zostaje
    const g = new FormData()
    g.append('zrodlo', 'allegro:31')
    expect(mapaZFormularza(g, { statusy: {}, przewoznicy: {}, zrodla: { 'allegro:31': 'POMIN', 'shop:1': 'POMIN' } }).zrodla).toEqual({ 'shop:1': 'POMIN' })
    const bezEkranu = new FormData()
    bezEkranu.append('pomin', 'allegro:31')
    expect(() => mapaZFormularza(bezEkranu, { statusy: {}, przewoznicy: {}, zrodla: {} })).toThrow(PrzeprowadzkaError)
    const zly = new FormData()
    zly.append('zrodlo', '../../etc')
    expect(() => mapaZFormularza(zly, { statusy: {}, przewoznicy: {}, zrodla: {} })).toThrow(PrzeprowadzkaError)
  })
})

describe('pełne listy spraw i raport do pobrania', () => {
  it('streszczenie niesie listy (nie same liczby); raport Markdown do pobrania bez danych klientów, tylko klientem tej firmy', async () => {
    const atrapa = new AtrapaBlPrzeprowadzki()
    await zapiszTokenBl(db, TOKEN, 'u-test', ENV)
    const run = await proba(atrapa)
    const st = await stanPanelu(db)
    const s = st.proba!.s!
    expect(s.listy!.produktyBezSku.map((p) => p.idBl)).toEqual(expect.arrayContaining(['1003']))
    expect(s.listy!.produktyBezSku).toHaveLength(s.liczbyDoDecyzji['produktyBezSku']!)
    expect(s.listy!.ofertyBezPowiazania).toHaveLength(s.liczbyDoDecyzji['ofertyBezPowiazania']!)
    expect(st.proba!.raport).toBe(true)

    const r = await raportPrzebiegu(db, run)
    expect(r?.tryb).toBe('PROBNY')
    expect(r!.markdown).toMatch(/^# /)
    expect(r!.markdown).toContain('Produkt bez SKU')
    for (const pii of PII_SENTINELS) expect(r!.markdown).not.toContain(pii)
    // treść raportu nie jedzie w streszczeniu (ekran ładuje 20 przebiegów)
    expect(JSON.stringify(st)).not.toContain('Produkt bez SKU (')
    expect(await raportPrzebiegu(db, 'nie-ma')).toBeNull()
    expect(await raportPrzebiegu(db, '../x')).toBeNull()
    expect(await raportPrzebiegu(dbB, run)).toBeNull() // RLS: cudza firma nie pobierze
    // przebieg bez raportu (np. błąd BL) nie ma linku
    const zly = await zlecPrzeprowadzke(db, { zapisz: false, actorId: 'u-test' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await wykonajPrzeprowadzkeZPanelu(db, { runId: zly }, { registry, secrets: SEKRETY, bl: () => { throw new Error('BL: HTTP 500') }, now: NOW })
    expect(await raportPrzebiegu(db, zly)).toBeNull()
  })
})

describe('„Przejście z BaseLinkera zakończone” (bramka trybu pracy po przeprowadzce)', () => {
  it('przed importem: odmowa z powodem; po imporcie: znacznik zdejmuje blokadę instancji, import wyłączony, cofnięcie przy kontach w podglądzie', async () => {
    expect((await stanZakonczenia(db, ENV)).blokady.join(' ')).toMatch(/zaimportuj/)
    await expect(zakonczPrzejscie(db, 'u-test', ENV)).rejects.toThrow(/zaimportuj/)

    await przeprowadz()
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(true)
    expect(blokadaInstancji(ENV, true)).toMatch(/Przejście z BaseLinkera → Przeprowadzka/)
    const st = await stanZakonczenia(db, ENV)
    expect(st.blokady).toEqual([])
    expect(st.uwagi.join(' ')).toMatch(/wyłącz w BaseLinkerze/)

    expect(await zakonczPrzejscie(db, 'u-test', ENV)).toBe('ZMIENIONO')
    expect(await zakonczPrzejscie(db, 'u-test', ENV)).toBe('BEZ_ZMIAN')
    expect(await db.auditLog.count({ where: { entity: ENCJA_ZAKONCZENIA } })).toBe(1)
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(false)
    expect(blokadaInstancji(ENV, await firmaPrzechodziZBl(db, SEKRETY))).toBeNull()
    // reszta ustawień BL zostaje (katalog, ślad przeprowadzki)
    const bl = ((await db.organization.findFirstOrThrow()).settings as { baselinker: Record<string, unknown> }).baselinker
    expect(bl['inventoryId']).toBe('700')
    expect(bl['przeprowadzka']).toMatchObject({ pierwszyZapis: expect.any(String) })

    // konto z przeprowadzki przełączy się z panelu bez EKRANY_PRACA (po udanym teście połączenia)
    const konto = await db.channelConfig.findFirstOrThrow({ where: { channel: 'WOO' } })
    await db.channelAccountStatus.create({ data: { channel: 'WOO', channelAccountId: konto.channelAccountId, testOk: true } })
    const ref = { channel: konto.channel, channelAccountId: konto.channelAccountId }
    expect(await zmienTrybKonta(db, ref, 'PRACA', { actorId: 'u-test', env: ENV, registry, firmaZBl: await firmaPrzechodziZBl(db, SEKRETY) })).toBe('ZMIENIONO')
    // lista startu: krok przełączenia pokazuje zakończone przejście
    const lista = await listaStartu(db, { firmaZBl: false, kluczBl: true, trybPracyZablokowany: false })
    expect(lista.kroki.find((k) => k.id === 'przejscie')).toBeDefined()

    // import po znaczniku: odmowa przy zleceniu (tryb próbny działa dalej)
    await expect(zlecPrzeprowadzke(db, { zapisz: true, actorId: 'u-test' })).rejects.toThrow(ODMOWA_PO_ZAKONCZENIU)

    // cofnięcie: najpierw konta w pracy do podglądu
    await expect(cofnijZakonczenie(db, 'u-test')).rejects.toThrow(/Tylko podgląd/)
    await zmienTrybKonta(db, ref, 'CIEN', { actorId: 'u-test', env: ENV, registry, firmaZBl: false })
    expect(await cofnijZakonczenie(db, 'u-test')).toBe('ZMIENIONO')
    expect(await cofnijZakonczenie(db, 'u-test')).toBe('BEZ_ZMIAN')
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(true)
    expect(await db.auditLog.count({ where: { entity: ENCJA_ZAKONCZENIA } })).toBe(2)
  })

  it('import zlecony przed znacznikiem, wykonany po nim: worker nie zapisuje', async () => {
    const atrapa = new AtrapaBlPrzeprowadzki()
    await przeprowadz(atrapa)
    await pauza()
    const run = await zlecPrzeprowadzke(db, { zapisz: false, actorId: 'u-test' })
    await wykonajPrzeprowadzkeZPanelu(db, { runId: run }, { registry, secrets: SEKRETY, bl: () => atrapa.client(), now: NOW })
    const imp = await zlecPrzeprowadzke(db, { zapisz: true, actorId: 'u-test' })
    // przebieg w toku blokuje znacznik
    await expect(zakonczPrzejscie(db, 'u-test', ENV)).rejects.toThrow(/trwa/)
    // znacznik ustawiony mimo to (np. ręcznie przez administratora): worker odmawia zapisu
    const settings = (await db.organization.findFirstOrThrow()).settings as { baselinker: Record<string, unknown> }
    await db.organization.updateMany({ data: { settings: { ...settings, baselinker: { ...settings.baselinker, przejscieZakonczone: { at: NOW.toISOString(), przez: 'admin' } } } } })
    const zapisyPrzed = await db.importRun.count({ where: { kind: RODZAJ_PRZEBIEGU } })
    await wykonajPrzeprowadzkeZPanelu(db, { runId: imp }, { registry, secrets: SEKRETY, bl: () => atrapa.client(), now: NOW })
    const r = await db.importRun.findUniqueOrThrow({ where: { id: imp } })
    expect(r.status).toBe('FAILED')
    expect(r.error).toBe(ODMOWA_PO_ZAKONCZENIU)
    expect(await db.importRun.count({ where: { kind: RODZAJ_PRZEBIEGU } })).toBe(zapisyPrzed)
  })

  it('ACME (katalog BL z presetu, bez przeprowadzki): znacznika nie da się ustawić, a ręcznie wpisany nie zdejmuje wyłącznika', async () => {
    const inv = ACME_PRESET.settings!.baselinker!.inventoryId!
    await db.organization.updateMany({ data: { settings: { baselinker: { inventoryId: inv } } } })
    await expect(zakonczPrzejscie(db, 'u-test', ENV)).rejects.toThrow(/zaimportuj/)
    await db.organization.updateMany({ data: { settings: { baselinker: { inventoryId: inv, przejscieZakonczone: { at: NOW.toISOString(), przez: 'x' } } } } })
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(true)
    expect(blokadaInstancji(ENV, true)).not.toBeNull()
  })

  it('klucz BL w konfiguracji serwera i import katalogu co N godzin: znacznik zablokowany; z kluczem w env firma zostaje „z BL” mimo znacznika', async () => {
    await przeprowadz()
    const zTokenem = { ...ENV, BASELINKER_TOKEN: 'tok-serwera' }
    expect((await stanZakonczenia(db, zTokenem)).blokady.join(' ')).toMatch(/konfiguracji serwera/)
    await expect(zakonczPrzejscie(db, 'u-test', zTokenem)).rejects.toThrow(/administrator serwera/)
    await expect(zakonczPrzejscie(db, 'u-test', { ...ENV, KATALOG_IMPORT_CO_GODZIN: '6' })).rejects.toThrow(/co kilka godzin/)
    expect((await stanZakonczenia(db, { ...ENV, KATALOG_IMPORT_CO_GODZIN: '0' })).blokady).toEqual([])
    await zakonczPrzejscie(db, 'u-test', ENV)
    expect(await firmaPrzechodziZBl(db, { env: zTokenem, envFallback: true })).toBe(true)
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(false)
  })
})

describe(',', () => {
  const ZAM = { channel: 'WOO' as const, channelAccountId: 'sklep', name: 'Sklep', adapterKey: 'woocommerce.v1' }

  it('wyłączone konto w trybie pracy nie blokuje klucza BL; włączone z publikacją poza podglądem blokuje (jedna definicja z zapisem)', async () => {
    await db.channelConfig.create({ data: { ...ZAM, active: false, stockMode: 'PRACA', statusMode: 'PRACA', trackingMode: 'PRACA' } })
    expect(await kontaWPracy(db)).toEqual([])
    await zapiszTokenBl(db, TOKEN, 'u-test', ENV)
    await db.channelConfig.updateMany({ data: { active: true, stockMode: 'CIEN', statusMode: 'CIEN', trackingMode: 'CIEN', publishMode: 'PRACA' } })
    expect(await kontaWPracy(db)).toEqual(['Sklep'])
    await expect(zapiszTokenBl(db, '3002-abcdef0123456789', 'u-test', ENV)).rejects.toThrow(/Tylko podgląd/)
  })

  it('zapis przeprowadzki „z uwagami” (PARTIAL) liczy się jak zapisany dla bramki i listy startu', async () => {
    await db.importRun.create({ data: { kind: RODZAJ_PRZEBIEGU, status: 'PARTIAL' } })
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(true)
    const l = await listaStartu(db, { firmaZBl: true, kluczBl: false, trybPracyZablokowany: true })
    expect(l.kroki.find((k) => k.id === 'przeprowadzka')?.stan).toBe('zrobione')
  })
})

describe('„Włącz tryb pracy” na pulpicie sprawdza uprawnienia (zachowanie, nie tekst źródła)', () => {
  it('bez „Zmiana trybu kanału”: 404; z nim, bez „Ustawienia firmy”: 404; z obydwoma: przełącza i wraca na pulpit', async () => {
    vi.stubEnv('BASELINKER_TOKEN', '')
    vi.stubEnv('EKRANY_PRACA', '')
    const { wlaczTrybPracy } = await import('@/app/(panel)/pulpit/akcje')
    await db.channelConfig.create({ data: { channel: 'WOO', channelAccountId: 'a', name: 'Sklep a', adapterKey: 'woocommerce.v1' } })
    await db.channelAccountStatus.create({ data: { channel: 'WOO', channelAccountId: 'a', testOk: true } })
    uprawnienia.lista = new Set(['ustawienia'])
    await expect(wlaczTrybPracy()).rejects.toThrow('NOT_FOUND')
    uprawnienia.lista = new Set(['kanaly.tryb'])
    await expect(wlaczTrybPracy()).rejects.toThrow('NOT_FOUND')
    expect((await db.channelConfig.findFirstOrThrow()).stockMode).toBe('CIEN')
    uprawnienia.lista = new Set(['kanaly.tryb', 'ustawienia'])
    await expect(wlaczTrybPracy()).rejects.toThrow(/REDIRECT \/pulpit\?tryb=/)
    expect((await db.channelConfig.findFirstOrThrow()).stockMode).toBe('PRACA')
    vi.unstubAllEnvs()
  })
})

describe('(pierwsza firma za wyłącznikiem w każdej kolejności)', () => {
  const blOf = async () => ((await db.organization.findFirstOrThrow()).settings as { baselinker: Record<string, unknown> }).baselinker
  const recznyZnacznik = async () => {
    const bl = await blOf()
    await db.organization.updateMany({ data: { settings: { baselinker: { ...bl, przejscieZakonczone: { at: NOW.toISOString(), przez: 'admin' } } } } })
  }

  it('katalog BL z presetu przed przeprowadzką: pełna przeprowadzka z panelu, znacznik odmawia, ręcznie wpisany nie zdejmuje wyłącznika', async () => {
    // katalog jak z presetu albo cienia (pierwsza firma); id katalogu atrapy, żeby przeprowadzka przeszła do końca
    await db.organization.updateMany({ data: { settings: { baselinker: { inventoryId: '700' } } } })
    await przeprowadz()
    const bl = await blOf()
    expect(bl['przeprowadzka']).toMatchObject({ pierwszyZapis: expect.any(String), katalogPrzed: true })
    expect((bl['przeprowadzka'] as Record<string, unknown>)['katalogZapisu']).toBeUndefined()
    expect((await stanZakonczenia(db, ENV)).blokady).toContain(ODMOWA_KATALOG_PRZED)
    await expect(zakonczPrzejscie(db, 'u-test', ENV)).rejects.toThrow(ODMOWA_KATALOG_PRZED)
    expect(await db.auditLog.count({ where: { entity: ENCJA_ZAKONCZENIA } })).toBe(0)
    await recznyZnacznik()
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(true)
    expect(blokadaInstancji(ENV, await firmaPrzechodziZBl(db, SEKRETY))).not.toBeNull()
    // konto z przeprowadzki nie przełączy się na „Aktywny” bez EKRANY_PRACA
    const konto = await db.channelConfig.findFirstOrThrow({ where: { channel: 'WOO' } })
    await db.channelAccountStatus.create({ data: { channel: 'WOO', channelAccountId: konto.channelAccountId, testOk: true } })
    const ref = { channel: konto.channel, channelAccountId: konto.channelAccountId }
    await expect(zmienTrybKonta(db, ref, 'PRACA', { actorId: 'u-test', env: ENV, registry, firmaZBl: await firmaPrzechodziZBl(db, SEKRETY) })).rejects.toThrow()
    expect((await db.channelConfig.findFirstOrThrow({ where: { channel: 'WOO' } })).stockMode).toBe('CIEN')
  })

  it('przeprowadzka bez katalogu z presetu: katalog zapisany jako jej; podmiana katalogu po znaczniku i zapis sprzed zmiany wracają za wyłącznik', async () => {
    await przeprowadz()
    expect((await blOf())['przeprowadzka']).toMatchObject({ katalogZapisu: '700' })
    expect(((await blOf())['przeprowadzka'] as Record<string, unknown>)['katalogPrzed']).toBeUndefined()
    await zakonczPrzejscie(db, 'u-test', ENV)
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(false)
    // katalog podmieniony później (preset albo cień ustawiony po znaczniku): firma znów za wyłącznikiem
    const bl = await blOf()
    await db.organization.updateMany({ data: { settings: { baselinker: { ...bl, inventoryId: '77701' } } } })
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(true)
    // ślad bez `katalogZapisu` przy katalogu (zapis sprzed tej zmiany): ostrożnie, jak katalog z presetu
    const { katalogZapisu: _k, ...stary } = bl['przeprowadzka'] as Record<string, unknown>
    await db.organization.updateMany({ data: { settings: { baselinker: { ...bl, przeprowadzka: stary } } as never } })
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(true)
  })
})

describe('(zapisany katalog BL bez wyjścia)', () => {
  it('zapisany katalog, którego nie ma w BL: tryb próbny bierze jedyny katalog z uwagą; „Usuń klucz” czyści wybór', async () => {
    const atrapa = new AtrapaBlPrzeprowadzki() // jeden katalog: 700
    await zapiszTokenBl(db, TOKEN, 'u-test', ENV)
    const f = decyzjeAtrapy()
    f.set('katalog', '701')
    await zapiszMapeFirmy(db, mapaZFormularza(f, await mapaFirmy(db)), 'u-test', katalogZFormularza(f))
    expect(await katalogFirmy(db)).toBe('701')
    await proba(atrapa)
    const s = (await stanPanelu(db)).proba!.s!
    expect(s.katalog?.id).toBe('700')
    expect(s.powodyOdmowy).toEqual([])
    expect(s.uwagaKatalogu).toMatch(/katalogu nr 701 nie ma w BaseLinkerze/)
    // import przechodzi (próba bez powodów odmowy)
    await importuj(atrapa)
    expect((await stanPanelu(db)).import?.status).toBe('OK')

    expect(await usunTokenBl(db, 'u-test')).toBe(true)
    expect(await katalogFirmy(db)).toBeNull()
    expect((await mapaFirmy(db)).statusy).toEqual({ '5': 'DO_REALIZACJI' }) // decyzje zostają
    // bez zapisanego wyboru: idempotentnie, bez nowego wpisu w historii
    const wpisy = await db.auditLog.count({ where: { entity: 'Organization.przeprowadzka' } })
    await usunTokenBl(db, 'u-test')
    expect(await db.auditLog.count({ where: { entity: 'Organization.przeprowadzka' } })).toBe(wpisy)
  })
})

describe('i', () => {
  it('martwy przebieg (RUNNING ponad godzinę) nie blokuje znacznika; świeży blokuje', async () => {
    await przeprowadz()
    const stary = await db.importRun.create({ data: { kind: 'PRZEPROWADZKA_PANEL', startedAt: new Date(Date.now() - PRZERWANY_MS - 60_000) } })
    expect((await stanZakonczenia(db, ENV)).blokady).toEqual([])
    await db.importRun.update({ where: { id: stary.id }, data: { startedAt: new Date() } })
    expect((await stanZakonczenia(db, ENV)).blokady.join(' ')).toMatch(/trwa/)
    await expect(zakonczPrzejscie(db, 'u-test', ENV)).rejects.toThrow(/trwa/)
  })

  it('raport zostaje w ostatnich przebiegach oraz w ostatniej próbie i imporcie; starsze tracą treść, nie streszczenie', async () => {
    const t0 = Date.now() - 3600_000
    const imp = await db.importRun.create({ data: { kind: 'PRZEPROWADZKA_PANEL', status: 'OK', startedAt: new Date(t0), stats: { zapisz: true, tryb: 'ZAPIS', coPrzejdzie: {} }, reportMarkdown: '# import' } })
    const proby: string[] = []
    for (let i = 1; i <= RAPORTY_W_BAZIE + 2; i++)
      proby.push((await db.importRun.create({ data: { kind: 'PRZEPROWADZKA_PANEL', status: 'OK', startedAt: new Date(t0 + i * 1000), stats: { zapisz: false, tryb: 'PROBNY', coPrzejdzie: {} }, reportMarkdown: `# próba ${i}` } })).id)
    expect(await przytnijRaporty(db)).toBe(2)
    const zTrescia = new Set((await db.importRun.findMany({ where: { reportMarkdown: { not: null } }, select: { id: true } })).map((r) => r.id))
    expect(zTrescia.has(imp.id)).toBe(true) // ostatni import zostaje, choć starszy niż ostatnie próby
    expect(zTrescia.has(proby[0]!)).toBe(false)
    expect(zTrescia.has(proby[1]!)).toBe(false)
    expect(zTrescia.has(proby.at(-1)!)).toBe(true)
    expect(zTrescia.size).toBe(RAPORTY_W_BAZIE + 1)
    expect((await db.importRun.findUniqueOrThrow({ where: { id: proby[0]! } })).stats).toMatchObject({ tryb: 'PROBNY' })
    expect(await przytnijRaporty(db)).toBe(0) // idempotentne
  })
})
