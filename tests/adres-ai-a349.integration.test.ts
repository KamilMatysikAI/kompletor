// (część 2): propozycja podziału niejednoznacznej linii adresu od asystenta AI firmy i „Zatwierdź” na bazie.
// Klient firmy (RLS), dane wyłącznie fikcyjne, model na atrapie (zero połączeń z dostawcą AI).
//  1. propozycja → zapis raz na linię (drugie pytanie bez modelu) → „Zatwierdź” → odbiorca przesyłki ma numer domu,
//     wpis w historii zamówienia bez treści adresu, zużycie AI zapisane;
//  2. zmiana linii adresu po propozycji unieważnia starą propozycję (odmowa „Zatwierdź”, nowe pytanie do modelu);
//  3. bez asystenta AI firmy: powód z drogą do Ustawień, model nie jest pytany;
//  4. niska pewność: propozycja widoczna, „Zatwierdź” odmawia; bezpiecznik odrzuca dopisany znak;
//  5. spójność: zmiana rekordu klienta między odczytem a zapisem = odmowa, bez zapisu adresu i bez wpisu w historii;
//  6. punkt odbioru i adres już rozdzielony = nie dotyczy;
//  7. lokal już wpisany w osobnym polu: inny niż w linii = odmowa bez zapisu i bez historii; ten sam
//     albo brak lokalu w linii = zapis, a odpowiedź pokazuje wartości faktycznie zapisane.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberRole } from '@prisma/client'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { BRAK_AI_ADRES, potrzebnyPodzialRekordu, powodBrakuAsystentaAdresu, propozycjaPodzialu, zatwierdzPodzial } from '@/lib/klienci/adres-ai'
import { daneKlienta } from '@/lib/klienci/odczyt'
import { poprawDostawe } from '@/lib/klienci/poprawka'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { odbiorcaPrzesylki } from '@/lib/klienci/wejscia'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const a = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await a.$disconnect()
})

const KLUCZE = `1:${'4'.repeat(64)}`
const KLUCZ_AI = `sk-ant-${'t'.repeat(40)}`
const ENV = { APP_MODE: 'self-host', AI_API_KEY: KLUCZ_AI, CUSTOMER_DATA_KEYS: KLUCZE, CUSTOMER_LOOKUP_KEY: 'd'.repeat(64) }
const ENV_BEZ_AI = { ...ENV, AI_API_KEY: '' }

beforeEach(async () => {
  vi.stubEnv('CUSTOMER_DATA_KEYS', KLUCZE)
  await truncateAll()
  await seedBase(a)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

async function osoba(email: string, role: MemberRole = 'WLASCICIEL'): Promise<string> {
  const u = await createUserWithHash(sys, { email, name: email, passwordHash: 'x' })
  await grantMembership(sys, { email, organizationId: ORG_A, role })
  return u.id
}

let seq = 0
async function zamowienie(ulica: string, o: { numerDomu?: string | null; numerLokalu?: string | null; punkt?: string | null } = {}): Promise<string> {
  const pid = await product(a, `ADR-${++seq}-${Math.random().toString(36).slice(2, 6)}`, 50)
  const r = await ingestOrder(a, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: o.punkt ? 'Paczkomaty InPost' : 'Kurier DPD', channel: 'WOO_SD', paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })
  const odbiorca: OrderRecipient = {
    dostawa: { imieNazwisko: 'Anna Fikcyjna', firma: null, ulica, numerDomu: o.numerDomu ?? null, numerLokalu: o.numerLokalu ?? null, kodPocztowy: '60-002', miasto: 'Poznań', kraj: 'PL', telefon: '+48 511 222 333', email: 'anna@example.test' },
    punktOdbioru: o.punkt ? { kod: o.punkt, nazwa: null } : null,
    faktura: null,
    problemy: ['adres_bez_podzialu'],
  }
  await zapiszRekordKlienta(a, r.orderId!, rekordZOdbiorcy(odbiorca), { source: 'KANAL', fetchedAt: T0, env: ENV })
  return r.orderId!
}

/** Atrapa klienta modelu: kolejne odpowiedzi JSON; licznik wywołań i treść zapytań. */
function atrapa(...odpowiedzi: Record<string, unknown>[]) {
  const zapytania: string[] = []
  const client = {
    messages: {
      create: async (req: { messages: { content: string }[] }) => {
        zapytania.push(req.messages.map((m) => m.content).join('\n'))
        const o = odpowiedzi[Math.min(zapytania.length - 1, odpowiedzi.length - 1)]
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(o) }], usage: { input_tokens: 120, output_tokens: 30 } }
      },
    },
  }
  return { client: client as never, zapytania }
}

