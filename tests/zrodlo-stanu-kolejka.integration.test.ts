// Drobne poprawki: zmiana źródła stanu przy pracującej kolejce wFirmy,
// kierunek blokady, zlecony odczyt w tej samej transakcji i zdjęty przy zmianie na Kompletor, firma
// bez wiersza magazynu, alert stanu ujemnego na każde wydanie, faktury włączone bez daty,
// równoległa faktura i zmiana źródła. Dane fikcyjne, atrapa wFirmy w pamięci.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { UstawieniaDokumentowError, zmienZrodloStanu } from '@/lib/dokumenty/zapis'
import { korektaStanu } from '@/lib/kanaly/korekta-stanu'
import { faktyPrzejscia, readyForDispatch } from '@/lib/rdzen/przejscia'
import { bezWysylkiPrzyStanieKompletora, requestFullRead, runWfirmaQueue } from '@/lib/rdzen/kolejka-wfirmy'
import { beginInvoice, packOrder } from '@/lib/rdzen/rozchod'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { zrodloStanu } from '@/lib/rdzen/zrodlo-stanu'
import { runLustroWfirmy } from '@/lib/worker/zadania'
import { testDb, testSystemDb, truncateAll } from './db'
import { ACC, FakeWfirma, order, product, seedBase, stockOf, T0, type TestChannel } from './rdzen-fixtures'
import { DEFAULT_CHANNEL_ADAPTER } from '@/lib/adaptery'

const db = testDb()
afterAll(() => db.$disconnect())
beforeEach(async () => {
  await truncateAll(db)
})

async function spakowane(productId: string, qty: number): Promise<string> {
  const r = await ingestOrder(db, order([{ productId, qty }]), { now: T0 })
  await packOrder(db, r.orderId!, { now: T0 })
  return r.orderId!
}

describe('zmiana źródła stanu', () => {
  beforeEach(() => seedBase(db)) // magazyn lustra wFirmy 999001, program wFirma wywnioskowany

  it('przy trwającym przebiegu kolejki wFirmy zmiana źródła czeka („spróbuj za chwilę”), po dzierżawie przechodzi', async () => {
    await db.wfirmaQueueState.create({ data: { runLockId: 'test', runLockUntil: new Date(Date.now() + 60_000) } })
    await expect(zmienZrodloStanu(db, 'KOMPLETOR', 'u1')).rejects.toThrow('Kolejka wFirmy właśnie pracuje')
    expect(await zrodloStanu(db)).toBe('WFIRMA')
    await db.wfirmaQueueState.updateMany({ data: { runLockId: null, runLockUntil: new Date(Date.now() - 1000) } })
    await zmienZrodloStanu(db, 'KOMPLETOR', 'u1')
    expect(await zrodloStanu(db)).toBe('KOMPLETOR')
  })

  it('rzeczy w drodze blokują tylko odejście z lustra wFirmy; powrót na lustro przechodzi i zleca pełny odczyt w tej samej transakcji', async () => {
    const tea = await product(db, 'HERB-A121-D11', 5)
    const id = await spakowane(tea, 1)
    expect((await beginInvoice(db, id, { now: T0 })).outcome).toBe('START') // CONSUMING + IN_FLIGHT
    await expect(zmienZrodloStanu(db, 'KOMPLETOR', 'u1')).rejects.toBeInstanceOf(UstawieniaDokumentowError)
    // pułapka z przeglądu: źródło przełączone w trakcie przebiegu (symulacja zapisem wprost)
    await db.warehouse.updateMany({ data: { stockSource: 'KOMPLETOR' } })
    await zmienZrodloStanu(db, 'WFIRMA', 'u1') // dawniej: blokada na zawsze
    expect(await zrodloStanu(db)).toBe('WFIRMA')
    expect((await db.wfirmaQueueState.findFirstOrThrow()).fullReadDueSince).not.toBeNull()
  })

  it('zmiana na Kompletor zdejmuje zlecony pełny odczyt; lustro w workerze nie zleca go firmie z Kompletorem', async () => {
    await requestFullRead(db, { now: T0 })
    await zmienZrodloStanu(db, 'KOMPLETOR', 'u1')
    expect((await db.wfirmaQueueState.findFirstOrThrow()).fullReadDueSince).toBeNull()
    const wf = new FakeWfirma()
    const r = await runLustroWfirmy(db, wf, { now: T0 })
    expect(r.fullReadRequested).toBeUndefined()
    expect((await db.wfirmaQueueState.findFirstOrThrow()).fullReadDueSince).toBeNull()
    expect(wf.log).toEqual([])
  })

  it('równoległa faktura i zmiana źródła — nigdy faktura w drodze przy źródle Kompletora', async () => {
    for (let i = 0; i < 4; i++) {
      await truncateAll(db)
      await seedBase(db)
      const tea = await product(db, `HERB-A121-D12-${i}`, 5)
      const id = await spakowane(tea, 1)
      const db2 = testDb()
      try {
        const [f, z] = await Promise.allSettled([beginInvoice(db, id, { now: T0 }), zmienZrodloStanu(db2, 'KOMPLETOR', 'u1')])
        expect(f.status).toBe('fulfilled')
        const zrodlo = await zrodloStanu(db)
        const wDrodze = await db.reservation.count({ where: { state: 'CONSUMING' } })
        if (zrodlo === 'KOMPLETOR') {
          expect(z.status).toBe('fulfilled')
          expect(wDrodze).toBe(0)
          expect((f as PromiseFulfilledResult<{ outcome: string }>).value.outcome).toBe('INNE_ZRODLO')
        } else {
          expect(z.status).toBe('rejected')
          expect(wDrodze).toBe(1)
        }
      } finally {
        await db2.$disconnect()
      }
    }
  })
})

