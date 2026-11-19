'use client'
// Przycisk „Poprawione w wFirmie” w wierszu listy „Do poprawy w wFirmie” (Braki towaru). Kliknięcie pobiera z serwera
// skutek liczony z bieżącego stanu (o ile wzrośnie stan dostępny, czy WZ do faktury brakuje w wFirmie), potem okno
// potwierdzenia, wynik = toast. Bez uprawnienia albo gdy WZ wystawi automat, przycisk widoczny i nieaktywny z powodem.
import { useState, useTransition } from 'react'
import { Potwierdzenie, Przycisk, useToast } from '@/app/ui'
import { tekstSkutku, warunekPoprawionego } from '@/lib/panel/poprawione-skutek'
import { poprawioneWWfirmie, skutekPoprawionegoWWfirmie } from './akcje'

export function PoprawioneWWfirmie({ movementId, rodzaj, opis, powodWylaczenia }: { movementId: string; rodzaj: string; opis: string; powodWylaczenia?: string | null }) {
  const [pending, start] = useTransition()
  const [okno, setOkno] = useState<{ skutek: string; ostrzezenie: string | null } | null>(null)
  const toast = useToast()
  const otworz = () =>
    start(async () => {
      const r = await skutekPoprawionegoWWfirmie(movementId)
      if (r.blad || !r.skutek) toast.blad(r.blad ?? 'Nie udało się policzyć skutku: odśwież stronę.')
      else if (r.skutek.blokada) toast.blad(r.skutek.blokada)
      else setOkno(tekstSkutku(r.skutek))
    })
  const potwierdz = () => {
    setOkno(null)
    start(async () => {
      const r = await poprawioneWWfirmie(movementId)
      if (r.blad) toast.blad(r.blad)
      else if (r.juzZamkniete) toast.sukces('Ta pozycja była już zamknięta: nic nie zmieniono')
      else toast.sukces('Zapisane: pozycja zamknięta, Kompletor odczyta stan z wFirmy w ciągu kilku minut')
    })
  }
  return (
    <>
      <Przycisk wariant="drugorzedny" rozmiar="sm" ladowanie={pending} powodWylaczenia={powodWylaczenia ?? undefined} onClick={otworz} aria-label={`Poprawione w wFirmie: ${opis}`}>
        Poprawione w wFirmie
      </Przycisk>
      <Potwierdzenie otwarte={okno !== null} tytul="Poprawione w wFirmie?" tak="Tak, poprawione w wFirmie" onTak={potwierdz} onNie={() => setOkno(null)}>
        {okno?.ostrzezenie && (
          <p role="alert">
            <strong>{okno.ostrzezenie}</strong>
          </p>
        )}
        <p>{okno?.skutek}</p>
        <p>Kliknij dopiero, gdy {warunekPoprawionego(rodzaj)}.</p>
        <p className="muted small">{opis}</p>
      </Potwierdzenie>
    </>
  )
}
