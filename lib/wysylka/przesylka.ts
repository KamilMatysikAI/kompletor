// Parametry przesyłki Base Courier w trybie „przygotuj, nie wysyłaj”. Czyste funkcje, bez bazy i sieci:
// gabaryt → wymiary, przewoźnik → `courier_code`, płatność → pobranie, waga i jej limity. Wynik nie ma danych odbiorcy.
// Braki są problemem na liście, nigdy cichą wartością: nieznana kwota pobrania to nie 0.
import type { Carrier, PaymentState } from '@prisma/client'
import type { PowodNiepewnejKwoty, PreparedParcel, ShipmentInput, ShipmentProblem } from '../adaptery/kontrakt'
import { GABARYTY, isGabaryt, type Gabaryt } from '../stanowisko/gabaryty'

/** Kody `CourierSearch.courier_code` z wtyczki BLPaczka; pełną listę zwraca `couriers` (do potwierdzenia na sandboxie). */
export const COURIER_CODES = ['paczkomaty', 'paczkomaty_eco', 'paczkomaty_allegro_smart', 'dpd', 'dhl', 'poczta', 'orlen'] as const

const DOMYSLNY_KOD: Partial<Record<Carrier, string>> = { PACZKOMATY: 'paczkomaty', DPD: 'dpd', DPD_EMPIK: 'dpd' }

/** InPost: pola „gabaryt” w API nie ma, tylko wymiary (basecourier.com/przewoznicy/inpost). */
export const WYMIARY_INPOST: Partial<Record<Gabaryt, readonly [number, number, number]>> = {
  INPOST_A: [8, 38, 64],
  INPOST_B: [19, 38, 64],
  INPOST_C: [41, 38, 64],
}

export const LIMIT_WAGI_G = 25_000
export const LIMIT_WAGI_DPD_PICKUP_G = 20_000

/** Gdy firma nie ustawiła własnych: robocze wartości do ustalenia z magazynem, zawsze z ostrzeżeniem na ekranie. */
export const WBUDOWANE_USTAWIENIA = { sideXCm: 40, sideYCm: 30, sideZCm: 20, weightKg: 1 } as const

export interface UstawieniaPrzesylki {
  sideXCm: number | null
  sideYCm: number | null
  sideZCm: number | null
  weightKg: number | null
  /** Zła wartość w konfiguracji: problem na liście, nie cichy powrót do wbudowanej. */
  problemy: ShipmentProblem[]
}

const blad = (kod: string, tekst: string): ShipmentProblem => ({ kod, poziom: 'BLAD', tekst })
const ostrzezenie = (kod: string, tekst: string): ShipmentProblem => ({ kod, poziom: 'OSTRZEZENIE', tekst })
const round2 = (n: number) => Math.round(n * 100) / 100

/** Domyślne wymiary i waga z konfiguracji adaptera albo reguły przewoźnika (CarrierRule.config). */
export function ustawieniaPrzesylki(config: Readonly<Record<string, unknown>>): UstawieniaPrzesylki {
  const problemy: ShipmentProblem[] = []
  const liczba = (key: string, calkowita: boolean): number | null => {
    const v = config[key]
    if (v === undefined || v === null || v === '') return null
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
    if (Number.isFinite(n) && n > 0 && n <= 1_000 && (!calkowita || Number.isInteger(n))) return n
    problemy.push(blad('ustawienie', `Zła wartość ustawienia ${key}: popraw konfigurację przewoźnika.`))
    return null
  }
  return { sideXCm: liczba('defaultSideXCm', true), sideYCm: liczba('defaultSideYCm', true), sideZCm: liczba('defaultSideZCm', true), weightKg: liczba('defaultWeightKg', false), problemy }
}

/** Kod kuriera: nadpisanie z reguły przewoźnika (`config.courierCode`) albo domyślny dla przewoźnika. */
export function kodKuriera(carrier: Carrier, nadpisanie?: unknown): string | null {
  if (typeof nadpisanie === 'string' && (COURIER_CODES as readonly string[]).includes(nadpisanie)) return nadpisanie
  if (nadpisanie !== undefined && nadpisanie !== null && nadpisanie !== '') return null
  return DOMYSLNY_KOD[carrier] ?? null
}

export interface DanePobrania {
  paymentState: PaymentState
  paymentMethod: string
  totalGross: number | null
  /** Braki, podział na paczki i odrzucone pozycje zmieniają kwotę do pobrania, a totalGross zostaje bez zmian. */
  kwotaNiepewna: PowodNiepewnejKwoty | null
}

