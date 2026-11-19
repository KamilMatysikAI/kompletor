// Dane karty zwrotu i formularza „Stwórz zwrot”. Klient bazy firmy z sesji (RLS), sam odczyt.
// Bez danych kupującego: zamówienie po numerze, pozycje po nazwie z kanału albo produktu.
import type { PrismaClient, ReturnKind, ReturnStatus } from '@prisma/client'
import { organizationIdOf } from '../db'
import { ustawieniaDokumentowFirmy } from '../dokumenty/firma'
import { korektyWlaczone } from '../dokumenty/ustawienia'
import { nazwyOsobFirmy } from '../panel/ustawienia-rezerwacji'
import { innaKorektaFaktury, pozostaloDoZwrotu } from '../rdzen/zwroty'
import { mozliwoscKorekty, type MozliwoscKorekty } from './korekta'
import { historiaZwrotu, type WpisHistorii, ZDARZENIA_ZWROTU } from './statusy'

type Db = PrismaClient

export interface PozycjaDoZwrotu {
  orderLineId: string
  productId: string
  nazwa: string
  sku: string
  /** Ile jeszcze można zwrócić (jednostka bazowa produktu). */
  maks: number
  jednostka: 'szt.' | 'g'
}

export interface ZamowienieDoZwrotu {
  id: string
  channel: string
  channelAccountId: string
  externalId: string
  status: string
  pozycje: PozycjaDoZwrotu[]
  /** Stan prowadzi Kompletor (zwrot kończy się przy odbiorze) albo wFirma (po odbiorze korekta faktury). */
  stanKompletora: boolean
}

const nazwaPozycji = (l: { channelName: string | null }, p: { nameAccounting: string; sku: string } | undefined) => l.channelName?.trim() || p?.nameAccounting || p?.sku || 'pozycja'

/** Zamówienie z pozycjami, które jeszcze można zwrócić (wydane minus inne zwroty bez odrzuconych). */
export async function zamowienieDoZwrotu(db: Db, orderId: string): Promise<ZamowienieDoZwrotu | null> {
  organizationIdOf(db)
  const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, channel: true, channelAccountId: true, externalId: true, status: true, lines: { select: { id: true, channelName: true } } } })
  if (!o) return null
  const zostalo = await pozostaloDoZwrotu(db, o.id)
  const produkty = new Map((await db.product.findMany({ where: { id: { in: zostalo.map((x) => x.productId) } }, select: { id: true, sku: true, nameAccounting: true, unit: true } })).map((p) => [p.id, p]))
  const res = zostalo.length ? await db.reservation.findFirst({ where: { orderId, state: 'CONSUMED' }, select: { warehouseId: true } }) : null
  const wh = res ? await db.warehouse.findFirst({ where: { id: res.warehouseId }, select: { stockSource: true } }) : null
  return {
    id: o.id,
    channel: o.channel,
    channelAccountId: o.channelAccountId,
    externalId: o.externalId,
    status: o.status,
    stanKompletora: wh?.stockSource === 'KOMPLETOR',
    pozycje: zostalo.map((z) => {
      const p = produkty.get(z.productId)
      const l = o.lines.find((x) => x.id === z.orderLineId)
      return { orderLineId: z.orderLineId, productId: z.productId, nazwa: nazwaPozycji(l ?? { channelName: null }, p), sku: p?.sku ?? '', maks: z.qty, jednostka: p?.unit === 'KG' ? 'g' : 'szt.' }
    }),
  }
}

export interface PozycjaZwrotu {
  id: string
  nazwa: string
  sku: string
  qty: number
  jednostka: 'szt.' | 'g'
  disposition: 'NA_STAN' | 'USZKODZONE' | 'BRAK' | null
}

export interface KartaZwrotu {
  id: string
  kind: ReturnKind
  status: ReturnStatus
  reason: string | null
  note: string | null
  source: string
  externalId: string | null
  createdAt: Date
  receivedAt: Date | null
  closedAt: Date | null
  moneyRefundedAt: Date | null
  correctionState: string | null
  correctionDocId: string | null
  lastError: string | null
  maZdjecie: boolean
  /** Bez faktury z rozchodem: stan prowadzi Kompletor, zwrot kończy się przy odbiorze paczki. */
  stanKompletora: boolean
  order: { id: string; channel: string; channelAccountId: string; externalId: string }
  pozycje: PozycjaZwrotu[]
  korekta: MozliwoscKorekty
  historia: WpisHistorii[]
}

