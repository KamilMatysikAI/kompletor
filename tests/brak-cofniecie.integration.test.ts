// reszta po. „Jednak jest” w PRACY (stanowisko i biuro) cofa brak w rdzeniu, („poczekaj”
// dokańcza cofnięcie zbierania), (druga sztuka składnika jedynego, już wyjętego zestawu). Dane wyłącznie testowe.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { checkInvariants } from '@/lib/rdzen/niezmienniki'
import { beginInvoice, officeConfirmManual } from '@/lib/rdzen/rozchod'
import { shipLater } from '@/lib/rdzen/brakuje'
import { processAllocateEvents } from '@/lib/rdzen/przydzial'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { BladStanowiska, cofnietePoPoprawie, cofnijBrak, naPolceNieBylo, rozpoznajSkan, zakonczCwiczenie, type WynikSkanu } from '@/lib/stanowisko/cwiczenie'
import { jednakJestZBiura, zdecydujOBraku } from '@/lib/stanowisko/decyzje'
import { drukujKarty } from '@/lib/stanowisko/karty'
import { gabarytyDla } from '@/lib/stanowisko/gabaryty'
import { orderDetail } from '@/lib/panel/dane'
import { testDb, testSystemDb, truncateAll } from './db'
import { bundle, order, product, seedBase } from './rdzen-fixtures'

const a = testDb()
const KTO = { userId: 'uzytkownik-testowy', nazwa: 'Magazyn Testowy' }
const BIURO = 'biuro-testowe'
const gabaryt = gabarytyDla('ALLEGRO')[0]!

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
})
afterEach(async () => {
  expect(await checkInvariants(a)).toEqual([])
})
afterAll(async () => {
  await a.$disconnect()
})

function ok(w: WynikSkanu): Extract<WynikSkanu, { typ: 'ok' }> {
  if (w.typ !== 'ok') throw new Error(`oczekiwane ok, jest: ${w.blokada.rodzaj} — ${w.blokada.komunikat}`)
  return w
}
type Linie = Parameters<typeof order>[0]
async function zamowienie(db: PrismaClient, externalId: string, lines: Linie) {
  return (await ingestOrder(db, order(lines, { externalId, createdAtChannel: new Date(), channel: 'ALLEGRO' }))).orderId!
}
const praca = () => a.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { statusMode: 'PRACA' } })
const stan = (productId: string) => a.stock.findFirstOrThrow({ where: { productId } })

async function otworz(id: string) {
  const { wydruki } = await drukujKarty(a, [id], KTO)
  return ok(await rozpoznajSkan(a, wydruki[0]!.kod, KTO))
}

/** Zamówienie w PRACY: p1 × 2 i p2 × 1, otwarte na stanowisku. */
async function otwartePraca() {
  await praca()
  const p1 = await product(a, 'HERB-1', 5)
  const p2 = await product(a, 'KUBEK', 5)
  const id = await zamowienie(a, '9301', [{ productId: p1, qty: 2 }, { productId: p2, qty: 1 }])
  const w = await otworz(id)
  const kl = (p: string) => w.zamowienie.pozycje.find((x) => x.productId === p)!.klucz
  return { id, p1, p2, drillId: w.cwiczenie.drillId, kl1: kl(p1), kl2: kl(p2) }
}

/** Zestaw A + 2×B (`ile` szt.) i kubek, otwarte na stanowisku. */
async function zestawPraca(ile: number) {
  await praca()
  const pa = await product(a, 'SKL-A', 5, { priceGross: 10 })
  const pb = await product(a, 'SKL-B', 5, { priceGross: 10 })
  const kubek = await product(a, 'KUBEK', 5)
  const zestaw = await bundle(a, 'ZESTAW', [{ id: pa, qty: 1 }, { id: pb, qty: 2 }])
  const id = await zamowienie(a, '9311', [{ productId: zestaw, qty: ile, unitPriceGross: 30 }, { productId: kubek, qty: 1 }])
  const w = await otworz(id)
  const kl = (p: string) => w.zamowienie.pozycje.find((x) => x.productId === p)!.klucz
  return { id, pa, pb, kubek, zestaw, drillId: w.cwiczenie.drillId, klA: kl(pa), klB: kl(pb), klK: kl(kubek) }
}

