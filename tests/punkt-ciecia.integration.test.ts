// Punkt cięcia przy przejściu z BaseLinkera: na sucho niczego nie zmienia, wykonanie zamyka tylko zamówienia
// obsłużone w BaseLinkerze (bez maila, faktury, ruchu stanu i zapisu do kanałów), powtórka niczego nie zmienia.
// Po przełączeniu kont w tryb pracy kolejka pakowania nie zawiera zamówień obsłużonych w BaseLinkerze, a automat
// „bez paczki” i kolejka faktur niczego starego nie pakują ani nie fakturują. Dane fikcyjne, zero połączeń.
import type { Channel, Prisma } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChannelState, fakeDefinition } from '@/lib/adaptery/falszywy'
import { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { planujAkcje } from '@/lib/akcje/silnik'
import { zapiszRegule } from '@/lib/automaty/dane'
import { przetworzCzas } from '@/lib/automaty/silnik'
import { zaplanujZapisy, zapiszMapeStatusow } from '@/lib/kanaly/zapis-host'
import { INVOICES_JOB } from '@/lib/cien/faktury-bl'
import { zapiszUdanyPrzebieg } from '@/lib/cien/przebiegi'
import { opisPunktuCiecia, punktCiecia, stareZrodla, ZAMKNIETE_PRZY_PRZEJSCIU } from '@/lib/kanaly/punkt-ciecia'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { moveOrder } from '@/lib/rdzen/przejscia'
import { applyBlInvoice, applyBlShippedWithoutInvoice } from '@/lib/rdzen/rozchod'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { ACC, expectInvariants, FakeWfirma, order, product, seedBase, stockOf, T0 } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const M = 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)
let blSeq = 5000

async function digital(sku: string): Promise<string> {
  return (await db.product.create({ data: { sku, kind: 'DIGITAL', unit: 'SZT', nameAccounting: `E-book ${sku}`, title: `E-book ${sku}`, vatRate: '5' } })).id
}

/** Kopia zamówienia BL ze statusem (jak zostawia ją odczyt cienia) i opcjonalnie kopia faktury BL. */
async function wBl(orderId: string, statusName: string, faktura?: string): Promise<number> {
  const blOrderId = ++blSeq
  const o = await db.order.update({ where: { id: orderId }, data: { blOrderId } })
  await db.blOrderSnapshot.create({
    data: { blOrderId, orderSource: 'test', orderSourceId: '1', channel: o.channel, channelAccountId: o.channelAccountId, externalRef: o.externalId, statusId: 1, statusName, dateAdd: T0, fetchedAt: at(M) },
  })
  if (faktura) await db.blInvoiceSnapshot.create({ data: { blInvoiceId: blOrderId, blOrderId, number: faktura, kind: 'normal', dateAdd: T0, fetchedAt: at(M) } })
  return blOrderId
}

async function praca(channel: Channel, channelAccountId: string): Promise<void> {
  await db.channelConfig.updateMany({ where: { channel, channelAccountId }, data: { statusMode: 'PRACA' } })
}

/**
 * Przebieg porównania z BL o `kiedy` (jak zostawia go worker cienia: wynik dziennika w `stats.journal`) i, domyślnie,
 * pełny odczyt faktur BL. `dziennik: false` = lista zamówień z okna przeczytana, dziennik statusów padł (błąd łapany,
 * przebieg i tak OK).
 */
async function odczyt(kiedy: Date, o: { dziennik?: boolean; faktury?: boolean } = {}): Promise<void> {
  const journal = o.dziennik === false ? { complete: false, lastLogId: null, error: 'dziennik BL: błąd sieci' } : { complete: true, lastLogId: '1', events: 0 }
  await db.importRun.create({ data: { kind: 'cien-bl', status: 'OK', startedAt: kiedy, finishedAt: kiedy, stats: { journal } } })
  if (o.faktury !== false) await zapiszUdanyPrzebieg(db, INVOICES_JOB, kiedy)
}

const status = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id } })).status

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})

