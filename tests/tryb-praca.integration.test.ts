// sekcja „Co dalej” na karcie zamówienia (tryb PRACA), (mieszane z całym towarem odrzuconym),
// („Wyjaśnione” z dołożonym towarem wymaga przewoźnika), (podgląd przesyłki nieaktualny, nadanie liczy od nowa).
// Dane fikcyjne, faktury na atrapie wFirmy, zero połączeń zewnętrznych.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { permissionsOf } from '@/lib/auth/uprawnienia'
import { stanCoDalej } from '@/lib/praca/dane'
import { wykonajPrzejscie } from '@/lib/praca/wykonaj'
import { rejectShortagesAtAcceptance, shipLater } from '@/lib/rdzen/brakuje'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { startPicking } from '@/lib/rdzen/przejscia'
import { TransitionError } from '@/lib/rdzen/statusy'
import { ingestOrder, resolveClarification } from '@/lib/rdzen/zamowienia'
import { podgladPrzesylki, prepareForOrder, przesylkaDoNadania } from '@/lib/wysylka/podglad'
import { ORG_B, testDb, truncateAll } from './db'
import { expectInvariants, FakeWfirma, offer, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
const dbB = testDb({ organizationId: ORG_B })
afterAll(async () => {
  await db.$disconnect()
  await dbB.$disconnect()
})

const ENV = { EKRANY_PRACA: '1' }
const EBOOK_DELIVERY = 'Dostawa elektroniczna (test)'
const BIURO = permissionsOf({ role: 'BIURO', permissions: [], deniedPermissions: [] })
const MAGAZYN = permissionsOf({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] })
const WLASCICIEL = permissionsOf({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] })

async function praca(channel: 'WOO' | 'EMPIK', channelAccountId: string, klient = db): Promise<void> {
  await klient.channelConfig.updateMany({ where: { channel, channelAccountId }, data: { statusMode: 'PRACA' } })
}

async function digital(sku: string, klient = db): Promise<string> {
  const p = await klient.product.create({ data: { sku, kind: 'DIGITAL', unit: 'SZT', nameAccounting: `E-book ${sku}`, title: `E-book ${sku}`, vatRate: '5' } })
  return p.id
}

const status = async (id: string, klient = db) => (await klient.order.findUniqueOrThrow({ where: { id } })).status
const klik = (id: string, akcja: string, opts: { uprawnienia?: ReadonlySet<string>; env?: Record<string, string | undefined>; nadanie?: string; przewoznik?: string; klient?: typeof db } = {}) =>
  wykonajPrzejscie(opts.klient ?? db, { orderId: id, akcja, userId: 'u-test', uprawnienia: opts.uprawnienia ?? WLASCICIEL, nadanie: opts.nadanie, przewoznik: opts.przewoznik }, opts.env ?? ENV)
const przyciski = async (id: string, u: ReadonlySet<string> = WLASCICIEL, env: Record<string, string | undefined> = ENV) => (await stanCoDalej(db, id, u, env))?.przyciski ?? null

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await seedBase(dbB)
})

