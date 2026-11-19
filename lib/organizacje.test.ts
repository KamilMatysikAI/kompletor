import { describe, expect, it } from 'vitest'
import { ACME_CARRIER_RULES, ACME_PRESET } from '@/tests/preset-testowy'
import { appModeOf, envSecretsAllowed, fillMissingCatalog, parseOrgSettings, validatePreset } from './organizacje'
import { carrierFromRules, DEFAULT_CARRIER_RULES, validateCarrierRule } from './rdzen/przewoznicy'

describe('organizacje: tryb i klucze z env', () => {
  it('hosting nigdy nie bierze kluczy z env; self-host tylko jedyna albo wskazana firma', () => {
    const org = { slug: 'acme' }
    expect(envSecretsAllowed({ APP_MODE: 'hosted' }, org, 1)).toBe(false)
    expect(envSecretsAllowed({}, org, 1)).toBe(true)
    expect(envSecretsAllowed({}, org, 2)).toBe(false)
    expect(envSecretsAllowed({ SELFHOST_ORG_SLUG: 'acme' }, org, 2)).toBe(true)
    expect(envSecretsAllowed({ SELFHOST_ORG_SLUG: 'inna' }, org, 1)).toBe(false)
    expect(() => appModeOf({ APP_MODE: 'saas' })).toThrow(/APP_MODE/)
  })

  it('ustawienia firmy: tylko znane pola, puste odrzucone', () => {
    expect(parseOrgSettings({ baselinker: { inventoryId: ' 77701 ' }, inne: 1 })).toEqual({ baselinker: { inventoryId: '77701' } })
    expect(parseOrgSettings({ baselinker: { inventoryId: '' } })).toEqual({})
    expect(parseOrgSettings(null)).toEqual({})
  })

  it('catalog z presetu: uzupełnia podklucze brakujące i puste listy, niepuste wartości firmy zostają', () => {
    const preset = { noStock: { skus: ['ebook1'] }, nonOfferSkus: ['naklejka', '80011'] }
    expect(fillMissingCatalog({ noStock: { skus: ['ebook1'] }, nonOfferSkus: [] }, preset)).toEqual(preset)
    expect(fillMissingCatalog({ noStock: { skus: ['ebook1'] } }, preset)).toEqual(preset)
    expect(fillMissingCatalog(undefined, preset)).toEqual(preset)
    expect(fillMissingCatalog({ noStock: { skus: [], shopCategories: ['7100001:12'] } }, preset)).toEqual({ noStock: { skus: ['ebook1'], shopCategories: ['7100001:12'] }, nonOfferSkus: ['naklejka', '80011'] })
    expect(fillMissingCatalog({ noStock: { skus: ['ebook-firmy'] }, nonOfferSkus: [] }, preset)).toEqual({ noStock: { skus: ['ebook-firmy'] }, nonOfferSkus: ['naklejka', '80011'] })
    expect(fillMissingCatalog({ noStock: { skus: ['ebook-firmy'] }, nonOfferSkus: ['wlasny'], inne: 1 }, preset)).toBeNull()
    expect(fillMissingCatalog({ nonOfferSkus: ['wlasny'] }, { nonOfferSkus: [] })).toBeNull()
    // lista noStock z panelu (także pusta) zostaje, nonOfferSkus dalej uzupełniane z presetu
    expect(fillMissingCatalog({ noStock: { skus: [] }, edytowanoWPanelu: true }, preset)).toEqual({ noStock: { skus: [] }, edytowanoWPanelu: true, nonOfferSkus: ['naklejka', '80011'] })
    expect(fillMissingCatalog({ noStock: { skus: [] }, nonOfferSkus: ['wlasny'], edytowanoWPanelu: true }, preset)).toBeNull()
  })

  it('preset: walidacja id, sluga i reguł', () => {
    expect(() => validatePreset(ACME_PRESET)).not.toThrow()
    expect(() => validatePreset({ ...ACME_PRESET, id: 'Zła firma' })).toThrow(/id organizacji/)
    expect(() => validatePreset({ ...ACME_PRESET, slug: '-x' })).toThrow(/slug/)
    expect(() => validatePreset({ ...ACME_PRESET, carrierRules: [{ ...ACME_CARRIER_RULES[0]!, pattern: '(' }] })).toThrow(/wzorzec/)
    // adres feedu w presecie ta sama osłona co przy odczycie (IP, http, nazwa wewnętrzna = błąd seeda)
    const zFeedem = (url: string) => ({ ...ACME_PRESET, settings: { ...ACME_PRESET.settings, feedyProduktowe: { adresy: [{ url }] } } })
    expect(() => validatePreset(zFeedem('https://sklep.example.test/feed.xml'))).not.toThrow()
    for (const zly of ['https://10.0.0.1/x.xml', 'http://sklep.example.test/f.xml', 'https://serwer.internal/f.xml']) expect(() => validatePreset(zFeedem(zly))).toThrow(/adres feedu/)
  })
})

describe('przewoźnicy z reguł firmy', () => {
  it('zestaw startowy rozpoznaje przewoźnika bez modułu wysyłki (Base Courier to wybór firmy)', () => {
    expect(carrierFromRules(DEFAULT_CARRIER_RULES, 'WOO', 'Paczkomaty InPost')).toEqual({ carrier: 'PACZKOMATY', shippingModule: 'BRAK' })
    expect(carrierFromRules(DEFAULT_CARRIER_RULES, 'ALLEGRO', 'cokolwiek')).toEqual({ carrier: 'ALLEGRO', shippingModule: 'WYSYLAM_Z_ALLEGRO' })
    expect(carrierFromRules([], 'WOO', 'Paczkomaty').carrier).toBe('BRAK')
  })

  it('priorytet wygrywa niezależnie od kolejności w tablicy; filtr kanału; wielkość liter bez znaczenia', () => {
    const rules = [...ACME_CARRIER_RULES].reverse()
    expect(carrierFromRules(rules, 'WOO', 'KURIER DPD')).toEqual({ carrier: 'DPD', shippingModule: 'BASE_COURIER' })
    expect(carrierFromRules(rules, 'ALLEGRO', 'Paczkomaty InPost')).toEqual({ carrier: 'ALLEGRO', shippingModule: 'WYSYLAM_Z_ALLEGRO' })
    expect(carrierFromRules(rules, 'EMPIK', 'Dostawa do salonu Empik')).toEqual({ carrier: 'DPD_EMPIK', shippingModule: 'BASE_COURIER' })
  })

  it('reguła przewoźnika nie dotyczy rodziny AI (integracja, nie kanał sprzedaży)', () => {
    expect(() => validateCarrierRule({ priority: 1, channel: 'AI', pattern: null, carrier: 'DPD', shippingModule: 'BRAK' })).toThrow(/AI/)
  })

  it('zła reguła: odrzucona przy zapisie, a w bazie nie pasuje do niczego', () => {
    expect(() => validateCarrierRule({ priority: 1, channel: null, pattern: '[', carrier: 'DPD', shippingModule: 'BRAK' })).toThrow()
    expect(carrierFromRules([{ priority: 1, channel: null, pattern: '[', carrier: 'DPD', shippingModule: 'BRAK' }], 'WOO', '[').carrier).toBe('BRAK')
  })
})
