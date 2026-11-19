'use client'
// Pasek akcji listy przesyłek: „Pobierz etykiety” (jeden PDF), „Drukuj etykiety” (stanowisko druku, w tle
// od 10 przesyłek), „Pobierz protokół” (od przewoźnika albo własna lista przekazanych paczek) i „Anuluj przesyłki”
// (z potwierdzeniem). Akcja bez uprawnienia, bez stanowiska druku albo na koncie z wyłączonym nadawaniem jest widoczna,
// ale nieaktywna z powodem. „Zaznacz wszystkie pasujące” przenosi druk i anulowanie na wszystkie strony (najwyżej 500).
import { useRouter } from 'next/navigation'
import { useActionState, useEffect, useMemo, useState } from 'react'
import { Modal, Przycisk, ToastPoAkcji, Wybor, ZaznaczoneUkryte, useZaznaczenie } from '@/app/ui'
import { opisStanowiskaDoWyboru, useStanowiskaDruku, useWybraneStanowisko, type StanowiskoDruku } from '../../_komponenty/druk'
import { MAKS_PLIKU, MAKS_PRZESYLEK, PROG_TLA_PRZESYLEK } from '@/lib/wysylka/masowo-progi'
import { akcjaPrzesylek, type StanAkcjiPrzesylek } from '../akcje'

export interface WierszAkcji {
  /** powód, dla którego konto przewoźnika nie pozwala na druk etykiet i anulowanie; null = wolno */
  wylaczone: string | null
  etykieta: boolean
  anulowalna: boolean
  konto: string
}

const nowyKlucz = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 24) : String(Date.now()) + Math.random().toString(36).slice(2, 10))

type Okno = 'druk' | 'anuluj' | null

