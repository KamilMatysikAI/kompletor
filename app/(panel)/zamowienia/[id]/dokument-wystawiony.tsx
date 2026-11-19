'use client'
// Przycisk „Dokument wystawiony” sekcji „Dokument sprzedaży” karty zamówienia: po
// wysyłce bez faktury biuro potwierdza, że dokument (WZ albo faktura) jest w wFirmie. Najpierw okno potwierdzenia, wynik
// = toast. Bez uprawnienia przycisk zostaje widoczny i nieaktywny z powodem (zasada fal: funkcja nie znika).
import { useState, useTransition } from 'react'
import { Potwierdzenie, Przycisk, useToast } from '@/app/ui'
import { potwierdzDokument } from './akcje-faktura'

export function DokumentWystawiony({ orderId, powodWylaczenia }: { orderId: string; powodWylaczenia?: string | null }) {
  const [pending, start] = useTransition()
  const [otwarte, setOtwarte] = useState(false)
  const toast = useToast()
  const potwierdz = () => {
    setOtwarte(false)
    start(async () => {
      const r = await potwierdzDokument(orderId)
      if (r.blad) toast.blad(r.blad)
      else toast.sukces('Zapisane: pozycja zamknięta, Kompletor odczyta stan z wFirmy w ciągu kilku minut')
    })
  }
  return (
    <>
      <Przycisk wariant="drugorzedny" rozmiar="sm" ladowanie={pending} powodWylaczenia={powodWylaczenia ?? undefined} onClick={() => setOtwarte(true)}>
        Dokument wystawiony
      </Przycisk>
      <Potwierdzenie otwarte={otwarte} tytul="Dokument jest w wFirmie?" tak="Tak, dokument jest w wFirmie" onTak={potwierdz} onNie={() => setOtwarte(false)}>
        <p>Potwierdź tylko wtedy, gdy dokument tej wysyłki (WZ albo faktura) jest już w wFirmie. Kompletor zamknie pozycję „Wydane bez dokumentu”, niczego nie wystawi i odczyta stan magazynu z wFirmy.</p>
      </Potwierdzenie>
    </>
  )
}
