'use client'
// Wyszukiwarka punktów odbioru InPost na karcie zamówienia: kod paczkomatu, kod pocztowy albo miasto →
// lista punktów z adresem i stanem → „Wybierz” wpisuje kod do pola „Punkt odbioru” formularza poprawki. Zapis dopiero
// po „Zapisz poprawkę” (zwykła poprawka z wpisem w historii). Bez zagnieżdżonego formularza: pole w formularzu
// poprawki, Enter szuka zamiast wysyłać poprawkę.
import { useState, useTransition, type KeyboardEvent } from 'react'
import type { PunktZWyszukiwarki } from '@/lib/wysylka/punkt-inpost'
import { szukajPunktowAkcja } from './akcje-przesylka'

export function WyszukiwarkaPunktow({ orderId, onWybierz, zapis = 'zapisz poprawkę' }: { orderId: string; onWybierz: (nazwa: string) => void; zapis?: string }) {
  const [fraza, setFraza] = useState('')
  const [wynik, setWynik] = useState<{ punkty: PunktZWyszukiwarki[]; blad: string | null } | null>(null)
  const [wybrany, setWybrany] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const szukaj = () => {
    if (!fraza.trim()) return
    start(async () => setWynik(await szukajPunktowAkcja(orderId, fraza)))
  }
  const enter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    szukaj()
  }
  return (
    <div className="wp-punkty stack">
      <div className="field">
        <label htmlFor={`wp-${orderId}`}>Znajdź paczkomat InPost</label>
        <div className="wp-szukaj">
          <input id={`wp-${orderId}`} className="input" type="search" value={fraza} onChange={(e) => setFraza(e.target.value)} onKeyDown={enter} placeholder="kod paczkomatu, kod pocztowy albo miasto" autoComplete="off" maxLength={60} />
          <button type="button" className="btn" onClick={szukaj} disabled={pending || !fraza.trim()} aria-busy={pending || undefined}>
            {pending ? 'Szukam…' : 'Szukaj'}
          </button>
        </div>
        <p className="small muted">Lista punktów z publicznej wyszukiwarki InPost. Wybrany punkt trafi do pola „Punkt odbioru”: {zapis}, żeby go zmienić.</p>
      </div>
      {wynik?.blad && (
        <div className="banner amber" role="status">
          {wynik.blad}
        </div>
      )}
      {!!wynik?.punkty.length && (
        <ul className="wp-lista" aria-label="Znalezione punkty">
          {wynik.punkty.map((p) => (
            <li key={p.nazwa} className={wybrany === p.nazwa ? 'wp-wybrany' : undefined}>
              <div>
                <b>{p.nazwa}</b>
                {p.dziala === false && <span className="wp-uwaga"> nie działa</span>}
                {p.adres && <span className="small"> · {p.adres}</span>}
                {p.opis && <span className="small muted"> · {p.opis}</span>}
                {p.pobranie === false && <span className="small muted"> · bez pobrania</span>}
              </div>
              <button
                type="button"
                className="btn small"
                aria-pressed={wybrany === p.nazwa}
                onClick={() => {
                  setWybrany(p.nazwa)
                  onWybierz(p.nazwa)
                }}
              >
                {wybrany === p.nazwa ? 'Wybrany' : 'Wybierz'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
