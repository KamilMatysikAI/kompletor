// alerty na Zulip — wysyłka z atrapą Zulipa zamiast sieci.
//  1. obie bramki (env POWIADOMIENIA_WYSYLKA i włącznik firmy) domyślnie zamknięte: zero wywołań atrapy;
//  2. włączenie nie wysyła starszych alertów; powtórka i równoległe przebiegi nie dublują;
//  3. 429 z ponowieniem (najwyżej 5 prób), timeout = UNCERTAIN bez ponowienia, porzucony SENDING = UNCERTAIN,
//     401 wyłącza wysyłkę firmy; limit na przebieg i na godzinę; błąd jednego alertu nie zatrzymuje reszty;
//  4. dwie firmy: izolacja i osobne trasy; treść bez danych klientów; nieznany rodzaj → „Inne”; host spoza listy;
//  5. zapis ustawień (walidacja, AuditLog, enabledAt), wiadomość próbna za tą samą bramką.
// Dane wyłącznie zmyślone (domeny .test, numery fikcyjne).
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { setSecret } from '@/lib/sekrety'
import { NotificationConfigError } from '@/lib/powiadomienia/adres'
import { ALERT_GROUPS, DEFAULT_ROUTES } from '@/lib/powiadomienia/grupy'
import { notificationView, saveNotificationSettings, sendTestNotification, type NotificationInput } from '@/lib/powiadomienia/ustawienia'
import { PER_HOUR, PER_RUN, runZulipDeliveries } from '@/lib/powiadomienia/wysylka'
import type { FetchLike } from '@/lib/zrodla/http'
import { HARMONOGRAM_RDZENIA } from '@/lib/worker/harmonogram'
import { handlers } from '@/lib/worker/zadania'
import { ORG_B, testDb, testSystemDb, truncateAll } from './db'

const KEY_HEX = 'ab'.repeat(32)
const ENV = { POWIADOMIENIA_WYSYLKA: '1', APP_ENCRYPTION_KEY: KEY_HEX }
const API_KEY = 'zulip-klucz-testowy-0001'
const T0 = new Date('2026-11-02T10:00:00Z')
const min = (n: number) => new Date(T0.getTime() + n * 60_000)

type Reply = number | 'timeout' | 'refused' | 'throw'
interface Call {
  url: string
  to: string
  topic: string
  content: string
  auth: string
}

/** Atrapa Zulipa: zapisuje wywołania, odpowiada kolejno z listy (potem 200). */
function atrapa(replies: Reply[] = []) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    const b = new URLSearchParams(String(init?.body ?? ''))
    calls.push({ url, to: b.get('to')!, topic: b.get('topic')!, content: b.get('content')!, auth: String((init?.headers as Record<string, string>).Authorization) })
    const r = replies.shift() ?? 200
    if (r === 'timeout')
      return new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    if (r === 'refused') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    if (r === 'throw') throw new Error('atrapa: nieoczekiwany wyjątek')
    const body = r === 200 ? { result: 'success', msg: '', id: calls.length } : { result: 'error', msg: 'x', code: r === 429 ? 'RATE_LIMIT_HIT' : r === 401 ? 'UNAUTHORIZED' : 'BAD_REQUEST' }
    return new Response(JSON.stringify(body), { status: r })
  }
  return { calls, fetch }
}

const a = testDb()
const a2 = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()

const input = (over: Partial<NotificationInput> = {}): NotificationInput => ({
  enabled: true,
  zulipSite: 'https://firma-a.zulipchat.com',
  zulipBotEmail: 'kompletor-bot@firma-a.zulipchat.com',
  routes: Object.fromEntries(ALERT_GROUPS.map((g) => [g, { stream: DEFAULT_ROUTES[g]!.stream, topic: DEFAULT_ROUTES[g]!.topic }])) as NotificationInput['routes'],
  ...over,
})

async function enable(db: PrismaClient, at: Date, over: Partial<NotificationInput> = {}) {
  await saveNotificationSettings(db, input(over), 'osoba-testowa', ENV, at)
}

async function addAlert(db: PrismaClient, createdAt: Date, kind = 'FAKTURA_BLAD', ref = 'SD-1001', message = 'błąd testowy') {
  return (await db.alert.create({ data: { kind, ref, message, createdAt } })).id
}

const run = (db: PrismaClient, fetch: FetchLike, now: Date, env: Record<string, string> = ENV, timeoutMs?: number) => runZulipDeliveries(db, env, { fetch, now: () => now, timeoutMs })

