// Profil firmy: jedno miejsce na dane firmy w `Organization.settings.firma`.
// Czytają go: KSeF (sprzedawca, lib/ksef/konfiguracja.ts), nadawca przesyłek (lib/wysylka/zlecenie-dpd.ts), maile
// (`firma.*` w lib/maile) i wydruki. Stare klucze (`ksef.sprzedawca`, `nadawca`) zostają nadpisaniem, gdy są ustawione
// (zgodność z presetami firm sprzed profilu). Strefa czasowa i waluta tylko do odczytu na start (PLN, Europe/Warsaw).
// Logo: osobna paczka (upload tylko przez osłonę uploadu, której repo jeszcze nie ma) — tu jedynie pole na adres.
import type { Prisma } from '@prisma/client'
import { poprawnyNip } from '../ksef/fa3/builder'

export interface AdresFirmy {
  /** Ulica i numer. */
  ulica: string
  kodPocztowy: string
  miasto: string
  /** ISO 3166-1 alfa-2, domyślnie PL. */
  kodKraju: string
}

export interface ProfilFirmy {
  nazwa: string | null
  nip: string | null
  adres: AdresFirmy | null
  /** Adres kontaktowy dla klientów (stopka maili, wydruki). */
  email: string | null
  /** Adres biura: alerty i maile wewnętrzne (np. błąd faktury). */
  emailBiura: string | null
  telefon: string | null
  /** Rachunek bankowy (NRB albo IBAN), bez spacji. */
  rachunek: string | null
  strefaCzasowa: string
  waluta: string
}

/** Ustawienia w `Organization.settings.firma` (wszystko opcjonalne). */
export interface UstawieniaFirmy {
  nazwa?: string
  nip?: string
  adres?: { ulica?: string; kodPocztowy?: string; miasto?: string; kodKraju?: string }
  email?: string
  emailBiura?: string
  telefon?: string
  rachunek?: string
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const tekst = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : null)

export function parseProfilFirmy(settings: Prisma.JsonValue | null | undefined): ProfilFirmy {
  const f = obj(obj(settings)['firma'])
  const a = obj(f['adres'])
  const ulica = tekst(a['ulica'])
  const kod = tekst(a['kodPocztowy'])
  const miasto = tekst(a['miasto'])
  return {
    nazwa: tekst(f['nazwa']),
    nip: tekst(f['nip']),
    adres: ulica && kod && miasto ? { ulica, kodPocztowy: kod, miasto, kodKraju: tekst(a['kodKraju']) ?? 'PL' } : null,
    email: tekst(f['email']),
    emailBiura: tekst(f['emailBiura']),
    telefon: tekst(f['telefon']),
    rachunek: tekst(f['rachunek'])?.replace(/\s/g, '') ?? null,
    strefaCzasowa: 'Europe/Warsaw',
    waluta: 'PLN',
  }
}

export class ProfilFirmyError extends Error {}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const KOD_PL_RE = /^\d{2}-\d{3}$/
const TELEFON_RE = /^\+?[0-9 ()-]{6,20}$/
const KRAJ_RE = /^[A-Z]{2}$/

/** Rachunek: 26 cyfr (NRB) albo IBAN (2 litery + 2 cyfry kontrolne + do 30 znaków), suma kontrolna mod 97. */
export function poprawnyRachunek(v: string): boolean {
  const s = v.replace(/\s/g, '').toUpperCase()
  const iban = /^\d{26}$/.test(s) ? `PL${s}` : s
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false
  const przest = iban.slice(4) + iban.slice(0, 4)
  let r = 0
  for (const ch of przest) {
    const n = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of n) r = (r * 10 + Number(d)) % 97
  }
  return r === 1
}

/**
 * Walidacja formularza „Dane firmy”. Puste pole = brak wartości (profil może być niepełny: zapis częściowy jest OK,
 * braki pokaże lista kontrolna). Zwraca ustawienia do zapisu albo rzuca ProfilFirmyError z komunikatem dla ekranu.
 */
