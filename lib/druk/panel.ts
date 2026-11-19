// Druk z panelu: zlecenia z przycisków „Drukuj” (karty, lista wysyłkowa, etykieta próbna), stan stanowisk
// dla nagłówka /pakowanie i /stanowisko oraz status zlecenia do krótkiego odpytywania. Klient bazy zawsze z sesji (RLS).
//
// Karty: `drukujKarty` (lib/stanowisko/karty.ts) bez zmian — OrderCardPrint, plakietka NA SUCHO i pomijanie zamówień
// bez stanu i wysłanych zostają; z listy zamówień (`informacyjne: true`) takie dostają wydruk informacyjny. Woła ją dopiero rysowanie zlecenia, PO rezerwacji z kluczem kliknięcia, więc podwójny
// klik nie daje drugiego numeru wydruku (nowy numer unieważniłby kartę w koszyku).
import type { PrintJobStatus, PrismaClient } from '@prisma/client'
import { parseOrderIds, shippingListData, SHIPPING_LIST_LIMIT } from '@/lib/pakowanie/dane'
import { BladKart, drukujKarty } from '@/lib/stanowisko/karty'
import { idZamowien, MAX_ZAMOWIEN } from '@/lib/stanowisko/zamowienia'
import { listaWysylkowa } from '@/lib/wydruki/lista-wysylkowa'
import { etykietaZamowienia } from '@/lib/wysylka/etykieta-przewoznika'
import type { ZrodloEtykiety } from './etykieta'
import {
  agentDziala,
  bladCelu,
  drukarkiZBazy,
  opisCelu,
  przypisaniaStanowiska,
  rolaDlaTypu,
  roleZRaportu,
  routingStanowiska,
  TYPY_ZLECEN,
  type DrukarkaZRaportu,
  type Przypisanie,
  type TypZlecenia,
} from './role'
import { plikTestowy, typWydrukuTestowego } from './wydruk-testowy'
import { BladDruku, utworzZlecenie } from './zlecenia'

type Db = PrismaClient

export const WZOR_KLUCZA = /^[A-Za-z0-9_-]{16,64}$/

export interface StanowiskoPanelu {
  id: string
  code: string
  name: string
  agentDziala: boolean
  /** Minuty od ostatniego raportu stanu; null = nigdy. */
  minutOdRaportu: number | null
  wersjaAgenta: string | null
  drukarki: DrukarkaZRaportu[]
  role: string[]
  routing: Record<TypZlecenia, string>
  /** przypisanie każdego rodzaju wydruku (`stanowisko` = drukarka innego komputera). */
  przypisania: Record<TypZlecenia, Przypisanie>
  /** drukarki, których to stanowisko naprawdę używa (także innych komputerów), ze stanem i powodem błędu. */
  uzywane: UzywanaDrukarka[]
  /** false = na tym stanowisku nie ma (jeszcze) programu druku; drukuje wyłącznie na drukarkach innych komputerów. */
  maProgram: boolean
}

export interface UzywanaDrukarka {
  typy: TypZlecenia[]
  stanowiskoId: string
  /** Nazwa komputera z drukarką. */
  stanowisko: string
  rola: string
  /** true = drukarka tego samego stanowiska. */
  wlasna: boolean
  drukarka: DrukarkaZRaportu | null
  agentDziala: boolean
  minutOdRaportu: number | null
  /** Dlaczego zlecenie tego rodzaju nie powstanie (null = powstanie). */
  blad: string | null
}

const minutOd = (d: Date | null, now: Date) => (d ? Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60_000)) : null)

/**
 * Aktywne stanowiska firmy ze stanem drukarek (nagłówek, wybór stanowiska przy „Drukuj”). Z listą drukarek,
 * których każde stanowisko używa według przypisań, także na innych komputerach (wyłączone komputery czytamy tylko po
 * to, żeby nazwać powód błędu).
 */
