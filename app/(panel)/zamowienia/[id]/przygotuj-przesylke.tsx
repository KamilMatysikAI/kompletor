'use client'
// Przycisk „Przygotuj” bloku „Przesyłka”: gabaryt opcjonalny, bez wyboru liczy z ćwiczenia pakowania.
// błąd jako toast, przycisk z app/ui.
import { useState, useTransition } from 'react'
import { Przycisk, useToast, Wybor } from '@/app/ui'
import { przygotujPrzesylke } from './akcje'

export function PrzygotujPrzesylke({ orderId, gabaryty, ponownie }: { orderId: string; gabaryty: { kod: string; nazwa: string }[]; ponownie: boolean }) {
  const [gabaryt, setGabaryt] = useState('')
  const [pending, start] = useTransition()
  const toast = useToast()
  const przygotuj = () =>
    start(async () => {
      const { blad } = await przygotujPrzesylke(orderId, gabaryt || null)
      if (blad) toast.blad(blad)
      else toast.sukces('Policzono przesyłkę.')
    })
  return (
    <div className="kz-wiersz kz-odstep-gora">
      {gabaryty.length > 1 && (
        <Wybor
          id={`pp-gabaryt-${orderId}`}
          etykieta="Gabaryt"
          value={gabaryt}
          onChange={(e) => setGabaryt(e.target.value)}
          opcje={[{ wartosc: '', etykieta: 'z pakowania albo podpowiedź' }, ...gabaryty.map((g) => ({ wartosc: g.kod, etykieta: g.nazwa }))]}
        />
      )}
      <Przycisk rozmiar="sm" ladowanie={pending} onClick={przygotuj}>
        {ponownie ? 'Policz przesyłkę ponownie' : 'Policz przesyłkę'}
      </Przycisk>
    </div>
  )
}
