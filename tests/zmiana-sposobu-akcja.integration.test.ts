// Akcja „Zmień sposób wysyłki” z karty zamówienia (przegląd E1): drugie uprawnienie (`pakowanie.stanowisko`) i zamówienie
// innej firmy. Sesja z atrapy kontekstu panelu (bez przeglądarki), dane fikcyjne, zero połączeń z przewoźnikami.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createUserWithHash, grantMembership } from '@/lib/auth/sesje'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

const sesja: { db: PrismaClient | null; uprawnienia: Set<string>; userId: string } = { db: null, uprawnienia: new Set(), userId: '' }

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }), headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/panel/kontekst', () => ({
  requireSession: async () => ({ db: sesja.db, permissions: sesja.uprawnienia, user: { id: sesja.userId } }),
  requirePermission: async (p: string) => {
    if (!sesja.uprawnienia.has(p)) throw new Error(`brak uprawnienia ${p}`)
    return { db: sesja.db, permissions: sesja.uprawnienia, user: { id: sesja.userId } }
  },
}))

const { dodajPrzesylkeAkcja, rozstrzygnijPrzesylkeAkcja, stanDodatkowejAkcja, zmienSposobAkcja } = await import('@/app/(panel)/zamowienia/[id]/akcje-przesylka')

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const ENV = { EKRANY_PRACA: '1', CUSTOMER_DATA_KEYS: `1:${'4'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'd'.repeat(64) }

function formularz(): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries({ sposob: 'DPD:DPD_BEZPOSREDNIO', imie: 'Ewa Fikcyjna', ulica: 'ul. Atrapowa', dom: '7', kod: '60-003', miasto: 'Poznań', telefon: '+48 511 222 444', punkt: '' })) f.set(k, v)
  return f
}

async function zamowienie(): Promise<string> {
  await db.carrierRule.updateMany({ where: { carrier: 'DPD' }, data: { shippingModule: 'DPD_BEZPOSREDNIO', adapterKey: 'dpd.services.zapis.v1' } })
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
  const pid = await product(db, `HERB-AK-${Math.random().toString(36).slice(2, 8)}`, 50)
  const id = (await ingestOrder(db, order([{ productId: pid, qty: 1, unitPriceGross: 30 }], { deliveryMethod: 'Paczkomaty InPost', paymentState: 'PAID', paymentMethod: 'Przelew' }), { now: T0 })).orderId!
  await zapiszRekordKlienta(
    db,
    id,
    rekordZOdbiorcy({
      dostawa: { imieNazwisko: 'Ewa Fikcyjna', firma: null, ulica: null, numerDomu: null, numerLokalu: null, kodPocztowy: null, miasto: null, kraj: 'PL', telefon: '+48 511 222 444', email: 'ewa@example.test' },
      punktOdbioru: { kod: 'TST01M', nazwa: null },
      faktura: null,
      problemy: [],
    }),
    { source: 'KANAL', fetchedAt: T0, env: ENV },
  )
  return id
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v)
  const u = await createUserWithHash(sys, { email: 'biuro@example.test', name: 'biuro', passwordHash: 'x' })
  await grantMembership(sys, { email: 'biuro@example.test', organizationId: ORG_A, role: 'WLASCICIEL' })
  sesja.userId = u.id
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('zmienSposobAkcja', () => {
  it('bez uprawnienia „Stanowisko pakowania”: odmowa z wyjaśnieniem, zamówienie bez zmian', async () => {
    const id = await zamowienie()
    sesja.db = db
    sesja.uprawnienia = new Set(['klienci.dane'])
    const w = await zmienSposobAkcja(id, formularz())
    expect(w.blad).toMatch(/uprawnieniem do pakowania/)
    expect((await db.order.findUniqueOrThrow({ where: { id } })).carrier).toBe('PACZKOMATY')
  })

  it('z oboma uprawnieniami: zmiana zapisana', async () => {
    const id = await zamowienie()
    sesja.db = db
    sesja.uprawnienia = new Set(['klienci.dane', 'pakowanie.stanowisko'])
    const w = await zmienSposobAkcja(id, formularz())
    expect(w.blad).toBeNull()
    expect((await db.order.findUniqueOrThrow({ where: { id } })).carrier).toBe('DPD')
  })

  it('zamówienie innej firmy (sesja firmy B): odmowa, zamówienie firmy A bez zmian', async () => {
    const id = await zamowienie()
    sesja.db = dbB
    sesja.uprawnienia = new Set(['klienci.dane', 'pakowanie.stanowisko'])
    const w = await zmienSposobAkcja(id, formularz())
    expect(w.blad).toEqual(expect.any(String))
    expect((await db.order.findUniqueOrThrow({ where: { id } })).carrier).toBe('PACZKOMATY')
  })
})

describe('„Dodaj przesyłkę” (dodatkowa przesyłka)', () => {
  const pola = { numer: 1, regulaId: 'cmregulatestowa0000000000', rodzaj: 'DOSYLKA', powod: 'reklamacja testowa', gabaryt: 'INPOST_A', koszt: '', potwierdzam: true, potwierdzone: [] as string[] }

  it('rola bez „Stanowisko pakowania” (np. biuro): ani okna, ani dodania, zero przesyłek', async () => {
    const id = await zamowienie()
    sesja.db = db
    sesja.uprawnienia = new Set(['klienci.dane', 'zamowienia.edycja'])
    await expect(stanDodatkowejAkcja(id)).rejects.toThrow(/brak uprawnienia pakowanie.stanowisko/)
    await expect(dodajPrzesylkeAkcja(id, pola)).rejects.toThrow(/brak uprawnienia pakowanie.stanowisko/)
    expect(await db.shipment.count()).toBe(0)
  })

  it('zamówienie innej firmy (sesja firmy B): okno puste, dodanie odrzucone, zero przesyłek', async () => {
    const id = await zamowienie()
    sesja.db = dbB
    sesja.uprawnienia = new Set(['pakowanie.stanowisko'])
    expect(await stanDodatkowejAkcja(id)).toBeNull()
    expect(await dodajPrzesylkeAkcja(id, pola)).toMatchObject({ blad: expect.any(String) })
    expect(await db.shipment.count()).toBe(0)
  })

  it('zamówienie bez głównej przesyłki: okno z powodem, przycisk „Utwórz” zablokowany', async () => {
    const id = await zamowienie()
    sesja.db = db
    sesja.uprawnienia = new Set(['pakowanie.stanowisko'])
    expect((await stanDodatkowejAkcja(id))!.powod).toEqual(expect.any(String))
  })

  it('„Rozstrzygnij ręcznie” w oknie: widoczne tylko z uprawnieniem rozstrzygania; akcja bez niego odrzucona, przesyłka bez zmian', async () => {
    const id = await zamowienie()
    const s = await db.shipment.create({ data: { orderId: id, packageNo: 1, extraNo: 1, extraKind: 'DOSYLKA', extraReason: 'reklamacja testowa', reference: `ref-niejasna-${id}`, adapterKey: 'dpd.services.zapis.v1', carrier: 'DPD', state: 'NIEJEDNOZNACZNA' } })
    sesja.db = db
    sesja.uprawnienia = new Set(['pakowanie.stanowisko'])
    expect((await stanDodatkowejAkcja(id))!.mozeRozstrzygnac).toBe(false)
    await expect(rozstrzygnijPrzesylkeAkcja(id, s.id, 'NIE_POWSTALA', null)).rejects.toThrow(/brak uprawnienia przesylki.rozstrzyganie/)
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('NIEJEDNOZNACZNA')
    sesja.uprawnienia = new Set(['pakowanie.stanowisko', 'przesylki.rozstrzyganie'])
    expect((await stanDodatkowejAkcja(id))!.mozeRozstrzygnac).toBe(true)
  })
})
