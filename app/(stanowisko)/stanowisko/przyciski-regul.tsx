'use client'
// przyciski automatycznych akcji firmy po „Spakowane” na stanowisku (np. „Paczka mała” = przesyłka z gabarytem).
// Przy wyłączonym nadawaniu przycisk widoczny, nieaktywny, z powodem. Klucz kliknięcia losowany raz na przycisk.
import { useEffect, useState, useTransition } from 'react'
import type { PrzyciskZamowienia } from '@/lib/automaty/silnik'
import { kliknijNaStanowisku, przyciskiStanowiska } from './akcje-automaty'

const klucz = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')

export function PrzyciskiRegulStanowiska({ orderId, onStart }: { orderId: string; onStart?: () => void }) {
  const [lista, setLista] = useState<(PrzyciskZamowienia & { klucz: string })[]>([])
  const [wynik, setWynik] = useState<{ ok: boolean; tekst: string } | null>(null)
  const [trwa, start] = useTransition()
  useEffect(() => {
    let zyje = true
    przyciskiStanowiska(orderId)
      .then((l) => zyje && setLista(l.map((p) => ({ ...p, klucz: klucz() }))))
      .catch(() => {})
    return () => {
      zyje = false
    }
  }, [orderId])
  if (!lista.length) return null
  return (
    <div className="st-przyciski-regul" aria-label="Przyciski automatycznych akcji">
      {lista.map((p) => (
        <button
          key={p.regulaId}
          type="button"
          className={`btn st-btn-duzy${p.powod ? ' is-disabled' : ''}`}
          aria-disabled={p.powod ? 'true' : undefined}
          title={p.powod ?? undefined}
          disabled={trwa}
          onClick={() => {
            if (p.powod) return setWynik({ ok: false, tekst: p.powod })
            onStart?.()
            start(async () => {
              const w = await kliknijNaStanowisku(orderId, p.regulaId, p.klucz)
              setWynik(w.blad ? { ok: false, tekst: w.blad } : { ok: true, tekst: `${p.etykieta}: zrobione.` })
            })
          }}
        >
          {p.etykieta}
        </button>
      ))}
      {wynik && (
        <p role="status" className={wynik.ok ? 'st-muted' : 'st-blad'}>
          {wynik.tekst}
        </p>
      )}
    </div>
  )
}
