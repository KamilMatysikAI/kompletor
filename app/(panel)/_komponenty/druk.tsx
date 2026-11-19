'use client'
// Druk na stanowisku z panelu: lista stanowisk firmy (GET /api/wydruki/stan, sesja) i przycisk „Drukuj”
// z wyborem stanowiska. Firma bez stanowisk nie widzi nic — zostają dotychczasowe przyciski PDF. Wybór stanowiska
// pamiętany w przeglądarce (localStorage), jedno stanowisko = bez wyboru. Po kliknięciu: „Wysłano na …”, potem wynik
// zlecenia (krótkie odpytywanie GET /api/wydruki/zlecenia/<id>). Ponowny druk karty = nowe kliknięcie = nowy numer.
// stanowisko wybiera się raz (useWybraneStanowisko: ta sama pamięć przeglądarki dla nagłówka, przycisków
// i nadania przesyłki), a serwer kieruje każdy rodzaj wydruku według przypisań stanowiska, także na drukarkę innego
// komputera; komunikat mówi, gdzie wyszło („Wysłano na: Komputer główny, A4”).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '@/app/ui'

export interface DrukarkaStanu {
  rola: string
  nazwa: string
  stan: 'DOSTEPNA' | 'OFFLINE' | 'BLAD'
  komunikat?: string
  zleceniaWKolejce: number | null
}

export interface StanowiskoDruku {
  id: string
  code: string
  name: string
  agentDziala: boolean
  minutOdRaportu: number | null
  wersjaAgenta: string | null
  drukarki: DrukarkaStanu[]
  role: string[]
  routing: Record<string, string>
  /** `stanowisko` = drukarka innego komputera. */
  przypisania: Record<string, { rola: string; stanowisko?: string }>
  uzywane: UzywanaDrukarkaStanu[]
  maProgram: boolean
}

/** drukarka, której stanowisko używa według przypisań (lib/druk/panel.ts `UzywanaDrukarka`). */
export interface UzywanaDrukarkaStanu {
  typy: string[]
  stanowiskoId: string
  stanowisko: string
  rola: string
  wlasna: boolean
  drukarka: DrukarkaStanu | null
  agentDziala: boolean
  minutOdRaportu: number | null
  blad: string | null
}

interface StatusZlecenia {
  id: string
  status: 'PRZYGOTOWANIE' | 'OCZEKUJE' | 'OK' | 'BLAD' | 'WYGASLO'
  stanowisko: string
  /** „Komputer główny, A4” — komputer z drukarką i drukarka. */
  cel?: string
  rola: string
  komunikat: string | null
  zapas: { id: string; status: StatusZlecenia['status']; rola: string; komunikat: string | null } | null
}

/** Stanowiska firmy; `odswiezMs` > 0 = odpytywanie (nagłówek co 30 s). Błąd sieci = ostatni znany stan, bez konsoli. */
export function useStanowiskaDruku(odswiezMs = 0): StanowiskoDruku[] | null {
  const [lista, setLista] = useState<StanowiskoDruku[] | null>(null)
  useEffect(() => {
    let zyje = true
    const pobierz = async () => {
      try {
        const r = await fetch('/api/wydruki/stan', { cache: 'no-store', credentials: 'same-origin' })
        if (!r.ok) return
        const j = (await r.json()) as { stanowiska?: StanowiskoDruku[] }
        if (zyje) setLista(Array.isArray(j.stanowiska) ? j.stanowiska : [])
      } catch {
        // brak sieci — zostaje ostatni stan
      }
    }
    void pobierz()
    const t = odswiezMs > 0 ? setInterval(pobierz, odswiezMs) : undefined
    return () => {
      zyje = false
      if (t) clearInterval(t)
    }
  }, [odswiezMs])
  return lista
}

export const KLUCZ_STANOWISKA = 'kompletor-druk-stanowisko'
const ZDARZENIE_WYBORU = 'kompletor-druk-stanowisko'

/**
 * Opis stanowiska na listach wyboru (akcje masowe). Stanowisko bez własnego programu, które drukuje
 * wyłącznie na drukarkach innych komputerów, nie dostaje dopisku „program druku nie odpowiada”.
 */
