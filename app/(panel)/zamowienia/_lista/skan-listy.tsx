'use client'
// czytnik kodów i wklejanie numeru na liście zamówień. Skan karty zamówienia, koszyka, etykiety przewoźnika
// albo numeru zamówienia otwiera kartę zamówienia; wklejenie (Ctrl+V poza polami albo w pole „Szukaj”) numeru
// z maila lub tytułu przelewu też, gdy wskazuje dokładnie jedno zamówienie. Inaczej krótki wklejony tekst filtruje
// listę, a dłuższy (fragment maila) daje komunikat i nie trafia do wyszukiwarki ani adresu strony.
// Karta pokazuje, po czym ją otwarto (adres z akcji, lib/stanowisko/otwarcie.ts).
import { useRouter } from 'next/navigation'
import { useCallback, useRef } from 'react'
import { useToast } from '@/app/ui'
import { wklejenieDoSzukania } from '@/lib/stanowisko/czytnik-panelu'
import { CzytnikKodow } from '../../_komponenty/czytnik-kodow'
import { kodListyZamowien } from '../akcje-skan'

export function SkanListy({ poleSzukania }: { poleSzukania: string }) {
  const router = useRouter()
  const toast = useToast()
  const zajety = useRef(false)

  const rozpoznaj = useCallback(
    async (tekst: string, zrodlo: 'skan' | 'wklej', gdzie: 'pole_szukania' | 'poza' | null) => {
      if (zajety.current) return
      zajety.current = true
      try {
        const w = await kodListyZamowien(tekst, zrodlo)
        if (w.typ === 'otworz') router.push(w.adres)
        else if (w.typ === 'komunikat') (w.ton === 'blad' ? toast.blad : toast.info)(w.tekst)
        else if (gdzie === 'poza') {
          // wklejenie poza polami bez jednego trafienia: zwykłe filtrowanie listy po wklejonym tekście
          const fraza = wklejenieDoSzukania(tekst)
          const pole = document.getElementById(poleSzukania)
          if (fraza === null) toast.info('Nie znalazłem numeru zamówienia we wklejonym tekście.')
          else if (pole instanceof HTMLInputElement && pole.form) {
            pole.value = fraza
            pole.form.requestSubmit()
          }
        }
      } catch {
        if (zrodlo === 'skan') toast.blad('Brak połączenia z serwerem: zeskanuj jeszcze raz.')
      } finally {
        zajety.current = false
      }
    },
    [router, toast, poleSzukania],
  )

  const onSkan = useCallback((t: string) => void rozpoznaj(t, 'skan', null), [rozpoznaj])
  const onWklej = useCallback((t: string, gdzie: 'pole_szukania' | 'poza') => void rozpoznaj(t, 'wklej', gdzie), [rozpoznaj])
  return <CzytnikKodow onSkan={onSkan} onWklej={onWklej} poleSzukania={poleSzukania} />
}
