// Kody zwrotne Orlen Paczki (pole `Err`) → rodzaj wyniku Kompletora. Lista kodów: suma tabeli z konektora
// Open Integration Platform (integrators/courier/orlenpaczka/v1.0.0/src/integration.py, ae43d1e, Apache-2.0) i rozdziałów
// 5–6 dokumentacji „API ORLEN Paczka v1.26.004”. Opisy po polsku napisane od nowa; klasyfikacja jest nasza (u nich kod
// dzieli się tylko na „sukces / brak uprawnień / reszta”).
//
// Klasy: OK (zapisano), OSTRZEZENIE (zapisano, Orlen podmienił kod punktu), TRWALY (dane, uprawnienia, stan paczki:
// ponowienie nic nie da), PRZEJSCIOWY (Orlen odmówił przed wykonaniem albo dane jeszcze się nie przeliczyły: wolno
// ponowić), NIEPEWNY (błąd po stronie Orlenu w trakcie wykonania: przy nadaniu nie wiadomo, czy paczka powstała).
import type { FailureKind } from './kontrakt'

export type KlasaKodu = 'OK' | 'OSTRZEZENIE' | 'TRWALY' | 'PRZEJSCIOWY' | 'NIEPEWNY'
/** Skąd znamy kod: konektor OIP, dokumentacja Orlen Paczki albo oba źródła. */
export type ZrodloKodu = 'oip' | 'dok' | 'oba'

export interface KodOrlen {
  opis: string
  klasa: KlasaKodu
  zrodlo: ZrodloKodu
}

const k = (opis: string, klasa: KlasaKodu, zrodlo: ZrodloKodu): KodOrlen => ({ opis, klasa, zrodlo })

