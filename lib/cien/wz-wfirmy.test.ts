// odczyt WZ z wFirmy na nagranych odpowiedziach (tests/nagrania/wfirma-wz, bez danych nabywcy).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { wfirmaItems } from '../zrodla/wfirma'
import { parseWz, warsawStamp, WfirmaWzZrodlo } from './wz-wfirmy'

const NAGRANIA = path.join(__dirname, '..', '..', 'tests', 'nagrania', 'wfirma-wz')
const nagranie = (f: string) => JSON.parse(readFileSync(path.join(NAGRANIA, f), 'utf8')) as Record<string, unknown>
const pierwszy = (f: string) => wfirmaItems<Record<string, unknown>>(nagranie(f)['warehouse_documents'], 'warehouse_document')[0]!

describe('WZ z wFirmy: parsowanie nagranych odpowiedzi', () => {
  it('WZ 142/4/11/26 (90002): numer, data, faktura, magazyn i trzy pozycje po 1 szt.', () => {
    expect(parseWz(pierwszy('wz-142-4-11-26.json'))).toEqual({
      docId: '900000070',
      numer: 'WZ 142/4/11/26',
      data: '2026-11-04',
      utworzono: '2026-11-04 12:51:24',
      magazyn: '900014',
      invoiceId: '900000217',
      opis: '',
      pozycje: [
        { wfirmaGoodId: '90000077', count: 1 },
        { wfirmaGoodId: '90000049', count: 1 },
        { wfirmaGoodId: '90000056', count: 1 },
      ],
    })
  })

  it('WZ 130/4/11/26 i 154/4/11/26 (90001): po 1 szt. towaru 90000021 do faktur SD 130/4/11/26 i SD 154/4/11/26', () => {
    const a = parseWz(pierwszy('wz-130-4-11-26.json'))!
    const b = parseWz(pierwszy('wz-154-4-11-26.json'))!
    expect(a.pozycje.find((l) => l.wfirmaGoodId === '90000021')).toEqual({ wfirmaGoodId: '90000021', count: 1 })
    expect(b.pozycje).toEqual([{ wfirmaGoodId: '90000021', count: 1 }])
    expect([a.invoiceId, b.invoiceId]).toEqual(['900000189', '900000252'])
  })

  it('WZ do faktury SD 127/26/10/26 nie ma towaru 90004 (90000175)', () => {
    const d = parseWz(pierwszy('wz-do-faktury-sd-127-26-10-26.json'))!
    expect(d.numer).toBe('WZ 127/26/10/26')
    expect(d.pozycje.map((l) => l.wfirmaGoodId)).not.toContain('90000175')
  })

  it('pozycja bez towaru albo ilości to błąd (nie 0); dokument bez numeru → null', () => {
    const raw = pierwszy('wz-154-4-11-26.json')
    const bad = JSON.parse(JSON.stringify(raw)) as Record<string, any>
    bad['warehouse_document_contents']['0']['warehouse_document_content']['count'] = ''
    expect(() => parseWz(bad)).toThrow(/nieczytelna pozycja WZ 154\/4\/11\/26/)
    expect(parseWz({ ...raw, fullnumber: '' })).toBeNull()
  })

  it('czas założenia z wFirmy (Warszawa) → UTC, także po zmianie czasu', () => {
    expect(warsawStamp('2026-11-04 13:29:32').toISOString()).toBe('2026-11-04T12:29:32.000Z')
    expect(warsawStamp('2026-10-24 10:00:00').toISOString()).toBe('2026-10-24T08:00:00.000Z')
  })
})

describe('WZ z wFirmy: zapytania (tylko odczyt)', () => {
  it('wzOd: warunek typ WZ i data od, strony po 100 do krótszej, magazyn filtrowany po odpowiedzi; numery faktur z listy dni', async () => {
    const calls: { path: string; body: any }[] = []
    const lista = nagranie('wz-lista-od-2026-10-24-wybrane.json')
    const faktury = nagranie('faktury-2026-11-04.json')
    const wf = {
      call: async <T,>(p: string, body: unknown): Promise<T> => {
        calls.push({ path: p, body })
        if (p === 'warehouse_documents/find') return lista as T
        if (p === 'invoices/find') return faktury as T
        throw new Error(p)
      },
    }
    const z = new WfirmaWzZrodlo(wf)
    const r = await z.wzOd('2026-10-24', '900014')
    expect(r.complete).toBe(true)
    expect(r.docs.map((d) => d.numer)).toContain('WZ 112/27/10/26')
    expect(r.docs).toHaveLength(10)
    expect(calls[0]!.body.warehouse_documents.parameters).toMatchObject({ conditions: { and: [{ condition: { field: 'type', operator: 'eq', value: 'WZ' } }, { condition: { field: 'date', operator: 'ge', value: '2026-10-24' } }] }, limit: 100, page: 1 })
    expect((await z.wzOd('2026-10-24', '1')).docs).toHaveLength(0)
    const n = await z.numeryFaktur('2026-11-04', '2026-11-04')
    expect(n.get('900000217')).toBe('SD 142/4/11/26')
    expect(n.get('900000252')).toBe('SD 154/4/11/26')
    expect(calls.map((c) => c.path).every((p) => /\/(find|get\/\d+)$/.test(p))).toBe(true)
  })
})
