'use client'
// wynik akcji serwera, która kończy się przekierowaniem z `?zapisano=<klucz>` albo `?blad=<tekst>`, jako toast
// (docs/ui.md: wynik akcji = toast, nie baner). Wzór: karta zamówienia: parametry czytamy z
// `useSearchParams`, po pokazaniu znikają z adresu przez `history.replaceState` (bez drugiego pobrania strony), więc
// odświeżenie nie powtarza komunikatu, a kolejny zapis z tym samym kluczem znów go pokaże (Next synchronizuje
// `useSearchParams` z `replaceState`). Poza routerem (np. render w teście) nic nie robi.
import { useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useToast } from './toast'

export function ToastZAdresuZapisu({
  komunikaty = {},
  domyslny = 'Zapisano.',
  sukces = 'zapisano',
  blad = 'blad',
}: {
  /** tekst dla wartości parametru sukcesu (np. `{ '1': 'Zapisano.' }`); wartość spoza mapy = `domyslny` */
  komunikaty?: Record<string, string>
  domyslny?: string
  /** nazwa parametru sukcesu */
  sukces?: string
  /** nazwa parametru błędu (tekst komunikatu, najwyżej 300 znaków) */
  blad?: string
}) {
  const sp = useSearchParams()
  const toast = useToast()
  const pokazany = useRef<string | null>(null)
  const ok = sp?.get(sukces) ?? null
  const zly = sp?.get(blad) ?? null
  useEffect(() => {
    if (ok === null && zly === null) {
      pokazany.current = null // kolejny zapis z tym samym komunikatem znów pokaże toast
      return
    }
    const klucz = `${ok}|${zly}`
    if (pokazany.current !== klucz) {
      pokazany.current = klucz // StrictMode: efekt dwa razy, toast raz
      if (zly !== null) toast.blad(zly.slice(0, 300) || 'Nie udało się zapisać.')
      else if (ok !== null) toast.sukces(Object.hasOwn(komunikaty, ok) ? komunikaty[ok]! : domyslny)
    }
    const u = new URL(window.location.href)
    u.searchParams.delete(sukces)
    u.searchParams.delete(blad)
    window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`)
  }, [ok, zly, komunikaty, domyslny, sukces, blad, toast])
  return null
}
