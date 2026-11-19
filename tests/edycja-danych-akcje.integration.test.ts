// Akcje karty: „Popraw adres albo punkt”, wyszukiwarka punktów i nowe formularze danych kupującego i danych do faktury.
// Tryb „Tylko podgląd” odrzuca zapis także przy ręcznym wywołaniu akcji; uprawnienie „Dane klienta” wymagane. Sesja
// z atrapy kontekstu panelu (bez przeglądarki), dane fikcyjne, zero połączeń z zewnętrznymi usługami.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { daneKlienta } from '@/lib/klienci/odczyt'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const sesja: { db: PrismaClient | null; uprawnienia: Set<string>; userId: string } = { db: null, uprawnienia: new Set(), userId: '' }

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }), headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`PRZEKIEROWANIE ${url}`)
  },
}))
vi.mock('@/lib/panel/kontekst', () => ({
  requireSession: async () => ({ db: sesja.db, permissions: sesja.uprawnienia, user: { id: sesja.userId }, organization: { organizationId: 'org-a' } }),
  requirePermission: async (p: string) => {
    if (!sesja.uprawnienia.has(p)) throw new Error(`brak uprawnienia ${p}`)
    return { db: sesja.db, permissions: sesja.uprawnienia, user: { id: sesja.userId }, organization: { organizationId: 'org-a' } }
  },
}))

const { poprawAdresAkcja, szukajPunktowAkcja } = await import('@/app/(panel)/zamowienia/[id]/akcje-przesylka')
const { zapiszKupujacegoAkcja, zapiszFaktureAkcja } = await import('@/app/(panel)/zamowienia/[id]/akcje-klient')

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
})

