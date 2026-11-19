// Koszyki do zbierania: lista koszyków firmy, przypisanie zamówienia do koszyka (1 zamówienie = 1 koszyk,
// ustalenie właściciela 22.10) i zwolnienie. Klient bazy firmy z sesji (RLS) — klienta systemowego funkcje odmawiają
// (`organizationIdOf` rzuca błąd). Kod do skanera i nazwy: kod.ts. Koszyk zwalnia się sam razem z końcem zamówienia
// (spakowane, wydane, anulowane, reklamacja: rdzeń w transakcji zmiany statusu, zwolnienie.ts; tryb próbny:
// lib/stanowisko/cwiczenie.ts, zakonczCwiczenie), ręcznie: ekran Pakowanie → Koszyki.
import { Prisma, type PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { kodKoszyka, kolejneNazwy, MAX_KOSZYKOW, nazwaKoszyka, porownajNazwy } from './kod'
import { ZWOLNIJ_KOSZYK as ZWOLNIJ } from './zwolnienie'

export { zwolnijKoszykPoStatusie, zwolnijKoszykZamowienia } from './zwolnienie'

type Db = PrismaClient

export interface Koszyk {
  id: string
  nazwa: string
  kod: string
  orderId: string | null
  assignedAt: Date | null
}

export async function listaKoszykow(db: Db): Promise<Koszyk[]> {
  organizationIdOf(db)
  const rows = await db.packBasket.findMany({ select: { id: true, name: true, orderId: true, assignedAt: true }, take: MAX_KOSZYKOW })
  return rows
    .map((r) => ({ id: r.id, nazwa: r.name, kod: kodKoszyka(r.name), orderId: r.orderId, assignedAt: r.assignedAt }))
    .sort((a, b) => porownajNazwy(a.nazwa, b.nazwa))
}

export class BladKoszyka extends Error {}

/**
 * Dodaje koszyki: `nazwy` wpisane przez firmę albo `ile` kolejnych liter (A, B, …). Istniejące nazwy pomija (dwa
 * kliknięcia „Dodaj 10” dają A–T, nie błąd). Zwraca dodane nazwy.
 */
export async function dodajKoszyki(db: Db, a: { nazwy?: string[]; ile?: number }): Promise<string[]> {
  organizationIdOf(db)
  const istniejace = (await db.packBasket.findMany({ select: { name: true } })).map((r) => r.name)
  let nowe: string[]
  if (a.nazwy?.length) {
    nowe = []
    for (const t of a.nazwy) {
      const n = nazwaKoszyka(t)
      if (!n) throw new BladKoszyka(`„${String(t).slice(0, 20)}”: nazwa koszyka to litery i cyfry, najwyżej 8 znaków`)
      if (!istniejace.includes(n) && !nowe.includes(n)) nowe.push(n)
    }
  } else {
    const ile = Math.floor(Number(a.ile ?? 0))
    if (!Number.isFinite(ile) || ile < 1 || ile > 50) throw new BladKoszyka('Liczba koszyków od 1 do 50')
    nowe = kolejneNazwy(istniejace, ile)
  }
  if (istniejace.length + nowe.length > MAX_KOSZYKOW) throw new BladKoszyka(`Firma może mieć najwyżej ${MAX_KOSZYKOW} koszyków`)
  if (!nowe.length) return []
  await db.packBasket.createMany({ data: nowe.map((name) => ({ name })), skipDuplicates: true })
  return nowe
}

/** Usuwa koszyk, tylko pusty (koszyk z zamówieniem najpierw „Zwolnij”). */
export async function usunKoszyk(db: Db, id: string): Promise<boolean> {
  organizationIdOf(db)
  const r = await db.packBasket.deleteMany({ where: { id: String(id), orderId: null } })
  return r.count === 1
}

export async function zwolnijKoszyk(db: Db, id: string): Promise<void> {
  organizationIdOf(db)
  await db.packBasket.updateMany({ where: { id: String(id) }, data: ZWOLNIJ })
}

export type WynikPrzypisania =
  | { typ: 'przypisany'; nazwa: string; przeniesionyZ: string | null }
  | { typ: 'juz'; nazwa: string }
  | { typ: 'zajety'; nazwa: string; orderId: string }
  /** Wyścig dwóch stanowisk: zamówienie przed chwilą trafiło do koszyka `wKoszyku`. */
  | { typ: 'wInnym'; nazwa: string; wKoszyku: string }
  | { typ: 'nieznany' }

const czyKonfliktUnikalnosci = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'

/**
 * Skan koszyka przy zbieraniu: zamówienie trafia do koszyka `nazwa`. Zajęty innym zamówieniem = odmowa (koszyk trzeba
 * najpierw opróżnić). Zamówienie w innym koszyku przechodzi do nowego (1 zamówienie = 1 koszyk). Zamówienie innej
 * firmy jest niewidoczne (RLS) = „nieznany”.
 */
export async function przypiszKoszyk(db: Db, a: { nazwa: string; orderId: string; userId: string }, now = new Date()): Promise<WynikPrzypisania> {
  organizationIdOf(db)
  const nazwa = nazwaKoszyka(a.nazwa)
  if (!nazwa || !/^[a-z0-9]{1,40}$/i.test(a.orderId)) return { typ: 'nieznany' }
  const [k, order] = await Promise.all([
    db.packBasket.findFirst({ where: { name: nazwa }, select: { id: true, orderId: true } }),
    db.order.findFirst({ where: { id: a.orderId }, select: { id: true } }),
  ])
  if (!k || !order) return { typ: 'nieznany' }
  if (k.orderId === a.orderId) return { typ: 'juz', nazwa }
  if (k.orderId) return { typ: 'zajety', nazwa, orderId: k.orderId }
  try {
    return await db.$transaction(async (tx) => {
      const poprzedni = await tx.packBasket.findFirst({ where: { orderId: a.orderId }, select: { id: true, name: true } })
      if (poprzedni) await tx.packBasket.update({ where: { id: poprzedni.id }, data: ZWOLNIJ })
      const r = await tx.packBasket.updateMany({ where: { id: k.id, orderId: null }, data: { orderId: a.orderId, assignedAt: now, assignedById: a.userId } })
      if (r.count !== 1) throw new BladKoszyka('zajety')
      return { typ: 'przypisany' as const, nazwa, przeniesionyZ: poprzedni?.name ?? null }
    })
  } catch (e) {
    // ktoś w tej samej chwili włożył coś do koszyka albo to zamówienie do innego koszyka
    if (e instanceof BladKoszyka || czyKonfliktUnikalnosci(e)) {
      const teraz = await db.packBasket.findFirst({ where: { name: nazwa }, select: { orderId: true } })
      if (teraz?.orderId === a.orderId) return { typ: 'juz', nazwa }
      if (teraz?.orderId) return { typ: 'zajety', nazwa, orderId: teraz.orderId }
      // to samo zamówienie w tej samej chwili zeskanowane do innego koszyka na drugim stanowisku
      // (unikalność `orderId`) — zostaje tam, bez cichego przenoszenia
      const gdzie = await db.packBasket.findFirst({ where: { orderId: a.orderId }, select: { name: true } })
      if (gdzie) return { typ: 'wInnym', nazwa, wKoszyku: gdzie.name }
    }
    throw e
  }
}

/**
 * Przydział wolnych koszyków zamówieniom bez koszyka, w podanej kolejności (lista zbierania). Zamówienia z koszykiem
 * zostają w swoim. Gdy koszyków brakuje, reszta zostaje bez koszyka (`bezKoszyka`).
 * Celowo bez jednej transakcji (≤ 100 krótkich zapisów z warunkiem `orderId: null`): dwa kliknięcia z dwóch tabletów
 * naraz dają przydział poprawny (każde zamówienie w najwyżej jednym koszyku), najwyżej z literami w innej kolejności
 * niż na liście.
 */
export async function przypiszWolne(db: Db, orderIds: string[], userId: string, now = new Date()): Promise<{ przypisane: { orderId: string; nazwa: string }[]; bezKoszyka: number }> {
  organizationIdOf(db)
  const ids = [...new Set(orderIds.filter((id) => /^[a-z0-9]{1,40}$/i.test(id)))].slice(0, 100)
  if (!ids.length) return { przypisane: [], bezKoszyka: 0 }
  const widoczne = new Set((await db.order.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((o) => o.id))
  const wszystkie = await listaKoszykow(db)
  const maKoszyk = new Set(wszystkie.map((k) => k.orderId).filter((x): x is string => !!x))
  const wolne = wszystkie.filter((k) => !k.orderId)
  const przypisane: { orderId: string; nazwa: string }[] = []
  let bezKoszyka = 0
  for (const id of ids) {
    if (!widoczne.has(id) || maKoszyk.has(id)) continue
    let ok = false
    while (!ok && wolne.length) {
      const k = wolne.shift()!
      try {
        ok = (await db.packBasket.updateMany({ where: { id: k.id, orderId: null }, data: { orderId: id, assignedAt: now, assignedById: userId } })).count === 1
      } catch (e) {
        // zamówienie w międzyczasie trafiło do innego koszyka (skan na stanowisku): koszyk wraca do puli, zamówienie ma już swój
        if (!czyKonfliktUnikalnosci(e)) throw e
        wolne.unshift(k)
        break
      }
      if (ok) przypisane.push({ orderId: id, nazwa: k.nazwa })
    }
    if (!ok && !wolne.length && !(await db.packBasket.findFirst({ where: { orderId: id }, select: { id: true } }))) bezKoszyka++
  }
  return { przypisane, bezKoszyka }
}

/** Koszyk każdego z zamówień (nazwa) — kolejka, lista zbierania, stanowisko. */
export async function koszykiZamowien(db: Pick<Db, 'packBasket'>, orderIds: string[]): Promise<Map<string, string>> {
  if (!orderIds.length) return new Map()
  const rows = await db.packBasket.findMany({ where: { orderId: { in: orderIds } }, select: { orderId: true, name: true } })
  return new Map(rows.filter((r) => r.orderId).map((r) => [r.orderId!, r.name]))
}

/** Zamówienie w koszyku o tej nazwie: `null` = nie ma takiego koszyka, `orderId: null` = pusty. */
export async function zawartoscKoszyka(db: Db, nazwa: string): Promise<{ nazwa: string; orderId: string | null } | null> {
  organizationIdOf(db)
  const n = nazwaKoszyka(nazwa)
  if (!n) return null
  const k = await db.packBasket.findFirst({ where: { name: n }, select: { name: true, orderId: true } })
  return k ? { nazwa: k.name, orderId: k.orderId } : null
}
