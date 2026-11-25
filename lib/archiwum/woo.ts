// etap 1: zamówienie WooCommerce z przeszłości → wiersz archiwum (`ArchivedOrder` + pozycje). Czysta logika,
// bez I/O. Normalizacja tą samą funkcją co bieżące zamówienia (`wooOrderZRabatem`: ceny po kuponie i po rabacie z
// ujemnych opłat, koszt wysyłki, status, płatność), więc archiwum i `Order` liczą kwoty jedną regułą.
//
// Bez danych osobowych: odczyt prosi sklep tylko o pola z `POLA_ZAMOWIENIA_WOO` (bez `billing`, `shipping`,
// `customer_note`, `meta_data`, adresu IP i nazwy metody płatności), a do archiwum trafiają liczby, pozycje i statusy.
// Pole płatności nie trafia nigdzie (w archiwum `paymentMethod` zostaje puste; nazwa metody bywa nośnikiem adresu
// e-mail, np. w polu płatności faktur z poprzedniego systemu). Powód zwrotu (`refunds[].reason`, tekst wpisany ręcznie)
// nie jest czytany, tylko kwota.
//
// Statusy (docs/raporty.md, „Archiwum zamówień”), tak jak bieżący raport liczy `Order` (sprzedaż = wszystko poza
// ANULOWANE):
//   completed                       → WYSLANE, sprzedaż;
//   processing                      → status nieustalony (null), sprzedaż (opłacone, w realizacji; tak samo liczy się
//                                     otwarte zamówienie w Kompletorze);
//   pending, on-hold, failed, inny  → opłacone albo za pobraniem: null, sprzedaż; nieopłacone: ANULOWANE (Kompletor
//                                     anuluje nieopłacone po terminie z ustawień firmy, a zamówienie z przeszłości
//                                     termin dawno minął);
//   cancelled, refunded             → ANULOWANE (poza sprzedażą, liczą się osobno jak anulowane w `Order`);
//   checkout-draft, trash           → pominięte (szkic; bieżący odczyt też ich nie przyjmuje).
// Zwrot częściowy (`refunds`) = kwota zwrotu pomniejszona o koszt wysyłki (zwrot samej wysyłki nie schodzi z towarów),
// rozłożona na pozycje proporcjonalnie do ich wartości (sklep nie podaje w zamówieniu, której pozycji dotyczy zwrot),
// najwyżej do wartości pozycji; raport odejmuje go jak zwrot.
import type { OrderStatus, PaymentState } from '@prisma/client'
import { wooOrderZRabatem, type OpcjeZamowieniaWoo } from '../adaptery/woo'
import { UnreadableDataError } from '../adaptery/kontrakt'

/** Pola zamówienia, o które importer prosi sklep (`_fields`): bez danych klienta i bez nazwy metody płatności. */
export const POLA_ZAMOWIENIA_WOO = [
  'id',
  'number',
  'status',
  'currency',
  'date_created_gmt',
  'date_modified_gmt',
  'date_paid_gmt',
  'date_completed_gmt',
  'total',
  'shipping_total',
  'shipping_tax',
  'payment_method',
  'line_items',
  'fee_lines',
  'shipping_lines',
  'refunds',
].join(',')

/** Pola, których importer nigdy nie czyta, nawet gdy sklep je odda (kontrola w teście i w `bezDanychOsobowych`). */
export const POLA_ZAKAZANE_WOO = ['billing', 'shipping', 'customer_note', 'customer_ip_address', 'customer_user_agent', 'payment_method_title', 'meta_data', 'transaction_id', 'customer_id'] as const

export interface PozycjaArchiwum {
  externalLineId: string
  /** id oferty w formacie `ChannelOffer.externalId` („<produkt>” albo „<produkt>/<wariant>”); null = produkt usunięty */
  offerId: string | null
  name: string
  sku: string | null
  ean: string | null
  /** sztuki oferty (z kanału); jednostki bazowe liczy importer z przelicznika oferty */
  qtyOffer: number
  /** wartość całej pozycji brutto po rabatach, grosze */
  lineGrossGr: number
  vatRate: string | null
  /** kwota zwrotu przypisana pozycji, grosze (0..lineGrossGr) */
  refundGr: number
}

export interface ZamowienieArchiwum {
  externalId: string
  channelNumber: string | null
  status: OrderStatus | null
  channelStatus: string
  createdAtChannel: Date
  closedAt: Date | null
  paymentState: PaymentState
  totalGrossGr: number
  shippingGrossGr: number | null
  refundGrossGr: number
  currency: string
  deliveryMethod: string | null
  sourceRevision: string
  lines: PozycjaArchiwum[]
  /** id zamówienia w BL (faktury BL: `order_id`); brak = pole bez zmian */
  blOrderId?: number | null
  /** numery dokumentów sprzedaży (faktury BL: numer faktury); brak = pole bez zmian */
  invoiceNumbers?: string[]
  /** kanał odtworzony dla tego wiersza (`ArchivedOrder.channelInferred`); brak = wartość ze źródła (`ZrodloArchiwum.kanalOdtworzony`) */
  kanalOdtworzony?: boolean
  /** ostrzeżenia mapowania (bez danych klienta) */
  warnings: string[]
}

export type WynikMapowaniaWoo = { rodzaj: 'zamowienie'; zamowienie: ZamowienieArchiwum } | { rodzaj: 'pominiete'; powod: 'szkic' | 'para w innym kanale' | 'inny kanał wg źródeł BL'; /** czas zamówienia: poza `--od/--do` = „poza zakresem dat” */ czas?: Date }

const SZKIC = new Set(['checkout-draft', 'trash'])
const ANULOWANE_WOO = new Set(['cancelled', 'refunded'])

