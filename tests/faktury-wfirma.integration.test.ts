// wystawianie faktur w wFirmie z Kompletora — cały tor: kolejka wFirmy → adapter zapisu (treść
// `zlozFakture`, kontrola zgodności z paczką) → klient zapisu `WfirmaZapis` → atrapa HTTP wFirmy (tests/wfirma-http-atrapa.ts,
// zero połączeń z siecią, zero prawdziwych faktur). Ścieżka ACME (lustro wFirmy, rozchód fakturą z WZ), timeout
// rozstrzygany przez find bez drugiej faktury, błąd faktury z alertem i „Ponów fakturę”, konta w podglądzie poza
// wystawianiem, (faktura z rozchodem tylko przy źródle WFIRMA), dokument bez rozchodu przy źródle Kompletor
// z „wystawiaj przy” i „tylko na żądanie”, PDF. Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderRecipient } from '@/lib/adaptery/kontrakt'
import { DEFAULT_CHANNEL_ADAPTER } from '@/lib/adaptery'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { pdfFakturyZamowienia } from '@/lib/dokumenty/pdf'
import { dokumentyZFormularza, programyDoWyboru, UstawieniaDokumentowError, zapiszUstawieniaDokumentow } from '@/lib/dokumenty/zapis'
import { ustawieniaDokumentowFirmy } from '@/lib/dokumenty/firma'
import { runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { finishPicking, markShipped, readyForDispatch, startPicking } from '@/lib/rdzen/przejscia'
import { flagsOf } from '@/lib/rdzen/rezerwacja'
import { issueInvoice, MAX_INVOICE_ATTEMPTS, packOrder, PackError, ponowFaktureRecznie } from '@/lib/rdzen/rozchod'
import { splitOrder } from '@/lib/rdzen/edycja'
import { cancelOrder } from '@/lib/rdzen/zamowienia'
import { dziennikPodgladow } from '@/lib/klienci/odczyt'
import { widokDokumentow } from '@/lib/dokumenty/zapis'
import { kwotaPaczkiDodatkowej } from '@/lib/wfirma/adapter-zapis'
import { maskujDane } from '@/lib/zrodla/wfirma-zapis'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { FakturyWfirmaZapis } from '@/lib/wfirma/adapter-zapis'
import { WfirmaReadOnly } from '@/lib/zrodla/wfirma'
import { WfirmaZapis } from '@/lib/zrodla/wfirma-zapis'
import { testDb, testSystemDb, truncateAll } from './db'
import { ACC, expectInvariants, order, product, seedBase, stockOf, T0, type TestChannel } from './rdzen-fixtures'
import { KLUCZE_TESTOWE, WfirmaHttpAtrapa } from './wfirma-http-atrapa'

const db = testDb()
afterAll(() => db.$disconnect())

// trasa PDF: sesja z panelu podstawiona, bez cookies i bez sieci
vi.mock('server-only', () => ({}))
const sesja: { permissions: Set<string> } = { permissions: new Set() }
vi.mock('@/lib/stanowisko/sesja-api', () => ({
  requirePermissionApi: async () => ({ db, permissions: sesja.permissions, user: { id: 'u-trasa', name: 'Trasa' } }),
}))

const KODY_VAT = { '23': 222, '8': 223, '5': 224, '0': 234 }

const ODBIORCA: OrderRecipient = {
  dostawa: { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'Testowa', numerDomu: '1', numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: null, email: null },
  punktOdbioru: null,
  faktura: null,
  problemy: [],
}

function adapter(atrapa: WfirmaHttpAtrapa, odbiorca: OrderRecipient | null | ((orderId: string) => OrderRecipient | null) = ODBIORCA) {
  return new FakturyWfirmaZapis(new WfirmaReadOnly(KLUCZE_TESTOWE, atrapa.fetch, 0), db, { zapis: new WfirmaZapis(KLUCZE_TESTOWE, atrapa.fetch, 0), odbiorca: async (id) => (typeof odbiorca === 'function' ? odbiorca(id) : odbiorca) })
}

async function ustawFaktury(faktury: Record<string, unknown>): Promise<void> {
  await testSystemDb().organization.update({ where: { id: 'test_a' }, data: { settings: { faktury: { kodyVat: KODY_VAT, ...faktury } } as never } })
}

async function praca(labels: TestChannel[]): Promise<void> {
  for (const l of labels) await db.channelConfig.updateMany({ where: ACC[l], data: { statusMode: 'PRACA' } })
}

async function spakowane(lines: { productId: string; qty: number; unitPriceGross?: number }[], over: Parameters<typeof order>[1] = {}, now = T0): Promise<string> {
  const r = await ingestOrder(db, order(lines, over), { now })
  expect(r.status).toBe('DO_REALIZACJI')
  await startPicking(db, r.orderId!, { now })
  await finishPicking(db, r.orderId!, { now })
  await packOrder(db, r.orderId!, { now })
  return r.orderId!
}

const min = (m: number) => new Date(T0.getTime() + m * 60_000)

beforeEach(async () => {
  await truncateAll(db)
})

describe('ścieżka ACME: lustro wFirmy, faktura z rozchodem przez wFirmę', () => {
  beforeEach(async () => {
    await seedBase(db)
    await praca(['WOO_SD'])
    await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() })
  })

  it('spakowane → invoices/add → faktura ISSUED z numerem, WZ rozliczony, potem „Do wysyłki”', async () => {
    const tea = await product(db, 'HERB-A133', 5, { wfirmaGoodId: '7001' })
    const id = await spakowane([{ productId: tea, qty: 2 }], { totalGross: 32.99 })
    const w = new WfirmaHttpAtrapa()
    const st = await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    expect(st.invoices).toBe(1)
    expect(w.faktury).toHaveLength(1)
    const f = w.faktury[0]!
    expect(f.idExternal).toBe(`${id}/1/1`)
    expect(f.paymentmethod).toBe('transfer')
    expect(f.pozycje).toEqual([
      { goodId: 7001, count: 2, price: '10.00', name: 'Towar testowy HERB-A133', vat: 222 },
      { goodId: 0, count: 1, price: '12.99', name: 'Wysyłka', vat: 222 },
    ])
    // kontrahent z dostawy (konsument bez danych do faktury), bez NIP
    expect(f.contractor).toMatchObject({ name: 'Jan Testowy', tax_id_type: 'none', street: 'Testowa 1', zip: '00-001', city: 'Testowo' })
    const a = await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })
    expect(a).toMatchObject({ state: 'ISSUED', wfirmaDocId: f.id, number: f.fullnumber, documentOnly: false })
    expect(await db.pendingMovement.findMany({ where: { orderId: id }, select: { state: true, wzQty: true, delta: true } })).toEqual([{ state: 'APPLIED', wzQty: 2, delta: -2 }])
    expect(await stockOf(db, tea)).toMatchObject({ physical: 3, reserved: 0, pendingDelta: -2 })
    expect(await readyForDispatch(db, id, { now: min(2) })).toBe('DO_WYSLANIA')
    expect(w.sciezki.filter((p) => p === 'invoices/add')).toHaveLength(1)
    await expectInvariants(db)
  })

  it('timeout po zapisie: find znajduje fakturę, drugiej nie ma; numer z find', async () => {
    const tea = await product(db, 'HERB-A133-T', 5, { wfirmaGoodId: '7002' })
    const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 })
    const w = new WfirmaHttpAtrapa()
    w.nastepne = ['TIMEOUT_PO_ZAPISIE']
    const ad = adapter(w)
    await runWfirmaQueue(db, { faktury: ad }, { now: min(1), tylkoPraca: true })
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).state).toBe('UNKNOWN')
    // kolejne przebiegi: find po 30 s rozstrzyga — bez drugiego invoices/add
    for (const m of [2, 4, 8]) await runWfirmaQueue(db, { faktury: ad }, { now: min(m), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    expect(w.sciezki.filter((p) => p === 'invoices/add')).toHaveLength(1)
    const a = await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })
    expect(a).toMatchObject({ state: 'ISSUED', wfirmaDocId: w.faktury[0]!.id, number: w.faktury[0]!.fullnumber })
    expect(await db.invoiceAttempt.count({ where: { orderId: id } })).toBe(1)
    await expectInvariants(db)
  })

  it('HTTP 500 i odpowiedź bez wyniku = niewiadoma (find), nie błąd i nie druga faktura', async () => {
    const tea = await product(db, 'HERB-A133-5', 5, { wfirmaGoodId: '7003' })
    const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 })
    const w = new WfirmaHttpAtrapa()
    w.nastepne = ['HTTP500']
    const ad = adapter(w)
    await runWfirmaQueue(db, { faktury: ad }, { now: min(1), tylkoPraca: true })
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).state).toBe('UNKNOWN')
    // find po 30 s, 2 min, 5 min nic nie znajduje → nowa próba z kolejnym numerem (dokument na pewno nie powstał)
    for (const m of [2, 4, 8, 14]) await runWfirmaQueue(db, { faktury: ad }, { now: min(m), tylkoPraca: true })
    const proby = await db.invoiceAttempt.findMany({ where: { orderId: id }, orderBy: { attemptNo: 'asc' } })
    expect(proby.map((p) => [p.attemptNo, p.state])).toEqual([
      [1, 'FAILED'],
      [2, 'ISSUED'],
    ])
    expect(w.faktury.map((f) => f.idExternal)).toEqual([`${id}/1/2`])
    await expectInvariants(db)
  })

  it('błąd wFirmy: alert, flaga, „Ponów fakturę” zaczyna nową serię prób i faktura wychodzi', async () => {
    const tea = await product(db, 'HERB-A133-E', 5, { wfirmaGoodId: '7004' })
    const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 })
    const w = new WfirmaHttpAtrapa()
    w.nastepne = ['BLAD']
    const ad = adapter(w)
    await runWfirmaQueue(db, { faktury: ad }, { now: min(1), tylkoPraca: true })
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    expect(flagsOf(o).fakturaBlad).toBe(true)
    const a = await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })
    expect(a.state).toBe('FAILED')
    expect(a.lastError).toContain('contractor: Pole wymagane')
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BLAD', ref: id, closedAt: null } })).toBe(1)
    // bez ponowienia kolejka nie próbuje sama
    await runWfirmaQueue(db, { faktury: ad }, { now: min(3), tylkoPraca: true })
    expect(w.sciezki.filter((p) => p === 'invoices/add')).toHaveLength(1)

    await ponowFaktureRecznie(db, id, { now: min(4), actorId: 'u-biuro' })
    expect(await db.alert.count({ where: { kind: 'FAKTURA_BLAD', ref: id, closedAt: null } })).toBe(0)
    expect(await db.orderEvent.count({ where: { orderId: id, kind: 'FAKTURA_PONOWIONA', actorId: 'u-biuro' } })).toBe(1)
    await runWfirmaQueue(db, { faktury: ad }, { now: min(5), tylkoPraca: true })
    expect(await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id, attemptNo: 2 } })).toMatchObject({ state: 'ISSUED' })
    // druga „Ponów” po wystawieniu = odmowa
    await expect(ponowFaktureRecznie(db, id, { now: min(6) })).rejects.toThrow(PackError)
    await expectInvariants(db)
  })

  it('limit prób, potem „Ponów”: stare próby nie liczą się do limitu', async () => {
    const tea = await product(db, 'HERB-A133-L', 5, { wfirmaGoodId: '7005' })
    const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 })
    const w = new WfirmaHttpAtrapa()
    const ad = adapter(w)
    for (let i = 0; i < MAX_INVOICE_ATTEMPTS; i++) {
      w.nastepne = ['BLAD']
      await issueInvoice(db, id, ad, { now: min(1 + i) })
      if (i < MAX_INVOICE_ATTEMPTS - 1) await ponowFaktureRecznie(db, id, { now: min(1 + i) })
    }
    // trzy nieudane, ale każda po ponowieniu — nowa seria: czwarta próba idzie
    await ponowFaktureRecznie(db, id, { now: min(10) })
    expect(await issueInvoice(db, id, ad, { now: min(11) })).toBe('WYSTAWIONA')
  })

  it('brak danych nabywcy: błąd jednoznaczny bez wywołania wFirmy', async () => {
    const tea = await product(db, 'HERB-A133-N', 5, { wfirmaGoodId: '7008' })
    const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10, wantInvoiceNip: true })
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    expect(w.sciezki).not.toContain('invoices/add')
    expect((await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).lastError).toBe('Brak danych nabywcy do faktury: faktura')
    // rozchód cofnięty: rezerwacje wróciły, stan bez zmian
    expect(await stockOf(db, tea)).toMatchObject({ physical: 5, reserved: 1, pendingDelta: 0 })
    await expectInvariants(db)
  })

  it('konto w podglądzie (BaseLinker wystawia): bez faktury z Kompletora', async () => {
    const tea = await product(db, 'HERB-A133-C', 5, { wfirmaGoodId: '7009' })
    const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10, channel: 'ALLEGRO' })
    const w = new WfirmaHttpAtrapa()
    const st = await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    expect(st.invoices).toBe(0)
    expect(w.sciezki).toEqual([])
    expect(await db.invoiceAttempt.count({ where: { orderId: id } })).toBe(0)
  })

  it('PDF faktury z karty: invoices/download, plik nie trafia do bazy', async () => {
    const tea = await product(db, 'HERB-A133-P', 5, { wfirmaGoodId: '7010' })
    const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 })
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    const env = { WFIRMA_ACCESS_KEY: 'a', WFIRMA_SECRET_KEY: 's', WFIRMA_APP_KEY: 'p', WFIRMA_COMPANY_ID: '999' }
    const pdf = await pdfFakturyZamowienia(db, id, { secrets: { env, envFallback: true }, fetch: w.fetch, actorId: 'u-biuro' })
    expect(new TextDecoder().decode(pdf.bytes)).toMatch(/^%PDF-/)
    expect(pdf.nazwaPliku).toBe(`faktura-FV-1-11-2026.pdf`)
    expect(w.sciezki.at(-1)).toBe(`invoices/download/${w.faktury[0]!.id}`)
  })
})

