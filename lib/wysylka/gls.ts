// Przesyłka GLS przez ADE: liczenie „przygotuj, nie wysyłaj” (czyste funkcje, bez bazy i sieci) i treść
// `adePreparingBox_Insert` dla klucza zapisu za wyłącznikiem. Nazwy pól przesyłki (rname1…rcontact, references, date,
// sendaddr, srv_bool z `cod`/`cod_amount`/`sds`, srv_sds, parcels.items.weight) podpatrzone w konektorze Open
// Integration Platform (integrators/courier/gls/v1.0.0/src/integration.py, ae43d1e, Apache-2.0); kod napisany od nowa.
// Różnice: referencja Kompletora (odcisk) w `references` zamiast treści paczki, bez usług dodatkowych poza pobraniem i
// punktem GLS, walidacja przed wysyłką. Limity pól i wagi [NIEPEWNE: do potwierdzenia na koncie testowym ADE].
// Odbiorca przychodzi w argumencie i nie trafia do bazy ani logów.
import type { PreparedParcel, RecipientAddress, ShipmentInput, ShipmentProblem } from '../adaptery/kontrakt'
import type { WartoscSoap } from '../zrodla/gls'
import { kwotaPobrania, ustawieniaPrzesylki, waga, type UstawieniaPrzesylki } from './przesylka'
import type { NadawcaDpd } from './zlecenie-dpd'

export const GLS_KURIER = 'GLS_KURIER'
/** Doręczenie do punktu GLS (usługa SDS, ParcelShop) z kodem punktu z zamówienia. */
export const GLS_PUNKT = 'GLS_SDS'
/** Waga jednej paczki: standard GLS do 31,5 kg [NIEPEWNE: wg umowy], minimum ADE 0,01 kg. */
export const LIMIT_WAGI_GLS_G = 31_500
export const WAGA_MIN_GLS_G = 10
/** Pobranie: domyślny limit [NIEPEWNE: wg umowy], firma zmienia go w ustawieniu konta `codLimit`. */
export const LIMIT_POBRANIA_GLS = 10_000
/** Najwięcej paczek w jednej przesyłce ADE (pole `quantity`) [NIEPEWNE]. */
export const MAX_PACZEK_GLS = 20

export interface UstawieniaGls extends UstawieniaPrzesylki {
  codLimit: number
}

const blad = (kod: string, tekst: string): ShipmentProblem => ({ kod, poziom: 'BLAD', tekst })

export function ustawieniaGls(config: Readonly<Record<string, unknown>>): UstawieniaGls {
  const u = ustawieniaPrzesylki(config)
  const v = config['codLimit']
  if (v === undefined || v === null || v === '') return { ...u, codLimit: LIMIT_POBRANIA_GLS }
  const n = typeof v === 'number' ? v : Number(v)
  if (Number.isFinite(n) && n > 0 && n <= 1_000_000) return { ...u, codLimit: n }
  return { ...u, codLimit: LIMIT_POBRANIA_GLS, problemy: [...u.problemy, blad('ustawienie', 'Zła wartość ustawienia codLimit: popraw konfigurację przewoźnika GLS.')] }
}

