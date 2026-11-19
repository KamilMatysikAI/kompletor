// Przypomnienie o płatności po nieudanej płatności online: wybór wariantu, podgląd akcji z danymi firmy i bez rachunku.
// Bez bazy.
import { describe, expect, it } from 'vitest'
import type { KontekstMarki } from '../maile'
import { podgladAkcji, type ZrodloPodgladu } from './podglad'
import { brakiDanychPrzelewu, danePrzelewu, DROGA_DANYCH_FIRMY, informacjaBezDanychPrzelewu, wariantPrzypomnienia } from './wariant-platnosci'

const FIRMA: KontekstMarki = {
  firma: { nazwa: 'Pracownia Testowa sp. z o.o.', adres: ['ul. Zielona 5', '60-001 Poznań'], email: 'kontakt@pracownia.example', emailBiura: 'biuro@pracownia.example' },
  sklep: { nazwa: 'Pracownia', kolorGlowny: '#24527a', odpowiedzDo: 'sklep@pracownia.example', odbiorOsobisty: null },
}
const zrodlo = (z: Partial<ZrodloPodgladu> = {}): ZrodloPodgladu => ({ kontekst: FIRMA, uwaga: 'u', pozycje: [{ nazwa: 'Wazon szklany 20 cm', ilosc: 2 }], ...z })
const VARS = { numerZamowienia: 'ZAM 4711', kwotaGr: 21_780, terminAnulowania: '2026-11-20T12:00:00.000Z' }

describe('wariant przypomnienia o płatności', () => {
  it('znacznik nieudanej płatności online i brak wpłaty = „Nieudana płatność online”; reszta zwykły mail', () => {
    expect(wariantPrzypomnienia({ flags: { nieudanaPlatnoscOnline: true }, paymentState: 'UNPAID' })).toBe('nieudana-platnosc')
    expect(wariantPrzypomnienia({ flags: { nieudanaPlatnoscOnline: true }, paymentState: 'PARTIAL' })).toBe('brak-platnosci')
    expect(wariantPrzypomnienia({ flags: { nieudanaPlatnoscOnline: true }, paymentState: 'PAID' })).toBe('brak-platnosci')
    expect(wariantPrzypomnienia({ flags: {}, paymentState: 'UNPAID' })).toBe('brak-platnosci')
    expect(wariantPrzypomnienia({ flags: null, paymentState: 'UNPAID' })).toBe('brak-platnosci')
    expect(wariantPrzypomnienia({ flags: { nieudanaPlatnoscOnline: 'tak' }, paymentState: 'UNPAID' })).toBe('brak-platnosci')
  })

  it('dane do przelewu: rachunek bez spacji i pełna nazwa z profilu firmy; bez któregokolwiek = null', () => {
    expect(danePrzelewu({ firma: { nazwa: 'Pracownia Testowa sp. z o.o.', rachunek: '12 3456 7890 1234 5678 9012 3456' } })).toEqual({ rachunek: '12345678901234567890123456', odbiorca: 'Pracownia Testowa sp. z o.o.' })
    expect(danePrzelewu({ firma: { rachunek: '12345678901234567890123456' } })).toBeNull()
    expect(danePrzelewu({ firma: { nazwa: 'Pracownia' } })).toBeNull()
    expect(danePrzelewu(null)).toBeNull()
  })

  it('braki danych do przelewu i informacja dla biura z drogą do ekranu', () => {
    expect(brakiDanychPrzelewu({ firma: {} })).toEqual(['numeru rachunku', 'pełnej nazwy firmy'])
    expect(brakiDanychPrzelewu({ firma: { nazwa: 'Pracownia' } })).toEqual(['numeru rachunku'])
    expect(brakiDanychPrzelewu({ firma: { nazwa: 'Pracownia', rachunek: '12345678901234567890123456' } })).toEqual([])
    const t = informacjaBezDanychPrzelewu(['pełnej nazwy firmy'])
    expect(t).toContain('zwykły mail „Brak płatności”')
    expect(t).toContain('brakuje pełnej nazwy firmy')
    expect(t).toContain(DROGA_DANYCH_FIRMY)
  })
})

