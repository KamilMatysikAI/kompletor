'use client'
// Formularz listy produktów bez stanu: po jednej pozycji w wierszu. Walidacja po stronie serwera.
import { useActionState } from 'react'
import { zapiszListe } from './akcje'
import type { StanListy } from './stan'

export function FormularzListy({ initial }: { initial: StanListy }) {
  const [state, action, pending] = useActionState(zapiszListe, initial)
  return (
    <form action={action} noValidate aria-label="Produkty bez stanu">
      {state.error && (
        <div className="banner red" role="alert" id="lista-blad">
          <div>
            <b>Nie zapisano.</b> {state.error}
          </div>
        </div>
      )}
      {state.savedAt && !state.error && (
        <div className="banner leaf-soft" role="status">
          <div>Zapisano. Lista działa od następnego importu katalogu.</div>
        </div>
      )}
      <div className="grid g2">
        <section className="card" aria-labelledby="h-skus">
          <div className="card-head">
            <h2 id="h-skus">SKU</h2>
            <span className="muted small">po jednym w wierszu</span>
          </div>
          <textarea
            className="input mono np-area"
            id="bs-skus"
            name="skus"
            aria-labelledby="h-skus"
            defaultValue={state.skus}
            key={`s-${state.savedAt ?? 0}`}
            rows={10}
            spellCheck={false}
            aria-describedby={state.error ? 'lista-blad' : undefined}
          />
        </section>
        <section className="card" aria-labelledby="h-kat">
          <div className="card-head">
            <h2 id="h-kat">Kategorie sklepu</h2>
            <span className="muted small">„konto sklepu:id kategorii”, np. sklep1:117</span>
          </div>
          <textarea
            className="input mono np-area"
            id="bs-kat"
            name="kategorie"
            aria-labelledby="h-kat"
            defaultValue={state.shopCategories}
            key={`k-${state.savedAt ?? 0}`}
            rows={10}
            spellCheck={false}
            aria-describedby={state.error ? 'lista-blad' : undefined}
          />
        </section>
      </div>
      <div className="np-actions">
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? 'Zapisywanie…' : 'Zapisz listę'}
        </button>
        <span className="muted small">Usunięcie z listy nie kasuje produktu i nie zmienia jego rodzaju.</span>
      </div>
    </form>
  )
}
