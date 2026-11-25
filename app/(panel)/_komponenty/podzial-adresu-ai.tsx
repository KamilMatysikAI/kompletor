'use client'
// „Podpowiedz podział adresu” (asystent AI firmy) przy dostawie kurierem, gdy linia adresu ma ulicę z numerem
// w jednym polu i nie da się jej rozdzielić jednoznacznie. Ten sam komponent na karcie zamówienia (blok „Przesyłka”) i na
// stanowisku pakowania (przy nieudanej przesyłce). Do asystenta idzie sama linia ulicy z numerem; wynik pokazujemy obok
// oryginalnej linii, a zapis robi człowiek przyciskiem „Zatwierdź” (zwykła poprawka adresu z wpisem w historii).
// Bez asystenta AI firmy, po limicie albo w trybie „Tylko podgląd” przycisk zostaje, nieaktywny, z powodem pod spodem.
// Niska pewność albo odrzucenie przez bezpiecznik = komunikat, bez „Zatwierdź”; ręczna poprawka zostaje jak dotąd.
import { useState, useTransition } from 'react'
import { Baner, ListaOpisowa, Odznaka, Przycisk } from '@/app/ui'
import { podpowiedzPodzialAkcja, zatwierdzPodzialAkcja, type WynikPodzialuAdresu } from '../zamowienia/[id]/akcje-przesylka'
import { ogloszPoprawkeAdresu } from './poprawka-adresu-zdarzenie'

const TON_KOMUNIKATU: Record<Exclude<WynikPodzialuAdresu['stan'], 'PROPOZYCJA'>, 'info' | 'sukces' | 'ostrzezenie' | 'blad'> = {
  ZAPISANO: 'sukces',
  ODRZUCONA: 'ostrzezenie',
  NIEDOSTEPNE: 'ostrzezenie',
  NIE_DOTYCZY: 'info',
  BLAD: 'blad',
}

export function PodzialAdresuAi({
  orderId,
  powod,
  onStart,
  potrzebny = true,
}: {
  orderId: string
  /** Powód nieaktywnego przycisku (brak asystenta, limit, tryb konta); null = aktywny. */
  powod: string | null
  onStart?: () => void
  /** Karta: false po zapisie (odświeżona strona) — wtedy zostaje samo potwierdzenie zapisu albo nic. */
  potrzebny?: boolean
}) {
  const [wynik, setWynik] = useState<WynikPodzialuAdresu | null>(null)
  const [pending, startTransition] = useTransition()
  const start = (f: () => Promise<void>) => {
    onStart?.()
    startTransition(f)
  }
  const podpowiedz = () =>
    start(async () => {
      setWynik(await podpowiedzPodzialAkcja(orderId))
    })
  const zatwierdz = () =>
    start(async () => {
      const w = await zatwierdzPodzialAkcja(orderId)
      setWynik(w)
      if (w.stan === 'ZAPISANO') ogloszPoprawkeAdresu(orderId)
    })
  const idPowodu = `pa-ai-powod-${orderId}`
  if (!potrzebny && wynik?.stan !== 'ZAPISANO') return null
  const p = wynik?.stan === 'PROPOZYCJA' ? wynik : null
  return (
    <div className="stack">
      {!p && potrzebny && wynik?.stan !== 'ZAPISANO' && (
        <div className="ui-akcja">
          <div className="ui-akcje-lista">
            <Przycisk rozmiar="sm" ladowanie={pending} powodWylaczenia={powod} aria-describedby={powod ? idPowodu : undefined} onClick={podpowiedz}>
              Podpowiedz podział adresu (asystent AI)
            </Przycisk>
          </div>
          {powod ? (
            <p id={idPowodu} className="ui-akcja-powod">
              {powod}
            </p>
          ) : (
            <p className="ui-akcja-powod">Numer domu jest w jednej linii z ulicą. Asystent dostaje tylko tę linię; zapisujesz Ty, po sprawdzeniu.</p>
          )}
        </div>
      )}
      {p && (
        <>
          <ListaOpisowa
            pozycje={[
              { klucz: 'linia', etykieta: 'Linia z zamówienia', wartosc: <span className="mono">{p.linia}</span> },
              { klucz: 'ulica', etykieta: 'Ulica', wartosc: p.propozycja.ulica },
              { klucz: 'dom', etykieta: 'Numer domu', wartosc: <span className="mono">{p.propozycja.numerDomu}</span> },
              { klucz: 'lokal', etykieta: 'Numer lokalu', wartosc: <span className="mono">{p.propozycja.numerLokalu ?? '—'}</span> },
              {
                klucz: 'pewnosc',
                etykieta: 'Pewność asystenta',
                wartosc: (
                  <Odznaka ton={p.propozycja.pewnosc === 'wysoka' ? 'sukces' : 'ostrzezenie'} rozmiar="sm">
                    {p.propozycja.pewnosc}
                  </Odznaka>
                ),
              },
            ]}
          />
          {p.propozycja.pewnosc === 'wysoka' ? (
            <div className="ui-akcje-lista">
              <Przycisk wariant="glowny" rozmiar="sm" ladowanie={pending} onClick={zatwierdz}>
                Zatwierdź podział
              </Przycisk>
              <Przycisk rozmiar="sm" disabled={pending} onClick={() => setWynik(null)}>
                Nie, poprawię ręcznie
              </Przycisk>
            </div>
          ) : (
            <Baner ton="ostrzezenie" rola="status">
              Asystent nie jest pewny tego podziału, więc nie da się go zatwierdzić jednym kliknięciem. Popraw adres ręcznie w „Popraw adres albo punkt odbioru”.
            </Baner>
          )}
        </>
      )}
      {wynik && wynik.stan !== 'PROPOZYCJA' && (
        <Baner ton={TON_KOMUNIKATU[wynik.stan]} rola={wynik.stan === 'BLAD' ? 'alert' : 'status'}>
          {wynik.komunikat}
        </Baner>
      )}
    </div>
  )
}
