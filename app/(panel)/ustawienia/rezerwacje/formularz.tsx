'use client'
// Formularz zasad rezerwacji: przełącznik sezonu, dni robocze dla obu trybów i przykład słowami,
// który zmienia się razem z wpisywanymi liczbami. Walidacja wyłącznie po stronie serwera (updatePolicy).
// PasekZapisu zamiast przycisku „Zapisz zasady”, wynik jako toast, błąd pod polem, którego dotyczy.
import { useActionState, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import Link from 'next/link'
import { PasekZapisu, ToastPoAkcji } from '@/app/ui'
import {
  DAY_KEYS,
  FIELD_LABEL,
  HOURS_KEY,
  REMINDER_DAYS_KEY,
  failedOnlineExample,
  failedOnlineReminderExample,
  maxOf,
  minOf,
  modeLabel,
  outOfStockExample,
  unpaidExample,
  type PolicyDaysKey,
  type PolicyFormState,
  type PolicyFormValues,
} from '@/lib/panel/ustawienia-rezerwacji-opis'
import { zapiszZasady } from './akcje'

const SHORT_LABEL: Record<PolicyDaysKey, string> = {
  normalReminderBusinessDays: 'Przypomnienie o płatności po',
  normalReleaseBusinessDays: 'Zwolnienie rezerwacji po',
  seasonReminderBusinessDays: 'Przypomnienie o płatności po',
  seasonReleaseBusinessDays: 'Zwolnienie rezerwacji po',
  allOutOfStockWaitBusinessDays: 'Czekamy na dostawę',
  failedOnlinePaymentHoldHours: 'Trzymaj towar przez',
  failedOnlinePaymentReminderDays: 'Zapytaj o płatność po',
}

const num = (s: string) => (s.trim() === '' ? Number.NaN : Number(s.replace(',', '.')))

export function FormularzZasad({ initial, bezDanychPrzelewu = null }: { initial: PolicyFormState; bezDanychPrzelewu?: string | null }) {
  const [state, action, pending] = useActionState(zapiszZasady, initial)
  const [v, setV] = useState<PolicyFormValues>(state.values)
  useEffect(() => setV(state.values), [state])
  const set = (k: PolicyDaysKey) => (e: ChangeEvent<HTMLInputElement>) => setV((p) => ({ ...p, [k]: e.target.value }))
  const current = state.current.seasonMode
  const changesMode = v.seasonMode !== current
  // stan dla toastu: nowy obiekt tylko przy nowym wyniku akcji (ToastPoAkcji porównuje referencje)
  const wynik = useMemo(
    () => (state.error ? { ok: false, komunikat: `Nie zapisano. ${state.error}` } : state.savedAt ? { ok: true, komunikat: `Zapisano. Obowiązuje tryb ${modeLabel(state.current.seasonMode)} dla zamówień przyjmowanych od teraz.` } : null),
    [state],
  )

  const field = (k: PolicyDaysKey) => {
    const bad = state.field === k || (state.field === 'order' && k !== 'allOutOfStockWaitBusinessDays' && k !== HOURS_KEY && k !== REMINDER_DAYS_KEY)
    const godziny = k === HOURS_KEY
    const kalendarzowe = k === REMINDER_DAYS_KEY
    const jednostka = godziny ? 'godzin' : kalendarzowe ? 'dni' : 'dni roboczych'
    return (
      <div className="field" key={k}>
        <label htmlFor={`f-${k}`}>{SHORT_LABEL[k]}</label>
        <div className="numunit">
          <input
            className="input"
            id={`f-${k}`}
            name={k}
            type="number"
            inputMode="numeric"
            min={minOf(k)}
            max={maxOf(k)}
            step={1}
            value={v[k]}
            onChange={set(k)}
            aria-invalid={bad || undefined}
            aria-describedby={bad ? `zasady-blad-${k}` : undefined}
            aria-label={`${FIELD_LABEL[k]} (${godziny ? 'godziny' : kalendarzowe ? 'dni kalendarzowe' : 'dni robocze'})`}
          />
          <span>{jednostka}</span>
        </div>
        {bad && state.error && (
          <p className="ui-blad" id={`zasady-blad-${k}`} role="alert">
            {state.error}
          </p>
        )}
      </div>
    )
  }

  const example = (text: string | null, max = 30) => <p className="pol-ex small">{text ? `Przykład: ${text}.` : `Przykład pojawi się po wpisaniu liczb od 0 do ${max}.`}</p>

  return (
    <form action={action} noValidate aria-label="Zasady rezerwacji" onReset={() => setV(state.values)}>
      <input type="hidden" name="wersja" value={state.version} />
      {/* błąd przypisany do pola pokazujemy pod polem; inny (np. cudzy zapis w międzyczasie) jako toast */}
      <ToastPoAkcji stan={wynik} bledy={!state.field} />

      <section className="card" aria-labelledby="h-sezon">
        <div className="card-head">
          <h2 id="h-sezon">Tryb sezonowy</h2>
          <span className={`chip ${current ? 'amber' : 'leaf'}`}>teraz obowiązuje: tryb {modeLabel(current)}</span>
        </div>
        <label className="toggle">
          <input type="checkbox" name="seasonMode" value="tak" checked={v.seasonMode} onChange={(e) => setV((p) => ({ ...p, seasonMode: e.target.checked }))} />
          Tryb sezonowy {v.seasonMode ? 'włączony' : 'wyłączony'}
        </label>
        <p className="small" style={{ marginBottom: 0 }}>
          Przełączenie dotyczy <b>zamówień, które system przyjmie po zapisaniu zmiany</b>, także przywróconych po anulowaniu. Terminy liczymy
          od daty złożenia zamówienia w kanale, a przy przywróconym od chwili przywrócenia. Zamówienia już przyjęte zachowują swoje terminy.
          Sezon włącza się i wyłącza wyłącznie tym przełącznikiem, nie ma dat automatycznych.
        </p>
        {changesMode && (
          <p className="small pol-pending" role="status">
            Po zapisaniu nowo przyjęte zamówienia dostaną terminy trybu <b>{modeLabel(v.seasonMode)}</b>.
          </p>
        )}
      </section>

      <div className="grid g2 pol-modes">
        {([false, true] as const).map((season) => {
          const [r, z] = (season ? DAY_KEYS.slice(2, 4) : DAY_KEYS.slice(0, 2)) as [PolicyDaysKey, PolicyDaysKey]
          return (
            <fieldset className="card pol-mode" key={String(season)} aria-describedby={`ex-${String(season)}`}>
              <legend className="sr">Tryb {modeLabel(season)}</legend>
              <div className="card-head">
                <h2 aria-hidden="true">Tryb {modeLabel(season)}</h2>
                {v.seasonMode === season && <span className="chip solid">{current === season ? 'obowiązuje' : 'po zapisaniu'}</span>}
              </div>
              <div className="pol-fields">
                {field(r)}
                {field(z)}
              </div>
              <div id={`ex-${String(season)}`}>{example(unpaidExample(num(v[r]), num(v[z])))}</div>
            </fieldset>
          )
        })}
      </div>

      <fieldset className="card" aria-describedby="ex-brak">
        <legend className="sr">Brakuje wszystkiego</legend>
        <div className="card-head">
          <h2 aria-hidden="true">„Brakuje wszystkiego”</h2>
          <span className="muted small">Zamówienie, w którym nie ma na stanie żadnej pozycji (w obu trybach tak samo)</span>
        </div>
        <div className="pol-fields">{field('allOutOfStockWaitBusinessDays')}</div>
        <div id="ex-brak">{example(outOfStockExample(num(v.allOutOfStockWaitBusinessDays)))}</div>
      </fieldset>

      <fieldset className="card" aria-describedby="ex-online">
        <legend className="sr">Nieudana płatność online</legend>
        <div className="card-head">
          <h2 aria-hidden="true">Nieudana płatność online</h2>
          <span className="muted small">Bramka odrzuciła płatność (np. BLIK albo karta), zamówienie zostaje nieopłacone (w obu trybach tak samo)</span>
        </div>
        {bezDanychPrzelewu && (
          <div className="banner amber" role="status">
            <div>
              {bezDanychPrzelewu} <Link href="/ustawienia/firma">Otwórz Dane firmy</Link>
            </div>
          </div>
        )}
        <div className="pol-fields">
          {field(HOURS_KEY)}
          {field(REMINDER_DAYS_KEY)}
        </div>
        <div id="ex-online">
          {example(failedOnlineExample(num(v[HOURS_KEY])), maxOf(HOURS_KEY))}
          {example(failedOnlineReminderExample(num(v[REMINDER_DAYS_KEY])), maxOf(REMINDER_DAYS_KEY))}
        </div>
        <p className="small" style={{ marginBottom: 0 }}>
          Godziny zegarowe od złożenia zamówienia, także w weekend; 0 = towar od razu wraca do sprzedaży. Po tym czasie towar
          wraca do sprzedaży, ale zamówienie nie jest anulowane ani u nas, ani w sklepie: czeka na płatność do zwykłego
          terminu z trybu wyżej i dopiero wtedy jest anulowane jak każde nieopłacone. Gdy klient zapłaci, zamówienie idzie do
          realizacji i rezerwuje to, co jest na stanie (reszta na liście braków). Gdy wybierze przelew tradycyjny, towar
          wraca do zamówienia od razu. Przelew tradycyjny od początku i pozostałe nieopłacone czekają zwykły termin.
        </p>
        <p className="small" style={{ marginBottom: 0 }}>
          Pytanie o płatność to mail „Nieudana płatność online” (zamiast zwykłego przypomnienia o płatności): rano, o 9:00,
          po tylu dniach kalendarzowych od dnia złożenia zamówienia (1 = następnego dnia), z danymi do przelewu z Ustawienia →
          Dokumenty i faktury → Dane firmy (nazwa i rachunek bankowy). Bez rachunku albo pełnej nazwy klient dostaje w tym
          samym terminie zwykłe przypomnienie o płatności, a informację widać w menu Przejście z BaseLinkera → „Maile do
          klientów: podgląd”. Gdy rano o 9:00 już minęła (np. bramka odrzuciła płatność dopiero po kilku dniach), pytanie
          wychodzi najbliższego ranka o 9:00, nigdy od razu. Częściowo opłacone, opłacone, anulowane i przełączone na przelew
          tradycyjny dostają zwykłe przypomnienie.
        </p>
      </fieldset>

      <p className="muted small">Dni robocze liczone od złożenia zamówienia w kanale (bez weekendów i świąt).</p>
      <PasekZapisu zapisz="Zapisz zasady" oczekuje={pending} />
    </form>
  )
}
