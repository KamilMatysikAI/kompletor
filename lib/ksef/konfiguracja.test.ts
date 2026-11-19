// wybór programu do faktur i ustawienia KSeF firmy. ACME (tests/preset-testowy.ts) zostaje przy wFirmie.
import { describe, expect, it } from 'vitest'
import { ACME_PRESET } from '../../tests/preset-testowy'
import { parseKonfiguracjaKsef, programFaktur } from './konfiguracja'

describe('programFaktur', () => {
  it('wFirma domyślnie: bez pola, bez faktur, inna wartość; ksef tylko jawnie', () => {
    expect(programFaktur(null)).toBe('wfirma')
    expect(programFaktur({})).toBe('wfirma')
    expect(programFaktur({ faktury: {} })).toBe('wfirma')
    expect(programFaktur({ faktury: { program: 'KSEF' } })).toBe('wfirma')
    expect(programFaktur({ faktury: { program: 'ksef' } })).toBe('ksef')
  })

  it('ACME z tests/preset-testowy.ts: wFirma (KSeF obsługuje wFirma)', () => {
    expect(programFaktur(ACME_PRESET.settings as never)).toBe('wfirma')
  })
})

describe('parseKonfiguracjaKsef', () => {
  it('pełne ustawienia', () => {
    const k = parseKonfiguracjaKsef({ ksef: { sprzedawca: { nip: '111-111-11-11', nazwa: 'Sprzedawca', adres: { linia1: 'ul. A 1', linia2: '00-001 Miasto' } }, seriaKod: 'FV', konsumenciDoKsef: true, podstawaZwolnienia: 'art. 43' } })
    expect(k).toEqual({ sprzedawca: { nip: '111-111-11-11', nazwa: 'Sprzedawca', adres: { kodKraju: 'PL', linia1: 'ul. A 1', linia2: '00-001 Miasto' } }, seriaKod: 'FV', konsumenciDoKsef: true, podstawaZwolnienia: 'art. 43', problemy: [], seria: { code: 'FV', pattern: 'FV/{NR}/{MM}/{RRRR}', resetPeriod: 'ROK' }, seriaKorekt: null, srodowisko: 'TEST', dataPrzyPonowieniu: 'PIERWSZA_PROBA' })
  })

  it('brak danych sprzedawcy i serii = problemy; konsumenci domyślnie poza KSeF', () => {
    const k = parseKonfiguracjaKsef({})
    expect(k.sprzedawca).toBeNull()
    expect(k.konsumenciDoKsef).toBe(false)
    expect(k.problemy.map((p) => p.kod)).toEqual(['brak-nip-sprzedawcy', 'brak-nazwy-sprzedawcy', 'brak-adresu-sprzedawcy', 'brak-serii'])
    expect(parseKonfiguracjaKsef({ ksef: { sprzedawca: { nip: '1111111112' } } }).problemy.map((p) => p.kod)).toContain('nip-zly')
    expect(parseKonfiguracjaKsef({ ksef: { konsumenciDoKsef: 'tak' } }).konsumenciDoKsef).toBe(false)
  })
})

describe('dataPrzyPonowieniu', () => {
  it('domyślnie data pierwszej próby; „dzień wysyłki” tylko jawnie; śmieci = domyślnie', () => {
    expect(parseKonfiguracjaKsef({}).dataPrzyPonowieniu).toBe('PIERWSZA_PROBA')
    expect(parseKonfiguracjaKsef({ ksef: { dataPrzyPonowieniu: 'DZIEN_WYSYLKI' } }).dataPrzyPonowieniu).toBe('DZIEN_WYSYLKI')
    expect(parseKonfiguracjaKsef({ ksef: { dataPrzyPonowieniu: 'cokolwiek' } }).dataPrzyPonowieniu).toBe('PIERWSZA_PROBA')
  })
})
