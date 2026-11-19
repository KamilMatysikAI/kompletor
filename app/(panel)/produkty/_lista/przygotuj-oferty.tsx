'use client'
// Pasek akcji na zaznaczonych produktach (3b-2): „Przygotuj oferty” z licznikiem. Zaznaczanie i pasek to te
// same części co na liście zamówień (app/ui/tabela-klient.tsx), tu tylko przycisk z formularzem akcji serwera.
import { useFormStatus } from 'react-dom'
import { Przycisk, ZaznaczoneUkryte, useZaznaczenie } from '@/app/ui'

function Wyslij({ ile, maks }: { ile: number; maks: number }) {
  const { pending } = useFormStatus()
  const powod = ile === 0 ? 'najpierw zaznacz produkty na liście' : ile > maks ? `najwyżej ${maks} produktów naraz` : null
  return (
    <Przycisk type="submit" wariant="glowny" rozmiar="sm" ladowanie={pending} powodWylaczenia={powod}>
      Przygotuj oferty ({ile})
    </Przycisk>
  )
}

export function PrzygotujOferty({ akcja, maks }: { akcja: (form: FormData) => Promise<void>; maks: number }) {
  const z = useZaznaczenie()
  return (
    <form className="inline" action={akcja} title="Sprawdza, czy zaznaczone produkty są gotowe do wystawienia na Allegro, Empiku i w sklepie. Nic nie wystawia.">
      <ZaznaczoneUkryte />
      <Wyslij ile={z.wybrane.size} maks={maks} />
    </form>
  )
}
