// reszta poczty. Prawdziwy transport SMTP (nodemailer) do lokalnej atrapy na 127.0.0.1
// (tests/smtp-atrapa.ts), zero maili do prawdziwych adresów, wyłącznie dane fikcyjne (example.com / example.test).
//  1. PDF dokumentu w mailu „Wysłane z fakturą” przez dostawcę dokumentów firmy (atrapa programu do faktur):
//     plik z dostawcy, numer z próby wystawienia w temacie, chwilowy błąd = czeka, dostawca bez PDF = czeka;
//     firma bez programu do faktur: reguła nie planuje maila „Faktura”.
//  2. Profil firmy (Ustawienia → Dane firmy) w stopce i jako adres biura; zapas: „Adres biura” z Ustawień → Poczta.
//  3. Zaproszenia mailem: link tylko do zaproszonej osoby (delivered), bez poczty albo przy błędzie: link do skopiowania.
//  4. Odmowa 5xx z powodu ustawień (MAIL FROM, STARTTLS) = KONFIGURACJA, nie odmowa adresata.
//  5. Prośby o reset bez utworzonego linku nie blokują resetu. Limit godzinowy przy dwóch przebiegach naraz.
//  6. Odbicia po wysłaniu (DSN): wysłany mail przechodzi w ODBITY z alertem bez pełnego adresu; drugi raport, obca
//     firma i mail niewysłany niczego nie zmieniają.
//  Poprawki po przeglądzie: budżet przed pobraniem PDF (1a), hamulce i czas oczekiwania
//  zaproszeń (3a), „Relay access denied” i odmowa połączenia (4a), obcy adresat w raporcie (6).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { planujAkcje } from '@/lib/akcje/silnik'
import { SlidingLimiter } from '@/lib/auth/limiter'
import { poprosOReset } from '@/lib/auth/reset-hasla'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { hashPassword } from '@/lib/auth/hasla'
import type { DostawcaDokumentow } from '@/lib/dokumenty/kontrakt'
import { CEL_PDF_FAKTURY } from '@/lib/dokumenty/pdf'
import { PODGLAD_AUDIT } from '@/lib/klienci/odczyt'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { PDF_PRZYKLADOWY } from '@/lib/maile/przyklady'
import { addMember } from '@/lib/panel/uzytkownicy'
import { domyslneZrodloPdf, zrodloPdfZDokumentow } from '@/lib/poczta/dokument-pdf'
import { zapiszUstawieniaPoczty, type WejscieUstawien } from '@/lib/poczta/ustawienia'
import { ALERT_KONFIGURACJA, ALERT_ODRZUCONY, PER_HOUR, PER_RUN, wyslijZaplanowane } from '@/lib/poczta/wysylka'
import { LIMIT_FIRMY, LIMIT_NA_ADRES, TIMEOUT_MS, zaproszeniaPoczta } from '@/lib/poczta/zaproszenia'
import { ALERT_ODBICIE, przyjmijOdbicie, rozpoznajOdbicie } from '@/lib/poczta/odbicia'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
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

beforeAll(async () => {
  atrapa = await uruchomAtrape({ login: 'kompletor', haslo: 'tajne-haslo-smtp' })
})
afterAll(async () => {
  await atrapa.zamknij()
  await a.$disconnect()
  await b.$disconnect()
  await sys.$disconnect()
})
beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
  atrapa.maile.length = 0
  atrapa.opcje.odrzuc = []
  atrapa.opcje.chwilowaOdmowa = false
  atrapa.opcje.zerwijPoDanych = false
  atrapa.opcje.odmowaNadawcy = null
  atrapa.opcje.odmowaAdresata = null
  atrapa.opcje.powitanie = null
  atrapa.opcje.milcz = false
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
    nadawcy: { 'WOO:sd': { nazwaSklepu: 'Pracownia Żółwik', email: 'sklep@example.com', odpowiedzDo: 'kontakt@example.com', kolor: '#2f6b3a', odbiorAdres: 'Pracownia Żółwik\nul. Przykładowa 1\n00-000 Testowo', odbiorGodziny: 'poniedziałek-piątek 9:00-17:00' } },
    ...over,
  }
}

const skonfiguruj = (over: Partial<WejscieUstawien> = {}, kiedy = new Date(Date.now() - 60_000)) => zapiszUstawieniaPoczty(a, wejscie(over), 'osoba-testowa', ENV, kiedy)
const wyslij = (deps: Parameters<typeof wyslijZaplanowane>[2] = {}) => wyslijZaplanowane(a, ENV, deps)
const wpisy = () => a.mailDelivery.findMany({ orderBy: { createdAt: 'asc' } })

async function zamowienieZKlientem(over: Parameters<typeof order>[1] = {}) {
  const p = await product(a, `P-${Math.random().toString(36).slice(2, 7)}`, 10)
  const r = await ingestOrder(a, order([{ productId: p, qty: 2 }], over))
  await zapiszRekordKlienta(a, r.orderId!, rekordZOdbiorcy(ODBIORCA), { source: 'KANAL', fetchedAt: new Date(), env: ENV })
  return r.orderId!
}

