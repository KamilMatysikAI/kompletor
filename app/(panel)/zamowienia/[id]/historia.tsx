// Historia zmian karty zamówienia: zdarzenia i dziennik zmian na jednej osi czasu, filtr „Tylko ludzie”
// przez adres (`?historia=ludzie`, bez JavaScriptu). Bez danych klienta (lib/karta/historia.ts).
// sekcja zwijana jak „Informacje dodatkowe” w BL; otwarta, gdy adres ma filtr historii (`?historia=`).
import Link from 'next/link'
import { Karta } from '@/app/ui'
import type { DaneKarty } from '@/lib/karta/dane'
import { when } from '@/lib/panel/format'

export function Historia({ d, tylkoLudzie, otwarta }: { d: DaneKarty; tylkoLudzie: boolean; otwarta: boolean }) {
  const now = new Date()
  const id = d.o.id
  const ile = d.historia.length
  return (
    <Karta zwijana otwarta={otwarta} id="historia" className="kz-historia" tytul="Historia zmian" opis={ile ? `${ile} ${ile === 1 ? 'zdarzenie' : ile % 10 >= 2 && ile % 10 <= 4 && (ile % 100 < 12 || ile % 100 > 14) ? 'zdarzenia' : 'zdarzeń'}` : 'brak zdarzeń'}>
      <nav className="seg" aria-label="Filtr historii">
        <Link href={`/zamowienia/${id}?historia=wszystko#historia`} aria-current={!tylkoLudzie ? 'true' : undefined} className={!tylkoLudzie ? 'on' : ''}>
          Wszystko
        </Link>
        <Link href={`/zamowienia/${id}?historia=ludzie#historia`} aria-current={tylkoLudzie ? 'true' : undefined} className={tylkoLudzie ? 'on' : ''}>
          Tylko ludzie
        </Link>
      </nav>
      {ile === 0 ? (
        <p className="muted small">Brak zdarzeń.</p>
      ) : (
        <ul className="timeline kz-odstep-gora">
          {d.historia.map((e) => (
            <li key={e.id}>
              <span className="mono small muted">{when(e.kiedy, now)}</span> {e.opis} <span className="muted small">({e.kto})</span>
            </li>
          ))}
        </ul>
      )}
    </Karta>
  )
}