describe('wyłącznik: konto w cieniu i instancja bez EKRANY_PRACA', () => {
  it('konto w cieniu: sekcji nie ma, akcja odmawia także przy ręcznym wywołaniu, zamówienie bez zmian', async () => {
    const tea = await product(db, 'HERB-P1', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })
    expect(await stanCoDalej(db, r.orderId!, WLASCICIEL, ENV)).toBeNull()
    const w = await klik(r.orderId!, 'zbieranie')
    expect(w).toMatchObject({ zmiana: false, blad: expect.stringMatching(/tylko dla kont w trybie PRACA/) })
    expect(await status(r.orderId!)).toBe('DO_REALIZACJI')
    expect(await db.orderEvent.count({ where: { orderId: r.orderId!, actorId: { startsWith: 'user:' } } })).toBe(0)
  })

  it('firma z BaseLinkerem: konto w PRACA bez EKRANY_PRACA (puste, 0) = odmowa; zła wartość = czytelna odmowa', async () => {
    // wyłącznik instancji obowiązuje tylko firmę przechodzącą z BL (tu: token BL z env self-hostu)
    const BL = { BASELINKER_TOKEN: 'test-bl' }
    await praca('WOO', 'sd')
    const tea = await product(db, 'HERB-P2', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })
    expect(await stanCoDalej(db, r.orderId!, WLASCICIEL, BL)).toBeNull()
    expect(await stanCoDalej(db, r.orderId!, WLASCICIEL, { ...BL, EKRANY_PRACA: '0' })).toBeNull()
    expect((await klik(r.orderId!, 'zbieranie', { env: BL })).blad).toMatch(/tylko dla kont w trybie PRACA/)
    expect((await klik(r.orderId!, 'zbieranie', { env: { EKRANY_PRACA: 'tak' } })).blad).toMatch(/Zła wartość EKRANY_PRACA/)
    expect(await stanCoDalej(db, r.orderId!, WLASCICIEL, { EKRANY_PRACA: 'tak' })).toBeNull() // karta działa, sekcji nie ma
    expect(await status(r.orderId!)).toBe('DO_REALIZACJI')
    expect(await stanCoDalej(db, r.orderId!, WLASCICIEL, { ...BL, ...ENV })).not.toBeNull()
  })

  it('firma bez BaseLinkera (R28): konto w PRACA działa bez EKRANY_PRACA; konto w cieniu dalej odmawia', async () => {
    const tea = await product(db, 'HERB-P3', 5)
    const cien = await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })
    expect((await klik(cien.orderId!, 'zbieranie', { env: {} })).blad).toMatch(/tylko dla kont w trybie PRACA/)
    await praca('WOO', 'sd')
    expect(await stanCoDalej(db, cien.orderId!, WLASCICIEL, {})).not.toBeNull()
    expect(await stanCoDalej(db, cien.orderId!, WLASCICIEL, { EKRANY_PRACA: '0' })).not.toBeNull()
    expect(await klik(cien.orderId!, 'zbieranie', { env: {} })).toMatchObject({ blad: null, zmiana: true })
  })
})

