// Preset firmy jako plik JSON: konfiguracja konkretnej firmy (konta kanałów, magazyn, reguły przewoźników,
// odbiory, strefy, ustawienia) nie siedzi w kodzie, tylko w `seed/presety/<nazwa>.json` (w repo tylko przykład),
// w prywatnej nakładce `prywatne/presety/<nazwa>.json` albo w pliku wskazanym `KOMPLETOR_PRESET_PLIK` (prywatna
// konfiguracja zamontowana do kontenera). Bez sekretów: klucze API idą do sekretów
// firmy (npm run sekret) albo do env w self-hoście.
//
// Plik jest czytany w czasie działania (fs), nigdy importowany statycznie: kod i bundel CLI budują się bez żadnego
// presetu w repo. Walidacja: typy pól tutaj, reguły biznesowe w `validatePreset` (lib/organizacje.ts). Nieznany klucz
// to błąd (literówka w pliku nie może po cichu zgubić ustawienia). Klucz `_komentarz` (tekst albo lista tekstów)
// jest dozwolony na każdym poziomie obiektu i pomijany: JSON nie ma komentarzy.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { $Enums } from '@prisma/client'
import { type OrgPreset, validatePreset } from './organizacje'

/** Błąd pliku presetu: komunikat dla człowieka, bez stack trace w CLI. */
export class PresetError extends Error {}

const NAZWA_RE = /^[a-z0-9-]{1,40}$/

/** Katalog presetów w repo i w obrazie (`/app/seed/presety`), względem katalogu roboczego procesu. */
export function katalogPresetow(cwd = process.cwd()): string {
  return path.join(cwd, 'seed', 'presety')
}

/**
 * Katalog prywatnej nakładki presetów (`prywatne/presety`, w obrazie `/app/prywatne/presety`): presety firm, które
 * nie należą do publicznego repo. Katalog `prywatne/` jest w `.gitignore` i `.dockerignore`; w kontenerze plik się
 * montuje (docs/instalacja.md, „Własny preset firmy”).
 */
export function katalogPresetowPrywatnych(cwd = process.cwd()): string {
  return path.join(cwd, 'prywatne', 'presety')
}

/**
 * Ścieżka presetu: `KOMPLETOR_PRESET_PLIK` (gdy ustawiona) wygrywa z nazwą, inaczej `seed/presety/<nazwa>.json`,
 * a gdy go nie ma, a jest `prywatne/presety/<nazwa>.json`, ten z prywatnej nakładki. Nazwa tylko `[a-z0-9-]`, żeby
 * nie dało się wyjść poza katalog presetów.
 */
