// Paczka programu druku (Kompletor-Druk-<wersja>-win-x64.zip) serwowana przez samą aplikację: ekran Ustawienia →
// Wysyłka i druk → Druk pokazuje przycisk pobrania, a trasa GET /api/wydruki/program wysyła plik.
// Katalog wskazuje zmienna AGENT_DRUKU_KATALOG (trwały wolumen na serwerze). Nazwa pliku nigdy nie pochodzi
// z żądania: bierzemy wyłącznie zwykłe pliki z tego katalogu o nazwie według wzoru, przy kilku najwyższą wersję.
// Dowiązania symboliczne i podkatalogi pomijamy, więc nie da się wyjść poza katalog.
import 'server-only'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export const WZOR_PACZKI = /^Kompletor-Druk-(\d+)\.(\d+)\.(\d+)-win-x64\.zip$/

/** Adres trasy pobrania paczki z serwera aplikacji. */
export const ADRES_POBRANIA_PACZKI = '/api/wydruki/program'

export const BRAK_PACZKI =
  'Paczki programu druku nie ma jeszcze na serwerze. Poproś administratora instalacji o wgranie pliku (Pomoc → Druk, „Paczka programu”).'

export interface PaczkaProgramu {
  nazwa: string
  wersja: string
  /** rozmiar w bajtach */
  rozmiar: number
  sciezka: string
}

/** Z listy nazw: nazwa paczki o najwyższej wersji (porównanie liczbowe, 0.10.0 > 0.9.0) albo null. */
export function wybierzPaczke(nazwy: readonly string[]): { nazwa: string; wersja: string } | null {
  let naj: { nazwa: string; wersja: string; klucz: [number, number, number] } | null = null
  for (const nazwa of nazwy) {
    const m = WZOR_PACZKI.exec(nazwa)
    if (!m) continue
    const klucz: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (!klucz.every(Number.isSafeInteger)) continue
    if (!naj || porownaj(klucz, naj.klucz) > 0) naj = { nazwa, wersja: klucz.join('.'), klucz }
  }
  return naj && { nazwa: naj.nazwa, wersja: naj.wersja }
}

function porownaj(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * Paczka do pobrania z katalogu (domyślnie AGENT_DRUKU_KATALOG) albo null: brak zmiennej, brak katalogu, brak pliku
 * według wzoru albo błąd odczytu. Nigdy nie rzuca: ekran ma się wyświetlić także przy złym wolumenie.
 */
export async function paczkaProgramu(katalog: string | undefined = process.env.AGENT_DRUKU_KATALOG): Promise<PaczkaProgramu | null> {
  const kat = katalog?.trim()
  if (!kat) return null
  try {
    const wpisy = await readdir(kat, { withFileTypes: true })
    const wybor = wybierzPaczke(wpisy.filter((w) => w.isFile()).map((w) => w.name))
    if (!wybor) return null
    const sciezka = path.join(kat, wybor.nazwa)
    const s = await stat(sciezka)
    if (!s.isFile()) return null
    return { ...wybor, rozmiar: s.size, sciezka }
  } catch {
    return null
  }
}

/** Rozmiar dla ludzi, jak w Eksploratorze Windows: „42,5 MB”. */
export function rozmiarDlaLudzi(bajty: number): string {
  const mb = bajty / (1024 * 1024)
  if (mb >= 1) return `${mb.toLocaleString('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`
  return `${Math.max(1, Math.round(bajty / 1024)).toLocaleString('pl-PL')} KB`
}
