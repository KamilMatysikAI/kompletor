// Słownik UI: jedno miejsce na nazwy, które
// widzi użytkownik. Zasada: piszemy językiem firmy, nie wdrożenia. Lewa kolumna to słowa wewnętrzne (zostają w kodzie,
// enumach i dokumentacji administratora), prawa to tekst w panelu. Testy (`slownik.test.ts`) pilnują, żeby menu
// i nagłówki nie używały słów z lewej kolumny.
export const SLOWNIK = {
  /** ChannelMode.CIEN */
  tylkoPodglad: 'Tylko podgląd',
  tylkoPodgladOpis: 'Kompletor czyta sklep, niczego w nim nie zmienia.',
  /** ChannelMode.PRACA */
  aktywny: 'Aktywny',
  aktywnyOpis: 'Kompletor zapisuje stany i statusy w sklepie.',
  /** pakowanie „na sucho”, ćwiczenie pakowania */
  pakowanieProbne: 'Pakowanie próbne',
  /** pakowanie „naprawdę” */
  doSpakowania: 'Do spakowania',
  /** rozjazdy z BaseLinkerem */
  porownanieZBl: 'Porównanie z BaseLinkerem',
  /** plan akcji (cień), „wysłałbym” */
  maileDoKlientow: 'Maile do klientów: podgląd',
  przejscieZBl: 'Przejście z BaseLinkera',
  przeprowadzka: 'Przeprowadzka',
  /** „Braki i listy biura” */
  brakiTowaru: 'Braki towaru',
  /** „Produkty i stany” */
  produkty: 'Produkty',
  produktyBezStanu: 'Produkty bez stanu',
  zwroty: 'Zwroty i reklamacje',
  /** nagłówki grup menu bocznego */
  grupaRealizacja: 'Realizacja',
  grupaTowar: 'Towar',
  grupaFinanse: 'Finanse',
  /** działy ustawień (druga kolumna ustawień) */
  dzialSprzedaz: 'Sprzedaż i kanały',
  dzialMagazyn: 'Magazyn i strefy',
  dzialWysylka: 'Wysyłka i druk',
  dzialDokumenty: 'Dokumenty i faktury',
  dzialKomunikacja: 'Komunikacja i poczta',
  dzialZespol: 'Zespół i dostęp',
  dzialIntegracje: 'Integracje i agenci AI',
  /** odznaki ekranu Integracje */
  niepodlaczony: 'Niepodłączony',
  zapisWylaczony: 'Zapis wyłączony',
  /** decyzja braku albo pakowanie na koncie „Tylko podgląd” (`dryRun`, „na sucho”) */
  probnie: 'próbnie',
  /** konto kanału w trybie PRACA w środku zdania („konto w pracy”) */
  kontoAktywne: 'konto aktywne',
  /** brak danych osobowych w zamówieniu z konta „Tylko podgląd” („brak w danych cienia”) */
  brakDanychOdbiorcy: 'brak danych odbiorcy w zamówieniu',
  /** nazwy przycisków i ekranów przesyłek i faktur, jednakowo w panelu, Pomocy i docs/ */
  statusyZamowien: 'Statusy zamówień',
  stworzZwrot: 'Stwórz zwrot',
  utworzPrzesylke: 'Utwórz przesyłkę',
  przyjechalKurier: 'Przyjechał kurier',
  pobierzProtokol: 'Pobierz protokół',
  faktury: 'Faktury',
  raporty: 'Raporty',
  powiazZOferta: 'Powiąż',
  /** błąd kolejki zadań („worker nie odebrał zadania”) */
  sprobujZaChwile: 'Nie udało się teraz wykonać. Spróbuj za minutę.',
  /** „za wyłącznikiem” */
  wymagaWlaczenia: 'Wymaga włączenia przez administratora',
} as const

/**
 * Słowa wewnętrzne, których nie pokazujemy w menu, okruszkach i nagłówkach (regex na cały tekst, bez rozróżniania
 * wielkości liter). Pełny przegląd treści ekranów: paczka.
 */
export const ZAKAZANE_W_NAWIGACJI: readonly RegExp[] = [/cie[nń]/i, /na sucho/i, /naprawd[eę]/i, /\bpraca\b/i, /worker/i, /rozjazd/i, /LOG-A-/, /npm run/i, /listy biura/i]

export function maZakazaneSlowo(tekst: string): RegExp | null {
  return ZAKAZANE_W_NAWIGACJI.find((r) => r.test(tekst)) ?? null
}
