// Grupy alertów do powiadomień: stała mapa `Alert.kind` → grupa. Strumień i temat Zulipa wybiera firma
// per grupa (Ustawienia → Powiadomienia). Rodzaj nieznany mapie trafia do „Inne”, więc nowy alert nie ginie.

export const ALERT_GROUPS = ['KANAL_STANY', 'KANAL_ZAMOWIENIA', 'FAKTURY', 'MAGAZYN', 'INNE'] as const
export type AlertGroup = (typeof ALERT_GROUPS)[number]

export const GROUP_LABEL: Record<AlertGroup, string> = {
  KANAL_STANY: 'Kanał nie przyjmuje stanów',
  KANAL_ZAMOWIENIA: 'Kanał nie czyta zamówień',
  FAKTURY: 'Faktury',
  MAGAZYN: 'Magazyn',
  INNE: 'Inne',
}

const KIND_GROUP: Readonly<Record<string, AlertGroup>> = {
  KANAL_NIEDOSTEPNY: 'KANAL_STANY',
  KANAL_ZAMOWIENIA_NIEDOSTEPNY: 'KANAL_ZAMOWIENIA',
  FAKTURA_BLAD: 'FAKTURY',
  FAKTURA_BEZ_WZ: 'FAKTURY',
  DUBLET_FAKTURY: 'FAKTURY',
  FAKTURA_DO_KOREKTY: 'FAKTURY',
  FAKTURA_OBCA_WALUTA: 'FAKTURY', // zamówienie w obcej walucie, faktura ręcznie
  FAKTURA_WALUTA_SPRAWDZ: 'FAKTURY', // faktura w obcej walucie niezgodna z odczytem wFirmy
  WFIRMA_LIMIT: 'FAKTURY',
  WFIRMA_KONFIGURACJA: 'FAKTURY',
  KOREKTA_BLAD: 'FAKTURY',
  DUBLET_KOREKTY: 'FAKTURY',
  KOREKTA_NIEZGODNA: 'FAKTURY', // korekta w wFirmie z innymi ilościami niż zwrot
  KOREKTA_NIESPRAWDZONA: 'FAKTURY', // odczyt kontrolny korekty nieudany
  KOREKTA_NIEWIADOMA: 'FAKTURY', // korekta bez odpowiedzi wFirmy, nieznaleziona po 3 próbach
  BRAK_NA_POLCE: 'MAGAZYN',
  NADMIAR_REZERWACJI: 'MAGAZYN',
  // rodzaje z main dodane po bazie gałęzi
  BRAK_PRZY_PAKOWANIU: 'MAGAZYN',
  DOSLANIE_ZAMIAST_ZWROTU: 'MAGAZYN',
  ZWROT_KANALU: 'KANAL_ZAMOWIENIA', // zwrot klienta z kanału nie założony automatycznie
  PRZESYLKA_ZWROT: 'MAGAZYN', // paczka wraca do nadawcy wg przewoźnika (oś statusów przesyłki)
  PRZESYLKA_PROBLEM: 'INNE', // przewoźnik zgłasza problem z paczką (zaginięcie, reklamacja)
  NOC_SYNC_BLAD: 'KANAL_STANY',
  WFIRMA_ODCZYT_BLAD: 'FAKTURY',
  FAKTURA_BL_BLAD: 'FAKTURY',
  FAKTURA_BL_TOWAR_W_PRACY: 'FAKTURY', // po przełączeniu, towar odłożony przy fakturze BL
  FAKTURA_BL_W_KOLEJCE: 'FAKTURY', // faktura BL po przełączeniu, zamówienie w kolejce pakowania
  FAKTURY_BL_NUMERY_SKLEPU: 'FAKTURY', // odczyt numerów ze sklepu pada, faktury BL czekają na parę
  FAKTURA_BL_I_KOMPLETORA: 'FAKTURY', // faktura BL przy zamówieniu z dokumentem sprzedaży z Kompletora
  FAKTURA_BL_BEZ_PARY: 'FAKTURY', // faktura BL po przełączeniu bez pary z zamówieniem Kompletora
  WZ_BLAD: 'FAKTURY',
  WZ_PO_POZYCJACH: 'FAKTURY',
  WZ_NIEROZSTRZYGNIETE: 'FAKTURY',
  WZ_NIEWIADOMA: 'FAKTURY',
  WFIRMA_BRAK_TOWARU: 'MAGAZYN',
  // przyjmowanie zamówień Empiku
  EMPIK_PRZYJECIE_CZEKA: 'KANAL_ZAMOWIENIA',
  EMPIK_PRZYJECIE_DECYZJA: 'KANAL_ZAMOWIENIA',
  EMPIK_PRZYJECIE_BLAD: 'KANAL_ZAMOWIENIA',
  // zapis na kanały (stany, statusy, numery nadania)
  KANAL_STAN_NIEJEDNOZNACZNY: 'KANAL_STANY',
  KANAL_STAN_BLAD: 'KANAL_STANY',
  KANAL_LIMIT_ZAKONCZEN: 'KANAL_STANY',
  KANAL_ZAPIS_BLAD: 'KANAL_STANY',
  KANAL_ZAPIS_NIEJEDNOZNACZNY: 'KANAL_STANY',
  // wynik importu stanów w kanale (Empik)
  KANAL_IMPORT_STANOW_ODRZUCONE: 'KANAL_STANY',
  KANAL_IMPORT_STANOW_BEZ_WYNIKU: 'KANAL_STANY',
  // poczta do klientów i biura (grupa „Inne”, jawnie)
  POCZTA_ODRZUCONY: 'INNE',
  POCZTA_BLAD: 'INNE',
  POCZTA_NIEPEWNY: 'INNE',
  POCZTA_LOGOWANIE: 'INNE',
  POCZTA_KONFIGURACJA: 'INNE',
  POCZTA_ODBICIE: 'INNE',
  // przepinanie ofert i łączenie ofert z produktami (alerty przez `db.alert.create`)
  PRZEPIECIE_OFERTY_W_TOKU: 'KANAL_ZAMOWIENIA',
  PRZEPIECIE_OFERTY_RESZTA: 'KANAL_ZAMOWIENIA',
  PRZEPIECIE_OFERTY_BLAD: 'KANAL_ZAMOWIENIA',
  LACZENIE_OFERT_BLAD: 'KANAL_ZAMOWIENIA',
  // nieopłacone anulowane u nas, sklep nie przyjmie anulowania z Kompletora
  KANAL_ANULUJ_RECZNIE: 'KANAL_ZAMOWIENIA',
  // automatyczne akcje firmy (pętla reguł, błąd wykonania reguły)
  AUTOMAT_PETLA: 'INNE',
  AUTOMAT_BLAD: 'INNE',
  AUTOMAT_PRZERWANY: 'INNE',
  // integracja (kanał, przewoźnik) wyłączona automatycznie po serii błędów połączenia
  INTEGRACJA_WYLACZONA: 'INNE',
}

