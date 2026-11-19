// Sygnały zwrotów i reklamacji z kopii zamówień kanałów (ekran „Zwroty i reklamacje” w cieniu).
// Czyste funkcje: surowy status kanału (`ChannelOrderSnapshot.channelStatus`) → rodzaj sygnału albo null.
// Listy statusów są tylko tu; to samo źródło bierze zapytanie ekranu (lib/panel/zwroty.ts), więc lista i klasyfikacja
// nie mogą się rozjechać. Statusy jak zapisują adaptery: Woo (lib/adaptery/woo.ts), Empik (lib/adaptery/mirakl-empik.ts),
// Allegro `<status>/<fulfillment>` (lib/adaptery/allegro.ts). Modułu zwrotów BL i `customer-returns` Allegro nie czytamy.
import type { Channel } from '@prisma/client'

export type SygnalZwrotu = 'ZWROT' | 'ZWROT_PIENIEDZY' | 'REKLAMACJA' | 'REKLAMACJA_ZAMKNIETA'

/** Woo: `refunded` bywa zwrotem pieniędzy przed wysyłką, więc to sygnał pieniędzy, nie „towar wrócił”. */
export const WOO_ZWROT_PIENIEDZY = ['refunded'] as const
export const EMPIK_ZWROT_PIENIEDZY = ['REFUNDED', 'WAITING_REFUND', 'WAITING_REFUND_PAYMENT'] as const
export const EMPIK_REKLAMACJA = ['INCIDENT_OPEN'] as const
export const EMPIK_REKLAMACJA_ZAMKNIETA = ['INCIDENT_CLOSED'] as const
/** Allegro: status realizacji po ukośniku; `…/RETURNED` = przesyłka wróciła do sprzedawcy. */
export const ALLEGRO_ZWROT_KONCOWKA = '/RETURNED'

/** Statusy kanałów porównywane dokładnie (`in` w zapytaniu); Allegro osobno, po końcówce. */
export const STATUSY_SYGNALOW: Partial<Record<Channel, readonly string[]>> = {
  WOO: [...WOO_ZWROT_PIENIEDZY],
  EMPIK: [...EMPIK_ZWROT_PIENIEDZY, ...EMPIK_REKLAMACJA, ...EMPIK_REKLAMACJA_ZAMKNIETA],
}

const has = (list: readonly string[], s: string) => list.includes(s)

export function sygnalZwrotu(channel: Channel, channelStatus: string): SygnalZwrotu | null {
  switch (channel) {
    case 'ALLEGRO':
      return channelStatus.endsWith(ALLEGRO_ZWROT_KONCOWKA) ? 'ZWROT' : null
    case 'WOO':
      return has(WOO_ZWROT_PIENIEDZY, channelStatus) ? 'ZWROT_PIENIEDZY' : null
    case 'EMPIK':
      if (has(EMPIK_ZWROT_PIENIEDZY, channelStatus)) return 'ZWROT_PIENIEDZY'
      if (has(EMPIK_REKLAMACJA, channelStatus)) return 'REKLAMACJA'
      if (has(EMPIK_REKLAMACJA_ZAMKNIETA, channelStatus)) return 'REKLAMACJA_ZAMKNIETA'
      return null
    default:
      return null
  }
}

export const SYGNAL_LABEL: Record<SygnalZwrotu, string> = {
  ZWROT: 'zwrot w kanale',
  ZWROT_PIENIEDZY: 'zwrot pieniędzy w kanale',
  REKLAMACJA: 'reklamacja otwarta',
  REKLAMACJA_ZAMKNIETA: 'reklamacja zamknięta',
}

/** Kolor plakietki (klasy `.chip` z app/panel.css). */
export const SYGNAL_TONE: Record<SygnalZwrotu, '' | 'amber' | 'red' | 'blue'> = {
  ZWROT: 'amber',
  ZWROT_PIENIEDZY: 'blue',
  REKLAMACJA: 'red',
  REKLAMACJA_ZAMKNIETA: '',
}