describe('„Jednak jest” w PRACY', () => {
  it('stanowisko: brak cofnięty w rdzeniu, rezerwacja i stan wracają, alert zamknięty, paczka wychodzi w całości', async () => {
    const { id, p1, drillId, kl1, kl2 } = await otwartePraca()
    const brak = await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    expect(await stan(p1)).toMatchObject({ physical: 4, reserved: 1 })

    const w = await cofnijBrak(a, { drillId, fixId: brak.fixId, userId: KTO.userId })
    expect(w.wrocilo).toBe(1)
    expect(w.pozycje?.find((p) => p.klucz === kl1)?.ilosc).toBe(2)
    expect(await stan(p1)).toMatchObject({ physical: 5, reserved: 2 })
    expect(await a.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(0)
    expect(await a.pendingMovement.findMany({ where: { orderId: id, type: 'STOCK_MISSING' }, select: { state: true } })).toEqual([{ state: 'CANCELLED' }])
    expect(await a.alert.count({ where: { kind: 'BRAK_NA_POLCE', closedAt: null } })).toBe(0)
    expect((await a.packDrillFix.findUniqueOrThrow({ where: { id: brak.fixId } })).state).toBe('WITHDRAWN')
    expect(await a.orderEvent.count({ where: { orderId: id, kind: 'BRAK_COFNIETY' } })).toBe(1)
    const o = await a.order.findUniqueOrThrow({ where: { id } })
    expect((o.flags as { brakuje?: boolean }).brakuje).toBeFalsy()
    // cofnięty wpis z PRACY to nie „poprawka wFirmy cofnięta na stanowisku”
    expect(await cofnietePoPoprawie(a)).toEqual([])

    // drugi klik: nic się nie dzieje
    await cofnijBrak(a, { drillId, fixId: brak.fixId, userId: KTO.userId })
    expect(await stan(p1)).toMatchObject({ physical: 5, reserved: 2 })

    await zakonczCwiczenie(a, { drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl1]: 2, [kl2]: 1 }, userId: KTO.userId })
    const fv = await beginInvoice(a, id)
    expect(fv.outcome === 'START' && fv.lines.find((x) => x.productId === p1)?.qty).toBe(2)
  })

  it('biuro: „Jednak jest na półce” z karty po „Nie spakowano”; karta pokazuje brak do cofnięcia, potem już nie', async () => {
    const { id, p1, drillId, kl1 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 2, userId: KTO.userId })
    await zakonczCwiczenie(a, { drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })
    const [lineId, productId] = kl1.split(':') as [string, string]
    expect((await orderDetail(a, id))!.brakiNaPolce).toEqual([{ orderLineId: lineId, productId, qty: 2 }])

    expect(await jednakJestZBiura(a, { orderLineId: lineId, productId, userId: BIURO })).toEqual({ qty: 2, units: 2 })
    expect(await stan(p1)).toMatchObject({ physical: 5, reserved: 2 })
    expect((await orderDetail(a, id))!.brakiNaPolce).toEqual([])
    expect(await a.packDrillFix.count({ where: { orderId: id, state: { not: 'WITHDRAWN' } } })).toBe(0)
    await expect(jednakJestZBiura(a, { orderLineId: lineId, productId, userId: BIURO })).rejects.toThrow(/nie ma zgłoszonego braku/)
  })

  it('odmowa po „poprawione” w biurze i po spakowaniu; stan bez zmian', async () => {
    const { id, p1, drillId, kl1, kl2 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    const [lineId, productId] = kl1.split(':') as [string, string]
    // spakowane z brakiem: paczka wyszła, cofnięcie odpada
    await zakonczCwiczenie(a, { drillId, wynik: 'SPAKOWANE', gabaryt, zebrane: { [kl1]: 1, [kl2]: 1 }, userId: KTO.userId })
    await expect(jednakJestZBiura(a, { orderLineId: lineId, productId, userId: BIURO })).rejects.toBeInstanceOf(BladStanowiska)

    // drugie zamówienie: biuro poprawiło stan w programie magazynowym, więc tu już nie cofniemy
    const id2 = await zamowienie(a, '9302', [{ productId: p1, qty: 1 }])
    const w2 = await otworz(id2)
    const kl = w2.zamowienie.pozycje[0]!.klucz
    await naPolceNieBylo(a, { drillId: w2.cwiczenie.drillId, klucz: kl, ilosc: 1, userId: KTO.userId })
    const ruch = await a.pendingMovement.findFirstOrThrow({ where: { orderId: id2, type: 'STOCK_MISSING' } })
    await officeConfirmManual(a, ruch.id, { actorId: BIURO })
    const przed = await stan(p1)
    await expect(jednakJestZBiura(a, { orderLineId: kl.split(':')[0]!, productId: p1, userId: BIURO })).rejects.toThrow(/już poprawiło stan/)
    expect(await stan(p1)).toEqual(przed)
    expect(id).not.toBe(id2)
  })

  it('zestaw: cofnięcie braku składnika wraca cały zestaw do paczki', async () => {
    const { id, pa, pb, drillId, klB, klA } = await zestawPraca(1)
    const brak = await naPolceNieBylo(a, { drillId, klucz: klB, ilosc: 1, userId: KTO.userId })
    expect(await stan(pb)).toMatchObject({ physical: 4, reserved: 0 })
    const w = await cofnijBrak(a, { drillId, fixId: brak.fixId, userId: KTO.userId })
    expect(w.wrocilo).toBe(1)
    expect(w.pozycje?.map((p) => p.klucz).sort()).toEqual(expect.arrayContaining([klA, klB].sort()))
    expect(await stan(pb)).toMatchObject({ physical: 5, reserved: 2 })
    expect(await stan(pa)).toMatchObject({ physical: 5, reserved: 1 })
    expect(await a.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(0)
  })

  it('zestaw: składnik, który wrócił na półkę, wziął inny klient — brak cofnięty, stan poprawny, zestaw zostaje brakiem', async () => {
    const { id, pa, pb, drillId, klB } = await zestawPraca(1)
    const brak = await naPolceNieBylo(a, { drillId, klucz: klB, ilosc: 1, userId: KTO.userId })
    await zamowienie(a, '9312', [{ productId: pa, qty: 5 }]) // całe A dostępne idzie do innego zamówienia
    expect(await stan(pa)).toMatchObject({ physical: 5, reserved: 5 })
    const w = await cofnijBrak(a, { drillId, fixId: brak.fixId, userId: KTO.userId })
    expect(w.wrocilo).toBe(0)
    expect(await stan(pb)).toMatchObject({ physical: 5, reserved: 0 })
    expect(await a.shortage.count({ where: { orderId: id, state: 'OPEN' } })).toBe(2)
  })
})

