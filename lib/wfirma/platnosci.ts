// Metoda płatności zamówienia → `paymentmethod` wFirmy. wFirma przyjmuje wyłącznie pięć wartości.
// Mapowanie domyślne potwierdził właściciel 11.11.2026 (wcześniej czekało na potwierdzenie księgowości). Zmiana: reguły
// w `Organization.settings.faktury.platnosci`, bez zmiany kodu. Nieznana metoda = problem, nigdy zgadywanie.
import type { OrderPaymentKind, PaymentState } from '@prisma/client'
import { grosze } from '../rdzen/edycja'
import { flagsOf } from '../rdzen/rezerwacja'

export type FormaPlatnosci = 'cash' | 'transfer' | 'compensation' | 'cod' | 'payment_card'

export interface RegulaPlatnosci {
  /** Fragment nazwy metody (bez wielkości liter i polskich znaków); przy `dokladnie` cała nazwa. */
  zawiera: string
  forma: FormaPlatnosci
  /**
   * nazwa metody równa `zawiera` albo `zawiera` z operatorem w nawiasie („ONLINE (AF)”), zamiast
   * fragmentu. Dla typów płatności Allegro, które są zwykłymi słowami („online” łapałoby „Karta płatnicza online”).
   */
  dokladnie?: true
}

export const DOMYSLNE_PLATNOSCI: RegulaPlatnosci[] = [
  { zawiera: 'pobrani', forma: 'cod' },
  { zawiera: 'przy odbiorze', forma: 'cod' },
  { zawiera: 'blik', forma: 'transfer' },
  { zawiera: 'payu', forma: 'transfer' },
  { zawiera: 'paypo', forma: 'transfer' },
  { zawiera: 'paypal', forma: 'transfer' },
  { zawiera: 'allegro finance', forma: 'transfer' },
  { zawiera: 'przelew', forma: 'transfer' },
  { zawiera: 'z gory', forma: 'transfer' },
  // adapter Allegro zapisuje metodę jako typ płatności Allegro z operatorem, np. „ONLINE (AF)”, „ONLINE (P24)”
  // (lib/adaptery/allegro.ts `paymentOf`). ONLINE = zapłacone z góry przez Allegro (jak „Allegro Finance” wyżej),
  // WIRE_TRANSFER = przelew tradycyjny na rachunek Allegro, też przed wysyłką. Runda 2: tylko dokładna nazwa typu,
  // bez dopasowania fragmentu. SPLIT_PAYMENT i EXTENDED_TERM (odroczony termin) celowo bez reguły: z kodu adaptera nie
  // wynika, kiedy i jak klient płaci, więc zostają `nieznana-platnosc` (biuro dopisuje regułę firmy po decyzji księgowości).
  // Na końcu listy: reguła firmy (`settings.faktury.platnosci`) i reguły wyżej wygrywają.
  { zawiera: 'online', forma: 'transfer', dokladnie: true },
  { zawiera: 'wire_transfer', forma: 'transfer', dokladnie: true },
]

const ZNAKI: Record<string, string> = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (c) => ZNAKI[c]!)
    .replace(/\s+/g, ' ')
    .trim()

/** Czy nazwa metody (znormalizowana) pasuje do reguły. */
function pasuje(m: string, r: RegulaPlatnosci): boolean {
  const z = norm(r.zawiera)
  return r.dokladnie ? m === z || m.startsWith(`${z} (`) : m.includes(z)
}

/** Forma wFirmy z nazwy metody; null = metoda nieznana. Stan COD rozstrzyga jak w rdzeniu (`beginInvoice`). */
export function formaPlatnosci(metoda: string | null | undefined, stan: PaymentState | null, reguly: RegulaPlatnosci[] = DOMYSLNE_PLATNOSCI): FormaPlatnosci | null {
  if (stan === 'COD') return 'cod'
  const m = norm(metoda ?? '')
  if (!m) return null
  if (m === 'cod') return 'cod'
  return reguly.find((r) => pasuje(m, r))?.forma ?? null
}

/**
 * ile klient zapłacił przed wystawieniem faktury, z danych zamówienia w Kompletorze. `CALOSC` = opłacone
 * w całości (kwotą zapłaconą na fakturze jest jej brutto), liczba = grosze (faktura bierze najwyżej swoje brutto).
 * Reguła jak „Zapłacono” na karcie zamówienia (`rozliczenie`, lib/karta/platnosci.ts): opłacone poza pobraniem = kwota
 * sprzed pierwszej edycji z karty (`flags.kwotaZaplacona`) albo, bez edycji, całość; do tego dopłaty i wpłaty minus
 * zwroty różnicy zapisane z karty. Pobranie = 0 (klient płaci kurierowi). Niedopłata (PARTIAL) = tylko wpłaty zapisane
 * w Kompletorze: kwoty częściowej wpłaty z kanału Kompletor dziś nie przechowuje, więc jej nie zgadujemy (faktura
 * zostaje „do zapłaty” w całości, jak przed zmianą). Druga paczka (podział, „dośle później”) opłaconego zamówienia:
 * w całości (pieniądze zostały na zamówieniu głównym, podział jest tylko dla opłaconych albo pobrań).
 */
export function zaplaconoDoFaktury(
  o: { paymentState: PaymentState; totalGross: { toString(): string } | number; flags: unknown; parentOrderId: string | null },
  wpisy: { kind: OrderPaymentKind; amount: { toString(): string } | number }[],
): 'CALOSC' | number {
  if (o.paymentState === 'COD') return 0
  const oplacone = o.paymentState === 'PAID'
  if (o.parentOrderId) return oplacone ? 'CALOSC' : 0
  const kwotaPrzedEdycja = flagsOf({ flags: o.flags as never }).kwotaZaplacona
  if (oplacone && kwotaPrzedEdycja === undefined && !wpisy.length) return 'CALOSC'
  const podstawa = oplacone ? (kwotaPrzedEdycja !== undefined ? grosze(kwotaPrzedEdycja) : grosze(o.totalGross)) : 0
  const ruch = wpisy.reduce((s, w) => s + (w.kind === 'ZWROT' ? -1 : 1) * grosze(w.amount), 0)
  return Math.max(0, podstawa + ruch)
}

const DZIEN_WARSZAWA = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' })

/** dzień wystawienia faktury (RRRR-MM-DD, czas polski), termin płatności faktury opłaconej w całości. */
export function dzienWystawienia(now: Date): string {
  return DZIEN_WARSZAWA.format(now)
}
