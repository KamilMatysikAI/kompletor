// Konfiguracja stanowiska: plik agent-druku.json obok programu (poza gitem). Adres serwera i token tylko tutaj.
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { jestRola } from './kontrakt.js'
import type { MapaRol } from './mapowanie.js'

export interface Konfiguracja {
  serwer: string
  token: string
  stanowisko: string
  drukarki: MapaRol
  sumatraPdf: string
  powershell: string
  odpytywanieSekundy: number
  stanSekundy: number
  limitCzasuDrukuSekundy: number
  limitCzasuSerweraSekundy: number
  maksRozmiarPlikuMb: number
  maksKolejkaTermicznej: number
  /** Obce hosty (np. magazyn plików z podpisanymi linkami), z których wolno pobierać pliki do druku — bez tokenu. */
  dozwoloneHostyPlikow: string[]
  /** Ścieżki bezwzględne (względne w pliku liczone od katalogu programu). */
  katalogDanych: string
  katalogLogow: string
  log: { maksMb: number; plikow: number }
  /** Port strony ustawień na 127.0.0.1 (zapasowy = ten + 1). */
  portUstawien: number
}

/** Domyślny port strony ustawień; gdy zajęty, program bierze następny. */
export const PORT_USTAWIEN = 47631

/** Jedyny brak w konfiguracji świeżo podłączonej kodem (drukarki wybiera się dopiero potem na stronie ustawień). */
export const BRAK_DRUKAREK = 'sekcja „drukarki” nie ma żadnej drukarki'

/** Czy tekst błędu konfiguracji mówi tylko o braku drukarek (stan „podłączony, czeka na wybór drukarek”). */
export function bezDrukarek(tekstBledu: string): boolean {
  const bledy = tekstBledu.split('\n- ').slice(1)
  return bledy.length === 1 && bledy[0] === BRAK_DRUKAREK
}

export class BladKonfiguracji extends Error {
  constructor(readonly bledy: string[]) {
    super(`Błędna konfiguracja agenta druku:\n- ${bledy.join('\n- ')}`)
    this.name = 'BladKonfiguracji'
  }
}

/** Nazwa hosta (litery, cyfry, kropki, myślniki) z opcjonalnym portem. */
const WZOR_HOSTA = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:\d{1,5})?$/

export function wczytajKonfiguracje(plik: string, katalogProgramu: string): Konfiguracja {
  let tekst: string
  try {
    tekst = readFileSync(plik, 'utf8')
  } catch {
    throw new BladKonfiguracji([`nie znaleziono pliku ${plik} — uruchom Zainstaluj.cmd i wklej kod instalacyjny z panelu (albo skopiuj agent-druku.przyklad.json jako agent-druku.json)`])
  }
  let json: unknown
  try {
    json = JSON.parse(tekst.replace(/^\uFEFF/, '')) // Notatnik zapisuje UTF-8 z BOM
  } catch (e) {
    throw new BladKonfiguracji([`plik ${plik} nie jest poprawnym JSON-em: ${(e as Error).message}`])
  }
  return sprawdzKonfiguracje(json, katalogProgramu)
}

export const SUMATRA_PROGRAM_FILES = 'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe'

/** SumatraPDF z paczki obok programu, inaczej z Program Files (zgodność ze starymi folderami). */
export function domyslnaSumatra(katalogProgramu: string, istnieje: (p: string) => boolean = existsSync): string {
  const zPaczki = join(katalogProgramu, 'sumatra', 'SumatraPDF.exe')
  return istnieje(zPaczki) ? zPaczki : SUMATRA_PROGRAM_FILES
}