describe('konto w PRACA: pełne drogi z karty', () => {
  it('paczka: zbieranie → zebrane → spakuj → faktura (atrapa) → do wysyłki → wysłane z numerem → odebrane', async () => {
    await praca('WOO', 'sd')
    const tea = await product(db, 'HERB-P3', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 2 }]), { now: T0 })
    const id = r.orderId!
    expect((await przyciski(id))!.map((p) => p.akcja)).toEqual(['zbieranie', 'spakuj', 'anuluj'])
    expect(await klik(id, 'zbieranie', { uprawnienia: MAGAZYN })).toEqual({ blad: null, zmiana: true })
    expect(await klik(id, 'zebrane', { uprawnienia: MAGAZYN })).toEqual({ blad: null, zmiana: true })
    expect(await klik(id, 'spakuj', { uprawnienia: MAGAZYN })).toEqual({ blad: null, zmiana: true })
    expect(await status(id)).toBe('SPAKOWANE')
    // przed fakturą „Do wysyłki” nieaktywne z powodem; akcja też odmawia
    expect((await przyciski(id))!.find((p) => p.akcja === 'wydanie')?.powod).toMatch(/^Najpierw faktura/)
    expect((await klik(id, 'wydanie')).blad).toMatch(/^Najpierw faktura/)
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect(wf.invoices).toHaveLength(1)
    expect(await klik(id, 'wydanie', { uprawnienia: BIURO })).toEqual({ blad: null, zmiana: true })
    expect(await status(id)).toBe('DO_WYSLANIA')
    expect((await klik(id, 'wyslane', { nadanie: '<b>zly</b>' })).blad).toMatch(/Numer nadania/)
    expect(await klik(id, 'wyslane', { nadanie: 'TEST 0000 1111' })).toEqual({ blad: null, zmiana: true })
    expect(await klik(id, 'odebrane')).toEqual({ blad: null, zmiana: true })
    expect(await status(id)).toBe('ODEBRANE')
    expect(await przyciski(id)).toEqual([])
    const ev = await db.orderEvent.findMany({ where: { orderId: id, actorId: 'user:u-test' }, orderBy: { createdAt: 'asc' } })
    expect(ev.map((e) => e.kind)).toEqual(['ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'WYSLANE', 'ODEBRANE'])
    expect(ev.find((e) => e.kind === 'WYSLANE')?.data).toMatchObject({ nadanie: 'TEST00001111' })
    expect((await stockOf(db, tea)).physical).toBe(3)
    await expectInvariants(db)
  })

  it('odbiór osobisty: spakuj z DO_REALIZACJI → faktura → „Do odbioru” → odebrane', async () => {
    await praca('WOO', 'sd')
    const tea = await product(db, 'HERB-P4', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }], { deliveryMethod: 'Odbiór osobisty' }), { now: T0 })
    const id = r.orderId!
    expect((await db.order.findUniqueOrThrow({ where: { id } })).carrier).toBe('OSOBISTY')
    expect((await klik(id, 'spakuj')).blad).toBeNull()
    expect((await przyciski(id))!.find((p) => p.akcja === 'bez_faktury')?.powod).toMatch(/Odbiór osobisty/)
    await runWfirmaQueue(db, { faktury: new FakeWfirma() }, { now: T0 })
    const p = (await przyciski(id))!.find((x) => x.akcja === 'wydanie')!
    expect(p).toMatchObject({ etykieta: 'Do odbioru', powod: null })
    expect((await klik(id, 'wydanie')).blad).toBeNull()
    expect(await status(id)).toBe('DO_ODBIORU')
    expect((await klik(id, 'odebrane')).blad).toBeNull()
    expect(await status(id)).toBe('ODEBRANE')
    await expectInvariants(db)
  })

  it('sam e-book: bez zbierania, spakuj z karty, faktura usługi, „Odebrane” po fakturze', async () => {
    await praca('WOO', 'sd')
    const ebook = await digital('ebook-p5')
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1, unitPriceGross: 19.9 }], { deliveryMethod: EBOOK_DELIVERY }), { now: T0 })
    const id = r.orderId!
    const s = (await stanCoDalej(db, id, WLASCICIEL, ENV))!
    expect(s.bezPaczki).toBe(true)
    expect(s.stanowisko).toBe(false)
    expect(s.przyciski.map((p) => p.akcja)).toEqual(['spakuj', 'anuluj'])
    expect((await klik(id, 'zbieranie')).blad).toMatch(/nie pasuje/) // nie ma takiego przycisku dla samej usługi
    expect((await klik(id, 'spakuj')).blad).toBeNull()
    expect((await przyciski(id))!).toMatchObject([{ akcja: 'odebrane_bez_wysylki', powod: expect.stringMatching(/Najpierw faktura/) }, { akcja: 'anuluj', powod: null }])
    // atrapa faktury; automat sam kończy zamówienie, a klik po nim nic nie zmienia
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect(wf.invoices[0]!.lines).toEqual([{ productId: ebook, qty: 1, unitGrossGr: 1990, vatRate: '5', service: true }])
    expect(await status(id)).toBe('ODEBRANE')
    expect(await klik(id, 'odebrane_bez_wysylki')).toEqual({ blad: null, zmiana: false })
    expect(await db.pendingMovement.count()).toBe(0)
    await expectInvariants(db)
  })

  it('nieopłacone: „Oznacz jako opłacone” tylko z uprawnieniem; anulowanie z karty', async () => {
    await praca('WOO', 'sd')
    const tea = await product(db, 'HERB-P6', 5)
    const a = await ingestOrder(db, order([{ productId: tea, qty: 1 }], { paymentState: 'UNPAID' }), { now: T0 })
    expect((await klik(a.orderId!, 'oplacone', { uprawnienia: BIURO })).blad).toMatch(/osobnego uprawnienia/)
    expect(await status(a.orderId!)).toBe('NOWE')
    expect((await klik(a.orderId!, 'oplacone', { uprawnienia: new Set([...BIURO, 'zamowienia.oznacz_oplacone']) })).blad).toBeNull()
    expect(await status(a.orderId!)).toBe('DO_REALIZACJI')
    expect(await db.order.findUniqueOrThrow({ where: { id: a.orderId! } })).toMatchObject({ paymentState: 'PAID' })
    expect((await klik(a.orderId!, 'anuluj', { uprawnienia: BIURO })).blad).toBeNull()
    expect(await status(a.orderId!)).toBe('ANULOWANE')
    expect(await stockOf(db, tea)).toMatchObject({ reserved: 0 })
    await expectInvariants(db)
  })
})

