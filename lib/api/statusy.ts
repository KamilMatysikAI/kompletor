// GET /api/v1/statusy (zakres `zamowienia:odczyt`) i narzędzie MCP `statusy`: słownik statusów zamówień
// i płatności z nazwami z panelu (STATUS_LABEL, PAYMENT_LABEL w lib/panel/format.ts) i krótkim opisem. Stałe, bez bazy.
// obok statusów rdzenia statusy firmy (nazwa, kolor, grupa, status bazowy, przewoźnicy) i grupy statusów;
// pola dotychczasowe bez zmian (zgodnie wstecz).
import type { Carrier, OrderStatus, PaymentState, PrismaClient } from '@prisma/client'
import { KOLORY_STATUSOW, isKolorStatusu } from '@/lib/panel/statusy'
import { statusyFirmy } from '@/lib/panel/statusy-firmy-dane'
import { PAYMENT_LABEL, STATUS_LABEL } from '@/lib/panel/format'
import { ORDER_STATUSES, PAYMENT_STATES } from './zamowienia'

const STATUS_OPIS: Record<OrderStatus, string> = {
  NOWE: 'Przyjęte z kanału; czeka na płatność albo przydział towaru.',
  DO_REALIZACJI: 'Opłacone (albo za pobraniem) z zarezerwowanym towarem; czeka na zbieranie.',
  ZBIERANIE: 'Magazyn zbiera pozycje.',
  ZEBRANE: 'Pozycje zebrane, czeka na pakowanie.',
  SPAKOWANE: 'Spakowane, czeka na etykietę lub przekazanie przewoźnikowi.',
  DO_WYSLANIA: 'Gotowe do nadania.',
  DO_ODBIORU: 'Czeka na odbiór osobisty albo na kuriera.',
  WYSLANE: 'Nadane u przewoźnika (zwykle z numerem nadania).',
  ODEBRANE: 'Klient odebrał przesyłkę.',
  ANULOWANE: 'Anulowane; rezerwacje zwolnione.',
  DO_WYJASNIENIA: 'Wymaga decyzji obsługi (np. brak towaru, niezmapowana pozycja, cofnięty status w kanale).',
  REKLAMACJA: 'Zgłoszona reklamacja albo zwrot.',
}

const PLATNOSC_OPIS: Record<PaymentState, string> = {
  PAID: 'Opłacone.',
  UNPAID: 'Nieopłacone; rezerwacja może wygasnąć wg zasad rezerwacji firmy.',
  COD: 'Za pobraniem; traktowane jak opłacone, rezerwacja nie wygasa.',
  PARTIAL: 'Niedopłata; wygasa jak nieopłacone.',
}

export interface StatusDictionary {
  statusy: { symbol: OrderStatus; nazwa: string; opis: string }[]
  platnosci: { symbol: PaymentState; nazwa: string; opis: string }[]
}

export interface StatusFirmyApi {
  klucz: string
  nazwa: string
  nazwaDlaKlienta: string | null
  /** nazwa koloru z palety panelu i jego wartość (#rrggbb) */
  kolor: string
  kolorHex: string
  grupa: string | null
  /** status rdzenia (`statusy[].symbol`), którego to jest nazwa */
  bazowy: OrderStatus
  /** przewoźnicy, dla których status pasuje; pusta lista = każdy */
  przewoznicy: Carrier[]
  aktywny: boolean
}

export interface StatusDictionaryFirmy extends StatusDictionary {
  /** statusy własne firmy w kolejności panelu; pusta lista = firma używa nazw rdzenia */
  statusyFirmy: StatusFirmyApi[]
  grupyStatusow: { klucz: string; nazwa: string }[]
}

/** Słownik z statusami firmy z sesji klucza API (RLS). */
export async function statusDictionaryFirmy(db: PrismaClient): Promise<StatusDictionaryFirmy> {
  const sf = await statusyFirmy(db)
  return {
    ...statusDictionary(),
    statusyFirmy: sf.statusy.map((s) => {
      const kolor = isKolorStatusu(s.color) ? s.color : 'szary'
      return { klucz: s.key, nazwa: s.name, nazwaDlaKlienta: s.customerName ?? null, kolor, kolorHex: KOLORY_STATUSOW[kolor].tekst, grupa: s.groupKey ?? null, bazowy: s.baseStatus, przewoznicy: [...s.carriers], aktywny: s.active }
    }),
    grupyStatusow: sf.grupy.map((g) => ({ klucz: g.key, nazwa: g.name })),
  }
}

export function statusDictionary(): StatusDictionary {
  return {
    statusy: ORDER_STATUSES.map((k) => ({ symbol: k, nazwa: STATUS_LABEL[k], opis: STATUS_OPIS[k] })),
    platnosci: PAYMENT_STATES.map((k) => ({ symbol: k, nazwa: PAYMENT_LABEL[k], opis: PLATNOSC_OPIS[k] })),
  }
}
