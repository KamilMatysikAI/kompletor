// Test zakresu przesyłek Allegro: `npm run cien -- allegro-wysylam-test [--konto <id>]` (w obrazie:
// `node dist/cien.cjs allegro-wysylam-test`). Tworzy adapter `allegro.wysylam.v1` na koncie ALLEGRO firmy (ta sama
// para tokenów co `allegro.v1`) i drukuje wynik `testConnection`: jedno GET `shipment-management/shipments/{UUID}`.
// Nic nie tworzy. Nigdy nie wypisuje tokenów ani Client Secret (komunikaty adaptera ich nie niosą).
import type { PrismaClient } from '@prisma/client'
import type { AdapterRegistry } from '../lib/adaptery/rejestr'
import type { SecretSource } from '../lib/sekrety'
import { createWysylamAdapter } from '../lib/wysylka/allegro-konto'
import type { FetchLike } from '../lib/zrodla/http'

export interface WysylamTestOpts {
  channelAccountId?: string
  registry: AdapterRegistry
  src: SecretSource
  fetch?: FetchLike
  out?: (line: string) => void
}

/** Kod wyjścia: 0 = zakres przesyłek działa, 1 = test nieudany, 2 = konfiguracja (brak konta, sekretu). */
export async function allegroWysylamTest(db: PrismaClient, o: WysylamTestOpts): Promise<number> {
  const out = o.out ?? ((l: string) => console.log(l))
  let adapter
  try {
    adapter = await createWysylamAdapter(db, o.registry, o.channelAccountId, o.src, { fetch: o.fetch })
  } catch (e) {
    out(`[allegro-wysylam] nie da się utworzyć adaptera — ${e instanceof Error ? e.message : 'błąd'}`)
    return 2
  }
  const t = await adapter.testConnection()
  out(`[allegro-wysylam] ${adapter.manifest.adapterKey} (${o.channelAccountId ? `ALLEGRO/${o.channelAccountId}` : 'konto Allegro firmy'}): ${t.ok ? 'OK' : 'BŁĄD'} — ${t.message}`)
  return t.ok ? 0 : 1
}
