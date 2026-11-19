import { describe, expect, it } from 'vitest'
import { smallRaw } from '@/tests/fixtures'
import { analyze } from './katalog'
import { csv, renderReport } from './raport'

describe('raport', () => {
  it('ma wszystkie sekcje i próg ofert ze sprzedażą bez powiązania', () => {
    const raw = smallRaw()
    const rep = renderReport(raw, analyze(raw), { generatedAt: new Date('2026-10-22T12:00:00Z'), runId: 'r1' })
    for (const h of [
      '## Wynik w skrócie',
      '## Powiązania z magazynem per kanał',
      '## Oferty bez powiązania',
      '## Duplikaty SKU i EAN',
      '## Zestawy i warianty',
      '## Produkty powiązane z towarem wFirmy w kg',
      '## Zgodność z wFirmą',
      '## Problemy przy pobieraniu',
    ])
      expect(rep.markdown).toContain(h)
    expect(rep.markdown).toContain('bez jednoznacznego powiązania = 1**')
    expect(Object.keys(rep.csv).sort()).toEqual(['bl-bez-wfirmy.csv', 'bl-vs-wfirma-rozbieznosci.csv', 'do-zatwierdzenia-po-sku.csv', 'oferty-bez-powiazania.csv', 'oferty-wszystkie.csv'])
    expect(rep.csv['oferty-bez-powiazania.csv']).toContain('9002')
    // (przegląd poprawek): stopka bez ścieżek komputera, sama komenda
    expect(rep.markdown).toContain('`npm run import:katalog`')
    expect(rep.markdown).not.toMatch(/\b[A-Za-z]:\\/)
  })

  it('bez wFirmy raport mówi to wprost', () => {
    const raw = { ...smallRaw(), wfirma: null }
    expect(renderReport(raw, analyze(raw), { generatedAt: new Date() }).markdown).toContain('Nie pobrano danych z wFirmy')
  })

  it('CSV: średnik, cudzysłowy, nowe linie', () => {
    expect(csv([['a;b', 'c"d', 'e\nf', null]])).toBe('"a;b";"c""d";"e\nf";\r\n')
  })
})
