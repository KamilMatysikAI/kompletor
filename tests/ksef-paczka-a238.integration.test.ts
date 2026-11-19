// (punkt 8): szkic KSeF paczki dodatkowej („dośle później”, podział). Podzamówienie
// ma `totalGross` 0 (pieniądze i wysyłka zostają na paczce 1), więc kwotą faktury paczki 2 jest suma jej pozycji, jak
// w fakturze wFirmy (`kwotaPaczkiDodatkowej`); rabat liczony na dokumencie matki zatrzymuje też paczkę 2
// (`rabatMatkiNaDokumencie`, jak `lib/wfirma/adapter-zapis.ts`). Dane fikcyjne, bez sieci (szkic bez wysyłki do KSeF).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareKsefForOrder } from '@/lib/ksef/szkice'
import { KOD_RABATU_NIEPEWNEGO } from '@/lib/dokumenty/pozycje'
import { ORG_A, testDb, testSystemDb, truncateAll } from './db'
import { ACC, product, seedBase } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))

const db = testDb()
const sys = testSystemDb()
afterAll(async () => {
  await db.$disconnect()
})

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
})

/** Zamówienie 2 szt. po 20,00 zł + wysyłka 12,99 zł; 1 szt. dosłana w paczce 2 (podzamówienie z kwotą 0). */
async function zamowienieZPaczka2(totalGross: string) {
  const p = await product(db, 'TEST-A238-P', 10)
  await db.order.create({ data: { id: 'kp1', ...ACC.WOO_SD, externalId: 'KP-1', status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross, shippingCostGross: '12.99', wantInvoiceNip: true, createdAtChannel: T } })
  await db.orderLine.create({ data: { orderId: 'kp1', externalLineId: 'L1', productId: p, qty: 2, qtyRejected: 1, unitPriceGross: '20.00', vatRate: '23' } })
  await db.order.create({ data: { id: 'kp2', ...ACC.WOO_SD, externalId: 'KP-1#2', parentOrderId: 'kp1', packageNo: 2, status: 'WYSLANE', paymentState: 'PAID', paymentMethod: 'BLIK', totalGross: '0.00', wantInvoiceNip: true, createdAtChannel: T } })
  await db.orderLine.create({ data: { orderId: 'kp2', externalLineId: 'L1#dosle', productId: p, qty: 1, unitPriceGross: '20.00', vatRate: '23' } })
}

describe('szkic KSeF paczki dodatkowej (punkt 8)', () => {
  it('paczka 2 z kwotą 0 w zamówieniu: faktura na sumę pozycji paczki (20,00 zł), bez „pozycje droższe niż zamówienie”', async () => {
    await zamowienieZPaczka2('52.99')
    const w = await prepareKsefForOrder(db, 'kp2', { now: T })
    expect(w).toMatchObject({ wynik: 'przygotowana' })
    const kody = w.wynik === 'przygotowana' ? w.problemy.map((p) => p.kod) : []
    expect(kody).not.toContain('pozycje-drozsze-niz-zamowienie')
    expect(await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: 'kp2' }, select: { bruttoGr: true } })).toEqual({ bruttoGr: 2000 })
    // paczka 1 bez zmian: 1 szt. + wysyłka
    await prepareKsefForOrder(db, 'kp1', { now: T })
    expect(await db.ksefInvoiceDraft.findFirstOrThrow({ where: { orderId: 'kp1' }, select: { bruttoGr: true } })).toEqual({ bruttoGr: 3299 })
  })

  it('matka z ceną sprzed rabatu (rabat liczony na dokumencie): paczka 2 też staje z komunikatem rabatu', async () => {
    await zamowienieZPaczka2('47.99') // 40,00 − 5,00 rabatu + 12,99
    const w = await prepareKsefForOrder(db, 'kp2', { now: T })
    expect(w.wynik === 'przygotowana' && w.problemy.map((p) => p.kod)).toContain(KOD_RABATU_NIEPEWNEGO)
  })
})
