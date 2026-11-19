'use client'
// Przycisk „Ponów fakturę” bloku „Faktura”. Wynik akcji = toast; przy braku uprawnienia albo gdy faktura
// jest w toku przycisk zostaje widoczny i nieaktywny z powodem (zasada fal: funkcja nie znika).
import { useTransition } from 'react'
import { Przycisk, useToast } from '@/app/ui'
import { ponowFakture } from './akcje-faktura'

export function PonowFakture({ orderId, powodWylaczenia }: { orderId: string; powodWylaczenia?: string | null }) {
  const [pending, start] = useTransition()
  const toast = useToast()
  const ponow = () =>
    start(async () => {
      const r = await ponowFakture(orderId)
      if (r.blad) toast.blad(r.blad)
      else toast.sukces('Faktura wróciła do kolejki: system spróbuje ją wystawić w ciągu kilku minut')
    })
  return (
    <Przycisk wariant="drugorzedny" rozmiar="sm" ladowanie={pending} powodWylaczenia={powodWylaczenia ?? undefined} onClick={ponow}>
      Ponów fakturę
    </Przycisk>
  )
}
