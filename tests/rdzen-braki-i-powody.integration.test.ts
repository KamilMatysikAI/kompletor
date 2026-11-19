// Rdzeń: drobne z wprowadzone — (termin „brakuje wszystkiego” z jednej
// funkcji) i (powody „Do wyjaśnienia” jako tablica). Dane zmyślone.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { addBusinessDays } from '@/lib/rdzen/kalendarz'
import type { Flags } from '@/lib/rdzen/rezerwacja'
import { cancelOrder, ingestOrder, markPaid, remapOrder, resolveClarification, runReservationExpiry } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { expectInvariants, offer, order, product, seedBase, T0 } from './rdzen-fixtures'

const db = testDb()
beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})
afterAll(() => db.$disconnect())

const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)
const wait3 = (from: Date) => addBusinessDays(from, 3)
const get = (id: string) => db.order.findUniqueOrThrow({ where: { id } })

describe('termin „brakuje wszystkiego” (4.2) ze wspólnej funkcji', () => {
  it('edycja w kanale zabiera jedyną zarezerwowaną pozycję → pełny brak, termin 3 dni; dołożenie towaru → termin zdjęty', async () => {
    const a = await product(db, 'A', 1)
    const b = await product(db, 'B', 0)
    const o = order([{ productId: a, qty: 1 }, { productId: b, qty: 1 }])
    const { orderId } = await ingestOrder(db, o, { now: T0 })
    expect((await get(orderId!)).shortageWaitUntil).toBeNull() // A zarezerwowane
    await ingestOrder(db, { ...o, externalRevision: '2', lines: [o.lines[1]!] }, { now: at(M) })
    expect((await get(orderId!)).shortageWaitUntil).toEqual(wait3(at(M)))
    await ingestOrder(db, { ...o, externalRevision: '3', lines: [o.lines[1]!, { externalLineId: 'L3', productId: a, qty: 1, unitPriceGross: 10 }] }, { now: at(2 * M) })
    expect((await get(orderId!)).shortageWaitUntil).toBeNull()
    await expectInvariants(db)
  })

  it('„opłacone po anulowaniu” z pełnym brakiem → DO_WYJASNIENIA i termin 3 dni (po wyjaśnieniu i terminie znowu „do wyjaśnienia”)', async () => {
    const a = await product(db, 'A', 1)
    const { orderId } = await ingestOrder(db, order([{ productId: a, qty: 1 }], { paymentState: 'UNPAID' }), { now: T0 })
    await runReservationExpiry(db, { now: at(14 * 24 * 60 * M) }) // po terminie płatności: zwolnione
    expect((await get(orderId!)).status).toBe('ANULOWANE')
    await ingestOrder(db, order([{ productId: a, qty: 1 }]), { now: at(14 * 24 * 60 * M) }) // ktoś inny bierze ostatnią sztukę
    const paidAt = at(15 * 24 * 60 * M)
    expect(await markPaid(db, orderId!, 'PAID', { now: paidAt })).toBe('DO_WYJASNIENIA')
    const o = await get(orderId!)
    expect(o.shortageWaitUntil).toEqual(wait3(paidAt))
    expect((o.flags as Flags).powodyWyjasnienia).toEqual(['opłacone po anulowaniu'])
    expect(await resolveClarification(db, orderId!, { now: paidAt })).toBe('DO_REALIZACJI')
    await runReservationExpiry(db, { now: new Date(wait3(paidAt).getTime() + M) })
    expect((await get(orderId!)).status).toBe('DO_WYJASNIENIA')
    await expectInvariants(db)
  })

  it('remap: pozycja zmapowana na produkt bez stanu → pełny brak, termin 3 dni', async () => {
    const a = await product(db, 'A', 0)
    const { orderId } = await ingestOrder(db, order([{ offerExternalId: 'nowa', qty: 2 }]), { now: T0 })
    expect((await get(orderId!)).shortageWaitUntil).toBeNull()
    await offer(db, 'WOO_SD', 'nowa', a)
    await remapOrder(db, orderId!, { now: at(M) })
    const o = await get(orderId!)
    expect(o.status).toBe('DO_REALIZACJI')
    expect(o.shortageWaitUntil).toEqual(wait3(at(M)))
    await expectInvariants(db)
  })
})

describe('powody „Do wyjaśnienia” jako tablica', () => {
  it('dwa powody → remap zdejmuje tylko „niezmapowana oferta”, zamówienie zostaje z drugim; tekst dla ekranu złączony', async () => {
    const a = await product(db, 'A', 5)
    const { orderId } = await ingestOrder(db, order([{ offerExternalId: 'nowa', qty: 1 }], { deliveryMethod: 'Teleportacja' }), { now: T0 })
    const f0 = (await get(orderId!)).flags as Flags
    expect(f0.powodyWyjasnienia).toEqual(['niezmapowana oferta', 'nieznana metoda dostawy: Teleportacja'])
    expect(f0.doWyjasnienia).toBe('niezmapowana oferta; nieznana metoda dostawy: Teleportacja')
    await offer(db, 'WOO_SD', 'nowa', a)
    await remapOrder(db, orderId!, { now: at(M) })
    const o = await get(orderId!)
    expect(o.status).toBe('DO_WYJASNIENIA')
    expect((o.flags as Flags).powodyWyjasnienia).toEqual(['nieznana metoda dostawy: Teleportacja'])
    expect(await resolveClarification(db, orderId!)).toBe('DO_REALIZACJI')
    expect((await get(orderId!)).flags).toMatchObject({ powodyWyjasnienia: [], doWyjasnienia: null })
    await expectInvariants(db)
  })

  it('zamówienie (tylko tekst) → remap czyta powody z tekstu i wraca samo', async () => {
    const a = await product(db, 'A', 5)
    const { orderId } = await ingestOrder(db, order([{ offerExternalId: 'nowa', qty: 1 }]), { now: T0 })
    await db.order.update({ where: { id: orderId! }, data: { flags: { doWyjasnienia: 'niezmapowana oferta' } } })
    await offer(db, 'WOO_SD', 'nowa', a)
    await remapOrder(db, orderId!, { now: at(M) })
    expect((await get(orderId!)).status).toBe('DO_REALIZACJI')
  })

  it('kolejny powód dopisany bez powtórzeń (cofnięty status dwa razy)', async () => {
    const a = await product(db, 'A', 5)
    const o = order([{ productId: a, qty: 1 }], { channelStatusRank: 5 })
    const { orderId } = await ingestOrder(db, o, { now: T0 })
    await ingestOrder(db, { ...o, externalRevision: '2', channelStatusRank: 3 }, { now: at(M) })
    await ingestOrder(db, { ...o, externalRevision: '3', channelStatusRank: 2 }, { now: at(2 * M) })
    expect(((await get(orderId!)).flags as Flags).powodyWyjasnienia).toEqual(['cofnięty status w kanale'])
    await cancelOrder(db, orderId!)
  })
})