describe('uprawnienia i powtórki', () => {
  it('bez zamowienia.przejscia: przyciski z powodem, akcja odmawia', async () => {
    await praca('WOO', 'sd')
    const tea = await product(db, 'HERB-P7', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })
    const tylkoPodglad = new Set(['panel.podglad'])
    expect((await przyciski(r.orderId!, tylkoPodglad))!.every((p) => p.powod)).toBe(true)
    expect((await klik(r.orderId!, 'zbieranie', { uprawnienia: tylkoPodglad })).blad).toMatch(/uprawnienia/)
    expect(await status(r.orderId!)).toBe('DO_REALIZACJI')
  })

  it('anulowanie po fakturze wymaga zamowienia.anuluj_po_fakturze', async () => {
    await praca('WOO', 'sd')
    const tea = await product(db, 'HERB-P8', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })
    const id = r.orderId!
    await klik(id, 'spakuj')
    await runWfirmaQueue(db, { faktury: new FakeWfirma() }, { now: T0 })
    // karta daje „Anuluj” w SPAKOWANE; po fakturze bez osobnego uprawnienia odmowa
    expect((await klik(id, 'anuluj', { uprawnienia: BIURO })).blad).toMatch(/osobnym uprawnieniem/)
    expect(await status(id)).toBe('SPAKOWANE')
    expect((await klik(id, 'anuluj', { uprawnienia: WLASCICIEL })).blad).toBeNull()
    const po = await db.order.findUniqueOrThrow({ where: { id } })
    expect(po.status === 'ANULOWANE' || !!po.pendingAction?.startsWith('CANCEL')).toBe(true)
  })

  it('anulowanie po fakturze (DO_REALIZACJI z wystawioną fakturą poprzedniej paczki) odmawia bez uprawnienia', async () => {
    await praca('WOO', 'sd')
    const tea = await product(db, 'HERB-P9', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })
    const id = r.orderId!
    await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED', wfirmaDocId: 'FV/T/1' } })
    expect((await klik(id, 'anuluj', { uprawnienia: BIURO })).blad).toMatch(/Po fakturze/)
    expect(await status(id)).toBe('DO_REALIZACJI')
    expect((await klik(id, 'anuluj', { uprawnienia: new Set([...BIURO, 'zamowienia.anuluj_po_fakturze']) })).blad).toBeNull()
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'ANULOWANE', flags: expect.objectContaining({ doKorekty: true }) })
  })

  it('podwójne kliknięcie (kolejno i naraz): jedno przejście, jedno zdarzenie, bez błędu', async () => {
    await praca('WOO', 'sd')
    const tea = await product(db, 'HERB-P10', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })
    const id = r.orderId!
    expect(await klik(id, 'zbieranie')).toEqual({ blad: null, zmiana: true })
    expect(await klik(id, 'zbieranie')).toEqual({ blad: null, zmiana: false })
    const naraz = await Promise.all([klik(id, 'spakuj'), klik(id, 'spakuj')])
    expect(naraz.every((w) => w.blad === null)).toBe(true)
    expect(await status(id)).toBe('SPAKOWANE')
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'ZBIERANIE' } })).toBe(1)
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'SPAKOWANE' } })).toBe(1)
    await expectInvariants(db)
  })

  it('izolacja dwóch firm: zamówienie firmy B niewidoczne dla firmy A (karta i akcja)', async () => {
    await praca('WOO', 'sd', dbB)
    const teaB = await product(dbB, 'HERB-P11', 5)
    const rB = await ingestOrder(dbB, order([{ productId: teaB, qty: 1 }]), { now: T0 })
    expect(await stanCoDalej(db, rB.orderId!, WLASCICIEL, ENV)).toBeNull()
    expect(await klik(rB.orderId!, 'zbieranie')).toEqual({ blad: 'Nie ma takiego zamówienia.', zmiana: false })
    expect(await status(rB.orderId!, dbB)).toBe('DO_REALIZACJI')
    expect(await klik(rB.orderId!, 'zbieranie', { klient: dbB })).toEqual({ blad: null, zmiana: true })
    expect(await db.order.count()).toBe(0)
  })
})

