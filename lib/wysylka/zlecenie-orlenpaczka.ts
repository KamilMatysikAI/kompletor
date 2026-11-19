// Treść `GenerateBusinessPack` Orlen Paczki i odcisk referencji. Kod własny; nazwy pól z dokumentacji
// „API ORLEN Paczka v1.26.004” (pkt 4.2), mapowanie pól nadawcy i odbiorcy podpatrzone w konektorze Open Integration
// Platform (integrators/courier/orlenpaczka/v1.0.0/src/integration.py, ae43d1e, Apache-2.0). Używa go tylko klucz
// zapisu `orlenpaczka.zapis.v1` za wyłącznikiem i testy z danymi fikcyjnymi: nic z tego nie trafia do bazy ani logów.
//
// Różnice wobec OIP (dokumentacja 1.26 jest nowsza): bez pobrania i ubezpieczenia (usługi wycofane), BoxSize S/M/L
// zamiast A, referencja Kompletora w `SenderOrders` (u nich numer zamówienia; pole drukuje się na etykiecie).
// Limity długości pól [NIEPEWNE: kolumny tabeli w PDF dokumentacji są przesunięte, do sprawdzenia na sandboxie].
import type { PreparedParcel, RecipientAddress } from '../adaptery/kontrakt'
import type { ParametrSoap } from '../zrodla/orlenpaczka'
import type { NadawcaDpd } from './zlecenie-dpd'
import { kodPunktuOrlen } from './orlenpaczka'

/**
 * Odcisk referencji hosta w `SenderOrders` (30 znaków): „KMP” + 27 znaków skrótu referencji bez kresek. Drukuje się na
 * etykiecie, więc odszukanie po referencji (lib/adaptery/orlenpaczka.ts) szuka go w etykiecie ZPL paczki.
 */
export function odciskReferencji(reference: string): string {
  const czysty = reference.toLowerCase().replace(/[^0-9a-z]/g, '')
  if (czysty.length < 16) throw new Error('referencja przesyłki za krótka na odcisk Orlen Paczki')
  return `KMP${czysty.slice(0, 27)}`.toUpperCase()
}

const tekst = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : null)

/** Telefon w formacie Orlenu: 9 cyfr bez +48 (dokumentacja dopuszcza też 12 znaków z +48). null = zły numer. */
export function telefonOrlen(v: string | null | undefined): string | null {
  const s = (v ?? '').replace(/[\s()-]/g, '')
  const m = /^(?:\+48|0048|48)?(\d{9})$/.exec(s)
  return m ? m[1]! : null
}

export const LIMITY_POL = { imie: 30, nazwisko: 30, firma: 70, email: 60, ulica: 30, budynek: 10, lokal: 10, miasto: 30 } as const

export interface OdbiorcaOrlen {
  FirstName: string | null
  LastName: string | null
  CompanyName: string | null
  PhoneNumber: string
  EMail: string | null
}

/**
 * Odbiorca do punktu: imię i nazwisko albo firma oraz telefon (Orlen wysyła SMS z kodem odbioru); adres nie jest
 * potrzebny. Imię i nazwisko z jednego pola: ostatnie słowo = nazwisko. Braki i za długie pola po nazwie, bez wartości.
 */
export function odbiorcaOrlen(r: Readonly<RecipientAddress>): { odbiorca: OdbiorcaOrlen | null; braki: string[] } {
  const braki: string[] = []
  const kraj = tekst(r.kraj)
  if (kraj && kraj.toUpperCase() !== 'PL') return { odbiorca: null, braki: ['kraj'] }
  const firma = tekst(r.firma)
  const slowa = (tekst(r.imieNazwisko) ?? '').split(' ').filter(Boolean)
  let FirstName: string | null = null
  let LastName: string | null = null
  if (slowa.length >= 2) {
    LastName = slowa[slowa.length - 1]!
    FirstName = slowa.slice(0, -1).join(' ')
  } else if (!firma) braki.push(slowa.length === 1 ? 'imie_nazwisko (jedno słowo)' : 'imie_nazwisko')
  const PhoneNumber = telefonOrlen(r.telefon)
  if (!r.telefon) braki.push('telefon')
  else if (!PhoneNumber) braki.push('telefon (format)')
  const EMail = tekst(r.email)
  if (FirstName && FirstName.length > LIMITY_POL.imie) braki.push('imie (za długie)')
  if (LastName && LastName.length > LIMITY_POL.nazwisko) braki.push('nazwisko (za długie)')
  if (firma && firma.length > LIMITY_POL.firma) braki.push('firma (za długa)')
  if (EMail && EMail.length > LIMITY_POL.email) braki.push('email (za długi)')
  if (braki.length) return { odbiorca: null, braki }
  return { odbiorca: { FirstName, LastName, CompanyName: firma, PhoneNumber: PhoneNumber!, EMail }, braki: [] }
}

export interface NadawcaOrlen {
  SenderCompanyName: string
  SenderStreetName: string
  SenderBuildingNumber: string
  SenderFlatNumber: string | null
  SenderCity: string
  SenderPostCode: string
  SenderPhoneNumber: string
  SenderEMail: string
}

