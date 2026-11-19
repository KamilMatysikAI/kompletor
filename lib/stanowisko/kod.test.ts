import { describe, expect, it } from 'vitest'
import { kodZamowieniaKarty, numerDoKarty, numerKartyZamowienia, odczytajSkan, przedrostekKodu } from './kod'

describe('odczyt skanu karty', () => {
  it('zamówienie bez i z podzamówieniem', () => {
    expect(odczytajSkan('SD48213/1')).toEqual({
      kodZamowienia: 'SD48213',
      numerWydruku: 1,
      zamowienie: { przedrostek: 'SD', numer: '48213', podzamowienie: null },
    })
    expect(odczytajSkan('SD48213-2/3')).toEqual({
      kodZamowienia: 'SD48213-2',
      numerWydruku: 3,
      zamowienie: { przedrostek: 'SD', numer: '48213', podzamowienie: 2 },
    })
    expect(odczytajSkan('ALG98765432/12')?.kodZamowienia).toBe('ALG98765432')
  })

  it('znaki z czytnika: AIM, Enter, Tab, GS, NBSP, spacje, małe litery, ręcznie przepisany numer', () => {
    expect(odczytajSkan(']C1SD48213/1\r\n')?.kodZamowienia).toBe('SD48213')
    expect(odczytajSkan('\tSD48213-2/1\n')?.kodZamowienia).toBe('SD48213-2')
    expect(odczytajSkan('\u001dSD48213/1\u001d')?.numerWydruku).toBe(1)
    expect(odczytajSkan('\u00a0sd48213/4\u00a0')).toMatchObject({ kodZamowienia: 'SD48213', numerWydruku: 4 })
    expect(odczytajSkan('SD 48213-2 / 1')?.kodZamowienia).toBe('SD48213-2')
    expect(odczytajSkan('\ufeffEMP77/2\u200b')?.kodZamowienia).toBe('EMP77')
    expect(odczytajSkan('ＳＤ４８２１３/１')?.kodZamowienia).toBe('SD48213') // pełna szerokość (IME) → NFKC
  })

  it('śmieci = null (nieznany kod), bez zgadywania', () => {
    for (const s of [
      '',
      '   ',
      '5901234123457', // EAN produktu
      'SD48213', // bez numeru wydruku
      'SD48213/0',
      'SD48213-0/1',
      'SD48213/99999999999999999999',
      'SD48213/',
      '/1',
      '48213/1', // bez przedrostka
      'SD48213-/1',
      'SD-48213/1',
      'K1H48213/1',
      'SD48213/1/2',
      'SD48213.1',
      "SD48213/1' OR 1=1",
      'SD' + '9'.repeat(80) + '/1', // za długi
      'x'.repeat(10_000),
    ]) {
      expect(odczytajSkan(s), JSON.stringify(s.slice(0, 30))).toBeNull()
    }
    expect(odczytajSkan(undefined as unknown as string)).toBeNull()
  })

  it('kod zamówienia do rejestru jak na wydruku', () => {
    expect(kodZamowieniaKarty({ przedrostek: 'sd', numer: '48213' })).toBe('SD48213')
    expect(kodZamowieniaKarty({ przedrostek: 'SD', numer: '48213', podzamowienie: 2 })).toBe('SD48213-2')
    expect(() => kodZamowieniaKarty({ przedrostek: 'ALG', numer: '3f2c1a9e-7b4d' })).toThrow(/cyfry/)
  })

  it('przedrostek do kodu: jak w panelu, tylko A–Z', () => {
    expect(przedrostekKodu('WOO', 'SklepDemo')).toBe('SD')
    expect(przedrostekKodu('WOO', 'HurtDemo')).toBe('HD')
    expect(przedrostekKodu('ALLEGRO', 'Allegro')).toBe('ALG')
    expect(przedrostekKodu('EMPIK', 'Empik')).toBe('EMP')
    expect(przedrostekKodu('RECZNE', null)).toBe('RE')
    expect(przedrostekKodu('WOO', 'Łąka Śliwek')).toBe('LS')
  })

  it('numer liczbowy: id kanału → numer w kanale → numer BL; Allegro z UUID bez BL = brak', () => {
    expect(numerDoKarty({ externalId: '48213' })).toBe('48213')
    expect(numerDoKarty({ externalId: '118438', channelNumber: '158405' })).toBe('118438')
    expect(numerDoKarty({ externalId: '3f2c1a9e-7b4d-4e1a-9c0b-1d2e3f4a5b6c', blOrderId: 9123456 })).toBe('9123456')
    expect(numerDoKarty({ externalId: 'A-77', channelNumber: '77' })).toBe('77')
    expect(numerDoKarty({ externalId: '3f2c1a9e-7b4d-4e1a-9c0b-1d2e3f4a5b6c', blOrderId: null })).toBeNull()
    expect(numerDoKarty({ externalId: 'x', blOrderId: 0 })).toBeNull()
  })
})

describe('numerKartyZamowienia', () => {
  it('Woo z numerem wtyczki, dosyłka z numerem paczki, Allegro bez numeru = null', () => {
    expect(numerKartyZamowienia({ channel: 'WOO', nazwaKonta: 'SklepDemo', numerZrodlowy: { externalId: 'abc', channelNumber: '48213' }, podzamowienie: null })).toEqual({ przedrostek: 'SD', numer: '48213', podzamowienie: null })
    expect(numerKartyZamowienia({ channel: 'WOO', nazwaKonta: 'SklepDemo', numerZrodlowy: { externalId: '6001' }, podzamowienie: 2 })).toEqual({ przedrostek: 'SD', numer: '6001', podzamowienie: 2 })
    expect(numerKartyZamowienia({ channel: 'ALLEGRO', nazwaKonta: 'Allegro', numerZrodlowy: { externalId: '3f2c1a9e-7b4d' }, podzamowienie: null })).toBeNull()
  })
})
