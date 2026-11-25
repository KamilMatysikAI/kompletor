// Treść `generatePackagesNumbers` DPDServices i dane nadawcy firmy. Używają jej tylko testy z danymi
// fikcyjnymi i klucz zapisu `dpd.services.zapis.v1` za wyłącznikiem, którego host dziś nie woła: nic tego wyniku nie
// zapisuje. Wartość robocza (wymiary, waga) i niepotwierdzony salon Empik nie przechodzą bez świadomego potwierdzenia
// w argumencie (ten sam wymóg co `buildCreateOrderPayload`). Odbiorca przychodzi w argumencie: system nie przechowuje
// adresów klientów. Kształt atrybutów usług, kod pocztowy bez kreski i `payerFID` jako liczba: [NIEPEWNE], do demo DPD.
import type { Carrier, Prisma } from '@prisma/client'
import type { PreparedParcel, RecipientAddress } from '../adaptery/kontrakt'
import { parseProfilFirmy } from '../firma/profil'
import { DPD_PICKUP } from './dpd'

/** Nadawca to firma (Organization.settings.nadawca), nie klient. Pola wymagane przez `sender` w API DPD. */
export interface NadawcaDpd {
  name: string
  fullName: string
  address: string
  city: string
  postalCode: string
  countryCode: string
  phone: string
  email: string | null
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const tekst = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** `Organization.settings.nadawca` z surowego JSON (jak `parseKonfiguracjaFaktur`); null + braki = nie da się nadać. */
export function parseNadawca(settings: Prisma.JsonValue | null | undefined): { nadawca: NadawcaDpd | null; braki: string[] } {
  const n = obj(obj(settings)['nadawca'])
  // brakujące pola z profilu firmy (Ustawienia → Dane firmy); `nadawca` zostaje nadpisaniem (np. inny adres nadania)
  const p = parseProfilFirmy(settings)
  const pola = {
    name: tekst(n['name']) ?? p.nazwa,
    address: tekst(n['address']) ?? p.adres?.ulica ?? null,
    city: tekst(n['city']) ?? p.adres?.miasto ?? null,
    postalCode: tekst(n['postalCode']) ?? p.adres?.kodPocztowy ?? null,
    phone: tekst(n['phone']) ?? p.telefon,
  }
  const braki = Object.entries(pola).filter(([, v]) => v === null).map(([k]) => k)
  if (braki.length) return { nadawca: null, braki }
  return {
    nadawca: {
      name: pola.name!,
      fullName: tekst(n['fullName']) ?? pola.name!,
      address: pola.address!,
      city: pola.city!,
      postalCode: pola.postalCode!,
      countryCode: tekst(n['countryCode']) ?? p.adres?.kodKraju ?? 'PL',
      phone: pola.phone!,
      email: tekst(n['email']) ?? p.email,
    },
    braki: [],
  }
}

export interface UstawieniaZleceniaDpd {
  /** FID płatnika; dla salonu Empik osobny (`empikPayerFid`), gdy firma go ma. */
  payerFid: string
  /** Klucz idempotencji od hosta (pole `reference`, do 50 znaków). */
  reference: string
  potwierdzoneOstrzezenia?: readonly string[]
}

/**
 * Salon Empik po przewoźniku zamówienia. Wcześniej rozpoznawany po ostrzeżeniu
 * `empik_niepotwierdzone`, co gubiło FID Empik, gdy host zdejmie potwierdzone ostrzeżenia z listy.
 */
export function czyEmpik(carrier: Carrier): boolean {
  return carrier === 'DPD_EMPIK'
}

/**
 * Odbiorca w treści DPD. Wymagane tylko to, czego wymaga API: `receiver` = nazwa, adres, miasto,
 * kod (kraj stały PL); `pudoReceiver` = nazwa (kraj stały PL). Numer domu, telefon i e-mail opcjonalne: Allegro i Woo
 * dają ulicę z numerem w jednej linii (`numerDomu: null`), a DPD przyjmuje cały adres w jednym polu.
 */
export interface OdbiorcaDpd {
  nazwa: string
  firma: string | null
  ulica: string | null
  numerDomu: string | null
  numerLokalu: string | null
  kodPocztowy: string | null
  miasto: string | null
  telefon: string | null
  email: string | null
}

/** Z adresu kanału na odbiorcę DPD; braki tylko nazwami pól, kraj ≠ PL = brak `kraj` (moduł krajowy). */
export function odbiorcaDpd(r: Readonly<RecipientAddress>, punkt: boolean): { odbiorca: OdbiorcaDpd; braki: [] } | { odbiorca: null; braki: string[] } {
  const kraj = tekst(r.kraj)
  if (kraj && kraj.toUpperCase() !== 'PL') return { odbiorca: null, braki: ['kraj'] }
  const o: OdbiorcaDpd = {
    nazwa: tekst(r.imieNazwisko) ?? tekst(r.firma) ?? '',
    firma: tekst(r.firma),
    ulica: tekst(r.ulica),
    numerDomu: tekst(r.numerDomu),
    numerLokalu: tekst(r.numerLokalu),
    kodPocztowy: tekst(r.kodPocztowy),
    miasto: tekst(r.miasto),
    telefon: tekst(r.telefon),
    email: tekst(r.email),
  }
  const braki: string[] = []
  if (!o.nazwa) braki.push('imieNazwisko')
  if (!punkt) {
    if (!o.ulica) braki.push('ulica')
    if (!o.kodPocztowy) braki.push('kodPocztowy')
    if (!o.miasto) braki.push('miasto')
  }
  return braki.length ? { odbiorca: null, braki } : { odbiorca: o, braki: [] }
}

const kodPocztowy = (v: string) => v.replace(/[^0-9A-Za-z]/g, '')

/** DPDServices przyjmuje wagę najwyżej z dwoma miejscami po przecinku (schemat `Parcel.weight`: „Accuracy to two
 * decimal places”); trzecie miejsce kończy się HTTP 400 (`packages[0].parcels[0].weight`, 0,144 kg).
 * W górę do 10 g, bo paczka nie może być zgłoszona jako lżejsza, niż jest. */
export const wagaDoDpd = (kg: number): number => Math.ceil(Math.round(kg * 1000) / 10) / 100

export function buildPackagesPayload(parcel: PreparedParcel, recipient: OdbiorcaDpd, nadawca: NadawcaDpd, ustawienia: UstawieniaZleceniaDpd): Record<string, unknown> {
  const potwierdzone = ustawienia.potwierdzoneOstrzezenia ?? []
  const bledy = parcel.problems.filter((p) => p.poziom === 'BLAD' || !potwierdzone.includes(p.kod))
  if (bledy.length) throw new Error(`Przesyłka nie jest gotowa: ${bledy.map((p) => p.kod).join(', ')}`)
  if (!/^\d{1,10}$/.test(ustawienia.payerFid)) throw new Error('Zły numer FID płatnika DPD')
  if (!ustawienia.reference || ustawienia.reference.length > 50) throw new Error('Referencja przesyłki DPD: od 1 do 50 znaków')
  if (parcel.sideXCm === null || parcel.sideYCm === null || parcel.sideZCm === null || parcel.weightKg === null) throw new Error('Przesyłka nie jest gotowa: brak wymiarów albo wagi')
  const punkt = parcel.courierCode === DPD_PICKUP
  if (punkt && !parcel.pickupPoint) throw new Error('Przesyłka nie jest gotowa: punkt')

  if (!recipient.nazwa) throw new Error('Przesyłka nie jest gotowa: odbiorca')
  if (!punkt && (!recipient.ulica || !recipient.kodPocztowy || !recipient.miasto)) throw new Error('Przesyłka nie jest gotowa: adres odbiorcy')
  // Numer domu osobno tylko, gdy kanał go podał; inaczej ulica niesie cały adres (`adres_bez_podzialu`)
  const numer = recipient.numerDomu ? ` ${recipient.numerDomu}${recipient.numerLokalu ? `/${recipient.numerLokalu}` : ''}` : ''
  const adres = `${recipient.ulica ?? ''}${numer}`
  const kontakt = { ...(recipient.telefon ? { phone: recipient.telefon } : {}), ...(recipient.email ? { email: recipient.email } : {}) }
  const services: { code: string; attributes: { code: string; value: string }[] }[] = []
  if (punkt) services.push({ code: 'DPD_PICKUP', attributes: [{ code: 'PUDO', value: parcel.pickupPoint! }] })
  if (parcel.codAmount !== null) services.push({ code: 'COD', attributes: [{ code: 'AMOUNT', value: parcel.codAmount.toFixed(2) }, { code: 'CURRENCY', value: 'PLN' }] })

  const pkg: Record<string, unknown> = {
    reference: ustawienia.reference,
    payerFID: Number(ustawienia.payerFid),
    sender: {
      name: nadawca.name,
      fullName: nadawca.fullName,
      address: nadawca.address,
      city: nadawca.city,
      postalCode: kodPocztowy(nadawca.postalCode),
      countryCode: nadawca.countryCode,
      phone: nadawca.phone,
      ...(nadawca.email ? { email: nadawca.email } : {}),
    },
    parcels: [{ weight: wagaDoDpd(parcel.weightKg), sizeX: parcel.sideXCm, sizeY: parcel.sideYCm, sizeZ: parcel.sideZCm }],
    ...(services.length ? { services } : {}),
  }
  if (punkt) {
    pkg['pudoReceiver'] = { countryCode: 'PL', name: recipient.nazwa, ...(recipient.firma ? { company: recipient.firma } : {}), ...kontakt }
  } else {
    pkg['receiver'] = {
      ...(recipient.firma ? { company: recipient.firma } : {}),
      name: recipient.nazwa,
      address: adres,
      city: recipient.miasto,
      postalCode: kodPocztowy(recipient.kodPocztowy!),
      countryCode: 'PL',
      ...kontakt,
    }
  }
  return { generationPolicy: 'ALL_OR_NOTHING', packages: [pkg] }
}
