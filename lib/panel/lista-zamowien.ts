// Pozycje zamówień do listy „Zamówienia” (uwaga właściciela 28.10: „ten widok jest ultra nieczytelny”).
// Osobno od `ordersPage` (lib/panel/dane.ts), żeby nie ruszać wspólnego modelu wiersza: lista pokazuje przy KAŻDEJ
// pozycji, czy brakuje do niej towaru (otwarte braki z `Shortage.orderLineId`), zamiast ogólnej plakietki
// „brakuje: N poz.” przy zamówieniu.
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { OPEN_SHORTAGE, productInfo, ZGLOSZONY_W_CIENIU } from './dane'
import { glowneZdjecia } from '@/lib/produkty/zdjecia'
import { buildListLines, type ListLine } from './lista-zamowien-linie'

export { buildListLines, isMissing, type ListLine } from './lista-zamowien-linie'

/** Pozycje (bez usuniętych w kanale) dla zamówień z jednej strony listy, w kolejności z kanału. */
export async function orderListLines(db: PrismaClient, orderIds: string[]): Promise<Map<string, ListLine[]>> {
  organizationIdOf(db)
  if (!orderIds.length) return new Map()
  const rows = await db.orderLine.findMany({
    where: { orderId: { in: orderIds }, removed: false },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, orderId: true, productId: true, channelName: true, qty: true, qtyRejected: true, shortages: { where: OPEN_SHORTAGE, select: { productId: true, qtyBase: true } } },
  })
  const lines = rows.map((l) => ({ ...l, qty: l.qty - l.qtyRejected })).filter((l) => l.qty > 0) // poza paczką: dosłane, zamienione, odrzucone
  // brak zgłoszony na stanowisku w cieniu nie jest wierszem Shortage, a na liście ma być widoczny
  const fixes = await db.packDrillFix.findMany({ where: { orderId: { in: orderIds }, ...ZGLOSZONY_W_CIENIU }, select: { orderLineId: true, productId: true, qtyBase: true } })
  const withFixes = lines.map((l) => {
    const extra = fixes.filter((f) => f.orderLineId === l.id)
    if (!extra.length) return l
    const shortages = [...l.shortages]
    for (const f of extra) {
      const known = shortages.filter((s) => s.productId === f.productId).reduce((sum, s) => sum + s.qtyBase, 0)
      if (f.qtyBase > known) shortages.push({ productId: f.productId, qtyBase: f.qtyBase - known })
    }
    return { ...l, shortages }
  })
  const ids = withFixes.flatMap((l) => [l.productId, ...l.shortages.map((s) => s.productId)]).filter((x): x is string => !!x)
  // miniatura = główne zdjęcie produktu pozycji, bez zdjęcia inicjały
  const [info, zdjecia] = await Promise.all([productInfo(db, ids), glowneZdjecia(db, withFixes.map((l) => l.productId).filter((x): x is string => !!x))])
  return buildListLines(withFixes, info, zdjecia)
}
