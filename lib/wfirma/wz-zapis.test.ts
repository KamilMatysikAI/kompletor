// zapis WZ w wFirmie — klient zapisu (klasyfikacja wyniku, strażnik ścieżki) i `WzWfirmaZapis` (treść
// z `wzAddBody`, odszukanie po `id_external` z filtrem po odpowiedzi). Wyłącznie atrapa `fetch`, zero połączeń z siecią.
import { describe, expect, it } from 'vitest'
import { WfirmaZapis, wzZOdpowiedzi } from '../zrodla/wfirma-zapis'
import { WzWfirmaZapis } from './wz-zapis'

const KEYS = { accessKey: 'a', secretKey: 's', appKey: 'p', companyId: '1' }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

function klient(odp: () => Response | Promise<Response>) {
  const wywolania: { sciezka: string; body: unknown }[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    wywolania.push({ sciezka: new URL(url).pathname, body: JSON.parse(String(init?.body ?? '{}')) })
    return odp()
  }
  return { k: new WfirmaZapis(KEYS, fetchImpl, 0), wywolania }
}

describe('WfirmaZapis.wystawWz', () => {
  it('strażnik: zapis WZ dozwolony tylko jako dodanie dokumentu magazynowego', () => {
    expect(WfirmaZapis.allowed('warehouse_documents/add')).toBe(true)
    for (const p of ['warehouse_documents/edit/1', 'warehouse_documents/delete/1', 'warehouse_documents/add/1', 'warehouse_documents/find']) expect(WfirmaZapis.allowed(p)).toBe(false)
  })

  it('OK z id i numerem, jedno żądanie', async () => {
    const { k, wywolania } = klient(() => json({ status: { code: 'OK' }, warehouse_documents: { '0': { warehouse_document: { id: '881', fullnumber: 'WZ 3/8/11/26' } } } }))
    expect(await k.wystawWz({ warehouse_documents: {} })).toEqual({ kind: 'OK', id: '881', numer: 'WZ 3/8/11/26' })
    expect(wywolania.map((w) => w.sciezka)).toEqual(['/warehouse_documents/add'])
  })

  it.each([
    ['błąd sieci', () => Promise.reject(new Error('ECONNRESET')), 'TIMEOUT'],
    ['HTTP 503', () => json({}, 503), 'TIMEOUT'],
    ['OK bez id', () => json({ status: { code: 'OK' }, warehouse_documents: { parameters: {} } }), 'TIMEOUT'],
    ['SNAPSHOT LOCK', () => json({ status: { code: 'SNAPSHOT LOCK' } }), 'TIMEOUT'],
    ['HTTP 429', () => json({}, 429), 'LIMIT'],
    ['TOTAL REQUESTS LIMIT EXCEEDED', () => json({ status: { code: 'TOTAL REQUESTS LIMIT EXCEEDED' } }), 'LIMIT'],
    ['ERROR z polem', () => json({ status: { code: 'ERROR' }, warehouse_documents: { '0': { warehouse_document: { errors: { '0': { error: { field: 'good', message: 'Brak towaru' } } } } } } }), 'ERROR'],
    ['HTTP 400', () => json({ status: { code: 'INPUT ERROR' } }, 400), 'ERROR'],
  ] as const)('%s → %s, bez ponowienia', async (n, odp, rodzaj) => {
    const { k, wywolania } = klient(odp as () => Response)
    const r = await k.wystawWz({ warehouse_documents: {} })
    expect(r.kind).toBe(rodzaj)
    expect(wywolania).toHaveLength(1)
    if (r.kind === 'ERROR' && n === 'ERROR z polem') expect(r.message).toContain('good: Brak towaru')
  })

  it('wzZOdpowiedzi: id 0 albo brak = null', () => {
    expect(wzZOdpowiedzi({ warehouse_documents: { '0': { warehouse_document: { id: 0 } } } })).toBeNull()
    expect(wzZOdpowiedzi({ warehouse_documents: { '0': { warehouse_document: { id: 7, fullnumber: '' } } } })).toEqual({ id: '7', numer: null })
  })
})

