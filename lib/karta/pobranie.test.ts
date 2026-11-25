// Zmiana płatności z karty: powody z pól zamówienia (czysta funkcja), widok „Do zapłaty przy odbiorze” przy pobraniu,
// sposób płatności słowem po zmianie, forma płatności faktury i zdarzenia automatów.
import { describe, expect, it, vi } from 'vitest'
import { zdarzeniaZDziennika } from '@/lib/automaty/silnik'
import { formaPlatnosci } from '@/lib/wfirma/platnosci'
import { sposobPlatnosci } from './opis'
import { kierunekZmiany, POWODY_ZMIANY_PLATNOSCI as P, powodZPol } from './pobranie'
import { rozliczenie } from './platnosci'

vi.mock('server-only', () => ({}))

const baza = { channel: 'WOO', status: 'NOWE', statusBeforeClarify: null, paymentState: 'UNPAID', carrier: 'DPD', shippingModule: 'DPD_BEZPOSREDNIO', parentOrderId: null } as const

describe('powodZPol', () => {
  it('nieopłacone u kuriera z pobraniem przed zbieraniem: można', () => {
    expect(powodZPol(baza, 'NA_POBRANIE')).toBeNull()
    expect(powodZPol({ ...baza, status: 'DO_WYJASNIENIA', statusBeforeClarify: 'NOWE' }, 'NA_POBRANIE')).toBeNull()
  })
  it('na pobranie: opłacone, częściowo, anulowane, kanał, Wysyłam z Allegro, odbiór osobisty, bez przewoźnika, usługa bez pobrania, paczka dodatkowa', () => {
    expect(powodZPol({ ...baza, paymentState: 'PAID' }, 'NA_POBRANIE')).toBe(P.oplacone)
    expect(powodZPol({ ...baza, paymentState: 'PARTIAL' }, 'NA_POBRANIE')).toBe(P.czesciowo)
    expect(powodZPol({ ...baza, status: 'ANULOWANE' }, 'NA_POBRANIE')).toBe(P.anulowane)
    expect(powodZPol({ ...baza, channel: 'ALLEGRO' }, 'NA_POBRANIE')).toBe(P.kanal)
    expect(powodZPol({ ...baza, channel: 'EMPIK' }, 'NA_POBRANIE')).toBe(P.kanal)
    expect(powodZPol({ ...baza, carrier: 'ALLEGRO', shippingModule: 'WYSYLAM_Z_ALLEGRO' }, 'NA_POBRANIE')).toBe(P.wysylamZAllegro)
    expect(powodZPol({ ...baza, carrier: 'OSOBISTY', shippingModule: 'BRAK' }, 'NA_POBRANIE')).toBe(P.osobisty)
    expect(powodZPol({ ...baza, carrier: 'BRAK', shippingModule: 'BRAK' }, 'NA_POBRANIE')).toBe(P.bezPrzewoznika)
    expect(powodZPol({ ...baza, carrier: 'BEZ_WYSYLKI', shippingModule: 'BRAK' }, 'NA_POBRANIE')).toBe(P.bezPrzewoznika)
    expect(powodZPol({ ...baza, carrier: 'POCZTA_POLSKA', shippingModule: 'POCZTA_POLSKA' }, 'NA_POBRANIE')).toMatch(/nie obsługuje pobrania: najpierw zmień sposób wysyłki/)
    expect(powodZPol({ ...baza, status: 'ZBIERANIE' }, 'NA_POBRANIE')).toBe(P.etapNaPobranie)
    expect(powodZPol({ ...baza, parentOrderId: 'x' }, 'NA_POBRANIE')).toBe(P.paczki)
  })
  it('na nieopłacone: tylko pobranie w „Do realizacji”, nie w kanale Allegro', () => {
    const cod = { ...baza, paymentState: 'COD', status: 'DO_REALIZACJI' } as const
    expect(powodZPol(cod, 'NA_NIEOPLACONE')).toBeNull()
    expect(powodZPol({ ...cod, status: 'DO_WYJASNIENIA', statusBeforeClarify: 'DO_REALIZACJI' }, 'NA_NIEOPLACONE')).toBeNull()
    expect(powodZPol({ ...cod, status: 'SPAKOWANE' }, 'NA_NIEOPLACONE')).toBe(P.etapNaNieoplacone)
    expect(powodZPol({ ...cod, channel: 'ALLEGRO' }, 'NA_NIEOPLACONE')).toBe(P.kanal)
    // odbiór osobisty za pobraniem wolno cofnąć na przelew
    expect(powodZPol({ ...cod, carrier: 'OSOBISTY', shippingModule: 'BRAK' }, 'NA_NIEOPLACONE')).toBeNull()
  })
  it('kierunek z płatności', () => {
    expect(kierunekZmiany('COD')).toBe('NA_NIEOPLACONE')
    for (const p of ['UNPAID', 'PAID', 'PARTIAL'] as const) expect(kierunekZmiany(p)).toBe('NA_POBRANIE')
  })
})

describe('pobranie na karcie i w dokumentach', () => {
  it('rozliczenie pobrania: nic nie zapłacono (pobranie to nie wpłata), bez różnicy', () => {
    expect(rozliczenie({ totalGross: '644.96', paymentState: 'COD', flags: {} }, [])).toEqual({ zamowienieGr: 64496, zaplaconoGr: 0, roznicaGr: 0, pokaz: false, pobranie: true })
    expect(rozliczenie({ totalGross: '644.96', paymentState: 'PAID', flags: {} }, [])).toMatchObject({ zaplaconoGr: 64496, pobranie: false })
  })
  it('sposób płatności przy pobraniu: „Za pobraniem”, nie tytuł metody sprzed zmiany', () => {
    expect(sposobPlatnosci('WOO', 'Przelew bankowy', 'COD')).toBe('Za pobraniem')
    expect(sposobPlatnosci('WOO', 'Przelew bankowy', 'UNPAID')).toBe('Przelew bankowy')
  })
  it('faktura: forma płatności z pobrania, nie z tytułu metody', () => {
    expect(formaPlatnosci('Przelew bankowy', 'COD')).toBe('cod')
  })
  it('automaty: zmiana płatności na karcie zmienia status, ale nie daje „opłacono”', () => {
    const e = (kind: string) => zdarzeniaZDziennika({ kind, actorId: 'user:u', data: {} })
    expect(e('PLATNOSC_NA_POBRANIE')).toEqual(['USTAWIONO_STATUS'])
    expect(e('PLATNOSC_POBRANIE_COFNIETE')).toEqual(['USTAWIONO_STATUS'])
    expect(e('OPLACONE')).toContain('OPLACONO')
  })
})