export const POWOD_KWOTY: Record<PowodNiepewnejKwoty, string> = {
  BRAKI: 'zamówienie ma braki, kwota do pobrania zmieni się po spakowaniu',
  BRAKI_SPAKOWANE: 'paczka spakowana z brakami, kwotę pobrania pomniejsz o brakujące pozycje',
  PODZIAL: 'zamówienie wysyłane w kilku paczkach, kwotę pobrania paczki ustal ręcznie',
  ODRZUCONE: 'pozycje odrzucone przy akceptacji nie są odjęte od kwoty zamówienia, kwotę pobrania ustal ręcznie',
}

const METODA_POBRANIE = /pobrani|przy odbiorze|\bcod\b/i

/** Zamówienie za pobraniem: stan COD albo nieopłacone z metodą płatności „pobranie” (ta sama reguła co kwota pobrania). */
export function jestPobranie(d: Pick<DanePobrania, 'paymentState' | 'paymentMethod'>): boolean {
  return d.paymentState !== 'PAID' && (d.paymentState === 'COD' || METODA_POBRANIE.test(d.paymentMethod))
}

/** Kwota `uptake`: null = bez pobrania. Pobranie o nieznanej kwocie to problem, nigdy 0. */
export function kwotaPobrania(d: DanePobrania): { kwota: number | null; problemy: ShipmentProblem[] } {
  if (d.paymentState === 'PAID') return { kwota: null, problemy: [] }
  const pobranie = jestPobranie(d)
  if (!pobranie) return { kwota: null, problemy: [ostrzezenie('nieoplacone', 'Zamówienie nie jest opłacone: przed nadaniem sprawdź płatność.')] }
  const nieznana = (powod: string) => ({ kwota: null, problemy: [blad('pobranie', `Nieznana kwota pobrania: ${powod}.`)] })
  if (d.paymentState === 'PARTIAL') return nieznana('zamówienie jest częściowo opłacone')
  if (d.kwotaNiepewna) return nieznana(POWOD_KWOTY[d.kwotaNiepewna])
  if (d.totalGross === null || !Number.isFinite(d.totalGross) || d.totalGross <= 0) return nieznana('brak kwoty zamówienia')
  const zMetody = d.paymentState === 'COD' ? [] : [ostrzezenie('pobranie_z_metody', 'Pobranie rozpoznane po nazwie metody płatności, a stan płatności to „nieopłacone”: potwierdź przed nadaniem.')]
  return { kwota: round2(d.totalGross), problemy: zMetody }
}

/**
 * Waga ze składu: towar na wagę ma gramaturę, sztuka waży tyle, ile podaje karta produktu (`wagaSztukiG`).
 * `pelna` = każda pozycja ma wagę; inaczej przesyłka bierze domyślną wagę firmy (nie mniej niż znana część).
 */
export function wagaZeSkladu(pozycje: { ilosc: number; jednostka: 'szt' | 'g'; wagaSztukiG?: number | null }[]): { gramy: number; pelna: boolean } {
  const zWaga = (p: { jednostka: 'szt' | 'g'; wagaSztukiG?: number | null }) => p.jednostka === 'g' || (typeof p.wagaSztukiG === 'number' && p.wagaSztukiG > 0)
  const gramy = pozycje.reduce((s, p) => s + (p.jednostka === 'g' ? p.ilosc : zWaga(p) ? p.ilosc * p.wagaSztukiG! : 0), 0)
  return { gramy: Math.round(gramy), pelna: pozycje.length > 0 && pozycje.every(zWaga) }
}

function wymiary(input: ShipmentInput, u: UstawieniaPrzesylki): { sides: readonly [number, number, number] | null; problemy: ShipmentProblem[] } {
  if (input.carrier === 'PACZKOMATY') {
    const sides = isGabaryt(input.gabaryt) ? WYMIARY_INPOST[input.gabaryt] : undefined
    if (sides) return { sides, problemy: [] }
    const jest = isGabaryt(input.gabaryt) ? ` (jest ${GABARYTY[input.gabaryt]})` : ''
    return { sides: null, problemy: [blad('gabaryt', `Paczkomat wymaga gabarytu A, B albo C${jest}.`)] }
  }
  if (u.sideXCm !== null && u.sideYCm !== null && u.sideZCm !== null) return { sides: [u.sideXCm, u.sideYCm, u.sideZCm], problemy: [] }
  const w = WBUDOWANE_USTAWIENIA
  return { sides: [w.sideXCm, w.sideYCm, w.sideZCm], problemy: [ostrzezenie('wymiary_domyslne', `Wymiary robocze ${w.sideXCm}×${w.sideYCm}×${w.sideZCm} cm: firma nie ustawiła domyślnych wymiarów DPD.`)] }
}

/** Ekran, na którym firma ustawia wagę domyślną paczki (pole konta przewoźnika „waga paczki w kg…”). */
export const GDZIE_WAGA_DOMYSLNA = 'Ustawienia → Wysyłka i druk → Przewoźnicy → Konta przewoźników'
/** Ekran wagi produktu (pole „Waga (g)” na karcie produktu). */
export const GDZIE_WAGA_PRODUKTU = 'Produkty → karta produktu, pole „Waga (g)”'

