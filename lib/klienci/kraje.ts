// kraje dostawy występujące w danych klientów firmy (lista wyboru filtra „Kraj” na liście zamówień).
// Tylko jawna kolumna `country` (kod ISO), bez odszyfrowywania. Klient firmy z sesji (RLS).
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'

export async function krajeKlientow(db: PrismaClient): Promise<string[]> {
  organizationIdOf(db)
  const rows = await db.orderCustomer.groupBy({ by: ['country'], where: { country: { not: null }, purgedAt: null } })
  return rows
    .map((r) => r.country)
    .filter((c): c is string => !!c)
    .sort()
}
