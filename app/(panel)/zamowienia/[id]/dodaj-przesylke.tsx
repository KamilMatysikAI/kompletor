'use client'
// „Dodaj przesyłkę” w bloku „Przesyłki” karty zamówienia: dodatkowa przesyłka do tego samego zamówienia (dosyłka,
// paczka zastępcza, druga paczka). Okno z rodzajem, modułem przewoźnika, gabarytem, obowiązkowym powodem, kosztem
// (opcjonalnie) i potwierdzeniem, że nowa etykieta ma powstać. Numer z okna idzie do hosta: ponowne kliknięcie
// tego samego okna zwraca tę samą przesyłkę, bez drugiej etykiety. Po każdej odmowie okno czyta stan od nowa (numer,
// niejasna przesyłka), a niejasną dodatkową przesyłkę wyjaśnia się tutaj: „Sprawdź u przewoźnika” albo
// „Rozstrzygnij ręcznie” (karta pokazuje tylko przesyłkę główną).
import { useState, useTransition } from 'react'
import { unstable_rethrow } from 'next/navigation'
import { Baner, Modal, PoleTekstowe, PoleWielowierszowe, Przelacznik, Przycisk, Wybor, WyborJednej, Zaawansowane } from '@/app/ui'
import { dodajPrzesylkeAkcja, rozstrzygnijPrzesylkeAkcja, sprawdzPrzesylkeAkcja, stanDodatkowejAkcja, type StanDodatkowej } from './akcje-przesylka'

type Wynik = { blad: string | null; info: string | null }

const BLAD_POLACZENIA = 'Nie udało się połączyć z Kompletorem. Odśwież stronę i spróbuj jeszcze raz.'
const BLAD_POLACZENIA_TWORZENIE =
  'Nie udało się połączyć z Kompletorem i nie wiadomo, czy przesyłka powstała. Odśwież stronę i otwórz „Dodaj przesyłkę” ponownie: okno pokaże, co się stało, i nie utworzy drugiej przesyłki.'
const BRAK_STANU = 'Nie można teraz dodać przesyłki do tego zamówienia: zamówienia nie ma albo nie masz uprawnienia do nadawania przesyłek. Odśwież stronę.'

const domyslnyModul = (s: StanDodatkowej | null) => s?.moduly.find((m) => m.zamowienia)?.regulaId ?? s?.moduly[0]?.regulaId ?? ''

