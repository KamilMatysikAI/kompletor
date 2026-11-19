// Cień Allegro na bazie: konto ALLEGRO/71045 z adapterem allegro.v1 na atrapie HTTP (tests/allegro-atrapa.ts)
// → stan cienia bez kont „bez adaptera”, odczyt do rdzenia, porównanie z BL po external_order_id = checkoutForm.id,
// rotacja tokenów między dwoma procesami (dwa klienty bazy), nieudany zapis pary, odrzucony refresh token, scalone
// płatności (także stary formularz usunięty w Allegro), błąd konta przy pojedynczym zamówieniu, kursor poza retencją. Zero prawdziwych wywołań; tokeny, Client ID i dane kupujących fikcyjne.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { ALLEGRO_SECRETS as S } from '@/lib/adaptery/allegro'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { createAccountAdapter, loadChannelAccounts } from '@/lib/adaptery/konta'
import { hasOrderFeed } from '@/lib/adaptery/kontrakt'
import { AdapterConfigError } from '@/lib/adaptery/rejestr'
import { rotateAccountSecrets, SECRETS_NOT_SAVED_ALERT, writeAccountSecrets } from '@/lib/adaptery/rotacja-sekretow'
import { runBlComparison } from '@/lib/cien/bl-porownanie'
import { accountsForComparison, planOrderPolls } from '@/lib/cien/harmonogram'
import { NOT_READING_ALERT, pollAccount } from '@/lib/cien/odczyt-zamowien'
import { loadShadowReading } from '@/lib/cien/stan-odczytu'
import { resolveSecrets, setSecret } from '@/lib/sekrety'
import { authorizeAllegro } from '@/scripts/allegro-autoryzacja'
import { API, AUTH, checkoutForm, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeAllegro, UA } from './allegro-atrapa'
import { FakeBl, sec } from './bl-atrapa'
import { testDb } from './db'
import { expectInvariants, offer, product, seedBase, stockOf } from './rdzen-fixtures'

const db = testDb()
const db2 = testDb() // drugi „proces” (osobna pula połączeń), np. CLI obok workera
afterAll(async () => {
  await db.$disconnect()
  await db2.$disconnect()
})

const T = new Date('2026-10-28T12:00:00.000Z')
const at = (min: number) => new Date(T.getTime() + min * 60_000)
const iso = (min: number) => at(min).toISOString()
const ENV = { APP_ENCRYPTION_KEY: '0'.repeat(64) }
const SRC = { env: ENV, envFallback: false }
const SCOPE = { channel: 'ALLEGRO' as const, channelAccountId: '71045' }

let fake: FakeAllegro
let a: string

async function allegroAccount(d: PrismaClient = db) {
  return (await loadChannelAccounts(d)).find((x) => x.channel === 'ALLEGRO' && x.channelAccountId === '71045')!
}

async function storeTokens(expiresAt: string, pair = fake.issuePair()) {
  await writeAccountSecrets(db, SCOPE, { [S.access]: pair.access, [S.refresh]: pair.refresh, [S.expiresAt]: expiresAt }, ENV)
  return pair
}

beforeEach(async () => {
  const { truncateAll } = await import('./db')
  await truncateAll(db)
  await seedBase(db)
  // konto jak u ACME (preset seed/acme-kanaly.ts); konta testowe bez adaptera odczytu (RECZNE, stare „allegro”) wyłączone
  await db.channelConfig.updateMany({ where: { OR: [{ channel: 'RECZNE' }, { channel: 'ALLEGRO' }] }, data: { active: false } })
  await db.channelConfig.create({ data: { channel: 'ALLEGRO', channelAccountId: '71045', name: 'Allegro', adapterKey: 'allegro.v1', config: { apiUrl: API, authUrl: AUTH, userAgent: UA, envPrefix: 'ALLEGRO_SD', pollIntervalSec: 60 } } })
  await setSecret(db, S.clientId, FAKE_CLIENT_ID, ENV, SCOPE)
  await setSecret(db, S.clientSecret, FAKE_CLIENT_SECRET, ENV, SCOPE)
  fake = new FakeAllegro()
  fake.clock = () => T.getTime()
  a = await product(db, 'A', 5)
  await db.channelOffer.create({ data: { ...SCOPE, externalId: '9001', productId: a, qtyBasePerOffer: 1 } })
  await offer(db, 'WOO_SD', '10', a)
})

