// Teksty karty zamówienia (czyste funkcje, testy w karta.test.ts): numer zamówienia jak w kanale albo w BL
// zamiast uciętego UUID i sposób płatności słowami zamiast kodu kanału („ONLINE (AF)”).
import type { Channel, PaymentState } from '@prisma/client'

/** Dostawcy płatności Allegro (checkout-form `payment.provider`). */
const ALLEGRO_DOSTAWCA: Record<string, string> = {
  AF: 'Allegro Finance',
  AF_P24: 'Przelewy24 przez Allegro Finance',
  AF_PAYU: 'PayU przez Allegro Finance',
  P24: 'Przelewy24',
  PAYU: 'PayU',
}

const ALLEGRO_TYP: Record<string, string> = {
  ONLINE: 'Płatność online Allegro',
  CASH_ON_DELIVERY: 'Za pobraniem',
  SPLIT_PAYMENT: 'Płatność podzielona',
  EXTENDED_TERM: 'Płatność odroczona (Allegro Pay)',
}

/**
 * Sposób płatności słowami. Allegro zapisujemy jako „TYP (DOSTAWCA)” (lib/adaptery/allegro.ts, `paymentOf`), więc
 * rozkładamy kod na słowa; inne kanały podają nazwę bramki tak, jak widzi ją klient (Woo `payment_method_title`), więc
 * zostaje bez zmian. Nieznany kod zostaje w nawiasie, żeby biuro mogło go zgłosić.
 */
export function sposobPlatnosci(channel: Channel, raw: string | null | undefined, stan?: PaymentState): string {
  const t = (raw ?? '').trim()
  if (!t || t === '(brak)') return stan === 'COD' ? 'Za pobraniem' : '—'
  if (channel === 'ALLEGRO') {
    const m = /^([A-Z_]+)(?: \(([A-Z0-9_]+)\))?$/.exec(t)
    if (m) {
      const typ = ALLEGRO_TYP[m[1]!]
      const dost = m[2] ? (ALLEGRO_DOSTAWCA[m[2]] ?? m[2]) : null
      if (typ) return dost && m[1] !== 'CASH_ON_DELIVERY' ? `${typ} (${dost})` : typ
    }
  }
  return t
}

/**
 * Numer zamówienia do nagłówka: numer widoczny w kanale (Woo z numeracją wtyczki, PrestaShop reference), potem numer
 * zamówienia w BL (przeprowadzka i cień), potem numer w kanale (krótki zostaje w całości, długi UUID ucięty).
 */
/**
 * Numery pod tytułem karty (każdy numer raz). Numer w sklepie pokazujemy tylko wtedy, gdy różni się
 * od numeru w tytule (tytuł z BL albo ucięty identyfikator); gdy jest taki sam, a kanał ma link, linkiem staje się numer
 * w tytule. Numer BL pod tytułem tylko, gdy w tytule jest inny numer.
 */
export function numeryKarty(o: { externalId: string; channelNumber: string | null; blOrderId: number | null }, linkKanalu: string | null): { numer: string; zrodlo: 'KANAL' | 'BL' | 'ID'; wSklepie: string | null; bl: number | null; linkWTytule: boolean } {
  const n = numerKarty(o)
  const wKanale = o.channelNumber ?? o.externalId
  const wSklepie = wKanale !== n.numer ? wKanale : null
  return { ...n, wSklepie, bl: o.blOrderId && n.zrodlo !== 'BL' ? o.blOrderId : null, linkWTytule: !wSklepie && !!linkKanalu }
}

export function numerKarty(o: { externalId: string; channelNumber: string | null; blOrderId: number | null }): { numer: string; zrodlo: 'KANAL' | 'BL' | 'ID' } {
  if (o.channelNumber) return { numer: o.channelNumber, zrodlo: 'KANAL' }
  if (o.blOrderId) return { numer: String(o.blOrderId), zrodlo: 'BL' }
  return { numer: o.externalId.length > 12 ? `${o.externalId.slice(0, 9)}…` : o.externalId, zrodlo: 'ID' }
}
