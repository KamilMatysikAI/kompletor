// Status w BaseLinkerze dla zamówień zrealizowanych w Kompletorze. Po przejściu z BL importuje on dalej
// zamówienia ze wszystkich kanałów, ale zamówienia prowadzone w Kompletorze stoją tam w „Nowe zamówienia”. Ten moduł
// po wysłaniu (albo wydaniu przy odbiorze osobistym) w Kompletorze ustawia zamówieniu w BL status z ustawień firmy
// (np. „Kompletor”), jedną metodą zapisu `setOrderStatus` (klient `BaseLinkerStatusZapis`, zamknięta lista metod).
//
// Warunki, wszystkie naraz: wyłącznik firmy `Organization.settings.statusBl.wlaczony` (domyślnie wyłączony) i id
// statusu w ustawieniach (nie w kodzie), token BL firmy (bez niego zadanie w ogóle nie powstaje), konto zamówienia
// aktywne i w trybie pracy, para z BL (`Order.blOrderId`), pierwsze „Wysłane”/„Odebrane” w ostatnich `OKNO_DNI`,
// zamówienie nie zamknięte punktem cięcia (to obsłużył BL). Przed zapisem świeży odczyt z BL: status docelowy = koniec
// bez zapisu; status rodziny „obsłużone w BL” (wysłane, odebrane, anulowane…), paczka utworzona w BL albo faktura z BL
// = pominięte z powodem (nie nadpisujemy pracy BL), paczka i rozjazd dodatkowo jako alert dla biura.
// Idempotencja: zdarzenie zamówienia `STATUS_BL_USTAWIONY` albo `STATUS_BL_POMINIETY` zamyka sprawę na zawsze.
// Błąd: zdarzenie `STATUS_BL_BLAD` (ślad w historii zamówienia), ponowienie najwcześniej po `ODSTEP_PONOWIENIA_MS`,
// po `MAX_PROB` albo przy błędzie trwałym alert i koniec prób. Bez danych klientów: same numery, statusy i komunikaty BL.
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { blStatusFamily, type BlFamily } from '../cien/bl-porownanie'
import { fakturaZBl } from '../rdzen/faktura-bl'
import { alert } from '../rdzen/stan'
import { SourceError } from '../zrodla/http'
import { BEZ_ZAMKNIETYCH_PRZY_PRZEJSCIU } from './zamkniete-przy-przejsciu'

/** Zadanie workera (harmonogram: tylko firmy z tokenem BL). */
export const STATUS_BL_JOB = 'kanaly-status-bl'
export const ZDARZENIE_STATUS_BL = 'STATUS_BL_USTAWIONY'
export const ZDARZENIE_STATUS_BL_POMINIETY = 'STATUS_BL_POMINIETY'
export const ZDARZENIE_STATUS_BL_BLAD = 'STATUS_BL_BLAD'
export const ALERT_STATUS_BL = 'BL_STATUS_KOMPLETOR'
/** Zamówienia wysłane najwyżej tyle dni temu (starsze zostają, jak były). */
export const OKNO_DNI = 7
/** Najwyżej tyle zamówień na przebieg (≈ 3 żądania BL na zamówienie; limit BL 100/min, klient trzyma odstęp). */
export const NA_PRZEBIEG = 25
export const MAX_PROB = 3
export const ODSTEP_PONOWIENIA_MS = 15 * 60_000
/** Rodziny statusu BL, w których BL sam obsłużył zamówienie, oraz status o nierozpoznanej nazwie (własny status firmy): nie nadpisujemy. */
export const RODZINY_OBSLUZONE_W_BL: readonly BlFamily[] = ['ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE', 'ANULOWANE', 'REKLAMACJA', 'EBOOK', 'NIEZNANY']

