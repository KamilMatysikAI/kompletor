// Gabaryty paczki na stanowisku pakowania: wybór jednym dotknięciem po „Spakowano”, wg przewoźnika
// zamówienia, z podpowiedzią. Czyste funkcje — używa ich ekran (klient) i zapis ćwiczenia (serwer).
import type { Carrier } from '@prisma/client'

export const GABARYTY = {
  INPOST_A: 'InPost A',
  INPOST_B: 'InPost B',
  INPOST_C: 'InPost C',
  ALLEGRO_A: 'Allegro A',
  ALLEGRO_B: 'Allegro B',
  ALLEGRO_C: 'Allegro C',
  DPD: 'DPD',
  INPOST_KURIER: 'InPost kurier',
  // rozmiary Orlen Paczki (BoxSize S/M/L): 8×38×60, 19×38×60, 41×38×60 cm, do 20 kg
  ORLEN_S: 'Orlen Paczka S',
  ORLEN_M: 'Orlen Paczka M',
  ORLEN_L: 'Orlen Paczka L',
  GLS: 'GLS', // paczka kurierska GLS (wymiary z ustawień konta)
  // Poczta Polska liczy format S…2XL z wymiarów w regule przewoźnika
  POCZTA_POLSKA: 'Poczta Polska',
  OSOBISTY: 'Odbiór osobisty',
} as const

export type Gabaryt = keyof typeof GABARYTY

export function isGabaryt(v: unknown): v is Gabaryt {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(GABARYTY, v)
}

/** Gabaryty do wyboru dla przewoźnika; nieustalony przewoźnik = wszystkie paczkowe. */
export function gabarytyDla(carrier: Carrier | null | undefined): Gabaryt[] {
  switch (carrier) {
    case 'PACZKOMATY':
      return ['INPOST_A', 'INPOST_B', 'INPOST_C']
    case 'ALLEGRO':
      return ['ALLEGRO_A', 'ALLEGRO_B', 'ALLEGRO_C']
    case 'DPD':
    case 'DPD_EMPIK':
      return ['DPD']
    case 'INPOST_KURIER':
      return ['INPOST_KURIER']
    case 'GLS':
      return ['GLS']
    case 'ORLEN_PACZKA':
      return ['ORLEN_S', 'ORLEN_M', 'ORLEN_L']
    case 'POCZTA_POLSKA':
      return ['POCZTA_POLSKA']
    case 'OSOBISTY':
      return ['OSOBISTY']
    default:
      return ['INPOST_A', 'INPOST_B', 'INPOST_C', 'ALLEGRO_A', 'ALLEGRO_B', 'ALLEGRO_C', 'DPD']
  }
}

/** pozycja do podpowiedzi gabarytu; `wymiaryCm` z karty produktu (dł., szer., wys. jednej sztuki). */
export interface PozycjaGabarytu {
  ilosc: number
  jednostka: 'szt' | 'g'
  wymiaryCm?: readonly [number, number, number] | null
}

/** Wewnętrzne wymiary skrytek (cm) od najmniejszej: InPost i Allegro A/B/C, Orlen Paczka S/M/L. */
const SKRYTKI: Record<'A' | 'B' | 'C', readonly [number, number, number]> = { A: [8, 38, 64], B: [19, 38, 64], C: [41, 38, 64] }
const SKRYTKI_ORLEN: Record<'A' | 'B' | 'C', readonly [number, number, number]> = { A: [8, 38, 60], B: [19, 38, 60], C: [41, 38, 60] }
/** Paczka nie wypełnia skrytki w całości: towar zajmuje najwyżej 80% objętości. */
const WYPELNIENIE = 0.8
/** przy kilku sztukach bez ułożenia w jeden stos towar zajmuje najwyżej połowę skrytki. */
const WYPELNIENIE_KILKU = 0.5
/** zapas na karton i wypełnienie, cm na każdy bok paczki. */
const ZAPAS_CM = 1

const posortuj = (w: readonly [number, number, number]) => [...w].sort((a, b) => a - b)
const cm = (w: readonly number[]) => w.map((x) => String(x).replace('.', ',')).join(' × ')

export type LiteraWymiarow = 'A' | 'B' | 'C' | { zaDuza: readonly [number, number, number]; skrytka: readonly [number, number, number] }

/**
 * litera gabarytu z wymiarów produktów, gdy KAŻDA zbierana pozycja ma wymiary na karcie: najmniejsza
 * skrytka, w której (z zapasem 1 cm na karton) mieści się każda sztuka po obróceniu, suma objętości ≤ 80% skrytki,
 * a przy więcej niż jednej sztuce dodatkowo stos sztuk najkrótszym bokiem mieści się w najkrótszym boku skrytki albo
 * objętość ≤ 50% (samo „każda się mieści + 80%” nie dowodzi, że się razem ułożą). Sztuka większa niż największa
 * skrytka = obiekt `zaDuza`, nie „C”. Brak wymiarów choć jednej pozycji = null (wtedy podpowiedź z liczby rzeczy).
 */
