// Faktury BL w cieniu (krok 1; spec 9.1): w cieniu fakturę wystawia BL, więc rezerwacja zamówienia, które
// BL zafakturował, ma przejść w CONSUMED (inaczej `available` w cieniu spada z każdym dniem). Co ≤ 2 min: BL
// `getInvoices` (tylko get*, od ostatniego numeru faktury) → kopia BlInvoiceSnapshot (same numery i daty, bez danych
// nabywcy) → zamówienie rdzenia po Order.blOrderId → ilości WZ z wFirmy (`warehouse_documents/find`, tylko odczyt)
// → `applyBlInvoice` (rozchod.ts). BL „Wysłane” bez faktury → `applyBlShippedWithoutInvoice` (ruch MANUAL do biura).
// Zapis wyłącznie w naszej bazie.
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { kontoWPodgladzie, samonaprawaPoFakturzeBl, type SamonaprawaFakturBl, zglosDwieFaktury } from '../rdzen/faktura-bl'
import { applyBlInvoice, applyBlShippedWithoutInvoice, rozliczPozneWzFakturyBl } from '../rdzen/rozchod'
import { toWarsaw } from '../rdzen/kalendarz'
import { alert } from '../rdzen/stan'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'
import { type WfirmaReadOnly, wfirmaItems } from '../zrodla/wfirma'
import { blStatusFamily, type BlFamily } from './bl-porownanie'
import { pairOrdersFromBlInvoices, type PobierzZamowienieBl, type UzupelnijNumerKanalu } from './parowanie-faktur'

export const INVOICES_JOB = 'cien-bl-faktury'

/** Ile przebiegów (co ~2 min) czekamy na WZ w wFirmie, zanim faktura idzie z ruchem MANUAL (biuro poprawia). */
export const WZ_MAX_ATTEMPTS = 15
/** Od tylu faktur w przebiegu „WZ dla żadnej” traktujemy jako złą konfigurację (dopóki żadna faktura nie dostała WZ). */
const MIN_CHECKED_FOR_CONFIG = 3
/** Faktura BL bez naszego zamówienia po tylu dniach = poza cieniem (zamówienie sprzed cienia albo spoza kanałów). */
const OUTSIDE_SHADOW_MS = 3 * 24 * 3600_000
/** Statusy BL „towar wyszedł” (spec 9.1: „Wysłane” bez faktury). */
const SHIPPED: BlFamily[] = ['WYSLANE', 'ODEBRANE']
/**
 * Ile razy w jednym przebiegu czytamy z BL numer faktury w wFirmie dla pojedynczej faktury (`getInvoices` po
 * `invoice_id`). Tylko faktury bez numeru wFirmy w kopii: czekające na WZ albo rozliczone bez WZ. Reszta w kolejnym przebiegu.
 */
export const MAX_ODCZYTOW_NUMERU = 20
/** Faktury BL rozliczone bez WZ sprawdzamy jeszcze tyle dni (WZ albo numer wFirmy mogą dojść później). */
export const POZNE_WZ_DNI = 60
/** Ile faktur rozliczonych bez WZ sprawdzamy w jednym przebiegu. */
const POZNE_WZ_NA_PRZEBIEG = 10
/** Odstępy kolejnych sprawdzeń faktury rozliczonej bez WZ (potem co ostatni odstęp). */
export const POZNE_WZ_ODSTEPY_MS = [10 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000]

export interface BlInvoiceHeader {
  blInvoiceId: number
  blOrderId: number
  number: string
  externalNumber: string | null
  kind: string | null
  dateAdd: Date
}

/** Pozycja faktury BL: SKU, ilość, cena, stawka. Nazwa pozycji nie jest czytana. */
export interface BlInvoiceLine {
  sku: string | null
  qty: number
  priceGross: number
  taxRate: number | null
  shipment: boolean
}

/** Treść faktury BL do porównania z naszą. Pola z tej samej odpowiedzi `getInvoices`, bez nowych odczytów. */
export interface BlInvoiceContent {
  totalGross: number | null
  totalNet: number | null
  paymentName: string | null
  lines: BlInvoiceLine[] | null
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && v !== 0 ? String(v) : null)

/** Nagłówek faktury BL: numery, typ, data. Nabywca, adres, NIP i pozycje nie wychodzą z tej funkcji. */
export function blInvoiceHeader(o: Record<string, unknown>): BlInvoiceHeader | null {
  const id = num(o['invoice_id'])
  const orderId = num(o['order_id'])
  const number = str(o['number'])
  const dateAdd = num(o['date_add'])
  if (id === null || orderId === null || !number || dateAdd === null) return null
  return { blInvoiceId: id, blOrderId: orderId, number, externalNumber: str(o['external_invoice_number']), kind: str(o['type']), dateAdd: new Date(dateAdd * 1000) }
}

/**
 * Sama nazwa metody płatności: BL dokleja do niej konto płacącego („PayPal - adres@…”), a to dane
 * osobowe. Ucinamy od „ - ” i od pierwszego słowa z `@`; nazwa z samego adresu daje null.
 */
export function blPaymentName(v: unknown): string | null {
  const nazwa = str(v)
  if (!nazwa) return null
  const bezDopisku = nazwa.split(/\s[-–—]\s/)[0]!
  const slowa = bezDopisku.split(/\s+/)
  const at = slowa.findIndex((s) => s.includes('@'))
  return (at < 0 ? slowa : slowa.slice(0, at)).join(' ').trim() || null
}