beforeEach(async () => {
  await truncateAll()
  await setSecret(a, 'ZULIP_API_KEY', API_KEY, ENV)
  await setSecret(b, 'ZULIP_API_KEY', 'zulip-klucz-testowy-b', ENV)
})
afterAll(async () => {
  await Promise.all([a.$disconnect(), a2.$disconnect(), b.$disconnect()])
})

describe('bramki: domyślnie nic nie wychodzi', () => {
  it('bez env, bez włącznika firmy, bez obu = zero wywołań atrapy i zero wierszy', async () => {
    await addAlert(a, min(1))
    const z = atrapa()
    // firma nie ma ustawień (domyślnie wyłączone), env włączony
    expect((await run(a, z.fetch, min(2))).skipped).toBe('firma')
    await enable(a, T0)
    await addAlert(a, min(1))
    for (const env of [{}, { POWIADOMIENIA_WYSYLKA: '0' }, { POWIADOMIENIA_WYSYLKA: '', APP_ENCRYPTION_KEY: KEY_HEX }]) {
      expect((await run(a, z.fetch, min(2), env as Record<string, string>)).skipped).toBe('env')
    }
    await enable(a, T0, { enabled: false })
    expect((await run(a, z.fetch, min(2))).skipped).toBe('firma')
    expect(z.calls).toHaveLength(0)
    expect(await a.alertDelivery.count()).toBe(0)
    // zła wartość env = błąd, nie wysyłka
    await enable(a, T0)
    await expect(run(a, z.fetch, min(2), { POWIADOMIENIA_WYSYLKA: 'tak' })).rejects.toThrow(/POWIADOMIENIA_WYSYLKA/)
    expect(z.calls).toHaveLength(0)
  })

  it('zadanie w harmonogramie co 60 s i w rejestrze; handler bez env nic nie wysyła', async () => {
    expect(HARMONOGRAM_RDZENIA).toContainEqual({ kind: 'powiadomienia-zulip', everyMs: 60_000 })
    expect(handlers['powiadomienia-zulip']).toBeTypeOf('function')
    await enable(a, T0)
    await addAlert(a, new Date())
    await handlers['powiadomienia-zulip']!(a, null, { organizationId: 'test_a', secrets: { env: { APP_ENCRYPTION_KEY: KEY_HEX }, envFallback: false } })
    expect(await a.alertDelivery.count()).toBe(0)
  })
})

