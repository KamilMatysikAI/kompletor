'use client'
// Przycisk „Przygotuj” bloku „Faktura KSeF”: składa szkic w naszej bazie, nic nie wysyła.
// wynik jako toast, przycisk z app/ui.
import { useTransition } from 'react'
import { Przycisk, useToast } from '@/app/ui'
import { przygotujFaktureKsef } from './akcje-ksef'

export function PrzygotujKsef({ orderId, ponownie, zablokowany }: { orderId: string; ponownie: boolean; zablokowany: boolean }) {
  const [pending, start] = useTransition()
  const toast = useToast()
  if (zablokowany) return null
  const przygotuj = () =>
    start(async () => {
      const { blad } = await przygotujFaktureKsef(orderId)
      if (blad) toast.blad(blad)
      else toast.sukces('Przygotowano szkic faktury.')
    })
  return (
    <div className="kz-odstep-gora">
      <Przycisk rozmiar="sm" ladowanie={pending} onClick={przygotuj}>
        {ponownie ? 'Przygotuj szkic ponownie' : 'Przygotuj szkic faktury'}
      </Przycisk>
    </div>
  )
}
