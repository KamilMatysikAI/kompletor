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
  // pobranie wygrywa z tytułem metody: płatność mogła zostać zmieniona na karcie (tytuł z kanału jest sprzed zmiany)
  if (stan === 'COD') return 'Za pobraniem'
  if (!t || t === '(brak)') return '—'
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

/** Identyfikator z kanału dłuższy niż tyle znaków (UUID Allegro) jest w tytule karty skrócony, pełny stoi pod spodem. */
const DLUGI_ID = 20

type NumeryZamowienia = { externalId: string; channelNumber: string | null; blOrderId: number | null }

/**
 * Numery pod tytułem karty (każdy numer raz). Numer w sklepie pokazujemy tylko wtedy, gdy różni się
 * od numeru w tytule (ucięty identyfikator); gdy jest taki sam, a kanał ma link, linkiem staje się numer w tytule.
 * numer BL zawsze tylko pomocniczo (`bl`, mała linia pod tytułem), nigdy w tytule.
 */
export function numeryKarty(o: NumeryZamowienia, linkKanalu: string | null): { numer: string; zrodlo: 'KANAL' | 'ID'; wSklepie: string | null; bl: number | null; linkWTytule: boolean } {
  const n = numerKarty(o)
  const wKanale = o.channelNumber ?? o.externalId
  const wSklepie = wKanale !== n.numer ? wKanale : null
  return { ...n, wSklepie, bl: o.blOrderId ?? null, linkWTytule: !wSklepie && !!linkKanalu }
}

/**
 * (decyzja właściciela 23.11: numery z kanału, nie z BaseLinkera): numer na liście
 * zamówień = numer z tytułu karty, czyli numer z kanału (Empik 40102452771670-A), nigdy numer BL. Różnica jedna: długi
 * identyfikator (UUID Allegro) lista pokazuje w całości, bez ucinania (kolumna łamie numer).
 */
export function numerListy(o: NumeryZamowienia): { numer: string; zrodlo: 'KANAL' | 'ID' } {
  const n = numerKarty(o)
  return { numer: n.zrodlo === 'ID' ? o.externalId : n.numer, zrodlo: n.zrodlo }
}

/**
 * Numer z przedrostkiem kanału jak w etykiecie wiersza listy zamówień („EMP 40102452771670-A”):,
 * kolejka pakowania pokazuje ten sam numer co lista i karta, nie skrócony `shortExternalId`.
 */
export function numerListyZPrzedrostkiem(przedrostek: string, o: NumeryZamowienia): string {
  return `${przedrostek} ${numerListy(o).numer}`
}

/**
 * Numer zamówienia do tytułu karty i na listę: numer widoczny w kanale (Woo z numeracją wtyczki, PrestaShop
 * reference), potem identyfikator z kanału (Empik, Allegro; krótki w całości, UUID ucięty). Numer BL nie jest numerem
 * głównym (po rezygnacji z BL 30.11 nowe zamówienia go nie mają).
 */
export function numerKarty(o: NumeryZamowienia): { numer: string; zrodlo: 'KANAL' | 'ID' } {
  if (o.channelNumber) return { numer: o.channelNumber, zrodlo: 'KANAL' }
  return { numer: o.externalId.length > DLUGI_ID ? `${o.externalId.slice(0, 9)}…` : o.externalId, zrodlo: 'ID' }
}
