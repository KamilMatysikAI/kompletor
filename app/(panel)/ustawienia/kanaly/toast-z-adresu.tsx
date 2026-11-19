'use client'
// Wynik akcji serwera, która kończy się przekierowaniem (`?zapisano=…`, `?blad=…`), jako toast (docs/ui.md:
// wynik akcji = toast, nie baner). Po pokazaniu parametry znikają z adresu, więc odświeżenie nie powtarza komunikatu.
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useToast } from '@/app/ui'

export function ToastZAdresu({ sukces, blad, zostaw }: { sukces?: string | null; blad?: string | null; /** parametry, które mają zostać w adresie (np. szukaj) */ zostaw?: Record<string, string> }) {
  const toast = useToast()
  const router = useRouter()
  const sciezka = usePathname()
  const pokazane = useRef(false)
  useEffect(() => {
    if (pokazane.current || (!sukces && !blad)) return
    pokazane.current = true
    if (blad) toast.blad(blad)
    else if (sukces) toast.sukces(sukces)
    const q = new URLSearchParams(zostaw ?? {}).toString()
    router.replace(q ? `${sciezka}?${q}` : sciezka, { scroll: false })
  }, [sukces, blad, toast, router, sciezka, zostaw])
  return null
}