export function opisStanowiskaDoWyboru(s: StanowiskoDruku): string {
  const tylkoInne = !!s.uzywane?.length && s.uzywane.every((u) => !u.wlasna)
  return s.agentDziala || tylkoInne ? s.name : `${s.name} (program druku nie odpowiada)`
}

function zapamietane(): string {
  try {
    return localStorage.getItem(KLUCZ_STANOWISKA) ?? ''
  } catch {
    return '' // bez localStorage — pierwsze stanowisko
  }
}

/**
 * stanowisko wybrane na tym urządzeniu (pamięć przeglądarki, klucz jak dotąd). Zmiana w jednym miejscu
 * (nagłówek, przycisk „Drukuj”) od razu przestawia pozostałe na tej stronie i w innych kartach przeglądarki.
 */
export function useWybraneStanowisko(stanowiska: { id: string }[] | null): [string, (id: string) => void] {
  const [wybrane, setWybrane] = useState('')
  useEffect(() => {
    if (!stanowiska?.length) return
    const ustaw = () => {
      const z = zapamietane()
      setWybrane((w) => (stanowiska.some((s) => s.id === z) ? z : stanowiska.some((s) => s.id === w) ? w : stanowiska[0]!.id))
    }
    ustaw()
    window.addEventListener(ZDARZENIE_WYBORU, ustaw)
    window.addEventListener('storage', ustaw)
    return () => {
      window.removeEventListener(ZDARZENIE_WYBORU, ustaw)
      window.removeEventListener('storage', ustaw)
    }
  }, [stanowiska])
  const wybierz = useCallback((id: string) => {
    setWybrane(id)
    try {
      localStorage.setItem(KLUCZ_STANOWISKA, id)
    } catch {
      // bez localStorage: wybór tylko na tej stronie
    }
    window.dispatchEvent(new Event(ZDARZENIE_WYBORU))
  }, [])
  return [wybrane, wybierz]
}

