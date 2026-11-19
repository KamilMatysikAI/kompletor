'use server'
// Produkty → „Synchronizuj stany” (19.11.2026): zlecenie pełnego odczytu stanów z wFirmy na żądanie. Odczyt wykonuje
// proces w tle w najbliższym przebiegu kolejki wFirmy (do ok. 2 minut); zlecenie jest idempotentne.
import { redirect } from 'next/navigation'
import { requirePermission } from '@/lib/panel/kontekst'
import { requestFullRead } from '@/lib/rdzen/kolejka-wfirmy'

export async function synchronizujStany(): Promise<void> {
  const ctx = await requirePermission('produkty.dodawanie')
  let stan = 'zlecone'
  try {
    await requestFullRead(ctx.db)
  } catch (e) {
    console.error(`[synchronizuj-stany] zlecenie: ${e instanceof Error ? e.name : 'błąd'}`)
    stan = 'blad'
  }
  redirect(`/produkty?${new URLSearchParams({ stany: stan })}`)
}
