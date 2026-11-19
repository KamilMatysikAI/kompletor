'use client'
// toasty — wynik akcji (zapisano, błąd) w rogu ekranu, ogłaszany czytnikom ekranu (role=status, a błąd
// role=alert), znika po 5 s (błąd po 8 s), da się zamknąć. Banery zostają dla stanów trwałych.
// Użycie: `const toast = useToast(); toast.sukces('Zapisano zmiany')`, albo `<ToastPoAkcji stan={state} />` przy
// formularzu z useActionState (stan z polami `ok` i `komunikat`/`message`).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export type RodzajToastu = 'sukces' | 'blad' | 'info'

interface Toast {
  id: number
  rodzaj: RodzajToastu
  tresc: ReactNode
}

interface ToastApi {
  pokaz: (rodzaj: RodzajToastu, tresc: ReactNode) => void
  sukces: (tresc: ReactNode) => void
  blad: (tresc: ReactNode) => void
  info: (tresc: ReactNode) => void
}

const Ctx = createContext<ToastApi | null>(null)

const CZAS: Record<RodzajToastu, number> = { sukces: 5000, info: 5000, blad: 8000 }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [lista, setLista] = useState<Toast[]>([])
  const nr = useRef(0)
  const zegary = useRef(new Set<number>())
  // zegary chowające toasty kasujemy przy odmontowaniu providera (bez setState na odmontowanym drzewie)
  useEffect(() => {
    const z = zegary.current
    return () => {
      z.forEach((t) => window.clearTimeout(t))
      z.clear()
    }
  }, [])
  const zamknij = useCallback((id: number) => setLista((l) => l.filter((t) => t.id !== id)), [])
  const pokaz = useCallback(
    (rodzaj: RodzajToastu, tresc: ReactNode) => {
      const id = ++nr.current
      setLista((l) => [...l.slice(-2), { id, rodzaj, tresc }]) // najwyżej 3 naraz
      const zegar = window.setTimeout(() => {
        zegary.current.delete(zegar)
        zamknij(id)
      }, CZAS[rodzaj])
      zegary.current.add(zegar)
    },
    [zamknij],
  )
  const api = useMemo<ToastApi>(() => ({ pokaz, sukces: (t) => pokaz('sukces', t), blad: (t) => pokaz('blad', t), info: (t) => pokaz('info', t) }), [pokaz])
  return (
    <Ctx.Provider value={api}>
      {children}
      {/* dwa regiony, żeby czytnik ogłosił błąd od razu (alert), a sukces grzecznie (status); oba zawsze w DOM */}
      <div className="ui-toasty" aria-live="polite" role="status">
        {lista
          .filter((t) => t.rodzaj !== 'blad')
          .map((t) => (
            <ToastWidok key={t.id} t={t} zamknij={zamknij} />
          ))}
      </div>
      <div className="ui-toasty ui-toasty-bledy" aria-live="assertive" role="alert">
        {lista
          .filter((t) => t.rodzaj === 'blad')
          .map((t) => (
            <ToastWidok key={t.id} t={t} zamknij={zamknij} />
          ))}
      </div>
    </Ctx.Provider>
  )
}

function ToastWidok({ t, zamknij }: { t: Toast; zamknij: (id: number) => void }) {
  return (
    <div className="ui-toast" data-rodzaj={t.rodzaj}>
      <span>{t.tresc}</span>
      <button type="button" className="ui-toast-x" aria-label="Zamknij powiadomienie" onClick={() => zamknij(t.id)}>
        ×
      </button>
    </div>
  )
}

/** Toasty poza `ToastProvider` (np. ekran logowania) nic nie robią, zamiast rzucać błędem. */
const CICHE: ToastApi = { pokaz: () => {}, sukces: () => {}, blad: () => {}, info: () => {} }

export function useToast(): ToastApi {
  return useContext(Ctx) ?? CICHE
}

/**
 * Toast po akcji serwera: pokazuje komunikat z każdego NOWEGO stanu (porównanie referencji obiektu stanu,
 * useActionState zwraca nowy obiekt po każdym wywołaniu). `ok: false` = błąd.
 */
export function ToastPoAkcji({
  stan,
  sukces,
  bledy = true,
}: {
  stan: { ok?: boolean; komunikat?: string | null; message?: string | null; error?: string | null } | null | undefined
  sukces?: string
  /** `false`, gdy formularz pokazuje błąd przy polach (bez dublowania toastem) */
  bledy?: boolean
}) {
  const toast = useToast()
  const poprzedni = useRef(stan)
  useEffect(() => {
    if (!stan || stan === poprzedni.current) return
    poprzedni.current = stan
    const tekst = stan.komunikat ?? stan.message ?? stan.error
    if (stan.ok === false) {
      if (bledy) toast.blad(tekst ?? 'Nie udało się zapisać.')
    } else if (stan.ok) toast.sukces(tekst ?? sukces ?? 'Zapisano zmiany.')
  }, [stan, sukces, bledy, toast])
  return null
}