describe('wysyłka bez duplikatów', () => {
  it('włączenie nie wysyła starszych alertów; powtórka przebiegu nie dubluje', async () => {
    await addAlert(a, min(-30), 'FAKTURA_BLAD', 'STARY-1')
    await enable(a, T0)
    await addAlert(a, min(1), 'FAKTURA_BLAD', 'NOWY-1')
    const z = atrapa()
    const r = await run(a, z.fetch, min(2))
    expect(r.sent).toBe(1)
    expect(z.calls.map((c) => c.content.includes('NOWY-1'))).toEqual([true])
    expect(z.calls[0]!.url).toBe('https://firma-a.zulipchat.com/api/v1/messages')
    expect(Buffer.from(z.calls[0]!.auth.replace('Basic ', ''), 'base64').toString()).toBe(`kompletor-bot@firma-a.zulipchat.com:${API_KEY}`)
    expect(z.calls[0]).toMatchObject({ to: 'Biuro', topic: 'Faktury' })
    await run(a, z.fetch, min(3))
    await run(a, z.fetch, min(4))
    expect(z.calls).toHaveLength(1)
    expect(await a.alertDelivery.findMany({ select: { state: true, attempts: true } })).toEqual([{ state: 'SENT', attempts: 1 }])
    // wyłączenie i ponowne włączenie: enabledAt przesuwa się, alerty z przerwy nie wychodzą
    await enable(a, min(5), { enabled: false })
    await addAlert(a, min(6), 'FAKTURA_BLAD', 'W-PRZERWIE')
    await enable(a, min(7))
    await run(a, z.fetch, min(8))
    expect(z.calls).toHaveLength(1)
  })

  it('równoległe przebiegi (dwa klienty) wysyłają każdy alert raz', async () => {
    await enable(a, T0)
    for (let i = 0; i < 8; i++) await addAlert(a, min(1), 'FAKTURA_BLAD', `R-${i}`)
    const z = atrapa()
    await Promise.all([run(a, z.fetch, min(2)), run(a2, z.fetch, min(2)), run(a, z.fetch, min(2))])
    expect(z.calls).toHaveLength(8)
    expect(new Set(z.calls.map((c) => c.content)).size).toBe(8)
    expect(await a.alertDelivery.count({ where: { state: 'SENT' } })).toBe(8)
  })

  it('429 i brak połączenia: ponowienie z odstępem, najwyżej 5 prób, potem FAILED', async () => {
    await enable(a, T0)
    await addAlert(a, min(1))
    const z = atrapa([429, 'refused', 429, 429, 429])
    let r = await run(a, z.fetch, min(2))
    expect(r.retry).toBe(1)
    // przed upływem odstępu nic
    await run(a, z.fetch, min(2.5))
    expect(z.calls).toHaveLength(1)
    for (const t of [4, 10, 30, 60]) r = await run(a, z.fetch, min(t))
    expect(z.calls).toHaveLength(5)
    expect(r.failed).toBe(1)
    const d = await a.alertDelivery.findFirstOrThrow()
    expect(d).toMatchObject({ state: 'FAILED', attempts: 5, nextAttemptAt: null })
    expect(d.lastError).toMatch(/429/)
    await run(a, z.fetch, min(200))
    expect(z.calls).toHaveLength(5)
  })

  it('429, potem 200: jedna wiadomość', async () => {
    await enable(a, T0)
    await addAlert(a, min(1))
    const z = atrapa([429])
    await run(a, z.fetch, min(2))
    await run(a, z.fetch, min(4))
    expect(z.calls).toHaveLength(2)
    expect(await a.alertDelivery.findFirstOrThrow()).toMatchObject({ state: 'SENT', attempts: 2 })
  })

  it('timeout po wysłaniu = UNCERTAIN bez ponowienia; błąd jednego alertu nie zatrzymuje reszty', async () => {
    await enable(a, T0)
    await addAlert(a, min(1), 'FAKTURA_BLAD', 'T-1')
    await addAlert(a, min(1.1), 'FAKTURA_BLAD', 'T-2')
    await addAlert(a, min(1.2), 'FAKTURA_BLAD', 'T-3')
    const z = atrapa(['timeout', 'throw'])
    const r = await run(a, z.fetch, min(2), ENV, 40)
    expect(r.uncertain).toBe(2) // timeout i nieznany wyjątek fetch: wiadomość mogła dojść
    expect(r.sent).toBe(1)
    await run(a, z.fetch, min(30), ENV, 40)
    await run(a, z.fetch, min(90), ENV, 40)
    expect(z.calls).toHaveLength(3)
    expect((await a.alertDelivery.findMany({ orderBy: { createdAt: 'asc' } })).map((d) => d.state).sort()).toEqual(['SENT', 'UNCERTAIN', 'UNCERTAIN'])
  })

  it('porzucony SENDING starszy niż 10 min = UNCERTAIN, bez wysyłki', async () => {
    await enable(a, T0)
    const id = await addAlert(a, min(1))
    await a.alertDelivery.create({ data: { alertId: id, kind: 'FAKTURA_BLAD', group: 'FAKTURY', state: 'SENDING', attempts: 1, lastAttemptAt: min(2) } })
    const z = atrapa()
    expect((await run(a, z.fetch, min(5))).stale).toBe(0)
    expect((await run(a, z.fetch, min(13))).stale).toBe(1)
    expect(z.calls).toHaveLength(0)
    expect((await a.alertDelivery.findFirstOrThrow()).state).toBe('UNCERTAIN')
  })

  it('401 wyłącza wysyłkę firmy z powodem na ekranie; kolejne alerty czekają', async () => {
    await enable(a, T0)
    await addAlert(a, min(1), 'FAKTURA_BLAD', 'A-1')
    await addAlert(a, min(1.1), 'FAKTURA_BLAD', 'A-2')
    const z = atrapa([401])
    const r = await run(a, z.fetch, min(2))
    expect(r.disabled).toBe(true)
    expect(z.calls).toHaveLength(1)
    const s = await a.notificationSettings.findFirstOrThrow()
    expect(s.enabled).toBe(false)
    expect(s.lastError).toMatch(/401/)
    expect(s.lastError).not.toContain(API_KEY)
    expect((await notificationView(a, ENV)).lastError).toMatch(/wyłączona/)
    await run(a, z.fetch, min(3))
    expect(z.calls).toHaveLength(1)
    // ponowne włączenie czyści błąd; po automatycznym wyłączeniu wysyłka wznawia się od dawnego
    // enabledAt, więc alert z przerwy (A-2) wychodzi; A-1 (odrzucony 401) nie wraca
    await addAlert(a, min(3.5), 'FAKTURA_BLAD', 'A-3')
    await enable(a, min(4))
    const s2 = await a.notificationSettings.findFirstOrThrow()
    expect(s2.lastError).toBeNull()
    expect(s2.enabledAt).toEqual(T0)
    const r2 = await run(a, z.fetch, min(5))
    expect(r2.sent).toBe(2)
    expect(z.calls.map((c) => c.content).join(' ')).toMatch(/A-2[\s\S]*A-3/)
    expect(z.calls.filter((c) => c.content.includes('`A-1`'))).toHaveLength(1)
  })

  it('wyłączenie po 401 dawniej niż 3 dni: ponowne włączenie liczy od teraz', async () => {
    await enable(a, T0)
    await addAlert(a, min(1), 'FAKTURA_BLAD', 'B-1')
    const z = atrapa([401])
    await run(a, z.fetch, min(2))
    await addAlert(a, min(10), 'FAKTURA_BLAD', 'B-2')
    const later = new Date(T0.getTime() + 4 * 24 * 3600_000)
    await enable(a, later)
    expect((await a.notificationSettings.findFirstOrThrow()).enabledAt).toEqual(later)
    expect((await run(a, z.fetch, new Date(later.getTime() + 60_000))).sent).toBe(0)
  })

  it('alert zamknięty w panelu przed wysyłką nie wychodzi; zamknięty w trakcie ponowień przestaje wracać', async () => {
    await enable(a, T0)
    const closed = await addAlert(a, min(1), 'FAKTURA_BLAD', 'C-1')
    await a.alert.update({ where: { id: closed }, data: { closedAt: min(1.5) } })
    const retried = await addAlert(a, min(1), 'FAKTURA_BLAD', 'C-2')
    const z = atrapa([429])
    const r = await run(a, z.fetch, min(2))
    expect(r.retry).toBe(1)
    expect(z.calls).toHaveLength(1)
    expect(z.calls[0]!.content).toContain('`C-2`')
    await a.alert.update({ where: { id: retried }, data: { closedAt: min(2.5) } })
    await run(a, z.fetch, min(10))
    expect(z.calls).toHaveLength(1)
    expect(await a.alertDelivery.findFirstOrThrow({ where: { alertId: retried } })).toMatchObject({ state: 'FAILED', nextAttemptAt: null, lastError: 'alert zamknięty przed wysyłką' })
    expect(await a.alertDelivery.count({ where: { alertId: closed } })).toBe(0)
  })

  it('limit 20 na przebieg i 100 na godzinę; nadmiar czeka', async () => {
    await enable(a, T0)
    for (let i = 0; i < 130; i++) await addAlert(a, new Date(min(1).getTime() + i), 'NIEZMIENNIK', `L-${i}`)
    const z = atrapa()
    const first = await run(a, z.fetch, min(2))
    expect(first.sent).toBe(PER_RUN)
    expect(first.deferred).toBeGreaterThan(0)
    for (let t = 3; t < 10; t++) await run(a, z.fetch, min(t))
    expect(z.calls).toHaveLength(PER_HOUR)
    const capped = await run(a, z.fetch, min(30))
    expect(capped.skipped).toBe('limit')
    expect(z.calls).toHaveLength(PER_HOUR)
    // najstarsze pierwsze
    expect(z.calls[0]!.content).toContain('`L-0`')
    await run(a, z.fetch, min(63))
    expect(z.calls).toHaveLength(PER_HOUR + PER_RUN)
  })
})

