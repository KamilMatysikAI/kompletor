// Ustawienia danych klientów firmy, wzorem Ustawienia → Powiadomienia: jeden wiersz
// `CustomerDataSettings` na firmę, brak wiersza = wartości domyślne. Zapis tylko z uprawnieniem `ustawienia`
// (sprawdza akcja panelu) i zawsze z jednym wierszem AuditLog bez danych klientów.
import type { PrismaClient } from '@prisma/client'

/**
 * Domyślne terminy retencji: do potwierdzenia przez księgową. 5 lat liczone od końca roku, w którym
 * wystawiono fakturę (przechowywanie dowodów księgowych); 36 miesięcy od dostarczenia albo anulowania zamówienia bez
 * faktury (rękojmia i reklamacje).
 */
export const RETENCJA_Z_FAKTURA_LAT = 5 // do potwierdzenia przez księgową
export const RETENCJA_BEZ_FAKTURY_MIESIECY = 36 // do potwierdzenia przez księgową

export const TRYBY_RETENCJI = ['RAPORT', 'USUWAJ'] as const
export type TrybRetencji = (typeof TRYBY_RETENCJI)[number]

export interface UstawieniaKlientow {
  /** daneKlientaWCieniu: zapis danych klienta także dla kont kanałów w trybie cienia (domyślnie nie). */
  zapisWCieniu: boolean
  retencjaZFakturaLat: number
  retencjaBezFakturyMiesiecy: number
  trybRetencji: TrybRetencji
  ostatniPrzebiegAt: Date | null
  ostatniPoTerminie: number | null
  ostatnioUsunieto: number | null
  updatedAt: Date | null
}

export const DOMYSLNE_USTAWIENIA: UstawieniaKlientow = {
  zapisWCieniu: false,
  retencjaZFakturaLat: RETENCJA_Z_FAKTURA_LAT,
  retencjaBezFakturyMiesiecy: RETENCJA_BEZ_FAKTURY_MIESIECY,
  trybRetencji: 'RAPORT',
  ostatniPrzebiegAt: null,
  ostatniPoTerminie: null,
  ostatnioUsunieto: null,
  updatedAt: null,
}

export async function ustawieniaKlientow(db: Pick<PrismaClient, 'customerDataSettings'>): Promise<UstawieniaKlientow> {
  const s = await db.customerDataSettings.findFirst()
  if (!s) return { ...DOMYSLNE_USTAWIENIA }
  return {
    zapisWCieniu: s.zapisWCieniu,
    retencjaZFakturaLat: s.retencjaZFakturaLat,
    retencjaBezFakturyMiesiecy: s.retencjaBezFakturyMiesiecy,
    trybRetencji: s.trybRetencji === 'USUWAJ' ? 'USUWAJ' : 'RAPORT',
    ostatniPrzebiegAt: s.ostatniPrzebiegAt,
    ostatniPoTerminie: s.ostatniPoTerminie,
    ostatnioUsunieto: s.ostatnioUsunieto,
    updatedAt: s.updatedAt,
  }
}

export class BladUstawienKlientow extends Error {}

export interface ZmianaUstawien {
  zapisWCieniu: boolean
  retencjaZFakturaLat: number
  retencjaBezFakturyMiesiecy: number
  trybRetencji: TrybRetencji
}

/** Formularz ekranu → zmiana (walidacja w `zapiszUstawieniaKlientow`). */
export function parseFormularzUstawien(form: FormData): ZmianaUstawien {
  const tryb = String(form.get('tryb') ?? 'RAPORT')
  return {
    zapisWCieniu: form.get('cien') === 'tak',
    retencjaZFakturaLat: Number(form.get('lat') ?? NaN),
    retencjaBezFakturyMiesiecy: Number(form.get('miesiecy') ?? NaN),
    trybRetencji: (TRYBY_RETENCJI as readonly string[]).includes(tryb) ? (tryb as TrybRetencji) : ('?' as TrybRetencji),
  }
}

/** Zapis ustawień z walidacją i AuditLog (`KLIENT_USTAWIENIA`, przed i po — same liczby i przełączniki). */
export async function zapiszUstawieniaKlientow(db: PrismaClient, z: ZmianaUstawien, actorId: string): Promise<void> {
  if (!Number.isInteger(z.retencjaZFakturaLat) || z.retencjaZFakturaLat < 1 || z.retencjaZFakturaLat > 20) throw new BladUstawienKlientow('Retencja z fakturą: od 1 do 20 lat')
  if (!Number.isInteger(z.retencjaBezFakturyMiesiecy) || z.retencjaBezFakturyMiesiecy < 1 || z.retencjaBezFakturyMiesiecy > 240)
    throw new BladUstawienKlientow('Retencja bez faktury: od 1 do 240 miesięcy')
  if (!TRYBY_RETENCJI.includes(z.trybRetencji)) throw new BladUstawienKlientow('Tryb retencji: raport albo usuwanie')
  const przed = await ustawieniaKlientow(db)
  const dane = { zapisWCieniu: z.zapisWCieniu, retencjaZFakturaLat: z.retencjaZFakturaLat, retencjaBezFakturyMiesiecy: z.retencjaBezFakturyMiesiecy, trybRetencji: z.trybRetencji, updatedById: actorId }
  await db.$transaction(async (tx) => {
    const cur = await tx.customerDataSettings.findFirst({ select: { organizationId: true } })
    if (cur) await tx.customerDataSettings.update({ where: { organizationId: cur.organizationId }, data: dane })
    else await tx.customerDataSettings.create({ data: dane })
    await tx.auditLog.create({
      data: {
        entity: 'KLIENT_USTAWIENIA',
        entityId: 'firma',
        actorId,
        before: { zapisWCieniu: przed.zapisWCieniu, retencjaZFakturaLat: przed.retencjaZFakturaLat, retencjaBezFakturyMiesiecy: przed.retencjaBezFakturyMiesiecy, trybRetencji: przed.trybRetencji },
        after: { zapisWCieniu: z.zapisWCieniu, retencjaZFakturaLat: z.retencjaZFakturaLat, retencjaBezFakturyMiesiecy: z.retencjaBezFakturyMiesiecy, trybRetencji: z.trybRetencji },
      },
    })
  })
}

/** Liczniki do ekranu (bez danych): zamówienia z danymi klienta i z danymi usuniętymi. */
export async function licznikiKlientow(db: PrismaClient): Promise<{ zDanymi: number; usuniete: number }> {
  const [zDanymi, usuniete] = await Promise.all([db.orderCustomer.count({ where: { purgedAt: null } }), db.orderCustomer.count({ where: { purgedAt: { not: null } } })])
  return { zDanymi, usuniete }
}