async function ustawFirme(patch: Record<string, unknown>) {
  const org = await a.organization.findUniqueOrThrow({ where: { id: ORG_A }, select: { settings: true } })
  const s = org.settings && typeof org.settings === 'object' && !Array.isArray(org.settings) ? (org.settings as Record<string, unknown>) : {}
  await a.organization.update({ where: { id: ORG_A }, data: { settings: { ...s, ...patch } as object } })
}

/** Wysłane zamówienie z wystawionym dokumentem programu firmy i planem maila „Faktura”. */
async function wyslaneZDokumentem(docId = 'DOC-7', numer: string | null = 'FV 7/11/2026') {
  const orderId = await zamowienieZKlientem()
  await a.order.update({ where: { id: orderId }, data: { status: 'WYSLANE' } })
  await a.invoiceAttempt.create({ data: { orderId, packageNo: 1, attemptNo: 1, idExternal: `${orderId}/1/1`, state: 'ISSUED', wfirmaDocId: docId, number: numer } })
  await a.plannedAction.create({
    data: { rule: 'mail.faktura', targetType: 'ZAMOWIENIE', targetId: orderId, occasion: `FV:${docId}`, mode: 'PRACA', state: 'PLANNED', vars: { numerZamowienia: 'SD 1', wfirmaDocId: docId }, dueAt: new Date(Date.now() - 1000) },
  })
  return orderId
}

const base64Pdf = Buffer.from(PDF_PRZYKLADOWY).toString('base64')
function atrapaDostawcy(over: Partial<DostawcaDokumentow> = {}, wywolania: string[] = []): DostawcaDokumentow {
  return {
    program: 'fakturownia.v1',
    nazwa: 'Fakturownia (atrapa)',
    zdolnosci: ['pdf'],
    pdf: async (docId) => {
      wywolania.push(docId)
      return { contentType: 'application/pdf', base64: base64Pdf }
    },
    ...over,
  }
}

