// poczta do klientów i biura. Wysyłka z planu akcji przez prawdziwy transport SMTP (nodemailer) do lokalnej
// atrapy serwera na 127.0.0.1 (tests/smtp-atrapa.ts) — zero maili do prawdziwych adresów, wyłącznie dane fikcyjne
// (domeny example.com/example.test). Sprawdzamy: jeden mail na zdarzenie (także dwa przebiegi naraz), bramki (env,
// firma, tryb konta), czekanie bez konfiguracji, ponowne sprawdzenie warunku przed wysyłką, PDF w załączniku przez
// port dokumentów, odbicia i błędy do alertów, zły login, szablony firmy, polskie znaki w HTML i tekście, reset hasła.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { podgladPlanu } from '@/lib/akcje/panel'
import { planujAkcje } from '@/lib/akcje/silnik'
import { MSG_RESET_WYSLANY, MSG_RESET_ZLY_LINK, poprosOReset, ustawNoweHaslo, ZADANIE_RESETU } from '@/lib/auth/reset-hasla'
import { SlidingLimiter } from '@/lib/auth/limiter'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { hashPassword, verifyPassword } from '@/lib/auth/hasla'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { formatujDate } from '@/lib/maile'
import { PDF_PRZYKLADOWY } from '@/lib/maile/przyklady'
import type { ZrodloPdf } from '@/lib/poczta/dokument-pdf'
import { nadpisanieZFormularza, podgladSzablonu, przywrocDomyslny, zapiszSzablon } from '@/lib/poczta/szablony'
import { BladUstawienPoczty, SMTP_PASSWORD, widokPoczty, zapiszUstawieniaPoczty, type WejscieUstawien } from '@/lib/poczta/ustawienia'
import { ALERT_LOGOWANIE, ALERT_NIEPEWNY, ALERT_ODRZUCONY, przesylkaDoMaila, wyslijMailProbny, wyslijZaplanowane } from '@/lib/poczta/wysylka'
import { zadanieResetuHasla, zadanieSprzataniaResetow, ZADANIE_SPRZATANIA_RESETOW } from '@/lib/poczta/zadanie'
import { NonRetryableError } from '@/lib/bledy'
import { BladSzablonu } from '@/lib/maile'
import type { TransportPoczty } from '@/lib/maile/transport'
import { deleteSecret } from '@/lib/sekrety'
import { savePolicy } from '@/lib/rdzen/polityka'
import { ingestOrder, runReservationExpiry } from '@/lib/rdzen/zamowienia'
import { HARMONOGRAM_RDZENIA } from '@/lib/worker/harmonogram'
import { handlers } from '@/lib/worker/zadania'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase } from './rdzen-fixtures'
import { envPocztyInstalacji, rozloz, uruchomAtrape, type Atrapa } from './smtp-atrapa'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const sys = testSystemDb()

const K1 = '1'.repeat(64)
const ENV = {
  POCZTA_WYSYLKA: '1',
  APP_ENCRYPTION_KEY: 'c'.repeat(64),
  CUSTOMER_DATA_KEYS: `1:${K1}`,
  CUSTOMER_LOOKUP_KEY: 'a'.repeat(64),
  PANEL_URL: 'https://panel.example.com',
}
const EMAIL = 'jan.kowalski@example.test'
const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: 'Jan Kowalski', firma: null, ulica: 'ul. Fikcyjna', numerDomu: '17', numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL', telefon: '+48 500 000 000', email: EMAIL },
  punktOdbioru: null,
  faktura: null,
  problemy: [],
}

let atrapa: Atrapa
/** serwer poczty instalacji (RESET_SMTP_*): jedyna droga linków resetu hasła */
let atrapaInst: Atrapa
/** ENV z pocztą instalacji (po starcie atrapy) */
let ENV_R: Record<string, string>

beforeAll(async () => {
  atrapa = await uruchomAtrape({ login: 'kompletor', haslo: 'tajne-haslo-smtp' })
  atrapaInst = await uruchomAtrape({ login: 'instalacja', haslo: 'haslo-instalacji' })
  ENV_R = { ...ENV, ...envPocztyInstalacji(atrapaInst) }
})
afterAll(async () => {
  await atrapa.zamknij()
  await atrapaInst.zamknij()
  await a.$disconnect()
  await b.$disconnect()
})
beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
  atrapa.maile.length = 0
  atrapaInst.maile.length = 0
  atrapa.opcje.odrzuc = []
  atrapa.opcje.chwilowaOdmowa = false
  atrapa.opcje.zerwijPoDanych = false
  // sklep SD w trybie pracy; reszta kont zostaje w cieniu
  await a.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: ORG_A, channel: 'WOO', channelAccountId: 'sd' } }, data: { statusMode: 'PRACA' } })
})

function wejscie(over: Partial<WejscieUstawien> = {}): WejscieUstawien {
  return {
    enabled: true,
    host: '127.0.0.1',
    port: String(atrapa.port),
    bezpieczenstwo: 'BRAK',
    login: 'kompletor',
    haslo: 'tajne-haslo-smtp',
    usunHaslo: false,
    fromEmail: 'poczta@example.com',
    fromName: 'Firma Testowa',
    officeEmail: 'biuro@example.com',
    nadawcy: {
      'WOO:sd': {
        nazwaSklepu: 'Pracownia Żółwik',
        email: 'sklep@example.com',
        odpowiedzDo: 'kontakt@example.com',
        kolor: '#2f6b3a',
        odbiorAdres: 'Pracownia Żółwik\nul. Przykładowa 1\n00-000 Testowo',
        odbiorGodziny: 'poniedziałek-piątek 9:00-17:00',
      },
    },
    ...over,
  }
}

const skonfiguruj = (over: Partial<WejscieUstawien> = {}, kiedy = new Date(Date.now() - 60_000)) => zapiszUstawieniaPoczty(a, wejscie(over), 'osoba-testowa', ENV, kiedy)

async function zamowienieZKlientem(over: Parameters<typeof order>[1] = {}, rekord: OrderRecipient | null = ODBIORCA) {
  const p = await product(a, `P-${Math.random().toString(36).slice(2, 7)}`, 10)
  const r = await ingestOrder(a, order([{ productId: p, qty: 2 }], over))
  if (rekord) await zapiszRekordKlienta(a, r.orderId!, rekordZOdbiorcy(rekord), { source: 'KANAL', fetchedAt: new Date(), env: ENV })
  return { orderId: r.orderId!, productId: p }
}

async function doOdbioru() {
  const z = await zamowienieZKlientem({ deliveryMethod: 'Odbiór osobisty' })
  await a.order.update({ where: { id: z.orderId }, data: { status: 'DO_ODBIORU' } })
  await planujAkcje(a)
  return z
}

const wyslij = (deps: Parameters<typeof wyslijZaplanowane>[2] = {}, env: Record<string, string> = ENV) => wyslijZaplanowane(a, env, deps)
const wpisy = () => a.mailDelivery.findMany({ orderBy: { createdAt: 'asc' } })

