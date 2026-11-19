'use client'
// Klucze API: formularz nowego klucza z jednorazowym pokazaniem pełnego klucza i przycisk „Odwołaj”
// z potwierdzeniem. Walidacja wyłącznie po stronie serwera (lib/api/zarzadzanie.ts).
import { useActionState, useState } from 'react'
import type { ApiKeyFormState } from '@/lib/api/zarzadzanie'
import { API_SCOPES, type ApiScope } from '@/lib/api/zakresy'
import { odwolajKlucz, utworzKlucz } from './akcje'
import { PrzyciskPotwierdz } from '@/app/ui'

const INITIAL: ApiKeyFormState = { error: null, created: null }

export interface KontoDoWyboru {
  /** `<KANAŁ>:<id konta>` */
  wartosc: string
  nazwa: string
}

export function NowyKlucz({ konta }: { konta: KontoDoWyboru[] }) {
  const [state, action, pending] = useActionState(utworzKlucz, INITIAL)
  const [copied, setCopied] = useState(false)
  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <section className="card" aria-labelledby="h-nowy">
      <div className="card-head">
        <h2 id="h-nowy">Nowy klucz</h2>
        <span className="muted small">Osobny klucz dla każdego systemu, tylko potrzebne zakresy</span>
      </div>
      {state.created && (
        <div className="banner leaf-soft" role="status" key={state.created.prefix}>
          <div>
            <b>Klucz „{state.created.name}” utworzony.</b> Skopiuj go teraz i wpisz w systemie, który ma z niego korzystać. Pełny klucz
            widać <b>tylko raz</b>: po odświeżeniu strony zostanie sam początek ({state.created.prefix}…).
            <div style={{ marginTop: 8 }}>
              <code className="mono" style={{ wordBreak: 'break-all', userSelect: 'all' }} aria-label="Pełny klucz API">
                {state.created.token}
              </code>
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="btn" type="button" onClick={() => copy(state.created!.token)}>
                {copied ? 'Skopiowano' : 'Kopiuj klucz'}
              </button>
            </div>
          </div>
        </div>
      )}
      {state.error && (
        <div className="banner red" role="alert" id="klucz-blad">
          <div>
            <b>Nie utworzono.</b> {state.error}
          </div>
        </div>
      )}
      <form action={action} onSubmit={() => setCopied(false)} aria-label="Nowy klucz API">
        <div className="field">
          <label htmlFor="f-nazwa">Nazwa (np. chatbot, sprzedaż e-booków, sklep hurtowy)</label>
          <input className="input" id="f-nazwa" name="nazwa" maxLength={80} required autoComplete="off" aria-describedby={state.error ? 'klucz-blad' : undefined} />
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: '12px 0' }}>
          <legend className="small">Zakresy</legend>
          {(Object.keys(API_SCOPES) as ApiScope[]).map((s) => (
            <label className="checkrow" key={s}>
              <input type="checkbox" name="zakres" value={s} /> <span className="mono small">{s}</span> <span className="muted small">{API_SCOPES[s]}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: '12px 0' }} aria-describedby="konta-opis">
          <legend className="small">Konta sprzedaży (tylko klucz obsługi klienta)</legend>
          <div className="muted small" id="konta-opis">
            Klucz <span className="mono">obsluga:odczyt</span> widzi zamówienia wyłącznie zaznaczonych kont. Zaznacz co najmniej jedno albo świadomie wszystkie konta firmy.
          </div>
          {konta.map((k) => (
            <label className="checkrow" key={k.wartosc}>
              <input type="checkbox" name="konto" value={k.wartosc} /> <span className="small">{k.nazwa}</span>
            </label>
          ))}
          <label className="checkrow" style={{ marginTop: 8 }}>
            <input type="checkbox" name="konta_wszystkie" value="tak" /> <b className="small">Wszystkie konta firmy</b>{' '}
            <span className="muted small">(także konta dodane później)</span>
          </label>
        </fieldset>
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? 'Tworzenie…' : 'Utwórz klucz'}
        </button>
      </form>
    </section>
  )
}

export function OdwolajKlucz({ id, name }: { id: string; name: string }) {
  const [error, action, pending] = useActionState(odwolajKlucz, null)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <PrzyciskPotwierdz
        disabled={pending}
        wariantTak="niebezpieczny"
        tytul={`Odwołać klucz „${name}”?`}
        pytanie="System, który go używa, od razu dostanie odmowę. Tego nie da się cofnąć."
        tak="Odwołaj klucz"
      >
        {pending ? "Odwoływanie…" : "Odwołaj"}
      </PrzyciskPotwierdz>
      {error && (
        <span className="small" role="alert">
          {' '}
          {error}
        </span>
      )}
    </form>
  )
}