const ENV = { EKRANY_PRACA: '1', CUSTOMER_DATA_KEYS: `1:${'4'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'd'.repeat(64) }

const form = (o: Record<string, string>): FormData => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}

async function zamowienie(tryb: 'PRACA' | 'CIEN'): Promise<string> {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: tryb } })
  const pid = await product(db, `HERB-EA-${Math.random().toString(36).slice(2, 8)}`, 50)
  const id = (await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: 'Kurier DPD', paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })).orderId!
  await zapiszRekordKlienta(
    db,
    id,
    rekordZOdbiorcy({
      dostawa: { imieNazwisko: 'Ewa Fikcyjna', firma: null, ulica: 'ul. Atrapowa', numerDomu: '7', numerLokalu: null, kodPocztowy: '60-003', miasto: 'Poznań', kraj: 'PL', telefon: '+48 511 222 444', email: 'ewa@example.test' },
      punktOdbioru: null,
      faktura: null,
      problemy: [],
    }),
    { source: 'KANAL', fetchedAt: T0, env: ENV },
  )
  return id
}

const ADRES = { imie: 'Ewa Fikcyjna', ulica: 'ul. Nowa', dom: '3', kod: '60-005', miasto: 'Poznań', telefon: '+48 511 222 444' }

async function rekord(id: string) {
  const d = await daneKlienta(db, id, { actorId: sesja.userId, zakres: 'PELNY', cel: 'PODGLAD', env: ENV })
  if (d.stan !== 'PELNY') throw new Error(d.stan)
  return d
}

/** Akcja formularza kończy się przekierowaniem na kartę: adres z komunikatem. */
async function przekierowanie(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    const m = /^PRZEKIEROWANIE (.*)$/.exec((e as Error).message)
    if (m) return m[1]!
    throw e
  }
  throw new Error('bez przekierowania')
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v)
  const u = await createUserWithHash(sys, { email: 'biuro@example.test', name: 'biuro', passwordHash: 'x' })
  await grantMembership(sys, { email: 'biuro@example.test', organizationId: ORG_A, role: 'WLASCICIEL' })
  sesja.userId = u.id
  sesja.db = db
  sesja.uprawnienia = new Set(['klienci.dane'])
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('„Popraw adres albo punkt” w trybie „Tylko podgląd”', () => {
  it('podgląd: zapis odrzucony z powodem trybu, adres bez zmian', async () => {
    const id = await zamowienie('CIEN')
    const w = await poprawAdresAkcja(id, form(ADRES))
    expect(w.blad).toMatch(/trybie PRACA/)
    expect((await rekord(id)).rekord.dostawa?.ulica).toBe('ul. Atrapowa')
  })
  it('praca: zapis jak dotąd', async () => {
    const id = await zamowienie('PRACA')
    const w = await poprawAdresAkcja(id, form(ADRES))
    expect(w.blad).toBeNull()
    expect((await rekord(id)).rekord.dostawa?.ulica).toBe('ul. Nowa')
  })
  it('podgląd: wyszukiwarka punktów odmawia bez pytania InPostu', async () => {
    const id = await zamowienie('CIEN')
    const w = await szukajPunktowAkcja(id, 'POZ08M')
    expect(w.punkty).toEqual([])
    expect(w.blad).toMatch(/trybie PRACA/)
  })
})

describe('formularze „Kupujący” i „Dane do faktury”', () => {
  it('kupujący: zapis i komunikat na karcie', async () => {
    const id = await zamowienie('PRACA')
    const url = await przekierowanie(zapiszKupujacegoAkcja(form({ zamowienie: id, wersja: String((await rekord(id)).rewizja), imie: 'Adam Kupujący', telefon: '+48 600 100 200', email: 'adam@example.test' })))
    // komunikat i kotwica osobno (zrzut E2: kotwica bez „#” sklejała się z kluczem komunikatu i toast znikał)
    expect(url).toMatch(/[?&]ok=klient\.kupujacy#wysylka$/)
    expect((await rekord(id)).rekord.email).toBe('adam@example.test')
  })
  it('kupujący w podglądzie: odmowa, dane bez zmian', async () => {
    const id = await zamowienie('CIEN')
    const url = await przekierowanie(zapiszKupujacegoAkcja(form({ zamowienie: id, wersja: String((await rekord(id)).rewizja), imie: 'Adam Kupujący', email: 'adam@example.test' })))
    expect(url).toContain('blad=tryb-podgladu')
    expect((await rekord(id)).rekord.email).toBe('ewa@example.test')
  })
  it('faktura: zły NIP odrzucony z nazwą pola, faktura na firmę zapisana', async () => {
    const id = await zamowienie('PRACA')
    const baza = { zamowienie: id, wersja: String((await rekord(id)).rewizja), f_rodzaj: 'firma', f_nazwa: 'Atrapa sp. z o.o.', f_ulica: 'ul. Fikcyjna 1', f_kod: '60-001', f_miasto: 'Poznań' }
    const zly = await przekierowanie(zapiszFaktureAkcja(form({ ...baza, f_nip: '1234563219' })))
    expect(zly).toMatch(/[?&]blad=szczegoly&k=[a-f0-9]{12}#dane-faktury$/)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).wantInvoiceNip).toBe(false)
    const ok = await przekierowanie(zapiszFaktureAkcja(form({ ...baza, f_nip: '123-456-32-18' })))
    expect(ok).toMatch(/[?&]ok=klient\.faktura#dane-faktury$/)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).wantInvoiceNip).toBe(true)
    expect((await rekord(id)).rekord.faktura?.nip).toBe('1234563218')
  })
  it('faktura KSeF odrzucona bez śladu wysyłki: zapis z komunikatem „kliknij Ponów”', async () => {
    const id = await zamowienie('PRACA')
    await db.ksefInvoiceDraft.create({ data: { id: `ksef-${id}`, orderId: id, packageNo: 1, status: 'ODRZUCONA', numer: 'FV/9/11/2026', wersjaSchemy: 'FA(3)', bruttoGr: 3000, nettoGr: 2439 } })
    const url = await przekierowanie(zapiszFaktureAkcja(form({ zamowienie: id, wersja: String((await rekord(id)).rewizja), f_rodzaj: 'imienna', f_nazwa: 'Ewa Fikcyjna', f_ulica: 'ul. Fikcyjna 1', f_kod: '60-001', f_miasto: 'Poznań' })))
    expect(url).toMatch(/[?&]ok=klient\.faktura-ponow#dane-faktury$/)
  })
  it('bez uprawnienia „Dane klienta”: akcja odmawia', async () => {
    const id = await zamowienie('PRACA')
    sesja.uprawnienia = new Set(['zamowienia.edycja_pozycji'])
    await expect(zapiszKupujacegoAkcja(form({ zamowienie: id, wersja: '1', imie: 'Adam' }))).rejects.toThrow(/brak uprawnienia klienci.dane/)
    await expect(zapiszFaktureAkcja(form({ zamowienie: id, wersja: '1' }))).rejects.toThrow(/brak uprawnienia klienci.dane/)
  })
})
