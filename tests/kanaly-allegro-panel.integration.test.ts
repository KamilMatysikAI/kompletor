// „Połącz z Allegro” z panelu (device flow rozłożony na akcje) i przełącznik trybu konta, na bazie i atrapie
// Allegro (tests/allegro-atrapa.ts). Zero prawdziwych wywołań; tokeny, Client ID i kody fikcyjne. Sprawdza: zakres z
// wybranych funkcji, kod urządzenia nie wychodzi do ekranu, odstęp odpytywania i slow_down, zapis pary z zakresem,
// skasowanie znacznika odrzuconego tokenu, odmowa i wygaśnięcie bez zapisu, równoległe odpytania (jedno zużycie
// kodu), zlecenie testu połączenia, AuditLog bez wartości; tryb: warunki, idempotencja, goBy/goAt, AuditLog.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ALLEGRO_SECRETS as S } from '@/lib/adaptery/allegro'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { WOO_ZAPIS_KEY } from '@/lib/adaptery/woo-zapis'
import { writeAccountSecrets } from '@/lib/adaptery/rotacja-sekretow'
import { anulujAutoryzacje, rozpocznijAutoryzacje, sprawdzAutoryzacje, stanAllegro } from '@/lib/kanaly/allegro-autoryzacja'
import { dodajKonto, KontoError, parseKodKonta, zapiszSekrety, zmienKonto } from '@/lib/kanaly/konta'
import { platformy } from '@/lib/kanaly/platformy'
import { ustawZapisKonta, zmienTrybKonta } from '@/lib/kanaly/tryb'
import { KANAL_TEST_JOB } from '@/lib/kanaly/zadania'
import { resolveSecrets, setSecret } from '@/lib/sekrety'
import { AUTH, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegro, UA } from './allegro-atrapa'
import { testDb, truncateAll } from './db'
import { seedBase } from './rdzen-fixtures'

const db = testDb()
const db2 = testDb()
afterAll(async () => {
  await db.$disconnect()
  await db2.$disconnect()
})

const T = new Date('2026-11-06T10:00:00.000Z')
const at = (s: number) => new Date(T.getTime() + s * 1000)
const ENV = { APP_ENCRYPTION_KEY: '0'.repeat(64) }
const SRC = { env: ENV, envFallback: false }
const REF = { channel: 'ALLEGRO' as const, channelAccountId: 'allegro-panel' }
const registry = defaultRegistry()

let fake: FakeAllegro
let actor: string

const deps = (now: Date) => ({ src: SRC, actorId: actor, fetch: fake.fetch, now: () => now })
const sekrety = () => resolveSecrets(db, [S.access, S.refresh, S.expiresAt, S.scope, S.autoryzacja, S.rejected], SRC, REF)

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  actor = 'test'
  await db.channelConfig.create({ data: { ...REF, name: 'Allegro testowe', adapterKey: 'allegro.v1', config: { authUrl: AUTH, userAgent: UA } } })
  await db.channelAccountStatus.create({ data: { ...REF, createdInPanel: true } })
  await setSecret(db, S.clientId, FAKE_CLIENT_ID, ENV, REF)
  await setSecret(db, S.clientSecret, FAKE_CLIENT_SECRET, ENV, REF)
  fake = new FakeAllegro()
  fake.clock = () => T.getTime()
})