/** Status archiwum ze statusu Woo i płatności (reguły w nagłówku pliku). */
export function statusArchiwumWoo(channelStatus: string, paymentState: PaymentState): OrderStatus | null | 'POMIN' {
  if (SZKIC.has(channelStatus)) return 'POMIN'
  if (ANULOWANE_WOO.has(channelStatus)) return 'ANULOWANE'
  if (channelStatus === 'completed') return 'WYSLANE'
  if (channelStatus === 'processing') return null
  return paymentState === 'PAID' || paymentState === 'COD' ? null : 'ANULOWANE'
}

const gr = (zl: number): number => Math.round(zl * 100)

function dataOpc(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const s = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Suma zwrotów zamówienia w groszach (dodatnia): `refunds[].total` sklep podaje ujemnie. Nieczytelne = błąd. */
export function zwrotyWooGr(raw: Record<string, unknown>, externalId: string): number {
  const r = raw['refunds']
  if (r === undefined || r === null) return 0
  if (!Array.isArray(r)) throw new UnreadableDataError(`zamówienie ${externalId}: nieczytelne zwroty`)
  let suma = 0
  for (const [i, z] of (r as Record<string, unknown>[]).entries()) {
    const t = Number(z?.['total'])
    if (!Number.isFinite(t)) throw new UnreadableDataError(`zamówienie ${externalId}: nieczytelna kwota zwrotu ${i + 1}`)
    suma += Math.abs(gr(t))
  }
  return suma
}

/**
 * Rozkład kwoty zwrotu na pozycje proporcjonalnie do wartości, w groszach, najwyżej do sumy pozycji (zwrot ponad
 * towary, np. z kosztem wysyłki, zostaje tylko w `refundGrossGr` zamówienia). Reszta groszy na największą pozycję.
 */
export function rozlozZwrot(wartosciGr: readonly number[], zwrotGr: number): number[] {
  const suma = wartosciGr.reduce((s, v) => s + Math.max(0, v), 0)
  const doRozlozenia = Math.min(Math.max(0, zwrotGr), suma)
  if (!doRozlozenia || !suma) return wartosciGr.map(() => 0)
  const out = wartosciGr.map((v) => Math.floor((Math.max(0, v) * doRozlozenia) / suma))
  let reszta = doRozlozenia - out.reduce((s, v) => s + v, 0)
  const kolejnosc = wartosciGr.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (let k = 0; reszta > 0; k = (k + 1) % kolejnosc.length) {
    const i = kolejnosc[k]![1]
    if (out[i]! < Math.max(0, wartosciGr[i]!)) {
      out[i]! += 1
      reszta--
    }
  }
  return out
}

/** Zamówienie WC REST v3 → wiersz archiwum. Nieczytelne pole = UnreadableDataError (importer zapisuje je jako problem). */
export function archiwumZWoo(raw: Record<string, unknown>, opts: OpcjeZamowieniaWoo = {}): WynikMapowaniaWoo {
  const surowyStatus = typeof raw['status'] === 'string' ? raw['status'].trim() : ''
  if (SZKIC.has(surowyStatus)) return { rodzaj: 'pominiete', powod: 'szkic' }
  const { order } = wooOrderZRabatem(raw, opts)
  const status = statusArchiwumWoo(order.channelStatus, order.paymentState)
  if (status === 'POMIN') return { rodzaj: 'pominiete', powod: 'szkic' }
  const wartosci = order.lines.map((l) => gr(l.unitPriceGross) * l.qty)
  const refundGrossGr = zwrotyWooGr(raw, order.externalId)
  // zwrot może obejmować koszt wysyłki (sklep nie mówi, czego dotyczył): na towary schodzi najwyżej zwrot ponad wysyłkę,
  // więc zwrot samej wysyłki nie zmniejsza sprzedaży produktów (cała kwota zostaje w `refundGrossGr` zamówienia)
  const wysylkaGr = order.shippingCostGross ? Math.max(0, gr(order.shippingCostGross)) : 0
  const zwroty = rozlozZwrot(wartosci, Math.max(0, refundGrossGr - wysylkaGr))
  const lines: PozycjaArchiwum[] = order.lines.map((l, i) => ({
    externalLineId: l.externalLineId,
    offerId: l.offerExternalId,
    name: (l.name ?? '').trim().slice(0, 500) || '(pozycja bez nazwy)',
    sku: l.sku ?? null,
    ean: l.ean ?? null,
    qtyOffer: l.qty,
    lineGrossGr: wartosci[i]!,
    vatRate: l.vatRate,
    refundGr: zwroty[i]!,
  }))
  return {
    rodzaj: 'zamowienie',
    zamowienie: {
      externalId: order.externalId,
      channelNumber: order.number ?? null,
      status,
      channelStatus: order.channelStatus,
      createdAtChannel: order.createdAt,
      closedAt: dataOpc(raw['date_completed_gmt']),
      paymentState: order.paymentState,
      totalGrossGr: gr(order.totalGross),
      shippingGrossGr: order.shippingCostGross === null || order.shippingCostGross === undefined ? null : gr(order.shippingCostGross),
      refundGrossGr,
      currency: order.currency,
      deliveryMethod: order.deliveryMethod ? order.deliveryMethod.slice(0, 200) : null,
      sourceRevision: order.revision,
      lines,
      warnings: order.warnings,
    },
  }
}

/** Kopia zamówienia bez pól zakazanych (gdy sklep zignoruje `_fields`): zanim cokolwiek je przeczyta. */
export function bezDanychOsobowych(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const dozwolone = new Set(POLA_ZAMOWIENIA_WOO.split(','))
  for (const [k, v] of Object.entries(raw)) if (dozwolone.has(k)) out[k] = v
  return out
}