export function DodajPrzesylke({ orderId }: { orderId: string }) {
  const [otwarte, setOtwarte] = useState(false)
  const [stan, setStan] = useState<StanDodatkowej | null>(null)
  const [pola, setPola] = useState({ rodzaj: '', regulaId: '', gabaryt: '', powod: '', koszt: '', potwierdzam: false })
  const [doPotwierdzenia, setDoPotwierdzenia] = useState<{ kod: string; tekst: string }[]>([])
  const [potwierdzone, setPotwierdzone] = useState<string[]>([])
  const [wynik, setWynik] = useState<Wynik | null>(null)
  const [czeka, start] = useTransition()

  // nowy stan okna; wybrany moduł zostaje, gdy dalej jest na liście
  const przyjmij = (s: StanDodatkowej | null) => {
    setStan(s)
    setPola((p) => ({ ...p, regulaId: s?.moduly.some((m) => m.regulaId === p.regulaId) ? p.regulaId : domyslnyModul(s) }))
  }

  // akcja serwera, która rzuci (sieć, wdrożenie w trakcie), kończy się banerem, a nie cichym brakiem reakcji
  const wykonaj = (fn: () => Promise<void>, bladPolaczenia = BLAD_POLACZENIA) =>
    start(async () => {
      try {
        await fn()
      } catch (e) {
        unstable_rethrow(e)
        setWynik({ blad: bladPolaczenia, info: null })
      }
    })

  const otworz = () =>
    wykonaj(async () => {
      setWynik(null)
      setDoPotwierdzenia([])
      setPotwierdzone([])
      const s = await stanDodatkowejAkcja(orderId)
      setStan(s)
      setPola({ rodzaj: '', regulaId: domyslnyModul(s), gabaryt: '', powod: '', koszt: '', potwierdzam: false })
      setOtwarte(true)
    })

  const utworz = () =>
    wykonaj(async () => {
      if (!stan) return
      const w = await dodajPrzesylkeAkcja(orderId, { numer: stan.nastepnyNumer, ...pola, potwierdzone })
      setWynik(w)
      if (w.doPotwierdzenia) setDoPotwierdzenia(w.doPotwierdzenia)
      if (!w.blad) {
        setOtwarte(false)
        return
      }
      // po odmowie albo błędzie stan mógł się zmienić (numer, przesyłka niejasna u przewoźnika): czytamy go od nowa
      przyjmij(await stanDodatkowejAkcja(orderId))
    }, BLAD_POLACZENIA_TWORZENIE)

  // dodatkowa przesyłka niejasna u przewoźnika: ten sam odczyt co „Sprawdź u przewoźnika” przy głównej
  const sprawdz = () =>
    wykonaj(async () => {
      if (!stan?.doSprawdzenia) return
      setWynik(await sprawdzPrzesylkeAkcja(orderId, stan.doSprawdzenia.shipmentId))
      przyjmij(await stanDodatkowejAkcja(orderId))
    })

  // „Rozstrzygnij ręcznie” po sprawdzeniu w panelu przewoźnika (ta sama akcja co przy przesyłce głównej)
  const rozstrzygnij = (form: FormData) =>
    wykonaj(async () => {
      if (!stan?.doSprawdzenia) return
      setWynik(await rozstrzygnijPrzesylkeAkcja(orderId, stan.doSprawdzenia.shipmentId, String(form.get('wariant') ?? ''), String(form.get('numer') ?? '')))
      przyjmij(await stanDodatkowejAkcja(orderId))
    })

  const ustaw = (k: keyof typeof pola) => (e: { target: { value: string } }) => setPola((p) => ({ ...p, [k]: e.target.value }))
  const formularz = !!stan && !stan.powod
  const ds = stan?.doSprawdzenia ?? null
  const tytul = !stan ? 'Dodatkowa przesyłka' : ds ? `Dodatkowa przesyłka nr ${ds.numer}` : stan.powod ? 'Dodatkowa przesyłka' : `Dodatkowa przesyłka nr ${stan.nastepnyNumer}`
  const banery = (
    <>
      {wynik?.blad && (
        <Baner ton="blad" rola="alert">
          {wynik.blad}
        </Baner>
      )}
      {wynik?.info && (
        <Baner ton="info" rola="status">
          {wynik.info}
        </Baner>
      )}
    </>
  )

  return (
    <div className="kz-odstep-gora">
      <Przycisk wariant="drugorzedny" rozmiar="sm" onClick={otworz} ladowanie={czeka && !otwarte}>
        Dodaj przesyłkę
      </Przycisk>
      {!otwarte && banery}
      <Modal
        otwarty={otwarte}
        onZamknij={() => setOtwarte(false)}
        tytul={tytul}
        stopka={
          <>
            <Przycisk wariant="drugorzedny" onClick={() => setOtwarte(false)}>
              {formularz ? 'Anuluj' : 'Zamknij'}
            </Przycisk>
            {formularz && (
              <Przycisk onClick={utworz} ladowanie={czeka} disabled={!pola.potwierdzam}>
                {czeka ? 'Tworzę…' : 'Utwórz przesyłkę'}
              </Przycisk>
            )}
          </>
        }
      >
        {!stan ? (
          <div className="stack">
            <p>{BRAK_STANU}</p>
            {banery}
          </div>
        ) : stan.powod ? (
          <div className="stack">
            <p>{stan.powod}</p>
            {ds && (
              <>
                <p className="small muted">
                  Referencja w Kompletorze: <span className="mono">{ds.referencja}</span>
                </p>
                <div>
                  <Przycisk wariant="drugorzedny" rozmiar="sm" onClick={sprawdz} ladowanie={czeka}>
                    Sprawdź u przewoźnika
                  </Przycisk>
                </div>
              </>
            )}
            {banery}
            {ds?.rozstrzygalna && stan.mozeRozstrzygnac && (
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
                  <PoleTekstowe id={`dp-rr-${ds.shipmentId}`} etykieta={ds.rozstrzygniecie.etykietaNumeru} pomoc={ds.rozstrzygniecie.wskazowka} name="numer" className="mono" autoComplete="off" />
                  <p className="small muted">Wybór trafia do dziennika zmian z Twoim nazwiskiem. „Nie powstała” pozwala dodać przesyłkę od nowa: zaznacz to tylko po sprawdzeniu w panelu przewoźnika, inaczej możesz zapłacić za dwie paczki.</p>
                  <div>
                    <Przycisk type="submit" ladowanie={czeka}>
                      Zapisz rozstrzygnięcie
                    </Przycisk>
                  </div>
                </form>
              </Zaawansowane>
            )}
            {ds?.rozstrzygalna && !stan.mozeRozstrzygnac && <p className="small muted">Jeśli „Sprawdź u przewoźnika” nie wystarczy, poproś osobę z uprawnieniem do rozstrzygania przesyłek (np. właściciela) o „Rozstrzygnij ręcznie” w tym oknie.</p>}
          </div>
        ) : (
          <div className="stack">
            <p className="small muted">
              Nowa paczka do tego samego zamówienia, np. dosyłka po reklamacji. Status zamówienia, faktura, stan magazynu i numer nadania w sklepie zostają bez zmian, klient nie dostaje maila. Przewoźnik policzy nową etykietę.
            </p>
            <Wybor id="dp-rodzaj" etykieta="Rodzaj" value={pola.rodzaj} onChange={ustaw('rodzaj')} opcje={[{ wartosc: '', etykieta: 'Wybierz…' }, ...stan.rodzaje.map((r) => ({ wartosc: r.kod, etykieta: r.nazwa }))]} />
            <Wybor id="dp-modul" etykieta="Przewoźnik i moduł" value={pola.regulaId} onChange={ustaw('regulaId')} opcje={stan.moduly.map((m) => ({ wartosc: m.regulaId, etykieta: m.zamowienia ? `${m.nazwa} (jak w zamówieniu)` : m.nazwa }))} />
            <Wybor id="dp-gabaryt" etykieta="Gabaryt" value={pola.gabaryt} onChange={ustaw('gabaryt')} opcje={[{ wartosc: '', etykieta: 'Wybierz…' }, ...stan.gabaryty.map((g) => ({ wartosc: g.kod, etykieta: g.nazwa }))]} />
            <PoleWielowierszowe id="dp-powod" etykieta="Powód" rows={2} maxLength={300} value={pola.powod} onChange={ustaw('powod')} pomoc="Np. „reklamacja: brak jednego produktu” albo „paczka zaginęła u przewoźnika”. Widać go na karcie i w raporcie." />
            <PoleTekstowe id="dp-koszt" etykieta="Koszt etykiety netto" opcjonalne inputMode="decimal" placeholder="np. 14,50" value={pola.koszt} onChange={ustaw('koszt')} pomoc="W złotych; trafia do raportu „Dodatkowe przesyłki”." />
            {doPotwierdzenia.length > 0 && (
              <div className="stack">
                {doPotwierdzenia.map((o) => (
                  <Przelacznik key={o.kod} id={`dp-potw-${o.kod}`} etykieta={o.tekst} checked={potwierdzone.includes(o.kod)} onChange={(e) => setPotwierdzone((x) => (e.target.checked ? [...x, o.kod] : x.filter((k) => k !== o.kod)))} />
                ))}
              </div>
            )}
            <Przelacznik id="dp-potwierdzam" etykieta="Potwierdzam: ta przesyłka ma powstać (płatna etykieta u przewoźnika)" checked={pola.potwierdzam} onChange={(e) => setPola((p) => ({ ...p, potwierdzam: e.target.checked }))} />
            {banery}
          </div>
        )}
      </Modal>
    </div>
  )
}
