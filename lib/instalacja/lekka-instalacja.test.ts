// lekka instalacja self-host — przypięte wersje zależności, Dependabot, nakładka compose.lekki.yaml oraz
// skrypty scripts/diagnostyka.sh i scripts/aktualizuj.sh (bez Dockera i bez bazy: składnia, kolejność kroków, filtr).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..', '..')
const czytaj = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')
const SEKCJE = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const
const DOKLADNA = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

describe('przypięte wersje zależności', () => {
  for (const katalog of ['.', 'agent-druku']) {
    it(`${katalog}: każda zależność ma dokładną wersję równą tej z package-lock.json`, () => {
      const pkg = JSON.parse(czytaj(`${katalog}/package.json`)) as Record<string, Record<string, string> | undefined>
      const lock = JSON.parse(czytaj(`${katalog}/package-lock.json`)) as { packages: Record<string, { version?: string } & Record<string, unknown>> }
      const korzen = lock.packages['']!
      const zle: string[] = []
      for (const s of SEKCJE) {
        for (const [nazwa, wersja] of Object.entries(pkg[s] ?? {})) {
          if (!DOKLADNA.test(wersja)) zle.push(`${s}.${nazwa}=${wersja} (bez ^, ~, zakresów)`)
          const zLocka = lock.packages[`node_modules/${nazwa}`]?.version
          if (zLocka !== wersja) zle.push(`${nazwa}: package.json ${wersja}, lock ${zLocka}`)
          const specLock = (korzen[s] as Record<string, string> | undefined)?.[nazwa]
          if (specLock !== wersja) zle.push(`${nazwa}: wpis korzenia locka ${specLock} (npm install --package-lock-only)`)
        }
      }
      expect(zle).toEqual([])
    })

    it(`${katalog}: .npmrc zapisuje nowe zależności dokładnie (save-exact)`, () => {
      expect(czytaj(`${katalog}/.npmrc`)).toMatch(/^save-exact=true$/m)
    })
  }

  it('Dependabot pilnuje npm (główny pakiet i agent druku) oraz akcji GitHuba', () => {
    const d = czytaj('.github/dependabot.yml')
    expect(d).toMatch(/package-ecosystem: npm\s+directory: \/\s/)
    expect(d).toMatch(/package-ecosystem: npm\s+directory: \/agent-druku/)
    expect(d).toMatch(/package-ecosystem: github-actions/)
  })
})

describe('compose.lekki.yaml', () => {
  const plik = czytaj('compose.lekki.yaml')

  it('każda usługa ma limit pamięci, a sterta Node mieści się w limicie kontenera z zapasem', () => {
    const limity = [...plik.matchAll(/memory: (\d+)M/g)].map((m) => Number(m[1]))
    expect(limity).toHaveLength(3)
    const sterty = [...plik.matchAll(/--max-old-space-size=(\d+)/g)].map((m) => Number(m[1]))
    expect(sterty).toHaveLength(2)
    // web i worker: sterta najwyżej połowa limitu (reszta: kod, bufory, sharp, pdfkit poza stertą)
    for (const s of sterty) expect(s * 2).toBeLessThanOrEqual(Math.min(...limity.slice(1)))
  })

  it('Postgres: bufor mniejszy od limitu kontenera, połączeń wystarczy na panel, worker i polecenia CLI', () => {
    const bufor = Number(/shared_buffers=(\d+)MB/.exec(plik)?.[1])
    const limitDb = Number(/db:[\s\S]*?memory: (\d+)M/.exec(plik)?.[1])
    expect(bufor).toBeGreaterThan(0)
    expect(bufor * 4).toBeLessThanOrEqual(limitDb)
    expect(Number(/max_connections=(\d+)/.exec(plik)?.[1])).toBeGreaterThanOrEqual(40)
  })

  it('nakładka nie zmienia obrazu, portów ani wolumenów (odwracalna: start bez niej wraca do domyślnych)', () => {
    expect(plik).not.toMatch(/^\s*(image|ports|volumes|build):/m)
  })
})

