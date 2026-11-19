// Maszyna statusów i wyznaczanie przewoźnika (spec 7). Czyste funkcje — testy w statusy.test.ts.
import type { Carrier, Channel, OrderStatus } from '@prisma/client'
import { type CarrierChoice, carrierFromRules, type CarrierRuleT } from './przewoznicy'

export type { CarrierChoice } from './przewoznicy'

/**
 * Reguły 7.2 firmy (tabela CarrierRule), pierwsza pasująca wygrywa. `BRAK` = nieznana metoda dostawy →
 * DO_WYJASNIENIA. Reguły ładuje `loadCarrierRules` (zamowienia.ts przy przyjęciu zamówienia).
 */
export function carrierFor(channel: Channel, deliveryMethod: string | null | undefined, rules: readonly CarrierRuleT[]): CarrierChoice {
  return carrierFromRules(rules, channel, deliveryMethod)
}

/** Przejścia z panelu (ręczne). Przejścia automatyczne robią funkcje rdzenia. */
const MANUAL: Partial<Record<OrderStatus, OrderStatus[]>> = {
  NOWE: ['DO_REALIZACJI', 'ANULOWANE', 'DO_WYJASNIENIA'],
  DO_REALIZACJI: ['ZBIERANIE', 'SPAKOWANE', 'ANULOWANE', 'DO_WYJASNIENIA'],
  // ZBIERANIE → SPAKOWANE: zbieranie i pakowanie na jednym ekranie (#7); robi to wyłącznie packOrder
  ZBIERANIE: ['ZEBRANE', 'SPAKOWANE', 'DO_REALIZACJI', 'ANULOWANE', 'DO_WYJASNIENIA'],
  ZEBRANE: ['SPAKOWANE', 'ANULOWANE', 'DO_WYJASNIENIA'],
  // SPAKOWANE → ODEBRANE: zamówienie bez wysyłki (sama usługa, np. e-book) po fakturze — bez kuriera
  SPAKOWANE: ['DO_WYSLANIA', 'DO_ODBIORU', 'ODEBRANE', 'ANULOWANE', 'DO_WYJASNIENIA'],
  DO_WYSLANIA: ['WYSLANE', 'ANULOWANE', 'DO_WYJASNIENIA'],
  DO_ODBIORU: ['ODEBRANE', 'ANULOWANE', 'DO_WYJASNIENIA'],
  WYSLANE: ['ODEBRANE', 'REKLAMACJA'],
  ODEBRANE: ['REKLAMACJA'],
  DO_WYJASNIENIA: [], // T15: wyjście przez `resolveClarification` (status przeliczany)
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (MANUAL[from] ?? []).includes(to)
}

export class TransitionError extends Error {}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new TransitionError(`Niedozwolone przejście ${from} → ${to}`)
}

/** Statusy przed zbieraniem: ich „brakuje” bierze dostawa (spec 4.4 pkt 3). */
export const BEFORE_PICKING: OrderStatus[] = ['NOWE', 'DO_REALIZACJI']

/** Karta w ręku zbieracza, paczka jeszcze niespakowana: edycja w kanale = różnica rezerwacji + „karta nieaktualna” (3.7). */
export const ON_CARD: OrderStatus[] = ['ZBIERANIE', 'ZEBRANE']

/** Status startowy wg płatności i przewoźnika (T1, T2). */
export function initialStatus(paid: boolean, carrier: Carrier): OrderStatus {
  if (carrier === 'BRAK') return 'DO_WYJASNIENIA'
  return paid ? 'DO_REALIZACJI' : 'NOWE'
}
