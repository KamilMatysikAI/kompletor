// faktura w wFirmie w walucie zamówienia. Cały tor jak/: kolejka wFirmy → adapter zapisu
// (`zlozFaktureZamowienia`) → klient `WfirmaZapis` → atrapa HTTP wFirmy (zero sieci, zero prawdziwych faktur). Waluta
// z kopii kanału. Wyłącznik firmy `settings.faktury.walutaZamowienia`: włączony = jedna faktura z `currency`
// i kursem dobranym przez wFirmę, wyłączony = blokada jak dotąd. PLN bajt w bajt jak bez wyłącznika. Dane fikcyjne.
import type { Order } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { dokumentyZFormularza, programyDoWyboru, zapiszUstawieniaDokumentow } from '@/lib/dokumenty/zapis'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { faktyPrzejscia, finishPicking, startPicking } from '@/lib/rdzen/przejscia'
import { beginDocument, packOrder, ponowFaktureRecznie } from '@/lib/rdzen/rozchod'
import { blokadaFakturyWaluta, FAKTURA_OBCA_WALUTA, FAKTURA_WALUTA_PONOWIONA, powodFakturyRecznej, tekstWalutaSprzedWlaczenia, walutaCzekaNaPonowienie, walutaZatrzymana } from '@/lib/rdzen/waluta'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { ALERT_FAKTURA_WALUTA_SPRAWDZ, FAKTURA_WALUTA, FakturyWfirmaZapis } from '@/lib/wfirma/adapter-zapis'
import { WfirmaReadOnly } from '@/lib/zrodla/wfirma'
import { WfirmaZapis } from '@/lib/zrodla/wfirma-zapis'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { ACC, expectInvariants, order, product, seedBase, T0 } from './rdzen-fixtures'
import { KLUCZE_TESTOWE, WfirmaHttpAtrapa } from './wfirma-http-atrapa'

const db = testDb()
const sys = testSystemDb()
afterAll(() => db.$disconnect())

const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'Testowa', numerDomu: '1', numerLokalu: null, kodPocztowy: '11000', miasto: 'Testowo', kraj: 'CZ', telefon: null, email: null },
  punktOdbioru: null,
  faktura: null,
  problemy: [],
}
const adapter = (w: WfirmaHttpAtrapa) => new FakturyWfirmaZapis(new WfirmaReadOnly(KLUCZE_TESTOWE, w.fetch, 0), db, { zapis: new WfirmaZapis(KLUCZE_TESTOWE, w.fetch, 0), odbiorca: async () => ODBIORCA })
const min = (m: number) => new Date(T0.getTime() + m * 60_000)

/**
 * Ustawienia firmy jak po zapisie ekranu. `od` = chwila włączenia „Faktury w walucie zamówienia” (domyślnie T0, przed
 * każdym spakowaniem w teście: zdarzenia statusu dostają zegar rzeczywisty, późniejszy niż T0).
 */
async function ustawFirme(walutaZamowienia: boolean | undefined, od: Date = T0): Promise<void> {
  await sys.organization.update({
    where: { id: ORG_A },
    data: {
      settings: {
        faktury: {
          kodyVat: { '23': 222, '8': 223, '5': 224, '0': 234 },
          program: 'wfirma',
          fakturyWlaczone: true,
          fakturyWlaczoneOd: T0.toISOString(),
          ...(walutaZamowienia === undefined ? {} : { walutaZamowienia }),
          ...(walutaZamowienia ? { walutaZamowieniaOd: od.toISOString() } : {}),
        },
      } as never,
    },
  })
}

/** Chwila włączenia „po” zdarzeniach statusu z zegara rzeczywistego (zapas na rozjazd zegara bazy i testu). */
// chwila włączenia po przyjęciu i spakowaniu zamówienia, a przed kolejnymi krokami testu (zegar rzeczywisty jak `createdAt` zdarzeń)
const pauza = () => new Promise((r) => setTimeout(r, 30))
async function poSpakowaniu(): Promise<Date> {
  await pauza()
  const d = new Date()
  await pauza()
  return d
}

