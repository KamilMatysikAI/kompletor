// sekrety pierwszego uruchomienia i funkcje docker/entrypoint.sh (bez Dockera i bez bazy).
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLIKI_SEKRETOW, czytajKodInstalacji, przygotujSekrety, uzytkownikZPasswd } from './sekrety'

const ENTRYPOINT = path.resolve(__dirname, '..', '..', 'docker', 'entrypoint.sh')

describe('sekrety pierwszego uruchomienia', () => {
  it('zakłada cztery pliki hex; drugi przebieg niczego nie zmienia; brakujący plik dokłada sam', async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), 'sekrety-')), 'sekrety')
    const r1 = await przygotujSekrety(dir)
    expect(r1.utworzone.sort()).toEqual(Object.keys(PLIKI_SEKRETOW).sort())
    const przed: Record<string, string> = {}
    for (const [n, bajty] of Object.entries(PLIKI_SEKRETOW)) {
      przed[n] = await readFile(path.join(dir, n), 'utf8')
      expect(przed[n]).toMatch(new RegExp(`^[0-9a-f]{${bajty * 2}}$`))
      // uprawnienia POSIX (na Windows fs nie ma bitów grupy i innych: sprawdza CI/Linux)
      if (process.platform !== 'win32') expect((await stat(path.join(dir, n))).mode & 0o077).toBe(0)
    }
    expect(new Set(Object.values(przed)).size).toBe(4)

    const r2 = await przygotujSekrety(dir)
    expect(r2.utworzone).toEqual([])
    for (const n of Object.keys(PLIKI_SEKRETOW)) expect(await readFile(path.join(dir, n), 'utf8')).toBe(przed[n])

    await rm(path.join(dir, 'kod_instalacji'))
    await writeFile(path.join(dir, 'app_encryption_key'), 'reczny-klucz')
    const r3 = await przygotujSekrety(dir)
    expect(r3.utworzone).toEqual(['kod_instalacji'])
    expect(await readFile(path.join(dir, 'app_encryption_key'), 'utf8')).toBe('reczny-klucz')
    expect((await readdir(dir)).sort()).toEqual(Object.keys(PLIKI_SEKRETOW).sort())
  })

  it('użytkownik z /etc/passwd i kod instalacji z pliku albo env', async () => {
    expect(uzytkownikZPasswd('root:x:0:0:root:/root:/bin/sh\napp:x:100:101:Linux User,,,:/home/app:/sbin/nologin\n', 'app')).toEqual({ uid: 100, gid: 101 })
    expect(uzytkownikZPasswd('root:x:0:0::/root:/bin/sh', 'app')).toBeNull()
    const dir = await mkdtemp(path.join(tmpdir(), 'kod-'))
    expect(await czytajKodInstalacji({ KOMPLETOR_SEKRETY_DIR: dir })).toBeNull()
    expect(await czytajKodInstalacji({ KOMPLETOR_SEKRETY_DIR: dir, KOMPLETOR_KOD_INSTALACJI: ' abc ' })).toBe('abc')
    await writeFile(path.join(dir, 'kod_instalacji'), 'abc123\n')
    expect(await czytajKodInstalacji({ KOMPLETOR_SEKRETY_DIR: dir, KOMPLETOR_KOD_INSTALACJI: 'inny' })).toBe('abc123')
    expect(await czytajKodInstalacji({})).toBeNull()
  })
})

