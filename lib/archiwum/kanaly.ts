// etap 2: zamówienia z przeszłości z Allegro, Empiku (Mirakl) i EasyTools → wiersz archiwum. Czysta logika,
// bez I/O. Allegro i Empik normalizuje ta sama funkcja co bieżące zamówienia (`allegroOrderFromApi`,
// `miraklOrderFromApi`), więc archiwum i `Order` liczą kwoty i ceny pozycji jedną regułą.
//
// Bez danych osobowych: Allegro i OR11 nie mają listy pól, więc odpowiedź kanału od razu przycinamy do listy dozwolonych
// pól (`bezDanychOsobowych*`), zanim cokolwiek ją przeczyta. Odpadają kupujący, adresy, punkt odbioru, wiadomości,
// pola dodatkowe zamówienia (Empik trzyma w nich e-mail klienta), e-mail EasyTools. Pole płatności nie trafia do
// archiwum (`paymentMethod` puste), tylko stan płatności.
//
// Statusy (jak Woo w lib/archiwum/woo.ts, sprzedaż = wszystko poza ANULOWANE):
//   cykl życia FULFILLED (wysłane, odebrane, zamknięte)       → WYSLANE (Allegro PICKED_UP, Empik RECEIVED/CLOSED → ODEBRANE);
//   CANCELLED (anulowane, odrzucone, zwrócone w całości)      → ANULOWANE;
//   OPEN opłacone albo za pobraniem                           → null, sprzedaż (w realizacji);
//   OPEN nieopłacone                                          → ANULOWANE (termin płatności zamówienia z przeszłości minął);
//   DRAFT (Empik STAGING)                                     → pominięte jak szkic.
// Zwroty: Empik podaje kwoty zwrotów przy pozycjach (`order_lines[].refunds[].amount`); Allegro w formularzu zakupu
// zwrotów nie podaje (osobny proces), więc archiwum Allegro ma zwrot 0. EasyTools: `refunded` = ANULOWANE.
import type { ChannelOrder } from '../adaptery/kontrakt'
import { UnreadableDataError } from '../adaptery/kontrakt'
import { allegroOrderFromApi } from '../adaptery/allegro'
import { miraklOrderFromApi } from '../adaptery/mirakl-empik'
import type { OrderStatus } from '@prisma/client'
import type { PozycjaArchiwum, WynikMapowaniaWoo, ZamowienieArchiwum } from './woo'

export type WynikMapowania = WynikMapowaniaWoo

const gr = (zl: number): number => Math.round(zl * 100)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Kopia obiektu tylko z kluczami z listy; zagnieżdżone listy i obiekty według podanego kształtu. */
type Ksztalt = { [k: string]: true | Ksztalt }
export function przytnij(v: unknown, k: Ksztalt): unknown {
  if (Array.isArray(v)) return v.map((x) => przytnij(x, k))
  if (!v || typeof v !== 'object') return v
  const out: Record<string, unknown> = {}
  for (const [klucz, opis] of Object.entries(k)) {
    if (!Object.hasOwn(v, klucz)) continue
    const x = (v as Record<string, unknown>)[klucz]
    out[klucz] = opis === true ? (x && typeof x === 'object' ? null : x) : przytnij(x, opis)
  }
  return out
}

const KWOTA: Ksztalt = { amount: true, currency: true }

/** Pola formularza zakupu Allegro, które importer czyta (reszta, w tym `buyer`, adresy i wiadomości, odpada). */
export const KSZTALT_ALLEGRO: Ksztalt = {
  id: true,
  status: true,
  updatedAt: true,
  revision: true,
  fulfillment: { status: true },
  summary: { totalToPay: KWOTA },
  payment: { type: true, provider: true, finishedAt: true, paidAmount: KWOTA, reconciliation: KWOTA },
  delivery: { method: { name: true }, cost: KWOTA },
  invoice: { required: true },
  lineItems: { id: true, quantity: true, price: KWOTA, boughtAt: true, tax: { rate: true }, offer: { id: true, name: true, external: { id: true } } },
}

/** Pola zamówienia OR11 (Empik), które importer czyta (reszta, w tym `customer` i pola dodatkowe z e-mailem, odpada). */
export const KSZTALT_MIRAKL: Ksztalt = {
  order_id: true,
  commercial_id: true,
  order_state: true,
  created_date: true,
  last_updated_date: true,
  total_price: true,
  shipping_price: true,
  currency_iso_code: true,
  shipping_type_label: true,
  shipping_type_code: true,
  shipping_tracking: true,
  order_lines: { order_line_id: true, order_line_state: true, quantity: true, price_unit: true, price: true, product_sku: true, product_title: true, offer_sku: true, refunds: { amount: true } },
}