describe('zamówienie mieszane z całym towarem odrzuconym', () => {
  async function mieszane(klient = db): Promise<{ id: string; ebook: string; tea: string }> {
    const ebook = await digital('ebook-w3', klient)
    const tea = await product(klient, 'HERB-W3', 0)
    await offer(klient, 'EMPIK', 'EMP-EBOOK', ebook, { qtyBasePerOffer: 1 })
    await offer(klient, 'EMPIK', 'EMP-HERB', tea, { qtyBasePerOffer: 1 })
    const r = await ingestOrder(klient, order([{ offerExternalId: 'EMP-EBOOK', qty: 1, unitPriceGross: 25 }, { offerExternalId: 'EMP-HERB', qty: 2 }], { channel: 'EMPIK' }), { now: T0 })
    expect(await rejectShortagesAtAcceptance(klient, r.orderId!, { now: T0 })).toBe(2)
    return { id: r.orderId!, ebook, tea }
  }

  it('e-book + odrzucona przyprawa, przewoźnik PACZKOMATY: automat → SPAKOWANE → faktura usługi → ODEBRANE', async () => {
    await praca('EMPIK', 'empik')
    const { id, ebook, tea } = await mieszane()
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DO_REALIZACJI', carrier: 'PACZKOMATY' })
    // T7 nie odmawia bez wyjaśnienia: komunikat mówi, co się dzieje
    await expect(startPicking(db, id, { now: T0 })).rejects.toThrow(/towar.*odrzucono.*automatem/)
    const s = (await stanCoDalej(db, id, WLASCICIEL, ENV))!
    expect(s.bezPaczki).toBe(true)
    expect(s.przyciski.map((p) => p.akcja)).not.toContain('zbieranie')

    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect(wf.invoices).toHaveLength(1)
    expect(wf.invoices[0]!.lines).toEqual([{ productId: ebook, qty: 1, unitGrossGr: 2500, vatRate: '5', service: true }])
    expect(await status(id)).toBe('ODEBRANE')
    const ev = await db.orderEvent.findMany({ where: { orderId: id }, orderBy: { createdAt: 'asc' } })
    expect(ev.find((e) => e.kind === 'SPAKOWANE')).toMatchObject({ actorId: 'system:bez-wysylki', data: expect.objectContaining({ bezWysylki: true }) })
    expect(ev.find((e) => e.kind === 'ODEBRANE')?.actorId).toBe('system:bez-wysylki')
    expect(await db.pendingMovement.count()).toBe(0)
    expect(await stockOf(db, tea)).toMatchObject({ physical: 0, reserved: 0, pendingDelta: 0 })
    await expectInvariants(db)
  })

  it('konto w cieniu w tym samym stanie: automat go nie rusza (BaseLinker prowadzi zamówienie)', async () => {
    const { id } = await mieszane()
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect(wf.invoices).toHaveLength(0)
    expect(await status(id)).toBe('DO_REALIZACJI')
    expect(await db.invoiceAttempt.count()).toBe(0)
  })

  it('PRACA w firmie B nie włącza automatu w firmie A (cień)', async () => {
    await praca('EMPIK', 'empik', dbB)
    const { id } = await mieszane()
    await runWfirmaQueue(db, { faktury: new FakeWfirma() }, { now: T0 })
    expect(await status(id)).toBe('DO_REALIZACJI')
  })

  it('Woo „dośle później”: z otwartym brakiem automat czeka; po decyzji podzamówienie czeka na towar jak dotąd', async () => {
    await praca('WOO', 'sd')
    const ebook = await digital('ebook-w3w')
    const tea = await product(db, 'HERB-W3W', 0)
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1, unitPriceGross: 25 }, { productId: tea, qty: 1 }]), { now: T0 })
    const id = r.orderId!
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    expect(await status(id)).toBe('DO_REALIZACJI') // otwarty brak: towar ma przyjść, automat nie pakuje
    expect(wf.invoices).toHaveLength(0)

    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: id, productId: tea } })
    const { childOrderId } = await shipLater(db, line.id, { now: T0 })
    await runWfirmaQueue(db, { faktury: wf }, { now: T0 })
    // podzamówienie z przyprawą: SHIP_LATER czeka na dostawę, bez faktury i bez spakowania (bez zmian)
    expect(await db.order.findUniqueOrThrow({ where: { id: childOrderId } })).toMatchObject({ status: 'DO_REALIZACJI', parentOrderId: id })
    expect(await db.shortage.findFirstOrThrow({ where: { orderId: childOrderId } })).toMatchObject({ state: 'SHIP_LATER' })
    expect(await db.invoiceAttempt.count({ where: { orderId: childOrderId } })).toBe(0)
    // matka została z samą usługą: idzie jak zamówienie bez paczki (faktura e-booka, koniec)
    expect(wf.invoices).toHaveLength(1)
    expect(wf.invoices[0]!.lines).toEqual([{ productId: ebook, qty: 1, unitGrossGr: 2500, vatRate: '5', service: true }])
    expect(await status(id)).toBe('ODEBRANE')
    await expectInvariants(db)
  })
})

