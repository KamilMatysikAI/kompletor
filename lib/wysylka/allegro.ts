// Parametry przesyłki „Wysyłam z Allegro” w trybie „przygotuj, nie wysyłaj”. Czyste funkcje, bez bazy i sieci:
// gabaryt Allegro A/B/C → wymiary, waga i jej limit, pobranie. Metodę dostawy i punkt odbioru Allegro bierze z zamówienia,
// więc kod kuriera i punkt są puste bez problemu. Wynik nie ma danych odbiorcy.
// Parser `delivery-proposals` przepisuje polami tylko typ dostawy, typ paczki i limity; `suggestedInput` (z nadawcą
// i odbiorcą, czyli dane osobowe) odrzuca w całości. Nieczytelne dane = UnreadableDataError, nigdy 0.
import type { PreparedParcel, ShipmentInput, ShipmentProblem } from '../adaptery/kontrakt'
import { UnreadableDataError } from '../adaptery/kontrakt'
import { GABARYTY, isGabaryt, type Gabaryt } from '../stanowisko/gabaryty'
import { kwotaPobrania, LIMIT_WAGI_G, waga, type UstawieniaPrzesylki } from './przesylka'

/**
 * Wymiary robocze gabarytów Allegro, przyjęte za paczkomatami InPost (A 8×38×64, B 19×38×64, C 41×38×64 cm).
 * DO POTWIERDZENIA: wymiary gabarytów Allegro dla naszych metod dostawy (`limits.dimensions` z `delivery-proposals`
 * po autoryzacji z zakresem przesyłek). Dlatego każda przesyłka dostaje ostrzeżenie `wymiary_domyslne`.
 */
export const WYMIARY_ALLEGRO: Partial<Record<Gabaryt, readonly [number, number, number]>> = {
  ALLEGRO_A: [8, 38, 64],
  ALLEGRO_B: [19, 38, 64],
  ALLEGRO_C: [41, 38, 64],
}

/** Limit wagi paczki Allegro: na razie ten sam co Base Courier (25 kg). DO POTWIERDZENIA (`limits.weight`). */
export const LIMIT_WAGI_ALLEGRO_G = LIMIT_WAGI_G

const blad = (kod: string, tekst: string): ShipmentProblem => ({ kod, poziom: 'BLAD', tekst })
const ostrzezenie = (kod: string, tekst: string): ShipmentProblem => ({ kod, poziom: 'OSTRZEZENIE', tekst })

/** Parametry przesyłki Allegro z danych zamówienia. Bez efektów ubocznych; `problems` z poziomem BLAD = nie do nadania. */
export function wyliczPrzesylkeAllegro(input: ShipmentInput, u: UstawieniaPrzesylki): PreparedParcel {
  const problems: ShipmentProblem[] = [...u.problemy]
  const sides = isGabaryt(input.gabaryt) ? WYMIARY_ALLEGRO[input.gabaryt] : undefined
  if (sides) {
    problems.push(ostrzezenie('wymiary_domyslne', `Wymiary robocze ${sides.join('×')} cm (jak paczkomat): wymiary gabarytów Allegro do potwierdzenia.`))
  } else {
    const jest = isGabaryt(input.gabaryt) ? ` (jest ${GABARYTY[input.gabaryt]})` : ''
    problems.push(blad('gabaryt', `Wysyłam z Allegro wymaga gabarytu Allegro A, B albo C${jest}.`))
  }
  // waga domyślna Wysyłam z Allegro żyje w regule przewoźnika, panel jej nie edytuje (docs/wysylam-z-allegro.md)
  const w = waga(input, u, { gdzieUstawienie: null })
  problems.push(...w.problemy)
  if (w.gramy > LIMIT_WAGI_ALLEGRO_G) problems.push(blad('waga_limit', `Paczka waży ${w.gramy / 1000} kg, limit to ${LIMIT_WAGI_ALLEGRO_G / 1000} kg (limit Allegro do potwierdzenia).`))
  const pob = kwotaPobrania({ paymentState: input.paymentState, paymentMethod: input.paymentMethod, totalGross: input.totalGross, kwotaNiepewna: input.codAmountUncertain })
  problems.push(...pob.problemy)
  if (pob.kwota !== null) problems.push(ostrzezenie('pobranie_konto', 'Pobranie przez Allegro: Allegro może wymagać właściciela i numeru konta do wypłaty pobrania. Sprawdź przed nadaniem.'))
  // kwota paczki z jej pozycji (podział, „dośle później”); kilka przesyłek za pobraniem do jednego
  // zakupu Allegro nie jest sprawdzone na koncie Allegro, więc ostrzeżenie zamiast cichego założenia
  if (pob.kwota !== null && input.wielePaczek) problems.push(ostrzezenie('pobranie_kilka_paczek', `Zamówienie idzie w kilku paczkach: ta paczka pobiera ${pob.kwota.toFixed(2).replace('.', ',')} zł. Po nadaniu sprawdź kwotę pobrania na etykiecie w Allegro.`))
  return {
    courierCode: null, // metodę dostawy Allegro bierze z zamówienia
    gabaryt: input.gabaryt,
    sideXCm: sides?.[0] ?? null,
    sideYCm: sides?.[1] ?? null,
    sideZCm: sides?.[2] ?? null,
    weightKg: w.gramy / 1000,
    codAmount: pob.kwota,
    pickupPoint: null, // punkt odbioru Allegro bierze z zamówienia
    problems,
  }
}

