// Korekta stanu z panelu dla firmy bez wFirmy. Firma z wFirmą jej nie ma: tam stan fizyczny to lustro
// magazynu wFirmy (lib/rdzen/lustro.ts) i każda zmiana idzie dokumentem w wFirmie. Bez wFirmy nikt inny stanu nie
// prowadzi, więc człowiek podaje stan po przeliczeniu półki i powód.
// Zapis jak w rdzeniu: blokada wiersza Stock (StockBook, kolejność productId), ruch OWN_CORRECTION w StockMovement,
// a `flush` dokłada AVAILABLE_CHANGED do outboxu (propagacja do kanałów, w cieniu tylko „wysłałbym”). Wzrost stanu
// budzi też przydział braków (ALLOCATE). `wfirmaCount` zmienia się o tę samą różnicę, żeby zachować niezmiennik
// physical = wfirmaCount + pendingDelta (lib/rdzen/niezmienniki.ts) — w firmie bez wFirmy to po prostu stan bazowy.
import type { PrismaClient } from '@prisma/client'
import { DEFAULT_WAREHOUSE, outbox, runTx, StockBook } from '../rdzen/stan'
import { firmaMaWfirme } from './firma'
import { KontoError } from './konta'
import { uniewaznijProdukty } from './rejestr-synchronizacji'

export interface Korekta {
  productId: string
  /** Stan fizyczny po korekcie (jednostka bazowa produktu: sztuki albo gramy). */
  physicalAfter: number
  reason: string
}

export async function korektaStanu(db: PrismaClient, k: Korekta, opts: { actorId: string; now?: Date; warehouseId?: string }): Promise<{ delta: number }> {
  const wh = opts.warehouseId ?? DEFAULT_WAREHOUSE
  const now = opts.now ?? new Date()
  if (await firmaMaWfirme(db, wh)) throw new KontoError('Firma z wFirmą koryguje stan dokumentem w wFirmie: tu stan to lustro wFirmy')
  if (!Number.isInteger(k.physicalAfter) || k.physicalAfter < 0 || k.physicalAfter > 10_000_000) throw new KontoError('Stan po korekcie musi być liczbą całkowitą od 0')
  const reason = k.reason.trim().replace(/\s+/g, ' ')
  if (reason.length < 3) throw new KontoError('Podaj powód korekty')
  if (reason.length > 300) throw new KontoError('Powód może mieć najwyżej 300 znaków')
  const p = await db.product.findFirst({ where: { id: k.productId }, select: { id: true, kind: true } })
  if (!p) throw new KontoError('Nie ma takiego produktu')
  if (p.kind !== 'STOCKED') throw new KontoError('Stan koryguje się na towarze, nie na zestawie ani produkcie bez stanu')
  const wynik = await runTx(db, async (tx) => {
    // produkt bez wiersza stanu (np. dodany ręcznie): wiersz z zerem, korekta niżej ustawia ilość
    await tx.stock.upsert({
      where: { productId_warehouseId: { productId: p.id, warehouseId: wh } },
      create: { productId: p.id, warehouseId: wh, wfirmaCount: 0, wfirmaReadAt: now, physical: 0 },
      update: {},
    })
    const book = await StockBook.lock(tx, wh, [p.id])
    const row = book.get(p.id)!
    const delta = k.physicalAfter - row.physical
    if (delta === 0) return { delta }
    book.change(p.id, { physical: delta })
    const after = book.get(p.id)!
    book.set(p.id, {
      wfirmaCount: row.wfirmaCount + delta,
      // niezmiennik 5: rezerwacje ponad stan tylko z datą nadmiaru (lista „Nadmiar rezerwacji”)
      overcommitSince: after.reserved > after.physical ? (after.overcommitSince ?? now) : null,
    })
    await tx.stockMovement.create({ data: { productId: p.id, warehouseId: wh, deltaPhysical: delta, source: 'OWN_CORRECTION', reason: `korekta stanu w panelu: ${reason}`, actorId: opts.actorId } })
    await book.flush(tx, now)
    if (delta > 0) await outbox(tx, 'ALLOCATE', p.id, now)
    return { delta }
  })
  // po korekcie oferty produktu (i zestawów z nim) idą do kanałów bez pomijania „bez zmian”. Poza transakcją
  // błąd rejestru w transakcji wycofałby korektę; tu ląduje tylko w logu (przy delcie ≠ 0 i tak zmienia
  // się wysyłana ilość, czyli skrót, więc kasowanie ma znaczenie tylko dla korekty bez zmiany ilości)
  await uniewaznijProdukty(db, [p.id]).catch((e) => console.warn(`[rejestr-synchronizacji] produkt ${p.id}: kasowanie skrótów po korekcie stanu nieudane (${e instanceof Error ? e.message : String(e)})`))
  return wynik
}