describe('trasy, treść, firmy', () => {
  it('dwie firmy: izolacja i osobne trasy', async () => {
    await enable(a, T0)
    await saveNotificationSettings(
      b,
      input({ zulipSite: 'https://firma-b.zulipchat.com', zulipBotEmail: 'bot@firma-b.zulipchat.com', routes: { ...input().routes, MAGAZYN: { stream: 'Hala B', topic: 'Półki' } } }),
      'osoba-b',
      ENV,
      T0,
    )
    await addAlert(a, min(1), 'BRAK_NA_POLCE', 'PROD-A')
    await addAlert(b, min(1), 'BRAK_NA_POLCE', 'PROD-B')
    const za = atrapa()
    const zb = atrapa()
    await run(a, za.fetch, min(2))
    expect(za.calls).toHaveLength(1)
    expect(za.calls[0]).toMatchObject({ to: 'Magazyn', topic: 'Magazyn' })
    expect(za.calls[0]!.content).toContain('Firma testowa A')
    expect(za.calls[0]!.content).not.toContain('PROD-B')
    expect(await b.alertDelivery.count()).toBe(0)
    await run(b, zb.fetch, min(2))
    expect(zb.calls).toHaveLength(1)
    expect(zb.calls[0]).toMatchObject({ url: 'https://firma-b.zulipchat.com/api/v1/messages', to: 'Hala B', topic: 'Półki' })
    expect(Buffer.from(zb.calls[0]!.auth.replace('Basic ', ''), 'base64').toString()).toBe('bot@firma-b.zulipchat.com:zulip-klucz-testowy-b')
    expect(await sys.alertDelivery.count()).toBe(2)
  })

  it('treść bez danych klientów, nawet gdy Alert.message je zawiera', async () => {
    await enable(a, T0)
    await addAlert(a, min(1), 'FAKTURA_BLAD', 'SD-2002', 'wFirma: NIP 0000000000, nabywca jan.testowy@przyklad.test, tel. +48 600 000 001, ul. Zmyślona 1')
    await addAlert(a, min(1.1), 'ZAMOWIENIE_KANALU_BLAD', 'ALLEGRO_SD/71045', 'Adam Fikcyjny, adam@przyklad.test, 600-000-002')
    const z = atrapa()
    await run(a, z.fetch, min(2))
    expect(z.calls).toHaveLength(2)
    for (const c of z.calls) {
      for (const bad of ['jan.testowy', 'przyklad.test', '600', 'Zmyślona', 'Adam', 'NIP', '0000000000']) expect(c.content).not.toContain(bad)
    }
    expect(z.calls[0]!.content).toContain('SD-2002')
    expect(z.calls[1]!.content).toContain('ALLEGRO_SD/71045')
    const d = await a.alertDelivery.findMany()
    for (const x of d) expect(JSON.stringify(x)).not.toContain('przyklad.test')
  })

  it('nieznany rodzaj → „Inne”; grupa bez trasy = FAILED bez wysyłki i bez ponawiania', async () => {
    await enable(a, T0, { routes: { ...input().routes, FAKTURY: { stream: '', topic: '' }, INNE: { stream: 'Ogólny', topic: 'Różne' } } })
    await addAlert(a, min(1), 'RODZAJ_Z_PRZYSZLOSCI', 'X-1')
    await addAlert(a, min(1.1), 'FAKTURA_BLAD', 'X-2')
    const z = atrapa()
    const r = await run(a, z.fetch, min(2))
    expect(r).toMatchObject({ sent: 1, noRoute: 1 })
    expect(z.calls[0]).toMatchObject({ to: 'Ogólny', topic: 'Różne' })
    expect(z.calls[0]!.content).toContain('RODZAJ_Z_PRZYSZLOSCI')
    const fail = await a.alertDelivery.findFirstOrThrow({ where: { kind: 'FAKTURA_BLAD' } })
    expect(fail).toMatchObject({ state: 'FAILED', nextAttemptAt: null, group: 'FAKTURY' })
    await run(a, z.fetch, min(60))
    expect(z.calls).toHaveLength(1)
  })

  it('adres spoza listy: odrzucony przy zapisie i drugi raz przed wysyłką', async () => {
    await expect(enable(a, T0, { zulipSite: 'https://zulip.obcy.test' })).rejects.toThrow(NotificationConfigError)
    await expect(enable(a, T0, { zulipSite: 'https://10.0.0.5' })).rejects.toThrow(NotificationConfigError)
    expect(await a.notificationSettings.count()).toBe(0)
    // zapis przy liście hostów firmy self-host, potem lista w env się zmienia
    await saveNotificationSettings(a, input({ zulipSite: 'https://zulip.firma.test' }), 'osoba-testowa', { ...ENV, ZULIP_DOZWOLONE_HOSTY: 'zulip.firma.test' }, T0)
    await addAlert(a, min(1))
    const z = atrapa()
    const r = await run(a, z.fetch, min(2))
    expect(r.skipped).toBe('konfiguracja')
    expect(z.calls).toHaveLength(0)
    expect((await a.notificationSettings.findFirstOrThrow()).lastError).toMatch(/spoza listy/)
    await run(a, z.fetch, min(3), { ...ENV, ZULIP_DOZWOLONE_HOSTY: 'zulip.firma.test' })
    expect(z.calls).toHaveLength(1)
    expect((await a.notificationSettings.findFirstOrThrow()).lastError).toBeNull()
  })

  it('brak klucza bota: nic nie wychodzi, powód w ustawieniach', async () => {
    await a.integrationSecret.deleteMany()
    await enable(a, T0)
    await addAlert(a, min(1))
    const z = atrapa()
    expect((await run(a, z.fetch, min(2))).skipped).toBe('konfiguracja')
    expect(z.calls).toHaveLength(0)
    const v = await notificationView(a, ENV)
    expect(v.keySet).toBe(false)
    expect(v.lastError).toMatch(/ZULIP_API_KEY/)
  })
})

