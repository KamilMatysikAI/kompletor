// kreator pierwszego uruchomienia /start, firma demo i pusta firma w panelu.
//   - kreator: zły kod, sukces i drugi przebieg (zamknięty), wyścig dwóch żądań, hosting, firma z presetu
//   - demo: tylko gdy firmy demo nie ma, inne firmy nietknięte, health bez kont „nie czyta” i bez `withoutAdapter`
//   - pusta firma: odczyty pulpitu, braków, rozjazdów i pakowania bez błędu
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createOrgClient } from '@/lib/db'
import { SlidingLimiter } from '@/lib/auth/limiter'
import { resolveSession } from '@/lib/auth/sesje'
import { loadShadowReading } from '@/lib/cien/stan-odczytu'
import { latestDailyReport } from '@/lib/cien/raport-dzienny'
import { DEMO_EMAIL, DEMO_ORG, zalozDemo } from '@/lib/instalacja/demo'
import { MSG_ZAMKNIETY, MSG_ZLY_KOD, stanKreatoraDb, wykonajKreatorDb, type DaneKreatora, type ZaleznosciKreatora } from '@/lib/instalacja/kreator'
import { presetNowejFirmy, slugZNazwy } from '@/lib/organizacje'
import { packingQueue } from '@/lib/pakowanie/dane'
import { accounts, dashboard, navCounts, shortagesData } from '@/lib/panel/dane'
import { licznikiPanelu } from '@/lib/panel/zamowienia-lista'
import { listaStartu } from '@/lib/start/lista'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl } from './global-setup'

const KOD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const orgClient = (id: string) => createOrgClient(id, { appConnectionString: testAppDbUrl(), poolMax: 2 })
const zal = (z: Partial<ZaleznosciKreatora> = {}): ZaleznosciKreatora => ({
  env: { APP_MODE: 'self-host' },
  kodInstalacji: KOD,
  limiter: new SlidingLimiter(100, 60_000),
  orgClient,
  log: () => {},
  ...z,
})
const dane = (d: Partial<DaneKreatora> = {}): DaneKreatora => ({
  kod: KOD,
  nazwaFirmy: 'Zielona Łąka Sp. z o.o.',
  imie: 'Ola',
  email: 'ola@example.test',
  haslo: 'bardzo-dlugie-haslo-1',
  tryb: 'firma',
  ip: '10.0.0.1',
  ...d,
})