describe('„Wyjaśnione” dla zamówienia bez wysyłki z dołożonym towarem', () => {
  async function ebookZTowarem(): Promise<string> {
    await praca('WOO', 'sd')
    const ebook = await digital('ebook-r2')
    const tea = await product(db, 'HERB-R2', 5)
    const first = order([{ productId: ebook, qty: 1 }], { deliveryMethod: EBOOK_DELIVERY })
    const r = await ingestOrder(db, first, { now: T0 })
    await ingestOrder(db, { ...first, externalRevision: '2', lines: [...first.lines, { externalLineId: 'L2', productId: tea, qty: 1, unitPriceGross: 10 }] }, { now: T0 })
    expect(await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })).toMatchObject({ status: 'DO_WYJASNIENIA', carrier: 'BEZ_WYSYLKI' })
    return r.orderId!
  }

  it('rdzeń: bez przewoźnika TransitionError i bez zmian; z przewoźnikiem zapisuje przewoźnika i moduł z reguły', async () => {
    const id = await ebookZTowarem()
    await expect(resolveClarification(db, id, { now: T0 })).rejects.toBeInstanceOf(TransitionError)
    await expect(resolveClarification(db, id, { now: T0, carrier: 'BEZ_WYSYLKI' })).rejects.toThrow(/przewoźnika paczki/)
    expect(await status(id)).toBe('DO_WYJASNIENIA')
    expect(await resolveClarification(db, id, { now: T0, carrier: 'DPD' })).toBe('DO_REALIZACJI')
    const rule = await db.carrierRule.findFirstOrThrow({ where: { carrier: 'DPD' }, orderBy: { priority: 'asc' } })
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ carrier: 'DPD', shippingModule: rule.shippingModule, statusBeforeClarify: null })
    expect((await db.orderEvent.findFirstOrThrow({ where: { orderId: id, kind: 'WYJASNIONE' } })).data).toMatchObject({ przewoznik: 'DPD' })
    expect(await startPicking(db, id, { now: T0 })).toBe('ZBIERANIE') // dalej jak paczka
    await expectInvariants(db)
  })

  it('karta: wybór przewoźnika z reguł firmy obowiązkowy; zły albo pusty = odmowa', async () => {
    const id = await ebookZTowarem()
    const s = (await stanCoDalej(db, id, BIURO, ENV))!
    expect(s.przyciski).toMatchObject([{ akcja: 'wyjasnione', wyborPrzewoznika: true, powod: null }])
    expect(s.przewoznicy.map((p) => p.carrier)).toEqual(expect.arrayContaining(['PACZKOMATY', 'DPD', 'OSOBISTY']))
    expect(s.przewoznicy.map((p) => p.carrier)).not.toContain('BEZ_WYSYLKI')
    expect(s.przewoznicy.map((p) => p.carrier)).not.toContain('ALLEGRO') // reguła tylko dla kanału Allegro
    expect((await klik(id, 'wyjasnione', { uprawnienia: BIURO })).blad).toMatch(/wybierz przewoźnika/)
    expect((await klik(id, 'wyjasnione', { uprawnienia: BIURO, przewoznik: 'ALLEGRO' })).blad).toMatch(/wybierz przewoźnika/)
    expect(await status(id)).toBe('DO_WYJASNIENIA')
    expect(await klik(id, 'wyjasnione', { uprawnienia: BIURO, przewoznik: 'PACZKOMATY' })).toEqual({ blad: null, zmiana: true })
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DO_REALIZACJI', carrier: 'PACZKOMATY' })
  })

  it('nieznana metoda dostawy (BRAK) z towarem: karta wymaga przewoźnika, rdzeń bez wyboru dalej jak dotąd', async () => {
    await praca('WOO', 'sd')
    const tea = await product(db, 'HERB-D3', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }], { deliveryMethod: 'Metoda spoza reguł (test)' }), { now: T0 })
    const id = r.orderId!
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DO_WYJASNIENIA', carrier: 'BRAK' })
    expect((await przyciski(id))![0]).toMatchObject({ akcja: 'wyjasnione', wyborPrzewoznika: true })
    expect((await klik(id, 'wyjasnione', { uprawnienia: BIURO })).blad).toMatch(/wybierz przewoźnika/)
    expect(await klik(id, 'wyjasnione', { uprawnienia: BIURO, przewoznik: 'DPD' })).toEqual({ blad: null, zmiana: true })
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DO_REALIZACJI', carrier: 'DPD' })
    await expectInvariants(db)
  })

  it('inne przypadki bez zmian: zamówienie z przewoźnikiem paczki wychodzi bez wyboru', async () => {
    await praca('WOO', 'sd')
    const r = await ingestOrder(db, order([{ offerExternalId: 'NIEZNANA', qty: 1 }]), { now: T0 })
    const id = r.orderId!
    expect(await status(id)).toBe('DO_WYJASNIENIA')
    expect((await przyciski(id))![0]!.wyborPrzewoznika).toBeUndefined()
    expect((await klik(id, 'wyjasnione')).blad).toBeNull()
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ carrier: 'PACZKOMATY' })
  })
})

