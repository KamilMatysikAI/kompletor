'use client'
// Wynik akcji karty jako toast. Akcje serwera karty kończą się przekierowaniem na kartę z `?ok=<klucz>`,
// `?info=<klucz>` albo `?blad=<kod>` (działa bez JavaScriptu; klucze i teksty w lib/karta/komunikaty.ts; treść błędu z zapisu
// przychodzi od strony karty jako `szczegoly`, odczytana po stronie serwera z ciasteczka). Z JavaScriptem
// komunikat pokazuje się w rogu ekranu, a parametry znikają z adresu (odświeżenie strony nie pokaże go drugi raz).
// Bez JavaScriptu karta pokazuje komunikat banerem w `<noscript>` (page.tsx).
// adres czyścimy `window.history.replaceState`, nie `router.replace`: nawigacja routera pobrałaby
// kartę z serwera drugi raz, a każdy render karty to wpis KLIENT_PODGLAD w dzienniku podglądów danych klientów.
// Next synchronizuje `useSearchParams` z `replaceState`, więc po wyczyszczeniu efekt kończy się na pierwszym `return`.
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useToast } from '@/app/ui'
import { adresBezKomunikatu, komunikatZAdresu, type SzczegolyBledu } from '@/lib/karta/komunikaty'

export function ToastZAdresu({ szczegoly }: { szczegoly?: SzczegolyBledu | null }) {
  const sp = useSearchParams()
  const sciezka = usePathname()
  const toast = useToast()
  const pokazany = useRef<string | null>(null)
  const zapytanie = sp.toString()
  useEffect(() => {
    const k = komunikatZAdresu(new URLSearchParams(zapytanie), szczegoly)
    const bylyParametry = /(^|&)(ok|blad|info|n|k)=/.test(zapytanie)
    if (!k && !bylyParametry) {
      pokazany.current = null // kolejna akcja z tym samym komunikatem znów pokaże toast
      return
    }
    if (k) {
      const klucz = `${k.rodzaj}|${k.tresc}`
      if (pokazany.current !== klucz) {
        pokazany.current = klucz // StrictMode: efekt dwa razy, toast raz
        toast[k.rodzaj](k.tresc)
      }
    }
    window.history.replaceState(window.history.state, '', adresBezKomunikatu(sciezka, zapytanie, window.location.hash))
  }, [zapytanie, sciezka, toast, szczegoly])
  return null
}
