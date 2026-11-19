'use client'
// Ustawienia → Druk: formularze stanowisk. Walidacja wyłącznie po stronie serwera (lib/druk/stanowiska.ts).
// Token i kod instalacyjny widać tylko raz, w stanie formularza po utworzeniu (wzór: klucze API).
// wyniki jako toasty (useToast), kod stanowiska tworzy się z nazwy (własny kod w „Zaawansowane”), bez stylów
// inline (klasy druk-* w app/panel.css).
import { useActionState, useEffect, useRef, useState } from 'react'
import { dodaj, testuj, uniewaznij, utworzToken, wylacz, zapiszRouting, zmienNazwe } from './akcje'
import { STAN_AKCJI, STAN_TOKENU, type StanAkcji } from './stan-formularzy'
import { PoleTekstowe, Przycisk, PrzyciskPotwierdz, useToast, Zaawansowane } from '@/app/ui'
import { kodZNazwy } from '@/lib/druk/role'

/** Wynik akcji jako toast: każdy nowy stan (nowy obiekt z useActionState) pokazuje swój komunikat raz. */
function Komunikat({ s }: { s: { error: string | null; ok?: string | null } }) {
  const toast = useToast()
  const poprzedni = useRef(s)
  useEffect(() => {
    if (s === poprzedni.current) return
    poprzedni.current = s
    if (s.error) toast.blad(s.error)
    else if (s.ok) toast.sukces(s.ok)
  }, [s, toast])
  return null
}

export function NoweStanowisko() {
  const [s, action, pending] = useActionState(dodaj, STAN_AKCJI)
  const [nazwa, setNazwa] = useState('')
  const [kod, setKod] = useState('')
  // po dodaniu pola od nowa
  useEffect(() => {
    if (s.ok) {
      setNazwa('')
      setKod('')
    }
  }, [s])
  const zNazwy = kodZNazwy(nazwa)
  return (
    <form action={action} aria-label="Nowe stanowisko druku">
      {/* druk-nowe-linia: pole i przycisk w jednym wierszu, opis pod spodem na całą szerokość; pole o stałej szerokości */}
      <div className="druk-nowe-linia">
        <PoleTekstowe
          id="d-nazwa"
          name="nazwa"
          etykieta="Nazwa stanowiska"
          maxLength={80}
          required
          placeholder="Pakowanie przy oknie"
          autoComplete="off"
          value={nazwa}
          onChange={(e) => setNazwa(e.target.value)}
          pomoc={
            nazwa.trim() ? (
              <>
                Kod stanowiska: <span className="mono">{kod.trim() || zNazwy}</span> (instalator pyta o niego przy instalacji)
              </>
            ) : (
              'Np. „Pakowanie przy oknie”. Kod stanowiska utworzy się z nazwy.'
            )
          }
        />
        <Przycisk type="submit" wariant="glowny" ladowanie={pending}>
          Dodaj stanowisko
        </Przycisk>
      </div>
      <Zaawansowane tytul="Własny kod stanowiska">
        <PoleTekstowe
          id="d-kod"
          name="kod"
          etykieta="Kod stanowiska"
          className="druk-kod-pole"
          maxLength={50}
          pattern="[A-Za-z0-9_\-]{1,50}"
          placeholder={nazwa.trim() ? zNazwy : 'magazyn-1'}
          autoComplete="off"
          title="Litery bez polskich znaków, cyfry, - i _"
          value={kod}
          onChange={(e) => setKod(e.target.value)}
          opcjonalne
          pomoc="Puste = z nazwy. Gdy taki kod już jest, dostanie końcówkę -2, -3…"
        />
      </Zaawansowane>
      <Komunikat s={s} />
    </form>
  )
}

