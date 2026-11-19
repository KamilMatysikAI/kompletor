// Lustro stanu wFirmy (spec 2.2). Odczyt niczego nie wnioskuje: podmienia `wfirmaCount`, potwierdza nasze
// ruchy wyłącznie przyczynowo (nasz zegar) i przelicza `physical`. Nie przenosi rezerwacji, nie przypisuje
// spadków do zamówień. Wzrost → `allocate` w outboxie tej samej transakcji; spadek poniżej `reserved` →
// `overcommitSince` (nadmiar rozstrzyga człowiek, 4.4).
import { alert, type Db, DEFAULT_WAREHOUSE, outbox, runTx, StockBook, byProductId } from './stan'

export interface StockRead {
  productId: string
  countBase: number // count z wFirmy przeliczony na jednostkę bazową (szt. albo g)
  /** NASZ zegar: chwila wysłania żądania (strony goods/find albo goods/get), z którego pochodzi count. */
  requestSentAt: Date
}

export type ReadOutcome = 'ZAPISANY' | 'ODRZUCONY_STARSZY' | 'BRAK_PRODUKTU'

export interface ReadResult {
  outcome: ReadOutcome
  confirmed: number
  physicalBefore?: number
  physicalAfter?: number
  overcommit?: boolean
  listedOvercommit?: boolean
}

const OVERCOMMIT_LIST_AFTER_MS = 30 * 60_000

export async function applyStockRead(db: Db, read: StockRead, ctx: { now?: Date; warehouseId?: string; actorId?: string } = {}): Promise<ReadResult> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  if (!Number.isInteger(read.countBase) || read.countBase < 0) throw new Error(`zły stan z wFirmy dla ${read.productId}: ${read.countBase}`)
  return runTx(db, async (tx) => {
    const product = await tx.product.findUnique({ where: { id: read.productId }, select: { kind: true } })
    if (!product || product.kind !== 'STOCKED') return { outcome: 'BRAK_PRODUKTU', confirmed: 0 }
    // nowy produkt bez wiersza Stock: wiersz startowy (bez zmiany cudzych wierszy), potem zwykła ścieżka
    if (!(await tx.stock.findUnique({ where: { productId_warehouseId: { productId: read.productId, warehouseId: wh } }, select: { version: true } })))
      await tx.$executeRaw`INSERT INTO "Stock" ("productId", "warehouseId", "wfirmaCount", "wfirmaReadAt", physical)
      VALUES (${read.productId}, ${wh}, 0, to_timestamp(0), 0) ON CONFLICT DO NOTHING`
    const book = await StockBook.lock(tx, wh, [read.productId])
    const s = book.get(read.productId)!
    if (read.requestSentAt.getTime() < s.wfirmaReadAt.getTime()) return { outcome: 'ODRZUCONY_STARSZY', confirmed: 0 }
    // Potwierdzanie przyczynowe: APPLIED z pełnym WZ i effectiveAt < requestSentAt na pewno jest w odczycie.
    const applied = await tx.pendingMovement.findMany({
      where: { productId: read.productId, warehouseId: wh, state: 'APPLIED', effectiveAt: { lt: read.requestSentAt } },
    })
    const toConfirm = applied.filter((m) => (m.wzQty ?? 0) >= -m.delta)
    if (toConfirm.length)
      await tx.pendingMovement.updateMany({ where: { id: { in: toConfirm.map((m) => m.id) } }, data: { state: 'CONFIRMED', confirmedAt: now } })
    const agg = await tx.pendingMovement.aggregate({
      where: { productId: read.productId, warehouseId: wh, state: { in: ['IN_FLIGHT', 'APPLIED', 'MANUAL'] } },
      _sum: { delta: true },
    })
    const pending = agg._sum.delta ?? 0
    const before = s.physical
    const after = read.countBase + pending
    const patch: Parameters<StockBook['set']>[1] = { wfirmaCount: read.countBase, wfirmaReadAt: read.requestSentAt, pendingDelta: pending, physical: after }
    if (after !== before) {
      await tx.stockMovement.create({
        data: {
          productId: read.productId,
          warehouseId: wh,
          deltaPhysical: after - before,
          source: 'WFIRMA_SYNC',
          reason: 'zmiana w wFirmie (PZ, kompletacja, korekta, faktura spoza systemu) albo potwierdzenie naszego ruchu',
          actorId: ctx.actorId ?? 'system:odczyt-wfirmy',
        },
      })
    }
    if (after > before) {
      patch.allocationPendingSince = now // wzrost: przydział „brakuje” przed wysłaniem wzrostu na kanały
      await outbox(tx, 'ALLOCATE', read.productId, now)
    }
    let listed = false
    if (s.reserved > after) {
      if (!s.overcommitSince) patch.overcommitSince = read.requestSentAt
      // stan ujemny (ruch biura) bez rezerwacji ponad zero: znacznik zostaje (niezmiennik 5), ale nie ma zamówień do
      // „brakuje”, więc bez listy „Nadmiar rezerwacji” i bez alertu
      else if (s.reserved <= Math.max(0, after)) {
        if (s.overcommitListedAt) patch.overcommitListedAt = null
      } else if (!s.overcommitListedAt && read.requestSentAt.getTime() - s.overcommitSince.getTime() >= OVERCOMMIT_LIST_AFTER_MS) {
        // drugi odczyt ≥ 30 min później musi potwierdzić wszystkie ruchy istniejące w chwili pierwszego
        const olderUnconfirmed = await tx.pendingMovement.count({
          where: { productId: read.productId, warehouseId: wh, state: { in: ['IN_FLIGHT', 'APPLIED'] }, sentAt: { lte: s.overcommitSince } },
        })
        if (olderUnconfirmed === 0) {
          patch.overcommitListedAt = now
          listed = true
          await alert(tx, 'NADMIAR_REZERWACJI', read.productId, `Nadmiar rezerwacji: zarezerwowane ${s.reserved}, na stanie ${after} — wybierz zamówienia do „brakuje”`, `nadmiar:${read.productId}:${s.overcommitSince.toISOString()}`)
        }
      }
    } else {
      patch.overcommitSince = null
      patch.overcommitListedAt = null
    }
    book.set(read.productId, patch)
    await book.flush(tx, now)
    return { outcome: 'ZAPISANY', confirmed: toConfirm.length, physicalBefore: before, physicalAfter: after, overcommit: s.reserved > after, listedOvercommit: listed }
  })
}

/**
 * Zapis strony pełnego odczytu: jedna krótka transakcja na produkt, w kolejności productId (2.2 pkt 4),
 * nigdy w kolejności strony wFirmy. Błąd jednego produktu nie zatrzymuje strony.
 */
export async function applyStockPage(
  db: Db,
  reads: { productId: string; countBase: number }[],
  requestSentAt: Date,
  ctx: { now?: Date; warehouseId?: string } = {},
): Promise<{ ok: number; rejected: number; errors: { productId: string; message: string }[] }> {
  const out = { ok: 0, rejected: 0, errors: [] as { productId: string; message: string }[] }
  for (const r of [...reads].sort((a, b) => byProductId(a.productId, b.productId))) {
    try {
      const res = await applyStockRead(db, { ...r, requestSentAt }, ctx)
      if (res.outcome === 'ZAPISANY') out.ok++
      else out.rejected++
    } catch (e) {
      out.errors.push({ productId: r.productId, message: (e as Error).message.slice(0, 500) })
    }
  }
  return out
}