const kg = (gramy: number) => `${(gramy / 1000).toLocaleString('pl-PL')} kg`

/**
 * Waga paczki: ze składu, a gdy produkty nie mają wagi, domyślna (nie mniej niż znana część). Tekst mówi
 * pakującemu, z jaką wagą paczka pójdzie i gdzie to zmienić. Poziom zależy od tego, czy wagę domyślną ustawiła firma:
 *  - ustawiona (`defaultWeightKg` konta albo reguły) = INFO, bez potwierdzania przy każdej paczce;
 *  - nieustawiona (wbudowane 1 kg) albo waga niepełna (znana część większa od domyślnej) = OSTRZEZENIE do potwierdzenia.
 * Kod zawsze `waga_domyslna`; liczba, która idzie do przewoźnika, bez zmian. `gdzieUstawienie: null` = moduł, w którym
 * panel nie ustawia wagi domyślnej (Wysyłam z Allegro bierze ją z reguły).
 */
export function waga(input: ShipmentInput, u: UstawieniaPrzesylki, o: { gdzieUstawienie?: string | null } = {}): { gramy: number; problemy: ShipmentProblem[] } {
  if (input.weightComplete && input.weightG !== null && input.weightG > 0) return { gramy: input.weightG, problemy: [] }
  const zaKg = u.weightKg ?? WBUDOWANE_USTAWIENIA.weightKg
  const znane = input.weightG ?? 0
  const gramy = Math.max(Math.round(zaKg * 1000), znane)
  const gdzie = o.gdzieUstawienie === undefined ? GDZIE_WAGA_DOMYSLNA : o.gdzieUstawienie
  if (znane > 0 && gramy === znane)
    return { gramy, problemy: [ostrzezenie('waga_domyslna', `Paczka pójdzie z wagą ${kg(gramy)}: tyle ważą produkty z wpisaną wagą, część produktów nie ma wagi. Brakującą wagę wpiszesz w: ${GDZIE_WAGA_PRODUKTU}.`)] }
  if (u.weightKg !== null)
    return { gramy, problemy: [{ kod: 'waga_domyslna', poziom: 'INFO', tekst: `Paczka pójdzie z wagą ${kg(gramy)} z ustawień przewoźnika (produkty nie mają wpisanej wagi).${gdzie ? ` Zmienisz ją w: ${gdzie}.` : ''}` }] }
  return { gramy, problemy: [ostrzezenie('waga_domyslna', `Paczka pójdzie z wagą ${kg(gramy)}: produkty nie mają wpisanej wagi, a firma nie ustawiła wagi domyślnej.${gdzie ? ` Ustawisz ją w: ${gdzie}.` : ''}`)] }
}

/** Parametry przesyłki z danych zamówienia. Bez efektów ubocznych; `problems` z poziomem BLAD = nie do nadania. */
export function wyliczPrzesylke(input: ShipmentInput, u: UstawieniaPrzesylki): PreparedParcel {
  const problems: ShipmentProblem[] = [...u.problemy]
  const courierCode = kodKuriera(input.carrier, input.courierCode)
  if (!courierCode) problems.push(blad('kod_kuriera', 'Reguła przewoźnika nie wyznacza znanego kodu kuriera Base Courier.'))
  const wym = wymiary(input, u)
  problems.push(...wym.problemy)
  const pickupPoint = input.pickupPoint?.trim() || null
  if (!pickupPoint && input.carrier !== 'DPD') problems.push(blad('punkt', 'Brak punktu odbioru w danych zamówienia.'))
  const w = waga(input, u)
  problems.push(...w.problemy)
  const dpdPickup = input.carrier === 'DPD_EMPIK' || (input.carrier === 'DPD' && pickupPoint !== null)
  const limit = dpdPickup ? LIMIT_WAGI_DPD_PICKUP_G : LIMIT_WAGI_G
  if (w.gramy > limit) problems.push(blad('waga_limit', `Paczka waży ${w.gramy / 1000} kg, limit to ${limit / 1000} kg.`))
  const pob = kwotaPobrania({ paymentState: input.paymentState, paymentMethod: input.paymentMethod, totalGross: input.totalGross, kwotaNiepewna: input.codAmountUncertain })
  problems.push(...pob.problemy)
  return {
    courierCode,
    gabaryt: input.gabaryt,
    sideXCm: wym.sides?.[0] ?? null,
    sideYCm: wym.sides?.[1] ?? null,
    sideZCm: wym.sides?.[2] ?? null,
    weightKg: w.gramy / 1000,
    codAmount: pob.kwota,
    pickupPoint,
    problems,
  }
}
