// powody odmowy przeprowadzki dla ekranu, bez języka polecenia.
import { describe, expect, it } from 'vitest'
import { powodDlaEkranu } from './powody-ekran'

const ZARGON = /CIEN|--mapa|--katalog|--z-zrzutu|getInventories|WOO\//

describe('powodDlaEkranu', () => {
  const powody = [
    'nie wszystkie otwarte zamówienia zostały pobrane z BL (limit stron albo błąd, patrz „problemy pobierania”) — zbierz dane od nowa',
    'firma ma konta kanałów w trybie innym niż CIEN (WOO/sklep, ALLEGRO/konto) — przeprowadzka zapisuje tylko do firmy w cieniu',
    'firma ma już zamówienia z własnych kanałów albo z panelu — pracuje w cieniu i nie jest celem przeprowadzki (tryb próbny działa)',
    'firma ma już ustawiony katalog BL 111, a plan wskazuje 222',
    'statusy BL do decyzji z otwartymi zamówieniami: 5 „Status Xyz” (3 zam.) — wpisz decyzję w pliku mapy (--mapa)',
    'statusy BL do decyzji z otwartymi zamówieniami: 5 „Status Xyz” (3 zam.): wybierz status w sekcji „Decyzje”',
    'mapa otwiera statusy 7, 8, których zamówień zrzut nie zawiera — zbierz dane od nowa (bez --z-zrzutu)',
    'katalogu 9 nie ma w BL (są: 1, 2)',
    'w BL jest 2 katalogów (1 „Główny”, 2 „Hurt”) — wskaż jeden: --katalog <id>',
    'BL nie zwrócił żadnego katalogu (getInventories)',
  ]

  it('każdy znany powód: zdanie z wielkiej litery, bez żargonu polecenia i bez identyfikatorów kont', () => {
    for (const p of powody) {
      const w = powodDlaEkranu(p)
      expect(w.tekst, p).not.toMatch(ZARGON)
      expect(w.tekst.charAt(0), p).toBe(w.tekst.charAt(0).toUpperCase())
    }
  })

  it('statusy: lista z nazwą i liczbą zamówień, odesłanie do sekcji „Decyzje” (obie wersje zapisu)', () => {
    for (const p of [powody[4]!, powody[5]!]) expect(powodDlaEkranu(p)).toEqual({ tekst: 'Statusy BaseLinkera z otwartymi zamówieniami czekają na decyzję: 5 „Status Xyz” (3 zam.). Wybierz dla nich status w Kompletorze.', href: '#decyzje', etykieta: 'Decyzje' })
  })

  it('konta w pracy: odesłanie do kanałów; kilka katalogów: lista bez polecenia', () => {
    expect(powodDlaEkranu(powody[1]!)).toMatchObject({ href: '/ustawienia/kanaly' })
    expect(powodDlaEkranu(powody[8]!).tekst).toContain('(1 „Główny”, 2 „Hurt”)')
    // wybór katalogu z panelu: odesłanie do „Decyzji”, bez administratora
    expect(powodDlaEkranu(powody[8]!)).toMatchObject({ href: '#decyzje' })
    expect(powodDlaEkranu(powody[8]!).tekst).not.toMatch(/administrator/)
    expect(powodDlaEkranu(powody[7]!)).toMatchObject({ href: '#decyzje' })
  })

  it('nieznany powód: bez flag polecenia, z wielkiej litery', () => {
    expect(powodDlaEkranu('coś nowego — zrób to (--flaga x)')).toEqual({ tekst: 'Coś nowego: zrób to' })
  })
})
