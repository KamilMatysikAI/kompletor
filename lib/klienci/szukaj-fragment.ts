// Wyszukiwanie klienta fragmentem (formularz „Dodaj zamówienie”): nazwa, firma, e-mail, telefon albo NIP.
// Dane klientów leżą wyłącznie w szyfrogramie, więc nie ma indeksu po fragmencie: funkcja odszyfrowuje
// w pamięci serwera najnowsze rekordy firmy (do `PRZEJRZANE_MAX`) i porównuje fragment. Wymaga `klienci.dane`
// (sprawdzane tutaj, nie u wywołującego). Jeden wpis w dzienniku podglądów na zapytanie (`cel: WYSZUKIWANIE`,
// liczba trafień i identyfikatory zamówień, których dane pokazano: przeglądu), bez frazy. Wynik (dane do podstawienia w formularzu) wraca tylko do przeglądarki osoby z
// uprawnieniem; nie zapisuj go w logu, adresie strony ani w innej tabeli.
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import type { Env } from '../sekrety'
import { PODGLAD_AUDIT, uprawnieniaOsoby } from './odczyt'
import type { RekordKlienta } from './rekord'
import { BrakKluczaKlientow, kluczeKlientowZEnv, odszyfrujKlienta } from './szyfr'

export const PRZEJRZANE_MAX = 2000
export const TRAFIENIA_MAX = 10
export const FRAZA_MIN = 3

export type WynikFragmentu =
  | { stan: 'OK'; klienci: { orderId: string; rekord: RekordKlienta }[]; przejrzane: number }
  | { stan: 'ZA_KROTKA' }
  | { stan: 'BEZ_UPRAWNIEN' }
  | { stan: 'BRAK_KLUCZA' }

/** Tekst do porównania: małe litery, bez polskich znaków diakrytycznych i bez spacji na brzegach. */
export function normalizujTekst(v: string | null | undefined): string {
  return (v ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .trim()
}

/** Czy rekord pasuje do frazy: tekstowo (nazwa, firma, e-mail, nazwa do faktury) albo cyfrowo (telefon, NIP). */
export function pasuje(k: RekordKlienta, fraza: string): boolean {
  const f = normalizujTekst(fraza)
  if (!f) return false
  const teksty = [k.nabywca?.imieNazwisko, k.nabywca?.firma, k.dostawa?.imieNazwisko, k.dostawa?.firma, k.faktura?.nazwa, k.email].map(normalizujTekst)
  if (teksty.some((t) => t.includes(f))) return true
  const cyfry = fraza.replace(/\D/g, '')
  if (cyfry.length >= FRAZA_MIN && cyfry.length === fraza.replace(/[\s()+-]/g, '').length) {
    const nr = [k.telefon, k.faktura?.nip].map((x) => (x ?? '').replace(/\D/g, ''))
    if (nr.some((n) => n.includes(cyfry))) return true
  }
  return false
}

/** Ten sam klient w kilku zamówieniach = jeden wynik (najnowszy rekord): po e-mailu, telefonie, NIP-ie albo nazwie. */
function kluczKlienta(k: RekordKlienta): string {
  return (
    normalizujTekst(k.email) ||
    (k.telefon ?? '').replace(/\D/g, '') ||
    (k.faktura?.nip ?? '').replace(/\D/g, '') ||
    normalizujTekst(`${k.nabywca?.imieNazwisko ?? ''}|${k.nabywca?.firma ?? ''}`)
  )
}

export async function szukajKlientaFragmentem(db: PrismaClient, fraza: string, o: { actorId: string; env?: Env; przejrzaneMax?: number }): Promise<WynikFragmentu> {
  const p = await uprawnieniaOsoby(db, o.actorId)
  if (!p.has('klienci.dane')) return { stan: 'BEZ_UPRAWNIEN' }
  const f = String(fraza ?? '').slice(0, 120).trim()
  if (normalizujTekst(f).length < FRAZA_MIN) return { stan: 'ZA_KROTKA' }
  let ring
  try {
    ring = kluczeKlientowZEnv(o.env ?? process.env)
  } catch (e) {
    if (e instanceof BrakKluczaKlientow) return { stan: 'BRAK_KLUCZA' }
    throw e
  }
  const organizationId = organizationIdOf(db)
  const rows = await db.orderCustomer.findMany({
    where: { purgedAt: null },
    orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }],
    take: Math.min(o.przejrzaneMax ?? PRZEJRZANE_MAX, PRZEJRZANE_MAX),
    select: { orderId: true, ciphertext: true, iv: true, authTag: true, keyVersion: true },
  })
  const klienci: { orderId: string; rekord: RekordKlienta }[] = []
  const widziani = new Set<string>()
  for (const r of rows) {
    let k: RekordKlienta
    try {
      k = odszyfrujKlienta(ring, organizationId, r.orderId, r)
    } catch {
      continue // uszkodzony albo starym kluczem bez wersji: pomijamy jeden rekord, nie całe wyszukiwanie
    }
    if (!pasuje(k, f)) continue
    const kk = kluczKlienta(k)
    if (widziani.has(kk)) continue
    widziani.add(kk)
    klienci.push({ orderId: r.orderId, rekord: k })
    if (klienci.length >= TRAFIENIA_MAX) break
  }
  await db.auditLog.create({ data: { entity: PODGLAD_AUDIT, entityId: 'wyszukiwanie', actorId: o.actorId, after: { cel: 'WYSZUKIWANIE', zakres: 'PELNY', trafienia: klienci.length, zamowienia: klienci.map((k) => k.orderId) } } })
  return { stan: 'OK', klienci, przejrzane: rows.length }
}

