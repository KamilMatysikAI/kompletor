// Ostatni stan przesyłki u przewoźnika do pokazania człowiekowi i w API (19.11.2026): z ostatniego zdarzenia
// PRZESYLKA_STATUS zamówienia (zapisuje je śledzenie, lib/pakowanie/wyslane-po-przyjezdzie.ts). Bez danych klienta:
// kod przewoźnika, opis statusu (oczyszczony przy odczycie) i chwila zapisu.
import type { PrismaClient } from '@prisma/client'

export interface StatusKuriera {
  /** Surowy kod przewoźnika. */
  status: string
  /** Opis po ludzku od przewoźnika; null = przewoźnik go nie podał (wtedy pokazujemy `nazwa`). */
  opis: string | null
  /** PRZED_NADANIEM | PRZEKAZANA | DORECZONA | NIEZNANY */
  stan: string
  /** Tekst do pokazania w panelu: opis przewoźnika albo nazwa stanu. */
  nazwa: string
  /**
   * stały tekst wyliczony ze stanu (bez opisu przewoźnika, który może nieść nazwisko, adres albo
   * telefon odbiorcy). Tylko to pole idzie na zewnątrz (API v1, MCP).
   */
  nazwaStanu: string
  /** Kiedy Kompletor zobaczył ten status. */
  kiedy: Date
}

export const NAZWA_STANU: Record<string, string> = { PRZED_NADANIEM: 'Etykieta utworzona, paczka czeka na kuriera', PRZEKAZANA: 'U przewoźnika, w drodze', DORECZONA: 'Doręczona', NIEZNANY: 'Status nierozpoznany' }

export async function statusyKuriera(db: PrismaClient, orderIds: string[]): Promise<Map<string, StatusKuriera>> {
  const wynik = new Map<string, StatusKuriera>()
  if (!orderIds.length) return wynik
  // Dodatek informacyjny: błąd odczytu nie może zablokować karty zamówienia ani API (ślad w logu).
  let rows: { orderId: string; status: string | null; opis: string | null; stan: string | null; createdAt: Date }[] = []
  try {
    rows = await db.$queryRaw<{ orderId: string; status: string | null; opis: string | null; stan: string | null; createdAt: Date }[]>`
      SELECT DISTINCT ON ("orderId") "orderId", data->>'status' AS status, data->>'opis' AS opis, data->>'stan' AS stan, "createdAt"
      FROM "OrderEvent"
      WHERE "orderId" = ANY(${orderIds}::text[]) AND kind = 'PRZESYLKA_STATUS'
      ORDER BY "orderId", "createdAt" DESC, id DESC`
  } catch (e) {
    console.error(`[status-kuriera] odczyt nieudany: ${e instanceof Error ? e.name : 'błąd'}`)
    return wynik
  }
  for (const r of rows) {
    if (!r.status) continue
    const stan = r.stan && r.stan in NAZWA_STANU ? r.stan : 'NIEZNANY'
    const opis = r.opis ? String(r.opis).slice(0, 120) : null
    wynik.set(r.orderId, { status: String(r.status).slice(0, 60), opis, stan, nazwa: opis ?? NAZWA_STANU[stan]!, nazwaStanu: NAZWA_STANU[stan]!, kiedy: r.createdAt })
  }
  return wynik
}