/** Kopia zamówienia z kanału z walutą (tak, jak zostawia ją odczyt kanału). */
async function kopiaKanalu(o: Pick<Order, 'id' | 'channel' | 'channelAccountId' | 'externalId'>, currency: string): Promise<void> {
  await db.channelOrderSnapshot.create({
    data: { channel: o.channel, channelAccountId: o.channelAccountId, externalId: o.externalId, revision: '1', channelStatus: 'READY_FOR_PROCESSING', lifecycle: 'OPEN', paymentState: 'PAID', totalGross: 957, currency, lineCount: 1, warnings: [], createdAtChannel: T0, firstSeenAt: T0, lastSeenAt: T0, orderId: o.id },
  })
}

/** Zamówienie Allegro: 2 × 400 + wysyłka 157 = 957 w walucie zamówienia; opcjonalnie spakowane. */
async function zamowienie(sku: string, waluta: string | null, opts: { spakuj?: boolean; goodId?: string } = { spakuj: true }): Promise<Order> {
  const tea = await product(db, sku, 5, { wfirmaGoodId: opts.goodId ?? '7101' })
  const r = await ingestOrder(db, order([{ productId: tea, qty: 2, unitPriceGross: 400 }], { channel: 'ALLEGRO', totalGross: 957 }), { now: T0 })
  const o = await db.order.findUniqueOrThrow({ where: { id: r.orderId! } })
  if (waluta) await kopiaKanalu(o, waluta)
  if (opts.spakuj) {
    await startPicking(db, o.id, { now: T0 })
    await finishPicking(db, o.id, { now: T0 })
    await packOrder(db, o.id, { now: T0 })
  }
  return o
}

const tresc = (cialo: string) => (JSON.parse(cialo) as { invoices: { invoice: Record<string, unknown> } }).invoices.invoice
const slad = (orderId: string, kind: string) => db.orderEvent.findMany({ where: { orderId, kind } })

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
  await db.channelConfig.updateMany({ where: ACC.ALLEGRO, data: { statusMode: 'PRACA' } })
})