const poll = (now: Date, d: PrismaClient = db) => allegroAccount(d).then((acc) => pollAccount(d, acc, { registry: defaultRegistry(), secrets: SRC, fetch: fake.fetch, now: () => now }))

describe('Allegro w stanie cienia i porównaniu z BL', () => {
  it('withoutAdapter = 0, konto Allegro planowane, czytane do rdzenia i sparowane z BL po external_order_id', async () => {
    await storeTokens(iso(600))
    const st = await loadShadowReading(db, { enabled: true, now: T })
    expect(st.withoutAdapter).toBe(0)
    expect(st.details.map((d) => `${d.channel}/${d.channelAccountId}`)).toContain('ALLEGRO/71045')
    const plan = await planOrderPolls(db, defaultRegistry(), T)
    expect(plan.withoutAdapter).toEqual([])

    const formId = '29a8e3c0-7f1b-11ef-9d6f-0d1c5b7a1e01'
    fake.putForm({ id: formId, status: 'BOUGHT', updatedAt: iso(-120), lines: [{ id: 'li-1', offerId: '9001', qty: 2, price: 25 }], paid: null })
    const s = await poll(T)
    expect(s).toMatchObject({ nowe: 1, bledyTrwale: 0, doPonowienia: 0 })
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2 }) // nieopłacone rezerwuje od zakupu
    const o = await db.order.findFirstOrThrow({ where: { externalId: formId } })
    expect(o).toMatchObject({ channel: 'ALLEGRO', channelAccountId: '71045', paymentState: 'UNPAID' })
    const cur = await db.channelCursor.findFirstOrThrow({ where: SCOPE })
    expect(cur.lastOkAt?.toISOString()).toBe(T.toISOString())

    const bl = new FakeBl()
    bl.orders.push({ order_id: 8001, order_source: 'allegro', order_source_id: '71045', external_order_id: formId, order_status_id: 1, date_add: sec(iso(-115)), date_confirmed: sec(iso(-115)) })
    bl.orders.push({ order_id: 8002, order_source: 'shop', order_source_id: 'obcy', shop_order_id: 5, order_status_id: 1, date_add: sec(iso(-100)) })
    const r = await runBlComparison(db, bl.client(), { shopAccounts: ['sd', 'lampy', 'km'], empikAccountId: 'empik' }, await accountsForComparison(db), { now: T, windowMs: 4 * 3600_000 })
    const al = r.accounts.find((x) => x.channel === 'ALLEGRO' && x.channelAccountId === '71045')!
    expect(al).toMatchObject({ polled: true, inChannel: 1, inBl: 1, paired: 1, missingInBl: 0 })
    expect(Object.keys(r.unpolled).some((k) => /allegro/i.test(k))).toBe(false)
    expect((await db.order.findFirstOrThrow({ where: { externalId: formId } })).blOrderId).toBe(8001)
    // dane kupującego z atrapy nie trafiły do bazy
    const snap = await db.channelOrderSnapshot.findFirstOrThrow({ where: { externalId: formId } })
    expect(JSON.stringify(snap)).not.toMatch(/Testow|600100200|example\.invalid|kupujacy_testowy/)
    expect(fake.nonGet()).toEqual([])
    await expectInvariants(db)
  })
})

