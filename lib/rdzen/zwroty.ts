// Zwroty i korekty faktur (spec 3.5, 3.6, 4.5, 7.4; v1.5). Byt `Return` ma 5 statusów:
//   ZGLOSZONY → PRZYJETY (pozycje oznaczone) → KOREKTA (kolejka wFirmy) → ZAKONCZONY;  ZGLOSZONY/PRZYJETY → ODRZUCONY.
// Korekta nigdy nie zakłada ruchu dodatniego (2.2 pkt 3): towar „na stan” pokaże odczyt wFirmy (zlecony goods/get),
// wzrost przejdzie przez allocate. Korekta z PZ przywraca w wFirmie także towar, którego nie da się sprzedać —
// „uszkodzone” (3.6 v1.5) i „brak” (pozycja na fakturze, której nie było w paczce, 4.5 v1.5) — więc w tej samej
// transakcji ruch MANUAL ujemny (DAMAGED_RETURN / STOCK_MISSING): `physical` i `available` na kanały spadają od razu,
// biuro robi RW w wFirmie i klika „poprawione” (officeConfirmManual), potwierdza odczyt po kliknięciu.
// Korekta bez PZ dla „na stan” (3.5 v1.5) → lista „korekta bez PZ” (biuro wystawia PZ i klika „PZ wystawione”).
// Wywołanie wFirmy idzie przez interfejs `KorektyWfirma` z kolejki (kolejka-wfirmy.ts); w tym zadaniu tylko atrapa.
//
// magazyn prowadzony przez Kompletor (źródło stanu KOMPLETOR). Towar zszedł przy „Do wysyłki”
// ruchem OWN_DISPATCH, bez faktury z WZ, więc zwrot nie ma czego korygować w programie do faktur: `invoiceDocId = null`,
// a przyjęcie paczki (`receiveReturn`; przy korekcie bez przesyłki `requestCorrection`) od razu kończy zwrot:
// „na stan” = ruch przychodu OWN_RETURN (+physical, +available, przydział braków), „uszkodzone” i „brak” = ruch 0 do
// historii (towar poza sprzedażą). Flaga `doKorekty` schodzi, chyba że zamówienie ma wystawiony dokument sprzedaży
// (wtedy alert „Faktura do korekty”: korektę dokumentu robi się w programie do faktur). Anulowanie po wydaniu
// (`cancelInTx`) zostawia `doKorekty`; zwrot całości jednym krokiem: `przyjmijZwrotPoAnulowaniu`.
import type { Order, Prisma, Return, ReturnDisposition, ReturnKind } from '@prisma/client'
import { mergeFlags } from './rezerwacja'
import { FIND_SCHEDULE_MS, FindValidationError, type QueueCtx, validateFound, WfirmaLimitError } from './rozchod'
import { advisoryLock, alert, type Db, DEFAULT_WAREHOUSE, loadCatalog, orderLockKey, outbox, partsOf, runTx, StockBook, type Tx } from './stan'
import { zrodloStanu } from './zrodlo-stanu'
import { ALERT_ZWROT_PRZESYLKI } from '../wysylka/reguly-drogi'
import type { Ctx } from './zamowienia'

/**
 * wynik kontroli korekty po zapisie (odczyt dokumentu i porównanie ilości).
 * `KOREKTA_NIEZGODNA` = dokument w programie ma inne ilości niż wynika ze zwrotu; `KOREKTA_NIESPRAWDZONA` = odczyt
 * kontrolny się nie udał. Żadne nie zmienia wyniku (dokument istnieje): zwrot kończy się, biuro dostaje alert.
 */
export interface OstrzezenieKorekty {
  kod: 'KOREKTA_NIEZGODNA' | 'KOREKTA_NIESPRAWDZONA'
  tresc: string
}

export type CorrectionResult =
  | { kind: 'OK'; docId: string; pz: Record<string, number | null>; ostrzezenie?: OstrzezenieKorekty } // pz: ilość przyjęta na stan per productId (null = brak danych)
  | { kind: 'ERROR'; message: string }
  | { kind: 'TIMEOUT' }
  | { kind: 'LIMIT'; message: string; retryAfterMs?: number }

export interface FoundCorrection {
  docId: string
  idExternal: string
  pz: Record<string, number | null>
}

export interface KorektyWfirma {
  /** Korekta faktury `invoiceDocId` o zwracane ilości. Kontrakt błędów jak `FakturyWfirma.issue` (wyjątek = timeout). */
  issueCorrection(req: { idExternal: string; invoiceDocId: string; lines: { productId: string; qty: number }[] }): Promise<CorrectionResult>
  /** Korekty po prefiksie id_external `zwrot/<returnId>/` (rozstrzyganie timeoutu, 3.4). */
  findCorrectionsByPrefix(prefix: string): Promise<FoundCorrection[]>
  /**
   * kontrola korekty znalezionej po timeoucie (ilości jak przy korekcie potwierdzonej od razu).
   * Opcjonalna (atrapy bez niej = bez kontroli); nie rzuca, wynik nie zmienia zakończenia zwrotu.
   */
  sprawdzZnaleziona?(req: { idExternal: string; invoiceDocId: string; docId: string; lines: { productId: string; qty: number }[] }): Promise<OstrzezenieKorekty | null>
}

export class ReturnError extends Error {}

export interface ReturnItem {
  orderLineId: string
  /** Składnik zestawu (jednostka bazowa); brak = cała pozycja: `qty` w sztukach pozycji (dla zestawu — zestawów). */
  productId?: string
  qty: number
  disposition?: ReturnDisposition
}

export const correctionPrefix = (returnId: string) => `zwrot/${returnId}/`

async function lockOrder(tx: Tx, orderId: string): Promise<Order> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
  await advisoryLock(tx, orderLockKey(o))
  return tx.order.findUniqueOrThrow({ where: { id: orderId } })
}

