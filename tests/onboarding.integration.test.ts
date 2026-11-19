// onboarding — lista uruchomienia (stany z danych, Pomiń/Przywróć/Ukryj), tryb pracy firmy z panelu
// (wszystkie konta naraz, blokada instancji tylko dla firm z BL), demo → własna firma (self-host) i przeprowadzka
// z BaseLinkera z panelu (klucz, tryb próbny = ten sam raport co polecenie, decyzje, import). BL tylko jako atrapa.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { createUser, grantMembership } from '@/lib/auth/sesje'
import { DEMO_ORG, DEMO_PRESET } from '@/lib/instalacja/demo'
import { stanWlasnejFirmyDb, utworzWlasnaFirmeDb } from '@/lib/instalacja/kreator'
import { applyOrgPreset } from '@/lib/organizacje'
import { zbierz } from '@/lib/przeprowadzka/przebieg'
import { uruchomPrzeprowadzke } from '@/lib/przeprowadzka/uruchomienie'
import { RODZAJ_PRZEBIEGU } from '@/lib/przeprowadzka/zapis'
import { mapaFirmy, mapaZFormularza, PrzeprowadzkaError, RODZAJ_PANELU, stanPanelu, usunTokenBl, wykonajPrzeprowadzkeZPanelu, zapiszMapeFirmy, zapiszTokenBl, zlecPrzeprowadzke } from '@/lib/przeprowadzka/z-panelu'
import { firmaMaBl, firmaPrzechodziZBl } from '@/lib/kanaly/firma'
import { blokadaInstancji } from '@/lib/kanaly/tryb'
import { kontoZamowienia, pracaDostepna } from '@/lib/praca/wlacznik'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ACME_PRESET } from './preset-testowy'
import { order, product, seedBase } from './rdzen-fixtures'
import { listaStartu, zmienStart } from '@/lib/start/lista'
import { trybFirmy, wlaczPraceFirmy } from '@/lib/start/tryb-firmy'
import { AtrapaBlPrzeprowadzki, NOW } from './bl-przeprowadzka-atrapa'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'

const db = testDb()
const registry = defaultRegistry()
const ENV = { APP_MODE: 'self-host', APP_ENCRYPTION_KEYS: `1:${'4'.repeat(64)}` }
const SEKRETY = { env: ENV, envFallback: false }

afterAll(async () => {
  await db.$disconnect()
})

beforeEach(async () => {
  await truncateAll()
})

const OPC = (zBl = false, kluczBl = false) => ({ firmaZBl: zBl, kluczBl, trybPracyZablokowany: zBl })
const stany = async (zBl = false) => Object.fromEntries((await listaStartu(db, OPC(zBl))).kroki.map((k) => [k.id, k.stan]))