describe('wyłącznik włączony, stan z wFirmy (faktura z rozchodem)', () => {
  beforeEach(() => ustawFirme(true))

  it('CZK: jedna faktura z currency CZK, ceny i wysyłka w koronach, kurs z odczytu wFirmy w historii, bez „wystaw ręcznie”', async () => {
    const o = await zamowienie('A395-CZK', 'CZK')
    const w = new WfirmaHttpAtrapa()
    const st = await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    expect(st.invoices).toBe(1)
    expect(w.faktury).toHaveLength(1)
    const inv = tresc(w.ciala[0]!)
    expect(inv['currency']).toBe('CZK')
    expect(Object.keys(inv).filter((k) => /exchange|currency_/.test(k))).toEqual([])
    expect(w.faktury[0]!.pozycje.map((p) => [p.goodId, p.count, p.price, p.vat])).toEqual([
      [7101, 2, '400.00', 222],
      [0, 1, '157.00', 222],
    ])
    expect(inv['alreadypaid_initial']).toBe('957.00')
    expect(w.sciezki).toContain(`invoices/get/${w.faktury[0]!.id}`)
    expect(await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: o.id } })).toMatchObject({ state: 'ISSUED', wfirmaDocId: w.faktury[0]!.id })
    const [e] = await slad(o.id, FAKTURA_WALUTA)
    expect(e?.data).toMatchObject({ docId: w.faktury[0]!.id, waluta: 'CZK', bruttoGr: 95700, kurs: 0.1745, dataKursu: '2026-11-20', tabela: '226/A/NBP/2026' })
    expect(await slad(o.id, FAKTURA_OBCA_WALUTA)).toHaveLength(0)
    expect(await db.alert.count({ where: { ref: o.id, kind: { in: ['FAKTURA_OBCA_WALUTA', ALERT_FAKTURA_WALUTA_SPRAWDZ] } } })).toBe(0)
    // następny przebieg: bez drugiej faktury
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    await expectInvariants(db)
  })

  it('PLN obok: treść żądania bajt w bajt, te same wywołania wFirmy, stany prób i zdarzenia jak przy wyłączonym wyłączniku', async () => {
    const obraz = async (w: WfirmaHttpAtrapa, orderId: string) => ({
      sciezki: w.sciezki,
      proby: (await db.invoiceAttempt.findMany({ where: { orderId }, orderBy: { attemptNo: 'asc' }, select: { attemptNo: true, state: true, documentOnly: true } })),
      zdarzenia: (await db.orderEvent.findMany({ where: { orderId }, select: { kind: true } })).map((e) => e.kind).sort(),
      alerty: (await db.alert.findMany({ where: { ref: orderId }, select: { kind: true } })).map((a) => a.kind).sort(),
    })
    const o1 = await zamowienie('A395-PLN1', 'PLN')
    const w1 = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w1) }, { now: min(1), tylkoPraca: true })
    await runWfirmaQueue(db, { faktury: adapter(w1) }, { now: min(2), tylkoPraca: true })
    const cialoWlaczony = w1.ciala[0]!
    const obrazWlaczony = await obraz(w1, o1.id)
    expect(w1.sciezki.some((s) => s.startsWith('invoices/get'))).toBe(false)

    await truncateAll(db)
    await seedBase(db)
    await db.channelConfig.updateMany({ where: ACC.ALLEGRO, data: { statusMode: 'PRACA' } })
    await ustawFirme(undefined)
    const o2 = await zamowienie('A395-PLN1', 'PLN')
    const w2 = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w2) }, { now: min(1), tylkoPraca: true })
    await runWfirmaQueue(db, { faktury: adapter(w2) }, { now: min(2), tylkoPraca: true })
    const norm = (c: string) => c.replace(/"id_external":"[^"]+"/, '"id_external":"X"')
    expect(norm(cialoWlaczony)).toBe(norm(w2.ciala[0]!))
    expect(obrazWlaczony).toEqual(await obraz(w2, o2.id))
    expect(obrazWlaczony.proby).toEqual([{ attemptNo: 1, state: 'ISSUED', documentOnly: false }])
    expect(tresc(cialoWlaczony)).not.toHaveProperty('currency')
  })

  it('wFirma zapisała inną walutę albo bez kursu: faktura zostaje (bez drugiej próby), alert dla biura do sprawdzenia', async () => {
    const o = await zamowienie('A395-ROZJAZD', 'CZK')
    const w = new WfirmaHttpAtrapa()
    w.walutaOdczytu = 'PLN'
    w.kurs = null
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: o.id } })).state).toBe('ISSUED')
    const a = await db.alert.findFirstOrThrow({ where: { ref: o.id, kind: ALERT_FAKTURA_WALUTA_SPRAWDZ } })
    expect(a.message).toMatch(/waluta faktury PLN, a zamówienia CZK; brak kursu NBP na fakturze/)
    expect(await slad(o.id, FAKTURA_WALUTA)).toHaveLength(0)
  })

  it('timeout po zapisie: find odnajduje fakturę, sprawdzenie waluty i ślad tak samo, bez drugiej faktury', async () => {
    const o = await zamowienie('A395-TIMEOUT', 'CZK')
    const w = new WfirmaHttpAtrapa()
    w.nastepne = ['TIMEOUT_PO_ZAPISIE']
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: o.id } })).state).toBe('UNKNOWN')
    for (const m of [2, 4, 8]) await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(m), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: o.id, state: 'ISSUED' } })).wfirmaDocId).toBe(w.faktury[0]!.id)
    expect((await slad(o.id, FAKTURA_WALUTA))[0]?.data).toMatchObject({ waluta: 'CZK', kurs: 0.1745 })
  })

  it('paczka dodatkowa zamówienia w CZK (`#dosle-1`, bez własnej kopii kanału): faktura w CZK', async () => {
    const glowne = await zamowienie('A395-GL', 'CZK', { spakuj: false })
    const z = await zamowienie('A395-DOSLE', null, { spakuj: false, goodId: '7102' })
    const dosle = await db.order.update({ where: { id: z.id }, data: { externalId: `${glowne.externalId}#dosle-1`, parentOrderId: glowne.id, packageNo: 2 } })
    await startPicking(db, dosle.id, { now: T0 })
    await finishPicking(db, dosle.id, { now: T0 })
    await packOrder(db, dosle.id, { now: T0 })
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    expect(w.faktury[0]!.currency).toBe('CZK')
    expect(w.faktury[0]!.idExternal.startsWith(`${glowne.id}/2/`)).toBe(true)
    expect((await slad(dosle.id, FAKTURA_WALUTA))[0]?.data).toMatchObject({ waluta: 'CZK' })
  })

  it('paczka dodatkowa po timeoucie (droga find): ślad waluty i alert na zamówieniu paczki, nie na głównym', async () => {
    const glowne = await zamowienie('A395-GL2', 'CZK', { spakuj: false })
    const z = await zamowienie('A395-DOSLE2', null, { spakuj: false, goodId: '7102' })
    const dosle = await db.order.update({ where: { id: z.id }, data: { externalId: `${glowne.externalId}#dosle-1`, parentOrderId: glowne.id, packageNo: 2 } })
    await startPicking(db, dosle.id, { now: T0 })
    await finishPicking(db, dosle.id, { now: T0 })
    await packOrder(db, dosle.id, { now: T0 })
    const w = new WfirmaHttpAtrapa()
    w.nastepne = ['TIMEOUT_PO_ZAPISIE']
    w.kurs = null
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    for (const m of [2, 4, 8]) await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(m), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: dosle.id, state: 'ISSUED' } })).wfirmaDocId).toBe(w.faktury[0]!.id)
    expect(await db.alert.count({ where: { ref: dosle.id, kind: ALERT_FAKTURA_WALUTA_SPRAWDZ } })).toBe(1)
    expect(await db.alert.count({ where: { ref: glowne.id, kind: ALERT_FAKTURA_WALUTA_SPRAWDZ } })).toBe(0)
    expect(await slad(glowne.id, FAKTURA_WALUTA)).toHaveLength(0)
  })

  it('paczka dodatkowa po timeoucie, faktura zgodna: ślad waluty na zamówieniu paczki', async () => {
    const glowne = await zamowienie('A395-GL3', 'CZK', { spakuj: false })
    const z = await zamowienie('A395-DOSLE3', null, { spakuj: false, goodId: '7102' })
    const dosle = await db.order.update({ where: { id: z.id }, data: { externalId: `${glowne.externalId}#dosle-1`, parentOrderId: glowne.id, packageNo: 2 } })
    await startPicking(db, dosle.id, { now: T0 })
    await finishPicking(db, dosle.id, { now: T0 })
    await packOrder(db, dosle.id, { now: T0 })
    const w = new WfirmaHttpAtrapa()
    w.nastepne = ['TIMEOUT_PO_ZAPISIE']
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    for (const m of [2, 4, 8]) await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(m), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    expect(await slad(dosle.id, FAKTURA_WALUTA)).toHaveLength(1)
    expect(await slad(glowne.id, FAKTURA_WALUTA)).toHaveLength(0)
  })

  it('a /: odczyt po zapisie pada (HTTP 500): jedna próba odczytu, faktura ISSUED, jedna faktura, alert „sprawdź ręcznie”', async () => {
    const o = await zamowienie('A395-GET', 'CZK')
    const w = new WfirmaHttpAtrapa()
    w.getBledy = 5
    w.getStatus = 500
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    expect(w.sciezki.filter((s) => s.startsWith('invoices/get'))).toHaveLength(1)
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: o.id } })).state).toBe('ISSUED')
    const a = await db.alert.findFirstOrThrow({ where: { ref: o.id, kind: ALERT_FAKTURA_WALUTA_SPRAWDZ } })
    expect(a.message).toMatch(/nie udało się sprawdzić waluty i kwoty faktury w wFirmie .*sprawdź dokument ręcznie/)
    expect(await slad(o.id, FAKTURA_WALUTA)).toHaveLength(0)
    await expectInvariants(db)
  })

  it('limit wFirmy (HTTP 429) na odczycie po zapisie: faktura rozliczona, kolejka wstrzymana, alert, bez drugiej faktury', async () => {
    const o = await zamowienie('A395-429', 'CZK')
    const w = new WfirmaHttpAtrapa()
    w.getBledy = 1
    w.getStatus = 429
    const st = await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    expect(st).toMatchObject({ paused: true })
    expect(w.faktury).toHaveLength(1)
    expect(w.sciezki.filter((s) => s.startsWith('invoices/get'))).toHaveLength(1)
    expect(w.sciezki.some((s) => s.startsWith('warehouse_documents'))).toBe(false)
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: o.id } })).state).toBe('ISSUED')
    expect(await db.alert.count({ where: { ref: o.id, kind: ALERT_FAKTURA_WALUTA_SPRAWDZ } })).toBe(1)
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(30), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
  })

  it('b /: rozjazd samej kwoty (waluta i kurs zgodne): alert z obiema kwotami i walutą z wFirmy; 1 grosz przy jednej stawce mieści się w tolerancji', async () => {
    const o = await zamowienie('A395-KWOTA', 'CZK')
    const w = new WfirmaHttpAtrapa()
    w.totalPrzesuniecieGr = 5
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: o.id } })).state).toBe('ISSUED')
    const a = await db.alert.findFirstOrThrow({ where: { ref: o.id, kind: ALERT_FAKTURA_WALUTA_SPRAWDZ } })
    expect(a.message).toMatch(/do sprawdzenia w wFirmie: kwota brutto w wFirmie 957\.05 CZK, a wysłana 957\.00 CZK\./)
    expect(a.message).not.toMatch(/waluta faktury|brak kursu/)

    const o2 = await zamowienie('A395-GROSZ', 'CZK', { spakuj: true, goodId: '7103' })
    w.totalPrzesuniecieGr = 1
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
    expect(w.faktury).toHaveLength(2)
    expect(await db.alert.count({ where: { ref: o2.id, kind: ALERT_FAKTURA_WALUTA_SPRAWDZ } })).toBe(0)
    expect(await slad(o2.id, FAKTURA_WALUTA)).toHaveLength(1)
  })

  it('c: po niewiadomej („nie znaleziono” po 3 próbach find) nowa próba najpierw szuka i sprawdza walutę znalezionej, bez drugiej faktury', async () => {
    const o = await zamowienie('A395-NIEWIADOMA', 'CZK')
    const w = new WfirmaHttpAtrapa()
    w.nastepne = ['TIMEOUT_PO_ZAPISIE']
    w.findPuste = 3
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    for (const m of [2, 4, 8, 15]) await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(m), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    expect(w.ciala).toHaveLength(1)
    const proby = await db.invoiceAttempt.findMany({ where: { orderId: o.id }, orderBy: { attemptNo: 'asc' } })
    expect(proby).toHaveLength(2)
    expect(proby.filter((p) => p.state === 'ISSUED')).toHaveLength(1)
    expect(proby[1]).toMatchObject({ state: 'ISSUED', wfirmaDocId: w.faktury[0]!.id })
    expect(w.sciezki).toContain(`invoices/get/${w.faktury[0]!.id}`)
    expect((await slad(o.id, FAKTURA_WALUTA))[0]?.data).toMatchObject({ docId: w.faktury[0]!.id, waluta: 'CZK', kurs: 0.1745 })
  })

  it('nieczytelny kod waluty z kanału: odmowa z powodem przed żądaniem do wFirmy', async () => {
    const o = await zamowienie('A395-KOD', 'KORUNY')
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    expect(w.ciala).toHaveLength(0)
    const a = await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: o.id } })
    expect(a.state).toBe('FAILED')
    expect(a.lastError).toMatch(/Nieczytelny kod waluty zamówienia/)
  })

  it('KSeF (bezpiecznik bez drogi wFirmy) zostaje zablokowany także przy włączonym wyłączniku', async () => {
    const o = await zamowienie('A395-KSEF', 'CZK', { spakuj: false })
    expect(await blokadaFakturyWaluta(db, o)).toEqual({ waluta: 'CZK', powod: powodFakturyRecznej('CZK') })
    expect(await blokadaFakturyWaluta(db, o, { wfirma: true })).toBeNull()
  })
})