export const KODY_ORLEN: Readonly<Record<number, KodOrlen>> = {
  0: k('zapisano', 'OK', 'oba'),
  6: k('zapisano, Orlen zmienił kod punktu odbioru (nieaktualna lista punktów)', 'OSTRZEZENIE', 'oba'),
  7: k('zapisano, Orlen zmienił kod punktu zwrotu (nieaktualna lista punktów)', 'OSTRZEZENIE', 'oba'),
  8: k('zapisano, Orlen zmienił kod punktu odbioru albo zwrotu (nieaktualna lista punktów)', 'OSTRZEZENIE', 'oba'),
  100: k('brak PartnerID (login konta Orlen Paczki)', 'TRWALY', 'oba'),
  101: k('brak PartnerKey (klucz konta Orlen Paczki)', 'TRWALY', 'oba'),
  103: k('brak telefonu odbiorcy', 'TRWALY', 'oba'),
  104: k('brak kodu punktu odbioru', 'TRWALY', 'oba'),
  105: k('brak imienia i nazwiska albo nazwy firmy odbiorcy', 'TRWALY', 'oba'),
  106: k('brak numeru paczki', 'TRWALY', 'oba'),
  107: k('brak wyboru adresu na etykiecie (PrintAdress)', 'TRWALY', 'oba'),
  108: k('brak adresu e-mail', 'TRWALY', 'dok'),
  111: k('brak adresu e-mail nadawcy', 'TRWALY', 'oba'),
  112: k('brak telefonu nadawcy', 'TRWALY', 'oba'),
  113: k('brak miejscowości nadawcy', 'TRWALY', 'oba'),
  114: k('brak ulicy nadawcy', 'TRWALY', 'oba'),
  115: k('brak numeru budynku nadawcy', 'TRWALY', 'oba'),
  116: k('brak kodu pocztowego nadawcy', 'TRWALY', 'oba'),
  117: k('brak imienia i nazwiska albo nazwy firmy nadawcy', 'TRWALY', 'oba'),
  120: k('brak kwoty pobrania', 'TRWALY', 'oba'),
  121: k('brak tytułu przelewu pobrania', 'TRWALY', 'oba'),
  123: k('brak miejscowości zwrotu', 'TRWALY', 'oba'),
  124: k('brak ulicy zwrotu', 'TRWALY', 'oba'),
  125: k('brak numeru budynku zwrotu', 'TRWALY', 'oba'),
  126: k('brak kodu pocztowego zwrotu', 'TRWALY', 'oba'),
  127: k('brak nazwy firmy zwrotu', 'TRWALY', 'oba'),
  128: k('brak zgody na zwrot (ReturnAvailable)', 'TRWALY', 'oba'),
  129: k('brak liczby paczek zwrotnych', 'TRWALY', 'oba'),
  130: k('niedozwolone znaki w kwocie pobrania', 'TRWALY', 'oba'),
  131: k('niedozwolone znaki w tytule przelewu', 'TRWALY', 'oba'),
  132: k('zły format danych', 'TRWALY', 'dok'),
  133: k('zły numer telefonu odbiorcy', 'TRWALY', 'oba'),
  134: k('zła wartość paczki', 'TRWALY', 'oba'),
  135: k('wartość paczki ponad limit ubezpieczenia', 'TRWALY', 'oba'),
  136: k('zły tytuł przelewu', 'TRWALY', 'oba'),
  137: k('zła liczba paczek zwrotnych', 'TRWALY', 'oba'),
  138: k('zły kod pocztowy', 'TRWALY', 'oba'),
  139: k('brak rodzaju wydruku', 'TRWALY', 'dok'),
  140: k('kwota pobrania nie może być zerem', 'TRWALY', 'oba'),
  141: k('zły rozmiar paczki (dozwolone S, M, L)', 'TRWALY', 'oba'),
  142: k('zły numer telefonu nadawcy', 'TRWALY', 'dok'),
  143: k('zły format etykiety', 'TRWALY', 'dok'),
  144: k('zły numer paczki', 'TRWALY', 'dok'),
  150: k('za dużo paczek w jednym żądaniu', 'TRWALY', 'oba'),
  161: k('brak miejscowości', 'TRWALY', 'dok'),
  162: k('brak NIP', 'TRWALY', 'dok'),
  163: k('brak numeru paczki i telefonu', 'TRWALY', 'oba'),
  164: k('brak liczby numerów do zarezerwowania', 'TRWALY', 'dok'),
  191: k('kod pocztowy poza obsługą', 'TRWALY', 'dok'),
  // Konektor OIP: „niepoprawny PartnerID i/lub PartnerKey”; dokumentacja 1.26 podaje ten opis pod kodem 401.
  200: k('zły PartnerID albo PartnerKey', 'TRWALY', 'oip'),
  201: k('paczka była już anulowana', 'TRWALY', 'oba'),
  202: k('paczki nie można już anulować', 'TRWALY', 'oba'),
  205: k('nieznany numer paczki', 'TRWALY', 'oba'),
  206: k('nieznany kod punktu odbioru', 'TRWALY', 'oba'),
  207: k('nieznany kod punktu zwrotu', 'TRWALY', 'oba'),
  208: k('klient już istnieje', 'TRWALY', 'oba'),
  209: k('zły numer paczki', 'TRWALY', 'oba'),
  // Dane trasy pojawiają się zwykle kilkadziesiąt sekund po nadaniu (OIP, dokumentacja pkt 4.30): wolno ponowić.
  211: k('brak jeszcze danych trasy dla etykiety (zwykle kilkadziesiąt sekund po nadaniu)', 'PRZEJSCIOWY', 'oba'),
  212: k('brak uprawnień do etykiety tego numeru', 'TRWALY', 'oba'),
  213: k('paczka o tym numerze jest już w drodze (etykiety nie można wydrukować ponownie)', 'TRWALY', 'oba'),
  214: k('paczka nie należy do tego konta', 'TRWALY', 'dok'),
  222: k('paczki nie ma w systemie Orlen Paczki', 'TRWALY', 'oba'),
  223: k('paczka nie należy do tego konta', 'TRWALY', 'oba'),
  240: k('za dużo zwrotów paczki', 'TRWALY', 'dok'),
  243: k('zły numer paczki', 'TRWALY', 'dok'),
  250: k('brak punktu (Psd)', 'TRWALY', 'dok'),
  251: k('nieznany punkt (Psd)', 'TRWALY', 'dok'),
  252: k('nieznany punkt zwrotu (ReturnPsd)', 'TRWALY', 'dok'),
  253: k('nieznany punkt zastępczy (AlternativePsd)', 'TRWALY', 'dok'),
  254: k('nieznany zastępczy kod punktu (AlternativeDestinationCode)', 'TRWALY', 'dok'),
  300: k('błąd zapisu po stronie Orlen Paczki', 'NIEPEWNY', 'dok'),
  308: k('brak uprawnień', 'TRWALY', 'dok'),
  309: k('brak uprawnień do tworzenia klientów', 'TRWALY', 'dok'),
  310: k('brak uprawnień do pobrania (usługa wycofana 2.01.2025)', 'TRWALY', 'oba'),
  311: k('brak uprawnień do ubezpieczenia (usługa wycofana 4.12.2024)', 'TRWALY', 'oba'),
  312: k('brak uprawnień do zwrotów', 'TRWALY', 'oba'),
  314: k('brak uprawnień do WhiteLabel', 'TRWALY', 'dok'),
  318: k('punkt odbioru nie obsługuje pobrania', 'TRWALY', 'oba'),
  330: k('błąd generowania etykiety', 'NIEPEWNY', 'dok'),
  336: k('błąd generowania etykiety', 'NIEPEWNY', 'dok'),
  350: k('zły kod promocji', 'TRWALY', 'dok'),
  399: k('nie znaleziono paczki', 'TRWALY', 'dok'),
  400: k('za dużo paczek przy pobieraniu numerów', 'TRWALY', 'dok'),
  401: k('zły PartnerID albo PartnerKey', 'TRWALY', 'dok'),
  801: k('brak paczek do protokołu przekazania', 'TRWALY', 'dok'),
  802: k('za dużo paczek w protokole przekazania', 'TRWALY', 'dok'),
  901: k('nieokreślony błąd po stronie Orlen Paczki', 'NIEPEWNY', 'dok'),
  // „API nie jest gotowe potwierdzić uprawnień, spróbuj za chwilę”: odmowa przed wykonaniem
  999: k('usługa chwilowo nie potwierdza uprawnień, spróbuj za chwilę', 'PRZEJSCIOWY', 'dok'),
  1038: k('brak nazwy nadawcy w zamówieniu kuriera', 'TRWALY', 'dok'),
  1039: k('brak ulicy w zamówieniu kuriera', 'TRWALY', 'dok'),
  1040: k('brak miejscowości w zamówieniu kuriera', 'TRWALY', 'dok'),
  1041: k('brak kodu pocztowego w zamówieniu kuriera', 'TRWALY', 'dok'),
  1043: k('brak e-maila w zamówieniu kuriera', 'TRWALY', 'dok'),
  1052: k('brak daty odbioru', 'TRWALY', 'dok'),
  1053: k('brak daty gotowości paczek', 'TRWALY', 'dok'),
  1054: k('odbiór w niedzielę niemożliwy', 'TRWALY', 'dok'),
  1055: k('godzina końca odbioru przed godziną gotowości', 'TRWALY', 'dok'),
  1067: k('zły przedział godzin odbioru dla tego dnia', 'TRWALY', 'dok'),
  1077: k('zbyt późna godzina odbioru dla wybranego dnia', 'TRWALY', 'dok'),
  1084: k('odbiór niedostępny w wybranym dniu', 'TRWALY', 'dok'),
}

