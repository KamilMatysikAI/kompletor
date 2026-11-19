'use client'
// Kolejka pakowania: zaznaczanie zamówień i pasek pracy masowej, potwierdzenie
// „Przyjechał”. Zaznaczenie żyje tylko na tej stronie (checkboxy w wierszach renderuje serwer).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { DrukujNaStanowisku, useStanowiskaDruku } from '../_komponenty/druk'
import { Przycisk, PrzyciskLink, PrzyciskPotwierdz } from '@/app/ui'
import { MAX_ZAMOWIEN } from '@/lib/stanowisko/stale'

const LIMIT_LISTY = 200
/** Lista zbierania czyta zamówienia jak stanowisko. */
const LIMIT_ZBIERANIA = MAX_ZAMOWIEN

/**
 * `canPack` = uprawnienie `pakowanie.stanowisko` (magazyn, właściciel): bez niego „Pakuj zaznaczone” i „Drukuj karty”
 * się nie pokazują (biuro dostałoby 404). Lista wysyłkowa — każdy z podglądem panelu. `tuKolejka` = adres tej kolejki
 * z filtrami: „Pakuj zaznaczone” dokłada do niego `pakuj=…` i otwiera okno nad panelem.
 */
export function Zaznaczanie({ children, naStronie, canPack, tuKolejka }: { children: ReactNode; naStronie: number; canPack: boolean; tuKolejka: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [ids, setIds] = useState<string[]>([])
  // stanowiska druku firmy; brak = panel jak dotąd (same przyciski PDF)
  const stanowiska = useStanowiskaDruku()
  const pdf = stanowiska?.length ? 'Pobierz PDF: ' : 'Drukuj '

  const read = useCallback(() => {
    const el = box.current
    if (!el) return
    const all = [...el.querySelectorAll<HTMLInputElement>('input[data-zaznacz]')]
    for (const i of all) i.closest('tr')?.classList.toggle('sel', i.checked)
    setIds(all.filter((i) => i.checked).map((i) => i.value))
  }, [])

  useEffect(() => {
    const el = box.current
    if (!el) return
    el.addEventListener('change', read)
    read()
    return () => el.removeEventListener('change', read)
  }, [read])

  const setAll = (on: boolean) => {
    for (const i of box.current?.querySelectorAll<HTMLInputElement>('input[data-zaznacz]') ?? []) i.checked = on
    read()
  }

  const z = encodeURIComponent(ids.join(','))
  const allOn = ids.length > 0 && ids.length === naStronie
  return (
    <div ref={box}>
      <div className="sel-all">
        <label className="sel-all-l">
          <input
            type="checkbox"
            checked={allOn}
            ref={(i) => {
              if (i) i.indeterminate = ids.length > 0 && !allOn
            }}
            onChange={(e) => setAll(e.target.checked)}
          />
          Zaznacz wszystkie na stronie ({naStronie})
        </label>
      </div>
      {ids.length > 0 && (
        <div className="bulk" role="region" aria-label="Praca na zaznaczonych">
          <b>Zaznaczono {ids.length}</b>
          {canPack && (
            <>
              <PrzyciskLink wariant="glowny" href={`${tuKolejka}${tuKolejka.includes('?') ? '&' : '?'}pakuj=${z}`} scroll={false} prefetch={false}>
                Pakuj zaznaczone
              </PrzyciskLink>
              {/* zbiorcza lista zbierania po lokalizacji, z koszykami */}
              {ids.length <= LIMIT_ZBIERANIA ? (
                <PrzyciskLink href={`/pakowanie/zbieranie?z=${z}`} prefetch={false}>
                  Lista zbierania
                </PrzyciskLink>
              ) : (
                <Przycisk powodWylaczenia={`Lista zbierania: najwyżej ${LIMIT_ZBIERANIA} zamówień naraz`}>Lista zbierania</Przycisk>
              )}
              {/* POST, nie link: każdy wydruk nadaje nowy numer kart, więc F5 w karcie z PDF-em nie może drukować
                  ponownie */}
              <DrukujNaStanowisku typ="karta" ids={ids} etykieta="Drukuj karty" stanowiska={stanowiska} />
              <form className="inline" method="post" action="/api/wydruki/karty" target="_blank">
                <input type="hidden" name="z" value={ids.join(',')} />
                <button className="btn" type="submit">
                  {pdf}karty zamówień
                </button>
              </form>
            </>
          )}
          {ids.length <= LIMIT_LISTY && <DrukujNaStanowisku typ="lista" ids={ids} etykieta="Drukuj listę" stanowiska={stanowiska} />}
          {ids.length <= LIMIT_LISTY ? (
            <a className="btn" href={`/api/wydruki/lista-wysylkowa?z=${z}`} target="_blank" rel="noopener">
              {pdf}listę wysyłkową
            </a>
          ) : (
            <span className="btn is-disabled" aria-disabled="true" title={`Lista wysyłkowa: najwyżej ${LIMIT_LISTY} zamówień naraz`}>
              Lista wysyłkowa: najwyżej {LIMIT_LISTY}
            </span>
          )}
          <button className="btn ghost" type="button" onClick={() => setAll(false)}>
            Odznacz
          </button>
        </div>
      )}
      {children}
    </div>
  )
}

/** Przycisk „Przyjechał …” z potwierdzeniem (kliknięcie zamyka odbiór dnia i chowa paczki, które pojechały). */
export function PrzyjechalPrzycisk({ label, wyslane = false }: { label: string; /** automat „Wysłane” po przyjeździe włączony */ wyslane?: boolean }) {
  const pytanie = wyslane
    ? 'Odbiór na dziś się zamknie. Spakowane paczki z numerem nadania przejdą do „Wysłane”: klient dostanie mail, a sklep status i numer przesyłki. Paczki bez numeru zostaną z powodem w raporcie.'
    : 'Odbiór na dziś się zamknie, a wysłane paczki znikną z kolejki.'
  return (
    <PrzyciskPotwierdz wariant="glowny" tytul={`Kurier ${label} przyjechał i zabrał spakowane paczki?`} pytanie={pytanie} tak={`Tak, przyjechał ${label}`}>
      Przyjechał {label}
    </PrzyciskPotwierdz>
  )
}
