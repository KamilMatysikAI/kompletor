// Kontekst marki do maili: dane firmy do stopki i sklep (konto kanału) do nagłówka, koloru i odpowiedzi.
//
// `daneFirmy` to jedyne miejsce, które czyta profil firmy na potrzeby maili: Ustawienia → Dane firmy
// (lib/firma/profil.ts) daje nazwę, NIP, adres, e-mail i telefon do stopki. Adres biura (adresat maili
// wewnętrznych) z profilu, a bez niego „Adres biura” z Ustawień → Poczta; kontakt w stopce: e-mail z profilu, potem
// adres biura, potem nadawca. Stopka przez `daneFirmyDoMaila`, puste NIP i telefon pomijane.
import type { Channel, PrismaClient } from '@prisma/client'
import { daneFirmyDoMaila, parseProfilFirmy } from '../firma/profil'
import type { DaneFirmy, DaneSklepu, KontekstMarki } from '../maile'
import { accountDisplayName } from '../panel/format'
import { DOMYSLNY_KOLOR, kluczKonta, nadawcyZBazy, type NadawcaKonta, type PocztaFirmy } from './ustawienia'

/** Część ustawień poczty, z której powstaje marka maila (bez serwera i hasła). */
export type UstawieniaMarki = Pick<PocztaFirmy, 'officeEmail' | 'fromEmail' | 'fromName' | 'nadawcy'>

/**
 * Ustawienia marki z Ustawień → Poczta bez sekretów i bez wymogu kompletnej konfiguracji serwera: podgląd maila
 * pokazuje markę firmy także wtedy, gdy wysyłka nie jest jeszcze ustawiona. Brak wpisu = puste pola.
 */
export async function ustawieniaMarki(db: PrismaClient): Promise<UstawieniaMarki> {
  const s = await db.mailSettings.findFirst({ select: { fromEmail: true, fromName: true, officeEmail: true, senders: true } })
  return { fromEmail: s?.fromEmail ?? '', fromName: s?.fromName ?? null, officeEmail: s?.officeEmail ?? null, nadawcy: nadawcyZBazy(s?.senders) }
}

export async function daneFirmy(db: PrismaClient, p: Pick<PocztaFirmy, 'officeEmail' | 'fromEmail'>): Promise<DaneFirmy> {
  const org = await db.organization.findFirstOrThrow({ select: { name: true, settings: true } })
  const z = daneFirmyDoMaila(parseProfilFirmy(org.settings), org.name)
  const emailBiura = z.emailBiura ?? p.officeEmail
  return {
    nazwa: z.nazwa,
    adres: z.adres,
    ...(z.nip ? { nip: z.nip } : {}),
    ...(z.telefon ? { telefon: z.telefon } : {}),
    email: z.email ?? emailBiura ?? p.fromEmail,
    emailBiura,
  }
}

export interface Nadawca {
  email: string
  nazwa: string | null
}

/** Sklep i nadawca dla konta kanału; konto bez wpisu = nazwa konta i dane firmy. */
export function sklepKonta(p: UstawieniaMarki, konto: { channel: Channel; channelAccountId: string; name: string | null; config: unknown } | null, nazwaFirmy: string): { sklep: DaneSklepu; nadawca: Nadawca } {
  const n: NadawcaKonta = konto ? (p.nadawcy[kluczKonta(konto.channel, konto.channelAccountId)] ?? {}) : {}
  const nazwa = n.nazwaSklepu ?? (konto ? accountDisplayName(konto.channel, konto.channelAccountId, konto.name, konto.config) : nazwaFirmy)
  const odpowiedzDo = n.odpowiedzDo ?? n.email ?? p.fromEmail
  return {
    sklep: {
      nazwa,
      logoUrl: n.logoUrl ?? null,
      kolorGlowny: n.kolor ?? DOMYSLNY_KOLOR,
      odpowiedzDo,
      www: n.www ?? null,
      odbiorOsobisty: n.odbiorAdres?.length || n.odbiorGodziny?.length ? { adres: n.odbiorAdres ?? [], godziny: n.odbiorGodziny ?? [], uwagi: n.odbiorUwagi ?? null } : null,
    },
    nadawca: { email: n.email ?? p.fromEmail, nazwa: n.nazwaNadawcy ?? p.fromName ?? nazwa },
  }
}

/** Kontekst maili do biura i maili systemowych (bez konta kanału): sklep = firma. */
export async function kontekstFirmy(db: PrismaClient, p: UstawieniaMarki): Promise<{ kontekst: KontekstMarki; nadawca: Nadawca }> {
  const firma = await daneFirmy(db, p)
  const { sklep, nadawca } = sklepKonta(p, null, firma.nazwa)
  return { kontekst: { firma, sklep }, nadawca }
}

/** Kontekst maila do klienta zamówienia z konta kanału: stopka firmy, sklep i nadawca z Ustawień → Poczta. */
export async function kontekstKontaKanalu(db: PrismaClient, p: UstawieniaMarki, channel: Channel, channelAccountId: string): Promise<{ kontekst: KontekstMarki; nadawca: Nadawca }> {
  const [firma, konto] = await Promise.all([
    daneFirmy(db, p),
    db.channelConfig.findFirst({ where: { channel, channelAccountId }, select: { channel: true, channelAccountId: true, name: true, config: true } }),
  ])
  const { sklep, nadawca } = sklepKonta(p, konto, firma.nazwa)
  return { kontekst: { firma, sklep }, nadawca }
}
