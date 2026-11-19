'use client'
// Agenci AI: formularz klucza agenta z jednorazowym pokazaniem pełnego klucza i gotowymi fragmentami
// konfiguracji klientów MCP (z kluczem tylko w tej chwili; na stałej liście poniżej — z miejscem <TWÓJ_KLUCZ>).
// Walidacja po stronie serwera (akcje.ts → lib/api/zarzadzanie.ts).
import { useActionState, useState } from 'react'
import type { ApiKeyFormState } from '@/lib/api/zarzadzanie'
import { clientConfigs, type ClientConfig } from '@/lib/mcp/konfiguracje'
import { utworzKluczAgenta } from './akcje'

const INITIAL: ApiKeyFormState = { error: null, created: null }

export function Kopiuj({ text, label = 'Kopiuj' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn small"
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
        } catch {
          setDone(false)
        }
      }}
    >
      {done ? 'Skopiowano' : label}
    </button>
  )
}

const MODE: Record<ClientConfig['mode'], { label: string; tone: string }> = {
  klucz: { label: 'działa kluczem', tone: 'leaf' },
  pomost: { label: 'przez pomost stdio', tone: 'blue' },
  oauth: { label: 'wkrótce (OAuth)', tone: 'amber' },
}

export function Konfiguracje({ url, token, open }: { url: string; token: string | null; open?: boolean }) {
  return (
    <div>
      {clientConfigs(url, token).map((c, i) => (
        <details className="agent" key={c.id} open={open && i === 0}>
          <summary>
            {c.title} <span className={`chip ${MODE[c.mode].tone}`}>{MODE[c.mode].label}</span>
          </summary>
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            {c.where}
          </p>
          {c.text && (
            <>
              <pre className="snippet" aria-label={`Konfiguracja: ${c.title}`}>
                {c.text}
              </pre>
              <div style={{ marginTop: 6 }}>
                <Kopiuj text={c.text} />
              </div>
            </>
          )}
          <p className="small" style={{ margin: '6px 0 0' }}>
            {c.note}
          </p>
        </details>
      ))}
    </div>
  )
}

export function NowyKluczAgenta({ url }: { url: string }) {
  const [state, action, pending] = useActionState(utworzKluczAgenta, INITIAL)
  return (
    <section className="card" aria-labelledby="h-nowy">
      <div className="card-head">
        <h2 id="h-nowy">Nowy klucz agenta</h2>
        <span className="muted small">Osobny klucz dla każdego agenta i każdej osoby</span>
      </div>
      {state.created && (
        <div className="banner leaf-soft" role="status" key={state.created.prefix}>
          <div>
            <b>Klucz „{state.created.name}” utworzony.</b> Skopiuj go teraz albo od razu jeden z gotowych fragmentów poniżej. Pełny klucz widać{' '}
            <b>tylko raz</b>: po odświeżeniu strony zostanie sam początek ({state.created.prefix}…).
            <div style={{ marginTop: 8 }}>
              <code className="mono" style={{ wordBreak: 'break-all', userSelect: 'all' }} aria-label="Pełny klucz agenta">
                {state.created.token}
              </code>
            </div>
            <div style={{ marginTop: 8 }}>
              <Kopiuj text={state.created.token} label="Kopiuj klucz" />
            </div>
            <div style={{ marginTop: 12 }}>
              <Konfiguracje url={url} token={state.created.token} open />
            </div>
          </div>
        </div>
      )}
      {state.error && (
        <div className="banner red" role="alert" id="agent-blad">
          <div>
            <b>Nie utworzono.</b> {state.error}
          </div>
        </div>
      )}
      <form action={action} aria-label="Nowy klucz agenta">
        <div className="field">
          <label htmlFor="f-nazwa">Nazwa (np. Claude Code — Anna, Cursor — biuro)</label>
          <input className="input" id="f-nazwa" name="nazwa" maxLength={80} required autoComplete="off" aria-describedby={state.error ? 'agent-blad' : undefined} />
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: '12px 0' }}>
          <legend className="small">Co agent może</legend>
          <label className="checkrow">
            <input type="checkbox" name="zakres" value="mcp:odczyt" defaultChecked disabled aria-describedby="z-odczyt" />
            <input type="hidden" name="zakres" value="mcp:odczyt" />
            <span>
              <b>Tylko odczyt</b>{' '}
              <span className="muted small" id="z-odczyt">
                zamówienia, stany, produkty, braki, rezerwacje, liczby dnia (zakres mcp:odczyt)
              </span>
            </span>
          </label>
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            Zapis (przygotowanie przesyłek i faktur z potwierdzeniem) dojdzie osobnym polem, gdy będą gotowe narzędzia zapisu. Dziś agent niczego nie zmienia.
          </p>
        </fieldset>
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? 'Tworzenie…' : 'Utwórz klucz agenta'}
        </button>
      </form>
    </section>
  )
}
