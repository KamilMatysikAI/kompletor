// dane do terminu wysyłki (lib/panel/termin-wysylki.ts): aktywne harmonogramy odbiorów firmy i dzisiejsze
// kliknięcia „Przyjechał”. Dwa małe zapytania (kilka wierszy), raz na żądanie (`cache`, klucz = klient firmy z sesji):
// menu (licznik „Po terminie”), lista (termin w wierszu, widok) i alerty biorą te same.
import type { PrismaClient } from '@prisma/client'
import { cache } from 'react'
import { organizationIdOf } from '../db'
import { blStatusFamily } from '../cien/bl-porownanie'
import type { PickupArrivalT, PickupScheduleT } from '../pakowanie/harmonogram'
import { toWarsaw } from '../rdzen/kalendarz'
import { STATUSY_PRZED_WYSYLKA, type CienTerminow } from './termin-wysylki'

export interface DaneTerminow {
  harmonogramy: PickupScheduleT[]
  przyjazdy: PickupArrivalT[]
  now: Date
  /** konta w trybie „Tylko podgląd” (termin wg statusu BL); brak = firma bez takich kont */
  cien?: CienTerminow
}

/**
 * konta `statusMode = CIEN` i zamówienia BL tych kont nadal przed wysyłką wg kopii nagłówka BL (nazwa statusu
 * → rodzina, mapa `blStatusFamily`). Najpierw rodzaje statusów (kilkanaście wierszy), potem tylko zamówienia w otwartych
 * statusach BL, więc zapytanie nie rośnie z historią zamówień.
 */
export async function cienTerminow(db: PrismaClient): Promise<CienTerminow | undefined> {
  const konta = await db.channelConfig.findMany({ where: { statusMode: 'CIEN' }, select: { channel: true, channelAccountId: true } })
  if (!konta.length) return undefined
  const kontaBl = { OR: konta.map((k) => ({ channel: k.channel, channelAccountId: k.channelAccountId })) }
  const statusy = await db.blOrderSnapshot.groupBy({ by: ['statusId', 'statusName'], where: { ...kontaBl, statusName: { not: null } } })
  const otwarte = [...new Set(statusy.filter((s) => (STATUSY_PRZED_WYSYLKA as readonly string[]).includes(blStatusFamily(s.statusName!).family)).map((s) => s.statusId))]
  const otwarteWBl = otwarte.length ? (await db.blOrderSnapshot.findMany({ where: { ...kontaBl, statusId: { in: otwarte } }, select: { blOrderId: true } })).map((s) => s.blOrderId) : []
  return { konta, otwarteWBl, zBl: statusy.length > 0 }
}

export async function daneTerminow(db: PrismaClient, now = new Date()): Promise<DaneTerminow> {
  organizationIdOf(db)
  const [h, p, cien] = await Promise.all([
    db.carrierPickup.findMany({ where: { active: true }, select: { carrier: true, weekdays: true, pickupMinute: true, promiseUntilMinute: true, active: true, example: true } }),
    db.carrierPickupEvent.findMany({ where: { pickupDay: toWarsaw(now).day }, select: { carrier: true, pickupDay: true, arrivedAt: true, actorName: true } }),
    cienTerminow(db),
  ])
  return { harmonogramy: h, przyjazdy: p, now, ...(cien ? { cien } : {}) }
}

/** Raz na żądanie (menu w layoucie, lista, alerty). */
export const daneTerminowNaZadanie = cache((db: PrismaClient): Promise<DaneTerminow> => daneTerminow(db))