describe('wyłącznik wyłączony = blokada jak dotąd', () => {
  it.each([[undefined], [false]] as [boolean | undefined][])('walutaZamowienia=%s: CZK bez żądania do wFirmy, ślad i alert „wystaw ręcznie”', async (v) => {
    await ustawFirme(v)
    const o = await zamowienie('A395-WYL', 'CZK')
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    expect(w.ciala).toHaveLength(0)
    expect(await db.invoiceAttempt.count({ where: { orderId: o.id } })).toBe(0)
    expect(await slad(o.id, FAKTURA_OBCA_WALUTA)).toHaveLength(1)
    expect(await db.alert.count({ where: { ref: o.id, kind: 'FAKTURA_OBCA_WALUTA', closedAt: null } })).toBe(1)
  })
})

describe('zamówienie zatrzymane przed włączeniem', () => {
  it('po włączeniu kolejka go sama nie bierze; „Ponów fakturę” je wpuszcza i zamyka alert „wystaw ręcznie”', async () => {
    await ustawFirme(false)
    const o = await zamowienie('A395-STARE', 'CZK')
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    expect(await slad(o.id, FAKTURA_OBCA_WALUTA)).toHaveLength(1)

    await ustawFirme(true)
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
    expect(w.ciala).toHaveLength(0)

    await ponowFaktureRecznie(db, o.id, { now: min(3), actorId: 'test' })
    expect(await db.alert.count({ where: { ref: o.id, kind: 'FAKTURA_OBCA_WALUTA', closedAt: null } })).toBe(0)
    await expect(ponowFaktureRecznie(db, o.id, { now: min(3), actorId: 'test' })).rejects.toThrow('Ta faktura nie ma błędu do ponowienia')
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(4), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    expect(w.faktury[0]!.currency).toBe('CZK')
  })

  it('wyłącznik wyłączony: „Ponów fakturę” dalej odmawia z powodem', async () => {
    await ustawFirme(false)
    const o = await zamowienie('A395-ODMOWA', 'CZK')
    await runWfirmaQueue(db, { faktury: adapter(new WfirmaHttpAtrapa()) }, { now: min(1), tylkoPraca: true })
    await expect(ponowFaktureRecznie(db, o.id, { now: min(2), actorId: 'test' })).rejects.toThrow(powodFakturyRecznej('CZK'))
  })
})

