'use client'
// usunięcie pozycji z jednego zapisu sekcji „Pozycje” pyta osobno. Komponent stoi w formularzu
// pozycji; gdy przy zapisie zaznaczone jest „usuń”, zatrzymuje wysłanie i pokazuje okno `Potwierdzenie` (app/ui)
// z listą usuwanych pozycji. Po „Tak” formularz idzie tym samym przyciskiem (`requestSubmit`), po „Anuluj” zostaje
// z zaznaczeniem do poprawy. Bez zaznaczonego „usuń” zapis idzie od razu (sama zmiana ilości ma potwierdzenie paskiem).
// Bez JavaScriptu formularz wysyła się bez okna (jak dotąd), a rdzeń dalej broni ostatniej pozycji i zamówień po fakturze.
import { useEffect, useRef, useState } from 'react'
import { Potwierdzenie } from '@/app/ui'

/** Nazwy pozycji z zaznaczonym „usuń” (pole `usun_<id>` z atrybutem `data-nazwa`). */
export function pozycjeDoUsuniecia(form: ParentNode): string[] {
  return [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name^="usun_"]:checked')].map((i) => i.dataset.nazwa || 'pozycja bez nazwy')
}

function pozycjiOdmiana(n: number): string {
  const d = n % 10
  const s = n % 100
  return d >= 2 && d <= 4 && (s < 12 || s > 14) ? 'pozycje' : 'pozycji'
}

export function PotwierdzUsuniecie() {
  const ref = useRef<HTMLSpanElement>(null)
  const zgoda = useRef(false)
  const przycisk = useRef<HTMLElement | null>(null)
  const [lista, setLista] = useState<string[] | null>(null)

  useEffect(() => {
    const f = ref.current?.closest('form')
    if (!f) return
    // nasłuch na samym formularzu: odpala się przed obsługą akcji serwera przez React (nasłuch na korzeniu dokumentu),
    // a React nie wysyła formularza, którego zdarzenie ma `defaultPrevented`
    const onSubmit = (e: SubmitEvent) => {
      if (zgoda.current) {
        zgoda.current = false
        return
      }
      const nazwy = pozycjeDoUsuniecia(f)
      if (!nazwy.length) return
      e.preventDefault()
      e.stopPropagation()
      przycisk.current = e.submitter
      setLista(nazwy)
    }
    f.addEventListener('submit', onSubmit)
    return () => f.removeEventListener('submit', onSubmit)
  }, [])

  const n = lista?.length ?? 0
  return (
    <span ref={ref} className="kz-potwierdz-usun">
      <Potwierdzenie
        otwarte={!!lista}
        tytul={n === 1 ? 'Usunąć pozycję?' : `Usunąć ${n} ${pozycjiOdmiana(n)}?`}
        tak={n === 1 ? 'Tak, usuń pozycję' : 'Tak, usuń pozycje'}
        nie="Anuluj"
        wariant="niebezpieczny"
        onNie={() => setLista(null)}
        onTak={() => {
          setLista(null)
          const f = ref.current?.closest('form')
          if (!f) return
          zgoda.current = true
          const b = przycisk.current
          f.requestSubmit(b && b.closest('form') === f ? (b as HTMLButtonElement) : undefined)
          // gdy walidacja HTML zatrzyma wysłanie, zdarzenie submit nie przyjdzie i zgoda wisiałaby
          // do następnego zapisu (wtedy bez okna); zdejmujemy ją po bieżącym zadaniu
          queueMicrotask(() => {
            zgoda.current = false
          })
        }}
      >
        <p>Z zamówienia znikną:</p>
        <ul>
          {(lista ?? []).map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
        <p>Rezerwacja wróci na stan, a w kanale zamówienie zostaje bez zmian. Usuniętej pozycji nie da się przywrócić: trzeba ją dodać od nowa przez „Dodaj pozycję”.</p>
      </Potwierdzenie>
    </span>
  )
}
