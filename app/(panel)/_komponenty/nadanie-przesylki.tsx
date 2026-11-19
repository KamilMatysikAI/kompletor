'use client'
// Przyciski przesyłki: „Utwórz przesyłkę” z gabarytem (odpowiednik zdarzeń BL „InPost Gabaryt A/B/C”,
// „Kurier DPD”), druk etykiety na stanowisku od razu po utworzeniu, „Sprawdź u przewoźnika” przy wyniku niejasnym,
// „Pobierz etykietę” i ponowny druk bez drugiej przesyłki. Ten sam komponent na karcie zamówienia i na stanowisku
// pakowania po „Spakowane”. Przy wyłączonym nadawaniu przyciski są widoczne, nieaktywne, z powodem pod spodem.
// na komponentach app/ui (Przycisk, Odznaka, ListaOpisowa, Baner, Zaawansowane, WyborJednej, Przelacznik).
import { useCallback, useEffect, useState, useTransition } from 'react'
import { Baner, ListaOpisowa, Odznaka, PoleTekstowe, Przelacznik, Przycisk, PrzyciskPotwierdz, WyborJednej, Zaawansowane } from '@/app/ui'
import { anulujPrzesylkeAkcja, pobierzEtykieteAkcja, rozstrzygnijPrzesylkeAkcja, sprawdzPrzesylkeAkcja, stanNadania, utworzPrzesylkeAkcja, type StanNadania, type WynikPrzyciskuPrzesylki } from '../zamowienia/[id]/akcje-przesylka'
import type { PoprzedniaPrzesylka } from '@/lib/wysylka/poprzednia'
import { DrukujNaStanowisku, useStanowiskaDruku } from './druk'
import { NumerNadania } from './numer-nadania'

const KLUCZ_STANOWISKA = 'kompletor-druk-stanowisko'

const STAN: Record<string, { tekst: string; ton: 'info' | 'sukces' | 'ostrzezenie' | 'blad' | 'neutralny' }> = {
  TWORZENIE: { tekst: 'Tworzy się u przewoźnika', ton: 'info' },
  UTWORZONA: { tekst: 'Utworzona', ton: 'sukces' },
  NIEJEDNOZNACZNA: { tekst: 'Do sprawdzenia u przewoźnika', ton: 'ostrzezenie' },
  BLAD: { tekst: 'Nie utworzono', ton: 'blad' },
  ANULOWANA: { tekst: 'Anulowana', ton: 'neutralny' },
}

/** linia o poprzedniej przesyłce paczki (anulowanej albo oznaczonej jako niepowstała). */
function tekstPoprzedniej(p: PoprzedniaPrzesylka): string {
  const kiedy = new Date(p.kiedy).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  const kto = p.kto ? ` (${p.kto}, ${kiedy})` : ` (${kiedy})`
  return p.recznie
    ? `Poprzednią przesyłkę tej paczki oznaczono ręcznie jako niepowstałą${kto}. Jeśli nie masz pewności, sprawdź w panelu przewoźnika, zanim utworzysz nową.`
    : `Poprzednią przesyłkę tej paczki anulowano u przewoźnika${kto}.`
}

export function zapamietaneStanowisko(lista: { id: string }[] | null): string | null {
  if (!lista?.length) return null
  let z: string | null = null
  try {
    z = window.localStorage.getItem(KLUCZ_STANOWISKA)
  } catch {
    // bez localStorage — pierwsze stanowisko
  }
  return lista.some((s) => s.id === z) ? z : lista[0]!.id
}