/** Sumy, nazwa płatności i pozycje faktury BL; biała lista pól: nabywca, adres i NIP nie wychodzą z tej funkcji. */
export function blInvoiceContent(o: Record<string, unknown>): BlInvoiceContent {
  const items = Array.isArray(o['items']) ? (o['items'] as Record<string, unknown>[]) : null
  return {
    totalGross: num(o['total_price_brutto']),
    totalNet: num(o['total_price_netto']),
    paymentName: blPaymentName(o['payment']),
    lines: items ? items.map((i) => ({ sku: str(i['sku']), qty: num(i['quantity']) ?? 0, priceGross: num(i['price_brutto']) ?? 0, taxRate: num(i['tax_rate']), shipment: num(i['is_shipment']) === 1 })) : null,
  }
}

/** Ile stron po 100 faktur czytamy w jednym przebiegu; więcej = odczyt niepełny (reszta w następnym przebiegu). */
const MAX_INVOICE_PAGES = 100

/**
 * Faktury BL od `idFrom` (włącznie) albo od daty; strony po 100 (limit BL). `beforeId` (douczytanie wstecz):
 * tylko faktury o numerze niższym, odczyt kończy się na pierwszej stronie, która go osiąga.
 */
export async function fetchBlInvoices(bl: BaseLinkerReadOnly, from: { idFrom?: number; dateFromUnix?: number; beforeId?: number }): Promise<{ headers: (BlInvoiceHeader & BlInvoiceContent)[]; complete: boolean; errors: string[] }> {
  const headers: (BlInvoiceHeader & BlInvoiceContent)[] = []
  const errors: string[] = []
  const seen = new Set<number>()
  let idFrom = from.idFrom
  let complete = true
  for (let guard = 0; ; guard++) {
    if (guard >= MAX_INVOICE_PAGES) {
      // jak fetchBlOrdersAdded: wyczerpany limit stron to odczyt niepełny, nie „wszystko”
      errors.push(`ponad ${MAX_INVOICE_PAGES} stron getInvoices — przerwane`)
      complete = false
      break
    }
    let batch: Record<string, unknown>[]
    try {
      const r = await bl.call<{ invoices?: Record<string, unknown>[] }>('getInvoices', idFrom !== undefined ? { id_from: idFrom } : { date_from: from.dateFromUnix ?? 0 })
      batch = Array.isArray(r.invoices) ? r.invoices : []
    } catch (e) {
      errors.push(`getInvoices: ${e instanceof Error ? e.message : String(e)}`)
      complete = false
      break
    }
    let fresh = 0
    let maxId = idFrom ?? 0
    for (const o of batch) {
      const h = blInvoiceHeader(o)
      if (!h) {
        errors.push('faktura BL bez numeru, zamówienia albo daty — pominięta')
        continue
      }
      maxId = Math.max(maxId, h.blInvoiceId)
      if (from.beforeId !== undefined && h.blInvoiceId >= from.beforeId) continue
      if (seen.has(h.blInvoiceId)) continue
      seen.add(h.blInvoiceId)
      fresh++
      headers.push({ ...h, ...blInvoiceContent(o) })
    }
    if (batch.length < 100 || fresh === 0) break
    if (from.beforeId !== undefined && maxId >= from.beforeId) break
    idFrom = maxId + 1
  }
  return { headers, complete, errors }
}

// ─── WZ z wFirmy (tylko odczyt) ─────────────────────────────────────────────

export interface WzLine {
  wfirmaGoodId: string
  /** Ilość w jednostce wFirmy (szt. albo kg). */
  count: number
}

/** Odczyt ilości wydanych (WZ) do faktury. null = faktury albo WZ jeszcze nie ma (spróbujemy później). */
export interface WzOdczyt {
  wzForInvoice(docNumber: string): Promise<WzLine[] | null>
}

const cond = (field: string, value: string) => ({ parameters: { conditions: { condition: { field, operator: 'eq', value } }, limit: 5 } })

/**
 * WZ do faktury z wFirmy: `invoices/find` po pełnym numerze → `warehouse_documents/find` po id faktury → pozycje.
 * Tylko odczyty `find` (blokada zapisu w kliencie). Nazwy pól warunków (`fullnumber`, `invoice_id`) i kształt pozycji WZ są
 * z dokumentacji API2 — do potwierdzenia na żywo przy pierwszym przebiegu (atrapa w testach ma ten sam kształt).
 */
export class WfirmaWzReader implements WzOdczyt {
  constructor(private readonly wf: Pick<WfirmaReadOnly, 'call'>) {}

  async wzForInvoice(docNumber: string): Promise<WzLine[] | null> {
    const inv = await this.wf.call<Record<string, unknown>>('invoices/find', { invoices: cond('fullnumber', docNumber) })
    const found = wfirmaItems<{ id?: unknown }>(inv['invoices'], 'invoice')
    const invoiceId = str(found[0]?.id)
    if (!invoiceId) return null
    return this.wzForInvoiceId(invoiceId, docNumber)
  }

  /** Pozycje WZ faktury o znanym id wFirmy (`readWz` adaptera podglądu). */
  async wzForInvoiceId(invoiceId: string, docNumber: string = invoiceId): Promise<WzLine[] | null> {
    const wz = await this.wf.call<Record<string, unknown>>('warehouse_documents/find', { warehouse_documents: cond('invoice_id', invoiceId) })
    const docs = wfirmaItems<Record<string, unknown>>(wz['warehouse_documents'], 'warehouse_document')
    if (!docs.length) return null
    const out: WzLine[] = []
    for (const d of docs) {
      for (const c of wfirmaItems<Record<string, unknown>>(d['warehouse_document_contents'], 'warehouse_document_content')) {
        const goodId = str((c['good'] as Record<string, unknown> | undefined)?.['id'])
        const count = num(c['count'])
        if (!goodId || count === null) throw new Error(`wFirma: nieczytelna pozycja WZ do faktury ${docNumber}`) // nieczytelne to błąd, nie 0
        out.push({ wfirmaGoodId: goodId, count })
      }
    }
    return out
  }
}

