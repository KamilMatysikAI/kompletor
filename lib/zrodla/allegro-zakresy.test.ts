// zakresy OAuth Allegro z jednego źródła (panel, CLI, zapis).
import { describe, expect, it } from 'vitest'
import { allegroScope } from '@/scripts/allegro-autoryzacja'
import { FUNKCJA_STANY, FUNKCJA_ZAMOWIENIA } from '@/lib/adaptery/allegro-zapis'
import { FUNKCJA_WYSYLAM } from '@/lib/adaptery/allegro-wysylam-zapis'
import { allegroZakresy, czyFunkcjaAllegro, DOMYSLNE_FUNKCJE_ALLEGRO, etykietaFunkcji, etykietyFunkcji, FUNKCJE_ALLEGRO, funkcjeZZakresu, zakresPozwala } from './allegro-zakresy'

describe('zakresy Allegro', () => {
  it('odczyt zamówień zawsze, bez powtórzeń, stała kolejność', () => {
    expect(allegroZakresy([])).toBe('allegro:api:orders:read')
    expect(allegroZakresy(['wysylamZAllegro', 'przesylki'])).toBe('allegro:api:orders:read allegro:api:shipments:read allegro:api:shipments:write')
    expect(allegroZakresy(['zapisStanow', 'oferty', 'zapisZamowien'])).toBe('allegro:api:orders:read allegro:api:sale:offers:read allegro:api:orders:write allegro:api:sale:offers:write')
  })
  it('komenda CLI daje dokładnie te same zakresy co wcześniej', () => {
    expect(allegroScope()).toBe('allegro:api:orders:read')
    expect(allegroScope(true, true)).toBe('allegro:api:orders:read allegro:api:shipments:read allegro:api:sale:offers:read')
  })
  it('funkcje z zakresu tokenu: tylko w pełni pokryte', () => {
    expect(funkcjeZZakresu('allegro:api:orders:read allegro:api:sale:offers:write')).toEqual(['zamowienia'])
    expect(funkcjeZZakresu(allegroZakresy(['zapisStanow']))).toEqual(['zamowienia', 'oferty', 'zapisStanow'])
    expect(funkcjeZZakresu(null)).toEqual([])
    expect(zakresPozwala(allegroZakresy(['wysylamZAllegro']), 'wysylamZAllegro')).toBe(true)
    expect(zakresPozwala('allegro:api:orders:read', 'zapisZamowien')).toBe(false)
  })
  it('domyślnie tylko odczyty; nazwy funkcji z listy; etykiety po polsku', () => {
    expect(DOMYSLNE_FUNKCJE_ALLEGRO).toEqual(['zamowienia', 'przesylki', 'oferty'])
    expect(czyFunkcjaAllegro('oferty')).toBe(true)
    expect(czyFunkcjaAllegro('allegro:api:orders:read')).toBe(false)
    expect(etykietyFunkcji(['oferty', 'zamowienia'])).toEqual(['Odczyt zamówień', 'Odczyt ofert'])
    for (const f of FUNKCJE_ALLEGRO) expect(f.zakresy.every((z) => z.startsWith('allegro:api:'))).toBe(true)
  })
  it('adaptery zapisu biorą nazwy funkcji z FUNKCJE_ALLEGRO, teksty bez zmian', () => {
    expect(FUNKCJA_STANY).toBe(etykietaFunkcji('zapisStanow'))
    expect(FUNKCJA_ZAMOWIENIA).toBe(etykietaFunkcji('zapisZamowien'))
    expect(FUNKCJA_WYSYLAM).toBe(etykietaFunkcji('wysylamZAllegro'))
    expect([FUNKCJA_STANY, FUNKCJA_ZAMOWIENIA, FUNKCJA_WYSYLAM]).toEqual(['Stany ofert', 'Status i numer nadania', 'Nadawanie Wysyłam z Allegro'])
  })
})