/** Parametry przesyłki GLS z danych zamówienia; problem BLAD = nie do nadania. Bez danych odbiorcy. */
export function wyliczPrzesylkeGls(input: ShipmentInput, u: UstawieniaGls): PreparedParcel {
  const problems: ShipmentProblem[] = [...u.problemy]
  if (input.carrier !== 'GLS') problems.push(blad('przewoznik', 'Moduł GLS obsługuje tylko przewoźnika „GLS”: sprawdź regułę przewoźnika.'))
  const punkt = input.pickupPoint?.trim() || null
  if (punkt && !/^[A-Za-z0-9-]{3,20}$/.test(punkt)) problems.push(blad('punkt_format', 'Punkt odbioru nie wygląda jak kod punktu GLS (ParcelShop): sprawdź punkt na karcie zamówienia.'))
  const w = waga(input, u)
  problems.push(...w.problemy)
  if (w.gramy < WAGA_MIN_GLS_G) problems.push(blad('waga_zakres', `Paczka waży ${w.gramy / 1000} kg, GLS przyjmuje od ${WAGA_MIN_GLS_G / 1000} kg.`))
  if (w.gramy > LIMIT_WAGI_GLS_G) problems.push(blad('waga_limit', `Paczka waży ${w.gramy / 1000} kg, limit paczki GLS to ${LIMIT_WAGI_GLS_G / 1000} kg.`))
  const pob = kwotaPobrania({ paymentState: input.paymentState, paymentMethod: input.paymentMethod, totalGross: input.totalGross, kwotaNiepewna: input.codAmountUncertain })
  problems.push(...pob.problemy)
  if (pob.kwota !== null && pob.kwota > u.codLimit) problems.push(blad('pobranie_limit', `Pobranie ${pob.kwota} zł przekracza limit ${u.codLimit} zł.`))
  // ADE przyjmuje samą kwotę pobrania, w złotych
  const waluta = input.currency?.trim().toUpperCase()
  if (pob.kwota !== null && waluta && waluta !== 'PLN') problems.push(blad('pobranie_waluta', `Zamówienie jest w walucie ${waluta}, a GLS pobiera tylko złote: rozlicz zamówienie bez pobrania albo nadaj je innym przewoźnikiem.`))
  return {
    courierCode: punkt ? GLS_PUNKT : GLS_KURIER,
    gabaryt: input.gabaryt,
    sideXCm: u.sideXCm,
    sideYCm: u.sideYCm,
    sideZCm: u.sideZCm,
    weightKg: w.gramy / 1000,
    codAmount: pob.kwota,
    pickupPoint: punkt,
    problems,
  }
}

/**
 * Odcisk referencji hosta w polu `references` przesyłki ADE (25 znaków: „KMP” + 22 znaki referencji bez kresek). Po nim
 * adapter odszukuje przygotowanie albo nadaną przesyłkę i nigdy nie wstawia drugiej dla tej samej referencji.
 */
export function odciskGls(reference: string): string {
  const czysty = reference.toLowerCase().replace(/[^0-9a-z]/g, '')
  if (czysty.length < 16) throw new Error('referencja przesyłki za krótka na odcisk GLS')
  return `KMP${czysty.slice(0, 22)}`.toUpperCase()
}

const tekst = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null)
const kodPocztowy = (v: string) => v.replace(/[^0-9A-Za-z]/g, '')
const dzienPl = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

export interface OdbiorcaGls {
  rname1: string
  rname2: string | null
  rcountry: string
  rzipcode: string
  rcity: string
  rstreet: string
  rphone: string | null
  rcontact: string | null
}

/** Odbiorca ADE z adresu kanału: nazwa, ulica, kod i miasto wymagane (kurier i punkt); braki tylko nazwami pól. */
export function odbiorcaGls(r: Readonly<RecipientAddress>): { odbiorca: OdbiorcaGls | null; braki: string[] } {
  const kraj = (tekst(r.kraj, 2) ?? 'PL').toUpperCase()
  if (kraj !== 'PL') return { odbiorca: null, braki: ['kraj'] }
  const osoba = tekst(r.imieNazwisko, 40)
  const firma = tekst(r.firma, 40)
  const ulica = tekst(r.ulica, 50)
  const nr = [tekst(r.numerDomu, 10), tekst(r.numerLokalu, 10)].filter(Boolean).join('/')
  const kod = r.kodPocztowy ? kodPocztowy(r.kodPocztowy) : ''
  const miasto = tekst(r.miasto, 30)
  const braki: string[] = []
  if (!osoba && !firma) braki.push('imieNazwisko')
  if (!ulica) braki.push('ulica')
  if (!/^\d{5}$/.test(kod)) braki.push('kodPocztowy')
  if (!miasto) braki.push('miasto')
  if (braki.length) return { odbiorca: null, braki }
  return {
    odbiorca: {
      rname1: (osoba ?? firma)!,
      rname2: osoba && firma ? firma : null,
      rcountry: 'PL',
      rzipcode: kod,
      rcity: miasto!,
      rstreet: nr ? `${ulica} ${nr}`.slice(0, 50) : ulica!,
      rphone: tekst(r.telefon, 20),
      rcontact: tekst(r.email, 60),
    },
    braki: [],
  }
}

