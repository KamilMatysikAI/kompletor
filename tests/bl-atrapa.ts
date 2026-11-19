// Atrapa BaseLinkera w pamięci: getOrderStatusList, getOrders (date_from / date_confirmed_from, id_from,
// niepotwierdzone), getInvoices (invoice_id / id_from / date_from). Zero połączeń z prawdziwym BL; dane wyłącznie fikcyjne.
// getOrders z `order_id`, getJournalList (`last_log_id` wyłączne, `logs_types`, strony po `journalPageSize`;
// `journalDisabled` = metoda wyłączona w ustawieniach API: pusta odpowiedź, jak opisuje BL).
import { BaseLinkerReadOnly } from '@/lib/zrodla/baselinker'
import type { FetchLike } from '@/lib/zrodla/http'

export const sec = (iso: string | Date) => Math.floor((typeof iso === 'string' ? Date.parse(iso) : iso.getTime()) / 1000)

export const BL_STATUSES = [
  { id: 1, name: 'Nowe zamówienia' },
  { id: 2, name: 'Do realizacji Paczkomaty' },
  { id: 3, name: 'Wysłane' },
  { id: 4, name: 'Anulowane' },
]

export interface BlFakeOrder {
  order_id: number
  order_source: string
  order_source_id: string
  shop_order_id?: number | string
  external_order_id?: string
  order_status_id: number
  date_add: number
  date_confirmed?: number
  confirmed?: boolean
  delivery_price?: number
  products?: { price_brutto: number; quantity: number }[]
  [k: string]: unknown
}

export interface BlFakeInvoice {
  invoice_id: number
  order_id: number
  number: string
  external_invoice_number?: string
  type?: string
  date_add: number
  [k: string]: unknown
}

export class FakeBl {
  orders: BlFakeOrder[] = []
  invoices: BlFakeInvoice[] = []
  calls: { method: string; params: Record<string, unknown> }[] = []
  failNext: string | null = null
  /** Metody, które odpowiadają błędem w każdym wywołaniu (np. metoda niewłączona na koncie). */
  failAlways: string[] = []
  statuses: { id: number; name: string }[] = BL_STATUSES
  /** Wpisy dziennika w kształcie BL (`log_id` albo `id`, `log_type`, `order_id`, `object_id`, `date`). */
  journal: Record<string, unknown>[] = []
  journalPageSize = 100
  journalDisabled = false

  client(): BaseLinkerReadOnly {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = new URLSearchParams(String(init?.body))
      const method = body.get('method')!
      const params = JSON.parse(body.get('parameters') ?? '{}') as Record<string, unknown>
      this.calls.push({ method, params })
      if (this.failNext === method || this.failAlways.includes(method)) {
        if (this.failNext === method) this.failNext = null
        return new Response(JSON.stringify({ status: 'ERROR', error_code: 'ERROR_INTERNAL_TEST', error_message: 'atrapa' }))
      }
      const ok = (x: Record<string, unknown>) => new Response(JSON.stringify({ status: 'SUCCESS', ...x }))
      if (method === 'getOrderStatusList') return ok({ statuses: this.statuses })
      if (method === 'getJournalList') {
        if (this.journalDisabled) return ok({})
        const last = Number(params['last_log_id'] ?? 0)
        // jak prawdziwy BaseLinker: zero odrzucone (produkcja 03–16.11.2026)
        if (!(last > 0)) return new Response(JSON.stringify({ status: 'ERROR', error_code: 'ERROR_BAD_PARAMETERS', error_message: "The 'last_log_id' field must be greater than zero." }))
        const types = Array.isArray(params['logs_types']) ? (params['logs_types'] as number[]) : null
        const idOf = (e: Record<string, unknown>) => Number(e['log_id'] ?? e['id'] ?? 0)
        const list = this.journal.filter((e) => idOf(e) > last && (!types || types.includes(Number(e['log_type']))))
        return ok({ logs: [...list].sort((a, b) => idOf(a) - idOf(b)).slice(0, this.journalPageSize) })
      }
      if (method === 'getOrders') {
        if (params['order_id'] !== undefined) return ok({ orders: this.orders.filter((o) => o.order_id === Number(params['order_id'])) })
        const idFrom = Number(params['id_from'] ?? 0)
        let list = this.orders.filter((o) => o.order_id >= idFrom)
        if (params['date_from'] !== undefined) list = list.filter((o) => o.date_add >= Number(params['date_from']))
        if (params['date_confirmed_from'] !== undefined) list = list.filter((o) => (o.date_confirmed ?? o.date_add) >= Number(params['date_confirmed_from']))
        if (!params['get_unconfirmed_orders']) list = list.filter((o) => o.confirmed !== false)
        return ok({ orders: [...list].sort((a, b) => a.order_id - b.order_id).slice(0, 100) })
      }
      if (method === 'getInvoices') {
        let list = this.invoices
        if (params['invoice_id'] !== undefined) list = list.filter((i) => i.invoice_id === Number(params['invoice_id']))
        if (params['id_from'] !== undefined) list = list.filter((i) => i.invoice_id >= Number(params['id_from']))
        if (params['date_from'] !== undefined) list = list.filter((i) => i.date_add >= Number(params['date_from']))
        return ok({ invoices: [...list].sort((a, b) => a.invoice_id - b.invoice_id).slice(0, 100) })
      }
      return new Response(JSON.stringify({ status: 'ERROR', error_code: 'ERROR_UNKNOWN_METHOD', error_message: method }))
    }
    return new BaseLinkerReadOnly('token-test', fetchImpl, 0)
  }
}
