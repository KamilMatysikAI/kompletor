// Obsługa klienta przez API (trasy /api/v1/obsluga/*, klucz z zakresem `obsluga:odczyt`): które zamówienia firmy
// mają klienta o tym e-mailu albo telefonie. Tylko skrót HMAC pełnej znormalizowanej wartości (`emailHash` /
// `phoneHash`, indeksy), bez odszyfrowywania rekordu i bez szukania fragmentu. Wynik to same identyfikatory zamówień:
// danych klienta funkcja nie zwraca.
//
// Wyszukanie po numerze zamówienia idzie tym samym jednym zapytaniem co wyszukanie po kontakcie (numer i skrót
// kontaktu w jednym warunku), więc „nie ma takiego numeru” i „numer jest, ale kontakt nie pasuje” to ta sama ścieżka i
// ten sam wynik (pusta lista).
//
// Konta: wyszukanie obejmuje wyłącznie konta sprzedaży zapisane przy kluczu (`ApiKey.accounts`, lib/api/konta-klucza.ts),
// odczytane tu z bazy po id klucza z autora, więc trasa nie może o nich zapomnieć. `konta` z żądania tylko zawęża ten
// zbiór; konto spoza klucza daje pustą listę tą samą ścieżką co brak danych.
//
// Każde wywołanie zostawia jeden wpis w dzienniku podglądów (`KLIENT_PODGLAD`, entityId `wyszukiwanie`), autor
// `api:<id klucza>`, `after: { cel: 'OBSLUGA_KLIENTA', trasa, rodzaj, trafienia }`, bez szukanej wartości i bez numeru.
// Wpis powstaje przed zwrotem wyniku: bez zapisanego śladu wynik nie wychodzi.
import type { Channel, Prisma, PrismaClient } from '@prisma/client'
import { kontaDoSzukania, kontaKluczaZBazy } from '../api/konta-klucza'
import { organizationIdOf } from '../db'
import type { Env } from '../sekrety'
import { PODGLAD_AUDIT } from './odczyt'
import { kluczSkrotowZEnv, normalizujEmail, normalizujTelefon, skrot } from './skroty'

export const CEL_OBSLUGI = 'OBSLUGA_KLIENTA'
export const TRASY_OBSLUGI = ['zamowienia-klienta', 'zamowienie'] as const
export type TrasaObslugi = (typeof TRASY_OBSLUGI)[number]
/** Najwięcej zamówień jednego kontaktu w odpowiedzi. */
export const MAX_TRAFIEN_OBSLUGI = 20

export type KontaktObslugi = { rodzaj: 'email' | 'telefon'; wartosc: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** E-mail albo telefon z zapytania po normalizacji jak przy zapisie skrótów; zła wartość = null. */
export function kontaktObslugi(rodzaj: 'email' | 'telefon', surowy: string): KontaktObslugi | null {
  if (rodzaj === 'email') {
    const e = normalizujEmail(surowy)
    return e && e.length <= 254 && EMAIL_RE.test(e) ? { rodzaj, wartosc: e } : null
  }
  if (!/^[+\d\s().-]{9,25}$/.test(surowy.trim())) return null
  const t = normalizujTelefon(surowy)
  return t ? { rodzaj, wartosc: t } : null
}

export interface KontoObslugi {
  kanal?: Channel
  konto: string
}

export interface ZapytanieObslugi {
  /** `api:<id klucza>`: autor wpisu w dzienniku. */
  actorId: string
  trasa: TrasaObslugi
  kontakt: KontaktObslugi
  /** numer sklepu, numer widoczny w kanale albo numer BL; brak = wszystkie zamówienia kontaktu */
  numer?: string
  /** zawężenie do kont (dowolne z listy) w granicach kont klucza; brak = wszystkie konta klucza */
  konta?: KontoObslugi[]
  limit: number
  env?: Env
}

export type WynikObslugi = { stan: 'OK'; orderIds: string[] } | { stan: 'BRAK_KLUCZA' }

/** Warunek numeru: numer sklepu (`externalId`), numer widoczny w kanale (`channelNumber`) albo numer BL. */
export function warunekNumeru(numer: string): Prisma.OrderWhereInput {
  const bl = /^\d{1,10}$/.test(numer) && Number(numer) <= 2_147_483_647 ? Number(numer) : null
  return { OR: [{ externalId: numer }, { channelNumber: numer }, ...(bl !== null ? [{ blOrderId: bl }] : [])] }
}

/** Warunek kont; pusta lista = warunek, którego nie spełnia żadne zamówienie. */
export function warunekKont(konta: readonly KontoObslugi[]): Prisma.OrderWhereInput {
  if (!konta.length) return { id: { in: [] } }
  return { OR: konta.map((k) => ({ channelAccountId: k.konto, ...(k.kanal ? { channel: k.kanal } : {}) })) }
}

export async function zamowieniaKontaktu(db: PrismaClient, q: ZapytanieObslugi): Promise<WynikObslugi> {
  if (!/^api:[A-Za-z0-9_-]{1,64}$/.test(q.actorId)) throw new Error('zamowieniaKontaktu: autor musi być kluczem API')
  if (!TRASY_OBSLUGI.includes(q.trasa)) throw new Error('zamowieniaKontaktu: nieznana trasa')
  const org = organizationIdOf(db) // klient firmy (RLS); klient systemowy = błąd
  const wpis = (after: Record<string, string | number>) =>
    db.auditLog.create({ data: { entity: PODGLAD_AUDIT, entityId: 'wyszukiwanie', actorId: q.actorId, after: { cel: CEL_OBSLUGI, trasa: q.trasa, rodzaj: q.kontakt.rodzaj, ...after } } })
  const key = kluczSkrotowZEnv(q.env ?? process.env)
  if (!key) {
    await wpis({ trafienia: 0, wynik: 'BRAK_KLUCZA' })
    return { stan: 'BRAK_KLUCZA' }
  }
  const h = skrot(key, org, q.kontakt.rodzaj, q.kontakt.wartosc)!
  const klucz = await db.apiKey.findUnique({ where: { id: q.actorId.slice(4) }, select: { accounts: true } })
  const konta = kontaDoSzukania(kontaKluczaZBazy(klucz?.accounts), q.konta)
  const warunki: Prisma.OrderWhereInput[] = [...(q.numer ? [warunekNumeru(q.numer)] : []), ...(konta ? [warunekKont(konta)] : [])]
  const rows = await db.orderCustomer.findMany({
    where: { ...(q.kontakt.rodzaj === 'email' ? { emailHash: h } : { phoneHash: h }), purgedAt: null, ...(warunki.length ? { order: { AND: warunki } } : {}) },
    select: { orderId: true },
    orderBy: [{ order: { createdAtChannel: 'desc' } }, { orderId: 'asc' }],
    take: Math.min(Math.max(q.limit, 1), MAX_TRAFIEN_OBSLUGI),
  })
  await wpis({ trafienia: rows.length })
  return { stan: 'OK', orderIds: rows.map((r) => r.orderId) }
}
