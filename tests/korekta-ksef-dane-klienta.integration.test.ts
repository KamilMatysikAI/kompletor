// Audyt bezpieczeństwa 13.11.2026, ustalenie LOW: szkic korekty FA(3) zwrotu niesie NIP, nazwę i adres
// nabywcy, a trasa GET /api/zwroty/<id>/korekta-ksef sprawdzała tylko `zwroty.korekty` i czytała dane klienta jako
// automat `system:ksef` (pełny zakres, ślad bez osoby). Teraz: bez `klienci.dane` 403 i zero odczytu danych klienta,
// z uprawnieniem odczyt jako osoba z sesji (wpis KLIENT_PODGLAD z jej User.id). Ścieżka workera zostaje systemowa.
// Dane fikcyjne (produkty TEST-*, NIP testowy), bez sieci (szkic bez wysyłki do KSeF).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { MemberRole } from '@prisma/client'
import { createUserWithHash, grantMembership, type SessionContext } from '@/lib/auth/sesje'
import { hashPassword } from '@/lib/auth/hasla'
import { permissionsOf, type Permission } from '@/lib/auth/uprawnienia'
import { PODGLAD_AUDIT } from '@/lib/klienci/odczyt'
import { rekordZOdbiorcy } from '@/lib/klienci/rekord'
import { zapiszRekordKlienta } from '@/lib/klienci/zapis'
import { prepareKsefForOrder } from '@/lib/ksef/szkice'
import { szkicKorektyKsef } from '@/lib/zwroty/korekta-ksef'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { ACC, product, seedBase } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))
// sesja panelu podstawiona (bez cookies), reszta requirePermissionApi prawdziwa
const sesja: { s: SessionContext | null } = { s: null }
vi.mock('@/lib/panel/kontekst', async (orig) => ({ ...(await orig<typeof import('@/lib/panel/kontekst')>()), currentSession: async () => sesja.s }))
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()

const trasa = await import('@/app/api/zwroty/[id]/korekta-ksef/route')

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
})

const K1 = '1'.repeat(64)
const ENV = { CUSTOMER_DATA_KEYS: `1:${K1}`, CUSTOMER_LOOKUP_KEY: 'a'.repeat(64) }
const NIP = '5260250995'
const T = new Date('2026-11-09T09:00:00.000Z')
const USTAWIENIA = {
  faktury: { program: 'ksef', fakturyWlaczone: true, fakturyWlaczoneOd: '2026-11-01T00:00:00.000Z', wystawiajPrzy: 'SPAKOWANE' },
  ksef: { sprzedawca: { nip: '1111111111', nazwa: 'Sprzedawca Testowy sp. z o.o.', adres: { linia1: 'ul. Testowa 1', linia2: '00-001 Warszawa' } }, seriaKod: 'FV', seriaWzor: '%N/%M/%Y', seriaReset: 'MIESIAC', srodowisko: 'TEST' },
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.warehouse.updateMany({ data: { stockSource: 'KOMPLETOR', wfirmaWarehouseId: null } })
  await sys.organization.update({ where: { id: ORG_A }, data: { settings: USTAWIENIA } })
  vi.stubEnv('CUSTOMER_DATA_KEYS', ENV.CUSTOMER_DATA_KEYS)
  vi.stubEnv('CUSTOMER_LOOKUP_KEY', ENV.CUSTOMER_LOOKUP_KEY)
  sesja.s = null
})

