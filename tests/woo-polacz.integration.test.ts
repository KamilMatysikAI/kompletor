// „Połącz z WooCommerce” (wc-auth) i podpowiedź pól zamówienia na prawdziwej bazie, ze sklepem-atrapą
// (WC REST w pamięci, tylko GET). Klucze ze „sklepu” przychodzą jak POST serwera sklepu na trasę panelu; zapis
// zaszyfrowany, znacznik jednorazowy, firma B nie dotknie konta firmy A. Zero zapytań do prawdziwego sklepu.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { filtrujPolaWp } from '@/lib/adaptery/suita-kontraktowa'
import { kontoEkran } from '@/lib/kanaly/dane'
import { dodajKonto, KontoError, uzyjPolaMeta } from '@/lib/kanaly/konta'
import { ustawZapisKonta } from '@/lib/kanaly/tryb'
import { anulujWooAuth, powrotWoo, przyjmijKluczeWoo, rozpocznijWooAuth, stanWoo, WOO_AUTORYZACJA } from '@/lib/kanaly/woo-autoryzacja'
import { KANAL_TEST_JOB, wykonajTestPolaczenia } from '@/lib/kanaly/zadania'
import { resolveSecrets } from '@/lib/sekrety'
import type { FetchLike } from '@/lib/zrodla/http'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})
const dbFor = (o: string) => (o === ORG_A ? db : o === ORG_B ? dbB : (() => { throw new Error('nieznana firma') })())

const ENV = { APP_ENCRYPTION_KEY: 'a'.repeat(64), APP_MODE: 'self-host', PANEL_URL: 'https://panel.example.pl' }
const registry = defaultRegistry()
const OPTS = { actorId: 'test', env: ENV, registry }
const T = new Date('2026-11-08T12:00:00.000Z')
const CK = `ck_${'1'.repeat(40)}`
const CS = `cs_${'2'.repeat(40)}`
const WCK = `ck_${'3'.repeat(40)}`
const WCS = `cs_${'4'.repeat(40)}`
const SCOPE = (a: { channelAccountId: string }) => ({ channel: 'WOO' as const, channelAccountId: a.channelAccountId })

beforeEach(async () => {
  await truncateAll()
})

async function konto(d: PrismaClient = db, adapterKey = 'woo.rest.v1') {
  return dodajKonto(d, { adapterKey, name: 'Sklep Woo', form: { baseUrl: 'https://sklep.example/' } }, OPTS)
}