export function NadaniePrzesylki({ orderId, poczatkowy, gabarytZPakowania, onStart }: { orderId: string; poczatkowy?: StanNadania | null; gabarytZPakowania?: string | null; /** stanowisko zatrzymuje odliczanie powrotu do skanu, gdy zaczyna się akcja przesyłki. */ onStart?: () => void }) {
  const [stan, setStan] = useState<StanNadania | null | undefined>(poczatkowy)
  const [wynik, setWynik] = useState<WynikPrzyciskuPrzesylki | null>(null)
  const [potwierdzone, setPotwierdzone] = useState<string[]>([])
  const [pending, startTransition] = useTransition()
  const start = useCallback((f: () => Promise<void>) => {
    onStart?.()
    startTransition(f)
  }, [onStart])
  const stanowiska = useStanowiskaDruku()

  const odswiez = useCallback(() => startTransition(async () => setStan(await stanNadania(orderId))), [orderId])
  useEffect(() => {
    if (poczatkowy === undefined) odswiez()
  }, [poczatkowy, odswiez])

  if (!stan || stan.nieDotyczy) return null
  const p = stan.przesylka
  const aktywna = p && p.stan !== 'BLAD' && p.stan !== 'ANULOWANA'
  const gabaryty = gabarytZPakowania ? stan.gabaryty.filter((g) => g.kod === gabarytZPakowania) : stan.gabaryty
  const lista = gabaryty.length ? gabaryty : [{ kod: '', nazwa: stan.modul ?? 'przewoźnik' }]

  const utworz = (gabaryt: string) =>
    start(async () => {
      const w = await utworzPrzesylkeAkcja(orderId, gabaryt || null, potwierdzone, zapamietaneStanowisko(stanowiska))
      setWynik(w)
      setStan(await stanNadania(orderId))
    })
  const sprawdz = () =>
    start(async () => {
      setWynik(await sprawdzPrzesylkeAkcja(orderId, p!.id))
      setStan(await stanNadania(orderId))
    })
  const rozstrzygnij = (form: FormData) =>
    start(async () => {
      setWynik(await rozstrzygnijPrzesylkeAkcja(orderId, p!.id, String(form.get('wariant') ?? ''), String(form.get('numer') ?? '')))
      setStan(await stanNadania(orderId))
    })
  const anuluj = () =>
    start(async () => {
      setWynik(await anulujPrzesylkeAkcja(orderId, p!.id))
      setStan(await stanNadania(orderId))
    })
  const pobierz = () =>
    start(async () => {
      setWynik(await pobierzEtykieteAkcja(orderId, p!.id))
      setStan(await stanNadania(orderId))
    })

  return (
    <div className="stack">
      {p && (
        <ListaOpisowa
          pozycje={[
            {
              klucz: 'stan',
              etykieta: 'Przesyłka',
              wartosc: (
                <>
                  <Odznaka ton={STAN[p.stan]?.ton ?? 'neutralny'} rozmiar="sm">
                    {STAN[p.stan]?.tekst ?? p.stan}
                  </Odznaka>
                  {p.gabaryt ? <span className="small muted"> · {p.gabaryt}</span> : null}
                </>
              ),
            },
            { klucz: 'numer', etykieta: 'Numer nadania', wartosc: p.numer ? <NumerNadania numer={p.numer} href={p.link} className="mono" /> : <span className="mono">—</span> },
            ...(p.uKuriera?.nazwa
              ? [{ klucz: 'kurier', etykieta: 'U przewoźnika', wartosc: <span>{p.uKuriera.nazwa} <span className="small muted">· {new Date(p.uKuriera.kiedy).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' })}</span></span> }]
              : []),
            { klucz: 'etykieta', etykieta: 'Etykieta', wartosc: p.etykieta ? 'pobrana od przewoźnika' : p.stan === 'UTWORZONA' ? (p.etykietaBlad ?? 'jeszcze niepobrana') : '—' },
            ...(p.blad && p.stan !== 'UTWORZONA' ? [{ klucz: 'powod', etykieta: 'Powód', wartosc: <span className="small">{p.blad}</span> }] : []),
            ...(p.uwaga && p.stan === 'UTWORZONA' ? [{ klucz: 'uwaga', etykieta: 'Uwaga przewoźnika', wartosc: <span className="small">{p.uwaga}</span> }] : []),
          ]}
        />
      )}

      {!aktywna && (
        <>
          <div className="ui-akcje-lista">
            {lista.map((g) => (
              <Przycisk key={g.kod || 'jeden'} wariant="glowny" ladowanie={pending} powodWylaczenia={stan.powod} onClick={() => utworz(g.kod)}>
                {`Utwórz przesyłkę: ${g.nazwa}`}
              </Przycisk>
            ))}
          </div>
          {stan.powod && <p className="ui-akcja-powod">{stan.powod}</p>}
          {!p && stan.poprzednia && (
            <p className="small" role="note">
              {tekstPoprzedniej(stan.poprzednia)}
            </p>
          )}
          {p?.stan === 'BLAD' && <p className="small muted">Poprzednia próba nie utworzyła przesyłki, więc ponowienie jej nie zdubluje.</p>}
        </>
      )}

      {wynik?.doPotwierdzenia?.length ? (
        <div className="stack">
          {wynik.doPotwierdzenia.map((o) => (
            <Przelacznik
              key={o.kod}
              id={`np-potw-${orderId}-${o.kod}`}
              etykieta={o.tekst}
              checked={potwierdzone.includes(o.kod)}
              onChange={(e) => setPotwierdzone((x) => (e.target.checked ? [...x, o.kod] : x.filter((k) => k !== o.kod)))}
            />
          ))}
        </div>
      ) : null}

      {p?.doSprawdzenia && (
        <div>
          <Przycisk ladowanie={pending} onClick={sprawdz}>
            Sprawdź u przewoźnika
          </Przycisk>
        </div>
      )}
      {p?.doSprawdzenia && stan.mozeRozstrzygnac && (
        <Zaawansowane tytul="Rozstrzygnij ręcznie (po sprawdzeniu w panelu przewoźnika)">
          <form action={rozstrzygnij} className="stack">
            <WyborJednej
              legenda="Co jest w panelu przewoźnika?"
              name="wariant"
              domyslna="ISTNIEJE"
              opcje={[
                { wartosc: 'ISTNIEJE', etykieta: 'Przesyłka istnieje u przewoźnika' },
                { wartosc: 'NIE_POWSTALA', etykieta: 'Przesyłka nie powstała (w panelu przewoźnika jej nie ma)' },
              ]}
            />
            <PoleTekstowe id={`rr-${p.id}`} etykieta={p.rozstrzygniecie.etykietaNumeru} pomoc={p.rozstrzygniecie.wskazowka} name="numer" className="mono" autoComplete="off" />
            <p className="small muted">Wybór trafia do dziennika zmian z Twoim nazwiskiem. „Nie powstała” pozwala utworzyć przesyłkę od nowa: zaznacz to tylko po sprawdzeniu w panelu przewoźnika, inaczej możesz zapłacić za dwie paczki.</p>
            <div>
              <Przycisk type="submit" ladowanie={pending}>
                Zapisz rozstrzygnięcie
              </Przycisk>
            </div>
          </form>
        </Zaawansowane>
      )}
      {p?.stan === 'UTWORZONA' && (
        <div className="ui-akcje-lista">
          {(!p.etykieta || !p.numer) && (
            <Przycisk ladowanie={pending} onClick={pobierz}>
              {p.etykieta ? 'Pobierz numer nadania' : 'Pobierz etykietę'}
            </Przycisk>
          )}
          {p.etykieta && stanowiska?.length ? <DrukujNaStanowisku typ="etykieta" ids={[orderId]} etykieta="Drukuj etykietę ponownie" stanowiska={stanowiska} /> : null}
          {p.moznaAnulowac && (
            <form action={anuluj}>
              <PrzyciskPotwierdz
                wariant="niebezpieczny"
                disabled={pending}
                tytul="Anulować przesyłkę u przewoźnika?"
                pytanie="Etykieta przestanie być ważna, a paczki nie da się już nadać z tym numerem. Potem możesz utworzyć nową przesyłkę."
                tak="Tak, anuluj przesyłkę"
                nie="Nie, zostaw"
              >
                Anuluj przesyłkę
              </PrzyciskPotwierdz>
            </form>
          )}
        </div>
      )}

      {wynik?.blad && (
        <Baner ton="blad" rola="alert">
          {wynik.blad}
        </Baner>
      )}
      {wynik?.info && (
        <Baner ton="info" rola="status">
          {wynik.info}
          {wynik.druk ? ` Etykieta wysłana do druku: ${wynik.druk.stanowisko}.` : ''}
        </Baner>
      )}
    </div>
  )
}