describe('Połącz z Allegro z panelu', () => {
  it('zakres z wybranych funkcji, link i kod na ekranie, kod urządzenia tylko zaszyfrowany w bazie', async () => {
    const r = await rozpocznijAutoryzacje(db, REF, ['oferty', 'zapisStanow'], deps(T))
    expect(fake.deviceCalls).toEqual([{ scope: 'allegro:api:orders:read allegro:api:sale:offers:read allegro:api:sale:offers:write' }])
    expect(r.link).toBe('https://allegro.pl/skojarz-aplikacje?code=ABC-123')
    expect(r.kod).toBe('ABC-123')
    const st = await stanAllegro(db, REF, SRC, T)
    expect(st).toMatchObject({ maKlucze: true, polaczone: false, trwa: { kod: 'ABC-123', funkcje: ['zamowienia', 'oferty', 'zapisStanow'] } })
    expect(JSON.stringify(st)).not.toContain('atrapa-device-code-TAJNE')
    const row = await db.integrationSecret.findFirstOrThrow({ where: { ...REF, name: S.autoryzacja } })
    expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain('atrapa-device-code')
    const audit = await db.auditLog.findMany({ where: { entityId: 'ALLEGRO/allegro-panel' } })
    expect(JSON.stringify(audit)).not.toMatch(/atrapa-device|TAJNE|NIE-WYPISYWAC/)
  })

  it('odpytuje najwyżej co interval, slow_down wydłuża odstęp, po zatwierdzeniu zapisuje parę z zakresem i zleca test', async () => {
    await rozpocznijAutoryzacje(db, REF, ['przesylki'], deps(T))
    expect(await sprawdzAutoryzacje(db, REF, deps(at(1)))).toEqual({ stan: 'czeka', zaSek: 4 })
    expect(fake.tokenCalls).toBe(0) // za wcześnie: bez zapytania do Allegro
    fake.deviceScript = ['authorization_pending', 'slow_down', 'ok']
    expect(await sprawdzAutoryzacje(db, REF, deps(at(5)))).toEqual({ stan: 'czeka', zaSek: 5 })
    expect(await sprawdzAutoryzacje(db, REF, deps(at(10)))).toEqual({ stan: 'czeka', zaSek: 10 })
    expect(await sprawdzAutoryzacje(db, REF, deps(at(15)))).toMatchObject({ stan: 'czeka' }) // 10 s po slow_down
    expect(fake.tokenCalls).toBe(2)
    const w = await sprawdzAutoryzacje(db, REF, deps(at(20)))
    expect(w.stan).toBe('gotowe')
    const s = await sekrety()
    expect(s[S.access]).toBeTruthy()
    expect(s[S.refresh]).toBeTruthy()
    expect(s[S.scope]).toBe('allegro:api:orders:read allegro:api:shipments:read')
    expect(s[S.autoryzacja]).toBeUndefined()
    const st = await stanAllegro(db, REF, SRC, at(21))
    expect(st).toMatchObject({ polaczone: true, odrzucone: false, funkcje: ['zamowienia', 'przesylki'], trwa: null })
    expect(await db.job.count({ where: { kind: KANAL_TEST_JOB } })).toBe(1)
  })

  it('Allegro przyznało węższy zakres niż żądany → „Kompletor może” pokazuje przyznany', async () => {
    await rozpocznijAutoryzacje(db, REF, ['przesylki'], deps(T))
    fake.grantScope = 'allegro:api:orders:read'
    fake.deviceScript = ['ok']
    expect((await sprawdzAutoryzacje(db, REF, deps(at(5)))).stan).toBe('gotowe')
    expect((await sekrety())[S.scope]).toBe('allegro:api:orders:read')
    expect(await stanAllegro(db, REF, SRC, at(6))).toMatchObject({ polaczone: true, funkcje: ['zamowienia'] })
  })

  it('nowa autoryzacja kasuje znacznik odrzuconego tokenu; odmowa i wygaśnięcie niczego nie zapisują', async () => {
    const stara = fake.issuePair()
    await writeAccountSecrets(db, REF, { [S.access]: stara.access, [S.refresh]: stara.refresh, [S.rejected]: 'odcisk' }, ENV)
    expect((await stanAllegro(db, REF, SRC, T)).odrzucone).toBe(true)

    await rozpocznijAutoryzacje(db, REF, [], deps(T))
    fake.deviceScript = ['access_denied']
    expect((await sprawdzAutoryzacje(db, REF, deps(at(5)))).stan).toBe('odmowa')
    let s = await sekrety()
    expect(s[S.refresh]).toBe(stara.refresh) // dotychczasowa para zostaje
    expect(s[S.autoryzacja]).toBeUndefined()

    await rozpocznijAutoryzacje(db, REF, [], deps(T))
    expect((await sprawdzAutoryzacje(db, REF, deps(at(3601)))).stan).toBe('wygasla')
    expect(fake.tokenCalls).toBe(1) // wygasły link: bez zapytania

    await rozpocznijAutoryzacje(db, REF, [], deps(T))
    fake.deviceScript = ['ok']
    expect((await sprawdzAutoryzacje(db, REF, deps(at(5)))).stan).toBe('gotowe')
    s = await sekrety()
    expect(s[S.rejected]).toBeUndefined()
    expect(s[S.refresh]).not.toBe(stara.refresh)
    expect((await sprawdzAutoryzacje(db, REF, deps(at(10)))).stan).toBe('brak')
  })

  it('dwa równoległe odpytania (dwie karty) zużywają kod raz', async () => {
    await rozpocznijAutoryzacje(db, REF, [], deps(T))
    fake.deviceScript = ['ok']
    fake.tokenDelayMs = 200
    const [a, b] = await Promise.all([sprawdzAutoryzacje(db, REF, deps(at(5))), sprawdzAutoryzacje(db2, REF, deps(at(5)))])
    expect([a.stan, b.stan].sort()).toEqual(['brak', 'gotowe'])
    expect(fake.tokenCalls).toBe(1)
  })

  it('anulowanie kasuje trwającą autoryzację; bez kluczy aplikacji czytelny błąd; zły Client Secret bez wartości w komunikacie', async () => {
    await rozpocznijAutoryzacje(db, REF, [], deps(T))
    expect(await anulujAutoryzacje(db, REF, actor, ENV)).toBe('ANULOWANE')
    expect((await stanAllegro(db, REF, SRC, T)).trwa).toBeNull()
    expect(await anulujAutoryzacje(db, REF, actor, ENV)).toBe('BRAK') // drugi klik: nic nie trwało, bez wpisu w historii
    expect(await db.auditLog.count({ where: { entityId: 'ALLEGRO/allegro-panel', after: { path: ['allegroAutoryzacja'], equals: 'anulowana' } } })).toBe(1)

    await setSecret(db, S.clientSecret, 'zly-sekret-XYZ', ENV, REF)
    const e = await rozpocznijAutoryzacje(db, REF, [], deps(T)).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(KontoError)
    expect((e as Error).message).toMatch(/Client ID albo Client Secret/)
    expect((e as Error).message).not.toContain('zly-sekret')

    await db.integrationSecret.deleteMany({ where: { ...REF, name: S.clientSecret } })
    await expect(rozpocznijAutoryzacje(db, REF, [], deps(T))).rejects.toThrow(/Najpierw zapisz Client ID i Client Secret/)
  })

  it('link weryfikacji spoza allegro.pl odrzucony; odpytanie po zakończeniu bez wpisu w historii', async () => {
    fake.verificationHost = 'https://allegro.pl.zly.example'
    await expect(rozpocznijAutoryzacje(db, REF, [], deps(T))).rejects.toThrow(/nieoczekiwany link/)
    expect((await stanAllegro(db, REF, SRC, T)).trwa).toBeNull()
    fake.verificationHost = 'https://allegro.pl'
    expect((await sprawdzAutoryzacje(db, REF, deps(T))).stan).toBe('brak')
    expect(await db.auditLog.count({ where: { entityId: 'ALLEGRO/allegro-panel', after: { path: ['allegroAutoryzacja'], equals: 'brak' } } })).toBe(0)
  })

  it('tylko konto Allegro', async () => {
    await expect(rozpocznijAutoryzacje(db, { channel: 'WOO', channelAccountId: 'x' }, [], deps(T))).rejects.toThrow(/nie jest konto Allegro/)
  })
})