async function lockReturn(tx: Tx, returnId: string): Promise<Return & { lines: Prisma.ReturnLineGetPayload<object>[] }> {
  const r0 = await tx.return.findUniqueOrThrow({ where: { id: returnId } })
  await lockOrder(tx, r0.orderId)
  return tx.return.findUniqueOrThrow({ where: { id: returnId }, include: { lines: { orderBy: { id: 'asc' } } } })
}

/**
 * inny zwrot tej samej faktury z korektą wystawioną albo w drodze. Druga korekta
 * liczona od faktury pierwotnej podniosłaby ilość z powrotem (korekta korekty wymaga `parent` = ostatnia korekta), więc
 * Kompletor jej nie wystawia: biuro wystawia kolejną korektę w programie i kończy zwrot „poza Kompletorem”.
 * Liczy się: zwrot ZAKONCZONY z tą fakturą (z `invoiceDocId` kończy się wyłącznie korektą, z Kompletora albo poza nim)
 * oraz zwrot „W trakcie” z korektą wysyłaną, niewiadomą albo wystawioną. Zwroty w kolejce (bez wysłania) nie blokują
 * się nawzajem: pierwszy, który ustawi SENDING, zablokuje drugi.
 */
export async function innaKorektaFaktury(db: Db | Tx, returnId: string, invoiceDocId: string): Promise<{ id: string; wystawiona: boolean } | null> {
  const r = await db.return.findFirst({
    where: {
      invoiceDocId,
      id: { not: returnId },
      OR: [{ status: 'ZAKONCZONY' }, { status: 'KOREKTA', correctionState: { in: ['SENDING', 'UNKNOWN', 'ISSUED'] } }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true },
  })
  return r ? { id: r.id, wystawiona: r.status === 'ZAKONCZONY' } : null
}

/** Faktura, z której wyszły pozycje: własna (InvoiceAttempt) albo BL (ruch BL_INVOICE). Dokładnie jedna na zwrot. */
async function invoiceDocOf(tx: Tx, orderId: string, pairs: { orderLineId: string; productId: string }[]): Promise<string> {
  const docs = new Set<string>()
  for (const p of pairs) {
    const res = await tx.reservation.findMany({ where: { orderId, orderLineId: p.orderLineId, productId: p.productId, state: 'CONSUMED' }, select: { invoiceId: true } })
    const attemptIds = [...new Set(res.map((r) => r.invoiceId).filter((x): x is string => !!x))]
    const own = attemptIds.length ? await tx.invoiceAttempt.findMany({ where: { id: { in: attemptIds }, state: 'ISSUED' }, select: { wfirmaDocId: true } }) : []
    own.forEach((a) => a.wfirmaDocId && docs.add(a.wfirmaDocId))
    if (!own.length) {
      const bl = await tx.pendingMovement.findMany({ where: { orderId, productId: p.productId, type: 'BL_INVOICE', wfirmaDocId: { not: null } }, select: { wfirmaDocId: true } })
      bl.forEach((m) => docs.add(m.wfirmaDocId!))
    }
  }
  if (docs.size === 0) throw new ReturnError('Brak faktury do korekty (wydane bez dokumentu?) — najpierw dokument w wFirmie')
  if (docs.size > 1) throw new ReturnError('Pozycje z różnych faktur — osobny zwrot na każdą paczkę')
  return [...docs][0]!
}

/**
 * magazyn wydania własnego (źródło KOMPLETOR), z którego zeszły pozycje zwrotu, albo null = wydane fakturą
 * z magazynu lustra wFirmy (dawna ścieżka). Pozycje z dwóch magazynów albo z obu torów naraz = osobne zwroty.
 */
async function magazynWydaniaWlasnego(tx: Tx, orderId: string, pairs: { orderLineId: string; productId: string }[]): Promise<string | null> {
  const res = pairs.length
    ? await tx.reservation.findMany({ where: { orderId, state: 'CONSUMED', OR: pairs.map((p) => ({ orderLineId: p.orderLineId, productId: p.productId })) }, select: { warehouseId: true } })
    : []
  const whs = [...new Set(res.map((r) => r.warehouseId))].sort()
  if (!whs.length) return (await zrodloStanu(tx, DEFAULT_WAREHOUSE)) === 'KOMPLETOR' ? DEFAULT_WAREHOUSE : null
  const zrodla = await Promise.all(whs.map((wh) => zrodloStanu(tx, wh)))
  if (zrodla.every((z) => z === 'WFIRMA')) return null
  if (zrodla.some((z) => z === 'WFIRMA') || whs.length > 1) throw new ReturnError('Pozycje z różnych magazynów: osobny zwrot na każdy magazyn')
  return whs[0]!
}

/**
 * Zgłoszenie zwrotu (ZWROT → ZGLOSZONY) albo korekty bez przesyłki (KOREKTA → od razu PRZYJETY, każda pozycja
 * z oznaczeniem). Zwrócić można tylko to, co wyszło fakturą (rezerwacje CONSUMED) minus inne zwroty (bez odrzuconych).
 */
export interface ZgloszenieZwrotu {
  kind?: ReturnKind
  note?: string
  /** kod powodu (lib/zwroty/powody.ts) albo krótki tekst; bez danych kupującego. */
  reason?: string
  /** zgłoszenie z kanału (Allegro customer-returns): ten sam numer drugi raz = istniejący zwrot, bez dubla. */
  zrodlo?: { source: 'ALLEGRO'; externalId: string }
}

export async function createReturn(db: Db, orderId: string, items: ReturnItem[], ctx: Ctx & ZgloszenieZwrotu = {}): Promise<string> {
  const now = ctx.now ?? new Date()
  const kind = ctx.kind ?? 'ZWROT'
  if (ctx.reason !== undefined && ctx.reason.length > 500) throw new ReturnError('Powód zwrotu najwyżej 500 znaków')
  if (!items.length) throw new ReturnError('Zwrot bez pozycji')
  for (const it of items) if (!Number.isInteger(it.qty) || it.qty <= 0) throw new ReturnError('Ilość zwrotu musi być dodatnią liczbą całkowitą')
  if (kind === 'KOREKTA' && items.some((it) => !it.disposition)) throw new ReturnError('Korekta bez przesyłki: każda pozycja potrzebuje oznaczenia')
  return runTx(db, async (tx) => {
    const o = await lockOrder(tx, orderId)
    // zwrot z kanału już założony (ponowny odczyt, dwa przebiegi naraz pod blokadą zamówienia) = ten sam
    if (ctx.zrodlo) {
      const jest = await tx.return.findFirst({ where: { source: ctx.zrodlo.source, externalId: ctx.zrodlo.externalId }, select: { id: true } })
      if (jest) return jest.id
    }
    const lines = await tx.orderLine.findMany({ where: { orderId } })
    const cat = await loadCatalog(tx, lines.map((l) => l.productId).filter((x): x is string => !!x))
    const rows: { orderLineId: string; productId: string; qty: number; disposition: ReturnDisposition | null }[] = []
    for (const it of items) {
      const line = lines.find((l) => l.id === it.orderLineId)
      const entry = line?.productId ? cat.get(line.productId) : undefined
      if (!line || !entry) throw new ReturnError(`Pozycja ${it.orderLineId} nie należy do zamówienia albo jest niezmapowana`)
      // produkt bez stanu (DIGITAL): rdzeń nie koryguje usług — inaczej korekta wyszłaby cicho bez tej pozycji
      if (entry.kind === 'DIGITAL') throw new ReturnError(`Pozycja ${line.externalLineId} to produkt bez stanu — korektę usługi wystaw ręcznie w wFirmie`)
      const parts = partsOf(entry)
      if (it.productId) {
        if (!parts.some((p) => p.productId === it.productId)) throw new ReturnError(`Produkt ${it.productId} nie należy do pozycji ${line.externalLineId}`)
        rows.push({ orderLineId: line.id, productId: it.productId, qty: it.qty, disposition: it.disposition ?? null })
      } else for (const p of parts) rows.push({ orderLineId: line.id, productId: p.productId, qty: it.qty * p.perUnit, disposition: it.disposition ?? null })
    }
    const whWlasny = await magazynWydaniaWlasnego(tx, orderId, rows)
    // limit: CONSUMED minus to, co już jest w zwrotach (bez odrzuconych)
    const key = (l: string, p: string) => `${l}:${p}`
    const want = new Map<string, number>()
    for (const r of rows) want.set(key(r.orderLineId, r.productId), (want.get(key(r.orderLineId, r.productId)) ?? 0) + r.qty)
    for (const [k, qty] of want) {
      const [orderLineId, productId] = k.split(':') as [string, string]
      const consumed = await tx.reservation.aggregate({ where: { orderLineId, productId, state: 'CONSUMED' }, _sum: { qtyBase: true } })
      const returned = await tx.returnLine.aggregate({ where: { orderLineId, productId, ret: { status: { not: 'ODRZUCONY' } } }, _sum: { qty: true } })
      const left = (consumed._sum.qtyBase ?? 0) - (returned._sum.qty ?? 0)
      if (qty > left) throw new ReturnError(`Za dużo do zwrotu: ${qty}, a wydane ${whWlasny ? 'z magazynu' : 'fakturą'} i jeszcze nie zwrócone ${left}`)
    }
    // przy stanie Kompletora nie ma faktury z rozchodem do korekty (dokument sprzedaży to osobny tor)
    const invoiceDocId = whWlasny ? null : await invoiceDocOf(tx, orderId, rows)
    const ret = await tx.return.create({
      data: {
        orderId,
        kind,
        status: kind === 'KOREKTA' ? 'PRZYJETY' : 'ZGLOSZONY',
        invoiceDocId,
        note: ctx.note ?? null,
        reason: ctx.reason?.trim() || null,
        source: ctx.zrodlo?.source ?? 'PANEL',
        externalId: ctx.zrodlo?.externalId ?? null,
        createdBy: ctx.actorId ?? null,
        receivedAt: kind === 'KOREKTA' ? now : null,
        lines: { create: rows },
      },
    })
    await tx.orderEvent.create({ data: { orderId: o.id, kind: kind === 'KOREKTA' ? 'KOREKTA_ZLOZONA' : kind === 'REKLAMACJA' ? 'REKLAMACJA_ZGLOSZONA' : 'ZWROT_ZGLOSZONY', actorId: ctx.actorId ?? 'panel', data: { returnId: ret.id, invoiceDocId, pozycje: rows.length, ...(ctx.zrodlo ? { zrodlo: ctx.zrodlo.source } : {}) } } })
    return ret.id
  })
}

/** Paczka zwrotu w magazynie: każda pozycja „na stan” albo „uszkodzone” (ZGLOSZONY → PRZYJETY). */
export async function receiveReturn(db: Db, returnId: string, disposition: ReturnDisposition | Record<string, ReturnDisposition>, ctx: Ctx = {}): Promise<void> {
  const now = ctx.now ?? new Date()
  await runTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId)
    // drugie kliknięcie po odświeżeniu = czytelny komunikat zamiast nazwy statusu
    if (r.status !== 'ZGLOSZONY') throw new ReturnError(r.status === 'ODRZUCONY' ? 'Zwrot jest odrzucony: paczki nie da się już odebrać' : 'Paczka jest już odebrana')
    for (const l of r.lines) {
      const d = typeof disposition === 'string' ? disposition : disposition[l.id]
      if (!d) throw new ReturnError('Każda pozycja zwrotu potrzebuje oznaczenia „na stan” albo „uszkodzone”')
      if (d === 'BRAK') throw new ReturnError('„Brak” tylko w korekcie bez przesyłki (pozycja nie wróciła = mniejsza ilość zwrotu)')
      await tx.returnLine.update({ where: { id: l.id }, data: { disposition: d } })
      l.disposition = d
    }
    await tx.return.update({ where: { id: returnId }, data: { status: 'PRZYJETY', receivedAt: now } })
    await tx.orderEvent.create({ data: { orderId: r.orderId, kind: 'ZWROT_PRZYJETY', actorId: ctx.actorId ?? 'magazyn', data: { returnId } } })
    // paczka w magazynie: powiadomienie „paczka wraca do nadawcy” ze śledzenia tego zamówienia jest załatwione
    await tx.alert.updateMany({ where: { kind: ALERT_ZWROT_PRZESYLKI, ref: r.orderId, closedAt: null }, data: { closedAt: now } })
    if (r.invoiceDocId === null) await przyjmijNaStanInTx(tx, { ...r, receivedAt: now }, now, ctx.actorId ?? 'magazyn')
  })
}