describe('druga sztuka składnika jedynego, już wyjętego zestawu', () => {
  it('przechodzi jako sam ruch stanu (bez kolejnego braku), trzecia sztuka odmawia', async () => {
    const { id, pb, drillId, klB } = await zestawPraca(1)
    await naPolceNieBylo(a, { drillId, klucz: klB, ilosc: 1, userId: KTO.userId })
    const w = await naPolceNieBylo(a, { drillId, klucz: klB, ilosc: 2, userId: KTO.userId })
    expect(w.ilosc).toBe(2)
    expect(w.zestawPoza).toBe(false)
    expect(await stan(pb)).toMatchObject({ physical: 3, reserved: 0 })
    expect(await a.shortage.findMany({ where: { orderId: id, productId: pb, state: 'OPEN' }, select: { qtyBase: true } })).toEqual([{ qtyBase: 2 }])
    await expect(naPolceNieBylo(a, { drillId, klucz: klB, ilosc: 3, userId: KTO.userId })).rejects.toThrow(/Do zebrania zostało 0/)
    expect(await stan(pb)).toMatchObject({ physical: 3, reserved: 0 })
  })
})

describe('„poczekaj” dokańcza cofnięcie zbierania', () => {
  it('decyzja zapisana, a zamówienie zostało w zbieraniu: ponowny klik „poczekaj” oddaje je przydziałowi', async () => {
    const { id, drillId, kl1 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    const lineId = kl1.split(':')[0]!
    // stan po nieudanym cofnięciu zbierania: decyzja jest, status został
    await a.shortageDecision.create({ data: { orderId: id, orderLineId: lineId, action: 'POCZEKAJ', dryRun: false, actorId: BIURO } })
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).toBe('ZBIERANIE')
    expect(await zdecydujOBraku(a, { orderLineId: lineId, akcja: 'POCZEKAJ', userId: BIURO })).toEqual({ zmiana: false, dryRun: false })
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).toBe('DO_REALIZACJI')
  })
})

