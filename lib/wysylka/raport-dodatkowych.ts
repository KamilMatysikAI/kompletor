// Raport dodatkowych przesyłek (dosyłki, paczki zastępcze, drugie paczki) w okresie: liczba i suma kosztu netto
// wpisanego ręcznie w oknie „Dodaj przesyłkę”, osobno dla każdego rodzaju, oraz liczba przesyłek bez wpisanego kosztu.
// Liczy przesyłki utworzone u przewoźnika (UTWORZONA; anulowane się nie liczą), po dacie
// utworzenia w czasie polskim. Kosztu głównych przesyłek Kompletor nie zna (przewoźnicy nie zwracają ceny), więc to
// raport kosztów dodatkowych, nie wszystkich etykiet. Tylko odczyt; dane firmy przez klienta z RLS.
import type { PrismaClient } from '@prisma/client'
import { addDays, fromWarsaw, type IsoDay } from '@/lib/rdzen/kalendarz'
import { jestRodzajDodatkowej, NAZWA_RODZAJU, RODZAJE_DODATKOWEJ, type RodzajDodatkowej } from './dodatkowa'

export interface PozycjaRaportuDodatkowych {
  rodzaj: RodzajDodatkowej
  nazwa: string
  liczba: number
  /** suma wpisanych kosztów netto w zł (2 miejsca) */
  kosztNetto: number
  /** ile z nich bez wpisanego kosztu */
  bezKosztu: number
}

export interface RaportDodatkowych {
  od: IsoDay
  do: IsoDay
  rodzaje: PozycjaRaportuDodatkowych[]
  razem: { liczba: number; kosztNetto: number; bezKosztu: number }
}

const grosze = (v: unknown): number => Math.round(Number(v ?? 0) * 100)

/** Zakres `od`–`do` włącznie (dni w czasie polskim). */
export async function raportDodatkowych(db: PrismaClient, od: IsoDay, doDnia: IsoDay): Promise<RaportDodatkowych> {
  const where = {
    extraNo: { gte: 1 },
    createdAt: { gte: fromWarsaw(od, 0), lt: fromWarsaw(addDays(doDnia, 1), 0) },
    state: 'UTWORZONA' as const,
  }
  const rows = await db.shipment.groupBy({ by: ['extraKind'], where, _count: { _all: true, extraCostNet: true }, _sum: { extraCostNet: true } })
  const mapa = new Map<RodzajDodatkowej, { liczba: number; grosze: number; bezKosztu: number }>()
  for (const r of rows) {
    const rodzaj: RodzajDodatkowej = r.extraKind && jestRodzajDodatkowej(r.extraKind) ? r.extraKind : 'DODATKOWA'
    const m = mapa.get(rodzaj) ?? { liczba: 0, grosze: 0, bezKosztu: 0 }
    m.liczba += r._count._all
    m.grosze += grosze(r._sum.extraCostNet)
    m.bezKosztu += r._count._all - r._count.extraCostNet
    mapa.set(rodzaj, m)
  }
  const rodzaje = (Object.keys(RODZAJE_DODATKOWEJ) as RodzajDodatkowej[])
    .filter((k) => mapa.has(k))
    .map((k) => ({ rodzaj: k, nazwa: NAZWA_RODZAJU[k], liczba: mapa.get(k)!.liczba, kosztNetto: mapa.get(k)!.grosze / 100, bezKosztu: mapa.get(k)!.bezKosztu }))
  const razem = rodzaje.reduce((a, r) => ({ liczba: a.liczba + r.liczba, grosze: a.grosze + Math.round(r.kosztNetto * 100), bezKosztu: a.bezKosztu + r.bezKosztu }), { liczba: 0, grosze: 0, bezKosztu: 0 })
  return { od, do: doDnia, rodzaje, razem: { liczba: razem.liczba, kosztNetto: razem.grosze / 100, bezKosztu: razem.bezKosztu } }
}
