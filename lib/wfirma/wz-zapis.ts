// `WzWfirma` z ZAPISEM w wFirmie — WZ bez faktury dla zamówienia wysłanego bez faktury przy stanie
// prowadzonym w wFirmie (lib/rdzen/wz-wydanie.ts). Sam zapis idzie wyłącznie przez klienta `WfirmaZapis`
// (lib/zrodla/wfirma-zapis.ts); odszukanie po `id_external` przez `WfirmaReadOnly` (tylko `find`). W tym module nie ma
// żadnej ścieżki zapisu API.
//
// Odszukanie: warunek `id_external` i dodatkowo filtr po odpowiedzi (host bierze tylko dokument z dokładnie tą
// referencją). Pole `id_external` dokumentu magazynowego nie występuje w nagraniach
// (tests/nagrania/wfirma-wz), więc host po niejasnym wyniku wystawienia NIE wystawia drugi raz na ślepo
// (alert `WZ_NIEWIADOMA`, lib/rdzen/wz-wydanie.ts). Pierwszy prawdziwy zapis tylko po GO właściciela firmy.
import { toWarsaw } from '../rdzen/kalendarz'
import { type WfirmaReadOnly, wfirmaItems } from '../zrodla/wfirma'
import type { WynikWystawienia } from '../zrodla/wfirma-zapis'
import { type WzIssueResult, type WzWfirma, wzAddBody, type WzLineWfirma } from './wz'

export interface ZapisWz {
  wystawWz(tresc: Record<string, unknown>): Promise<WynikWystawienia>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && v !== 0 ? String(v) : null)

export class WzWfirmaZapis implements WzWfirma {
  constructor(
    private readonly wf: Pick<WfirmaReadOnly, 'call'>,
    private readonly zapis: ZapisWz,
    private readonly zegar: () => Date = () => new Date(),
  ) {}

  async issueWz(r: { idExternal: string; warehouseId: string; lines: WzLineWfirma[] }): Promise<WzIssueResult> {
    let tresc: Record<string, unknown>
    try {
      tresc = wzAddBody({ idExternal: r.idExternal, warehouseId: r.warehouseId, date: toWarsaw(this.zegar()).day, lines: r.lines })
    } catch (e) {
      // treść nie dała się złożyć (zła pozycja, magazyn): nic nie poszło do wFirmy, błąd jednoznaczny
      return { kind: 'ERROR', message: e instanceof Error ? e.message : String(e) }
    }
    const w = await this.zapis.wystawWz(tresc)
    if (w.kind === 'OK') return { kind: 'OK', docId: w.id, number: w.numer }
    if (w.kind === 'ERROR') return { kind: 'ERROR', message: w.message }
    if (w.kind === 'LIMIT') return { kind: 'LIMIT', message: w.message, ...(w.retryAfterMs ? { retryAfterMs: w.retryAfterMs } : {}) }
    return { kind: 'TIMEOUT' }
  }

  async findWzByExternal(idExternal: string): Promise<{ docId: string; idExternal: string; number?: string | null }[]> {
    const r = await this.wf.call<Record<string, unknown>>('warehouse_documents/find', {
      warehouse_documents: { parameters: { conditions: { condition: { field: 'id_external', operator: 'eq', value: idExternal } }, limit: 20 } },
    })
    const out: { docId: string; idExternal: string; number: string | null }[] = []
    for (const d of wfirmaItems<Record<string, unknown>>(r['warehouse_documents'], 'warehouse_document')) {
      const docId = str(d['id'])
      const ext = str(d['id_external'])
      if (!docId || ext !== idExternal) continue
      out.push({ docId, idExternal: ext, number: str(d['fullnumber']) })
    }
    return out
  }
}
