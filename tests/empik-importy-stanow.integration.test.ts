// wynik importu stanów Empiku (STO01 → STO02/STO03) i zmiana rodzaju konta (tylko odczyt ↔ z zapisem),
// wyłącznie na atrapie Mirakl (empik.example; atrapa rzuca błąd przy każdym innym adresie). Droga jak na produkcji:
// host stanów (`wyslijStanyKonta`) → wiersz ChannelStockImport → zadanie `kanaly-importy-stanow` → alert. Zero
// wywołań prawdziwego Empiku, zero danych klientów.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { wyczyscPamiecOfertEmpiku } from '@/lib/adaptery/mirakl-empik'
import { pollAccount } from '@/lib/cien/odczyt-zamowien'
import { ALERT_IMPORT_BEZ_WYNIKU, ALERT_IMPORT_ODRZUCONE, IMPORTY_STANOW_JOB, KOLEJNY_ODCZYT_MS, przebiegImportowStanow, RETENCJA_MS, WSTRZYMANIE_MS } from '@/lib/kanaly/importy-stanow'
import { ekranZapisu, wyslijStanyKonta, zmienRodzajKonta } from '@/lib/kanaly/zapis-host'
import { fullSyncChannel } from '@/lib/rdzen/propagacja'
import { setSecret } from '@/lib/sekrety'
import { HARMONOGRAM_RDZENIA } from '@/lib/worker/harmonogram'
import { handlers } from '@/lib/worker/zadania'
import { rodzajKonta } from '../scripts/konto-kanalu'
import { ORG_A, testDb, truncateAll } from './db'
import { MIRAKL_HOST, MIRAKL_KEY, MiraklAtrapa } from './mirakl-atrapa'
import { product, seedBase } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const T = new Date('2026-11-09T09:00:00.000Z')
const M = 60_000
const at = (ms: number) => new Date(T.getTime() + ms)
const ENV = { APP_ENCRYPTION_KEY: '4'.repeat(64) }
const SRC = { env: ENV, envFallback: false }
const EMPIK = { channel: 'EMPIK' as const, channelAccountId: 'empik' }
const where = { organizationId_channel_channelAccountId: { organizationId: ORG_A, ...EMPIK } }
// (przegląd scalenia): bez odstępu 2 s i bez ponowień na atrapie
const FAST = { minIntervalMs: 0, retry: { attempts: 1, baseDelayMs: 0 } }
const registry = defaultRegistry()

let atr: MiraklAtrapa
const ctx = (now: Date) => ({ registry, secrets: SRC, now, fetch: atr.fetch, http: FAST })

async function konto(adapterKey: string, config: Record<string, unknown>, stockMode: 'CIEN' | 'PRACA' = 'PRACA') {
  await db.channelConfig.update({ where, data: { adapterKey, stockMode, config: { baseUrl: MIRAKL_HOST, ...config } as Prisma.InputJsonValue } })
}

/** Dwie oferty Empiku ze stanem do zmniejszenia (spadek: bez czekania na odczyt zamówień). */
async function oferty() {
  const a = await product(db, 'A', 5)
  const b = await product(db, 'B', 3)
  await db.channelOffer.createMany({
    data: [
      { ...EMPIK, externalId: 'PA', productId: a, lastPushedQty: 99, lastPushedAt: at(-60 * M) },
      { ...EMPIK, externalId: 'PB', productId: b, lastPushedQty: 99, lastPushedAt: at(-60 * M) },
    ],
  })
  atr.putOffer('PA', 'SD-A')
  atr.putOffer('PB', 'SD-B')
}

async function wyslij(now = T) {
  await fullSyncChannel(db, EMPIK, { now })
  return wyslijStanyKonta(db, EMPIK, ctx(now))
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  atr = new MiraklAtrapa()
  wyczyscPamiecOfertEmpiku()
  await setSecret(db, 'MIRAKL_API_KEY', MIRAKL_KEY, ENV, EMPIK)
})