export interface UstawieniaStatusuBl {
  wlaczony: boolean
  statusId: number | null
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const idStatusu = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,12}$/.test(v.trim()) ? Number(v.trim()) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Odczyt z `Organization.settings.statusBl`; brak pola albo zła wartość = wyłączone. */
export function parseStatusBl(settings: Prisma.JsonValue | null | undefined): UstawieniaStatusuBl {
  const s = obj(obj(settings)['statusBl'])
  const statusId = idStatusu(s['statusId'])
  return { wlaczony: s['wlaczony'] === true && statusId !== null, statusId }
}

export async function statusBlFirmy(db: PrismaClient): Promise<UstawieniaStatusuBl> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  return parseStatusBl(org?.settings ?? null)
}

/** Zapis z panelu: blokada wiersza firmy, tylko pole `statusBl`, ślad w AuditLog. Włączenie bez id statusu = błąd. */
export async function zapiszStatusBl(db: PrismaClient, nowe: { wlaczony: boolean; statusId: unknown }, actorId: string): Promise<UstawieniaStatusuBl> {
  const organizationId = organizationIdOf(db)
  const statusId = idStatusu(nowe.statusId)
  if (nowe.wlaczony && statusId === null) throw new Error('Podaj numer statusu z BaseLinkera (same cyfry), zanim włączysz.')
  const czyste: UstawieniaStatusuBl = { wlaczony: nowe.wlaczony === true, statusId }
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`SELECT settings FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    const settings = obj(rows[0]?.settings)
    const przed = parseStatusBl(rows[0]?.settings ?? null)
    if (przed.wlaczony === czyste.wlaczony && przed.statusId === czyste.statusId && settings['statusBl'] !== undefined) return
    await tx.organization.update({ where: { id: organizationId }, data: { settings: { ...settings, statusBl: { ...czyste } } as Prisma.InputJsonValue } })
    await tx.auditLog.create({ data: { entity: 'Organization.statusBl', entityId: organizationId, actorId, before: { ...przed }, after: { ...czyste } } })
  })
  return czyste
}

/** Klient BL: `BaseLinkerStatusZapis` (get* + setOrderStatus) albo atrapa w testach. */
export interface KlientStatusuBl {
  call<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
}

export interface StatystykiStatusuBl {
  kandydaci: number
  ustawione: number
  juzBylo: number
  pominiete: number
  bledy: number
  /** null = przebieg bez pracy (wyłączone, brak kont w pracy); inaczej powód zatrzymania całego przebiegu */
  stop: string | null
}

const AKTOR = 'system:status-bl'
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}
const krotko = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

/** Wybór zamówień do przebiegu (bez wywołań BL). Wynik bez zamówień z wyczerpanymi próbami i w odstępie po błędzie. */
export async function kandydaciStatusuBl(db: PrismaClient, now: Date): Promise<{ id: string; blOrderId: number; parentOrderId: string | null; channelNumber: string | null; externalId: string }[]> {
  const konta = await db.channelConfig.findMany({ where: { active: true, statusMode: 'PRACA' }, select: { channel: true, channelAccountId: true } })
  if (!konta.length) return []
  const od = new Date(now.getTime() - OKNO_DNI * 86_400_000)
  const rows = await db.order.findMany({
    where: {
      blOrderId: { not: null },
      status: { in: ['WYSLANE', 'ODEBRANE'] },
      OR: konta.map((k) => ({ channel: k.channel, channelAccountId: k.channelAccountId })),
      AND: [
        { events: { some: { kind: { in: ['WYSLANE', 'ODEBRANE'] }, createdAt: { gte: od } } } },
        { events: { none: { kind: { in: [ZDARZENIE_STATUS_BL, ZDARZENIE_STATUS_BL_POMINIETY] } } } },
        BEZ_ZAMKNIETYCH_PRZY_PRZEJSCIU,
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: NA_PRZEBIEG * 4,
    select: { id: true, blOrderId: true, parentOrderId: true, channelNumber: true, externalId: true },
  })
  if (!rows.length) return []
  const bledy = await db.orderEvent.groupBy({ by: ['orderId'], where: { orderId: { in: rows.map((r) => r.id) }, kind: ZDARZENIE_STATUS_BL_BLAD }, _count: { _all: true }, _max: { createdAt: true } })
  const poBledzie = new Map(bledy.map((b) => [b.orderId, b]))
  return rows
    .filter((r) => {
      const b = poBledzie.get(r.id)
      if (!b) return true
      if (b._count._all >= MAX_PROB) return false
      return !b._max.createdAt || now.getTime() - b._max.createdAt.getTime() >= ODSTEP_PONOWIENIA_MS
    })
    .slice(0, NA_PRZEBIEG)
    .map((r) => ({ ...r, blOrderId: r.blOrderId! }))
}

async function zdarzenie(db: PrismaClient, orderId: string, kind: string, data: Prisma.InputJsonValue, now: Date): Promise<void> {
  await db.orderEvent.create({ data: { orderId, kind, actorId: AKTOR, createdAt: now, data } })
}

/**
 * Jeden przebieg: kandydaci → świeży odczyt BL → `setOrderStatus` albo pominięcie z powodem. Błąd jednego zamówienia nie
 * zatrzymuje reszty. Wyłączone ustawienie = zero wywołań BL.
 */
export async function przebiegStatusuBl(db: PrismaClient, bl: KlientStatusuBl, ctx: { now?: Date; ustawienia?: UstawieniaStatusuBl } = {}): Promise<StatystykiStatusuBl> {
  const now = ctx.now ?? new Date()
  const st: StatystykiStatusuBl = { kandydaci: 0, ustawione: 0, juzBylo: 0, pominiete: 0, bledy: 0, stop: null }
  const u = ctx.ustawienia ?? (await statusBlFirmy(db))
  if (!u.wlaczony || u.statusId === null) return st
  const kandydaci = await kandydaciStatusuBl(db, now)
  st.kandydaci = kandydaci.length
  if (!kandydaci.length) return st

  // Status docelowy musi istnieć w BL (literówka w ustawieniach = alert i nic, zamiast błędów na każdym zamówieniu)
  const lista = await bl.call<{ statuses?: { id?: unknown; name?: unknown }[] }>('getOrderStatusList')
  const nazwy = new Map<number, string>()
  for (const s of lista.statuses ?? []) {
    const id = num(s.id)
    if (id !== null && typeof s.name === 'string') nazwy.set(id, s.name)
  }
  if (!nazwy.has(u.statusId)) {
    st.stop = `w BaseLinkerze nie ma statusu o numerze ${u.statusId}`
    await alert(db, ALERT_STATUS_BL, `status:${u.statusId}`, `Status w BaseLinkerze dla zamówień z Kompletora: ${st.stop}. Popraw numer: menu Przejście z BaseLinkera → Przeprowadzka z BaseLinkera, sekcja 6.`, `${ALERT_STATUS_BL}:brak-statusu:${u.statusId}`)
    return st
  }

  const zrobione = new Set<number>() // podzamówienia z tym samym zamówieniem BL w jednym przebiegu
  for (const k of kandydaci) {
    const nr = k.channelNumber ?? k.externalId
    try {
      if (zrobione.has(k.blOrderId)) {
        await zdarzenie(db, k.id, ZDARZENIE_STATUS_BL, { blOrderId: k.blOrderId, wynik: 'JUZ', statusId: u.statusId }, now)
        st.juzBylo++
        continue
      }
      const res = await bl.call<{ orders?: Record<string, unknown>[] }>('getOrders', { order_id: k.blOrderId, get_unconfirmed_orders: true })
      const o = (Array.isArray(res.orders) ? res.orders : []).find((y) => num(y?.['order_id']) === k.blOrderId)
      if (!o) {
        await zdarzenie(db, k.id, ZDARZENIE_STATUS_BL_POMINIETY, { blOrderId: k.blOrderId, powod: 'brak zamówienia w BaseLinkerze' }, now)
        st.pominiete++
        continue
      }
      const teraz = num(o['order_status_id'])
      if (teraz === u.statusId) {
        await zdarzenie(db, k.id, ZDARZENIE_STATUS_BL, { blOrderId: k.blOrderId, wynik: 'JUZ', statusId: u.statusId }, now)
        zrobione.add(k.blOrderId)
        st.juzBylo++
        continue
      }
      const nazwa = teraz !== null ? nazwy.get(teraz) ?? String(teraz) : '?'
      const rodzina = blStatusFamily(nazwa).family
      if (RODZINY_OBSLUZONE_W_BL.includes(rodzina)) {
        await zdarzenie(db, k.id, ZDARZENIE_STATUS_BL_POMINIETY, { blOrderId: k.blOrderId, powod: `BaseLinker prowadził zamówienie dalej (status „${nazwa}”)`, statusBl: teraz }, now)
        st.pominiete++
        continue
      }
      const paczki = await bl.call<{ packages?: unknown[] }>('getOrderPackages', { order_id: k.blOrderId })
      if (Array.isArray(paczki.packages) && paczki.packages.length) {
        await zdarzenie(db, k.id, ZDARZENIE_STATUS_BL_POMINIETY, { blOrderId: k.blOrderId, powod: `w BaseLinkerze jest przesyłka (${paczki.packages.length})`, statusBl: teraz }, now)
        await alert(db, ALERT_STATUS_BL, k.id, `Zamówienie ${nr}: wysłane w Kompletorze, a w BaseLinkerze ma też przesyłkę. Statusu „${nazwy.get(u.statusId)}” nie ustawiłem: sprawdź, czy nie poszło podwójnie.`, `${ALERT_STATUS_BL}:paczka:${k.id}`)
        st.pominiete++
        continue
      }
      const fakturaBl = await fakturaZBl(db, { id: k.id, blOrderId: k.blOrderId, parentOrderId: k.parentOrderId })
      if (fakturaBl) {
        await zdarzenie(db, k.id, ZDARZENIE_STATUS_BL_POMINIETY, { blOrderId: k.blOrderId, powod: 'faktura z BaseLinkera (zamówienie kończy BaseLinker)', statusBl: teraz }, now)
        st.pominiete++
        continue
      }
      await bl.call('setOrderStatus', { order_id: k.blOrderId, status_id: u.statusId })
      await zdarzenie(db, k.id, ZDARZENIE_STATUS_BL, { blOrderId: k.blOrderId, wynik: 'OK', statusId: u.statusId, poprzedni: teraz }, now)
      zrobione.add(k.blOrderId)
      st.ustawione++
    } catch (e) {
      st.bledy++
      const trwaly = e instanceof SourceError && !e.retryable
      try {
        const proby = (await db.orderEvent.count({ where: { orderId: k.id, kind: ZDARZENIE_STATUS_BL_BLAD } })) + 1
        await zdarzenie(db, k.id, ZDARZENIE_STATUS_BL_BLAD, { blOrderId: k.blOrderId, proba: proby, trwaly, blad: krotko(e) }, now)
        if (trwaly || proby >= MAX_PROB) {
          if (trwaly) await zdarzenie(db, k.id, ZDARZENIE_STATUS_BL_POMINIETY, { blOrderId: k.blOrderId, powod: `błąd trwały: ${krotko(e)}` }, now)
          await alert(db, ALERT_STATUS_BL, k.id, `Zamówienie ${nr}: nie udało się ustawić statusu w BaseLinkerze (${trwaly ? 'błąd trwały' : `${proby} próby`}): ${krotko(e)}. Kompletor nie ponawia; ustaw status ręcznie w BL.`, `${ALERT_STATUS_BL}:blad:${k.id}`)
        }
      } catch {
        // zapis śladu błędu też padł (baza): zamówienie wróci w następnym przebiegu, licznik prób bez zmian
      }
    }
  }
  return st
}