describe('lista uruchomienia', () => {
  it('pusta firma: osiem kroków do zrobienia; dane z bazy zmieniają stan; Pomiń/Przywróć/Ukryj z AuditLog, idempotentnie', async () => {
    const l = await listaStartu(db, OPC())
    expect(l.kroki.map((k) => k.id)).toEqual(['dane-firmy', 'magazyn', 'kanal', 'produkty', 'przewoznik', 'przeplyw', 'dokumenty', 'poczta', 'zamowienie'])
    expect(l).toMatchObject({ zrobione: 0, razem: 9, gotowe: false, ukryta: false })
    expect(l.kroki.every((k) => k.href.startsWith('/'))).toBe(true)

    await db.product.create({ data: { sku: 'ST-1', kind: 'STOCKED', unit: 'SZT', nameAccounting: 'Towar', title: 'Towar', vatRate: '23' } })
    await db.organization.updateMany({ data: { settings: { firma: { nazwa: 'Firma Testowa', nip: '5260250995', adres: { ulica: 'Testowa 1', kodPocztowy: '00-001', miasto: 'Warszawa' } } } } })
    expect(await stany()).toMatchObject({ produkty: 'zrobione', 'dane-firmy': 'zrobione', kanal: 'do_zrobienia' })

    await zmienStart(db, { krok: 'poczta', pomin: true }, 'u-test')
    await zmienStart(db, { krok: 'poczta', pomin: true }, 'u-test') // drugi raz: bez zmian
    expect((await stany()).poczta).toBe('pominiete')
    expect(await db.auditLog.count({ where: { entity: 'Organization.start' } })).toBe(1)
    await zmienStart(db, { krok: 'poczta', pomin: false }, 'u-test')
    expect((await stany()).poczta).toBe('do_zrobienia')
    await zmienStart(db, { ukryj: true }, 'u-test')
    expect((await listaStartu(db, OPC())).ukryta).toBe(true)
    // inne klucze ustawień firmy zostają
    expect(((await db.organization.findFirstOrThrow()).settings as { firma?: { nazwa?: string } }).firma?.nazwa).toBe('Firma Testowa')
  })

  it('firma z BaseLinkerem: pierwszy krok to przeprowadzka; konto w podglądzie nie blokuje kroku „Kanał sprzedaży”', async () => {
    await db.channelConfig.create({ data: { channel: 'WOO', channelAccountId: 'sklep', name: 'Sklep', adapterKey: 'woocommerce.v1' } })
    expect((await listaStartu(db, OPC(true))).kroki[0]!.id).toBe('przeprowadzka')
    expect(await stany(true)).toMatchObject({ przeprowadzka: 'do_zrobienia', kanal: 'zrobione' })
    expect((await stany(false)).kanal).toBe('do_zrobienia') // firma bez BL: konto ma być aktywne
  })
})

describe('tryb pracy firmy z panelu', () => {
  async function konto(id: string, testOk: boolean | null) {
    await db.channelConfig.create({ data: { channel: 'WOO', channelAccountId: id, name: `Sklep ${id}`, adapterKey: 'woocommerce.v1' } })
    if (testOk !== null) await db.channelAccountStatus.create({ data: { channel: 'WOO', channelAccountId: id, testOk } })
  }

  it('firma bez BL: konta z udanym testem przechodzą na aktywne bez EKRANY_PRACA, reszta z powodem; AuditLog; powtórka bez zmian', async () => {
    await konto('a', true)
    await konto('b', null)
    expect(await trybFirmy(db, false, {})).toMatchObject({ wPodgladzie: 2, blokada: null })
    const w = await wlaczPraceFirmy(db, { actorId: 'u-test', env: {}, registry, firmaZBl: false })
    expect(w.wlaczone).toEqual(['Sklep a'])
    expect(w.pominiete).toEqual([{ nazwa: 'Sklep b', powod: expect.stringMatching(/sprawdź połączenie/i) }])
    expect(await db.channelConfig.findFirstOrThrow({ where: { channelAccountId: 'a' } })).toMatchObject({ stockMode: 'PRACA', statusMode: 'PRACA', trackingMode: 'PRACA', goBy: 'u-test' })
    expect(await db.auditLog.count({ where: { entity: 'ChannelConfig', entityId: 'WOO/a' } })).toBe(1)
    expect((await wlaczPraceFirmy(db, { actorId: 'u-test', env: {}, registry, firmaZBl: false })).wlaczone).toEqual([])
    expect(await db.auditLog.count({ where: { entity: 'ChannelConfig', entityId: 'WOO/a' } })).toBe(1)
  })

  it('firma z BL bez EKRANY_PRACA: twarda blokada instancji z czytelnym powodem, nic się nie zmienia; z EKRANY_PRACA=1 przechodzi', async () => {
    await konto('a', true)
    const t = await trybFirmy(db, true, {})
    expect(t.blokada).toMatch(/administrator serwera/)
    const w = await wlaczPraceFirmy(db, { actorId: 'u-test', env: {}, registry, firmaZBl: true })
    expect(w).toEqual({ wlaczone: [], pominiete: [{ nazwa: 'Sklep a', powod: t.blokada }] })
    expect((await db.channelConfig.findFirstOrThrow()).stockMode).toBe('CIEN')
    expect((await wlaczPraceFirmy(db, { actorId: 'u-test', env: { EKRANY_PRACA: '1' }, registry, firmaZBl: true })).wlaczone).toEqual(['Sklep a'])
  })
})

