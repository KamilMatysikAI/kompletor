// ukryte kolumny tabel zapisane na koncie osoby.
import { describe, expect, it } from 'vitest'
import { ukryteKolumny, zKolumnami } from './kolumny'

describe('kolumny per osoba', () => {
  it('brak wyboru = null (domyślne tabeli), zapis jednej tabeli nie rusza innych, śmieci odrzucone', () => {
    expect(ukryteKolumny(null, 'zamowienia')).toBeNull()
    const v = zKolumnami({ produkty: ['cena'] }, 'zamowienia', ['kraj', 'kraj', 'data', '<script>', 7])
    expect(v).toEqual({ produkty: ['cena'], zamowienia: ['kraj', 'data'] })
    expect(ukryteKolumny(v, 'zamowienia')).toEqual(['kraj', 'data'])
    expect(ukryteKolumny(zKolumnami(v, 'zamowienia', []), 'zamowienia')).toEqual([]) // wszystkie widoczne ≠ brak wyboru
    expect(zKolumnami(v, '../x', ['a'])).toBeNull()
    expect(zKolumnami(v, 'zamowienia', 'kraj')).toBeNull()
    expect(ukryteKolumny({ zamowienia: 'kraj' }, 'zamowienia')).toBeNull()
  })
})
