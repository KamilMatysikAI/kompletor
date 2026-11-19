'use client'
// czytnik kodów na kolejce Pakowania i liście zbierania, gdy okno pakowania nie jest otwarte. Skan karty
// zamówienia (albo koszyka z zamówieniem) otwiera okno pakowania tego zamówienia, jak przycisk „Pakuj”; spakowane,
// wysłane, anulowane albo nieznane: komunikat jak na stanowisku, bez otwierania. Przy otwartym oknie skan obsługuje
// samo okno (stanowisko.tsx), a ten komponent nie jest wtedy zamontowany.
import { useRouter } from 'next/navigation'
import { useCallback, useRef } from 'react'
import { useToast } from '@/app/ui'
import { CzytnikKodow } from '../_komponenty/czytnik-kodow'
import { skanNaKolejce } from './akcje-skan'

/** `kolejka` = adres kolejki z filtrami, do którego okno dokłada `pakuj=<id>` (po zamknięciu wraca tam). */
export function SkanKolejki({ kolejka }: { kolejka: string }) {
  const router = useRouter()
  const toast = useToast()
  const zajety = useRef(false)
  const onSkan = useCallback(
    async (tekst: string) => {
      if (zajety.current) return
      zajety.current = true
      try {
        const w = await skanNaKolejce(tekst)
        if (w.typ === 'otworz') router.push(`${kolejka}${kolejka.includes('?') ? '&' : '?'}pakuj=${encodeURIComponent(w.orderId)}`, { scroll: false })
        else if (w.ton === 'info') toast.info(w.tekst)
        else toast.blad(w.tekst)
      } catch {
        toast.blad('Brak połączenia z serwerem: zeskanuj jeszcze raz.')
      } finally {
        zajety.current = false
      }
    },
    [router, toast, kolejka],
  )
  return <CzytnikKodow onSkan={(t) => void onSkan(t)} />
}
