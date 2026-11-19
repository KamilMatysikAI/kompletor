// wspólny układ ekranów ustawień: druga kolumna z działami i zakładki działu (`_dzialy/uklad.tsx`).
// Działy i zakładki z drzewa nawigacji (`dzialyUstawien`, pole `dzial`), wg uprawnień osoby i BL firmy. Sesja przez
// requireLayoutSession (bez przekierowania hasła startowego): przy haśle startowym układ oddaje sam ekran
// zmiany hasła, bez kolumny (szkielet panelu i tak jest wtedy okrojony). Każdy ekran sprawdza sesję i uprawnienie sam.
import type { ReactNode } from 'react'
import { firmaMaBlWPanelu } from '@/lib/kanaly/firma'
import { requireLayoutSession } from '@/lib/panel/kontekst'
import { dzialyUstawien } from '@/lib/panel/nawigacja'
import { UkladUstawien } from './_dzialy/uklad'
import './_dzialy/ustawienia.css'

export default async function UstawieniaLayout({ children }: { children: ReactNode }) {
  const ctx = await requireLayoutSession()
  if (ctx.mustChangePassword) return children
  const dzialy = dzialyUstawien({ uprawnienia: ctx.permissions, maBl: await firmaMaBlWPanelu(ctx.db) })
  return <UkladUstawien dzialy={dzialy}>{children}</UkladUstawien>
}