describe('1. PDF z dostawcy dokumentów firmy w mailu „Wysłane z fakturą”', () => {
  it('program z rejestru ze zdolnością PDF: plik z dostawcy w załączniku, numer z próby w temacie, wpis w dzienniku podglądów', async () => {
    await skonfiguruj()
    await ustawFirme({ faktury: { program: 'fakturownia.v1' } })
    const orderId = await wyslaneZDokumentem()
    const wywolania: string[] = []
    const programy: string[] = []
    const pdf = zrodloPdfZDokumentow({ env: ENV, dostawca: async (_db, program) => (programy.push(program), atrapaDostawcy({}, wywolania)) })
    expect(await wyslij({ pdf })).toMatchObject({ sent: 1, errors: [] })
    expect(programy).toEqual(['fakturownia.v1'])
    expect(wywolania).toEqual(['DOC-7'])
    expect(atrapa.maile).toHaveLength(1)
    expect(atrapa.maile[0]!.do).toEqual([EMAIL])
    const x = rozloz(atrapa.maile[0]!.surowy)
    expect(x.temat).toBe('Faktura FV 7/11/2026 do zamówienia SD 1')
    expect(x.zalaczniki).toHaveLength(1)
    expect(x.zalaczniki[0]!.typ).toBe('application/pdf')
    expect(x.zalaczniki[0]!.nazwa).toBe('Faktura-FV-7-11-2026.pdf')
    expect(x.zalaczniki[0]!.tresc.subarray(0, 5).toString()).toBe('%PDF-')
    const wpis = await a.auditLog.findFirstOrThrow({ where: { entity: PODGLAD_AUDIT, entityId: orderId } })
    expect(wpis.actorId).toBe('system:poczta')
  })

  it('numer nieznany: mail bez numeru, identyfikator dokumentu nie trafia do tematu, treści ani nazwy pliku', async () => {
    await skonfiguruj()
    await ustawFirme({ faktury: { program: 'fakturownia.v1' } })
    await wyslaneZDokumentem('DOC-8', null)
    expect(await wyslij({ pdf: zrodloPdfZDokumentow({ env: ENV, dostawca: async () => atrapaDostawcy() }) })).toMatchObject({ sent: 1 })
    const x = rozloz(atrapa.maile[0]!.surowy)
    expect(x.temat).toBe('Faktura do zamówienia SD 1')
    expect(x.tekst).toContain('w załączniku przesyłamy fakturę do zamówienia')
    expect(x.tekst).not.toContain('Numer faktury')
    expect(x.zalaczniki).toHaveLength(1)
    expect(x.zalaczniki[0]!.nazwa).toBe('Faktura-do-zamówienia-SD-1.pdf')
    expect(x.zalaczniki[0]!.tresc.subarray(0, 5).toString()).toBe('%PDF-')
    expect([x.temat, x.tekst, x.html, ...x.zalaczniki.map((z) => z.nazwa)].join(' ')).not.toContain('DOC-8')
  })

  it('numer nieznany, a źródło PDF podaje nazwę pliku z identyfikatorem: nazwa z numeru zamówienia', async () => {
    await skonfiguruj()
    await wyslaneZDokumentem('84512345', null)
    const pdf = { pobierz: async () => ({ stan: 'PDF' as const, tresc: PDF_PRZYKLADOWY, numer: null, nazwaPliku: 'faktura-84512345.pdf' }) }
    expect(await wyslij({ pdf })).toMatchObject({ sent: 1 })
    const x = rozloz(atrapa.maile[0]!.surowy)
    expect(x.temat).toBe('Faktura do zamówienia SD 1')
    expect(x.zalaczniki[0]!.nazwa).toBe('Faktura-do-zamówienia-SD-1.pdf')
    expect([x.temat, x.tekst, x.html, ...x.zalaczniki.map((z) => z.nazwa)].join(' ')).not.toContain('84512345')
  })

  it('mail „Faktura”: numer faktury z programu w postaci z programu, bez identyfikatora dokumentu i bez dopisku', async () => {
    await skonfiguruj()
    await ustawFirme({ faktury: { program: 'fakturownia.v1' } })
    await wyslaneZDokumentem('84512345', 'FS 24/13/11/26')
    expect(await wyslij({ pdf: zrodloPdfZDokumentow({ env: ENV, dostawca: async () => atrapaDostawcy() }) })).toMatchObject({ sent: 1 })
    const x = rozloz(atrapa.maile[0]!.surowy)
    expect(x.temat).toBe('Faktura FS 24/13/11/26 do zamówienia SD 1')
    expect(x.tekst).toContain('FS 24/13/11/26')
    expect(`${x.temat}\n${x.tekst}\n${x.html}`).not.toMatch(/84512345|dokument wFirmy/)
    expect(x.zalaczniki[0]!.nazwa).toBe('Faktura-FS-24-13-11-26.pdf')
  })

  it('chwilowy błąd dostawcy = mail czeka (POZNIEJ), po naprawie wychodzi z PDF; nigdy bez załącznika', async () => {
    await skonfiguruj()
    await ustawFirme({ faktury: { program: 'fakturownia.v1' } })
    await wyslaneZDokumentem()
    let padnie = true
    const pdf = zrodloPdfZDokumentow({
      env: ENV,
      dostawca: async () =>
        atrapaDostawcy({
          pdf: async () => {
            if (padnie) throw new Error('HTTP 503 Service Unavailable')
            return { contentType: 'application/pdf', base64: base64Pdf }
          },
        }),
    })
    expect(await wyslij({ pdf })).toMatchObject({ sent: 0, waiting: 1 })
    const [d] = await wpisy()
    expect(d).toMatchObject({ state: 'CZEKA' })
    expect(d!.lastError).toMatch(/nie udało się pobrać PDF z programu Fakturownia \(atrapa\): HTTP 503/)
    expect(atrapa.maile).toHaveLength(0)
    padnie = false
    expect(await wyslij({ pdf, now: () => new Date(Date.now() + 16 * 60_000) })).toMatchObject({ sent: 1 })
    expect(rozloz(atrapa.maile[0]!.surowy).zalaczniki).toHaveLength(1)
  })

  it('dostawca bez zdolności PDF albo niepodłączony program = mail czeka (BRAK), bez wywołań i bez maila', async () => {
    await skonfiguruj()
    await ustawFirme({ faktury: { program: 'fakturownia.v1' } })
    const orderId = await wyslaneZDokumentem()
    expect(await wyslij({ pdf: zrodloPdfZDokumentow({ env: ENV, dostawca: async () => atrapaDostawcy({ zdolnosci: [], pdf: undefined }) }) })).toMatchObject({ sent: 0, waiting: 1 })
    expect((await wpisy())[0]!.lastError).toMatch(/Fakturownia \(atrapa\) nie daje pliku PDF/)
    // domyślna fabryka: program z rejestru bez podłączonego adaptera
    expect(await domyslneZrodloPdf.pobierz(a, { orderId, docId: 'DOC-7' })).toMatchObject({ stan: 'BRAK' })
    expect(atrapa.maile).toHaveLength(0)
  })

  it('firma bez programu do faktur: wysłane zamówienie bez dokumentu nie dostaje planu „Faktura”; źródło PDF mówi BRAK', async () => {
    await skonfiguruj()
    await ustawFirme({ faktury: { program: 'brak' } })
    const orderId = await zamowienieZKlientem()
    await a.order.update({ where: { id: orderId }, data: { status: 'WYSLANE' } })
    await planujAkcje(a)
    expect(await a.plannedAction.count({ where: { rule: 'mail.faktura' } })).toBe(0)
    expect(await domyslneZrodloPdf.pobierz(a, { orderId, docId: 'X' })).toEqual({ stan: 'BRAK', powod: expect.stringMatching(/nie wystawia dokumentów sprzedaży/) })
    expect(await wyslij()).toMatchObject({ sent: 0, waiting: 0 })
  })
})

