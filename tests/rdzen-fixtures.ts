// Dane testowe rdzenia: zmyślone produkty i zamówienia. Żadnych prawdziwych danych klientów ani sklepu.
import type { Channel, PaymentState, PrismaClient } from '@prisma/client'
import { expect } from 'vitest'
import { DEFAULT_CHANNEL_ADAPTER } from '@/lib/adaptery'
import { checkInvariants } from '@/lib/rdzen/niezmienniki'
import type { GoodCount, OdczytStanowWfirma } from '@/lib/rdzen/kolejka-wfirmy'
import { type FakturyWfirma, type FoundInvoice, type InvoiceLine, type IssueResult, WfirmaLimitError } from '@/lib/rdzen/rozchod'
import type { CorrectionResult, FoundCorrection, KorektyWfirma } from '@/lib/rdzen/zwroty'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import type { IncomingLine, IncomingOrder } from '@/lib/rdzen/zamowienia'
import { organizationIdOf } from '@/lib/db'

export const T0 = new Date('2026-10-15T08:00:00Z') // czwartek 10:00 w Warszawie

/** Etykiety kont testowych (nazwy) → typ kanału + konto. Trzy sklepy Woo to trzy konta kanału WOO. */
export const ACC = {
  WOO_SD: { channel: 'WOO', channelAccountId: 'sd' },
  WOO_LAMPY: { channel: 'WOO', channelAccountId: 'lampy' },
  WOO_KOLOROWYKUBEK: { channel: 'WOO', channelAccountId: 'km' },
  ALLEGRO: { channel: 'ALLEGRO', channelAccountId: 'allegro' },
  EMPIK: { channel: 'EMPIK', channelAccountId: 'empik' },
  RECZNE: { channel: 'RECZNE', channelAccountId: 'panel' },
  EASYTOOLS: { channel: 'EASYTOOLS', channelAccountId: 'et' },
  BL_INNE: { channel: 'BL_INNE', channelAccountId: 'bl' },
} as const satisfies Record<string, { channel: Channel; channelAccountId: string }>
export type TestChannel = keyof typeof ACC

export async function seedBase(db: PrismaClient): Promise<void> {
  await db.warehouse.create({ data: { id: DEFAULT_WAREHOUSE, name: 'Główny (test)', wfirmaWarehouseId: '999001', stockSource: 'WFIRMA' } })
  const labels: TestChannel[] = ['WOO_SD', 'WOO_LAMPY', 'WOO_KOLOROWYKUBEK', 'ALLEGRO', 'EMPIK', 'RECZNE']
  await db.channelConfig.createMany({ data: labels.map((l) => ({ ...ACC[l], name: `${l} test`, adapterKey: DEFAULT_CHANNEL_ADAPTER[ACC[l].channel] })) })
}

export async function product(
  db: PrismaClient,
  sku: string,
  stock: number,
  opts: { unit?: 'SZT' | 'KG'; priceGross?: number; vatRate?: string; readAt?: Date; wfirmaGoodId?: string } = {},
): Promise<string> {
  const p = await db.product.create({
    data: {
      sku,
      wfirmaGoodId: opts.wfirmaGoodId ?? null,
      kind: 'STOCKED',
      unit: opts.unit ?? 'SZT',
      nameAccounting: `Towar testowy ${sku}`,
      title: `Towar testowy ${sku}`,
      priceGross: (opts.priceGross ?? 10).toFixed(2),
      vatRate: opts.vatRate ?? '23',
    },
  })
  await db.stock.create({
    data: { productId: p.id, warehouseId: DEFAULT_WAREHOUSE, wfirmaCount: stock, physical: stock, wfirmaReadAt: opts.readAt ?? new Date('2026-01-01T00:00:00Z') },
  })
  return p.id
}

export async function bundle(db: PrismaClient, sku: string, parts: { id: string; qty: number }[]): Promise<string> {
  const p = await db.product.create({ data: { sku, kind: 'BUNDLE', unit: 'SZT', nameAccounting: `Zestaw ${sku}`, title: `Zestaw ${sku}` } })
  await db.bundleComponent.createMany({ data: parts.map((x) => ({ bundleId: p.id, componentId: x.id, qtyBase: x.qty })) })
  return p.id
}

export async function offer(db: PrismaClient, label: TestChannel, externalId: string, productId: string, opts: { qtyBasePerOffer?: number; safetyBuffer?: number } = {}): Promise<string> {
  const o = await db.channelOffer.create({
    data: { ...ACC[label], externalId, productId, qtyBasePerOffer: opts.qtyBasePerOffer ?? 1, safetyBuffer: opts.safetyBuffer ?? null },
  })
  return o.id
}