/** Pola zamówienia EasyTools (bez `customer_email`). */
export const KSZTALT_EASYTOOLS: Ksztalt = { id: true, status: true, amount: true, currency: true, quantity: true, product_name: true, created_at: true }

export const bezDanychOsobowychAllegro = (raw: Record<string, unknown>) => przytnij(raw, KSZTALT_ALLEGRO) as Record<string, unknown>
export const bezDanychOsobowychMirakl = (raw: Record<string, unknown>) => przytnij(raw, KSZTALT_MIRAKL) as Record<string, unknown>
export const bezDanychOsobowychEasyTools = (raw: Record<string, unknown>) => przytnij(raw, KSZTALT_EASYTOOLS) as Record<string, unknown>

const ODEBRANE = new Set(['PICKED_UP', 'RECEIVED', 'CLOSED'])

/** Status archiwum ze znormalizowanego zamówienia kanału (reguły w nagłówku pliku). */
export function statusArchiwumKanalu(o: Pick<ChannelOrder, 'lifecycle' | 'paymentState' | 'channelStatus'>): OrderStatus | null | 'POMIN' {
  if (o.lifecycle === 'DRAFT') return 'POMIN'
  if (o.lifecycle === 'CANCELLED') return 'ANULOWANE'
  if (o.lifecycle === 'FULFILLED') return ODEBRANE.has(o.channelStatus.split('/').pop() ?? '') ? 'ODEBRANE' : 'WYSLANE'
  return o.paymentState === 'PAID' || o.paymentState === 'COD' ? null : 'ANULOWANE'
}

/** Znormalizowane zamówienie kanału → wiersz archiwum; `zwrotyPozycjiGr` po `externalLineId` (brak = 0). */
export function archiwumZZamowienia(order: ChannelOrder, extra: { channelNumber?: string | null; zwrotyPozycjiGr?: Map<string, number> } = {}): WynikMapowania {
  const status = statusArchiwumKanalu(order)
  if (status === 'POMIN') return { rodzaj: 'pominiete', powod: 'szkic' }
  const wartosci = order.lines.map((l) => gr(l.unitPriceGross) * l.qty)
  const zwroty = order.lines.map((l, i) => Math.min(Math.max(0, extra.zwrotyPozycjiGr?.get(l.externalLineId) ?? 0), Math.max(0, wartosci[i]!)))
  const refundGrossGr = [...(extra.zwrotyPozycjiGr?.values() ?? [])].reduce((a, b) => a + Math.max(0, b), 0)
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
  const z: ZamowienieArchiwum = {
    externalId: order.externalId,
    channelNumber: extra.channelNumber ?? order.number ?? null,
    status,
    channelStatus: order.channelStatus,
    createdAtChannel: order.createdAt,
    closedAt: null,
    paymentState: order.paymentState,
    totalGrossGr: gr(order.totalGross),
    shippingGrossGr: order.shippingCostGross === null || order.shippingCostGross === undefined ? null : gr(order.shippingCostGross),
    refundGrossGr,
    currency: order.currency,
    deliveryMethod: order.deliveryMethod ? order.deliveryMethod.slice(0, 200) : null,
    sourceRevision: order.revision,
    lines,
    warnings: order.warnings,
  }
  return { rodzaj: 'zamowienie', zamowienie: z }
}

/** Formularz zakupu Allegro (z API albo ze zrzutu w kształcie API) → wiersz archiwum. */
export function archiwumZAllegro(raw: Record<string, unknown>): WynikMapowania {
  return archiwumZZamowienia(allegroOrderFromApi(bezDanychOsobowychAllegro(raw)))
}

