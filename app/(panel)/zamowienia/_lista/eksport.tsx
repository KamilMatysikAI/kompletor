'use client'
// Jeden „Eksport” listy zamówień: ikona w pasku akcji otwiera wybór zakresu (zaznaczone albo
// cały widok z filtrami i wyszukiwaniem) i formatu (CSV albo Excel XLSX). Wcześniej obok siebie stały
// wyłączony „Eksport CSV” zaznaczonych i aktywna ikona eksportu widoku, co myliło. Plik liczy serwer
// (`/api/zamowienia/eksport`): widok z parametrów listy (`qz`, nie fraza), zaznaczone z `z=<id,…>`.
import { useEffect, useState } from 'react'
import { useZaznaczenie } from '@/app/ui'
import { EKSPORT_MAKS, EKSPORT_ZAZNACZONE_MAKS } from '@/lib/zamowienia/eksport-csv'

export function IkonaEksportu() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11" />
    </svg>
  )
}

export function MenuEksportu({ widok, razem }: { /** adres eksportu bieżącego widoku (bez `format`) */ widok: string; razem: number }) {
  const z = useZaznaczenie()
  const ids = [...z.wybrane]
  const [zakres, setZakres] = useState<'zaznaczone' | 'widok'>('widok')
  // po zaznaczeniu domyślnie zaznaczone, po odznaczeniu wraca do widoku
  useEffect(() => setZakres(ids.length > 0 ? 'zaznaczone' : 'widok'), [ids.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps
  const zaznaczone = zakres === 'zaznaczone' && ids.length > 0
  const zaDuzo = zaznaczone ? ids.length > EKSPORT_ZAZNACZONE_MAKS : razem > EKSPORT_MAKS
  const href = zaznaczone ? `/api/zamowienia/eksport?z=${encodeURIComponent(ids.join(','))}` : widok
  return (
    <details className="ui-kolumny zl-eksport">
      <summary className="btn small ui-ikona-btn" title="Eksport: zaznaczone albo cały widok, CSV albo Excel (XLSX)">
        <IkonaEksportu />
        <span className="sr">Eksport</span>
      </summary>
      <div className="ui-kolumny-lista zl-eksport-menu">
        <fieldset>
          <legend>Co wyeksportować</legend>
          <label>
            <input type="radio" name="zl-eksport-zakres" checked={zaznaczone} disabled={ids.length === 0} onChange={() => setZakres('zaznaczone')} />
            Zaznaczone ({ids.length})
          </label>
          <label>
            <input type="radio" name="zl-eksport-zakres" checked={!zaznaczone} onChange={() => setZakres('widok')} />
            Cały widok z filtrami ({razem})
          </label>
        </fieldset>
        {zaDuzo ? (
          <p className="ui-pomoc">
            {zaznaczone ? `Najwyżej ${EKSPORT_ZAZNACZONE_MAKS} zaznaczonych zamówień w jednym pliku.` : `Najwyżej ${EKSPORT_MAKS} zamówień w jednym pliku: zawęź filtry.`}
          </p>
        ) : (
          <div className="zl-eksport-pliki">
            <a className="btn small" href={href} download>
              Pobierz CSV
            </a>
            <a className="btn small" href={`${href}&format=xlsx`} download title="Arkusz Excela: kwoty jako liczby, daty jako daty">
              Pobierz Excel (XLSX)
            </a>
          </div>
        )}
      </div>
    </details>
  )
}