/** Zamówienie z fakturą na firmę: szkic faktury KSeF, dane nabywcy w bazie, przyjęty zwrot. Zwraca id zwrotu. */
async function zwrotZFakturaNaFirme(id: string): Promise<{ returnId: string; orderId: string }> {
  const p = await product(db, `TEST-KOR-${id}`, 100)
  await db.order.create({ data: { id, ...ACC.WOO_SD, externalId: `Z-${id}`, status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '20.00', shippingCostGross: '0', wantInvoiceNip: true, createdAtChannel: T } })
  await db.orderLine.create({ data: { id: `${id}l1`, orderId: id, externalLineId: 'L1', productId: p, qty: 2, unitPriceGross: '10.00', vatRate: '23' } })
  expect(await prepareKsefForOrder(db, id, { now: T })).toMatchObject({ wynik: 'przygotowana' })
  await zapiszRekordKlienta(
    db,
    id,
    rekordZOdbiorcy({
      dostawa: { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'ul. Fikcyjna 17', numerDomu: '17', numerLokalu: null, kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL', telefon: '+48 500 000 000', email: 'jan@example.test' },
      punktOdbioru: null,
      faktura: { nazwa: 'Nabywca Testowy sp. z o.o.', nip: NIP, ulica: 'ul. Fikcyjna 17', kodPocztowy: '60-001', miasto: 'Poznań', kraj: 'PL' },
      problemy: [],
    }),
    { source: 'RECZNE', fetchedAt: T, env: ENV },
  )
  const r = await db.return.create({ data: { orderId: id, status: 'PRZYJETY', lines: { create: [{ orderLineId: `${id}l1`, productId: p, qty: 1 }] } } })
  return { returnId: r.id, orderId: id }
}

/** Prawdziwe konto i członkostwo (odczyt danych klienta sprawdza uprawnienia osoby w bazie) + sesja panelu. */
async function zaloguj(role: MemberRole, permissions: Permission[]): Promise<string> {
  const email = `osoba-${Math.random().toString(36).slice(2, 8)}@example.test`
  const u = await createUserWithHash(sys, { email, name: 'Osoba Testowa', passwordHash: await hashPassword('haslo-testowe-123456') })
  await grantMembership(sys, { email, organizationId: ORG_A, role, permissions })
  const organization = { organizationId: ORG_A, slug: 'firma-a', name: 'Firma A', role, permissions, deniedPermissions: [] }
  sesja.s = { sessionId: 's', user: { id: u.id, email, name: 'Osoba Testowa' }, organization, memberships: [organization], permissions: permissionsOf({ role, permissions, deniedPermissions: [] }), mustChangePassword: false }
  return u.id
}

const pobierz = (returnId: string) => trasa.GET(new NextRequest(`http://localhost/api/zwroty/${returnId}/korekta-ksef`), { params: Promise.resolve({ id: returnId }) })
/** Ślady odczytu danych klienta zamówienia powstałe po przygotowaniu danych (szkic faktury czyta nabywcę jako automat). */
async function slady(orderId: string, przed: Set<string>) {
  return (await db.auditLog.findMany({ where: { entity: PODGLAD_AUDIT, entityId: orderId }, select: { id: true, actorId: true } })).filter((s) => !przed.has(s.id))
}
const stan = async (orderId: string) => new Set((await db.auditLog.findMany({ where: { entity: PODGLAD_AUDIT, entityId: orderId }, select: { id: true } })).map((s) => s.id))

describe('szkic korekty KSeF: dane nabywcy tylko z `klienci.dane` (audyt bezpieczeństwa)', () => {
  it('bez `klienci.dane` 403 i zero odczytu danych klienta', async () => {
    const { returnId, orderId } = await zwrotZFakturaNaFirme('kor1')
    const przed = await stan(orderId)
    await zaloguj('MAGAZYN', ['zwroty.korekty'])
    expect(sesja.s!.permissions.has('klienci.dane')).toBe(false)
    const res = await pobierz(returnId)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain(NIP)
    expect(await slady(orderId, przed)).toEqual([])
  })

  it('z `klienci.dane` szkic z nabywcą, ślad KLIENT_PODGLAD na osobę z sesji (nie system:ksef)', async () => {
    const { returnId, orderId } = await zwrotZFakturaNaFirme('kor2')
    const przed = await stan(orderId)
    const userId = await zaloguj('MAGAZYN', ['zwroty.korekty', 'klienci.dane'])
    const res = await pobierz(returnId)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(NIP)
    const aktorzy = (await slady(orderId, przed)).map((s) => s.actorId)
    expect(aktorzy).toContain(userId)
    expect(aktorzy).not.toContain('system:ksef')
  })

  it('bez `zwroty.korekty` dalej 404 (uprawnienie trasy bez zmian)', async () => {
    const { returnId } = await zwrotZFakturaNaFirme('kor3')
    await zaloguj('MAGAZYN', ['klienci.dane'])
    expect(sesja.s!.permissions.has('zwroty.korekty')).toBe(false)
    expect((await pobierz(returnId)).status).toBe(404)
  })

  it('ścieżka automatu bez osoby zostaje systemowa (system:ksef)', async () => {
    const { returnId, orderId } = await zwrotZFakturaNaFirme('kor4')
    const przed = await stan(orderId)
    const k = await szkicKorektyKsef(db, returnId, { now: T })
    expect(k.ok).toBe(true)
    expect((await slady(orderId, przed)).map((s) => s.actorId)).toEqual(['system:ksef'])
  })
})