/** Rodzaj operacji: od niego zależy, co znaczy błąd w trakcie wykonania i „już anulowana”. */
export type OperacjaOrlen = 'nadanie' | 'anulowanie' | 'odczyt'

export type WynikKodu = { kind: 'OK'; ostrzezenie: string | null } | { kind: FailureKind; message: string }

/** Kod `Err` jako liczba („000” = 0); nieczytelny = null. */
export function kodLiczbowy(v: string | null | undefined): number | null {
  if (v === null || v === undefined || !/^\s*\d{1,5}\s*$/.test(v)) return null
  return Number(v.trim())
}

/**
 * Wynik dla kodu `Err`. Nadanie: błąd Orlenu w trakcie wykonania i kod spoza tabeli = NIEJEDNOZNACZNY (paczka mogła
 * powstać; rozstrzyga odszukanie albo człowiek). Anulowanie: „już anulowana” = OK (powtórka bezpieczna), błąd w trakcie
 * = PRZEJSCIOWY (ponowienie anulowania nie tworzy paczki). Odczyt: błąd w trakcie i nieznany kod = PRZEJSCIOWY/TRWALY.
 */
export function wynikKodu(kod: number, op: OperacjaOrlen): WynikKodu {
  const d = KODY_ORLEN[kod]
  if (!d) {
    if (op === 'nadanie') return { kind: 'NIEJEDNOZNACZNY', message: `Orlen Paczka: nieznany kod ${kod}; nie wiadomo, czy paczka powstała: nie twórz jej drugi raz, kliknij „Sprawdź u przewoźnika” (paczek z API nie widać w panelu Orlen Paczki)` }
    return { kind: 'TRWALY', message: `Orlen Paczka: nieznany kod ${kod}` }
  }
  if (d.klasa === 'OK') return { kind: 'OK', ostrzezenie: null }
  if (d.klasa === 'OSTRZEZENIE') return { kind: 'OK', ostrzezenie: d.opis }
  if (op === 'anulowanie' && kod === 201) return { kind: 'OK', ostrzezenie: d.opis }
  const message = `Orlen Paczka (kod ${kod}): ${d.opis}`
  if (d.klasa === 'NIEPEWNY') {
    if (op === 'nadanie') return { kind: 'NIEJEDNOZNACZNY', message: `${message}; nie wiadomo, czy paczka powstała: nie twórz jej drugi raz, kliknij „Sprawdź u przewoźnika” (paczek z API nie widać w panelu Orlen Paczki)` }
    return { kind: 'PRZEJSCIOWY', message }
  }
  return { kind: d.klasa, message }
}