const DOBRA = { ulica: 'Testowa', numer_domu: '7-9', numer_lokalu: '3', pewnosc: 'wysoka' }

describe('podział adresu przez asystenta AI (tryb „propozycja + Zatwierdź”)', () => {
  it('propozycja → raz na linię → „Zatwierdź”: odbiorca przesyłki ma numer domu, historia bez adresu, zużycie zapisane', async () => {
    const uid = await osoba('biuro-a349@example.invalid')
    const oid = await zamowienie('Testowa 7-9 m 3')
    const m = atrapa(DOBRA)

    const p1 = await propozycjaPodzialu(a, oid, { actorId: uid, env: ENV, client: m.client })
    expect(p1).toEqual({ stan: 'PROPOZYCJA', linia: 'Testowa 7-9 m 3', propozycja: { ulica: 'Testowa', numerDomu: '7-9', numerLokalu: '3', pewnosc: 'wysoka' }, zZapisu: false })
    // do modelu idzie wyłącznie linia ulicy z numerem: bez nazwiska, telefonu, e-maila, kodu i miasta
    expect(m.zapytania).toHaveLength(1)
    expect(m.zapytania[0]).toContain('Testowa 7-9 m 3')
    expect(m.zapytania[0]).not.toMatch(/Anna|Fikcyjna|511|example\.test|60-002|Poznań/)

    const p2 = await propozycjaPodzialu(a, oid, { actorId: uid, env: ENV, client: m.client })
    expect(p2).toMatchObject({ stan: 'PROPOZYCJA', zZapisu: true })
    expect(m.zapytania).toHaveLength(1)
    const flags = (await a.order.findUniqueOrThrow({ where: { id: oid }, select: { flags: true } })).flags as Record<string, unknown>
    expect(JSON.stringify(flags['adresAi'])).not.toMatch(/Testowa/)

    const w = await zatwierdzPodzial(a, oid, { actorId: uid, env: ENV })
    expect(w).toMatchObject({ wynik: 'ZAPISANO' })
    const odb = await odbiorcaPrzesylki(a, oid, { modul: 'wysylka', env: ENV })
    expect(odb.recipient).toMatchObject({ ulica: 'Testowa', numerDomu: '7-9', numerLokalu: '3', kodPocztowy: '60-002', miasto: 'Poznań' })
    expect(odb.przejscie.ok).toBe(true)

    const ev = await a.orderEvent.findMany({ where: { orderId: oid, kind: 'ADRES_PODZIELONY_PRZEZ_ASYSTENTA' } })
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actorId: `user:${uid}`, data: { tryb: 'zatwierdzone', pewnosc: 'wysoka' } })
    expect(JSON.stringify(ev[0]!.data)).not.toMatch(/Testowa|7-9/)
    expect(await a.aiUsage.count({ where: { feature: 'adres-podzial' } })).toBe(1)

    // po zapisie podział nie jest już potrzebny: drugie „Zatwierdź” odmawia bez zapisu
    expect(await propozycjaPodzialu(a, oid, { actorId: uid, env: ENV, client: m.client })).toEqual({ stan: 'NIE_DOTYCZY' })
    expect(await zatwierdzPodzial(a, oid, { actorId: uid, env: ENV })).toMatchObject({ wynik: 'ODMOWA' })
    expect(await a.orderEvent.count({ where: { orderId: oid, kind: 'ADRES_PODZIELONY_PRZEZ_ASYSTENTA' } })).toBe(1)
  })

  it('zmiana linii adresu po propozycji unieważnia starą propozycję: „Zatwierdź” odmawia, kolejne pytanie idzie do modelu', async () => {
    const uid = await osoba('biuro2-a349@example.invalid')
    const oid = await zamowienie('Testowa 7-9 m 3')
    const m = atrapa(DOBRA, { ulica: 'Inna', numer_domu: '11-13', numer_lokalu: null, pewnosc: 'wysoka' })
    expect(await propozycjaPodzialu(a, oid, { actorId: uid, env: ENV, client: m.client })).toMatchObject({ stan: 'PROPOZYCJA' })
    const z = await poprawDostawe(a, oid, { imieNazwisko: 'Anna Fikcyjna', firma: null, ulica: 'Inna 11-13', numerDomu: null, numerLokalu: null, kodPocztowy: '60-002', miasto: 'Poznań', telefon: '+48 511 222 333', punkt: null }, { actorId: uid, env: ENV })
    expect(z).toMatchObject({ wynik: 'ZAPISANO' })
    expect(await zatwierdzPodzial(a, oid, { actorId: uid, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: expect.stringMatching(/zmienił się/) })
    const odb = await odbiorcaPrzesylki(a, oid, { modul: 'wysylka', env: ENV })
    expect(odb.recipient).toMatchObject({ ulica: 'Inna 11-13', numerDomu: null })
    const p = await propozycjaPodzialu(a, oid, { actorId: uid, env: ENV, client: m.client })
    expect(p).toMatchObject({ stan: 'PROPOZYCJA', zZapisu: false, propozycja: { ulica: 'Inna', numerDomu: '11-13' } })
    expect(m.zapytania).toHaveLength(2)
  })

  it('bez asystenta AI firmy: powód z drogą do Ustawień, model nie jest pytany, nic nie zapisane', async () => {
    const uid = await osoba('biuro3-a349@example.invalid')
    const oid = await zamowienie('Testowa 7-9 m 3')
    expect(await powodBrakuAsystentaAdresu(a, ENV_BEZ_AI)).toBe(BRAK_AI_ADRES)
    expect(await powodBrakuAsystentaAdresu(a, ENV)).toBeNull()
    // hosting bez klucza firmy i bez klucza platformy: też powód (env AI_API_KEY w hostingu nie działa)
    expect(await powodBrakuAsystentaAdresu(a, { ...ENV, APP_MODE: 'hosted' })).toBe(BRAK_AI_ADRES)
    const m = atrapa(DOBRA)
    expect(await propozycjaPodzialu(a, oid, { actorId: uid, env: ENV_BEZ_AI, client: m.client })).toEqual({ stan: 'NIEDOSTEPNE', powod: BRAK_AI_ADRES })
    expect(m.zapytania).toHaveLength(0)
    const flags = (await a.order.findUniqueOrThrow({ where: { id: oid }, select: { flags: true } })).flags as Record<string, unknown>
    expect(flags['adresAi']).toBeUndefined()
  })

  it('wyczerpany limit AI z konta platformy: powód z limitem przed kliknięciem', async () => {
    const env = { ...ENV, APP_MODE: 'hosted', AI_API_KEY: '', PLATFORM_AI_API_KEY: KLUCZ_AI, PLATFORM_AI_LIMIT_DZIENNY_GROSZE: '0' }
    expect(await powodBrakuAsystentaAdresu(a, env)).toMatch(/wyłączone|limit/)
  })

  it('niska pewność: propozycja widoczna, „Zatwierdź” odmawia; dopisany znak = propozycja odrzucona przez bezpiecznik', async () => {
    const uid = await osoba('biuro4-a349@example.invalid')
    const oid = await zamowienie('Testowa 7-9 m 3')
    const niska = atrapa({ ...DOBRA, pewnosc: 'niska' })
    expect(await propozycjaPodzialu(a, oid, { actorId: uid, env: ENV, client: niska.client })).toMatchObject({ stan: 'PROPOZYCJA', propozycja: { pewnosc: 'niska' } })
    expect(await zatwierdzPodzial(a, oid, { actorId: uid, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: expect.stringMatching(/nie jest pewny/) })
    expect(await a.orderEvent.count({ where: { orderId: oid, kind: 'ADRES_PODZIELONY_PRZEZ_ASYSTENTA' } })).toBe(0)

    const oid2 = await zamowienie('Testowa 7-9 m 3')
    const zly = atrapa({ ...DOBRA, ulica: 'ul. Testowa' })
    expect(await propozycjaPodzialu(a, oid2, { actorId: uid, env: ENV, client: zly.client })).toMatchObject({ stan: 'ODRZUCONA' })
    expect(await zatwierdzPodzial(a, oid2, { actorId: uid, env: ENV })).toMatchObject({ wynik: 'ODMOWA' })
  })

  it('spójność: rekord klienta zmienia się między odczytem a zapisem = odmowa, adres bez zmian i bez wpisu w historii', async () => {
    const uid = await osoba('biuro5-a349@example.invalid')
    const oid = await zamowienie('Testowa 7-9 m 3')
    const m = atrapa(DOBRA)
    await propozycjaPodzialu(a, oid, { actorId: uid, env: ENV, client: m.client })
    const w = await zatwierdzPodzial(a, oid, {
      actorId: uid,
      env: ENV,
      // równoległa poprawka telefonu (ta sama linia adresu) po odczycie, przed zapisem
      poOdczycie: async () => {
        await poprawDostawe(a, oid, { imieNazwisko: 'Anna Fikcyjna', firma: null, ulica: 'Testowa 7-9 m 3', numerDomu: null, numerLokalu: null, kodPocztowy: '60-002', miasto: 'Poznań', telefon: '+48 511 999 888', punkt: null }, { actorId: uid, env: ENV })
      },
    })
    expect(w).toEqual({ wynik: 'ODMOWA', powod: expect.stringMatching(/zmieniły się/) })
    const d = await daneKlienta(a, oid, { actorId: uid, zakres: 'PELNY', cel: 'PODGLAD', env: ENV })
    expect(d.stan === 'PELNY' && d.rekord.dostawa).toMatchObject({ ulica: 'Testowa 7-9 m 3', numerDomu: null })
    expect(d.stan === 'PELNY' && d.rekord.telefon).toBe('+48 511 999 888')
    expect(await a.orderEvent.count({ where: { orderId: oid, kind: 'ADRES_PODZIELONY_PRZEZ_ASYSTENTA' } })).toBe(0)
  })

  it('punkt odbioru i adres rozdzielony jednoznacznie: nie dotyczy, bez pytania modelu', async () => {
    const uid = await osoba('biuro6-a349@example.invalid')
    const m = atrapa(DOBRA)
    const punkt = await zamowienie('Testowa 7-9 m 3', { punkt: 'POZ01X' })
    expect(await propozycjaPodzialu(a, punkt, { actorId: uid, env: ENV, client: m.client })).toEqual({ stan: 'NIE_DOTYCZY' })
    const prosty = await zamowienie('Testowa 7')
    expect(await propozycjaPodzialu(a, prosty, { actorId: uid, env: ENV, client: m.client })).toEqual({ stan: 'NIE_DOTYCZY' })
    expect(m.zapytania).toHaveLength(0)
    const d = await daneKlienta(a, punkt, { actorId: uid, zakres: 'PELNY', cel: 'PODGLAD', env: ENV })
    expect(d.stan === 'PELNY' && potrzebnyPodzialRekordu(d.rekord)).toBe(false)
    const d2 = await daneKlienta(a, await zamowienie('Testowa 7-9 m 3'), { actorId: uid, zakres: 'PELNY', cel: 'PODGLAD', env: ENV })
    expect(d2.stan === 'PELNY' && potrzebnyPodzialRekordu(d2.rekord)).toBe(true)
  })

  it('lokal już wpisany w osobnym polu: inny niż w linii = odmowa bez zapisu; zgodny albo brak lokalu w linii = zapis wartości faktycznych', async () => {
    const uid = await osoba('biuro7-a349@example.invalid')
    // linia „Testowa 7-9 m 3”, a w polu lokalu „7”: zapis zgubiłby „3” z linii
    const inny = await zamowienie('Testowa 7-9 m 3', { numerLokalu: '7' })
    await propozycjaPodzialu(a, inny, { actorId: uid, env: ENV, client: atrapa(DOBRA).client })
    expect(await zatwierdzPodzial(a, inny, { actorId: uid, env: ENV })).toEqual({ wynik: 'ODMOWA', powod: 'W zamówieniu jest już numer lokalu inny niż w linii adresu: popraw adres ręcznie.' })
    const d = await daneKlienta(a, inny, { actorId: uid, zakres: 'PELNY', cel: 'PODGLAD', env: ENV })
    expect(d.stan === 'PELNY' && d.rekord.dostawa).toMatchObject({ ulica: 'Testowa 7-9 m 3', numerDomu: null, numerLokalu: '7' })
    expect(await a.orderEvent.count({ where: { orderId: inny, kind: 'ADRES_PODZIELONY_PRZEZ_ASYSTENTA' } })).toBe(0)

    // ten sam lokal (po trim) w polu i w linii: zapis
    const zgodny = await zamowienie('Testowa 7-9 m 3', { numerLokalu: ' 3 ' })
    await propozycjaPodzialu(a, zgodny, { actorId: uid, env: ENV, client: atrapa(DOBRA).client })
    expect(await zatwierdzPodzial(a, zgodny, { actorId: uid, env: ENV })).toMatchObject({ wynik: 'ZAPISANO', propozycja: { ulica: 'Testowa', numerDomu: '7-9', numerLokalu: '3' } })

    // linia bez lokalu, lokal tylko w polu: zostaje, a odpowiedź „Zapisano” pokazuje lokal faktycznie zapisany
    const bezLokaluWLinii = await zamowienie('Testowa 7-9', { numerLokalu: '12' })
    await propozycjaPodzialu(a, bezLokaluWLinii, { actorId: uid, env: ENV, client: atrapa({ ulica: 'Testowa', numer_domu: '7-9', numer_lokalu: null, pewnosc: 'wysoka' }).client })
    expect(await zatwierdzPodzial(a, bezLokaluWLinii, { actorId: uid, env: ENV })).toMatchObject({ wynik: 'ZAPISANO', propozycja: { ulica: 'Testowa', numerDomu: '7-9', numerLokalu: '12' } })
    const odb = await odbiorcaPrzesylki(a, bezLokaluWLinii, { modul: 'wysylka', env: ENV })
    expect(odb.recipient).toMatchObject({ ulica: 'Testowa', numerDomu: '7-9', numerLokalu: '12' })
  })
})
