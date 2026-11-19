// powody nieaktywnych przycisków karty zamówienia na koncie poza trybem PRACA.
import { describe, expect, it } from 'vitest'
import { KOMUNIKAT_CIEN, powodyPodgladu } from './bramka'

describe('powodyPodgladu', () => {
  it('firma z BaseLinkerem, konto w podglądzie: BL z nazwy i ekran, gdzie konto się włącza', () => {
    const p = powodyPodgladu({ statusMode: 'CIEN', firmaZBl: true })
    expect(p.platnosc).toBe('Wpłatę zapisujesz w BaseLinkerze, dopóki konto sklepu jest w trybie „Tylko podgląd”. Włączysz je w Ustawienia → Sprzedaż i kanały → Kanały sprzedaży.')
    expect(p.status).toMatch(/^Zmiany zamówienia robisz w BaseLinkerze, dopóki/)
    expect(p.pozycje).toMatch(/^Pozycje zmieniasz w BaseLinkerze, dopóki/)
  })

  it('firma bez BaseLinkera i konto bez konfiguracji: bez nazwy BL', () => {
    for (const k of [{ statusMode: 'CIEN' as const, firmaZBl: false }, null]) {
      const p = powodyPodgladu(k)
      expect(p.platnosc).not.toMatch(/BaseLinker/)
      expect(p.platnosc).toMatch(/tam, gdzie prowadzisz zamówienia dziś.*Ustawienia → Sprzedaż i kanały → Kanały sprzedaży/)
    }
  })

  it('konto w PRACA zatrzymane wyłącznikiem instancji: nie odsyła do Kanałów sprzedaży', () => {
    const p = powodyPodgladu({ statusMode: 'PRACA', firmaZBl: true })
    expect(p.status).toMatch(/wyłączony na tej instalacji/)
    expect(p.status).not.toMatch(/Kanały sprzedaży/)
  })

  it('baner podglądu zostaje i nie obiecuje, że przyciski „pojawią się”', () => {
    expect(KOMUNIKAT_CIEN).toMatch(/^Konto sklepu w trybie „Tylko podgląd”/)
    expect(KOMUNIKAT_CIEN).not.toMatch(/pojawią się/)
  })
})