describe('ustawienia i wiadomość próbna', () => {
  it('zapis: AuditLog z autorem, enabledAt przy każdym włączeniu, walidacja strumienia; widok bez klucza', async () => {
    await enable(a, T0)
    await enable(a, min(5)) // zapis przy włączonym: enabledAt bez zmian
    expect((await a.notificationSettings.findFirstOrThrow()).enabledAt).toEqual(T0)
    await enable(a, min(6), { enabled: false })
    await enable(a, min(7))
    expect((await a.notificationSettings.findFirstOrThrow()).enabledAt).toEqual(min(7))
    const logs = await a.auditLog.findMany({ where: { entity: 'NotificationSettings' } })
    expect(logs).toHaveLength(4)
    expect(logs.every((l) => l.actorId === 'osoba-testowa')).toBe(true)
    await expect(enable(a, min(8), { routes: { ...input().routes, MAGAZYN: { stream: 'x'.repeat(61), topic: 't' } } })).rejects.toThrow(/60/)
    await expect(enable(a, min(8), { zulipBotEmail: '' })).rejects.toThrow(/adres bota/)
    const v = await notificationView(a, ENV)
    expect(v).toMatchObject({ enabled: true, keySet: true, instanceSending: true })
    expect(JSON.stringify(v)).not.toContain(API_KEY)
    expect((await notificationView(a, {})).instanceSending).toBe(false)
    expect(JSON.stringify(await a.notificationSettings.findFirstOrThrow())).not.toContain(API_KEY)
  })

  it('wiadomość próbna: ta sama bramka env i lista hostów; AuditLog', async () => {
    await enable(a, T0, { enabled: false })
    const z = atrapa()
    expect(await sendTestNotification(a, { APP_ENCRYPTION_KEY: KEY_HEX }, 'MAGAZYN', 'osoba-testowa', z.fetch)).toEqual({ ok: false, error: expect.stringMatching(/POWIADOMIENIA_WYSYLKA/) })
    expect(await sendTestNotification(a, { ...ENV, ZULIP_DOZWOLONE_HOSTY: 'inny.test' }, 'MAGAZYN', 'osoba-testowa', z.fetch)).toMatchObject({ ok: false })
    expect(z.calls).toHaveLength(0)
    expect(await sendTestNotification(a, ENV, 'MAGAZYN', 'osoba-testowa', z.fetch)).toEqual({ ok: true })
    expect(z.calls).toHaveLength(1)
    expect(z.calls[0]).toMatchObject({ to: 'Magazyn', topic: 'Magazyn' })
    expect(z.calls[0]!.content).toContain('Wiadomość próbna')
    expect(await a.auditLog.count({ where: { entity: 'NotificationTest' } })).toBe(1)
    expect(await a.alertDelivery.count()).toBe(0)
    // druga próba w tej samej minucie odmówiona bez wywołania
    expect(await sendTestNotification(a, ENV, 'MAGAZYN', 'osoba-testowa', z.fetch)).toEqual({ ok: false, error: expect.stringMatching(/za minutę/) })
    expect(z.calls).toHaveLength(1)
    // limit liczony per firma: firma B może wysłać swoją próbę
    await enable(b, T0, { enabled: false, zulipSite: 'https://firma-b.zulipchat.com', zulipBotEmail: 'bot@firma-b.zulipchat.com' })
    expect(await sendTestNotification(b, ENV, 'MAGAZYN', 'osoba-testowa', z.fetch)).toEqual({ ok: true })
  })
})
