// Stanowisko pakowania: pełny ekran bez menu panelu — komputer z ekranem dotykowym i skanerem kart.
// Sesję sprawdza tu requireLayoutSession (bez przekierowania hasła startowego), a strona jeszcze raz sama
// przez requirePermission (z uprawnieniem pakowanie.stanowisko; ona też odsyła na zmianę hasła startowego).
import type { ReactNode } from 'react'
import { requireLayoutSession } from '@/lib/panel/kontekst'
import './stanowisko.css'

export const dynamic = 'force-dynamic'

export default async function StanowiskoLayout({ children }: { children: ReactNode }) {
  await requireLayoutSession()
  return <div className="st-root">{children}</div>
}