/**
 * zakończenie zwrotu przy stanie Kompletora (bez korekty w programie do faktur). „Na stan” = ruch OWN_RETURN
 * +qty (physical i wfirmaCount razem, jak korekta z panelu, więc `physical = wfirmaCount + pendingDelta` trzyma się),
 * potem przydział braków; „uszkodzone” i „brak” = ruch 0 do historii. Wołane pod blokadą zamówienia (`lockReturn`).
 */
async function przyjmijNaStanInTx(tx: Tx, r: Return & { lines: Prisma.ReturnLineGetPayload<object>[] }, now: Date, actorId: string): Promise<void> {
  const wh = await magazynWydaniaWlasnego(tx, r.orderId, r.lines)
  if (!wh) throw new ReturnError('Zwrot zgłoszony bez faktury, a stan magazynu prowadzi teraz wFirma. Odrzuć ten zwrot i przyjmij towar dokumentem w wFirmie.')
  const naStan = r.lines.filter((l) => l.disposition === 'NA_STAN')
  const book = await StockBook.lock(tx, wh, naStan.map((l) => l.productId))
  let sztuk = 0
  for (const l of r.lines) {
    if (l.disposition === 'NA_STAN') {
      const przed = book.get(l.productId)
      if (!przed) throw new ReturnError(`Brak wiersza stanu produktu ${l.productId} w magazynie ${wh}`)
      const wfirmaCount = przed.wfirmaCount
      book.change(l.productId, { physical: l.qty })
      const po = book.get(l.productId)!
      book.set(l.productId, { wfirmaCount: wfirmaCount + l.qty, overcommitSince: po.reserved > po.physical ? (po.overcommitSince ?? now) : null })
      sztuk += l.qty
    }
    const pozaStanem = l.disposition === 'USZKODZONE' ? 'uszkodzone' : 'brak w paczce'
    await tx.stockMovement.create({
      data: {
        productId: l.productId,
        warehouseId: wh,
        deltaPhysical: l.disposition === 'NA_STAN' ? l.qty : 0,
        source: 'OWN_RETURN',
        reason: l.disposition === 'NA_STAN' ? `zwrot ${r.id}: +${l.qty} na stan` : `zwrot ${r.id}: ${l.qty} ${pozaStanem}, poza stanem`,
        actorId,
        orderId: r.orderId,
      },
    })
  }
  await tx.return.update({ where: { id: r.id }, data: { status: 'ZAKONCZONY', correctionState: null, nextFindAt: null, closedAt: now, lastError: null, receivedAt: r.receivedAt ?? now } })
  // dokument sprzedaży (tor bez rozchodu) zostaje do korekty w programie do faktur — Kompletor jej nie wystawia
  const dokument = await tx.invoiceAttempt.findFirst({ where: { orderId: r.orderId, state: 'ISSUED' }, select: { wfirmaDocId: true, number: true } })
  const o = await tx.order.findUniqueOrThrow({ where: { id: r.orderId } })
  await tx.order.update({ where: { id: o.id }, data: { flags: mergeFlags(o, { doKorekty: !!dokument }) } })
  await tx.orderEvent.create({ data: { orderId: r.orderId, kind: 'ZWROT_NA_STAN', actorId, data: { returnId: r.id, naStan: sztuk, pozaStanem: r.lines.length - naStan.length } } })
  if (dokument) {
    const nr = dokument.number ?? dokument.wfirmaDocId
    await alert(tx, 'FAKTURA_DO_KOREKTY', r.orderId, `Zwrot przyjęty na stan. Dokument sprzedaży${nr ? ` ${nr}` : ''} skoryguj w programie do faktur`, `zwrot-dokument:${r.id}`)
  }
  await book.flush(tx, now)
  for (const p of [...new Set(naStan.map((l) => l.productId))].sort()) await outbox(tx, 'ALLOCATE', p, now)
}

