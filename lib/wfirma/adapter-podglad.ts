// `FakturyWfirma` w trybie podglądu: `issue` nie dotyka sieci i odmawia, `findByPrefix` i `readWz` tylko czytają
// przez `WfirmaReadOnly` (strażnik `assertWfirmaReadOnly`). Prawdziwy adapter zapisu powstaje po osobnym GO.
// Adapter nie jest podpięty do workera: `runWfirmaQueue` z nim zamieniłby spakowane zamówienia w błąd faktury.
import type { PrismaClient } from '@prisma/client'
import { WfirmaWzReader, wzByProduct } from '../cien/faktury-bl'
import { type FakturyWfirma, type FoundInvoice, type IssueResult, WfirmaLimitError } from '../rdzen/rozchod'
import { SourceError } from '../zrodla/http'
import { type WfirmaReadOnly, wfirmaItems } from '../zrodla/wfirma'

export const TRYB_PODGLADU = 'tryb podglądu: faktura nie jest wystawiana w wFirmie'

/** Limit wFirmy z klienta odczytu → kontrakt rdzenia: `WfirmaLimitError` wstrzymuje kolejkę firmy (3.4). */
async function zLimitem<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof SourceError && !e.retryable && /limit/i.test(e.message)) throw new WfirmaLimitError(e.message)
    throw e
  }
}

export class FakturyPodglad implements FakturyWfirma {
  private readonly wz: WfirmaWzReader

  constructor(
    private readonly wf: Pick<WfirmaReadOnly, 'call'>,
    private readonly db: Pick<PrismaClient, 'product'>,
  ) {
    this.wz = new WfirmaWzReader(wf)
  }

  async issue(_req?: Parameters<FakturyWfirma['issue']>[0]): Promise<IssueResult> {
    void _req
    return { kind: 'ERROR', message: TRYB_PODGLADU }
  }

  async findByPrefix(prefix: string): Promise<FoundInvoice[]> {
    const body = { invoices: { parameters: { conditions: { condition: { field: 'id_external', operator: 'like', value: `${prefix}%` } }, limit: 25 } } }
    const r = await zLimitem(() => this.wf.call<Record<string, unknown>>('invoices/find', body))
    const out: FoundInvoice[] = []
    for (const i of wfirmaItems<{ id?: unknown; id_external?: unknown; fullnumber?: unknown }>(r['invoices'], 'invoice')) {
      const docId = String(i.id ?? '')
      // numer faktury, gdy wFirma go oddała (timeout rozstrzygnięty find ma numer na karcie)
      const number = typeof i.fullnumber === 'string' && i.fullnumber.trim() ? i.fullnumber.trim() : null
      if (docId) out.push({ docId, idExternal: String(i.id_external ?? ''), wz: await this.readWz(docId), ...(number ? { number } : {}) })
    }
    return out
  }

  async readWz(docId: string): Promise<Record<string, number | null>> {
    const lines = await zLimitem(() => this.wz.wzForInvoiceId(docId))
    return lines ? wzByProduct(this.db, lines) : {}
  }
}
