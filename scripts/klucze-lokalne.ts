// Klucze z lokalnych plików .env innych projektów (self-host na własnym komputerze), bez kopiowania ich do repo
// i bez wypisywania wartości. Mapa źródeł leży POZA repo produktu: plik JSON wskazany `--klucze-z <plik.json>`
// albo zmienną env KLUCZE_LOKALNE. Format: [{ "file": "<ścieżka .env>", "keys": { "<nasza zmienna>": "<zmienna w pliku>" } }].
// Zmienne już ustawione w env wygrywają.
import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'dotenv'

export type Env = Record<string, string | undefined>

interface KeySource {
  file: string
  keys: Record<string, string>
}

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/

export function parseKeyMap(json: string): KeySource[] {
  const v = JSON.parse(json) as unknown
  if (!Array.isArray(v)) throw new Error('Mapa kluczy: oczekiwana lista [{ file, keys }]')
  return v.map((x, i) => {
    const o = x as Partial<KeySource>
    if (typeof o.file !== 'string' || !o.file.trim() || !o.keys || typeof o.keys !== 'object') throw new Error(`Mapa kluczy: wpis ${i + 1} bez file albo keys`)
    for (const [t, f] of Object.entries(o.keys)) if (!NAME_RE.test(t) || typeof f !== 'string' || !NAME_RE.test(f)) throw new Error(`Mapa kluczy: zła nazwa zmiennej we wpisie ${i + 1}`)
    return { file: o.file, keys: o.keys as Record<string, string> }
  })
}

/** Env uzupełniony kluczami z plików z mapy (`mapPath`); bez mapy — env bez zmian. */
export function envWithLocalKeys(base: Env, mapPath: string | undefined): Env {
  if (!mapPath) return base
  if (!existsSync(mapPath)) throw new Error(`Brak pliku mapy kluczy ${mapPath}`)
  const env: Env = { ...base }
  for (const src of parseKeyMap(readFileSync(mapPath, 'utf8'))) {
    if (!existsSync(src.file)) {
      console.warn(`[klucze] brak pliku ${src.file}`)
      continue
    }
    const parsed = parse(readFileSync(src.file))
    for (const [target, from] of Object.entries(src.keys)) if (!env[target] && parsed[from]) env[target] = parsed[from]
  }
  return env
}
