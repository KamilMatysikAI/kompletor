// Strażnik publicznego wydania: do kodu produkcyjnego nie wraca nic specyficznego dla jednej firmy.
// Konfiguracja konkretnej firmy żyje w presecie i w tabeli nadpisań ofert w prywatnej nakładce (prywatne/presety,
// prywatne/nadpisania-ofert; poza repo i obrazem), obie opcjonalne; w repo tylko przykład. Migracje są
// historią i ich się nie zmienia. Wzorce, dozwolone fragmenty i jawna lista wyjątków: tests/straznik-nazw.ts;
// testy są w zakresie strażnika, wielkość liter bez znaczenia.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLIKI_POZA_STRAZNIKIEM, WLACZ_WZORCE_PRZED_PUBLIKACJA, WZORCE_PRZED_PUBLIKACJA, ZAKAZANE, pozaZakresem, slady, wzorceAktywne } from './straznik-nazw'

const ROOT = path.resolve(__dirname, '..')

/** Pliki śledzone w repo (to, co trafia do publicznego wydania; lokalne notatki w klonie nie), istniejące na dysku. */
const plikiRepo = (): string[] =>
  execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f && existsSync(path.join(ROOT, f)) && statSync(path.join(ROOT, f)).isFile())

/** Treść pliku czytana z dysku raz na przebieg (dwa testy przechodzą przez te same pliki repo). */
const tresci = new Map<string, string>()
const czytaj = (f: string): string => {
  let t = tresci.get(f)
  if (t === undefined) {
    t = readFileSync(path.join(ROOT, f), 'utf8')
    tresci.set(f, t)
  }
  return t
}

/**
 * Skan wszystkich plików repo to odczyt z dysku (osobno ok. 1 s). Obok testów integracyjnych i innych przebiegów
 * na tym samym dysku potrafi przekroczyć domyślne 5 s vitest; jawny limit chroni przed zawieszeniem, nie mierzy szybkości.
 */
const LIMIT_SKANU_REPO_MS = 60_000

