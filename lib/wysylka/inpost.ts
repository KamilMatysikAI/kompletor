// Parametry przesyłki InPost ShipX w trybie „przygotuj, nie wysyłaj”. Czyste funkcje, bez bazy i sieci:
// przewoźnik → usługa ShipX (`courierCode`), gabaryt paczkomatu → szablon, kurier → wymiary i waga z ustawień firmy,
// płatność → pobranie z limitem z konfiguracji. Wynik nie ma danych odbiorcy. Braki są problemem na liście, nigdy cichą
// wartością (te same kody co Base Courier: panel po nich pokazuje wartości robocze).
import type { PreparedParcel, ShipmentInput, ShipmentProblem } from '../adaptery/kontrakt'
import { GABARYTY, isGabaryt, type Gabaryt } from '../stanowisko/gabaryty'
import { kwotaPobrania, LIMIT_WAGI_G, ustawieniaPrzesylki, waga, WBUDOWANE_USTAWIENIA, WYMIARY_INPOST, type UstawieniaPrzesylki } from './przesylka'

/** Kody usług ShipX (`service`), potwierdzone w dokumentacji InPost. */
export const USLUGI_SHIPX = ['inpost_locker_standard', 'inpost_courier_standard'] as const
export type UslugaShipx = (typeof USLUGI_SHIPX)[number]

/** Szablon paczki paczkomatowej (`parcels.template`) z gabarytu A/B/C. */
export const SZABLON_INPOST: Partial<Record<Gabaryt, 'small' | 'medium' | 'large'>> = { INPOST_A: 'small', INPOST_B: 'medium', INPOST_C: 'large' }

export interface UstawieniaInpost extends UstawieniaPrzesylki {
  /** Najwyższa kwota pobrania z konfiguracji firmy (limit InPost do potwierdzenia); null = nieustawiony. */
  codLimit: number | null
}

const blad = (kod: string, tekst: string): ShipmentProblem => ({ kod, poziom: 'BLAD', tekst })
const ostrzezenie = (kod: string, tekst: string): ShipmentProblem => ({ kod, poziom: 'OSTRZEZENIE', tekst })

/** Ustawienia z konfiguracji adaptera albo reguły przewoźnika; zła wartość limitu to problem, nie cichy brak limitu. */
export function ustawieniaInpost(config: Readonly<Record<string, unknown>>): UstawieniaInpost {
  const u = ustawieniaPrzesylki(config)
  const v = config['codLimit']
  let codLimit: number | null = null
  if (v !== undefined && v !== null && v !== '') {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
    if (Number.isFinite(n) && n > 0) codLimit = n
    else u.problemy.push(blad('ustawienie', 'Zła wartość ustawienia codLimit: popraw konfigurację przewoźnika.'))
  }
  return { ...u, codLimit }
}

/** Usługa ShipX dla przewoźnika zamówienia; inny przewoźnik niż InPost = null (reguła wskazuje zły moduł). */
export function uslugaShipx(carrier: ShipmentInput['carrier']): UslugaShipx | null {
  if (carrier === 'PACZKOMATY') return 'inpost_locker_standard'
  if (carrier === 'INPOST_KURIER') return 'inpost_courier_standard'
  return null
}

function wymiary(input: ShipmentInput, u: UstawieniaPrzesylki, usluga: UslugaShipx | null): { sides: readonly [number, number, number] | null; problemy: ShipmentProblem[] } {
  if (usluga === 'inpost_locker_standard') {
    const sides = isGabaryt(input.gabaryt) ? WYMIARY_INPOST[input.gabaryt] : undefined
    if (sides) return { sides, problemy: [] }
    const jest = isGabaryt(input.gabaryt) ? ` (jest ${GABARYTY[input.gabaryt]})` : ''
    return { sides: null, problemy: [blad('gabaryt', `Paczkomat wymaga gabarytu A, B albo C${jest}.`)] }
  }
  if (u.sideXCm !== null && u.sideYCm !== null && u.sideZCm !== null) return { sides: [u.sideXCm, u.sideYCm, u.sideZCm], problemy: [] }
  const w = WBUDOWANE_USTAWIENIA
  return { sides: [w.sideXCm, w.sideYCm, w.sideZCm], problemy: [ostrzezenie('wymiary_domyslne', `Wymiary robocze ${w.sideXCm}×${w.sideYCm}×${w.sideZCm} cm: firma nie ustawiła domyślnych wymiarów paczki kurierskiej InPost.`)] }
}

/** Parametry przesyłki ShipX z danych zamówienia. Bez efektów ubocznych; problem z poziomem BLAD = nie do nadania. */
export function wyliczPrzesylkeInpost(input: ShipmentInput, u: UstawieniaInpost): PreparedParcel {
  const problems: ShipmentProblem[] = [...u.problemy]
  const usluga = uslugaShipx(input.carrier)
  if (!usluga) problems.push(blad('kod_kuriera', 'Moduł InPost ShipX obsługuje tylko paczkomaty i kuriera InPost: sprawdź regułę przewoźnika.'))
  const wym = wymiary(input, u, usluga)
  problems.push(...wym.problemy)
  // Kurier jedzie pod adres: punkt odbioru nie dotyczy. Paczkomat bez punktu = przesyłki nie da się utworzyć.
  const pickupPoint = usluga === 'inpost_courier_standard' ? null : input.pickupPoint?.trim() || null
  if (usluga !== 'inpost_courier_standard' && !pickupPoint) problems.push(blad('punkt', 'Brak punktu odbioru (paczkomatu) w danych zamówienia.'))
  const w = waga(input, u)
  problems.push(...w.problemy)
  if (w.gramy > LIMIT_WAGI_G) problems.push(blad('waga_limit', `Paczka waży ${w.gramy / 1000} kg, limit to ${LIMIT_WAGI_G / 1000} kg.`))
  const pob = kwotaPobrania({ paymentState: input.paymentState, paymentMethod: input.paymentMethod, totalGross: input.totalGross, kwotaNiepewna: input.codAmountUncertain })
  problems.push(...pob.problemy)
  if (pob.kwota !== null) {
    if (u.codLimit === null) problems.push(ostrzezenie('pobranie_limit_nieznany', 'Limit kwoty pobrania InPost nie jest ustawiony w konfiguracji: sprawdź go w umowie przed nadaniem.'))
    else if (pob.kwota > u.codLimit) problems.push(blad('pobranie_limit', `Kwota pobrania ${pob.kwota} zł przekracza limit ${u.codLimit} zł z konfiguracji.`))
    // nie każdy paczkomat przyjmuje pobranie (`payment_available` punktu); bez sieci tego nie wiemy
    if (usluga === 'inpost_locker_standard') problems.push(ostrzezenie('pobranie_punkt', 'Pobranie do paczkomatu: sprawdź, czy wybrany paczkomat przyjmuje pobranie (sprawdzenie punktu), zanim potwierdzisz przesyłkę.'))
    problems.push(ostrzezenie('pobranie_ubezpieczenie', 'Pobranie: przesyłka dostanie ubezpieczenie równe kwocie pobrania (wymóg InPost do potwierdzenia na sandboxie).'))
  }
  return {
    courierCode: usluga,
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