/**
 * zamówienie anulowane po wydaniu przy stanie Kompletora — cała wydana, jeszcze
 * niezwrócona ilość wraca jednym krokiem (zwrot „na stan” albo „uszkodzone”), flaga `doKorekty` schodzi bez wFirmy.
 * Zwraca id zwrotu albo null, gdy nie ma już nic do zwrotu.
 */
export async function przyjmijZwrotPoAnulowaniu(db: Db, orderId: string, ctx: Ctx & { disposition?: Exclude<ReturnDisposition, 'BRAK'>; note?: string } = {}): Promise<string | null> {
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })
  if (o.status !== 'ANULOWANE') throw new ReturnError('Zwrot całości jednym krokiem tylko dla anulowanego zamówienia')
  // ponowienie po przerwanym poprzednim kliknięciu: przyjęty, niezakończony zwrot bez faktury kończymy, nie dublujemy
  const wiszacy = await db.return.findFirst({ where: { orderId, status: 'PRZYJETY', invoiceDocId: null }, select: { id: true } })
  if (wiszacy) {
    await requestCorrection(db, wiszacy.id, ctx)
    return wiszacy.id
  }
  const doZwrotu = await pozostaloDoZwrotu(db, orderId)
  if (!doZwrotu.length) return null
  const rid = await createReturn(db, orderId, doZwrotu.map((x) => ({ orderLineId: x.orderLineId, productId: x.productId, qty: x.qty, disposition: ctx.disposition ?? 'NA_STAN' })), { ...ctx, kind: 'KOREKTA', note: ctx.note ?? 'zwrot po anulowaniu' })
  await requestCorrection(db, rid, ctx)
  return rid
}

