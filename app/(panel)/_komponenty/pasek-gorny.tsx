'use client'
// Górny pasek panelu (R2 z przeglądu TwojOMS): okruszki z drzewa nawigacji po lewej (bieżący ekran
// na końcu), po prawej zębatka ustawień i menu konta: firma (przełącznik, gdy osoba ma kilka), gęstość „Gęsto /
// Wygodnie”, zmiana hasła, Pomoc, Wyloguj. Te rzeczy były wcześniej na dole menu bocznego jak druga nawigacja.
// Telefon (≤ 900 px): przycisk „Menu”, sam bieżący ekran (albo link powrotu na karcie) i ikona konta.
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { wyloguj, zmienFirme, zmienGestosc, zmienMotyw } from '@/app/akcje'
import { GESTOSC_ETYKIETA, GESTOSCI, type Gestosc } from '@/lib/panel/gestosc'
import { MOTYW_ETYKIETA, MOTYWY, type Motyw } from '@/lib/panel/motyw'
import { okruszkiPaska } from '@/lib/panel/nawigacja'
import { Ikona } from './ikony-menu'

export interface DaneKonta {
  imie: string
  rola: string
  firma: { id: string; nazwa: string }
  firmy: { id: string; nazwa: string }[]
  gestosc: Gestosc
  motyw: Motyw
}

function inicjaly(imie: string): string {
  const s = imie
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
  return s || '?'
}

function MenuKonta({ konto }: { konto: DaneKonta }) {
  const [otwarte, setOtwarte] = useState(false)
  const kontener = useRef<HTMLDivElement>(null)
  const przycisk = useRef<HTMLButtonElement>(null)
  const id = useId()
  const path = usePathname()
  useEffect(() => setOtwarte(false), [path])
  useEffect(() => {
    if (!otwarte) return
    const klik = (e: MouseEvent) => {
      if (!kontener.current?.contains(e.target as Node)) setOtwarte(false)
    }
    const klawisz = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOtwarte(false)
      przycisk.current?.focus()
    }
    document.addEventListener('mousedown', klik)
    window.addEventListener('keydown', klawisz)
    return () => {
      document.removeEventListener('mousedown', klik)
      window.removeEventListener('keydown', klawisz)
    }
  }, [otwarte])
  return (
    <div className="konto" ref={kontener}>
      <button
        ref={przycisk}
        type="button"
        className="konto-przelacz"
        aria-expanded={otwarte}
        aria-controls={otwarte ? id : undefined}
        aria-label={`Konto: ${konto.imie}, ${konto.firma.nazwa}`}
        onClick={() => setOtwarte((o) => !o)}
      >
        <span className="konto-inicjaly" aria-hidden="true">
          {inicjaly(konto.imie)}
        </span>
        <span className="konto-nazwa">
          <span className="konto-imie">{konto.imie}</span>
          <span className="konto-firma">{konto.firma.nazwa}</span>
        </span>
        <Ikona nazwa="strzalka" rozmiar={16} />
      </button>
      {otwarte && (
        <div className="konto-menu" id={id}>
          <div className="konto-kto">
            <b>{konto.imie}</b>
            <span>
              {konto.rola} w firmie {konto.firma.nazwa}
            </span>
          </div>
          {konto.firmy.length > 1 && (
            <form action={zmienFirme} className="konto-firma-form">
              <label htmlFor={`${id}-firma`}>Firma</label>
              <div className="konto-wiersz">
                <select id={`${id}-firma`} name="firma" className="input" defaultValue={konto.firma.id}>
                  {konto.firmy.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.nazwa}
                    </option>
                  ))}
                </select>
                <button className="btn small" type="submit">
                  Przełącz
                </button>
              </div>
            </form>
          )}
          <form action={zmienGestosc} className="konto-gestosc">
            <span id={`${id}-gestosc`}>Widok</span>
            <div className="seg" role="group" aria-labelledby={`${id}-gestosc`}>
              {GESTOSCI.map((g) => (
                <button key={g} type="submit" name="gestosc" value={g} aria-pressed={g === konto.gestosc}>
                  {GESTOSC_ETYKIETA[g]}
                </button>
              ))}
            </div>
          </form>
          <form action={zmienMotyw} className="konto-gestosc">
            <span id={`${id}-motyw`}>Motyw</span>
            <div className="seg" role="group" aria-labelledby={`${id}-motyw`}>
              {MOTYWY.map((m) => (
                <button key={m} type="submit" name="motyw" value={m} aria-pressed={m === konto.motyw}>
                  {MOTYW_ETYKIETA[m]}
                </button>
              ))}
            </div>
          </form>
          <ul className="konto-linki">
            <li>
              <Link href="/ustawienia/haslo">Zmiana hasła</Link>
            </li>
            <li>
              <Link href="/pomoc">Pomoc</Link>
            </li>
          </ul>
          <form action={wyloguj} className="konto-wyloguj">
            <button className="btn small" type="submit">
              Wyloguj
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

export function PasekGorny({ konto, przyciskMenu }: { konto: DaneKonta; przyciskMenu: ReactNode }) {
  const path = usePathname()
  const { lancuch, biezacy } = okruszkiPaska(path)
  const ostatni = lancuch[lancuch.length - 1]
  return (
    <header className="pasek-gorny">
      {przyciskMenu}
      <nav className="ui-okruszki pasek-okruszki" aria-label="Jesteś tutaj">
        <ol>
          {lancuch.map((o) => (
            <li key={o.href} className={!biezacy && o === ostatni ? 'okruszek-ostatni' : undefined}>
              <Link href={o.href}>{o.etykieta}</Link>
            </li>
          ))}
          {biezacy && (
            <li className="okruszek-ostatni">
              <span aria-current="page">{biezacy}</span>
            </li>
          )}
        </ol>
      </nav>
      <div className="pasek-prawa">
        <Link href="/ustawienia" className="pasek-ikona" aria-label="Ustawienia" title="Ustawienia" aria-current={path === '/ustawienia' || path.startsWith('/ustawienia/') ? 'true' : undefined}>
          <Ikona nazwa="zebatka" rozmiar={20} />
        </Link>
        <MenuKonta konto={konto} />
      </div>
    </header>
  )
}