/** `sh` na PATH (Linux, CI, Git Bash); na Windows z PowerShella bywa niedostępne — wtedy testy entrypointu pomijane. */
const shDostepne = (() => {
  try {
    execFileSync('sh', ['-c', 'true'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// bez `sh` testy entrypointu sprawdza CI/Linux, lokalnie są pomijane zamiast czerwone
describe.skipIf(!shDostepne)('docker/entrypoint.sh', () => {
  const sh = (skrypt: string, env: Record<string, string>) =>
    execFileSync('sh', ['-c', `. "${ENTRYPOINT}"; ${skrypt}`], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', KOMPLETOR_ENTRYPOINT_TYLKO_FUNKCJE: '1', ...env } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' })

  it('składnia (sh -n) entrypointu i polecenia kompletor', () => {
    expect(() => execFileSync('sh', ['-n', ENTRYPOINT])).not.toThrow()
    expect(() => execFileSync('sh', ['-n', path.join(path.dirname(ENTRYPOINT), 'kompletor-cli.sh')])).not.toThrow()
  })

  it('zbuduj_adresy: adresy i klucz z plików sekretów, tylko gdy puste w env', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ep-'))
    await przygotujSekrety(dir)
    const pg = await readFile(path.join(dir, 'postgres_password'), 'utf8')
    const app = await readFile(path.join(dir, 'app_db_password'), 'utf8')
    const key = await readFile(path.join(dir, 'app_encryption_key'), 'utf8')
    const wypisz = 'zbuduj_adresy; printf "%s\\n%s\\n%s" "${DATABASE_URL:-}" "${APP_DATABASE_URL:-}" "${APP_ENCRYPTION_KEY:-}"'
    expect(sh(wypisz, { KOMPLETOR_SEKRETY_DIR: dir }).split('\n')).toEqual([
      `postgresql://kompletor:${pg}@db:5432/kompletor`,
      `postgresql://logistyka_app:${app}@db:5432/kompletor`,
      key,
    ])
    // Coolify i inne instalacje z własnymi zmiennymi: nic nie jest nadpisane
    const wlasne = { KOMPLETOR_SEKRETY_DIR: dir, DATABASE_URL: 'postgresql://a:b@h/x', APP_DATABASE_URL: 'postgresql://logistyka_app:c@h/x', APP_ENCRYPTION_KEYS: '1:abc' }
    expect(sh(wypisz, wlasne).split('\n')).toEqual(['postgresql://a:b@h/x', 'postgresql://logistyka_app:c@h/x', ''])
    expect(sh(wypisz, { KOMPLETOR_SEKRETY_DIR: dir, KOMPLETOR_DB_HOST: 'baza', KOMPLETOR_DB_NAME: 'k2' }).split('\n')[0]).toBe(`postgresql://kompletor:${pg}@baza:5432/k2`)
    // bez KOMPLETOR_SEKRETY_DIR: nic się nie dzieje
    expect(sh(wypisz, {})).toBe('\n\n')
    // brak pliku = błąd (kontener nie startuje), bez wartości w komunikacie
    await rm(path.join(dir, 'app_db_password'))
    expect(() => sh('zbuduj_adresy', { KOMPLETOR_SEKRETY_DIR: dir })).toThrow()
  })

  it('nazwa_seeda_ok: [a-z0-9-], 1–40 znaków', () => {
    const ok = (n: string) => sh(`if nazwa_seeda_ok '${n}'; then echo tak; else echo nie; fi`, {}).trim()
    expect(ok('acme')).toBe('tak')
    expect(ok('demo')).toBe('tak')
    expect(ok('moja-firma-2')).toBe('tak')
    expect(ok('Acme')).toBe('nie')
    expect(ok('../x')).toBe('nie')
    expect(ok('a b')).toBe('nie')
    expect(ok('a'.repeat(41))).toBe('nie')
  })

  describe('kontrola_migracji_bazowej', () => {
    /** Uruchamia kontrolę z podmienionym CLI Prismy; zwraca kod wyjścia, wyjście (stderr razem ze stdout) i to, czy CLI zostało wywołane. */
    const kontrola = async (opcje: { bazowa: boolean; cli: string }) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'kontrola-'))
      const migracje = path.join(dir, 'migracje')
      await mkdir(path.join(migracje, opcje.bazowa ? '00000000000000_baza' : '20260101000000_stara'), { recursive: true })
      const sql = path.join(dir, 'kontrola.sql')
      await writeFile(sql, 'SELECT 1;\n')
      const znacznik = path.join(dir, 'wywolane')
      const skrypt = `prisma_cli() { : > "${znacznik}"; ${opcje.cli}; }; kontrola_migracji_bazowej "${migracje}" "${sql}"`
      let kod = 0
      let stderr = ''
      try {
        stderr = execFileSync('sh', ['-c', `. "${ENTRYPOINT}"; { ${skrypt}; } 2>&1`], {
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', KOMPLETOR_ENTRYPOINT_TYLKO_FUNKCJE: '1', TMPDIR: dir } as unknown as NodeJS.ProcessEnv,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (e) {
        const err = e as { status: number; stdout: string }
        kod = err.status
        stderr = err.stdout
      }
      const wywolane = await stat(znacznik).then(() => true, () => false)
      return { kod, stderr, wywolane }
    }

    it('repo bez migracji bazowej: kontrola nic nie robi (CLI nie jest wołane)', async () => {
      expect(await kontrola({ bazowa: false, cli: 'echo KOMPLETOR_BRAK_MIGRACJI_BAZOWEJ >&2; return 1' })).toEqual({ kod: 0, stderr: '', wywolane: false })
    })

    it('baza ze starszą historią bez migracji bazowej: start zatrzymany z poleceniem naprawy', async () => {
      const r = await kontrola({ bazowa: true, cli: 'echo "ERROR: KOMPLETOR_BRAK_MIGRACJI_BAZOWEJ" >&2; return 1' })
      expect(r.kod).toBe(1)
      expect(r.wywolane).toBe(true)
      expect(r.stderr).toContain('migrate resolve --applied 00000000000000_baza')
      expect(r.stderr).toContain('--entrypoint kompletor web migracja-bazowa-wykonana')
      expect(r.stderr).not.toContain('npx')
    })

    it('polecenie naprawy z komunikatu jest w CLI kontenera i w dokumentacji', async () => {
      const cli = await readFile(path.join(path.dirname(ENTRYPOINT), 'kompletor-cli.sh'), 'utf8')
      // adresy z wolumenu sekretów są budowane przed wyborem polecenia
      expect(cli.indexOf('zbuduj_adresy')).toBeLessThan(cli.indexOf('migracja-bazowa-wykonana)'))
      expect(cli).toContain('migrate resolve --applied 00000000000000_baza')
      const docs = await readFile(path.resolve(__dirname, '..', '..', 'docs', 'instalacja.md'), 'utf8')
      expect(docs).toContain('docker compose run --rm --entrypoint kompletor web migracja-bazowa-wykonana')
    })

    it('kontrola przeszła (pusta baza albo migracja bazowa wykonana): start idzie dalej', async () => {
      expect(await kontrola({ bazowa: true, cli: 'return 0' })).toMatchObject({ kod: 0, wywolane: true })
    })

    it('inny błąd kontroli (baza nie odpowiada): nie zatrzymuje, decyduje migrate deploy', async () => {
      const r = await kontrola({ bazowa: true, cli: 'echo "P1001: Can\'t reach database server" >&2; return 1' })
      expect(r.kod).toBe(0)
      expect(r.stderr).toContain('P1001')
    })

    it('kontrola stoi w skrypcie przed migrate deploy, a obraz ma plik SQL', async () => {
      const tresc = await readFile(ENTRYPOINT, 'utf8')
      const kontrolaPoz = tresc.indexOf('kontrola_migracji_bazowej prisma/migrations kontrola-migracji-bazowej.sql || exit 1')
      expect(kontrolaPoz).toBeGreaterThan(0)
      expect(kontrolaPoz).toBeLessThan(tresc.indexOf('migrate deploy >"$MIGRATE_LOG"'))
      const dockerfile = await readFile(path.resolve(__dirname, '..', '..', 'Dockerfile'), 'utf8')
      expect(dockerfile).toContain('docker/kontrola-migracji-bazowej.sql /opt/migrate/kontrola-migracji-bazowej.sql')
    })
  })
})