export async function stanowiskaDlaPanelu(db: Db, now = new Date()): Promise<StanowiskoPanelu[]> {
  const wszystkie = await db.printStation.findMany({
    orderBy: [{ name: 'asc' }, { code: 'asc' }],
    select: { id: true, code: true, name: true, printers: true, lastReportAt: true, agentVersion: true, routing: true, disabledAt: true, tokenHash: true },
  })
  const poId = new Map(wszystkie.map((s) => [s.id, s]))
  return wszystkie
    .filter((s) => !s.disabledAt)
    .map((s) => {
      const przypisania = przypisaniaStanowiska(s.routing, s.id)
      const uzywane: UzywanaDrukarka[] = []
      for (const t of TYPY_ZLECEN) {
        const p = przypisania[t]
        const cel = p.stanowisko ? (poId.get(p.stanowisko) ?? null) : s
        const id = cel?.id ?? p.stanowisko!
        const byla = uzywane.find((u) => u.stanowiskoId === id && u.rola === p.rola)
        if (byla) {
          byla.typy.push(t)
          continue
        }
        const blad = !p.stanowisko
          ? (() => {
              const r = rolaDlaTypu(s, t)
              return 'blad' in r ? r.blad : null
            })()
          : bladCelu(s.name, t, cel && { ...cel, maToken: !!cel.tokenHash }, p.rola, now)
        uzywane.push({
          typy: [t],
          stanowiskoId: id,
          stanowisko: cel?.name ?? 'nieznany komputer',
          rola: p.rola,
          wlasna: !p.stanowisko,
          drukarka: cel ? (drukarkiZBazy(cel.printers).find((d) => d.rola === p.rola) ?? null) : null,
          agentDziala: cel ? agentDziala(cel.lastReportAt, now) : false,
          minutOdRaportu: cel ? minutOd(cel.lastReportAt, now) : null,
          blad,
        })
      }
      return {
        id: s.id,
        code: s.code,
        name: s.name,
        agentDziala: agentDziala(s.lastReportAt, now),
        minutOdRaportu: minutOd(s.lastReportAt, now),
        wersjaAgenta: s.agentVersion,
        drukarki: drukarkiZBazy(s.printers),
        role: roleZRaportu(s.printers),
        routing: routingStanowiska(s.routing),
        przypisania,
        uzywane,
        maProgram: !!s.lastReportAt,
      }
    })
}

export interface ZlecenieZPanelu {
  typ: 'karta' | 'lista' | 'etykieta'
  ids: string[]
  stationId: string
  klucz: string
  /** karty z listy zamówień — zamówienia bez karty do zbierania dostają wydruk informacyjny zamiast pominięcia. */
  informacyjne?: boolean
}

/** Treść POST /api/wydruki/zlecenia → dane zlecenia albo komunikat błędu (400). */
export function parsujZlecenieZPanelu(v: unknown): ZlecenieZPanelu | { blad: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { blad: 'Treść żądania: { typ, z, stanowisko, klucz }' }
  const o = v as Record<string, unknown>
  if (o.typ !== 'karta' && o.typ !== 'lista' && o.typ !== 'etykieta') return { blad: 'Typ wydruku: karta, lista albo etykieta' }
  if (typeof o.stanowisko !== 'string' || !/^[a-z0-9]{1,40}$/i.test(o.stanowisko)) return { blad: 'Wybierz stanowisko druku' }
  if (typeof o.klucz !== 'string' || !WZOR_KLUCZA.test(o.klucz)) return { blad: 'Brak klucza kliknięcia — odśwież stronę' }
  const surowe = Array.isArray(o.z) ? o.z.filter((x): x is string => typeof x === 'string').join(',') : typeof o.z === 'string' ? o.z : ''
  const limit = o.typ === 'lista' ? SHIPPING_LIST_LIMIT : o.typ === 'karta' ? MAX_ZAMOWIEN : 1
  const ids = o.typ === 'lista' ? parseOrderIds(surowe).ids : idZamowien(surowe)
  if (!ids.length) return { blad: 'Brak zamówień do wydruku' }
  if (surowe.split(',').filter((x) => x.trim()).length > limit) return { blad: `Najwyżej ${limit} zamówień w jednym wydruku` }
  return { typ: o.typ, ids, stationId: o.stanowisko, klucz: o.klucz, ...(o.typ === 'karta' && o.informacyjne === true ? { informacyjne: true } : {}) }
}

export interface OdpowiedzZlecenia {
  zlecenie: StatusZlecenia
  istnialo: boolean
  /** Numery zamówień pominiętych w kartach (bez stanu, wysłane, anulowane). */
  pominiete: string[]
  /** numery zamówień wydrukowanych informacyjnie (bez kodu karty); tylko przy `informacyjne`. */
  informacyjne: string[]
}

