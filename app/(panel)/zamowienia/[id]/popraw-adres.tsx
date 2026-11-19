'use client'
// „Popraw adres i punkt odbioru”: przed nadaniem, dla osób z `klienci.dane`. Otwarcie formularza pobiera
// obecne wartości (wpis w dzienniku podglądów), zapis idzie jako poprawka człowieka (automat z kanału jej nie nadpisze).
// Po utworzeniu przesyłki formularza nie ma: adres zmienia się wtedy w panelu przewoźnika.
import { useRef, useState, useTransition } from 'react'
import { WyszukiwarkaPunktow } from './wyszukiwarka-punktow'
import type { PoprawkaDostawy } from '@/lib/klienci/poprawka'
import { daneDoPoprawkiAkcja, poprawAdresAkcja, type WynikPrzyciskuPrzesylki } from './akcje-przesylka'

export const POLA: { nazwa: string; klucz: keyof PoprawkaDostawy; etykieta: string; autocomplete?: string }[] = [
  { nazwa: 'imie', klucz: 'imieNazwisko', etykieta: 'Imię i nazwisko', autocomplete: 'name' },
  { nazwa: 'firma', klucz: 'firma', etykieta: 'Firma', autocomplete: 'organization' },
  { nazwa: 'ulica', klucz: 'ulica', etykieta: 'Ulica', autocomplete: 'address-line1' },
  { nazwa: 'dom', klucz: 'numerDomu', etykieta: 'Numer domu' },
  { nazwa: 'lokal', klucz: 'numerLokalu', etykieta: 'Numer lokalu' },
  { nazwa: 'kod', klucz: 'kodPocztowy', etykieta: 'Kod pocztowy (NN-NNN)', autocomplete: 'postal-code' },
  { nazwa: 'miasto', klucz: 'miasto', etykieta: 'Miasto', autocomplete: 'address-level2' },
  { nazwa: 'telefon', klucz: 'telefon', etykieta: 'Telefon', autocomplete: 'tel' },
  { nazwa: 'punkt', klucz: 'punkt', etykieta: 'Punkt odbioru (np. kod paczkomatu)' },
]

export function PoprawAdres({ orderId }: { orderId: string }) {
  const [dane, setDane] = useState<PoprawkaDostawy | null | undefined>(undefined)
  const [wynik, setWynik] = useState<WynikPrzyciskuPrzesylki | null>(null)
  const [pending, start] = useTransition()
  const [zWyszukiwarki, setZWyszukiwarki] = useState(false)
  const punkt = useRef<HTMLInputElement>(null)
  const otworz = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open && dane === undefined) start(async () => setDane(await daneDoPoprawkiAkcja(orderId)))
  }
  const zapisz = (form: FormData) =>
    start(async () => {
      setWynik(await poprawAdresAkcja(orderId, form))
    })
  return (
    <details onToggle={otworz}>
      <summary className="small">Popraw adres albo punkt odbioru przed nadaniem</summary>
      {dane === undefined ? (
        <p className="small muted">Wczytuję…</p>
      ) : (
        <form action={zapisz} className="stack">
          <div className="grid g2">
            {POLA.map((p) => (
              <div key={p.nazwa} className="field">
                <label htmlFor={`pa-${p.nazwa}`}>{p.etykieta}</label>
                <input
                  id={`pa-${p.nazwa}`}
                  name={p.nazwa}
                  className="input"
                  defaultValue={dane?.[p.klucz] ?? ''}
                  autoComplete={p.autocomplete ?? 'off'}
                  ref={p.nazwa === 'punkt' ? punkt : undefined}
                  onInput={p.nazwa === 'punkt' ? () => setZWyszukiwarki(false) : undefined}
                />
              </div>
            ))}
          </div>
          <WyszukiwarkaPunktow
            orderId={orderId}
            onWybierz={(nazwa) => {
              if (punkt.current) punkt.current.value = nazwa
              setZWyszukiwarki(true)
            }}
          />
          {zWyszukiwarki && <input type="hidden" name="punkt_z_wyszukiwarki" value="tak" />}
          <p className="small muted">Zmiana zapisuje się w dzienniku podglądów danych klientów (Ustawienia → Zespół i dostęp → Dane klientów). Dane do faktury i e-mail zostają bez zmian.</p>
          <div className="actions">
            <button type="submit" className="btn" disabled={pending}>
              {pending ? 'Zapisuję…' : 'Zapisz poprawkę'}
            </button>
          </div>
          {wynik?.blad && (
            <div className="banner red" role="alert">
              {wynik.blad}
            </div>
          )}
          {wynik?.info && (
            <div className="banner blue" role="status">
              {wynik.info}
            </div>
          )}
        </form>
      )}
    </details>
  )
}
