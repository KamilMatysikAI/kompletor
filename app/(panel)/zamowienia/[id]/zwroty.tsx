// Sekcja „Zwroty i reklamacje” karty zamówienia: zwroty zamówienia ze statusem jak w BL
// i linkiem do karty zwrotu. „Stwórz zwrot” i „Zgłoś reklamację” są w menu „Więcej” w nagłówku (jedno miejsce);
// sekcja pokazuje się, gdy zamówienie ma zwroty.
import Link from 'next/link'
import type { ReturnStatus } from '@prisma/client'
import { Sekcja } from '@/app/ui'
import type { DaneKarty } from '@/lib/karta/dane'
import { when } from '@/lib/panel/format'
import { RODZAJ_ZWROTU, STATUS_ZWROTU } from '@/lib/zwroty/statusy'

export function Zwroty({ d }: { d: DaneKarty }) {
  if (d.zwroty.length === 0) return null
  const now = new Date()
  return (
    <Sekcja
      id="zwroty"
      tytul="Zwroty i reklamacje"
      akcje={
        <Link className="small" href={`/zwroty?zamowienie=${d.o.id}`}>
          Otwórz w zwrotach
        </Link>
      }
    >
      <ul className="timeline">
        {d.zwroty.map((z) => (
          <li key={z.id}>
            <span className="mono small muted">{when(z.createdAt, now)}</span> <Link href={`/zwroty/${z.id}`}>{RODZAJ_ZWROTU[z.kind]}</Link>: {STATUS_ZWROTU[z.status as ReturnStatus]}
            {z.moneyRefundedAt ? <span className="muted small"> · pieniądze zwrócone</span> : null}
          </li>
        ))}
      </ul>
    </Sekcja>
  )
}