describe('1a. Budżet przebiegu przed pobraniem PDF', () => {
  /** Wpisy dziennika podglądów za pobranie PDF (osobno od wpisów za odczyt danych kontaktowych do maila). */
  const wpisyPdf = () => a.auditLog.count({ where: { entity: PODGLAD_AUDIT, after: { path: ['cel'], equals: CEL_PDF_FAKTURY } } })
  it('25 maili „Faktura” naraz: PDF pobrany i wpisany do dziennika tylko dla 20 wysłanych, reszta czeka na kolejny przebieg', async () => {
    await skonfiguruj()
    await ustawFirme({ faktury: { program: 'fakturownia.v1' } })
    for (let i = 0; i < PER_RUN + 5; i++) await wyslaneZDokumentem(`DOC-${i}`)
    const wywolania: string[] = []
    const pdf = zrodloPdfZDokumentow({ env: ENV, dostawca: async () => atrapaDostawcy({}, wywolania) })
    expect(await wyslij({ pdf })).toMatchObject({ sent: PER_RUN, deferred: 5, errors: [] })
    expect(wywolania).toHaveLength(PER_RUN)
    expect(await wpisyPdf()).toBe(PER_RUN)
    expect(atrapa.maile).toHaveLength(PER_RUN)
    // kolejny przebieg: reszta (5), bez ponownych pobrań dla wysłanych
    expect(await wyslij({ pdf })).toMatchObject({ sent: 5, deferred: 0 })
    expect(wywolania).toHaveLength(PER_RUN + 5)
    expect(await wpisyPdf()).toBe(PER_RUN + 5)
  })

  it('wyczerpany limit godzinowy: ani jednego pobrania PDF i wpisu w dzienniku, wszystkie maile odłożone', async () => {
    await skonfiguruj()
    await ustawFirme({ faktury: { program: 'fakturownia.v1' } })
    await a.mailDelivery.createMany({ data: Array.from({ length: PER_HOUR }, (_, i) => ({ dedupeKey: `wczesniej:${i}`, kind: 'test', state: 'SENT', attempts: 1, lastAttemptAt: new Date() })) })
    for (let i = 0; i < 3; i++) await wyslaneZDokumentem(`DOC-${i}`)
    const wywolania: string[] = []
    const pdf = zrodloPdfZDokumentow({ env: ENV, dostawca: async () => atrapaDostawcy({}, wywolania) })
    expect(await wyslij({ pdf })).toMatchObject({ sent: 0, deferred: 3, skipped: 'limit' })
    expect(wywolania).toHaveLength(0)
    expect(await a.auditLog.count({ where: { entity: PODGLAD_AUDIT } })).toBe(0) // ani PDF, ani danych kontaktowych
    expect(atrapa.maile).toHaveLength(0)
  })
})

describe('2. profil firmy w mailach', () => {
  async function bladFaktury() {
    const orderId = await zamowienieZKlientem()
    await a.plannedAction.create({
      data: { rule: 'mail.blad-faktury', targetType: 'ZAMOWIENIE', targetId: orderId, occasion: 'proba:x', mode: 'PRACA', vars: { numerZamowienia: 'SD 2', idExternal: 'x' }, dueAt: new Date(Date.now() - 1000) },
    })
  }

  it('Dane firmy: nazwa, NIP, adres i telefon w stopce; e-mail biura z profilu jest adresatem maili do biura', async () => {
    await skonfiguruj()
    await ustawFirme({ firma: { nazwa: 'Przyprawy Testowe sp. z o.o.', nip: '7811234567', adres: { ulica: 'ul. Zielona 5', kodPocztowy: '60-100', miasto: 'Poznań' }, emailBiura: 'biuro-profil@example.com', email: 'kontakt-firmy@example.com', telefon: '+48 600 000 000' } })
    await bladFaktury()
    expect(await wyslij()).toMatchObject({ sent: 1 })
    expect(atrapa.maile[0]!.do).toEqual(['biuro-profil@example.com'])
    const x = rozloz(atrapa.maile[0]!.surowy)
    for (const t of ['Przyprawy Testowe sp. z o.o.', 'NIP 7811234567', 'ul. Zielona 5', '60-100 Poznań', '+48 600 000 000', 'kontakt-firmy@example.com']) expect(x.tekst, t).toContain(t)
  })

  it('profil bez e-maila biura: zapas „Adres biura” z Ustawień → Poczta', async () => {
    await skonfiguruj()
    await ustawFirme({ firma: { nazwa: 'Przyprawy Testowe sp. z o.o.' } })
    await bladFaktury()
    expect(await wyslij()).toMatchObject({ sent: 1 })
    expect(atrapa.maile[0]!.do).toEqual(['biuro@example.com'])
    expect(rozloz(atrapa.maile[0]!.surowy).tekst).toContain('Przyprawy Testowe sp. z o.o.')
  })
})

