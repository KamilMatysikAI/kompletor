// Parametry przesyłki Orlen Paczki w trybie „przygotuj, nie wysyłaj”. Czyste funkcje, bez bazy i sieci.
// Fakty z dokumentacji „API ORLEN Paczka v1.26.004”: dostawa wyłącznie do punktu albo automatu (DestinationCode),
// rozmiar S/M/L (8×38×60, 19×38×60, 41×38×60 cm), do 20 kg; pobranie wycofane 2.01.2025, ubezpieczenie 4.12.2024.
// Wynik nie ma danych odbiorcy. Braki są problemem na liście, nigdy cichą wartością (te same kody co inni przewoźnicy:
// panel po nich pokazuje wartości robocze).
import type { PreparedParcel, ShipmentInput, ShipmentProblem } from '../adaptery/kontrakt'
import { GABARYTY, isGabaryt, type Gabaryt } from '../stanowisko/gabaryty'
import { kwotaPobrania, ustawieniaPrzesylki, waga, type UstawieniaPrzesylki } from './przesylka'

export type RozmiarOrlen = 'S' | 'M' | 'L'

/** Gabaryt ze stanowiska → `BoxSize` i wymiary z dokumentacji (pkt 3.13). */
export const ROZMIAR_ORLEN: Partial<Record<Gabaryt, { box: RozmiarOrlen; sides: readonly [number, number, number] }>> = {
  ORLEN_S: { box: 'S', sides: [8, 38, 60] },
  ORLEN_M: { box: 'M', sides: [19, 38, 60] },
  ORLEN_L: { box: 'L', sides: [41, 38, 60] },
}

export const LIMIT_WAGI_ORLEN_G = 20_000

/**
 * Kod punktu (`DestinationCode`): pełny z listy punktów, np. `WS-116263-C3-01`, albo uniwersalny `XX-116263-00-00`
 * (pkt 3.5.2). Litery i cyfry w członach, 6 cyfr numeru punktu.
 */
export const KOD_PUNKTU_ORLEN_RE = /^[A-Z0-9]{2}-\d{6}-[A-Z0-9]{2}-[A-Z0-9]{2}$/

export interface UstawieniaOrlen extends UstawieniaPrzesylki {}

const blad = (kod: string, tekst: string): ShipmentProblem => ({ kod, poziom: 'BLAD', tekst })

/** Ustawienia z konfiguracji adaptera albo reguły przewoźnika (domyślna waga paczki). */
export function ustawieniaOrlen(config: Readonly<Record<string, unknown>>): UstawieniaOrlen {
  return ustawieniaPrzesylki(config)
}

/** Kod punktu w kształcie Orlenu (wielkie litery); null = to nie jest kod punktu Orlen Paczki. */
export function kodPunktuOrlen(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().toUpperCase()
  return KOD_PUNKTU_ORLEN_RE.test(s) ? s : null
}

/** Parametry przesyłki Orlen Paczki z danych zamówienia. Bez efektów ubocznych; problem BLAD = nie do nadania. */
export function wyliczPrzesylkeOrlen(input: ShipmentInput, u: UstawieniaOrlen): PreparedParcel {
  const problems: ShipmentProblem[] = [...u.problemy]
  if (input.carrier !== 'ORLEN_PACZKA') problems.push(blad('kod_kuriera', 'Moduł Orlen Paczka obsługuje tylko przewoźnika „Orlen Paczka”: sprawdź regułę przewoźnika.'))
  const r = isGabaryt(input.gabaryt) ? ROZMIAR_ORLEN[input.gabaryt] : undefined
  if (!r) {
    const jest = isGabaryt(input.gabaryt) ? ` (jest ${GABARYTY[input.gabaryt]})` : ''
    problems.push(blad('gabaryt', `Orlen Paczka wymaga rozmiaru S, M albo L${jest}.`))
  }
  const surowy = input.pickupPoint?.trim() || null
  const pickupPoint = kodPunktuOrlen(surowy)
  if (!surowy) problems.push(blad('punkt', 'Brak punktu odbioru Orlen Paczki: Orlen Paczka dowozi tylko do punktu albo automatu.'))
  else if (!pickupPoint) problems.push(blad('punkt_format', 'Punkt odbioru nie jest kodem Orlen Paczki (np. WS-116263-C3-01): sprawdź punkt na karcie zamówienia.'))
  const w = waga(input, u)
  problems.push(...w.problemy)
  if (w.gramy > LIMIT_WAGI_ORLEN_G) problems.push(blad('waga_limit', `Paczka waży ${w.gramy / 1000} kg, limit Orlen Paczki to ${LIMIT_WAGI_ORLEN_G / 1000} kg.`))
  const pob = kwotaPobrania({ paymentState: input.paymentState, paymentMethod: input.paymentMethod, totalGross: input.totalGross, kwotaNiepewna: input.codAmountUncertain })
  // Pobranie (także o nieznanej kwocie) = nie do nadania; zwykłe ostrzeżenia płatności (np. nieopłacone) zostają
  if (pob.kwota !== null || pob.problemy.some((p) => p.kod === 'pobranie')) problems.push(blad('pobranie', 'Orlen Paczka nie przyjmuje paczek za pobraniem (usługa wycofana 2 stycznia 2025): wybierz innego przewoźnika albo zmień płatność.'))
  else problems.push(...pob.problemy)
  return {
    courierCode: r?.box ?? null,
    gabaryt: input.gabaryt,
    sideXCm: r?.sides[0] ?? null,
    sideYCm: r?.sides[1] ?? null,
    sideZCm: r?.sides[2] ?? null,
    weightKg: w.gramy / 1000,
    codAmount: null,
    pickupPoint,
    problems,
  }
}
