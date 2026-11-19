// Ustawienia (w działach z zakładkami): samo „/ustawienia” przekierowuje na pierwszą zakładkę
// pierwszego działu, który osoba widzi (właściciel: Kanały sprzedaży; osoba bez uprawnienia ustawień: Zmiana hasła).
// Dawna strona-spis 17 pozycji zniknęła: tę samą listę pokazuje kolumna działów (`layout.tsx`).
import { redirect } from 'next/navigation'
import { firmaMaBlWPanelu } from '@/lib/kanaly/firma'
import { requireSession } from '@/lib/panel/kontekst'
import { pierwszyAdresUstawien } from '@/lib/panel/nawigacja'

export const metadata = { title: 'Ustawienia' }

export default async function Ustawienia() {
  const ctx = await requireSession()
  redirect(pierwszyAdresUstawien({ uprawnienia: ctx.permissions, maBl: await firmaMaBlWPanelu(ctx.db) }))
}