describe('3. zaproszenia mailem', () => {
  const OSOBA = 'nowa.osoba@example.test'
  let wlasciciel: string
  beforeEach(async () => {
    wlasciciel = (await createUserWithHash(sys, { email: 'wlasciciel@example.test', name: 'Właściciel', passwordHash: await hashPassword('haslo-wlasciciela-123') })).id
    await grantMembership(sys, { email: 'wlasciciel@example.test', organizationId: ORG_A, role: 'WLASCICIEL' })
  })
  const zapros = (env: Record<string, string> = ENV) =>
    addMember({ userId: wlasciciel, organizationId: ORG_A }, { email: OSOBA, name: '', role: 'MAGAZYN', permissions: [] }, { sys, appMode: 'hosted', panelUrl: 'https://panel.example.com', sender: zaproszeniaPoczta(a, env, { log: () => {} }) })

  it('gotowa poczta firmy: link tylko w mailu do zaproszonej osoby, nie w odpowiedzi; zaproszenie doręczone', async () => {
    await skonfiguruj({ enabled: false }) // włącznik planu akcji nie ma znaczenia (jak reset hasła)
    expect(await zapros()).toEqual({ ok: true, kind: 'invited', link: null })
    expect(atrapa.maile).toHaveLength(1)
    expect(atrapa.maile[0]!.do).toEqual([OSOBA])
    const x = rozloz(atrapa.maile[0]!.surowy)
    expect(x.temat).toBe('Zaproszenie do firmy Firma testowa A w Kompletorze')
    expect(x.tekst).toContain('(rola: Magazyn)')
    const token = /zaproszenie\?t=([A-Za-z0-9_-]{43})/.exec(x.tekst)?.[1]
    expect(token).toBeTruthy()
    const inv = await sys.invitation.findFirstOrThrow({ where: { email: OSOBA } })
    expect(inv.delivered).toBe(true)
    const [d] = await wpisy()
    expect(d).toMatchObject({ kind: 'zaproszenie', state: 'SENT', dedupeKey: `zaproszenie:${inv.id}`, recipient: 'n***@example.test' })
    // token ani pełny adres nie trafiają do wpisów wysyłki, alertów ani dziennika
    const slad = JSON.stringify([await wpisy(), await a.alert.findMany(), await a.auditLog.findMany()])
    expect(slad).not.toContain(token!)
    expect(slad).not.toContain(OSOBA)
  })

  it('bez bramki instancji albo bez poczty: link do skopiowania (jak dotąd), zaproszenie niedoręczone, zero maili', async () => {
    const r1 = await zapros() // poczta firmy nieustawiona
    expect(r1).toMatchObject({ ok: true, kind: 'invited', link: expect.stringMatching(/^https:\/\/panel\.example\.com\/zaproszenie\?t=/) })
    await skonfiguruj()
    const r2 = await zapros({ ...ENV, POCZTA_WYSYLKA: '' })
    expect(r2).toMatchObject({ ok: true, kind: 'invited', link: expect.any(String) })
    expect(atrapa.maile).toHaveLength(0)
    expect(await sys.invitation.count({ where: { delivered: true } })).toBe(0)
  })

  it('odmowa serwera z powodu ustawień: link do skopiowania, komunikat w Ustawieniach → Poczta, alert bez adresata', async () => {
    await skonfiguruj()
    atrapa.opcje.odmowaNadawcy = '530 5.7.0 Must issue a STARTTLS command first'
    expect(await zapros()).toMatchObject({ ok: true, kind: 'invited', link: expect.any(String) })
    const ust = await a.mailSettings.findFirstOrThrow()
    expect(ust.enabled).toBe(false)
    expect(ust.lastError).toMatch(/nie przyjmuje maili przy tych ustawieniach/)
    const al = await a.alert.findFirstOrThrow({ where: { kind: ALERT_KONFIGURACJA } })
    expect(al.message).not.toMatch(/@/)
    expect((await wpisy())[0]).toMatchObject({ kind: 'zaproszenie', state: 'FAILED' })
  })
})