function losowyKlucz(): string {
  const b = new Uint8Array(18)
  crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const OPIS_STATUSU: Record<StatusZlecenia['status'], string> = {
  PRZYGOTOWANIE: 'przygotowanie pliku',
  OCZEKUJE: 'czeka na program druku',
  OK: 'wydrukowano (przyjęte przez drukarkę)',
  BLAD: 'błąd',
  WYGASLO: 'wygasło — nie wydrukowano',
}

/**
 * Przycisk „Drukuj …” dla zaznaczonych zamówień (`typ` karta/lista) albo etykiety próbnej (`typ` etykieta, jedno id).
 * Nic nie renderuje, gdy firma nie ma stanowisk druku.
 */
export function DrukujNaStanowisku({
  typ,
  ids,
  etykieta,
  stanowiska,
  informacyjne = false,
}: {
  typ: 'karta' | 'lista' | 'etykieta'
  ids: string[]
  etykieta: string
  stanowiska: StanowiskoDruku[] | null
  /** karty z listy zamówień — zamówienia bez karty do zbierania dostają wydruk informacyjny. */
  informacyjne?: boolean
}) {
  const [wybrane, wybierz] = useWybraneStanowisko(stanowiska)
  const [trwa, setTrwa] = useState(false)
  // Wynik idzie do powiadomienia w rogu ekranu, nie obok przycisku: tekst w pasku akcji rozpychał menu.
  const toast = useToast()
  const odpytywanie = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(odpytywanie.current), [])

  const sledz = useCallback((id: string, nazwa: string, proba = 0) => {
    clearTimeout(odpytywanie.current)
    odpytywanie.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/wydruki/zlecenia/${encodeURIComponent(id)}`, { cache: 'no-store' })
        if (!r.ok) return
        const z = ((await r.json()) as { zlecenie: StatusZlecenia }).zlecenie
        const zapas = z.zapas ? ` Zapas na ${z.zapas.rola}: ${OPIS_STATUSU[z.zapas.status]}${z.zapas.komunikat ? ` (${z.zapas.komunikat})` : ''}.` : ''
        if (z.status === 'OK') toast.sukces(`${nazwa}: ${OPIS_STATUSU.OK}.`)
        else if (z.status === 'BLAD' || z.status === 'WYGASLO') (z.zapas?.status === 'OK' ? toast.info : toast.blad)(`${nazwa}: ${OPIS_STATUSU[z.status]}${z.komunikat ? `: ${z.komunikat}` : ''}.${zapas}`)
        const dalej = (z.status === 'OCZEKUJE' || z.status === 'PRZYGOTOWANIE' || (z.zapas && (z.zapas.status === 'OCZEKUJE' || z.zapas.status === 'PRZYGOTOWANIE'))) && proba < 40
        if (dalej) sledz(id, nazwa, proba + 1)
        else if (proba >= 40 && z.status === 'OCZEKUJE') toast.blad(`${nazwa}: zlecenie nadal czeka na program druku. Sprawdź stan drukarek w nagłówku.`)
      } catch {
        // przerwa w sieci — kolejna próba
        if (proba < 40) sledz(id, nazwa, proba + 1)
      }
    }, proba < 5 ? 1500 : 3000)
  }, [toast])

  if (!stanowiska?.length || !ids.length) return null
  const st = stanowiska.find((s) => s.id === wybrane) ?? stanowiska[0]!

  const drukuj = async () => {
    setTrwa(true)
    try {
      const r = await fetch('/api/wydruki/zlecenia', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ typ, z: ids, stanowisko: st.id, klucz: losowyKlucz(), ...(informacyjne ? { informacyjne: true } : {}) }),
      })
      const j = (await r.json().catch(() => ({}))) as { error?: string; zlecenie?: StatusZlecenia; pominiete?: string[]; informacyjne?: string[] }
      if (!r.ok || !j.zlecenie) {
        toast.blad(j.error ?? `Nie udało się zlecić druku (${r.status})`)
        return
      }
      const pom = j.pominiete?.length ? ` Pominięto (bez stanu, wysłane albo anulowane): ${j.pominiete.join(', ')}.` : ''
      const inf = j.informacyjne?.length ? ` Wydruk informacyjny (bez kodu karty): ${j.informacyjne.join(', ')}.` : ''
      const cel = j.zlecenie.cel ?? j.zlecenie.stanowisko
      toast.info(`Wysłano na: ${cel}.${pom}${inf}`)
      sledz(j.zlecenie.id, cel)
    } catch {
      toast.blad('Brak połączenia z serwerem. Spróbuj ponownie.')
    } finally {
      setTrwa(false)
    }
  }

  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      {stanowiska.length > 1 && (
        <select className="input" style={{ width: 'auto', minHeight: 36 }} aria-label="Stanowisko druku" value={st.id} onChange={(e) => wybierz(e.target.value)}>
          {stanowiska.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      <button className="btn primary" type="button" onClick={drukuj} disabled={trwa} title={`Druk na stanowisku ${st.name}`}>
        {trwa ? 'Wysyłanie…' : etykieta}
      </button>
    </span>
  )
}

/**
 * „Drukuj etykietę próbną” w bloku przygotowanej przesyłki: atrapa z napisem „PRÓBA — NIE NADAWAĆ”,
 * bez nadania i bez kodu kreskowego (lib/druk/etykieta.ts). Firma bez stanowisk druku nie widzi przycisku.
 */
export function DrukujEtykieteProbna({ orderId }: { orderId: string }) {
  const stanowiska = useStanowiskaDruku()
  if (!stanowiska?.length) return null
  return (
    <div style={{ marginTop: 10 }}>
      <DrukujNaStanowisku typ="etykieta" ids={[orderId]} etykieta="Drukuj etykietę próbną" stanowiska={stanowiska} />
      <div className="muted small" style={{ marginTop: 4 }}>
        Próbna kartka z parametrami przesyłki i napisem „PRÓBA — NIE NADAWAĆ”. Nic nie jest nadawane u przewoźnika.
      </div>
    </div>
  )
}