export function sciezkaPresetu(nazwa: string | undefined, env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  const plik = env['KOMPLETOR_PRESET_PLIK']?.trim()
  if (plik) return path.resolve(cwd, plik)
  if (!nazwa || !NAZWA_RE.test(nazwa)) throw new PresetError(`Zła nazwa presetu „${nazwa ?? ''}” (małe litery, cyfry, myślnik, do 40 znaków)`)
  const publiczny = path.join(katalogPresetow(cwd), `${nazwa}.json`)
  const prywatny = path.join(katalogPresetowPrywatnych(cwd), `${nazwa}.json`)
  return !existsSync(publiczny) && existsSync(prywatny) ? prywatny : publiczny
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

function sprawdzKlucze(o: Obj, gdzie: string, dozwolone: readonly string[]): void {
  for (const k of Object.keys(o)) {
    if (k === '_komentarz') {
      const v = o[k]
      if (typeof v !== 'string' && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) throw new PresetError(`${gdzie}._komentarz: tekst albo lista tekstów`)
      continue
    }
    if (!dozwolone.includes(k)) throw new PresetError(`${gdzie}: nieznany klucz „${k}” (dozwolone: ${dozwolone.join(', ')})`)
  }
}

function tekst(o: Obj, k: string, gdzie: string, opcja: 'wymagany' | 'opcjonalny' | 'null' = 'wymagany'): void {
  const v = o[k]
  if (v === undefined && opcja !== 'wymagany') return
  if (v === null && opcja === 'null') return
  if (typeof v !== 'string') throw new PresetError(`${gdzie}.${k}: oczekiwany tekst`)
}

function calkowita(o: Obj, k: string, gdzie: string): void {
  if (!Number.isInteger(o[k])) throw new PresetError(`${gdzie}.${k}: oczekiwana liczba całkowita`)
}

function logiczna(o: Obj, k: string, gdzie: string, opcjonalna = false): void {
  if (o[k] === undefined && opcjonalna) return
  if (typeof o[k] !== 'boolean') throw new PresetError(`${gdzie}.${k}: oczekiwane true albo false`)
}

function wylicz(o: Obj, k: string, gdzie: string, wartosci: Record<string, string>, nullable = false): void {
  const v = o[k]
  if (v === null && nullable) return
  if (typeof v !== 'string' || !(v in wartosci)) throw new PresetError(`${gdzie}.${k}: jedno z ${Object.keys(wartosci).join(', ')}${nullable ? ' albo null' : ''}`)
}

function lista(o: Obj, k: string, gdzie: string): Obj[] | undefined {
  const v = o[k]
  if (v === undefined) return undefined
  if (!Array.isArray(v) || !v.every(isObj)) throw new PresetError(`${gdzie}.${k}: oczekiwana lista obiektów`)
  return v
}

/**
 * Sprawdza typy pól presetu z JSON i zwraca `OrgPreset` bez kluczy `_komentarz`. Reguły biznesowe (slug, wzorce,
 * godziny, klucze adapterów) sprawdza potem `validatePreset`.
 */
export function presetZJson(dane: unknown, zrodlo = 'preset'): OrgPreset {
  if (!isObj(dane)) throw new PresetError(`${zrodlo}: oczekiwany obiekt JSON`)
  sprawdzKlucze(dane, zrodlo, ['id', 'slug', 'name', 'settings', 'warehouses', 'channels', 'carrierRules', 'carrierPickups', 'zoneRules', 'zones', 'statusGroups', 'statuses', 'automationGroups', 'automationRules'])
  for (const k of ['id', 'slug', 'name']) tekst(dane, k, zrodlo)
  if (dane['settings'] !== undefined && !isObj(dane['settings'])) throw new PresetError(`${zrodlo}.settings: oczekiwany obiekt`)

  lista(dane, 'warehouses', zrodlo)?.forEach((w, i) => {
    const g = `${zrodlo}.warehouses[${i}]`
    sprawdzKlucze(w, g, ['id', 'name', 'wfirmaWarehouseId'])
    tekst(w, 'id', g)
    tekst(w, 'name', g)
    tekst(w, 'wfirmaWarehouseId', g, 'null')
  })
  lista(dane, 'channels', zrodlo)?.forEach((c, i) => {
    const g = `${zrodlo}.channels[${i}]`
    sprawdzKlucze(c, g, ['channel', 'channelAccountId', 'name', 'blStorageId', 'adapterKey', 'config', 'active'])
    wylicz(c, 'channel', g, $Enums.Channel)
    tekst(c, 'channelAccountId', g)
    tekst(c, 'name', g)
    tekst(c, 'blStorageId', g, 'null')
    tekst(c, 'adapterKey', g, 'opcjonalny')
    if (c['config'] !== undefined && !isObj(c['config'])) throw new PresetError(`${g}.config: oczekiwany obiekt`)
    logiczna(c, 'active', g, true)
  })
  lista(dane, 'carrierRules', zrodlo)?.forEach((r, i) => {
    const g = `${zrodlo}.carrierRules[${i}]`
    sprawdzKlucze(r, g, ['priority', 'channel', 'pattern', 'carrier', 'shippingModule', 'adapterKey'])
    calkowita(r, 'priority', g)
    if (r['channel'] === undefined) throw new PresetError(`${g}.channel: wymagane (null = każdy kanał)`)
    wylicz(r, 'channel', g, $Enums.Channel, true)
    if (r['pattern'] === undefined) throw new PresetError(`${g}.pattern: wymagane (null = każda metoda dostawy)`)
    tekst(r, 'pattern', g, 'null')
    wylicz(r, 'carrier', g, $Enums.Carrier)
    wylicz(r, 'shippingModule', g, $Enums.ShippingModule)
    if (r['adapterKey'] !== undefined) tekst(r, 'adapterKey', g, 'null')
  })
  lista(dane, 'carrierPickups', zrodlo)?.forEach((s, i) => {
    const g = `${zrodlo}.carrierPickups[${i}]`
    sprawdzKlucze(s, g, ['carrier', 'weekdays', 'pickupMinute', 'promiseUntilMinute', 'active', 'example'])
    wylicz(s, 'carrier', g, $Enums.Carrier)
    if (!Array.isArray(s['weekdays']) || !s['weekdays'].every(Number.isInteger)) throw new PresetError(`${g}.weekdays: lista dni tygodnia 1–7`)
    calkowita(s, 'pickupMinute', g)
    calkowita(s, 'promiseUntilMinute', g)
    logiczna(s, 'active', g)
    logiczna(s, 'example', g, true)
  })
  // strefy firmy; reguły wskazują klucz strefy (zgodność kluczy sprawdza validatePreset)
  lista(dane, 'zones', zrodlo)?.forEach((z, i) => {
    const g = `${zrodlo}.zones[${i}]`
    sprawdzKlucze(z, g, ['key', 'name', 'color', 'sortOrder'])
    tekst(z, 'key', g)
    tekst(z, 'name', g)
    tekst(z, 'color', g)
    calkowita(z, 'sortOrder', g)
  })
  lista(dane, 'zoneRules', zrodlo)?.forEach((r, i) => {
    const g = `${zrodlo}.zoneRules[${i}]`
    sprawdzKlucze(r, g, ['priority', 'pattern', 'zone'])
    calkowita(r, 'priority', g)
    tekst(r, 'pattern', g)
    tekst(r, 'zone', g)
  })
  // statusy firmy i ich grupy (zgodność grup i pokrycie statusów rdzenia sprawdza validatePreset)
  lista(dane, 'statusGroups', zrodlo)?.forEach((x, i) => {
    const g = `${zrodlo}.statusGroups[${i}]`
    sprawdzKlucze(x, g, ['key', 'name', 'sortOrder', 'collapsed'])
    tekst(x, 'key', g)
    tekst(x, 'name', g)
    calkowita(x, 'sortOrder', g)
    logiczna(x, 'collapsed', g, true)
  })
  lista(dane, 'statuses', zrodlo)?.forEach((x, i) => {
    const g = `${zrodlo}.statuses[${i}]`
    sprawdzKlucze(x, g, ['key', 'name', 'customerName', 'color', 'groupKey', 'sortOrder', 'baseStatus', 'carriers', 'active'])
    tekst(x, 'key', g)
    tekst(x, 'name', g)
    tekst(x, 'customerName', g, 'null')
    tekst(x, 'color', g)
    tekst(x, 'groupKey', g, 'null')
    calkowita(x, 'sortOrder', g)
    wylicz(x, 'baseStatus', g, $Enums.OrderStatus)
    const c = x['carriers']
    if (c !== undefined && !(Array.isArray(c) && c.every((v) => typeof v === 'string' && Object.hasOwn($Enums.Carrier, v)))) throw new PresetError(`${g}.carriers: lista przewoźników (${Object.keys($Enums.Carrier).join(', ')})`)
    logiczna(x, 'active', g, true)
  })
  // automatyczne akcje (format lib/automaty/szablon.ts); treść reguł sprawdza validatePreset (parsujRegule)
  lista(dane, 'automationGroups', zrodlo)?.forEach((x, i) => {
    const g = `${zrodlo}.automationGroups[${i}]`
    sprawdzKlucze(x, g, ['key', 'name', 'sortOrder', 'collapsed'])
    tekst(x, 'key', g)
    tekst(x, 'name', g)
    if (x['sortOrder'] !== undefined) calkowita(x, 'sortOrder', g)
    logiczna(x, 'collapsed', g, true)
  })
  lista(dane, 'automationRules', zrodlo)?.forEach((x, i) => {
    const g = `${zrodlo}.automationRules[${i}]`
    sprawdzKlucze(x, g, ['key', 'groupKey', 'name', 'enabled', 'event', 'conditions', 'actions', 'buttonLabel', 'buttonPlaces', 'description'])
    tekst(x, 'key', g)
    tekst(x, 'groupKey', g, 'null')
    tekst(x, 'name', g)
    tekst(x, 'event', g)
    logiczna(x, 'enabled', g, true)
    if (x['conditions'] !== undefined && !Array.isArray(x['conditions'])) throw new PresetError(`${g}.conditions: oczekiwana lista`)
    if (!Array.isArray(x['actions'])) throw new PresetError(`${g}.actions: oczekiwana lista kroków`)
    tekst(x, 'buttonLabel', g, 'null')
    tekst(x, 'description', g, 'null')
    if (x['buttonPlaces'] !== undefined && !(Array.isArray(x['buttonPlaces']) && x['buttonPlaces'].every((v) => typeof v === 'string'))) throw new PresetError(`${g}.buttonPlaces: lista miejsc`)
  })
  return bezKomentarzy(dane) as unknown as OrgPreset
}

function bezKomentarzy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(bezKomentarzy)
  if (!isObj(v)) return v
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_komentarz').map(([k, x]) => [k, bezKomentarzy(x)]))
}

/**
 * Czyta preset z pliku JSON: typy pól (`presetZJson`), potem `validatePreset`. Brak pliku, zły JSON albo zła
 * wartość = `PresetError` z nazwą pliku i pola.
 */
export async function wczytajPreset(sciezka: string): Promise<OrgPreset> {
  let tresc: string
  try {
    tresc = await readFile(sciezka, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    throw new PresetError(code === 'ENOENT' ? `Brak pliku presetu: ${sciezka}` : `Nie da się odczytać presetu ${sciezka}: ${code ?? String(e)}`)
  }
  let dane: unknown
  try {
    dane = JSON.parse(tresc)
  } catch (e) {
    throw new PresetError(`Zły JSON w ${sciezka}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const preset = presetZJson(dane, path.basename(sciezka))
  try {
    validatePreset(preset)
  } catch (e) {
    throw new PresetError(`${path.basename(sciezka)}: ${e instanceof Error ? e.message : String(e)}`)
  }
  return preset
}
