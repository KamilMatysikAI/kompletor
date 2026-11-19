// Kontrakt HTTP agent druku ↔ serwer Kompletora. Te same typy opisuje README.md (sekcja „Kontrakt”);
// serwer dostanie endpointy:
//   GET  /api/druk/zlecenia?stanowisko=<id>      → OdpowiedzZlecen
//   POST /api/druk/zlecenia/<id>/wynik           ← RaportWyniku
//   POST /api/druk/stan                          ← RaportStanu
// Wszystkie z nagłówkiem `Authorization: Bearer <token stanowiska>`.
//
// (wersja 0.2.0): rola drukarki to tekst według WZOR_ROLI, a nie jedna z trzech stałych — stanowisko może
// mieć dowolną liczbę drukarek (A4, A4_2…, TERMICZNA_1, TERMICZNA_2, TERMICZNA_3…). Trzy dotychczasowe role pasują do
// wzoru bez zmian, więc stare konfiguracje działają. Serwer zleca tylko role z ostatniego raportu stanu stanowiska,
// więc agent 0.1.0 nie dostanie roli, której nie zna.

export const WERSJA_AGENTA = '0.2.0'

/** Rola drukarki: `A4`, `A4_<1–2 cyfry>` albo `TERMICZNA_<1–2 cyfry>`. Inna = odrzucona. */
export const WZOR_ROLI = /^A4(_[0-9]{1,2})?$|^TERMICZNA_[0-9]{1,2}$/

/** Role domyślne (konfiguracja przykładowa, zgodność z wersją 0.1.0). Dozwolone role opisuje WZOR_ROLI. */
export const ROLE_DRUKAREK = ['A4', 'TERMICZNA_1', 'TERMICZNA_2'] as const
export type RolaDrukarki = string

export const jestRola = (v: unknown): v is RolaDrukarki => typeof v === 'string' && WZOR_ROLI.test(v)

export const TYPY_ZLECEN = ['karta', 'lista', 'spis', 'etykieta'] as const
export type TypZlecenia = (typeof TYPY_ZLECEN)[number]

export const FORMATY = ['pdf', 'zpl'] as const
export type FormatZlecenia = (typeof FORMATY)[number]

/** Górna granica kopii jednego zlecenia — chroni rolkę etykiet przed literówką po stronie serwera. */
export const MAKS_KOPII = 20

/** Id trafia do ścieżki URL i nazwy pliku tymczasowego, więc tylko bezpieczne znaki. */
const WZOR_ID = /^[A-Za-z0-9_-]{1,100}$/

export interface ZlecenieDruku {
  id: string
  typ: TypZlecenia
  format: FormatZlecenia
  /** Docelowa drukarka jako rola; nazwę drukarki Windows zna tylko agent (konfiguracja stanowiska). */
  rola: RolaDrukarki
  /**
   * Adres pliku: bezwzględny albo względny wobec adresu serwera. Inny host tylko z listy dozwoloneHostyPlikow
   * w konfiguracji stanowiska; token idzie tylko do adresu serwera.
   */
  plikUrl: string
  kopie: number
  /** ISO 8601, opcjonalne — agent drukuje w kolejności otrzymanej listy. */
  utworzono?: string
}

export interface OdpowiedzZlecen {
  zlecenia: ZlecenieDruku[]
}

export type WynikDruku = 'OK' | 'BLAD'

export interface RaportWyniku {
  stanowisko: string
  wynik: WynikDruku
  /** Tekst dla człowieka (po polsku), przy BLAD zawsze wypełniony. */
  komunikat?: string
  /** Przy odrzuceniu zlecenia z nieznaną rolą — wartość zastępcza A4 (powód w `komunikat`). */
  rola: RolaDrukarki
  /** Nazwa drukarki Windows, na którą poszło (albo miało pójść) zlecenie. */
  drukarka?: string
  /**
   * Tylko przy pewnej awarii termicznej (nic nie wyszło): propozycja agenta, gdzie drukować. Decyzję podejmuje
   * serwer. Nie ma jej przy przekroczonym czasie druku (nie wiadomo, czy wyszło).
   */
  rolaZapasowa?: RolaDrukarki
  /** true, gdy agent powtarza raport zlecenia wydrukowanego wcześniej (np. po restarcie) — bez ponownego druku. */
  ponowienieRaportu: boolean
  czas: string
}

export type StanDrukarki = 'DOSTEPNA' | 'OFFLINE' | 'BLAD'

export interface StanJednejDrukarki {
  rola: RolaDrukarki
  nazwa: string
  stan: StanDrukarki
  komunikat?: string
  /** Liczba zadań w kolejce wydruku Windows; null, gdy nie udało się odczytać. */
  zleceniaWKolejce: number | null
}

