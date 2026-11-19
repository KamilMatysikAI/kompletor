// Sekrety pierwszego uruchomienia (`docker compose up` bez pliku .env). Jednorazowa usługa `sekrety` z
// compose.yaml (scripts/instalacja-sekrety.ts, w obrazie `node dist/instalacja.cjs`) zakłada w wolumenie `sekrety`
// pliki z losowymi wartościami hex (nie psują adresu bazy). Idempotentnie: istniejący plik NIGDY nie jest zmieniany
// (nowy klucz szyfrowania = sekrety firm nie do odczytania, nowe hasło Postgresa = baza z wolumenu się nie otworzy).
// Do logu nie trafia żadna wartość poza kodem instalacji (wypisuje go entrypoint w adresie /start).
import { randomBytes } from 'node:crypto'
import { chmod, chown, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Pliki w katalogu sekretów: nazwa → liczba losowych bajtów (zapis hex, więc 2× tyle znaków). */
export const PLIKI_SEKRETOW = {
  /** Hasło właściciela bazy (POSTGRES_PASSWORD_FILE): czyta postgres i entrypoint aplikacji. */
  postgres_password: 32,
  /** Hasło roli LOGIN logistyka_app (APP_DATABASE_URL); ustawia je web po migracjach. */
  app_db_password: 32,
  /** APP_ENCRYPTION_KEY: 32 bajty = 64 znaki hex (lib/sekrety.ts). */
  app_encryption_key: 32,
  /** Kod kreatora /start: kto go nie zna, nie założy pierwszej firmy, nawet gdy trafi na adres pierwszy. */
  kod_instalacji: 16,
} as const

export type PlikSekretu = keyof typeof PLIKI_SEKRETOW

/** Postgres w obrazie alpine (uid i gid 70). */
export const POSTGRES_UID = 70

export interface Wlasciciele {
  /** uid i gid użytkownika aplikacji (`app` w obrazie). */
  app: { uid: number; gid: number }
  postgresUid: number
}

export interface WynikSekretow {
  utworzone: PlikSekretu[]
  istniejace: PlikSekretu[]
}

/**
 * Zakłada brakujące pliki sekretów. Plik istniejący zostaje bez zmian (także jego prawa). Zapis z flagą `wx`: gdyby
 * dwa procesy ruszyły naraz, drugi nie nadpisze pliku pierwszego. Z `wlasciciele` (proces jako root w kontenerze
 * `sekrety`) ustawia właściciela: `postgres_password` = postgres:app 0440 (czytają postgres i aplikacja), reszta =
 * app:app 0400; katalog root, 0711 (wejście bez listowania). Bez `wlasciciele` (testy, uruchomienie bez roota) tylko
 * prawa 0600 i 0700.
 */
export async function przygotujSekrety(dir: string, wlasciciele?: Wlasciciele): Promise<WynikSekretow> {
  await mkdir(dir, { recursive: true })
  const wynik: WynikSekretow = { utworzone: [], istniejace: [] }
  for (const [nazwa, bajty] of Object.entries(PLIKI_SEKRETOW) as [PlikSekretu, number][]) {
    const plik = path.join(dir, nazwa)
    try {
      await writeFile(plik, randomBytes(bajty).toString('hex'), { flag: 'wx', mode: 0o600 })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      wynik.istniejace.push(nazwa)
      continue
    }
    if (wlasciciele) {
      const pg = nazwa === 'postgres_password'
      await chown(plik, pg ? wlasciciele.postgresUid : wlasciciele.app.uid, wlasciciele.app.gid)
      await chmod(plik, pg ? 0o440 : 0o400)
    }
    wynik.utworzone.push(nazwa)
  }
  if (wlasciciele && wynik.utworzone.length) await chmod(dir, 0o711)
  else if (!wlasciciele && (await stat(dir)).uid === process.getuid?.()) await chmod(dir, 0o700)
  return wynik
}

/** uid i gid użytkownika z /etc/passwd (obraz alpine: `app` z `adduser -S`). */
export function uzytkownikZPasswd(passwd: string, nazwa: string): { uid: number; gid: number } | null {
  for (const linia of passwd.split('\n')) {
    const [n, , uid, gid] = linia.split(':')
    if (n === nazwa && uid && gid && /^\d+$/.test(uid) && /^\d+$/.test(gid)) return { uid: Number(uid), gid: Number(gid) }
  }
  return null
}

/**
 * Kod instalacji dla kreatora /start: plik `kod_instalacji` w `KOMPLETOR_SEKRETY_DIR`, inaczej env
 * `KOMPLETOR_KOD_INSTALACJI` (instalacja bez wolumenu sekretów). Brak obu albo pusty = null (kreator zamknięty).
 */
export async function czytajKodInstalacji(env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const dir = env['KOMPLETOR_SEKRETY_DIR']?.trim()
  if (dir) {
    try {
      const kod = (await readFile(path.join(dir, 'kod_instalacji'), 'utf8')).trim()
      if (kod) return kod
    } catch {
      // brak pliku: niżej env
    }
  }
  const z = env['KOMPLETOR_KOD_INSTALACJI']?.trim()
  return z || null
}