describe('kreator /start', () => {
  beforeEach(async () => {
    await truncateAll(undefined, []) // świeża instalacja: bez firm i bez kont
  })

  it('slug z nazwy: polskie znaki, fallback „firma”, id przechodzi assertOrgId', () => {
    expect(slugZNazwy('Zielona Łąka Sp. z o.o.')).toBe('zielona-laka-sp-z-o-o')
    expect(slugZNazwy('Żółć & Gęś')).toBe('zolc-ges')
    expect(slugZNazwy('!!!')).toBe('firma')
    expect(slugZNazwy('x'.repeat(80))).toHaveLength(40)
    expect(presetNowejFirmy({ slug: 'zielona-laka', name: ' Zielona ' })).toMatchObject({ id: 'zielona_laka', name: 'Zielona' })
  })

  it('zły kod: odmowa, nic nie powstaje; dobry kod: firma, właściciel i sesja; potem kreator zamknięty', async () => {
    const sys = testSystemDb()
    expect(await stanKreatoraDb(sys, { APP_MODE: 'self-host' }, KOD)).toEqual({ dostepny: true, istniejacaFirma: null, wieleFirm: false })
    expect(await wykonajKreatorDb(sys, dane({ kod: 'zly' }), zal())).toEqual({ ok: false, blad: MSG_ZLY_KOD })
    expect(await wykonajKreatorDb(sys, dane({ kod: '' }), zal())).toEqual({ ok: false, blad: MSG_ZLY_KOD })
    expect(await wykonajKreatorDb(sys, dane({ haslo: 'krotkie' }), zal())).toMatchObject({ ok: false, blad: expect.stringMatching(/12 znaków/) })
    expect(await wykonajKreatorDb(sys, dane({ email: 'nie-email' }), zal())).toMatchObject({ ok: false, blad: expect.stringMatching(/e-mail/) })
    expect(await sys.user.count()).toBe(0)
    expect(await sys.organization.count()).toBe(0)

    const r = await wykonajKreatorDb(sys, dane({ email: ' Ola@Example.TEST ' }), zal())
    expect(r).toMatchObject({ ok: true, organizationId: 'zielona_laka_sp_z_o_o' })
    if (!r.ok) throw new Error('kreator')
    const s = await resolveSession(sys, r.token)
    expect(s?.user.email).toBe('ola@example.test')
    expect(s?.organization).toMatchObject({ slug: 'zielona-laka-sp-z-o-o', name: 'Zielona Łąka Sp. z o.o.', role: 'WLASCICIEL' })
    expect(await sys.warehouse.count({ where: { organizationId: 'zielona_laka_sp_z_o_o' } })).toBe(1)
    expect(await sys.carrierRule.count({ where: { organizationId: 'zielona_laka_sp_z_o_o' } })).toBeGreaterThan(0)

    expect(await stanKreatoraDb(sys, { APP_MODE: 'self-host' }, KOD)).toEqual({ dostepny: false })
    expect(await wykonajKreatorDb(sys, dane({ email: 'drugi@example.test' }), zal())).toEqual({ ok: false, blad: MSG_ZAMKNIETY, zamkniety: true })
    expect(await sys.user.count()).toBe(1)
    expect(await sys.organization.count()).toBe(1)
  })

  it('szablon przepływu wybrany w kreatorze: statusy szablonu i włączone reguły; nieznany szablon = bez szablonu', async () => {
    const sys = testSystemDb()
    const r = await wykonajKreatorDb(sys, dane({ szablon: 'odbior-osobisty' }), zal())
    if (!r.ok) throw new Error('kreator')
    expect(await sys.automationRule.count({ where: { organizationId: r.organizationId, enabled: true } })).toBeGreaterThan(0)
    expect(await sys.orderStatusDef.findFirst({ where: { organizationId: r.organizationId, key: 'ODEBRANE' }, select: { customerName: true } })).toEqual({ customerName: 'Zamówienie odebrane' })
  })

  it('nieznany szablon w kreatorze = firma bez reguł (jak bez wyboru)', async () => {
    const sys = testSystemDb()
    const r = await wykonajKreatorDb(sys, dane({ szablon: '../acme' }), zal())
    if (!r.ok) throw new Error('kreator')
    expect(await sys.automationRule.count()).toBe(0)
  })

  it('wyścig: dwa równoległe żądania = jedna firma i jedno konto, drugie dostaje komunikat', async () => {
    const sys = testSystemDb()
    const wyniki = await Promise.all([
      wykonajKreatorDb(sys, dane({ email: 'a@example.test', nazwaFirmy: 'Firma A' }), zal()),
      wykonajKreatorDb(sys, dane({ email: 'b@example.test', nazwaFirmy: 'Firma B' }), zal()),
    ])
    expect(wyniki.filter((w) => w.ok)).toHaveLength(1)
    expect(wyniki.filter((w) => !w.ok)).toEqual([{ ok: false, blad: MSG_ZAMKNIETY, zamkniety: true }])
    expect(await sys.user.count()).toBe(1)
    expect(await sys.organization.count()).toBe(1)
    expect(await sys.membership.count()).toBe(1)
  })

  it('hosting, brak kodu i limit prób: kreator zamknięty albo odmowa', async () => {
    const sys = testSystemDb()
    expect(await stanKreatoraDb(sys, { APP_MODE: 'hosted' }, KOD)).toEqual({ dostepny: false })
    expect(await stanKreatoraDb(sys, { APP_MODE: 'self-host' }, null)).toEqual({ dostepny: false })
    expect(await wykonajKreatorDb(sys, dane(), zal({ env: { APP_MODE: 'hosted' } }))).toMatchObject({ ok: false, zamkniety: true })
    expect(await wykonajKreatorDb(sys, dane(), zal({ kodInstalacji: null }))).toMatchObject({ ok: false, zamkniety: true })
    const limiter = new SlidingLimiter(2, 60_000)
    await wykonajKreatorDb(sys, dane({ kod: 'x' }), zal({ limiter }))
    await wykonajKreatorDb(sys, dane({ kod: 'x' }), zal({ limiter }))
    expect(await wykonajKreatorDb(sys, dane(), zal({ limiter }))).toMatchObject({ ok: false, blad: expect.stringMatching(/Za dużo prób/) })
    expect(await sys.user.count()).toBe(0)
  })

  it('firma z presetu bez kont: kreator nadaje jej właściciela zamiast zakładać drugą', async () => {
    const sys = testSystemDb()
    await truncateAll(undefined, [{ id: 'z_presetu', slug: 'z-presetu', name: 'Firma z presetu' }])
    expect(await stanKreatoraDb(sys, { APP_MODE: 'self-host' }, KOD)).toEqual({ dostepny: true, istniejacaFirma: 'Firma z presetu', wieleFirm: false })
    const r = await wykonajKreatorDb(sys, dane({ nazwaFirmy: '' }), zal())
    expect(r).toMatchObject({ ok: true, organizationId: 'z_presetu' })
    expect(await sys.organization.count()).toBe(1)
  })

  it('demo z kreatora: firma demo z danymi fikcyjnymi i osoba z formularza jako właściciel; health ok', async () => {
    const sys = testSystemDb()
    expect(await wykonajKreatorDb(sys, dane({ tryb: 'demo' }), zal({ env: { APP_MODE: 'hosted' } }))).toMatchObject({ ok: false })
    const r = await wykonajKreatorDb(sys, dane({ tryb: 'demo', nazwaFirmy: '' }), zal())
    expect(r).toMatchObject({ ok: true, organizationId: DEMO_ORG })
    expect(await sys.product.count({ where: { organizationId: DEMO_ORG } })).toBe(13)
    expect(await sys.order.count({ where: { organizationId: DEMO_ORG } })).toBeGreaterThan(0)
    const health = await loadShadowReading(sys, { enabled: true })
    expect(health).toMatchObject({ status: 'ok', withoutAdapter: 0, notReading: 0, accounts: 0 })
  })
})