export interface RaportStanu {
  stanowisko: string
  czas: string
  wersjaAgenta: string
  drukarki: StanJednejDrukarki[]
}

export interface BledneZlecenie {
  /** Brak id = nie da się odesłać wyniku; agent tylko loguje. */
  id?: string
  rola?: RolaDrukarki
  powod: string
}

export interface ZleceniaPoParsowaniu {
  poprawne: ZlecenieDruku[]
  bledne: BledneZlecenie[]
}

const jestTyp = (v: unknown): v is TypZlecenia => typeof v === 'string' && (TYPY_ZLECEN as readonly string[]).includes(v)
const jestFormat = (v: unknown): v is FormatZlecenia => typeof v === 'string' && (FORMATY as readonly string[]).includes(v)

/** Termiczna = prefiks `TERMICZNA_`; każda inna rola (A4, A4_2…) to drukarka zwykła, bez ZPL. */
export const jestTermiczna = (rola: RolaDrukarki) => rola.startsWith('TERMICZNA_')

/** Kolejność ról do wyświetlania i raportu: A4, A4_2…, potem termiczne po numerze. */
export function porownajRole(a: RolaDrukarki, b: RolaDrukarki): number {
  const klucz = (r: string) => {
    const term = jestTermiczna(r)
    const nr = Number(/_(\d+)$/.exec(r)?.[1] ?? (term ? 0 : 1))
    return [term ? 1 : 0, nr] as const
  }
  const [ta, na] = klucz(a)
  const [tb, nb] = klucz(b)
  return ta - tb || na - nb || (a < b ? -1 : a > b ? 1 : 0)
}

/**
 * Sprawdza odpowiedź GET /api/druk/zlecenia. Nie ufa serwerowi: błędne zlecenie nie zatrzymuje pozostałych,
 * a jeśli ma poprawne id, agent odeśle dla niego BLAD z powodem.
 */
export function parsujZlecenia(json: unknown): ZleceniaPoParsowaniu {
  const wynik: ZleceniaPoParsowaniu = { poprawne: [], bledne: [] }
  const lista = typeof json === 'object' && json !== null ? (json as { zlecenia?: unknown }).zlecenia : undefined
  if (!Array.isArray(lista)) throw new Error('Odpowiedź serwera bez tablicy „zlecenia”')
  const widziane = new Set<string>()
  for (const surowe of lista) {
    if (typeof surowe !== 'object' || surowe === null) {
      wynik.bledne.push({ powod: 'Zlecenie nie jest obiektem' })
      continue
    }
    const z = surowe as Record<string, unknown>
    const id = typeof z.id === 'string' && WZOR_ID.test(z.id) ? z.id : undefined
    const rola = jestRola(z.rola) ? z.rola : undefined
    if (!id) {
      wynik.bledne.push({ powod: `Niepoprawne id zlecenia: ${JSON.stringify(z.id)?.slice(0, 120)}` })
      continue
    }
    if (widziane.has(id)) continue // duplikat w jednej odpowiedzi — drukujemy raz
    widziane.add(id)
    const powody: string[] = []
    if (!jestTyp(z.typ)) powody.push(`nieznany typ ${JSON.stringify(z.typ)}`)
    if (!jestFormat(z.format)) powody.push(`nieznany format ${JSON.stringify(z.format)}`)
    if (!rola) powody.push(`nieznana rola drukarki ${JSON.stringify(z.rola)}`)
    if (typeof z.plikUrl !== 'string' || z.plikUrl.length === 0) powody.push('brak adresu pliku')
    if (typeof z.kopie !== 'number' || !Number.isInteger(z.kopie) || z.kopie < 1 || z.kopie > MAKS_KOPII)
      powody.push(`liczba kopii musi być od 1 do ${MAKS_KOPII}`)
    // ZPL to język drukarek Zebra — Brother A4 (i każda inna drukarka nietermiczna) wydrukowałby surowy tekst poleceń.
    if (z.format === 'zpl' && rola && !jestTermiczna(rola)) powody.push(`format ZPL nie może iść na drukarkę ${rola === 'A4' ? 'A4' : `nietermiczną ${rola}`}`)
    if (powody.length > 0) {
      wynik.bledne.push({ id, rola, powod: `Odrzucone zlecenie: ${powody.join(', ')}` })
      continue
    }
    wynik.poprawne.push({
      id,
      typ: z.typ as TypZlecenia,
      format: z.format as FormatZlecenia,
      rola: rola!,
      plikUrl: z.plikUrl as string,
      kopie: z.kopie as number,
      ...(typeof z.utworzono === 'string' ? { utworzono: z.utworzono } : {}),
    })
  }
  return wynik
}
