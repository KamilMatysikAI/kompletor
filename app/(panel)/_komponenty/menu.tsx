'use client'
// Rama panelu (przebudowa po przeglądzie TwojOMS 08.11): jasne menu boczne z grupami i ikonami
// (drzewo z lib/panel/nawigacja.ts), statusy zamówień jako podpozycje „Zamówienia” (kropka koloru statusu, licznik,
// przewoźnicy pod aktywnym statusem), górny pasek z okruszkami i menu konta (`pasek-gorny.tsx`). Pozycje podrzędne
// widać po wejściu w sekcję; „Zamówienia” można też rozwinąć przyciskiem obok (telefon: statusy z każdego ekranu).
// Na telefonie (≤ 900 px) menu wysuwane z lewej przyciskiem „Menu” w pasku; Esc i tło zamykają, fokus wraca na przycisk.
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { aktywnaPozycja, type PozycjaMenu, type SekcjaMenu } from '@/lib/panel/nawigacja'
import { Ikona } from './ikony-menu'
import { PasekGorny, type DaneKonta } from './pasek-gorny'

/**
 * Parametry listy, które pozycja-status zastępuje własnymi (reszta, czyli wyszukiwarka i filtry, zostaje).
 * `sf` (status firmy) i `sg` (grupa statusów firmy) też należą do pozycji, jak w dawnym panelu listy.
 */
// `kb` (jednorazowy komunikat wyszukiwania) nie idzie dalej z kliknięciem statusu
const PARAMETRY_WIDOKU = ['widok', 'przewoznik', 'strona', 'status', 'sf', 'sg', 'kb'] as const

function adresPozycji(p: PozycjaMenu, sciezka: string, zapytanie: URLSearchParams | null): string {
  if (!p.widok || sciezka !== '/zamowienia' || !zapytanie) return p.href
  const q = new URLSearchParams(zapytanie.toString())
  PARAMETRY_WIDOKU.forEach((k) => q.delete(k))
  q.set('widok', p.widok.widok)
  if (p.widok.przewoznik) q.set('przewoznik', p.widok.przewoznik)
  if (p.widok.sf) q.set('sf', p.widok.sf)
  if (p.widok.sg) q.set('sg', p.widok.sg)
  return `/zamowienia?${q.toString()}`
}

/** Czy pozycja albo któraś z jej podpozycji (grupa → status → przewoźnik) jest bieżąca. */
function zawiera(p: PozycjaMenu, aktywna: string | null): boolean {
  return aktywna !== null && (p.href === aktywna || p.dzieci.some((d) => zawiera(d, aktywna)))
}

const OPIS_LICZNIKA: Record<string, string> = { '/zamowienia': 'wymaga działania', '/braki': 'z brakami' }

/** Odmiana dla czytnika ekranu: 1 zamówienie, 2–4 zamówienia, 5+ zamówień. */
function zamowieniaSlownie(n: number): string {
  if (n === 1) return 'zamówienie'
  const j = n % 10
  const d = n % 100
  return j >= 2 && j <= 4 && (d < 12 || d > 14) ? 'zamówienia' : 'zamówień'
}

function Licznik({ p }: { p: PozycjaMenu }) {
  if (p.licznik === undefined) return null
  return (
    <span className="cnt" data-ton={p.licznikTon ?? 'neutralny'}>
      {p.licznik}
      <span className="sr"> {OPIS_LICZNIKA[p.href] ?? zamowieniaSlownie(p.licznik)}</span>
    </span>
  )
}

/** Stan rozwinięcia grup statusów firmy (przeglądu rebase 09.11): klucze grup rozwiniętych przyciskiem. */
interface GrupyMenu {
  otwarte: ReadonlySet<string>
  przelacz: (g: NonNullable<PozycjaMenu['grupaStatusow']>) => void
}

interface PropsPozycji {
  p: PozycjaMenu
  aktywna: string | null
  sciezka: string
  zapytanie: URLSearchParams | null
  grupy: GrupyMenu
}

