// Zwolnienie koszyka razem z końcem zamówienia: 1 zamówienie = 1 koszyk kończy się
// z zamówieniem. Woła je rdzeń w tej samej transakcji co zmiana statusu (spakowanie z karty, wydanie, anulowanie,
// reklamacja), więc błąd i cofnięcie transakcji cofają też zwolnienie. Bez zależności od lib/db: rdzeń importuje ten
// plik bez cyklu. Tryb próbny (status bez zmian) zwalnia koszyk w lib/stanowisko/cwiczenie.ts.
import type { OrderStatus, Prisma } from '@prisma/client'

export const ZWOLNIJ_KOSZYK = { orderId: null, assignedAt: null, assignedById: null } as const

/** Statusy, w których zamówienie nie leży już w koszyku: spakowane i dalej, anulowane, reklamacja. */
export const STATUSY_BEZ_KOSZYKA: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE', 'ANULOWANE', 'REKLAMACJA'])

type ZKoszykami = { packBasket: Pick<Prisma.TransactionClient['packBasket'], 'updateMany'> }

/** Zwalnia koszyk zamówienia (bez koszyka nic nie robi). */
export async function zwolnijKoszykZamowienia(db: ZKoszykami, orderId: string): Promise<void> {
  await db.packBasket.updateMany({ where: { orderId }, data: ZWOLNIJ_KOSZYK })
}

/** Po zmianie statusu: koszyk wraca do puli, gdy nowy status kończy pobyt zamówienia w koszyku. */
export async function zwolnijKoszykPoStatusie(tx: ZKoszykami, orderId: string, status: OrderStatus): Promise<void> {
  if (STATUSY_BEZ_KOSZYKA.has(status)) await zwolnijKoszykZamowienia(tx, orderId)
}