/**
 * Adres nadawcy w jednej linii („ul. Magazynowa 5/2”, „Prosta 12A m. 3”) na ulicę, budynek i lokal. Bez zgadywania:
 * linia bez numeru na końcu = null (firma ustawia numer w Dane firmy).
 */
export function podzielAdres(linia: string): { ulica: string; budynek: string; lokal: string | null } | null {
  const s = linia.trim().replace(/\s+/g, ' ').replace(/^(ul\.|ulica)\s+/i, '')
  const m = /^(.*?\D)\s+(\d+[A-Za-z]?)(?:\s*\/\s*(\d+[A-Za-z]?)|\s+(?:m\.?|lok\.?)\s*(\d+[A-Za-z]?))?$/.exec(s)
  if (!m || !m[1]!.trim()) return null
  return { ulica: m[1]!.trim(), budynek: m[2]!, lokal: m[3] ?? m[4] ?? null }
}

/** Nadawca Orlenu z danych firmy (ten sam kształt co dla DPD: `parseNadawca`). Braki po nazwie pola. */
export function nadawcaOrlen(n: NadawcaDpd): { nadawca: NadawcaOrlen | null; braki: string[] } {
  const braki: string[] = []
  const a = podzielAdres(n.address)
  if (!a) braki.push('adres (ulica i numer budynku osobno)')
  const tel = telefonOrlen(n.phone)
  if (!tel) braki.push('telefon')
  if (!n.email) braki.push('email')
  const kod = /^\d{2}-\d{3}$/.test(n.postalCode.trim()) ? n.postalCode.trim() : /^\d{5}$/.test(n.postalCode.trim()) ? `${n.postalCode.trim().slice(0, 2)}-${n.postalCode.trim().slice(2)}` : null
  if (!kod) braki.push('kod pocztowy')
  if (n.countryCode && n.countryCode.toUpperCase() !== 'PL') braki.push('kraj')
  if (a && a.ulica.length > LIMITY_POL.ulica) braki.push('ulica (za długa)')
  if (n.city.length > LIMITY_POL.miasto) braki.push('miasto (za długie)')
  if (n.name.length > LIMITY_POL.firma) braki.push('nazwa (za długa)')
  if (braki.length) return { nadawca: null, braki }
  return {
    nadawca: { SenderCompanyName: n.name, SenderStreetName: a!.ulica, SenderBuildingNumber: a!.budynek, SenderFlatNumber: a!.lokal, SenderCity: n.city, SenderPostCode: kod!, SenderPhoneNumber: tel!, SenderEMail: n.email! },
    braki: [],
  }
}

/**
 * Parametry `GenerateBusinessPack` (bez PartnerID i PartnerKey: dokłada je klient). Problem BLAD i ostrzeżenie bez
 * potwierdzenia człowieka = wyjątek z kodami (jak `buildPackagesPayload` DPD). Bez pól pobrania i ubezpieczenia.
 */
export function zlecenieOrlen(parcel: PreparedParcel, o: OdbiorcaOrlen, n: NadawcaOrlen, opts: { reference: string; potwierdzoneOstrzezenia?: readonly string[] }): Record<string, ParametrSoap> {
  const bledy = parcel.problems.filter((p) => p.poziom === 'BLAD')
  if (bledy.length) throw new Error(`przesyłka z błędami: ${bledy.map((p) => p.kod).join(', ')}`)
  const pot = new Set(opts.potwierdzoneOstrzezenia ?? [])
  const nie = parcel.problems.filter((p) => p.poziom === 'OSTRZEZENIE' && !pot.has(p.kod))
  if (nie.length) throw new Error(`niepotwierdzone wartości robocze: ${nie.map((p) => p.kod).join(', ')}`)
  const punkt = kodPunktuOrlen(parcel.pickupPoint)
  if (!punkt) throw new Error('brak kodu punktu Orlen Paczki')
  if (parcel.courierCode !== 'S' && parcel.courierCode !== 'M' && parcel.courierCode !== 'L') throw new Error('brak rozmiaru paczki S, M albo L')
  if (parcel.codAmount !== null) throw new Error('Orlen Paczka nie obsługuje pobrania')
  return {
    DestinationCode: punkt,
    BoxSize: parcel.courierCode,
    EMail: o.EMail,
    FirstName: o.FirstName,
    LastName: o.LastName,
    CompanyName: o.CompanyName,
    PhoneNumber: o.PhoneNumber,
    SenderEMail: n.SenderEMail,
    SenderCompanyName: n.SenderCompanyName,
    SenderStreetName: n.SenderStreetName,
    SenderBuildingNumber: n.SenderBuildingNumber,
    SenderFlatNumber: n.SenderFlatNumber,
    SenderCity: n.SenderCity,
    SenderPostCode: n.SenderPostCode,
    SenderPhoneNumber: n.SenderPhoneNumber,
    SenderOrders: odciskReferencji(opts.reference),
    PrintAdress: '1',
  }
}