/** Rachunek do przelewu w Danych firmy A (null = brak) i pełna nazwa (null = brak); pozostałe ustawienia zostają. */
async function rachunekFirmy(rachunek: string | null, nazwa: string | null = 'Pracownia Testowa sp. z o.o.'): Promise<void> {
  const org = await sys.organization.findUniqueOrThrow({ where: { id: ORG_A }, select: { settings: true } })
  const s = (org.settings && typeof org.settings === 'object' && !Array.isArray(org.settings) ? org.settings : {}) as Record<string, unknown>
  const firma = { ...((s['firma'] as Record<string, unknown> | undefined) ?? {}), nazwa: nazwa ?? undefined, rachunek: rachunek ?? undefined }
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: { ...s, firma } as never } })
}

describe('wysyłka z planu akcji: jeden mail na zdarzenie', () => {
  it('„Gotowe do odbioru”: mail do klienta z polskimi znakami w HTML i tekście, akcja DONE, drugi przebieg nic', async () => {
    await skonfiguruj()
    const { orderId } = await doOdbioru()
    const r = await wyslij()
    expect(r).toMatchObject({ sent: 1, failed: 0, errors: [] })
    expect(atrapa.maile).toHaveLength(1)
    const m = atrapa.maile[0]!
    expect(m.do).toEqual([EMAIL])
    expect(m.od).toBe('sklep@example.com')
    const x = rozloz(m.surowy)
    expect(x.temat).toMatch(/^Zamówienie .+ czeka na odbiór$/)
    expect(x.naglowki['reply-to']).toContain('kontakt@example.com')
    expect(x.naglowki['x-kompletor-id']).toMatch(/^plan:/)
    expect(x.tekst).toContain('Dzień dobry Jan,')
    expect(x.tekst).toContain('Przy odbiorze prosimy podać numer zamówienia.')
    expect(x.tekst).toContain('ul. Przykładowa 1')
    expect(x.html).toContain('Zamówienie gotowe do odbioru')
    expect(x.html).toContain('Pracownia Żółwik')
    expect(x.html).toContain('2 × Towar testowy')
    const [d] = await wpisy()
    expect(d).toMatchObject({ state: 'SENT', kind: 'gotowe-do-odbioru', recipient: 'j***@example.test', attempts: 1 })
    // pełny adres klienta nie ląduje w bazie poczty
    expect(JSON.stringify(await a.mailDelivery.findMany())).not.toContain(EMAIL)
    expect(await a.plannedAction.findFirst({ where: { targetId: orderId } })).toMatchObject({ state: 'DONE', reason: 'wysłano do j***@example.test' })
    expect(await wyslij()).toMatchObject({ sent: 0 })
    expect(atrapa.maile).toHaveLength(1)
  })

  it('oferta z przelicznikiem — ilość w mailu w sztukach kanału przy nazwie z kanału', async () => {
    await skonfiguruj()
    const { orderId } = await zamowienieZKlientem({ deliveryMethod: 'Odbiór osobisty' })
    // 1 × „Towar 6-pak” w kanale = 6 sztuk bazowych w Kompletorze
    await a.orderLine.updateMany({ where: { orderId }, data: { qty: 6, qtyChannel: 1, channelName: 'Towar testowy 6-pak' } })
    await a.order.update({ where: { id: orderId }, data: { status: 'DO_ODBIORU' } })
    await planujAkcje(a)
    expect(await wyslij()).toMatchObject({ sent: 1, failed: 0 })
    const x = rozloz(atrapa.maile[0]!.surowy)
    expect(x.html).toContain('1 × Towar testowy 6-pak')
    expect(x.html).not.toContain('6 × Towar testowy 6-pak')
    expect(x.tekst).not.toMatch(/6 × Towar testowy 6-pak/)
  })

  it('logo firmy z Dane firmy osadzone w mailu (cid), gdy sklep nie ma własnego logo', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const sharp = (await import('sharp')).default
    const { wgrajLogo } = await import('@/lib/firma/logo')
    const prev = process.env['ZDJECIA_DIR']
    process.env['ZDJECIA_DIR'] = mkdtempSync(path.join(tmpdir(), 'kompletor-logo-poczta-'))
    try {
      await skonfiguruj()
      const png = await sharp({ create: { width: 400, height: 120, channels: 3, background: '#2a7' } }).png().toBuffer()
      await wgrajLogo(a, new File([new Uint8Array(png)], 'logo.png', { type: 'image/png' }), 'u1')
      // worker ma własny (pusty) wolumen zdjęć, logo idzie z bazy
      process.env['ZDJECIA_DIR'] = mkdtempSync(path.join(tmpdir(), 'kompletor-logo-worker-'))
      await doOdbioru()
      expect(await wyslij()).toMatchObject({ sent: 1 })
      const m = atrapa.maile[0]!
      const x = rozloz(m.surowy)
      // sklep w tej konfiguracji nie ma własnego logo w Poczcie: idzie logo firmy
      expect(x.html).toContain('src="cid:logo-firmy@kompletor"')
      expect(m.surowy).toMatch(/Content-ID: <logo-firmy@kompletor>/i)
      expect(x.zalaczniki).toHaveLength(0) // logo nie jest załącznikiem do pobrania
    } finally {
      if (prev === undefined) delete process.env['ZDJECIA_DIR']
      else process.env['ZDJECIA_DIR'] = prev
    }
  })

  it('dwa przebiegi naraz (dwa workery) wysyłają jeden mail', async () => {
    await skonfiguruj()
    await doOdbioru()
    const drugi = testDb()
    try {
      const [r1, r2] = await Promise.all([wyslij(), wyslijZaplanowane(drugi, ENV)])
      expect(r1.sent + r2.sent).toBe(1)
      expect(atrapa.maile).toHaveLength(1)
      expect(await a.mailDelivery.count()).toBe(1)
    } finally {
      await drugi.$disconnect()
    }
  })

  it('znacznik próby z chwili zajęcia, nie ze startu przebiegu (wolny serwer nie robi z wpisów „porzuconych”)', async () => {
    await skonfiguruj()
    await doOdbioru()
    await doOdbioru()
    let t = Date.now()
    const zegar = () => new Date(t)
    const start = t
    const wolny: TransportPoczty = {
      async wyslij() {
        t += 6 * 60_000 // każda wysyłka „trwa” 6 minut
        return { kind: 'SENT', messageId: null }
      },
    }
    expect(await wyslij({ now: zegar, transport: () => wolny })).toMatchObject({ sent: 2 })
    const [d1, d2] = await wpisy()
    expect(d1!.lastAttemptAt!.getTime()).toBe(start)
    expect(d2!.lastAttemptAt!.getTime()).toBe(start + 6 * 60_000)
  })

  it('konto w cieniu (plan SUCHO) nigdy nie wysyła', async () => {
    await skonfiguruj()
    await a.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: ORG_A, channel: 'WOO', channelAccountId: 'sd' } }, data: { statusMode: 'CIEN' } })
    await doOdbioru()
    expect((await a.plannedAction.findFirstOrThrow()).mode).toBe('SUCHO')
    expect(await wyslij()).toMatchObject({ sent: 0, skipped: null })
    expect(atrapa.maile).toHaveLength(0)
    expect(await a.mailDelivery.count()).toBe(0)
  })

  it('plan pracy sprzed przełączenia konta z powrotem do cienia nie wysyła maila', async () => {
    await skonfiguruj()
    await doOdbioru()
    expect((await a.plannedAction.findFirstOrThrow()).mode).toBe('PRACA')
    await a.channelConfig.update({ where: { organizationId_channel_channelAccountId: { organizationId: ORG_A, channel: 'WOO', channelAccountId: 'sd' } }, data: { statusMode: 'CIEN' } })
    expect(await wyslij()).toMatchObject({ sent: 0, skippedPlans: 1 })
    expect(atrapa.maile).toHaveLength(0)
    expect((await a.plannedAction.findFirstOrThrow()).state).toBe('SKIPPED')
  })
})