describe('faktura z rozchodem tylko przy źródle WFIRMA', () => {
  it('magazyn z id wFirmy, ale źródło KOMPLETOR: beginInvoice odmawia, zero wywołań', async () => {
    await seedBase(db)
    await praca(['WOO_SD'])
    const tea = await product(db, 'HERB-A133-D', 5, { wfirmaGoodId: '7011' })
    const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 })
    await db.warehouse.updateMany({ where: { id: DEFAULT_WAREHOUSE }, data: { stockSource: 'KOMPLETOR' } })
    const w = new WfirmaHttpAtrapa()
    expect(await issueInvoice(db, id, adapter(w), { now: min(1) })).toBe('INNE_ZRODLO')
    expect(w.sciezki).toEqual([])
    expect(await db.invoiceAttempt.count()).toBe(0)
  })
})

describe('magazyn prowadzony przez Kompletor, faktury w wFirmie: dokument bez rozchodu', () => {
  beforeEach(async () => {
    await db.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Główny (test, Kompletor)', stockSource: 'KOMPLETOR' } })
    const labels: TestChannel[] = ['WOO_SD', 'ALLEGRO', 'RECZNE']
    await db.channelConfig.createMany({ data: labels.map((l) => ({ ...ACC[l], name: `${l} test`, adapterKey: DEFAULT_CHANNEL_ADAPTER[ACC[l].channel], statusMode: 'PRACA' as const })) })
  })

  it('„przy Do wysyłki”: spakowane czeka, po „Do wysyłki” dokument bez ruchu stanu; towar bez powiązania z wFirmą po nazwie', async () => {
    await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString(), wystawiajPrzy: 'DO_WYSLANIA' })
    const tea = await product(db, 'HERB-A133-K', 5)
    const id = await spakowane([{ productId: tea, qty: 2 }], { totalGross: 25 }, min(1))
    const w = new WfirmaHttpAtrapa()
    const ad = adapter(w)
    expect((await runWfirmaQueue(db, { faktury: ad }, { now: min(2), tylkoPraca: true })).documents).toBe(0)
    expect(w.sciezki).toEqual([])
    expect(await readyForDispatch(db, id, { now: min(3) })).toBe('DO_WYSLANIA')
    expect(await stockOf(db, tea)).toMatchObject({ physical: 3, reserved: 0 })
    const st = await runWfirmaQueue(db, { faktury: ad }, { now: min(4), tylkoPraca: true })
    expect(st.documents).toBe(1)
    expect(w.faktury[0]!.pozycje[0]).toMatchObject({ goodId: 0, count: 2, name: 'Towar testowy HERB-A133-K' })
    expect(await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ state: 'ISSUED', documentOnly: true, number: w.faktury[0]!.fullnumber })
    // bez ruchów wFirmy, bez odczytów, stan bez zmian po fakturze
    expect(await db.pendingMovement.count()).toBe(0)
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ' } })).toBe(0)
    expect(await stockOf(db, tea)).toMatchObject({ physical: 3, reserved: 0 })
    expect(w.sciezki).not.toContain('warehouse_documents/find')
    // kolejny przebieg i wysłane: bez drugiego dokumentu
    await markShipped(db, id, { now: min(5) })
    await runWfirmaQueue(db, { faktury: ad }, { now: min(6), tylkoPraca: true })
    expect(w.faktury).toHaveLength(1)
    await expectInvariants(db)
  })

  it('„tylko na żądanie”: zamówienie bez prośby o fakturę zostaje bez dokumentu', async () => {
    await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString(), wystawiajPrzy: 'SPAKOWANE', tylkoNaZadanie: true })
    const tea = await product(db, 'HERB-A133-Z', 5)
    const bez = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 }, min(1))
    const z = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10, wantInvoiceNip: true }, min(1))
    const w = new WfirmaHttpAtrapa()
    const nabywca: OrderRecipient = { ...ODBIORCA, faktura: { nazwa: 'Firma Testowa Sp. z o.o.', nip: '0000000000', ulica: 'Biurowa 2', kodPocztowy: '00-002', miasto: 'Testowo', kraj: 'PL' } }
    await runWfirmaQueue(db, { faktury: adapter(w, nabywca) }, { now: min(2), tylkoPraca: true })
    expect(await db.invoiceAttempt.count({ where: { orderId: bez } })).toBe(0)
    expect(await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: z } })).toMatchObject({ state: 'ISSUED', documentOnly: true })
    expect(w.faktury[0]!.contractor).toMatchObject({ name: 'Firma Testowa Sp. z o.o.', nip: '0000000000', tax_id_type: 'nip' })
  })

  it('zamówienie spakowane przed włączeniem: bez zaległej faktury', async () => {
    // zdarzenia statusu mają czas bazy (now()), więc chwila włączenia „po spakowaniu” = przyszłość względem zegara bazy
    await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: new Date(Date.now() + 3600_000).toISOString(), wystawiajPrzy: 'SPAKOWANE' })
    const tea = await product(db, 'HERB-A133-S', 5)
    const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 }, min(1))
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(11), tylkoPraca: true })
    expect(await db.invoiceAttempt.count({ where: { orderId: id } })).toBe(0)
  })

  it('wystawianie wyłączone albo program „brak”: kolejka nic nie wysyła', async () => {
    const tea = await product(db, 'HERB-A133-W', 5)
    await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 }, min(1))
    const w = new WfirmaHttpAtrapa()
    for (const f of [{ program: 'wfirma', fakturyWlaczone: false }, { program: 'brak', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() }]) {
      await ustawFaktury(f)
      await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
    }
    expect(w.sciezki).toEqual([])
  })
})