export function NazwaStanowiska({ id, nazwa }: { id: string; nazwa: string }) {
  const [s, action, pending] = useActionState(zmienNazwe, STAN_AKCJI)
  return (
    <form action={action} aria-label="Nazwa stanowiska" className="druk-wiersz">
      <input type="hidden" name="id" value={id} />
      <div className="field">
        <label htmlFor={`n-${id}`}>Nazwa</label>
        <input className="input" id={`n-${id}`} name="nazwa" maxLength={80} required defaultValue={nazwa} />
      </div>
      <button className="btn" type="submit" disabled={pending}>
        Zmień nazwę
      </button>
      <Komunikat s={s} />
    </form>
  )
}

export function WlaczWylacz({ id, nazwa, wylaczone, korzystaja = [] }: { id: string; nazwa: string; wylaczone: boolean; /** „Pakowanie 2: etykiety” — kto drukuje na drukarkach tego komputera. */ korzystaja?: string[] }) {
  const [s, action, pending] = useActionState(wylacz, STAN_AKCJI)
  return (
    <form action={action} className="druk-wiersz-srodek">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="wylacz" value={wylaczone ? 'nie' : 'tak'} />
      <PrzyciskPotwierdz
        wariant={wylaczone ? "drugorzedny" : "niebezpieczny"}
        disabled={pending}
        pomin={wylaczone}
        tytul={`Wyłączyć stanowisko „${nazwa}”?`}
        pytanie={
          korzystaja.length
            ? `Program druku na tym komputerze od razu dostanie odmowę, a stanowisko zniknie z wyboru przy „Drukuj”. Na drukarkach tego komputera drukują też inne stanowiska i ich wydruki przestaną wychodzić: ${korzystaja.join('; ')}.`
            : 'Program druku na tym komputerze od razu dostanie odmowę, a stanowisko zniknie z wyboru przy „Drukuj”.'
        }
        tak="Wyłącz stanowisko"
      >
        {wylaczone ? "Włącz stanowisko" : "Wyłącz stanowisko"}
      </PrzyciskPotwierdz>
      <Komunikat s={s} />
    </form>
  )
}

