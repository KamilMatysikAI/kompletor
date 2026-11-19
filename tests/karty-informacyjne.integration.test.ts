// karty z listy zamówień drukują się dla każdego zaznaczonego zamówienia. Wysłane, anulowane, z samym
// produktem bez stanu (e-book), z brakiem całego towaru i bez numeru do kodu karty dostają wydruk informacyjny: bez
// wiersza w OrderCardPrint, bez kodu, bez zmian statusu, flag i historii. Karty do zbierania bez zmian (rejestr, T7).
// Kolejka pakowania (bez `informacyjne`) zachowuje się jak dotąd. Trasa: błąd z formularza = strona HTML, fetch = JSON.
// Dane wyłącznie testowe (zmyślone produkty, numery zamówień i adresy e-mail w domenie .test).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createUser, grantMembership, login } from '@/lib/auth/sesje'
import { cancelOrder, ingestOrder } from '@/lib/rdzen/zamowienia'
import { BladKart, drukujKarty } from '@/lib/stanowisko/karty'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

let ciasteczko: string | undefined
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (_n: string) => (ciasteczko ? { value: ciasteczko } : undefined) }),
  headers: async () => new Headers(),
}))
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()

const db = testDb()
const sys = testSystemDb()
const KTO = { userId: 'uzytkownik-testowy', nazwa: 'Magazyn Testowy' }
const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.channelConfig.updateMany({ where: { channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
})
afterAll(async () => {
  await db.$disconnect()
  await sys.$disconnect()
})

let nr = 23300
async function zamowienie(lines: Parameters<typeof order>[0], over: Parameters<typeof order>[1] = {}): Promise<string> {
  const { orderId } = await ingestOrder(db, order(lines, { externalId: String(++nr), ...over }), { now: T0 })
  return orderId!
}
const ebook = async () =>
  (await db.product.create({ data: { sku: `EBOOK-${++nr}`, kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'Poradnik testowy', title: 'Poradnik testowy' } })).id

async function tekstStron(pdf: Buffer): Promise<string[]> {
  const zadanie = getDocument({ data: new Uint8Array(pdf), useSystemFonts: false })
  const dokument = await zadanie.promise
  const strony: string[] = []
  for (let i = 1; i <= dokument.numPages; i++) {
    const tresc = await (await dokument.getPage(i)).getTextContent()
    strony.push(tresc.items.map((x) => ('str' in x ? x.str : '')).join(' ').replace(/\s+/g, ' '))
  }
  await zadanie.destroy()
  return strony
}

/** Zamówienia, flagi i historia — wydruk informacyjny nie może tu niczego zmienić. */
const stan = async () =>
  JSON.stringify({
    orders: await db.order.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true, flags: true, pendingAction: true, updatedAt: true } }),
    events: await db.orderEvent.findMany({ orderBy: { id: 'asc' } }),
    reservations: await db.reservation.findMany({ orderBy: { id: 'asc' } }),
  })

/** Cztery zamówienia bez karty do zbierania: wysłane, anulowane, sam e-book, brak całego towaru. */
async function czteryInformacyjne() {
  const jest = await product(db, 'A', 50)
  const brak = await product(db, 'B', 0)
  const wyslane = await zamowienie([{ productId: jest, qty: 1 }])
  // skrót testu: sam status (bez rozchodu), więc niezmienników rdzenia tu nie sprawdzamy — „bez zmian” pilnuje stan()
  await db.order.update({ where: { id: wyslane }, data: { status: 'WYSLANE' } })
  const anulowane = await zamowienie([{ productId: jest, qty: 1 }])
  await cancelOrder(db, anulowane, { now: T0 })
  const tylkoEbook = await zamowienie([{ productId: await ebook(), qty: 1 }])
  const bezTowaru = await zamowienie([{ productId: brak, qty: 2 }])
  return { jest, wyslane, anulowane, tylkoEbook, bezTowaru }
}