describe('stan prowadzi Kompletor (dokument bez rozchodu)', () => {
  beforeEach(async () => {
    await db.warehouse.updateMany({ data: { stockSource: 'KOMPLETOR' } })
  })

  it('włączony: beginDocument startuje dla CZK; „Dokument przed wysyłką” czeka na dokument jak w PLN', async () => {
    await sys.organization.update({
      where: { id: ORG_A },
      data: { settings: { faktury: { kodyVat: { '23': 222, '8': 223, '5': 224, '0': 234 }, program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString(), walutaZamowienia: true, walutaZamowieniaOd: T0.toISOString(), przedWysylka: true } } as never },
    })
    const o = await zamowienie('A395-DOK', 'CZK')
    expect((await faktyPrzejscia(db, o)).dokumentWymagany).toBe(true)
    expect((await beginDocument(db, o.id, { now: min(1), statusy: ['SPAKOWANE'] })).outcome).toBe('START')
  })

  it('wyłączony: beginDocument = OBCA_WALUTA, „Dokument przed wysyłką” nie zatrzymuje CZK', async () => {
    await sys.organization.update({
      where: { id: ORG_A },
      data: { settings: { faktury: { kodyVat: { '23': 222 }, program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString(), przedWysylka: true } } as never },
    })
    const o = await zamowienie('A395-DOK2', 'CZK')
    expect((await faktyPrzejscia(db, o)).dokumentWymagany).toBe(false)
    expect((await beginDocument(db, o.id, { now: min(1), statusy: ['SPAKOWANE'] })).outcome).toBe('OBCA_WALUTA')
  })
})

