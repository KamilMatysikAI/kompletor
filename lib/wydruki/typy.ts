// Typy wejściowe wydruków magazynowych. Moduł lib/wydruki/ to czyste funkcje
// dane → PDF (Buffer): bez klienta Prismy, bez sieci. Dane z bazy składa warstwa wyżej (panel / worker).
// Ilości w jednostce bazowej jak w całym repo: sztuki albo gramy.

export type Jednostka = 'szt' | 'g'

/** Numer zamówienia z przedrostkiem kanału, np. SD 48213, ALG 1023, EMP 77; dosyłka: SD 48213-2. */
export interface NumerZamowienia {
  /** Przedrostek kanału: same litery A–Z (SD, BH, KM, ALG, EMP…); cyfra w przedrostku = wyjątek w kodKarty. */
  przedrostek: string
  /**
   * Wewnętrzny numer liczbowy zamówienia w kanale: same cyfry, bez przedrostka. Identyfikatory zewnętrzne
   * (np. UUID zamówienia Allegro) mapuje warstwa wyżej — kodKarty rzuca wyjątek na cokolwiek poza cyframi
   * (26.10.2026: inaczej kod karty byłby dwuznaczny przy skanowaniu).
   */
  numer: string
  /** Numer podzamówienia dosyłki („dośle później”): 2, 3…; brak = zamówienie główne. */
  podzamowienie?: number | null
}

/** Z danych klienta na wydrukach magazynowych tylko to — pełny adres jest na etykiecie kurierskiej. */
export interface OdbiorcaSkrot {
  imie: string
  nazwisko: string
  miasto: string
}

export interface PozycjaKarty {
  /** Lokalizacja na półce w formacie regał-półka-miejsce, np. B-3-4; brak = pozycja na końcu listy. */
  lokalizacja?: string | null
  nazwa: string
  wariant?: string | null
  sku?: string | null
  ilosc: number
  jednostka: Jednostka
  /**
   * Miniatura JPEG albo PNG, już przeskalowana przez warstwę wyżej (≤ 100 px, ≤ 50 KB) — moduł nie skaluje,
   * pdfkit osadza plik w oryginalnej rozdzielczości. Brak zdjęcia (kreskowana ramka, wydruk idzie dalej), gdy:
   * plik > 64 KB, inny format (WebP, GIF…), PNG nie przechodzi synchronicznej walidacji (uszkodzony strumień,
   * zły filtr, wymiar > 1024 px, głębia < 8 bitów z alfą/przeplotem) albo JPEG jest uszkodzony
   * (/, 26.10.2026; walidacja w obraz.ts).
   */
  miniatura?: Buffer | null
}

export interface KartaZamowieniaDane {
  /** logo firmy (JPEG ≤ 64 KB z `plikLogo(…, 'druk')`); brak = karta bez logo. */
  logo?: Buffer | null
  zamowienie: NumerZamowienia
  /** Nazwa kanału do wyświetlenia, np. Sklep Przyprawowy, Allegro, Empik. */
  kanal: string
  /** Data złożenia zamówienia. */
  dataZamowienia: Date
  /** Przewoźnik, np. InPost, DPD. */
  przewoznik: string
  /** Metoda dostawy, np. Paczkomat, Kurier. */
  metodaDostawy?: string | null
  /** Zamówienie z trybu próbnego — na karcie plakietka NA SUCHO. */
  naSucho?: boolean
  /** Kolejny wydruk tej karty: 1, 2… Ponowny wydruk (N+1) unieważnia kod z numerem N. */
  numerWydruku: number
  wydrukowano: Date
  /** Osoba drukująca (imię albo login). */
  drukujacy: string
  /** Brak (null) = zamówienie bez danych osobowych (cień): „Odbiorca: brak w danych cienia”. */
  odbiorca: OdbiorcaSkrot | null
  /**
   * Pełny blok odbiorcy: tylko gdy osoba zlecająca wydruk ma uprawnienie `klienci.dane`; linie gotowe do
   * druku (odbiorca, ulica, kod i miasto, telefon). Brak = sam skrót z `odbiorca`.
   */
  adresOdbiorcy?: string[] | null
  /** Uwagi biura dla magazynu. */
  uwagiMagazynu?: string | null
  /** Uwagi klienta z zamówienia. */
  uwagiKlienta?: string | null
  pozycje: PozycjaKarty[]
}

/** pozycja wydruku informacyjnego — cała zawartość zamówienia, z oznaczeniem tego, czego nie ma do zebrania. */
export interface PozycjaInformacyjna {
  nazwa: string
  wariant?: string | null
  sku?: string | null
  ilosc: number
  jednostka: Jednostka
  /** „brak” = brak na stanie (nie do wydania), „bez stanu” = produkt bez wysyłki (np. e-book); brak = zwykła pozycja. */
  oznaczenie?: 'brak' | 'bez stanu' | null
}

