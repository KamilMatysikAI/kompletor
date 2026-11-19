// Program do faktur firmy z bazy: ustawienia firmy + źródło stanu magazynu (firma bez pola `program`
// i bez magazynu wFirmy = `brak`). Klient firmy (RLS). Dla ekranów i hosta; rdzeń liczy to samo w `faktyPrzejscia`.
import type { PrismaClient } from '@prisma/client'
import { DEFAULT_WAREHOUSE } from '../rdzen/stan'
import { zrodloStanu } from '../rdzen/zrodlo-stanu'
import { parseUstawieniaDokumentow, type UstawieniaDokumentow } from './ustawienia'

export async function ustawieniaDokumentowFirmy(db: PrismaClient, warehouseId = DEFAULT_WAREHOUSE): Promise<UstawieniaDokumentow> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  return parseUstawieniaDokumentow(org?.settings ?? null, { maWfirme: (await zrodloStanu(db, warehouseId)) === 'WFIRMA' })
}
