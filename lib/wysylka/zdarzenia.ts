// Zdarzenie „numer nadania gotowy” (↔). Host przesyłek zgłasza je w tej samej transakcji, w której
// przesyłka dostaje numer nadania; host zapisu na kanały przekazuje numer do kanału (status + numer w Woo,
// Allegro, Empik) i do maila „Wysłane”.
//
// Do czasu hosta zapisu zdarzenie leży jako wiersz AuditLog (entity NUMER_NADANIA_GOTOWY, entityId = id przesyłki):
// podmienia ciało `zglosNumerNadania` na wpis do swojego outboxa (jedna funkcja) albo czyta te wiersze.
// Treść bez danych klienta: numer nadania nie jest daną osobową. Jedna przesyłka = jeden numer = jedno zdarzenie
// (klucz idempotencji odbiorcy: `shipmentId`).
import type { Carrier, Prisma } from '@prisma/client'

export const NUMER_NADANIA_GOTOWY = 'NUMER_NADANIA_GOTOWY'

export interface NumerNadaniaGotowy {
  shipmentId: string
  orderId: string
  packageNo: number
  carrier: Carrier
  adapterKey: string
  trackingNumber: string
}

export async function zglosNumerNadania(tx: Prisma.TransactionClient, z: NumerNadaniaGotowy, actorId: string): Promise<void> {
  await tx.auditLog.create({ data: { entity: NUMER_NADANIA_GOTOWY, entityId: z.shipmentId, actorId, after: { ...z } } })
}
