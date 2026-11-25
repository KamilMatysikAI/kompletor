'use client'
// „Zmień sposób wysyłki” przed nadaniem (np. klient wybrał Paczkomat InPost, a chce kuriera DPD). Lista usług z reguł
// przewoźników firmy, dane odbiorcy jak w poprawce adresu (otwarcie formularza = wpis w dzienniku podglądów), punkt
// poprzedniego przewoźnika nie przechodzi na nowego. Bramki (tryb pracy, przesyłka, status, pobranie, Allegro) sprawdza
// serwer; formularz tylko podpowiada, czego nowa usługa potrzebuje.
import { useState, useTransition } from 'react'
import type { PoprawkaDostawy } from '@/lib/klienci/poprawka'
import type { OpcjaWysylki, RodzajDostawy } from '@/lib/wysylka/zmiana-sposobu'
import { daneDoPoprawkiAkcja, zmienSposobAkcja, type WynikPrzyciskuPrzesylki } from './akcje-przesylka'
import { POLA } from './popraw-adres'
import { WyszukiwarkaPunktow } from './wyszukiwarka-punktow'

const PODPOWIEDZ: Record<RodzajDostawy, string> = {
  PUNKT: 'Ta usługa dowozi do punktu odbioru: podaj punkt nowego przewoźnika.',
  ADRES: 'Kurier jedzie pod adres: podaj ulicę, kod pocztowy i miasto. Punkt odbioru zostanie usunięty.',
  ADRES_LUB_PUNKT: 'Podaj adres odbiorcy (ulica, kod i miasto są wymagane zawsze). Dostawa do punktu tego przewoźnika: dopisz jego kod; puste pole = kurier pod adres. Punkt poprzedniego przewoźnika tu nie pasuje.',
  ODBIOR: 'Klient odbierze paczkę osobiście: dane odbiorcy zostają bez zmian.',
  Z_KANALU: 'Usługę i odbiorcę bierze Allegro z zamówienia: dane odbiorcy w Kompletorze zostają bez zmian.',
}

