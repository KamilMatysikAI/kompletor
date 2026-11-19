// Walidacja XML FA(3) schematem XSD przez `xmllint-wasm`, bez sieci. Schematy z katalogu `KSEF_XSD_DIR`
// (domyślnie lib/ksef/xsd/): główny rozpoznawany po `targetNamespace` FA(3), importy (`StrukturyDanych`,
// `ElementarneTypyDanych`, `KodyKrajow`) po nazwie pliku — adresy `schemaLocation` są podmieniane na pliki lokalne.
// Brak plików = stan `XSD_NIEDOSTEPNY`, nigdy „poprawne”. Wczytane schematy trzymamy w pamięci per katalog (
// wzorzec DewFlow `xsd-validate.ts`), a błąd samego walidatora (brak workera albo pliku .wasm w obrazie) też daje
// `XSD_NIEDOSTEPNY` z komunikatem „walidator: …”, nigdy wyjątek ani 500 w panelu.
// `xmllint-wasm` jest w `serverExternalPackages`, a XSD i pakiet w `outputFileTracingIncludes` (next.config.ts).
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { FA3_NAMESPACE } from './typy'

export type StanWalidacji = 'POPRAWNY' | 'BLEDY' | 'XSD_NIEDOSTEPNY'

export interface WynikWalidacji {
  stan: StanWalidacji
  /** Komunikaty xmllint (najwyżej 20, skrócone). Walidujemy tylko XML bez danych nabywcy, więc nie ma ich też tu. */
  bledy: string[]
  komunikat: string
}

export const KSEF_XSD_DIR_DOMYSLNY = path.join('lib', 'ksef', 'xsd')

export function katalogXsd(env: Record<string, string | undefined> = process.env): string {
  // `turbopackIgnore`: katalog jest danymi w czasie działania, a nie częścią bundla (bez tego Next śledzi cały projekt)
  return path.resolve(/* turbopackIgnore: true */ env['KSEF_XSD_DIR'] || KSEF_XSD_DIR_DOMYSLNY)
}

interface Schematy {
  glowny: { fileName: string; contents: string }
  pozostale: { fileName: string; contents: string }[]
}

const SCHEMA_LOCATION = /schemaLocation="([^"]+)"/g

/** Udane wczytania per katalog: pętla dnia nie czyta ~0,3 MB schematów z dysku przy każdym zamówieniu. */
const PAMIEC = new Map<string, Schematy>()

/** Schematy z katalogu z lokalnymi `schemaLocation`; null = brak schematu FA(3) albo brak importu. */
export async function wczytajSchematy(dir: string): Promise<{ schematy: Schematy | null; powod: string }> {
  const z = PAMIEC.get(dir)
  if (z) return { schematy: z, powod: '' }
  const w = await wczytajZDysku(dir)
  // tylko udane: dołożenie plików do katalogu działa bez restartu
  if (w.schematy) PAMIEC.set(dir, w.schematy)
  return w
}

async function wczytajZDysku(dir: string): Promise<{ schematy: Schematy | null; powod: string }> {
  let pliki: string[]
  try {
    pliki = (await readdir(/* turbopackIgnore: true */ dir)).filter((f) => f.toLowerCase().endsWith('.xsd')).sort()
  } catch {
    return { schematy: null, powod: `brak katalogu schematów XSD (${dir})` }
  }
  const tresci = new Map<string, string>()
  for (const f of pliki) tresci.set(f, await readFile(path.join(/* turbopackIgnore: true */ dir, f), 'utf8'))
  const lokalnie = (loc: string) => {
    const base = loc.split(/[\\/]/).pop() ?? loc
    return tresci.has(base) ? base : null
  }
  const brakujace = new Set<string>()
  const pliki2 = [...tresci].map(([fileName, contents]) => ({
    fileName,
    contents: contents.replace(SCHEMA_LOCATION, (m, loc: string) => {
      const l = lokalnie(loc)
      if (!l) brakujace.add(loc.split(/[\\/]/).pop() ?? loc)
      return l ? `schemaLocation="${l}"` : m
    }),
  }))
  const glowny = pliki2.find((p) => p.contents.includes(`targetNamespace="${FA3_NAMESPACE}"`))
  if (!glowny) return { schematy: null, powod: `brak schematu FA(3) (targetNamespace ${FA3_NAMESPACE}) w ${dir}` }
  if (brakujace.size) return { schematy: null, powod: `brak importowanych schematów: ${[...brakujace].join(', ')}` }
  return { schematy: { glowny, pozostale: pliki2.filter((p) => p !== glowny) }, powod: '' }
}

export async function walidujFa3(xml: string, opts: { dir?: string } = {}): Promise<WynikWalidacji> {
  const { schematy, powod } = await wczytajSchematy(opts.dir ?? katalogXsd())
  if (!schematy) return { stan: 'XSD_NIEDOSTEPNY', bledy: [], komunikat: `Nie sprawdzono schematem: ${powod}.` }
  let r: Awaited<ReturnType<(typeof import('xmllint-wasm'))['validateXML']>>
  try {
    const { validateXML } = await import('xmllint-wasm')
    r = await validateXML({ xml: [{ fileName: 'faktura.xml', contents: xml }], schema: [schematy.glowny], preload: schematy.pozostale })
  } catch (e) {
    const m = (e instanceof Error ? e.message : String(e)).slice(0, 200)
    return { stan: 'XSD_NIEDOSTEPNY', bledy: [], komunikat: `Nie sprawdzono schematem: walidator: ${m}.` }
  }
  if (r.valid) return { stan: 'POPRAWNY', bledy: [], komunikat: 'Zgodny ze schematem FA(3).' }
  return { stan: 'BLEDY', bledy: r.errors.slice(0, 20).map((e) => e.message.slice(0, 300)), komunikat: `Niezgodny ze schematem FA(3): ${r.errors.length} błędów.` }
}
