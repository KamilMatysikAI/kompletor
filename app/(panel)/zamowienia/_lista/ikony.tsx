// Ikony listy zamówień: przewoźnik; kolumna „Stan” (płatność, przesyłka, dokument, zwrot). Ikona
// zawsze z tekstem dla czytnika i podpowiedzią; kolor tylko z tonu (tokeny), znaczenie niesie też kształt i tekst.
import type { Carrier } from '@prisma/client'
import type { ReactNode } from 'react'
import { CARRIER_LABEL } from '@/lib/panel/format'
import type { IkonaStanu, RodzajStanu } from '@/lib/panel/stan-zamowienia'

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

const KSZTALT: Record<'paczkomat' | 'kurier' | 'osobisty' | 'brak', ReactNode> = {
  paczkomat: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <path d="M2 6h12M2 10h12M8 2v12" />
    </>
  ),
  kurier: (
    <>
      <path d="M1.5 4h8v7h-8zM9.5 6.5h3l2 2.5v2h-5" />
      <circle cx="4.5" cy="12" r="1.3" />
      <circle cx="11.5" cy="12" r="1.3" />
    </>
  ),
  osobisty: (
    <>
      <path d="M3 7.5 8 3l5 4.5V13H3z" />
      <path d="M6.5 13V9.5h3V13" />
    </>
  ),
  brak: <path d="M3 8h10" />,
}

function rodzaj(c: Carrier): keyof typeof KSZTALT {
  if (c === 'PACZKOMATY') return 'paczkomat'
  if (c === 'OSOBISTY') return 'osobisty'
  if (c === 'BRAK' || c === 'BEZ_WYSYLKI') return 'brak'
  return 'kurier'
}

export function IkonaPrzewoznika({ carrier }: { carrier: Carrier | null }) {
  const c = carrier ?? 'BRAK'
  return (
    <span className={`zl-ikona zl-przew zl-przew-${rodzaj(c)}`} title={CARRIER_LABEL[c]}>
      <Svg>{KSZTALT[rodzaj(c)]}</Svg>
    </span>
  )
}

/** Kształty ikon kolumny „Stan”: płatność, przesyłka, dokument sprzedaży, zwrot. */
const STAN: Record<RodzajStanu, ReactNode> = {
  platnosc: (
    <>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
      <path d="M1.5 6.5h13M4 10h3" />
    </>
  ),
  przesylka: (
    <>
      <path d="M2 5 8 2l6 3v6l-6 3-6-3z" />
      <path d="M2 5l6 3 6-3M8 8v6" />
    </>
  ),
  dokument: (
    <>
      <path d="M4 1.8h5.5L12 4.3v9.9H4z" />
      <path d="M6 7h4M6 9.5h4" />
    </>
  ),
  zwrot: (
    <>
      <path d="M5.5 3.5 2.5 6.5l3 3" />
      <path d="M2.5 6.5h7a4 4 0 0 1 0 8H7" />
    </>
  ),
}

/**
 * Kolumna „Stan” (R8): cztery ikony w stałej kolejności (płatność, przesyłka, dokument sprzedaży, zwrot)
 * z `lib/panel/stan-zamowienia.ts`. Ton niesie kolor i ramkę, znaczenie niesie też kształt; opis w podpowiedzi
 * (`title`) i dla czytnika ekranu (jedna etykieta całej grupy, żeby czytnik nie czytał czterech obrazków osobno).
 */
export function IkonyStanu({ ikony }: { ikony: readonly IkonaStanu[] }) {
  return (
    <span className="zl-stan" role="img" aria-label={ikony.map((i) => i.opis).join('. ')}>
      {ikony.map((i) => (
        <span key={i.rodzaj} className={`zl-stan-ikona zl-ton-${i.ton}`} title={i.opis} data-rodzaj={i.rodzaj} data-ton={i.ton}>
          <Svg>{STAN[i.rodzaj]}</Svg>
        </span>
      ))}
    </span>
  )
}