describe('demo → własna firma (self-host)', () => {
  it('tylko właściciel demo, tylko bez innej firmy; nowa firma z właścicielem, demo nieaktywne; hosting odmawia', async () => {
    await truncateAll(undefined, [])
    const sys = testSystemDb()
    await applyOrgPreset(sys, DEMO_PRESET)
    const u = await createUser(sys, { email: 'ola@example.test', name: 'Ola', password: 'bardzo-dlugie-haslo-1' })
    await grantMembership(sys, { email: 'ola@example.test', organizationId: DEMO_ORG, role: 'WLASCICIEL' })
    const inny = await createUser(sys, { email: 'jan@example.test', name: 'Jan', password: 'bardzo-dlugie-haslo-2' })
    await grantMembership(sys, { email: 'jan@example.test', organizationId: DEMO_ORG, role: 'MAGAZYN' })

    expect(await stanWlasnejFirmyDb(sys, ENV, { userId: u.id, organizationId: DEMO_ORG, rola: 'WLASCICIEL' })).toEqual({ dostepny: true })
    expect(await stanWlasnejFirmyDb(sys, { APP_MODE: 'hosted' }, { userId: u.id, organizationId: DEMO_ORG, rola: 'WLASCICIEL' })).toEqual({ dostepny: false })
    expect(await stanWlasnejFirmyDb(sys, ENV, { userId: inny.id, organizationId: DEMO_ORG, rola: 'MAGAZYN' })).toEqual({ dostepny: false })
    expect(await utworzWlasnaFirmeDb(sys, { userId: inny.id, nazwa: 'Cudza', zostawDemo: false }, ENV)).toMatchObject({ ok: false, blad: expect.stringMatching(/właściciel/) })
    expect(await utworzWlasnaFirmeDb(sys, { userId: u.id, nazwa: 'X', zostawDemo: false }, { APP_MODE: 'hosted' })).toMatchObject({ ok: false })
    expect(await utworzWlasnaFirmeDb(sys, { userId: u.id, nazwa: '  ', zostawDemo: false }, ENV)).toMatchObject({ ok: false, blad: 'Podaj nazwę firmy.' })

    const r = await utworzWlasnaFirmeDb(sys, { userId: u.id, nazwa: 'Zielona Łąka', zostawDemo: false }, ENV)
    expect(r).toEqual({ ok: true, organizationId: 'zielona_laka' })
    expect(await sys.membership.findFirst({ where: { userId: u.id, organizationId: 'zielona_laka' }, select: { role: true } })).toEqual({ role: 'WLASCICIEL' })
    expect(await sys.organization.findUniqueOrThrow({ where: { id: DEMO_ORG }, select: { active: true } })).toEqual({ active: false })
    expect(await sys.warehouse.findFirst({ where: { organizationId: 'zielona_laka' }, select: { stockSource: true } })).toEqual({ stockSource: 'KOMPLETOR' })
    // druga firma z panelu: odmowa (kolejne zakłada administrator)
    expect(await utworzWlasnaFirmeDb(sys, { userId: u.id, nazwa: 'Druga', zostawDemo: false }, ENV)).toMatchObject({ ok: false })
    expect(await sys.organization.count()).toBe(2)
    await truncateAll()
  })
})

