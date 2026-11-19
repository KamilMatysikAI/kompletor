// czyste funkcje powiązań (stan, przelicznik z formularza, opis w historii produktu).
import { describe, expect, it } from 'vitest'
import { opisPowiazania, PowiazaniaError, stanPowiazania, sztukZTekstu } from './powiazania'

describe('stanPowiazania', () => {
  it('rozróżnia powiązaną, propozycję, wyłączoną importem i odłączoną', () => {
    expect(stanPowiazania({ active: true, needsApproval: false, deactivatedByImportAt: null })).toBe('AKTYWNA')
    expect(stanPowiazania({ active: false, needsApproval: true, deactivatedByImportAt: new Date() })).toBe('PROPOZYCJA')
    expect(stanPowiazania({ active: false, needsApproval: false, deactivatedByImportAt: new Date() })).toBe('WYLACZONA_IMPORTEM')
    expect(stanPowiazania({ active: false, needsApproval: false, deactivatedByImportAt: null })).toBe('ODLACZONA')
  })
})

describe('sztukZTekstu', () => {
  it('puste = 1, liczba całkowita od 1, reszta = czytelna odmowa', () => {
    expect(sztukZTekstu('')).toBe(1)
    expect(sztukZTekstu(' 3 ')).toBe(3)
    for (const z of ['0', '-1', '1,5', 'abc', '1000001']) expect(() => sztukZTekstu(z)).toThrow(PowiazaniaError)
  })
})

describe('opisPowiazania', () => {
  it('wpis historii po ludzku', () => {
    expect(opisPowiazania({ powiazanie: 'dodane', oferta: 'WOO/sd nr 501', przelicznik: 3 })).toBe('powiązana oferta WOO/sd nr 501 (przelicznik 3)')
    expect(opisPowiazania({ powiazanie: 'dodane', oferta: 'WOO/sd nr 501', przelicznik: 1, zProduktu: 'A' })).toBe('powiązana oferta WOO/sd nr 501, przepięta z SKU „A”')
    expect(opisPowiazania({ powiazanie: 'odlaczone', oferta: 'ALLEGRO/a nr 9' })).toBe('odłączona oferta ALLEGRO/a nr 9')
    expect(opisPowiazania({ powiazanie: 'przepiete', oferta: 'X', naProdukt: 'B' })).toBe('oferta X przepięta na SKU „B”')
    expect(opisPowiazania({ powiazanie: 'dodane', oferta: 'X', masowo: 'EAN' })).toBe('powiązana oferta X (łączenie po EAN)')
  })
})