/** Wydane (CONSUMED) minus zwroty bez odrzuconych, per pozycja i produkt (składnik zestawu osobno). */
export async function pozostaloDoZwrotu(db: Db | Tx, orderId: string): Promise<{ orderLineId: string; productId: string; qty: number }[]> {
  const consumed = await db.reservation.groupBy({ by: ['orderLineId', 'productId'], where: { orderId, state: 'CONSUMED' }, _sum: { qtyBase: true } })
  const returned = await db.returnLine.groupBy({ by: ['orderLineId', 'productId'], where: { ret: { orderId, status: { not: 'ODRZUCONY' } } }, _sum: { qty: true } })
  const zw = new Map(returned.map((r) => [`${r.orderLineId}:${r.productId}`, r._sum.qty ?? 0]))
  return consumed
    .map((c) => ({ orderLineId: c.orderLineId, productId: c.productId, qty: (c._sum.qtyBase ?? 0) - (zw.get(`${c.orderLineId}:${c.productId}`) ?? 0) }))
    .filter((x) => x.qty > 0)
    .sort((a, b) => (a.orderLineId + a.productId < b.orderLineId + b.productId ? -1 : 1))
}

/** Zlecenie korekty (PRZYJETY → KOREKTA): od tej chwili korektę wystawia kolejka wFirmy (priorytet przed odczytami). */
export async function requestCorrection(db: Db, returnId: string, ctx: Ctx = {}): Promise<void> {
  await runTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId)
    if (r.status !== 'PRZYJETY') throw new ReturnError(`Korekta tylko dla przyjętego zwrotu (jest ${r.status})`)
    if (r.lines.some((l) => !l.disposition)) throw new ReturnError('Pozycje bez oznaczenia')
    // stan Kompletora — bez korekty w programie do faktur, zwrot kończy się od razu ruchem OWN_RETURN
    if (r.invoiceDocId === null) return przyjmijNaStanInTx(tx, r, ctx.now ?? new Date(), ctx.actorId ?? 'panel')
    await tx.return.update({ where: { id: returnId }, data: { status: 'KOREKTA', correctionState: null, lastError: null } })
    await tx.orderEvent.create({ data: { orderId: r.orderId, kind: 'KOREKTA_ZLECONA', actorId: ctx.actorId ?? 'panel', data: { returnId } } })
  })
}

/** Odrzucenie albo wycofanie zwrotu przed korektą (ZGLOSZONY/PRZYJETY → ODRZUCONY). */
export async function rejectReturn(db: Db, returnId: string, ctx: Ctx & { note?: string } = {}): Promise<void> {
  await runTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId)
    if (r.status !== 'ZGLOSZONY' && r.status !== 'PRZYJETY') throw new ReturnError(`Odrzucić można zwrot przed korektą (jest ${r.status})`)
    await tx.return.update({ where: { id: returnId }, data: { status: 'ODRZUCONY', closedAt: ctx.now ?? new Date(), note: ctx.note ?? r.note } })
    await tx.orderEvent.create({ data: { orderId: r.orderId, kind: 'ZWROT_ODRZUCONY', actorId: ctx.actorId ?? 'panel', data: { returnId } } })
  })
}

/** Pieniądze oddane klientowi (uprawnienie zwroty.pieniadze; przelew robi człowiek albo bramka — rdzeń zapisuje fakt). */
export async function markReturnRefunded(db: Db, returnId: string, ctx: Ctx = {}): Promise<void> {
  await runTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId)
    if (r.status === 'ODRZUCONY') throw new ReturnError('Zwrot odrzucony')
    if (r.moneyRefundedAt) return
    await tx.return.update({ where: { id: returnId }, data: { moneyRefundedAt: ctx.now ?? new Date() } })
    await tx.orderEvent.create({ data: { orderId: r.orderId, kind: 'ZWROT_PIENIEDZY', actorId: ctx.actorId ?? 'panel', data: { returnId } } })
  })
}

/** komunikat odmowy ponowienia po niewiadomej bez ręcznego potwierdzenia. */
export const PONOWIENIE_PO_NIEWIADOMEJ = 'Poprzednia próba korekty nie dała odpowiedzi z wFirmy, a wyszukiwanie jej nie znalazło. Sprawdź w wFirmie, czy tej korekty nie ma, i potwierdź to przy ponowieniu (inaczej mogą powstać dwie korekty).'

/**
 * Po jednoznacznym błędzie korekty obsługa poprawia dane i ponawia (FAILED → do kolejki). Po
 * niewiadomej (timeout, wyszukiwanie po 3 próbach nic nie znalazło) ponowienie wymaga `potwierdzone` (osoba sprawdziła
 * wFirmę), bo nowa próba ma nowy numer `zwrot/<id>/<próba>` i przy spóźnionym wyszukiwaniu wFirmy dałaby drugą korektę.
 */
export async function retryCorrection(db: Db, returnId: string, ctx: Ctx & { potwierdzone?: boolean } = {}): Promise<void> {
  await runTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId)
    if (r.status !== 'KOREKTA' || r.correctionState !== 'FAILED') throw new ReturnError('Ponowienie tylko po błędzie korekty')
    if (r.lastError?.startsWith('timeout') && !ctx.potwierdzone) throw new ReturnError(PONOWIENIE_PO_NIEWIADOMEJ)
    await tx.return.update({ where: { id: returnId }, data: { correctionState: null, lastError: null } })
    await tx.orderEvent.create({ data: { orderId: r.orderId, kind: 'KOREKTA_PONOWIONA', actorId: ctx.actorId ?? 'panel', data: { returnId, ...(ctx.potwierdzone ? { sprawdzonoWProgramie: true } : {}) } } })
  })
}

// ─── Korekta w wFirmie (wołane z kolejki) ────────────────────────────────────

export type CorrectionOutcome = 'WYSTAWIONA' | 'JUZ_WYSTAWIONA' | 'W_TOKU' | 'BLAD' | 'TIMEOUT' | 'LIMIT' | 'NIC'

