'use client'
// „Utwórz własną firmę” na pulpicie firmy demo. Widoczne tylko, gdy lib/instalacja/kreator.ts pozwala
// (self-host, właściciel demo, brak innej firmy). Po sukcesie akcja przełącza sesję do nowej firmy.
import { useActionState } from 'react'
import { utworzWlasnaFirmeZDemo, type WlasnaFirmaState } from '@/app/akcje'
import { Karta, PoleTekstowe, Przelacznik, Przycisk } from '@/app/ui'

const START: WlasnaFirmaState = { error: null, nazwa: '' }

export function WlasnaFirma() {
  const [state, action, pending] = useActionState(utworzWlasnaFirmeZDemo, START)
  return (
    <Karta id="wlasna-firma" className="st-mb" tytul="To jest firma demo z danymi fikcyjnymi" opis="Gdy obejrzysz demo, załóż swoją firmę. Zaczniesz od pustego katalogu i listy uruchomienia; Twoje konto zostaje to samo.">
      <form action={action} className="st-wlasna" noValidate>
        <PoleTekstowe id="wf-nazwa" etykieta="Nazwa Twojej firmy" name="nazwa" defaultValue={state.nazwa} maxLength={120} autoComplete="organization" required blad={state.error ?? undefined} />
        <Przelacznik id="wf-demo" etykieta="Zostaw firmę demo do podglądu" name="zostawDemo" pomoc="Domyślnie demo znika z przełącznika firm, a dane fikcyjne zostają w bazie. Gdy zostawisz demo, klucze sklepów nowej firmy wpisujesz w panelu (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży)." />
        <div>
          <Przycisk type="submit" wariant="glowny" ladowanie={pending}>
            Utwórz własną firmę
          </Przycisk>
        </div>
      </form>
    </Karta>
  )
}