describe('reguła „po chwili włączenia” w bezpieczniku', () => {
  it('CZK spakowane przed włączeniem, bez śladu: kolejka nie wystawia (ślad i alert raz); po „Ponów fakturę” jedna faktura', async () => {
    await ustawFirme(undefined)
    const o = await zamowienie('A395-W1-STARE', 'CZK')
    expect(await slad(o.id, FAKTURA_OBCA_WALUTA)).toHaveLength(0)
    await ustawFirme(true, await poSpakowaniu())
    expect(await walutaCzekaNaPonowienie(db, o)).toBe(true)
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
    expect(w.ciala).toHaveLength(0)
    expect(await db.invoiceAttempt.count({ where: { orderId: o.id } })).toBe(0)
    expect(await slad(o.id, FAKTURA_OBCA_WALUTA)).toHaveLength(1)
    const a = await db.alert.findFirstOrThrow({ where: { ref: o.id, kind: 'FAKTURA_OBCA_WALUTA', closedAt: null } })
    expect(a.message).toContain(tekstWalutaSprzedWlaczenia('CZK'))
    expect(tekstWalutaSprzedWlaczenia('CZK')).toContain('Wystawione ręcznie? Jeśli nie, kliknij „Ponów fakturę”')

    await ponowFaktureRecznie(db, o.id, { now: min(3), actorId: 'test' })
    expect(await walutaCzekaNaPonowienie(db, o)).toBe(false)
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(4), tylkoPraca: true })
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(5), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    expect(w.faktury[0]!.currency).toBe('CZK')
    expect(await db.invoiceAttempt.count({ where: { orderId: o.id } })).toBe(1)
  })

  it('bezpiecznik zatrzymuje też drogę z pominięciem filtra kolejki (bez śladu, przed włączeniem): issueInvoice po niewiadomej = OBCA_WALUTA', async () => {
    await ustawFirme(undefined)
    const o = await zamowienie('A395-W1-D2', 'CZK')
    await ustawFirme(true, await poSpakowaniu())
    const { issueInvoice } = await import('@/lib/rdzen/rozchod')
    const w = new WfirmaHttpAtrapa()
    expect(await issueInvoice(db, o.id, adapter(w), { now: min(1) })).toBe('OBCA_WALUTA')
    expect(w.sciezki).toEqual([])
  })

  it('CZK przyjęte przed włączeniem, spakowane po nim: czeka na „Ponów fakturę” (biuro mogło wystawić ręcznie przed spakowaniem)', async () => {
    await ustawFirme(undefined)
    const o = await zamowienie('A395-W1-PRZYJETE', 'CZK', { spakuj: false })
    await new Promise((r) => setTimeout(r, 30))
    await ustawFirme(true, new Date())
    await new Promise((r) => setTimeout(r, 30))
    await startPicking(db, o.id, { now: T0 })
    await finishPicking(db, o.id, { now: T0 })
    await packOrder(db, o.id, { now: T0 })
    expect(await walutaCzekaNaPonowienie(db, o)).toBe(true)
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
    expect(w.ciala).toHaveLength(0)
    expect(await db.invoiceAttempt.count({ where: { orderId: o.id } })).toBe(0)
    await ponowFaktureRecznie(db, o.id, { now: min(3), actorId: 'test' })
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(4), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
  })

  it('CZK spakowane po włączeniu: jedna faktura z automatu, bez „Ponów fakturę”', async () => {
    await ustawFirme(true, T0)
    const o = await zamowienie('A395-W1-NOWE', 'CZK')
    expect(await walutaCzekaNaPonowienie(db, o)).toBe(false)
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    expect(await db.invoiceAttempt.count({ where: { orderId: o.id } })).toBe(1)
    expect(await slad(o.id, FAKTURA_OBCA_WALUTA)).toHaveLength(0)
  })

  it('włączony bez chwili włączenia (ustawienia spoza ekranu): każde zamówienie w obcej walucie czeka na „Ponów fakturę”', async () => {
    await ustawFirme(true, T0)
    const fu = (await sys.organization.findUniqueOrThrow({ where: { id: ORG_A } })).settings as { faktury: Record<string, unknown> }
    delete fu.faktury['walutaZamowieniaOd']
    await sys.organization.update({ where: { id: ORG_A }, data: { settings: fu as never } })
    const o = await zamowienie('A395-W1-BEZOD', 'CZK')
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    expect(w.ciala).toHaveLength(0)
    expect(await walutaCzekaNaPonowienie(db, o)).toBe(true)
  })

  it('f: „Ponów fakturę” dwa razy i dwa przebiegi kolejki na tym samym zamówieniu sprzed włączenia = jedna próba', async () => {
    await ustawFirme(undefined)
    const o = await zamowienie('A395-W1-F', 'CZK')
    await ustawFirme(true, await poSpakowaniu())
    await ponowFaktureRecznie(db, o.id, { now: min(1), actorId: 'test' })
    await expect(ponowFaktureRecznie(db, o.id, { now: min(1), actorId: 'test' })).rejects.toThrow('Ta faktura nie ma błędu do ponowienia')
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
    await expect(ponowFaktureRecznie(db, o.id, { now: min(3), actorId: 'test' })).rejects.toThrow('Faktura jest już wystawiona')
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(4), tylkoPraca: true })
    expect(await db.invoiceAttempt.count({ where: { orderId: o.id } })).toBe(1)
    expect(w.faktury).toHaveLength(1)
    expect(await slad(o.id, FAKTURA_WALUTA_PONOWIONA)).toHaveLength(1)
  })

  it('zapis ekranu: chwila włączenia przy przejściu z wyłączonego na włączony, bez przesunięcia przy kolejnym zapisie, znika po wyłączeniu', async () => {
    const programy = programyDoWyboru(defaultRegistry().list())
    const form = (pola: Record<string, string>) => {
      const f = new FormData()
      for (const [k, v] of Object.entries({ program: 'wfirma', wystawiajPrzy: 'SPAKOWANE', rodzaj: 'faktura', wysylkaStawka: '23', fakturyWlaczonePole: 'tak', fakturyWlaczone: 'tak', walutaZamowieniaPole: 'tak', ...pola })) f.set(k, v)
      return dokumentyZFormularza(f)
    }
    const faktury = async () => ((await sys.organization.findUniqueOrThrow({ where: { id: ORG_A } })).settings as { faktury: Record<string, unknown> }).faktury
    await zapiszUstawieniaDokumentow(db, form({}), 'u1', programy, { now: min(1) })
    expect(await faktury()).not.toHaveProperty('walutaZamowieniaOd')
    await zapiszUstawieniaDokumentow(db, form({ walutaZamowienia: 'tak' }), 'u1', programy, { now: min(2) })
    expect(await faktury()).toMatchObject({ walutaZamowienia: true, walutaZamowieniaOd: min(2).toISOString() })
    await zapiszUstawieniaDokumentow(db, form({ walutaZamowienia: 'tak' }), 'u1', programy, { now: min(5) })
    expect((await faktury())['walutaZamowieniaOd']).toBe(min(2).toISOString())
    await zapiszUstawieniaDokumentow(db, form({}), 'u1', programy, { now: min(6) })
    expect(await faktury()).toMatchObject({ walutaZamowienia: false })
    expect(await faktury()).not.toHaveProperty('walutaZamowieniaOd')
    await zapiszUstawieniaDokumentow(db, form({ walutaZamowienia: 'tak' }), 'u1', programy, { now: min(7) })
    expect((await faktury())['walutaZamowieniaOd']).toBe(min(7).toISOString())
  })
})

