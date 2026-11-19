// dawna strona-spis /ustawienia przekierowuje na pierwszy dział, a listę ekranów pokazuje kolumna działów
// (`dzialyUstawien`). Testy uprawnień „link tylko z uprawnieniem” sprawdzają więc zakładki działów bieżącej sesji;
// wynik jako tekst z `href="…"`, żeby dotychczasowe asercje `toContain('href="/ustawienia/…"')` zostały bez zmian.
import { firmaMaBlWPanelu } from '@/lib/kanaly/firma'
import { requireSession } from '@/lib/panel/kontekst'
import { dzialyUstawien } from '@/lib/panel/nawigacja'

export async function wejsciaUstawien(): Promise<string> {
  const ctx = await requireSession()
  const dzialy = dzialyUstawien({ uprawnienia: ctx.permissions, maBl: await firmaMaBlWPanelu(ctx.db) })
  return dzialy.flatMap((d) => d.zakladki.map((z) => `href="${z.href}"`)).join('\n')
}