describe('karty z listy zamówień: wydruk informacyjny', () => {
  it('wysłane, anulowane, sam e-book i brak całego towaru = 4 strony informacyjne; rejestr, statusy, flagi i historia bez zmian', async () => {
    const z = await czteryInformacyjne()
    const ids = [z.wyslane, z.anulowane, z.tylkoEbook, z.bezTowaru]
    expect((await db.order.findUniqueOrThrow({ where: { id: z.anulowane } })).status).toBe('ANULOWANE')
    const przed = await stan()
    const w = await drukujKarty(db, ids, KTO, at(M), { informacyjne: true })
    expect(w.wydruki).toEqual([])
    expect(w.pominiete).toEqual([])
    expect(w.informacyjne.map((i) => [i.orderId, i.powod])).toEqual([
      [z.wyslane, 'zamówienie wysłane'],
      [z.anulowane, 'zamówienie anulowane'],
      [z.tylkoEbook, 'same produkty bez wysyłki (np. e-book)'],
      [z.bezTowaru, 'brakuje całego towaru'],
    ])
    expect(await db.orderCardPrint.count()).toBe(0)
    expect(await stan()).toBe(przed)
    const strony = await tekstStron(w.pdf)
    expect(strony).toHaveLength(4)
    expect(strony[0]).toContain('Wydruk informacyjny: zamówienie wysłane')
    expect(strony[1]).toContain('Wydruk informacyjny: zamówienie anulowane')
    expect(strony[2]).toContain('Wydruk informacyjny: same produkty bez wysyłki (np. e-book)')
    expect(strony[2]).toContain('BEZ STANU (bez wysyłki)')
    expect(strony[3]).toContain('Wydruk informacyjny: brakuje całego towaru')
    expect(strony[3]).toContain('BRAK NA STANIE')
    expect(strony[3]).toContain('Towar testowy B')
    for (const s of strony) expect(s).not.toMatch(/SD\d+\/\d/)

  })

  it('kolejka pakowania (bez `informacyjne`): jak dotąd — same takie zamówienia = 422 z komunikatem po ludzku, nic nie zapisane', async () => {
    const z = await czteryInformacyjne()
    const e = await drukujKarty(db, [z.wyslane, z.anulowane, z.tylkoEbook, z.bezTowaru], KTO, at(M)).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(BladKart)
    expect((e as BladKart).status).toBe(422)
    expect((e as BladKart).message).toMatch(/^Żadne z zaznaczonych zamówień nie ma towaru do zebrania/)
    expect(await db.orderCardPrint.count()).toBe(0)
  })

  it('mieszane zaznaczenie (2 do zbierania + 2 informacyjne) = 4 strony w kolejności zaznaczenia, 2 wiersze rejestru, T7 tylko dla kart', async () => {
    const z = await czteryInformacyjne()
    const k1 = await zamowienie([{ productId: z.jest, qty: 1 }])
    const k2 = await zamowienie([{ productId: z.jest, qty: 3 }])
    const flagiInfo = await db.order.findMany({ where: { id: { in: [z.wyslane, z.bezTowaru] } }, orderBy: { id: 'asc' }, select: { status: true, flags: true } })
    const w = await drukujKarty(db, [k1, z.wyslane, k2, z.bezTowaru], KTO, at(M), { informacyjne: true })
    expect(w.wydruki.map((x) => [x.orderId, x.printNo, x.zbieranie])).toEqual([
      [k1, 1, true],
      [k2, 1, true],
    ])
    expect(w.informacyjne.map((i) => i.orderId)).toEqual([z.wyslane, z.bezTowaru])
    expect(await db.orderCardPrint.count()).toBe(2)
    expect((await db.orderCardPrint.findMany({ orderBy: { orderId: 'asc' } })).map((p) => p.orderId).sort()).toEqual([k1, k2].sort())
    expect((await db.order.findUniqueOrThrow({ where: { id: k1 } })).status).toBe('ZBIERANIE')
    expect(await db.order.findMany({ where: { id: { in: [z.wyslane, z.bezTowaru] } }, orderBy: { id: 'asc' }, select: { status: true, flags: true } })).toEqual(flagiInfo)
    const strony = await tekstStron(w.pdf)
    expect(strony).toHaveLength(4)
    expect(strony[0]).toContain(w.wydruki[0]!.kod)
    expect(strony[1]).toContain('Wydruk informacyjny: zamówienie wysłane')
    expect(strony[2]).toContain(w.wydruki[1]!.kod)
    expect(strony[3]).toContain('Wydruk informacyjny: brakuje całego towaru')
    expect(strony.join(' ')).not.toContain('Pominięto')

  })

  it('częściowy brak w karcie do zbierania: brakująca część widoczna jako „BRAK, NIE PAKOWAĆ”, migawka jak dotąd', async () => {
    const malo = await product(db, 'C', 1)
    const jest = await product(db, 'D', 5)
    const id = await zamowienie([{ productId: malo, qty: 3 }, { productId: jest, qty: 1 }])
    const w = await drukujKarty(db, [id], KTO, at(M), { informacyjne: true })
    expect(w.informacyjne).toEqual([])
    const [s] = await tekstStron(w.pdf)
    expect(s).toContain('BRAK, NIE PAKOWAĆ: Towar testowy C: 2 szt.')
    const wpis = await db.orderCardPrint.findFirstOrThrow({ where: { orderId: id } })
    expect((wpis.lines as { b?: number }[]).some((l) => l.b === 2)).toBe(true)
  })

  it('zamówienie bez numeru do kodu karty: z listy wydruk informacyjny, z kolejki pakowania 422 jak dotąd', async () => {
    const jest = await product(db, 'E', 5)
    const id = await zamowienie([{ productId: jest, qty: 1 }], { channel: 'ALLEGRO', externalId: '3f1c2b7a-9d4e-4c11-8a55-0b6f0e7d9a21' })
    const w = await drukujKarty(db, [id], KTO, at(M), { informacyjne: true })
    expect(w.informacyjne.map((i) => i.powod)).toEqual(['zamówienie nie ma jeszcze numeru do kodu karty'])
    expect(await db.orderCardPrint.count()).toBe(0)
    const e = (await drukujKarty(db, [id], KTO, at(M)).catch((x: unknown) => x)) as BladKart
    expect(e.status).toBe(422)
    expect(e.message).toMatch(/nie mają jeszcze numeru, z którego powstaje kod karty/)
    expect(e.message).not.toMatch(/BaseLinker/)
  })
})

