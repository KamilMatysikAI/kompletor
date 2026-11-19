// atrapa `_fields` (filtrujPolaWp w suicie kontraktowej) porównana z odpowiedziami prawdziwego
// WordPressa 7.1 + WooCommerce 11.2 (stos tests/woo-prawdziwy, przebieg.ts, 11.11.2026). Plik `fields-wp.json`
// to zapis z tamtego przebiegu (zamówienie fikcyjne, tylko id, status, meta_data i miasto).
import { describe, expect, it } from 'vitest'
import { filtrujPolaWp } from '@/lib/adaptery/suita-kontraktowa'
import zapis from './fields-wp.json'

describe('atrapa `_fields` = prawdziwy WordPress', () => {
  it('zapis ma meta_data (inaczej porównanie list nic nie mówi)', () => {
    expect(Array.isArray((zapis.pelne as { meta_data: unknown[] }).meta_data)).toBe(true)
    expect((zapis.pelne as { meta_data: unknown[] }).meta_data.length).toBeGreaterThan(0)
  })
  for (const [pola, prawdziwy] of Object.entries(zapis.fields)) {
    it(`_fields=${pola}`, () => {
      expect(filtrujPolaWp(zapis.pelne, pola)).toEqual(prawdziwy)
    })
  }
})
