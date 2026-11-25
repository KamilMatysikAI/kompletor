'use client'
// Kolejka pakowania: zaznaczanie zamówień i pasek pracy masowej, potwierdzenie „Przyjechał”. Checkboxy
// w wierszach renderuje serwer. Przy każdym kurierze „Zaznacz wszystkie na tej stronie” i (gdy kurier ma
// zamówienia na innych stronach) „Zaznacz wszystkie tego kuriera”: id z innych stron przychodzą z serwera
// (`idsKuriera`) i żyją w stanie tej strony; pasek „Zaznaczono …” i wszystkie akcje liczą je razem ze stroną,
// z limitami akcji (pakowanie i karty MAX_ZAMOWIEN, lista wysyłkowa LIMIT_LISTY). Przejście na inną stronę zaczyna
// zaznaczanie od nowa (jak dotąd).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DrukujNaStanowisku, useStanowiskaDruku } from '../_komponenty/druk'
import { Przycisk, PrzyciskLink, PrzyciskPotwierdz } from '@/app/ui'
import { MAX_ZAMOWIEN } from '@/lib/stanowisko/stale'
import { rozbicieZaznaczenia, zaznaczonePoKurierach } from '@/lib/pakowanie/zaznaczenie'

const LIMIT_LISTY = 200
/** Lista zbierania czyta zamówienia jak stanowisko. */
const LIMIT_ZBIERANIA = MAX_ZAMOWIEN

/** Stan zaznaczenia jednej sekcji kuriera (do pól „Zaznacz wszystkie …” przy kurierze). */
interface StanSekcji {
  naStronie: number
  zaznaczoneNaStronie: number
  /** Zaznaczone tego kuriera razem z innymi stronami (widać je przy pasku także w zwiniętej sekcji). */
  zaznaczone: number
  caly: boolean
}

interface ZaznaczanieApi {
  stan: (klucz: string) => StanSekcji
  zaznaczStrone: (klucz: string, on: boolean) => void
  zaznaczKuriera: (klucz: string, on: boolean) => void
}

const Ctx = createContext<ZaznaczanieApi | null>(null)
/** Stała (nie nowy obiekt przy renderze), bo `read` zależy od `idsKuriera`. */
const BEZ_LIST: Record<string, string[]> = {}

const polaSekcji = (el: Element) => [...el.querySelectorAll<HTMLInputElement>('input[data-zaznacz]')]

/**
 * `canPack` = uprawnienie `pakowanie.stanowisko` (magazyn, właściciel): bez niego „Pakuj zaznaczone” i „Drukuj karty”
 * się nie pokazują (biuro dostałoby 404). Lista wysyłkowa — każdy z podglądem panelu. `tuKolejka` = adres tej kolejki
 * z filtrami: „Pakuj zaznaczone” dokłada do niego `pakuj=…` i otwiera okno nad panelem. `idsKuriera` =
 * id do spakowania kurierów, którzy mają zamówienia poza tą stroną (klucz sekcji `data-kurier`).
 */