function Pozycja({ p, aktywna, sciezka, zapytanie, grupy }: PropsPozycji) {
  const wSekcji = !p.widok && !p.naglowek && !p.pomocniczy && (sciezka === p.href || sciezka.startsWith(`${p.href}/`))
  const statusy = !p.widok && !p.naglowek && p.dzieci.some((d) => d.widok)
  const [rozwiniete, setRozwiniete] = useState(false)
  const g = p.grupaStatusow
  // grupę statusów firmy wymusza otwartą wybrana pozycja w niej; inaczej rozwinięcie przyciskiem
  const grupaWymuszona = !!g && zawiera(p, aktywna)
  // dzieci (ekrany ustawień, statusy) rozwijamy w bieżącej sekcji albo na żądanie; przewoźników tylko pod aktywnym
  // statusem; grupę statusów firmy po wybraniu jej albo jej statusu i po rozwinięciu przyciskiem
  const pokaz = p.naglowek || (p.widok ? zawiera(p, aktywna) || (!!g && grupy.otwarte.has(g.klucz)) : wSekcji || rozwiniete)
  const dzieci = pokaz ? p.dzieci : []
  const idDzieci = `menu-${p.href.replace(/[^a-z0-9]+/gi, '-')}`
  const potomne = (d: PozycjaMenu) => <Pozycja key={d.href} p={d} aktywna={aktywna} sciezka={sciezka} zapytanie={zapytanie} grupy={grupy} />
  if (p.naglowek) {
    return (
      <li className="nav-naglowek-li">
        <span className="nav-naglowek" id={idDzieci}>
          {p.etykieta}
        </span>
        <ul className="nav-dzieci nav-statusy" aria-labelledby={idDzieci}>
          {p.dzieci.map(potomne)}
        </ul>
      </li>
    )
  }
  // status z zerem: wyszarzony, nie ukryty (ta sama lista statusów co w ustawieniach i w BL)
  const pusty = !!p.widok && p.licznik === 0 && aktywna !== p.href
  const przelacznikGrupy = !!g && p.dzieci.length > 0 && !grupaWymuszona
  return (
    <li className={statusy || przelacznikGrupy ? 'nav-z-przelacznikiem' : undefined}>
      <Link
        href={adresPozycji(p, sciezka, zapytanie)}
        aria-current={aktywna === p.href ? 'page' : undefined}
        data-w-sekcji={wSekcji ? 'tak' : undefined}
        data-pusty={pusty ? 'tak' : undefined}
        className={p.pomocniczy ? 'nav-pomocniczy' : undefined}
        title={p.pelnaNazwa}
      >
        {p.ikona && <Ikona nazwa={p.ikona} />}
        {p.kropka && <span className="nav-kropka" data-ton={p.kropka} style={p.kolor ? { background: p.kolor } : undefined} aria-hidden="true" />}
        {p.pelnaNazwa ? (
          <span className="nav-etykieta">
            <span aria-hidden="true">{p.etykieta}</span>
            <span className="sr">{p.pelnaNazwa}</span>
          </span>
        ) : (
          <span className="nav-etykieta">{p.etykieta}</span>
        )}
        {/* licznik „Zamówień” znika, gdy widać statusy z własnymi licznikami */}
        {!(statusy && dzieci.length > 0) && <Licznik p={p} />}
      </Link>
      {statusy && !wSekcji && (
        <button type="button" className="nav-rozwin" aria-expanded={rozwiniete} aria-controls={rozwiniete && dzieci.length > 0 ? idDzieci : undefined} onClick={() => setRozwiniete((r) => !r)}>
          <Ikona nazwa="strzalka" rozmiar={16} />
          <span className="sr">{rozwiniete ? 'Zwiń statusy' : 'Pokaż statusy'}</span>
        </button>
      )}
      {przelacznikGrupy && (
        <button type="button" className="nav-rozwin nav-rozwin-sm" aria-expanded={pokaz} aria-controls={pokaz ? idDzieci : undefined} onClick={() => grupy.przelacz(g)}>
          <Ikona nazwa="strzalka" rozmiar={14} />
          <span className="sr">{pokaz ? `Zwiń grupę ${p.etykieta}` : `Rozwiń grupę ${p.etykieta}`}</span>
        </button>
      )}
      {dzieci.length > 0 && (
        <ul className={statusy || p.widok ? 'nav-dzieci nav-statusy' : 'nav-dzieci'} id={idDzieci} aria-label={statusy ? 'Statusy zamówień' : undefined}>
          {dzieci.map(potomne)}
        </ul>
      )}
    </li>
  )
}

/** Klucz `localStorage` z rozwiniętymi grupami statusów (osobno dla każdej firmy: klucze grup się powtarzają). */
const kluczGrup = (firma: string) => `kompletor:menu-grupy:${firma}`

function czytajGrupy(firma: string): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(kluczGrup(firma)) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    // bez localStorage (tryb prywatny, blokada) albo zepsuta wartość: wszystkie grupy zwinięte, menu działa
    return new Set()
  }
}

function zapiszGrupy(firma: string, otwarte: ReadonlySet<string>) {
  try {
    localStorage.setItem(kluczGrup(firma), JSON.stringify([...otwarte]))
  } catch {
    // brak zapisu = tylko brak wygody (po przeładowaniu grupa startuje zwinięta)
  }
}

