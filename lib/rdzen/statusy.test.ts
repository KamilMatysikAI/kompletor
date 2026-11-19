import { describe, expect, it } from 'vitest'
import { splitBundlePrice } from './ceny'
import { assertTransition, canTransition, carrierFor, initialStatus } from './statusy'
import { targetFor } from './propagacja'
import { ACME_CARRIER_RULES } from '@/tests/preset-testowy'
import { compareRevision, validateIncoming, ValidationError } from './zamowienia'

describe('przewoźnik i statusy (spec 7, przypadki 45–47)', () => {
  it('45: reguły 7.2', () => {
    expect(carrierFor('WOO', 'Paczkomaty InPost (Darmowa wysyłka)', ACME_CARRIER_RULES)).toEqual({ carrier: 'PACZKOMATY', shippingModule: 'BASE_COURIER' })
    expect(carrierFor('EMPIK', 'Dostawa do Salonu Empik', ACME_CARRIER_RULES)).toEqual({ carrier: 'DPD_EMPIK', shippingModule: 'BASE_COURIER' })
    expect(carrierFor('WOO', 'DPD Pickup', ACME_CARRIER_RULES)).toEqual({ carrier: 'DPD', shippingModule: 'BASE_COURIER' })
    expect(carrierFor('ALLEGRO', 'Allegro One Box', ACME_CARRIER_RULES)).toEqual({ carrier: 'ALLEGRO', shippingModule: 'WYSYLAM_Z_ALLEGRO' })
    expect(carrierFor('WOO', 'Odbiór osobisty', ACME_CARRIER_RULES)).toEqual({ carrier: 'OSOBISTY', shippingModule: 'BRAK' })
    expect(carrierFor('WOO', 'Teleportacja', ACME_CARRIER_RULES).carrier).toBe('BRAK')
    expect(initialStatus(true, 'BRAK')).toBe('DO_WYJASNIENIA')
  })

  it('46: Paczkomaty za pobraniem → DO_REALIZACJI (w BL zostawało w „Nowe”)', () => {
    expect(initialStatus(true, carrierFor('WOO', 'Paczkomaty InPost za pobraniem', ACME_CARRIER_RULES).carrier)).toBe('DO_REALIZACJI')
  })

  it('47: niedozwolone przejście NOWE → WYSLANE z panelu odrzucone z komunikatem', () => {
    expect(canTransition('NOWE', 'WYSLANE')).toBe(false)
    expect(() => assertTransition('NOWE', 'WYSLANE')).toThrow('Niedozwolone przejście NOWE → WYSLANE')
    expect(canTransition('SPAKOWANE', 'DO_WYSLANIA')).toBe(true)
  })

  it('tabela zgodna z packOrder — SPAKOWANE z DO_REALIZACJI, ZBIERANIE i ZEBRANE', () => {
    for (const from of ['DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE'] as const) expect(canTransition(from, 'SPAKOWANE')).toBe(true)
    expect(canTransition('NOWE', 'SPAKOWANE')).toBe(false)
  })
})

describe('rozbicie ceny zestawu na fakturze (przypadek 27)', () => {
  it('suma brutto = cena zestawu, każdy składnik > 0 zł, różne stawki VAT', () => {
    const lines = splitBundlePrice(4999, [
      { productId: 'przyprawa', qty: 1, retailGross: 39.9, vatRate: '5' },
      { productId: 'kubek', qty: 2, retailGross: 24.99, vatRate: '23' },
    ])
    expect(lines.reduce((s, l) => s + l.lineGrossGr, 0)).toBe(4999)
    expect(lines.every((l) => l.unitGrossGr > 0)).toBe(true)
    expect(lines.find((l) => l.productId === 'kubek')!.vatRate).toBe('23')
  })

  it('mocny rabat i składnik z qty > 1 bez składnika pojedynczego: reszta jako osobna linia, nadal co do grosza', () => {
    const lines = splitBundlePrice(101, [
      { productId: 'a', qty: 3, retailGross: 100, vatRate: '23' },
      { productId: 'b', qty: 2, retailGross: 0.5, vatRate: '5' },
    ])
    expect(lines.reduce((s, l) => s + l.lineGrossGr, 0)).toBe(101)
    expect(lines.every((l) => l.unitGrossGr > 0)).toBe(true)
    expect(lines.filter((l) => l.productId === 'a').reduce((s, l) => s + l.qty, 0)).toBe(3)
  })

  it('cena niższa niż 1 gr na sztukę składnika → błąd zamiast ceny 0', () => {
    expect(() => splitBundlePrice(2, [{ productId: 'a', qty: 3, retailGross: 1, vatRate: '23' }])).toThrow()
  })
})

describe('drobne funkcje rdzenia', () => {
  it('41: qtyBasePerOffer = 3, bufor 1, available 10 → target 3', () => {
    expect(targetFor(10, 1, 3)).toBe(3)
    expect(targetFor(0, 2, 1)).toBe(0)
  })

  it('rewizje: liczbowo albo jak daty ISO', () => {
    expect(compareRevision('10', '9')).toBe(1)
    expect(compareRevision('2026-10-22T10:00:00', '2026-10-22T09:59:59')).toBe(1)
    expect(compareRevision(null, '1')).toBe(0)
  })

  it('walidacja wejścia', () => {
    expect(() =>
      validateIncoming({
        source: 't',
        channel: 'WOO',
        channelAccountId: 'sd',
        externalId: '1',
        createdAtChannel: new Date('x'),
        paymentState: 'PAID',
        paymentMethod: 'BLIK',
        totalGross: 1,
        lines: [],
      }),
    ).toThrow(ValidationError)
  })
})
