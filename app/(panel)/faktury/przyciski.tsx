'use client'
// Przyciski listy faktur: „Ponów” / „Wyślij do KSeF” w wierszu i „Wyślij korektę do KSeF” (lista i karta
// zwrotu). Wynik akcji = toast. Bez uprawnienia albo przy wyłączonym wystawianiu przycisk zostaje widoczny i nieaktywny
// z powodem (zasada fal: funkcja nie znika).
import { useState, useTransition } from 'react'
import { Przycisk, useToast } from '@/app/ui'
import { ponowDokument, wyslijKorekte } from './akcje'

export function PonowDokument({ klucz, etykieta = 'Ponów', powodWylaczenia, potwierdzenie }: { klucz: string; etykieta?: string; powodWylaczenia?: string | null; potwierdzenie?: boolean }) {
  const [pending, start] = useTransition()
  const [sprawdzone, setSprawdzone] = useState(false)
  const toast = useToast()
  const klik = () =>
    start(async () => {
      const r = await ponowDokument(klucz, potwierdzenie === true && sprawdzone)
      if (r.blad) toast.blad(r.blad)
      else toast.sukces(r.komunikat ?? 'Gotowe')
    })
  return (
    <>
      {potwierdzenie && !powodWylaczenia && (
        <label className="checkrow small">
          <input type="checkbox" checked={sprawdzone} onChange={(e) => setSprawdzone(e.target.checked)} />
          <span>Sprawdziłem w programie: tego dokumentu tam nie ma</span>
        </label>
      )}
      <Przycisk
        wariant="drugorzedny"
        rozmiar="sm"
        ladowanie={pending}
        powodWylaczenia={powodWylaczenia ?? (potwierdzenie && !sprawdzone ? 'Najpierw sprawdź w programie do faktur i zaznacz pole obok' : undefined)}
        onClick={klik}
      >
        {etykieta}
      </Przycisk>
    </>
  )
}

export function WyslijKorekte({ returnId, powodWylaczenia }: { returnId: string; powodWylaczenia?: string | null }) {
  const [pending, start] = useTransition()
  const toast = useToast()
  const klik = () =>
    start(async () => {
      const r = await wyslijKorekte(returnId)
      if (r.blad) toast.blad(r.blad)
      else toast.sukces(r.komunikat ?? 'Korekta wysłana do KSeF')
    })
  return (
    <Przycisk wariant="glowny" rozmiar="sm" ladowanie={pending} powodWylaczenia={powodWylaczenia ?? undefined} onClick={klik}>
      Wyślij korektę do KSeF
    </Przycisk>
  )
}
