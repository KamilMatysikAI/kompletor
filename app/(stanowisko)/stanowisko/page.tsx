// Ekran stanowiska pakowania: pole skanu karty albo koszyka, sesja zamówień (`?z=<id,id…>`
// z kolejki pakowania albo ze skanów) i okno pakowania. Pusta sesja: „Następne do spakowania” z kolejki.
import { requirePermission } from '@/lib/panel/kontekst'
import { sesjaZamowien } from '@/lib/stanowisko/cwiczenie'
import { nastepneDoSpakowania } from '@/lib/stanowisko/nastepne'
import { ustawieniaStanowiska } from '@/lib/stanowisko/ustawienia'
import { idZamowien } from '@/lib/stanowisko/zamowienia'
import { Stanowisko } from './stanowisko'

export const metadata = { title: 'Stanowisko pakowania' }

export default async function StanowiskoPage({ searchParams }: { searchParams: Promise<{ z?: string | string[] }> }) {
  const ctx = await requirePermission('pakowanie.stanowisko')
  const [sesja, ustawienia, { nastepne, przykladKodu }] = await Promise.all([sesjaZamowien(ctx.db, idZamowien((await searchParams).z)), ustawieniaStanowiska(ctx.db), nastepneDoSpakowania(ctx.db)])
  return <Stanowisko sesjaStart={sesja} ustawienia={ustawienia} kto={ctx.user.name} firma={ctx.organization.name} nastepne={nastepne} przykladKodu={przykladKodu} />
}
