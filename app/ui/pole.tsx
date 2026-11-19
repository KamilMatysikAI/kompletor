// pola formularza. Etykieta nad polem, opis pod polem, błąd pod polem (powiązane przez aria-describedby,
// błąd dodatkowo aria-invalid), znacznik „opcjonalne”. Bez hooków: działa w komponentach serwerowych i klienckich.
// Hasło z przyciskiem „pokaż”: app/ui/pole-hasla.tsx (kliencki).
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

export interface PoleWspolne {
  id: string
  etykieta: ReactNode
  /** krótki opis pod polem (format, przykład, skutek) */
  pomoc?: ReactNode
  /** komunikat błędu pod polem; ustawia aria-invalid */
  blad?: ReactNode
  opcjonalne?: boolean
  className?: string
}

/** Atrybuty dostępności dla kontrolki w `Pole` (do użycia także z własną kontrolką). */
export function atrybutyPola(p: Pick<PoleWspolne, 'id' | 'pomoc' | 'blad'>): { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true } {
  const opis = [p.pomoc ? `${p.id}-pomoc` : '', p.blad ? `${p.id}-blad` : ''].filter(Boolean).join(' ')
  return { id: p.id, ...(opis ? { 'aria-describedby': opis } : {}), ...(p.blad ? { 'aria-invalid': true as const } : {}) }
}

/** Rama pola: etykieta, kontrolka (children), opis i błąd. Kontrolka musi mieć `{...atrybutyPola(p)}`. */
export function Pole({ id, etykieta, pomoc, blad, opcjonalne, className, children }: PoleWspolne & { children: ReactNode }) {
  return (
    <div className={['field', 'ui-pole', blad ? 'ui-pole-blad' : '', className].filter(Boolean).join(' ')}>
      <label htmlFor={id}>
        {etykieta}
        {opcjonalne && <span className="ui-opcjonalne"> (opcjonalne)</span>}
      </label>
      {children}
      {pomoc && (
        <p className="ui-pomoc" id={`${id}-pomoc`}>
          {pomoc}
        </p>
      )}
      {blad && (
        <p className="ui-blad" id={`${id}-blad`} role="alert">
          {blad}
        </p>
      )}
    </div>
  )
}

type InputBez = Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'>

export function PoleTekstowe({ id, etykieta, pomoc, blad, opcjonalne, className, ...input }: PoleWspolne & InputBez) {
  return (
    <Pole id={id} etykieta={etykieta} pomoc={pomoc} blad={blad} opcjonalne={opcjonalne} className={className}>
      <input type="text" {...input} {...atrybutyPola({ id, pomoc, blad })} className="input" />
    </Pole>
  )
}

/** Pole liczbowe z jednostką w polu (szt., zł, dni), zamiast jednostki w etykiecie. */
export function PoleLiczbowe({ id, etykieta, pomoc, blad, opcjonalne, className, jednostka, ...input }: PoleWspolne & InputBez & { jednostka?: string }) {
  return (
    <Pole id={id} etykieta={etykieta} pomoc={pomoc} blad={blad} opcjonalne={opcjonalne} className={className}>
      <span className="ui-z-jednostka">
        <input type="number" inputMode="decimal" {...input} {...atrybutyPola({ id, pomoc, blad })} className="input" />
        {jednostka && <span aria-hidden="true">{jednostka}</span>}
      </span>
    </Pole>
  )
}

export function PoleWielowierszowe({ id, etykieta, pomoc, blad, opcjonalne, className, ...ta }: PoleWspolne & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'className'>) {
  return (
    <Pole id={id} etykieta={etykieta} pomoc={pomoc} blad={blad} opcjonalne={opcjonalne} className={className}>
      <textarea rows={4} {...ta} {...atrybutyPola({ id, pomoc, blad })} className="input ui-textarea" />
    </Pole>
  )
}

export function Wybor({
  id,
  etykieta,
  pomoc,
  blad,
  opcjonalne,
  className,
  opcje,
  ...select
}: PoleWspolne & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'className'> & { opcje: { wartosc: string; etykieta: string; wylaczona?: boolean }[] }) {
  return (
    <Pole id={id} etykieta={etykieta} pomoc={pomoc} blad={blad} opcjonalne={opcjonalne} className={className}>
      <select {...select} {...atrybutyPola({ id, pomoc, blad })} className="input">
        {opcje.map((o) => (
          <option key={o.wartosc} value={o.wartosc} disabled={o.wylaczona}>
            {o.etykieta}
          </option>
        ))}
      </select>
    </Pole>
  )
}

/** Przełącznik tak/nie (checkbox w roli switch) z etykietą obok i opisem pod spodem. */
export function Przelacznik({ id, etykieta, pomoc, blad, className, ...input }: Omit<PoleWspolne, 'opcjonalne'> & Omit<InputBez, 'type'>) {
  return (
    <div className={['ui-pole', className].filter(Boolean).join(' ')}>
      <label className="toggle" htmlFor={id}>
        <input type="checkbox" role="switch" {...input} {...atrybutyPola({ id, pomoc, blad })} />
        <span>{etykieta}</span>
      </label>
      {pomoc && (
        <p className="ui-pomoc" id={`${id}-pomoc`}>
          {pomoc}
        </p>
      )}
      {blad && (
        <p className="ui-blad" id={`${id}-blad`} role="alert">
          {blad}
        </p>
      )}
    </div>
  )
}

/**
 * wybór jednej z kilku opcji (radio) z legendą, np. rozstrzygnięcie przesyłki. Opcje jedna pod drugą,
 * cel dotyku 44 px; `opis` opcji pod jej etykietą.
 */
export function WyborJednej({
  legenda,
  name,
  opcje,
  domyslna,
  className,
}: {
  legenda: ReactNode
  name: string
  opcje: { wartosc: string; etykieta: ReactNode; opis?: ReactNode }[]
  domyslna?: string
  className?: string
}) {
  return (
    <fieldset className={['ui-pole', 'ui-radio', className].filter(Boolean).join(' ')}>
      <legend>{legenda}</legend>
      {opcje.map((o) => (
        <label key={o.wartosc} className="ui-radio-opcja">
          <input type="radio" name={name} value={o.wartosc} defaultChecked={o.wartosc === domyslna} />
          <span>
            {o.etykieta}
            {o.opis && <span className="ui-pomoc">{o.opis}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  )
}

/** Sekcja „Zaawansowane”: pola rzadko zmieniane, domyślnie zwinięte. */
export function Zaawansowane({ children, tytul = 'Zaawansowane', otwarte }: { children: ReactNode; tytul?: ReactNode; otwarte?: boolean }) {
  return (
    <details className="ui-zaawansowane" open={otwarte}>
      <summary>{tytul}</summary>
      <div className="ui-zaawansowane-tresc">{children}</div>
    </details>
  )
}
