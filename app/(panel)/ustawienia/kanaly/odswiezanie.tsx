'use client'
// Odświeżanie ekranu konta, gdy test połączenia albo pobranie ofert czeka na worker: co 3 s, najwyżej
// 3 minuty, potem informacja zamiast kręcenia się bez końca.
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

export function Odswiezanie({ aktywne }: { aktywne: boolean }) {
  const router = useRouter()
  const [ticks, setTicks] = useState(0)
  useEffect(() => {
    if (!aktywne || ticks >= 60) return
    const t = setTimeout(() => {
      setTicks((n) => n + 1)
      router.refresh()
    }, 3000)
    return () => clearTimeout(t)
  }, [aktywne, ticks, router])
  if (!aktywne) return null
  return (
    <p className="muted small" role="status" aria-live="polite">
      {ticks >= 60 ? 'Wynik jeszcze nie przyszedł. Odśwież stronę za chwilę.' : 'Czekam na wynik, ekran odświeży się sam…'}
    </p>
  )
}