export const ZAMOWIENIA_MAX = 200

export type WynikZamowienFragmentem = { stan: 'OK'; orderIds: string[]; przejrzane: number } | { stan: 'ZA_KROTKA' } | { stan: 'BEZ_UPRAWNIEN' } | { stan: 'BRAK_KLUCZA' }

/**
 * zamówienia klientów pasujących do fragmentu (lista zamówień → „Klient”). Jak `szukajKlientaFragmentem`,
 * ale bez łączenia klientów: każde pasujące zamówienie (do ZAMOWIENIA_MAX), bo lista pokazuje zamówienia, nie osoby.
 * Do przeglądarki wracają tylko identyfikatory zamówień, nie dane. Jeden wpis w dzienniku podglądów, bez frazy.
 */
export async function zamowieniaKlientaFragmentem(db: PrismaClient, fraza: string, o: { actorId: string; env?: Env; przejrzaneMax?: number }): Promise<WynikZamowienFragmentem> {
  const p = await uprawnieniaOsoby(db, o.actorId)
  if (!p.has('klienci.dane')) return { stan: 'BEZ_UPRAWNIEN' }
  const f = String(fraza ?? '').slice(0, 120).trim()
  if (normalizujTekst(f).length < FRAZA_MIN) return { stan: 'ZA_KROTKA' }
  let ring
  try {
    ring = kluczeKlientowZEnv(o.env ?? process.env)
  } catch (e) {
    if (e instanceof BrakKluczaKlientow) return { stan: 'BRAK_KLUCZA' }
    throw e
  }
  const organizationId = organizationIdOf(db)
  const rows = await db.orderCustomer.findMany({
    where: { purgedAt: null },
    orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }],
    take: Math.min(o.przejrzaneMax ?? PRZEJRZANE_MAX, PRZEJRZANE_MAX),
    select: { orderId: true, ciphertext: true, iv: true, authTag: true, keyVersion: true },
  })
  const orderIds: string[] = []
  for (const r of rows) {
    let k: RekordKlienta
    try {
      k = odszyfrujKlienta(ring, organizationId, r.orderId, r)
    } catch {
      continue
    }
    if (!pasuje(k, f)) continue
    orderIds.push(r.orderId)
    if (orderIds.length >= ZAMOWIENIA_MAX) break
  }
  await db.auditLog.create({ data: { entity: PODGLAD_AUDIT, entityId: 'wyszukiwanie', actorId: o.actorId, after: { cel: 'WYSZUKIWANIE', zakres: 'PELNY', lista: true, trafienia: orderIds.length } } })
  return { stan: 'OK', orderIds, przejrzane: rows.length }
}
