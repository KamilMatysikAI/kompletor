// dokumenty WZ z wFirmy w cieniu — tylko odczyt (`warehouse_documents/find`, `invoices/find`, `invoices/get`).
// Powód (odpowiedzi biura do raportu rozjazdów z 04.11): stan w wFirmie schodzi dokumentem WZ, który BL zakłada razem
// z fakturą. Gdy rdzeń tej faktury nie rozliczył (faktura sprzed startu odczytu faktur BL, zamówienie bez pary z BL),
// rezerwacja i brak wisiały, a raport liczył spadek stanu jako „bez przyczyny”. Przebieg:
//   1. WZ z magazynu lustra od dnia `od` (strony po 100) → kopia `WfirmaWzSnapshot` (numery, daty, towary, ilości);
//   2. numer faktury WZ (lista faktur z tych dni, pojedynczy `invoices/get` tylko dla brakujących, z limitem);
//   3. powiązanie z zamówieniem: (a) faktura już rozliczona w rdzeniu (ruch z tym numerem) → nic do zrobienia;
//      (b) kopia faktury BL z tym numerem → zamówienie po `blOrderId`; gdy żadne nasze zamówienie nie ma tej pary,
//      WZ czeka na parę po tożsamości (`pairOrdersFromBlInvoices`) i NIE idzie do wiązania po pozycjach (
//      faktura należy do obcego zamówienia BL, a koincydencja ilości rozliczyłaby cudze zamówienie);
//      (c) numer zamówienia BL w opisie WZ; (d) tylko WZ bez kopii faktury BL: pozycje — dokładnie jedno opłacone
//      (albo za pobraniem) zamówienie, którego aktywne rezerwacje i otwarte braki na towarach WZ równają się ilościom
//      WZ, założone przed WZ. Dopasowanie po pozycjach nigdy nie zapisuje pary z BL (`Order.blOrderId`);
//   4. rozliczenie jak faktura BL (`applyBlInvoice`): rezerwacje zużyte, ruch z numerem dokumentu, odczyt celowany
//      wFirmy; otwarte braki na towarach WZ najpierw dostają rezerwację (towar wyszedł, więc brak jest nieaktualny).
// Błąd jednego WZ zostaje w `lastError` tego WZ i ponowi się w kolejnym przebiegu; reszta idzie dalej.
// WZ z faktury wFirmy bez kopii faktury BL idzie po pozycjach dopiero, gdy (i) minęło okno
// WZ_BL_INVOICE_WAIT_MIN, (ii) znamy numer faktury (bez numeru nie da się sprawdzić kopii BL) i (iii) BL jest
// nieskonfigurowany albo ostatni KOMPLETNY odczyt faktur BL wystartował po założeniu WZ; inaczej `CZEKA_NA_FAKTURE_BL`,
// a to po dobie daje alert razem z pozostałymi nierozstrzygniętymi. Opis i surowa chwila założenia są
// w kopii, więc ponowna próba z kopii wiąże po opisie tak samo jak odczyt z wFirmy i dobiera brakujące numery faktur.
import type { Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { fromWarsaw, type IsoDay } from '../rdzen/kalendarz'
import { flagsOf, mergeFlags } from '../rdzen/rezerwacja'
import { applyBlInvoice } from '../rdzen/rozchod'
import { advisoryLock, alert, DEFAULT_WAREHOUSE, orderLockKey, outbox, runTx } from '../rdzen/stan'
import { zrodloStanu } from '../rdzen/zrodlo-stanu'
import { type WfirmaReadOnly, wfirmaItems } from '../zrodla/wfirma'
import { type WzLine, wzByProduct } from './faktury-bl'
import { bezParyPoProbie } from './parowanie-faktur'

export const WZ_JOB = 'cien-wz-wfirmy'
/** Pierwszy odczyt: tyle dni wstecz (obejmuje faktury sprzed startu odczytu faktur BL). */
export const WZ_LOOKBACK_DAYS = 14
/** Kolejne przebiegi: od dnia najnowszego WZ w kopii minus zapas (WZ dopisane później z datą wstecz). */
export const WZ_OVERLAP_DAYS = 2
/** Nierozstrzygnięte WZ (bez zamówienia, niejednoznaczne) próbujemy wiązać przez tyle dni od założenia. */
export const WZ_RETRY_DAYS = 14
/** Ile pojedynczych `invoices/get` (numer faktury spoza listy dni) w jednym przebiegu. */
export const WZ_INVOICE_GET_BUDGET = 20
/** WZ nierozstrzygnięte (czeka na parę, bez zamówienia, niejednoznaczne) dłużej niż tyle godzin → alert biura. */
export const WZ_UNRESOLVED_ALERT_HOURS = 24
/**
 * WZ z fakturą w wFirmie, której kopii faktur BL jeszcze nie ma, czeka tyle minut od
 * założenia (faktury BL czytamy co 2 min, WZ co 30 min), zanim uznamy fakturę za ręczną biura i wiążemy po pozycjach.
 */
export const WZ_BL_INVOICE_WAIT_MIN = 15
const MAX_PAGES = 30

export interface WzDokument {
  docId: string
  numer: string
  data: string
  /** „RRRR-MM-DD GG:MM:SS” czasu Warszawy (tak podaje wFirma). */
  utworzono: string
  magazyn: string | null
  invoiceId: string | null
  opis: string
  pozycje: WzLine[]
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && v !== 0 ? String(v) : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}
const idOf = (v: unknown): string | null => {
  const s = str((v as Record<string, unknown> | undefined)?.['id'])
  return s && s !== '0' ? s : null
}

/** Dokument WZ z odpowiedzi wFirmy. Nieczytelna pozycja to błąd (nie 0), dokument bez numeru albo daty: null. */
export function parseWz(raw: Record<string, unknown>): WzDokument | null {
  const docId = str(raw['id'])
  const numer = str(raw['fullnumber'])
  const data = str(raw['date'])
  const utworzono = str(raw['created'])
  if (!docId || !numer || !data || !utworzono || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return null
  const pozycje: WzLine[] = []
  for (const c of wfirmaItems<Record<string, unknown>>(raw['warehouse_document_contents'], 'warehouse_document_content')) {
    const goodId = idOf(c['good'])
    const count = num(c['count'])
    if (!goodId || count === null) throw new Error(`wFirma: nieczytelna pozycja ${numer}`)
    pozycje.push({ wfirmaGoodId: goodId, count })
  }
  return { docId, numer, data, utworzono, magazyn: idOf(raw['warehouse']), invoiceId: idOf(raw['invoice']), opis: str(raw['description']) ?? '', pozycje }
}

/** „RRRR-MM-DD GG:MM:SS” czasu Warszawy → chwila UTC. */
export function warsawStamp(s: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s)
  if (!m) throw new Error(`wFirma: nieczytelna data ${s}`)
  return fromWarsaw(m[1] as IsoDay, ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000)
}

/** Odczyt WZ i numerów faktur z wFirmy. Atrapa w testach odtwarza nagrane odpowiedzi (tests/nagrania/wfirma-wz). */
export interface WzZrodlo {
  /** WZ z dnia `od` i późniejsze, z magazynu `magazyn` (null = wszystkie). */
  wzOd(od: string, magazyn: string | null): Promise<{ docs: WzDokument[]; complete: boolean; errors: string[] }>
  /** Numery faktur (id → pełny numer) z dni [od, do]. */
  numeryFaktur(od: string, doDnia: string): Promise<Map<string, string>>
  /** Numer jednej faktury po id (gdy nie było jej na liście dni). */
  numerFaktury(invoiceId: string): Promise<string | null>
}

const and = (...c: { field: string; operator: string; value: string }[]) => ({ and: c.map((condition) => ({ condition })) })

export class WfirmaWzZrodlo implements WzZrodlo {
  constructor(private readonly wf: Pick<WfirmaReadOnly, 'call'>) {}

  async wzOd(od: string, magazyn: string | null): Promise<{ docs: WzDokument[]; complete: boolean; errors: string[] }> {
    const docs: WzDokument[] = []
    const errors: string[] = []
    // magazyn filtrujemy po odpowiedzi (pole `warehouse.id` dokumentu), nie w warunku: nazwa pola warunku dla dokumentów
    // magazynowych nie jest potwierdzona na żywo, a zły warunek wFirma odrzuca całe zapytanie
    const conds = [
      { field: 'type', operator: 'eq', value: 'WZ' },
      { field: 'date', operator: 'ge', value: od },
    ]
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await this.wf.call<Record<string, unknown>>('warehouse_documents/find', { warehouse_documents: { parameters: { conditions: and(...conds), limit: 100, page, order: { asc: 'id' } } } })
      const items = wfirmaItems<Record<string, unknown>>(r['warehouse_documents'], 'warehouse_document')
      for (const raw of items) {
        try {
          const d = parseWz(raw)
          if (d && magazyn && d.magazyn && d.magazyn !== magazyn) continue
          if (d) docs.push(d)
          else errors.push('WZ bez numeru albo daty — pominięty')
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e))
        }
      }
      if (items.length < 100) return { docs, complete: true, errors }
    }
    errors.push(`ponad ${MAX_PAGES} stron WZ — przerwane`)
    return { docs, complete: false, errors }
  }

  async numeryFaktur(od: string, doDnia: string): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await this.wf.call<Record<string, unknown>>('invoices/find', {
        invoices: { parameters: { conditions: and({ field: 'date', operator: 'ge', value: od }, { field: 'date', operator: 'le', value: doDnia }), limit: 100, page } },
      })
      // z odpowiedzi bierzemy wyłącznie id i numer; dane nabywcy nie wychodzą poza tę funkcję
      const items = wfirmaItems<Record<string, unknown>>(r['invoices'], 'invoice')
      for (const i of items) {
        const id = str(i['id'])
        const n = str(i['fullnumber'])
        if (id && n) out.set(id, n)
      }
      if (items.length < 100) break
    }
    return out
  }

  async numerFaktury(invoiceId: string): Promise<string | null> {
    if (!/^\d+$/.test(invoiceId)) return null
    const r = await this.wf.call<Record<string, unknown>>(`invoices/get/${invoiceId}`, {})
    return str(wfirmaItems<Record<string, unknown>>(r['invoices'], 'invoice')[0]?.['fullnumber'])
  }
}

