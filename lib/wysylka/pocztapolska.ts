// Poczta Polska, Pocztex Kurier przez eNadawcę: parametry przesyłki („przygotuj, nie wysyłaj”), treść
// `addShipment` i GUID przesyłki z referencji hosta. Czyste funkcje, bez bazy i sieci; dane adresata tylko w pamięci.
// Wiedza z konektora Open Integration Platform (integrators/courier/pocztapolska/v1.0.0/src/integration.py, ae43d1e,
// Apache-2.0): format S/M/L/XL/2XL z wymiarów i wagi, ponadgabaryt, adres w polach adresType. Kod własny.
// [NIEPEWNE: progi formatów z konektora OIP (Pocztex 2021), limit wagi i to, które pola są atrybutami XML, do
// sprawdzenia w aktualnym cenniku i WSDL eNadawcy.]
import { createHash } from 'node:crypto'
import type { PreparedParcel, RecipientAddress, ShipmentInput, ShipmentProblem } from '../adaptery/kontrakt'
import type { WezelXml } from '../zrodla/pocztapolska'
import { kwotaPobrania, ustawieniaPrzesylki, waga, WBUDOWANE_USTAWIENIA, type UstawieniaPrzesylki } from './przesylka'
import type { NadawcaDpd } from './zlecenie-dpd'
import { podzielAdres, telefonOrlen } from './zlecenie-orlenpaczka'

export type FormatPP = 'S' | 'M' | 'L' | 'XL' | '2XL'

/** Najdłuższe boki formatu w cm (posortowane rosnąco) i limit wagi; 2XL = suma boków ≤ 250 cm, najdłuższy ≤ 120 cm. */
export const FORMATY_PP: readonly { format: FormatPP; boki: readonly [number, number, number] }[] = [
  { format: 'S', boki: [9, 40, 65] },
  { format: 'M', boki: [20, 40, 65] },
  { format: 'L', boki: [40, 42, 65] },
  { format: 'XL', boki: [60, 60, 70] },
]
export const LIMIT_WAGI_FORMATU_G = 20_000
export const LIMIT_SUMY_2XL_CM = 250
export const LIMIT_BOKU_2XL_CM = 120
export const LIMIT_WAGI_PP_G = 30_000

const blad = (kod: string, tekst: string): ShipmentProblem => ({ kod, poziom: 'BLAD', tekst })
const ostrzezenie = (kod: string, tekst: string): ShipmentProblem => ({ kod, poziom: 'OSTRZEZENIE', tekst })

export type UstawieniaPP = UstawieniaPrzesylki

export function ustawieniaPP(config: Readonly<Record<string, unknown>>): UstawieniaPP {
  return ustawieniaPrzesylki(config)
}

/** Format Pocztex z wymiarów (cm) i wagi (g); null = paczka za duża dla Pocztex Kurier. */
export function formatPP(boki: readonly [number, number, number], gramy: number): FormatPP | null {
  const s = [...boki].sort((a, b) => a - b)
  if (gramy <= LIMIT_WAGI_FORMATU_G) for (const f of FORMATY_PP) if (s[0]! <= f.boki[0] && s[1]! <= f.boki[1] && s[2]! <= f.boki[2]) return f.format
  if (s[0]! + s[1]! + s[2]! <= LIMIT_SUMY_2XL_CM && s[2]! <= LIMIT_BOKU_2XL_CM && gramy <= LIMIT_WAGI_PP_G) return '2XL'
  return null
}

