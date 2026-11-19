// Strażnik kodu: dane osobowe odbiorcy czytamy z kanału wyłącznie przez
// `pobierzOdbiorce` (bramka PRACA, wyłącznik instancji, ślad AuditLog). `getOrderRecipient` jest publiczne na każdym
// adapterze, a worker cienia tworzy adaptery tych samych kont, więc bez tego testu bramkę omija jedno wywołanie.
// Nowe miejsce = świadoma decyzja i wpis na listę (jak SYSTEM_CLIENT_ALLOWED w organizacje-izolacja). Bez bazy.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')

const RECIPIENT_ALLOWED = new Set([
  'lib/odbiorca/pobierz.ts', // jedyna droga hosta: bramka + ślad
  'lib/adaptery/kontrakt.ts', // deklaracja RecipientReader
  'lib/adaptery/woo.ts',
  'lib/adaptery/allegro.ts',
  'lib/adaptery/mirakl-empik.ts',
  'lib/adaptery/falszywy.ts', // atrapa do testów
  'lib/adaptery/suita-kontraktowa.ts', // suita kontraktowa (wołana z testów)
])

// wywołanie albo definicja metody/parsera; komentarze nie są kodem
const RECIPIENT_CALL = /\b(getOrderRecipient|wooRecipientFromApi|allegroRecipientFromApi|miraklRecipientFromApi)\s*\(/


describe('strażnik kodu: odbiorca z kanału tylko przez pobierzOdbiorce', () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) files.push(path.relative(ROOT, p).replace(/\\/g, '/'))
    }
  }
  for (const d of ['lib', 'app', 'worker', 'scripts', 'seed']) {
    try {
      if (statSync(path.join(ROOT, d)).isDirectory()) walk(path.join(ROOT, d))
    } catch {
      // katalogu nie ma w tej wersji repo
    }
  }

  it('skan widzi kod (kontrola: pobierz.ts jest na liście plików i ma wywołanie)', () => {
    expect(files).toContain('lib/odbiorca/pobierz.ts')
    expect(RECIPIENT_CALL.test(readFileSync(path.join(ROOT, 'lib/odbiorca/pobierz.ts'), 'utf8'))).toBe(true)
  })

  it('getOrderRecipient( i parsery odbiorcy kanałów tylko w plikach z listy', () => {
    const offenders = files.filter((f) => !RECIPIENT_ALLOWED.has(f) && RECIPIENT_CALL.test(readFileSync(path.join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('wzorzec łapie wywołanie przez zmienną i z odstępem, także w komentarzu (strażnik bez wycinania komentarzy)', () => {
    expect(RECIPIENT_CALL.test('const r = await adapter.getOrderRecipient (id)')).toBe(true)
    expect(RECIPIENT_CALL.test('x.miraklRecipientFromApi(raw)')).toBe(true)
  })
})