describe('scripts/diagnostyka.sh i scripts/aktualizuj.sh', () => {
  const diag = czytaj('scripts/diagnostyka.sh')
  const akt = czytaj('scripts/aktualizuj.sh')
  const shDostepny = (() => {
    try {
      execFileSync('sh', ['-c', 'exit 0'])
      return true
    } catch {
      return false
    }
  })()

  it.skipIf(!shDostepny)('składnia sh -n bez błędów', () => {
    for (const f of ['scripts/diagnostyka.sh', 'scripts/aktualizuj.sh']) execFileSync('sh', ['-n', path.join(ROOT, f)])
  })

  it('diagnostyka nie czyta sekretów ani zmiennych środowiska kontenerów', () => {
    const kod = diag.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
    for (const zakazane of [/docker\s+inspect/, /compose\s+config/, /\bprintenv\b/, /(^|[\s;|])env(\s|$)/m, /\/sekrety/, /cat\s+\/proc\/\d*\/?environ/]) {
      expect(kod).not.toMatch(zakazane)
    }
  })

  it.skipIf(!shDostepny)('filtr zakrywa e-mail, dane logowania w adresie, tokeny, klucze API i telefony; zostawia nazwy migracji', () => {
    const funkcja = /^zakryj\(\) \{[\s\S]*?^\}/m.exec(diag)?.[0]
    expect(funkcja).toBeTruthy()
    const wejscie = [
      'mail jan.kowalski@firma.pl',
      'baza postgresql://kompletor:tajne123@db:5432/kompletor',
      'tel 600 700 800 i +48600700800',
      'migracja 20261109119110_ksef_indeks_automatu',
      'token=abc Bearer xyz kmp_ABCdef123 haslo: sekretne',
      'ciag aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '"secretsKey":"ok"',
    ].join('\n')
    const wynik = execFileSync('sh', ['-c', `${funkcja}\nzakryj`], { input: wejscie, encoding: 'utf8' })
    for (const jawne of ['jan.kowalski', 'tajne123', '600 700 800', '600700800', 'abc', 'xyz', 'kmp_ABC', 'sekretne', 'aaaaaaaaaaaaaaaa']) {
      expect(wynik).not.toContain(jawne)
    }
    expect(wynik).toContain('20261109119110_ksef_indeks_automatu')
    expect(wynik).toContain('"secretsKey":"ok"')
    expect(wynik).toContain('@db:5432/kompletor')
  })

  it.skipIf(!shDostepny)('filtr zakrywa JSON, wielkie litery, Authorization, apikey, passwd i pwd', () => {
    const funkcja = /^zakryj\(\) \{[\s\S]*?^\}/m.exec(diag)![0]
    const przypadki = [
      '{"password":"abc1"}',
      '"token": "abc2"',
      '"api_key": "abc3"',
      'PASSWORD=abc4 TOKEN=abc5 SECRET=abc6 API_KEY=abc7',
      'Authorization: Basic abc8',
      'authorization: Bearer abc9',
      'apikey=abc10 passwd=abc11 pwd=abc12',
      '{"apiKey":"abc13"}',
    ]
    const wynik = execFileSync('sh', ['-c', `${funkcja}\nzakryj`], { input: przypadki.join('\n'), encoding: 'utf8' })
    for (let i = 1; i <= 13; i++) expect(wynik, `abc${i}`).not.toMatch(new RegExp(`abc${i}\\b`))
    // pola stanu z /api/health zostają czytelne
    const zdrowie = execFileSync('sh', ['-c', `${funkcja}\nzakryj`], { input: '{"secretsKey":"error","adapterKey":"woo.v1"}', encoding: 'utf8' })
    expect(zdrowie).toContain('"secretsKey":"error","adapterKey":"woo.v1"')
  })

  it.skipIf(!shDostepny)('filtr zakrywa całą wartość w cudzysłowie, także ze spacją', () => {
    const funkcja = /^zakryj\(\) \{[\s\S]*?^\}/m.exec(diag)![0]
    const przypadki = ['PASSWORD="ala ma kota"', '{"password":"dwa slowa","user":"jan"}', "haslo: 'trzy male slowa'", 'token = "x y" reszta']
    const wynik = execFileSync('sh', ['-c', `${funkcja}\nzakryj`], { input: przypadki.join('\n'), encoding: 'utf8' })
    for (const slowo of ['ala', 'kota', 'dwa', 'slowa', 'trzy', 'male', 'x y']) expect(wynik, slowo).not.toContain(slowo)
    expect(wynik).toContain('PASSWORD="<ukryte>"')
    expect(wynik).toContain('"password":"<ukryte>","user":"jan"')
    expect(wynik).toMatch(/haslo: '?<ukryte>'?$/m) // apostrofy może zjeść ogólna reguła niżej: wartość i tak cała zakryta
    expect(wynik).toContain('token = "<ukryte>" reszta')
  })

  it('diagnostyka: ostrzeżenie „przejrzyj przed wysłaniem” na początku raportu, błędy zadań filtrowane przed przycięciem', () => {
    const pierwszeEcho = diag.split('\n').filter((l) => /^echo /.test(l)).slice(0, 2).join('\n')
    expect(pierwszeEcho).toMatch(/PRZED WYSŁANIEM przejrzyj/)
    expect(diag).toMatch(/\| zakryj \| cut -c 1-\d+/)
    expect(diag).toMatch(/'g'\), 400\) from/)
  })

  it('aktualizacja: kopia bazy tylko dla właściciela (umask 077, katalog 700, plik 600), niepełna kopia nie udaje dobrej', () => {
    const umask = akt.indexOf('umask 077')
    const mkdir = akt.indexOf('mkdir -p "$KOPIE"')
    expect(umask).toBeGreaterThan(-1)
    expect(umask).toBeLessThan(mkdir)
    expect(akt).toMatch(/chmod 700 "\$KOPIE"/)
    expect(akt).toMatch(/chmod 600 "\$PLIK"/)
    expect(akt).toMatch(/pg_dump [^\n]*> "\$PLIK\.niepelny"/)
    expect(akt).toMatch(/mv "\$PLIK\.niepelny" "\$PLIK"/)
  })

  it('aktualizacja: powrót bazy do świeżej bazy (--create, bez --single-transaction) po zatrzymaniu web i workera', () => {
    const instrukcja = akt.slice(akt.indexOf('<<EOF'))
    expect(instrukcja).toMatch(/pg_restore -U "\$DB_USER" -d postgres --clean --if-exists --create < "\$PLIK"/)
    expect(instrukcja).not.toMatch(/single-transaction/)
    expect(instrukcja.indexOf('stop web worker')).toBeLessThan(instrukcja.indexOf('pg_restore'))
    expect(instrukcja).toMatch(/migrate resolve --rolled-back/)
    expect(akt).not.toMatch(/git checkout/)
    expect(akt).toMatch(/git reset --hard/)
    // kod wyjścia `up -d` nie ginie, pipefail tam, gdzie powłoka go zna
    expect(akt).not.toMatch(/up -d \|\| true/)
    expect(akt).toMatch(/set -o pipefail/)
  })

  it('aktualizacja: kopia bazy (sprawdzona) przed pobraniem kodu, budowa przed restartem, na końcu health', () => {
    const kod = akt.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
    const poz = (re: RegExp) => {
      const m = re.exec(kod)
      expect(m, String(re)).toBeTruthy()
      return m!.index
    }
    const kopia = poz(/pg_dump .* -Fc/)
    const sprawdzenie = poz(/pg_restore -l/)
    const pull = poz(/git pull --ff-only/)
    const budowa = poz(/dc build web/)
    const restart = poz(/dc up -d/)
    const health = poz(/"pending":0/)
    expect(kopia).toBeLessThan(sprawdzenie)
    expect(sprawdzenie).toBeLessThan(pull)
    expect(pull).toBeLessThan(budowa)
    expect(budowa).toBeLessThan(restart)
    expect(restart).toBeLessThan(health)
  })

  it('aktualizacja niczego nie kasuje ani nie cofa bazy sama', () => {
    const kod = akt.split('\n').filter((l) => !l.trimStart().startsWith('#'))
    // pg_restore --clean wolno tylko w instrukcji dla człowieka (heredoc po STOP), nie jako polecenie skryptu
    const heredoc = kod.findIndex((l) => l.includes('<<EOF'))
    const polecenia = kod.slice(0, heredoc).join('\n')
    expect(polecenia).not.toMatch(/\brm\s|down\s+-v|--volumes|pg_restore\s+.*--clean|dropdb|DROP\s+DATABASE/i)
  })

  it('kopie bazy poza repozytorium i poza kontekstem obrazu', () => {
    expect(czytaj('.gitignore')).toMatch(/^kopie\/$/m)
    expect(czytaj('.dockerignore')).toMatch(/^kopie$/m)
    expect(czytaj('.dockerignore')).toMatch(/^\*\*\/\*\.dump$/m)
    expect(existsSync(path.join(ROOT, 'kopie'))).toBe(false)
  })
})