export function TokenStanowiska({ id, nazwa, maToken, utworzono, pobranieUrl }: { id: string; nazwa: string; maToken: boolean; utworzono: string | null; pobranieUrl: string | null }) {
  const [s, action, pending] = useActionState(utworzToken, STAN_TOKENU)
  const [u, uAction, uPending] = useActionState(uniewaznij, STAN_AKCJI)
  const [skopiowano, setSkopiowano] = useState('')
  const kopiuj = async (co: string, tekst: string) => {
    try {
      await navigator.clipboard.writeText(tekst)
      setSkopiowano(co)
    } catch {
      setSkopiowano('')
    }
  }
  const nowy = s.utworzony?.stationId === id ? s.utworzony : null
  return (
    <div>
      {nowy && (
        <div className="banner leaf-soft" role="status" key={nowy.token.slice(-8)}>
          <div>
            <b>Kod instalacyjny dla „{nowy.stanowisko}”.</b> Skopiuj go teraz i wklej w instalatorze na komputerze w magazynie
            (<span className="mono">Zainstaluj.cmd</span>). Kod widać <b>tylko raz</b>: po odświeżeniu strony zostanie samo „token utworzony”. Kod
            zawiera token: nie wysyłaj go mailem ani czatem, przepisz albo przenieś na pendrivie.
            {nowy.ostrzezenie && (
              <div className="banner amber druk-kod-blok" role="alert">
                {nowy.ostrzezenie}
              </div>
            )}
            <div className="druk-kod-blok">
              <code className="mono druk-kod" aria-label="Kod instalacyjny">
                {nowy.kod}
              </code>
            </div>
            <div className="druk-kod-blok druk-wiersz-srodek">
              <button className="btn primary" type="button" onClick={() => kopiuj('kod', nowy.kod)}>
                {skopiowano === 'kod' ? 'Skopiowano kod' : 'Kopiuj kod instalacyjny'}
              </button>
              <button className="btn" type="button" onClick={() => kopiuj('token', nowy.token)}>
                {skopiowano === 'token' ? 'Skopiowano token' : 'Kopiuj sam token (ręczna konfiguracja)'}
              </button>
            </div>
            {pobranieUrl && (
              <div className="small druk-kod-blok">
                Paczka programu: <a href={pobranieUrl} download>pobierz Kompletor-Druk (ZIP)</a>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="druk-wiersz-srodek">
        <span className="small">{maToken ? <>token utworzony {utworzono}</> : <span className="muted">brak aktywnego tokenu</span>}</span>
        <form action={action} onSubmit={() => setSkopiowano('')}>
          <input type="hidden" name="id" value={id} />
          <PrzyciskPotwierdz
            disabled={pending}
            pomin={!maToken}
            tytul={`Utworzyć nowy token dla „${nazwa}”?`}
            pytanie="Poprzedni przestanie działać od razu: program druku na komputerze dostanie odmowę, dopóki nie wkleisz nowego kodu w instalatorze."
            tak="Utwórz nowy token"
          >
            {pending ? "Tworzenie…" : maToken ? "Nowy token (unieważnia obecny)" : "Utwórz token i kod instalacyjny"}
          </PrzyciskPotwierdz>
        </form>
        {maToken && (
          <form action={uAction}>
            <input type="hidden" name="id" value={id} />
            <PrzyciskPotwierdz wariant="niebezpieczny" disabled={uPending} tytul={`Unieważnić token „${nazwa}”?`} pytanie="Program druku na komputerze od razu dostanie odmowę.">
              Unieważnij token
            </PrzyciskPotwierdz>
          </form>
        )}
        <Komunikat s={s} />
        <Komunikat s={u} />
      </div>
    </div>
  )
}

const TYPY: [string, string][] = [
  ['karta', 'Karty zamówień'],
  ['lista', 'Lista wysyłkowa'],
  ['spis', 'Spis produktów'],
  ['etykieta', 'Etykiety'],
]

/** drukarka do wyboru w „Co na jakiej drukarce”: wartość `rola` (ten komputer) albo `<id>:<rola>`. */
export interface OpcjaDrukarki {
  wartosc: string
  etykieta: string
}

/**
 * „Co na jakiej drukarce”: każdy rodzaj wydruku wybiera drukarkę z listy drukarek wszystkich włączonych stanowisk
 * firmy. Obecne przypisanie spoza listy (komputer wyłączony albo drukarka zniknęła z raportu) zostaje
 * na liście z dopiskiem, żeby zapis innego pola go nie zmienił po cichu.
 */
export function Routing({ id, wartosci, opcje, obecne }: { id: string; wartosci: Record<string, string>; opcje: OpcjaDrukarki[]; obecne: Record<string, string> }) {
  const [s, action, pending] = useActionState(zapiszRouting, STAN_AKCJI)
  return (
    <form action={action} aria-label="Przypisanie drukarek" className="druk-nowe">
      <input type="hidden" name="id" value={id} />
      {TYPY.map(([t, opis]) => {
        const w = wartosci[t]!
        const lista = opcje.some((o) => o.wartosc === w) ? opcje : [{ wartosc: w, etykieta: `${obecne[t] ?? w} (niedostępna)` }, ...opcje]
        return (
          <div className="field" key={t}>
            <label htmlFor={`r-${id}-${t}`}>{opis}</label>
            <select className="input druk-select" id={`r-${id}-${t}`} name={`r-${t}`} defaultValue={w}>
              {lista.map((o) => (
                <option key={o.wartosc} value={o.wartosc}>
                  {o.etykieta}
                </option>
              ))}
            </select>
          </div>
        )
      })}
      <button className="btn" type="submit" disabled={pending}>
        Zapisz przypisanie
      </button>
      <Komunikat s={s} />
    </form>
  )
}

export function WydrukTestowy({ id, rola }: { id: string; rola: string }) {
  const [s, action, pending] = useActionState(testuj, STAN_AKCJI)
  return (
    <form action={action} className="druk-wiersz-srodek">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="rola" value={rola} />
      <button className="btn small" type="submit" disabled={pending}>
        {pending ? 'Wysyłanie…' : 'Wydruk testowy'}
      </button>
      <Komunikat s={s} />
    </form>
  )
}
