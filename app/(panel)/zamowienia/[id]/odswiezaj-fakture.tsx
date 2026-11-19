'use client'
// Faktura „W kolejce” (po spakowaniu albo po „Ponów fakturę”): wystawia ją worker, więc karta sama pyta serwer
// o nowy stan, aż faktura powstanie albo wróci błąd. Bez tego wynik było widać dopiero po ręcznym odświeżeniu strony.
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

const CO_MS = 5_000
const NAJDLUZEJ_MS = 5 * 60_000

export function OdswiezajFakture() {
  const router = useRouter()
  useEffect(() => {
    const start = Date.now()
    const t = setInterval(() => {
      if (Date.now() - start > NAJDLUZEJ_MS) return clearInterval(t)
      if (document.visibilityState === 'visible') router.refresh()
    }, CO_MS)
    return () => clearInterval(t)
  }, [router])
  return null
}
