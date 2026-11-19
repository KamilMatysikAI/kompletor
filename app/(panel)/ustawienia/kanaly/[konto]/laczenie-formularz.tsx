'use client'
// Formularze akcji masowych „Łączenia ofert”: zaznaczone wiersze tabeli → akcja serwera, wynik w toaście.
import { useActionState } from 'react'
import { Przycisk, ToastPoAkcji, ZaznaczoneUkryte } from '@/app/ui'
import { polaczZaznaczone, zatwierdzZaznaczone, type StanLaczenia } from './laczenie-akcje'

const START: StanLaczenia = { ok: false, komunikat: null }

export function PolaczZaznaczone({ konto, po }: { konto: string; po: 'SKU' | 'EAN' }) {
  const [stan, akcja, pending] = useActionState(polaczZaznaczone, START)
  return (
    <form action={akcja}>
      <ToastPoAkcji stan={stan} />
      <input type="hidden" name="konto" value={konto} />
      <input type="hidden" name="po" value={po} />
      <ZaznaczoneUkryte />
      <Przycisk type="submit" wariant="glowny" rozmiar="sm" ladowanie={pending}>
        Połącz zaznaczone
      </Przycisk>
    </form>
  )
}

export function ZatwierdzZaznaczone({ konto }: { konto: string }) {
  const [stan, akcja, pending] = useActionState(zatwierdzZaznaczone, START)
  return (
    <form action={akcja}>
      <ToastPoAkcji stan={stan} />
      <input type="hidden" name="konto" value={konto} />
      <ZaznaczoneUkryte />
      <Przycisk type="submit" wariant="glowny" rozmiar="sm" ladowanie={pending}>
        Zatwierdź zaznaczone
      </Przycisk>
    </form>
  )
}
