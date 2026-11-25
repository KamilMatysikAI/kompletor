'use client'
// Przyciski przesyłki: „Utwórz przesyłkę” z gabarytem (odpowiednik zdarzeń BL „InPost Gabaryt A/B/C”,
// „Kurier DPD”), druk etykiety na stanowisku od razu po utworzeniu, „Sprawdź u przewoźnika” przy wyniku niejasnym,
// „Pobierz etykietę” i ponowny druk bez drugiej przesyłki. Ten sam komponent na karcie zamówienia i na stanowisku
// pakowania po „Spakowane”. Przy wyłączonym nadawaniu przyciski są widoczne, nieaktywne, z powodem pod spodem.
// na komponentach app/ui (Przycisk, Odznaka, ListaOpisowa, Baner, Zaawansowane, WyborJednej).
// ostrzeżenia do potwierdzenia to krok „Sprawdź przed nadaniem” z polami wyboru przed pierwszym kliknięciem.
import { useCallback, useEffect, useState, useTransition } from 'react'
import { Baner, ListaOpisowa, Odznaka, PoleTekstowe, Przycisk, PrzyciskPotwierdz, WyborJednej, Zaawansowane } from '@/app/ui'
import { anulujPrzesylkeAkcja, pobierzEtykieteAkcja, rozstrzygnijPrzesylkeAkcja, sprawdzPrzesylkeAkcja, stanNadania, utworzPrzesylkeAkcja, type StanNadania, type WynikPrzyciskuPrzesylki } from '../zamowienia/[id]/akcje-przesylka'
import type { PoprzedniaPrzesylka } from '@/lib/wysylka/poprzednia'
import { DrukujNaStanowisku, useStanowiskaDruku } from './druk'
import { NumerNadania } from './numer-nadania'
import { PodzialAdresuAi } from './podzial-adresu-ai'
import { naPoprawkeAdresu } from './poprawka-adresu-zdarzenie'
import { naPrzeliczeniePrzesylki } from './przeliczenie-przesylki-zdarzenie'

const KLUCZ_STANOWISKA = 'kompletor-druk-stanowisko'

/** zdarzenie okna po udanej poprawce adresu albo punktu (w `poprawka-adresu-zdarzenie.ts`). */
export { ogloszPoprawkeAdresu } from './poprawka-adresu-zdarzenie'

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

/** ostrzeżenia z podglądu i z odpowiedzi nadania bez powtórzeń (kod jest kluczem; nowszy tekst wygrywa). */
export function polaczPotwierdzenia(...listy: readonly { kod: string; tekst: string }[][]): { kod: string; tekst: string }[] {
  const m = new Map<string, { kod: string; tekst: string }>()
  for (const l of listy) for (const o of l) m.set(o.kod, { kod: o.kod, tekst: o.tekst })
  return [...m.values()]
}

/**
 * co idzie z kliknięciem „Potwierdzam i tworzę przesyłkę”. Tylko kody widoczne w kroku, każdy
 * z tekstem, który człowiek zaznaczył; nadanie przyjmuje kod tylko przy tym samym tekście w świeżym liczeniu (inna waga,
 * inna kwota pobrania = nowy tekst do zaznaczenia).
 */
export function potwierdzeniaDoWyslania(widoczne: readonly { kod: string; tekst: string }[], zaznaczone: readonly string[]): { kod: string; tekst: string }[] {
  return widoczne.filter((d) => zaznaczone.includes(d.kod)).map((d) => ({ kod: d.kod, tekst: d.tekst }))
}