describe('tokeny konta w bazie', () => {
  it('dwa procesy z wygasłym tokenem: jedno wywołanie /auth/oauth/token, przegrany czyta świeżą parę z bazy', async () => {
    const old = await storeTokens(iso(-1))
    fake.putForm({ id: 'f1', updatedAt: iso(-5), lines: [{ id: 'l1', offerId: '9001', qty: 1 }] })
    fake.tokenDelayMs = 300
    const make = async (d: PrismaClient) => {
      const ad = await createAccountAdapter(d, defaultRegistry(), await allegroAccount(d), SRC, { fetch: fake.fetch, now: () => T })
      if (!hasOrderFeed(ad)) throw new Error('bez orders.feed')
      return ad
    }
    const [x, y] = await Promise.all([make(db), make(db2)])
    const [ox, oy] = await Promise.all([x.getOrder('f1'), y.getOrder('f1')])
    expect(ox?.externalId).toBe('f1')
    expect(oy?.externalId).toBe('f1')
    expect(fake.tokenCalls).toBe(1)
    const s = await resolveSecrets(db, [S.access, S.refresh, S.expiresAt, S.scope], SRC, SCOPE)
    expect(s[S.scope]).toBe('allegro:api:orders:read') // zakres z odpowiedzi odświeżenia, w tej samej rotacji
    expect(s[S.access]).not.toBe(old.access)
    expect(s[S.refresh]).not.toBe(old.refresh)
    expect(fake.validAccess.has(s[S.access]!)).toBe(true)
    expect(Date.parse(s[S.expiresAt]!)).toBeGreaterThan(T.getTime())
    // wartości w bazie zaszyfrowane (nie ma tokena otwartym tekstem)
    const rows = await db.integrationSecret.findMany({ where: SCOPE })
    expect(Buffer.concat(rows.map((r) => Buffer.from(r.ciphertext))).toString('latin1')).not.toContain(s[S.access]!)
  })

  it('nieudany zapis nowej pary: jedna ponowna próba; dwie nieudane → alert konta i błąd, para nieużyta', async () => {
    const old = await storeTokens(iso(-1))
    const allowed = new Set(Object.values(S))
    let attempts: number[] = []
    const rotation = (value: string) => ({
      names: [S.refresh, S.access, S.expiresAt],
      stale: { name: S.access, value },
      refresh: async () => ({ [S.access]: 'nowy-access', [S.refresh]: 'nowy-refresh', [S.expiresAt]: iso(720) }),
    })
    const out = await rotateAccountSecrets(db, SCOPE, ENV, rotation(old.access), {
      allowed,
      retryDelayMs: 10,
      hooks: {
        beforeWrite: async (n) => {
          attempts.push(n)
          if (n === 1) throw new Error('zapis nieudany')
        },
      },
    })
    expect(attempts).toEqual([1, 2])
    expect(out[S.access]).toBe('nowy-access')
    expect((await resolveSecrets(db, [S.access], SRC, SCOPE))[S.access]).toBe('nowy-access')

    attempts = []
    await expect(
      rotateAccountSecrets(db, SCOPE, ENV, rotation('nowy-access'), {
        allowed,
        retryDelayMs: 10,
        hooks: {
          beforeWrite: async (n) => {
            attempts.push(n)
            throw new Error('zapis nieudany')
          },
        },
      }),
    ).rejects.toMatchObject({ kind: 'PRZEJSCIOWY' })
    expect(attempts).toEqual([1, 2])
    expect((await resolveSecrets(db, [S.access], SRC, SCOPE))[S.access]).toBe('nowy-access')
    const al = await db.alert.findMany({ where: { kind: SECRETS_NOT_SAVED_ALERT } })
    expect(al).toHaveLength(1)
    expect(al[0]!.message).not.toContain('nowy-')
  })

  it('rotacja, którą ubiegł inny proces: blokada nie zmienia daty sekretu', async () => {
    await storeTokens(iso(-1))
    const where = { ...SCOPE, name: S.refresh }
    const before = (await db.integrationSecret.findFirstOrThrow({ where })).updatedAt
    await new Promise((r) => setTimeout(r, 20))
    await rotateAccountSecrets(db, SCOPE, ENV, { names: [S.refresh, S.access], stale: { name: S.access, value: 'już-nieaktualny' }, refresh: async () => ({}) }, { allowed: new Set(Object.values(S)) })
    expect((await db.integrationSecret.findFirstOrThrow({ where })).updatedAt).toEqual(before)
  })

  it('refresh odrzucony (invalid_grant): jeden alert konta „uruchom allegro-autoryzuj”, bez kolejnych prób odświeżania', async () => {
    const pair = await storeTokens(iso(-1))
    fake.revoked.add(pair.refresh)
    await expect(poll(T)).rejects.toBeInstanceOf(AdapterConfigError)
    expect(fake.tokenCalls).toBe(1)
    await expect(poll(at(5))).rejects.toBeInstanceOf(AdapterConfigError)
    await expect(poll(at(10))).rejects.toBeInstanceOf(AdapterConfigError)
    expect(fake.tokenCalls).toBe(1) // znacznik odrzuconego tokena w sekretach konta
    const al = await db.alert.findMany({ where: { kind: NOT_READING_ALERT, closedAt: null } })
    expect(al).toHaveLength(1)
    expect(al[0]!.ref).toBe('ALLEGRO/71045')
    expect(al[0]!.message).toContain('Allegro wymaga ponownego połączenia')
    expect(al[0]!.message).toContain('Połącz ponownie z Allegro')
    expect(al[0]!.message).not.toContain(pair.refresh)
    // ponowna autoryzacja (nowa para, znacznik skasowany) → odczyt wraca, alert zamknięty
    const fresh = fake.issuePair()
    await writeAccountSecrets(db, SCOPE, { [S.access]: fresh.access, [S.refresh]: fresh.refresh, [S.expiresAt]: iso(700) }, ENV, [S.rejected])
    await poll(at(15))
    expect(await db.alert.count({ where: { kind: NOT_READING_ALERT, closedAt: null } })).toBe(0)
  })
})

