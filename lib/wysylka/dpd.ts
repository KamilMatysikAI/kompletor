// Parametry przesyłki DPD bezpośrednio (DPDServices) w trybie „przygotuj, nie wysyłaj”. Czyste funkcje, bez
// bazy i sieci: kurier albo punkt DPD Pickup (także salon Empik), wymiary i waga z zakresami API, pobranie z limitem.
// Wynik nie ma danych odbiorcy. Braki są problemem na liście, nigdy cichą wartością: nieznana kwota pobrania to nie 0.
// Salon Empik: specyfikacja DPD nie wspomina Empiku; `DPD_PICKUP` z kodem salonu, potwierdzone nadaniem 20.11.2026 (docs/integracje/dpd.md).
// BL nadawał 7 salonów (08–12.11.2026) modułem DPD z konta „DPD Salony Empik”, punkt = kod salonu `PL49xxx`.
import type { PreparedParcel, ShipmentInput, ShipmentProblem } from '../adaptery/kontrakt'
import { kwotaPobrania, LIMIT_WAGI_DPD_PICKUP_G, ustawieniaPrzesylki, waga, WBUDOWANE_USTAWIENIA, type UstawieniaPrzesylki } from './przesylka'

/** Kod wewnętrzny (nie kod usługi DPD): kurier do drzwi, bez usługi `DPD_PICKUP`. */
export const DPD_KURIER = 'DPD_CLASSIC'
/** Usługa DPD `DPD_PICKUP` z atrybutem `PUDO` (kod punktu albo salonu Empik). */
export const DPD_PICKUP = 'DPD_PICKUP'

/** Limit wagi kuriera z umowy; schemat API pozwala do 700 kg w kraju [NIEPEWNE: domyślnie 31,5 kg]. */
export const LIMIT_WAGI_KURIERA_DPD_KG = 31.5
export const LIMIT_WAGI_KURIERA_DPD_SCHEMAT_KG = 700
/** Pobranie: limit Base Courier dla DPD [NIEPEWNE dla umowy bezpośredniej]. */
export const LIMIT_POBRANIA_DPD = 15_000
/** Zakresy pól paczki w schemacie DPDServices (`Parcel`). */
export const BOK_DPD_CM = { min: 1, max: 300 } as const
export const WAGA_MIN_DPD_G = 10

export interface UstawieniaDpd extends UstawieniaPrzesylki {
  limitWagiKurieraKg: number
  codLimit: number
}

const blad = (kod: string, tekst: string): ShipmentProblem => ({ kod, poziom: 'BLAD', tekst })
const ostrzezenie = (kod: string, tekst: string): ShipmentProblem => ({ kod, poziom: 'OSTRZEZENIE', tekst })

/** Ustawienia z konfiguracji adaptera albo reguły przewoźnika: wymiary i waga jak Base Courier, plus limity DPD. */
export function ustawieniaDpd(config: Readonly<Record<string, unknown>>): UstawieniaDpd {
  const u = ustawieniaPrzesylki(config)
  const problemy = [...u.problemy]
  const liczba = (key: string, max: number, domyslna: number): number => {
    const v = config[key]
    if (v === undefined || v === null || v === '') return domyslna
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
    if (Number.isFinite(n) && n > 0 && n <= max) return n
    problemy.push(blad('ustawienie', `Zła wartość ustawienia ${key}: popraw konfigurację przewoźnika.`))
    return domyslna
  }
  const limitWagiKurieraKg = liczba('limitWagiKuriera', LIMIT_WAGI_KURIERA_DPD_SCHEMAT_KG, LIMIT_WAGI_KURIERA_DPD_KG)
  const codLimit = liczba('codLimit', 1_000_000, LIMIT_POBRANIA_DPD)
  return { ...u, limitWagiKurieraKg, codLimit, problemy }
}

