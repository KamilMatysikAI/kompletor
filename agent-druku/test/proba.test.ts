// kartka próbna instalatora (P przy drukarce) — PDF bez zależności i druk przez SumatraPDF (atrapa).
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { pdfKartkiProbnej, SZEROKOSC_PT, tekstPdf, WYSOKOSC_PT, wydrukujKartkeProbna, zawin } from '../src/proba.js'

describe('kartka próbna', () => {
  it('PDF 100×150 mm z numerem i nazwą, poprawna tablica xref', () => {
    const pdf = pdfKartkiProbnej({ numer: 4, nazwa: 'Zebra GK420d (kopia 1)' })
    const t = pdf.toString('latin1')
    expect(t.startsWith('%PDF-1.4')).toBe(true)
    expect(t).toContain(`/MediaBox [0 0 ${SZEROKOSC_PT} ${WYSOKOSC_PT}]`)
    expect(SZEROKOSC_PT).toBeCloseTo(283.46, 1)
    expect(WYSOKOSC_PT).toBeCloseTo(425.2, 1)
    expect(t).toContain('/F2 120 Tf')
    expect(t).toContain('(4) Tj')
    expect(t).toContain(String.raw`Zebra GK420d \(kopia 1\)`)
    // każdy wpis xref wskazuje początek „N 0 obj”
    const xref = Number(/startxref\n(\d+)/.exec(t)![1])
    const wpisy = t.slice(xref).split('\n').slice(3, 9)
    wpisy.forEach((w, i) => expect(t.slice(Number(w.slice(0, 10)))).toMatch(new RegExp(`^${i + 1} 0 obj`)))
  })

  it('polskie litery przez /Differences, nieznane znaki jako ?', () => {
    expect(tekstPdf('zażółć')).toBe(String.raw`za\207\220\203\201`)
    expect(tekstPdf('Ł€(')).toBe(String.raw`\213?\(`)
    expect(pdfKartkiProbnej({ numer: 1, nazwa: 'x' }).toString('latin1')).toContain('/Differences [128 /aogonek /cacute')
  })

  it('zawijanie długich nazw', () => {
    expect(zawin('Brother HL-L2350DW series Printer na biurku', 20)).toEqual(['Brother HL-L2350DW', 'series Printer na', 'biurku'])
    expect(zawin('A'.repeat(25), 10)).toEqual(['AAAAAAAAAA', 'AAAAAAAAAA', 'AAAAA'])
  })

  it('druk: PDF na wskazaną drukarkę, skalowanie fit, plik tymczasowy znika', async () => {
    const wywolania: { drukarka: string; plik: string; kopie: number; skal: string; byl: boolean; pdf: string }[] = []
    await wydrukujKartkeProbna(
      {
        drukujPdf: async (drukarka, plik, kopie, skal) => {
          wywolania.push({ drukarka, plik, kopie, skal, byl: existsSync(plik), pdf: readFileSync(plik, 'latin1').slice(0, 5) })
        },
      },
      'Termiczna 2',
      7,
    )
    expect(wywolania).toHaveLength(1)
    expect(wywolania[0]).toMatchObject({ drukarka: 'Termiczna 2', kopie: 1, skal: 'fit', byl: true, pdf: '%PDF-' })
    expect(existsSync(wywolania[0]!.plik)).toBe(false)
  })

  it('błąd drukarki wraca do wywołującego, plik i tak znika', async () => {
    let plik = ''
    await expect(
      wydrukujKartkeProbna({ drukujPdf: async (_d, p) => { plik = p; throw new Error('drukarka odmówiła') } }, 'X', 1),
    ).rejects.toThrow('drukarka odmówiła')
    expect(existsSync(plik)).toBe(false)
  })
})
