'use client'
// Przyciski stopki karty „Wysyłka” (sekcja „Klient i adresy”): „Odśwież z kanału”
// i „Kopiuj adres”. Adres do schowka wraca z akcji serwera (osobny wpis w dzienniku podglądów, cel KOPIA) i nie jest trzymany w stanie komponentu po skopiowaniu.
// wynik jako toast. Bez `router.refresh()`: akcja `odswiezKlienta` robi
// `revalidatePath` karty, więc Next odświeża kartę w odpowiedzi na akcję; drugi odczyt dałby drugi wpis KLIENT_PODGLAD.
import { useTransition } from 'react'
import { Przycisk, useToast } from '@/app/ui'
import { kopiujAdresKlienta, odswiezKlienta } from './akcje-klient'

export function PrzyciskiKlienta({ orderId, odswiez, kopiuj }: { orderId: string; odswiez: boolean; kopiuj: boolean }) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const naOdswiez = () =>
    start(async () => {
      const r = await odswiezKlienta(orderId)
      if (r.blad) toast.blad(r.blad)
      else if (r.info) toast.sukces(r.info)
    })
  const naKopiuj = () =>
    start(async () => {
      const r = await kopiujAdresKlienta(orderId)
      if (!r.tekst) return toast.blad(r.blad ?? 'Brak adresu do skopiowania.')
      try {
        await navigator.clipboard.writeText(r.tekst)
        toast.sukces('Skopiowano adres.')
      } catch {
        toast.blad('Przeglądarka nie pozwoliła skopiować adresu.')
      }
    })
  if (!odswiez && !kopiuj) return null
  return (
    <>
      {kopiuj && (
        <Przycisk rozmiar="sm" disabled={pending} onClick={naKopiuj}>
          Kopiuj adres
        </Przycisk>
      )}
      {odswiez && (
        <Przycisk rozmiar="sm" ladowanie={pending} onClick={naOdswiez}>
          Odśwież z kanału
        </Przycisk>
      )}
    </>
  )
}
