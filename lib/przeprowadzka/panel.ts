// Ekran Ustawienia → Przeprowadzka z BaseLinkera: tylko odczyt ostatniego przebiegu PRZEPROWADZKA
// klientem firmy z sesji (RLS; klient systemowy odrzucony). Uruchamiania z panelu nie ma — ekran podaje polecenie.
import type { ImportStatus, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { RODZAJ_PRZEBIEGU } from './zapis'

export const LIMIT_SPRAW = 200

export interface SprawaDoDecyzji {
  rodzaj: string
  ref: string
  tresc: string
}

export interface PrzeprowadzkaPanel {
  ostatni: {
    id: string
    status: ImportStatus
    start: Date
    koniec: Date | null
    blad: string | null
    liczby: Record<string, number | string | null>
  } | null
  przebiegow: number
  sprawy: SprawaDoDecyzji[]
  sprawWszystkich: number
}

/** Rodzaje ImportIssue przeprowadzki po polsku (ekran i raport). */
export const RODZAJ_SPRAWY: Record<string, string> = {
  'decyzja:status': 'Status BL',
  'decyzja:przewoznik': 'Metoda dostawy',
  'decyzja:zrodlo': 'Źródło bez adaptera',
  'decyzja:reguly': 'Reguły przewoźników',
  'decyzja:oferta': 'Zamówienie z pozycją bez powiązania',
  zamowienie: 'Zamówienie nie przeszło',
}

export async function przeprowadzkaPanel(db: PrismaClient): Promise<PrzeprowadzkaPanel> {
  organizationIdOf(db)
  const [ostatni, przebiegow] = await Promise.all([
    db.importRun.findFirst({ where: { kind: RODZAJ_PRZEBIEGU }, orderBy: { startedAt: 'desc' } }),
    db.importRun.count({ where: { kind: RODZAJ_PRZEBIEGU } }),
  ])
  if (!ostatni) return { ostatni: null, przebiegow, sprawy: [], sprawWszystkich: 0 }
  const where = { runId: ostatni.id, OR: [{ kind: { startsWith: 'decyzja:' } }, { kind: 'zamowienie' }] }
  const [rows, sprawWszystkich] = await Promise.all([
    db.importIssue.findMany({ where, orderBy: [{ kind: 'asc' }, { ref: 'asc' }], take: LIMIT_SPRAW, select: { kind: true, ref: true, message: true } }),
    db.importIssue.count({ where }),
  ])
  const stats = ostatni.stats && typeof ostatni.stats === 'object' && !Array.isArray(ostatni.stats) ? (ostatni.stats as Record<string, number | string | null>) : {}
  return {
    ostatni: { id: ostatni.id, status: ostatni.status, start: ostatni.startedAt, koniec: ostatni.finishedAt, blad: ostatni.error, liczby: stats },
    przebiegow,
    sprawy: rows.map((r) => ({ rodzaj: r.kind, ref: r.ref, tresc: r.message })),
    sprawWszystkich,
  }
}
