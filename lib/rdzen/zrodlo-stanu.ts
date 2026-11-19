// Źródło stanu magazynu: kto prowadzi stan fizyczny.
//   WFIRMA    — lustro magazynu wFirmy: rozchód idzie fakturą z WZ, potwierdza go odczyt wFirmy (dawna ścieżka, bez zmian);
//   KOMPLETOR — stan prowadzi Kompletor: towar schodzi ze stanu przy „Do wysyłki / Do odbioru” (ruch OWN_DISPATCH),
//               dokument sprzedaży to osobny tor (lib/dokumenty), korekta stanu z panelu (lib/kanaly/korekta-stanu.ts).
// Kolumna `Warehouse.stockSource` może być pusta (magazyn założony starym kodem albo testem): wtedy źródło liczy się
// dzisiejszą regułą — magazyn wskazuje magazyn wFirmy = WFIRMA, inaczej KOMPLETOR. Jedna funkcja dla rdzenia i ekranów.
import type { StockSource } from '@prisma/client'
import { type Db, DEFAULT_WAREHOUSE, type Tx } from './stan'

export type ZrodloStanu = StockSource

export const ZRODLA_STANU: readonly ZrodloStanu[] = ['KOMPLETOR', 'WFIRMA']

/** Czysta reguła: jawne pole wygrywa, brak pola = wywnioskowane z magazynu wFirmy (zgodność wstecz). */
export function zrodloZMagazynu(w: { stockSource?: StockSource | null; wfirmaWarehouseId?: string | null } | null | undefined): ZrodloStanu {
  if (w?.stockSource) return w.stockSource
  return w?.wfirmaWarehouseId ? 'WFIRMA' : 'KOMPLETOR'
}

/** Źródło stanu magazynu firmy (klient firmy, RLS). Brak magazynu = KOMPLETOR (nic nie prowadzi stanu za nas). */
export async function zrodloStanu(db: Db | Tx, warehouseId = DEFAULT_WAREHOUSE): Promise<ZrodloStanu> {
  const w = await db.warehouse.findFirst({ where: { id: warehouseId }, select: { stockSource: true, wfirmaWarehouseId: true } })
  return zrodloZMagazynu(w)
}

export const ETYKIETA_ZRODLA: Record<ZrodloStanu, string> = {
  KOMPLETOR: 'Kompletor prowadzi stan sam',
  WFIRMA: 'Lustro magazynu wFirmy',
}