export function sprawdzKonfiguracje(json: unknown, katalogProgramu: string, istnieje: (p: string) => boolean = existsSync): Konfiguracja {
  const bledy: string[] = []
  const k = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>

  const tekst = (pole: string, wymagane: boolean, domyslne = ''): string => {
    const v = k[pole]
    if (v === undefined || v === '') {
      if (wymagane) bledy.push(`brak pola „${pole}”`)
      return domyslne
    }
    if (typeof v !== 'string') {
      bledy.push(`pole „${pole}” musi być tekstem`)
      return domyslne
    }
    return v.trim()
  }
  const liczba = (obj: Record<string, unknown>, pole: string, domyslna: number, min: number, max: number, nazwa = pole) => {
    const v = obj[pole]
    if (v === undefined) return domyslna
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      bledy.push(`pole „${nazwa}” musi być liczbą od ${min} do ${max}`)
      return domyslna
    }
    return v
  }

  const serwer = tekst('serwer', true)
  if (serwer) {
    try {
      const u = new URL(serwer)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') bledy.push('„serwer” musi zaczynać się od https://')
    } catch {
      bledy.push(`„serwer” nie jest poprawnym adresem: ${serwer}`)
    }
  }
  const token = tekst('token', true)
  if (token && token.length < 16) bledy.push('„token” jest za krótki — skopiuj cały token stanowiska z panelu')
  const stanowisko = tekst('stanowisko', true)
  if (stanowisko && !/^[A-Za-z0-9_-]{1,50}$/.test(stanowisko))
    bledy.push('„stanowisko” może zawierać tylko litery bez polskich znaków, cyfry, - i _')

  const drukarki: MapaRol = {}
  const d = k.drukarki
  if (typeof d !== 'object' || d === null || Array.isArray(d)) bledy.push('brak sekcji „drukarki”')
  else {
    for (const [rola, nazwa] of Object.entries(d)) {
      // rola według wzoru (A4, A4_2…, TERMICZNA_1, TERMICZNA_2, TERMICZNA_3…), bez limitu liczby drukarek
      if (!jestRola(rola))
        bledy.push(`nieznana rola drukarki „${rola}” (dozwolone: A4, A4_2, A4_3…, TERMICZNA_1, TERMICZNA_2, TERMICZNA_3…)`)
      else if (typeof nazwa !== 'string') bledy.push(`nazwa drukarki dla „${rola}” musi być tekstem`)
      else if (nazwa.trim()) drukarki[rola] = nazwa.trim()
    }
    if (Object.keys(drukarki).length === 0) bledy.push(BRAK_DRUKAREK)
  }

  // Host albo host:port, bez protokołu i ścieżki, np. „pliki.kompletor.pl”. Domyślnie pusta lista = pliki tylko
  // z adresu serwera (inaczej przejęty serwer mógłby kazać agentowi odpytywać sieć lokalną).
  const dozwoloneHostyPlikow: string[] = []
  const h = k.dozwoloneHostyPlikow
  if (h !== undefined) {
    if (!Array.isArray(h)) bledy.push('„dozwoloneHostyPlikow” musi być listą, np. ["pliki.kompletor.pl"]')
    else
      for (const wpis of h) {
        if (typeof wpis !== 'string' || !WZOR_HOSTA.test(wpis.trim()))
          bledy.push(`„dozwoloneHostyPlikow”: ${JSON.stringify(wpis)} nie jest nazwą hosta (bez https:// i bez ścieżki, np. pliki.kompletor.pl)`)
        else dozwoloneHostyPlikow.push(wpis.trim().toLowerCase())
      }
  }

  // domyślnie SumatraPDF z paczki (sumatra\SumatraPDF.exe obok programu), a gdy go nie ma (stary folder
  // bez paczki) — dotychczasowa instalacja w Program Files.
  const sumatraPdf = tekst('sumatraPdf', false, domyslnaSumatra(katalogProgramu, istnieje))
  const powershell = tekst('powershell', false, 'powershell.exe')
  const logSurowy = (typeof k.log === 'object' && k.log !== null ? k.log : {}) as Record<string, unknown>
  const sciezka = (p: string) => (isAbsolute(p) ? p : resolve(katalogProgramu, p))

  const konfig: Konfiguracja = {
    serwer,
    token,
    stanowisko,
    drukarki,
    sumatraPdf,
    powershell,
    odpytywanieSekundy: liczba(k, 'odpytywanieSekundy', 5, 2, 300),
    stanSekundy: liczba(k, 'stanSekundy', 60, 10, 3600),
    limitCzasuDrukuSekundy: liczba(k, 'limitCzasuDrukuSekundy', 60, 5, 600),
    limitCzasuSerweraSekundy: liczba(k, 'limitCzasuSerweraSekundy', 20, 2, 300),
    maksRozmiarPlikuMb: liczba(k, 'maksRozmiarPlikuMb', 20, 1, 200),
    maksKolejkaTermicznej: liczba(k, 'maksKolejkaTermicznej', 5, 1, 1000),
    dozwoloneHostyPlikow,
    katalogDanych: sciezka(tekst('katalogDanych', false, 'dane')),
    katalogLogow: sciezka(tekst('katalogLogow', false, 'logi')),
    log: {
      maksMb: liczba(logSurowy, 'maksMb', 5, 1, 100, 'log.maksMb'),
      plikow: liczba(logSurowy, 'plikow', 5, 1, 50, 'log.plikow'),
    },
    portUstawien: liczba(k, 'portUstawien', PORT_USTAWIEN, 1024, 65534),
  }
  if (bledy.length > 0) throw new BladKonfiguracji(bledy)
  return konfig
}

/** Ostrzeżenia, które nie blokują startu (do logu). */
export function ostrzezeniaKonfiguracji(k: Konfiguracja): string[] {
  const w: string[] = []
  const u = new URL(k.serwer)
  const lokalny = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol === 'http:' && !lokalny)
    w.push('serwer bez https — token stanowiska idzie siecią otwartym tekstem; używaj tylko w zaufanej sieci lokalnej')
  if (!k.drukarki.A4) w.push('brak drukarki A4 — karty, listy i spisy nie wydrukują się, a etykiety nie mają zapasu na A4')
  return w
}