function wymiary(u: UstawieniaPrzesylki): { sides: readonly [number, number, number]; problemy: ShipmentProblem[] } {
  const problemy: ShipmentProblem[] = []
  let sides: readonly [number, number, number]
  if (u.sideXCm !== null && u.sideYCm !== null && u.sideZCm !== null) sides = [u.sideXCm, u.sideYCm, u.sideZCm]
  else {
    const w = WBUDOWANE_USTAWIENIA
    sides = [w.sideXCm, w.sideYCm, w.sideZCm]
    problemy.push(ostrzezenie('wymiary_domyslne', `Wymiary robocze ${w.sideXCm}×${w.sideYCm}×${w.sideZCm} cm: firma nie ustawiła domyślnych wymiarów DPD.`))
  }
  if (sides.some((s) => s < BOK_DPD_CM.min || s > BOK_DPD_CM.max)) problemy.push(blad('wymiary_zakres', `Wymiary ${sides.join('×')} cm poza zakresem DPD: każdy bok od ${BOK_DPD_CM.min} do ${BOK_DPD_CM.max} cm.`))
  return { sides, problemy }
}

/** Parametry przesyłki DPD z danych zamówienia. Bez efektów ubocznych; `problems` z poziomem BLAD = nie do nadania. */
export function wyliczPrzesylkeDpd(input: ShipmentInput, u: UstawieniaDpd): PreparedParcel {
  const problems: ShipmentProblem[] = [...u.problemy]
  const obslugiwany = input.carrier === 'DPD' || input.carrier === 'DPD_EMPIK'
  if (!obslugiwany) problems.push(blad('przewoznik', 'Moduł DPD obsługuje tylko przewoźnika DPD i dostawę do salonu Empik.'))
  const pickupPoint = input.pickupPoint?.trim() || null
  const empik = input.carrier === 'DPD_EMPIK'
  const pickup = empik || (input.carrier === 'DPD' && pickupPoint !== null)
  // ostrzeżenie `empik_niepotwierdzone` zdjęte (salony idą z Kompletora od 20.11.2026, FID po przewoźniku
  // `DPD_EMPIK` w zlecenie-dpd.ts), więc salon nie wymaga już osobnego potwierdzenia przy nadaniu
  if (empik && !pickupPoint) problems.push(blad('punkt', 'Brak kodu salonu Empik w danych zamówienia.'))
  const wym = wymiary(u)
  problems.push(...wym.problemy)
  const w = waga(input, u)
  problems.push(...w.problemy)
  if (w.gramy < WAGA_MIN_DPD_G) problems.push(blad('waga_zakres', `Paczka waży ${w.gramy / 1000} kg, DPD przyjmuje od ${WAGA_MIN_DPD_G / 1000} kg.`))
  const limit = pickup ? LIMIT_WAGI_DPD_PICKUP_G : Math.round(u.limitWagiKurieraKg * 1000)
  if (w.gramy > limit) problems.push(blad('waga_limit', `Paczka waży ${w.gramy / 1000} kg, limit to ${limit / 1000} kg.`))
  if (pickup && (input.wielePaczek || input.codAmountUncertain === 'PODZIAL')) problems.push(blad('pickup_jedna_paczka', 'DPD Pickup w kraju przyjmuje tylko przesyłkę jednopaczkową, a zamówienie idzie w kilku paczkach: wybierz kuriera albo wyślij razem.'))
  const pob = kwotaPobrania({ paymentState: input.paymentState, paymentMethod: input.paymentMethod, totalGross: input.totalGross, kwotaNiepewna: input.codAmountUncertain })
  problems.push(...pob.problemy)
  if (pob.kwota !== null && pob.kwota > u.codLimit) problems.push(blad('pobranie_limit', `Pobranie ${pob.kwota} zł przekracza limit ${u.codLimit} zł.`))
  return {
    courierCode: obslugiwany ? (pickup ? DPD_PICKUP : DPD_KURIER) : null,
    gabaryt: input.gabaryt,
    sideXCm: wym.sides[0],
    sideYCm: wym.sides[1],
    sideZCm: wym.sides[2],
    weightKg: w.gramy / 1000,
    codAmount: pob.kwota,
    pickupPoint: pickup ? pickupPoint : null,
    problems,
  }
}