// ─── Powiązanie z zamówieniem ───────────────────────────────────────────────

// CZEKA_NA_PARE: kopia faktury BL jest, ale jej zamówienie BL nie ma (jeszcze) pary z naszym zamówieniem;
// POZA_CIENIEM: para po tożsamości się nie znalazła (zamówienie BL spoza kanałów czytanych w cieniu) — nie nasze.
export type WzOutcome = 'ROZLICZONA' | 'JUZ_ROZLICZONA' | 'CZEKA_NA_FAKTURE_BL' | 'CZEKA_NA_PARE' | 'POZA_CIENIEM' | 'NIC_DO_ROZLICZENIA' | 'BEZ_ZAMOWIENIA' | 'NIEJEDNOZNACZNE' | 'POZA_KATALOGIEM'
const FINAL: WzOutcome[] = ['ROZLICZONA', 'JUZ_ROZLICZONA', 'NIC_DO_ROZLICZENIA']
/** Wyniki, które mogą dotyczyć naszego zamówienia i wymagają oka biura, gdy wiszą dłużej niż próg. */
const UNRESOLVED: WzOutcome[] = ['CZEKA_NA_PARE', 'BEZ_ZAMOWIENIA', 'NIEJEDNOZNACZNE', 'CZEKA_NA_FAKTURE_BL']

