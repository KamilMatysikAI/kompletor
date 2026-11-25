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
  uwaga,
}: {
  /** tekst dla wartości parametru sukcesu (np. `{ '1': 'Zapisano.' }`); wartość spoza mapy = `domyslny` */
  komunikaty?: Record<string, string>
  domyslny?: string
  /** nazwa parametru sukcesu */
  sukces?: string
  /** nazwa parametru błędu (tekst komunikatu, najwyżej 300 znaków) */
  blad?: string
  /** nazwa parametru uwagi (tekst, najwyżej 300 znaków): osobny toast informacyjny obok wyniku; bez nazwy = brak */
  uwaga?: string
}) {
  const sp = useSearchParams()
  const toast = useToast()
  const pokazany = useRef<string | null>(null)
  const ok = sp?.get(sukces) ?? null
  const zly = sp?.get(blad) ?? null
  const info = uwaga ? (sp?.get(uwaga) ?? null) : null
  useEffect(() => {
    if (ok === null && zly === null && info === null) {
      pokazany.current = null // kolejny zapis z tym samym komunikatem znów pokaże toast
      return
    }
    const klucz = `${ok}|${zly}|${info}`
    if (pokazany.current !== klucz) {
      pokazany.current = klucz // StrictMode: efekt dwa razy, toast raz
      if (zly !== null) toast.blad(zly.slice(0, 300) || 'Nie udało się zapisać.')
      else if (ok !== null) toast.sukces(Object.hasOwn(komunikaty, ok) ? komunikaty[ok]! : domyslny)
      if (info) toast.info(info.slice(0, 300))
    }
    const u = new URL(window.location.href)
    u.searchParams.delete(sukces)
    u.searchParams.delete(blad)
    if (uwaga) u.searchParams.delete(uwaga)
    window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`)
  }, [ok, zly, info, komunikaty, domyslny, sukces, blad, uwaga, toast])
  return null
}