export function ZmianaSposobu({ orderId, opcje, obecna, uwagi, pobranie }: { orderId: string; opcje: OpcjaWysylki[]; obecna: string | null; uwagi: string[]; pobranie: boolean }) {
  const [dane, setDane] = useState<PoprawkaDostawy | null | undefined>(undefined)
  const [klucz, setKlucz] = useState('')
  const [punkt, setPunkt] = useState('')
  const [zWyszukiwarki, setZWyszukiwarki] = useState(false)
  const [wynik, setWynik] = useState<WynikPrzyciskuPrzesylki | null>(null)
  const [pending, start] = useTransition()
  const wybrana = opcje.find((o) => o.klucz === klucz) ?? null
  const obecnyPrzewoznik = obecna?.split(':')[0] ?? null
  // dane odbiorcy wczytywane przy każdym otwarciu i po zapisie, nie raz na życie komponentu (poprawka adresu
  // albo wcześniejsza zmiana mogły je zmienić; stary punkt paczkomatu nie może wrócić do formularza)
  const otworz = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open) start(async () => setDane(await daneDoPoprawkiAkcja(orderId)))
  }
  const wybierz = (k: string) => {
    setKlucz(k)
    setWynik(null)
    setZWyszukiwarki(false)
    // punkt przechodzi tylko przy tym samym przewoźniku (inny moduł); paczkomat jako punkt DPD poszedłby w złe miejsce
    const op = opcje.find((o) => o.klucz === k)
    setPunkt(op && op.carrier === obecnyPrzewoznik ? (dane?.punkt ?? '') : '')
  }
  const zapisz = (form: FormData) =>
    start(async () => {
      const w = await zmienSposobAkcja(orderId, form)
      setWynik(w)
      // po zapisie karta odświeża listę (nowa usługa = „obecny”): wybór od zera, zostaje sam komunikat
      if (!w.blad) {
        setKlucz('')
        setPunkt('')
        setZWyszukiwarki(false)
        setDane(await daneDoPoprawkiAkcja(orderId))
      }
    })
  const bezPobrania = !!wybrana && pobranie && !wybrana.pobranie
  const pola = wybrana && (wybrana.rodzaj === 'PUNKT' || wybrana.rodzaj === 'ADRES' || wybrana.rodzaj === 'ADRES_LUB_PUNKT')
  return (
    <details onToggle={otworz}>
      <summary className="btn small">Zmień sposób wysyłki przed nadaniem (np. Paczkomat → kurier DPD)</summary>
      {dane === undefined ? (
        <p className="small muted">Wczytuję…</p>
      ) : (
        <form action={zapisz} className="stack">
          <div className="field">
            <label htmlFor={`zs-sposob-${orderId}`}>Nowy sposób wysyłki</label>
            <select id={`zs-sposob-${orderId}`} name="sposob" className="input" required value={klucz} onChange={(e) => wybierz(e.target.value)}>
              <option value="">
                Wybierz przewoźnika i usługę
              </option>
              {opcje.map((o) => (
                <option key={o.klucz} value={o.klucz} disabled={o.klucz === obecna}>
                  {`${o.etykieta}${o.klucz === obecna ? ' (obecny)' : ''}${pobranie && !o.pobranie ? ' (bez pobrania)' : ''}`}
                </option>
              ))}
            </select>
            {wybrana && <p className="small muted">{PODPOWIEDZ[wybrana.rodzaj]}</p>}
            {wybrana?.rodzaj === 'ODBIOR' && pobranie && <p className="small muted">Zamówienie jest za pobraniem: przy odbiorze osobistym kwotę pobierasz od klienta przy wydaniu paczki (płatność przy odbiorze).</p>}
          </div>
          {pola && (
            <>
              <div className="grid g2">
                {POLA.filter((p) => p.nazwa !== 'punkt' || wybrana.rodzaj !== 'ADRES').map((p) => (
                  <div key={p.nazwa} className="field">
                    <label htmlFor={`zs-${p.nazwa}-${orderId}`}>{p.nazwa === 'punkt' ? `Punkt odbioru ${wybrana.rodzaj === 'PUNKT' ? '(wymagany)' : '(puste = kurier pod adres)'}` : p.etykieta}</label>
                    {p.nazwa === 'punkt' ? (
                      <input
                        id={`zs-${p.nazwa}-${orderId}`}
                        name="punkt"
                        className="input"
                        value={punkt}
                        required={wybrana.rodzaj === 'PUNKT'}
                        autoComplete="off"
                        onChange={(e) => {
                          setPunkt(e.target.value)
                          setZWyszukiwarki(false)
                        }}
                      />
                    ) : (
                      <input id={`zs-${p.nazwa}-${orderId}`} name={p.nazwa} className="input" defaultValue={dane?.[p.klucz] ?? ''} autoComplete={p.autocomplete ?? 'off'} />
                    )}
                  </div>
                ))}
              </div>
              {wybrana.carrier === 'PACZKOMATY' && (
                <WyszukiwarkaPunktow
                  orderId={orderId}
                  zapis="zmień sposób wysyłki"
                  onWybierz={(nazwa) => {
                    setPunkt(nazwa)
                    setZWyszukiwarki(true)
                  }}
                />
              )}
              {zWyszukiwarki && <input type="hidden" name="punkt_z_wyszukiwarki" value="tak" />}
            </>
          )}
          {bezPobrania && (
            <div className="banner red" role="alert">
              „{wybrana.etykieta}” nie obsługuje pobrania, a zamówienie jest za pobraniem: wybierz usługę z pobraniem albo najpierw zmień płatność.
            </div>
          )}
          <ul className="small muted kz-bez-marginesu">
            {uwagi.map((u) => (
              <li key={u}>{u}</li>
            ))}
            <li>Zmiana zapisuje się w historii zamówienia (przewoźnik przed i po), a adres i punkt w dzienniku podglądów danych klientów.</li>
          </ul>
          <div className="actions">
            <button type="submit" className="btn" disabled={pending || !wybrana || bezPobrania}>
              {pending ? 'Zapisuję…' : 'Zmień sposób wysyłki'}
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