describe('liczy się najnowszy ślad', () => {
  it('włączony → „Ponów fakturę” → wyłączony przed wystawieniem: nowa blokada, bez pętli; po ponownym włączeniu znów „Ponów fakturę”', async () => {
    await ustawFirme(false)
    const o = await zamowienie('A395-D1', 'CZK')
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    expect(await slad(o.id, FAKTURA_OBCA_WALUTA)).toHaveLength(1)

    await ustawFirme(true, await poSpakowaniu())
    await ponowFaktureRecznie(db, o.id, { now: min(2), actorId: 'test' })
    expect(await walutaZatrzymana(db, o.id)).toBe(false)

    await ustawFirme(false)
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(3), tylkoPraca: true })
    expect(await slad(o.id, FAKTURA_OBCA_WALUTA)).toHaveLength(2)
    expect(await walutaZatrzymana(db, o.id)).toBe(true)
    expect(await db.alert.count({ where: { ref: o.id, kind: 'FAKTURA_OBCA_WALUTA', closedAt: null } })).toBe(1)
    // kolejne przebiegi nie biorą go znowu (bez nowych śladów)
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(4), tylkoPraca: true })
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(5), tylkoPraca: true })
    expect(await slad(o.id, FAKTURA_OBCA_WALUTA)).toHaveLength(2)
    expect(w.ciala).toHaveLength(0)

    await ustawFirme(true, await poSpakowaniu())
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(6), tylkoPraca: true })
    expect(w.ciala).toHaveLength(0)
    await ponowFaktureRecznie(db, o.id, { now: min(7), actorId: 'test' })
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(8), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    expect(await db.invoiceAttempt.count({ where: { orderId: o.id } })).toBe(1)
  })
})