describe('3a. Hamulce i czas oczekiwania zaproszeń', () => {
  const OSOBA = 'nowa.osoba@example.test'
  let wlasciciel: string
  beforeEach(async () => {
    wlasciciel = (await createUserWithHash(sys, { email: 'wlasciciel@example.test', name: 'Właściciel', passwordHash: await hashPassword('haslo-wlasciciela-123') })).id
    await grantMembership(sys, { email: 'wlasciciel@example.test', organizationId: ORG_A, role: 'WLASCICIEL' })
  })
  const logi: string[] = []
  const zapros = (email = OSOBA) =>
    addMember({ userId: wlasciciel, organizationId: ORG_A }, { email, name: '', role: 'MAGAZYN', permissions: [] }, { sys, appMode: 'hosted', panelUrl: 'https://panel.example.com', sender: zaproszeniaPoczta(a, ENV, { log: (m) => logi.push(m) }) })

  it(`najwyżej ${LIMIT_NA_ADRES} maile z zaproszeniem na godzinę na adres: kolejne zaproszenie wraca z linkiem do skopiowania`, async () => {
    await skonfiguruj()
    for (let i = 0; i < LIMIT_NA_ADRES; i++) expect(await zapros()).toMatchObject({ ok: true, link: null })
    expect(atrapa.maile).toHaveLength(LIMIT_NA_ADRES)
    logi.length = 0
    expect(await zapros()).toMatchObject({ ok: true, kind: 'invited', link: expect.stringMatching(/^https:\/\/panel\.example\.com\/zaproszenie\?t=/) })
    expect(atrapa.maile).toHaveLength(LIMIT_NA_ADRES)
    expect(logi.join('\n')).toMatch(/limit 3 zaproszeń na godzinę na adres/)
    expect(logi.join('\n')).not.toContain(OSOBA)
    // inny adres w tej samej godzinie dalej dostaje mail
    expect(await zapros('inna.osoba@example.test')).toMatchObject({ ok: true, link: null })
  })

  it(`najwyżej ${LIMIT_FIRMY} zaproszeń na godzinę w firmie i limit godzinowy maili firmy: link do skopiowania, zero maili`, async () => {
    await skonfiguruj()
    await a.mailDelivery.createMany({ data: Array.from({ length: LIMIT_FIRMY }, (_, i) => ({ dedupeKey: `zaproszenie:stare-${i}`, kind: 'zaproszenie', state: 'SENT', attempts: 1, lastAttemptAt: new Date(), recipient: `x${i}***@example.test` })) })
    expect(await zapros()).toMatchObject({ ok: true, link: expect.any(String) })
    expect(atrapa.maile).toHaveLength(0)
    // zaproszenia sprzed godziny się nie liczą, ale pełny limit godzinowy firmy (np. maile do klientów) też hamuje
    await a.mailDelivery.updateMany({ where: { kind: 'zaproszenie' }, data: { lastAttemptAt: new Date(Date.now() - 2 * 3600_000) } })
    await a.mailDelivery.createMany({ data: Array.from({ length: PER_HOUR }, (_, i) => ({ dedupeKey: `wczesniej:${i}`, kind: 'test', state: 'SENT', attempts: 1, lastAttemptAt: new Date() })) })
    expect(await zapros()).toMatchObject({ ok: true, link: expect.any(String) })
    expect(atrapa.maile).toHaveLength(0)
    expect(await sys.invitation.count({ where: { delivered: true } })).toBe(0)
  })

  it('milczący serwer poczty: akcja panelu czeka najwyżej ok. 10 s (nie 20 s na krok), link do skopiowania', async () => {
    const cicha = await uruchomAtrape({ milcz: true })
    try {
      await skonfiguruj({ port: String(cicha.port) })
      const start = Date.now()
      expect(await zapros()).toMatchObject({ ok: true, link: expect.any(String) })
      const trwalo = Date.now() - start
      expect(trwalo).toBeGreaterThanOrEqual(TIMEOUT_MS - 500)
      expect(trwalo).toBeLessThan(TIMEOUT_MS + 5_000)
      expect((await wpisy())[0]).toMatchObject({ kind: 'zaproszenie', state: 'FAILED' })
      expect(await a.mailSettings.findFirstOrThrow()).toMatchObject({ enabled: true }) // chwilowy błąd nie wyłącza poczty
    } finally {
      await cicha.zamknij()
    }
  }, 30_000)
})

describe('4. Odmowa z powodu ustawień serwera w wysyłce z planu', () => {
  it('530 na MAIL FROM: KONFIGURACJA — mail wraca do kolejki bez zużytej próby, wysyłka wyłączona, bez alertu o adresacie; po naprawie wychodzi', async () => {
    await skonfiguruj()
    const orderId = await zamowienieZKlientem({ deliveryMethod: 'Odbiór osobisty' })
    await a.order.update({ where: { id: orderId }, data: { status: 'DO_ODBIORU' } })
    await planujAkcje(a)
    atrapa.opcje.odmowaNadawcy = '530 5.7.0 Must issue a STARTTLS command first'
    expect(await wyslij()).toMatchObject({ sent: 0, failed: 1, disabled: true })
    const [d] = await wpisy()
    expect(d).toMatchObject({ state: 'FAILED', attempts: 0 })
    expect(d!.nextAttemptAt).not.toBeNull()
    expect(await a.alert.count({ where: { kind: ALERT_ODRZUCONY } })).toBe(0)
    const al = await a.alert.findFirstOrThrow({ where: { kind: ALERT_KONFIGURACJA } })
    expect(al.message).not.toMatch(/@/)
    const ust = await a.mailSettings.findFirstOrThrow()
    expect(ust).toMatchObject({ enabled: false })
    expect(ust.lastError).toMatch(/Sprawdź szyfrowanie, port, login i adres nadawcy/)
    // poprawka ustawień i ponowne włączenie: ten sam mail wychodzi (jeden)
    atrapa.opcje.odmowaNadawcy = null
    await skonfiguruj({}, new Date(Date.now() - 60_000))
    expect(await wyslij()).toMatchObject({ sent: 1 })
    expect(atrapa.maile).toHaveLength(1)
    expect((await wpisy())[0]).toMatchObject({ state: 'SENT', attempts: 1 })
  })
})