describe('bramki i brak konfiguracji: maile czekają, nic nie ginie', () => {
  it('bez POCZTA_WYSYLKA, bez włącznika firmy i bez konfiguracji nic nie wychodzi, a akcja zostaje „zaplanowana”', async () => {
    await doOdbioru()
    expect(await wyslij()).toMatchObject({ skipped: 'firma', sent: 0 })
    await skonfiguruj()
    expect(await wyslij({}, { ...ENV, POCZTA_WYSYLKA: '0' })).toMatchObject({ skipped: 'env' })
    await expect(wyslij({}, { ...ENV, POCZTA_WYSYLKA: 'tak' })).rejects.toThrow(/POCZTA_WYSYLKA/)
    // włączona, ale hasło zniknęło: czytelny komunikat w ustawieniach, akcja czeka
    await deleteSecret(a, SMTP_PASSWORD)
    expect(await wyslij()).toMatchObject({ skipped: 'konfiguracja' })
    expect((await widokPoczty(a, ENV)).lastError).toMatch(/brak hasło SMTP/)
    expect(atrapa.maile).toHaveLength(0)
    expect((await a.plannedAction.findFirstOrThrow()).state).toBe('PLANNED')
    // po uzupełnieniu hasła ten sam mail wychodzi i komunikat znika
    await skonfiguruj()
    expect(await wyslij()).toMatchObject({ sent: 1 })
    expect((await widokPoczty(a, ENV)).lastError).toBeNull()
  })

  it('walidacja: włączenie bez serwera, zły adres, w hostingu serwer lokalny i bez szyfrowania', async () => {
    await expect(skonfiguruj({ host: '' , port: ''})).rejects.toThrow(/uzupełnij: adres serwera SMTP, port/)
    await expect(skonfiguruj({ fromEmail: 'nie-mail' })).rejects.toThrow(BladUstawienPoczty)
    await expect(zapiszUstawieniaPoczty(a, wejscie(), 'x', { ...ENV, APP_MODE: 'hosted' })).rejects.toThrow(/dostępny z internetu.*port SMTP.*szyfrowane/)
    // hasło nie trafia do AuditLog
    await skonfiguruj()
    const log = await a.auditLog.findFirstOrThrow({ where: { entity: 'MailSettings' } })
    expect(JSON.stringify(log)).not.toContain('tajne-haslo-smtp')
    expect((log.after as Record<string, unknown>).haslo).toBe('zmienione')
    expect((await widokPoczty(a, ENV)).hasloUstawione).toBe(true)
  })
})