describe('podgląd przesyłki nieaktualny, nadanie liczy od nowa', () => {
  it('chip po zmianie zamówienia albo pozycji; ponowne policzenie zdejmuje', async () => {
    const tea = await product(db, 'HERB-D9', 50)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 2 }]), { now: T0 })
    const id = r.orderId!
    await prepareForOrder(db, id, 'INPOST_B')
    expect((await podgladPrzesylki(db, id))!.zapisana).toMatchObject({ nieaktualny: false })
    await new Promise((res) => setTimeout(res, 5))
    await db.orderLine.updateMany({ where: { orderId: id }, data: { qtyRejected: 1 } })
    expect((await podgladPrzesylki(db, id))!.zapisana).toMatchObject({ nieaktualny: true })
    await prepareForOrder(db, id, 'INPOST_B')
    expect((await podgladPrzesylki(db, id))!.zapisana).toMatchObject({ nieaktualny: false })
    await new Promise((res) => setTimeout(res, 5))
    await db.order.update({ where: { id }, data: { paymentMethod: 'Za pobraniem' } })
    expect((await podgladPrzesylki(db, id))!.zapisana).toMatchObject({ nieaktualny: true })
  })

  it('przesylkaDoNadania nie czyta zapisanego wiersza: sfałszowane parametry wiersza nie przechodzą', async () => {
    const tea = await product(db, 'HERB-D9B', 50)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 2 }]), { now: T0 })
    const id = r.orderId!
    const swiezy = await prepareForOrder(db, id, 'INPOST_B')
    await db.preparedShipment.updateMany({ where: { orderId: id }, data: { sideXCm: 999, weightKg: '99.000', codAmount: '1234.00', courierCode: 'podmieniony' } })
    const doNadania = await przesylkaDoNadania(db, id, 'INPOST_B')
    expect(doNadania).toEqual(swiezy)
    if (doNadania.wynik !== 'przygotowane') throw new Error('nie przygotowane')
    expect(doNadania.parcel).toMatchObject({ sideXCm: 19, codAmount: null, courierCode: 'paczkomaty' })
    // przy okazji odświeża podgląd: wiersz znów odpowiada zamówieniu
    expect(await db.preparedShipment.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ sideXCm: 19, courierCode: 'paczkomaty' })
  })
})