describe('przeprowadzka z BaseLinkera z panelu', () => {
  const atrapa = new AtrapaBlPrzeprowadzki()
  const deps = { registry, secrets: SEKRETY, bl: () => atrapa.client(), now: NOW }

  it('bez klucza: odmowa zlecenia; klucz zapisany szyfrowany (bez wartości w AuditLog)', async () => {
    await expect(zlecPrzeprowadzke(db, { zapisz: false, actorId: 'u-test' })).rejects.toBeInstanceOf(PrzeprowadzkaError)
    await expect(zapiszTokenBl(db, 'za krótki', 'u-test', ENV)).rejects.toBeInstanceOf(PrzeprowadzkaError)
    await zapiszTokenBl(db, '3001-abcdef0123456789', 'u-test', ENV)
    expect(await db.integrationSecret.count({ where: { name: 'BASELINKER_TOKEN', channel: null } })).toBe(1)
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain('3001-abcdef')
  })

  it('tryb próbny z panelu = ten sam raport co polecenie; import czeka na decyzje, po nich zapisuje; jeden przebieg naraz', async () => {
    await zapiszTokenBl(db, '3001-abcdef0123456789', 'u-test', ENV)
    const run = await zlecPrzeprowadzke(db, { zapisz: false, actorId: 'u-test', now: NOW })
    await expect(zlecPrzeprowadzke(db, { zapisz: false, actorId: 'u-test', now: NOW })).rejects.toThrow(/już trwa/)
    expect(await db.job.count({ where: { kind: 'przeprowadzka-panel' } })).toBe(1)
    await wykonajPrzeprowadzkeZPanelu(db, { runId: run }, deps)
    const s = await stanPanelu(db)
    expect(s.wToku).toBeNull()
    expect(s.proba?.status).toBe('OK')
    // ten sam raport co CLI (zbierz + uruchomPrzeprowadzke na tej samej atrapie)
    const cli = await uruchomPrzeprowadzke(db, { firma: 'x', dane: await zbierz({ bl: new AtrapaBlPrzeprowadzki().client(), wfirma: null, wfirmaWarehouseId: null }, { registry, now: NOW }), registry, zapisz: false, now: NOW })
    expect(s.proba!.s!.coPrzejdzie).toEqual(cli.raport.coPrzejdzie)
    expect(s.proba!.s!.powodyOdmowy).toHaveLength(cli.powodyOdmowy.length)
    expect(s.proba!.s!.powodyOdmowy.join(' ')).toMatch(/Status Xyz.*sekcji „Decyzje”/) // ekran: formularz zamiast pliku mapy
    expect(s.proba!.s!.powodyOdmowy.join(' ')).not.toMatch(/--mapa/)
    expect(s.proba!.s!.statusy.map((x) => x.id)).toEqual(['5'])
    expect(await db.product.count()).toBe(0) // tryb próbny nic nie zapisał

    await expect(zlecPrzeprowadzke(db, { zapisz: true, actorId: 'u-test' })).rejects.toThrow(/blokują import/)
    const form = new FormData()
    form.set('status:5', 'DO_REALIZACJI')
    form.set('przewoznik:Poczta Polska', 'BRAK')
    await zapiszMapeFirmy(db, mapaZFormularza(form, await mapaFirmy(db)), 'u-test')
    expect((await mapaFirmy(db)).statusy).toEqual({ '5': 'DO_REALIZACJI' })
    const bad = new FormData()
    bad.set('status:5', 'NIE_MA')
    expect(() => mapaZFormularza(bad, { statusy: {}, przewoznicy: {}, zrodla: {} })).toThrow(PrzeprowadzkaError)
    await expect(zlecPrzeprowadzke(db, { zapisz: true, actorId: 'u-test' })).rejects.toThrow(/Najpierw uruchom tryb próbny|zmieniły się|blokują/)

    const run2 = await zlecPrzeprowadzke(db, { zapisz: false, actorId: 'u-test' })
    await wykonajPrzeprowadzkeZPanelu(db, { runId: run2 }, deps)
    expect((await stanPanelu(db)).proba!.s!.powodyOdmowy).toEqual([])
    const run3 = await zlecPrzeprowadzke(db, { zapisz: true, actorId: 'u-test' })
    await wykonajPrzeprowadzkeZPanelu(db, { runId: run3 }, deps)
    const po = await stanPanelu(db)
    expect(po.import?.status).toBe('OK')
    expect(po.import?.s?.tryb).toBe('ZAPIS')
    expect(await db.importRun.count({ where: { kind: RODZAJ_PRZEBIEGU } })).toBe(1)
    expect(await db.product.count()).toBeGreaterThan(0)
    // zadanie już wykonane = bez drugiego zapisu (idempotencja handlera)
    await wykonajPrzeprowadzkeZPanelu(db, { runId: run3 }, deps)
    expect(await db.importRun.count({ where: { kind: RODZAJ_PRZEBIEGU } })).toBe(1)
    expect(await db.importRun.count({ where: { kind: RODZAJ_PANELU } })).toBe(3)
  })

  it('błąd BL trafia do przebiegu (ekran go pokazuje), nie tylko do logu', async () => {
    await zapiszTokenBl(db, '3001-abcdef0123456789', 'u-test', ENV)
    const run = await zlecPrzeprowadzke(db, { zapisz: false, actorId: 'u-test' })
    const zly = { ...deps, bl: () => { throw new Error('BL getInventories: HTTP 500') } }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await wykonajPrzeprowadzkeZPanelu(db, { runId: run }, zly)
    const r = await db.importRun.findUniqueOrThrow({ where: { id: run } })
    expect(r.status).toBe('FAILED')
    expect(r.error).toMatch(/HTTP 500/)
    expect(r.organizationId).toBe(ORG_A)
  })
})

