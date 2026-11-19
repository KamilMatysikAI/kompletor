// Pusty stan stanowiska pakowania (przegląd 06.11: „brak wskazówki co dalej, gdy nie ma czytnika”):
// kilka pierwszych zamówień z kolejki pakowania do kliknięcia i przykład kodu karty z przedrostka konta firmy.
// Klient bazy firmy z sesji (RLS).
import type { PrismaClient } from '@prisma/client'
import { packingQueue } from '@/lib/pakowanie/dane'
import { accounts } from '@/lib/panel/dane'
import { przedrostekKodu } from './kod'

export interface Nastepne {
  id: string
  numer: string
  przewoznik: string
  tryb: 'CIEN' | 'PRACA'
  koszyk: string | null
  pozycji: number
}

/** Pierwsze niespakowane zamówienia kolejki (kolejność kurierów jak w Pakowaniu): konta aktywne, a bez nich próbne. */
export async function nastepneDoSpakowania(db: PrismaClient, ile = 8): Promise<{ nastepne: Nastepne[]; przykladKodu: string }> {
  const accs = await accounts(db)
  const praca = accs.some((a) => a.active && a.statusMode === 'PRACA')
  const q = await packingQueue(db, { tab: praca ? 'naprawde' : 'na_sucho', zone: 'wszystkie', page: 1, accounts: accs })
  const nastepne: Nastepne[] = []
  for (const g of q.groups) {
    for (const o of g.orders) {
      if (o.status === 'SPAKOWANE' || o.cwiczenie === 'SPAKOWANE' || nastepne.length >= ile) continue
      nastepne.push({ id: o.id, numer: o.number, przewoznik: g.label, tryb: o.mode, koszyk: o.koszyk, pozycji: o.lines.length })
    }
  }
  const konto = accs.find((a) => a.active) ?? accs[0]
  return { nastepne, przykladKodu: `${konto ? przedrostekKodu(konto.channel, konto.name) : 'SK'}48213/1` }
}
