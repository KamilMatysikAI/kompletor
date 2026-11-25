'use client'
// zwijana sekcja kuriera w kolejce pakowania („na początku listy zwinięte: DPD, Empik, InPost; dopiero po
// kliknięciu rozwijają się zamówienia”). Pasek kuriera (nazwa, liczniki, odbiór, „Pakuj …”, „Zamów kuriera”,
// „Przyjechał”) zostaje widoczny także w zwiniętej sekcji; zwija się tylko lista zamówień. Przełącznik to przycisk
// z `aria-expanded`/`aria-controls` w pasku. Zwinięte wiersze zostają w DOM (atrybut `hidden`), więc zaznaczenie,
// „Zaznacz wszystkie na stronie” i skan czytnikiem (skan-kolejki.tsx, niezależny od listy) działają jak dotąd.
// Rozwinięte sekcje pamięta ciasteczko (CIASTKO_ROZWINIETE): czyta je serwer, więc po odświeżeniu i na innej stronie
// kolejki sekcje są od razu w tym samym stanie, bez mignięcia.
import { createContext, useContext, useId, useState, type ReactNode } from 'react'
import { CIASTKO_ROZWINIETE, przelaczRozwiniete, rozwinieteZ } from '@/lib/pakowanie/zaznaczenie'

interface Sekcja {
  otwarta: boolean
  przelacz: () => void
  idPanelu: string
}

const Ctx = createContext<Sekcja | null>(null)

function zapamietaj(klucz: string, otwarta: boolean) {
  try {
    const teraz = document.cookie
      .split('; ')
      .find((c) => c.startsWith(`${CIASTKO_ROZWINIETE}=`))
      ?.slice(CIASTKO_ROZWINIETE.length + 1)
    const nowe = przelaczRozwiniete(rozwinieteZ(teraz), klucz, otwarta)
    document.cookie = `${CIASTKO_ROZWINIETE}=${encodeURIComponent(nowe.join(','))}; path=/pakowanie; max-age=31536000; samesite=lax`
  } catch {
    // bez ciasteczek sekcja działa, tylko nie pamięta stanu po odświeżeniu
  }
}

export function SekcjaKuriera({ klucz, etykieta, otwartaNaStart, children }: { klucz: string; etykieta: string; otwartaNaStart: boolean; children: ReactNode }) {
  const [otwarta, setOtwarta] = useState(otwartaNaStart)
  const idPanelu = `kurier-lista-${useId().replace(/:/g, '')}`
  const przelacz = () => {
    const n = !otwarta
    setOtwarta(n)
    zapamietaj(klucz, n)
  }
  return (
    <Ctx.Provider value={{ otwarta, przelacz, idPanelu }}>
      <section aria-label={`Kurier: ${etykieta}`} data-kurier={klucz} data-etykieta={etykieta} className={`c-sekcja${otwarta ? ' is-open' : ''}`}>
        {children}
      </section>
    </Ctx.Provider>
  )
}

/** Nazwa kuriera w pasku jako przycisk rozwijania (strzałka + nazwa + liczba zamówień do spakowania na liście). */
export function PrzelacznikKuriera({ etykieta, ile }: { etykieta: string; ile: number }) {
  const s = useContext(Ctx)
  if (!s) return <b>{etykieta}</b>
  return (
    <button type="button" className="c-przel" aria-expanded={s.otwarta} aria-controls={s.idPanelu} onClick={s.przelacz} title={s.otwarta ? `Zwiń listę: ${etykieta}` : `Pokaż zamówienia: ${etykieta}`}>
      <span className="c-przel-ikona" aria-hidden="true">
        {s.otwarta ? '▾' : '▸'}
      </span>
      <b>{etykieta}</b>
      {ile > 0 && <span className="sr"> ({ile} na liście)</span>}
      {/* widoczny napis: zamówienia są pod paskiem (prośba właściciela) */}
      <span className="c-przel-napis">{s.otwarta ? 'Zwiń' : ile > 0 ? `Rozwiń (${ile})` : 'Rozwiń'}</span>
    </button>
  )
}

/** Lista zamówień kuriera: w zwiniętej sekcji ukryta (zostaje w DOM, z `hidden`). */
export function PanelKuriera({ children }: { children: ReactNode }) {
  const s = useContext(Ctx)
  return (
    <div id={s?.idPanelu} hidden={s ? !s.otwarta : undefined} className="c-panel">
      {children}
    </div>
  )
}
