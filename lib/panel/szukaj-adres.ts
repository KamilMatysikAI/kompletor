// adres listy zamówień po wyszukaniu jednym polem (akcja serwera app/(panel)/zamowienia/akcje-szukaj.ts).
// Czysty moduł (test w szukaj-adres.test.ts): które parametry listy zostają, kiedy fraza idzie zaszyfrowana (`qz`),
// kiedy jawnie (`q`), a kiedy wcale (komunikat `kb`).
import { odczytaniaFrazy, rozpoznajFraze } from '../klienci/skroty'

/** Parametry listy przenoszone przy nowym wyszukiwaniu (bez strony: wynik zaczyna się od pierwszej). */
const ZOSTAJA = ['widok', 'status', 'kanal', 'przewoznik', 'platnosc', 'od', 'do', 'faktura', 'kraj', 'sf', 'sg', 'sort', 'kier', 'ile'] as const

/**
 * telefon w zapisie telefonicznym („+48 511 222 333”, „(61) 222-33-44”) u osoby bez dostępu do danych
 * klientów nie idzie jawnie do adresu (i tak nic by nie znalazł). Same cyfry zostają, bo to też numer zamówienia, EAN
 * albo numer przesyłki.
 */
function telefonWZapisie(f: string): boolean {
  return rozpoznajFraze(f).rodzaj === 'telefon' && /[+\s()-]/.test(f)
}

/** Czysta część (test): adres listy po wyszukaniu. `zapieczetuj` = null, gdy osoba nie szuka po klientach. */
export function adresPoSzukaniu(fraza: string, powrot: string, zapieczetuj: ((f: string) => string) | null): string {
  const stare = new URLSearchParams(powrot.replace(/^\?/, '').slice(0, 2000))
  const p = new URLSearchParams()
  for (const k of ZOSTAJA) {
    const v = stare.get(k)
    if (v) p.set(k, v.slice(0, 100))
  }
  const f = fraza.trim().slice(0, 120)
  if (f) {
    if (zapieczetuj) {
      try {
        p.set('qz', zapieczetuj(f))
      } catch {
        // brak klucza danych klientów: numery i produkty dalej jawnie, dane klienta nie trafiają do adresu
        if (odczytaniaFrazy(f).length || f.includes('@')) p.set('kb', 'klucz')
        else p.set('q', f)
      }
    } else if (f.includes('@') || telefonWZapisie(f)) p.set('kb', 'uprawnienia')
    else p.set('q', f)
  }
  const s = p.toString()
  return s ? `/zamowienia?${s}` : '/zamowienia'
}