describe('warunek sprawdzany drugi raz przed wysyłką', () => {
  it('„Brak płatności”: mail z datą anulowania; opłacone przed wysyłką → pominięte bez maila', async () => {
    const z1 = await zamowienieZKlientem({ paymentState: 'UNPAID', paymentMethod: 'przelew', totalGross: 123.45 })
    const z2 = await zamowienieZKlientem({ paymentState: 'UNPAID', paymentMethod: 'przelew', totalGross: 50 })
    const z3 = await zamowienieZKlientem({ paymentState: 'UNPAID', paymentMethod: 'przelew', totalGross: 70 })
    const o = await a.order.findUniqueOrThrow({ where: { id: z1.orderId } })
    const at = new Date(o.remindAt!.getTime() + 60_000)
    await runReservationExpiry(a, { now: at })
    await planujAkcje(a, { now: at })
    // poczta włączona godzinę przed przypomnieniem (zegar testu = chwila przypomnienia); zamówienie 2 opłacone w międzyczasie
    await skonfiguruj({}, new Date(at.getTime() - 3600_000))
    await a.order.update({ where: { id: z2.orderId }, data: { paymentState: 'PAID' } })
    // zamówienie 3 przed wysyłką trafiło do „Do odbioru” (np. zamknięte przy przejściu z BaseLinkera) → bez maila
    await a.order.update({ where: { id: z3.orderId }, data: { status: 'DO_ODBIORU' } })
    const r = await wyslij({ now: () => new Date(at.getTime() + 60_000) })
    expect(r).toMatchObject({ sent: 1, skippedPlans: 2 })
    const x = rozloz(atrapa.maile[0]!.surowy)
    const termin = (await a.order.findUniqueOrThrow({ where: { id: z1.orderId } })).reservationDeadline!
    expect(x.tekst).toContain(`Jeśli płatność nie wpłynie do ${formatujDate(termin)}, zamówienie zostanie anulowane.`)
    expect(x.tekst).toContain('Kwota do zapłaty: 123,45 zł')
    expect(x.tekst).not.toMatch(/w ciągu/)
    const pominiety = await a.plannedAction.findFirstOrThrow({ where: { targetId: z2.orderId } })
    expect(pominiety).toMatchObject({ state: 'SKIPPED', reason: 'przed wysyłką: zamówienie opłacone przed wysyłką' })
    expect(await a.plannedAction.findFirstOrThrow({ where: { targetId: z3.orderId } })).toMatchObject({ state: 'SKIPPED', reason: 'przed wysyłką: zamówienie zakończone albo anulowane przed wysyłką' })
  })

  it('„Nieudana płatność online”: rachunek, kwota i tytuł przelewu; zdanie o braku rezerwacji tylko po zwolnieniu towaru; zdjęty znacznik = zwykły mail', async () => {
    await rachunekFirmy('61109010140000071219812874')
    const teraz = new Date()
    // z1 przyjęte przy długim trzymaniu towaru (rano następnego dnia towar nadal zarezerwowany), z2 przy domyślnych 2 h
    await savePolicy(a, { failedOnlinePaymentHoldHours: 48 }, 'test')
    const z1 = await zamowienieZKlientem({ paymentState: 'UNPAID', paymentFailedOnline: true, totalGross: 123.45, createdAtChannel: teraz })
    await savePolicy(a, { failedOnlinePaymentHoldHours: 2 }, 'test')
    const z2 = await zamowienieZKlientem({ paymentState: 'UNPAID', paymentFailedOnline: true, totalGross: 50, createdAtChannel: teraz })
    const z3 = await zamowienieZKlientem({ paymentState: 'UNPAID', paymentFailedOnline: true, totalGross: 70, createdAtChannel: teraz })
    const o1 = await a.order.findUniqueOrThrow({ where: { id: z1.orderId } })
    const at = new Date(o1.remindAt!.getTime() + 60_000)
    expect((await runReservationExpiry(a, { now: at })).reminders).toBe(3)
    await planujAkcje(a, { now: at })
    await skonfiguruj({}, new Date(at.getTime() - 3600_000))
    // z3 przed wysyłką przełączone na przelew tradycyjny (znacznik zszedł): zwykły „Brak płatności”
    await a.order.update({ where: { id: z3.orderId }, data: { flags: {} } })
    const r = await wyslij({ now: () => new Date(at.getTime() + 60_000) })
    expect(r).toMatchObject({ sent: 3 })
    const maile = atrapa.maile.map((m) => rozloz(m.surowy))
    const numer = async (id: string) => {
      const o = await a.order.findUniqueOrThrow({ where: { id } })
      return o.channelNumber ?? o.externalId
    }
    const mailDo = async (id: string) => {
      const nr = await numer(id)
      const m = maile.filter((x) => x.tekst.includes(nr))
      expect(m).toHaveLength(1)
      return { m: m[0]!, nr }
    }
    const trzymany = await mailDo(z1.orderId)
    expect(trzymany.m.temat).toContain('Czy był problem z płatnością')
    expect(trzymany.m.tekst).toContain('61 1090 1014 0000 0712 1981 2874')
    expect(trzymany.m.tekst).toContain('123,45 zł')
    const tytul = trzymany.m.tekst.split('\n').find((l) => l.startsWith('Tytuł przelewu: Zamówienie '))
    // tytuł przelewu z numerem ze sklepu, bez przedrostka konta, którego klient nie zna
    expect(tytul).toBe(`Tytuł przelewu: Zamówienie ${trzymany.nr}`)
    expect(trzymany.m.tekst).toContain('Pracownia Testowa sp. z o.o.')
    expect(trzymany.m.tekst).not.toContain('nie jest już dla Państwa zarezerwowany')
    expect(trzymany.m.html).toContain('1090 1014')
    const zwolniony = await mailDo(z2.orderId)
    expect(zwolniony.m.tekst).toContain('nie jest już dla Państwa zarezerwowany')
    expect(zwolniony.m.tekst).toContain('50,00 zł')
    const zwykly = await mailDo(z3.orderId)
    expect(zwykly.m.temat).not.toContain('Czy był problem z płatnością')
    expect(zwykly.m.tekst).not.toContain('1090 1014')
    expect(zwykly.m.tekst).toContain('Kwota do zapłaty: 70,00 zł')
    // historia wysyłki: rodzaj maila, który faktycznie wyszedł
    const rodzaje = new Map((await wpisy()).map((w) => [w.plannedActionId, w.kind]))
    const planDla = async (id: string) => (await a.plannedAction.findFirstOrThrow({ where: { targetId: id } })).id
    expect(rodzaje.get(await planDla(z1.orderId))).toBe('nieudana-platnosc')
    expect(rodzaje.get(await planDla(z2.orderId))).toBe('nieudana-platnosc')
    expect(rodzaje.get(await planDla(z3.orderId))).toBe('brak-platnosci')
  })

  it('„Nieudana płatność online”: rachunek usunięty z Danych firmy między planem a wysyłką → zwykły „Brak płatności”, bez błędu i alertu', async () => {
    await rachunekFirmy('61109010140000071219812874')
    const z = await zamowienieZKlientem({ paymentState: 'UNPAID', paymentFailedOnline: true, totalGross: 40, createdAtChannel: new Date() })
    const o = await a.order.findUniqueOrThrow({ where: { id: z.orderId } })
    const at = new Date(o.remindAt!.getTime() + 60_000)
    await runReservationExpiry(a, { now: at })
    await planujAkcje(a, { now: at })
    const plan = await a.plannedAction.findFirstOrThrow({ where: { targetId: z.orderId } })
    expect(plan).toMatchObject({ state: 'PLANNED' })
    expect((plan.vars as Record<string, unknown>).wariant).toBe('nieudana-platnosc')
    await skonfiguruj({}, new Date(at.getTime() - 3600_000))
    await rachunekFirmy(null)
    const r = await wyslij({ now: () => new Date(at.getTime() + 60_000) })
    expect(r).toMatchObject({ sent: 1, failed: 0 })
    expect(atrapa.maile).toHaveLength(1)
    const m = rozloz(atrapa.maile[0]!.surowy)
    expect(m.temat).not.toContain('Czy był problem z płatnością')
    expect(m.tekst).toContain('Kwota do zapłaty: 40,00 zł')
    expect(m.tekst).not.toContain('Numer rachunku')
    expect((await wpisy())[0]).toMatchObject({ state: 'SENT', kind: 'brak-platnosci' })
    expect(await a.alert.count()).toBe(0)
  })

  it('„Nieudana płatność online”: firma bez rachunku albo bez pełnej nazwy już przy planowaniu → plan z informacją dla biura, klient dostaje zwykły „Brak płatności”', async () => {
    await rachunekFirmy(null)
    const z1 = await zamowienieZKlientem({ paymentState: 'UNPAID', paymentFailedOnline: true, totalGross: 41, createdAtChannel: new Date() })
    const o = await a.order.findUniqueOrThrow({ where: { id: z1.orderId } })
    const at = new Date(o.remindAt!.getTime() + 60_000)
    await runReservationExpiry(a, { now: at })
    await planujAkcje(a, { now: at })
    const plan = await a.plannedAction.findFirstOrThrow({ where: { targetId: z1.orderId } })
    expect(plan).toMatchObject({ state: 'PLANNED' })
    expect((plan.vars as Record<string, unknown>).wariant).toBeUndefined()
    expect(plan.reason).toContain('brakuje numeru rachunku')
    expect(plan.reason).toContain('Ustawienia → Dokumenty i faktury → Dane firmy')
    const podglad = await podgladPlanu(a, plan.id, {})
    expect(podglad!.temat).not.toContain('Czy był problem z płatnością')
    expect(podglad!.informacje!.join(' ')).toContain('brakuje numeru rachunku')
    expect(podglad!.braki.join(' ')).not.toContain('nie wyjdzie')

    // rachunek jest, ale bez pełnej nazwy w Danych firmy: robocza nazwa z systemu nie trafia do przelewu
    await rachunekFirmy('61109010140000071219812874', null)
    const z2 = await zamowienieZKlientem({ paymentState: 'UNPAID', paymentFailedOnline: true, totalGross: 42, createdAtChannel: new Date() })
    await runReservationExpiry(a, { now: at })
    await planujAkcje(a, { now: at })
    const plan2 = await a.plannedAction.findFirstOrThrow({ where: { targetId: z2.orderId } })
    expect(plan2.reason).toContain('brakuje pełnej nazwy firmy')

    await skonfiguruj({}, new Date(at.getTime() - 3600_000))
    const r = await wyslij({ now: () => new Date(at.getTime() + 60_000) })
    expect(r).toMatchObject({ sent: 2, failed: 0 })
    for (const m of atrapa.maile.map((x) => rozloz(x.surowy))) {
      expect(m.temat).not.toContain('Czy był problem z płatnością')
      expect(m.tekst).not.toContain('1090 1014')
    }
    expect((await wpisy()).map((w) => [w.state, w.kind])).toEqual([
      ['SENT', 'brak-platnosci'],
      ['SENT', 'brak-platnosci'],
    ])
    expect(await a.alert.count()).toBe(0)
  })

  it('zamówienie odebrane, zanim mail wyszedł → pominięte; klient bez e-maila → pominięte bez alertu', async () => {
    await skonfiguruj()
    const z = await doOdbioru()
    await a.order.update({ where: { id: z.orderId }, data: { status: 'ODEBRANE' } })
    const bezMaila = await zamowienieZKlientem({ deliveryMethod: 'Odbiór osobisty' }, { ...ODBIORCA, dostawa: { ...ODBIORCA.dostawa!, email: null } })
    await a.order.update({ where: { id: bezMaila.orderId }, data: { status: 'DO_ODBIORU' } })
    await planujAkcje(a)
    expect(await wyslij()).toMatchObject({ sent: 0, skippedPlans: 2 })
    expect(atrapa.maile).toHaveLength(0)
    expect(await a.alert.count()).toBe(0)
  })

  it('dane klienta jeszcze niezapisane → mail czeka (CZEKA) i wychodzi, gdy dane przyjdą', async () => {
    await skonfiguruj()
    const z = await zamowienieZKlientem({ deliveryMethod: 'Odbiór osobisty' }, null)
    await a.order.update({ where: { id: z.orderId }, data: { status: 'DO_ODBIORU' } })
    await planujAkcje(a)
    expect(await wyslij()).toMatchObject({ sent: 0, waiting: 1 })
    expect((await wpisy())[0]).toMatchObject({ state: 'CZEKA', attempts: 0, lastError: 'dane klienta jeszcze niezapisane' })
    await zapiszRekordKlienta(a, z.orderId, rekordZOdbiorcy(ODBIORCA), { source: 'KANAL', fetchedAt: new Date(), env: ENV })
    expect(await wyslij({ now: () => new Date(Date.now() + 16 * 60_000) })).toMatchObject({ sent: 1 })
    expect((await wpisy())[0]).toMatchObject({ state: 'SENT', attempts: 1 })
  })
})

