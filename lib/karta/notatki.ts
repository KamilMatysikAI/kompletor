// Notatki wewnętrzne na karcie zamówienia. Treść ≤ 2000 znaków, autor i czas; poprawić może wyłącznie
// autor przez 15 minut od dodania, nikt nie kasuje cudzych (kasowania nie ma w ogóle). Notatka nie zmienia zamówienia,
// więc działa też na koncie w cieniu. Treść nie idzie do AI, alertów, logów ani zdarzeń zamówienia. Pole `showOnCard`
// zostaje w bazie, ale formularz go nie pokazuje, dopóki wydruk karty nie pokazuje notatek.
// Uprawnienie `zamowienia.notatki`.
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { nazwyOsobFirmy } from '@/lib/panel/ustawienia-rezerwacji'
import { ID_RE } from './bramka'
import { BEZ_UPRAWNIENIA, type WynikKarty } from './pozycje'

type Db = PrismaClient

export const MAKS_NOTATKI = 2000
export const OKNO_EDYCJI_MS = 15 * 60_000
export const BLAD_DLUGOSCI = `Notatka: od 1 do ${MAKS_NOTATKI} znaków.`

export interface Notatka {
  id: string
  tresc: string
  autor: string
  mojaDoPoprawy: boolean
  naKarcie: boolean
  dodano: Date
  poprawiono: Date | null
}

function tresc(v: unknown): string | null {
  const s = String(v ?? '').replace(/\r\n/g, '\n').trim()
  return s.length >= 1 && s.length <= MAKS_NOTATKI ? s : null
}

export const moznaPoprawic = (n: { actorId: string; createdAt: Date }, userId: string, now: Date): boolean => n.actorId === `user:${userId}` && now.getTime() - n.createdAt.getTime() <= OKNO_EDYCJI_MS

export async function notatkiZamowienia(db: Db, orderId: string, userId: string, now = new Date()): Promise<Notatka[]> {
  organizationIdOf(db)
  const rows = await db.orderNote.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' }, take: 100 })
  const nazwy = await nazwyOsobFirmy(db, [...new Set(rows.map((r) => r.actorId.replace(/^user:/, '')))])
  return rows.map((r) => ({
    id: r.id,
    tresc: r.body,
    autor: nazwy.get(r.actorId.replace(/^user:/, '')) ?? 'użytkownik',
    mojaDoPoprawy: moznaPoprawic(r, userId, now),
    naKarcie: r.showOnCard,
    dodano: r.createdAt,
    poprawiono: r.editedAt,
  }))
}

export interface ZlecenieNotatki {
  orderId: unknown
  tresc: unknown
  naKarcie?: unknown
  userId: string
  uprawnienia: ReadonlySet<string>
}

export async function dodajNotatke(db: Db, z: ZlecenieNotatki): Promise<WynikKarty> {
  organizationIdOf(db)
  if (!z.uprawnienia.has('zamowienia.notatki')) return { blad: BEZ_UPRAWNIENIA, zmiana: false }
  const id = String(z.orderId ?? '')
  if (!ID_RE.test(id) || !(await db.order.findUnique({ where: { id }, select: { id: true } }))) return { blad: 'Nie ma takiego zamówienia.', zmiana: false }
  const body = tresc(z.tresc)
  if (!body) return { blad: BLAD_DLUGOSCI, zmiana: false }
  await db.orderNote.create({ data: { orderId: id, body, actorId: `user:${z.userId}`, showOnCard: z.naKarcie === 'tak' || z.naKarcie === true } })
  return { blad: null, zmiana: true }
}

/** Poprawka własnej notatki w oknie 15 minut (warunek w samym zapisie: dwa okna przeglądarki nie obejdą okna czasu). */
export async function poprawNotatke(db: Db, z: ZlecenieNotatki & { noteId: unknown }, now = new Date()): Promise<WynikKarty> {
  organizationIdOf(db)
  if (!z.uprawnienia.has('zamowienia.notatki')) return { blad: BEZ_UPRAWNIENIA, zmiana: false }
  const noteId = String(z.noteId ?? '')
  const orderId = String(z.orderId ?? '')
  if (!ID_RE.test(noteId) || !ID_RE.test(orderId)) return { blad: 'Nie ma takiej notatki.', zmiana: false }
  const body = tresc(z.tresc)
  if (!body) return { blad: BLAD_DLUGOSCI, zmiana: false }
  const r = await db.orderNote.updateMany({
    where: { id: noteId, orderId, actorId: `user:${z.userId}`, createdAt: { gte: new Date(now.getTime() - OKNO_EDYCJI_MS) } },
    data: { body, showOnCard: z.naKarcie === 'tak' || z.naKarcie === true, editedAt: now },
  })
  if (r.count === 1) return { blad: null, zmiana: true }
  const n = await db.orderNote.findFirst({ where: { id: noteId, orderId }, select: { actorId: true } })
  if (!n) return { blad: 'Nie ma takiej notatki.', zmiana: false }
  return { blad: n.actorId === `user:${z.userId}` ? 'Notatkę można poprawić tylko przez 15 minut od dodania.' : 'Poprawić notatkę może tylko jej autor.', zmiana: false }
}
