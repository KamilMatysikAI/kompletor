// sekcja z nagłówkiem w pasku (wzór układu: TwojOMS, MIT; kod własny). Tytuł małymi wersalikami na szarym
// pasku przy górnej krawędzi karty, po prawej dodatkowe akcje i jedno „Edytuj”. Edycja sekcji jest w adresie strony
// (np. `?edytuj=pozycje`), więc działa bez JavaScriptu: „Edytuj” prowadzi do trybu edycji, „Zakończ edycję” z powrotem
// do odczytu. Gdy edycja jest niedostępna (konto w podglądzie, blokada edycji), „Edytuj” jest widoczne i nieaktywne
// z powodem (zasada fal: funkcja widoczna, nie ukryta); powód widocznym tekstem raz, w sekcji (`opisId`) albo dla czytnika. Bez hooków, działa w komponentach serwerowych.
import Link from 'next/link'
import type { ReactNode } from 'react'

/** Stan „Edytuj” w nagłówku: odczyt (link do edycji), edycja (link z powrotem do odczytu), nieaktywne z powodem. */
export type EdycjaSekcji = { tryb: 'odczyt'; href: string; etykieta?: string } | { tryb: 'edycja'; href: string } | { tryb: 'niedostepna'; powod: string; etykieta?: string; opisId?: string }

export function NaglowekSekcji({ id, tytul, akcje, edycja }: { id: string; tytul: ReactNode; akcje?: ReactNode; edycja?: EdycjaSekcji | null }) {
  return (
    <div className="ui-sekcja-glowa">
      <h2 id={id} tabIndex={-1}>
        {tytul}
      </h2>
      {(akcje || edycja) && (
        <div className="ui-sekcja-akcje">
          {akcje}
          {edycja && <LinkEdycji e={edycja} />}
        </div>
      )}
    </div>
  )
}

function LinkEdycji({ e }: { e: EdycjaSekcji }) {
  if (e.tryb === 'niedostepna')
    return (
      <span className="ui-sekcja-edytuj is-disabled" aria-disabled="true" title={e.powod} data-powod={e.powod} aria-describedby={e.opisId}>
        {e.etykieta ?? 'Edytuj'}
        {/* gdy powód stoi widocznym tekstem w sekcji (`opisId`), czytnik dostaje go przez opis, nie drugi raz */}
        {!e.opisId && <span className="sr"> ({e.powod})</span>}
      </span>
    )
  if (e.tryb === 'edycja')
    return (
      <Link className="ui-sekcja-edytuj" href={e.href} scroll={false}>
        Zakończ edycję
      </Link>
    )
  return (
    <Link className="ui-sekcja-edytuj" href={e.href} scroll={false}>
      {e.etykieta ?? 'Edytuj'}
    </Link>
  )
}

/** Karta sekcji z paskiem nagłówka. `id` = kotwica sekcji, nagłówek dostaje `h-<id>`. */
export function Sekcja({
  id,
  tytul,
  akcje,
  edycja,
  className,
  children,
}: {
  id: string
  tytul: ReactNode
  akcje?: ReactNode
  edycja?: EdycjaSekcji | null
  className?: string
  children?: ReactNode
}) {
  const klasy = ['card', 'ui-karta', 'ui-sekcja', edycja?.tryb === 'edycja' ? 'ui-sekcja-w-edycji' : '', className].filter(Boolean).join(' ')
  return (
    <section className={klasy} id={id} aria-labelledby={`h-${id}`}>
      <NaglowekSekcji id={`h-${id}`} tytul={tytul} akcje={akcje} edycja={edycja} />
      <div className="ui-sekcja-tresc">{children}</div>
    </section>
  )
}