describe('firma demo (KOMPLETOR_SEED=demo, npm run demo:panel)', () => {
  beforeEach(async () => {
    await truncateAll()
  })

  it('zakłada firmę demo raz, nie dotyka innych firm, nigdy w hostingu', async () => {
    const sys = testSystemDb()
    await expect(zalozDemo(sys, orgClient, { APP_MODE: 'hosted' })).rejects.toThrow(/hosting/)
    const przed = { produkty: await sys.product.count({ where: { organizationId: { not: DEMO_ORG } } }), zamowienia: await sys.order.count({ where: { organizationId: { not: DEMO_ORG } } }) }
    const r = await zalozDemo(sys, orgClient, { APP_MODE: 'self-host' })
    expect(r).toMatchObject({ utworzona: true, email: DEMO_EMAIL })
    if (!r.utworzona) throw new Error('demo')
    expect(r.haslo).toHaveLength(20)
    // hasło z logu kontenera = zmiana przy pierwszym logowaniu
    expect((await sys.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } })).mustChangePassword).toBe(true)
    expect(await zalozDemo(sys, orgClient, { APP_MODE: 'self-host' })).toEqual({ utworzona: false })
    expect(await sys.product.count({ where: { organizationId: { not: DEMO_ORG } } })).toBe(przed.produkty)
    expect(await sys.order.count({ where: { organizationId: { not: DEMO_ORG } } })).toBe(przed.zamowienia)
    expect(await sys.membership.findMany({ where: { user: { email: DEMO_EMAIL } }, select: { organizationId: true, role: true } })).toEqual([{ organizationId: DEMO_ORG, role: 'WLASCICIEL' }])
    // konta kanałów demo nieaktywne: health bez kont „nie czyta” i bez `withoutAdapter`
    expect(await loadShadowReading(sys, { enabled: true })).toMatchObject({ status: 'ok', withoutAdapter: 0, notReading: 0 })
    // panel firmy demo: pulpit z danymi, karta pierwszych kroków widoczna (brak aktywnego sklepu)
    const db = orgClient(DEMO_ORG)
    try {
      expect((await dashboard(db)).monthTotals.count).toBeGreaterThan(0)
      // lista startu zamiast „Pierwszych kroków”: produkty są, sklepu nie ma
      const l = await listaStartu(db, { firmaZBl: false, kluczBl: false, trybPracyZablokowany: false })
      expect(Object.fromEntries(l.kroki.map((k) => [k.id, k.stan]))).toMatchObject({ produkty: 'zrobione', kanal: 'do_zrobienia', zamowienie: 'zrobione' })
    } finally {
      await db.$disconnect()
    }
  })
})

describe('pusta firma: ekrany panelu bez błędu', () => {
  beforeEach(async () => {
    await truncateAll()
  })

  it('pulpit, braki, rozjazdy, pakowanie i liczniki menu na firmie bez danych', async () => {
    const db = testDb()
    expect(await sysCount()).toBe(0)
    const d = await dashboard(db)
    expect(d.today.count).toBe(0)
    expect(d.work).toMatchObject({ toPack: 0, shortageLines: 0, unpaid: 0 })
    expect(await navCounts(db)).toEqual({ shortages: 0 })
    expect((await licznikiPanelu(db)).grupy.wymaga).toBe(0)
    expect(await accounts(db)).toEqual([])
    await expect(shortagesData(db)).resolves.toBeTruthy()
    await expect(latestDailyReport(db)).resolves.toBeNull()
    const q = await packingQueue(db, { tab: 'naprawde', zone: 'wszystkie' })
    expect(q.groups).toEqual([])
    const l = await listaStartu(db, { firmaZBl: false, kluczBl: false, trybPracyZablokowany: false })
    expect(l).toMatchObject({ zrobione: 0, razem: 9, gotowe: false, ukryta: false })
  })
})

async function sysCount(): Promise<number> {
  return testSystemDb().order.count({ where: { organizationId: ORG_A } })
}