/** Ilości WZ per produkt (jednostka bazowa) i czy wszystkie towary WZ są w katalogu. */
async function wzProducts(db: PrismaClient, lines: WzLine[]): Promise<{ per: Record<string, number>; complete: boolean }> {
  const per = await wzByProduct(db, lines)
  const known = await db.product.count({ where: { wfirmaGoodId: { in: [...new Set(lines.map((l) => l.wfirmaGoodId))] } } })
  return { per, complete: known === new Set(lines.map((l) => l.wfirmaGoodId)).size }
}

/**
 * Zamówienia, których aktywne rezerwacje + otwarte braki na towarach WZ równają się ilościom WZ (i nic ponadto na tych
 * towarach). Tylko opłacone albo za pobraniem, bez statusów anulowane / do wyjaśnienia ((3), przeglądu).
 */
export async function ordersMatchingLines(db: PrismaClient, per: Record<string, number>, before: Date): Promise<string[]> {
  const ids = Object.keys(per)
  if (!ids.length) return []
  const [res, sh] = await Promise.all([
    db.reservation.findMany({ where: { productId: { in: ids }, state: 'ACTIVE' }, select: { orderId: true, productId: true, qtyBase: true } }),
    db.shortage.findMany({ where: { productId: { in: ids }, state: 'OPEN' }, select: { orderId: true, productId: true, qtyBase: true } }),
  ])
  const byOrder = new Map<string, Record<string, number>>()
  for (const r of [...res, ...sh]) {
    const m = byOrder.get(r.orderId) ?? {}
    m[r.productId] = (m[r.productId] ?? 0) + r.qtyBase
    byOrder.set(r.orderId, m)
  }
  const same = [...byOrder].filter(([, m]) => ids.length === Object.keys(m).length && ids.every((p) => m[p] === per[p])).map(([o]) => o)
  if (!same.length) return []
  // rozliczenie zużywa wszystkie aktywne rezerwacje zamówienia: po pozycjach tylko zamówienie bez rezerwacji i braków
  // na towarach spoza WZ (inaczej WZ to część zamówienia, a reszta jeszcze nie wyszła)
  const [resOther, shOther] = await Promise.all([
    db.reservation.findMany({ where: { orderId: { in: same }, state: 'ACTIVE', productId: { notIn: ids } }, select: { orderId: true } }),
    db.shortage.findMany({ where: { orderId: { in: same }, state: 'OPEN', productId: { notIn: ids } }, select: { orderId: true } }),
  ])
  const partial = new Set([...resOther, ...shOther].map((x) => x.orderId))
  const whole = same.filter((o) => !partial.has(o))
  if (!whole.length) return []
  // tylko zamówienia złożone przed WZ, nieanulowane
  return (
    await db.order.findMany({
      where: { id: { in: whole }, status: { notIn: ['ANULOWANE', 'DO_WYJASNIENIA'] }, paymentState: { in: ['PAID', 'COD'] }, createdAtChannel: { lte: before } },
      select: { id: true },
      orderBy: { id: 'asc' },
    })
  ).map((o) => o.id)
}

