// Ustawienia stanowiska pakowania firmy w Organization.settings.stanowisko (bez migracji):
// „po etykiecie wróć sam do skanu” (domyślnie włączone) i po ilu sekundach (domyślnie 3).
// „wymagaj skanu koszyka przed »Spakowano«” (domyślnie wyłączone; działa tylko, gdy firma ma koszyki).
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'

export interface UstawieniaStanowiska {
  powrotDoSkanu: boolean
  powrotPoSekundach: number
  /** Zapisane w ustawieniach firmy; skuteczne tylko przy `maKoszyki` (ekran i zapis patrzą na `koszykWymagany && maKoszyki`). */
  koszykWymagany: boolean
}

export const DOMYSLNE_USTAWIENIA: UstawieniaStanowiska = { powrotDoSkanu: true, powrotPoSekundach: 3, koszykWymagany: false }

function stanowiskoZ(settings: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  const o = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {}
  return o['stanowisko'] && typeof o['stanowisko'] === 'object' && !Array.isArray(o['stanowisko']) ? (o['stanowisko'] as Record<string, unknown>) : {}
}

export function parseUstawienia(settings: Prisma.JsonValue | null | undefined): UstawieniaStanowiska {
  const s = stanowiskoZ(settings)
  const sek = s['powrotPoSekundach']
  return {
    powrotDoSkanu: typeof s['powrotDoSkanu'] === 'boolean' ? s['powrotDoSkanu'] : DOMYSLNE_USTAWIENIA.powrotDoSkanu,
    powrotPoSekundach: typeof sek === 'number' && Number.isInteger(sek) && sek >= 1 && sek <= 30 ? sek : DOMYSLNE_USTAWIENIA.powrotPoSekundach,
    koszykWymagany: s['koszykWymagany'] === true,
  }
}

/**
 * Ustawienia dla ekranu stanowiska: `koszykWymagany` już po sprawdzeniu, że firma ma choć jeden koszyk. W transakcji
 * (`tx` nie zna firmy) firmę podaje wołający: `ustawieniaStanowiska(tx, organizationIdOf(db))`.
 */
export async function ustawieniaStanowiska(db: Pick<PrismaClient, 'organization' | 'packBasket'>, organizationId?: string): Promise<UstawieniaStanowiska> {
  const id = organizationId ?? organizationIdOf(db)
  const [org, koszyki] = await Promise.all([db.organization.findUnique({ where: { id }, select: { settings: true } }), db.packBasket.count()])
  const u = parseUstawienia(org?.settings)
  return { ...u, koszykWymagany: u.koszykWymagany && koszyki > 0 }
}

/** Zapis „wymagaj skanu koszyka” bez ruszania reszty ustawień firmy (blokada wiersza jak lib/firma/zapis.ts, ślad w AuditLog). */
export async function zapiszKoszykWymagany(db: PrismaClient, wlaczone: boolean, actorId: string): Promise<void> {
  const id = organizationIdOf(db)
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${id} FOR UPDATE`
    if (!rows[0]) throw new Error('Brak firmy klienta')
    const o = rows[0].settings && typeof rows[0].settings === 'object' && !Array.isArray(rows[0].settings) ? (rows[0].settings as Record<string, Prisma.JsonValue>) : {}
    const przed = stanowiskoZ(rows[0].settings)
    if ((przed['koszykWymagany'] === true) === (wlaczone === true)) return
    const stanowisko = { ...przed, koszykWymagany: wlaczone === true } as Prisma.JsonObject
    await tx.organization.update({ where: { id }, data: { settings: { ...o, stanowisko } as Prisma.InputJsonValue } })
    await tx.auditLog.create({ data: { entity: 'Organization.stanowisko', entityId: id, actorId, before: przed as Prisma.InputJsonValue, after: stanowisko } })
  })
}
