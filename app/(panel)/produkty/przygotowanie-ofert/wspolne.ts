// Produkty → „Przygotowane oferty” (3b-2): wspólne teksty statusu i nazwy kont dla listy i raportu.
import type { PrismaClient } from '@prisma/client'
import { loadChannelAccounts } from '@/lib/adaptery/konta'
import { kodKonta } from '@/lib/kanaly/konta'
import { NAZWA_KANALU, type KanalOferty } from '@/lib/oferty/publikacja'
import type { StatusPrzebiegu } from '@/lib/oferty/masowo'

export const STATUS_PRZEBIEGU: Record<StatusPrzebiegu, { tekst: string; ton: 'sukces' | 'ostrzezenie' | 'blad' | 'info' }> = {
  RUNNING: { tekst: 'w toku', ton: 'info' },
  OK: { tekst: 'zakończone', ton: 'sukces' },
  PARTIAL: { tekst: 'zakończone, części produktów nie udało się sprawdzić', ton: 'ostrzezenie' },
  FAILED: { tekst: 'nieudane', ton: 'blad' },
}

/** Kod konta → nazwa konta z ustawień (także wyłączonego); `brak:<kanał>` = kanał bez podłączonego konta. */
export async function nazwyKont(db: PrismaClient): Promise<(klucz: string, kanal: KanalOferty) => string> {
  const mapa = new Map((await loadChannelAccounts(db, { activeOnly: false })).map((a) => [kodKonta({ channel: a.channel, channelAccountId: a.channelAccountId }), a.name]))
  return (klucz, kanal) => (klucz.startsWith('brak:') ? `${NAZWA_KANALU[kanal]} (bez podłączonego konta)` : (mapa.get(klucz) ?? `${NAZWA_KANALU[kanal]} (konto usunięte)`))
}