describe('klucz BL z panelu nie zmienia bramki trybu pracy', () => {
  const PRACA = { stockMode: 'PRACA', statusMode: 'PRACA', trackingMode: 'PRACA' } as const
  const ZAM = { channel: 'WOO' as const, channelAccountId: 'sklep' }

  it('firma bez BL z kontem w pracy: zapis klucza odrzucony z powodem, karta dalej ma akcje bez EKRANY_PRACA', async () => {
    await db.channelConfig.create({ data: { ...ZAM, name: 'Sklep', adapterKey: 'woocommerce.v1', ...PRACA } })
    expect(pracaDostepna(await kontoZamowienia(db, ZAM, ENV), ENV)).toBe(true)
    await expect(zapiszTokenBl(db, '3001-abcdef0123456789', 'u-test', ENV)).rejects.toThrow(/Tylko podgląd/)
    expect(await db.integrationSecret.count()).toBe(0)
    expect(pracaDostepna(await kontoZamowienia(db, ZAM, ENV), ENV)).toBe(true)
  })

  it('sam klucz (zapisany, gdy konta były w podglądzie): firma dalej „bez BL” dla bramki, menu przeprowadzki widzi klucz; „Usuń klucz”', async () => {
    await db.channelConfig.create({ data: { ...ZAM, name: 'Sklep', adapterKey: 'woocommerce.v1' } })
    await zapiszTokenBl(db, '3001-abcdef0123456789', 'u-test', ENV)
    expect(await firmaMaBl(db, SEKRETY)).toBe(true)
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(false)
    expect(blokadaInstancji({}, await firmaPrzechodziZBl(db, SEKRETY))).toBeNull()
    await db.channelConfig.updateMany({ data: PRACA })
    expect(pracaDostepna(await kontoZamowienia(db, ZAM, ENV), ENV)).toBe(true)
    expect(await usunTokenBl(db, 'u-test')).toBe(true)
    expect(await usunTokenBl(db, 'u-test')).toBe(false) // powtórka bez drugiego wpisu
    expect(await db.integrationSecret.count()).toBe(0)
    const wpisy = await db.auditLog.findMany({ where: { entity: 'IntegrationSecret', entityId: 'BASELINKER_TOKEN' }, orderBy: { createdAt: 'asc' } })
    expect(wpisy.map((w) => w.after)).toEqual([{ zapisany: true, zrodlo: 'panel' }, { usuniety: true, zrodlo: 'panel' }])
    expect(JSON.stringify(wpisy)).not.toContain('3001-abcdef')
  })

  it('pierwsza firma (katalog BL z presetu ACME): dalej pod wyłącznikiem EKRANY_PRACA; ślad przeprowadzki i token z env też', async () => {
    const inv = ACME_PRESET.settings!.baselinker!.inventoryId!
    await db.channelConfig.create({ data: { ...ZAM, name: 'Sklep', adapterKey: 'woocommerce.v1', ...PRACA } })
    await db.organization.updateMany({ data: { settings: { baselinker: { inventoryId: inv } } } })
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(true)
    expect(pracaDostepna(await kontoZamowienia(db, ZAM, ENV), ENV)).toBe(false)
    const zWl = { ...ENV, EKRANY_PRACA: '1' }
    expect(pracaDostepna(await kontoZamowienia(db, ZAM, zWl), zWl)).toBe(true)
    await db.organization.updateMany({ data: { settings: { baselinker: { przeprowadzka: { pierwszyZapis: '2026-11-06T10:00:00.000Z' } } } } })
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(true)
    await db.organization.updateMany({ data: { settings: {} } })
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(false)
    await db.importRun.create({ data: { kind: RODZAJ_PRZEBIEGU, status: 'OK' } })
    expect(await firmaPrzechodziZBl(db, SEKRETY)).toBe(true)
    await db.importRun.deleteMany()
    expect(await firmaPrzechodziZBl(db, { env: { BASELINKER_TOKEN: 'x' }, envFallback: true })).toBe(true)
    expect(await firmaPrzechodziZBl(db, { env: { BASELINKER_TOKEN: 'x' }, envFallback: false })).toBe(false)
  })

  it('zmiana klucza po trybie próbnym unieważnia próbę przed importem', async () => {
    const atrapa = new AtrapaBlPrzeprowadzki()
    const deps = { registry, secrets: SEKRETY, bl: () => atrapa.client(), now: NOW }
    await zapiszTokenBl(db, '3001-abcdef0123456789', 'u-test', ENV)
    const form = new FormData()
    form.set('status:5', 'DO_REALIZACJI')
    form.set('przewoznik:Poczta Polska', 'BRAK')
    await zapiszMapeFirmy(db, mapaZFormularza(form, await mapaFirmy(db)), 'u-test')
    const run = await zlecPrzeprowadzke(db, { zapisz: false, actorId: 'u-test' })
    await wykonajPrzeprowadzkeZPanelu(db, { runId: run }, deps)
    expect((await stanPanelu(db)).proba!.s!.powodyOdmowy).toEqual([])
    await new Promise((r) => setTimeout(r, 5))
    await zapiszTokenBl(db, '3002-abcdef0123456789', 'u-test', ENV)
    await expect(zlecPrzeprowadzke(db, { zapisz: true, actorId: 'u-test' })).rejects.toThrow(/Klucz API BaseLinkera zmienił się/)
  })
})