let seq = 0
export function order(
  lines: (Partial<IncomingLine> & { productId?: string; qty: number })[],
  overIn: Omit<Partial<IncomingOrder>, 'channel'> & { channel?: TestChannel } = {},
): IncomingOrder {
  seq++
  const { channel: label = 'WOO_SD', ...over } = overIn
  const { channel, channelAccountId } = ACC[label]
  return {
    source: 'test',
    channel,
    channelAccountId,
    externalId: `T-${seq}-${Math.random().toString(36).slice(2, 8)}`,
    externalRevision: '1',
    createdAtChannel: T0,
    paymentState: 'PAID' as PaymentState,
    paymentMethod: 'BLIK',
    totalGross: 100,
    deliveryMethod: channel === 'ALLEGRO' ? 'Allegro One Box' : 'Paczkomaty InPost',
    lines: lines.map((l, i) => ({ externalLineId: `L${i + 1}`, unitPriceGross: 10, ...l })),
    ...over,
  }
}

export async function stockOf(db: PrismaClient, productId: string) {
  const s = await db.stock.findUniqueOrThrow({ where: { productId_warehouseId: { productId, warehouseId: DEFAULT_WAREHOUSE } } })
  return { ...s, available: Math.max(0, s.physical - s.reserved) }
}

export async function expectInvariants(db: PrismaClient): Promise<void> {
  const v = await checkInvariants(db)
  expect(v, JSON.stringify(v, null, 1)).toEqual([])
}

/** Atrapa wFirmy: faktury w pamięci, sterowane wyniki. Zero połączeń z prawdziwą wFirmą. */
export class FakeWfirma implements FakturyWfirma, KorektyWfirma, OdczytStanowWfirma {
  invoices: (FoundInvoice & { lines: InvoiceLine[]; contentIds: Record<string, string>; type: 'normal' | 'simple' })[] = []
  corrections: (FoundCorrection & { invoiceDocId: string; lines: { productId: string; qty: number }[] })[] = []
  calls = 0
  /** kolejność wszystkich wywołań (issue, find, readWz, correction, findCorrection, readGoods, page, otherWh) — 44c */
  log: string[] = []
  next: ('OK' | 'ERROR' | 'TIMEOUT_AFTER_CREATE' | 'TIMEOUT_NO_CREATE' | 'LIMIT')[] = []
  /** czas podany przez wFirmę w wyniku LIMIT faktury i korekty */
  limitRetryAfterMs: number | undefined
  correctionNext: ('OK' | 'ERROR' | 'TIMEOUT_AFTER_CREATE' | 'TIMEOUT_NO_CREATE' | 'LIMIT')[] = []
  /** odczyty (goods, strony, WZ, find): kolejne wyniki; LIMIT = WfirmaLimitError */
  readNext: ('OK' | 'LIMIT')[] = []
  wzOverride: ((productId: string, qty: number) => number | null) | null = null
  /** 2.2 pkt 5 v1.5: tyle kolejnych odczytów WZ (także ten zaraz po fakturze) kończy się błędem (null) */
  wzReadFailures = 0
  /** faktura `simple` (bez WZ) → WZ 0 */
  invoiceType: 'normal' | 'simple' = 'normal'
  /** PZ korekty per produkt (domyślnie = ilość korekty) */
  pzOverride: ((productId: string, qty: number) => number | null) | null = null
  /** 3.4 v1.5: wFirma ignorująca nieznane pole filtra — find oddaje wszystkie dokumenty */
  ignoreFindFilter = false
  /** find „nie widzi” dokumentów (złe pole/endpoint) — zawsze puste, osobno faktury i korekty */
  findInvoicesEmpty = false
  findCorrectionsEmpty = false
  /** stany per `<magazyn>:<towar>` w jednostce wFirmy */
  counts = new Map<string, number>()
  pageSize = 2
  warehousesSeen = new Set<string>()
  /** przesunięcie zegara wFirmy (24b) — rdzeń go nie używa, więc wynik ma być ten sam */
  clockSkewMs = 0

  private readGate(kind: string): void {
    this.log.push(kind)
    if (this.readNext.shift() === 'LIMIT') throw new WfirmaLimitError('atrapa: TOTAL REQUESTS LIMIT EXCEEDED')
  }

  private wzOf(doc: { lines: InvoiceLine[]; type: 'normal' | 'simple' }): Record<string, number | null> {
    const wz: Record<string, number | null> = {}
    if (this.wzReadFailures > 0) {
      this.wzReadFailures--
      for (const l of doc.lines) wz[l.productId] = null
      return wz
    }
    for (const l of doc.lines) wz[l.productId] = (wz[l.productId] ?? 0) + (doc.type === 'simple' ? 0 : this.wzOverride ? (this.wzOverride(l.productId, l.qty) ?? 0) : l.qty)
    if (this.wzOverride && doc.type !== 'simple') for (const l of doc.lines) if (this.wzOverride(l.productId, l.qty) === null) wz[l.productId] = null
    return wz
  }