describe('Ustawienia → Dokumenty sprzedaży: wyłącznik „Wystawiaj faktury z Kompletora”', () => {
  beforeEach(async () => {
    await seedBase(db)
  })

  const form = (pola: Record<string, string>) => {
    const f = new FormData()
    for (const [k, v] of Object.entries({ program: 'wfirma', wystawiajPrzy: 'SPAKOWANE', rodzaj: 'faktura', wysylkaStawka: '23', fakturyWlaczonePole: 'tak', ...pola })) f.set(k, v)
    return dokumentyZFormularza(f)
  }

  it('włączenie zapisuje chwilę i AuditLog; ponowny zapis nie przesuwa chwili; wyłączenie ją zdejmuje', async () => {
    const programy = programyDoWyboru(defaultRegistry().list())
    await zapiszUstawieniaDokumentow(db, form({ fakturyWlaczone: 'tak' }), 'u1', programy, { now: min(1) })
    let u = await ustawieniaDokumentowFirmy(db)
    expect(u).toMatchObject({ fakturyWlaczone: true, fakturyWlaczoneOd: min(1).toISOString() })
    await zapiszUstawieniaDokumentow(db, form({ fakturyWlaczone: 'tak' }), 'u1', programy, { now: min(5) })
    expect((await ustawieniaDokumentowFirmy(db)).fakturyWlaczoneOd).toBe(min(1).toISOString())
    await zapiszUstawieniaDokumentow(db, form({}), 'u1', programy, { now: min(6) })
    u = await ustawieniaDokumentowFirmy(db)
    expect(u).toMatchObject({ fakturyWlaczone: false, fakturyWlaczoneOd: null })
    expect(await db.auditLog.count({ where: { entity: 'Organization.faktury' } })).toBe(2)
  })

  it('formularz bez pola wyłącznika (starszy ekran) nie zmienia go', async () => {
    const programy = programyDoWyboru(defaultRegistry().list())
    await zapiszUstawieniaDokumentow(db, form({ fakturyWlaczone: 'tak' }), 'u1', programy, { now: min(1) })
    const f = new FormData()
    for (const [k, v] of Object.entries({ program: 'wfirma', wystawiajPrzy: 'SPAKOWANE', rodzaj: 'faktura', wysylkaStawka: '8' })) f.set(k, v)
    await zapiszUstawieniaDokumentow(db, dokumentyZFormularza(f), 'u1', programy, { now: min(2) })
    expect((await ustawieniaDokumentowFirmy(db)).fakturyWlaczone).toBe(true)
  })

  it('włączenie przy programie innym niż wFirma = odmowa', async () => {
    await db.warehouse.updateMany({ where: { id: DEFAULT_WAREHOUSE }, data: { stockSource: 'KOMPLETOR' } })
    await expect(zapiszUstawieniaDokumentow(db, form({ program: 'ksef', fakturyWlaczone: 'tak' }), 'u1', programyDoWyboru(defaultRegistry().list()))).rejects.toBeInstanceOf(UstawieniaDokumentowError)
  })
})

