// Formularz „Wpisz dane klienta” dla zamówień ręcznych: walidacja kodu pocztowego PL (NN-NNN), e-maila,
// telefonu i NIP-u z sumą kontrolną. Komunikaty mówią, które pole jest złe, nigdy nie powtarzają wartości.
import { poprawnyNip } from '../ksef/fa3/builder'
import type { RekordKlienta } from './rekord'
import { normalizujTelefon } from './skroty'

export class BladFormularzaKlienta extends Error {}

const KOD_PL = /^\d{2}-\d{3}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Pola formularza „Wpisz dane klienta” (nazwy jak w `name` inputów karty i formularza „Dodaj zamówienie”). */
export const POLA_KLIENTA = ['imie', 'firma', 'ulica', 'dom', 'lokal', 'kod', 'miasto', 'kraj', 'telefon', 'email', 'punkt', 'punkt_nazwa', 'f_nazwa', 'f_nip', 'f_ulica', 'f_kod', 'f_miasto', 'uwagi'] as const
export type PoleKlienta = (typeof POLA_KLIENTA)[number]
export type DaneKlientaWe = Partial<Record<PoleKlienta, string | null | undefined>>

const MAX: Partial<Record<PoleKlienta, number>> = { dom: 20, lokal: 20, kod: 10, kraj: 2, telefon: 30, punkt: 40, f_nip: 20, f_kod: 10, uwagi: 1000 }
const ETYKIETA: Record<PoleKlienta, string> = {
  imie: 'Imię i nazwisko',
  firma: 'Firma',
  ulica: 'Ulica',
  dom: 'Numer domu',
  lokal: 'Numer lokalu',
  kod: 'Kod pocztowy',
  miasto: 'Miasto',
  kraj: 'Kraj',
  telefon: 'Telefon',
  email: 'E-mail',
  punkt: 'Punkt odbioru',
  punkt_nazwa: 'Nazwa punktu odbioru',
  f_nazwa: 'Nazwa do faktury',
  f_nip: 'NIP',
  f_ulica: 'Ulica do faktury',
  f_kod: 'Kod pocztowy do faktury',
  f_miasto: 'Miasto do faktury',
  uwagi: 'Uwagi klienta',
}

/** Pole: trim, pusty = null, najwyżej `max` znaków (domyślnie 200); inny typ niż tekst = błąd z nazwą pola. */
function pole(d: DaneKlientaWe, nazwa: PoleKlienta): string | null {
  const raw = d[nazwa]
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new BladFormularzaKlienta(`${ETYKIETA[nazwa]}: tekst`)
  const v = (raw ?? '').trim()
  if (!v) return null
  const max = MAX[nazwa] ?? 200
  if (v.length > max) throw new BladFormularzaKlienta(`${ETYKIETA[nazwa]}: najwyżej ${max} znaków`)
  return v
}

/** Dane z formularza (FormData) jako zwykły obiekt pól klienta. */
export function daneZFormularza(form: FormData): DaneKlientaWe {
  const out: DaneKlientaWe = {}
  for (const p of POLA_KLIENTA) {
    const v = form.get(p)
    if (typeof v === 'string') out[p] = v
  }
  return out
}

/** Rekord z formularza zamówienia ręcznego; błąd = BladFormularzaKlienta z nazwą pola. */
export function rekordZFormularza(form: FormData): RekordKlienta {
  return rekordZDanych(daneZFormularza(form))
}

/**
 * Rekord z pól klienta (formularz karty, „Dodaj zamówienie”, API ogólne): te same reguły dla każdego wejścia.
 * Błąd = BladFormularzaKlienta z nazwą pola, nigdy z wartością.
 */
export function rekordZDanych(d: DaneKlientaWe): RekordKlienta {
  const imieNazwisko = pole(d, 'imie')
  const firma = pole(d, 'firma')
  const ulica = pole(d, 'ulica')
  const numerDomu = pole(d, 'dom')
  const numerLokalu = pole(d, 'lokal')
  const kodPocztowy = pole(d, 'kod')
  const miasto = pole(d, 'miasto')
  const kraj = (pole(d, 'kraj') ?? 'PL').toUpperCase()
  const telefon = pole(d, 'telefon')
  const email = pole(d, 'email')
  const punkt = pole(d, 'punkt')
  const punktNazwa = pole(d, 'punkt_nazwa')
  const fNazwa = pole(d, 'f_nazwa')
  const fNip = pole(d, 'f_nip')
  const fUlica = pole(d, 'f_ulica')
  const fKod = pole(d, 'f_kod')
  const fMiasto = pole(d, 'f_miasto')
  const uwagi = pole(d, 'uwagi')

  if (!imieNazwisko && !firma) throw new BladFormularzaKlienta('Podaj imię i nazwisko albo firmę')
  if (!/^[A-Z]{2}$/.test(kraj)) throw new BladFormularzaKlienta('Kraj: dwuliterowy kod, np. PL')
  const adres = ulica || numerDomu || kodPocztowy || miasto
  if (adres && (!ulica || !kodPocztowy || !miasto)) throw new BladFormularzaKlienta('Adres dostawy: ulica, kod pocztowy i miasto razem')
  if (kodPocztowy && kraj === 'PL' && !KOD_PL.test(kodPocztowy)) throw new BladFormularzaKlienta('Kod pocztowy w formacie NN-NNN')
  if (email && !EMAIL.test(email)) throw new BladFormularzaKlienta('E-mail: zły format')
  if (telefon && !normalizujTelefon(telefon)) throw new BladFormularzaKlienta('Telefon: co najmniej 9 cyfr')
  const nip = fNip ? fNip.replace(/[\s-]/g, '').replace(/^PL/i, '') : null
  if (nip && !(/^\d{10}$/.test(nip) && poprawnyNip(nip))) throw new BladFormularzaKlienta('NIP: 10 cyfr z poprawną sumą kontrolną')
  const faktura = fNazwa || nip || fUlica || fKod || fMiasto
  if (faktura && !fNazwa) throw new BladFormularzaKlienta('Dane do faktury: podaj nazwę')
  if (fKod && !KOD_PL.test(fKod)) throw new BladFormularzaKlienta('Kod pocztowy do faktury w formacie NN-NNN')

  return {
    v: 1,
    nabywca: { imieNazwisko, firma },
    dostawa: adres ? { imieNazwisko, firma, ulica, numerDomu, numerLokalu, kodPocztowy, miasto, kraj } : null,
    punktOdbioru: punkt ? { kod: punkt, nazwa: punktNazwa } : null,
    faktura: faktura ? { nazwa: fNazwa, nip, ulica: fUlica, kodPocztowy: fKod, miasto: fMiasto, kraj: 'PL' } : null,
    telefon,
    email,
    uwagiKlienta: uwagi,
    problemy: [],
  }
}

/** Adres do schowka („Kopiuj adres”): odbiorca, ulica z numerem, kod i miasto, kraj spoza PL, telefon. */
export function adresDoKopii(k: RekordKlienta): string | null {
  const d = k.dostawa
  if (!d) return null
  const numer = d.numerDomu ? ` ${d.numerDomu}${d.numerLokalu ? `/${d.numerLokalu}` : ''}` : ''
  const linie = [
    d.imieNazwisko,
    d.firma,
    d.ulica ? `${d.ulica}${numer}` : null,
    [d.kodPocztowy, d.miasto].filter(Boolean).join(' ') || null,
    d.kraj && d.kraj !== 'PL' ? d.kraj : null,
    k.telefon ? `tel. ${k.telefon}` : null,
  ]
  return linie.filter(Boolean).join('\n') || null
}