export function Zaznaczanie({ children, naStronie, canPack, tuKolejka, idsKuriera = BEZ_LIST }: { children: ReactNode; naStronie: number; canPack: boolean; tuKolejka: string; idsKuriera?: Record<string, string[]> }) {
  const box = useRef<HTMLDivElement>(null)
  const [ids, setIds] = useState<string[]>([])
  const [naStronieZaznaczone, setNaStronieZaznaczone] = useState(0)
  const [sekcje, setSekcje] = useState<Record<string, { naStronie: number; zaznaczone: number; wszystkich: number }>>({})
  const [rozbicie, setRozbicie] = useState<string | null>(null)
  const [caly, setCaly] = useState<ReadonlySet<string>>(new Set())
  const calyRef = useRef(caly)
  // stanowiska druku firmy; brak = panel jak dotąd (same przyciski PDF)
  const stanowiska = useStanowiskaDruku()
  const pdf = stanowiska?.length ? 'Pobierz PDF: ' : 'Drukuj '

  const read = useCallback(() => {
    const el = box.current
    if (!el) return
    const all = polaSekcji(el)
    for (const i of all) i.closest('tr')?.classList.toggle('sel', i.checked)
    const opis: { klucz: string; naStronie: string[]; zaznaczone: Set<string> }[] = []
    const liczniki: Record<string, { naStronie: number; zaznaczone: number; wszystkich: number }> = {}
    const etykiety: Record<string, string> = {}
    const wSekcjach = new Set<HTMLInputElement>()
    for (const s of el.querySelectorAll<HTMLElement>('[data-kurier]')) {
      const pola = polaSekcji(s)
      for (const p of pola) wSekcjach.add(p)
      const k = s.dataset.kurier ?? ''
      opis.push({ klucz: k, naStronie: pola.map((p) => p.value), zaznaczone: new Set(pola.filter((p) => p.checked).map((p) => p.value)) })
      liczniki[k] = { naStronie: pola.length, zaznaczone: pola.filter((p) => p.checked).length, wszystkich: 0 }
      if (s.dataset.etykieta) etykiety[k] = s.dataset.etykieta
    }
    // pola poza sekcjami kurierów (nie powinno ich być): liczą się jak dotąd
    const reszta = all.filter((p) => !wSekcjach.has(p))
    if (reszta.length) opis.push({ klucz: '', naStronie: reszta.map((p) => p.value), zaznaczone: new Set(reszta.filter((p) => p.checked).map((p) => p.value)) })
    const poKurierach = zaznaczonePoKurierach(opis, calyRef.current, idsKuriera)
    for (const s of poKurierach) if (liczniki[s.klucz]) liczniki[s.klucz]!.wszystkich = s.ids.length
    setIds(poKurierach.flatMap((s) => s.ids))
    setRozbicie(rozbicieZaznaczenia(poKurierach.map((s) => ({ klucz: s.klucz, ile: s.ids.length })), etykiety))
    setNaStronieZaznaczone(all.filter((i) => i.checked).length)
    setSekcje(liczniki)
  }, [idsKuriera])

  const ustawCaly = useCallback(
    (n: ReadonlySet<string>) => {
      calyRef.current = n
      setCaly(n)
      read()
    },
    [read],
  )

  useEffect(() => {
    const el = box.current
    if (!el) return
    el.addEventListener('change', read)
    read()
    return () => el.removeEventListener('change', read)
  }, [read])

  const setAll = (on: boolean) => {
    for (const i of box.current ? polaSekcji(box.current) : []) i.checked = on
    if (!on) ustawCaly(new Set())
    else read()
  }

  const api = useMemo<ZaznaczanieApi>(() => {
    const sekcja = (klucz: string) => box.current?.querySelector<HTMLElement>(`[data-kurier="${CSS.escape(klucz)}"]`) ?? null
    const pola = (klucz: string, on: boolean) => {
      const s = sekcja(klucz)
      if (s) for (const p of polaSekcji(s)) p.checked = on
    }
    const bez = (klucz: string) => new Set([...calyRef.current].filter((k) => k !== klucz))
    return {
      stan: (klucz) => ({ naStronie: sekcje[klucz]?.naStronie ?? 0, zaznaczoneNaStronie: sekcje[klucz]?.zaznaczone ?? 0, zaznaczone: sekcje[klucz]?.wszystkich ?? 0, caly: caly.has(klucz) }),
      zaznaczStrone: (klucz, on) => {
        pola(klucz, on)
        if (!on && calyRef.current.has(klucz)) ustawCaly(bez(klucz))
        else read()
      },
      zaznaczKuriera: (klucz, on) => {
        pola(klucz, on)
        ustawCaly(on ? new Set([...calyRef.current, klucz]) : bez(klucz))
      },
    }
  }, [sekcje, caly, read, ustawCaly])

  const z = encodeURIComponent(ids.join(','))
  const allOn = naStronie > 0 && naStronieZaznaczone === naStronie
  const spozaStrony = ids.length - naStronieZaznaczone
  const zaDuzo = (limit: number, co: string) => `${co}: najwyżej ${limit} zamówień naraz (zaznaczono ${ids.length})`
  return (
    <Ctx.Provider value={api}>
      <div ref={box}>
        <div className="sel-all">
          <label className="sel-all-l">
            <input
              type="checkbox"
              checked={allOn}
              ref={(i) => {
                if (i) i.indeterminate = naStronieZaznaczone > 0 && !allOn
              }}
              onChange={(e) => setAll(e.target.checked)}
            />
            Zaznacz wszystkie na stronie ({naStronie})
          </label>
        </div>
        {ids.length > 0 && (
          <div className="bulk" role="region" aria-label="Praca na zaznaczonych">
            <b>
              Zaznaczono {ids.length}
              {spozaStrony > 0 && <span className="muted small"> (w tym {spozaStrony} z innych stron)</span>}
              {rozbicie && <span className="muted small">: {rozbicie}</span>}
            </b>
            {canPack && (
              <>
                {ids.length <= MAX_ZAMOWIEN ? (
                  <PrzyciskLink wariant="glowny" href={`${tuKolejka}${tuKolejka.includes('?') ? '&' : '?'}pakuj=${z}`} scroll={false} prefetch={false}>
                    Pakuj zaznaczone
                  </PrzyciskLink>
                ) : (
                  <Przycisk wariant="glowny" powodWylaczenia={zaDuzo(MAX_ZAMOWIEN, 'Pakowanie')}>
                    Pakuj zaznaczone
                  </Przycisk>
                )}
                {/* zbiorcza lista zbierania po lokalizacji, z koszykami */}
                {ids.length <= LIMIT_ZBIERANIA ? (
                  <PrzyciskLink href={`/pakowanie/zbieranie?z=${z}`} prefetch={false}>
                    Lista zbierania
                  </PrzyciskLink>
                ) : (
                  <Przycisk powodWylaczenia={zaDuzo(LIMIT_ZBIERANIA, 'Lista zbierania')}>Lista zbierania</Przycisk>
                )}
                {/* POST, nie link: każdy wydruk nadaje nowy numer kart, więc F5 w karcie z PDF-em nie może drukować
                    ponownie */}
                {ids.length <= MAX_ZAMOWIEN ? (
                  <>
                    <DrukujNaStanowisku typ="karta" ids={ids} etykieta="Drukuj karty" stanowiska={stanowiska} />
                    <form className="inline" method="post" action="/api/wydruki/karty" target="_blank">
                      <input type="hidden" name="z" value={ids.join(',')} />
                      <button className="btn" type="submit">
                        {pdf}karty zamówień
                      </button>
                    </form>
                  </>
                ) : (
                  <Przycisk powodWylaczenia={zaDuzo(MAX_ZAMOWIEN, 'Karty zamówień')}>{pdf}karty zamówień</Przycisk>
                )}
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
    </Ctx.Provider>
  )
}

/**
 * „Zaznacz wszystkie na tej stronie (N)” i, gdy kurier ma zamówienia na innych stronach, „Zaznacz wszystkie
 * <kurier> ze wszystkich stron (M)” nad listą zamówień kuriera. `wszystkich` = M z serwera (null = kurier w całości na
 * tej stronie).
 */
export function ZaznaczKuriera({ klucz, etykieta, wszystkich }: { klucz: string; etykieta: string; wszystkich: number | null }) {
  const api = useContext(Ctx)
  if (!api) return null
  const s = api.stan(klucz)
  if (s.naStronie === 0) return null
  const strona = s.zaznaczoneNaStronie === s.naStronie
  return (
    <div className="sel-kurier" role="group" aria-label={`Zaznaczanie: ${etykieta}`}>
      <label className="sel-all-l">
        <input
          type="checkbox"
          checked={strona}
          ref={(i) => {
            if (i) i.indeterminate = s.zaznaczoneNaStronie > 0 && !strona
          }}
          onChange={(e) => api.zaznaczStrone(klucz, e.target.checked)}
        />
        Zaznacz wszystkie na tej stronie ({s.naStronie})
      </label>
      {wszystkich !== null && wszystkich > s.naStronie && (
        <label className="sel-all-l">
          {/* zaznaczony, póki zamówienia z innych stron są w zaznaczeniu; odznaczone na tej stronie = stan pośredni */}
          <input
            type="checkbox"
            checked={s.caly}
            ref={(i) => {
              if (i) i.indeterminate = s.caly && !strona
            }}
            onChange={(e) => api.zaznaczKuriera(klucz, e.target.checked)}
          />
          Zaznacz wszystkie {etykieta} ze wszystkich stron ({wszystkich})
        </label>
      )}
    </div>
  )
}

/**
 * „· zaznaczono N” w pasku kuriera (widoczne także w zwiniętej sekcji), z liczbą z innych stron,
 * gdy zaznaczono całego kuriera. Bez zaznaczenia nic się nie pokazuje.
 */
export function ZaznaczoneWKurierze({ klucz }: { klucz: string }) {
  const api = useContext(Ctx)
  if (!api) return null
  const s = api.stan(klucz)
  if (s.zaznaczone === 0) return null
  const spoza = s.zaznaczone - s.zaznaczoneNaStronie
  return (
    <span className="c-zazn">
      {' '}
      · zaznaczono <b>{s.zaznaczone}</b>
      {spoza > 0 && <span className="muted"> (w tym {spoza} z innych stron)</span>}
    </span>
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