describe('Empik: wynik importu stanów (STO02/STO03)', () => {
  it('zadanie w harmonogramie co minutę i zarejestrowany handler', () => {
    expect(HARMONOGRAM_RDZENIA).toContainEqual({ kind: IMPORTY_STANOW_JOB, everyMs: 60_000, requires: 'empik' })
    expect(typeof handlers[IMPORTY_STANOW_JOB]).toBe('function')
  })

  it('import z odrzuconym wierszem: wiersz importu po wysyłce, wynik po minucie, alert z liczbą bez treści wierszy', async () => {
    await konto('mirakl.empik.zapis.v1', { zapisWlaczony: true, magazynEmpik: 'MAG1' })
    atr.magazyny.add('MAG1')
    await oferty()
    expect(await wyslij()).toMatchObject({ sent: 2, failed: 0 })
    const imp = await db.channelStockImport.findFirstOrThrow({})
    expect(imp).toMatchObject({ ...EMPIK, externalRef: 'STO01:1001', wierszy: 2, state: 'W_TOKU', createdAt: T }) // zegar z ctx.now, nie z bazy
    // atrapa odrzuci SD-B: oferta znika z Empiku między przyjęciem pliku a przetworzeniem (wiersz odrzucony)
    atr.importy.get('1001')!.bledy.push({ line: 3, row: '"SD-B";"3";"MAG1";"update"', reason: 'zmyślony błąd atrapy: oferta nieaktywna' })
    atr.importy.get('1001')!.przyjete = 1
    // przed minutą: bez odczytu
    expect(await przebiegImportowStanow(db, ctx(at(30_000)))).toMatchObject({ sprawdzone: 0 })
    const r = await przebiegImportowStanow(db, ctx(at(M)))
    expect(r).toMatchObject({ sprawdzone: 1, odrzucone: 1, bledy: [] })
    expect(await db.channelStockImport.findFirstOrThrow({})).toMatchObject({ state: 'ODRZUCONE', przyjete: 1, odrzucone: 1, kodyOdrzuconych: ['SD-B'] })
    const alerty = await db.alert.findMany({ where: { kind: ALERT_IMPORT_ODRZUCONE } })
    expect(alerty).toHaveLength(1)
    expect(alerty[0]!.message).toContain('odrzucił 1 z 2 wierszy')
    expect(alerty[0]!.message).toContain('SD-B')
    expect(alerty[0]!.message).not.toContain('zmyślony błąd')
    // kolejny przebieg: import zamknięty, bez drugiego alertu i bez żądań
    const n = atr.zapytania.length
    expect(await przebiegImportowStanow(db, ctx(at(10 * M)))).toMatchObject({ sprawdzone: 0 })
    expect(atr.zapytania.length).toBe(n)
    expect(await db.alert.count({ where: { kind: ALERT_IMPORT_ODRZUCONE } })).toBe(1)
    // ekran konta: ostatnie importy z wynikiem
    const e = await ekranZapisu(db, registry, EMPIK, at(10 * M))
    expect(e!.importy).toMatchObject([{ identyfikator: 'STO01:1001', wierszy: 2, state: 'ODRZUCONE', stan: 'część odrzucona', odrzucone: 1, kody: ['SD-B'], uwaga: null }])
    // tylko GET do STO02/STO03 i jeden POST STO01: nic poza dozwolonymi ścieżkami
    expect(atr.zapisy().map((z) => `${z.method} ${z.path}`)).toEqual(['POST /offers/stock/imports'])
  })

  it('import bez błędów: GOTOWE bez alertu; w toku: kolejny odczyt za 5 min; po dobie bez wyniku: alert i koniec', async () => {
    await konto('mirakl.empik.zapis.v1', { zapisWlaczony: true })
    await oferty()
    await wyslij()
    expect(await przebiegImportowStanow(db, ctx(at(M)))).toMatchObject({ gotowe: 1 })
    expect(await db.alert.count({})).toBe(0)
    expect([...atr.stany]).toEqual(expect.arrayContaining([['SD-A', 5], ['SD-B', 3]]))

    // drugi import: Empik długo liczy
    atr.odczytowWToku = 1_000
    await db.channelOffer.updateMany({ where: EMPIK, data: { lastPushedQty: 50 } })
    await wyslij(at(2 * M))
    const drugi = await db.channelStockImport.findFirstOrThrow({ where: { externalRef: 'STO01:1002' } })
    expect(await przebiegImportowStanow(db, ctx(at(3 * M)))).toMatchObject({ wToku: 1 })
    expect((await db.channelStockImport.findUniqueOrThrow({ where: { id: drugi.id } })).nextCheckAt).toEqual(new Date(at(3 * M).getTime() + KOLEJNY_ODCZYT_MS))
    const r = await przebiegImportowStanow(db, ctx(at(2 * M + 24 * 3600_000)))
    expect(r).toMatchObject({ bezWyniku: 1 })
    expect(await db.channelStockImport.findUniqueOrThrow({ where: { id: drugi.id } })).toMatchObject({ state: 'BEZ_WYNIKU' })
    expect(await db.alert.count({ where: { kind: ALERT_IMPORT_BEZ_WYNIKU } })).toBe(1)
    // po 30 dniach zamknięte importy znikają przy przebiegu, otwarte zostają
    await db.channelStockImport.create({ data: { ...EMPIK, externalRef: 'STO01:9', reference: 'r', wierszy: 1, createdAt: at(0), nextCheckAt: at(100 * 24 * 3600_000) } })
    await przebiegImportowStanow(db, ctx(at(RETENCJA_MS + 3 * M)))
    expect((await db.channelStockImport.findMany({ orderBy: { externalRef: 'asc' } })).map((r) => r.externalRef)).toEqual(['STO01:9'])
  })

  // ───: odmowa dostępu do wyniku (STO02) to „wynik niedostępny”, nie „odrzucone” ───
  it('403 na STO02 → wynik niedostępny (nie „odrzucone”), jeden alert BEZ_WYNIKU; kolejny import tego konta bez żądania i bez alertu; po dobie znowu pyta', async () => {
    await konto('mirakl.empik.zapis.v1', { zapisWlaczony: true })
    await oferty()
    await wyslij()
    atr.failNextGet(403)
    const r = await przebiegImportowStanow(db, ctx(at(M)))
    expect(r).toMatchObject({ sprawdzone: 1, nieodczytane: 1, nieudane: 0, odrzucone: 0, bledy: [] })
    const pierwszy = await db.channelStockImport.findFirstOrThrow({ where: { externalRef: 'STO01:1001' } })
    expect(pierwszy).toMatchObject({ state: 'NIEODCZYTANY', odczytWstrzymanyDo: new Date(at(M).getTime() + WSTRZYMANIE_MS) })
    expect(pierwszy.lastError).toContain('HTTP 403')
    expect(await db.alert.count({ where: { kind: ALERT_IMPORT_ODRZUCONE } })).toBe(0)
    const alerty = await db.alert.findMany({ where: { kind: ALERT_IMPORT_BEZ_WYNIKU } })
    expect(alerty).toHaveLength(1)
    expect(alerty[0]!.message).toContain('nie ma dostępu do wyniku importu')
    // ekran konta: „wynik niedostępny” ze zdaniem dla człowieka, bez kodu HTTP i ścieżki API
    const e = await ekranZapisu(db, registry, EMPIK, at(2 * M))
    expect(e!.importy![0]).toMatchObject({ state: 'NIEODCZYTANY', stan: 'wynik niedostępny' })
    expect(e!.importy![0]!.uwaga).toContain('Nie wiadomo, czy stany weszły')
    expect(e!.importy![0]!.uwaga).not.toMatch(/HTTP|\/offers/)

    // drugi import tego konta (stany się zmieniły): bez żądania STO02 i bez drugiego alertu
    await db.channelOffer.updateMany({ where: EMPIK, data: { lastPushedQty: 50 } })
    await wyslij(at(2 * M))
    const odczyty = () => atr.zapytania.filter((z) => z.method === 'GET' && z.path.startsWith('/offers/stock/imports/')).length
    const n = odczyty()
    expect(await przebiegImportowStanow(db, ctx(at(3 * M)))).toMatchObject({ sprawdzone: 1, nieodczytane: 1 })
    expect(odczyty()).toBe(n)
    expect(await db.channelStockImport.findFirstOrThrow({ where: { externalRef: 'STO01:1002' } })).toMatchObject({ state: 'NIEODCZYTANY', odczytWstrzymanyDo: null })
    expect(await db.alert.count({ where: { kind: ALERT_IMPORT_BEZ_WYNIKU } })).toBe(1)

    // po dobie wstrzymania: kolejny import znów pyta Empik (tu wynik już jest: GOTOWE)
    const pozniej = at(M + WSTRZYMANIE_MS + M)
    await db.channelOffer.updateMany({ where: EMPIK, data: { lastPushedQty: 40 } })
    await wyslij(pozniej)
    expect(await przebiegImportowStanow(db, ctx(new Date(pozniej.getTime() + M)))).toMatchObject({ gotowe: 1 })
    expect(odczyty()).toBeGreaterThan(n)
  })

  it('401 na STO02 → wynik niedostępny bez wstrzymania; dwa importy tego samego dnia = jeden alert', async () => {
    await konto('mirakl.empik.zapis.v1', { zapisWlaczony: true })
    await oferty()
    await wyslij()
    await db.channelOffer.updateMany({ where: EMPIK, data: { lastPushedQty: 50 } })
    await wyslij(at(2 * M))
    expect(await db.channelStockImport.count({})).toBe(2)
    // oba odczyty dostają 401 (klucz po rotacji); reszta żądań idzie do atrapy
    const orig = atr.fetch
    const f: typeof atr.fetch = async (u, i) =>
      String(u).includes('/offers/stock/imports/') && (i?.method ?? 'GET') === 'GET' ? new Response(JSON.stringify({ status: 401 }), { status: 401 }) : orig(u, i)
    const r = await przebiegImportowStanow(db, { ...ctx(at(3 * M)), fetch: f })
    expect(r).toMatchObject({ sprawdzone: 2, nieodczytane: 2 })
    expect((await db.channelStockImport.findMany({})).map((x) => [x.state, x.odczytWstrzymanyDo])).toEqual([
      ['NIEODCZYTANY', null],
      ['NIEODCZYTANY', null],
    ])
    const alerty = await db.alert.findMany({ where: { kind: ALERT_IMPORT_BEZ_WYNIKU } })
    expect(alerty).toHaveLength(1)
    expect(alerty[0]!.message).toContain('klucz API')
  })

  it('500 na STO02 → zostaje w toku z próbą za 5 min (nie NIEUDANE); na ekranie zdanie dla człowieka', async () => {
    await konto('mirakl.empik.zapis.v1', { zapisWlaczony: true })
    await oferty()
    await wyslij()
    atr.failNextGet(500)
    expect(await przebiegImportowStanow(db, ctx(at(M)))).toMatchObject({ wToku: 1 })
    const e = await ekranZapisu(db, registry, EMPIK, at(M))
    expect(e!.importy![0]).toMatchObject({ state: 'W_TOKU', uwaga: 'Nie udało się odczytać wyniku ze sklepu, kolejna próba za 5 minut.' })
    expect(await db.alert.count({})).toBe(0)
  })

  // ───: powtórki tej samej przyczyny łączone w jeden alert dziennie ───
  it('dwa importy odrzucone z tym samym kodem oferty = jeden alert; nowy kod = drugi alert; dwa odrzucone pliki = jeden alert', async () => {
    await konto('mirakl.empik.zapis.v1', { zapisWlaczony: true })
    await oferty()
    let q = 50
    const kolejny = async (min: number, kody: string[]) => {
      await db.channelOffer.updateMany({ where: EMPIK, data: { lastPushedQty: q-- } })
      await wyslij(at(min * M))
      const id = String(Math.max(...[...atr.importy.keys()].map(Number)))
      const imp = atr.importy.get(id)!
      for (const k of kody) imp.bledy.push({ line: 2, row: `"${k}";"1";"";"update"`, reason: 'zmyślony błąd atrapy' })
      imp.przyjete = 0
      await przebiegImportowStanow(db, ctx(at((min + 1) * M)))
    }
    await kolejny(0, ['SD-B'])
    await kolejny(2, ['SD-B'])
    expect(await db.channelStockImport.count({ where: { state: 'ODRZUCONE' } })).toBe(2)
    expect(await db.alert.count({ where: { kind: ALERT_IMPORT_ODRZUCONE } })).toBe(1)
    await kolejny(4, ['SD-A', 'SD-B'])
    expect(await db.alert.count({ where: { kind: ALERT_IMPORT_ODRZUCONE } })).toBe(2)
    // ten sam zestaw w innej kolejności: bez nowego alertu
    await kolejny(6, ['SD-B', 'SD-A'])
    expect(await db.alert.count({ where: { kind: ALERT_IMPORT_ODRZUCONE } })).toBe(2)

    // cały plik odrzucony dwa razy tego samego dnia: jeden alert
    for (const min of [8, 10]) {
      atr.nastepnyImportNieudany = true
      await db.channelOffer.updateMany({ where: EMPIK, data: { lastPushedQty: q-- } })
      await wyslij(at(min * M))
      await przebiegImportowStanow(db, ctx(at((min + 1) * M)))
    }
    expect(await db.channelStockImport.count({ where: { state: 'NIEUDANE' } })).toBe(2)
    expect(await db.alert.count({ where: { kind: ALERT_IMPORT_ODRZUCONE } })).toBe(3)
  })

  it('cały plik odrzucony: NIEUDANE z alertem; ten sam identyfikator importu nie tworzy drugiego wiersza', async () => {
    await konto('mirakl.empik.zapis.v1', { zapisWlaczony: true })
    await oferty()
    atr.nastepnyImportNieudany = true
    await wyslij()
    expect(await przebiegImportowStanow(db, ctx(at(M)))).toMatchObject({ nieudane: 1 })
    expect(await db.alert.count({ where: { kind: ALERT_IMPORT_ODRZUCONE } })).toBe(1)
    const { zapiszPrzyjetyImport } = await import('@/lib/kanaly/importy-stanow')
    await zapiszPrzyjetyImport(db, EMPIK, { externalRef: 'STO01:1001', reference: 'x', wierszy: 2 }, at(M))
    expect(await db.channelStockImport.count({})).toBe(1)
  })

  it('konto tylko do odczytu albo w podglądzie: ani pliku stanów, ani odczytu wyniku', async () => {
    await konto('mirakl.empik.v1', {})
    await oferty()
    await wyslij()
    await konto('mirakl.empik.zapis.v1', { zapisWlaczony: true }, 'CIEN')
    await wyslij(at(M))
    expect(await przebiegImportowStanow(db, ctx(at(5 * M)))).toMatchObject({ sprawdzone: 0 })
    expect(await db.channelStockImport.count({})).toBe(0)
    expect(atr.zapytania).toEqual([])
  })
})