/** Parametry przesyłki Pocztex Kurier z danych zamówienia. Bez efektów ubocznych; problem BLAD = nie do nadania. */
export function wyliczPrzesylkePP(input: ShipmentInput, u: UstawieniaPP): PreparedParcel {
  const problems: ShipmentProblem[] = [...u.problemy]
  if (input.carrier !== 'POCZTA_POLSKA') problems.push(blad('kod_kuriera', 'Moduł Poczta Polska obsługuje tylko przewoźnika „Poczta Polska”: sprawdź regułę przewoźnika.'))
  let boki: [number, number, number]
  if (u.sideXCm && u.sideYCm && u.sideZCm) boki = [u.sideXCm, u.sideYCm, u.sideZCm]
  else {
    boki = [WBUDOWANE_USTAWIENIA.sideXCm, WBUDOWANE_USTAWIENIA.sideYCm, WBUDOWANE_USTAWIENIA.sideZCm]
    problems.push(ostrzezenie('wymiary_domyslne', `Wymiary robocze ${boki.join('×')} cm: ustaw wymiary paczki w regule przewoźnika Poczta Polska.`))
  }
  const w = waga(input, u)
  problems.push(...w.problemy)
  const format = formatPP(boki, w.gramy)
  if (!format) problems.push(blad('gabaryt', `Paczka ${boki.join('×')} cm, ${w.gramy / 1000} kg nie mieści się w formatach Pocztex Kurier (do 2XL: suma boków 250 cm, najdłuższy 120 cm, ${LIMIT_WAGI_PP_G / 1000} kg).`))
  const pob = kwotaPobrania({ paymentState: input.paymentState, paymentMethod: input.paymentMethod, totalGross: input.totalGross, kwotaNiepewna: input.codAmountUncertain })
  if (pob.kwota !== null || pob.problemy.some((p) => p.kod === 'pobranie')) problems.push(blad('pobranie', 'Pobranie w module Poczty Polskiej nie jest jeszcze obsługiwane: wybierz innego przewoźnika albo zmień płatność.'))
  else problems.push(...pob.problemy)
  return { courierCode: format, gabaryt: input.gabaryt, sideXCm: boki[0], sideYCm: boki[1], sideZCm: boki[2], weightKg: w.gramy / 1000, codAmount: null, pickupPoint: null, problems }
}

/**
 * GUID przesyłki w eNadawcy (32 znaki szesnastkowe) z referencji hosta: ta sama referencja = ten sam GUID, więc
 * ponowienie po zgubionej odpowiedzi nie tworzy drugiej przesyłki, a odszukanie pyta eNadawcę o ten GUID.
 */
export function guidZReferencji(reference: string): string {
  const r = reference.trim()
  if (r.length < 16) throw new Error('referencja przesyłki za krótka na GUID eNadawcy')
  return createHash('sha256').update(`kompletor:${r}`).digest('hex').slice(0, 32).toUpperCase()
}
export const GUID_PP_RE = /^[0-9A-F]{32}$/

const tekst = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : null)
const kodPocztowy = (v: string | null): string | null => {
  const s = (v ?? '').replace(/\s/g, '')
  return /^\d{2}-?\d{3}$/.test(s) ? s.replace('-', '') : null
}

/** Pola adresType eNadawcy (bez przestrzeni nazw). */
export interface AdresPP {
  nazwa: string
  nazwa2: string | null
  ulica: string
  numerDomu: string
  numerLokalu: string | null
  miejscowosc: string
  kodPocztowy: string
  kraj: 'Polska'
  telefon: string | null
  mobile: string | null
  email: string | null
}

/** Adresat Pocztex Kurier: adres w Polsce z ulicą i numerem osobno, telefon komórkowy (awizo SMS). Braki po nazwie pola. */
export function adresatPP(r: Readonly<RecipientAddress>): { adres: AdresPP | null; braki: string[] } {
  const braki: string[] = []
  const kraj = tekst(r.kraj)
  if (kraj && kraj.toUpperCase() !== 'PL') return { adres: null, braki: ['kraj'] }
  const nazwa = tekst(r.imieNazwisko) ?? tekst(r.firma)
  if (!nazwa) braki.push('imie_nazwisko')
  const ulica = tekst(r.ulica)
  const numerDomu = tekst(r.numerDomu)
  if (!ulica) braki.push('ulica')
  if (!numerDomu) braki.push('numer_domu')
  const miejscowosc = tekst(r.miasto)
  if (!miejscowosc) braki.push('miasto')
  const kod = kodPocztowy(r.kodPocztowy)
  if (!kod) braki.push('kod_pocztowy')
  const mobile = telefonOrlen(r.telefon)
  if (!mobile) braki.push(r.telefon ? 'telefon (format)' : 'telefon')
  if (nazwa && nazwa.length > 60) braki.push('imie_nazwisko (za długie)')
  if (braki.length) return { adres: null, braki }
  const firma = tekst(r.firma)
  return {
    adres: { nazwa: nazwa!, nazwa2: firma && firma !== nazwa ? firma.slice(0, 60) : null, ulica: ulica!, numerDomu: numerDomu!, numerLokalu: tekst(r.numerLokalu), miejscowosc: miejscowosc!, kodPocztowy: kod!, kraj: 'Polska', telefon: null, mobile, email: tekst(r.email) },
    braki: [],
  }
}

