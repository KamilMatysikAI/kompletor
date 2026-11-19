'use client'
// „Kopiuj dane” w menu „Więcej” karty zamówienia. Dane osobowe wracają z akcji serwera (osobny wpis
// w dzienniku podglądów, cel KOPIA) i nie zostają w stanie komponentu po skopiowaniu. Numer zamówienia kopiuje się
// bez serwera: to nie dane osobowe.
import { useTransition } from 'react'
import { GrupaMenu, POZYCJA_MENU, Przycisk, useToast } from '@/app/ui'
import { kopiujDaneKlienta } from './akcje-kopiuj'

const ETYKIETA = { adres: 'Kopiuj adres dostawy', email: 'Kopiuj e-mail', telefon: 'Kopiuj telefon' } as const

export function KopiujDane({ orderId, numer, daneKlienta }: { orderId: string; numer: string; daneKlienta: boolean }) {
  // wynik jako toast zamiast linii pod przyciskami
  const toast = useToast()
  const [pending, start] = useTransition()
  const doSchowka = async (tekst: string, co: string) => {
    try {
      await navigator.clipboard.writeText(tekst)
      toast.sukces(`Skopiowano ${co}.`)
    } catch {
      toast.blad('Przeglądarka nie pozwoliła skopiować.')
    }
  }
  const kopiuj = (co: keyof typeof ETYKIETA) =>
    start(async () => {
      const r = await kopiujDaneKlienta(orderId, co)
      if (!r.tekst) return toast.blad(r.blad ?? 'Brak danych do skopiowania.')
      await doSchowka(r.tekst, co === 'adres' ? 'adres' : co === 'email' ? 'e-mail' : 'telefon')
    })
  return (
    <GrupaMenu tytul="Kopiuj dane">
      {daneKlienta &&
        (Object.keys(ETYKIETA) as (keyof typeof ETYKIETA)[]).map((co) => (
          <Przycisk key={co} wariant="cichy" className={POZYCJA_MENU} disabled={pending} onClick={() => kopiuj(co)}>
            {ETYKIETA[co]}
          </Przycisk>
        ))}
      <Przycisk wariant="cichy" className={POZYCJA_MENU} onClick={() => start(() => doSchowka(numer, 'numer zamówienia'))}>
        Kopiuj numer zamówienia
      </Przycisk>
    </GrupaMenu>
  )
}