describe('punkt cięcia', () => {
  it('na sucho → wykonanie → powtórka; po przełączeniu kolejka i automaty nie ruszają zamówień obsłużonych w BL', async () => {
    const tea = await product(db, 'HERB-PC1', 50)
    const ebook = await digital('ebook-pc1')
    const nowy = (lines: Parameters<typeof order>[0], over: Parameters<typeof order>[1] = {}) => ingestOrder(db, order(lines, { channel: 'EMPIK', ...over }), { now: T0 }).then((r) => r.orderId!)

    // A: wysłane i zafakturowane w BL (faktura rozliczona)
    const a = await nowy([{ productId: tea, qty: 2 }])
    await wBl(a, 'Wysłane', 'FV/BL/A')
    await applyBlInvoice(db, a, 'FV/BL/A', { [tea]: 2 }, { now: at(2 * M) })
    // B: odebrane w BL bez faktury (cień rozliczył „wysłane bez faktury”)
    const b = await nowy([{ productId: tea, qty: 1 }])
    await wBl(b, 'Odebrane')
    await applyBlShippedWithoutInvoice(db, b, { now: at(2 * M) })
    // C: wysłane w BL, rezerwacja jeszcze aktywna (odczyt nie przeszedł)
    const c = await nowy([{ productId: tea, qty: 1 }])
    await wBl(c, 'Wysłane')
    // D: do realizacji w BL z fakturą BL (czeka na spakowanie)
    const d = await nowy([{ productId: tea, qty: 1 }])
    await wBl(d, 'Do realizacji Paczkomaty', 'FV/BL/D')
    // E: do realizacji w BL bez faktury
    const e = await nowy([{ productId: tea, qty: 1 }])
    await wBl(e, 'Do realizacji Paczkomaty')
    // G: mieszane (towar + e-book) wysłane i zafakturowane w BL
    const g = await nowy([{ productId: tea, qty: 1 }, { productId: ebook, qty: 1 }])
    await wBl(g, 'Wysłane', 'FV/BL/G')
    await applyBlInvoice(db, g, 'FV/BL/G', { [tea]: 1 }, { now: at(2 * M) })
    // H: anulowane w BL
    const h = await nowy([{ productId: tea, qty: 1 }])
    await wBl(h, 'Anulowane')
    // I: bez pary w BL
    const i = await nowy([{ productId: tea, qty: 1 }])

    const przed = await stockOf(db, tea)
    const outboxPrzed = await db.outboxEvent.count()
    const zdarzeniaPrzed = await db.orderEvent.count()
    const sucho = await punktCiecia(db, { naSucho: true, now: at(10 * M) })
    expect(sucho.liczby).toEqual({ DO_ZAMKNIECIA: 3, CZEKA_NA_ROZLICZENIE: 1, NIESKONCZONE_Z_FAKTURA_BL: 1, NIESKONCZONE_BEZ_FAKTURY: 1, DO_SPRAWDZENIA: 1, BEZ_PARY_W_BL: 1 })
    const grupa = (id: string) => sucho.pozycje.find((p) => p.orderId === id)?.grupa
    expect([a, b, g].map(grupa)).toEqual(['DO_ZAMKNIECIA', 'DO_ZAMKNIECIA', 'DO_ZAMKNIECIA'])
    expect([c, d, e, h, i].map(grupa)).toEqual(['CZEKA_NA_ROZLICZENIE', 'NIESKONCZONE_Z_FAKTURA_BL', 'NIESKONCZONE_BEZ_FAKTURY', 'DO_SPRAWDZENIA', 'BEZ_PARY_W_BL'])
    expect(sucho.zamkniete).toBe(0)
    expect(sucho.wKolejcePakowania).toBe(8)
    expect(await db.orderEvent.count()).toBe(zdarzeniaPrzed)
    expect(await status(a)).toBe('DO_REALIZACJI')

    await odczyt(at(10 * M))
    const inneZdarzenia = () => db.orderEvent.count({ where: { kind: { not: ZAMKNIETE_PRZY_PRZEJSCIU } } })
    const inneZdarzeniaPrzed = await inneZdarzenia()
    const raz = await punktCiecia(db, { naSucho: false, now: at(11 * M) })
    expect(raz.zamkniete).toBe(3)
    expect(raz.bledy).toEqual([])
    expect(raz.wKolejcePakowania).toBe(5) // C, D, E, H, I — do porównania z BL
    expect(raz.wKolejceZFakturaBl).toBe(1) // D: kończy według planu przełączenia
    expect([await status(a), await status(b), await status(g)]).toEqual(['WYSLANE', 'ODEBRANE', 'WYSLANE'])
    expect([await status(c), await status(d), await status(e)]).toEqual(['DO_REALIZACJI', 'DO_REALIZACJI', 'DO_REALIZACJI'])
    const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: a, kind: ZAMKNIETE_PRZY_PRZEJSCIU } })
    expect(ev.data).toMatchObject({ z: 'DO_REALIZACJI', na: 'WYSLANE', statusBl: 'Wysłane', fakturaBl: 'FV/BL/A' })
    // bez ruchu stanu, bez faktury, bez kolejki zapisu do kanałów
    expect(await stockOf(db, tea)).toEqual(przed)
    expect(await db.invoiceAttempt.count()).toBe(0)
    expect(await inneZdarzenia()).toBe(inneZdarzeniaPrzed)
    expect(await db.outboxEvent.count()).toBe(outboxPrzed)

    const dwa = await punktCiecia(db, { naSucho: false, now: at(12 * M) })
    expect(dwa.zamkniete).toBe(0)
    expect(await db.orderEvent.count({ where: { kind: ZAMKNIETE_PRZY_PRZEJSCIU } })).toBe(3)

    // przełączenie konta w tryb pracy: punkt cięcia pomija konto, automaty nie ruszają zamkniętych ani tych z fakturą BL
    await praca('EMPIK', 'empik')
    expect((await punktCiecia(db, { naSucho: true, now: at(13 * M) })).pozycje.filter((p) => p.channel === 'EMPIK')).toHaveLength(0)
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: at(14 * M) })
    expect(wf.invoices).toHaveLength(0)
    expect([await status(a), await status(g), await status(d)]).toEqual(['WYSLANE', 'WYSLANE', 'DO_REALIZACJI'])
    await planujAkcje(db, { now: at(15 * M) })
    expect(await db.plannedAction.count({ where: { targetId: { in: [a, b, g] } } })).toBe(0)
    await expectInvariants(db)
  })

  it('zamknięcie pomija zamówienie, które między listą a zapisem dostało pracę w Kompletorze', async () => {
    const tea = await product(db, 'HERB-PC2', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }], { channel: 'EMPIK' }), { now: T0 })
    await wBl(r.orderId!, 'Wysłane', 'FV/BL/X')
    await applyBlInvoice(db, r.orderId!, 'FV/BL/X', { [tea]: 1 }, { now: at(M) })
    await db.order.update({ where: { id: r.orderId! }, data: { pendingAction: 'ANULUJ_PO_FAKTURZE' } })
    await odczyt(at(2 * M))
    const w = await punktCiecia(db, { naSucho: false, now: at(2 * M) })
    expect(w.liczby.DO_SPRAWDZENIA).toBe(1)
    expect(w.zamkniete).toBe(0)
    expect(await status(r.orderId!)).toBe('DO_REALIZACJI')
  })

  it('po przełączeniu konta w tryb pracy planista zapisów nie wysyła do sklepu statusu zamkniętych przy przejściu', async () => {
    const state = new FakeChannelState()
    const registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
    const SD = ACC.WOO_SD
    await db.channelConfig.updateMany({ where: SD, data: { adapterKey: 'fake.v1', config: { zapisWlaczony: true } as Prisma.InputJsonValue } })
    await zapiszMapeStatusow(db, SD, { status_WYSLANE: 'completed', status_ODEBRANE: 'completed' }, { registry, actorId: 'test' })
    const tea = await product(db, 'HERB-PC3', 10)
    const ebook = await digital('ebook-pc3')
    const nowy = (lines: Parameters<typeof order>[0], over: Parameters<typeof order>[1] = {}) => ingestOrder(db, order(lines, over), { now: T0 }).then((r) => r.orderId!)
    // A: wysłane i zafakturowane w BL; E: sam e-book z fakturą BL (zamknięty jako Odebrane)
    const a = await nowy([{ productId: tea, qty: 1 }])
    await wBl(a, 'Wysłane', 'FV/BL/A3')
    await applyBlInvoice(db, a, 'FV/BL/A3', { [tea]: 1 }, { now: at(M) })
    const e = await nowy([{ productId: ebook, qty: 1 }], { deliveryMethod: 'Dostawa elektroniczna (test)' })
    await wBl(e, 'E-book', 'FV/BL/E3')
    // K: zamówienie bez pary w BL, które po przełączeniu wysyła Kompletor (kontrola: jego status idzie do sklepu)
    const k = await nowy([{ productId: tea, qty: 1 }])

    await odczyt(at(9 * M))
    const w = await punktCiecia(db, { naSucho: false, now: at(10 * M) })
    expect(w.zamkniete).toBe(2)
    expect([await status(a), await status(e)]).toEqual(['WYSLANE', 'ODEBRANE'])
    await praca('WOO', SD.channelAccountId)
    await db.order.update({ where: { id: k }, data: { status: 'WYSLANE' } })

    const plan = await zaplanujZapisy(db, registry, { now: at(20 * M) })
    expect(plan.bledyPlanu).toEqual([])
    const zapisy = await db.channelWrite.findMany({ where: { kind: 'STATUS' }, select: { orderId: true, state: true } })
    expect(zapisy).toEqual([{ orderId: k, state: 'OCZEKUJE' }])
    expect(state.writeCalls).toEqual([])
  })

  it('stan z chwili cięcia nie idzie do sklepu ani do reguł czasowych, późniejsze ręczne „Odebrane” idzie normalnie; „Brak płatności” pomija zamknięte', async () => {
    const state = new FakeChannelState()
    const registry = new AdapterRegistry([fakeDefinition(state, 'WOO')])
    const SD = ACC.WOO_SD
    await db.channelConfig.updateMany({ where: SD, data: { adapterKey: 'fake.v1', config: { zapisWlaczony: true } as Prisma.InputJsonValue } })
    await zapiszMapeStatusow(db, SD, { status_DO_ODBIORU: 'processing', status_ODEBRANE: 'completed' }, { registry, actorId: 'test' })
    const tea = await product(db, 'HERB-PC7', 10)
    const nowy = () => ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 }).then((r) => r.orderId!)
    // O: odbiór osobisty, w BL „Do odbioru” z fakturą BL; rdzeń zdążył w podglądzie odnotować przypomnienie o płatności
    const o = await nowy()
    await db.order.update({ where: { id: o }, data: { carrier: 'OSOBISTY' } })
    await wBl(o, 'Do odbioru', 'FV/BL/O7')
    await applyBlInvoice(db, o, 'FV/BL/O7', { [tea]: 1 }, { now: at(M) })
    await db.order.update({ where: { id: o }, data: { reminderSentAt: at(2 * M) } })
    // K: kontrola bez pary w BL, nieopłacone z przypomnieniem → plan „Brak płatności” powstaje
    const k = await nowy()
    await db.order.update({ where: { id: k }, data: { reminderSentAt: at(2 * M), reservationDeadline: at(3 * 86_400_000) } })

    await odczyt(at(9 * M))
    expect((await punktCiecia(db, { naSucho: false, now: at(10 * M) })).zamkniete).toBe(1)
    expect(await status(o)).toBe('DO_ODBIORU')
    await praca('WOO', SD.channelAccountId)
    const regula = await zapiszRegule(db, { enabled: true, regula: { name: 'Po odbiorze', event: 'W_STATUSIE_DNI', conditions: [{ typ: 'dniWStatusie', dni: 3, robocze: false }, { typ: 'status', wartosci: ['DO_ODBIORU', 'ODEBRANE'] }], actions: [{ typ: 'wyslijEmail', szablon: 'gotowe-do-odbioru' }] } }, 'u-test')
    const za10dni = () => new Date(Date.now() + 10 * 86_400_000)

    // stan z chwili cięcia („Do odbioru”): bez zapisu do sklepu, bez reguły czasowej, bez „Brak płatności”
    expect((await zaplanujZapisy(db, registry, { now: at(20 * M) })).bledyPlanu).toEqual([])
    expect(await db.channelWrite.count({ where: { orderId: o, kind: 'STATUS' } })).toBe(0)
    expect((await przetworzCzas(db, { env: { EKRANY_PRACA: '1' }, now: za10dni() })).bledy).toEqual([])
    expect(await db.automationRun.count({ where: { ruleId: regula.id, orderId: o } })).toBe(0)
    await planujAkcje(db, { now: at(13 * M) })
    expect(await db.plannedAction.findMany({ where: { rule: 'mail.brak-platnosci' }, select: { targetId: true } })).toEqual([{ targetId: k }])

    // ręczne „Odebrane” w Kompletorze po przełączeniu: zwykłe przejście, idzie do sklepu i do reguł czasowych
    expect(await moveOrder(db, o, 'ODEBRANE', { now: at(14 * M), actorId: 'test' })).toBe('ODEBRANE')
    expect((await zaplanujZapisy(db, registry, { now: at(20 * M) })).bledyPlanu).toEqual([])
    expect(await db.channelWrite.findMany({ where: { orderId: o, kind: 'STATUS' }, select: { key: true, state: true, channelStatus: true } })).toEqual([{ key: 'ODEBRANE', state: 'OCZEKUJE', channelStatus: 'completed' }])
    expect((await przetworzCzas(db, { env: { EKRANY_PRACA: '1' }, now: za10dni() })).bledy).toEqual([])
    expect(await db.automationRun.count({ where: { ruleId: regula.id, orderId: o } })).toBe(1)
    // mail „Brak płatności” zostaje pominięty trwale (płatność prowadził BaseLinker)
    await planujAkcje(db, { now: at(15 * M) })
    expect(await db.plannedAction.count({ where: { targetId: o, rule: 'mail.brak-platnosci' } })).toBe(0)
    expect(state.writeCalls).toEqual([])
  })

  it('reguła czasowa „Wysłane ≥ 3 dni → e-mail” po przełączeniu nie bierze zamkniętych przy przejściu', async () => {
    const tea = await product(db, 'HERB-PC4', 10)
    const nowy = () => ingestOrder(db, order([{ productId: tea, qty: 1 }], { channel: 'EMPIK' }), { now: T0 }).then((r) => r.orderId!)
    const a = await nowy()
    await wBl(a, 'Wysłane', 'FV/BL/A4')
    await applyBlInvoice(db, a, 'FV/BL/A4', { [tea]: 1 }, { now: at(M) })
    const k = await nowy() // kontrola: wysłane przez Kompletor po przełączeniu
    await odczyt(at(9 * M))
    expect((await punktCiecia(db, { naSucho: false, now: at(10 * M) })).zamkniete).toBe(1)
    await praca('EMPIK', 'empik')
    await db.order.update({ where: { id: k }, data: { status: 'WYSLANE' } })
    await db.orderEvent.create({ data: { orderId: k, kind: 'WYSLANE', actorId: 'test', createdAt: new Date() } })
    const r = await zapiszRegule(db, { enabled: true, regula: { name: 'Po wysyłce', event: 'W_STATUSIE_DNI', conditions: [{ typ: 'dniWStatusie', dni: 3, robocze: false }, { typ: 'status', wartosci: ['WYSLANE'] }], actions: [{ typ: 'wyslijEmail', szablon: 'gotowe-do-odbioru' }] } }, 'u-test')
    const za10dni = new Date(Date.now() + 10 * 86_400_000)
    const w = await przetworzCzas(db, { env: { EKRANY_PRACA: '1' }, now: za10dni })
    expect(w.bledy).toEqual([])
    expect(await db.automationRun.count({ where: { ruleId: r.id, orderId: a } })).toBe(0)
    expect(await db.automationRun.count({ where: { ruleId: r.id, orderId: k } })).toBe(1)
    expect(await db.plannedAction.count({ where: { targetId: a } })).toBe(0)
  })

  it('kopia z BL starsza niż próg: wykonanie odmawia i niczego nie zamyka; świeży odczyt albo wyższy próg → zamyka', async () => {
    const tea = await product(db, 'HERB-PC5', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }], { channel: 'EMPIK' }), { now: T0 })
    const id = r.orderId!
    await wBl(id, 'Wysłane', 'FV/BL/A5')
    await applyBlInvoice(db, id, 'FV/BL/A5', { [tea]: 1 }, { now: at(M) })

    // nigdy nieodczytane → odmowa, także raport na sucho pokazuje czasy
    const nigdy = await punktCiecia(db, { naSucho: false, now: at(10 * M) })
    expect(nigdy.odmowa).toMatch(/lista zamówień z okna nigdy nieodczytane, dziennik statusów nigdy nieodczytane, faktury nigdy nieodczytane/)
    expect(nigdy.zamkniete).toBe(0)
    expect(nigdy.liczby.DO_ZAMKNIECIA).toBe(1)
    expect((await punktCiecia(db, { naSucho: true, now: at(10 * M) })).odmowa).toBeNull()

    // odczyt 20 min temu → odmowa (domyślnie 15 min), status bez zmian, bez wpisu w historii
    await odczyt(at(-10 * M))
    const stara = await punktCiecia(db, { naSucho: false, now: at(10 * M) })
    expect(stara.odmowa).toMatch(/starsza niż 15 min .*najpierw odśwież odczyt/)
    expect(stara.zamkniete).toBe(0)
    expect(await status(id)).toBe('DO_REALIZACJI')
    expect(await db.orderEvent.count({ where: { orderId: id, kind: ZAMKNIETE_PRZY_PRZEJSCIU } })).toBe(0)

    // świeża lista zamówień i faktury, ale dziennik statusów w tym przebiegu padł (kursor i tak przesunięty) → odmowa:
    // status starszych zamówień niesie tylko dziennik, a ostatni udany jest sprzed 20 min
    await db.blJournalCursor.create({ data: { lastLogId: 1, lastReadAt: at(9 * M) } })
    await odczyt(at(9 * M), { dziennik: false })
    const bezDziennika = await punktCiecia(db, { naSucho: false, now: at(10 * M) })
    expect(bezDziennika.odmowa).toMatch(/\(dziennik statusów odczytane [^)]*\): najpierw odśwież/)
    expect(stareZrodla(bezDziennika.swiezosc, bezDziennika.sprawdzonoO)).toEqual(['dziennik'])
    expect(bezDziennika.swiezosc.zamowienia).toEqual(at(9 * M))
    expect(bezDziennika.swiezosc.dziennik).toEqual(at(-10 * M))
    expect(opisPunktuCiecia(bezDziennika)).toMatch(/dziennik statusów [^(]* \(za stare: blokuje zapis\), faktury [^(;]*;/)
    expect(bezDziennika.zamkniete).toBe(0)
    expect(await status(id)).toBe('DO_REALIZACJI')

    // oba odczyty świeże (dziennik udany, choć pusty) → zamyka
    await odczyt(at(9 * M + 1000))
    const swieze = await punktCiecia(db, { naSucho: false, now: at(10 * M) })
    expect(swieze.odmowa).toBeNull()
    expect(swieze.swiezosc.dziennik).toEqual(at(9 * M + 1000))
    expect(swieze.zamkniete).toBe(1)
    expect(await status(id)).toBe('WYSLANE')
  })

  it('sam e-book i odbiór osobisty: e-book z fakturą BL zamknięty, bez faktury BL po przełączeniu idzie automatem; odbiór osobisty czeka na wydanie', async () => {
    const ebook = await digital('ebook-pc6')
    const tea = await product(db, 'HERB-PC6', 5)
    // metoda dostawy znana (w podglądzie e-book z nieznaną metodą dostawy stoi w „Do wyjaśnienia”)
    const EBOOK = { channel: 'EMPIK' as const }
    const e1 = (await ingestOrder(db, order([{ productId: ebook, qty: 1 }], EBOOK), { now: T0 })).orderId!
    await wBl(e1, 'E-book', 'FV/BL/E6')
    const e2 = (await ingestOrder(db, order([{ productId: ebook, qty: 1 }], EBOOK), { now: T0 })).orderId!
    await wBl(e2, 'E-book')
    const o = (await ingestOrder(db, order([{ productId: tea, qty: 1 }], { channel: 'EMPIK' }), { now: T0 })).orderId!
    await db.order.update({ where: { id: o }, data: { carrier: 'OSOBISTY' } })
    await wBl(o, 'Do odbioru', 'FV/BL/O6')
    await applyBlInvoice(db, o, 'FV/BL/O6', { [tea]: 1 }, { now: at(M) })

    await odczyt(at(9 * M))
    const w = await punktCiecia(db, { naSucho: false, now: at(10 * M) })
    const grupa = (id: string) => w.pozycje.find((p) => p.orderId === id)
    expect(grupa(e1)).toMatchObject({ grupa: 'DO_ZAMKNIECIA', na: 'ODEBRANE' })
    expect(grupa(e2)).toMatchObject({ grupa: 'NIESKONCZONE_BEZ_FAKTURY', na: null })
    expect(grupa(o)).toMatchObject({ grupa: 'DO_ZAMKNIECIA', na: 'DO_ODBIORU' })
    expect(w.zamkniete).toBe(2)
    expect([await status(e1), await status(e2), await status(o)]).toEqual(['ODEBRANE', 'DO_REALIZACJI', 'DO_ODBIORU'])

    // po przełączeniu: e-book bez faktury BL pakuje automat „bez paczki” i dostaje fakturę; zamknięte bez faktury
    await praca('EMPIK', 'empik')
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf }, { now: at(11 * M) })
    await runWfirmaQueue(db, { faktury: wf }, { now: at(12 * M) })
    expect(wf.invoices).toHaveLength(1)
    expect(await status(e2)).toBe('ODEBRANE')
    expect(await db.invoiceAttempt.count({ where: { orderId: { in: [e1, o] } } })).toBe(0)
    // „Gotowe do odbioru”: mail wysłał BaseLinker, plan go nie dokłada; wydanie klientowi jak zwykle
    await planujAkcje(db, { now: at(13 * M) })
    expect(await db.plannedAction.count({ where: { targetId: { in: [e1, o] } } })).toBe(0)
    expect(await moveOrder(db, o, 'ODEBRANE', { now: at(14 * M), actorId: 'test' })).toBe('ODEBRANE')
    await expectInvariants(db)
  })
})