/** Nadawca z danych firmy (kształt `parseNadawca`). Braki po nazwie pola. */
export function nadawcaPP(n: NadawcaDpd): { adres: AdresPP | null; braki: string[] } {
  const braki: string[] = []
  const a = podzielAdres(n.address)
  if (!a) braki.push('adres (ulica i numer budynku osobno)')
  const kod = kodPocztowy(n.postalCode)
  if (!kod) braki.push('kod pocztowy')
  if (n.countryCode && n.countryCode.toUpperCase() !== 'PL') braki.push('kraj')
  const tel = telefonOrlen(n.phone)
  if (!tel) braki.push('telefon')
  if (braki.length) return { adres: null, braki }
  return {
    adres: { nazwa: n.name.slice(0, 60), nazwa2: null, ulica: a!.ulica, numerDomu: a!.budynek, numerLokalu: a!.lokal, miejscowosc: n.city, kodPocztowy: kod!, kraj: 'Polska', telefon: tel, mobile: tel, email: n.email ?? null },
    braki: [],
  }
}

const FORMATY = new Set<string>(['S', 'M', 'L', 'XL', '2XL'])

/**
 * Element `przesylki` dla `addShipment` (Pocztex Kurier). BLAD i niepotwierdzone ostrzeżenie = wyjątek z kodami.
 * `numerPrzesylkiKlienta` = początek referencji: człowiek znajdzie przesyłkę w eNadawcy po tym numerze.
 */
export function zleceniePP(parcel: PreparedParcel, adresat: AdresPP, nadawca: AdresPP, opts: { reference: string; dataNadania: string; potwierdzoneOstrzezenia?: readonly string[] }): { guid: string; przesylka: Record<string, WezelXml> } {
  const bledy = parcel.problems.filter((p) => p.poziom === 'BLAD')
  if (bledy.length) throw new Error(`przesyłka z błędami: ${bledy.map((p) => p.kod).join(', ')}`)
  const pot = new Set(opts.potwierdzoneOstrzezenia ?? [])
  const nie = parcel.problems.filter((p) => p.poziom === 'OSTRZEZENIE' && !pot.has(p.kod))
  if (nie.length) throw new Error(`niepotwierdzone wartości robocze: ${nie.map((p) => p.kod).join(', ')}`)
  if (!parcel.courierCode || !FORMATY.has(parcel.courierCode)) throw new Error('brak formatu paczki Pocztex (S…2XL)')
  if (parcel.codAmount !== null) throw new Error('pobranie nieobsługiwane w module Poczty Polskiej')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.dataNadania)) throw new Error('zła data nadania')
  const gramy = Math.round((parcel.weightKg ?? 0) * 1000)
  if (gramy <= 0) throw new Error('brak wagi paczki')
  const guid = guidZReferencji(opts.reference)
  return {
    guid,
    przesylka: {
      '@xsi:type': 'tns:pocztex2021KurierType',
      '@guid': guid,
      '@planowanaDataNadania': opts.dataNadania,
      '@numerPrzesylkiKlienta': opts.reference.replace(/[^0-9a-zA-Z]/g, '').slice(0, 20),
      adres: { ...adresat },
      nadawca: { ...nadawca },
      masa: gramy,
      format: parcel.courierCode,
      ponadgabaryt: parcel.courierCode === '2XL',
      uiszczaOplate: 'NADAWCA',
    },
  }
}