describe('porównanie z BL na 30 zamówieniach (treść wysłana do wFirmy = treść porównywana z BL)', () => {
  beforeEach(async () => {
    await seedBase(db)
    await praca(['WOO_SD', 'ALLEGRO'])
    await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() })
  })

  it('30 zamówień: ilości 1–5, ceny z groszami, 23% i 8%, wysyłka, pobranie; faktury zgodne z fakturą BL co do grosza', async () => {
    const przyprawa = await product(db, 'HERB-30-A', 500, { wfirmaGoodId: '8001', vatRate: '5' })
    const kubek = await product(db, 'KUB-30-B', 500, { wfirmaGoodId: '8002', vatRate: '23' })
    const kawa = await product(db, 'KAWA-30-C', 500, { wfirmaGoodId: '8003', vatRate: '8' })
    await testSystemDb().organization.update({ where: { id: 'test_a' }, data: { settings: { faktury: { kodyVat: KODY_VAT, program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() } } as never } })
    const ceny = [12.99, 7.33, 19.9, 4.01, 31.5]
    const ids: { id: string; linie: { productId: string; qty: number; unitPriceGross: number; vat: string }[]; total: number; cod: boolean }[] = []
    for (let i = 0; i < 30; i++) {
      const linie = [
        { productId: przyprawa, qty: 1 + (i % 5), unitPriceGross: ceny[i % 5]!, vat: '5' },
        ...(i % 3 === 0 ? [{ productId: kubek, qty: 1 + (i % 2), unitPriceGross: ceny[(i + 2) % 5]!, vat: '23' }] : []),
        ...(i % 4 === 1 ? [{ productId: kawa, qty: 2, unitPriceGross: ceny[(i + 1) % 5]!, vat: '8' }] : []),
      ]
      const pozycje = linie.reduce((s, l) => s + Math.round(l.qty * l.unitPriceGross * 100), 0)
      const wysylka = [0, 999, 1299, 1650][i % 4]!
      const cod = i % 7 === 3
      const total = (pozycje + wysylka) / 100
      const id = await spakowane(
        linie.map(({ vat: _v, ...l }) => l),
        { totalGross: total, channel: i % 2 ? 'ALLEGRO' : 'WOO_SD', ...(cod ? { paymentState: 'COD' as const, paymentMethod: 'Za pobraniem' } : {}) },
      )
      ids.push({ id, linie, total, cod })
    }
    const w = new WfirmaHttpAtrapa()
    const ad = adapter(w)
    for (let m = 1; m < 10 && (await db.invoiceAttempt.count({ where: { state: 'ISSUED' } })) < 30; m++) await runWfirmaQueue(db, { faktury: ad }, { now: min(m), tylkoPraca: true })
    expect(await db.invoiceAttempt.count({ where: { state: 'ISSUED' } })).toBe(30)
    expect(w.faktury).toHaveLength(30)

    const { zlozFakture, nettoGr } = await import('@/lib/wfirma/faktura')
    const { porownajFakture } = await import('@/lib/wfirma/porownanie')
    const { parseKonfiguracjaFaktur } = await import('@/lib/wfirma/konfiguracja')
    const { pozycjeZamowienia } = await import('@/lib/wfirma/podglad')
    const cfg = parseKonfiguracjaFaktur((await db.organization.findFirstOrThrow({ select: { settings: true } })).settings)
    const sku = new Map((await db.product.findMany({ include: { bundleComponents: true } })).map((p) => [p.id, p]))
    const wyniki: string[] = []
    for (const z of ids) {
      const o = await db.order.findUniqueOrThrow({ where: { id: z.id }, include: { lines: true } })
      const f = w.faktury.find((x) => x.idExternal.startsWith(`${z.id}/1/`))!
      // faktura BL tego zamówienia: pozycja = ilość × cena, wysyłka = reszta kwoty zamówienia, forma z płatności
      const blPoz = z.linie.map((l) => ({ sku: sku.get(l.productId)!.sku, qty: l.qty, bruttoGr: Math.round(l.qty * l.unitPriceGross * 100), stawkaVat: l.vat, wysylka: false }))
      const wys = Math.round(z.total * 100) - blPoz.reduce((s, p) => s + p.bruttoGr, 0)
      if (wys) blPoz.push({ sku: null as never, qty: 1, bruttoGr: wys, stawkaVat: '23', wysylka: true })
      const blFv = { pozycje: blPoz, bruttoGr: Math.round(z.total * 100), nettoGr: nettoGr(blPoz.map((p) => ({ bruttoGr: p.bruttoGr, stawkaVat: p.stawkaVat }))), forma: z.cod ? ('cod' as const) : ('transfer' as const) }
      const nasza = zlozFakture({ idExternal: f.idExternal, totalGross: Number(o.totalGross), paymentMethod: o.paymentMethod, paymentState: o.paymentState, pozycje: pozycjeZamowienia(o, sku, new Map()), konfiguracja: cfg })
      const p = porownajFakture(nasza, blFv)
      if (p.wynik !== 'ZGODNA') wyniki.push(`${z.id}: ${JSON.stringify(p.roznice)}`)
      // to, co poszło do wFirmy, to dokładnie ta treść: suma pozycji co do grosza i forma płatności
      const wyslane = f.pozycje.reduce((s, x) => s + Math.round(Number(x.price) * 100 * x.count), 0)
      if (wyslane !== nasza.bruttoGr || f.paymentmethod !== nasza.forma) wyniki.push(`${z.id}: wysłane ${wyslane} gr / ${f.paymentmethod}, złożone ${nasza.bruttoGr} gr / ${nasza.forma}`)
    }
    expect(wyniki).toEqual([])
    await expectInvariants(db)
  })
})

