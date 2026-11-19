'use client'
// Raport w toku odświeża się sam co 5 s, najwyżej 10 minut (potem zostaje odświeżenie strony), żeby nie pytać serwera bez końca.
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

const CO_MS = 5_000
const MAKS_MS = 10 * 60_000

export function OdswiezajWToku() {
  const router = useRouter()
  useEffect(() => {
    const start = Date.now()
    const t = setInterval(() => {
      if (Date.now() - start > MAKS_MS) clearInterval(t)
      else router.refresh()
    }, CO_MS)
    return () => clearInterval(t)
  }, [router])
  return null
}