describe('Tryb konta z panelu', () => {
  it('PRACA wymaga sprawdzonego połączenia; zmiana ustawia trzy tryby, goBy/goAt i AuditLog; ten sam tryb = bez zmian', async () => {
    const o = { actorId: actor, env: {}, registry, firmaZBl: false, now: T }
    await expect(zmienTrybKonta(db, REF, 'PRACA', o)).rejects.toThrow(/Sprawdź połączenie/)
    await db.channelAccountStatus.update({ where: { organizationId_channel_channelAccountId: { organizationId: (await db.channelConfig.findFirstOrThrow({ where: REF })).organizationId, ...REF } }, data: { testOk: true } })
    expect(await zmienTrybKonta(db, REF, 'PRACA', o)).toBe('ZMIENIONO')
    const row = await db.channelConfig.findFirstOrThrow({ where: REF })
    expect(row).toMatchObject({ stockMode: 'PRACA', statusMode: 'PRACA', trackingMode: 'PRACA', goBy: actor, goRef: 'panel:praca' })
    expect(row.goAt?.toISOString()).toBe(T.toISOString())
    expect(await zmienTrybKonta(db, REF, 'PRACA', o)).toBe('BEZ_ZMIAN')
    expect(await zmienTrybKonta(db, REF, 'CIEN', o)).toBe('ZMIENIONO')
    const audit = await db.auditLog.findMany({ where: { entityId: 'ALLEGRO/allegro-panel' }, orderBy: { createdAt: 'asc' } })
    expect(audit.map((a) => (a.after as { stockMode?: string }).stockMode)).toEqual(['PRACA', 'CIEN'])
  })

  it('firma z BaseLinkerem bez wyłącznika instancji nie przełączy na PRACA; wyłączone konto też nie', async () => {
    const orgId = (await db.channelConfig.findFirstOrThrow({ where: REF })).organizationId
    await db.channelAccountStatus.update({ where: { organizationId_channel_channelAccountId: { organizationId: orgId, ...REF } }, data: { testOk: true } })
    const o = { actorId: actor, env: {}, registry, firmaZBl: true, now: T }
    await expect(zmienTrybKonta(db, REF, 'PRACA', o)).rejects.toThrow(/przechodzących z BaseLinkera/)
    expect(await zmienTrybKonta(db, REF, 'PRACA', { ...o, env: { EKRANY_PRACA: '1' } })).toBe('ZMIENIONO')
    await zmienTrybKonta(db, REF, 'CIEN', o) // do podglądu zawsze wolno
    await db.channelConfig.updateMany({ where: REF, data: { active: false } })
    await expect(zmienTrybKonta(db, REF, 'PRACA', { ...o, firmaZBl: false })).rejects.toThrow(/wyłączone/)
  })
})

