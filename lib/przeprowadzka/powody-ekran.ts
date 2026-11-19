// Powody odmowy przeprowadzki w języku ekranu. `powodyOdmowy` (zapis.ts) pisze
// teksty dla polecenia administratora (CIEN, identyfikatory kont, --mapa, --katalog); polecenie i jego raport zostają
// bez zmian, a ekran „Przeprowadzka z BaseLinkera” pokazuje właścicielowi ten słownik: co jest nie tak, co zrobić
// i gdzie (kotwica albo ekran panelu). Czysta funkcja: działa też na streszczeniach zapisanych przed zmianą.

export interface PowodEkranu {
  tekst: string
  /** Gdzie to naprawić (adres w panelu albo kotwica na tym ekranie). */
  href?: string
  etykieta?: string
}

const KANALY = { href: '/ustawienia/kanaly', etykieta: 'Kanały sprzedaży' }
const DECYZJE = { href: '#decyzje', etykieta: 'Decyzje' }
const PROBA = { href: '#proba', etykieta: 'Tryb próbny' }

/** Lista po dwukropku, przed „ — ” (np. statusy z liczbą zamówień). */
const listaZ = (p: string): string => {
  const i = p.indexOf(': ')
  const j = p.lastIndexOf(' — ')
  return i >= 0 ? p.slice(i + 2, j > i ? j : undefined).trim() : ''
}

/** Końcówka, którą `streszczenie` (z-panelu.ts) wstawia w miejsce „— wpisz decyzję w pliku mapy (--mapa)”. */
const KONCOWKA_DECYZJI = ': wybierz status w sekcji „Decyzje”'

export function powodDlaEkranu(p: string): PowodEkranu {
  const t = p.trim().replace(KONCOWKA_DECYZJI, ' — ')
  if (t.startsWith('nie wszystkie otwarte zamówienia'))
    return { tekst: 'Nie wszystkie otwarte zamówienia udało się pobrać z BaseLinkera (błąd po jego stronie albo bardzo dużo zamówień). Uruchom tryb próbny jeszcze raz.', ...PROBA }
  if (t.startsWith('firma ma konta kanałów w trybie innym niż'))
    return {
      tekst: 'Część kont sklepów prowadzi już zamówienia w Kompletorze (tryb pracy). Import zapisuje tylko do kont w trybie „Tylko podgląd”: przełącz je na ekranie konta (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto → Stan konta).',
      ...KANALY,
    }
  if (t.startsWith('firma ma już zamówienia z własnych kanałów'))
    return { tekst: 'Firma ma już zamówienia z podłączonych sklepów albo dodane ręcznie. Import z BaseLinkera jest dla firmy, która dopiero zaczyna w Kompletorze; tryb próbny działa dalej.' }
  if (t.startsWith('firma ma już ustawiony katalog BL'))
    return { tekst: `Firma ma już ustawiony inny katalog produktów BaseLinkera niż ten, który widzi zapisany klucz API (${t.replace(/^firma ma już ustawiony katalog BL /, 'jest ').replace(', a plan wskazuje ', ', klucz wskazuje ')}). Sprawdź, czy klucz jest z właściwego konta BaseLinkera.`, href: '#klucz', etykieta: 'Klucz API' }
  if (t.startsWith('statusy BL do decyzji z otwartymi zamówieniami'))
    return { tekst: `Statusy BaseLinkera z otwartymi zamówieniami czekają na decyzję: ${listaZ(t)}. Wybierz dla nich status w Kompletorze.`, ...DECYZJE }
  if (t.startsWith('mapa otwiera statusy'))
    return { tekst: 'Decyzje obejmują statusy, których zamówień nie pobrano w tym trybie próbnym. Uruchom tryb próbny jeszcze raz.', ...PROBA }
  if (t.startsWith('katalogu ') && t.includes(' nie ma w BL'))
    return { tekst: 'Wybranego katalogu produktów nie ma w BaseLinkerze. Wybierz inny katalog w sekcji „Decyzje” albo sprawdź, czy klucz API jest z właściwego konta BaseLinkera.', ...DECYZJE }
  if (/^w BL jest \d+ katalogów/.test(t))
    return {
      tekst: `W BaseLinkerze jest kilka katalogów produktów (${listaZ(t.replace(/^w BL jest \d+ katalogów \(/, ': ').replace(/\) — .*$/, ' — '))}). Wybierz katalog w sekcji „Decyzje” i uruchom tryb próbny jeszcze raz.`,
      ...DECYZJE,
    }
  if (t.startsWith('BL nie zwrócił żadnego katalogu')) return { tekst: 'BaseLinker nie pokazał żadnego katalogu produktów dla tego klucza API. Sprawdź uprawnienia klucza w BaseLinkerze.', href: '#klucz', etykieta: 'Klucz API' }
  // nieznany powód: tekst polecenia bez skrótów technicznych, z wielkiej litery
  const czysty = t.replace(/ — $/, '').replace(/ \(--[a-z-]+[^)]*\)/g, '').replace(/ — /g, ': ')
  return { tekst: czysty.charAt(0).toUpperCase() + czysty.slice(1) }
}