describe('scalanie płatności i retencja', () => {
  const form = (id: string, updatedAt: string) => ({ id, updatedAt, boughtAt: iso(-60), lines: [{ id: 'li-wspolna', offerId: '9001', qty: 2 }] })

  it('stary formularz pierwszy, potem nowszy z tym samym lineItem.id → rezerwuje tylko nowszy, stary anulowany', async () => {
    await storeTokens(iso(600))
    fake.putForm(form('stary', iso(-50)))
    await poll(T)
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2 })
    fake.putForm(form('nowy', iso(-10)), 'READY_FOR_PROCESSING')
    await poll(at(1))
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2 })
    expect((await db.order.findFirstOrThrow({ where: { externalId: 'stary' } })).status).toBe('ANULOWANE')
    expect((await db.order.findFirstOrThrow({ where: { externalId: 'nowy' } })).status).not.toBe('ANULOWANE')
    const snap = await db.channelOrderSnapshot.findFirstOrThrow({ where: { externalId: 'stary' } })
    expect(snap.skipReason).toBe('zastapione')
    expect(snap.warnings.join(' ')).toContain('nowy')
    // kolejne zdarzenie starego formularza nie przywraca rezerwacji
    fake.addEvent('stary', 'BUYER_MODIFIED')
    await poll(at(2))
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2 })
    await expectInvariants(db)
  })

  it('nowszy formularz pierwszy, potem stary (zdarzenia poza kolejnością) → stary pominięty, bez podwójnej rezerwacji', async () => {
    await storeTokens(iso(600))
    fake.putForm(form('nowy', iso(-10)), 'READY_FOR_PROCESSING')
    await poll(T)
    fake.putForm(form('stary', iso(-50)))
    await poll(at(1))
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2 })
    expect(await db.order.count({ where: { externalId: 'stary' } })).toBe(0)
    expect((await db.channelOrderSnapshot.findFirstOrThrow({ where: { externalId: 'stary' } })).skipReason).toBe('zastapione')
    await expectInvariants(db)
  })

  it('stary formularz usunięty w Allegro po scaleniu (404) → anulowany z danych kopii, rezerwuje tylko nowszy', async () => {
    await storeTokens(iso(600))
    fake.putForm(form('stary', iso(-50)))
    await poll(T)
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2 })
    fake.forms.delete('stary')
    fake.putForm(form('nowy', iso(-10)), 'READY_FOR_PROCESSING')
    const s = await poll(at(1))
    expect(s).toMatchObject({ bledyTrwale: 0, doPonowienia: 0 })
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2 })
    expect((await db.order.findFirstOrThrow({ where: { externalId: 'stary' } })).status).toBe('ANULOWANE')
    expect((await db.order.findFirstOrThrow({ where: { externalId: 'nowy' } })).status).not.toBe('ANULOWANE')
    const snap = await db.channelOrderSnapshot.findFirstOrThrow({ where: { externalId: 'stary' } })
    expect(snap.skipReason).toBe('zastapione')
    expect(snap.warnings.join(' ')).toMatch(/usunięty w kanale po scaleniu płatności z nowy/)
    expect(snap.warnings.join(' ')).toMatch(/zastąpiony nowszym nowy/)
    expect(await db.alert.count({ where: { kind: 'ZAMOWIENIE_KANALU_BLAD' } })).toBe(0)
    // powtórka bez skutków
    fake.addEvent('nowy', 'BUYER_MODIFIED')
    await poll(at(2))
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2 })
    await expectInvariants(db)
  })

  it('stary formularz usunięty po wysyłce: rdzeń bez zmian, alert; kolejne rewizje nowszego już go nie pobierają', async () => {
    await storeTokens(iso(600))
    fake.putForm(form('stary', iso(-50)))
    await poll(T)
    await db.order.updateMany({ where: { externalId: 'stary' }, data: { status: 'WYSLANE' } })
    fake.forms.delete('stary')
    fake.putForm(form('nowy', iso(-10)), 'READY_FOR_PROCESSING')
    await poll(at(1))
    expect((await db.order.findFirstOrThrow({ where: { externalId: 'stary' } })).status).toBe('WYSLANE')
    expect((await db.channelOrderSnapshot.findFirstOrThrow({ where: { externalId: 'stary' } })).skipReason).toBe('zastapione-po-wysylce')
    expect(await db.alert.count({ where: { kind: 'ZAMOWIENIE_ZASTAPIONE_W_KANALE' } })).toBe(1)
    const asked = () => fake.requests.filter((x) => x === 'GET /order/checkout-forms/stary').length
    const before = asked()
    fake.putForm(form('nowy', iso(-5)), 'FILLED_IN')
    await poll(at(2))
    expect(asked()).toBe(before)
  })

  it.each(['BUYER_CANCELLED', 'AUTO_CANCELLED'])('zdarzenie %s + formularz CANCELLED → rdzeń ANULOWANE, rezerwacja zwolniona', async (ev) => {
    await storeTokens(iso(600))
    fake.putForm({ id: 'f1', updatedAt: iso(-50), lines: [{ id: 'l1', offerId: '9001', qty: 2 }] })
    await poll(T)
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2 })
    fake.forms.set('f1', checkoutForm({ id: 'f1', status: 'CANCELLED', updatedAt: iso(-10), lines: [{ id: 'l1', offerId: '9001', qty: 2 }] }))
    fake.addEvent('f1', ev)
    await poll(at(1))
    expect((await db.order.findFirstOrThrow({ where: { externalId: 'f1' } })).status).toBe('ANULOWANE')
    expect(await stockOf(db, a)).toMatchObject({ reserved: 0 })
    await expectInvariants(db)
  })

  it('kursor poza retencją dziennika → lista zapasowa i alert-ostrzeżenie konta', async () => {
    await storeTokens(iso(600))
    await poll(T)
    const old = { v: 1, p: 'E', e: '000001', t: new Date(T.getTime() - 61 * 24 * 3600_000).toISOString() }
    await db.channelCursor.updateMany({ where: SCOPE, data: { cursor: JSON.stringify(old) } })
    fake.putForm({ id: 'w-luce', updatedAt: iso(-3000), lines: [{ id: 'lx', offerId: '9001', qty: 1 }] })
    const s = await poll(at(1))
    expect(s.nowe).toBe(1)
    const al = await db.alert.findMany({ where: { kind: 'KANAL_ZAMOWIENIA_OSTRZEZENIE' } })
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toMatch(/retencj/)
    // ta sama luka przy kolejnym przebiegu: bez drugiego alertu; inna luka: nowy alert
    await db.channelCursor.updateMany({ where: SCOPE, data: { cursor: JSON.stringify(old) } })
    await poll(at(2))
    expect(await db.alert.count({ where: { kind: 'KANAL_ZAMOWIENIA_OSTRZEZENIE' } })).toBe(1)
    await db.channelCursor.updateMany({ where: SCOPE, data: { cursor: JSON.stringify({ ...old, t: new Date(T.getTime() - 62 * 24 * 3600_000).toISOString() }) } })
    await poll(at(3))
    expect(await db.alert.count({ where: { kind: 'KANAL_ZAMOWIENIA_OSTRZEZENIE' } })).toBe(2)
  })
})