describe('poprawki z przeglądu', () => {
  describe('anulowanie w trakcie dokumentu bez rozchodu (stan prowadzi Kompletor)', () => {
    beforeEach(async () => {
      await db.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Główny (test, Kompletor)', stockSource: 'KOMPLETOR' } })
      await db.channelConfig.createMany({ data: (['WOO_SD'] as TestChannel[]).map((l) => ({ ...ACC[l], name: `${l} test`, adapterKey: DEFAULT_CHANNEL_ADAPTER[ACC[l].channel], statusMode: 'PRACA' as const })) })
      await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString(), wystawiajPrzy: 'SPAKOWANE' })
    })

    it('dokument wszedł po anulowaniu: rezerwacje zwolnione od razu, potem ISSUED z „do korekty” i alertem', async () => {
      const tea = await product(db, 'HERB-W1-A', 5)
      const id = await spakowane([{ productId: tea, qty: 2 }], { totalGross: 25 }, min(1))
      const w = new WfirmaHttpAtrapa()
      w.nastepne = ['TIMEOUT_PO_ZAPISIE']
      const ad = adapter(w)
      await runWfirmaQueue(db, { faktury: ad }, { now: min(2), tylkoPraca: true })
      expect(await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ state: 'UNKNOWN', documentOnly: true })
      // anulowanie nie czeka na dokument: towar wraca od razu
      expect(await cancelOrder(db, id, { now: min(3) })).toBe('ANULOWANE')
      expect(await stockOf(db, tea)).toMatchObject({ physical: 5, reserved: 0 })
      expect((await db.order.findUniqueOrThrow({ where: { id } })).pendingAction).toBeNull()
      // find rozstrzyga: faktura jest → ISSUED, zamówienie do korekty z alertem, bez drugiego invoices/add
      for (const m of [4, 6, 10]) await runWfirmaQueue(db, { faktury: ad }, { now: min(m), tylkoPraca: true })
      expect(await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ state: 'ISSUED', wfirmaDocId: w.faktury[0]!.id })
      const o = await db.order.findUniqueOrThrow({ where: { id } })
      expect(o.status).toBe('ANULOWANE')
      expect(flagsOf(o).doKorekty).toBe(true)
      expect(await db.alert.count({ where: { kind: 'FAKTURA_DO_KOREKTY', ref: id, closedAt: null } })).toBe(1)
      expect(w.sciezki.filter((p) => p === 'invoices/add')).toHaveLength(1)
      expect(await stockOf(db, tea)).toMatchObject({ physical: 5, reserved: 0 })
      await expectInvariants(db)
    })

    it('dokument nie powstał (find pusty ×3) po anulowaniu: bez flagi błędu, bez alertu i bez nowej próby', async () => {
      const tea = await product(db, 'HERB-W1-B', 5)
      const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 }, min(1))
      const w = new WfirmaHttpAtrapa()
      w.nastepne = ['TIMEOUT_BEZ_ZAPISU']
      const ad = adapter(w)
      await runWfirmaQueue(db, { faktury: ad }, { now: min(2), tylkoPraca: true })
      await cancelOrder(db, id, { now: min(3) })
      for (const m of [4, 6, 10, 16]) await runWfirmaQueue(db, { faktury: ad }, { now: min(m), tylkoPraca: true })
      expect((await db.invoiceAttempt.findMany({ where: { orderId: id } })).map((a) => a.state)).toEqual(['FAILED'])
      const o = await db.order.findUniqueOrThrow({ where: { id } })
      expect(o.status).toBe('ANULOWANE')
      expect(flagsOf(o).fakturaBlad).toBeFalsy()
      expect(await db.alert.count({ where: { kind: 'FAKTURA_BLAD', ref: id, closedAt: null } })).toBe(0)
      expect(w.sciezki.filter((p) => p === 'invoices/add')).toHaveLength(1)
      expect(await stockOf(db, tea)).toMatchObject({ physical: 5, reserved: 0 })
      await expectInvariants(db)
    })
  })

  describe('przy stanie z wFirmy (ACME)', () => {
    beforeEach(async () => {
      await seedBase(db)
      await praca(['WOO_SD'])
    })

    it('druga paczka z podziału dostaje fakturę na swoje pozycje, nabywca z zamówienia głównego', async () => {
      await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() })
      const a = await product(db, 'HERB-W2-A', 5, { wfirmaGoodId: '7101' })
      const b = await product(db, 'HERB-W2-B', 5, { wfirmaGoodId: '7102' })
      // 2 × 10,00 + 1 × 7,50 + wysyłka 12,99
      const r = await ingestOrder(db, order([{ productId: a, qty: 2 }, { productId: b, qty: 1, unitPriceGross: 7.5 }], { totalGross: 40.49 }), { now: T0 })
      const id = r.orderId!
      const lb = (await db.orderLine.findFirstOrThrow({ where: { orderId: id, productId: b } })).id
      const { childOrderId } = await splitOrder(db, id, { [lb]: 1 }, { now: T0 })
      for (const x of [id, childOrderId]) {
        await startPicking(db, x, { now: T0 })
        await finishPicking(db, x, { now: T0 })
        await packOrder(db, x, { now: T0 })
      }
      const zapytane: string[] = []
      const w = new WfirmaHttpAtrapa()
      // rekord klienta istnieje tylko dla zamówienia głównego
      const ad = adapter(w, (oid) => {
        zapytane.push(oid)
        return oid === id ? ODBIORCA : null
      })
      await runWfirmaQueue(db, { faktury: ad }, { now: min(1), tylkoPraca: true })
      expect(w.faktury.map((f) => f.idExternal).sort()).toEqual([`${id}/1/1`, `${id}/2/1`].sort())
      const f1 = w.faktury.find((f) => f.idExternal === `${id}/1/1`)!
      const f2 = w.faktury.find((f) => f.idExternal === `${id}/2/1`)!
      expect(f1.pozycje).toEqual([
        { goodId: 7101, count: 2, price: '10.00', name: 'Towar testowy HERB-W2-A', vat: 222 },
        { goodId: 0, count: 1, price: '12.99', name: 'Wysyłka', vat: 222 },
      ])
      expect(f2.pozycje).toEqual([{ goodId: 7102, count: 1, price: '7.50', name: 'Towar testowy HERB-W2-B', vat: 222 }])
      expect(f2.contractor).toMatchObject({ name: 'Jan Testowy' })
      expect(zapytane.every((x) => x === id)).toBe(true)
      expect(await db.invoiceAttempt.count({ where: { orderId: childOrderId, state: 'ISSUED' } })).toBe(1)
      expect(flagsOf(await db.order.findUniqueOrThrow({ where: { id: childOrderId } })).fakturaBlad).toBeFalsy()
      await expectInvariants(db)
    })

    it('spakowane przed włączeniem bez faktury (zero wywołań), po włączeniu tak; licznik zaległych na ekranie', async () => {
      const tea = await product(db, 'HERB-W3', 5, { wfirmaGoodId: '7103' })
      await ustawFaktury({ program: 'wfirma', fakturyWlaczone: false })
      const stare = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 })
      expect((await widokDokumentow(db)).spakowaneBezFaktury).toBe(1)
      // włączone „teraz” wg zegara bazy: zdarzenie spakowania starego zamówienia jest wcześniejsze
      await new Promise((res) => setTimeout(res, 20))
      const teraz = (await db.$queryRaw<{ n: Date }[]>`SELECT now() AS n`)[0]!.n
      await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: teraz.toISOString() })
      expect((await widokDokumentow(db)).spakowaneBezFaktury).toBeNull()
      const w = new WfirmaHttpAtrapa()
      await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
      expect(w.sciezki).toEqual([])
      expect(await db.invoiceAttempt.count({ where: { orderId: stare } })).toBe(0)
      const nowe = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 })
      await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(2), tylkoPraca: true })
      expect(w.faktury.map((f) => f.idExternal)).toEqual([`${nowe}/1/1`])
      expect(await db.invoiceAttempt.count({ where: { orderId: stare } })).toBe(0)
      await expectInvariants(db)
    })

    it('„Ponów fakturę” po niewiadomej: find przed invoices/add znajduje spóźnioną fakturę, drugiej nie ma', async () => {
      await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() })
      const tea = await product(db, 'HERB-W4', 5, { wfirmaGoodId: '7104' })
      const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 })
      const w = new WfirmaHttpAtrapa()
      // faktura powstała, ale find jej nie widzi przez 3 próby i przy automatycznej nowej próbie (która dostaje błąd)
      w.nastepne = ['TIMEOUT_PO_ZAPISIE', 'BLAD']
      w.findPuste = 4
      const ad = adapter(w)
      for (const m of [1, 2, 4, 8]) await runWfirmaQueue(db, { faktury: ad }, { now: min(m), tylkoPraca: true })
      expect((await db.invoiceAttempt.findMany({ where: { orderId: id }, orderBy: { attemptNo: 'asc' } })).map((a) => [a.attemptNo, a.state])).toEqual([
        [1, 'FAILED'],
        [2, 'FAILED'],
      ])
      expect(flagsOf(await db.order.findUniqueOrThrow({ where: { id } })).fakturaBlad).toBe(true)
      await ponowFaktureRecznie(db, id, { now: min(9), actorId: 'u-biuro' })
      await runWfirmaQueue(db, { faktury: ad }, { now: min(10), tylkoPraca: true })
      const a3 = await db.invoiceAttempt.findFirstOrThrow({ where: { orderId: id, attemptNo: 3 } })
      expect(a3).toMatchObject({ state: 'ISSUED', wfirmaDocId: w.faktury[0]!.id, number: w.faktury[0]!.fullnumber })
      expect(w.faktury).toHaveLength(1)
      expect(w.sciezki.filter((p) => p === 'invoices/add')).toHaveLength(2) // pierwsza (powstała) i automatyczna (odrzucona)
      expect(await db.pendingMovement.findMany({ where: { orderId: id, state: 'APPLIED' }, select: { wzQty: true } })).toEqual([{ wzQty: 1 }])
      await expectInvariants(db)
    })

    it('automatyczna nowa próba po „nie znaleziono” też najpierw szuka i przyjmuje spóźnioną fakturę', async () => {
      await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() })
      const tea = await product(db, 'HERB-W4-B', 5, { wfirmaGoodId: '7105' })
      const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 })
      const w = new WfirmaHttpAtrapa()
      w.nastepne = ['TIMEOUT_PO_ZAPISIE']
      w.findPuste = 3
      const ad = adapter(w)
      for (const m of [1, 2, 4, 8]) await runWfirmaQueue(db, { faktury: ad }, { now: min(m), tylkoPraca: true })
      expect((await db.invoiceAttempt.findMany({ where: { orderId: id }, orderBy: { attemptNo: 'asc' } })).map((a) => [a.attemptNo, a.state])).toEqual([
        [1, 'FAILED'],
        [2, 'ISSUED'],
      ])
      expect(w.faktury).toHaveLength(1)
      expect(w.sciezki.filter((p) => p === 'invoices/add')).toHaveLength(1)
      await expectInvariants(db)
    })

    it('pobranie PDF faktury zostawia wpis w dzienniku podglądów danych klienta', async () => {
      await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() })
      const tea = await product(db, 'HERB-W5', 5, { wfirmaGoodId: '7106' })
      const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 })
      const w = new WfirmaHttpAtrapa()
      await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
      const env = { WFIRMA_ACCESS_KEY: 'a', WFIRMA_SECRET_KEY: 's', WFIRMA_APP_KEY: 'p', WFIRMA_COMPANY_ID: '999' }
      await pdfFakturyZamowienia(db, id, { secrets: { env, envFallback: true }, fetch: w.fetch, actorId: 'u-biuro' })
      const wpisy = await dziennikPodgladow(db, { actorId: 'u-biuro' })
      expect(wpisy).toHaveLength(1)
      expect(wpisy[0]).toMatchObject({ orderId: id, cel: 'FAKTURA_PDF', zakres: 'PELNY' })
      // nieudane pobranie (brak faktury) nie zostawia wpisu
      const bez = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 }, min(2))
      await expect(pdfFakturyZamowienia(db, bez, { secrets: { env, envFallback: true }, fetch: w.fetch, actorId: 'u-biuro' })).rejects.toThrow(/nie ma jeszcze wystawionej faktury/)
      expect(await dziennikPodgladow(db, { actorId: 'u-biuro' })).toHaveLength(1)
    })

    it('trasa PDF bez uprawnienia do danych klienta albo z obcej strony = 403, bez wpisu', async () => {
      const { GET } = await import('@/app/api/wydruki/faktura/route')
      const req = (site: string | null) => ({ headers: new Headers(site ? { 'sec-fetch-site': site } : {}), nextUrl: new URL('http://localhost/api/wydruki/faktura?z=abc') }) as never
      sesja.permissions = new Set(['zamowienia.faktury'])
      expect((await GET(req('same-origin'))).status).toBe(403)
      sesja.permissions = new Set(['zamowienia.faktury', 'klienci.dane'])
      expect((await GET(req('cross-site'))).status).toBe(403)
      expect(await dziennikPodgladow(db)).toHaveLength(0)
    })
  })

  it('w dostawie sama firma bez NIP-u = braki „nip”, faktura nie wychodzi', async () => {
    const { kontrahentDoWystawienia } = await import('@/lib/odbiorca/przejscia')
    const r = kontrahentDoWystawienia({ ...ODBIORCA, dostawa: { ...ODBIORCA.dostawa!, imieNazwisko: null, firma: 'Firma Bez NIP' } }, false)
    expect(r).toEqual({ ok: false, braki: ['nip'] })
  })

  it('komunikat wFirmy bez e-maili, telefonów i numerów; kwota paczki dodatkowej bez wysyłki', () => {
    expect(maskujDane('contractor: Nieprawidłowy NIP 123-456-78-90, e-mail jan@test.pl, tel. +48 600 100 200, kod 00-001')).toBe('contractor: Nieprawidłowy NIP …, e-mail …, tel. …, kod 00-001')
    expect(kwotaPaczkiDodatkowej([{ qty: 3, naOferte: 1, cenaBruttoGr: 333 }, { qty: 2, naOferte: 2, cenaBruttoGr: 1250 }])).toBe(22.49)
  })
})