export async function kartaZwrotu(db: Db, returnId: string): Promise<KartaZwrotu | null> {
  organizationIdOf(db)
  const r = await db.return.findUnique({
    where: { id: returnId },
    select: {
      id: true,
      kind: true,
      status: true,
      reason: true,
      note: true,
      source: true,
      externalId: true,
      createdAt: true,
      receivedAt: true,
      closedAt: true,
      moneyRefundedAt: true,
      correctionState: true,
      correctionDocId: true,
      lastError: true,
      invoiceDocId: true,
      photo: { select: { returnId: true } },
      order: { select: { id: true, channel: true, channelAccountId: true, externalId: true } },
      lines: { orderBy: { id: 'asc' }, select: { id: true, orderLineId: true, productId: true, qty: true, disposition: true } },
    },
  })
  if (!r) return null
  const [produkty, linie, zdarzenia, dok, konto, dokument, org, inna] = await Promise.all([
    db.product.findMany({ where: { id: { in: r.lines.map((l) => l.productId) } }, select: { id: true, sku: true, nameAccounting: true, unit: true } }),
    db.orderLine.findMany({ where: { id: { in: r.lines.map((l) => l.orderLineId) } }, select: { id: true, channelName: true } }),
    db.orderEvent.findMany({ where: { orderId: r.order.id, kind: { in: ZDARZENIA_ZWROTU } }, orderBy: { createdAt: 'asc' }, select: { kind: true, actorId: true, createdAt: true, data: true } }),
    ustawieniaDokumentowFirmy(db),
    db.channelConfig.findFirst({ where: { channel: r.order.channel, channelAccountId: r.order.channelAccountId }, select: { statusMode: true } }),
    // dokument sprzedaży to też faktura KSeF z numerem z serii (program „KSeF bezpośrednio”)
    Promise.all([db.invoiceAttempt.count({ where: { orderId: r.order.id, state: 'ISSUED' } }), db.ksefInvoiceDraft.count({ where: { orderId: r.order.id, returnId: '', numer: { not: null } } })]).then(([w, k]) => w + k),
    db.organization.findFirst({ select: { settings: true } }),
    r.invoiceDocId ? innaKorektaFaktury(db, r.id, r.invoiceDocId) : Promise.resolve(null),
  ])
  const p = new Map(produkty.map((x) => [x.id, x]))
  const ol = new Map(linie.map((x) => [x.id, x]))
  const ids = [...new Set(zdarzenia.map((z) => z.actorId).filter((a) => a.startsWith('user:')).map((a) => a.slice(5)))]
  const osoby = ids.length ? await nazwyOsobFirmy(db, ids) : new Map<string, string>()
  return {
    ...r,
    maZdjecie: !!r.photo,
    stanKompletora: r.invoiceDocId === null,
    pozycje: r.lines.map((l) => {
      const pr = p.get(l.productId)
      return { id: l.id, nazwa: nazwaPozycji(ol.get(l.orderLineId) ?? { channelName: null }, pr), sku: pr?.sku ?? '', qty: l.qty, jednostka: pr?.unit === 'KG' ? 'g' : 'szt.', disposition: l.disposition }
    }),
    korekta: mozliwoscKorekty({ status: r.status, invoiceDocId: r.invoiceDocId, program: dok.program, fakturyWlaczone: dok.fakturyWlaczone, korektyWlaczone: korektyWlaczone(org?.settings ?? null), trybKonta: konto?.statusMode ?? null, maDokument: dokument > 0, correctionState: r.correctionState, poNiewiadomej: !!r.lastError?.startsWith('timeout'), innaKorekta: inna ? (inna.wystawiona ? 'wystawiona' : 'w_drodze') : null }),
    historia: historiaZwrotu(r.id, zdarzenia, osoby),
  }
}
