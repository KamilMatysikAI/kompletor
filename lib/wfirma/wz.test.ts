// treść żądania WZ dla wFirmy i deklaracja zdolności `wz` dostawcy (bez sieci, bez zapisu).
import { describe, expect, it } from 'vitest'
import { problemyDostawcy, umieWydacWz } from '../dokumenty/kontrakt'
import { dostawcaWfirmy } from './dostawca'
import { wzAddBody } from './wz'

describe('WZ wFirmy', () => {
  it('treść warehouse_documents/add: typ WZ, magazyn, data, referencja, pozycje towar + ilość; bez kontrahenta', () => {
    const b = wzAddBody({ idExternal: 'wz/ord_1/1', warehouseId: '900014', date: '2026-11-06', lines: [{ wfirmaGoodId: '90000021', count: 1 }, { wfirmaGoodId: '90000063', count: 0.25 }] })
    expect(b).toEqual({
      warehouse_documents: {
        warehouse_document: {
          type: 'WZ',
          date: '2026-11-06',
          id_external: 'wz/ord_1/1',
          warehouse: { id: 900014 },
          warehouse_document_contents: {
            '0': { warehouse_document_content: { good: { id: 90000021 }, count: 1 } },
            '1': { warehouse_document_content: { good: { id: 90000063 }, count: 0.25 } },
          },
        },
      },
    })
    expect(JSON.stringify(b)).not.toMatch(/contractor/)
  })

  it('śmieci odrzucone przed wywołaniem: pusta referencja, zły magazyn, zła data, brak pozycji, ilość 0', () => {
    const ok = { idExternal: 'wz/x/1', warehouseId: '1', date: '2026-11-06', lines: [{ wfirmaGoodId: '1', count: 1 }] }
    expect(() => wzAddBody({ ...ok, idExternal: '' })).toThrow()
    expect(() => wzAddBody({ ...ok, warehouseId: 'abc' })).toThrow()
    expect(() => wzAddBody({ ...ok, date: '06.11.2026' })).toThrow()
    expect(() => wzAddBody({ ...ok, lines: [] })).toThrow()
    expect(() => wzAddBody({ ...ok, lines: [{ wfirmaGoodId: '1', count: 0 }] })).toThrow()
  })

  it('zdolność wz tylko z adapterem zapisu WZ; deklaracja poprawna', () => {
    expect(umieWydacWz(dostawcaWfirmy())).toBe(false)
    const d = dostawcaWfirmy({ wz: { issueWz: async () => ({ kind: 'OK', docId: '1' }), findWzByExternal: async () => [] } })
    expect(umieWydacWz(d)).toBe(true)
    expect(d.zdolnosci).toContain('wz')
    expect(problemyDostawcy(d)).toEqual([])
    expect(problemyDostawcy({ program: 'x.v1', nazwa: 'X', zdolnosci: ['wz'] })).toContain('zdolność wz bez metod wydajWz i odszukajWz')
  })
})