describe('Wyłącznik „Zapis do sklepu” z panelu', () => {
  const woo = () => platformy(registry).find((p) => p.klucz === 'woo')!
  const nowe = (form: Record<string, string> = {}) =>
    dodajKonto(db, { adapterKey: woo().adapterKey, name: 'Sklep zapis', form: { baseUrl: 'https://sklep.example.com', WOO_CONSUMER_KEY: 'ck_x', WOO_CONSUMER_SECRET: 'cs_x', ...form } }, { actorId: actor, env: ENV, registry })
  const cfg = async (ref: { channel: 'WOO' | 'ALLEGRO'; channelAccountId: string }) => (await db.channelConfig.findFirstOrThrow({ where: ref })).config as Record<string, unknown>

  it('spreparowany formularz kreatora nie włączy zapisu; włączenie wymaga klucza zapisu; zapis ustawień go nie rusza; AuditLog', async () => {
    const ref = (await nowe({ zapisWlaczony: 'tak' })) as { channel: 'WOO'; channelAccountId: string }
    expect((await cfg(ref))['zapisWlaczony']).toBeUndefined()
    await expect(ustawZapisKonta(db, ref, true, { actorId: actor, registry })).rejects.toThrow(/klucz z prawem zapisu/)
    await zapiszSekrety(db, ref, { WOO_WRITE_KEY: 'ck_w', WOO_WRITE_SECRET: 'cs_w' }, { actorId: actor, env: ENV, registry })
    expect(await ustawZapisKonta(db, ref, true, { actorId: actor, registry })).toBe('ZMIENIONO')
    expect(await ustawZapisKonta(db, ref, true, { actorId: actor, registry })).toBe('BEZ_ZMIAN')
    expect((await cfg(ref))['zapisWlaczony']).toBe(true)
    // zapis ustawień (także z polem wyłącznika w formularzu) zostawia wyłącznik bez zmian
    await zmienKonto(db, ref, { name: 'Sklep zapis 2', form: { baseUrl: 'https://sklep.example.com', zapisWlaczony: '' } }, { actorId: actor, env: ENV, registry })
    expect((await cfg(ref))['zapisWlaczony']).toBe(true)
    expect(await ustawZapisKonta(db, ref, false, { actorId: actor, registry })).toBe('ZMIENIONO')
    await zmienKonto(db, ref, { name: 'Sklep zapis 3', form: { baseUrl: 'https://sklep.example.com', zapisWlaczony: 'tak' } }, { actorId: actor, env: ENV, registry })
    expect((await cfg(ref))['zapisWlaczony']).toBe(false)
    const audit = await db.auditLog.findMany({ where: { entityId: `WOO/${ref.channelAccountId}`, after: { path: ['zrodlo'], equals: 'panel' } }, orderBy: { createdAt: 'asc' } })
    expect(audit.map((a) => (a.after as { zapisWlaczony: boolean }).zapisWlaczony)).toEqual([true, false])
  })

  it('konto tylko do odczytu (allegro.v1) nie włączy zapisu', async () => {
    await expect(ustawZapisKonta(db, REF, true, { actorId: actor, registry })).rejects.toThrow(/tylko czyta/)
    expect(await ustawZapisKonta(db, REF, false, { actorId: actor, registry })).toBe('BEZ_ZMIAN')
  })
})

describe('Kreator: platformy i kod konta', () => {
  it('kafel Woo zakłada konto w wersji z zapisem, zapis wyłączony, tryb podglądu; Shoper i PrestaShop mają ekran konta', async () => {
    const woo = platformy(registry).find((p) => p.klucz === 'woo')!
    const ref = await dodajKonto(db, { adapterKey: woo.adapterKey, name: 'Sklep testowy', form: { baseUrl: 'https://sklep.example.com', WOO_CONSUMER_KEY: 'ck_x', WOO_CONSUMER_SECRET: 'cs_x' } }, { actorId: actor, env: ENV, registry })
    const row = await db.channelConfig.findFirstOrThrow({ where: ref })
    expect(row.adapterKey).toBe(WOO_ZAPIS_KEY)
    expect(row.stockMode).toBe('CIEN')
    expect((row.config as Record<string, unknown>)['zapisWlaczony']).not.toBe(true)
    expect(parseKodKonta('SHOPER.sklep-1')).toEqual({ channel: 'SHOPER', channelAccountId: 'sklep-1' })
    expect(parseKodKonta('PRESTASHOP.sklep-1')).toEqual({ channel: 'PRESTASHOP', channelAccountId: 'sklep-1' })
  })
})