// ─── Parser `delivery-proposals` ─────────────────────────────────────────────

export const ALLEGRO_PACKAGE_TYPES = ['DOX', 'PACKAGE', 'PALLET', 'OTHER'] as const
export type AllegroPackageType = (typeof ALLEGRO_PACKAGE_TYPES)[number]

export interface AllegroKwota {
  amount: number
  currency: string
}

/** Opcja dostawy z `delivery-proposals`: tylko pola potrzebne do przesyłki, bez nadawcy i odbiorcy. */
export interface AllegroDeliveryOption {
  deliveryType: string | null
  packageType: AllegroPackageType
  limits: {
    cashOnDelivery: AllegroKwota | null
    insurance: AllegroKwota | null
    dimensions: { lengthCm: number | null; widthCm: number | null; heightCm: number | null } | null
    weightKg: number | null
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const absent = (v: unknown) => v === undefined || v === null

/** Liczba z Allegro: NIEPEWNE, czy `value`/`amount` przychodzi liczbą czy tekstem (przykłady w specyfikacji są niespójne), więc oba. */
function liczba(v: unknown, what: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+([.,]\d+)?\s*$/.test(v) ? Number(v.trim().replace(',', '.')) : Number.NaN
  if (!Number.isFinite(n) || n < 0) throw new UnreadableDataError(`nieczytelna liczba: ${what}`)
  return n
}

function kwota(v: unknown, what: string): AllegroKwota | null {
  if (absent(v)) return null
  if (!isRecord(v)) throw new UnreadableDataError(`nieczytelna kwota: ${what}`)
  const currency = typeof v['currency'] === 'string' && /^[A-Z]{3}$/.test(v['currency']) ? v['currency'] : null
  if (!currency) throw new UnreadableDataError(`nieczytelna waluta: ${what}`)
  return { amount: liczba(v['amount'], what), currency }
}

const NA_CM: Record<string, number> = { CENTIMETER: 1, MILLIMETER: 0.1, METER: 100 }
const NA_KG: Record<string, number> = { KILOGRAMS: 1, GRAMS: 0.001 }

/** `{ value, unit }` albo sama liczba (wtedy w jednostce domyślnej). Jednostka spoza listy = nieczytelne. */
function miara(v: unknown, jednostki: Record<string, number>, domyslna: string, what: string): number | null {
  if (absent(v)) return null
  if (!isRecord(v)) return liczba(v, what) * jednostki[domyslna]!
  const unit = absent(v['unit']) ? domyslna : v['unit']
  const mnoznik = typeof unit === 'string' ? jednostki[unit] : undefined
  if (mnoznik === undefined) throw new UnreadableDataError(`nieznana jednostka: ${what}`)
  return Math.round(liczba(v['value'], what) * mnoznik * 1000) / 1000
}

function opcja(raw: unknown, i: number): AllegroDeliveryOption {
  const what = (pole: string) => `deliveryOptions[${i}].${pole}`
  if (!isRecord(raw)) throw new UnreadableDataError(`nieczytelna opcja dostawy ${i + 1}`)
  const packageType = raw['packageType']
  if (typeof packageType !== 'string' || !(ALLEGRO_PACKAGE_TYPES as readonly string[]).includes(packageType)) throw new UnreadableDataError(`nieznany typ paczki: ${what('packageType')}`)
  const dt = raw['deliveryType']
  if (!absent(dt) && typeof dt !== 'string') throw new UnreadableDataError(`nieczytelny typ dostawy: ${what('deliveryType')}`)
  const l = raw['limits']
  if (!absent(l) && !isRecord(l)) throw new UnreadableDataError(`nieczytelne limity: ${what('limits')}`)
  const limits = isRecord(l) ? l : {}
  const d = limits['dimensions']
  if (!absent(d) && !isRecord(d)) throw new UnreadableDataError(`nieczytelne wymiary: ${what('limits.dimensions')}`)
  return {
    deliveryType: typeof dt === 'string' && dt.trim() ? dt.trim() : null,
    packageType: packageType as AllegroPackageType,
    limits: {
      cashOnDelivery: kwota(limits['cashOnDelivery'], what('limits.cashOnDelivery')),
      insurance: kwota(limits['insurance'], what('limits.insurance')),
      dimensions: isRecord(d)
        ? {
            lengthCm: miara(d['length'], NA_CM, 'CENTIMETER', what('limits.dimensions.length')),
            widthCm: miara(d['width'], NA_CM, 'CENTIMETER', what('limits.dimensions.width')),
            heightCm: miara(d['height'], NA_CM, 'CENTIMETER', what('limits.dimensions.height')),
          }
        : null,
      weightKg: miara(limits['weight'], NA_KG, 'KILOGRAMS', what('limits.weight')),
    },
  }
}

/**
 * Odpowiedź `GET /shipment-management/delivery-proposals/{orderId}` → opcje dostawy. Kopiuje polami wyłącznie
 * `deliveryType`, `packageType` i `limits`; `suggestedInput`, `additionalServices`, `additionalProperties` i reszta
 * nie wychodzą z tej funkcji. Wynik nie idzie do bazy, logów ani alertów. Komunikaty błędów tylko z nazwą pola.
 */
export function parseDeliveryOptions(body: unknown): AllegroDeliveryOption[] {
  if (!isRecord(body)) throw new UnreadableDataError('nieczytelna odpowiedź delivery-proposals')
  const list = body['deliveryOptions']
  if (!Array.isArray(list)) throw new UnreadableDataError('delivery-proposals bez listy deliveryOptions')
  return list.map((o, i) => opcja(o, i))
}

export interface WymiaryPaczkiCm {
  length: number
  width: number
  height: number
}

/**
 * Wymiary paczki dopasowane do limitu metody dostawy z `delivery-proposals` (opcje typu PACKAGE z pełnym, dodatnim
 * limitem). Wymiary gabarytu są robocze (jak polski paczkomat), a metody zagraniczne mają mniejsze skrytki: bez
 * dopasowania Allegro odrzuca przesyłkę kodem DIMENSIONS_VALIDATION_ERROR. Największy bok paczki trafia do pola
 * z największym limitem, każdy bok jest przycięty do swojego limitu (przy równych limitach kolejność pól zostaje
 * length, width, height). Paczka mieszcząca się w układzie gabarytu zostaje bez zmian; mieszcząca się dopiero po
 * obróceniu jest przestawiona między polami bez przycięcia (`przyciete: false`).
 * Opcja dostawy w specyfikacji nie ma `deliveryMethodId`, więc metody nie da się dopasować po identyfikatorze: kilka
 * opcji z różnymi limitami (inna skrytka, nie tylko obrót) = limit niejednoznaczny, wymiary bez zmian, `limit: null`
 * i `niejednoznaczny: true`. Brak pełnego limitu (albo zero) = wymiary bez zmian i `limit: null`.
 */
export function dopasujWymiaryDoLimitu(w: WymiaryPaczkiCm, opcje: readonly AllegroDeliveryOption[]): { wymiary: WymiaryPaczkiCm; limit: WymiaryPaczkiCm | null; przyciete: boolean; niejednoznaczny?: true } {
  const limity: WymiaryPaczkiCm[] = []
  for (const o of opcje) {
    const d = o.packageType === 'PACKAGE' ? o.limits.dimensions : null
    if (d && d.lengthCm && d.widthCm && d.heightCm) limity.push({ length: d.lengthCm, width: d.widthCm, height: d.heightCm })
  }
  const skrytka = (l: WymiaryPaczkiCm) => [l.length, l.width, l.height].sort((a, b) => b - a).join('×')
  if (!limity.length) return { wymiary: w, limit: null, przyciete: false }
  if (new Set(limity.map(skrytka)).size > 1) return { wymiary: w, limit: null, przyciete: false, niejednoznaczny: true }
  const limit = limity[0]!
  // mieści się w układzie gabarytu: nic nie zmieniamy (dotychczasowe metody krajowe)
  if (w.length <= limit.length && w.width <= limit.width && w.height <= limit.height) return { wymiary: w, limit, przyciete: false }
  const pola = (['length', 'width', 'height'] as const).slice().sort((a, b) => limit[b] - limit[a])
  const boki = [w.length, w.width, w.height].sort((a, b) => b - a)
  const wymiary = { ...w }
  pola.forEach((pole, i) => (wymiary[pole] = Math.min(boki[i]!, limit[pole])))
  const przyciete = boki.some((b, i) => b > limit[pola[i]!])
  return { wymiary, limit, przyciete }
}