describe('punkt cięcia: konto w trybie pracy', () => {
  it('bierze tylko zamówienia z fakturą BL; zamyka tylko „Wysłane/Odebrane” w BL, „Spakowane/Do wysłania” do sprawdzenia; kolejka pakowania nie liczy kont w pracy', async () => {
    const tea = await product(db, 'HERB-PC-W6', 50)
    const nowy = () => ingestOrder(db, order([{ productId: tea, qty: 1 }], { channel: 'EMPIK' }), { now: T0 }).then((r) => r.orderId!)
    const zFakturaBl = async (status: string) => {
      const id = await nowy()
      await wBl(id, status, `FV/BL/${id.slice(-4)}`)
      await applyBlInvoice(db, id, `FV/BL/${id.slice(-4)}`, { [tea]: 1 }, { now: at(2 * M) })
      return id
    }
    const wyslane = await zFakturaBl('Wysłane')
    const spakowane = await zFakturaBl('Spakowane')
    const doWyslania = await zFakturaBl('Do wysłania')
    const nowe = await zFakturaBl('Nowe')
    // bez faktury BL (bez zdarzenia FAKTURA_BL): zamówienie Kompletora, punkt cięcia go nie bierze
    const bezFaktury = await nowy()
    await wBl(bezFaktury, 'Wysłane')
    await praca('EMPIK', 'empik')
    await odczyt(at(10 * M))

    const w = await punktCiecia(db, { naSucho: false, now: at(11 * M) })
    const grupa = (id: string) => w.pozycje.find((p) => p.orderId === id)?.grupa
    expect(grupa(wyslane)).toBe('DO_ZAMKNIECIA')
    expect([grupa(spakowane), grupa(doWyslania)]).toEqual(['DO_SPRAWDZENIA', 'DO_SPRAWDZENIA'])
    expect(grupa(nowe)).toBe('NIESKONCZONE_Z_FAKTURA_BL')
    expect(grupa(bezFaktury)).toBeUndefined()
    expect(w.zamkniete).toBe(1)
    expect([await status(wyslane), await status(spakowane), await status(doWyslania), await status(nowe), await status(bezFaktury)]).toEqual(['WYSLANE', 'DO_REALIZACJI', 'DO_REALIZACJI', 'DO_REALIZACJI', 'DO_REALIZACJI'])
    expect(w.wKolejcePakowania).toBe(0)
  })
})