/** Kolejna próba korekty: stan SENDING zapisany przed żądaniem, żądanie poza transakcją, rozstrzygnięcie. */
export async function issueCorrection(db: Db, returnId: string, wf: KorektyWfirma, ctx: QueueCtx = {}): Promise<CorrectionOutcome> {
  const now = ctx.now ?? new Date()
  const b = await runTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId)
    if (r.status !== 'KOREKTA') return { outcome: 'NIC' as const }
    if (r.correctionState === 'ISSUED') return { outcome: 'JUZ_WYSTAWIONA' as const }
    if (r.correctionState === 'SENDING' || r.correctionState === 'UNKNOWN') return { outcome: 'W_TOKU' as const }
    if (r.correctionState === 'FAILED') return { outcome: 'NIC' as const } // czeka na obsługę (retryCorrection)
    if (r.invoiceDocId === null) return { outcome: 'NIC' as const } // zwrot przy stanie Kompletora nie idzie do wFirmy
    const attempt = r.correctionTry + 1
    await tx.return.update({ where: { id: returnId }, data: { correctionTry: attempt, correctionState: 'SENDING', findTries: 0, nextFindAt: null } }) // updatedAt z @updatedAt: sprzątacz SENDING liczy od czasu rzeczywistego
    return { outcome: 'START' as const, idExternal: `${correctionPrefix(returnId)}${attempt}`, invoiceDocId: r.invoiceDocId, lines: linieKorekty(r.lines) }
  })
  if (b.outcome !== 'START') return b.outcome
  let res: CorrectionResult
  try {
    res = await wf.issueCorrection({ idExternal: b.idExternal, invoiceDocId: b.invoiceDocId, lines: b.lines })
  } catch {
    res = { kind: 'TIMEOUT' }
  }
  const receivedAt = ctx.clock ? ctx.clock() : now
  if (res.kind === 'OK') {
    await completeCorrection(db, returnId, res.docId, res.pz, { ...ctx, now: receivedAt })
    if (res.ostrzezenie) await zapiszOstrzezenieKorekty(db, returnId, res.docId, res.ostrzezenie)
    return 'WYSTAWIONA'
  }
  if (res.kind === 'LIMIT') {
    // dokument nie powstał: z powrotem do kolejki (kolejny numer próby), bez alertu — kolejka wstrzymuje się sama
    await db.return.update({ where: { id: returnId }, data: { correctionState: null, lastError: `limit: ${res.message}`.slice(0, 1000) } })
    ctx.onLimit?.(res.retryAfterMs)
    return 'LIMIT'
  }
  if (res.kind === 'ERROR') {
    await runTx(db, async (tx) => {
      const r = await lockReturn(tx, returnId)
      await tx.return.update({ where: { id: returnId }, data: { correctionState: 'FAILED', lastError: res.message.slice(0, 1000) } })
      await alert(tx, 'KOREKTA_BLAD', r.orderId, `Błąd korekty faktury ${r.invoiceDocId}: ${res.message}`.slice(0, 1000), `korekta-blad:${b.idExternal}`)
    })
    return 'BLAD'
  }
  await db.return.update({ where: { id: returnId }, data: { correctionState: 'UNKNOWN', findTries: 0, nextFindAt: new Date(receivedAt.getTime() + FIND_SCHEDULE_MS[0]!), lastError: 'timeout' } })
  return 'TIMEOUT'
}

/** Dokument istnieje, zwrot zakończony; biuro poprawia korektę w programie. */
async function zapiszOstrzezenieKorekty(db: Db, returnId: string, docId: string, ost: OstrzezenieKorekty): Promise<void> {
  await runTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId)
    await tx.return.update({ where: { id: returnId }, data: { lastError: ost.tresc.slice(0, 1000) } })
    await alert(tx, ost.kod, r.orderId, ost.tresc.slice(0, 1000), `${ost.kod === 'KOREKTA_NIEZGODNA' ? 'korekta-niezgodna' : 'korekta-niesprawdzona'}:${docId}`)
  })
}

const linieKorekty = (lines: { productId: string; qty: number }[]) => {
  const per = new Map<string, number>()
  for (const l of lines) per.set(l.productId, (per.get(l.productId) ?? 0) + l.qty)
  return [...per].map(([productId, qty]) => ({ productId, qty }))
}

/**
 * Rozstrzyganie korekt po timeoucie (jak faktury, 3.4): `find` po `zwrot/<id>/` po 30 s, 2 min, 5 min; znaleziona →
 * zakończona, nie znaleziona po ostatniej próbie → z powrotem do kolejki z kolejnym numerem próby. SENDING starsze
 * niż 2 min (worker padł w trakcie) → UNKNOWN. Walidacja odpowiedzi `find` jak przy fakturach.
 */