// poprawki po przeglądzie
describe('runda 2: przegląd', () => {
  it('cofnięcie czeka na blokadzie Stock, biuro w tym czasie zatwierdza ruch = odmowa, `pendingDelta` bez zmian', async () => {
    // deterministycznie: transakcja „biura” trzyma wiersz Stock (FOR UPDATE), cofnięcie startuje i wisi na tej blokadzie,
    // dopiero wtedy ruch MANUAL → APPLIED (jak `officeConfirmManualInTx`, który stanu nie rusza) i commit. Kod sprzed
    // poprawki czytał ruchy przed blokadą Stock, widział MANUAL i podnosił `pendingDelta` przy ruchu już APPLIED.
    const { id, p1, drillId, kl1 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await zakonczCwiczenie(a, { drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })
    const [lineId, productId] = kl1.split(':') as [string, string]
    const ruch = await a.pendingMovement.findFirstOrThrow({ where: { orderId: id, type: 'STOCK_MISSING' } })
    const przed = await stan(p1)
    expect(przed).toMatchObject({ physical: 4, pendingDelta: -1, reserved: 1 })
    const sys = testSystemDb()
    const czekaNaStock = async () =>
      (await sys.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%' AND query LIKE '%"Stock"%'`)[0]!.n > 0
    let cofniecie!: Promise<PromiseSettledResult<unknown>>
    await a.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "Stock" WHERE "productId" = ${p1} FOR UPDATE`
        cofniecie = jednakJestZBiura(a, { orderLineId: lineId, productId, userId: BIURO }).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        )
        const koniec = Date.now() + 20_000
        while (!(await czekaNaStock())) {
          if (Date.now() > koniec) throw new Error('cofnięcie nie zawisło na blokadzie Stock')
          await new Promise((r) => setTimeout(r, 20))
        }
        await tx.pendingMovement.update({ where: { id: ruch.id }, data: { state: 'APPLIED', effectiveAt: new Date(), wzQty: -ruch.delta } })
      },
      { maxWait: 30_000, timeout: 30_000 },
    )
    const w = await cofniecie
    expect(w.status).toBe('rejected')
    expect(String((w as PromiseRejectedResult).reason)).toMatch(/już poprawiło stan/)
    expect((await a.pendingMovement.findUniqueOrThrow({ where: { id: ruch.id } })).state).toBe('APPLIED')
    expect(await stan(p1)).toMatchObject({ physical: przed.physical, pendingDelta: przed.pendingDelta, reserved: przed.reserved })
    expect(await checkInvariants(a)).toEqual([])
  })

  // „Dwa równoległe cofnięcia” przechodzą także bez poprawki: szereguje je blokada pakowania (`pakowanie:<firma>:<id>`
  // w `jednakJestZBiura`), więc drugie widzi ruch już CANCELLED. Test pilnuje wyniku, nie samej poprawki.
  it('dwa równoległe cofnięcia — stan wraca raz', async () => {
    const { p1, drillId, kl1 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 2, userId: KTO.userId })
    await zakonczCwiczenie(a, { drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })
    const [lineId, productId] = kl1.split(':') as [string, string]
    const w = await Promise.allSettled([jednakJestZBiura(a, { orderLineId: lineId, productId, userId: BIURO }), jednakJestZBiura(a, { orderLineId: lineId, productId, userId: BIURO })])
    expect(w.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(await stan(p1)).toMatchObject({ physical: 5, reserved: 2 })
  })

  it('druga sztuka składnika po rezerwacji innego zamówienia = znacznik nadmiaru (niezmiennik 5)', async () => {
    const { pb, drillId, klB } = await zestawPraca(1)
    await naPolceNieBylo(a, { drillId, klucz: klB, ilosc: 1, userId: KTO.userId })
    expect(await stan(pb)).toMatchObject({ physical: 4, reserved: 0 })
    await zamowienie(a, '9313', [{ productId: pb, qty: 4 }]) // inny klient bierze wszystko, co zostało na półce
    expect(await stan(pb)).toMatchObject({ physical: 4, reserved: 4 })
    await naPolceNieBylo(a, { drillId, klucz: klB, ilosc: 2, userId: KTO.userId })
    const s = await stan(pb)
    expect(s).toMatchObject({ physical: 3, reserved: 4 })
    expect(s.overcommitSince).not.toBeNull()
  })

  it('(runda 3): cofnięcie braku, po którym stan wraca do normy, zdejmuje znacznik nadmiaru od razu', async () => {
    const { pb, drillId, klB } = await zestawPraca(1)
    await naPolceNieBylo(a, { drillId, klucz: klB, ilosc: 1, userId: KTO.userId })
    await zamowienie(a, '9314', [{ productId: pb, qty: 4 }])
    await naPolceNieBylo(a, { drillId, klucz: klB, ilosc: 2, userId: KTO.userId })
    const przed = await stan(pb)
    expect(przed).toMatchObject({ physical: 3, reserved: 4 })
    expect(przed.overcommitSince).not.toBeNull()
    await zakonczCwiczenie(a, { drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })
    const [lineId, productId] = klB.split(':') as [string, string]
    await jednakJestZBiura(a, { orderLineId: lineId, productId, userId: BIURO })
    const s = await stan(pb)
    expect(s.physical).toBe(5)
    expect(s.reserved).toBeLessThanOrEqual(s.physical)
    expect(s).toMatchObject({ overcommitSince: null, overcommitListedAt: null })
  })

  it('cofnięcie po „dośle później” — sztuka idzie najpierw do przydziału (paczka 2), nie do kanałów', async () => {
    await praca()
    const p1 = await product(a, 'HERB-2', 2)
    const id = await zamowienie(a, '9321', [{ productId: p1, qty: 2 }])
    const w = await otworz(id)
    const kl1 = w.zamowienie.pozycje[0]!.klucz
    const [lineId, productId] = kl1.split(':') as [string, string]
    await naPolceNieBylo(a, { drillId: w.cwiczenie.drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await zakonczCwiczenie(a, { drillId: w.cwiczenie.drillId, wynik: 'NIE_SPAKOWANO', zebrane: {}, userId: KTO.userId })
    const { childOrderId } = await shipLater(a, lineId)
    expect(await stan(p1)).toMatchObject({ physical: 1, reserved: 1 })
    expect(await a.reservation.count({ where: { orderId: childOrderId, state: 'ACTIVE' } })).toBe(0)

    expect(await jednakJestZBiura(a, { orderLineId: lineId, productId, userId: BIURO })).toEqual({ qty: 1, units: 0 })
    const s = await stan(p1)
    expect(s).toMatchObject({ physical: 2, reserved: 1 })
    expect(s.allocationPendingSince).not.toBeNull()
    expect(await a.outboxEvent.count({ where: { kind: 'ALLOCATE', productId: p1 } })).toBeGreaterThan(0)
    await processAllocateEvents(a)
    expect(await a.reservation.count({ where: { orderId: childOrderId, state: 'ACTIVE' } })).toBe(1)
    expect(await stan(p1)).toMatchObject({ physical: 2, reserved: 2 })
  })

  it('biuro nie cofa braku na koncie w podglądzie (serwer, nie tylko ukryty przycisk)', async () => {
    const { id, drillId, kl1 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await a.channelConfig.updateMany({ where: { channel: 'ALLEGRO' }, data: { statusMode: 'CIEN' } })
    const [lineId, productId] = kl1.split(':') as [string, string]
    await expect(jednakJestZBiura(a, { orderLineId: lineId, productId, userId: BIURO })).rejects.toThrow(/podglądzie/)
    expect(await a.pendingMovement.count({ where: { orderId: id, type: 'STOCK_MISSING', state: 'MANUAL' } })).toBe(1)
  })

  it('„poczekaj” przy zamówieniu już zebranym — decyzja zapisana, status bez zmian, bez błędu', async () => {
    const { id, drillId, kl1 } = await otwartePraca()
    await naPolceNieBylo(a, { drillId, klucz: kl1, ilosc: 1, userId: KTO.userId })
    await a.order.update({ where: { id }, data: { status: 'ZEBRANE' } })
    const lineId = kl1.split(':')[0]!
    expect(await zdecydujOBraku(a, { orderLineId: lineId, akcja: 'POCZEKAJ', userId: BIURO })).toMatchObject({ zmiana: true })
    expect((await a.order.findUniqueOrThrow({ where: { id } })).status).toBe('ZEBRANE')
    expect(await a.orderEvent.count({ where: { orderId: id, kind: 'ZBIERANIE_COFNIETE' } })).toBe(0)
  })
})
