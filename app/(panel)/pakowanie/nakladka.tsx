'use client'
// Pakowanie z kolejki w oknie nad panelem (wymaganie z 23.10: „w nowym okienku z X jak w BL”): ten sam
// komponent co samodzielne /stanowisko, adres `/pakowanie?pakuj=<id,id…>`, więc F5 wraca do sesji, a „wstecz” zamyka.
// X (i Esc z widoku listy albo podsumowania) wraca do kolejki bez przeładowania panelu i pobiera jej świeży stan.
import { useRouter } from 'next/navigation'
import { useCallback, useEffect } from 'react'
import { Stanowisko } from '@/app/(stanowisko)/stanowisko/stanowisko'
import '@/app/(stanowisko)/stanowisko.css'
import type { PozycjaSesji } from '@/lib/stanowisko/sesja'
import type { UstawieniaStanowiska } from '@/lib/stanowisko/ustawienia'

export function NakladkaPakowania({ sesjaStart, ustawienia, kto, firma, powrot }: { sesjaStart: PozycjaSesji[]; ustawienia: UstawieniaStanowiska; kto: string; firma: string; powrot: string }) {
  const router = useRouter()
  const zamknij = useCallback(() => {
    router.replace(powrot, { scroll: false })
    router.refresh()
  }, [router, powrot])
  // panel pod spodem się nie przewija, gdy okno jest otwarte
  useEffect(() => {
    const przed = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = przed
    }
  }, [])
  return <Stanowisko sesjaStart={sesjaStart} ustawienia={ustawienia} kto={kto} firma={firma} onZamknijNakladke={zamknij} />
}