export async function resolveUnknownCorrections(db: Db, wf: KorektyWfirma, ctx: QueueCtx = {}): Promise<{ found: number; requeued: number; waiting: number; errors: number; doSprawdzenia: number }> {
  const now = ctx.now ?? new Date()
  await db.return.updateMany({
    where: { status: 'KOREKTA', correctionState: 'SENDING', updatedAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
    data: { correctionState: 'UNKNOWN', nextFindAt: now, findTries: 0, lastError: 'porzucona (worker)' },
  })
  const { budget } = ctx
  const due = await db.return.findMany({ where: { status: 'KOREKTA', correctionState: 'UNKNOWN', nextFindAt: { lte: now } }, orderBy: { nextFindAt: 'asc' }, include: { lines: { select: { productId: true, qty: true } } }, ...(budget ? { take: Math.max(0, budget.left) } : {}) })
  const stats = { found: 0, requeued: 0, waiting: 0, errors: 0, doSprawdzenia: 0 }
  for (const r of due) {
    if (budget && !budget.take()) break
    const prefix = correctionPrefix(r.id)
    try {
      const found = validateFound(prefix, await wf.findCorrectionsByPrefix(prefix))
      if (found.length > 1) await alert(db, 'DUBLET_KOREKTY', r.orderId, `Więcej niż jedna korekta dla zwrotu ${r.id}: ${found.map((f) => f.docId).join(', ')} — do wyjaśnienia przez biuro`, `dublet-korekty:${r.id}`)
      if (found.length) {
        const f = found[0]!
        // kontrola przed zakończeniem (zwrot musi być jeszcze „W trakcie”); wynik nie zmienia zakończenia
        const ost = wf.sprawdzZnaleziona && r.invoiceDocId ? await wf.sprawdzZnaleziona({ idExternal: f.idExternal, invoiceDocId: r.invoiceDocId, docId: f.docId, lines: linieKorekty(r.lines) }).catch(() => null) : null
        await completeCorrection(db, r.id, f.docId, f.pz, { ...ctx, now })
        if (ost) await zapiszOstrzezenieKorekty(db, r.id, f.docId, ost)
        stats.found++
        continue
      }
      const tries = r.findTries + 1
      if (tries >= FIND_SCHEDULE_MS.length) {
        // bez samoczynnej nowej próby — wFirma mogła zapisać korektę, a wyszukiwanie jej
        // jeszcze nie widzi; nowa próba z nowym numerem dałaby drugą. Czeka na osobę („Ponów korektę” z potwierdzeniem).
        await runTx(db, async (tx) => {
          await tx.return.update({ where: { id: r.id }, data: { correctionState: 'FAILED', nextFindAt: null, lastError: 'timeout: korekty nie znaleziono po 3 próbach' } })
          await alert(tx, 'KOREKTA_NIEWIADOMA', r.orderId, `Korekta faktury ${r.invoiceDocId ?? ''} (zwrot ${r.id}): brak odpowiedzi wFirmy i wyszukiwanie jej nie znalazło. Sprawdź w wFirmie, zanim ją ponowisz.`.slice(0, 1000), `korekta-niewiadoma:${r.id}:${r.correctionTry}`)
        })
        stats.doSprawdzenia++
        continue
      }
      const base = r.nextFindAt!.getTime() - FIND_SCHEDULE_MS[r.findTries]!
      await db.return.update({ where: { id: r.id }, data: { findTries: tries, nextFindAt: new Date(base + FIND_SCHEDULE_MS[tries]!) } })
      stats.waiting++
    } catch (e) {
      if (e instanceof WfirmaLimitError) throw e
      stats.errors++
      await db.return.update({ where: { id: r.id }, data: { lastError: (e as Error).message.slice(0, 1000) } }).catch(() => {})
      if (e instanceof FindValidationError) await alert(db, 'WFIRMA_FIND_FILTR', r.orderId, e.message, `find-filtr:${prefix}`)
    }
  }
  return stats
}

/**
 * Korekta wystawiona: historia (bez ruchu dodatniego) i zlecony odczyt per produkt; „uszkodzone” i „brak” przyjęte
 * na stan wFirmy (PZ) → ruch MANUAL ujemny w tej samej transakcji; „na stan” bez pełnego PZ → lista „korekta bez PZ”.
 */
export async function completeCorrection(db: Db, returnId: string, docId: string, pz: Record<string, number | null>, ctx: Ctx = {}): Promise<void> {
  await runTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId)
    if (r.correctionState === 'ISSUED') return
    if (r.status !== 'KOREKTA') throw new ReturnError(`Korekta zwrotu ${returnId} w statusie ${r.status}`)
    await completeCorrectionInTx(tx, r, docId, pz, ctx)
  })
}

/**
 * korekta wystawiona poza Kompletorem (program do faktur bez zapisu z Kompletora, wyłączone „Wystawiaj faktury
 * z Kompletora” albo konto w trybie podglądu). Przyjęty zwrot z fakturą do korekty kończy się tak jak po korekcie
 * z kolejki, ale bez danych o PZ: pozycje „na stan” trafiają na listę „korekta bez PZ” (biuro potwierdza PZ),
 * uszkodzone wychodzą ze sprzedaży od razu. `numer` = numer korekty w programie (opcjonalny, do historii).
 */
export async function zakonczKorektePozaKompletorem(db: Db, returnId: string, ctx: Ctx & { numer?: string } = {}): Promise<void> {
  const numer = ctx.numer?.trim().slice(0, 60) || null
  await runTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId)
    if (r.status === 'ZAKONCZONY') return
    // „W trakcie” bez wysłanej korekty (czeka w kolejce albo po błędzie) też: pod blokadą zamówienia kolejka nie wyśle jej
    // równolegle (issueCorrection ustawia SENDING pod tą samą blokadą); SENDING/UNKNOWN = korekta mogła już powstać
    const czeka = r.status === 'KOREKTA' && (r.correctionState === null || r.correctionState === 'FAILED')
    if (r.status !== 'PRZYJETY' && !czeka) throw new ReturnError(r.status === 'KOREKTA' ? 'Korekta jest właśnie wysyłana do programu do faktur: poczekaj na wynik' : `Zakończenie bez korekty z Kompletora tylko dla przyjętego zwrotu (jest ${r.status})`)
    if (r.invoiceDocId === null) throw new ReturnError('Ten zwrot nie ma faktury do korekty: kończy się przy przyjęciu paczki')
    if (r.lines.some((l) => !l.disposition)) throw new ReturnError('Pozycje bez oznaczenia')
    await tx.orderEvent.create({ data: { orderId: r.orderId, kind: 'KOREKTA_POZA_KOMPLETOREM', actorId: ctx.actorId ?? 'panel', data: { returnId, numer } } })
    await completeCorrectionInTx(tx, { ...r, status: 'KOREKTA' }, numer ?? 'poza Kompletorem', {}, { ...ctx, poza: true })
  })
}