export function Menu({ menu, konto, children }: { menu: SekcjaMenu[]; konto: DaneKonta; children: ReactNode }) {
  const path = usePathname()
  const zapytanie = useSearchParams()
  const [open, setOpen] = useState(false)
  const przycisk = useRef<HTMLButtonElement>(null)
  const oddajFokus = useRef(false)
  const firma = konto.firma.id
  // przeglądu rebase 09.11: grupy statusów firmy startują zwinięte; rozwinięte przyciskiem trzymamy w stanie (cała
  // sesja w przeglądarce) i w `localStorage` (bez grup „zwiniętych” w ustawieniach). Pierwszy render bez `localStorage`
  // (serwer = przeglądarka), odczyt po zamontowaniu i po zmianie firmy.
  const [otwarteGrupy, setOtwarteGrupy] = useState<ReadonlySet<string>>(() => new Set())
  const kluczeZwinietych = menu
    .flatMap((s) => s.pozycje.flatMap((p) => [p, ...p.dzieci]))
    .flatMap((p) => (p.grupaStatusow?.zwinietaNaStart ? [p.grupaStatusow.klucz] : []))
    .join('|')
  useEffect(() => {
    const zwiniete = new Set(kluczeZwinietych.split('|'))
    setOtwarteGrupy(new Set([...czytajGrupy(firma)].filter((k) => !zwiniete.has(k))))
  }, [firma, kluczeZwinietych])
  const grupy: GrupyMenu = {
    otwarte: otwarteGrupy,
    przelacz: (g) => {
      const nowe = new Set(otwarteGrupy)
      if (nowe.has(g.klucz)) nowe.delete(g.klucz)
      else nowe.add(g.klucz)
      setOtwarteGrupy(nowe)
      if (g.zwinietaNaStart) return
      const zapis = czytajGrupy(firma)
      if (nowe.has(g.klucz)) zapis.add(g.klucz)
      else zapis.delete(g.klucz)
      zapiszGrupy(firma, zapis)
    },
  }
  useEffect(() => setOpen(false), [path, zapytanie])
  // ×: firma z wieloma statusami (np. 22) ma menu dłuższe niż ekran; bieżący status przewijamy do
  // widoku menu (tylko wewnątrz menu, `block: 'nearest'`, bez ruszania strony)
  useEffect(() => {
    const menu = document.getElementById('menu-boczne')
    const biezacy = menu?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!menu || !biezacy) return
    const m = menu.getBoundingClientRect()
    const b = biezacy.getBoundingClientRect()
    if (b.top < m.top || b.bottom > m.bottom) menu.scrollTop += b.top - m.top - m.height / 3
  }, [path, zapytanie])
  useEffect(() => {
    document.body.classList.toggle('menu-open', open)
    if (!open) {
      // przycisk „Menu” jest w treści, która przy otwartej szufladzie jest `inert`; fokus wraca na
      // niego dopiero po zamknięciu (po zdjęciu `inert`), nie w samym obsłużeniu klawisza
      if (oddajFokus.current) przycisk.current?.focus()
      oddajFokus.current = false
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      oddajFokus.current = true
      setOpen(false)
    }
    // szuflada istnieje tylko na wąskim ekranie (≤ 900 px, komponenty.css): po poszerzeniu okna zamykamy ją, żeby
    // treść nie została `inert` na szerokim ekranie
    const szeroki = window.matchMedia('(min-width: 901px)')
    const onSzeroki = () => {
      if (szeroki.matches) setOpen(false)
    }
    szeroki.addEventListener('change', onSzeroki)
    window.addEventListener('keydown', onKey)
    // przeglądu rebase 09.11: fokus na bieżącej pozycji (przeglądarka przewija do niej menu), inaczej pierwszy link
    const boczne = document.getElementById('menu-boczne')
    ;(boczne?.querySelector<HTMLElement>('a[aria-current="page"]') ?? boczne?.querySelector<HTMLElement>('a'))?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      szeroki.removeEventListener('change', onSzeroki)
    }
  }, [open])
  const aktywna = aktywnaPozycja(menu, path, zapytanie)
  return (
    <>
      <nav className="side" id="menu-boczne" aria-label="Menu główne">
        {/* znak marki — złota etykieta paczki z „K”; prowadzi na pulpit */}
        <Link className="brand" href="/pulpit" aria-label="Kompletor, pulpit">
          <svg className="brand-znak" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="var(--kolor-akcent)" />
            <path d="M10 8v16M10 16.5 20.5 8M13.6 13.6 21.5 24" fill="none" stroke="var(--kolor-na-akcencie)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="brand-tekst">
            <b>Kompletor</b>
            <span>zamówienia i wysyłki</span>
          </span>
        </Link>
        {menu.map((s) => (
          <div key={s.sekcja} className="nav-grupa" data-sekcja={s.sekcja}>
            {s.tytul && <p className="nav-sekcja-tytul">{s.tytul}</p>}
            <ul className="nav">
              {s.pozycje.map((p) => (
                <Pozycja key={p.href} p={p} aktywna={aktywna} sciezka={path} zapytanie={zapytanie} grupy={grupy} />
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {open && <button className="menu-scrim" type="button" aria-label="Zamknij menu" onClick={() => {
            oddajFokus.current = true
            setOpen(false)
          }} />}
      {/* otwarta szuflada menu na telefonie łapie fokus; treść pod nią jest `inert` */}
      <div className="main" inert={open || undefined}>
        <PasekGorny
          konto={konto}
          przyciskMenu={
            <button ref={przycisk} className="btn pasek-menu" type="button" aria-expanded={open} aria-controls="menu-boczne" onClick={() => setOpen((o) => !o)}>
              Menu
            </button>
          }
        />
        {children}
      </div>
    </>
  )
}
