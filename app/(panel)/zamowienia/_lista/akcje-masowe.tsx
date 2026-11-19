'use client'
// Pasek akcji na zaznaczonych zamówieniach (jak pasek narzędzi listy w BL; stały, akcje bez
// zaznaczenia wyłączone z powodem, jak w TwojOMS): zmiana statusu z powodem,
// utworzenie przesyłek z gabarytem, druk etykiet, kart i listy wysyłkowej. Eksport (zaznaczone albo widok, CSV albo
// XLSX) to jedna ikona po prawej stronie paska (_lista/eksport.tsx). Akcja bez uprawnienia albo
// bez stanowiska druku jest widoczna, ale wyłączona z powodem (zasada fal). „Zaznacz wszystkie pasujące” przenosi
// akcję na wszystkie strony: serwer liczy identyfikatory z tych samych filtrów co lista (najwyżej 1000).
// Od progu (zmiana statusu 50, przesyłki i etykiety 10) akcja idzie w tle; postęp i raport pokazuje jeden PostepAkcji
// nad listą (renderuje go strona z `ostatnieAkcje` po odświeżeniu, nie ten pasek). Okno akcji zamyka się po każdej
// odpowiedzi serwera, żeby raport błędów nie chował się pod formularzem.
import { useRouter } from 'next/navigation'
import { useActionState, useEffect, useState } from 'react'
import { Modal, Przycisk, PoleWielowierszowe, ToastPoAkcji, Wybor, ZaznaczoneUkryte, useZaznaczenie } from '@/app/ui'
import { DrukujNaStanowisku, opisStanowiskaDoWyboru, useStanowiskaDruku, useWybraneStanowisko } from '../../_komponenty/druk'
import { MAKS_AKCJI, PROG_TLA, type RodzajAkcji } from '@/lib/zamowienia/masowo-progi'
import { MAX_ZAMOWIEN } from '@/lib/stanowisko/stale'
import { akcjaMasowa, type StanAkcjiMasowej } from '../akcje-masowe'

const LIMIT_LISTY = 200
/** Limit serwera kart (lib/stanowisko/stale.ts); wcześniej 200 tu i 100 na serwerze. */
const LIMIT_KART = MAX_ZAMOWIEN
const BEZ_ZAZNACZENIA = 'Najpierw zaznacz zamówienia na liście (pole przy numerze).'

type Okno = 'status' | 'przesylki' | 'etykiety' | null