/** Pozycje WZ → ilość w jednostce bazowej per productId (kg → g). Towar spoza katalogu pomijany (zostanie MANUAL). */
export async function wzByProduct(db: Pick<PrismaClient, 'product'>, lines: WzLine[]): Promise<Record<string, number>> {
  const products = await db.product.findMany({ where: { wfirmaGoodId: { in: [...new Set(lines.map((l) => l.wfirmaGoodId))] } }, select: { id: true, wfirmaGoodId: true, unit: true } })
  const byGood = new Map(products.map((p) => [p.wfirmaGoodId!, p]))
  const out: Record<string, number> = {}
  for (const l of lines) {
    const p = byGood.get(l.wfirmaGoodId)
    if (!p) continue
    out[p.id] = (out[p.id] ?? 0) + Math.round(p.unit === 'KG' ? l.count * 1000 : l.count)
  }
  return out
}

/**
 * Zamówienie z samymi produktami bez stanu (DIGITAL, e-book) — BL wystawia fakturę, a ze stanu nie ma czego
 * zdjąć. Liczą się pozycje nieusunięte; pozycja bez produktu albo anulowane zamówienie to nie „bez stanu”.
 */
async function digitalOnly(db: PrismaClient, orderId: string): Promise<boolean> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { status: true, lines: { where: { removed: false }, select: { productId: true } } } })
  if (!o || o.status === 'ANULOWANE' || !o.lines.length || o.lines.some((l) => !l.productId)) return false
  const ids = [...new Set(o.lines.map((l) => l.productId!))]
  return (await db.product.count({ where: { id: { in: ids }, kind: 'DIGITAL' } })) === ids.length
}

/**
 * Ustawienie firmy `cien.wzOptional`: firma nie wystawia WZ w wFirmie, więc faktura bez WZ idzie od razu torem
 * BEZ_WZ — bez czekania na WZ i bez bezpiecznika. Domyślnie wyłączone (WZ obowiązkowe). Czytane z surowego
 * JSON ustawień, bez `parseOrgSettings`.
 * Uwaga: tor BEZ_WZ daje ruch MANUAL na każdej pozycji, więc lista biura rośnie, po dobie idzie `RUCH_ZALEGLY` per pozycja,
 * a raport dzienny nigdy nie będzie `ok`. Nie włączać drugiej firmie bez decyzji, co znaczy rozchód bez WZ.
 */
async function wzOptionalOf(db: PrismaClient): Promise<boolean> {
  const org = await db.organization.findFirst({ select: { settings: true } })
  const s = org?.settings
  const cien = s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>)['cien'] : undefined
  return !!cien && typeof cien === 'object' && !Array.isArray(cien) && (cien as Record<string, unknown>)['wzOptional'] === true
}

// ─── Przebieg ───────────────────────────────────────────────────────────────

export interface InvoiceSyncStats {
  fetched: number
  applied: number
  withoutWz: number
  nothingToConsume: number
  /** Zamówienia z samymi produktami bez stanu (DIGITAL, e-book): faktura bez rozchodu (`BEZ_STANU`). */
  digitalOnly: number
  corrections: number
  outsideShadow: number
  waitingForOrder: number
  waitingForWz: number
  waitingNoWfirma: number
  shippedWithoutInvoice: number
  /** zamówienia, które dostały parę z BL od strony faktury (złożone przed oknem porównania). */
  pairedFromInvoice?: number
  /** faktury dopisane jednorazowym douczytaniem wstecz. */
  backfilled?: number
  /** Odczyty numeru zamówienia ze sklepu przy parze od strony faktury. */
  numbersRead?: number
  /** Odczyty numeru przerwane błędem sklepu: faktury czekają na następny przebieg. */
  numbersFailed?: number
  /** Faktury BL, którym numer wFirmy doczytano z BL (kopia nie miała numeru). */
  numeryWfirmyDoczytane?: number
  /** Ruchy faktur BL rozliczonych bez WZ, zamknięte później dokumentem WZ znalezionym w wFirmie. */
  pozneWz?: number
  /** Rezerwacje i braki zamówień z zastosowaną fakturą BL rozliczone samonaprawą (tylko gdy było co rozliczyć). */
  samonaprawa?: Omit<SamonaprawaFakturBl, 'bledy'>
  errors: string[]
  blComplete: boolean
}

export interface InvoiceSyncOpts {
  now?: Date
  /** Pierwszy odczyt (pusta kopia faktur): od ilu ms wstecz. */
  initialLookbackMs?: number
  /** odczyt zamówienia BL po numerze, gdy faktura BL nie ma naszego zamówienia, a kopii zamówienia BL brak. */
  fetchBlOrder?: PobierzZamowienieBl | null
  /** Numer zamówienia w kanale odczytem ze sklepu (tylko odczyt) dla zamówień bez numeru, gdy para po nim nie powstała. */
  uzupelnijNumer?: UzupelnijNumerKanalu | null
  /**
   * jednorazowe douczytanie faktur BL za tyle dni przed najstarszą fakturą w kopii (faktury sprzed startu
   * odczytu faktur, np. 27.10–01.11). Po pełnym odczycie znacznik w `settings.cien.fakturyBlWstecz` i więcej się nie
   * uruchamia; 0 albo brak = wyłączone.
   */
  backfillDays?: number
}

/** domyślny zasięg douczytania wstecz (jak pierwszy odczyt WZ z wFirmy, `WZ_LOOKBACK_DAYS`). */
export const INVOICES_BACKFILL_DAYS = 14

const objOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/**
 * faktury BL wystawione przed pierwszym odczytem faktur nie trafiły do kopii (pierwszy
 * odczyt bierze tylko okno cienia), więc ich rezerwacje wisiały, a WZ z wFirmy nie miały po czym związać się z
 * zamówieniem. Jeden raz: `getInvoices` od (najstarsza faktura w kopii − `days`) do niej (bez niej), kopia jak zwykle
 * (`upsert` bez nadpisania — powtórka niczego nie zmienia). Znacznik dopiero po pełnym odczycie, więc przerwany odczyt
 * ponowi się w kolejnym przebiegu. Pierwszy przebieg firmy (pusta kopia) robi zwykły odczyt; douczytanie w następnym.
 */
async function backfillBlInvoices(db: PrismaClient, bl: BaseLinkerReadOnly, days: number, now: Date, stats: InvoiceSyncStats): Promise<void> {
  const organizationId = organizationIdOf(db)
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } })
  const settings = objOf(org?.settings)
  const cien = objOf(settings['cien'])
  if (cien['fakturyBlWstecz']) return
  const oldest = await db.blInvoiceSnapshot.findFirst({ orderBy: { blInvoiceId: 'asc' }, select: { blInvoiceId: true, dateAdd: true } })
  if (!oldest) return
  const from = new Date(oldest.dateAdd.getTime() - days * 86400_000)
  const f = await fetchBlInvoices(bl, { dateFromUnix: Math.floor(from.getTime() / 1000), beforeId: oldest.blInvoiceId })
  stats.errors.push(...f.errors.map((e) => `douczytanie faktur BL: ${e}`))
  for (const h of f.headers) {
    await db.blInvoiceSnapshot.upsert({
      where: { organizationId_blInvoiceId: { organizationId, blInvoiceId: h.blInvoiceId } },
      create: { ...h, lines: (h.lines ?? undefined) as Prisma.InputJsonValue | undefined, fetchedAt: now },
      update: {},
    })
  }
  stats.backfilled = f.headers.length
  if (!f.complete) return
  await db.organization.update({
    where: { id: organizationId },
    data: { settings: { ...settings, cien: { ...cien, fakturyBlWstecz: { od: from.toISOString(), doFaktury: oldest.blInvoiceId, faktur: f.headers.length, at: now.toISOString() } } } as Prisma.InputJsonValue },
  })
}

/**
 * Jeden przebieg: nowe faktury BL → kopia → rozliczenie oczekujących → „Wysłane bez faktury”. Błąd jednej faktury
 * (odczyt WZ, transakcja) zostaje w `lastError` i ponowi się w kolejnym przebiegu; reszta idzie dalej.
 * Bez odczytu wFirmy (brak kluczy) faktury czekają — bez WZ nie zgadujemy rozchodu (ruch MANUAL na każdej pozycji
 * zalałby biuro); wyjątek to firma z `cien.wzOptional`.
 */
/**
 * Faktura BL przy zamówieniu bez nic do rozliczenia: alert o dwóch fakturach, gdy Kompletor ma do niego dokument sprzedaży
 * w toku albo wystawiony, zamówienie nie jest anulowane, a konto pracuje w Kompletorze (podgląd bez zmian). Jeden alert
 * na zamówienie (klucz deduplikacji), powtórka nic nie dodaje.
 */
async function dwieFakturyBezRozliczenia(db: PrismaClient, orderId: string, docId: string): Promise<void> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, channel: true, channelAccountId: true, channelNumber: true, externalId: true } })
  if (!o || o.status === 'ANULOWANE') return
  if (!(await db.invoiceAttempt.count({ where: { orderId, state: { in: ['SENDING', 'UNKNOWN', 'ISSUED'] } } }))) return
  if (await kontoWPodgladzie(db, o)) return
  await zglosDwieFaktury(db, o, docId, { bezRozliczenia: true })
}

type KopiaFakturyBl = { organizationId: string; blInvoiceId: number; externalNumber: string | null }

/**
 * Numer faktury w wFirmie odczytany z BL dla jednej faktury (`getInvoices` po `invoice_id`, tylko odczyt) i zapisany
 * w kopii. null = BL dalej go nie podaje, budżet przebiegu wyczerpany albo błąd odczytu (błąd do błędów przebiegu,
 * faktura idzie dalej jak bez numeru).
 */
