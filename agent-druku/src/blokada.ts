// Jedna kopia agenta na komputer: dwie działające naraz wydrukowałyby te same zlecenia (rejestr jest per proces).
//
// Plik blokady trzyma PID i czas startu. Sam PID nie wystarcza (2026-10-26): po zaniku prądu
// Windows przydziela ten sam numer innemu procesowi, a procesy systemowe odpowiadają EPERM, więc „proces żyje”
// byłoby prawdą, choć agent nie działa. Dlatego blokadę uznajemy za żywą tylko wtedy, gdy właścicielem PID-u
// jest program Node; każdy inny proces = blokada po martwym agencie, przejmowana.
import { execFileSync } from 'node:child_process'
import { closeSync, linkSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { basename } from 'node:path'

/** brak = nie ma procesu; node = żyje program Node; inny = PID zajęty przez inny program; nieznany = nie da się sprawdzić. */
export type StanProcesu = 'brak' | 'node' | 'inny' | 'nieznany'
export type SprawdzProces = (pid: number) => StanProcesu

const NAZWY_NODE = new Set(['node.exe', 'node', basename(process.execPath).toLowerCase()])

/** Domyślne sprawdzenie: istnienie przez sygnał 0, nazwa programu przez `tasklist` (Windows) albo `ps`. */
export const sprawdzProces: SprawdzProces = (pid) => {
  try {
    process.kill(pid, 0)
  } catch (e) {
    const kod = (e as NodeJS.ErrnoException).code
    if (kod === 'ESRCH') return 'brak'
    if (kod !== 'EPERM') return 'nieznany' // EPERM = istnieje, ale należy do innego użytkownika — sprawdzamy nazwę
  }
  const nazwa = nazwaProcesu(pid)
  if (nazwa === undefined) return 'nieznany'
  if (nazwa === '') return 'brak'
  return NAZWY_NODE.has(nazwa.toLowerCase()) ? 'node' : 'inny'
}

/** Nazwa programu procesu; '' = nie ma takiego procesu; undefined = nie udało się sprawdzić. */
export function nazwaProcesu(pid: number): string | undefined {
  try {
    if (process.platform === 'win32') {
      // CSV bez nagłówka: "node.exe","12340","Console","1","45 000 K". Brak procesu = komunikat INFO
      // (w języku systemu), który nie zaczyna się od cudzysłowu.
      const wyjscie = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      })
      return parsujTasklist(wyjscie)
    }
    const wyjscie = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 15_000 })
    return basename(wyjscie.trim())
  } catch (e) {
    // `ps` kończy się kodem 1, gdy procesu nie ma.
    if (process.platform !== 'win32' && (e as { status?: number }).status === 1) return ''
    return undefined
  }
}

export function parsujTasklist(wyjscie: string): string {
  const linia = wyjscie.split(/\r?\n/).find((l) => l.startsWith('"'))
  if (!linia) return ''
  return linia.slice(1, linia.indexOf('"', 1))
}

interface TrescBlokady {
  pid: number
  start?: string
}

function czytajBlokade(plik: string): { tekst: string; pid?: number } {
  let tekst: string
  try {
    tekst = readFileSync(plik, 'utf8')
  } catch {
    return { tekst: '' }
  }
  const t = tekst.trim()
  let pid: number | undefined
  try {
    const json = JSON.parse(t) as Partial<TrescBlokady> | number
    pid = typeof json === 'number' ? json : json?.pid // liczba = format sprzed 2026-10-26
  } catch {
    pid = undefined
  }
  return { tekst, pid: Number.isInteger(pid) && pid! > 0 ? pid : undefined }
}

/** Zakłada plik z pełną treścią albo rzuca EEXIST. Hard link z pliku tymczasowego = brak chwili z pustym plikiem. */
function utworzAtomowo(plik: string, tresc: string, pid: number) {
  const tymczasowy = `${plik}.${pid}.tmp`
  writeFileSync(tymczasowy, tresc, 'utf8')
  try {
    linkSync(tymczasowy, plik)
  } catch (e) {
    const kod = (e as NodeJS.ErrnoException).code
    if (kod === 'EEXIST') throw e
    // System plików bez twardych dowiązań (np. FAT32 na pendrivie): zwykłe utworzenie na wyłączność.
    const fd = openSync(plik, 'wx')
    try {
      writeSync(fd, tresc)
    } finally {
      closeSync(fd)
    }
  } finally {
    rmSync(tymczasowy, { force: true })
  }
}

export interface WynikBlokady {
  /** Funkcja zwalniająca; null = działa już inna kopia. */
  zwolnij: (() => void) | null
  /** PID właściciela, gdy blokada jest zajęta. */
  zajetaPrzez?: number
}

/**
 * Zakłada plik blokady. Blokada po martwym procesie albo z PID-em, który należy teraz do programu innego niż
 * Node (np. po zaniku prądu), jest przejmowana. Gdy nazwy procesu nie da się sprawdzić, blokada zostaje
 * (bezpieczniej poczekać niż drukować dwiema kopiami) — start.ps1 spróbuje ponownie za 60 s.
 */
export function zalozBlokade(plik: string, pid = process.pid, sprawdz: SprawdzProces = sprawdzProces): WynikBlokady {
  const tresc = JSON.stringify({ pid, start: new Date().toISOString() } satisfies TrescBlokady)
  for (let proba = 0; proba < 3; proba++) {
    try {
      utworzAtomowo(plik, tresc, pid)
      return {
        zwolnij: () => {
          // Kasujemy tylko własną blokadę — nie tę, którą po nas założyła inna kopia.
          if (czytajBlokade(plik).pid === pid) rmSync(plik, { force: true })
        },
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const { tekst, pid: inny } = czytajBlokade(plik)
      if (inny !== undefined && inny !== pid) {
        const stan = sprawdz(inny)
        if (stan === 'node' || stan === 'nieznany') return { zwolnij: null, zajetaPrzez: inny }
      }
      // Martwa blokada. Kasujemy tylko, jeśli nikt jej w międzyczasie nie podmienił.
      if (czytajBlokade(plik).tekst === tekst) rmSync(plik, { force: true })
    }
  }
  return { zwolnij: null }
}