describe('kolejka wFirmy: drobne poprawki', () => {
  it('firma bez wiersza magazynu — alert zamiast cichego przebiegu, zero wywołań wFirmy', async () => {
    const labels: TestChannel[] = ['WOO_SD']
    await db.channelConfig.createMany({ data: labels.map((l) => ({ ...ACC[l], name: `${l} test`, adapterKey: DEFAULT_CHANNEL_ADAPTER[ACC[l].channel] })) })
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf, korekty: wf, odczyt: wf }, { now: T0 })
    expect(wf.log).toEqual([])
    expect(await db.alert.count({ where: { kind: 'WFIRMA_BRAK_MAGAZYNU', ref: DEFAULT_WAREHOUSE } })).toBe(1)
  })

  it('„Wystawiaj faktury” włączone bez daty włączenia = alert konfiguracji, bez faktury', async () => {
    await seedBase(db)
    await testSystemDb().organization.update({ where: { id: 'test_a' }, data: { settings: { faktury: { program: 'wfirma', fakturyWlaczone: true } } as never } })
    const tea = await product(db, 'HERB-A121-D10', 5)
    await spakowane(tea, 1)
    const wf = new FakeWfirma()
    await runWfirmaQueue(db, { faktury: wf, korekty: null, odczyt: null }, { now: T0, tylkoPraca: true })
    expect(await db.invoiceAttempt.count()).toBe(0)
    expect(await db.alert.count({ where: { kind: 'WFIRMA_KONFIGURACJA' } })).toBe(1)
  })
})

describe('stan ujemny po wydaniu', () => {
  it('alert przy każdym wydaniu z minusem, nie raz na zawsze dla produktu', async () => {
    await seedBase(db)
    await db.warehouse.updateMany({ data: { stockSource: 'KOMPLETOR', wfirmaWarehouseId: null } })
    const tea = await product(db, 'HERB-A121-D2', 2)
    for (let i = 0; i < 2; i++) {
      await korektaStanu(db, { productId: tea, physicalAfter: 2, reason: 'test D-2' }, { actorId: 'test', now: T0 })
      const id = await spakowane(tea, 2)
      await korektaStanu(db, { productId: tea, physicalAfter: 0, reason: 'test D-2 minus' }, { actorId: 'test', now: T0 })
      await readyForDispatch(db, id, { now: T0 })
      expect((await stockOf(db, tea)).physical).toBe(-2)
      expect((await faktyPrzejscia(db, { id, packageNo: 1 })).wydane).toBeGreaterThan(0)
    }
    expect(await db.alert.count({ where: { kind: 'STAN_UJEMNY_PO_WYDANIU' } })).toBe(2)
  })
})