describe('WzWfirmaZapis', () => {
  const wynikOk = { kind: 'OK' as const, id: '881', numer: 'WZ 3/8/11/26' }

  it('treść z wzAddBody: typ WZ, data dnia w Warszawie, magazyn, id_external, pozycje; wynik OK z numerem', async () => {
    const tresci: Record<string, unknown>[] = []
    const w = new WzWfirmaZapis({ call: async () => ({}) as never }, { wystawWz: async (t) => (tresci.push(t), wynikOk) }, () => new Date('2026-11-08T23:30:00Z'))
    expect(await w.issueWz({ idExternal: 'wz/o1/1', warehouseId: '999001', lines: [{ wfirmaGoodId: '700', count: 2 }] })).toEqual({ kind: 'OK', docId: '881', number: 'WZ 3/8/11/26' })
    expect(tresci[0]).toEqual({
      warehouse_documents: { warehouse_document: { type: 'WZ', date: '2026-11-09', id_external: 'wz/o1/1', warehouse: { id: 999001 }, warehouse_document_contents: { '0': { warehouse_document_content: { good: { id: 700 }, count: 2 } } } } },
    })
  })

  it('zła pozycja albo magazyn: ERROR bez żądania do wFirmy; TIMEOUT i LIMIT przechodzą dalej', async () => {
    let wyslane = 0
    type Odp = { kind: 'TIMEOUT'; message: string } | { kind: 'LIMIT'; message: string; retryAfterMs: number }
    let nast: Odp = { kind: 'TIMEOUT', message: 'x' } as Odp
    const w = new WzWfirmaZapis({ call: async () => ({}) as never }, { wystawWz: async () => (wyslane++, nast) })
    expect((await w.issueWz({ idExternal: 'wz/o1/1', warehouseId: 'abc', lines: [{ wfirmaGoodId: '700', count: 1 }] })).kind).toBe('ERROR')
    expect((await w.issueWz({ idExternal: 'wz/o1/1', warehouseId: '1', lines: [{ wfirmaGoodId: '700', count: 0 }] })).kind).toBe('ERROR')
    expect(wyslane).toBe(0)
    expect(await w.issueWz({ idExternal: 'wz/o1/1', warehouseId: '1', lines: [{ wfirmaGoodId: '700', count: 1 }] })).toEqual({ kind: 'TIMEOUT' })
    nast = { kind: 'LIMIT', message: 'limit', retryAfterMs: 5000 }
    expect(await w.issueWz({ idExternal: 'wz/o1/1', warehouseId: '1', lines: [{ wfirmaGoodId: '700', count: 1 }] })).toEqual({ kind: 'LIMIT', message: 'limit', retryAfterMs: 5000 })
  })

  it('odszukanie: find z warunkiem id_external, tylko dokumenty z dokładnie tą referencją (wFirma ignorująca warunek oddaje obce)', async () => {
    const zapytania: [string, unknown][] = []
    const wf = {
      call: async (p: string, b: unknown) => {
        zapytania.push([p, b])
        return {
          warehouse_documents: {
            '0': { warehouse_document: { id: '10', id_external: 'wz/o1/1', fullnumber: 'WZ 1/8/11/26' } },
            '1': { warehouse_document: { id: '11', id_external: 'wz/o2/1', fullnumber: 'WZ 2/8/11/26' } },
            '2': { warehouse_document: { id: '12', fullnumber: 'WZ 3/8/11/26' } },
            parameters: {},
          },
        } as never
      },
    }
    const w = new WzWfirmaZapis(wf, { wystawWz: async () => wynikOk })
    expect(await w.findWzByExternal('wz/o1/1')).toEqual([{ docId: '10', idExternal: 'wz/o1/1', number: 'WZ 1/8/11/26' }])
    expect(zapytania[0]![0]).toBe('warehouse_documents/find')
    expect(JSON.stringify(zapytania[0]![1])).toContain('"field":"id_external","operator":"eq","value":"wz/o1/1"')
  })
})
