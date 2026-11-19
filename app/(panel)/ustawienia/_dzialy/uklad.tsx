'use client'
// (R4 z przeglądu TwojOMS): układ ustawień. Druga kolumna z działami (obok menu bocznego), w dziale
// zakładki = podstrony z dotychczasowymi adresami. Dział i zakładka z adresu (`dzialDla`), więc konto kanału zaznacza
// „Kanały sprzedaży”. Na telefonie (≤ 900 px) kolumna zwija się do przycisku „Dział: …”, który rozwija listę działów;
// zakładki przewijane w poziomie (`Zakladki`). Ekran spoza działów (nowa podstrona bez `dzial` w drzewie) dostaje
// kolumnę bez zaznaczenia i bez zakładek, nie błąd.
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { Zakladki } from '@/app/ui'
import { dzialDla, type DzialWidok } from '@/lib/panel/nawigacja'

export function UkladUstawien({ dzialy, children }: { dzialy: DzialWidok[]; children: ReactNode }) {
  const sciezka = usePathname()
  const [otwarte, setOtwarte] = useState(false)
  useEffect(() => setOtwarte(false), [sciezka])
  const biezacy = dzialDla(dzialy, sciezka)
  const dzial = dzialy.find((d) => d.klucz === biezacy?.dzial) ?? null
  return (
    <div className="ust">
      <nav className="ust-dzialy" aria-label="Działy ustawień" data-otwarte={otwarte ? 'tak' : undefined}>
        <button type="button" className="ust-dzialy-przycisk" aria-expanded={otwarte} aria-controls="ust-dzialy-lista" onClick={() => setOtwarte((o) => !o)}>
          <span className="ust-dzialy-przycisk-etykieta">Dział</span>
          <span>{dzial?.nazwa ?? 'Ustawienia'}</span>
        </button>
        <ul className="ust-dzialy-lista" id="ust-dzialy-lista">
          {dzialy.map((d) => (
            <li key={d.klucz}>
              <Link href={d.href} aria-current={d.klucz === dzial?.klucz ? 'true' : undefined}>
                <span className="ust-dzial-nazwa">{d.nazwa}</span>
                <span className="ust-dzial-opis">{d.opis}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="ust-tresc">
        {dzial && dzial.zakladki.length > 1 && (
          <Zakladki etykieta={`Zakładki działu ${dzial.nazwa}`} zakladki={dzial.zakladki.map((z) => ({ href: z.href, etykieta: z.etykieta, aktywna: z.href === biezacy?.zakladka }))} />
        )}
        {children}
      </div>
    </div>
  )
}