describe('4a. Odmowa przekazania i odmowa połączenia', () => {
  async function gotoweDoOdbioru() {
    const orderId = await zamowienieZKlientem({ deliveryMethod: 'Odbiór osobisty' })
    await a.order.update({ where: { id: orderId }, data: { status: 'DO_ODBIORU' } })
    await planujAkcje(a)
  }

  it('„Relay access denied” przy adresacie = ustawienia poczty: bez alertu o adresacie, mail wraca do kolejki, wysyłka wyłączona', async () => {
    await skonfiguruj()
    await gotoweDoOdbioru()
    atrapa.opcje.odmowaAdresata = `554 5.7.1 <${EMAIL}>: Relay access denied`
    expect(await wyslij()).toMatchObject({ sent: 0, failed: 1, disabled: true })
    expect((await wpisy())[0]).toMatchObject({ state: 'FAILED', attempts: 0 })
    expect(await a.alert.count({ where: { kind: ALERT_ODRZUCONY } })).toBe(0)
    const al = await a.alert.findFirstOrThrow({ where: { kind: ALERT_KONFIGURACJA } })
    expect(al.message).not.toContain(EMAIL)
    expect((await a.mailSettings.findFirstOrThrow()).lastError).toMatch(/Sprawdź szyfrowanie, port, login i adres nadawcy/)
  })

  it('554 na powitaniu = odmowa połączenia: komunikat o adresie IP serwera Kompletora, nie o loginie', async () => {
    await skonfiguruj()
    await gotoweDoOdbioru()
    atrapa.opcje.powitanie = '554 5.7.1 Adres IP odrzucony przez liste dozwolonych'
    expect(await wyslij()).toMatchObject({ sent: 0, disabled: true })
    const ust = await a.mailSettings.findFirstOrThrow()
    expect(ust.enabled).toBe(false)
    expect(ust.lastError).toMatch(/odrzucił połączenie z Kompletora/)
    expect(ust.lastError).toMatch(/listę dozwolonych adresów/)
    expect(ust.lastError).not.toMatch(/login i adres nadawcy/)
    const al = await a.alert.findFirstOrThrow({ where: { kind: ALERT_KONFIGURACJA } })
    expect(al.message).toMatch(/odrzucił połączenie z Kompletora/)
    expect((await wpisy())[0]).toMatchObject({ state: 'FAILED', attempts: 0 })
  })
})

describe('5. limity: reset hasła, limit godzinowy', () => {
  it('prośby bez utworzonego linku (instalacja bez poczty) nie blokują późniejszego resetu właściciela adresu', async () => {
    await createUserWithHash(sys, { email: 'osoba@example.com', name: 'Osoba Testowa', passwordHash: await hashPassword('stare-haslo-123456') })
    await grantMembership(sys, { email: 'osoba@example.com', organizationId: ORG_A, role: 'MAGAZYN' })
    const deps = { env: ENV, ipLimiter: new SlidingLimiter(100, 60_000), orgClient: (id: string) => (id === ORG_A ? a : b), log: () => {} }
    for (let i = 0; i < 5; i++) await poprosOReset(sys, { email: 'osoba@example.com', ip: `10.0.0.${i}` }, deps)
    expect(await sys.passwordReset.count()).toBe(0)
    // operator ustawia pocztę instalacji (RESET_SMTP_*); poczta firmy nie ma znaczenia (audyt bezpieczeństwa)
    const zPoczta = { ...deps, env: { ...ENV, ...envPocztyInstalacji(atrapa, { login: 'kompletor', haslo: 'tajne-haslo-smtp' }) } }
    await poprosOReset(sys, { email: 'osoba@example.com', ip: '10.0.0.9' }, zPoczta)
    expect(await sys.passwordReset.count()).toBe(1)
    // limit na konto liczony z bazy: najwyżej 3 linki na godzinę
    for (let i = 0; i < 5; i++) await poprosOReset(sys, { email: 'osoba@example.com', ip: '10.0.1.1' }, zPoczta)
    expect(await sys.passwordReset.count()).toBe(3)
  })

  it('dwa przebiegi naraz przy prawie wyczerpanym limicie godzinowym — najwyżej jeden mail ponad limit na przebieg', async () => {
    await skonfiguruj()
    const teraz = new Date()
    const wolne = 2
    await a.mailDelivery.createMany({ data: Array.from({ length: PER_HOUR - wolne }, (_, i) => ({ dedupeKey: `wczesniej:${i}`, kind: 'test', state: 'SENT', attempts: 1, lastAttemptAt: teraz })) })
    for (let i = 0; i < 6; i++) {
      const orderId = await zamowienieZKlientem({ deliveryMethod: 'Odbiór osobisty' })
      await a.order.update({ where: { id: orderId }, data: { status: 'DO_ODBIORU' } })
    }
    await planujAkcje(a)
    const [r1, r2] = await Promise.all([wyslij(), wyslij()])
    const wyslane = r1.sent + r2.sent
    expect(wyslane).toBeGreaterThanOrEqual(wolne)
    expect(wyslane).toBeLessThanOrEqual(wolne + 1)
    expect(atrapa.maile).toHaveLength(wyslane)
    // kolejny przebieg w tej samej godzinie nic nie wysyła
    expect(await wyslij()).toMatchObject({ sent: 0 })
  })
})

