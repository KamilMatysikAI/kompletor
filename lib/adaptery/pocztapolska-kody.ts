// Błędy eNadawcy → klasy Kompletora. eNadawca zwraca w odpowiedzi listę `error` (errorNumber, errorDesc,
// guid) zamiast wyjątku; numery błędów nie są publicznie opisane, więc klasyfikujemy po treści opisu, a numer idzie
// tylko do komunikatu. [NIEPEWNE: wzorce opisów do potwierdzenia na koncie testowym eNadawcy; nieznany opis = TRWALY,
// czyli bezpieczna strona: nic nie ponawiamy na ślepo.]
//
// Klasy dodatkowe (adapter przekłada je na wynik kontraktu):
//   DUPLIKAT — przesyłka o tym GUID już jest w eNadawcy: poprzednia próba doszła, adapter ją odszukuje zamiast nadawać.
//   BUFOR    — bufor partii nie istnieje albo został już wysłany: adapter zakłada bufor na nowo (przesyłka nie powstała).
import type { ErrorClass, FailureKind } from './kontrakt'
import type { BladEnadawcy } from '../zrodla/pocztapolska'

export type KlasaBleduPP = FailureKind | 'DUPLIKAT' | 'BUFOR'

export interface WzorzecBledu {
  re: RegExp
  klasa: KlasaBleduPP
  errorClass?: ErrorClass
  /** Tekst dla obsługi (bez danych adresata). */
  tekst: string
}

/** Kolejność ma znaczenie: pierwszy pasujący wzorzec wygrywa. */
export const WZORCE_BLEDOW_PP: readonly WzorzecBledu[] = [
  { re: /guid.{0,40}(istnieje|już|juz|zajęty|zajety|użyty|uzyty|duplikat)/i, klasa: 'DUPLIKAT', tekst: 'przesyłka o tym identyfikatorze już jest w eNadawcy' },
  { re: /(bufor|envelope).{0,40}(nie istnieje|nie znaleziono|wysłan|wyslan|zamknięt|zamkniet)/i, klasa: 'BUFOR', tekst: 'bufor partii nie istnieje albo został już wysłany' },
  { re: /(autoryzac|uwierzytel|nieprawidłowy login|nieprawidlowy login|hasł|hasl|brak uprawnie)/i, klasa: 'TRWALY', errorClass: 'UWIERZYTELNIENIE', tekst: 'eNadawca odrzucił login albo hasło' },
  { re: /(urząd nadania|urzad nadania|umow)/i, klasa: 'TRWALY', errorClass: 'KONFIGURACJA', tekst: 'urząd nadania albo umowa konta eNadawcy nie pasuje' },
  { re: /(spróbuj ponownie|sprobuj ponownie|chwilowo|niedostępn|niedostepn|przeciąż|przeciaz|timeout|przekroczono czas)/i, klasa: 'PRZEJSCIOWY', tekst: 'eNadawca chwilowo niedostępny' },
]

export interface WynikBleduPP {
  klasa: KlasaBleduPP
  errorClass?: ErrorClass
  message: string
  /** false = opis spoza wzorców: adapter nie wie, czy żądanie się wykonało, i sprawdza stan w eNadawcy. */
  znany: boolean
}

/**
 * „Nie znaleziono” z odczytu przesyłki po GUID (`getAddresLabelByGuidCompact`): jedyny błąd, który znaczy, że eNadawca
 * tej przesyłki nie ma. Każdy inny błąd odczytu to NIE dowód braku.
 */
export const NIE_ZNALEZIONO_PP_RE = /(nie znaleziono|nie odnaleziono|nie istnieje|brak przesy[łl]ki)/i

/**
 * Numery błędu „nie znaleziono” z `getAddresLabelByGuidCompact`. [NIEPEWNE: numer do potwierdzenia na
 * koncie testowym eNadawcy, do tego czasu zbiór jest pusty i decyduje tekst `NIE_ZNALEZIONO_PP_RE`.] Po potwierdzeniu
 * dopisać numer tutaj: dopasowanie po numerze nie zależy od brzmienia opisu.
 */
export const NIE_ZNALEZIONO_PP_NUMERY: ReadonlySet<number> = new Set<number>()

/** Błąd odczytu po GUID znaczy „eNadawca nie ma tej przesyłki”: numer z `numery` albo opis „nie znaleziono”. */
export function jestNieZnaleziono(b: BladEnadawcy, numery: ReadonlySet<number> = NIE_ZNALEZIONO_PP_NUMERY): boolean {
  return (b.numer !== null && numery.has(b.numer)) || NIE_ZNALEZIONO_PP_RE.test(b.opis)
}

/**
 * Klasa pierwszego błędu listy (najgorszy wygrywa: TRWALY > BUFOR > PRZEJSCIOWY, DUPLIKAT tylko gdy jedyny rodzaj).
 * Nieznany opis = TRWALY ze stałym tekstem i kodem: opis eNadawcy może powtarzać dane adresata, więc nie trafia ani do
 * komunikatu, ani do logu.
 */
export function klasyfikujBledy(lista: readonly BladEnadawcy[]): WynikBleduPP | null {
  if (!lista.length) return null
  const wyniki = lista.map((b) => {
    const w = WZORCE_BLEDOW_PP.find((x) => x.re.test(b.opis))
    const nr = b.numer !== null ? ` (kod ${b.numer})` : ''
    // eNadawca nie zapisuje odrzuconej przesyłki, więc w eNadawcy nie ma czego oglądać; przyczyna jest w danych
    if (!w) return { klasa: 'TRWALY' as const, znany: false, message: `eNadawca odrzucił dane przesyłki${nr}${b.opis ? '' : ', bez opisu'}: odrzuconej przesyłki eNadawca nie zapisuje, więc przyczyny szukaj w danych zamówienia (adres, kod pocztowy, telefon, masa, wymiary); jeśli są poprawne, podaj ten kod opiekunowi umowy w Poczcie Polskiej` }
    return { klasa: w.klasa, znany: true, ...(w.errorClass ? { errorClass: w.errorClass } : {}), message: `${w.tekst}${nr}` }
  })
  const kolejnosc: KlasaBleduPP[] = ['TRWALY', 'NIEJEDNOZNACZNY', 'BUFOR', 'PRZEJSCIOWY', 'DUPLIKAT']
  wyniki.sort((a, b) => kolejnosc.indexOf(a.klasa) - kolejnosc.indexOf(b.klasa))
  return wyniki[0]!
}