describe('lista uruchomienia schowana dla działającej firmy', () => {
  it('zamówienie z kanału starsze niż 7 dni: lista domyślnie schowana, „Pokaż listę” wygrywa', async () => {
    const now = new Date()
    await seedBase(db)
    const p = await product(db, 'W5-1', 10)
    await ingestOrder(db, order([{ productId: p, qty: 1 }]))
    expect((await listaStartu(db, { ...OPC(), now })).ukryta).toBe(false) // świeże zamówienie: nowa firma testuje
    await db.order.updateMany({ data: { createdAt: new Date(now.getTime() - 8 * 86_400_000) } })
    expect((await listaStartu(db, { ...OPC(), now })).ukryta).toBe(true)
    await zmienStart(db, { ukryj: false }, 'u-test')
    expect((await listaStartu(db, { ...OPC(), now })).ukryta).toBe(false)
  })

  it('cień BL (katalog z presetu) bez przeprowadzki: schowana; po przeprowadzce widoczna', async () => {
    await db.organization.updateMany({ data: { settings: { baselinker: { inventoryId: '77701' } } } })
    expect((await listaStartu(db, OPC(true))).ukryta).toBe(true)
    await db.importRun.create({ data: { kind: RODZAJ_PRZEBIEGU, status: 'OK' } })
    expect((await listaStartu(db, OPC(true))).ukryta).toBe(false)
  })
})

// (uprawnienia „Włącz tryb pracy” na pulpicie): test zachowania w przeprowadzka-panel.integration.test.ts
// (zamiast wyrażenia regularnego na tekście źródła)