describe('„Wysłane” z dokumentem sprzedaży (port PDF)', () => {
  async function wyslaneZPlanem() {
    const z = await zamowienieZKlientem()
    await a.order.update({ where: { id: z.orderId }, data: { status: 'WYSLANE' } })
    await a.plannedAction.create({
      data: { rule: 'mail.faktura', targetType: 'ZAMOWIENIE', targetId: z.orderId, occasion: 'FV:FV-1', mode: 'PRACA', state: 'PLANNED', vars: { numerZamowienia: 'SD 1', wfirmaDocId: 'FV-1' }, dueAt: new Date(Date.now() - 1000) },
    })
    return z
  }

  it('dostawca daje PDF → mail z załącznikiem PDF; bez PDF (dokument spoza Kompletora) mail czeka i nie wychodzi bez załącznika', async () => {
    await skonfiguruj()
    await wyslaneZPlanem()
    expect(await wyslij()).toMatchObject({ sent: 0, waiting: 1 })
    expect((await wpisy())[0]!.lastError).toMatch(/faktura spoza Kompletora: PDF nie jest dostępny/) // domyślne źródło szuka faktury Kompletora
    const pdf: ZrodloPdf = { pobierz: async (_db, p) => ({ stan: 'PDF', tresc: PDF_PRZYKLADOWY, numer: `FV ${p.docId}/11/2026` }) }
    expect(await wyslij({ pdf, now: () => new Date(Date.now() + 61 * 60_000) })).toMatchObject({ sent: 1 })
    const x = rozloz(atrapa.maile[0]!.surowy)
    expect(x.temat).toBe('Faktura FV FV-1/11/2026 do zamówienia SD 1')
    expect(x.zalaczniki).toHaveLength(1)
    expect(x.zalaczniki[0]!.nazwa).toBe('Faktura-FV-FV-1-11-2026.pdf')
    expect(x.zalaczniki[0]!.typ).toBe('application/pdf')
    expect(x.zalaczniki[0]!.tresc.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('numer i link przesyłki w mailu z głównej paczki; dosyłka (ta sama paczka, nowsza próba) ich nie zastępuje', async () => {
    const z = await zamowienieZKlientem()
    await a.shipment.create({ data: { orderId: z.orderId, packageNo: 1, reference: 'mail-p-0', state: 'UTWORZONA', adapterKey: 'test', carrier: 'PACZKOMATY', trackingNumber: '600000000000000000000200' } })
    await a.shipment.create({
      data: { orderId: z.orderId, packageNo: 1, attempt: 2, extraNo: 1, extraKind: 'DOSYLKA', extraReason: 'reklamacja: brak sztuki', reference: 'mail-p-1', state: 'UTWORZONA', adapterKey: 'test', carrier: 'PACZKOMATY', trackingNumber: '600000000000000000000201' },
    })
    expect(await przesylkaDoMaila(a, z.orderId)).toEqual({
      numerPrzesylki: '600000000000000000000200',
      linkSledzenia: 'https://inpost.pl/sledzenie-przesylek?number=600000000000000000000200',
    })
  })
})

describe('maile do biura', () => {
  it('„Błąd faktury” i „Niski stan” idą na adres biura z linkiem do panelu', async () => {
    await skonfiguruj()
    const z = await zamowienieZKlientem()
    await a.plannedAction.create({
      data: { rule: 'mail.blad-faktury', targetType: 'ZAMOWIENIE', targetId: z.orderId, occasion: 'proba:x', mode: 'PRACA', vars: { numerZamowienia: 'SD 2', idExternal: 'x' }, dueAt: new Date(Date.now() - 1000) },
    })
    await a.product.update({ where: { id: z.productId }, data: { lowStockThreshold: 100 } })
    await a.organization.update({ where: { id: ORG_A }, data: { settings: { akcje: { trybProduktow: 'PRACA' } } } })
    await planujAkcje(a)
    expect(await wyslij()).toMatchObject({ sent: 2 })
    expect(atrapa.maile.map((m) => m.do)).toEqual([['biuro@example.com'], ['biuro@example.com']])
    const [bf, ns] = atrapa.maile.map((m) => rozloz(m.surowy))
    expect(bf!.temat).toBe('Błąd wystawiania faktury: zamówienie SD 2 (Pracownia Żółwik)')
    expect(bf!.tekst).toContain(`Otwórz zamówienie w panelu: https://panel.example.com/zamowienia/${z.orderId}`)
    expect(ns!.temat).toMatch(/^Niski stan: P-/)
    expect(ns!.tekst).toContain('Próg: 100 szt.')
    expect(ns!.html).toContain('WIADOMOŚĆ WEWNĘTRZNA')
  })
})

describe('odbicia i błędy serwera do alertów', () => {
  it('adresat odrzucony (550) → błąd na stałe i alert, bez ponowienia', async () => {
    await skonfiguruj()
    atrapa.opcje.odrzuc = [EMAIL]
    await doOdbioru()
    expect(await wyslij()).toMatchObject({ sent: 0, failed: 1 })
    const d = (await wpisy())[0]!
    expect(d).toMatchObject({ state: 'FAILED', nextAttemptAt: null })
    // atrapa odbija pełny adres w odpowiedzi 550 (jak prawdziwe serwery); w bazie i alercie tylko maska
    expect(d.lastError).toContain('<j***@example.test>')
    expect(d.lastError).not.toContain(EMAIL)
    const al = await a.alert.findFirstOrThrow({ where: { kind: ALERT_ODRZUCONY } })
    expect(al.message).toContain('j***@example.test')
    expect(al.message).not.toContain(EMAIL)
    expect(JSON.stringify(await a.alert.findMany())).not.toContain(EMAIL)
    expect(await wyslij({ now: () => new Date(Date.now() + 3600_000) })).toMatchObject({ sent: 0, failed: 0 })
  })

  it('chwilowa odmowa (451) → ponowienie po odstępie, potem mail wychodzi raz', async () => {
    await skonfiguruj()
    atrapa.opcje.chwilowaOdmowa = true
    await doOdbioru()
    expect(await wyslij()).toMatchObject({ retry: 1 })
    const d = (await wpisy())[0]!
    expect(d.state).toBe('FAILED')
    expect(d.nextAttemptAt).not.toBeNull()
    atrapa.opcje.chwilowaOdmowa = false
    expect(await wyslij()).toMatchObject({ sent: 0 }) // przed terminem ponowienia nic
    expect(await wyslij({ now: () => new Date(Date.now() + 3 * 60_000) })).toMatchObject({ sent: 1 })
    expect(atrapa.maile).toHaveLength(1)
    expect((await wpisy())[0]).toMatchObject({ state: 'SENT', attempts: 2 })
  })

  it('połączenie zerwane po wysłaniu treści → niepewne, alert, bez ponowienia', async () => {
    await skonfiguruj()
    atrapa.opcje.zerwijPoDanych = true
    await doOdbioru()
    expect(await wyslij()).toMatchObject({ uncertain: 1 })
    expect((await wpisy())[0]!.state).toBe('UNCERTAIN')
    expect(await a.alert.count({ where: { kind: ALERT_NIEPEWNY } })).toBe(1)
    atrapa.opcje.zerwijPoDanych = false
    expect(await wyslij({ now: () => new Date(Date.now() + 3600_000) })).toMatchObject({ sent: 0 })
  })

  it('zły login → wysyłka firmy wyłączona, komunikat, alert; po poprawie mail wychodzi', async () => {
    await skonfiguruj({ haslo: 'zle-haslo-smtp' })
    await doOdbioru()
    expect(await wyslij()).toMatchObject({ disabled: true, sent: 0 })
    const v = await widokPoczty(a, ENV)
    expect(v.enabled).toBe(false)
    expect(v.lastError).toMatch(/odrzucił login albo hasło/)
    expect(await a.alert.count({ where: { kind: ALERT_LOGOWANIE } })).toBe(1)
    expect(JSON.stringify(await a.mailDelivery.findMany())).not.toContain('zle-haslo-smtp')
    await skonfiguruj()
    expect(await wyslij()).toMatchObject({ sent: 1 })
  })
})

describe('szablony firmy (Ustawienia → Poczta → Szablony)', () => {
  it('zmieniony temat i akapit idą w mailu; nieznana zmienna odrzucona; przywrócenie treści domyślnej', async () => {
    const f = new FormData()
    f.set('temat', 'Twoje zamówienie {{numerZamowienia}} czeka w Żółwiku')
    f.set('b1_tekst', 'zamówienie {{numerZamowienia}} jest gotowe, zapraszamy po odbiór. Zażółć gęślą jaźń.')
    await zapiszSzablon(a, 'gotowe-do-odbioru', nadpisanieZFormularza('gotowe-do-odbioru', f), 'osoba-testowa')
    const zly = new FormData()
    zly.set('temat', 'Zamówienie {{nieMa}}')
    await expect(zapiszSzablon(a, 'gotowe-do-odbioru', nadpisanieZFormularza('gotowe-do-odbioru', zly), 'osoba-testowa')).rejects.toThrow(/nieznana zmienna „nieMa”/)
    expect(podgladSzablonu('gotowe-do-odbioru', nadpisanieZFormularza('gotowe-do-odbioru', f)).temat).toBe('Twoje zamówienie ZAM-2026-00123 czeka w Żółwiku')
    await skonfiguruj()
    await doOdbioru()
    await wyslij()
    const x = rozloz(atrapa.maile[0]!.surowy)
    expect(x.temat).toMatch(/^Twoje zamówienie .+ czeka w Żółwiku$/)
    expect(x.html).toContain('Zażółć gęślą jaźń.')
    // firma B nie widzi szablonu firmy A
    expect(await b.mailTemplate.count()).toBe(0)
    await przywrocDomyslny(a, 'gotowe-do-odbioru', 'osoba-testowa')
    expect(await a.mailTemplate.count()).toBe(0)
  })
})

describe('mail próbny „Wyślij test”', () => {
  it('przychodzi z polskimi znakami; drugi w ciągu minuty odmówiony; bez POCZTA_WYSYLKA odmowa', async () => {
    await skonfiguruj({ enabled: false })
    expect(await wyslijMailProbny(a, { ...ENV, POCZTA_WYSYLKA: '' }, '', 'osoba')).toMatchObject({ ok: false })
    expect(await wyslijMailProbny(a, ENV, '', 'osoba')).toEqual({ ok: true, maska: 'b***@example.com' })
    const x = rozloz(atrapa.maile[0]!.surowy)
    expect(x.temat).toBe('Wiadomość próbna z Kompletora (Firma testowa A)')
    expect(x.tekst).toContain('Polskie znaki: Zażółć gęślą jaźń')
    expect(x.html).toContain('Zażółć gęślą jaźń')
    expect(await wyslijMailProbny(a, ENV, 'ktos@example.com', 'osoba')).toMatchObject({ ok: false, error: expect.stringMatching(/za minutę/) })
  })
})

/** Klient Prisma, który rzuca przy każdym dotknięciu MailSettings (reset hasła nie może czytać poczty firmy). */
function bezPocztyFirmy<T extends object>(db: T): T {
  return new Proxy(db, {
    get(t, k) {
      if (k === 'mailSettings') throw new Error('reset hasła czyta MailSettings firmy')
      const v = Reflect.get(t, k)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}

describe('reset hasła mailem', () => {
  it('prośba → mail z jednorazowym linkiem (poczta instalacji) → nowe hasło, sesje zakończone, drugi raz link nie działa; nieznany adres: ta sama odpowiedź', async () => {
    const u = await createUserWithHash(sys, { email: 'osoba@example.com', name: 'Osoba Testowa', passwordHash: await hashPassword('stare-haslo-123456') })
    await grantMembership(sys, { email: 'osoba@example.com', organizationId: ORG_A, role: 'MAGAZYN' })
    const lim = () => new SlidingLimiter(100, 60_000)
    const deps = { env: ENV_R, ipLimiter: lim(), orgClient: (id: string) => (id === ORG_A ? a : b) }
    expect(await poprosOReset(sys, { email: 'nikt@example.com', ip: '1.1.1.1' }, deps)).toEqual({ ok: true, message: MSG_RESET_WYSLANY })
    expect(await sys.passwordReset.count()).toBe(0)
    expect(await poprosOReset(sys, { email: 'Osoba@Example.com', ip: '1.1.1.1' }, deps)).toEqual({ ok: true, message: MSG_RESET_WYSLANY })
    const job = await a.job.findFirstOrThrow({ where: { kind: ZADANIE_RESETU } })
    expect(JSON.stringify(job.payload)).not.toMatch(/[A-Za-z0-9_-]{40,}/) // w kolejce tylko id prośby, nie token
    await zadanieResetuHasla({ sys: () => sys })(a, job.payload, { organizationId: ORG_A, secrets: { env: ENV_R, envFallback: false } })
    expect(atrapaInst.maile).toHaveLength(1)
    expect(atrapa.maile).toHaveLength(0)
    const x = rozloz(atrapaInst.maile[0]!.surowy)
    expect(atrapaInst.maile[0]!.do).toEqual(['osoba@example.com'])
    expect(atrapaInst.maile[0]!.od).toBe('konta@kompletor.example.com')
    expect(x.temat).toBe('Ustawienie nowego hasła do Kompletora (Firma testowa A)')
    expect(x.tekst).toContain('Jeśli to nie Ty, zignoruj tę wiadomość: hasło się nie zmieni.')
    const token = /nowe-haslo\?t=([A-Za-z0-9_-]+)/.exec(x.tekst)![1]!
    const row = await sys.passwordReset.findFirstOrThrow()
    expect(row.sealedToken).toBeNull() // po wysyłce token nie leży już w bazie
    await sys.session.create({ data: { id: 'sesja-1', userId: u.id, organizationId: ORG_A, expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } })
    const ip = { ipLimiter: lim() }
    expect(await ustawNoweHaslo(sys, { token, next: 'krotkie', repeat: 'krotkie', ip: '1.1.1.1' }, ip)).toMatchObject({ ok: false })
    expect(await ustawNoweHaslo(sys, { token, next: 'nowe-haslo-123456', repeat: 'nowe-haslo-123456', ip: '1.1.1.1' }, ip)).toEqual({ ok: true })
    const user = await sys.user.findUniqueOrThrow({ where: { id: u.id } })
    expect(await verifyPassword(user.passwordHash, 'nowe-haslo-123456')).toBe(true)
    expect(await sys.session.count({ where: { userId: u.id } })).toBe(0)
    expect(await ustawNoweHaslo(sys, { token, next: 'inne-haslo-123456', repeat: 'inne-haslo-123456', ip: '1.1.1.1' }, ip)).toEqual({ ok: false, message: MSG_RESET_ZLY_LINK })
    // drugie uruchomienie tego samego zadania nie wysyła drugiego maila
    await zadanieResetuHasla({ sys: () => sys })(a, job.payload, { organizationId: ORG_A, secrets: { env: ENV_R, envFallback: false } })
    expect(atrapaInst.maile).toHaveLength(1)
  })
})

describe('reset hasła nigdy pocztą firmy (audyt bezpieczeństwa)', () => {
  const lim = () => new SlidingLimiter(100, 60_000)
  async function wlascicielIUstawienia() {
    await createUserWithHash(sys, { email: 'wlasciciel@example.com', name: 'Właściciel Testowy', passwordHash: await hashPassword('stare-haslo-123456') })
    await grantMembership(sys, { email: 'wlasciciel@example.com', organizationId: ORG_A, role: 'WLASCICIEL' })
    // właściciel drugiej firmy, który ma też konto w firmie A (ostatnio używanej)
    await grantMembership(sys, { email: 'wlasciciel@example.com', organizationId: ORG_B, role: 'WLASCICIEL' })
    await sys.membership.updateMany({ where: { organizationId: ORG_A, user: { email: 'wlasciciel@example.com' } }, data: { lastSeenAt: new Date() } })
    // osoba z uprawnieniem `ustawienia` ustawia serwer poczty firmy A na swój serwer (atrapa)
    await skonfiguruj()
  }

  it('bez poczty instalacji link nie powstaje, a serwer poczty firmy nie dostaje niczego', async () => {
    await wlascicielIUstawienia()
    const logi: string[] = []
    const deps = { env: ENV, ipLimiter: lim(), orgClient: (id: string) => (id === ORG_A ? a : b), log: (m: string) => logi.push(m) }
    expect(await poprosOReset(sys, { email: 'wlasciciel@example.com', ip: '1.1.1.1' }, deps)).toEqual({ ok: true, message: MSG_RESET_WYSLANY })
    expect(await sys.passwordReset.count()).toBe(0)
    expect(await a.job.count({ where: { kind: ZADANIE_RESETU } })).toBe(0)
    expect(await b.job.count({ where: { kind: ZADANIE_RESETU } })).toBe(0)
    expect(atrapa.maile).toHaveLength(0)
    expect(logi.join('\n')).toMatch(/RESET_SMTP_HOST/)
    expect(logi.join('\n')).not.toContain('wlasciciel@example.com')
  })

  it('z pocztą instalacji link idzie tylko nią; ani prośba, ani worker nie czytają MailSettings firmy', async () => {
    await wlascicielIUstawienia()
    const deps = { env: ENV_R, ipLimiter: lim(), orgClient: (id: string) => (id === ORG_A ? a : b) }
    expect(await poprosOReset(bezPocztyFirmy(sys), { email: 'wlasciciel@example.com', ip: '1.1.1.1' }, deps)).toEqual({ ok: true, message: MSG_RESET_WYSLANY })
    expect(await sys.passwordReset.count()).toBe(1)
    const job = await a.job.findFirstOrThrow({ where: { kind: ZADANIE_RESETU } })
    await zadanieResetuHasla({ sys: () => sys }, () => {})(bezPocztyFirmy(a), job.payload, { organizationId: ORG_A, secrets: { env: ENV_R, envFallback: false } })
    expect(atrapa.maile).toHaveLength(0) // serwer ustawiony przez firmę nie widzi tokenu
    expect(atrapaInst.maile).toHaveLength(1)
    expect(atrapaInst.maile[0]!.do).toEqual(['wlasciciel@example.com'])
    expect((await a.mailDelivery.findFirstOrThrow({ where: { kind: 'reset-hasla' } })).state).toBe('SENT')
  })

  it('zadanie z kolejki bez poczty instalacji nie wysyła serwerem firmy (prośba sprzed zmiany), token znika', async () => {
    await wlascicielIUstawienia()
    const deps = { env: ENV_R, ipLimiter: lim(), orgClient: (id: string) => (id === ORG_A ? a : b) }
    await poprosOReset(sys, { email: 'wlasciciel@example.com', ip: '1.1.1.1' }, deps)
    const job = await a.job.findFirstOrThrow({ where: { kind: ZADANIE_RESETU } })
    const logi: string[] = []
    await zadanieResetuHasla({ sys: () => sys }, (m) => logi.push(m))(a, job.payload, { organizationId: ORG_A, secrets: { env: ENV, envFallback: false } })
    expect(atrapa.maile).toHaveLength(0)
    expect(atrapaInst.maile).toHaveLength(0)
    expect((await sys.passwordReset.findFirstOrThrow()).sealedToken).toBeNull()
    expect(logi.join('\n')).toMatch(/link nie wyszedł/)
  })
})

describe('reset hasła: bramki, błędy i sprzątanie', () => {
  const lim = () => new SlidingLimiter(100, 60_000)
  const ctxA = () => ({ organizationId: ORG_A, secrets: { env: ENV_R, envFallback: false } })
  async function prosba(env: Record<string, string> = ENV_R) {
    if (!(await sys.user.findUnique({ where: { email: 'osoba@example.com' } })))
      await createUserWithHash(sys, { email: 'osoba@example.com', name: 'Osoba Testowa', passwordHash: await hashPassword('stare-haslo-123456') })
    if (!(await sys.membership.count({ where: { organizationId: ORG_A, user: { email: 'osoba@example.com' } } })))
      await grantMembership(sys, { email: 'osoba@example.com', organizationId: ORG_A, role: 'MAGAZYN' })
    const deps = { env, ipLimiter: lim(), orgClient: (id: string) => (id === ORG_A ? a : b), log: () => {} }
    expect(await poprosOReset(sys, { email: 'osoba@example.com', ip: '1.1.1.1' }, deps)).toEqual({ ok: true, message: MSG_RESET_WYSLANY })
  }

  it('poczta firmy nie ma znaczenia: bez serwera firmy i przy wyłączonej wysyłce z planu link wychodzi pocztą instalacji', async () => {
    await prosba()
    let job = await a.job.findFirstOrThrow({ where: { kind: ZADANIE_RESETU } })
    await zadanieResetuHasla({ sys: () => sys }, () => {})(a, job.payload, ctxA())
    expect(atrapaInst.maile).toHaveLength(1)
    await skonfiguruj({ enabled: false })
    await prosba()
    job = await a.job.findFirstOrThrow({ where: { kind: ZADANIE_RESETU, id: { not: job.id } } })
    await zadanieResetuHasla({ sys: () => sys }, () => {})(a, job.payload, ctxA())
    expect(atrapaInst.maile).toHaveLength(2)
    expect(atrapa.maile).toHaveLength(0)
    expect(await a.mailDelivery.count({ where: { kind: 'reset-hasla', state: 'SENT' } })).toBe(2)
  })

  it('poczta instalacji odrzuca login: link nie wychodzi, token znika, ustawienia poczty firmy i alerty firmy bez zmian', async () => {
    await skonfiguruj()
    const zly = { ...ENV, ...envPocztyInstalacji(atrapaInst, { haslo: 'zle-haslo' }) }
    await prosba(zly)
    const job = await a.job.findFirstOrThrow({ where: { kind: ZADANIE_RESETU } })
    const logi: string[] = []
    await zadanieResetuHasla({ sys: () => sys }, (m) => logi.push(m))(a, job.payload, { organizationId: ORG_A, secrets: { env: zly, envFallback: false } })
    expect(atrapaInst.maile).toHaveLength(0)
    expect(atrapa.maile).toHaveLength(0)
    expect((await a.mailDelivery.findFirstOrThrow()).state).toBe('FAILED')
    expect((await sys.passwordReset.findFirstOrThrow()).sealedToken).toBeNull()
    expect(JSON.stringify(await a.mailDelivery.findMany())).not.toContain('osoba@example.com')
    expect(logi.join('\n')).toMatch(/RESET_SMTP/)
    const v = await widokPoczty(a, ENV)
    expect(v.enabled).toBe(true)
    expect(v.loginRejectedAt).toBeNull()
    expect(await a.alert.count({ where: { kind: ALERT_LOGOWANIE } })).toBe(0)
    // poprawione hasło instalacji: kolejna prośba wychodzi
    await prosba()
    const job2 = await a.job.findFirstOrThrow({ where: { kind: ZADANIE_RESETU, id: { not: job.id } } })
    await zadanieResetuHasla({ sys: () => sys }, () => {})(a, job2.payload, ctxA())
    expect(atrapaInst.maile).toHaveLength(1)
  })

  it('niepoprawna poczta instalacji (brak nadawcy, login bez hasła): link nie powstaje', async () => {
    await prosba({ ...ENV_R, RESET_SMTP_NADAWCA: '' })
    expect(await sys.passwordReset.count()).toBe(0)
    await prosba({ ...ENV_R, RESET_SMTP_PASSWORD: '' })
    expect(await sys.passwordReset.count()).toBe(0)
  })

  it('blokada po AUTH z planu akcji; zdejmuje ją ponowne włączenie albo udany mail próbny', async () => {
    await skonfiguruj({ haslo: 'zle-haslo-smtp' })
    await doOdbioru()
    expect(await wyslij()).toMatchObject({ disabled: true })
    expect((await widokPoczty(a, ENV)).loginRejectedAt).toBeInstanceOf(Date)
    // dostawca naprawił konto (te same dane w panelu): udany mail próbny zdejmuje blokadę
    await skonfiguruj({ enabled: false })
    await a.mailSettings.updateMany({ data: { loginRejectedAt: new Date() } })
    expect(await wyslijMailProbny(a, ENV, '', 'osoba')).toMatchObject({ ok: true })
    expect((await widokPoczty(a, ENV)).loginRejectedAt).toBeNull()
    // ponowne włączenie bez zmiany danych też zdejmuje blokadę
    await a.mailSettings.updateMany({ data: { loginRejectedAt: new Date() } })
    await skonfiguruj()
    expect((await widokPoczty(a, ENV)).loginRejectedAt).toBeNull()
  })

  it('błąd renderu przed zajęciem — bez wpisu SENDING, bez ponawiania, token wyczyszczony', async () => {
    await skonfiguruj()
    await prosba()
    const job = await a.job.findFirstOrThrow({ where: { kind: ZADANIE_RESETU } })
    const zly = () => {
      throw new BladSzablonu(['reset hasła: zepsuty szablon'])
    }
    await expect(zadanieResetuHasla({ sys: () => sys, renderuj: zly }, () => {})(a, job.payload, ctxA())).rejects.toBeInstanceOf(NonRetryableError)
    expect(await a.mailDelivery.count()).toBe(0)
    expect(atrapaInst.maile).toHaveLength(0)
    expect((await sys.passwordReset.findFirstOrThrow()).sealedToken).toBeNull()
    // przebieg wysyłki 10 min później nie zgłasza „porzuconej” wysyłki
    expect(await wyslij({ now: () => new Date(Date.now() + 11 * 60_000) })).toMatchObject({ stale: 0 })
    expect(await a.alert.count({ where: { kind: ALERT_NIEPEWNY } })).toBe(0)
  })

  it('sprzątanie raz na dobę: wygasły link traci token, stary znika, druga firma nietknięta', async () => {
    await prosba()
    const r = await sys.passwordReset.findFirstOrThrow()
    expect(r.sealedToken).not.toBeNull()
    const zaGodzine = new Date(Date.now() + 2 * 3600_000)
    await zadanieSprzataniaResetow({ sys: () => sys, now: () => zaGodzine })(a, null, ctxA())
    expect((await sys.passwordReset.findUniqueOrThrow({ where: { id: r.id } })).sealedToken).toBeNull()
    // wpis drugiej firmy: zadanie firmy A go nie rusza
    await sys.passwordReset.update({ where: { id: r.id }, data: { organizationId: ORG_B } })
    await zadanieSprzataniaResetow({ sys: () => sys, now: () => new Date(Date.now() + 3 * 24 * 3600_000) })(a, null, ctxA())
    expect(await sys.passwordReset.count()).toBe(1)
    await zadanieSprzataniaResetow({ sys: () => sys, now: () => new Date(Date.now() + 3 * 24 * 3600_000) })(b, null, { ...ctxA(), organizationId: ORG_B })
    expect(await sys.passwordReset.count()).toBe(0)
    expect(handlers[ZADANIE_SPRZATANIA_RESETOW]).toBeTypeOf('function')
    expect(HARMONOGRAM_RDZENIA.find((h) => h.kind === ZADANIE_SPRZATANIA_RESETOW)?.everyMs).toBe(24 * 3600_000)
  })
})

describe('rejestracja w workerze', () => {
  it('zadania poczty są w rejestrze, wysyłka w harmonogramie co minutę', () => {
    expect(handlers['poczta-wysylka']).toBeTypeOf('function')
    expect(handlers[ZADANIE_RESETU]).toBeTypeOf('function')
    expect(HARMONOGRAM_RDZENIA.find((h) => h.kind === 'poczta-wysylka')?.everyMs).toBe(60_000)
  })
})