/** Po odmowie nadania: kody, które nadanie zwróciło do potwierdzenia, tracą zaznaczenie (ich tekst mógł się zmienić). */
export function zaznaczeniaPoOdmowie(zaznaczone: readonly string[], zwrocone: readonly { kod: string }[] | undefined): string[] {
  return zaznaczone.filter((k) => !zwrocone?.some((d) => d.kod === k))
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

export function NadaniePrzesylki({
  orderId,
  poczatkowy,
  gabarytZPakowania,
  onStart,
  podzialAdresu = false,
}: {
  orderId: string
  poczatkowy?: StanNadania | null
  gabarytZPakowania?: string | null
  /** stanowisko zatrzymuje odliczanie powrotu do skanu, gdy zaczyna się akcja przesyłki. */
  onStart?: () => void
  /** stanowisko pakowania — przy nieudanej przesyłce „Podpowiedz podział adresu” (karta ma go w bloku „Przesyłka”). */
  podzialAdresu?: boolean
}) {
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
  // `poczatkowy` liczy się tylko przy montażu, więc po poprawce adresu blok trzymał stary powód blokady i stary
  // komunikat „Utwórz przesyłkę” aż do F5. Po sygnale z formularza poprawki: świeży stan z serwera, bez starego komunikatu.
  useEffect(
    () =>
      naPoprawkeAdresu(orderId, () => {
        setWynik(null)
        odswiez()
      }),
    [orderId, odswiez],
  )
  // po „Policz przesyłkę” albo odmowie automatu na stanowisku stare zaznaczenia i stare
  // teksty znikają; krok pokazuje świeże ostrzeżenia (z serwera albo z odmowy nadania)
  useEffect(
    () =>
      naPrzeliczeniePrzesylki(orderId, (p) => {
        setPotwierdzone([])
        setWynik(p.doPotwierdzenia?.length ? { blad: null, info: null, doPotwierdzenia: p.doPotwierdzenia } : null)
        odswiez()
      }),
    [orderId, odswiez],
  )

  if (!stan || stan.nieDotyczy) return null
  const p = stan.przesylka
  const aktywna = p && p.stan !== 'BLAD' && p.stan !== 'ANULOWANA'
  const gabaryty = gabarytZPakowania ? stan.gabaryty.filter((g) => g.kod === gabarytZPakowania) : stan.gabaryty
  const lista = gabaryty.length ? gabaryty : [{ kod: '', nazwa: stan.modul ?? 'przewoźnik' }]
  // ostrzeżenia do potwierdzenia jako zwykły krok przed nadaniem (z podglądu od razu, z odpowiedzi nadania,
  // gdy podgląd się zestarzał), a nie odmowa po pierwszym kliknięciu
  const doPotwierdzenia = aktywna || stan.powod ? [] : polaczPotwierdzenia(stan.doPotwierdzenia ?? [], wynik?.doPotwierdzenia ?? [])
  const brakZaznaczen = doPotwierdzenia.some((d) => !potwierdzone.includes(d.kod))
  const noweDoPotwierdzenia = !!wynik?.doPotwierdzenia?.length

  const utworz = (gabaryt: string) =>
    start(async () => {
      const wysylane = potwierdzeniaDoWyslania(doPotwierdzenia, potwierdzone)
      const w = await utworzPrzesylkeAkcja(orderId, gabaryt || null, wysylane.map((d) => d.kod), zapamietaneStanowisko(stanowiska), wysylane)
      setWynik(w)
      const s = await stanNadania(orderId)
      setStan(s)
      // po utworzeniu przesyłki zaznaczenia nie przechodzą na następną (np. po anulowaniu)
      if (s?.przesylka && s.przesylka.stan !== 'BLAD' && s.przesylka.stan !== 'ANULOWANA') setPotwierdzone([])
      else setPotwierdzone((x) => zaznaczeniaPoOdmowie(x, w.doPotwierdzenia))
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
      setPotwierdzone([])
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

      {!aktywna && doPotwierdzenia.length > 0 && (
        <fieldset className="np-sprawdz stack" aria-describedby={`np-sprawdz-${orderId}`}>
          <legend className="small">
            <b>Sprawdź przed nadaniem</b>
          </legend>
          <p id={`np-sprawdz-${orderId}`} className="small muted">
            {noweDoPotwierdzenia ? 'Przesyłka czeka na Twoje potwierdzenie (nic jeszcze nie zostało nadane). ' : ''}Zaznacz każde pole, potem utwórz przesyłkę.
          </p>
          {doPotwierdzenia.map((o) => (
            <label key={o.kod} className="checkrow must">
              <input
                type="checkbox"
                id={`np-potw-${orderId}-${o.kod}`}
                checked={potwierdzone.includes(o.kod)}
                onChange={(e) => setPotwierdzone((x) => (e.target.checked ? [...new Set([...x, o.kod])] : x.filter((k) => k !== o.kod)))}
              />
              <span>{o.tekst}</span>
            </label>
          ))}
        </fieldset>
      )}

      {!aktywna && (
        <>
          <div className="ui-akcje-lista">
            {lista.map((g) => (
              <Przycisk key={g.kod || 'jeden'} wariant="glowny" ladowanie={pending} powodWylaczenia={stan.powod ?? (brakZaznaczen ? 'Najpierw zaznacz pola w „Sprawdź przed nadaniem”.' : null)} onClick={() => utworz(g.kod)}>
                {doPotwierdzenia.length ? `Potwierdzam i tworzę przesyłkę: ${g.nazwa}` : `Utwórz przesyłkę: ${g.nazwa}`}
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
          {/* na stanowisku przy nieudanej przesyłce (np. brak numeru domu u kuriera), dla osób z pełnymi danymi klientów */}
          {podzialAdresu && p?.stan === 'BLAD' && stan.podzialAdresu && <PodzialAdresuAi orderId={orderId} powod={stan.podzialAdresu.powod} onStart={onStart} />}
        </>
      )}

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

      {/* odmowa „do potwierdzenia” nie jest błędem: pokazuje ją krok „Sprawdź przed nadaniem” */}
      {wynik?.blad && !wynik.doPotwierdzenia?.length && (
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