describe('„Pakuj mimo faktury z BaseLinkera” po stronie serwera', () => {
  async function zFaktura(blOrderId: number, rozliczona: boolean): Promise<string> {
    await praca('WOO', 'sd')
    const p = await product(db, `HERB-FBL-${blOrderId}`, 5, { wfirmaGoodId: `G-${blOrderId}` })
    const id = (await ingestOrder(db, order([{ productId: p, qty: 1 }]), { now: T0 })).orderId!
    await db.order.update({ where: { id }, data: { blOrderId } })
    if (rozliczona) await db.orderEvent.create({ data: { orderId: id, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId: `FV ${blOrderId}` } } })
    else await db.blInvoiceSnapshot.create({ data: { blInvoiceId: blOrderId, blOrderId, number: `FV ${blOrderId}`, kind: 'normal', dateAdd: T0, fetchedAt: T0 } })
    return id
  }
  const flaga = async (id: string) => !!((await db.order.findUniqueOrThrow({ where: { id } })).flags as { pakujMimoFakturyBl?: boolean } | null)?.pakujMimoFakturyBl

  it('bez uprawnienia do zmiany statusu na dowolny: odmowa z powodem, flaga i wpis w historii nie powstają', async () => {
    const id = await zFaktura(8801, true)
    const w = await klik(id, 'pakuj_mimo_faktury_bl', { uprawnienia: BIURO })
    expect(w).toMatchObject({ zmiana: false, blad: expect.stringMatching(/uprawnieniem do zmiany statusu na dowolny/) })
    expect(await flaga(id)).toBe(false)
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'PAKUJ_MIMO_FAKTURY_BL' } })).toBe(0)
    expect(await klik(id, 'pakuj_mimo_faktury_bl')).toEqual({ blad: null, zmiana: true }) // właściciel
    expect(await flaga(id)).toBe(true)
  })

  it('faktura z BaseLinkera jeszcze nierozliczona (sama kopia, towar odłożony): czytelna odmowa zamiast odblokowania', async () => {
    const id = await zFaktura(8802, false)
    const w = await klik(id, 'pakuj_mimo_faktury_bl')
    expect(w).toMatchObject({ zmiana: false, blad: expect.stringMatching(/czeka jeszcze na dokument WZ/) })
    expect(await flaga(id)).toBe(false)
  })
})