/**
 * wydruk informacyjny zamówienia (dokument do teczki, reklamacji, rozmowy z klientem), drukowany obok kart
 * do zbierania dla zamówień wysłanych, anulowanych, bez towaru do zebrania albo bez numeru do kodu karty. Bez kodu
 * kreskowego i numeru wydruku: stanowisko pakowania nie może go zeskanować, a rejestr wydruków go nie zna.
 */
export interface KartaInformacyjnaDane {
  informacyjna: true
  /** Powód po ludzku, np. „zamówienie wysłane”; na stronie jako „Wydruk informacyjny: <powód>”. */
  powod: string
  logo?: Buffer | null
  /** Numer do wyświetlenia jak w panelu („SD 48213”, „ALG 2f961f8-4…”); nie musi być liczbowy, bo nie ma kodu karty. */
  numer: string
  kanal: string
  /** Status zamówienia po ludzku („Wysłane”). */
  status?: string | null
  dataZamowienia: Date
  przewoznik: string
  metodaDostawy?: string | null
  wydrukowano: Date
  drukujacy: string
  odbiorca: OdbiorcaSkrot | null
  adresOdbiorcy?: string[] | null
  uwagiKlienta?: string | null
  pozycje: PozycjaInformacyjna[]
}

/** Strona (albo kilka stron) wydruku kart: karta do zbierania albo wydruk informacyjny. */
export type StronaKart = KartaZamowieniaDane | KartaInformacyjnaDane

export function czyInformacyjna(d: StronaKart): d is KartaInformacyjnaDane {
  return 'informacyjna' in d && d.informacyjna === true
}

export interface KartaZamowieniaOpcje {
  /** Wariant jak w BL: każda pozycja na osobnej karcie (stronie), z tym samym kodem zamówienia. */
  jednaPozycjaNaKarte?: boolean
  /**
   * Numery zamówień pominiętych w wydruku zbiorczym (same produkty bez stanu, np. e-book):
   * ostatnia strona PDF-u mówi to wprost, bo nagłówka odpowiedzi nie widać w karcie z PDF-em.
   */
  pominiete?: readonly string[]
}

export interface ZamowienieListyWysylkowej {
  zamowienie: NumerZamowienia
  przewoznik: string
  liczbaPaczek: number
  /** Numer nadania (lub kilka, gdy paczek jest więcej). */
  numeryNadania: string[]
  odbiorca: OdbiorcaSkrot
}

export interface ListaWysylkowaDane {
  /** logo firmy (JPEG ≤ 64 KB z `plikLogo(…, 'druk')`); brak = nagłówek bez logo. */
  logo?: Buffer | null
  /** Dzień (i godzina) odbioru przez przewoźnika. */
  dataOdbioru: Date
  /** Opcjonalny opis odbioru, np. „InPost — odbiór popołudniowy”. */
  opisOdbioru?: string | null
  wydrukowano: Date
  drukujacy: string
  zamowienia: ZamowienieListyWysylkowej[]
}

export interface PozycjaSpisu {
  lokalizacja?: string | null
  nazwa: string
  sku?: string | null
  jednostka: Jednostka
  /** Stan fizyczny na półce. */
  fizyczny: number
  zarezerwowany: number
  /** Dostępny; brak = fizyczny − zarezerwowany. */
  dostepny?: number | null
  /** Strefa magazynu, np. „produkty spożywcze”, „akcesoria”. */
  strefa?: string | null
}

export interface SpisProduktowDane {
  /** Filtr: tylko pozycje z tej strefy (porównanie bez wielkości liter); brak = wszystkie. */
  strefa?: string | null
  wydrukowano: Date
  drukujacy: string
  pozycje: PozycjaSpisu[]
}

export interface EtykietaProduktuDane {
  nazwa: string
  /** Skład albo opis (zawijany i zmniejszany, by zmieścić się na etykiecie). */
  sklad?: string | null
  /** Masa netto do wyświetlenia, np. „50 g”. */
  masa?: string | null
  numerPartii?: string | null
  /** Data (zwykle minimalnej trwałości); tekst wstawiany bez zmian albo Date formatowana dd.mm.rrrr. */
  data?: Date | string | null
  /** Podpis daty; domyślnie „Najlepiej spożyć przed”. */
  etykietaDaty?: string | null
}

export interface EtykietaProduktuOpcje {
  /** Rozmiar etykiety w mm; domyślnie 100 × 50. */
  szerokoscMm?: number
  wysokoscMm?: number
  /** Liczba kopii (stron) w jednym PDF; domyślnie 1. */
  kopie?: number
  /** Data utworzenia w metadanych PDF; podana = deterministyczne bajty pliku (26.10.2026). */
  utworzono?: Date
}