describe('Empik: rodzaj konta tylko odczyt ↔ z zapisem (pkt 2)', () => {
  it('przełączenie zachowuje klucz API, wszystkie ustawienia i kursor zamówień; zapis wyłączony; wpis w dzienniku zmian', async () => {
    await konto('mirakl.empik.v1', { akceptacjaAlertGodzin: 6, envPrefix: 'EMPIK_MIRAKL' })
    atr.putOrder({ id: 'E-1', state: 'SHIPPING', lines: [{ id: 'E-1-1', sku: 'PA', qty: 1 }] })
    const poll = async (now: Date) => pollAccount(db, (await loadChannelAccounts(db)).find((a) => a.channel === 'EMPIK')!, { registry, secrets: SRC, fetch: atr.fetch, http: FAST, now: () => now, initialLookbackMs: 7 * 24 * 3600_000 })
    await poll(T)
    const przed = await db.channelCursor.findFirstOrThrow({ where: EMPIK })

    expect(await zmienRodzajKonta(db, EMPIK, 'zapis', { registry, actorId: 'test' })).toBe('mirakl.empik.zapis.v1')
    let cfg = await db.channelConfig.findUniqueOrThrow({ where })
    expect(cfg.adapterKey).toBe('mirakl.empik.zapis.v1')
    expect(cfg.config).toEqual({ baseUrl: MIRAKL_HOST, akceptacjaAlertGodzin: 6, envPrefix: 'EMPIK_MIRAKL', zapisWlaczony: false, wystawianieOfertWlaczone: false }) // zmiana rodzaju konta zeruje też wystawianie ofert
    // ustawienia z zapisem i włączony zapis: przy powrocie do odczytu zostają ustawienia, zapis wyłączony
    await db.channelConfig.update({ where, data: { config: { ...(cfg.config as Record<string, unknown>), zapisWlaczony: true, magazynEmpik: 'MAG1' } } })
    await poll(at(2 * M))
    const po = await db.channelCursor.findFirstOrThrow({ where: EMPIK })
    // ta sama rodzina adaptera: kursor, pokrycie i pierwszy odczyt bez zmian (nie czytamy od nowa)
    expect(po.adapterKey).toBe('mirakl.empik.zapis.v1')
    expect(po.firstPollAt).toEqual(przed.firstPollAt)
    expect(po.coverageFrom).toEqual(przed.coverageFrom)

    // otwarty import przy przełączeniu na odczyt zamyka się od razu, bez alertu
    await db.channelStockImport.create({ data: { ...EMPIK, externalRef: 'STO01:77', reference: 'r', wierszy: 1, nextCheckAt: at(5 * M) } })
    expect(await zmienRodzajKonta(db, EMPIK, 'odczyt', { registry, actorId: 'test' })).toBe('mirakl.empik.v1')
    expect(await db.channelStockImport.findFirstOrThrow({ where: { externalRef: 'STO01:77' } })).toMatchObject({ state: 'NIEODCZYTANY', uwaga: expect.stringContaining('tylko do odczytu') })
    expect(await db.alert.count({})).toBe(0)
    cfg = await db.channelConfig.findUniqueOrThrow({ where })
    expect(cfg.adapterKey).toBe('mirakl.empik.v1')
    expect(cfg.config).toMatchObject({ akceptacjaAlertGodzin: 6, magazynEmpik: 'MAG1', zapisWlaczony: false })
    // sekret konta ten sam: odczyt działa bez ponownego wpisywania klucza
    const r = await poll(at(4 * M))
    expect(r).toMatchObject({ bledyTrwale: 0 })
    expect((await db.channelCursor.findFirstOrThrow({ where: EMPIK })).firstPollAt).toEqual(przed.firstPollAt)
    expect(await db.integrationSecret.count({ where: { name: 'MIRAKL_API_KEY', ...EMPIK } })).toBe(1)

    const log = await db.auditLog.findMany({ where: { entity: 'ChannelConfig', entityId: 'EMPIK/empik' }, orderBy: { createdAt: 'asc' } })
    expect(log.map((l) => (l.after as { rodzaj?: string }).rodzaj)).toEqual(['zapis', 'odczyt'])
    expect(log[1]!.before).toMatchObject({ adapterKey: 'mirakl.empik.zapis.v1', zapisWlaczony: true })
    // ten sam rodzaj drugi raz: bez zmian i bez wpisu
    expect(await zmienRodzajKonta(db, EMPIK, 'odczyt', { registry, actorId: 'test' })).toBe('mirakl.empik.v1')
    expect(await db.auditLog.count({ where: { entity: 'ChannelConfig', entityId: 'EMPIK/empik' } })).toBe(2)
    expect(atr.zapisy()).toEqual([])
  })

  it('ekran konta: konto z zapisem pokazuje drogę powrotu, konto tylko do odczytu drogę do zapisu', async () => {
    await konto('mirakl.empik.v1', {})
    let e = await ekranZapisu(db, registry, EMPIK, T)
    expect(e).toMatchObject({ kluczZZapisem: 'mirakl.empik.zapis.v1', kluczTylkoOdczyt: null, importy: null })
    await konto('mirakl.empik.zapis.v1', {})
    e = await ekranZapisu(db, registry, EMPIK, T)
    expect(e).toMatchObject({ kluczTylkoOdczyt: 'mirakl.empik.v1', importy: [] })
  })

  it('polecenie `npm run konto -- rodzaj`: zmiana i komunikat; zły rodzaj i obce konto = odmowa', async () => {
    await konto('mirakl.empik.v1', {})
    expect((await rodzajKonta(db, registry, 'EMPIK/empik', 'zapis'))[0]).toContain('mirakl.empik.v1 → mirakl.empik.zapis.v1')
    expect((await rodzajKonta(db, registry, 'EMPIK/empik', 'zapis'))[0]).toContain('bez zmian')
    await expect(rodzajKonta(db, registry, 'EMPIK/empik', 'pelny')).rejects.toThrow('--na zapis albo --na odczyt')
    await expect(rodzajKonta(db, registry, 'EMPIK/nie-ma', 'odczyt')).rejects.toThrow('Nie ma konta')
    // RECZNE nie ma wersji z zapisem
    await expect(rodzajKonta(db, registry, 'RECZNE/panel', 'zapis')).rejects.toThrow()
  })
})
