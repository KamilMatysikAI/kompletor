// Metoda płatności zamówienia → `paymentmethod` wFirmy. wFirma przyjmuje wyłącznie pięć wartości.
// Mapowanie domyślne potwierdził właściciel 11.11.2026 (wcześniej czekało na potwierdzenie księgowości). Zmiana: reguły
// w `Organization.settings.faktury.platnosci`, bez zmiany kodu. Nieznana metoda = problem, nigdy zgadywanie.
import type { PaymentState } from '@prisma/client'

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
