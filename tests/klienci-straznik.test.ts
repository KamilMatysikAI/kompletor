// Strażnik kodu, wzorem tests/odbiorca-straznik.test.ts: odszyfrowanie danych klienta i każdy dostęp do
// tabeli `OrderCustomer` wyłącznie w lib/klienci/*. Reszta kodu (panel, przesyłka, faktura, wydruk) bierze dane przez
// `daneKlienta` (uprawnienie po stronie serwera + dziennik podglądów). Nowe miejsce = świadoma decyzja i wpis na
// listę. Bez bazy.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')

/** Pliki spoza lib/klienci z dozwolonym dostępem (pusta lista: nikt). */
const ALLOWED = new Set<string>([])

// odszyfrowanie, pierścień kluczy klientów i klient Prismy tabeli OrderCustomer (także przez transakcję)
// (odczyt zmiennej z env, nie sama nazwa w tekście dla człowieka)
const PATTERN = /\b(odszyfrujKlienta|kluczeKlientowZEnv)\s*\(|\borderCustomer\s*\.|\[\s*['"]CUSTOMER_DATA_KEYS['"]\s*\]|\.CUSTOMER_DATA_KEYS\b|"OrderCustomer"/

describe('strażnik kodu: dane klienta odszyfrowuje tylko lib/klienci', () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f)) files.push(path.relative(ROOT, p).replace(/\\/g, '/'))
    }
  }
  for (const d of ['lib', 'app', 'worker', 'scripts', 'seed']) {
    try {
      if (statSync(path.join(ROOT, d)).isDirectory()) walk(path.join(ROOT, d))
    } catch {
      // katalogu nie ma w tej wersji repo
    }
  }

  it('skan widzi kod (kontrola: odczyt.ts jest na liście i ma odszyfrowanie)', () => {
    expect(files).toContain('lib/klienci/odczyt.ts')
    expect(PATTERN.test(readFileSync(path.join(ROOT, 'lib/klienci/odczyt.ts'), 'utf8'))).toBe(true)
  })

  it('odszyfrowanie i dostęp do OrderCustomer tylko w lib/klienci/*', () => {
    const offenders = files.filter((f) => !f.startsWith('lib/klienci/') && !ALLOWED.has(f) && PATTERN.test(readFileSync(path.join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  // `actorId: 'system:…'` przy `daneKlienta` omija sprawdzenie członkostwa, więc taki odczyt
  // wolno zrobić tylko automatom w lib/klienci/* (wejścia przesyłki, faktury, KSeF) i lib/worker/*.
  const SYSTEM_ODCZYT = /\bdaneKlienta\s*\([^;]{0,400}?actorId:\s*[`'"]system:/
  it('odczyt danych klienta jako „system:” tylko w lib/klienci/* i lib/worker/*', () => {
    const offenders = files.filter((f) => !f.startsWith('lib/klienci/') && !f.startsWith('lib/worker/') && SYSTEM_ODCZYT.test(readFileSync(path.join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
    expect(SYSTEM_ODCZYT.test("daneKlienta(db, id, {\n  actorId: 'system:wysylka', cel: 'PRZESYLKA' })")).toBe(true)
    expect(SYSTEM_ODCZYT.test('daneKlienta(db, id, { actorId: ctx.user.id })')).toBe(false)
  })

  it('wzorzec łapie wywołanie z odstępem, przez transakcję i surowy SQL', () => {
    expect(PATTERN.test('const r = odszyfrujKlienta (ring, a, b, c)')).toBe(true)
    expect(PATTERN.test('await tx.orderCustomer.findMany()')).toBe(true)
    expect(PATTERN.test('SELECT * FROM "OrderCustomer"')).toBe(true)
    expect(PATTERN.test("env['CUSTOMER_DATA_KEYS']")).toBe(true)
    expect(PATTERN.test('process.env.CUSTOMER_DATA_KEYS')).toBe(true)
    expect(PATTERN.test('daneKlienta(db, id, opts)')).toBe(false)
  })
})
