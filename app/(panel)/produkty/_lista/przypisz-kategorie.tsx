'use client'
// Pasek akcji na zaznaczonych produktach: „Przypisz kategorię” — okno z wyborem kategorii z drzewa firmy
// albo „Bez kategorii” i zapis dla zaznaczonych. Zaznaczanie, pasek i okno jak na liście zamówień (zmiana statusu).
import { useState } from 'react'
import { Modal, Przycisk, Wybor, ZaznaczoneUkryte, useZaznaczenie } from '@/app/ui'

export function PrzypiszKategorie({ akcja, opcje, maks, wroc }: { akcja: (form: FormData) => Promise<void>; opcje: { wartosc: string; etykieta: string }[]; maks: number; wroc: string }) {
  const z = useZaznaczenie()
  const [otwarte, setOtwarte] = useState(false)
  const [trwa, setTrwa] = useState(false)
  const ile = z.wybrane.size
  const powod = ile === 0 ? 'najpierw zaznacz produkty na liście' : ile > maks ? `najwyżej ${maks} produktów naraz` : undefined
  return (
    <>
      <Przycisk rozmiar="sm" onClick={() => setOtwarte(true)} powodWylaczenia={powod}>
        Przypisz kategorię ({ile})
      </Przycisk>
      <Modal
        otwarty={otwarte}
        onZamknij={() => setOtwarte(false)}
        tytul={`Kategoria dla zaznaczonych: ${ile}`}
        stopka={
          <>
            <Przycisk wariant="cichy" onClick={() => setOtwarte(false)}>
              Anuluj
            </Przycisk>
            <Przycisk wariant="glowny" type="submit" form="kat-masowo-form" ladowanie={trwa}>
              Przypisz kategorię
            </Przycisk>
          </>
        }
      >
        <form id="kat-masowo-form" action={akcja} onSubmit={() => setTrwa(true)}>
          <ZaznaczoneUkryte />
          <input type="hidden" name="wroc" value={wroc} />
          <Wybor
            id="kat-masowo"
            name="kategoria"
            etykieta="Kategoria"
            required
            defaultValue=""
            opcje={[{ wartosc: '', etykieta: 'Wybierz…' }, ...opcje]}
            pomoc="Kategoria zastępuje dotychczasową kategorię zaznaczonych produktów; zmiana trafia do historii każdego produktu."
          />
        </form>
      </Modal>
    </>
  )
}