describe('błąd konta przy pojedynczym zamówieniu (getOrder)', () => {
  type Pair = { access: string; refresh: string }
  // awaria zaczyna się dopiero przy żądaniu danego formularza, jak w środku strony; `recover` = stan po naprawie konta
  const CASES: { name: string; fail: (pair: Pair) => void; text: RegExp; recover: () => Promise<void> }[] = [
    {
      name: 'refresh odrzucony',
      fail: (pair) => {
        fake.validAccess.clear()
        fake.revoked.add(pair.refresh)
      },
      text: /Połącz ponownie z Allegro/,
      recover: async () => {
        const fresh = fake.issuePair()
        await writeAccountSecrets(db, SCOPE, { [S.access]: fresh.access, [S.refresh]: fresh.refresh, [S.expiresAt]: iso(700) }, ENV, [S.rejected])
      },
    },
    { name: '401 także po odświeżeniu', fail: () => void fake.apiFailures.push({ status: 401 }, { status: 401 }), text: /HTTP 401/, recover: async () => undefined },
    { name: '403', fail: () => void fake.apiFailures.push({ status: 403 }), text: /HTTP 403/, recover: async () => undefined },
  ]
  const line = (id: string) => ({ id: `l-${id}`, offerId: '9001', qty: 1 })
  const failOnce = (formId: string, f: () => void) => {
    fake.beforeApi = (p) => {
      if (p !== `/order/checkout-forms/${formId}`) return
      fake.beforeApi = null
      f()
    }
  }
  const retryIds = async () => (await db.channelCursor.findFirstOrThrow({ where: SCOPE })).retryIds

  it.each(CASES)('$name przy drugim zamówieniu strony: odczyt przerwany, alert konta, kursor stoi, nic nie przepada', async (c) => {
    const pair = await storeTokens(iso(600))
    await poll(T)
    const cursor = (await db.channelCursor.findFirstOrThrow({ where: SCOPE })).cursor
    fake.putForm({ id: 'f1', updatedAt: iso(-5), lines: [line('f1')] })
    fake.putForm({ id: 'f2', updatedAt: iso(-4), lines: [line('f2')] })
    failOnce('f2', () => c.fail(pair))
    await expect(poll(at(1))).rejects.toBeInstanceOf(AdapterConfigError)
    expect((await db.channelCursor.findFirstOrThrow({ where: SCOPE })).cursor).toBe(cursor)
    expect(await retryIds()).toEqual([])
    const al = await db.alert.findMany({ where: { kind: NOT_READING_ALERT, closedAt: null } })
    expect(al).toHaveLength(1)
    expect(al[0]!.message).toMatch(c.text)
    expect(await db.alert.count({ where: { kind: 'ZAMOWIENIE_KANALU_BLAD' } })).toBe(0)
    expect(await db.order.count({ where: { externalId: 'f2' } })).toBe(0)
    await c.recover()
    const s = await poll(at(2))
    expect(s).toMatchObject({ bledyTrwale: 0, doPonowienia: 0 })
    expect(await db.order.count({ where: { externalId: { in: ['f1', 'f2'] } } })).toBe(2)
    expect(await stockOf(db, a)).toMatchObject({ reserved: 2 })
    expect(await db.alert.count({ where: { kind: NOT_READING_ALERT, closedAt: null } })).toBe(0)
    await expectInvariants(db)
  })

  it.each(CASES)('$name na liście ponowień: liczba prób bez zmian (także przy ostatniej), zamówienia nieporzucone', async (c) => {
    const pair = await storeTokens(iso(600))
    await poll(T)
    fake.forms.set('f1', checkoutForm({ id: 'f1', updatedAt: iso(-5), lines: [line('f1')] }))
    fake.forms.set('f2', checkoutForm({ id: 'f2', updatedAt: iso(-4), lines: [line('f2')] }))
    const list = [{ id: 'f1', attempts: 2 }, { id: 'f2', attempts: 4 }]
    await db.channelCursor.updateMany({ where: SCOPE, data: { retryIds: list } })
    failOnce('f1', () => c.fail(pair))
    await expect(poll(at(1))).rejects.toBeInstanceOf(AdapterConfigError)
    expect(await retryIds()).toEqual(list)
    expect(await db.alert.count({ where: { kind: NOT_READING_ALERT, closedAt: null } })).toBe(1)
    expect(await db.alert.count({ where: { kind: 'ZAMOWIENIE_KANALU_BLAD' } })).toBe(0)
    await c.recover()
    const s = await poll(at(2))
    expect(s).toMatchObject({ ponowione: 2, bledyTrwale: 0, doPonowienia: 0 })
    expect(await retryIds()).toEqual([])
    expect(await db.order.count({ where: { externalId: { in: ['f1', 'f2'] } } })).toBe(2)
  })
})

