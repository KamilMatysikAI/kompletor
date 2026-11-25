// Strażnik kodu, wzorem tests/klienci-straznik.test.ts: archiwum zamówień (`ArchivedOrder`,
// `ArchivedOrderLine`) czytają i piszą wyłącznie importer archiwum (lib/archiwum/*) i miejsca z listy niżej (raporty
// sprzedaży, wyszukiwanie). Zapytanie operacyjne (pulpit pracy, lista, pakowanie, automaty i maile, API v1, cień,
// retencja) z archiwum = maile do starych klientów albo fałszywe liczniki.
// Nowe miejsce = świadoma decyzja i wpis na listę. Bez bazy.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')

/** Pliki spoza lib/archiwum z dozwolonym dostępem do archiwum. */
const ALLOWED = new Set<string>([
  'lib/api/raporty-sprzedaz.ts', // raport sprzedaży: UNION ALL archiwum bez wierszy z `Order` (etap 1)
])

/** klient Prismy tabel archiwum (także przez transakcję) i nazwa tabeli w SQL */
const PATTERN_ARCHIWUM = /\barchivedOrder(Line)?\s*\.|"ArchivedOrder(Line)?"/

function pliki(): string[] {
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
  return files
}

describe('strażnik kodu: archiwum zamówień tylko w importerze, raportach i wyszukiwaniu', () => {
  it('wzorzec łapie klienta Prismy i SQL, a nie łapie `Order`', () => {
    expect(PATTERN_ARCHIWUM.test('await tx.archivedOrder.upsert({')).toBe(true)
    expect(PATTERN_ARCHIWUM.test('db.archivedOrderLine .findMany()')).toBe(true)
    expect(PATTERN_ARCHIWUM.test('FROM "ArchivedOrder" a')).toBe(true)
    expect(PATTERN_ARCHIWUM.test('JOIN "ArchivedOrderLine" l')).toBe(true)
    expect(PATTERN_ARCHIWUM.test('FROM "Order" o JOIN "OrderLine" l')).toBe(false)
    expect(PATTERN_ARCHIWUM.test('db.order.findMany()')).toBe(false)
  })

  it('skan widzi kod (kontrola: lib/api/raporty-sprzedaz.ts jest na liście plików)', () => {
    expect(pliki()).toContain('lib/api/raporty-sprzedaz.ts')
  })

  it('dostęp do tabel archiwum tylko w lib/archiwum/* i plikach z listy', () => {
    const zle = pliki().filter((f) => !f.startsWith('lib/archiwum/') && !ALLOWED.has(f) && PATTERN_ARCHIWUM.test(readFileSync(path.join(ROOT, f), 'utf8')))
    expect(zle).toEqual([])
  })
})
