// Eksport CSV listy zamówień: czyste funkcje pola i daty (testy jednostkowe), trasa w
// app/api/zamowienia/eksport/route.ts. Bez danych osobowych klientów.
import { toWarsaw } from '@/lib/rdzen/kalendarz'

export const EKSPORT_MAKS = 5000
/**
 * Najwięcej zaznaczonych zamówień w `?z=`: z ekranu przychodzi najwyżej strona (250) albo wynik szukania
 * klienta (200), a 5 000 identyfikatorów w adresie (~130 KB) i tak odrzuciłby serwer (nagłówki > 16 KB, ok. 600 id).
 */
export const EKSPORT_ZAZNACZONE_MAKS = 250

/** Pole CSV: w cudzysłowie, gdy ma separator, cudzysłów albo nową linię; początek formuły arkusza neutralizowany. */
export function poleCsv(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = `'${s}`
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** „2026-11-06 14:05” w czasie polskim. */
export function dataCsv(t: Date): string {
  const w = toWarsaw(t)
  const min = Math.floor(w.msOfDay / 60_000)
  return `${w.day} ${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}
