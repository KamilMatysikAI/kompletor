// Zapis profilu firmy z panelu (Ustawienia → Dane firmy). Klient firmy (RLS), blokada wiersza firmy na czas
// odczytu i zapisu ustawień (jak lib/produkty/bez-stanu.ts), ślad w AuditLog z wartością przed i po (dane firmy, nie
// klientów). Pozostałe klucze `settings` (baselinker, catalog, faktury, ksef, nadawca…) zostają nietknięte.
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { type UstawieniaFirmy, walidujProfil } from './profil'

type Json = Record<string, Prisma.JsonValue>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export const POLA_PROFILU = ['nazwa', 'nip', 'ulica', 'kodPocztowy', 'miasto', 'kodKraju', 'email', 'emailBiura', 'telefon', 'rachunek'] as const

export function profilZFormularza(form: FormData): Record<string, string> {
  return Object.fromEntries(POLA_PROFILU.map((k) => [k, String(form.get(k) ?? '')]))
}

/** Zapis profilu: walidacja (ProfilFirmyError z komunikatem dla ekranu), potem zapis klucza `firma`. */
export async function zapiszProfilFirmy(db: PrismaClient, input: Record<string, string>, actorId: string): Promise<UstawieniaFirmy> {
  const organizationId = organizationIdOf(db)
  const nowy = walidujProfil(input)
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    if (!rows[0]) throw new Error('Brak firmy klienta')
    const settings: Json = isObj(rows[0].settings) ? rows[0].settings : {}
    const przed = isObj(settings['firma']) ? settings['firma'] : null
    if (JSON.stringify(przed ?? {}) === JSON.stringify(nowy)) return
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, firma: nowy } as unknown as Prisma.InputJsonValue } })
    await tx.auditLog.create({ data: { entity: 'Organization.firma', entityId: organizationId, actorId, before: (przed ?? undefined) as Prisma.InputJsonValue | undefined, after: nowy as unknown as Prisma.InputJsonValue } })
  })
  return nowy
}
