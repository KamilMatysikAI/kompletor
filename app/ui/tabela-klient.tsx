'use client'
// interaktywne części `Tabela` (app/ui/tabela.tsx): zaznaczanie wierszy, pasek akcji masowych, wybór
// kolumn (zapamiętany w przeglądarce per tabela), klikalne wiersze. Tabela sama jest komponentem serwerowym,
// te wyspy dostają tylko identyfikatory, nigdy funkcje renderujące.
import { useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, useId, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'

interface Zaznaczenie {
  ids: readonly string[]
  wybrane: ReadonlySet<string>
  przelacz: (id: string, on: boolean) => void
  ustaw: (ids: readonly string[]) => void
}

const Ctx = createContext<Zaznaczenie | null>(null)

export function useZaznaczenie(): Zaznaczenie {
  const c = useContext(Ctx)
  if (!c) throw new Error('useZaznaczenie poza <ZaznaczanieTabeli>')
  return c
}

export function ZaznaczanieTabeli({ ids, children }: { ids: readonly string[]; children: ReactNode }) {
  const [wybrane, setWybrane] = useState<ReadonlySet<string>>(new Set())
  // wiersze znikające z listy (inna strona, filtr) nie zostają zaznaczone
  const klucz = ids.join('|')
  useEffect(() => setWybrane((w) => new Set([...w].filter((id) => ids.includes(id)))), [klucz]) // eslint-disable-line react-hooks/exhaustive-deps
  const api = useMemo<Zaznaczenie>(
    () => ({
      ids,
      wybrane,
      przelacz: (id, on) =>
        setWybrane((w) => {
          const n = new Set(w)
          if (on) n.add(id)
          else n.delete(id)
          return n
        }),
      ustaw: (lista) => setWybrane(new Set(lista)),
    }),
    [ids, wybrane],
  )
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

export function PoleZaznaczenia({ id, etykieta }: { id: string; etykieta: string }) {
  const z = useZaznaczenie()
  return (
    <label className="ui-ck">
      <input type="checkbox" checked={z.wybrane.has(id)} onChange={(e) => z.przelacz(id, e.target.checked)} />
      <span className="sr">{etykieta}</span>
    </label>
  )
}

export function ZaznaczWszystkie() {
  const z = useZaznaczenie()
  const wszystkie = z.ids.length > 0 && z.ids.every((id) => z.wybrane.has(id))
  const czesc = !wszystkie && z.wybrane.size > 0
  return (
    <label className="ui-ck">
      <input
        type="checkbox"
        checked={wszystkie}
        ref={(el) => {
          if (el) el.indeterminate = czesc
        }}
        onChange={(e) => z.ustaw(e.target.checked ? z.ids : [])}
      />
      <span className="sr">Zaznacz wszystkie na tej stronie</span>
    </label>
  )
}

/**
 * Pasek nad tabelą: liczba, akcje (formularze z `<ZaznaczoneUkryte />`), „Odznacz”. Domyślnie widoczny po zaznaczeniu;
 * `stale`: wiersz stoi zawsze z narzędziami tabeli po prawej; ciemny pasek z akcjami pojawia się
 * dopiero po zaznaczeniu (bez zaznaczenia jasny wiersz z podpowiedzią, style w zamowienia/_lista/lista.css).
 */
export function PasekAkcjiMasowych({ children, stale = false, narzedzia }: { children: ReactNode; stale?: boolean; narzedzia?: ReactNode }) {
  const z = useZaznaczenie()
  const puste = z.wybrane.size === 0
  if (puste && !stale) return null
  return (
    <div className="bulk ui-akcje-masowe" data-stale={stale ? 'tak' : undefined} data-puste={puste ? 'tak' : undefined} role="region" aria-label={stale && puste ? 'Narzędzia listy' : 'Akcje na zaznaczonych'}>
      <b role="status">Zaznaczone: {z.wybrane.size}</b>
      {stale && puste && <span className="ui-am-podpowiedz">Zaznacz zamówienia, a pojawią się akcje: status, przesyłki, etykiety, wydruki.</span>}
      <div className="ui-am-akcje">
        {children}
        {!puste && (
          <button type="button" className="btn ghost small" onClick={() => z.ustaw([])}>
            Odznacz
          </button>
        )}
      </div>
      {narzedzia && <div className="ui-am-narzedzia">{narzedzia}</div>}
    </div>
  )
}

/** Ukryte pola z zaznaczonymi identyfikatorami: wstaw do formularza akcji masowej. */
export function ZaznaczoneUkryte({ nazwa = 'zaznaczone' }: { nazwa?: string }) {
  const z = useZaznaczenie()
  return (
    <>
      {[...z.wybrane].map((id) => (
        <input key={id} type="hidden" name={nazwa} value={id} />
      ))}
    </>
  )
}

/**
 * Wartość w cudzysłowie selektora atrybutu. Zawsze ta sama funkcja na serwerze i w przeglądarce (przegląd
 * CSS.escape w przeglądarce dawał inny tekst niż serwer dla kluczy od cyfry, czyli ostrzeżenie hydratacji).
 */
const esc = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)

const KLUCZ_KOLUMN = (tabela: string) => `kompletor-kolumny:${tabela}`

/**
 * Wybór widocznych kolumn; ukrycie przez wygenerowany styl (tabela renderuje się na serwerze bez zmian).
 * z `osoba` wybór zapisuje się na koncie (akcja serwera) i przychodzi z serwera przy następnym wejściu, na każdym
 * komputerze; bez `osoba` jak dotąd w przeglądarce.
 */
export function WyborKolumn({
  tabela,
  kolumny,
  osoba,
  ikona = false,
}: {
  tabela: string
  kolumny: { klucz: string; etykieta: string; ukrytaDomyslnie?: boolean }[]
  osoba?: { ukryte: string[] | null; zapisz: (tabela: string, ukryte: string[]) => Promise<void> }
  /** przycisk jako ikona z podpowiedzią (pasek akcji listy zamówień) */
  ikona?: boolean
}) {
  const domyslne = kolumny.filter((k) => k.ukrytaDomyslnie).map((k) => k.klucz)
  const [ukryte, setUkryte] = useState<string[]>(osoba?.ukryte ?? domyslne)
  useEffect(() => {
    if (osoba) return
    try {
      const v = localStorage.getItem(KLUCZ_KOLUMN(tabela))
      if (v) setUkryte((JSON.parse(v) as unknown[]).filter((x): x is string => typeof x === 'string'))
    } catch {
      // bez localStorage albo uszkodzony wpis: zostają domyślne
    }
  }, [tabela]) // eslint-disable-line react-hooks/exhaustive-deps
  const przelacz = (k: string, widoczna: boolean) => {
    const n = widoczna ? ukryte.filter((x) => x !== k) : [...new Set([...ukryte, k])]
    setUkryte(n)
    if (osoba) {
      void osoba.zapisz(tabela, n).catch(() => {}) // zapis w tle; nieudany = wybór zostaje do odświeżenia strony
      return
    }
    try {
      localStorage.setItem(KLUCZ_KOLUMN(tabela), JSON.stringify(n))
    } catch {
      // jw.
    }
  }
  // `!important`, bo widok kart na telefonie (`.tbl.cards td { display: grid }`, panel.css) ma wyższą
  // specyficzność i ukryta kolumna wracała na 390 px
  const css = ukryte.map((k) => `[data-tabela="${esc(tabela)}"] [data-kol="${esc(k)}"]{display:none!important}`).join('')
  return (
    <details className="ui-kolumny">
      {ikona ? (
        <summary className="btn small ui-ikona-btn" title="Kolumny: wybierz, co widać w tabeli">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <path d="M6 2.5v11M10.5 2.5v11" />
          </svg>
          <span className="sr">Kolumny</span>
        </summary>
      ) : (
        <summary className="btn small">Kolumny</summary>
      )}
      {css && <style>{css}</style>}
      <div className="ui-kolumny-lista" role="group" aria-label="Widoczne kolumny">
        {kolumny.map((k) => (
          <label key={k.klucz}>
            <input type="checkbox" checked={!ukryte.includes(k.klucz)} onChange={(e) => przelacz(k.klucz, e.target.checked)} /> {k.etykieta}
          </label>
        ))}
      </div>
    </details>
  )
}

function cel(e: { target: EventTarget | null }): HTMLElement | null {
  const el = e.target as HTMLElement | null
  if (!el || el.closest('a, button, input, select, textarea, label, summary, .z-ck, .ui-ck')) return null
  return el.closest<HTMLElement>('[data-href]')
}

/** Cały wiersz z `data-href` klikalny (Ctrl/⌘ = nowa karta, Enter z klawiatury); linki i pola w wierszu działają. */
export function KlikalneWiersze({ children, className }: { children: ReactNode; className?: string }) {
  const router = useRouter()
  const onClick = (e: MouseEvent) => {
    const row = cel(e)
    if (!row) return
    if (window.getSelection()?.toString()) return // zaznaczanie tekstu nie otwiera
    const href = row.dataset.href!
    if (e.ctrlKey || e.metaKey) window.open(href, '_blank', 'noopener')
    else router.push(href)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return
    const row = cel(e)
    if (row) router.push(row.dataset.href!)
  }
  return (
    <div className={className} onClick={onClick} onKeyDown={onKey}>
      {children}
    </div>
  )
}

/**
 * narzędzia nad tabelą (eksport, „Kolumny”) w menu „Więcej” na telefonie (≤ 760 px), żeby nagłówek listy
 * nie zabierał pierwszego ekranu. Na szerokim ekranie przycisk jest ukryty, a zawartość stoi w pasku jak dotąd.
 */
export function MenuWiecej({ children }: { children: ReactNode }) {
  const [otwarte, setOtwarte] = useState(false)
  const idTresci = `${useId()}-wiecej`
  return (
    <div className="ui-wiecej">
      <button type="button" className="btn small ui-wiecej-przelacz" aria-expanded={otwarte} aria-controls={idTresci} onClick={() => setOtwarte((o) => !o)}>
        Więcej
      </button>
      <div className="ui-wiecej-tresc" id={idTresci} data-otwarte={otwarte ? 'tak' : 'nie'}>
        {children}
      </div>
    </div>
  )
}