export function groupOf(kind: string): AlertGroup {
  return Object.hasOwn(KIND_GROUP, kind) ? KIND_GROUP[kind]! : 'INNE'
}

/** Rodzaje przypisane do grupy (do opisu na ekranie); „Inne” = wszystko spoza mapy. */
export function kindsOf(group: AlertGroup): string[] {
  return Object.entries(KIND_GROUP)
    .filter(([, g]) => g === group)
    .map(([k]) => k)
}

/**
 * Etykiety rodzajów do treści wiadomości — stałe teksty, bez danych z alertu. Rodzaj spoza listy: sam kod (to stała
 * z kodu, nie dane klienta).
 */
const KIND_LABEL: Readonly<Record<string, string>> = {
  INTEGRACJA_WYLACZONA: 'Integracja wyłączona po błędach połączenia',
  KANAL_NIEDOSTEPNY: 'Kanał nie przyjmuje stanów',
  KANAL_STAN_NIEJEDNOZNACZNY: 'Niepewny zapis stanu w sklepie',
  KANAL_STAN_BLAD: 'Stan oferty nie zapisuje się w sklepie',
  KANAL_LIMIT_ZAKONCZEN: 'Dobowy limit zakończeń ofert przy stanie 0 wyczerpany',
  KANAL_ZAPIS_BLAD: 'Status albo numer nadania nie zapisał się w sklepie',
  KANAL_ZAPIS_NIEJEDNOZNACZNY: 'Niepewny zapis statusu albo numeru nadania w sklepie',
  KANAL_IMPORT_STANOW_ODRZUCONE: 'Sklep odrzucił część stanów z importu',
  KANAL_IMPORT_STANOW_BEZ_WYNIKU: 'Brak wyniku importu stanów w sklepie',
  KANAL_ZAMOWIENIA_NIEDOSTEPNY: 'Kanał nie czyta zamówień',
  KANAL_ZAMOWIENIA_OSTRZEZENIE: 'Ostrzeżenie odczytu zamówień z kanału',
  KANAL_ANULUJ_RECZNIE: 'Nieopłacone zamówienie do anulowania ręcznie w sklepie',
  AUTOMAT_PETLA: 'Automatyczne akcje przestawiają status w kółko',
  AUTOMAT_BLAD: 'Automatyczna akcja nie wykonała się',
  AUTOMAT_PRZERWANY: 'Automatyczna akcja przerwała się w trakcie',
  FAKTURA_BLAD: 'Błąd wystawienia faktury',
  FAKTURA_BEZ_WZ: 'Faktura bez WZ',
  FAKTURY_BL_BEZ_WZ: 'Faktury BL bez WZ',
  DUBLET_FAKTURY: 'Podwójna faktura',
  FAKTURA_DO_KOREKTY: 'Faktura do korekty',
  WFIRMA_LIMIT: 'Limit wywołań wFirmy',
  WFIRMA_BRAK_MAGAZYNU: 'wFirma: brak magazynu',
  WFIRMA_KONFIGURACJA: 'Faktury: ustawienia do poprawy',
  WFIRMA_FIND_FILTR: 'wFirma: filtr wyszukiwania',
  KOREKTA_BLAD: 'Błąd wystawienia korekty',
  KOREKTA_BEZ_PZ: 'Korekta bez PZ',
  DUBLET_KOREKTY: 'Podwójna korekta',
  KOREKTA_NIEZGODNA: 'Korekta z innymi ilościami niż zwrot',
  KOREKTA_NIESPRAWDZONA: 'Korekta niesprawdzona po wystawieniu',
  KOREKTA_NIEWIADOMA: 'Korekta bez odpowiedzi programu: sprawdź przed ponowieniem',
  BRAK_NA_POLCE: 'Brak towaru na półce',
  PRZESYLKA_ZWROT: 'Paczka wraca do nadawcy',
  PRZESYLKA_PROBLEM: 'Problem z paczką u przewoźnika',
  BRAK_PRZY_PAKOWANIU: 'Paczka wyszła z brakiem',
  DOSLANIE_ZAMIAST_ZWROTU: 'Dosłanie zamiast zwrotu',
  ZWROT_KANALU: 'Zwrot z kanału do założenia ręcznie',
  NOC_SYNC_BLAD: 'Nocna synchronizacja stanów nieudana',
  WFIRMA_ODCZYT_BLAD: 'wFirma: odczyt stanu towaru nieudany',
  FAKTURA_BL_BLAD: 'Błąd faktury BL',
  FAKTURA_BL_TOWAR_W_PRACY: 'Faktura z BaseLinkera, a towar nadal odłożony w Kompletorze',
  FAKTURA_BL_W_KOLEJCE: 'Faktura z BaseLinkera po przełączeniu: zamówienie w kolejce pakowania albo już spakowane',
  FAKTURA_BL_I_KOMPLETORA: 'Dwie faktury na jedno zamówienie: z BaseLinkera i z Kompletora',
  FAKTURA_BL_BEZ_PARY: 'Faktura z BaseLinkera bez zamówienia w Kompletorze: sprawdź, czy go nie pakujesz',
  FAKTURY_BL_NUMERY_SKLEPU: 'Faktury z BaseLinkera czekają na parę: sklep nie odpowiada',
  WFIRMA_BRAK_TOWARU: 'wFirma: brak towaru w odpowiedzi',
  NADMIAR_REZERWACJI: 'Nadmiar rezerwacji',
  NADMIAR_ZALEGLY: 'Zaległy nadmiar rezerwacji',
  STAN_UJEMNY_PO_WYDANIU: 'Stan ujemny po wydaniu',
  ALLOCATE_ZALEGLE: 'Zaległy przydział stanów',
  RUCH_ZALEGLY: 'Zaległy ruch magazynowy',
  NIEZMIENNIK: 'Naruszony niezmiennik stanów',
  BLAD_ZAMOWIENIA: 'Błąd zamówienia',
  ZAMOWIENIE_KANALU_BLAD: 'Błąd zamówienia z kanału',
  ZAMOWIENIE_COFNIETE_W_KANALE: 'Zamówienie cofnięte w kanale',
  ZAMOWIENIE_ZASTAPIONE_W_KANALE: 'Zamówienie zastąpione w kanale',
  ZAMOWIENIE_ZNIKNELO_Z_KANALU: 'Zamówienie zniknęło z kanału',
  SPRZEDAZ_DNIA_ROZJAZD: 'Rozjazd sprzedaży dnia z BL',
  STAN_INNY_MAGAZYN: 'Stan w innym magazynie',
  PLATNOSC_PO_ANULOWANIU: 'Płatność po anulowaniu',
  REAKTYWACJA_PO_FAKTURZE: 'Reaktywacja po fakturze',
  USZKODZONE_DO_RW: 'Uszkodzone do RW',
  WYDANE_BEZ_DOKUMENTU: 'Wydane bez dokumentu',
  WZ_BLAD: 'WZ nie wystawione w wFirmie',
  WZ_PO_POZYCJACH: 'Zamówienie rozliczone dokumentem WZ po pozycjach',
  WZ_NIEROZSTRZYGNIETE: 'Dokumenty WZ z wFirmy bez zamówienia',
  WZ_NIEWIADOMA: 'Nie wiadomo, czy WZ powstało w wFirmie',
  EMPIK_PRZYJECIE_CZEKA: 'Empik: zamówienie czeka na przyjęcie',
  EMPIK_PRZYJECIE_DECYZJA: 'Empik: przyjęcie zamówienia czeka na decyzję',
  EMPIK_PRZYJECIE_BLAD: 'Empik: przyjęcie zamówienia nie przeszło',
  POCZTA_ODRZUCONY: 'Serwer poczty odrzucił mail',
  POCZTA_BLAD: 'Mail nie wyszedł',
  POCZTA_NIEPEWNY: 'Mail mógł nie dojść',
  POCZTA_LOGOWANIE: 'Poczta: zły login albo hasło',
  POCZTA_KONFIGURACJA: 'Poczta: serwer nie przyjmuje maili przy tych ustawieniach',
  POCZTA_ODBICIE: 'Mail wrócił jako niedoręczony',
  PRZEPIECIE_OFERTY_W_TOKU: 'Przepięcie oferty w toku',
  PRZEPIECIE_OFERTY_RESZTA: 'Przepięcie oferty: reszta',
  PRZEPIECIE_OFERTY_BLAD: 'Przepięcie oferty: zamówienie nie przeliczyło się',
  LACZENIE_OFERT_BLAD: 'Łączenie ofert z produktami: oferta nie połączyła się',
}

export function kindLabel(kind: string): string {
  return Object.hasOwn(KIND_LABEL, kind) ? KIND_LABEL[kind]! : kind.replace(/[^A-Za-z0-9_]/g, '').slice(0, 60) || 'Alert'
}

export interface Route {
  stream: string
  topic: string
}
export type Routes = Record<AlertGroup, Route | null>

/** Trasy domyślne: wszystko do „Biuro”, magazyn do „Magazyn”; temat = nazwa grupy. */
export const DEFAULT_ROUTES: Routes = {
  KANAL_STANY: { stream: 'Biuro', topic: 'Kanały: stany' },
  KANAL_ZAMOWIENIA: { stream: 'Biuro', topic: 'Kanały: zamówienia' },
  FAKTURY: { stream: 'Biuro', topic: 'Faktury' },
  MAGAZYN: { stream: 'Magazyn', topic: 'Magazyn' },
  INNE: { stream: 'Biuro', topic: 'Inne alerty' },
}
