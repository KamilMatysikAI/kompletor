// adapter podglądu nie zapisuje: `issue` bez sieci, odczyty tylko */find przez strażnika. Atrapy.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WfirmaLimitError } from '../rdzen/rozchod'
import { SourceError } from '../zrodla/http'
import { assertWfirmaReadOnly } from '../zrodla/wfirma'
import { FakturyPodglad, TRYB_PODGLADU } from './adapter-podglad'

const db = { product: { findMany: async () => [{ id: 'p1', wfirmaGoodId: '100', unit: 'SZT' }] } } as never

function atrapa(onCall?: (p: string) => void) {
  const sciezki: string[] = []
  const wf = {
    call: async <T,>(p: string): Promise<T> => {
      assertWfirmaReadOnly(p)
      sciezki.push(p)
      onCall?.(p)
      if (p === 'invoices/find') return { invoices: { '0': { invoice: { id: '55', id_external: 'o1/1/1' } }, parameters: {} } } as T
      return { warehouse_documents: { '0': { warehouse_document: { warehouse_document_contents: { '0': { warehouse_document_content: { good: { id: '100' }, count: '2.0000' } } } } } } } as T
    },
  }
  return { wf, sciezki }
}

describe('FakturyPodglad', () => {
  it('issue: bez sieci, odmowa z jasnym komunikatem', async () => {
    const { wf, sciezki } = atrapa()
    expect(await new FakturyPodglad(wf, db).issue()).toEqual({ kind: 'ERROR', message: TRYB_PODGLADU })
    expect(sciezki).toEqual([])
  })

  it('findByPrefix i readWz tylko przez odczyt', async () => {
    const { wf, sciezki } = atrapa()
    expect(await new FakturyPodglad(wf, db).findByPrefix('o1/1/')).toEqual([{ docId: '55', idExternal: 'o1/1/1', wz: { p1: 2 } }])
    expect(sciezki).toEqual(['invoices/find', 'warehouse_documents/find'])
  })

  it('limit wFirmy z odczytu = WfirmaLimitError (kolejka firmy się wstrzymuje), inny błąd przechodzi', async () => {
    const limit = new FakturyPodglad(atrapa(() => { throw new SourceError('wFirma invoices/find: TOTAL REQUESTS LIMIT EXCEEDED — limit, bez ponawiania', false) }).wf, db)
    await expect(limit.findByPrefix('o1/1/')).rejects.toBeInstanceOf(WfirmaLimitError)
    const inny = new FakturyPodglad(atrapa(() => { throw new SourceError('wFirma invoices/find: ERROR', false) }).wf, db)
    await expect(inny.findByPrefix('o1/1/')).rejects.toBeInstanceOf(SourceError)
  })

  it('strażnik w źródłach: żadnego wywołania zapisu w lib/wfirma i komendzie, strażnik odczytu niepoluzowany', () => {
    const dir = path.resolve('lib/wfirma')
    const pliki = [...readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => path.join(dir, f)), path.resolve('scripts/faktury-podglad.ts')]
    for (const f of pliki) expect(readFileSync(f, 'utf8'), f).not.toMatch(/['"`][a-z_]+\/(add|edit|delete|send|fiscalize)/)
    for (const p of ['invoices/add', 'invoices/edit/1', 'invoices/delete/1', 'invoices/send/1', 'payments/add']) expect(() => assertWfirmaReadOnly(p)).toThrow()
  })
})