/** Zlecenie z panelu: rezerwacja → rysowanie (karty / lista / etykieta próbna) → kolejka agenta. */
export async function zlecZPanelu(
  db: Db,
  kto: { userId: string; nazwa: string },
  z: ZlecenieZPanelu,
  opcje: { now?: Date; etykiety?: ZrodloEtykiety } = {},
): Promise<OdpowiedzZlecenia> {
  const now = opcje.now ?? new Date()
  const typ: TypZlecenia = z.typ
  const w = await utworzZlecenie<{ pominiete: string[]; informacyjne?: string[] }>(db, {
    stationId: z.stationId,
    typ,
    zrodlo: 'PANEL',
    klucz: z.klucz,
    kto: kto.userId,
    orderIds: z.ids,
    now,
    rysuj: async () => {
      if (z.typ === 'karta') {
        // BladKart niesie komunikat dla człowieka; utworzZlecenie przepuszcza do panelu tylko BladDruku.
        const { pdf, wydruki, pominiete, informacyjne } = await drukujKarty(db, z.ids, { userId: kto.userId, nazwa: kto.nazwa }, now, { informacyjne: z.informacyjne === true }).catch((e: unknown) => {
          throw e instanceof BladKart ? new BladDruku(e.message, e.status) : e
        })
        const opis = [wydruki.length ? `Karty: ${wydruki.map((x) => x.kod).join(', ')}` : null, informacyjne.length ? `Wydruk informacyjny: ${informacyjne.length}` : null].filter(Boolean).join(' · ')
        return { pliki: { pdf }, opis, dodatkowe: { pominiete: pominiete.map((p) => p.numer), informacyjne: informacyjne.map((p) => p.numer) } }
      }
      if (z.typ === 'lista') {
        const dane = await shippingListData(db, z.ids, { now, drukujacy: kto.nazwa })
        if (!dane) throw new BladDruku('Brak zamówień do wydruku', 404)
        return { pliki: { pdf: await listaWysylkowa(dane) }, opis: `Lista wysyłkowa: ${z.ids.length} zam.` }
      }
      // etykieta przewoźnika, gdy zamówienie ma utworzoną przesyłkę; atrapa próbna tylko bez przesyłki
      const e = await (opcje.etykiety ?? etykietaZamowienia).etykieta(db, z.ids[0]!, now)
      return { pliki: { pdf: e.pdf, zpl: e.zpl }, opis: e.opis }
    },
  })
  return { zlecenie: await statusZlecenia(db, w.zlecenie.id), istnialo: w.istnialo, pominiete: w.dodatkowe?.pominiete ?? [], informacyjne: w.dodatkowe?.informacyjne ?? [] }
}

export interface StatusZlecenia {
  id: string
  status: PrintJobStatus
  typ: TypZlecenia
  zrodlo: string
  rola: string
  stanowisko: string
  /** gdzie wychodzi wydruk, np. „Komputer główny, A4” (komputer z drukarką, nie wybrane stanowisko). */
  cel: string
  komunikat: string | null
  drukarka: string | null
  opis: string | null
  utworzono: string
  /** Zlecenie zapasowe utworzone po awarii (inna drukarka) i jego stan. */
  zapas: { id: string; status: PrintJobStatus; rola: string; komunikat: string | null } | null
}

/** Stan zlecenia do odpytywania z panelu; brak (albo cudze — RLS) = BladDruku 404. */
export async function statusZlecenia(db: Db, id: string): Promise<StatusZlecenia> {
  const s = await statusZleceniaLubNull(db, id)
  if (!s) throw new BladDruku('Nie znaleziono zlecenia', 404)
  return s
}

export async function statusZleceniaLubNull(db: Db, id: string): Promise<StatusZlecenia | null> {
  const j = await db.printJob.findUnique({
    where: { id },
    select: {
      id: true, status: true, type: true, source: true, role: true, resultMessage: true, resultPrinter: true, summary: true, createdAt: true,
      station: { select: { name: true } },
      fallback: { select: { id: true, status: true, role: true, resultMessage: true } },
    },
  })
  if (!j) return null
  return {
    id: j.id,
    status: j.status,
    typ: j.type,
    zrodlo: j.source,
    rola: j.role,
    stanowisko: j.station.name,
    cel: opisCelu(j.station.name, j.role),
    komunikat: j.resultMessage,
    drukarka: j.resultPrinter,
    opis: j.summary,
    utworzono: j.createdAt.toISOString(),
    zapas: j.fallback ? { id: j.fallback.id, status: j.fallback.status, rola: j.fallback.role, komunikat: j.fallback.resultMessage } : null,
  }
}

/** Ostatnie zlecenia firmy (Ustawienia → Druk): bez bajtów plików. */
export async function ostatnieZlecenia(db: Db, ile = 20) {
  return db.printJob.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: ile,
    select: {
      id: true, status: true, type: true, source: true, role: true, format: true, copies: true, summary: true, resultMessage: true,
      resultPrinter: true, createdAt: true, reportedAt: true, fallbackOfId: true, station: { select: { name: true, code: true } },
    },
  })
}

/** „Wydruk testowy” na jedną drukarkę stanowiska (rola z ostatniego raportu), bez danych zamówień. */
export async function wydrukTestowy(db: Db, stationId: string, rola: string, kto: string, now = new Date()): Promise<StatusZlecenia> {
  const st = await db.printStation.findUnique({ where: { id: stationId }, select: { name: true, code: true, printers: true } })
  if (!st) throw new BladDruku('Nie znaleziono stanowiska — odśwież stronę', 404)
  const drukarka = drukarkiZBazy(st.printers).find((d) => d.rola === rola)?.nazwa
  const w = await utworzZlecenie(db, {
    stationId,
    typ: typWydrukuTestowego(rola),
    zrodlo: 'TEST',
    rola,
    kto,
    now,
    rysuj: async () => ({
      pliki: await plikTestowy({ stanowisko: st.name, kod: st.code, rola, ...(drukarka ? { drukarka } : {}), data: now }),
      opis: `Wydruk testowy: ${rola}`,
    }),
  })
  return statusZlecenia(db, w.zlecenie.id)
}