async function doczytajNumerWfirmy(db: PrismaClient, bl: BaseLinkerReadOnly, inv: KopiaFakturyBl, budzet: { numery: number }, stats: InvoiceSyncStats): Promise<string | null> {
  if (inv.externalNumber) return inv.externalNumber
  if (budzet.numery <= 0) return null
  budzet.numery--
  let ext: string | null = null
  try {
    const r = await bl.call<{ invoices?: Record<string, unknown>[] }>('getInvoices', { invoice_id: inv.blInvoiceId })
    const h = (Array.isArray(r.invoices) ? r.invoices : []).map(blInvoiceHeader).find((x) => x?.blInvoiceId === inv.blInvoiceId)
    ext = h?.externalNumber ?? null
  } catch (e) {
    stats.errors.push(`numer wFirmy faktury BL ${inv.blInvoiceId}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  if (!ext) return null
  await db.blInvoiceSnapshot.update({ where: { organizationId_blInvoiceId: { organizationId: inv.organizationId, blInvoiceId: inv.blInvoiceId } }, data: { externalNumber: ext } })
  stats.numeryWfirmyDoczytane = (stats.numeryWfirmyDoczytane ?? 0) + 1
  return ext
}

/**
 * Naprawa wstecz: faktura BL rozliczona bez WZ (ruchy BL_INVOICE w MANUAL), bo kopia nie miała jeszcze numeru wFirmy
 * albo WZ powstało później. Dla ruchów z ostatnich `POZNE_WZ_DNI` dni, najwyżej `POZNE_WZ_NA_PRZEBIEG` faktur, każda
 * w odstępach `POZNE_WZ_ODSTEPY_MS`: numer wFirmy z kopii (brak = odczyt z BL), WZ w wFirmie po tym numerze, a gdy jest,
 * rozliczenie jak zwykle (`rozliczPozneWzFakturyBl`). WZ przypisane już innemu zamówieniu nie rozlicza drugi raz. Każda
 * faktura osobno: błąd jednej nie wstrzymuje reszty.
 */
async function rozliczPozneWz(db: PrismaClient, bl: BaseLinkerReadOnly, wz: WzOdczyt, now: Date, budzet: { numery: number }, stats: InvoiceSyncStats): Promise<void> {
  let ruchy: { id: string; orderId: string | null; wfirmaDocId: string | null; wzTries: number }[]
  try {
    ruchy = await db.pendingMovement.findMany({
      where: { type: 'BL_INVOICE', state: 'MANUAL', orderId: { not: null }, wfirmaDocId: { not: null }, createdAt: { gte: new Date(now.getTime() - POZNE_WZ_DNI * 86400_000) }, OR: [{ nextWzReadAt: null }, { nextWzReadAt: { lte: now } }] },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, orderId: true, wfirmaDocId: true, wzTries: true },
    })
  } catch (e) {
    stats.errors.push(`faktury BL bez WZ: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  const grupy = new Map<string, { orderId: string; doc: string; ruchy: typeof ruchy }>()
  for (const m of ruchy) {
    const k = JSON.stringify([m.orderId, m.wfirmaDocId])
    const g = grupy.get(k) ?? { orderId: m.orderId!, doc: m.wfirmaDocId!, ruchy: [] }
    g.ruchy.push(m)
    grupy.set(k, g)
  }
  for (const g of [...grupy.values()].slice(0, POZNE_WZ_NA_PRZEBIEG)) {
    try {
      const inv = await db.blInvoiceSnapshot.findFirst({ where: { orderId: g.orderId, AND: [{ OR: [{ number: g.doc }, { externalNumber: g.doc }] }, { OR: [{ kind: null }, { kind: 'normal' }] }] }, orderBy: { blInvoiceId: 'desc' } })
      const ext = inv ? await doczytajNumerWfirmy(db, bl, inv, budzet, stats) : null
      // WZ tej faktury już rozliczone przy innym zamówieniu (np. po pozycjach): bez drugiego rozliczenia, zostaje dla biura
      const cudze = ext ? await db.pendingMovement.count({ where: { wfirmaDocId: ext, orderId: { not: g.orderId } } }) : 0
      const lines = ext && !cudze ? await wz.wzForInvoice(ext) : null
      if (inv && ext && lines) {
        const zamkniete = await rozliczPozneWzFakturyBl(db, g.orderId, g.doc, ext, await wzByProduct(db, lines), { now })
        if (zamkniete) stats.pozneWz = (stats.pozneWz ?? 0) + zamkniete
        if (zamkniete && !(await db.pendingMovement.count({ where: { orderId: g.orderId, wfirmaDocId: g.doc, type: 'BL_INVOICE', state: 'MANUAL' } })))
          await db.blInvoiceSnapshot.update({ where: { organizationId_blInvoiceId: { organizationId: inv.organizationId, blInvoiceId: inv.blInvoiceId } }, data: { outcome: 'ZASTOSOWANA', lastError: null } })
      }
      // co zostało MANUAL (brak numeru, brak WZ, WZ na część): następne sprawdzenie za odstęp
      for (const m of g.ruchy) {
        const odstep = POZNE_WZ_ODSTEPY_MS[Math.min(m.wzTries, POZNE_WZ_ODSTEPY_MS.length - 1)]!
        await db.pendingMovement.updateMany({ where: { id: m.id, state: 'MANUAL' }, data: { wzTries: { increment: 1 }, nextWzReadAt: new Date(now.getTime() + odstep) } })
      }
    } catch (e) {
      stats.errors.push(`faktura BL ${g.doc} bez WZ: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

export async function syncBlInvoices(db: PrismaClient, bl: BaseLinkerReadOnly, wz: WzOdczyt | null, opts: InvoiceSyncOpts = {}): Promise<InvoiceSyncStats> {
  const now = opts.now ?? new Date()
  const stats: InvoiceSyncStats = { fetched: 0, applied: 0, withoutWz: 0, nothingToConsume: 0, digitalOnly: 0, corrections: 0, outsideShadow: 0, waitingForOrder: 0, waitingForWz: 0, waitingNoWfirma: 0, shippedWithoutInvoice: 0, errors: [], blComplete: true }
  const last = await db.blInvoiceSnapshot.findFirst({ orderBy: { blInvoiceId: 'desc' }, select: { blInvoiceId: true } })
  const f = await fetchBlInvoices(bl, last ? { idFrom: last.blInvoiceId + 1 } : { dateFromUnix: Math.floor((now.getTime() - (opts.initialLookbackMs ?? 24 * 3600_000)) / 1000) })
  stats.blComplete = f.complete
  stats.errors.push(...f.errors)
  for (const h of f.headers) {
    await db.blInvoiceSnapshot.upsert({
      where: { organizationId_blInvoiceId: { organizationId: organizationIdOf(db), blInvoiceId: h.blInvoiceId } },
      create: { ...h, lines: (h.lines ?? undefined) as Prisma.InputJsonValue | undefined, fetchedAt: now },
      // numer wFirmy, który BL dopisał po pierwszej kopii (odczyt wstecz), trafia do kopii; reszta kopii bez zmian
      update: h.externalNumber ? { externalNumber: h.externalNumber } : {},
    })
    stats.fetched++
  }
  // jednorazowe douczytanie faktur sprzed pierwszego odczytu (tylko gdy kopia już była przed przebiegiem)
  if (last && opts.backfillDays && opts.backfillDays > 0) {
    try {
      await backfillBlInvoices(db, bl, opts.backfillDays, now, stats)
    } catch (e) {
      stats.errors.push(`douczytanie faktur BL: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // faktura BL bez naszego zamówienia — para od strony faktury (zamówienie sprzed okna porównania), zanim
  // faktura pójdzie do POZA_CIENIEM; faktura POZA_CIENIEM, która dostała parę, wraca do rozliczenia
  const pairs = await pairOrdersFromBlInvoices(db, { now, fetchOrder: opts.fetchBlOrder ?? null, uzupelnijNumer: opts.uzupelnijNumer ?? null })
  if (pairs.paired) stats.pairedFromInvoice = pairs.paired
  if (pairs.numbersRead) stats.numbersRead = pairs.numbersRead
  if (pairs.numbersFailed) stats.numbersFailed = pairs.numbersFailed
  stats.errors.push(...pairs.errors)

  // Do przebiegu tylko faktury z naszym zamówieniem albo starsze niż próg „poza cieniem”. Faktury BL bez zamówienia
  // w rdzeniu (np. kanał nieczytany w cieniu) czekają do 3 dni i bez tego filtra zajęłyby limit 500, a nowsze faktury
  // naszych zamówień nie doszłyby do rozliczenia.
  const outsideBefore = new Date(now.getTime() - OUTSIDE_SHADOW_MS)
  const waiting = await db.blInvoiceSnapshot.findMany({ where: { appliedAt: null }, select: { blOrderId: true, dateAdd: true, lastError: true } })
  const orders = waiting.length ? await db.order.findMany({ where: { blOrderId: { in: [...new Set(waiting.map((p) => p.blOrderId))] } }, select: { id: true, blOrderId: true } }) : []
  const orderOf = new Map(orders.map((o) => [o.blOrderId!, o.id]))
  stats.waitingForOrder = waiting.filter((p) => !orderOf.has(p.blOrderId) && p.dateAdd >= outsideBefore).length
  // odkładanie faktur przez nieudany odczyt numeru ze sklepu nie może być ciche
  try {
    const bezPary = waiting.filter((p) => !orderOf.has(p.blOrderId) && !p.lastError)
    await alertNumerowSklepu(db, { now, numbersRead: pairs.numbersRead ?? 0, numbersFailed: pairs.numbersFailed ?? 0, czekajace: bezPary.length, najstarsza: bezPary.reduce<Date | null>((m, p) => (!m || p.dateAdd < m ? p.dateAdd : m), null) })
  } catch (e) {
    stats.errors.push(`alert odczytu numerów ze sklepu: ${e instanceof Error ? e.message : String(e)}`)
  }
  const pending = waiting.length
    ? await db.blInvoiceSnapshot.findMany({
        where: { appliedAt: null, OR: [{ blOrderId: { in: [...orderOf.keys()] } }, { dateAdd: { lt: outsideBefore } }] },
        orderBy: { blInvoiceId: 'asc' },
        take: 500,
      })
    : []
  // Bezpiecznik: dopóki żadna faktura firmy nie dostała WZ z wFirmy, „brak WZ” po limicie prób
  // nie przechodzi w BEZ_WZ, jeśli w przebiegu WZ nie znalazła się dla żadnej z ≥ 3 faktur — złe pole warunku albo
  // numeracja BL ≠ wFirma dałaby inaczej ruch MANUAL na każdej pozycji każdej faktury.
  const everApplied = (await db.blInvoiceSnapshot.count({ where: { outcome: 'ZASTOSOWANA' } })) > 0
  const wzOptional = await wzOptionalOf(db)
  let wzChecked = 0
  let wzFound = 0
  const budzet = { numery: MAX_ODCZYTOW_NUMERU }
  const exhausted: { inv: (typeof pending)[number]; orderId: string; docId: string }[] = []
  const done = (inv: (typeof pending)[number], outcome: string, orderId: string | null = null) =>
    db.blInvoiceSnapshot.update({ where: { organizationId_blInvoiceId: { organizationId: inv.organizationId, blInvoiceId: inv.blInvoiceId } }, data: { appliedAt: now, outcome, orderId, lastError: null } })
  const failed = async (inv: (typeof pending)[number], e: unknown) => {
    const m = (e instanceof Error ? e.message : String(e)).slice(0, 1000)
    stats.errors.push(`faktura BL ${inv.number}: ${m}`)
    await db.blInvoiceSnapshot
      .update({ where: { organizationId_blInvoiceId: { organizationId: inv.organizationId, blInvoiceId: inv.blInvoiceId } }, data: { attempts: { increment: 1 }, lastError: m } })
      .catch(() => undefined)
    // błąd, który wraca (np. SourceError wFirmy przy złym polu warunku), po limicie prób daje alert —
    // raz na fakturę BL; faktura dalej ponawia się w kolejnych przebiegach. Treść: numery i błąd, bez nabywcy.
    if (inv.attempts + 1 >= WZ_MAX_ATTEMPTS)
      await alert(
        db,
        'FAKTURA_BL_BLAD',
        'BL',
        `Faktura BL ${inv.number} (zamówienie BL ${inv.blOrderId}): ${inv.attempts + 1} nieudanych prób rozliczenia, ostatni błąd: ${m.slice(0, 300)}. Rezerwacja zostaje aktywna do wyjaśnienia.`,
        `faktura-bl-blad:${inv.blInvoiceId}`,
      ).catch(() => undefined)
  }
  for (const inv of pending) {
    try {
      if (inv.kind && inv.kind !== 'normal') {
        // korekta w BL: zwrot na stan pokaże odczyt wFirmy (2.2 pkt 3), rdzeń niczego nie zdejmuje
        await done(inv, 'KOREKTA')
        stats.corrections++
        continue
      }
      const orderId = orderOf.get(inv.blOrderId)
      if (!orderId) {
        // tu trafiają tylko faktury starsze niż próg (filtr wyżej); czekające policzone przy wyborze
        await done(inv, 'POZA_CIENIEM')
        stats.outsideShadow++
        continue
      }
      const [active, withoutDoc, openShortages] = await Promise.all([
        db.reservation.count({ where: { orderId, state: 'ACTIVE' } }),
        db.pendingMovement.count({ where: { orderId, type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL' } }),
        // zamówienie w całości w braku (stanu nie było przy przyjęciu) też wyszło z fakturą: braki → wydane
        db.shortage.count({ where: { orderId, state: 'OPEN' } }),
      ])
      if (!active && !withoutDoc && !openShortages) {
        // Kompletor wystawił już (albo wystawia) własny dokument sprzedaży, zanim zamówienie dostało parę w BL: rezerwacje
        // zużyte, więc rozliczenie faktury BL nic nie zdejmuje, ale to druga faktura na to samo zamówienie
        // błąd alertu trafia do błędów przebiegu (log zadania) i nie wstrzymuje zakończenia faktury
        await dwieFakturyBezRozliczenia(db, orderId, inv.externalNumber ?? inv.number).catch((e: unknown) => {
          stats.errors.push(`alert dwóch faktur ${inv.number}: ${e instanceof Error ? e.message : String(e)}`)
        })
        // same e-booki to faktura wystawiona bez rozchodu, nie „anulowane”
        if (await digitalOnly(db, orderId)) {
          await done(inv, 'BEZ_STANU', orderId)
          stats.digitalOnly++
          continue
        }
        // zamówienie anulowane, pominięte przy przyjęciu albo już rozliczone — nic do zdjęcia ze stanu
        await done(inv, 'NIC_DO_ROZLICZENIA', orderId)
        stats.nothingToConsume++
        continue
      }
      if (!wz && !wzOptional) {
        stats.waitingNoWfirma++
        continue
      }
      let docId = inv.externalNumber ?? inv.number
      let lines = wz ? await wz.wzForInvoice(docId) : null
      // kopia bez numeru wFirmy (BL dopisuje go dopiero po odpowiedzi wFirmy, kilka sekund po fakturze): przed kolejną
      // próbą i przed uznaniem „bez WZ” numer czytany z BL jeszcze raz, WZ szukane po nim
      if (wz && !lines && !inv.externalNumber) {
        const ext = await doczytajNumerWfirmy(db, bl, inv, budzet, stats)
        if (ext && ext !== docId) {
          docId = ext
          lines = await wz.wzForInvoice(ext)
        }
      }
      if (wz) wzChecked++
      if (lines) wzFound++
      // WZ nieobowiązkowe: bez WZ od razu BEZ_WZ, bez czekania i bez
      if (!lines && !wzOptional && inv.attempts + 1 >= WZ_MAX_ATTEMPTS && !everApplied) {
        // decyzja po pętli: gdy WZ nie znalazła się dla żadnej faktury, to raczej konfiguracja niż opóźnienie
        exhausted.push({ inv, orderId, docId })
        continue
      }
      if (!lines && !wzOptional && inv.attempts + 1 < WZ_MAX_ATTEMPTS) {
        await db.blInvoiceSnapshot.update({ where: { organizationId_blInvoiceId: { organizationId: inv.organizationId, blInvoiceId: inv.blInvoiceId } }, data: { attempts: { increment: 1 }, lastError: 'brak WZ w wFirmie (jeszcze)' } })
        stats.waitingForWz++
        continue
      }
      // WZ nie przyszło po ~30 min (albo firma nie wystawia WZ): rozchód i tak (rezerwacja nie może wisieć), ruch
      // MANUAL — biuro poprawia WZ w wFirmie
      await applyBlInvoice(db, orderId, docId, lines ? await wzByProduct(db, lines) : {}, { now })
      await done(inv, lines ? 'ZASTOSOWANA' : 'BEZ_WZ', orderId)
      if (lines) stats.applied++
      else stats.withoutWz++
    } catch (e) {
      await failed(inv, e)
    }
  }
  if (exhausted.length) {
    if (wzFound === 0 && wzChecked >= MIN_CHECKED_FOR_CONFIG) {
      const m = `brak WZ w wFirmie dla żadnej z ${wzChecked} faktur — podejrzenie złej konfiguracji (numeracja BL ≠ wFirma albo pole warunku), faktury czekają`
      for (const x of exhausted)
        await db.blInvoiceSnapshot.update({ where: { organizationId_blInvoiceId: { organizationId: x.inv.organizationId, blInvoiceId: x.inv.blInvoiceId } }, data: { attempts: { increment: 1 }, lastError: m } })
      // klucz z dniem: alert zamknięty, a problem trwa następnego dnia → nowy alert, nie cisza
      await alert(db, 'FAKTURY_BL_BEZ_WZ', 'BL', `Faktury BL: ${m}. Rezerwacje zostają aktywne do wyjaśnienia.`, `faktury-bl-bez-wz:${toWarsaw(now).day}`)
      stats.waitingForWz += exhausted.length
      stats.errors.push(m)
    } else {
      for (const x of exhausted) {
        try {
          // WZ nie przyszło po ~30 min: rozchód i tak (rezerwacja nie może wisieć), ruch MANUAL — biuro poprawia WZ
          await applyBlInvoice(db, x.orderId, x.docId, {}, { now })
          await done(x.inv, 'BEZ_WZ', x.orderId)
          stats.withoutWz++
        } catch (e) {
          await failed(x.inv, e)
        }
      }
    }
  }

  // faktury BL rozliczone wcześniej bez WZ: numer wFirmy i WZ mogły dojść później (naprawa wstecz, z odstępami)
  if (wz) await rozliczPozneWz(db, bl, wz, now, budzet, stats)

  // „Wysłane” w BL bez faktury: tylko kopie statusu sprzed tego przebiegu (lista faktur jest od nich świeższa), tylko
  // przy pełnym odczycie faktur, tylko zamówienia z aktywną rezerwacją.
  if (f.complete) {
    const open = await db.order.findMany({ where: { blOrderId: { not: null }, reservations: { some: { state: 'ACTIVE' } } }, select: { id: true, blOrderId: true } })
    const ids = open.map((o) => o.blOrderId!)
    const shipped = ids.length ? await db.blOrderSnapshot.findMany({ where: { blOrderId: { in: ids }, fetchedAt: { lt: now }, statusName: { not: null } }, select: { blOrderId: true, statusName: true } }) : []
    const shippedIds = new Set(shipped.filter((s) => SHIPPED.includes(blStatusFamily(s.statusName!).family)).map((s) => s.blOrderId))
    if (shippedIds.size) {
      const invoiced = new Set((await db.blInvoiceSnapshot.findMany({ where: { blOrderId: { in: [...shippedIds] } }, select: { blOrderId: true } })).map((x) => x.blOrderId))
      for (const o of open.filter((x) => shippedIds.has(x.blOrderId!) && !invoiced.has(x.blOrderId!))) {
        try {
          await applyBlShippedWithoutInvoice(db, o.id, { now })
          stats.shippedWithoutInvoice++
        } catch (e) {
          stats.errors.push(`wysłane bez faktury ${o.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }

  // Zamówienie z zastosowaną fakturą BL nie trzyma rezerwacji ani braku: rozlicza te, które powstały po fakturze
  // (przydział dostawy dla braku sprzed poprawki) — samo po wdrożeniu, bezpieczne przy powtórce, bez ruchu stanu.
  const heal = await samonaprawaPoFakturzeBl(db, { now })
  if (heal.zamowien || heal.zgloszonych || heal.nadmiarowZamknietych || heal.alertowZamknietych) {
    const { bledy: _bledy, ...reszta } = heal
    stats.samonaprawa = reszta
  }
  stats.errors.push(...heal.bledy)
  return stats
}

// ─── Faktury BL odkładane, bo sklep nie podaje numeru ─────────

/** Alert raz na dobę: odczyt numerów ze sklepu pada, a najstarsza faktura BL bez pary czeka ponad dobę. */
export const FAKTURY_BL_NUMERY_SKLEPU = 'FAKTURY_BL_NUMERY_SKLEPU'
const DOBA_MS = 24 * 3600_000

/**
 * W przebiegu z nieudanym odczytem numeru (`numbersFailed > 0`) i najstarszą czekającą fakturą starszą niż doba: alert
 * najwyżej raz na dobę od poprzedniego zgłoszenia (liczby w treści); nowe zgłoszenie zamyka starsze otwarte, więc przy
 * trwałej awarii otwarte jest jedno. Zamyka się sam w przebiegu, w którym odczyt przeszedł bez błędu albo żadna faktura
 * nie czeka ponad dobę. Firma bez BL tu nie dochodzi (zadanie faktur BL wymaga tokenu).
 */
export async function alertNumerowSklepu(
  db: PrismaClient,
  s: { now: Date; numbersRead: number; numbersFailed: number; czekajace: number; najstarsza: Date | null },
): Promise<'ZGLOSZONY' | 'ZAMKNIETY' | 'BEZ_ZMIAN'> {
  const doba = !!s.najstarsza && s.now.getTime() - s.najstarsza.getTime() > DOBA_MS
  if (s.numbersFailed > 0 && doba) {
    // raz na dobę liczone od ostatniego zgłoszenia (otwartego albo zamkniętego), nie od dnia kalendarzowego
    const ostatni = await db.alert.findFirst({ where: { kind: FAKTURY_BL_NUMERY_SKLEPU }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
    if (ostatni && s.now.getTime() - ostatni.createdAt.getTime() < DOBA_MS) return 'BEZ_ZMIAN'
    const dzien = toWarsaw(s.now).day
    const godzin = Math.floor((s.now.getTime() - s.najstarsza!.getTime()) / 3600_000)
    const klucz = `faktury-bl-numery-sklepu:${dzien}`
    const nowy = await alert(
      db,
      FAKTURY_BL_NUMERY_SKLEPU,
      dzien,
      `Faktury z BaseLinkera czekają na zamówienie, bo sklep nie podaje numerów zamówień (odczyty: ${s.numbersRead}, nieudane: ${s.numbersFailed}). ` +
        `Czeka ${s.czekajace} faktur, najstarsza od ${godzin} h. Po 30 dniach taka faktura wypada z dopasowania i trzeba ją rozliczyć ręcznie. ` +
        'Sprawdź, czy sklep działa i czy klucze sklepu są aktualne (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży); alert zamknie się sam po udanym odczycie.',
      klucz,
    )
    if (!nowy) return 'BEZ_ZMIAN'
    // chwila zgłoszenia = chwila przebiegu (podstawa liczenia doby); starsze otwarte zgłoszenia zastępuje nowe, przy
    // trwałej awarii zostaje jedno otwarte
    await db.alert.updateMany({ where: { kind: FAKTURY_BL_NUMERY_SKLEPU, dedupeKey: klucz }, data: { createdAt: s.now } })
    await db.alert.updateMany({ where: { kind: FAKTURY_BL_NUMERY_SKLEPU, closedAt: null, OR: [{ dedupeKey: null }, { dedupeKey: { not: klucz } }] }, data: { closedAt: s.now } })
    return 'ZGLOSZONY'
  }
  if ((s.numbersRead > 0 && s.numbersFailed === 0) || !doba) {
    const r = await db.alert.updateMany({ where: { kind: FAKTURY_BL_NUMERY_SKLEPU, closedAt: null }, data: { closedAt: s.now } })
    return r.count ? 'ZAMKNIETY' : 'BEZ_ZMIAN'
  }
  return 'BEZ_ZMIAN'
}
