'use client'
// Ustawienia → Przewoźnicy → karta „Automatyczne statusy wysyłki”: przełączniki firmy, lista przewoźników do śledzenia
// i lista przewoźników objętych regułami na osi statusów, z jednym zapisem. Sekcja istniejącego ekranu, bez nowej
// pozycji w menu.
import { useActionState } from 'react'
import { Karta, PasekZapisu, Przelacznik, ToastPoAkcji } from '@/app/ui'
import type { AutomatyWysylki } from '@/lib/wysylka/automaty'
import { zapiszAutomaty, type StanAutomatow } from './akcje-automaty'

export interface ModulSledzenia {
  adapterKey: string
  nazwa: string
  wlaczone: boolean
}

export function FormularzAutomatow({
  automaty,
  opisy,
  sledzenie = [],
  reguly = [],
}: {
  automaty: AutomatyWysylki
  opisy: Record<keyof AutomatyWysylki, { nazwa: string; opis: string }>
  sledzenie?: ModulSledzenia[]
  /** przewoźnicy objęci regułami „Doręczona paczka = Odebrane” i powiadomieniami o zwrocie (domyślnie InPost, Poczta Polska i Wysyłam z Allegro) */
  reguly?: ModulSledzenia[]
}) {
  const [stan, akcja, trwa] = useActionState<StanAutomatow, FormData>(zapiszAutomaty, {})
  const a = stan.automaty ?? automaty
  const wybory = stan.sledzenie ?? Object.fromEntries(sledzenie.map((m) => [m.adapterKey, m.wlaczone]))
  const wyboryRegul = stan.reguly ?? Object.fromEntries(reguly.map((m) => [m.adapterKey, m.wlaczone]))
  const pola = Object.keys(opisy) as (keyof AutomatyWysylki)[]
  return (
    <Karta tytul="Automatyczne statusy wysyłki" opis="Co Kompletor robi sam po przyjeździe kuriera i po terminie płatności. Sklep dostaje zmianę tylko wtedy, gdy jego konto ma włączony zapis do sklepu." className="przew-automaty">
      <form action={akcja} aria-label="Automatyczne statusy wysyłki">
        <ToastPoAkcji stan={stan} />
        {pola.map((k) => (
          <Przelacznik key={`${k}-${String(a[k])}`} id={`automat-${k}`} name={k} value="tak" etykieta={opisy[k].nazwa} pomoc={opisy[k].opis} defaultChecked={a[k]} />
        ))}
        {sledzenie.length > 0 && (
          <fieldset className="przew-automaty-sledzenie">
            <legend>Których przewoźników pytać o paczki</legend>
            <p className="muted">Działa razem z przełącznikiem „Sprawdzaj u przewoźnika, czy paczka pojechała”. Przewoźnik dodany później jest domyślnie wyłączony; „Przyjechał kurier” działa zawsze.</p>
            {sledzenie.map((m) => (
              <Przelacznik key={`${m.adapterKey}-${String(wybory[m.adapterKey])}`} id={`sledzenie-${m.adapterKey}`} name={`sledzenie:${m.adapterKey}`} value="tak" etykieta={m.nazwa} defaultChecked={wybory[m.adapterKey] === true} />
            ))}
          </fieldset>
        )}
        {reguly.length > 0 && (
          <fieldset className="przew-automaty-sledzenie">
            <legend>Dla których przewoźników doręczenie i zwrot zmieniają status albo dają powiadomienie</legend>
            <p className="muted">Dotyczy przełączników „Doręczona paczka = Odebrane” i „Powiadamiaj o zwrocie i problemie z paczką”. DPD jest domyślnie wyłączony, dopóki nie potwierdzimy u przewoźnika, które jego kody oznaczają doręczenie i zwrot; drogę paczki DPD widać w historii zamówienia także bez zaznaczenia.</p>
            {reguly.map((m) => (
              <Przelacznik key={`reguly-${m.adapterKey}-${String(wyboryRegul[m.adapterKey])}`} id={`reguly-${m.adapterKey}`} name={`reguly:${m.adapterKey}`} value="tak" etykieta={m.nazwa} defaultChecked={wyboryRegul[m.adapterKey] === true} />
            ))}
          </fieldset>
        )}
        <PasekZapisu oczekuje={trwa} />
      </form>
    </Karta>
  )
}