describe('podgląd akcji „Brak płatności” po nieudanej płatności online', () => {
  it('dane firmy: pytanie o problem, dane do przelewu z rachunkiem i tytułem, zdanie o zwolnionym towarze', () => {
    const p = podgladAkcji('mail.brak-platnosci', VARS, zrodlo({ wariant: 'nieudana-platnosc', rachunek: '12345678901234567890123456', towarZwolniony: true }))
    expect(p.temat).toBe('Czy był problem z płatnością za zamówienie ZAM 4711?')
    expect(p.tekst).toContain('Czy wystąpił jakiś problem z płatnością?')
    expect(p.tekst).toContain('Pracownia Testowa sp. z o.o.')
    expect(p.tekst).toContain('12 3456 7890 1234 5678 9012 3456')
    expect(p.tekst).toContain('Zamówienie ZAM 4711')
    expect(p.tekst).toMatch(/217,80.zł/)
    expect(p.tekst).toContain('nie jest już dla Państwa zarezerwowany')
    expect(p.tekst).toContain('20 listopada 2026')
    expect(p.tekst).toContain('2 × Wazon szklany 20 cm')
    expect(p.braki).toEqual([])
  })

  it('towar jeszcze trzymany (długi krótki termin): bez zdania o zwolnieniu', () => {
    const p = podgladAkcji('mail.brak-platnosci', VARS, zrodlo({ wariant: 'nieudana-platnosc', rachunek: '12345678901234567890123456', towarZwolniony: false }))
    expect(p.tekst).not.toContain('zarezerwowany')
    expect(p.tekst).toContain('Numer rachunku')
  })

  it('brak rachunku przy prawdziwych danych: zwykły „Brak płatności” jak przy wysyłce i informacja z drogą do Danych firmy', () => {
    const p = podgladAkcji('mail.brak-platnosci', VARS, zrodlo({ wariant: 'nieudana-platnosc', rachunek: null }))
    expect(p.temat).toBe('Przypomnienie o płatności za zamówienie ZAM 4711')
    expect(p.braki).toEqual([])
    expect(p.informacje).toEqual([`${informacjaBezDanychPrzelewu(['numeru rachunku'])}.`])
    expect(p.informacje![0]).toContain(DROGA_DANYCH_FIRMY)
    expect(p.tekst).not.toContain('Numer rachunku')
  })

  it('tytuł przelewu z numerem ze sklepu bez przedrostka konta; numer z przedrostkiem zostaje w treści', () => {
    const p = podgladAkcji('mail.brak-platnosci', VARS, zrodlo({ wariant: 'nieudana-platnosc', rachunek: '12345678901234567890123456', numerWSklepie: '4711' }))
    expect(p.tekst).toContain('Zamówienie 4711')
    expect(p.tekst).not.toContain('Zamówienie ZAM 4711')
    expect(p.temat).toContain('ZAM 4711')
  })

  it('odbiorca przelewu z Danych firmy, nie z nazwy w stopce', () => {
    const p = podgladAkcji('mail.brak-platnosci', VARS, zrodlo({ wariant: 'nieudana-platnosc', rachunek: '12345678901234567890123456', odbiorcaPrzelewu: 'Pełna Nazwa Spółki sp. z o.o.' }))
    expect(p.tekst).toContain('Pełna Nazwa Spółki sp. z o.o.')
  })

  it('zamówienie przełączone na przelew: wariant ze stanu (zwykły mail) wygrywa z zapisanym w planie', () => {
    const p = podgladAkcji('mail.brak-platnosci', { ...VARS, wariant: 'nieudana-platnosc' }, zrodlo({ wariant: 'brak-platnosci' }))
    expect(p.temat).toBe('Przypomnienie o płatności za zamówienie ZAM 4711')
    expect(p.tekst).not.toContain('Numer rachunku')
  })

  it('dane przykładowe (edytor, plan bez zamówienia): wariant z planu, rachunek przykładowy, bez braków', () => {
    const p = podgladAkcji('mail.brak-platnosci', { ...VARS, wariant: 'nieudana-platnosc' })
    expect(p.temat).toBe('Czy był problem z płatnością za zamówienie ZAM 4711?')
    expect(p.tekst).toContain('12 3456 7890 1234 5678 9012 3456')
    expect(p.braki).toEqual([])
  })

  it('bez terminu anulowania: akcja pominięta także w tym wariancie', () => {
    const p = podgladAkcji('mail.brak-platnosci', { numerZamowienia: 'ZAM 1', wariant: 'nieudana-platnosc' }, zrodlo({ wariant: 'nieudana-platnosc', rachunek: '12345678901234567890123456' }))
    expect(p.temat).toBe('—')
  })
})