/** wpis historii zmian od sklepu (actorId 'sklep:wc-auth') pada w bazie na czas `fn` (wyzwalacz testowy). */
async function zAwariaHistorii<T>(fn: () => Promise<T>): Promise<T> {
  const sys = testSystemDb()
  await sys.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION a137_awaria_historii() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN IF NEW."actorId" = 'sklep:wc-auth' THEN RAISE EXCEPTION 'awaria historii (test) ${CK}'; END IF; RETURN NEW; END $fn$`)
  await sys.$executeRawUnsafe('CREATE OR REPLACE TRIGGER a137_awaria_historii BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION a137_awaria_historii()')
  try {
    return await fn()
  } finally {
    await sys.$executeRawUnsafe('DROP TRIGGER IF EXISTS a137_awaria_historii ON "AuditLog"')
    await sys.$executeRawUnsafe('DROP FUNCTION IF EXISTS a137_awaria_historii()')
  }
}

/** Link ze „sklepu” → POST, jaki wysyła serwer WooCommerce po „Zatwierdź”. */
function postZeSklepu(link: string, over: Record<string, unknown> = {}) {
  const u = new URL(link)
  return { key_id: 7, user_id: u.searchParams.get('user_id'), consumer_key: CK, consumer_secret: CS, key_permissions: u.searchParams.get('scope'), ...over }
}

describe('Połącz z WooCommerce', () => {
  it('link do sklepu, klucze ze sklepu zapisane zaszyfrowane, test zlecony, drugi POST z tym samym linkiem odrzucony', async () => {
    const a = await konto()
    const link = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    const u = new URL(link)
    expect(u.origin + u.pathname).toBe('https://sklep.example/wc-auth/v1/authorize')
    expect(u.searchParams.get('callback_url')).toBe('https://panel.example.pl/api/kanaly/woo/klucze')
    expect((await stanWoo(db, a, { env: ENV, registry, now: T })).trwa).toMatchObject({ zakres: 'read' })

    const w = await przyjmijKluczeWoo(postZeSklepu(link), { env: ENV, now: T, db: dbFor })
    expect(w).toMatchObject({ status: 200, kod: 'zapisane' })
    expect(await resolveSecrets(db, ['WOO_CONSUMER_KEY', 'WOO_CONSUMER_SECRET', WOO_AUTORYZACJA], { env: ENV, envFallback: false }, SCOPE(a))).toEqual({ WOO_CONSUMER_KEY: CK, WOO_CONSUMER_SECRET: CS })
    // w bazie tylko szyfrogram
    const rows = await db.integrationSecret.findMany({ where: SCOPE(a) })
    expect(JSON.stringify(rows.map((r) => Buffer.from(r.ciphertext).toString('latin1')))).not.toContain(CK)
    expect(await db.job.count({ where: { kind: KANAL_TEST_JOB } })).toBe(1)
    expect((await stanWoo(db, a, { env: ENV, registry, now: T })).trwa).toBeNull()
    // historia zmian bez wartości kluczy
    const log = JSON.stringify(await db.auditLog.findMany({ where: { entityId: `WOO/${a.channelAccountId}` } }))
    expect(log).toContain('zapisana')
    expect(log).not.toContain(CK)
    expect(log).not.toContain(CS)

    expect(await przyjmijKluczeWoo(postZeSklepu(link, { consumer_key: `ck_${'9'.repeat(40)}` }), { env: ENV, now: T, db: dbFor })).toEqual({ status: 409, kod: 'zuzyty' })
    expect((await resolveSecrets(db, ['WOO_CONSUMER_KEY'], { env: ENV, envFallback: false }, SCOPE(a))).WOO_CONSUMER_KEY).toBe(CK)
  })

  it('nowy link unieważnia stary; inne uprawnienia niż prośba = odmowa bez zapisu; po terminie = odmowa', async () => {
    const a = await konto()
    const stary = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    const nowy = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    expect(await przyjmijKluczeWoo(postZeSklepu(stary), { env: ENV, now: T, db: dbFor })).toEqual({ status: 409, kod: 'zuzyty' })
    expect(await przyjmijKluczeWoo(postZeSklepu(nowy, { key_permissions: 'read_write' }), { env: ENV, now: T, db: dbFor })).toEqual({ status: 400, kod: 'zle-uprawnienia' })
    expect(await resolveSecrets(db, ['WOO_CONSUMER_KEY', WOO_AUTORYZACJA], { env: ENV, envFallback: false }, SCOPE(a))).toEqual({})
    const trzeci = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    expect(await przyjmijKluczeWoo(postZeSklepu(trzeci), { env: ENV, now: new Date(T.getTime() + 16 * 60_000), db: dbFor })).toEqual({ status: 410, kod: 'wygasl' })
    expect(await db.job.count({ where: { kind: KANAL_TEST_JOB } })).toBe(0)
  })

  it('anulowanie: znacznik skasowany, POST ze sklepu odrzucony, wcześniejsze klucze zostają', async () => {
    const a = await konto()
    const l1 = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    expect((await przyjmijKluczeWoo(postZeSklepu(l1), { env: ENV, now: T, db: dbFor })).status).toBe(200)
    const l2 = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    expect(await anulujWooAuth(db, a, 'test')).toBe(true)
    expect(await przyjmijKluczeWoo(postZeSklepu(l2, { consumer_key: `ck_${'8'.repeat(40)}` }), { env: ENV, now: T, db: dbFor })).toEqual({ status: 409, kod: 'zuzyty' })
    expect((await resolveSecrets(db, ['WOO_CONSUMER_KEY'], { env: ENV, envFallback: false }, SCOPE(a))).WOO_CONSUMER_KEY).toBe(CK)
  })

  it('prawo zapisu: tylko wersja z zapisem; klucz do kluczy zapisu, a odczyt dostaje go, gdy własnego nie ma', async () => {
    const tylkoOdczyt = await konto()
    await expect(rozpocznijWooAuth(db, tylkoOdczyt, 'read_write', { ...OPTS, now: T })).rejects.toThrow(/tylko czyta/)
    const a = await dodajKonto(db, { adapterKey: 'woo.rest.zapis.v1', name: 'Sklep z zapisem', form: { baseUrl: 'https://sklep.example' } }, OPTS)
    const link = await rozpocznijWooAuth(db, a, 'read_write', { ...OPTS, now: T })
    expect(new URL(link).searchParams.get('scope')).toBe('read_write')
    expect((await przyjmijKluczeWoo(postZeSklepu(link, { consumer_key: WCK, consumer_secret: WCS }), { env: ENV, now: T, db: dbFor })).status).toBe(200)
    expect(await resolveSecrets(db, ['WOO_CONSUMER_KEY', 'WOO_CONSUMER_SECRET', 'WOO_WRITE_KEY', 'WOO_WRITE_SECRET'], { env: ENV, envFallback: false }, SCOPE(a))).toEqual({
      WOO_CONSUMER_KEY: WCK,
      WOO_CONSUMER_SECRET: WCS,
      WOO_WRITE_KEY: WCK,
      WOO_WRITE_SECRET: WCS,
    })
    // drugi klucz z zapisem nie podmienia istniejącego klucza odczytu
    const l2 = await rozpocznijWooAuth(db, a, 'read_write', { ...OPTS, now: T })
    expect((await przyjmijKluczeWoo(postZeSklepu(l2, { consumer_key: `ck_${'5'.repeat(40)}`, consumer_secret: `cs_${'6'.repeat(40)}` }), { env: ENV, now: T, db: dbFor })).status).toBe(200)
    expect((await resolveSecrets(db, ['WOO_CONSUMER_KEY', 'WOO_WRITE_KEY'], { env: ENV, envFallback: false }, SCOPE(a)))).toEqual({ WOO_CONSUMER_KEY: WCK, WOO_WRITE_KEY: `ck_${'5'.repeat(40)}` })
  })

  it('izolacja firm: link firmy A nie zapisze nic w firmie B, firma B nie zacznie łączenia konta A', async () => {
    const a = await konto()
    await expect(rozpocznijWooAuth(dbB, a, 'read', { ...OPTS, now: T })).rejects.toThrow(/Nie ma takiego konta/)
    const link = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    // ten sam podpisany link, ale podany firmie B (np. pomyłka w trasie): w B nie ma znacznika
    expect(await przyjmijKluczeWoo(postZeSklepu(link), { env: ENV, now: T, db: () => dbB })).toEqual({ status: 409, kod: 'zuzyty' })
    expect(await dbB.integrationSecret.count()).toBe(0)
  })

  it('bez publicznego adresu https panelu: czytelna odmowa, nic nie zapisane', async () => {
    const a = await konto()
    await expect(rozpocznijWooAuth(db, a, 'read', { ...OPTS, env: { ...ENV, PANEL_URL: '' }, now: T })).rejects.toBeInstanceOf(KontoError)
    await expect(rozpocznijWooAuth(db, a, 'read', { ...OPTS, env: { ...ENV, PANEL_URL: 'http://panel.example.pl' }, now: T })).rejects.toThrow(/https/)
    expect(await db.integrationSecret.count()).toBe(0)
    expect((await stanWoo(db, a, { env: { ...ENV, PANEL_URL: '' }, registry, now: T })).panel.ok).toBe(false)
  })

  it('awaria wpisu historii po zapisie kluczy = dalej 200, klucze zapisane, w logu bez treści kluczy', async () => {
    const a = await konto()
    const link = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    await new Promise((r) => setTimeout(r, 5)) // POST ze sklepu przychodzi po rozpoczęciu (znacznik czasu historii)
    // wpis historii zmian ze sklepu pada (np. zerwane połączenie po commicie transakcji)
    const log: string[] = []
    const w = await zAwariaHistorii(() => przyjmijKluczeWoo(postZeSklepu(link), { env: ENV, now: T, db: dbFor, log: (m) => log.push(m) }))
    expect(w).toMatchObject({ status: 200, kod: 'zapisane' })
    expect((await resolveSecrets(db, ['WOO_CONSUMER_KEY'], { env: ENV, envFallback: false }, SCOPE(a))).WOO_CONSUMER_KEY).toBe(CK)
    expect(await db.job.count({ where: { kind: KANAL_TEST_JOB } })).toBe(1) // test połączenia zlecony mimo awarii historii
    expect(log).toHaveLength(1)
    expect(log[0]).toMatch(/wpis historii/)
    expect(log.join('\n')).not.toMatch(/ck_|cs_/)
    // powrót ze sklepu: bez wpisu „zapisana” toast i tak mówi „Połączono”, bo klucz zapisano po rozpoczęciu łączenia
    const e = await kontoEkran(db, registry, a, T)
    expect(powrotWoo(await stanWoo(db, a, { env: ENV, registry, now: T }), e!.sekrety.map((x) => x.savedAt))).toBe('polaczono')

    // odrzucenie (inne uprawnienia, wpis historii po transakcji) z awarią historii: kod odmowy bez zmian, nie 500
    const l2 = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    const w2 = await zAwariaHistorii(() => przyjmijKluczeWoo(postZeSklepu(l2, { key_permissions: 'read_write' }), { env: ENV, now: T, db: dbFor, log: (m) => log.push(m) }))
    expect(w2).toEqual({ status: 400, kod: 'zle-uprawnienia' })
    expect(log).toHaveLength(2)
  })

  it('dwa równoczesne POST z tym samym linkiem = dokładnie jedno 200 (blokada wiersza znacznika)', async () => {
    const a = await konto()
    const link = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    const wyniki = await Promise.all([
      przyjmijKluczeWoo(postZeSklepu(link), { env: ENV, now: T, db: dbFor }),
      przyjmijKluczeWoo(postZeSklepu(link, { consumer_key: WCK, consumer_secret: WCS }), { env: ENV, now: T, db: dbFor }),
    ])
    expect(wyniki.map((w) => w.status).sort()).toEqual([200, 409])
    const zapisany = (await resolveSecrets(db, ['WOO_CONSUMER_KEY', 'WOO_CONSUMER_SECRET'], { env: ENV, envFallback: false }, SCOPE(a)))
    // para kluczy z tego POST, który wygrał (nigdy klucz z jednego i sekret z drugiego)
    expect(wyniki[0]!.status === 200 ? { WOO_CONSUMER_KEY: CK, WOO_CONSUMER_SECRET: CS } : { WOO_CONSUMER_KEY: WCK, WOO_CONSUMER_SECRET: WCS }).toEqual(zapisany)
    expect(await db.job.count({ where: { kind: KANAL_TEST_JOB } })).toBe(1)
  })

  it('adres sklepu z zapytaniem i kotwicą — link wc-auth bez nich', async () => {
    const a = await konto()
    await db.channelConfig.updateMany({ where: SCOPE(a), data: { config: { baseUrl: 'https://sklep.example/sklep/?lang=pl' } } })
    const u = new URL(await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T }))
    expect(u.origin + u.pathname).toBe('https://sklep.example/sklep/wc-auth/v1/authorize')
    expect(u.searchParams.get('lang')).toBeNull()
  })

  it('„Połączono” po powrocie tylko, gdy to łączenie zapisało klucze', async () => {
    const a = await konto()
    const powrot = async (now = T) => powrotWoo(await stanWoo(db, a, { env: ENV, registry, now }), (await kontoEkran(db, registry, a, now))!.sekrety.map((x) => x.savedAt))
    const pozniej = new Date(T.getTime() + 16 * 60_000)
    const chwila = () => new Promise((r) => setTimeout(r, 5)) // kolejność znaczników czasu historii i zapisu kluczy
    expect(await powrot()).toBe('nie-trwa') // nigdy nie łączono (bez obietnicy odświeżenia)
    const l1 = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    expect(await powrot()).toBe('czeka') // link wysłany, kluczy brak
    await chwila()
    await przyjmijKluczeWoo(postZeSklepu(l1), { env: ENV, now: T, db: dbFor })
    expect(await powrot()).toBe('polaczono')
    // konto ma już klucze, nowe łączenie odrzucone po terminie (bez dotykania bazy): nie „Połączono”
    await chwila()
    const l2 = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    expect(await przyjmijKluczeWoo(postZeSklepu(l2), { env: ENV, now: pozniej, db: dbFor })).toEqual({ status: 410, kod: 'wygasl' })
    expect(await powrot(pozniej)).toBe('wygasl')
    const l3 = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    await przyjmijKluczeWoo(postZeSklepu(l3, { key_permissions: 'read_write' }), { env: ENV, now: T, db: dbFor })
    expect(await powrot()).toBe('zle-uprawnienia')
    // podpisany POST z kluczem o złym kształcie zużywa znacznik i zostawia wynik w historii
    const l4 = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    await chwila()
    expect(await przyjmijKluczeWoo(postZeSklepu(l4, { consumer_key: 'ck_za-krotki' }), { env: ENV, now: T, db: dbFor })).toEqual({ status: 400, kod: 'zly-ksztalt' })
    expect(await powrot()).toBe('zly-ksztalt')
    expect(await przyjmijKluczeWoo(postZeSklepu(l4), { env: ENV, now: T, db: dbFor })).toEqual({ status: 409, kod: 'zuzyty' }) // znacznik zużyty
    await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    await chwila()
    await anulujWooAuth(db, a, 'test')
    expect(await powrot()).toBe('nie-trwa') // anulowane: ekran nie obiecuje odświeżenia
  })
})

/** Sklep-atrapa: ostatnie zamówienia z polami wtyczek; tylko GET. */
function sklepZPolami(methods: string[]): FetchLike {
  const auth = `Basic ${Buffer.from(`${CK}:${CS}`).toString('base64')}`
  const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
  return async (url, init) => {
    methods.push(init?.method ?? 'GET')
    if ((init?.headers as Record<string, string>)['Authorization'] !== auth) return new Response('{}', { status: 401 })
    const u = new URL(url)
    const path = u.pathname.replace(/^\/wp-json\/wc\/v3/, '')
    if (path === '/settings/products/woocommerce_hold_stock_minutes') return json({ value: '60' })
    if (path === '/orders') {
      const zam = [
        { id: 3, meta_data: [{ key: '_billing_nip', value: 'NIP 1234563218' }, { key: '_paczkomat_id', value: 'POZ01M' }] },
        { id: 2, meta_data: [{ key: '_billing_nip', value: '' }, { key: '_billing_faktura', value: '1' }] },
        { id: 1, meta_data: [{ key: '_wfirma_invoice_id', value: '42' }] },
      ]
      // `_fields` jak w WordPressie
      return json(filtrujPolaWp(zam.slice(0, Number(u.searchParams.get('per_page') ?? 10)), u.searchParams.get('_fields')), { 'x-wp-total': '3', 'x-wp-totalpages': '1' })
    }
    return new Response('{}', { status: 404 })
  }
}

describe('Pola zamówienia z testu połączenia', () => {
  it('test zapisuje same nazwy pól; ekran je pokazuje; „Użyj” tylko dla wykrytej nazwy, z historią zmian', async () => {
    const a = await konto()
    const link = await rozpocznijWooAuth(db, a, 'read', { ...OPTS, now: T })
    await przyjmijKluczeWoo(postZeSklepu(link), { env: ENV, now: T, db: dbFor })
    const methods: string[] = []
    const r = await wykonajTestPolaczenia(db, a, { registry, secrets: { env: ENV, envFallback: false }, fetch: sklepZPolami(methods), now: () => T })
    expect(r).toMatchObject({ ok: true })
    expect(new Set(methods)).toEqual(new Set(['GET']))
    const st = await db.channelAccountStatus.findFirstOrThrow({ where: SCOPE(a) })
    expect(JSON.stringify(st.testMetaKeys)).not.toMatch(/1234563218|POZ01M/)
    const e = await kontoEkran(db, registry, a, T)
    expect(e!.wykryteMeta).toMatchObject({ sample: 3, keys: expect.arrayContaining([{ key: '_billing_nip', orders: 2 }, { key: '_paczkomat_id', orders: 1 }]) })

    await expect(uzyjPolaMeta(db, a, 'nipMetaKey', '_nie_bylo', OPTS)).rejects.toThrow(/nie było w ostatnich zamówieniach/)
    await expect(uzyjPolaMeta(db, a, 'baseUrl', '_billing_nip', OPTS)).rejects.toThrow(/Nieznane pole/)
    expect(await uzyjPolaMeta(db, a, 'nipMetaKey', '_billing_nip', OPTS)).toBe('ZMIENIONO')
    expect(await uzyjPolaMeta(db, a, 'nipMetaKey', '_billing_nip', OPTS)).toBe('BEZ_ZMIAN')
    const cfg = (await db.channelConfig.findFirstOrThrow({ where: SCOPE(a) })).config as Record<string, unknown>
    expect(cfg).toMatchObject({ baseUrl: 'https://sklep.example', nipMetaKey: '_billing_nip' }) // reszta konfiguracji bez zmian
    expect(await db.auditLog.count({ where: { entityId: `WOO/${a.channelAccountId}`, after: { path: ['nipMetaKey'], equals: '_billing_nip' } } })).toBe(1)

    // nieudany test nie kasuje wykrytych nazw
    await wykonajTestPolaczenia(db, a, { registry, secrets: { env: ENV, envFallback: false }, fetch: async () => new Response('{}', { status: 401 }), now: () => T })
    expect((await kontoEkran(db, registry, a, T))!.wykryteMeta?.keys.length).toBe(4)
  })

  it('/ w akcji: pusty przedrostek env nie zastępuje klucza zapisu; instancja bez trybu pracy nie blokuje włączenia', async () => {
    const a = await dodajKonto(db, { adapterKey: 'woo.rest.zapis.v1', name: 'Sklep z zapisem', form: { baseUrl: 'https://sklep.example' } }, OPTS)
    await db.channelConfig.updateMany({ where: SCOPE(a), data: { config: { baseUrl: 'https://sklep.example', envPrefix: '' } } })
    await expect(ustawZapisKonta(db, a, true, { actorId: 'test', registry, env: ENV, firmaZBl: true })).rejects.toThrow(/klucz z prawem zapisu/)
    const link = await rozpocznijWooAuth(db, a, 'read_write', { ...OPTS, now: T })
    await przyjmijKluczeWoo(postZeSklepu(link, { consumer_key: WCK, consumer_secret: WCS }), { env: ENV, now: T, db: dbFor })
    expect(await ustawZapisKonta(db, a, true, { actorId: 'test', registry, env: ENV, firmaZBl: true })).toBe('ZMIENIONO')
  })
})
