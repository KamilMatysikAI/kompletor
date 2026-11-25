'use client'
// Pasek akcji na zaznaczonych produktach (zlecenie): „Wyłącz / włącz” — okno z wyborem i zapis
// dla zaznaczonych. Ten sam wzorzec co „Przypisz kategorię” (okno z paska akcji masowych).
import { useState } from 'react'
import { Modal, Przycisk, Wybor, ZaznaczoneUkryte, useZaznaczenie } from '@/app/ui'

export function ZmienAktywnosc({ akcja, maks, wroc, domyslnie }: { akcja: (form: FormData) => Promise<void>; maks: number; wroc: string; domyslnie: 'tak' | 'nie' }) {
  const z = useZaznaczenie()
  const [otwarte, setOtwarte] = useState(false)
  const [trwa, setTrwa] = useState(false)
  const ile = z.wybrane.size
  const powod = ile === 0 ? 'najpierw zaznacz produkty na liście' : ile > maks ? `najwyżej ${maks} produktów naraz` : undefined
  return (
    <>
      <Przycisk rozmiar="sm" onClick={() => setOtwarte(true)} powodWylaczenia={powod}>
        Wyłącz / włącz ({ile})
      </Przycisk>
      <Modal
        otwarty={otwarte}
        onZamknij={() => setOtwarte(false)}
        tytul={`Wyłącz albo włącz zaznaczone: ${ile}`}
        stopka={
          <>
            <Przycisk wariant="cichy" onClick={() => setOtwarte(false)}>
              Anuluj
            </Przycisk>
            <Przycisk wariant="glowny" type="submit" form="akt-masowo-form" ladowanie={trwa}>
              Zapisz
            </Przycisk>
          </>
        }
      >
        <form id="akt-masowo-form" action={akcja} onSubmit={() => setTrwa(true)}>
          <ZaznaczoneUkryte />
          <input type="hidden" name="wroc" value={wroc} />
          <Wybor
            id="akt-masowo"
            name="aktywny"
            etykieta="Co zrobić z zaznaczonymi"
            required
            defaultValue={domyslnie}
            opcje={[
              { wartosc: 'nie', etykieta: 'Wyłącz produkty' },
              { wartosc: 'tak', etykieta: 'Włącz produkty' },
            ]}
            pomoc="Wyłączony produkt znika z listy (zakładka „Wyłączone”), kafli i raportów; nic nie jest kasowane. Produkt z aktywną ofertą, rezerwacją, otwartym zamówieniem albo w aktywnym zestawie zostaje włączony i trafi do komunikatu z powodem."
          />
        </form>
      </Modal>
    </>
  )
}
