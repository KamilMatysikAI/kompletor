// Skan czytnikiem bez otwartego okna pakowania: Pakowanie (kolejka, lista zbierania) i lista zamówień.
// Rozpoznanie kodu wspólne ze stanowiskiem (rozpoznaj-kod.ts), ocena „czy wolno pakować” ta sama co przy otwarciu okna
// (ocenZamowienie). Zachowanie przy OTWARTYM oknie pakowania należy do stanowiska (stanowisko.tsx).
import type { PrismaClient } from '@prisma/client'
import { ocenZamowienie } from './cwiczenie'
import { krotkiGolyNumer, trybWklejenia } from './kod-tekst'
import { adresOtwarcia } from './otwarcie'
import { rozpoznajKod, type RozpoznanyKod } from './rozpoznaj-kod'
import { wczytajZamowienia } from './zamowienia'

type Db = PrismaClient

export type WynikSkanuKolejki =
  | { typ: 'otworz'; orderId: string; numer: string }
  | { typ: 'komunikat'; ton: 'info' | 'blad' | 'czerwona'; tekst: string }

/** `adres` = karta zamówienia z informacją, po czym ją otwarto (lib/stanowisko/otwarcie.ts). */
export type WynikKoduListy = { typ: 'otworz'; orderId: string; adres: string } | { typ: 'komunikat'; ton: 'info' | 'blad'; tekst: string } | { typ: 'filtruj' }

/** Kod w komunikacie: krótko i bez znaków sterujących (to, co przyszło z czytnika, nie trafia do ekranu w całości). */
export function kodWKomunikacie(tekst: string): string {
  const t = String(tekst ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  return t.length > 40 ? `${t.slice(0, 38)}…` : t
}

export function nieZnamKodu(tekst: string, podpowiedz: string): string {
  return `Nie znam kodu „${kodWKomunikacie(tekst)}”. ${podpowiedz}`
}

function koszykKomunikat(r: Extract<RozpoznanyKod, { typ: 'koszyk' }>): string {
  return r.stan === 'brak' ? `Nie ma koszyka ${r.nazwa}. Koszyki firmy: Pakowanie → Koszyki.` : `Koszyk ${r.nazwa} jest pusty. Zeskanuj kartę zamówienia.`
}

/**
 * Pakowanie: skan karty zamówienia, koszyka albo numeru nadania → zamówienie do otwarcia w oknie pakowania albo
 * komunikat jak na stanowisku (spakowane, wysłane, anulowane, „Do wyjaśnienia”, karta nieaktualna). Samo otwarcie
 * robi okno pakowania (`otworzZListy`), które sprawdza zamówienie jeszcze raz.
 */
export async function skanDoPakowania(db: Db, tekst: string): Promise<WynikSkanuKolejki> {
  const r = await rozpoznajKod(db, tekst, { tryb: 'kod', numery: true, koszyk: true, fragmenty: true })
  if (r.typ === 'koszyk') return { typ: 'komunikat', ton: 'info', tekst: koszykKomunikat(r) }
  if (r.typ === 'wiele') return { typ: 'komunikat', ton: 'blad', tekst: `Kod pasuje do ${r.ile} zamówień. Zeskanuj kartę zamówienia.` }
  if (r.typ === 'nieznany') return { typ: 'komunikat', ton: 'blad', tekst: nieZnamKodu(tekst, 'Zeskanuj kartę zamówienia albo koszyk.') }
  const [z] = await wczytajZamowienia(db, [r.orderId])
  if (!z) return { typ: 'komunikat', ton: 'blad', tekst: nieZnamKodu(tekst, 'Zeskanuj kartę zamówienia albo koszyk.') }
  const blokada = await ocenZamowienie(db, z, r.karta)
  if (blokada) return { typ: 'komunikat', ton: blokada.czerwona ? 'czerwona' : 'blad', tekst: blokada.komunikat }
  return { typ: 'otworz', orderId: z.id, numer: z.numer }
}

/**
 * Lista zamówień: skan (karta, koszyk, numer nadania z etykiety, numer zamówienia) albo wklejony tekst (numer z maila,
 * tytuł przelewu) → karta zamówienia. Wklejenie bez jednego trafienia = zwykłe filtrowanie listy (`filtruj`).
 */
export async function kodNaLiscie(db: Db, tekst: string, zrodlo: 'skan' | 'wklej'): Promise<WynikKoduListy> {
  const t = String(tekst ?? '')
  const tryb = zrodlo === 'skan' ? 'kod' : trybWklejenia(t)
  const r = await rozpoznajKod(db, t, { tryb, numery: true, koszyk: zrodlo === 'skan', fragmenty: zrodlo === 'skan' })
  if (r.typ === 'zamowienie') return { typ: 'otworz', orderId: r.orderId, adres: adresOtwarcia(r.orderId, r) }
  if (zrodlo === 'wklej') return { typ: 'filtruj' }
  if (r.typ === 'koszyk') return { typ: 'komunikat', ton: 'info', tekst: koszykKomunikat(r) }
  if (r.typ === 'wiele') return { typ: 'komunikat', ton: 'info', tekst: `Kod pasuje do ${r.ile} zamówień. Wpisz go w pole „Szukaj”, żeby zobaczyć wszystkie.` }
  return { typ: 'komunikat', ton: 'blad', tekst: nieZnamKodu(t, 'Zeskanuj kartę zamówienia albo etykietę przewoźnika.') }
}

/**
 * Enter w polu „Szukaj” listy: fraza będąca dokładnie kodem albo numerem jednego zamówienia otwiera jego kartę.
 * goły numer bez przedrostka dopiero od 5 cyfr, a przy szukaniu w danych klientów (`k=tak`) nigdy.
 */
export async function zamowienieZFrazy(db: Db, fraza: string, o: { klienci: boolean } = { klienci: false }): Promise<Extract<RozpoznanyKod, { typ: 'zamowienie' }> | null> {
  const t = String(fraza ?? '').trim()
  if (!t || o.klienci || krotkiGolyNumer(t)) return null
  const r = await rozpoznajKod(db, t, { tryb: 'kod', numery: true, koszyk: false, fragmenty: false })
  return r.typ === 'zamowienie' ? r : null
}
