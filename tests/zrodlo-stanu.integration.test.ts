// firma bez wFirmy i bez programu do faktur przechodzi pełną ścieżkę (przyjęcie → zbieranie → spakowanie →
// „Do wysyłki” → „Wysłane” → „Odebrane”): stan schodzi przy wydaniu (ruch OWN_DISPATCH), bez alertu „Wydane bez
// dokumentu”, bez ruchu MANUAL i bez odczytu wFirmy. E-book kończy się bez faktury. Ścieżka ACME (lustro wFirmy) bez
// zmian. Do tego zapis ustawień z panelu (Dane firmy, Dokumenty sprzedaży, źródło stanu) z AuditLog. Dane fikcyjne.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CHANNEL_ADAPTER } from '@/lib/adaptery'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { ustawieniaDokumentowFirmy } from '@/lib/dokumenty/firma'
import { BLAD_PARY, dokumentyZFormularza, programyDoWyboru, UstawieniaDokumentowError, widokDokumentow, zapiszUstawieniaDokumentow, zmienZrodloStanu } from '@/lib/dokumenty/zapis'
import { ProfilFirmyError } from '@/lib/firma/profil'
import { zapiszProfilFirmy } from '@/lib/firma/zapis'
import { firmaMaWfirme } from '@/lib/kanaly/firma'
import { parseKonfiguracjaKsef } from '@/lib/ksef/konfiguracja'
import { NIE_DOTYCZY_BRAK, prepareKsefForOrder } from '@/lib/ksef/szkice'
import { requestFullRead, runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { applyOrgPreset, presetNowejFirmy } from '@/lib/organizacje'
import { dostepnePrzejscia } from '@/lib/praca/przejscia-ekran'
import { faktyEkranu } from '@/lib/praca/dane'
import { finishPicking, finishWithoutShipping, markReceived, markShipped, readyForDispatch, startPicking } from '@/lib/rdzen/przejscia'
import { beginInvoice, packOrder, shipWithoutInvoice, wydajZMagazynuWlasnegoInTx } from '@/lib/rdzen/rozchod'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { TransitionError } from '@/lib/rdzen/statusy'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { zrodloStanu } from '@/lib/rdzen/zrodlo-stanu'
import { testDb, testSystemDb, truncateAll } from './db'
import { ACC, bundle, expectInvariants, FakeWfirma, order, product, seedBase, stockOf, T0, type TestChannel } from './rdzen-fixtures'

const db = testDb()
afterAll(() => db.$disconnect())

const WSZYSTKIE = new Set(['zamowienia.przejscia', 'zamowienia.oznacz_oplacone', 'zamowienia.anuluj_po_fakturze'])
const EBOOK_DELIVERY = 'Dostawa elektroniczna (test)'

/** Firma bez wFirmy: magazyn bez magazynu wFirmy, te same konta kanałów co seedBase. */
async function seedBezWfirmy(): Promise<void> {
  await db.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Główny (test, bez wFirmy)' } })
  const labels: TestChannel[] = ['WOO_SD', 'ALLEGRO', 'RECZNE']
  await db.channelConfig.createMany({ data: labels.map((l) => ({ ...ACC[l], name: `${l} test`, adapterKey: DEFAULT_CHANNEL_ADAPTER[ACC[l].channel] })) })
}

async function ustawFaktury(faktury: Record<string, unknown>): Promise<void> {
  await testSystemDb().organization.update({ where: { id: 'test_a' }, data: { settings: { faktury } as never } })
}

async function doSpakowania(lines: { productId: string; qty: number }[], over: Parameters<typeof order>[1] = {}): Promise<string> {
  const r = await ingestOrder(db, order(lines, over), { now: T0 })
  expect(r.status).toBe('DO_REALIZACJI')
  await startPicking(db, r.orderId!, { now: T0 })
  await finishPicking(db, r.orderId!, { now: T0 })
  await packOrder(db, r.orderId!, { now: T0 })
  return r.orderId!
}

beforeEach(async () => {
  await truncateAll(db)
})

describe('firma bez wFirmy i bez programu do faktur', () => {
  beforeEach(seedBezWfirmy)

  it('źródło stanu KOMPLETOR i program „brak” wywnioskowane bez ustawień', async () => {
    expect(await zrodloStanu(db)).toBe('KOMPLETOR')
    expect(await firmaMaWfirme(db)).toBe(false)
    expect((await ustawieniaDokumentowFirmy(db)).program).toBe('brak')
  })

  it('pełna ścieżka: stan −qty przy „Do wysyłki”, 0 alertów, 0 ruchów MANUAL, zamówienie zamknięte', async () => {
    const tea = await product(db, 'HERB-A114', 5)
    const id = await doSpakowania([{ productId: tea, qty: 2 }])
    expect(await stockOf(db, tea)).toMatchObject({ physical: 5, reserved: 2, available: 3 })

    // ekran: bez „Wyślij bez faktury”, „Do wysyłki” od razu po spakowaniu
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    const przyciski = dostepnePrzejscia({ status: o.status, carrier: o.carrier, pendingAction: o.pendingAction, paymentState: o.paymentState, kartaNieaktualna: false }, await faktyEkranu(db, o), WSZYSTKIE)
    expect(przyciski.map((p) => p.akcja)).not.toContain('bez_faktury')
    expect(przyciski.find((p) => p.akcja === 'wydanie')).toMatchObject({ etykieta: 'Do wysyłki', powod: null })

    expect(await readyForDispatch(db, id, { now: T0, actorId: 'test' })).toBe('DO_WYSLANIA')
    expect(await stockOf(db, tea)).toMatchObject({ physical: 3, reserved: 0, available: 3, wfirmaCount: 3, pendingDelta: 0 })
    expect(await db.reservation.findMany({ where: { orderId: id } })).toEqual([expect.objectContaining({ state: 'CONSUMED' })])
    expect(await db.stockMovement.findMany({ where: { orderId: id }, select: { source: true, deltaPhysical: true, actorId: true } })).toEqual([{ source: 'OWN_DISPATCH', deltaPhysical: -2, actorId: 'test' }])
    expect((await db.orderEvent.findFirstOrThrow({ where: { orderId: id, kind: 'DO_WYSLANIA' } })).data).toMatchObject({ wydaneZeStanu: 2 })

    await markShipped(db, id, { now: T0 })
    expect(await markReceived(db, id, { now: T0 })).toBe('ODEBRANE')
    expect(await db.alert.count({ where: { kind: 'WYDANE_BEZ_DOKUMENTU' } })).toBe(0)
    expect(await db.alert.count()).toBe(0)
    expect(await db.pendingMovement.count()).toBe(0)
    expect(await db.outboxEvent.count({ where: { kind: 'WFIRMA_READ' } })).toBe(0)
    expect(await db.invoiceAttempt.count()).toBe(0)
    await expectInvariants(db)
  })

  it('ponowione „Do wysyłki” (podwójne kliknięcie) nie zdejmuje stanu drugi raz', async () => {
    const tea = await product(db, 'HERB-A114-2', 4)
    const id = await doSpakowania([{ productId: tea, qty: 1 }])
    await readyForDispatch(db, id, { now: T0 })
    await readyForDispatch(db, id, { now: T0 })
    expect(await stockOf(db, tea)).toMatchObject({ physical: 3, reserved: 0 })
    expect(await db.stockMovement.count({ where: { source: 'OWN_DISPATCH' } })).toBe(1)
    await expectInvariants(db)
  })

  it('zestaw schodzi składnikami', async () => {
    const a = await product(db, 'SKL-A', 10)
    const b = await product(db, 'SKL-B', 10)
    const z = await bundle(db, 'ZEST-A114', [
      { id: a, qty: 2 },
      { id: b, qty: 1 },
    ])
    const id = await doSpakowania([{ productId: z, qty: 2 }])
    await readyForDispatch(db, id, { now: T0 })
    expect(await stockOf(db, a)).toMatchObject({ physical: 6, reserved: 0 })
    expect(await stockOf(db, b)).toMatchObject({ physical: 8, reserved: 0 })
    await expectInvariants(db)
  })

  it('e-book kończy się „Odebrane” bez faktury', async () => {
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
    const ebook = (await db.product.create({ data: { sku: 'EBOOK-A114', kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book testowy', title: 'E-book testowy', vatRate: '5' } })).id
    const r = await ingestOrder(db, order([{ productId: ebook, qty: 1, unitPriceGross: 29.9 }], { deliveryMethod: EBOOK_DELIVERY }), { now: T0 })
    await packOrder(db, r.orderId!, { now: T0 })
    expect(await finishWithoutShipping(db, r.orderId!, { now: T0 })).toBe('ODEBRANE')
    expect(await db.invoiceAttempt.count()).toBe(0)
    expect(await db.alert.count()).toBe(0)
  })

  it('„Dokument przed wysyłką” z programem: „Do wysyłki” czeka na dokument, stan nietknięty', async () => {
    await ustawFaktury({ program: 'ksef', przedWysylka: true })
    const tea = await product(db, 'HERB-A114-3', 5)
    const id = await doSpakowania([{ productId: tea, qty: 2 }])
    await expect(readyForDispatch(db, id, { now: T0 })).rejects.toThrow(/Najpierw dokument sprzedaży/)
    expect(await stockOf(db, tea)).toMatchObject({ physical: 5, reserved: 2 })
    // bez „przed wysyłką” ten sam program nie blokuje wydania
    await ustawFaktury({ program: 'ksef' })
    expect(await readyForDispatch(db, id, { now: T0 })).toBe('DO_WYSLANIA')
    await expectInvariants(db)
  })
})

describe('ACME: lustro wFirmy bez zmian', () => {
  beforeEach(async () => {
    await seedBase(db)
  })

  it('„Do wysyłki” z rezerwacją ACTIVE odmawia jak dotąd, „Wyślij bez faktury” daje MANUAL i alert', async () => {
    expect(await zrodloStanu(db)).toBe('WFIRMA')
    expect((await ustawieniaDokumentowFirmy(db)).program).toBe('wfirma')
    const tea = await product(db, 'HERB-ACME', 5)
    const id = await doSpakowania([{ productId: tea, qty: 2 }])
    const err = await readyForDispatch(db, id, { now: T0 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransitionError)
    expect((err as Error).message).toBe('Najpierw faktura (albo „wyślij bez faktury”): towar nie jest jeszcze wydany z magazynu')
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    const przyciski = dostepnePrzejscia({ status: o.status, carrier: o.carrier, pendingAction: o.pendingAction, paymentState: o.paymentState, kartaNieaktualna: false }, await faktyEkranu(db, o), WSZYSTKIE)
    expect(przyciski.map((p) => p.akcja)).toContain('bez_faktury')
    await shipWithoutInvoice(db, id, { now: T0 })
    expect(await db.pendingMovement.findMany({ select: { type: true, state: true } })).toEqual([{ type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL' }])
    expect(await db.alert.count({ where: { kind: 'WYDANE_BEZ_DOKUMENTU' } })).toBe(1)
    expect(await db.stockMovement.count({ where: { source: 'OWN_DISPATCH' } })).toBe(0)
    await expectInvariants(db)
  })

  it('jawne źródło KOMPLETOR wygrywa z magazynem wFirmy (ustawienie z panelu)', async () => {
    await zmienZrodloStanu(db, 'KOMPLETOR', 'test')
    expect(await zrodloStanu(db)).toBe('KOMPLETOR')
    const tea = await product(db, 'HERB-ACME-2', 5)
    const id = await doSpakowania([{ productId: tea, qty: 1 }])
    expect(await readyForDispatch(db, id, { now: T0 })).toBe('DO_WYSLANIA')
    expect(await db.auditLog.count({ where: { entity: 'Warehouse.stockSource' } })).toBe(1)
  })

  it('zmiana źródła stanu zablokowana, gdy faktura jest w drodze', async () => {
    const tea = await product(db, 'HERB-ACME-3', 5)
    const id = await doSpakowania([{ productId: tea, qty: 1 }])
    await beginInvoice(db, id, { now: T0 }) // rezerwacja CONSUMING, ruch IN_FLIGHT
    await expect(zmienZrodloStanu(db, 'KOMPLETOR', 'test')).rejects.toBeInstanceOf(UstawieniaDokumentowError)
    expect(await zrodloStanu(db)).toBe('WFIRMA')
  })
})

describe('preset nowej firmy', () => {
  it('nowa firma z kreatora: program „brak”, magazyn KOMPLETOR; z magazynem wFirmy: wfirma i WFIRMA', () => {
    const a = presetNowejFirmy({ slug: 'zielona-laka', name: 'Zielona Łąka' })
    expect(a.settings?.faktury).toEqual({ program: 'brak' })
    expect(a.warehouses).toEqual([expect.objectContaining({ stockSource: 'KOMPLETOR', wfirmaWarehouseId: null })])
    const b = presetNowejFirmy({ slug: 'z-wfirma', name: 'Z wFirmą', wfirmaWarehouseId: '42' })
    expect(b.settings?.faktury).toEqual({ program: 'wfirma' })
    expect(b.warehouses).toEqual([expect.objectContaining({ stockSource: 'WFIRMA' })])
  })

  it('założona firma ma jawne źródło stanu w bazie', async () => {
    const sys = testSystemDb()
    await applyOrgPreset(sys, presetNowejFirmy({ slug: 'nowa-a114', name: 'Nowa A114' }))
    const w = await sys.warehouse.findFirstOrThrow({ where: { organizationId: 'nowa_a114' } })
    expect(w.stockSource).toBe('KOMPLETOR')
    const o = await sys.organization.findUniqueOrThrow({ where: { id: 'nowa_a114' } })
    expect(o.settings).toMatchObject({ faktury: { program: 'brak' } })
  })
})

describe('ustawienia z panelu', () => {
  beforeEach(seedBezWfirmy)

  const form = (over: Record<string, string> = {}) => {
    const f = new FormData()
    const v: Record<string, string> = { program: 'ksef', wystawiajPrzy: 'SPAKOWANE', rodzaj: 'faktura', seriaKod: 'FV', seriaWzor: 'FV/{NR}/{MM}/{RRRR}', seriaReset: 'MIESIAC', wysylkaNazwa: 'Wysyłka', wysylkaStawka: '23', ...over }
    for (const [k, x] of Object.entries(v)) f.set(k, x)
    return f
  }

  it('Dane firmy + Dokumenty sprzedaży: szkic KSeF bez problemów sprzedawcy i serii, AuditLog, ustawienia wFirmy nietknięte', async () => {
    await ustawFaktury({ kodyVat: { '23': 222 } })
    await zapiszProfilFirmy(db, { nazwa: 'Pracownia Testowa sp. z o.o.', nip: '5260250274', ulica: 'ul. Testowa 1', kodPocztowy: '60-001', miasto: 'Poznań', kodKraju: 'PL', email: 'kontakt@example.com', emailBiura: 'biuro@example.com', telefon: '+48 600 000 000', rachunek: '' }, 'u1')
    await zapiszUstawieniaDokumentow(db, dokumentyZFormularza(form()), 'u1', programyDoWyboru(defaultRegistry().list()))
    const org = await db.organization.findFirstOrThrow({ select: { settings: true } })
    const k = parseKonfiguracjaKsef(org.settings)
    expect(k.problemy).toEqual([])
    expect(k.sprzedawca).toEqual({ nip: '5260250274', nazwa: 'Pracownia Testowa sp. z o.o.', adres: { kodKraju: 'PL', linia1: 'ul. Testowa 1', linia2: '60-001 Poznań' } })
    expect(org.settings).toMatchObject({ faktury: { program: 'ksef', kodyVat: { '23': 222 } }, ksef: { seriaKod: 'FV', seriaReset: 'MIESIAC' } })
    expect((await widokDokumentow(db)).ustawienia.program).toBe('ksef')
    expect((await db.auditLog.findMany({ select: { entity: true }, orderBy: { createdAt: 'asc' } })).map((a) => a.entity)).toEqual(['Organization.firma', 'Organization.faktury'])
  })

  it('walidacja: zły NIP, nieznany program, paragon, seria bez {NR}, „przed wysyłką” bez programu', async () => {
    await expect(zapiszProfilFirmy(db, { nip: '1234567890' }, 'u1')).rejects.toBeInstanceOf(ProfilFirmyError)
    const lista = programyDoWyboru(defaultRegistry().list())
    const zle: Record<string, string>[] = [{ program: 'fakturownia.v1' }, { program: 'KSEF' }, { rodzaj: 'paragon' }, { seriaWzor: 'FV/{MM}' }, { program: 'brak', przedWysylka: 'tak' }]
    for (const over of zle)
      await expect(zapiszUstawieniaDokumentow(db, dokumentyZFormularza(form(over)), 'u1', lista)).rejects.toBeInstanceOf(UstawieniaDokumentowError)
    expect(await db.auditLog.count()).toBe(0)
  })

  it('źródło WFIRMA wymaga magazynu wFirmy', async () => {
    await expect(zmienZrodloStanu(db, 'WFIRMA', 'u1')).rejects.toThrow(/magazynu wFirmy/)
    expect(await zrodloStanu(db)).toBe('KOMPLETOR')
  })
})

describe('poprawki przeglądu', () => {
  beforeEach(async () => {
    await seedBase(db) // magazyn z magazynem wFirmy 999001
  })

  async function wydaneWMagazynieKompletora(): Promise<{ tea: string; wf: FakeWfirma }> {
    await zmienZrodloStanu(db, 'KOMPLETOR', 'test')
    const tea = await product(db, 'HERB-W1', 5, { wfirmaGoodId: '7001' })
    const id = await doSpakowania([{ productId: tea, qty: 2 }])
    await readyForDispatch(db, id, { now: T0 })
    const wf = new FakeWfirma()
    wf.counts.set('999001:7001', 5) // wFirma nie wie o wydaniu: stary stan
    return { tea, wf }
  }

  it('przy jawnym źródle KOMPLETOR kolejka wFirmy nie czyta stanu i nie nadpisuje wydania', async () => {
    const { tea, wf } = await wydaneWMagazynieKompletora()
    await requestFullRead(db, { now: T0 })
    await runWfirmaQueue(db, { odczyt: wf, faktury: wf, korekty: wf }, { now: T0 })
    expect(wf.log).toEqual([])
    expect(await stockOf(db, tea)).toMatchObject({ physical: 3, reserved: 0 })
    expect(await db.alert.count({ where: { kind: 'WFIRMA_BRAK_MAGAZYNU' } })).toBe(0)
    await expectInvariants(db)
  })

  it('kontrola: przy źródle WFIRMA ten sam przebieg czyta wFirmę', async () => {
    const tea = await product(db, 'HERB-W1K', 5, { wfirmaGoodId: '7002' })
    const wf = new FakeWfirma()
    wf.counts.set('999001:7002', 4)
    await requestFullRead(db, { now: T0 })
    await runWfirmaQueue(db, { odczyt: wf }, { now: T0 })
    expect(wf.log.length).toBeGreaterThan(0)
    expect((await stockOf(db, tea)).physical).toBe(4)
  })

  it('lustro wFirmy przyjmuje tylko program wFirma; zmiana na lustro wymaga programu wFirma; zleca pełny odczyt', async () => {
    const lista = programyDoWyboru(defaultRegistry().list())
    const f = (program: string) => {
      const x = new FormData()
      for (const [k, v] of Object.entries({ program, wystawiajPrzy: 'SPAKOWANE', rodzaj: 'faktura', wysylkaStawka: '23' })) x.set(k, v)
      return dokumentyZFormularza(x)
    }
    await expect(zapiszUstawieniaDokumentow(db, f('ksef'), 'u1', lista)).rejects.toThrow(BLAD_PARY)
    await expect(zapiszUstawieniaDokumentow(db, f('brak'), 'u1', lista)).rejects.toThrow(BLAD_PARY)
    await zapiszUstawieniaDokumentow(db, f('wfirma'), 'u1', lista)

    await zmienZrodloStanu(db, 'KOMPLETOR', 'u1')
    await zapiszUstawieniaDokumentow(db, f('ksef'), 'u1', lista) // Kompletor + dowolny program: OK
    await expect(zmienZrodloStanu(db, 'WFIRMA', 'u1')).rejects.toThrow(BLAD_PARY)
    expect(await zrodloStanu(db)).toBe('KOMPLETOR')

    await zapiszUstawieniaDokumentow(db, f('wfirma'), 'u1', lista)
    await zmienZrodloStanu(db, 'WFIRMA', 'u1')
    expect(await zrodloStanu(db)).toBe('WFIRMA')
    expect((await db.wfirmaQueueState.findFirstOrThrow()).fullReadDueSince).not.toBeNull()
  })

  it('wydanie z magazynu lustra wFirmy odmawia nawet przy bezpośrednim wywołaniu', async () => {
    const tea = await product(db, 'HERB-D1', 5)
    const id = await doSpakowania([{ productId: tea, qty: 1 }])
    const o = await db.order.findUniqueOrThrow({ where: { id } })
    await expect(db.$transaction((tx) => wydajZMagazynuWlasnegoInTx(tx, o, T0, 'test'))).rejects.toThrow(/rozchód tylko fakturą/)
    expect(await stockOf(db, tea)).toMatchObject({ physical: 5, reserved: 1 })
  })

  it('szkic KSeF w firmie bez programu mówi „brak programu”, nie „wFirma”', async () => {
    await truncateAll(db)
    await seedBezWfirmy()
    const tea = await product(db, 'HERB-D6', 5)
    const r = await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })
    expect(await prepareKsefForOrder(db, r.orderId!)).toEqual({ wynik: 'nie_dotyczy', powod: NIE_DOTYCZY_BRAK })
  })
})