export function AkcjePrzesylek({ wiersze, razem, filtry, mozeMagazyn }: { wiersze: Record<string, WierszAkcji>; razem: number; filtry: string; mozeMagazyn: boolean }) {
  const z = useZaznaczenie()
  const [okno, setOkno] = useState<Okno>(null)
  const [wszystkie, setWszystkie] = useState(false)
  const [klucz, setKlucz] = useState(nowyKlucz)
  const [stan, wyslij, trwa] = useActionState<StanAkcjiPrzesylek, FormData>(akcjaPrzesylek, { komunikat: null })
  const stanowiska = useStanowiskaDruku()
  // domyślnie stanowisko wybrane na tym urządzeniu (ta sama pamięć co nagłówek pakowania i „Drukuj”)
  const [wybrane] = useWybraneStanowisko(stanowiska)
  const router = useRouter()
  const ids = [...z.wybrane]
  const cala = z.ids.length > 0 && z.ids.every((id) => z.wybrane.has(id))
  const zaznaczenie = ids.join('|')
  useEffect(() => setWszystkie(false), [zaznaczenie])
  useEffect(() => {
    if (!stan.komunikat) return
    setOkno(null)
    setKlucz(nowyKlucz())
    if (stan.wTle) router.refresh()
  }, [stan, router])
  const ile = wszystkie ? razem : ids.length
  const w = useMemo(() => ids.map((id) => wiersze[id]).filter((x): x is WierszAkcji => !!x), [zaznaczenie, wiersze]) // eslint-disable-line react-hooks/exhaustive-deps
  const zEtykieta = w.filter((x) => x.etykieta && !x.wylaczone).length
  const doAnulowania = w.filter((x) => x.anulowalna && !x.wylaczone).length
  const bezUprawnien = mozeMagazyn ? undefined : 'Przesyłki obsługuje osoba z dostępem do stanowiska pakowania (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).'

  const ukryte = (rodzaj: string) => (
    <>
      <input type="hidden" name="rodzaj" value={rodzaj} />
      <input type="hidden" name="klucz" value={klucz} />
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
  const stopka = (tekst: string, formularz: string, wariant: 'glowny' | 'niebezpieczny' = 'glowny') => (
    <>
      <Przycisk wariant="cichy" onClick={() => setOkno(null)}>
        Wróć
      </Przycisk>
      <Przycisk wariant={wariant} type="submit" form={formularz} ladowanie={trwa}>
        {tekst}
      </Przycisk>
    </>
  )
  const uwagaTla =
    ile > MAKS_PRZESYLEK ? (
      <p className="ui-pomoc zl-za-duzo">Najwyżej {MAKS_PRZESYLEK} przesyłek w jednej akcji: zawęź zaznaczenie albo filtry.</p>
    ) : ile >= PROG_TLA_PRZESYLEK ? (
      <p className="ui-pomoc">{ile} przesyłek: akcja pójdzie w tle, postęp i raport zobaczysz nad listą.</p>
    ) : null
  const plik = (sciezka: string) => `/api/przesylki/${sciezka}?z=${encodeURIComponent(ids.join(','))}`
  const zaDuzoPlik = wszystkie || ids.length > MAKS_PLIKU ? `Najwyżej ${MAKS_PLIKU} zaznaczonych przesyłek w jednym pliku.` : undefined

  return (
    <>
      <ToastPoAkcji stan={stan} />
      {cala && razem > ids.length && (
        <button type="button" className="btn small" aria-pressed={wszystkie} onClick={() => setWszystkie((x) => !x)}>
          {wszystkie ? `Wszystkie pasujące: ${razem} (tylko zaznaczone)` : `Zaznacz wszystkie pasujące: ${razem}`}
        </button>
      )}
      {bezUprawnien || zaDuzoPlik || !zEtykieta ? (
        <Przycisk rozmiar="sm" powodWylaczenia={bezUprawnien ?? zaDuzoPlik ?? 'Zaznaczone przesyłki nie mają pobranej etykiety albo są na koncie z wyłączonym nadawaniem.'}>
          Pobierz etykiety
        </Przycisk>
      ) : (
        <a className="btn small" href={plik('etykiety')} target="_blank" rel="noopener">
          Pobierz etykiety ({zEtykieta})
        </a>
      )}
      <Przycisk
        rozmiar="sm"
        onClick={() => setOkno('druk')}
        powodWylaczenia={bezUprawnien ?? (stanowiska && !stanowiska.length ? 'Brak stanowiska druku: dodaj je w Ustawienia → Wysyłka i druk → Druk.' : !wszystkie && !zEtykieta ? 'Zaznaczone przesyłki nie mają pobranej etykiety albo są na koncie z wyłączonym nadawaniem.' : undefined)}
      >
        Drukuj etykiety
      </Przycisk>
      {bezUprawnien || zaDuzoPlik ? (
        <Przycisk rozmiar="sm" powodWylaczenia={bezUprawnien ?? zaDuzoPlik}>
          Pobierz protokół
        </Przycisk>
      ) : (
        <a className="btn small" href={plik('protokol')} target="_blank" rel="noopener" title="Lista przekazanych paczek z miejscem na podpis kuriera (bez żądania do przewoźnika)">
          Pobierz protokół
        </a>
      )}
      <Przycisk
        rozmiar="sm"
        wariant="niebezpieczny"
        onClick={() => setOkno('anuluj')}
        powodWylaczenia={bezUprawnien ?? (!wszystkie && !doAnulowania ? 'Żadnej z zaznaczonych przesyłek nie da się anulować z Kompletora (przewoźnik bez anulowania, przesyłka nieutworzona albo konto z wyłączonym nadawaniem): anuluj w panelu przewoźnika.' : undefined)}
      >
        Anuluj przesyłki
      </Przycisk>

      {!!stan.bledy?.length && (
        <div className="zl-raport" role="status">
          <b>Pominięte albo z błędem: {stan.bledy.length}</b>
          <ul>
            {stan.bledy.map((b) => (
              <li key={b.id}>
                <b>{b.nr}</b>: {b.komunikat}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Modal otwarty={okno === 'druk'} onZamknij={() => setOkno(null)} tytul={`Drukuj etykiety: ${ile}`} stopka={stopka('Drukuj etykiety', 'pl-form-druk')}>
        <form id="pl-form-druk" action={wyslij}>
          {ukryte('PRZESYLKI_DRUK')}
          <Wybor
            id="pl-stanowisko"
            name="stanowisko"
            etykieta="Stanowisko druku"
            required
            key={wybrane || "brak"}
            defaultValue={wybrane || stanowiska?.[0]?.id || ''}
            opcje={(stanowiska ?? []).map((s) => ({ wartosc: s.id, etykieta: opisStanowiskaDoWyboru(s) }))}
            pomoc="Etykiety drukują się w kolejności z listy, jedna po drugiej. Przesyłki bez etykiety albo na koncie z wyłączonym nadawaniem zostaną pominięte z powodem w raporcie."
          />
          {!wszystkie && zEtykieta < ids.length && <p className="ui-pomoc">Z etykietą do druku: {zEtykieta} z {ids.length}.</p>}
          {uwagaTla}
        </form>
      </Modal>
      <Modal otwarty={okno === 'anuluj'} onZamknij={() => setOkno(null)} tytul={`Anuluj przesyłki: ${ile}`} stopka={stopka('Tak, anuluj u przewoźnika', 'pl-form-anuluj', 'niebezpieczny')}>
        <form id="pl-form-anuluj" action={wyslij}>
          {ukryte('PRZESYLKI_ANULUJ')}
          <p>Kompletor wyśle do przewoźnika anulowanie każdej przesyłki. Anulowanej przesyłki nie da się przywrócić: do zamówienia trzeba będzie utworzyć nową.</p>
          {!wszystkie && doAnulowania < ids.length && (
            <p className="ui-pomoc">
              Da się anulować {doAnulowania} z {ids.length}. Pozostałe zostaną pominięte z powodem (np. przewoźnik nie anuluje z Kompletora: wtedy w jego panelu).
            </p>
          )}
          {uwagaTla}
        </form>
      </Modal>
    </>
  )
}

/** Stanowiska dla przycisków „Drukuj” w wierszach: jeden odczyt na stronę (nie po jednym na wiersz), ważny 60 s. */
let wspolne: { kiedy: number; lista: Promise<StanowiskoDruku[]> } | null = null
function useStanowiskaWierszy(): StanowiskoDruku[] | null {
  const [lista, setLista] = useState<StanowiskoDruku[] | null>(null)
  useEffect(() => {
    if (!wspolne || Date.now() - wspolne.kiedy > 60_000)
      wspolne = {
        kiedy: Date.now(),
        lista: fetch('/api/wydruki/stan', { cache: 'no-store', credentials: 'same-origin' })
          .then(async (r) => (r.ok ? ((await r.json()) as { stanowiska?: StanowiskoDruku[] }) : { stanowiska: [] }))
          .then((j) => (Array.isArray(j.stanowiska) ? j.stanowiska : []))
          .catch(() => {
            wspolne = null
            return []
          }),
      }
    let zyje = true
    void wspolne.lista.then((l) => zyje && setLista(l))
    return () => {
      zyje = false
    }
  }, [])
  return lista
}

/** „Drukuj” w wierszu: jedna etykieta na stanowisko wybrane na tym urządzeniu (bez wyboru: pierwsze), raport w toaście. */
export function DrukujWiersz({ id, powod }: { id: string; powod: string | null }) {
  const [stan, wyslij, trwa] = useActionState<StanAkcjiPrzesylek, FormData>(akcjaPrzesylek, { komunikat: null })
  const stanowiska = useStanowiskaWierszy()
  const [klucz, setKlucz] = useState(nowyKlucz)
  useEffect(() => {
    if (stan.komunikat) setKlucz(nowyKlucz())
  }, [stan])
  const [wybrane] = useWybraneStanowisko(stanowiska)
  const st = stanowiska?.find((s) => s.id === wybrane) ?? stanowiska?.[0]
  const brak = powod ?? (stanowiska && !st ? 'Brak stanowiska druku: dodaj je w Ustawienia → Wysyłka i druk → Druk.' : null)
  return (
    <>
      <ToastPoAkcji stan={stan.bledy?.length ? { ...stan, ok: false, komunikat: stan.bledy[0]!.komunikat } : stan} />
      {brak ? (
        <Przycisk rozmiar="sm" wariant="cichy" powodWylaczenia={brak}>
          Drukuj
        </Przycisk>
      ) : (
        <form action={wyslij} className="inline">
          <input type="hidden" name="rodzaj" value="PRZESYLKI_DRUK" />
          <input type="hidden" name="zaznaczone" value={id} />
          <input type="hidden" name="stanowisko" value={st?.id ?? ''} />
          <input type="hidden" name="klucz" value={klucz} />
          <Przycisk rozmiar="sm" wariant="cichy" type="submit" ladowanie={trwa} title={st ? `Drukuj na stanowisku „${st.name}”` : undefined}>
            Drukuj
          </Przycisk>
        </form>
      )}
    </>
  )
}