async function completeCorrectionInTx(tx: Tx, r: Return & { lines: Prisma.ReturnLineGetPayload<object>[] }, docId: string, pz: Record<string, number | null>, ctx: Ctx & { poza?: boolean }): Promise<void> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  const returnId = r.id
  {
    if (r.invoiceDocId === null) throw new ReturnError(`Zwrot ${returnId} bez faktury z rozchodem (stan Kompletora): korekta w wFirmie nie dotyczy`)
    const held = r.lines.filter((l) => l.disposition === 'USZKODZONE' || l.disposition === 'BRAK')
    const book = await StockBook.lock(tx, wh, held.map((l) => l.productId))
    const left = new Map<string, number | null>()
    for (const l of r.lines) if (!left.has(l.productId)) left.set(l.productId, pz[l.productId] ?? null)
    let withoutPz = 0
    let toRw = 0
    // częściowe PZ najpierw na towar niesprzedawalny (ruch MANUAL zdejmuje go z available), reszta na „na stan”;
    // niedobór PZ trafia wtedy na listę „korekta bez PZ”, a nie w sztuki, które wróciły na półkę tylko w wFirmie
    for (const l of [...held, ...r.lines.filter((x) => !held.includes(x))]) {
      const avail = left.get(l.productId)!
      // null = wFirma nie podała PZ: przy „na stan” → lista (sprawdź), przy niesprzedawalnych zakładamy pełne PZ (bezpiecznie: available niżej)
      const got = avail === null ? (l.disposition === 'NA_STAN' ? null : l.qty) : Math.min(l.qty, avail)
      if (avail !== null) left.set(l.productId, avail - (got ?? 0))
      await tx.returnLine.update({ where: { id: l.id }, data: { pzQty: got } })
      await tx.stockMovement.create({
        data: { productId: l.productId, warehouseId: wh, deltaPhysical: 0, source: 'OWN_CORRECTION', reason: `korekta ${docId}: +${l.qty} (${l.disposition}; stan pokaże odczyt wFirmy)`, actorId: 'system:korekty', orderId: r.orderId },
      })
      if (l.disposition === 'NA_STAN') {
        if (got === null || got < l.qty) withoutPz++
      } else if (got && got > 0) {
        book.change(l.productId, { pending: -got })
        const s = book.get(l.productId)!
        if (s.reserved > s.physical && !s.overcommitSince) book.set(l.productId, { overcommitSince: now }) // niezmiennik 5: nadmiar rozstrzyga człowiek (4.4)
        await tx.pendingMovement.create({
          data: {
            productId: l.productId,
            warehouseId: wh,
            delta: -got,
            type: l.disposition === 'USZKODZONE' ? 'DAMAGED_RETURN' : 'STOCK_MISSING',
            state: 'MANUAL',
            sentAt: now,
            effectiveAt: now,
            wzQty: 0,
            wfirmaDocId: docId,
            orderId: r.orderId,
            idempotencyKey: `zwrot:${r.id}:${l.id}`,
          },
        })
        toRw++
      }
      await outbox(tx, 'WFIRMA_READ', l.productId, now)
    }
    await tx.return.update({ where: { id: returnId }, data: { status: 'ZAKONCZONY', correctionState: ctx.poza ? null : 'ISSUED', correctionDocId: ctx.poza ? null : docId, nextFindAt: null, closedAt: now, lastError: null } })
    const o = await tx.order.findUniqueOrThrow({ where: { id: r.orderId } })
    await tx.order.update({ where: { id: o.id }, data: { flags: mergeFlags(o, { doKorekty: false }) } })
    await tx.orderEvent.create({ data: { orderId: r.orderId, kind: 'KOREKTA', actorId: ctx.poza ? (ctx.actorId ?? 'panel') : 'system:korekty', data: { returnId, docId, bezPz: withoutPz, doRw: toRw, ...(ctx.poza ? { pozaKompletorem: true } : {}) } } })
    if (withoutPz) await alert(tx, 'KOREKTA_BEZ_PZ', r.orderId, `Korekta ${docId}: ${withoutPz} pozycji „na stan” bez PZ — wystaw PZ w wFirmie i kliknij „PZ wystawione”`, `korekta-bez-pz:${docId}`)
    if (toRw) await alert(tx, 'USZKODZONE_DO_RW', r.orderId, `Korekta ${docId}: ${toRw} pozycji uszkodzonych albo brakujących wróciło na stan wFirmy — RW w wFirmie, potem kliknij „Poprawione w wFirmie” (Braki towaru → Do poprawy w wFirmie)`, `do-rw:${docId}`)
    await book.flush(tx, now)
  }
}

// ─── Listy dla biura ─────────────────────────────────────────────────────────

/** Lista „korekta bez PZ” (3.5 v1.5): pozycje „na stan” zakończonych korekt bez pełnego PZ, niepotwierdzone przez biuro. */
export async function listCorrectionsWithoutPz(db: Db) {
  const rows = await db.returnLine.findMany({
    where: { disposition: 'NA_STAN', pzConfirmedAt: null, ret: { status: 'ZAKONCZONY' } },
    include: { ret: { select: { orderId: true, correctionDocId: true } } },
    orderBy: { id: 'asc' },
  })
  return rows.filter((l) => l.pzQty === null || l.pzQty < l.qty)
}

/** Biuro: „PZ wystawione” — pozycja schodzi z listy, zlecony odczyt pokaże wzrost (bez ruchu dodatniego). */
export async function confirmPz(db: Db, returnLineId: string, ctx: Ctx = {}): Promise<void> {
  const now = ctx.now ?? new Date()
  await runTx(db, async (tx) => {
    const l = await tx.returnLine.findUniqueOrThrow({ where: { id: returnLineId } })
    if (l.pzConfirmedAt) return
    await tx.returnLine.update({ where: { id: l.id }, data: { pzConfirmedAt: now } })
    await outbox(tx, 'WFIRMA_READ', l.productId, now)
    await tx.auditLog.create({ data: { entity: 'ReturnLine', entityId: l.id, actorId: ctx.actorId ?? 'panel', before: { pzQty: l.pzQty }, after: { pzConfirmedAt: now.toISOString() } } })
  })
}

/** Lista „uszkodzone do RW” (3.6 v1.5): ruchy MANUAL pomniejszające available do RW w wFirmie i „poprawione”. */
export async function listDamagedForRw(db: Db) {
  return db.pendingMovement.findMany({ where: { type: { in: ['DAMAGED_RETURN'] }, state: 'MANUAL' }, orderBy: { sentAt: 'asc' } })
}
