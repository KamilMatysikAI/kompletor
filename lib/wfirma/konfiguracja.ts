// Ustawienia faktur firmy: `Organization.settings.faktury`, czytane z surowego JSON jak `cien.wzOptional`.
// Identyfikatory są danymi konta wFirmy (preset firmy, seed/presety/<nazwa>.json), nie stałymi w kodzie. Bez sekretów.
import type { Prisma } from '@prisma/client'
import { sufitRabatuProc } from '../rdzen/ceny'
import { DOMYSLNE_PLATNOSCI, type FormaPlatnosci, type RegulaPlatnosci } from './platnosci'

export interface KonfiguracjaFaktur {
  /** `series.id` w wFirmie; null = nieustawione, treść faktury idzie bez serii (CLI to wypisuje). */
  seriaId: string | null
  /** Stawka („23”, „8”, „5”, „0”, „zw”) → `vat_code.id` z `vat_codes/find` konta firmy. */
  kodyVat: Record<string, number>
  wysylka: { nazwa: string; stawkaVat: string }
  platnosci: RegulaPlatnosci[]
  /** sufit rabatu na całe zamówienie, % wartości pozycji (`rabatMaksProcent`, domyślnie 50). */
  rabatMaksProcent?: number
}

/** Ustawienia w `Organization.settings.faktury` (wszystko opcjonalne). */
export interface UstawieniaFaktur {
  seriaId?: string
  kodyVat?: Record<string, number>
  wysylka?: { nazwa?: string; stawkaVat?: string }
  platnosci?: RegulaPlatnosci[]
  /** sufit rabatu na całe zamówienie, % wartości pozycji (0–100, domyślnie 50). */
  rabatMaksProcent?: number
}

const FORMY: FormaPlatnosci[] = ['cash', 'transfer', 'compensation', 'cod', 'payment_card']
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const tekst = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function parseKonfiguracjaFaktur(settings: Prisma.JsonValue | null | undefined): KonfiguracjaFaktur {
  const f = obj(obj(settings)['faktury'])
  const kodyVat: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj(f['kodyVat']))) if (typeof v === 'number' && Number.isInteger(v) && v > 0) kodyVat[k] = v
  const w = obj(f['wysylka'])
  const reguly: RegulaPlatnosci[] = []
  for (const r of Array.isArray(f['platnosci']) ? (f['platnosci'] as unknown[]).map(obj) : []) {
    const zawiera = tekst(r['zawiera'])
    if (zawiera && FORMY.includes(r['forma'] as FormaPlatnosci)) reguly.push({ zawiera, forma: r['forma'] as FormaPlatnosci, ...(r['dokladnie'] === true ? { dokladnie: true as const } : {}) })
  }
  return {
    seriaId: tekst(f['seriaId']),
    kodyVat,
    wysylka: { nazwa: tekst(w['nazwa']) ?? 'Wysyłka', stawkaVat: tekst(w['stawkaVat']) ?? '23' },
    // reguły firmy przed domyślnymi: firma może dopisać metodę (np. Empik) albo zmienić formę po decyzji księgowości
    platnosci: [...reguly, ...DOMYSLNE_PLATNOSCI],
    rabatMaksProcent: sufitRabatuProc(f['rabatMaksProcent']), // ta sama reguła co rabatMaksProcent (lib/dokumenty/ustawienia.ts)
  }
}
