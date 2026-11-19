'use client'
// pasek filtrów listy. Formularz GET (filtry w adresie), jedno pole wyszukiwania (Enter), filtry
// (`<select>`, pola) stosowane od razu po zmianie, bez przycisku „Pokaż”. Na ≤ 900 px pod wyszukiwarką zostaje jeden
// przycisk „Filtry (n)”, który rozwija resztę, żeby lista zaczynała się na pierwszym ekranie telefonu. Z
// `zwijane` tak samo na każdej szerokości (jak w BL: filtry pod przyciskiem, domyślnie zwinięte), stan zapamiętany
// w przeglądarce per lista.
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'

export function PasekFiltrow({
  akcja,
  szukaj,
  aktywne = 0,
  wyczysc,
  children,
  zachowaj,
  zwijane = false,
}: {
  /** ścieżka listy, np. '/zamowienia' */
  akcja: string
  /** pole wyszukiwania; `nazwa` = parametr adresu */
  szukaj?: { nazwa: string; wartosc?: string; etykieta: string; podpowiedz?: string }
  /** liczba aktywnych filtrów (bez wyszukiwania), do „Filtry (n)” */
  aktywne?: number
  /** adres bez filtrów; pokazuje „Wyczyść”, gdy cokolwiek jest ustawione */
  wyczysc?: string
  /** pola filtrów: `<select name>`, `<input name>`; zmiana od razu przeładowuje listę */
  children?: ReactNode
  /** parametry do zachowania przy wysłaniu (np. bieżąca zakładka), jako ukryte pola */
  zachowaj?: Record<string, string | undefined>
  /** filtry pod przyciskiem „Filtry (n)” także na szerokim ekranie (domyślnie zwinięte, stan w przeglądarce) */
  zwijane?: boolean
}) {
  const router = useRouter()
  const ref = useRef<HTMLFormElement>(null)
  const [otwarte, setOtwarte] = useState(false)
  const kluczStanu = `kompletor-filtry:${akcja}`
  useEffect(() => {
    if (!zwijane) return
    try {
      if (localStorage.getItem(kluczStanu) === 'tak') setOtwarte(true)
    } catch {
      // bez localStorage: zostają zwinięte
    }
  }, [zwijane, kluczStanu])
  const przelacz = () =>
    setOtwarte((o) => {
      if (zwijane) {
        try {
          localStorage.setItem(kluczStanu, o ? 'nie' : 'tak')
        } catch {
          // jw.
        }
      }
      return !o
    })
  const idPol = `${useId()}-pola` // dwa paski na jednym ekranie nie dzielą jednego id
  const wyslij = (e?: FormEvent) => {
    e?.preventDefault()
    const f = ref.current
    if (!f) return
    const q = new URLSearchParams()
    new FormData(f).forEach((v, k) => {
      if (typeof v === 'string' && v.trim() !== '') q.append(k, v.trim())
    })
    const s = q.toString()
    router.push(s ? `${akcja}?${s}` : akcja) // strona wraca na 1 (parametru `strona` nie ma w formularzu)
  }
  const ustawione = aktywne > 0 || !!szukaj?.wartosc
  return (
    <form ref={ref} className="ui-filtry" data-zwijane={zwijane ? 'tak' : undefined} role="search" action={akcja} method="get" onSubmit={wyslij} onChange={(e) => {
        // wyszukiwarka czeka na Enter, reszta filtrów działa od razu
        if ((e.target as unknown as HTMLInputElement).type !== 'search') wyslij()
      }}>
      {zachowaj && Object.entries(zachowaj).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      {szukaj && (
        <div className="ui-filtry-szukaj">
          <label className="sr" htmlFor={`f-${szukaj.nazwa}`}>
            {szukaj.etykieta}
          </label>
          <input id={`f-${szukaj.nazwa}`} className="input" type="search" name={szukaj.nazwa} defaultValue={szukaj.wartosc} placeholder={szukaj.podpowiedz ?? szukaj.etykieta} enterKeyHint="search" />
          <button className="btn" type="submit">
            Szukaj
          </button>
        </div>
      )}
      {children && (
        <button className="btn ui-filtry-przelacz" type="button" aria-expanded={otwarte} aria-controls={idPol} onClick={przelacz}>
          Filtry{aktywne > 0 ? ` (${aktywne})` : ''}
        </button>
      )}
      {children && (
        <div className="ui-filtry-pola" id={idPol} data-otwarte={otwarte ? 'tak' : 'nie'}>
          {children}
        </div>
      )}
      {wyczysc && ustawione && (
        <Link className="btn ghost small ui-filtry-wyczysc" href={wyczysc}>
          {/* sam pasek szukania (np. Pomoc) nie ma filtrów do wyczyszczenia */}
          {children ? 'Wyczyść filtry' : 'Wyczyść'}
        </Link>
      )}
    </form>
  )
}