describe('strażnik publicznego wydania', () => {
  const pliki = plikiRepo().filter((f) => !pozaZakresem(f))
  const sprawdzane = pliki.filter((f) => !PLIKI_POZA_STRAZNIKIEM.has(f))

  it('w kodzie, testach i dokumentacji nie ma nazw firmy, sklepów, asortymentu, osób ani notatek spoza repo', () => {
    expect(sprawdzane.length).toBeGreaterThan(500)
    expect(sprawdzane.some((f) => f.startsWith('tests/'))).toBe(true)
    const znalezione = sprawdzane.flatMap((f) => slady(f, czytaj(f)))
    expect(znalezione).toEqual([])
  }, LIMIT_SKANU_REPO_MS)

  it('wyjątki strażnika istnieją (lista nie gnije po przeniesieniu pliku)', () => {
    for (const f of PLIKI_POZA_STRAZNIKIEM) expect(existsSync(path.join(ROOT, f)), f).toBe(true)
  })

  it('wzorce łapią nazwy bez względu na wielkość liter, a dozwolone fragmenty przepuszczają', () => {
    const kat = (tresc: string, plik = 'lib/x.ts') => slady(plik, tresc).map((s) => s.split(': ')[1])
    expect(kat('KRAINAHERBATY.pl')).toContain('nazwa sklepu')
    expect(kat('sklep hurtowy bomb')).toContain('asortyment firmy')
    expect(kat('const x = "EtinBOT"')).toContain('nazwa firmy')
    expect(kat('ETIN_PRESET')).toContain('nazwa firmy')
    expect(kat('Herbata zielona 50 g')).toContain('asortyment firmy')
    expect(kat("sku: 'KH-123'")).toContain('skrót sklepu')
    expect(kat('kod KH48213/1')).toContain('skrót sklepu')
    expect(kat('ALLEGRO_KH')).toContain('skrót sklepu')
    expect(kat('plan: Materialy/a-1/plan.md')).toContain('katalog notatek')
    expect(kat('(decyzja kamila 05.11)')).toContain('osoba z zespołu')
    expect(kat('konto 4020996')).toContain('identyfikator konta')
    // bez fałszywych trafień: pojęcia techniczne, klucze danych stref, stary parametr adresu, słowa zawierające wzorzec
    expect(kat('chroni przed bombą ZIP i bombą dekompresyjną')).toEqual([])
    expect(kat("{ key: 'HERBATY_KAWY', name: 'produkty spożywcze' }; ?strefa=bomby")).toEqual([])
    // nazwy stref z asortymentem firmy należą do presetu, nie do kodu
    expect(kat("{ key: 'HERBATY_KAWY', name: 'herbaty i kawy' }")).toContain('asortyment firmy')
    expect(kat('Filtr strefy (bomby i akcesoria / mieszane)')).toContain('asortyment firmy')
    expect(kat("const s = one(sp.kh); kh: parametry('kh'), stare `kh`/`kf`")).toEqual([])
    expect(kat('[...xml.matchAll(re)]; khaki; ekh; Kambodża')).toEqual([])
    // nazwa właściciela praw tylko w plikach projektu i tylko jako pełna nazwa spółki albo adres kontaktowy
    expect(kat('prawa autorskie: ETIN Group Sp. z o.o.', 'README.md')).toEqual([])
    expect(kat('prawa autorskie: ETIN Group Sp. z o.o.')).toContain('nazwa firmy')
    expect(kat('EtinBOT', 'README.md')).toContain('nazwa firmy')
  })

  it('wzorce sprzed publikacji (identyfikatory zadań, nazwy modeli) są włączone i działają', () => {
    // Włączone po codemodzie identyfikatorów (WLACZ_WZORCE_PRZED_PUBLIKACJA w tests/straznik-nazw.ts).
    expect(WLACZ_WZORCE_PRZED_PUBLIKACJA).toBe(true)
    expect(wzorceAktywne()).toEqual([...ZAKAZANE, ...WZORCE_PRZED_PUBLIKACJA])
    const kat = (tresc: string) => slady('lib/x.ts', tresc).map((s) => s.split(': ')[1])
    expect(kat('// LOG-A-154: poprawka')).toContain('identyfikator zadania')
    expect(kat('// log-k-018')).toContain('identyfikator zadania')
    expect(kat('po przeglądzie Fable')).toContain('nazwa modelu')
    expect(kat('recenzja: Grok, potem Opus')).toContain('nazwa modelu')
    expect(kat('Claude Code — Anna; BLOG-A-1x; opusy')).toEqual([])
    // modele dostawcy AI do wyboru w panelu to funkcja produktu, nie ślad przeglądu
    expect(kat("{ id: 'claude-opus-5-5', etykieta: 'Claude Opus 5.5 (najlepsze teksty)' }")).toEqual([])
    expect(kat("model: 'claude-sonnet-5-5'")).toEqual([])
    expect(kat('przegląd: Claude Opus')).toContain('nazwa modelu')
  })

  it('kod produkcyjny nie importuje z seed/ (presety czyta się z pliku w czasie działania)', () => {
    const IMPORT_SEED = /(?:from\s+|import\s*\(\s*|require\(\s*)['"](?:@\/seed\/|(?:\.\.?\/)+seed\/)/
    const kod = pliki.filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f) && !f.startsWith('tests/') && !/\.test\.tsx?$/.test(f))
    expect(kod.filter((f) => IMPORT_SEED.test(czytaj(f)))).toEqual([])
    expect(IMPORT_SEED.test("import { X } from '../seed/firma'")).toBe(true)
    expect(IMPORT_SEED.test("import x from '@/seed/presety/firma.json'")).toBe(true)
    expect(IMPORT_SEED.test("const p = path.join(cwd, 'seed', 'presety')")).toBe(false)
  }, LIMIT_SKANU_REPO_MS)

  it('kod i testy budują się bez presetu firmy: przykładowy preset jest w repo', () => {
    expect(existsSync(path.join(ROOT, 'seed', 'presety', 'przyklad.json'))).toBe(true)
    expect(existsSync(path.join(ROOT, 'dane', 'nadpisania-ofert', '.gitkeep'))).toBe(true)
  })

  it('presety i nadpisania firm są poza repo i obrazem (prywatna nakładka prywatne/, montowana)', () => {
    const sledzone = execFileSync('git', ['ls-files', '--cached', '-z', '--', 'seed', 'dane', 'prywatne'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    expect(sledzone.sort()).toEqual(['dane/nadpisania-ofert/.gitkeep', 'seed/presety/przyklad.json'])
    const linie = (f: string) => readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).map((l) => l.trim())
    expect(linie('.gitignore')).toContain('/prywatne/')
    const di = linie('.dockerignore')
    for (const l of ['prywatne', 'seed/presety/*', '!seed/presety/przyklad.json', 'dane/nadpisania-ofert/*', '!dane/nadpisania-ofert/.gitkeep']) expect(di).toContain(l)
    // Dockerfile kopiuje do obrazu tylko katalogi (filtrowane przez .dockerignore), nigdy pliku konkretnej firmy
    expect(linie('Dockerfile').filter((l) => l.startsWith('COPY') && /prywatne|presety\/|nadpisania-ofert\/|\.csv\b/i.test(l))).toEqual([])
  })
})