/** Zamówienie OR11 → wiersz archiwum, ze zwrotami pozycji z `order_lines[].refunds[].amount`. */
export function archiwumZMirakl(raw: Record<string, unknown>): WynikMapowania {
  const r = bezDanychOsobowychMirakl(raw)
  const order = miraklOrderFromApi(r)
  const zwroty = new Map<string, number>()
  for (const l of (Array.isArray(r['order_lines']) ? r['order_lines'] : []) as Record<string, unknown>[]) {
    const id = typeof l['order_line_id'] === 'string' || typeof l['order_line_id'] === 'number' ? String(l['order_line_id']) : null
    const refunds = l['refunds']
    if (!id || refunds === undefined || refunds === null) continue
    if (!Array.isArray(refunds)) throw new UnreadableDataError(`zamówienie ${order.externalId}: nieczytelne zwroty pozycji ${id}`)
    let s = 0
    for (const z of refunds as unknown[]) {
      const a = Number(obj(z)['amount'])
      if (!Number.isFinite(a)) throw new UnreadableDataError(`zamówienie ${order.externalId}: nieczytelna kwota zwrotu pozycji ${id}`)
      s += Math.abs(gr(a))
    }
    // zwrot pozycji pominiętej przez normalizację (odrzucona, anulowana) nie zmniejsza sprzedaży: liczymy tylko pozycje zamówienia
    if (s && order.lines.some((x) => x.externalLineId === id)) zwroty.set(id, s)
  }
  const commercial = r['commercial_id']
  return archiwumZZamowienia(order, { channelNumber: typeof commercial === 'string' && commercial.trim() ? commercial.trim().slice(0, 100) : null, zwrotyPozycjiGr: zwroty })
}

const STATUS_EASYTOOLS: Record<string, { status: OrderStatus; paid: boolean }> = {
  completed: { status: 'WYSLANE', paid: true },
  canceled: { status: 'ANULOWANE', paid: false },
  cancelled: { status: 'ANULOWANE', paid: false },
  refunded: { status: 'ANULOWANE', paid: true },
  awaiting_payment: { status: 'ANULOWANE', paid: false },
}

/**
 * Zamówienie EasyTools (`GET /orders`: kwota w groszach, jedna pozycja = produkt × ilość, bez kosztu wysyłki i bez
 * SKU) → wiersz archiwum. Nieznany status = ANULOWANE z ostrzeżeniem (nie liczymy jako sprzedaż czegoś, czego nie znamy).
 * Rewizji EasyTools nie podaje: rewizja = status i kwota.
 */
export function archiwumZEasyTools(raw: Record<string, unknown>): WynikMapowania {
  const r = bezDanychOsobowychEasyTools(raw)
  const id = typeof r['id'] === 'string' && r['id'].trim() ? r['id'].trim() : typeof r['id'] === 'number' ? String(r['id']) : null
  if (!id) throw new UnreadableDataError('zamówienie EasyTools bez id')
  const st = typeof r['status'] === 'string' ? r['status'].trim() : ''
  if (!st) throw new UnreadableDataError(`zamówienie ${id} bez statusu`)
  const amount = r['amount']
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) throw new UnreadableDataError(`zamówienie ${id}: nieczytelna kwota`)
  const qty = r['quantity'] === undefined || r['quantity'] === null ? 1 : Number(r['quantity'])
  if (!Number.isInteger(qty) || qty <= 0) throw new UnreadableDataError(`zamówienie ${id}: nieczytelna ilość`)
  const created = typeof r['created_at'] === 'string' ? new Date(r['created_at']) : null
  if (!created || Number.isNaN(created.getTime())) throw new UnreadableDataError(`zamówienie ${id}: nieczytelna data`)
  const warnings: string[] = []
  const znany = STATUS_EASYTOOLS[st]
  if (!znany) warnings.push(`nieznany status EasyTools „${st.slice(0, 40)}” — liczony jak anulowane`)
  const name = (typeof r['product_name'] === 'string' ? r['product_name'] : '').trim().slice(0, 500) || '(pozycja bez nazwy)'
  return {
    rodzaj: 'zamowienie',
    zamowienie: {
      externalId: id,
      channelNumber: null,
      status: znany?.status ?? 'ANULOWANE',
      channelStatus: st.slice(0, 60),
      createdAtChannel: created,
      closedAt: null,
      paymentState: znany?.paid ? 'PAID' : 'UNPAID',
      totalGrossGr: amount,
      shippingGrossGr: null,
      refundGrossGr: 0,
      currency: (typeof r['currency'] === 'string' && r['currency'].trim() ? r['currency'].trim() : 'PLN').toUpperCase().slice(0, 3),
      deliveryMethod: null,
      sourceRevision: `${st}|${amount}`,
      lines: [{ externalLineId: '1', offerId: null, name, sku: null, ean: null, qtyOffer: qty, lineGrossGr: amount, vatRate: null, refundGr: 0 }],
      warnings,
    },
  }
}