describe('6. odbicia po wysłaniu (raport DSN ze skrzynki nadawcy)', () => {
  const raport = (id: string, messageId = 'nieznany@example.com', adresat = EMAIL, diagnoza = `550 5.1.1 <${EMAIL}>: User unknown`) =>
    [
      'From: MAILER-DAEMON@mx.example.test',
      'Subject: Undelivered Mail Returned to Sender',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="B1"',
      '',
      '--B1',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.example.test',
      '',
      `Final-Recipient: rfc822; ${adresat}`,
      'Action: failed',
      'Status: 5.1.1',
      `Diagnostic-Code: smtp; ${diagnoza}`,
      '',
      '--B1',
      'Content-Type: text/rfc822-headers',
      '',
      `Message-ID: <${messageId}>`,
      `X-Kompletor-Id: ${id}`,
      '',
      '--B1--',
      '',
    ].join('\r\n')

  it('wysłany „Gotowe do odbioru” wraca: ODBITY, powód z maską, alert do biura; drugi raport = JUZ; obca firma nie widzi wpisu', async () => {
    await skonfiguruj()
    const orderId = await zamowienieZKlientem({ deliveryMethod: 'Odbiór osobisty' })
    await a.order.update({ where: { id: orderId }, data: { status: 'DO_ODBIORU' } })
    await planujAkcje(a)
    expect(await wyslij()).toMatchObject({ sent: 1 })
    const [d] = await wpisy()
    const o = rozpoznajOdbicie(raport(d!.dedupeKey))!
    expect(o.kompletorId).toBe(d!.dedupeKey)
    expect(await przyjmijOdbicie(b, o)).toBe('NIEZNANY') // RLS: firma B nie widzi wpisu firmy A
    expect(await przyjmijOdbicie(a, o)).toBe('ZAPISANO')
    const po = (await wpisy())[0]!
    expect(po.state).toBe('ODBITY')
    expect(po.lastError).toMatch(/^odbicie po wysłaniu \(5\.1\.1\): 550 5\.1\.1 <j\*\*\*@example\.test>: User unknown$/)
    const al = await a.alert.findFirstOrThrow({ where: { kind: ALERT_ODBICIE } })
    expect(al.message).toContain('Gotowe do odbioru')
    expect(al.message).toContain('j***@example.test')
    expect(JSON.stringify([await wpisy(), await a.alert.findMany()])).not.toContain(EMAIL)
    expect(await przyjmijOdbicie(a, o)).toBe('JUZ')
    expect(await a.alert.count({ where: { kind: ALERT_ODBICIE } })).toBe(1)
  })

  it('dopasowanie zapasowe po Message-ID; mail jeszcze niewysłany (czeka) nie zmienia stanu', async () => {
    await skonfiguruj()
    const sent = await a.mailDelivery.create({ data: { dedupeKey: 'test:1', kind: 'test', state: 'SENT', attempts: 1, lastAttemptAt: new Date(), messageId: '<mid-1@example.com>', recipient: 'j***@example.test' } })
    await a.mailDelivery.create({ data: { dedupeKey: 'plan:czeka', kind: 'faktura', state: 'CZEKA' } })
    expect(await przyjmijOdbicie(a, rozpoznajOdbicie(raport('obcy:klucz', 'mid-1@example.com'))!)).toBe('ZAPISANO')
    expect((await a.mailDelivery.findUniqueOrThrow({ where: { id: sent.id } })).state).toBe('ODBITY')
    expect(await przyjmijOdbicie(a, rozpoznajOdbicie(raport('plan:czeka'))!)).toBe('POMINIETY')
    expect(await przyjmijOdbicie(a, { kompletorId: null, messageIds: [], adresat: null, status: null, diagnoza: null })).toBe('NIEZNANY')
  })

  it('raport z innym adresatem niż ten, do którego mail wyszedł = POMINIETY; adres strony wycięty z powodu', async () => {
    await skonfiguruj()
    const d = await a.mailDelivery.create({ data: { dedupeKey: 'test:2', kind: 'test', state: 'SENT', attempts: 1, lastAttemptAt: new Date(), recipient: 'j***@example.test' } })
    expect(await przyjmijOdbicie(a, rozpoznajOdbicie(raport('test:2', 'x@example.com', 'ktos.inny@example.org'))!)).toBe('POMINIETY')
    expect((await a.mailDelivery.findUniqueOrThrow({ where: { id: d.id } })).state).toBe('SENT')
    expect(await a.alert.count({ where: { kind: ALERT_ODBICIE } })).toBe(0)
    // ten sam adresat (inna wielkość liter, nawiasy ostre): zapis, bez adresu strony w powodzie
    const o = rozpoznajOdbicie(raport('test:2', 'x@example.com', '<Jan.Kowalski@example.test>', '550 5.7.1 Zablokowane, zobacz https://phish.example.org/klik?x=1 po szczegoly'))!
    expect(await przyjmijOdbicie(a, o)).toBe('ZAPISANO')
    const po = await a.mailDelivery.findUniqueOrThrow({ where: { id: d.id } })
    expect(po.state).toBe('ODBITY')
    expect(po.lastError).not.toMatch(/https?:/)
    expect(po.lastError).toContain('[adres strony]')
    expect((await a.alert.findFirstOrThrow({ where: { kind: ALERT_ODBICIE } })).message).not.toMatch(/phish/)
  })
})
