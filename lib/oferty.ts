// Ręczne zmiany ofert kanałów (panel F2). JEDYNA droga dla panelu do zmiany `ChannelOffer.active` —
// pilnuje kontraktu z importem katalogu (lib/import/zapis.ts, uwaga 5):
// - włączenie (także zatwierdzenie propozycji po SKU) = `mappingSource = MANUAL`: import przestaje ruszać ofertę;
// - wyłączenie (także odrzucenie propozycji) = trwałe: import nie włączy oferty z powrotem;
// - każda ręczna zmiana zeruje `deactivatedByImportAt` i `needsApproval` — inaczej import uznałby
//   ręczne wyłączenie za swoje i przy następnym przebiegu włączył ofertę.
import type { ChannelOffer, PrismaClient } from '@prisma/client'

// Migawka do AuditLog: wszystkie pola, które ręczna zmiana może przestawić (drobna 6).
const snapshot = (o: ChannelOffer) => ({
  active: o.active,
  mappingSource: o.mappingSource,
  productId: o.productId,
  qtyBasePerOffer: o.qtyBasePerOffer,
  needsApproval: o.needsApproval,
  deactivatedByImportAt: o.deactivatedByImportAt?.toISOString() ?? null,
})

/**
 * Ręczne włączenie albo wyłączenie oferty z panelu (z opcjonalną zmianą produktu i przelicznika).
 * Zmiana `productId` NIE przelicza `qtyBasePerOffer` (import liczy 1000 g dla towaru w kg): przy zmianie produktu
 * na inny w innej jednostce panel musi podać `qtyBasePerOffer` sam (F2).
 */
export async function setOfferActiveManually(
  db: PrismaClient,
  offerId: string,
  active: boolean,
  opts: { actorId: string; productId?: string; qtyBasePerOffer?: number },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const before = await tx.channelOffer.findUniqueOrThrow({ where: { id: offerId } })
    const after = await tx.channelOffer.update({
      where: { id: offerId },
      data: {
        active,
        needsApproval: false,
        deactivatedByImportAt: null,
        ...(active ? { mappingSource: 'MANUAL' as const } : {}),
        ...(opts.productId ? { productId: opts.productId } : {}),
        ...(opts.qtyBasePerOffer ? { qtyBasePerOffer: opts.qtyBasePerOffer } : {}),
      },
    })
    await tx.auditLog.create({
      data: {
        entity: 'ChannelOffer',
        entityId: offerId,
        actorId: opts.actorId,
        before: snapshot(before),
        after: snapshot(after),
      },
    })
  })
}
