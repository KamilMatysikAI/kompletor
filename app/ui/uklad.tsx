// klocki układu ekranu bez stanu (działają w komponentach serwerowych): nagłówek strony, karta, baner,
// pusty stan, lista opisowa, ładowanie, zakładki. Okruszki rysuje layout panelu z drzewa nawigacji
// (górny pasek `app/(panel)/_komponenty/pasek-gorny.tsx`), więc ekran ich nie podaje.
import Link from 'next/link'
import type { ReactNode } from 'react'
import type { Ton } from '@/lib/panel/statusy'

/** Nagłówek ekranu: tytuł, jedna linia podtytułu, akcje (najwyżej jedna główna + reszta w „Więcej”). */
export function NaglowekStrony({ tytul, podtytul, akcje, className }: { tytul: ReactNode; podtytul?: ReactNode; akcje?: ReactNode; className?: string }) {
  return (
    <header className={['page-head', 'ui-naglowek', className].filter(Boolean).join(' ')}>
      <div className="ui-naglowek-tekst">
        <h1>{tytul}</h1>
        {podtytul && <p className="sub">{podtytul}</p>}
      </div>
      {akcje && <div className="actions">{akcje}</div>}
    </header>
  )
}

/**
 * Karta: płaska powierzchnia z ramką. `zwijana` = `<details>` (domyślnie zwinięta, `otwarta` rozwija), np. sekcja
 * „Zaawansowane”. `naglowekPoziom` pozwala zachować poprawną hierarchię nagłówków na ekranie.
 */
export function Karta({
  tytul,
  opis,
  akcje,
  stopka,
  zwijana,
  otwarta,
  naglowekPoziom = 2,
  id,
  className,
  children,
}: {
  tytul?: ReactNode
  opis?: ReactNode
  akcje?: ReactNode
  stopka?: ReactNode
  zwijana?: boolean
  otwarta?: boolean
  naglowekPoziom?: 2 | 3
  id?: string
  className?: string
  children?: ReactNode
}) {
  const H = naglowekPoziom === 3 ? 'h3' : 'h2'
  const klasy = ['card', 'ui-karta', className].filter(Boolean).join(' ')
  const glowa = (tytul || akcje) && (
    <div className="card-head">
      <div>
        {tytul && <H>{tytul}</H>}
        {opis && <p className="muted small ui-karta-opis">{opis}</p>}
      </div>
      {akcje && <div className="actions">{akcje}</div>}
    </div>
  )
  if (zwijana) {
    return (
      <details className={`${klasy} ui-karta-zwijana`} id={id} open={otwarta}>
        <summary>
          <H>{tytul}</H>
          {opis && <span className="muted small">{opis}</span>}
        </summary>
        <div className="ui-karta-tresc">{children}</div>
        {stopka && <div className="ui-karta-stopka">{stopka}</div>}
      </details>
    )
  }
  return (
    <section className={klasy} id={id}>
      {glowa}
      {children}
      {stopka && <div className="ui-karta-stopka">{stopka}</div>}
    </section>
  )
}

const BANER_TON: Record<'info' | 'ostrzezenie' | 'blad' | 'sukces' | 'uwaga', string> = { info: 'blue', ostrzezenie: 'amber', blad: 'red', sukces: 'leaf-soft', uwaga: 'violet' }

/** Baner tylko dla stanów trwałych (konto wyłączone, dane fikcyjne). Wynik akcji = toast, nie baner. */
export function Baner({ ton = 'info', tytul, akcja, children, rola }: { ton?: keyof typeof BANER_TON; tytul?: ReactNode; akcja?: ReactNode; children?: ReactNode; rola?: 'note' | 'alert' | 'status' }) {
  return (
    <div className={`banner ${BANER_TON[ton]}`} role={rola ?? (ton === 'blad' ? 'alert' : 'note')}>
      <div>
        {tytul && <b>{tytul}</b>} {children}
      </div>
      {akcja && <div className="ui-baner-akcja">{akcja}</div>}
    </div>
  )
}

/** Pusty stan: co tu będzie i jedno działanie, od którego zacząć. */
export function PustyStan({ tytul, children, akcja, ikona }: { tytul: ReactNode; children?: ReactNode; akcja?: ReactNode; ikona?: ReactNode }) {
  return (
    <div className="empty ui-pusty">
      {ikona && (
        <div className="ui-pusty-ikona" aria-hidden="true">
          {ikona}
        </div>
      )}
      <h2>{tytul}</h2>
      {children && <p className="muted">{children}</p>}
      {akcja && <div className="ui-pusty-akcja">{akcja}</div>}
    </div>
  )
}

/** Pary etykieta–wartość (`.dl`), w 1 albo 2 kolumnach par. */
export function ListaOpisowa({ pozycje, kolumny = 1 }: { pozycje: { etykieta: ReactNode; wartosc: ReactNode; klucz?: string }[]; kolumny?: 1 | 2 }) {
  return (
    <dl className={`dl${kolumny === 2 ? ' ui-dl-2' : ''}`}>
      {pozycje.map((p, i) => (
        <div className="ui-dl-para" key={p.klucz ?? i}>
          <dt>{p.etykieta}</dt>
          <dd>{p.wartosc}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Kręciołek z opisem (role=status). Do całych sekcji ładowanych w tle; przycisk ma własne `ladowanie`. */
export function Ladowanie({ children = 'Wczytywanie…' }: { children?: ReactNode }) {
  return (
    <div className="ui-ladowanie" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{children}</span>
    </div>
  )
}

/** Szkielet wierszy (np. w `loading.tsx` ekranu z listą). */
export function Szkielet({ wiersze = 5 }: { wiersze?: number }) {
  return (
    <div className="ui-szkielet" aria-hidden="true">
      {Array.from({ length: wiersze }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  )
}

export interface Zakladka {
  href: string
  etykieta: ReactNode
  licznik?: number
  aktywna?: boolean
  tonLicznika?: Ton
}

/** Zakładki-linki z licznikami; na telefonie przewijane w poziomie z cieniem krawędzi (bez ucinania bez wskazówki). */
export function Zakladki({ zakladki, etykieta }: { zakladki: Zakladka[]; etykieta: string }) {
  return (
    <nav className="ui-zakladki" aria-label={etykieta}>
      {/* <ul role=list> (Safari przy list-style: none gubi rolę listy), link zostaje linkiem */}
      <ul className="tabs" role="list">
        {zakladki.map((z) => (
          <li key={z.href}>
            <Link href={z.href} aria-current={z.aktywna ? 'page' : undefined}>
              {z.etykieta}
              {z.licznik !== undefined && (
                <span className="cnt" data-ton={z.tonLicznika}>
                  {z.licznik}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