export function AkcjeMasowe({
  opcjeStatusow,
  razem,
  filtry,
  mozeStatus,
  mozeMagazyn,
}: {
  opcjeStatusow: { wartosc: string; etykieta: string }[]
  /** liczba zamówień pasujących do filtrów (wszystkie strony) */
  razem: number
  /** bieżące parametry listy jako query string (akcja „na wszystkich stronach”, eksport) */
  filtry: string
  mozeStatus: boolean
  mozeMagazyn: boolean
}) {
  const z = useZaznaczenie()
  const [okno, setOkno] = useState<Okno>(null)
  const [wszystkie, setWszystkie] = useState(false)
  const [stan, wyslij, trwa] = useActionState<StanAkcjiMasowej, FormData>(akcjaMasowa, { komunikat: null })
  const stanowiska = useStanowiskaDruku()
  // domyślnie stanowisko wybrane na tym urządzeniu
  const [wybrane] = useWybraneStanowisko(stanowiska)
  const ids = [...z.wybrane]
  const cala = z.ids.length > 0 && z.ids.every((id) => z.wybrane.has(id))
  // zmiana zaznaczenia wraca do „tylko zaznaczone”
  const klucz = ids.join('|')
  useEffect(() => setWszystkie(false), [klucz])
  const router = useRouter()
  useEffect(() => {
    if (!stan.komunikat) return
    setOkno(null)
    if (stan.wTle) router.refresh() // pasek postępu przychodzi ze strony (ostatnieAkcje)
  }, [stan, router])
  const ile = wszystkie ? razem : ids.length
  const pdf = stanowiska?.length ? 'Pobierz PDF: ' : 'Drukuj '

  const ukryte = (rodzaj: string) => (
    <>
      <input type="hidden" name="rodzaj" value={rodzaj} />
      {wszystkie ? (
        <>
          <input type="hidden" name="wszystkie" value="tak" />
          <input type="hidden" name="filtry" value={filtry} />
        </>
      ) : (
        <ZaznaczoneUkryte />
      )}
    </>
  )
  const uwagaTla = (rodzaj: RodzajAkcji) =>
    ile > MAKS_AKCJI[rodzaj] ? (
      <p className="ui-pomoc zl-za-duzo">Najwyżej {MAKS_AKCJI[rodzaj]} zamówień w jednej akcji: zawęź zaznaczenie albo filtry.</p>
    ) : ile >= PROG_TLA[rodzaj] ? (
      <p className="ui-pomoc">{ile} zamówień: akcja pójdzie w tle, postęp i raport zobaczysz nad listą.</p>
    ) : null
  const stopka = (tekst: string, formularz: string) => (
    <>
      <Przycisk wariant="cichy" onClick={() => setOkno(null)}>
        Anuluj
      </Przycisk>
      <Przycisk wariant="glowny" type="submit" form={formularz} ladowanie={trwa}>
        {tekst}
      </Przycisk>
    </>
  )

  // (R7), bez zaznaczenia przyciski są w DOM, ale ukryte stylem (jasny wiersz z podpowiedzią); (brak uprawnienia
  // ma pierwszeństwo, bo zaznaczenie go nie zmieni)
  if (ids.length === 0 && !wszystkie) {
    const powod = (brakPrawa?: string) => brakPrawa ?? BEZ_ZAZNACZENIA
    return (
      <>
        <ToastPoAkcji stan={stan} />
        <Przycisk rozmiar="sm" powodWylaczenia={powod(mozeStatus ? undefined : 'Zmiana statusu wymaga uprawnienia „Zmiana statusu na dowolny dozwolony” (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).')}>
          Zmień status
        </Przycisk>
        <Przycisk rozmiar="sm" powodWylaczenia={powod(mozeMagazyn ? undefined : 'Przesyłki tworzy osoba z dostępem do stanowiska pakowania.')}>
          Utwórz przesyłki
        </Przycisk>
        <Przycisk rozmiar="sm" powodWylaczenia={powod(mozeMagazyn ? undefined : 'Etykiety drukuje osoba z dostępem do stanowiska pakowania.')}>
          Drukuj etykiety
        </Przycisk>
        <Przycisk rozmiar="sm" powodWylaczenia={BEZ_ZAZNACZENIA}>
          Lista wysyłkowa
        </Przycisk>
        {mozeMagazyn && (
          <Przycisk rozmiar="sm" powodWylaczenia={BEZ_ZAZNACZENIA}>
            Karty zamówień
          </Przycisk>
        )}
      </>
    )
  }

  return (
    <>
      <ToastPoAkcji stan={stan} />
      {cala && razem > ids.length && (
        <button type="button" className="btn small" aria-pressed={wszystkie} onClick={() => setWszystkie((w) => !w)}>
          {wszystkie ? `Wszystkie pasujące: ${razem} (tylko zaznaczone)` : `Zaznacz wszystkie pasujące: ${razem}`}
        </button>
      )}
      <Przycisk rozmiar="sm" onClick={() => setOkno('status')} powodWylaczenia={mozeStatus ? undefined : 'Zmiana statusu wymaga uprawnienia „Zmiana statusu na dowolny dozwolony” (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).'}>
        Zmień status
      </Przycisk>
      <Przycisk rozmiar="sm" onClick={() => setOkno('przesylki')} powodWylaczenia={mozeMagazyn ? undefined : 'Przesyłki tworzy osoba z dostępem do stanowiska pakowania.'}>
        Utwórz przesyłki
      </Przycisk>
      <Przycisk
        rozmiar="sm"
        onClick={() => setOkno('etykiety')}
        powodWylaczenia={!mozeMagazyn ? 'Etykiety drukuje osoba z dostępem do stanowiska pakowania.' : stanowiska && !stanowiska.length ? 'Brak stanowiska druku: dodaj je w Ustawienia → Wysyłka i druk → Druk.' : undefined}
      >
        Drukuj etykiety
      </Przycisk>
      {!wszystkie && ids.length <= LIMIT_LISTY && <DrukujNaStanowisku typ="lista" ids={ids} etykieta="Drukuj listę" stanowiska={stanowiska} />}
      {!wszystkie && ids.length <= LIMIT_LISTY ? (
        <a className="btn small" href={`/api/wydruki/lista-wysylkowa?z=${encodeURIComponent(ids.join(','))}`} target="_blank" rel="noopener">
          {pdf}listę wysyłkową
        </a>
      ) : (
        <Przycisk rozmiar="sm" powodWylaczenia={`Lista wysyłkowa: najwyżej ${LIMIT_LISTY} zaznaczonych zamówień.`}>
          Lista wysyłkowa
        </Przycisk>
      )}
      {mozeMagazyn && (wszystkie || ids.length > LIMIT_KART) && (
        <Przycisk rozmiar="sm" powodWylaczenia={`Karty: najwyżej ${LIMIT_KART} zaznaczonych zamówień.`}>
          Karty zamówień
        </Przycisk>
      )}
      {/* każde zaznaczone zamówienie dostaje stronę — wysłane, anulowane i bez towaru do zebrania jako wydruk
          informacyjny (bez kodu karty, bez zmian w zamówieniu) */}
      {mozeMagazyn && !wszystkie && ids.length <= LIMIT_KART && <DrukujNaStanowisku typ="karta" ids={ids} etykieta="Drukuj karty" stanowiska={stanowiska} informacyjne />}
      {mozeMagazyn && !wszystkie && ids.length <= LIMIT_KART && (
        // POST, nie link: każdy wydruk nadaje nowe numery kart
        <form className="inline" method="post" action="/api/wydruki/karty" target="_blank">
          <input type="hidden" name="z" value={ids.join(',')} />
          <input type="hidden" name="informacyjne" value="1" />
          <button className="btn small" type="submit">
            {pdf}karty zamówień
          </button>
        </form>
      )}

      {!!stan.bledy?.length && (
        <div className="zl-raport" role="status">
          <b>Nie udało się dla {stan.bledy.length} zamówień:</b>
          <ul>
            {stan.bledy.map((b) => (
              <li key={b.id}>
                <a href={`/zamowienia/${b.id}`}>{b.nr}</a>: {b.komunikat}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Modal otwarty={okno === 'status'} onZamknij={() => setOkno(null)} tytul={`Zmień status: ${ile} zamówień`} stopka={stopka('Zmień status', 'zl-form-status')}>
        <form id="zl-form-status" action={wyslij}>
          {ukryte('STATUS')}
          <Wybor id="zl-status" name="status" etykieta="Nowy status" required defaultValue="" opcje={[{ wartosc: '', etykieta: 'Wybierz…' }, ...opcjeStatusow]} pomoc="Każde zamówienie przechodzi tylko wtedy, gdy ten status jest dla niego dozwolony; pozostałe dostaną powód w raporcie." />
          <PoleWielowierszowe id="zl-powod" name="powod" etykieta="Powód" rows={2} required minLength={3} maxLength={300} pomoc="Zostanie w historii każdego zamówienia." />
          {uwagaTla('STATUS')}
        </form>
      </Modal>
      <Modal otwarty={okno === 'przesylki'} onZamknij={() => setOkno(null)} tytul={`Utwórz przesyłki: ${ile} zamówień`} stopka={stopka('Utwórz przesyłki', 'zl-form-przesylki')}>
        <form id="zl-form-przesylki" action={wyslij}>
          {ukryte('PRZESYLKI')}
          <Wybor
            id="zl-gabaryt"
            name="gabaryt"
            etykieta="Rozmiar paczki"
            defaultValue=""
            opcje={[
              { wartosc: '', etykieta: 'Domyślny dla przewoźnika' },
              { wartosc: 'A', etykieta: 'A (mała)' },
              { wartosc: 'B', etykieta: 'B (średnia)' },
              { wartosc: 'C', etykieta: 'C (duża)' },
            ]}
            pomoc="Rozmiar dobiera się do przewoźnika każdego zamówienia (paczkomat, Allegro). Przesyłka, która czeka na potwierdzenie wagi albo wymiarów, zostanie w raporcie do potwierdzenia na karcie."
          />
          {uwagaTla('PRZESYLKI')}
        </form>
      </Modal>
      <Modal otwarty={okno === 'etykiety'} onZamknij={() => setOkno(null)} tytul={`Drukuj etykiety: ${ile} zamówień`} stopka={stopka('Drukuj etykiety', 'zl-form-etykiety')}>
        <form id="zl-form-etykiety" action={wyslij}>
          {ukryte('ETYKIETY')}
          <Wybor key={wybrane || "brak"} id="zl-stanowisko" name="stanowisko" etykieta="Stanowisko druku" required defaultValue={wybrane || stanowiska?.[0]?.id || ''} opcje={(stanowiska ?? []).map((s) => ({ wartosc: s.id, etykieta: opisStanowiskaDoWyboru(s) }))} pomoc="Drukują się etykiety zamówień z utworzoną przesyłką; pozostałe dostaną powód w raporcie." />
          {uwagaTla('ETYKIETY')}
        </form>
      </Modal>
    </>
  )
}