describe('komenda allegro-autoryzuj (device flow)', () => {
  const run = async (extra: { zOfertami?: boolean } = {}) => {
    const printed: string[] = []
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation((c) => (printed.push(String(c)), true)),
      vi.spyOn(process.stderr, 'write').mockImplementation((c) => (printed.push(String(c)), true)),
      ...(['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...xs: unknown[]) => void printed.push(xs.map(String).join(' ') + '\n'))),
    ]
    try {
      const code = await authorizeAllegro(db, { registry: defaultRegistry(), src: SRC, fetch: fake.fetch, wait: async () => {}, ...extra })
      return { code, printed: printed.join('') }
    } finally {
      for (const s of spies) s.mockRestore()
    }
  }

  it('pending → slow_down → sukces: para zapisana zaszyfrowana, znacznik skasowany, test OK; wyjście bez sekretów', async () => {
    await setSecret(db, S.rejected, 'stary-odcisk', ENV, SCOPE)
    fake.deviceScript = ['authorization_pending', 'slow_down', 'ok']
    const { code, printed } = await run()
    expect(code).toBe(0)
    const s = await resolveSecrets(db, Object.values(S), SRC, SCOPE)
    expect(fake.validAccess.has(s[S.access]!)).toBe(true)
    expect(s[S.refresh]).toMatch(/^atrapa-refresh-/)
    expect(s[S.rejected]).toBeUndefined()
    expect(fake.deviceCalls).toEqual([{ scope: 'allegro:api:orders:read' }])
    expect(printed).toContain('https://allegro.pl/skojarz-aplikacje?code=ABC-123')
    expect(printed).toMatch(/test połączenia: OK/)
    for (const x of [s[S.access]!, s[S.refresh]!, 'atrapa-device-code-TAJNE', FAKE_CLIENT_SECRET]) expect(printed).not.toContain(x)
    expect(fake.nonGet().every((q) => q.startsWith('POST /auth/oauth/'))).toBe(true)
  })

  it('--z-ofertami: zakres ofert w żądaniu, po zapisie odczyt pierwszej strony ofert — wypisana tylko liczba', async () => {
    fake.deviceScript = ['ok']
    fake.offers.set('15054799863', { id: '15054799863', name: 'Oferta-NIE-WYPISYWAC', external: { id: 'SKU-NIE-WYPISYWAC' }, stock: { available: 3 }, publication: { status: 'ACTIVE' } })
    const { code, printed } = await run({ zOfertami: true })
    expect(code).toBe(0)
    expect(fake.deviceCalls).toEqual([{ scope: 'allegro:api:orders:read allegro:api:sale:offers:read' }])
    expect(printed).toMatch(/odczyt ofert: OK — pierwsza strona 1 ofert/)
    expect(printed).not.toMatch(/NIE-WYPISYWAC/)
    expect(fake.nonGet().every((q) => q.startsWith('POST /auth/oauth/'))).toBe(true)
  })

  it('access_denied: nic nie zapisane, kod 1', async () => {
    fake.deviceScript = ['access_denied']
    const { code, printed } = await run()
    expect(code).toBe(1)
    expect(printed).toMatch(/odmówił/)
    expect(await db.integrationSecret.count({ where: { ...SCOPE, name: { in: [S.access, S.refresh] } } })).toBe(0)
  })
})