describe('scalenie z pocztą: PDF faktury jako załącznik maila „Wysłane”', () => {
  it('faktura z Kompletora daje PDF z wpisem system:poczta; dokument spoza Kompletora = BRAK', async () => {
    await seedBase(db)
    await praca(['WOO_SD'])
    await ustawFaktury({ program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() })
    const tea = await product(db, 'HERB-MAIL', 5, { wfirmaGoodId: '7201' })
    const id = await spakowane([{ productId: tea, qty: 1 }], { totalGross: 10 })
    const w = new WfirmaHttpAtrapa()
    await runWfirmaQueue(db, { faktury: adapter(w) }, { now: min(1), tylkoPraca: true })
    const { zrodloPdfZProgramu } = await import('@/lib/poczta/dokument-pdf')
    const zrodlo = zrodloPdfZProgramu({ WFIRMA_ACCESS_KEY: 'a', WFIRMA_SECRET_KEY: 's', WFIRMA_APP_KEY: 'p', WFIRMA_COMPANY_ID: '999', APP_MODE: 'self-host' }, w.fetch)
    const r = await zrodlo.pobierz(db, { orderId: id, docId: w.faktury[0]!.id })
    expect(r.stan).toBe('PDF')
    if (r.stan === 'PDF') {
      expect(new TextDecoder().decode(r.tresc)).toMatch(/^%PDF-/)
      expect(r.numer).toBe(w.faktury[0]!.fullnumber)
    }
    expect(await dziennikPodgladow(db, { actorId: 'system:poczta' })).toMatchObject([{ orderId: id, cel: 'FAKTURA_PDF' }])
    expect((await zrodlo.pobierz(db, { orderId: id, docId: 'FV-BL-1/11/2026' })).stan).toBe('BRAK')
  })
})