export interface ZlecenieGls {
  /** Odcisk referencji (`references`). */
  odcisk: string
  dane: Record<string, WartoscSoap>
  /**
   * Pola porównywane z przygotowaniem z poprzedniej próby przed jego dokończeniem:
   * `punkt` = kod punktu GLS (`srv_sds.id`), null = kurier pod adres.
   */
  kontrolne: { kod: string; ulica: string; punkt: string | null; pobranie: number; waga: number; data: string }
}

const kwota = (n: number) => n.toFixed(2)

/**
 * Treść `consign_prep_data` dla `adePreparingBox_Insert`. `wagiKg` = waga każdej paczki przesyłki (wielopaczkowa =
 * kilka wartości). Wartość robocza (waga domyślna) i inne ostrzeżenia blokują nadanie, chyba że człowiek je potwierdził.
 * Kwoty i wagi jako tekst z dwoma miejscami po przecinku; pobranie ≤ 0, nieskończone albo ponad `codLimit` = błąd.
 */
export function zlecenieGls(parcel: PreparedParcel, odbiorca: OdbiorcaGls, nadawca: NadawcaDpd, o: { reference: string; teraz: Date; wagiKg?: readonly number[]; potwierdzoneOstrzezenia?: readonly string[]; codLimit?: number }): ZlecenieGls {
  const bledy = parcel.problems.filter((p) => p.poziom === 'BLAD')
  if (bledy.length) throw new Error(`przesyłka ma błędy: ${bledy.map((p) => p.kod).join(', ')}`)
  const ok = new Set(o.potwierdzoneOstrzezenia ?? [])
  const niepotwierdzone = parcel.problems.filter((p) => p.poziom === 'OSTRZEZENIE' && !ok.has(p.kod))
  if (niepotwierdzone.length) throw new Error(`niepotwierdzone ostrzeżenia: ${niepotwierdzone.map((p) => p.kod).join(', ')}`)
  const wagi = o.wagiKg?.length ? [...o.wagiKg] : [parcel.weightKg ?? 0]
  if (wagi.length > MAX_PACZEK_GLS) throw new Error(`najwyżej ${MAX_PACZEK_GLS} paczek w jednej przesyłce GLS`)
  if (wagi.some((w) => !Number.isFinite(w) || w * 1000 < WAGA_MIN_GLS_G || w * 1000 > LIMIT_WAGI_GLS_G)) throw new Error(`waga każdej paczki GLS od ${WAGA_MIN_GLS_G / 1000} do ${LIMIT_WAGI_GLS_G / 1000} kg`)
  const cod = parcel.codAmount
  const codLimit = o.codLimit ?? LIMIT_POBRANIA_GLS
  if (cod !== null && (!Number.isFinite(cod) || cod <= 0 || cod > codLimit)) throw new Error(`kwota pobrania GLS musi być większa od zera i nie większa niż ${codLimit} zł`)
  const odcisk = odciskGls(o.reference)
  const punkt = parcel.courierCode === GLS_PUNKT ? parcel.pickupPoint : null
  const waga = Math.round(wagi.reduce((s, w) => s + w, 0) * 100) / 100
  const data = dzienPl(o.teraz)
  const dane: Record<string, WartoscSoap> = {
    ...odbiorca,
    references: odcisk,
    notes: '',
    quantity: wagi.length,
    weight: kwota(waga),
    date: data,
    sendaddr: {
      name1: nadawca.name.slice(0, 40),
      name2: nadawca.fullName !== nadawca.name ? nadawca.fullName.slice(0, 40) : '',
      country: (nadawca.countryCode || 'PL').toUpperCase(),
      zipcode: kodPocztowy(nadawca.postalCode),
      city: nadawca.city.slice(0, 30),
      street: nadawca.address.slice(0, 50),
    },
    srv_bool: { cod: cod !== null, cod_amount: kwota(cod ?? 0), sds: !!punkt },
    ...(punkt ? { srv_sds: { id: punkt } } : {}),
    parcels: wagi.map((w) => ({ reference: odcisk, weight: kwota(w) })),
  }
  return { odcisk, dane, kontrolne: { kod: odbiorca.rzipcode, ulica: odbiorca.rstreet, punkt, pobranie: Math.round((cod ?? 0) * 100) / 100, waga, data } }
}