describe('e-book przy stanie Kompletora bez programu do faktur', () => {
  const EBOOK = 'Dostawa elektroniczna (test)'
  beforeEach(async () => {
    await seedBase(db)
    await db.warehouse.updateMany({ data: { stockSource: 'KOMPLETOR', wfirmaWarehouseId: null } })
    await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
  })
  const ebook = async () => (await db.product.create({ data: { sku: `EBOOK-A121-${Math.random().toString(36).slice(2, 8)}`, kind: 'DIGITAL', unit: 'SZT', nameAccounting: 'E-book testowy', title: 'E-book testowy', vatRate: '5' } })).id
  const zamow = async (lines: { productId: string; qty: number }[], channel: TestChannel = 'WOO_SD') => (await ingestOrder(db, order(lines.map((l) => ({ ...l, unitPriceGross: 29.9 })), { deliveryMethod: EBOOK, channel }), { now: T0 })).orderId!
  const status = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id } })).status

  it('bez programu: automat pakuje i zamyka „Odebrane” bez faktury; drugi przebieg nic nie zmienia', async () => {
    const id = await zamow([{ productId: await ebook(), qty: 1 }])
    expect(await status(id)).toBe('DO_REALIZACJI')
    expect(await bezWysylkiPrzyStanieKompletora(db, { now: T0 })).toEqual({ spakowane: 1, odebrane: 1 })
    expect(await status(id)).toBe('ODEBRANE')
    expect(await db.invoiceAttempt.count()).toBe(0)
    expect(await bezWysylkiPrzyStanieKompletora(db, { now: T0 })).toEqual({ spakowane: 0, odebrane: 0 })
  })

  it('zamówienie z towarem i konto w podglądzie: automat ich nie rusza; lustro wFirmy: nic (robi to kolejka)', async () => {
    const tea = await product(db, 'HERB-A121-EB', 5)
    const mieszane = await zamow([{ productId: await ebook(), qty: 1 }, { productId: tea, qty: 1 }])
    const cien = await zamow([{ productId: await ebook(), qty: 1 }], 'ALLEGRO')
    const przed = [await status(mieszane), await status(cien)]
    await bezWysylkiPrzyStanieKompletora(db, { now: T0 })
    expect([await status(mieszane), await status(cien)]).toEqual(przed)
    expect(przed[1]).toBe('DO_REALIZACJI')
    await db.warehouse.updateMany({ data: { stockSource: 'WFIRMA', wfirmaWarehouseId: '999001' } })
    expect(await bezWysylkiPrzyStanieKompletora(db, { now: T0 })).toBeNull()
  })

  it('wFirma z włączonym wystawianiem: zamknięcie dopiero po wystawionym dokumencie', async () => {
    await testSystemDb().organization.update({ where: { id: 'test_a' }, data: { settings: { faktury: { program: 'wfirma', fakturyWlaczone: true, fakturyWlaczoneOd: T0.toISOString() } } as never } })
    const id = await zamow([{ productId: await ebook(), qty: 1 }])
    expect(await bezWysylkiPrzyStanieKompletora(db, { now: T0 })).toEqual({ spakowane: 1, odebrane: 0 })
    expect(await status(id)).toBe('SPAKOWANE')
    await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED', documentOnly: true, wfirmaDocId: 'D-9' } })
    expect(await bezWysylkiPrzyStanieKompletora(db, { now: T0 })).toEqual({ spakowane: 0, odebrane: 1 })
    expect(await status(id)).toBe('ODEBRANE')
  })

  it('„Dokument przed wysyłką”: bez automatu', async () => {
    await testSystemDb().organization.update({ where: { id: 'test_a' }, data: { settings: { faktury: { program: 'ksef', przedWysylka: true } } as never } })
    await zamow([{ productId: await ebook(), qty: 1 }])
    expect(await bezWysylkiPrzyStanieKompletora(db, { now: T0 })).toBeNull()
  })
})

describe('mail paczki dodatkowej', () => {
  it('kontakt do maila podzamówienia z danych klienta zamówienia głównego', async () => {
    const { zapiszRekordKlienta } = await import('@/lib/klienci/zapis')
    const { rekordZOdbiorcy } = await import('@/lib/klienci/rekord')
    const { kontaktDoMaila } = await import('@/lib/klienci/wejscia')
    const ENV = { DANE_KLIENTA_ZAPIS: '1', CUSTOMER_DATA_KEYS: `1:${'1'.repeat(64)}`, CUSTOMER_LOOKUP_KEY: 'a'.repeat(64) }
    await seedBase(db)
    const tea = await product(db, 'HERB-A121-D9', 5)
    const glowne = (await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })).orderId!
    const pod = (await ingestOrder(db, order([{ productId: tea, qty: 1 }]), { now: T0 })).orderId!
    await testSystemDb().order.update({ where: { id: pod }, data: { parentOrderId: glowne, packageNo: 2 } })
    const dostawa = { imieNazwisko: 'Anna Fikcyjna', firma: null, ulica: 'ul. Testowa 1', numerDomu: '1', numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: null, email: 'anna@example.test' }
    await zapiszRekordKlienta(db, glowne, rekordZOdbiorcy({ dostawa, punktOdbioru: null, faktura: null, problemy: [] }), { source: 'RECZNE', fetchedAt: T0, env: ENV })
    expect(await kontaktDoMaila(db, pod, { env: ENV })).toEqual({ stan: 'OK', email: 'anna@example.test', imie: 'Anna' })
  })
})

describe('zasady wydania policzone raz', () => {
  it('faktyPrzejscia z podanymi zasadami = bez nich (lustro i Kompletor)', async () => {
    const { zasadyWydania } = await import('@/lib/rdzen/przejscia')
    await seedBase(db)
    const tea = await product(db, 'HERB-A121-D9B', 5)
    const id = await spakowane(tea, 1)
    for (const zrodlo of ['WFIRMA', 'KOMPLETOR'] as const) {
      await db.warehouse.updateMany({ data: { stockSource: zrodlo } })
      const zasady = await zasadyWydania(db, null, DEFAULT_WAREHOUSE)
      expect(await faktyPrzejscia(db, { id, packageNo: 1 }, { zasady })).toEqual(await faktyPrzejscia(db, { id, packageNo: 1 }))
      expect(zasady.wydanieWlasne).toBe(zrodlo === 'KOMPLETOR')
    }
  })
})
