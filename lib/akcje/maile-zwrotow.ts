// Wyłącznik maili do klienta o zwrotach i reklamacjach (Zwrot dotarł, Reklamacja dotarła, Pieniądze zwrócone).
// Moduł bez zależności wartościowych (tylko typy), żeby silnik planu, wysyłka poczty i ekrany mogły go importować bez
// ryzyka cyklu importów (wzór: lib/kanaly/zamkniete-przy-przejsciu.ts).
//
// Ustawienie firmy: `Organization.settings.akcje.maileZwrotow` = true oraz `akcje.maileZwrotowOd` = chwila włączenia
// (ISO). Chwila włączenia zapisuje się przy każdym przejściu wyłączony → włączony; maile dotyczą tylko zwrotów odebranych
// (i pieniędzy zwróconych) od tej chwili, więc włączenie nie wysyła zaległości sprzed włączenia. Flaga bez poprawnej
// daty (np. ręczny wpis w bazie) liczy się jak wyłączona.
import type { Prisma, PrismaClient } from '@prisma/client'
import type { KluczReguly } from './reguly'

/** Reguły maili o zwrotach (działają tylko z włączonym wyłącznikiem firmy). */
export const REGULY_ZWROTOW = ['mail.zwrot-przyjety', 'mail.reklamacja-przyjeta', 'mail.zwrot-pieniedzy'] as const satisfies readonly KluczReguly[]

function akcjeZUstawien(settings: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {}
  const a = s['akcje']
  return a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {}
}

/**
 * Chwila włączenia maili o zwrotach albo null, gdy wyłączone: wymaga jawnego `maileZwrotow` = true i poprawnej daty
 * `maileZwrotowOd`. Domyślnie (firma bez ustawienia) null.
 */
export function maileZwrotowOd(settings: Prisma.JsonValue | null | undefined): Date | null {
  const a = akcjeZUstawien(settings)
  if (a['maileZwrotow'] !== true) return null
  const od = a['maileZwrotowOd']
  if (typeof od !== 'string') return null
  const d = new Date(od)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Czy maile o zwrotach działają dla firmy (flaga i data włączenia). */
export function maileZwrotowWlaczone(settings: Prisma.JsonValue | null | undefined): boolean {
  return maileZwrotowOd(settings) !== null
}

/** Chwila włączenia maili o zwrotach dla firmy klienta `db` (jedno zapytanie); null = wyłączone. */
export async function maileZwrotowFirmy(db: PrismaClient): Promise<Date | null> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  return maileZwrotowOd(org?.settings)
}