export function literaZWymiarow(pozycje: PozycjaGabarytu[], orlen = false): LiteraWymiarow | null {
  const zebrane = pozycje.filter((p) => p.ilosc > 0)
  if (!zebrane.length) return null
  let objetosc = 0
  let sztuk = 0
  let stos = 0
  const boki: number[][] = []
  for (const p of zebrane) {
    const w = p.wymiaryCm
    if (!w || w.some((x) => !Number.isFinite(x) || x <= 0)) return null
    // towar na wagę: wymiary dotyczą opakowania sprzedażowego, ilość w gramach nie mówi o liczbie opakowań
    if (p.jednostka !== 'szt') return null
    const b = posortuj(w)
    objetosc += p.ilosc * w[0] * w[1] * w[2]
    sztuk += p.ilosc
    stos += p.ilosc * b[0]!
    boki.push(b)
  }
  const skrytki = orlen ? SKRYTKI_ORLEN : SKRYTKI
  const miesci = (b: number[], s: number[]) => b[0]! + ZAPAS_CM <= s[0]! && b[1]! + ZAPAS_CM <= s[1]! && b[2]! + ZAPAS_CM <= s[2]!
  for (const litera of ['A', 'B', 'C'] as const) {
    const s = posortuj(skrytki[litera])
    const v = s[0]! * s[1]! * s[2]!
    if (!boki.every((b) => miesci(b, s))) continue
    if (objetosc > v * WYPELNIENIE) continue
    if (sztuk > 1 && !(stos + ZAPAS_CM <= s[0]! || objetosc <= v * WYPELNIENIE_KILKU)) continue
    return litera
  }
  const najwieksza = posortuj(skrytki.C)
  const zaDuza = boki.find((b) => !miesci(b, najwieksza))
  if (zaDuza) return { zaDuza: zaDuza as unknown as readonly [number, number, number], skrytka: skrytki.C }
  // każda sztuka się mieści, ale razem za dużo na jedną skrytkę: największa (jak podpowiedź z liczby rzeczy)
  return 'C'
}

export interface OcenaGabarytu {
  /** Podpowiedź; null = brak (sztuka większa niż największa skrytka przewoźnika). */
  gabaryt: Gabaryt | null
  /** Ostrzeżenie po polsku dla pakującego i podglądu przesyłki; null = brak. */
  ostrzezenie: string | null
}

/**
 * Podpowiedź gabarytu: z wymiarów produktów, gdy wszystkie pozycje je mają, inaczej z liczby rzeczy
 * w paczce (sztuki; towar na wagę liczony co 250 g): do 3 → A, do 8 → B, więcej → C. Tylko podpowiedź — wybiera pakujący.
 * Sztuka większa niż największa skrytka: bez podpowiedzi, z ostrzeżeniem.
 */
export function ocenaGabarytu(carrier: Carrier | null | undefined, pozycje: PozycjaGabarytu[]): OcenaGabarytu {
  const lista = gabarytyDla(carrier)
  if (lista.length === 1) return { gabaryt: lista[0]!, ostrzezenie: null }
  const orlenTylko = lista.every((g) => g.startsWith('ORLEN_'))
  const n = pozycje.reduce((s, p) => s + (p.jednostka === 'g' ? Math.ceil(p.ilosc / 250) : p.ilosc), 0)
  const zWymiarow = literaZWymiarow(pozycje, orlenTylko)
  if (zWymiarow !== null && typeof zWymiarow === 'object') {
    return {
      gabaryt: null,
      ostrzezenie: `Produkt ${cm(zWymiarow.zaDuza)} cm (z kartonem) nie mieści się w największej skrytce ${cm(zWymiarow.skrytka)} cm: brak podpowiedzi gabarytu, sprawdź wymiary na karcie albo wyślij kurierem.`,
    }
  }
  const litera = zWymiarow ?? (n <= 3 ? 'A' : n <= 8 ? 'B' : 'C')
  // Orlen Paczka ma rozmiary S/M/L zamiast A/B/C (ta sama kolejność od najmniejszego)
  const orlen = { A: 'ORLEN_S', B: 'ORLEN_M', C: 'ORLEN_L' } as const
  return { gabaryt: lista.find((g) => g.endsWith(`_${litera}`)) ?? lista.find((g) => g === orlen[litera]) ?? lista[0]!, ostrzezenie: null }
}

/** Sama podpowiedź z `ocenaGabarytu`; null = brak podpowiedzi (sztuka większa niż największa skrytka). */
export function podpowiedzGabarytu(carrier: Carrier | null | undefined, pozycje: PozycjaGabarytu[]): Gabaryt | null {
  return ocenaGabarytu(carrier, pozycje).gabaryt
}