export function walidujProfil(input: Record<string, string>): UstawieniaFirmy {
  const v = (k: string, max: number, nazwa: string): string | undefined => {
    const t = tekst(input[k])
    if (!t) return undefined
    if (t.length > max) throw new ProfilFirmyError(`${nazwa}: najwyżej ${max} znaków`)
    return t
  }
  const nazwa = v('nazwa', 200, 'Nazwa firmy')
  const nip = v('nip', 20, 'NIP')?.replace(/[\s-]/g, '')
  if (nip && !poprawnyNip(nip)) throw new ProfilFirmyError('NIP jest niepoprawny (sprawdź cyfry)')
  const ulica = v('ulica', 200, 'Ulica i numer')
  const kodPocztowy = v('kodPocztowy', 12, 'Kod pocztowy')
  const miasto = v('miasto', 100, 'Miasto')
  const kodKraju = (v('kodKraju', 2, 'Kraj') ?? 'PL').toUpperCase()
  if (!KRAJ_RE.test(kodKraju)) throw new ProfilFirmyError('Kraj: dwuliterowy kod, np. PL')
  if (kodPocztowy && kodKraju === 'PL' && !KOD_PL_RE.test(kodPocztowy)) throw new ProfilFirmyError('Kod pocztowy w formacie 00-000')
  const email = v('email', 254, 'E-mail')
  if (email && !EMAIL_RE.test(email)) throw new ProfilFirmyError('E-mail kontaktowy jest niepoprawny')
  const emailBiura = v('emailBiura', 254, 'E-mail biura')
  if (emailBiura && !EMAIL_RE.test(emailBiura)) throw new ProfilFirmyError('E-mail biura jest niepoprawny')
  const telefon = v('telefon', 20, 'Telefon')
  if (telefon && !TELEFON_RE.test(telefon)) throw new ProfilFirmyError('Telefon: cyfry, spacje, +, nawiasy, myślnik')
  const rachunek = v('rachunek', 40, 'Rachunek')?.replace(/\s/g, '')
  if (rachunek && !poprawnyRachunek(rachunek)) throw new ProfilFirmyError('Numer rachunku jest niepoprawny (sprawdź cyfry)')
  const adres = ulica || kodPocztowy || miasto ? { ...(ulica ? { ulica } : {}), ...(kodPocztowy ? { kodPocztowy } : {}), ...(miasto ? { miasto } : {}), kodKraju } : undefined
  return {
    ...(nazwa ? { nazwa } : {}),
    ...(nip ? { nip } : {}),
    ...(adres ? { adres } : {}),
    ...(email ? { email } : {}),
    ...(emailBiura ? { emailBiura } : {}),
    ...(telefon ? { telefon } : {}),
    ...(rachunek ? { rachunek } : {}),
  }
}

/** Braki profilu do listy kontrolnej i ekranu (nazwy pól po polsku). */
export function brakiProfilu(p: ProfilFirmy): string[] {
  const b: string[] = []
  if (!p.nazwa) b.push('nazwa firmy')
  if (!p.nip) b.push('NIP')
  if (!p.adres) b.push('adres (ulica, kod pocztowy, miasto)')
  if (!p.emailBiura) b.push('e-mail biura')
  if (!p.telefon) b.push('telefon')
  return b
}

/** Dane firmy do stopki maili (lib/maile/typy.ts `DaneFirmy`); bez nazwy w profilu — nazwa firmy w systemie. */
export function daneFirmyDoMaila(p: ProfilFirmy, nazwaWSystemie: string): { nazwa: string; adres: string[]; nip: string | null; email: string | null; telefon: string | null; emailBiura: string | null } {
  return {
    nazwa: p.nazwa ?? nazwaWSystemie,
    adres: p.adres ? [p.adres.ulica, `${p.adres.kodPocztowy} ${p.adres.miasto}`] : [],
    nip: p.nip,
    email: p.email,
    telefon: p.telefon,
    emailBiura: p.emailBiura,
  }
}
