'use client'
// jeden „Zapisz zmiany” na formularz. Pasek wstawiony na końcu <form> (po zmianie przykleja się do dołu ekranu),
// porównuje bieżące wartości z wartościami z chwili wczytania (FormData) i jest aktywny dopiero po zmianie;
// „Anuluj” przywraca wartości (form.reset). Przy niezapisanych zmianach przeglądarka pyta przed wyjściem ze strony.
// Po zapisie akcji serwera React resetuje formularz do nowych wartości domyślnych, a pasek przyjmuje je za stan
// zapisany. Formularz z useActionState: przekaż `oczekuje={pending}`.
// `ukryjBezZmian` chowa pasek, dopóki nic się nie zmieniło (karta zamówienia: na telefonie stały pasek pod
// tabelą pozycji był szumem); po zmianie pokazuje się i przykleja do dołu ekranu, po zapisie albo „Anuluj” znika.
// Pozostałe formularze (ustawienia, produkt) bez tej flagi działają jak dotąd.
// (1) ukryty pasek zostaje w DOM (`data-ukryty`), widoczny jest tylko status dla czytnika ekranu, a przyciski
// są ukryte — region role="status" istnieje przed zmianą treści, więc pierwsze „Masz niezapisane zmiany.” jest ogłaszane.
// (2) `anulujHref`: „Anuluj” jest linkiem z powrotem do trybu odczytu sekcji (karta zamówienia,
// `?edytuj=…`), a nie samym wyczyszczeniem pól. (3) Po „Anuluj” z resetem fokus wraca na `fokusPoAnuluj` (id
// nagłówka sekcji) zamiast na <body>, gdy pasek znika. Przy „Anuluj” jako linku (`anulujHref`) fokus
// idzie na `fokusPoAnuluj` po nawigacji (element może powstać dopiero w nowym widoku, np. „Wysyłka” po edycji klienta);
// focus() przewija do sekcji, więc ekran nie zostaje przy przyklejonym pasku nad zmienioną treścią.
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useFormStatus } from 'react-dom'
import { klasyPrzycisku, Przycisk } from './przycisk'

/** Fokus na element, gdy pojawi się w DOM (najwyżej ~3 s, np. po nawigacji do trybu odczytu sekcji). */
function fokusGdyBedzie(id: string): void {
  const koniec = performance.now() + 3000
  const krok = () => {
    const el = document.getElementById(id)
    if (el) el.focus()
    else if (performance.now() < koniec) requestAnimationFrame(krok)
  }
  requestAnimationFrame(krok)
}

function zrzut(form: HTMLFormElement): string {
  const fd = new FormData(form)
  const pary: string[] = []
  fd.forEach((v, k) => {
    if (k.startsWith('$ACTION')) return // pola techniczne akcji serwera
    pary.push(`${k}=${typeof v === 'string' ? v : `[plik:${v.name}:${v.size}]`}`)
  })
  return pary.join('&')
}

/** Czy pasek jest widoczny. Bez `ukryjBezZmian` zawsze; z flagą tylko przy zmianach albo w trakcie zapisu. */
export function pasekWidoczny({ zmiany, trwa, ukryjBezZmian, zawszeAktywny }: { zmiany: boolean; trwa: boolean; ukryjBezZmian?: boolean; zawszeAktywny?: boolean }): boolean {
  if (!ukryjBezZmian || zawszeAktywny) return true
  return zmiany || trwa
}

export function PasekZapisu({
  zapisz = 'Zapisz zmiany',
  anuluj = 'Anuluj',
  oczekuje,
  zawszeAktywny,
  opis,
  ukryjBezZmian,
  anulujHref,
  fokusPoAnuluj,
}: {
  zapisz?: string
  anuluj?: string
  oczekuje?: boolean
  /** np. formularz pusty do wypełnienia */
  zawszeAktywny?: boolean
  opis?: string
  /** pasek niewidoczny, dopóki w formularzu nic się nie zmieniło */
  ukryjBezZmian?: boolean
  /** „Anuluj” jako link (np. powrót z trybu edycji sekcji do odczytu); zawsze aktywny poza zapisem */
  anulujHref?: string
  /** id elementu (np. nagłówka sekcji), na który wraca fokus po „Anuluj” (reset albo, z `anulujHref`, po nawigacji) */
  fokusPoAnuluj?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const zapisany = useRef<string>('')
  const [zmiany, setZmiany] = useState(false)
  const { pending } = useFormStatus()
  const trwa = oczekuje ?? pending

  const form = useCallback(() => ref.current?.closest('form') ?? null, [])
  const sprawdz = useCallback(() => {
    const f = form()
    if (f) setZmiany(zrzut(f) !== zapisany.current)
  }, [form])

  useEffect(() => {
    const f = form()
    if (!f) return
    zapisany.current = zrzut(f)
    const onZmiana = () => sprawdz()
    // reset (Anuluj albo reset po akcji serwera): wartości są przywracane po zdarzeniu, więc odczyt w następnej klatce
    const onReset = () =>
      requestAnimationFrame(() => {
        zapisany.current = zrzut(f)
        setZmiany(false)
      })
    f.addEventListener('input', onZmiana)
    f.addEventListener('change', onZmiana)
    f.addEventListener('reset', onReset)
    return () => {
      f.removeEventListener('input', onZmiana)
      f.removeEventListener('change', onZmiana)
      f.removeEventListener('reset', onReset)
    }
  }, [form, sprawdz])

  // po zakończonym zapisie bieżące wartości są nowym stanem zapisanym (także gdy React nie zresetował formularza)
  const bylo = useRef(trwa)
  useEffect(() => {
    if (bylo.current && !trwa) {
      const f = form()
      if (f) {
        zapisany.current = zrzut(f)
        setZmiany(false)
      }
    }
    bylo.current = trwa
  }, [trwa, form])

  useEffect(() => {
    if (!zmiany) return
    const ostrzez = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', ostrzez)
    return () => window.removeEventListener('beforeunload', ostrzez)
  }, [zmiany])

  const aktywny = (zmiany || !!zawszeAktywny) && !trwa
  const widoczny = pasekWidoczny({ zmiany, trwa, ukryjBezZmian, zawszeAktywny })
  return (
    <div ref={ref} className="ui-pasek-zapisu" data-zmiany={zmiany ? 'tak' : 'nie'} data-ukryty={widoczny ? undefined : ''}>
      <span className="ui-pasek-zapisu-stan" role="status">
        {trwa ? 'Zapisywanie…' : zmiany ? 'Masz niezapisane zmiany.' : (opis ?? 'Brak zmian do zapisania.')}
      </span>
      <div className="ui-pasek-zapisu-akcje" hidden={!widoczny}>
        {anulujHref && !trwa ? (
          <Link className={klasyPrzycisku()} href={anulujHref} scroll={false} onClick={fokusPoAnuluj ? () => fokusGdyBedzie(fokusPoAnuluj) : undefined}>
            {anuluj}
          </Link>
        ) : (
          <Przycisk
            disabled={anulujHref ? true : !zmiany || trwa}
            onClick={() => {
              form()?.reset()
              if (fokusPoAnuluj) requestAnimationFrame(() => document.getElementById(fokusPoAnuluj)?.focus())
            }}
          >
            {anuluj}
          </Przycisk>
        )}
        <Przycisk type="submit" wariant="glowny" disabled={!aktywny} ladowanie={trwa}>
          {zapisz}
        </Przycisk>
      </div>
    </div>
  )
}