describe('POST /api/wydruki/karty: wydruk informacyjny i błędy po ludzku', () => {
  it('formularz z listy (informacyjne=1) drukuje wysłane; błąd z formularza = HTML, z fetch = JSON', async () => {
    const { POST } = await import('@/app/api/wydruki/karty/route')
    const z = await czteryInformacyjne()
    await createUser(sys, { email: 'magazyn@firma-a.test', name: 'Magazyn A', password: 'haslo-testowe-a233' })
    await grantMembership(sys, { email: 'magazyn@firma-a.test', organizationId: ORG_A, role: 'MAGAZYN' })
    const r = await login(sys, 'magazyn@firma-a.test', 'haslo-testowe-a233')
    if (!r.ok) throw new Error(r.reason)
    ciasteczko = r.token
    const req = (pola: Record<string, string>, accept?: string) =>
      new NextRequest('http://localhost/api/wydruki/karty', {
        method: 'POST',
        body: new URLSearchParams(pola),
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(accept ? { accept } : {}) },
      })

    const ok = await POST(req({ z: `${z.wyslane},${z.tylkoEbook}`, informacyjne: '1' }, 'text/html,*/*;q=0.8'))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('application/pdf')
    expect(ok.headers.get('x-karty')).toBe('')
    expect(decodeURIComponent(ok.headers.get('x-karty-informacyjne') ?? '')).toMatch(/,/)
    expect(await tekstStron(Buffer.from(await ok.arrayBuffer()))).toHaveLength(2)
    expect(await db.orderCardPrint.count()).toBe(0)

    // kolejka pakowania (bez `informacyjne`) z samymi wysłanymi: formularz w nowej karcie = strona HTML
    const html = await POST(req({ z: z.wyslane }, 'text/html,application/xhtml+xml,*/*;q=0.8'))
    expect(html.status).toBe(422)
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const tresc = await html.text()
    expect(tresc).toContain('Nie udało się wydrukować kart')
    expect(tresc).toContain('Wróć do zamówień')
    expect(tresc).not.toContain('{"error"')

    // fetch z kodu: JSON jak dotąd
    const json = await POST(req({ z: z.wyslane }, 'application/json'))
    expect(json.status).toBe(422)
    expect((await json.json()).error).toMatch(/nie ma towaru do zebrania/)
    expect((await POST(req({ z: '' }))).status).toBe(400)

    ciasteczko = undefined
    const bezSesji = await POST(req({ z: z.wyslane, informacyjne: '1' }, 'text/html'))
    expect(bezSesji.status).toBe(401)
    expect(await bezSesji.text()).toContain('Zaloguj się')
  })
})
