'use client'
// menu akcji rozwijane z przycisku (np. „Więcej” na karcie zamówienia; wzór: BL „Więcej” w nagłówku
// zamówienia). Na natywnym <details>: działa bez JavaScriptu i przyjmuje dzieci z komponentów serwerowych (formularze
// akcji serwera). Z JavaScriptem zamyka się kliknięciem obok, klawiszem Esc (fokus wraca na przycisk) i po wybraniu
// pozycji, która nie otwiera okna ani rozwinięcia. Pozycje to zwykłe `Przycisk`/`PrzyciskLink` z klasą
// `ui-menu-poz` (pełna szerokość, 44 px celu dotyku), grupy z tytułem przez `GrupaMenu`.
// Na telefonie (≤ 760 px) menu rozwija się pod przyciskiem w treści strony zamiast warstwy nad nią.
import { useEffect, useRef, type ReactNode } from 'react'
import { klasyPrzycisku, POZYCJA_MENU, type RozmiarPrzycisku, type WariantPrzycisku } from './przycisk'

export function MenuAkcji({
  etykieta = 'Więcej',
  opis = 'Więcej akcji',
  wariant = 'drugorzedny',
  rozmiar = 'md',
  children,
}: {
  etykieta?: ReactNode
  /** Nazwa grupy dla czytnika ekranu. */
  opis?: string
  wariant?: WariantPrzycisku
  rozmiar?: RozmiarPrzycisku
  children: ReactNode
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    const zamknij = (fokus: boolean) => {
      if (!d.open) return
      d.open = false
      if (fokus) d.querySelector<HTMLElement>('summary')?.focus()
    }
    const onKlik = (e: MouseEvent) => {
      const cel = e.target as Node | null
      if (cel && d.contains(cel)) return
      // okno modalne otwarte z menu (np. potwierdzenie) leży w drzewie menu; okno spoza menu
      // (np. „Zamień produkt” z tabeli) nie trzyma menu otwartego
      if (d.querySelector('dialog[open]')) return
      zamknij(false)
    }
    const onKlawisz = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !d.open) return
      if (d.querySelector('dialog[open]')) return // Esc zamyka najpierw okno otwarte z menu, nie menu
      zamknij(true)
    }
    // wybrana pozycja (link, przycisk zwykły) zamyka menu; przycisk otwierający okno albo rozwinięcie zostawia je otwarte
    const onWybor = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(`a.${POZYCJA_MENU}, button.${POZYCJA_MENU}`)
      if (!el || el.closest('details') !== d) return
      if (el.dataset.zostawMenu !== undefined) return
      requestAnimationFrame(() => {
        if (!d.querySelector('dialog[open]')) zamknij(false)
      })
    }
    document.addEventListener('click', onKlik)
    document.addEventListener('keydown', onKlawisz)
    d.addEventListener('click', onWybor)
    return () => {
      document.removeEventListener('click', onKlik)
      document.removeEventListener('keydown', onKlawisz)
      d.removeEventListener('click', onWybor)
    }
  }, [])
  return (
    <details ref={ref} className="ui-menu">
      <summary className={klasyPrzycisku(wariant, rozmiar, 'ui-menu-przelacz')}>{etykieta}</summary>
      <div className="ui-menu-panel" role="group" aria-label={opis}>
        {children}
      </div>
    </details>
  )
}

/** Grupa pozycji menu z opcjonalnym tytułem i linią oddzielającą od następnej grupy. */
export function GrupaMenu({ tytul, children }: { tytul?: ReactNode; children: ReactNode }) {
  return (
    <div className="ui-menu-grupa">
      {tytul && <p className="ui-menu-tytul">{tytul}</p>}
      {children}
    </div>
  )
}

/** Rozwinięcie w menu (formularz z polami, np. „Zmień status…”): pozycja menu jako przycisk, treść pod nim. */
export function RozwinWMenu({ etykieta, children }: { etykieta: ReactNode; children: ReactNode }) {
  return (
    <details className="ui-menu-rozwin">
      <summary className={klasyPrzycisku('cichy', 'md', POZYCJA_MENU)}>{etykieta}</summary>
      <div className="ui-menu-rozwin-tresc">{children}</div>
    </details>
  )
}