  async issue(req: { idExternal: string; lines: InvoiceLine[] }): Promise<IssueResult> {
    this.calls++
    this.log.push('issue')
    const mode = this.next.shift() ?? 'OK'
    if (mode === 'ERROR') return { kind: 'ERROR', message: 'atrapa: dokument nie powstał' }
    if (mode === 'LIMIT') return { kind: 'LIMIT', message: 'atrapa: TOTAL REQUESTS LIMIT EXCEEDED', retryAfterMs: this.limitRetryAfterMs }
    if (mode === 'TIMEOUT_NO_CREATE') return { kind: 'TIMEOUT' }
    // pozycja faktury niesie tylko warehouse_document_content.id; ilość WZ = osobny odczyt dokumentu WZ (2.2 pkt 5 v1.5)
    const contentIds = Object.fromEntries(req.lines.map((l, i) => [l.productId, `wdc-${this.invoices.length + 1}-${i + 1}`]))
    const doc = { docId: `FV/${this.invoices.length + 1}`, idExternal: req.idExternal, wz: {}, lines: req.lines, contentIds, type: this.invoiceType, serverTime: new Date(Date.now() + this.clockSkewMs) }
    doc.wz = this.wzOf(doc)
    this.invoices.push(doc)
    if (mode === 'TIMEOUT_AFTER_CREATE') return { kind: 'TIMEOUT' }
    return { kind: 'OK', docId: doc.docId, wz: doc.wz }
  }

  async findByPrefix(prefix: string): Promise<FoundInvoice[]> {
    this.readGate('find')
    if (this.findInvoicesEmpty) return []
    return this.invoices.filter((i) => this.ignoreFindFilter || i.idExternal.startsWith(prefix)).map((i) => ({ ...i, wz: this.wzOf(i) }))
  }

  async readWz(docId: string): Promise<Record<string, number | null>> {
    this.readGate('readWz')
    const doc = this.invoices.find((i) => i.docId === docId)
    return doc ? this.wzOf(doc) : {}
  }

  async issueCorrection(req: { idExternal: string; invoiceDocId: string; lines: { productId: string; qty: number }[] }): Promise<CorrectionResult> {
    this.log.push('correction')
    const mode = this.correctionNext.shift() ?? 'OK'
    if (mode === 'ERROR') return { kind: 'ERROR', message: 'atrapa: korekta odrzucona' }
    if (mode === 'LIMIT') return { kind: 'LIMIT', message: 'atrapa: TOTAL REQUESTS LIMIT EXCEEDED', retryAfterMs: this.limitRetryAfterMs }
    if (mode === 'TIMEOUT_NO_CREATE') return { kind: 'TIMEOUT' }
    const pz: Record<string, number | null> = {}
    for (const l of req.lines) pz[l.productId] = this.pzOverride ? this.pzOverride(l.productId, l.qty) : l.qty
    const doc = { docId: `KOR/${this.corrections.length + 1}`, idExternal: req.idExternal, invoiceDocId: req.invoiceDocId, lines: req.lines, pz }
    this.corrections.push(doc)
    if (mode === 'TIMEOUT_AFTER_CREATE') return { kind: 'TIMEOUT' }
    return { kind: 'OK', docId: doc.docId, pz }
  }

  async findCorrectionsByPrefix(prefix: string): Promise<FoundCorrection[]> {
    this.readGate('findCorrection')
    if (this.findCorrectionsEmpty) return []
    return this.corrections.filter((c) => this.ignoreFindFilter || c.idExternal.startsWith(prefix))
  }

  async readGoods(goodIds: string[], warehouseId: string): Promise<GoodCount[]> {
    this.readGate('readGoods')
    this.warehousesSeen.add(warehouseId)
    return goodIds.filter((g) => this.counts.has(`${warehouseId}:${g}`)).map((g) => ({ wfirmaGoodId: g, count: this.counts.get(`${warehouseId}:${g}`)! }))
  }

  async readGoodsPage(page: number, warehouseId: string): Promise<{ items: GoodCount[]; last: boolean }> {
    this.readGate('page')
    this.warehousesSeen.add(warehouseId)
    const all = [...this.counts].filter(([k]) => k.startsWith(`${warehouseId}:`)).sort(([a], [b]) => (a < b ? -1 : 1))
    const slice = all.slice((page - 1) * this.pageSize, page * this.pageSize)
    return { items: slice.map(([k, count]) => ({ wfirmaGoodId: k.slice(warehouseId.length + 1), count })), last: page * this.pageSize >= all.length }
  }

  async readOtherWarehouses(exceptWarehouseId: string): Promise<{ warehouseId: string; wfirmaGoodId: string; count: number }[]> {
    this.readGate('otherWh')
    return [...this.counts]
      .map(([k, count]) => ({ warehouseId: k.slice(0, k.indexOf(':')), wfirmaGoodId: k.slice(k.indexOf(':') + 1), count }))
      .filter((r) => r.warehouseId !== exceptWarehouseId && r.count !== 0)
  }
}

/** Udany odczyt zamówień konta kanału w chwili `at` (kursor odczytu: `lastOkAt`), jak po przebiegu workera. */
export async function udanyOdczytKonta(db: PrismaClient, channel: Channel, channelAccountId: string, at: Date): Promise<void> {
  await db.channelCursor.upsert({
    where: { organizationId_channel_channelAccountId: { organizationId: organizationIdOf(db), channel, channelAccountId } },
    create: { channel, channelAccountId, adapterKey: 'test', firstPollAt: at, lastPollStartedAt: at, lastPollFinishedAt: at, lastOkAt: at },
    update: { lastPollStartedAt: at, lastPollFinishedAt: at, lastOkAt: at },
  })
}
