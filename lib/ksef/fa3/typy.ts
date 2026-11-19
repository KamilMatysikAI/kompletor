// Typy buildera FA(3). Czyste dane: bez Prismy, bez sieci. Kwoty w groszach (liczby całkowite).
// Kolejność elementów i stałe przeniesione z działającego buildera naszych systemów (XSD i środowisko TEST KSeF);
// miejsca niepewne oznaczone [NIEPEWNE] i zebrane w docs/integracje/ksef.md.

/** Przestrzeń nazw schematu FA(3), obowiązuje od 01.02.2026. */
export const FA3_NAMESPACE = 'http://crd.gov.pl/wzor/2025/06/25/13775/'
export const FA3_KOD_SYSTEMOWY = 'FA (3)'
export const FA3_WERSJA_SCHEMY = '1-0E'
export const FA3_WARIANT = 3
/** Zapis w szkicu (`KsefInvoiceDraft.wersjaSchemy`). */
export const FA3_WERSJA = `${FA3_KOD_SYSTEMOWY} ${FA3_WERSJA_SCHEMY}`

/** Stawka po normalizacji (`stawka()` z lib/wfirma/faktura.ts) → kod P_12 i pola sum (P_13_x netto, P_14_x VAT). */
export interface StawkaFa3 {
  p12: string
  netto: string
  vat: string | null
  /** Procent do wyliczenia netto z brutto; 0 = stawka bez podatku (0%, zw, np). */
  procent: number
}

/** Kolejność pól sum w `Fa`. Osobna lista: klucze liczbowe obiektu JS iterują się rosnąco (0, 5, 8, 23). */
export const KOLEJNOSC_STAWEK = ['23', '8', '5', '0', 'zw', 'np'] as const

export const STAWKI_FA3: Readonly<Record<string, StawkaFa3>> = {
  '23': { p12: '23', netto: 'P_13_1', vat: 'P_14_1', procent: 23 },
  '8': { p12: '8', netto: 'P_13_2', vat: 'P_14_2', procent: 8 },
  '5': { p12: '5', netto: 'P_13_3', vat: 'P_14_3', procent: 5 },
  // 0% w kraju; „0 KR” [NIEPEWNE: kod P_12 dla krajowej 0% w FA(3), sprawdzić na TEST]
  '0': { p12: '0 KR', netto: 'P_13_6_1', vat: null, procent: 0 },
  zw: { p12: 'zw', netto: 'P_13_7', vat: null, procent: 0 },
  // niepodlegające opodatkowaniu w kraju [NIEPEWNE: „np I” vs „np II” zależnie od rodzaju usługi]
  np: { p12: 'np I', netto: 'P_13_8', vat: null, procent: 0 },
}

export interface AdresFa3 {
  /** Kod kraju ISO (tylko „PL” w tym etapie). */
  kodKraju: string
  linia1: string
  linia2?: string | null
}

export interface SprzedawcaFa3 {
  nip: string
  nazwa: string
  adres: AdresFa3
}

/**
 * Nabywca. Prawdziwe dane (także NIP) są TYLKO argumentem `zbudujFa3`: nigdy nie trafiają do bazy ani logu.
 * `nip: null` = nabywca bez NIP (`BrakID` = 1), np. osoba prywatna albo stała zastępcza szkicu.
 */
export interface NabywcaFa3 {
  nip: string | null
  nazwa: string
  adres?: AdresFa3 | null
}

export interface WierszFa3 {
  nazwa: string
  /** P_8A, np. „szt.”, „kg”. */
  jednostka: string
  /** P_8B; ilość dodatnia (kg: do trzech miejsc po przecinku). */
  ilosc: number
  /** P_9B: cena jednostkowa brutto w groszach. */
  cenaBruttoGr: number
  /** P_11A: wartość brutto wiersza w groszach (decyduje o sumach). */
  bruttoGr: number
  /** Stawka po normalizacji: „23”, „8”, „5”, „0”, „zw”, „np”. Inna = problem. */
  stawka: string
}

export interface WejscieFa3 {
  /** P_2. Szkic: `SZKIC-<id szkicu>`; numer z serii dopiero przy zatwierdzeniu do wysyłki. */
  numer: string
  /** P_1, RRRR-MM-DD. */
  dataWystawienia: string
  /** P_6 (data dostawy), gdy inna niż data wystawienia. */
  dataDostawy?: string | null
  /** DataWytworzeniaFa. */
  wytworzono: Date
  /** Tylko „PLN”; inna waluta = problem (poza zakresem). */
  waluta: string
  /** „VAT” albo „KOR” (szkic korekty przy zwrocie, z `korekta`); zaliczki = problem (poza zakresem). */
  rodzaj: string
  /**
   * dane faktury korygowanej (tylko przy `rodzaj = KOR`). Wiersze korekty metodą różnicy: ilość i kwoty
   * ujemne (zwrot). `nrKsef` null = faktura pierwotna poza KSeF (`NrKSeFN`). Skutek korekty: data korekty (TypKorekty 2).
   */
  korekta?: { przyczyna: string; numer: string; dataWystawienia: string; nrKsef: string | null } | null
  sprzedawca: SprzedawcaFa3
  nabywca: NabywcaFa3
  wiersze: WierszFa3[]
  /** Oczekiwana suma brutto (np. `Order.totalGross` w groszach); inna niż suma wierszy = problem. */
  oczekiwaneBruttoGr?: number | null
  /** Podstawa prawna zwolnienia (P_19A), wymagana przy wierszach „zw”. */
  podstawaZwolnienia?: string | null
  /** Pary klucz–wartość w `DodatkowyOpis` (bez danych klientów). */
  dodatkowyOpis?: { klucz: string; wartosc: string }[]
  /** `SystemInfo` w nagłówku. */
  systemInfo?: string | null
}

/** Problem danych: stały kod, ścieżka pola i stały tekst. Nigdy wartości z danych (NIP, nazwy, adresy). */
export interface ProblemFa3 {
  kod: string
  pole?: string
  tekst: string
}

export interface SumaStawki {
  stawka: string
  nettoGr: number
  vatGr: number
  bruttoGr: number
}

export interface SumyFa3 {
  nettoGr: number
  vatGr: number
  bruttoGr: number
  perStawka: SumaStawki[]
}

export interface ZlozonaFa3 {
  /** XML UTF-8; null = są problemy: takiej faktury nie wolno odłożyć do wysyłki. */
  xml: string | null
  wersjaSchemy: string
  sumy: SumyFa3
  problemy: ProblemFa3[]
}