/** Numer zamówienia BL (9 cyfr) w opisie WZ → nasze zamówienie z tą parą. */
async function orderFromDescription(db: PrismaClient, opis: string): Promise<string | null> {
  const nums = [...new Set([...opis.matchAll(/(?<!\d)(\d{8,10})(?!\d)/g)].map((m) => Number(m[1])))]
  if (!nums.length) return null
  const o = await db.order.findMany({ where: { blOrderId: { in: nums } }, select: { id: true } })
  return o.length === 1 ? o[0]!.id : null
}

/**
 * Otwarte braki zamówienia na towarach WZ → wydane (rezerwacja od razu CONSUMED, brak RESOLVED): towar wyszedł z magazynu
 * w wFirmie, a brak powstał, bo stanu nie było — stan wFirmy już ten WZ zawiera, więc bez ruchu i bez zmiany stanu
 * (bilans pozycji: rezerwacja zużyta zamiast braku). Odczyt celowany wFirmy potwierdza stan. Ilość najwyżej taka, jaką
 * WZ wydało ponad aktywne rezerwacje zamówienia.
 */
async function shortagesAsIssued(db: PrismaClient, orderId: string, per: Record<string, number>, now: Date, numer: string): Promise<number> {
  return runTx(db, async (tx) => {
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
    await advisoryLock(tx, orderLockKey(o))
    const sh = await tx.shortage.findMany({ where: { orderId, state: 'OPEN', productId: { in: Object.keys(per) } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    if (!sh.length) return 0
    const res = await tx.reservation.findMany({ where: { orderId, state: 'ACTIVE', productId: { in: Object.keys(per) } }, select: { productId: true, qtyBase: true } })
    const left: Record<string, number> = { ...per }
    for (const r of res) left[r.productId] = (left[r.productId] ?? 0) - r.qtyBase
    let moved = 0
    const touched = new Set<string>()
    for (const s of sh) {
      const take = Math.min(s.qtyBase, Math.max(0, left[s.productId] ?? 0))
      if (take <= 0) continue
      const r = await tx.reservation.create({ data: { orderId, orderLineId: s.orderLineId, productId: s.productId, warehouseId: DEFAULT_WAREHOUSE, qtyBase: take, state: 'CONSUMED', consumedAt: now }, select: { id: true } })
      const done = { state: 'RESOLVED' as const, reservationId: r.id, resolvedAt: now, resolvedBy: 'system:wz-wfirmy', note: `wydane w wFirmie: ${numer}` }
      if (take === s.qtyBase) await tx.shortage.update({ where: { id: s.id }, data: done })
      else {
        await tx.shortage.update({ where: { id: s.id }, data: { qtyBase: s.qtyBase - take } })
        await tx.shortage.create({ data: { orderId, orderLineId: s.orderLineId, productId: s.productId, qtyBase: take, ...done } })
      }
      left[s.productId] = (left[s.productId] ?? 0) - take
      touched.add(s.productId)
      moved += take
    }
    for (const productId of [...touched].sort()) await outbox(tx, 'WFIRMA_READ', productId, now)
    const open = await tx.shortage.count({ where: { orderId, state: { in: ['OPEN', 'SHIP_LATER'] } } })
    if (!open && flagsOf(o).brakuje) await tx.order.update({ where: { id: orderId }, data: { flags: mergeFlags(o, { brakuje: false }) } })
    return moved
  })
}

export interface WzSyncStats {
  read: number
  settled: number
  alreadySettled: number
  waitingForBlInvoice: number
  nothingToSettle: number
  withoutOrder: number
  ambiguous: number
  outsideCatalog: number
  waitingForPair: number
  outsideShadow: number
  /** WZ nierozstrzygnięte dłużej niż WZ_UNRESOLVED_ALERT_HOURS (alert biura, raz na dobę). */
  unresolvedOld: number
  errors: string[]
  complete: boolean
}

export interface WzSyncOpts {
  now?: Date
  /** Pierwszy odczyt: od tego dnia (domyślnie WZ_LOOKBACK_DAYS wstecz). */
  od?: string
  /**
   * stan odczytu faktur BL. Brak = firma bez BL (faktury tylko ręczne w wFirmie): po oknie pozycje.
   * `ostatniOk` = start ostatniego kompletnego odczytu faktur BL (null = nigdy).
   */
  fakturyBl?: { ostatniOk: Date | null } | null
}

/** czy odczyt faktur BL mógł już widzieć fakturę do WZ założonego w `created` (BL nieskonfigurowany = tak). */
function fakturyBlAktualne(bl: WzSyncOpts['fakturyBl'], created: Date): boolean {
  if (!bl) return true
  return !!bl.ostatniOk && bl.ostatniOk.getTime() > created.getTime()
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10)

/** Jeden przebieg: odczyt WZ → kopia → powiązanie i rozliczenie. Wynik bez danych nabywcy. */
export async function syncWfirmaWz(db: PrismaClient, src: WzZrodlo, opts: WzSyncOpts = {}): Promise<WzSyncStats> {
  const now = opts.now ?? new Date()
  const stats: WzSyncStats = { read: 0, settled: 0, alreadySettled: 0, waitingForBlInvoice: 0, nothingToSettle: 0, withoutOrder: 0, ambiguous: 0, outsideCatalog: 0, waitingForPair: 0, outsideShadow: 0, unresolvedOld: 0, errors: [], complete: true }
  const organizationId = organizationIdOf(db)
  // WZ dotyczą tylko magazynu, którego stan prowadzi wFirma (lustro); magazyn Kompletora zdejmuje stan sam
  if ((await zrodloStanu(db)) !== 'WFIRMA') return stats
  const wh = await db.warehouse.findFirst({ where: { id: DEFAULT_WAREHOUSE }, select: { wfirmaWarehouseId: true } })
  const magazyn = wh?.wfirmaWarehouseId ?? null
  const newest = await db.wfirmaWzSnapshot.findFirst({ orderBy: { docDate: 'desc' }, select: { docDate: true } })
  const od = opts.od ?? (newest ? dayOf(new Date(Date.parse(newest.docDate) - WZ_OVERLAP_DAYS * 86400_000)) : dayOf(new Date(now.getTime() - WZ_LOOKBACK_DAYS * 86400_000)))
  const r = await src.wzOd(od, magazyn)
  stats.complete = r.complete
  stats.errors.push(...r.errors)
  stats.read = r.docs.length

  // numery faktur: lista dni WZ (jedno–kilka wywołań), pojedyncze `get` tylko dla brakujących, z limitem
  const known = new Map((await db.wfirmaWzSnapshot.findMany({ where: { wfirmaDocId: { in: r.docs.map((d) => d.docId) } }, select: { wfirmaDocId: true, invoiceNumber: true, outcome: true } })).map((x) => [x.wfirmaDocId, x]))
  const needNumber = r.docs.filter((d) => d.invoiceId && !known.get(d.docId)?.invoiceNumber)
  let numbers = new Map<string, string>()
  if (needNumber.length) {
    const days = needNumber.map((d) => d.data).sort()
    try {
      numbers = await src.numeryFaktur(days[0]!, days[days.length - 1]!)
    } catch (e) {
      stats.errors.push(`lista faktur: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  let budget = WZ_INVOICE_GET_BUDGET
  for (const d of r.docs) {
    if (magazyn && d.magazyn && d.magazyn !== magazyn) continue // WZ innego magazynu nie dotyczy lustra
    try {
      const prev = known.get(d.docId)
      if (prev?.outcome && (FINAL as string[]).includes(prev.outcome)) continue
      let invoiceNumber = prev?.invoiceNumber ?? (d.invoiceId ? (numbers.get(d.invoiceId) ?? null) : null)
      if (d.invoiceId && !invoiceNumber && budget > 0) {
        budget--
        invoiceNumber = await src.numerFaktury(d.invoiceId)
      }
      const created = warsawStamp(d.utworzono)
      const base = { number: d.numer, docDate: d.data, createdInWfirma: created, wfirmaWarehouseId: d.magazyn, invoiceId: d.invoiceId, invoiceNumber, lines: d.pozycje as unknown as Prisma.InputJsonValue, description: d.opis || null, createdRaw: d.utworzono }
      await db.wfirmaWzSnapshot.upsert({
        where: { organizationId_wfirmaDocId: { organizationId, wfirmaDocId: d.docId } },
        create: { wfirmaDocId: d.docId, ...base, fetchedAt: now },
        update: base,
      })
      const outcome = await settleOne(db, d, invoiceNumber, created, now, stats, opts.fakturyBl)
      await db.wfirmaWzSnapshot.update({
        where: { organizationId_wfirmaDocId: { organizationId, wfirmaDocId: d.docId } },
        data: { outcome: outcome.outcome, orderId: outcome.orderId, linkedBy: outcome.linkedBy, candidates: outcome.candidates ?? null, settledAt: (FINAL as string[]).includes(outcome.outcome) ? now : null, lastError: null },
      })
    } catch (e) {
      const m = (e instanceof Error ? e.message : String(e)).slice(0, 1000)
      stats.errors.push(`${d.numer}: ${m}`)
      await db.wfirmaWzSnapshot.updateMany({ where: { wfirmaDocId: d.docId }, data: { attempts: { increment: 1 }, lastError: m } }).catch(() => undefined)
    }
  }
  // nierozstrzygnięte WZ spoza tego odczytu (starsze niż okno nakładki): ponowna próba z kopii, bez wFirmy
  const seen = new Set(r.docs.map((d) => d.docId))
  const retry = await db.wfirmaWzSnapshot.findMany({
    where: { createdInWfirma: { gte: new Date(now.getTime() - WZ_RETRY_DAYS * 86400_000) }, OR: [{ outcome: null }, { outcome: { notIn: FINAL } }] },
    orderBy: { createdInWfirma: 'asc' },
    take: 200,
  })
  for (const x of retry.filter((y) => !seen.has(y.wfirmaDocId))) {
    try {
      const d: WzDokument = { docId: x.wfirmaDocId, numer: x.number, data: x.docDate, utworzono: x.createdRaw ?? '', magazyn: x.wfirmaWarehouseId, invoiceId: x.invoiceId, opis: x.description ?? '', pozycje: x.lines as unknown as WzLine[] }
      // numer faktury, którego zabrakło w przebiegu z wFirmy (budżet `get` wyczerpany), dobierany z kopii
      let invoiceNumber = x.invoiceNumber
      if (x.invoiceId && !invoiceNumber && budget > 0) {
        budget--
        invoiceNumber = await src.numerFaktury(x.invoiceId)
      }
      const outcome = await settleOne(db, d, invoiceNumber, x.createdInWfirma, now, stats, opts.fakturyBl)
      await db.wfirmaWzSnapshot.update({
        where: { organizationId_wfirmaDocId: { organizationId, wfirmaDocId: x.wfirmaDocId } },
        data: { invoiceNumber, outcome: outcome.outcome, orderId: outcome.orderId, linkedBy: outcome.linkedBy, candidates: outcome.candidates ?? null, settledAt: (FINAL as string[]).includes(outcome.outcome) ? now : null, lastError: null },
      })
    } catch (e) {
      const m = (e instanceof Error ? e.message : String(e)).slice(0, 1000)
      stats.errors.push(`${x.number}: ${m}`)
      await db.wfirmaWzSnapshot.update({ where: { organizationId_wfirmaDocId: { organizationId, wfirmaDocId: x.wfirmaDocId } }, data: { attempts: { increment: 1 }, lastError: m } }).catch(() => undefined)
    }
  }
  await alertUnresolved(db, now, stats)
  return stats
}

/**
 * WZ, które dłużej niż WZ_UNRESOLVED_ALERT_HOURS czekają na parę, nie mają zamówienia albo mają
 * kilka kandydatów, trzymają rezerwację naszego zamówienia (o ile to nasze). Jeden alert biura na dobę z liczbą i
 * numerami; WZ zamówień spoza cienia (POZA_CIENIEM) i spoza katalogu się nie liczą.
 */
async function alertUnresolved(db: PrismaClient, now: Date, stats: WzSyncStats): Promise<void> {
  try {
    const rows = await db.wfirmaWzSnapshot.findMany({
      where: {
        outcome: { in: UNRESOLVED },
        // wiek od pierwszego odczytu (fetchedAt), nie od założenia w wFirmie: pierwszy przebieg 14 dni wstecz nie
        // alertuje od razu o starych WZ, zanim para po tożsamości zdąży je rozstrzygnąć
        fetchedAt: { lt: new Date(now.getTime() - WZ_UNRESOLVED_ALERT_HOURS * 3600_000) },
        createdInWfirma: { gte: new Date(now.getTime() - WZ_RETRY_DAYS * 86400_000) },
      },
      select: { number: true, invoiceNumber: true, outcome: true },
      orderBy: { createdInWfirma: 'asc' },
      take: 200,
    })
    stats.unresolvedOld = rows.length
    if (!rows.length) return
    const list = rows.slice(0, 10).map((r) => (r.invoiceNumber ? `${r.number} (faktura ${r.invoiceNumber})` : r.number))
    const more = rows.length > list.length ? ` i ${rows.length - list.length} więcej` : ''
    const czekaBl = rows.filter((r) => r.outcome === 'CZEKA_NA_FAKTURE_BL').length
    const bl = czekaBl ? ` Z tego ${czekaBl} czeka na fakturę z BaseLinkera: sprawdź połączenie z BaseLinkerem (Przejście z BaseLinkera → Przeprowadzka, krok „Klucz API”).` : ''
    await alert(
      db,
      'WZ_NIEROZSTRZYGNIETE',
      'wz-wfirmy',
      `Dokumenty WZ z wFirmy bez przypisanego zamówienia od ponad ${WZ_UNRESOLVED_ALERT_HOURS} h: ${rows.length}. ${list.join(', ')}${more}. Jeśli to nasze zamówienia, ich rezerwacja nadal wisi: sprawdź w raporcie rozjazdów.${bl}`,
      `wz-nierozstrzygniete:${dayOf(now)}`,
    )
  } catch (e) {
    stats.errors.push(`alert WZ: ${e instanceof Error ? e.message : String(e)}`)
  }
}

interface Settled {
  outcome: WzOutcome
  orderId: string | null
  linkedBy: 'FAKTURA' | 'OPIS' | 'POZYCJE' | null
  candidates?: number
}

async function settleOne(db: PrismaClient, d: WzDokument, invoiceNumber: string | null, created: Date, now: Date, stats: WzSyncStats, fakturyBl?: WzSyncOpts['fakturyBl']): Promise<Settled> {
  const docRef = invoiceNumber ?? d.numer
  // (a) faktura już rozliczona w rdzeniu (faktura BL z WZ, nasza faktura, wcześniejszy przebieg); także WZ
  // wystawione przez Kompletor przy wysyłce bez faktury (ruch z numerem WZ albo `wz:<id>`, gdy program nie dał numeru)
  const done = await db.pendingMovement.findFirst({ where: { wfirmaDocId: { in: [...new Set([docRef, d.numer, `wz:${d.docId}`, ...(d.invoiceId ? [d.invoiceId] : [])])] } }, select: { orderId: true } })
  if (done) {
    stats.alreadySettled++
    return { outcome: 'JUZ_ROZLICZONA', orderId: done.orderId, linkedBy: 'FAKTURA' }
  }
  const { per, complete } = await wzProducts(db, d.pozycje)
  // (b) kopia faktury BL z tym numerem
  let orderId: string | null = null
  let linkedBy: Settled['linkedBy'] = null
  // faktura korygująca nie tworzy WZ, a jej kopia nie wiąże zamówienia
  // `kind` NULL (BL nie podał typu) to nie korekta; samo `NOT kind = correcting` w SQL wyklucza też NULL
  const inv = invoiceNumber
    ? await db.blInvoiceSnapshot.findFirst({
        where: { AND: [{ OR: [{ number: invoiceNumber }, { externalNumber: invoiceNumber }] }, { OR: [{ kind: null }, { kind: { not: 'correcting' } }] }] },
        orderBy: { blInvoiceId: 'desc' },
      })
    : null
  if (inv) {
    const o = await db.order.findFirst({ where: { blOrderId: inv.blOrderId }, select: { id: true } })
    if (!o) {
      // faktura należy do zamówienia BL bez pary u nas: para tylko po tożsamości (para od strony faktury BL), nigdy po
      // ilościach. Po nieudanej próbie pary (znacznik w kopii faktury) zamówienie BL nie jest nasze (spoza cienia).
      if (bezParyPoProbie(inv.lastError)) {
        stats.outsideShadow++
        return { outcome: 'POZA_CIENIEM', orderId: null, linkedBy: null }
      }
      stats.waitingForPair++
      return { outcome: 'CZEKA_NA_PARE', orderId: null, linkedBy: null }
    }
    // kopia czeka w torze faktur BL (WZ znajdzie się po numerze): nie rozliczamy drugi raz
    if (!inv.appliedAt) {
      stats.waitingForBlInvoice++
      return { outcome: 'CZEKA_NA_FAKTURE_BL', orderId: o.id, linkedBy: 'FAKTURA' }
    }
    orderId = o.id
    linkedBy = 'FAKTURA'
  }
  // (c) numer zamówienia BL w opisie WZ
  if (!orderId && d.opis) {
    orderId = await orderFromDescription(db, d.opis)
    if (orderId) linkedBy = 'OPIS'
  }
  // (d) pozycje: dokładnie jedno pasujące zamówienie — tylko WZ bez kopii faktury BL (`inv` wyżej zawsze kończy wybór)
  if (!orderId) {
    // świeża faktura z wFirmy bez kopii faktur BL to zwykle faktura BL sprzed najbliższego odczytu faktur, nie
    // faktura ręczna biura: czekamy na kopię (ponowna próba z kopii WZ), po oknie dopiero pozycje
    // bez numeru faktury kopii BL nie da się sprawdzić (numer dobierze kolejny przebieg); BL skonfigurowany,
    // a odczyt faktur BL nie przeszedł kompletnie po założeniu WZ (nieważny token, błąd API, wyłączone zadanie; bez tokena WZ idzie po pozycjach od razu) = czekamy
    if (!inv && d.invoiceId && (now.getTime() - created.getTime() < WZ_BL_INVOICE_WAIT_MIN * 60_000 || !invoiceNumber || !fakturyBlAktualne(fakturyBl, created))) {
      stats.waitingForBlInvoice++
      return { outcome: 'CZEKA_NA_FAKTURE_BL', orderId: null, linkedBy: null }
    }
    if (!complete || !Object.keys(per).length) {
      stats.outsideCatalog++
      return { outcome: 'POZA_KATALOGIEM', orderId: null, linkedBy: null }
    }
    const cands = await ordersMatchingLines(db, per, created)
    if (cands.length > 1) {
      stats.ambiguous++
      return { outcome: 'NIEJEDNOZNACZNE', orderId: null, linkedBy: null, candidates: cands.length }
    }
    if (!cands.length) {
      stats.withoutOrder++
      return { outcome: 'BEZ_ZAMOWIENIA', orderId: null, linkedBy: null }
    }
    orderId = cands[0]!
    linkedBy = 'POZYCJE'
  }
  const issued = await shortagesAsIssued(db, orderId, per, now, d.numer)
  const [active, withoutDoc] = await Promise.all([
    db.reservation.count({ where: { orderId, state: 'ACTIVE' } }),
    db.pendingMovement.count({ where: { orderId, type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL' } }),
  ])
  if (!active && !withoutDoc && !issued) {
    stats.nothingToSettle++
    return { outcome: 'NIC_DO_ROZLICZENIA', orderId, linkedBy }
  }
  if (active || withoutDoc) await applyBlInvoice(db, orderId, docRef, per, { now })
  if (inv && !inv.appliedAt)
    await db.blInvoiceSnapshot.update({ where: { organizationId_blInvoiceId: { organizationId: inv.organizationId, blInvoiceId: inv.blInvoiceId } }, data: { appliedAt: now, outcome: 'ZASTOSOWANA', orderId, lastError: null } })
  await db.orderEvent.create({ data: { orderId, kind: 'WZ_WFIRMY', actorId: 'system:wz-wfirmy', data: { wz: d.numer, faktura: invoiceNumber, powiazanie: linkedBy } } })
  if (linkedBy === 'POZYCJE')
    await alert(db, 'WZ_PO_POZYCJACH', orderId, `Rozliczone po pozycjach dokumentu ${d.numer}${invoiceNumber ? ` (faktura ${invoiceNumber})` : ''}: sprawdź, czy to to zamówienie`, `wz-pozycje:${d.docId}`)
  stats.settled++
  return { outcome: 'ROZLICZONA', orderId, linkedBy }
}
