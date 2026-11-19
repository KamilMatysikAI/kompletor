'use client'
// Czekanie na zatwierdzenie w Allegro: co `interval` sekund (z odpowiedzi serwera, 3–30 s) jedno
// odpytanie akcją `sprawdzAllegro`; po wyniku toast i odświeżenie ekranu. Najwyżej do końca ważności linku, potem
// informacja zamiast kręcenia się bez końca. Kod urządzenia nie trafia do przeglądarki (zna go tylko serwer).
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useToast } from '@/app/ui'
import { sprawdzAllegro } from '../akcje'

export function AllegroCzekanie({ kod, wazneDo }: { kod: string; wazneDo: string }) {
  const router = useRouter()
  const toast = useToast()
  const [opis, setOpis] = useState('Czekam na zatwierdzenie w Allegro…')
  const koniec = useRef(false)
  useEffect(() => {
    // Strict Mode w `next dev` montuje efekt dwa razy, a cleanup ustawia `koniec`; bez zerowania
    // na starcie drugie (i każde kolejne, np. nowy `kod`) uruchomienie nigdy by nie odpytało serwera
    koniec.current = false
    let zegar: number | undefined
    const krok = async (za: number) => {
      zegar = window.setTimeout(async () => {
        if (koniec.current) return
        if (Date.now() > new Date(wazneDo).getTime()) {
          koniec.current = true
          setOpis('Link wygasł. Kliknij „Połącz z Allegro” jeszcze raz.')
          router.refresh()
          return
        }
        let w
        try {
          w = await sprawdzAllegro(kod)
        } catch {
          return krok(10)
        }
        if (koniec.current) return
        if (w.stan === 'czeka') return krok(Math.min(30, Math.max(3, w.zaSek)))
        koniec.current = true
        if (w.stan === 'gotowe') toast.sukces(w.komunikat)
        else toast.blad(w.komunikat)
        setOpis(w.komunikat)
        router.refresh()
      }, za * 1000)
    }
    void krok(3)
    return () => {
      koniec.current = true
      window.clearTimeout(zegar)
    }
  }, [kod, wazneDo, router, toast])
  return (
    <p className="muted small" role="status" aria-live="polite">
      {opis}
    </p>
  )
}
