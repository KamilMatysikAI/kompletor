'use client'
// pole hasła z przyciskiem „Pokaż / Ukryj” (przegląd 06.11: brak podglądu hasła przy zmianie hasła).
import { useState, type InputHTMLAttributes } from 'react'
import { atrybutyPola, Pole, type PoleWspolne } from './pole'

export function PoleHasla({ id, etykieta, pomoc, blad, opcjonalne, className, ...input }: PoleWspolne & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className' | 'type'>) {
  const [widoczne, setWidoczne] = useState(false)
  return (
    <Pole id={id} etykieta={etykieta} pomoc={pomoc} blad={blad} opcjonalne={opcjonalne} className={className}>
      <span className="ui-haslo">
        <input {...input} {...atrybutyPola({ id, pomoc, blad })} type={widoczne ? 'text' : 'password'} className="input" />
        <button type="button" className="btn ghost small" aria-controls={id} aria-pressed={widoczne} onClick={() => setWidoczne((v) => !v)}>
          {widoczne ? 'Ukryj' : 'Pokaż'}
        </button>
      </span>
    </Pole>
  )
}
