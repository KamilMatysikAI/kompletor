// Dzienny raport rozjazdów cienia (krok 2, spec 9.2 pkt 1–5): raz dziennie za dzień poprzedni, same liczby
// i lista do wyjaśnienia (numery zamówień, SKU) — bez danych klientów. Zapis w ShadowDailyCheck (`raport-rozjazdow`,
// ekran /rozjazdy) i jako plik markdown (worker, RAPORTY_DIR). Sekcje:
//   1. zamówienia i statusy — ostatnie porównanie z BL (`cien-bl`, bl-porownanie.ts) + sprzedaż dnia (sprzedaz-dnia.ts);
//   2. stany — `available`/fizyczny u nas vs stan BL `accounting_1` (kopia z importu katalogu) vs stan widziany
//      w kanale (`ChannelOffer.lastSeenQty`, gdy adapter go czyta);
//   3. „uratowane sprzedaże” — oferty, które my wystawilibyśmy (ostatni „wysłałbym” > 0), a BL ma stan 0
//      (definicja robocza do potwierdzenia ze spec 9.2 pkt 3);
//   4. ruchy niepotwierdzone > 24 h (zaległość systemu: IN_FLIGHT, APPLIED) i nadmiary rezerwacji > 30 min;
//   5. naruszenia niezmienników 5.4;
//   „Dla biura”: ruchy MANUAL > 24 h i zamówienia „Do wyjaśnienia” — lista pracy biura, NIE zeruje `ok`.
// Kryterium `ok` (ustalenie z 03.11.2026, docs/seria-f3.md): sprzedaż dnia zgodna, zero zaległych ruchów
// systemu, nadmiarów, naruszeń i rozjazdów stanu liczonych do `ok` (`stocks.physicalVsBlForOk`, tolerancja niżej).
import type { Channel, Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { checkInvariants } from '../rdzen/niezmienniki'
import { alert } from '../rdzen/stan'
import { type IsoDay } from '../rdzen/kalendarz'
import { ROZLICZENIE_PO_FAKTURZE_BL } from '../rdzen/faktura-bl'
import { flagsOf } from '../rdzen/rezerwacja'
import type { AccountComparison } from './bl-porownanie'
import { FAKTURY_BL_NUMERY_SKLEPU } from './faktury-bl'
import { cleanDayStreaks, type DaySalesResult, SALES_CHECK, salesCountBreakdown, warsawDay } from './sprzedaz-dnia'

export const REPORT_CHECK = 'raport-rozjazdow'
const MAX_LISTED = 50

export interface StockDiff {
  sku: string
  physical: number
  available: number
  bl: number
  unit: 'SZT' | 'KG'
  /** rozjazd tolerowany — przesunięcie w czasie między odczytem BL a wFirmy (ruch „w drodze”); nie zeruje `ok`. */
  inTransit?: boolean
  /** rozjazd wyjaśniony ruchem MANUAL (pozycja biura, „Dla biura”); nie zeruje `ok`. */
  office?: boolean
  /** dokumenty WZ z wFirmy w oknie między odczytami, które wyjaśniają różnicę (ruch z dokumentem, nie „bez przyczyny”). */
  wzDocs?: string[]
  /** produkt bez odczytu lustra wFirmy — rozjazd liczy się do `ok` nawet z ruchem w drodze. */
  noMirrorRead?: boolean
}

/** Pozycje pracy biura: nie zerują `ok` ani serii F3. Pola opcjonalne — raporty sprzed nich ich nie mają. */
export interface OfficeItems {
  /** ruchy MANUAL > 24 h + zamówienia „Do wyjaśnienia” */
  count: number
  /** ISSUED_WITHOUT_DOCUMENT/MANUAL > 24 h — wysłane bez faktury */
  shippedWithoutInvoice: number
  /** BL_INVOICE/MANUAL > 24 h — faktura bez WZ albo z niepełnym WZ */
  invoiceWithoutWz: number
  /** inne ruchy MANUAL > 24 h (np. faktura Kompletora bez WZ, gdy zapis w wFirmie ruszy) */
  otherManual: number
  /** zamówienia „Do wyjaśnienia” (= `toClarify.count`) */
  toClarify: number
  /** pozycje powstałe w dniu raportu (ruchy MANUAL i zamówienia „Do wyjaśnienia” założone tego dnia) — czy lista rośnie */
  newSinceYesterday: number
  /** numery zamówień BL (albo kanał:numer) i SKU pozycji — bez danych klientów, najwyżej MAX_LISTED */
  orders: string[]
  skus: string[]
}

export interface DailyReport {
  day: IsoDay
  generatedAt: string
  sales: DaySalesResult | null
  /** Dni zamknięte z rzędu bez rozjazdu sprzedaży (klucz „kanał|konto”, `*` = cała firma). */
  streaks: Record<string, number>
  orders: { comparedAt: string | null; blComplete: boolean | null; accounts: Pick<AccountComparison, 'channel' | 'channelAccountId' | 'name' | 'inChannel' | 'inBl' | 'paired' | 'missingInBl' | 'missingHere' | 'verdicts' | 'divergences' | 'activeReservationsBlAhead'>[] }
  /** `digitalOnly` (faktury zamówień z samymi e-bookami, BEZ_STANU) i `nothingToConsume` (anulowane, pominięte) od
   *  w raportach sprzed nich brak. */
  invoices: { pending: number; waitingForWz: number; withoutWz: number; digitalOnly?: number; nothingToConsume?: number; shippedWithoutInvoice: number }
  /** Pole nowsze, w starszych raportach go brak: faktury BL bez naszego zamówienia (czekają na numer ze sklepu
   *  albo na odczyt zamówień) i wiek najstarszej w godzinach, zamówienia rozliczone samonaprawą po fakturze BL w tym
   *  dniu, otwarty alert „sklep nie podaje numerów” (liczby odczytów i błędów są w jego treści). */
  blInvoiceRepair?: { withoutPair: number; oldestWithoutPairHours: number | null; healedOrders: number; numbersAlertOpen: boolean }
  /** `blUnreadable` (stan BL w sztukach z częścią ułamkową — nieczytelny, nie porównywany). */
  /** `physicalVsBlForOk` (rozjazdy liczone do `ok`), `inTransit`, `office`, `blConflicting*`
   *  (rekordy BL jednego towaru wFirmy z różnym stanem), `blMultiGood*` (produkt z kilkoma różnymi towarami wFirmy w BL),
   *  `blStaleRecords` (rekordy BL nieobecne w ostatnim imporcie, pominięte), `mirrorLastFullReadAt`. */
  stocks: {
    products: number
    blSnapshotAt: string | null
    physicalVsBl: number
    physicalVsBlList: StockDiff[]
    physicalVsBlForOk?: number
    inTransit?: number
    office?: number
    blUnreadable?: number
    blUnreadableList?: { sku: string; bl: number }[]
    blConflicting?: number
    blConflictingList?: { sku: string; blSkus: string[]; values: number[] }[]
    blMultiGood?: number
    blMultiGoodList?: string[]
    blStaleRecords?: number
    mirrorLastFullReadAt?: string | null
    /** ostatni pełny odczyt lustra starszy niż kopia BL — stany porównane z dwóch różnych chwil (ostrzeżenie). */
    mirrorBeforeBl?: boolean
    offersWithChannelRead: number
    channelVsTarget: number
    channelVsTargetList: { sku: string; account: string; target: number; channel: number }[]
  }
  /** `savedSkippedBundles`: oferty produktów innych niż STOCKED (zestaw, cyfrowy) pominięte w „uratowanych”. */
  saved: { offers: number; list: { sku: string; account: string; target: number }[]; savedSkippedBundles?: number }
  /** Zaległość systemu: ruchy IN_FLIGHT i APPLIED > 24 h (bez MANUAL — te są w `officeItems`). */
  stalePending: { count: number; byKind: Record<string, number> }
  /** `noExcess*`: znacznik nadmiaru bez rezerwacji ponad stan liczony od zera — w praktyce ujemny fizyczny
   *  z ruchów MANUAL przy rezerwacjach 0. Nie nadmiar, nie zeruje `ok`. */
  overcommit: { count: number; skus: string[]; noExcess?: number; noExcessSkus?: string[] }
  invariants: { count: number; byRule: Record<string, number> }
  toClarify: { count: number; byReason: Record<string, number> }
  /** Lista pracy biura — nie wchodzi do `ok`. */
  officeItems?: OfficeItems
  /** Sprzedaż dnia zgodna, zero zaległych ruchów systemu, nadmiarów, naruszeń i rozjazdów stanu liczonych do `ok`. */
  ok: boolean
}

const inc = (m: Record<string, number>, k: string, n = 1) => (m[k] = (m[k] ?? 0) + n)

/**
 * Stan fizyczny u nas (jednostka bazowa: szt. albo g) kontra stan BL `accounting_1` (jednostka wFirmy: szt. albo kg).
 * BL trzyma kg ucięte; sztuki z częścią ułamkową to stan nieczytelny — osobna pozycja raportu,
 * nie zaokrąglenie, które ukryłoby różnicę < 0,5.
 */
export function compareStock(physical: number, bl: number, unit: 'SZT' | 'KG'): 'ZGODNY' | 'ROZJAZD' | 'NIECZYTELNY' {
  if (unit === 'SZT' && bl !== Math.trunc(bl)) return 'NIECZYTELNY'
  const ours = unit === 'KG' ? Math.floor(physical / 1000) : physical
  const theirs = unit === 'KG' ? Math.floor(bl) : bl
  return ours === theirs ? 'ZGODNY' : 'ROZJAZD'
}

/** Raport za dzień `day` (zwykle wczorajszy) z bieżącego stanu bazy. Tylko odczyt. */
export async function buildDailyReport(db: PrismaClient, day: IsoDay, now = new Date()): Promise<DailyReport> {
  organizationIdOf(db) // tylko klient firmy (RLS)
  const { to: dayEnd } = warsawDay(day)
  const salesRow = await db.shadowDailyCheck.findFirst({ where: { kind: SALES_CHECK, day } })
  const streaks = await cleanDayStreaks(db, day)

  // 1. zamówienia i statusy: ostatnie porównanie z BL z tego dnia (albo najświeższe przed jego końcem)
  const cmp = await db.importRun.findFirst({ where: { kind: 'cien-bl', status: { in: ['OK', 'PARTIAL'] }, startedAt: { lte: new Date(dayEnd.getTime() + 3600_000) } }, orderBy: { startedAt: 'desc' } })
  const cmpStats = (cmp?.stats ?? null) as { blComplete?: boolean; accounts?: AccountComparison[] } | null
  const orders: DailyReport['orders'] = {
    comparedAt: cmp?.finishedAt?.toISOString() ?? null,
    blComplete: cmpStats?.blComplete ?? null,
    accounts: (cmpStats?.accounts ?? [])
      .filter((a) => a.polled)
      .map((a) => ({ channel: a.channel, channelAccountId: a.channelAccountId, name: a.name, inChannel: a.inChannel, inBl: a.inBl, paired: a.paired, missingInBl: a.missingInBl, missingHere: a.missingHere, verdicts: a.verdicts, divergences: a.divergences, activeReservationsBlAhead: a.activeReservationsBlAhead })),
  }

  const [pendingInv, withoutWz, digitalOnly, nothingToConsume, shippedNoInv] = await Promise.all([
    db.blInvoiceSnapshot.findMany({ where: { appliedAt: null }, select: { attempts: true } }),
    db.blInvoiceSnapshot.count({ where: { outcome: 'BEZ_WZ' } }),
    db.blInvoiceSnapshot.count({ where: { outcome: 'BEZ_STANU' } }),
    db.blInvoiceSnapshot.count({ where: { outcome: 'NIC_DO_ROZLICZENIA' } }),
    db.pendingMovement.count({ where: { type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL', idempotencyKey: { startsWith: 'bl-bez-faktury:' } } }),
  ])

  // 2. stany: stan BL produktu = jedna wartość na towar wFirmy, bez rekordów BL skasowanych
  const stocks = await db.stock.findMany({ select: { productId: true, physical: true, reserved: true, wfirmaReadAt: true, overcommitSince: true, product: { select: { sku: true, unit: true, active: true, kind: true } } } })
  const blv = await blStockByProduct(db)
  const blOf = blv.byProduct
  const blAt = blv.at
  const queue = await db.wfirmaQueueState.findFirst({ select: { lastFullReadAt: true } })
  const lastFullReadAt = queue?.lastFullReadAt ?? null
  const diffs: StockDiff[] = []
  const unreadable: { sku: string; bl: number }[] = []
  for (const s of stocks) {
    const b = blOf.get(s.productId)
    if (b === undefined || !s.product.active || s.product.kind !== 'STOCKED') continue
    const v = compareStock(s.physical, b.value, s.product.unit)
    if (v === 'NIECZYTELNY') unreadable.push({ sku: s.product.sku, bl: b.value })
    if (v === 'ROZJAZD') diffs.push({ sku: s.product.sku, physical: s.physical, available: Math.max(0, s.physical - s.reserved), bl: b.value, unit: s.product.unit })
  }
  await classifyStockDiffs(db, diffs, stocks, blOf, lastFullReadAt)
  const diffsForOk = diffs.filter((d) => !d.inTransit && !d.office)
  const offers = await db.channelOffer.findMany({ where: { active: true }, select: { id: true, channel: true, channelAccountId: true, lastSeenQty: true, product: { select: { id: true, sku: true, kind: true } } } })
  // ostatni „wysłałbym” oferty do końca dnia (tydzień wstecz wystarcza: pełna synchronizacja wysyła każdą ofertę)
  const pushes = await db.channelPushLog.findMany({
    where: { mode: 'CIEN', createdAt: { lt: dayEnd, gte: new Date(dayEnd.getTime() - 7 * 24 * 3600_000) }, offerId: { in: offers.map((o) => o.id) } },
    orderBy: { createdAt: 'desc' },
    select: { offerId: true, targetQty: true },
  })
  const lastTarget = new Map<string, number>()
  for (const p of pushes) if (!lastTarget.has(p.offerId)) lastTarget.set(p.offerId, p.targetQty)
  const channelDiffs: DailyReport['stocks']['channelVsTargetList'] = []
  const saved: DailyReport['saved']['list'] = []
  let savedSkippedBundles = 0
  let withRead = 0
  for (const o of offers) {
    const target = lastTarget.get(o.id)
    const account = `${o.channel}/${o.channelAccountId}`
    if (o.lastSeenQty !== null) {
      withRead++
      if (target !== undefined && target !== o.lastSeenQty) channelDiffs.push({ sku: o.product.sku, account, target, channel: o.lastSeenQty })
    }
    if (target !== undefined && target > 0 && (blOf.get(o.product.id)?.value ?? 1) <= 0) {
      // `accounting_1` zestawu w BL zwykle 0 (zestaw nie ma stanu w wFirmie) — porównanie z celem zestawu
      // dawałoby fałszywe „uratowane”; liczone tylko produkty STOCKED, reszta osobno
      if (o.product.kind !== 'STOCKED') savedSkippedBundles++
      else saved.push({ sku: o.product.sku, account, target })
    }
  }

  // 4. zaległość systemu: ruchy IN_FLIGHT/APPLIED > 24 h (wchodzą do `ok`); nadmiar > 30 min
  const dayAgo = new Date(now.getTime() - 24 * 3600_000)
  const moves = await db.pendingMovement.findMany({ where: { state: { in: ['IN_FLIGHT', 'APPLIED'] }, sentAt: { lt: dayAgo } }, select: { type: true, state: true } })
  const byKind: Record<string, number> = {}
  for (const m of moves) inc(byKind, `${m.type}/${m.state}`)
  const overdue = stocks.filter((s) => s.overcommitSince && s.overcommitSince.getTime() < now.getTime() - 30 * 60_000)
  // ujemny fizyczny z ruchów MANUAL (wydane bez faktury przy stanie wFirmy 0) daje `reserved 0 > physical -1`
  // i lustro stawia `overcommitSince` (niezmiennik 5), ale żadne zamówienie nie ma rezerwacji ponad stan — to pozycja
  // „Dla biura” (ruch biura), nie nadmiar. Nadmiar do `ok` tylko, gdy rezerwacje przekraczają stan liczony od zera.
  const over = overdue.filter((s) => s.reserved > Math.max(0, s.physical))
  const noExcess = overdue.filter((s) => s.reserved <= Math.max(0, s.physical))

  // 5. niezmienniki
  const violations = await checkInvariants(db)
  const byRule: Record<string, number> = {}
  for (const v of violations) inc(byRule, v.rule)

  // do wyjaśnienia: zamówienia z kanałów czytanych w cieniu (powód z flag, bez danych klienta)
  const clarify = await db.order.findMany({ where: { status: 'DO_WYJASNIENIA', channel: { in: shadowChannels(orders.accounts) } }, select: { flags: true, channel: true, externalId: true, blOrderId: true, createdAt: true } })
  const byReason: Record<string, number> = {}
  for (const o of clarify) for (const r of (flagsOf(o).doWyjasnienia ?? 'bez powodu').split('; ')) inc(byReason, r.replace(/: .*$/, ''))
  const officeItems = await buildOfficeItems(db, day, dayAgo, clarify)
  // liczby faktur BL to dodatek; błąd ich odczytu nie zabiera całego raportu (pole puste, błąd w logu)
  let blInvoiceRepair: DailyReport['blInvoiceRepair']
  try {
    blInvoiceRepair = await buildBlInvoiceRepair(db, day, now)
  } catch (e) {
    console.error(`[raport-dzienny] liczby faktur BL ${day}: ${e instanceof Error ? e.message : String(e)}`)
  }

  const sales = (salesRow?.stats ?? null) as DaySalesResult | null
  const report: DailyReport = {
    day,
    generatedAt: now.toISOString(),
    sales,
    streaks,
    orders,
    invoices: { pending: pendingInv.length, waitingForWz: pendingInv.filter((p) => p.attempts > 0).length, withoutWz, digitalOnly, nothingToConsume, shippedWithoutInvoice: shippedNoInv },
    blInvoiceRepair,
    stocks: {
      products: stocks.filter((s) => blOf.has(s.productId) && s.product.kind === 'STOCKED').length,
      blSnapshotAt: blAt?.toISOString() ?? null,
      physicalVsBl: diffs.length,
      // najpierw rozjazdy liczone do `ok`, potem tolerowane — lista ucięta do MAX_LISTED nie chowa tych ważnych
      physicalVsBlList: [...diffsForOk, ...diffs.filter((d) => d.inTransit || d.office)].slice(0, MAX_LISTED),
      physicalVsBlForOk: diffsForOk.length,
      inTransit: diffs.filter((d) => d.inTransit).length,
      office: diffs.filter((d) => d.office && !d.inTransit).length,
      blUnreadable: unreadable.length,
      blUnreadableList: unreadable.slice(0, MAX_LISTED),
      blConflicting: blv.conflicting.length,
      blConflictingList: blv.conflicting.slice(0, MAX_LISTED),
      blMultiGood: blv.multiGood.length,
      blMultiGoodList: blv.multiGood.slice(0, MAX_LISTED),
      blStaleRecords: blv.staleRecords,
      mirrorLastFullReadAt: lastFullReadAt?.toISOString() ?? null,
      mirrorBeforeBl: !!lastFullReadAt && !!blAt && lastFullReadAt < blAt,
      offersWithChannelRead: withRead,
      channelVsTarget: channelDiffs.length,
      channelVsTargetList: channelDiffs.slice(0, MAX_LISTED),
    },
    saved: { offers: saved.length, list: saved.slice(0, MAX_LISTED), savedSkippedBundles },
    stalePending: { count: moves.length, byKind },
    overcommit: { count: over.length, skus: over.map((s) => s.product.sku).slice(0, MAX_LISTED), noExcess: noExcess.length, noExcessSkus: noExcess.map((s) => s.product.sku).slice(0, MAX_LISTED) },
    invariants: { count: violations.length, byRule },
    toClarify: { count: clarify.length, byReason },
    officeItems,
    // (ustalenie z 03.11.2026): `officeItems` NIE wchodzi do `ok`
    ok: !!salesRow?.ok && moves.length === 0 && over.length === 0 && violations.length === 0 && diffsForOk.length === 0,
  }
  return report
}

/**
 * Najmniejsza możliwa różnica stanu w jednostce `Stock.physical` (szt. albo g). Dla kg BL trzyma kilogramy ucięte
 * (`compareStock`), więc `bl = 3` znaczy, że wFirma miała 3000–3999 g: różnica to odległość od tego przedziału
 * (pełne kg dawały 1000 g przy realnej różnicy 1 g i fałszywy czerwony przy sprzedaży
 * na wagę przez granicę kilograma).
 */
export function stockGap(physical: number, bl: number, unit: 'SZT' | 'KG'): number {
  if (unit !== 'KG') return Math.abs(physical - bl)
  const lo = Math.floor(bl) * 1000
  const hi = lo + 999
  return physical < lo ? lo - physical : physical > hi ? physical - hi : 0
}

/**
 * Lustro wFirmy uznaje produkt za „odczytany”, gdy jego `wfirmaReadAt` nie jest starszy od ostatniego pełnego odczytu
 * o więcej niż tyle. Pełny odczyt idzie co noc (`rdzen-noc`) i trwa minuty (strony po 100 w budżecie
 * kolejki), więc produkt starszy o ponad dobę z zapasem nie wrócił w ostatnim pełnym odczycie (towar skasowany albo
 * przeniesiony w wFirmie, złe powiązanie) albo nigdy nie był czytany przez lustro (stan z importu). Początek pełnego
 * odczytu nie jest zapisywany (`fullReadSentAt` zeruje się na końcu), stąd przybliżenie od `lastFullReadAt`.
 */
export const MIRROR_READ_MAX_AGE_MS = 26 * 3600_000

/**
 * Tolerancja rozjazdu stanu w `ok`. Ilościowo 0 szt. (SZT) i pełne kg w dół jak BL (KG, `compareStock`) —
 * BL kopiuje `accounting_1` z wFirmy bez przeliczeń, więc każda różnica jest prawdziwa albo wynika z czasu. Rozjazd NIE
 * liczy się do `ok` (zostaje na liście z oznaczeniem), gdy:
 *   - „w drodze”: różnica (`stockGap`: szt., dla kg odległość w g od przedziału, który BL ucięty reprezentuje;
 *     przy ruchach MANUAL mniejsza z różnic ze stanem z nimi i bez nich) mieści się w sumie |delta| ruchów, które mogły ją spowodować:
 *     niepotwierdzonych IN_FLIGHT/APPLIED (BL może już widzieć WZ, a lustro jeszcze nie) i ruchów (nowy
 *     PendingMovement poza MANUAL i CANCELLED, StockMovement WFIRMA_SYNC) między starszym a nowszym z (`BlProduct.importedAt`,
 *     `Stock.wfirmaReadAt`) — dwa odczyty z różnych chwil. Sam fakt ruchu nie wystarcza (przy
 *     codziennej sprzedaży okno prawie zawsze ma ruch). `sentAt` to nasz zegar, `StockMovement.createdAt` zegar bazy:
 *     kilka sekund różnicy może przesunąć ruch na granicy okna, bound ilościowy ogranicza skutek;
 *   - „biuro”: różnicę w całości wyjaśniają ruchy MANUAL (wydane bez faktury, faktura bez pełnego WZ): stan bez nich
 *     równa się BL. To pozycje „Dla biura”, które serii nie zerują.
 * Produkt bez odczytu lustra (`noMirrorRead`: brak pełnego odczytu w firmie albo `wfirmaReadAt` starszy niż
 * MIRROR_READ_MAX_AGE_MS przed ostatnim) nie dostaje żadnej tolerancji — liczy się do `ok` (bez lustra nasz stan to
 * import plus nasza sprzedaż, a nie wFirma).
 */
async function classifyStockDiffs(
  db: PrismaClient,
  diffs: StockDiff[],
  stocks: { productId: string; physical: number; wfirmaReadAt: Date; product: { sku: string; unit: 'SZT' | 'KG' } }[],
  blOf: Map<string, BlStock>,
  lastFullReadAt: Date | null,
): Promise<void> {
  if (!diffs.length) return
  const bySku = new Map(stocks.map((s) => [s.product.sku, s]))
  const ids = diffs.map((d) => bySku.get(d.sku)!.productId)
  const pending = await db.pendingMovement.findMany({ where: { productId: { in: ids }, state: { in: ['IN_FLIGHT', 'APPLIED', 'MANUAL'] } }, select: { id: true, productId: true, state: true, delta: true } })
  // okno między odczytami: od starszego do nowszego z (import BL, odczyt wFirmy), osobno na produkt
  const windows = new Map<string, { from: Date; to: Date }>()
  for (const id of ids) {
    const s = stocks.find((x) => x.productId === id)!
    const blAt = blOf.get(id)!.at
    const [from, to] = blAt < s.wfirmaReadAt ? [blAt, s.wfirmaReadAt] : [s.wfirmaReadAt, blAt]
    windows.set(id, { from, to })
  }
  const minFrom = new Date(Math.min(...[...windows.values()].map((w) => w.from.getTime())))
  const [newPending, syncs] = await Promise.all([
    // `sentAt` = nasz zegar przy powstaniu ruchu (jak w lustrze i kolejce; `createdAt` to zegar bazy). CONFIRMED
    // w oknie liczy się celowo: starszy odczyt BL go nie widział, nowszy nasz już tak. CANCELLED nie: nieudana
    // faktura cofa ruch, więc nie dotknął ani wFirmy, ani naszego stanu. MANUAL osobno („biuro”).
    db.pendingMovement.findMany({ where: { productId: { in: ids }, sentAt: { gt: minFrom }, state: { notIn: ['MANUAL', 'CANCELLED'] } }, select: { id: true, productId: true, state: true, sentAt: true, delta: true } }),
    db.stockMovement.findMany({ where: { productId: { in: ids }, source: 'WFIRMA_SYNC', createdAt: { gt: minFrom } }, select: { productId: true, createdAt: true, deltaPhysical: true } }),
  ])
  // WZ z wFirmy założone między odczytami (BL widział spadek, lustro jeszcze nie, albo odwrotnie) — ilość WZ
  // wyjaśnia różnicę jak ruch „w drodze”. WZ, którego dokument ma już nasz ruch (ten sam numer), nie liczy się drugi raz.
  const wzInWindow = await wzQtyInWindow(db, ids, minFrom)
  const inWindow = (id: string, at: Date) => {
    const w = windows.get(id)!
    return at > w.from && at <= w.to
  }
  for (const d of diffs) {
    const s = bySku.get(d.sku)!
    const id = s.productId
    d.noMirrorRead = !lastFullReadAt || s.wfirmaReadAt.getTime() < lastFullReadAt.getTime() - MIRROR_READ_MAX_AGE_MS
    // tolerancja ILOŚCIOWA — różnica musi mieścić się w sumie |delta| ruchów, które mogły ją
    // spowodować. Sam fakt ruchu nie wystarcza: przy codziennej sprzedaży okno prawie zawsze ma jakiś ruch, a realny
    // rozjazd (u nas 10, BL 50) byłby tolerowany na stałe. MANUAL liczy osobno „biuro” niżej.
    const counted = new Set<string>()
    let explain = 0
    for (const m of pending) {
      if (m.productId !== id || m.state === 'MANUAL') continue
      counted.add(m.id)
      explain += Math.abs(m.delta)
    }
    for (const m of newPending) {
      if (m.productId !== id || m.state === 'MANUAL' || counted.has(m.id) || !inWindow(id, m.sentAt)) continue
      counted.add(m.id)
      explain += Math.abs(m.delta)
    }
    for (const m of syncs) if (m.productId === id && inWindow(id, m.createdAt)) explain += Math.abs(m.deltaPhysical)
    const docs: string[] = []
    for (const w of wzInWindow) {
      if (w.productId !== id || !inWindow(id, w.at)) continue
      explain += w.qty
      docs.push(w.number)
    }
    if (docs.length) d.wzDocs = docs
    const manual = pending.filter((m) => m.productId === id && m.state === 'MANUAL').reduce((a, m) => a + m.delta, 0)
    // ruch biura i sprzedaż w oknie składają się — bound liczony także od stanu bez MANUAL
    const gap = Math.min(stockGap(s.physical, d.bl, d.unit), manual !== 0 ? stockGap(s.physical - manual, d.bl, d.unit) : Infinity)
    if (explain > 0 && gap <= explain && !d.noMirrorRead) d.inTransit = true
    if (manual !== 0 && !d.noMirrorRead && compareStock(s.physical - manual, d.bl, d.unit) === 'ZGODNY') d.office = true
  }
}

/** pozycje WZ z kopii (`WfirmaWzSnapshot`) od `from`, na produkty z listy, w jednostce bazowej. */
async function wzQtyInWindow(db: PrismaClient, productIds: string[], from: Date): Promise<{ productId: string; qty: number; at: Date; number: string; invoiceNumber: string | null }[]> {
  const docs = await db.wfirmaWzSnapshot.findMany({ where: { createdInWfirma: { gt: from } }, select: { number: true, invoiceNumber: true, createdInWfirma: true, lines: true } })
  if (!docs.length) return []
  const products = await db.product.findMany({ where: { id: { in: productIds }, wfirmaGoodId: { not: null } }, select: { id: true, wfirmaGoodId: true, unit: true } })
  const byGood = new Map(products.map((p) => [p.wfirmaGoodId!, p]))
  // ilość, którą nasz ruch z tym numerem dokumentu (faktura rozliczona w rdzeniu, dowolny stan poza CANCELLED) już
  // zawiera, nie wyjaśnia różnicy drugi raz; reszta pozycji WZ (np. część wydana z braku bez ruchu) tak
  const refs = [...new Set(docs.flatMap((d) => [d.number, ...(d.invoiceNumber ? [d.invoiceNumber] : [])]))]
  const own = new Map<string, number>()
  for (const m of await db.pendingMovement.findMany({ where: { productId: { in: productIds }, wfirmaDocId: { in: refs }, state: { not: 'CANCELLED' } }, select: { productId: true, wfirmaDocId: true, delta: true } })) {
    const k = `${m.productId}|${m.wfirmaDocId}`
    own.set(k, (own.get(k) ?? 0) + Math.abs(m.delta))
  }
  const out: { productId: string; qty: number; at: Date; number: string; invoiceNumber: string | null }[] = []
  for (const d of docs) {
    const lines = Array.isArray(d.lines) ? (d.lines as { wfirmaGoodId?: unknown; count?: unknown }[]) : []
    // suma pozycji WZ per produkt (towar w kilku pozycjach), potem minus to, co ma już nasz ruch z tym numerem
    const per = new Map<string, number>()
    for (const l of lines) {
      const p = byGood.get(String(l.wfirmaGoodId))
      const c = typeof l.count === 'number' ? l.count : Number(l.count)
      if (!p || !Number.isFinite(c)) continue
      per.set(p.id, (per.get(p.id) ?? 0) + Math.round(p.unit === 'KG' ? c * 1000 : c))
    }
    for (const [productId, qty] of per) {
      const covered = (own.get(`${productId}|${d.number}`) ?? 0) + (d.invoiceNumber && d.invoiceNumber !== d.number ? (own.get(`${productId}|${d.invoiceNumber}`) ?? 0) : 0)
      const left = qty - covered
      if (left > 0) out.push({ productId, qty: left, at: d.createdInWfirma, number: d.number, invoiceNumber: d.invoiceNumber })
    }
  }
  return out
}

interface BlStock {
  value: number
  /** najnowszy `importedAt` z rekordów BL wziętych pod uwagę */
  at: Date
}

/**
 * Stan BL (`accounting_1`) produktu. Kilka rekordów `BlProduct` (warianty, duble ofert) wskazuje ten sam
 * towar wFirmy i niesie ten sam stan, więc sumowanie dawało wielokrotność. Zasady:
 *   - rekordy nieobecne w ostatnim udanym imporcie katalogu (skasowane w BL; upsert importu ich nie czyści) pomijane:
 *     `importRunId` ≠ id ostatniego `ImportRun` `katalog-bl-wfirma` w stanie OK/PARTIAL ani nowszego przebiegu RUNNING
 *     (import trwający w chwili raportu stempluje rekordy na bieżąco; bez tego świeże rekordy wypadałyby jako stare). Gdy żaden rekord nie pochodzi
 *     z tych przebiegów (np. baza sprzed importów z `importRunId`), bez filtra — lepiej pokazać za dużo niż ukryć stan;
 *   - w produkcie grupa na towar wFirmy (`wfirmaGoodIdLink ?? id` rekordu): jedna wartość; gdy rekordy grupy się
 *     różnią, maksimum + pozycja w `conflicting` (osobny sygnał dla biura);
 *   - kilka różnych towarów wFirmy pod jednym produktem: gdy któryś to towar produktu (`Product.wfirmaGoodId`), tylko
 *     on (pozostałe rekordy BL pokazują stan innego towaru); inaczej suma po towarach. W obu przypadkach produkt trafia
 *     do `multiGood` (do sprawdzenia powiązań w BL).
 */
export async function blStockByProduct(db: PrismaClient): Promise<{
  byProduct: Map<string, BlStock>
  at: Date | null
  conflicting: { sku: string; blSkus: string[]; values: number[] }[]
  multiGood: string[]
  staleRecords: number
}> {
  const rows = await db.blProduct.findMany({
    where: { productId: { not: null }, stockAccounting: { not: null } },
    select: { id: true, sku: true, productId: true, stockAccounting: true, importedAt: true, importRunId: true, wfirmaGoodIdLink: true, product: { select: { sku: true, wfirmaGoodId: true } } },
    orderBy: { id: 'asc' },
  })
  const lastImport = await db.importRun.findFirst({ where: { kind: 'katalog-bl-wfirma', status: { in: ['OK', 'PARTIAL'] } }, orderBy: { startedAt: 'desc' }, select: { id: true, startedAt: true } })
  // import trwający (RUNNING, nowszy niż ostatni udany) stempluje rekordy w trakcie — są bieżące
  const running = lastImport
    ? await db.importRun.findMany({ where: { kind: 'katalog-bl-wfirma', status: 'RUNNING', startedAt: { gt: lastImport.startedAt } }, select: { id: true } })
    : []
  const currentRuns = new Set([...(lastImport ? [lastImport.id] : []), ...running.map((r) => r.id)])
  // przełącznik liczy „bieżące” tak samo jak filtr — inaczej trwający import, który
  // przestemplował już wszystkie rekordy, wyłączał filtr i wracały rekordy skasowane w BL
  const filter = !!lastImport && rows.some((r) => !!r.importRunId && currentRuns.has(r.importRunId))
  const current = filter ? rows.filter((r) => !!r.importRunId && currentRuns.has(r.importRunId)) : rows
  const staleRecords = rows.length - current.length
  const groups = new Map<string, Map<string, typeof rows>>()
  for (const r of current) {
    const g = groups.get(r.productId!) ?? new Map<string, typeof rows>()
    const key = r.wfirmaGoodIdLink ?? `bl:${r.id}`
    g.set(key, [...(g.get(key) ?? []), r])
    groups.set(r.productId!, g)
  }
  const byProduct = new Map<string, BlStock>()
  const conflicting: { sku: string; blSkus: string[]; values: number[] }[] = []
  const multiGood: string[] = []
  let at: Date | null = null
  for (const [productId, g] of groups) {
    const own = rows.find((r) => r.productId === productId)!.product!
    let keys = [...g.keys()]
    if (keys.length > 1) {
      multiGood.push(own.sku)
      if (own.wfirmaGoodId && g.has(own.wfirmaGoodId)) keys = [own.wfirmaGoodId]
    }
    let value = 0
    let last: Date | null = null
    for (const k of keys) {
      const recs = g.get(k)!
      const values = recs.map((r) => Number(r.stockAccounting))
      if (new Set(values).size > 1) conflicting.push({ sku: own.sku, blSkus: recs.map((r) => r.sku ?? r.id), values })
      value += Math.max(...values)
      for (const r of recs) if (!last || r.importedAt > last) last = r.importedAt
    }
    byProduct.set(productId, { value, at: last! })
    if (!at || last! > at) at = last
  }
  return { byProduct, at, conflicting, multiGood, staleRecords }
}

/** Pozycje pracy biura: ruchy MANUAL > 24 h i „Do wyjaśnienia”, numery zamówień i SKU bez danych klientów. */
/** liczby odkładanych faktur BL i samonaprawy, żeby nie ginęły w statystykach przebiegu. Tylko odczyt. */
async function buildBlInvoiceRepair(db: PrismaClient, day: IsoDay, now: Date): Promise<NonNullable<DailyReport['blInvoiceRepair']>> {
  const { from, to } = warsawDay(day)
  const waiting = await db.blInvoiceSnapshot.findMany({ where: { appliedAt: null, lastError: null }, select: { blOrderId: true, dateAdd: true } })
  const paired = waiting.length ? await db.order.findMany({ where: { blOrderId: { in: [...new Set(waiting.map((w) => w.blOrderId))] } }, select: { blOrderId: true } }) : []
  const withPair = new Set(paired.map((o) => o.blOrderId))
  const bezPary = waiting.filter((w) => !withPair.has(w.blOrderId))
  const oldest = bezPary.reduce<Date | null>((m, w) => (!m || w.dateAdd < m ? w.dateAdd : m), null)
  const [healedOrders, numbersAlert] = await Promise.all([
    db.orderEvent.count({ where: { kind: ROZLICZENIE_PO_FAKTURZE_BL, createdAt: { gte: from, lt: to } } }),
    db.alert.count({ where: { kind: FAKTURY_BL_NUMERY_SKLEPU, closedAt: null } }),
  ])
  return { withoutPair: bezPary.length, oldestWithoutPairHours: oldest ? Math.floor((now.getTime() - oldest.getTime()) / 3600_000) : null, healedOrders, numbersAlertOpen: numbersAlert > 0 }
}

async function buildOfficeItems(
  db: PrismaClient,
  day: IsoDay,
  dayAgo: Date,
  clarify: { channel: Channel; externalId: string; blOrderId: number | null; createdAt: Date }[],
): Promise<OfficeItems> {
  const { from, to } = warsawDay(day)
  const manual = await db.pendingMovement.findMany({ where: { state: 'MANUAL' }, select: { type: true, sentAt: true, orderId: true, productId: true } })
  const stale = manual.filter((m) => m.sentAt < dayAgo)
  const shippedWithoutInvoice = stale.filter((m) => m.type === 'ISSUED_WITHOUT_DOCUMENT').length
  const invoiceWithoutWz = stale.filter((m) => m.type === 'BL_INVOICE').length
  const newSinceYesterday = manual.filter((m) => m.sentAt >= from && m.sentAt < to).length + clarify.filter((o) => o.createdAt >= from && o.createdAt < to).length
  const orderIds = [...new Set(stale.map((m) => m.orderId).filter((x): x is string => !!x))]
  const productIds = [...new Set(stale.map((m) => m.productId))]
  const [ordersRows, products] = await Promise.all([
    orderIds.length ? db.order.findMany({ where: { id: { in: orderIds } }, select: { channel: true, externalId: true, blOrderId: true } }) : [],
    productIds.length ? db.product.findMany({ where: { id: { in: productIds } }, select: { sku: true } }) : [],
  ])
  const ref = (o: { channel: Channel; externalId: string; blOrderId: number | null }) => (o.blOrderId ? `BL ${o.blOrderId}` : `${o.channel} ${o.externalId}`)
  return {
    count: stale.length + clarify.length,
    shippedWithoutInvoice,
    invoiceWithoutWz,
    otherManual: stale.length - shippedWithoutInvoice - invoiceWithoutWz,
    toClarify: clarify.length,
    newSinceYesterday,
    orders: [...new Set([...ordersRows.map(ref), ...clarify.map(ref)])].sort().slice(0, MAX_LISTED),
    skus: products.map((p) => p.sku).sort().slice(0, MAX_LISTED),
  }
}

/**
 * Alert dla biura: raz dziennie, gdy lista „Dla biura” nie jest pusta. Trafia do „Sytuacje do obsługi” na
 * pulpicie (otwarte alerty) — bez nowego kanału wysyłki. Same liczby, numery zamówień i SKU.
 */
export async function alertOfficeItems(db: PrismaClient, r: DailyReport): Promise<boolean> {
  const o = r.officeItems
  if (!o || o.count === 0) return false
  const parts = [
    `Dla biura (raport ${r.day}, nie zeruje serii): ${o.count} pozycji`,
    `wysłane bez faktury ${o.shippedWithoutInvoice}`,
    `faktura bez WZ albo z niepełnym WZ ${o.invoiceWithoutWz}`,
    ...(o.otherManual ? [`inne ruchy ręczne ${o.otherManual}`] : []),
    `„Do wyjaśnienia” ${o.toClarify}`,
    `nowe tego dnia ${o.newSinceYesterday}`,
  ]
  const lists = [o.orders.length ? `Zamówienia: ${o.orders.join(', ')}` : '', o.skus.length ? `SKU: ${o.skus.join(', ')}` : ''].filter(Boolean)
  await alert(db, OFFICE_ALERT, 'raport-rozjazdow', `${parts.join(', ')}.${lists.length ? ' ' + lists.join('. ') + '.' : ''}`, `biuro-do-wyjasnienia:${r.day}`)
  return true
}

export const OFFICE_ALERT = 'BIURO_DO_WYJASNIENIA'

function shadowChannels(accounts: { channel: Channel }[]): Channel[] {
  const s = new Set<Channel>(accounts.map((a) => a.channel))
  return s.size ? [...s] : ['WOO', 'EMPIK']
}

/**
 * raport z harmonogramu czeka na zlecony pełny odczyt lustra (np. po imporcie katalogu tuż przed północą),
 * żeby porównać stan BL i wFirmy z tej samej chwili — najwyżej 3 h po końcu dnia (jak przy niezamkniętej sprzedaży), potem
 * liczy się bez niego. Nocny pełny odczyt (`rdzen-noc`, od 3:00) wypada po tym oknie, więc raportu nie wstrzymuje.
 */
export function reportWaitsForMirror(queue: { fullReadDueSince: Date | null } | null, day: IsoDay, now: Date): boolean {
  if (!queue?.fullReadDueSince) return false
  return now.getTime() - warsawDay(day).to.getTime() < 3 * 3600_000
}

/** Zapis raportu (jeden wiersz na dzień; ponowne przeliczenie nadpisuje). */
export async function saveDailyReport(db: PrismaClient, r: DailyReport, now = new Date()): Promise<void> {
  const stats = JSON.parse(JSON.stringify(r)) as Prisma.InputJsonValue
  await db.shadowDailyCheck.upsert({
    where: { organizationId_kind_day: { organizationId: organizationIdOf(db), kind: REPORT_CHECK, day: r.day } },
    create: { kind: REPORT_CHECK, day: r.day, final: true, ok: r.ok, checkedAt: now, stats },
    update: { ok: r.ok, checkedAt: now, stats },
  })
}

/** Ostatni raport firmy (ekran /rozjazdy). */
export async function latestDailyReport(db: PrismaClient): Promise<DailyReport | null> {
  organizationIdOf(db)
  const r = await db.shadowDailyCheck.findFirst({ where: { kind: REPORT_CHECK }, orderBy: { day: 'desc' } })
  return r ? (r.stats as unknown as DailyReport) : null
}

const zl = (cents: number) => (cents / 100).toFixed(2).replace('.', ',')
const entries = (m: Record<string, number>) => Object.entries(m).map(([k, n]) => `${k.trim()} ${n}`).join(', ')

/** Markdown raportu (plik dla biura). */
export function renderDailyReport(r: DailyReport): string {
  const L: string[] = []
  L.push(`# Raport rozjazdów cienia — ${r.day}`, '')
  L.push(`Wygenerowany ${r.generatedAt}. Same liczby, numery zamówień i SKU — bez danych klientów. Wynik: **${r.ok ? 'bez rozjazdów' : 'są rozjazdy do wyjaśnienia'}**.`, '')
  if (r.officeItems)
    L.push(
      'Wynik zerują (docs/seria-f3.md): rozjazd sprzedaży dnia (sekcja 1), stan u nas ≠ BL bez wyjaśnienia czasem albo ruchem biura (sekcja 2), ruchy systemu IN_FLIGHT/APPLIED > 24 h i nadmiary rezerwacji > 30 min (sekcja 4), naruszenia niezmienników (sekcja 5). Nie zerują: „uratowane sprzedaże”, stan kanału kontra „wysłałbym” i lista „Dla biura”.',
      '',
    )
  else L.push('Wynik dotyczy sekcji 1, 4 i 5 (sprzedaż dnia, ruchy i nadmiary, niezmienniki); stany, „uratowane sprzedaże” i „Do wyjaśnienia” są informacyjne (raport w starszym formacie).', '')
  L.push(`Dni z rzędu bez rozjazdu sprzedaży (kryterium 7 dni): cała firma ${r.streaks['*'] ?? 0}.`, '')

  L.push('## 1. Sprzedaż dnia i zamówienia', '')
  if (!r.sales) L.push('Brak sprawdzenia sprzedaży dnia (zadanie `cien-sprzedaz-dnia` nie przeszło).', '')
  else {
    L.push(`Pobranie BL ${r.sales.blComplete ? 'pełne' : 'NIEPEŁNE'}${r.sales.blErrors.length ? ` (${r.sales.blErrors.length} błędów)` : ''}.`, '')
    L.push('| Konto | Kompletor (zam. / zł) | BL (zam. / zł) | Tylko u nas | Tylko w BL | Inna kwota | Wynik | Dni bez rozjazdu |')
    L.push('|---|---|---|---|---|---|---|---|')
    for (const a of r.sales.accounts)
      L.push(`| ${a.name} | ${salesCountBreakdown(a, 'ours')} / ${zl(a.ours.cents)} | ${salesCountBreakdown(a, 'bl')} / ${zl(a.bl.cents)} | ${a.onlyHere.join(', ') || '—'} | ${a.onlyBl.join(', ') || '—'} | ${a.amountDiffs.map((d) => d.ref).join(', ') || '—'} | ${a.ok ? 'zgodne' : 'ROZJAZD'} | ${r.streaks[`${a.channel}|${a.channelAccountId}`] ?? 0} |`)
    for (const a of r.sales.accounts) if (a.notImportedByBl?.length) L.push('', `${a.name}: bez pary w BL, BL ich nie importuje (nieopłacone albo anulowane, nie rozjazd): ${a.notImportedByBl.join(', ')}.`)
    for (const a of r.sales.accounts) if (a.blDelayedImport?.length) L.push('', `${a.name}: import BL z opóźnieniem, u nas złożone innego dnia (nie rozjazd): ${a.blDelayedImport.map((d) => `${d.ref} (${d.ourDay})`).join(', ')}.`)
    for (const a of r.sales.accounts) if (a.blLaterImport?.length) L.push('', `${a.name}: import BL z opóźnieniem, w BL z innym dniem (nie rozjazd): ${a.blLaterImport.map((d) => `${d.ref} (${d.blDay})`).join(', ')}.`)
    if (r.sales.notCompared.length) L.push('', `Źródła BL bez naszego odczytu (bez porównania): ${r.sales.notCompared.map((n) => `${n.key} ${n.count} / ${zl(n.cents)} zł`).join(', ')}.`)
    L.push('')
  }
  if (r.orders.accounts.length) {
    L.push(`Statusy (ostatnie porównanie z BL ${r.orders.comparedAt ?? '—'}):`, '')
    L.push('| Konto | W kanale | W BL | Pary | Brak w BL | Brak u nas | Zgodne | BL dalej | Rozjazd | Rezerwacje na zamówieniach, które BL już pakuje |')
    L.push('|---|---|---|---|---|---|---|---|---|---|')
    for (const a of r.orders.accounts) L.push(`| ${a.name} | ${a.inChannel} | ${a.inBl} | ${a.paired} | ${a.missingInBl} | ${a.missingHere} | ${a.verdicts.ZGODNE} | ${a.verdicts.BL_DALEJ} | ${a.verdicts.ROZJAZD} | ${a.activeReservationsBlAhead} |`)
    for (const a of r.orders.accounts) if (Object.keys(a.divergences).length) L.push('', `- **${a.name}** różnice (nasz → BL): ${entries(a.divergences)}.`)
    L.push('')
  }
  L.push(
    `Faktury BL: czeka na rozliczenie ${r.invoices.pending} (w tym na WZ ${r.invoices.waitingForWz}), rozliczone bez WZ ${r.invoices.withoutWz}, bez stanu (same e-booki) ${r.invoices.digitalOnly ?? 0}, nic do zdjęcia ze stanu (anulowane, pominięte) ${r.invoices.nothingToConsume ?? 0}, wysłane bez faktury ${r.invoices.shippedWithoutInvoice}.`,
    '',
  )
  if (r.blInvoiceRepair) {
    const b = r.blInvoiceRepair
    L.push(
      `Faktury BL bez zamówienia w Kompletorze: ${b.withoutPair}${b.oldestWithoutPairHours !== null ? ` (najstarsza od ${b.oldestWithoutPairHours} h)` : ''}; ` +
        `odczyt numerów zamówień ze sklepu: ${b.numbersAlertOpen ? '**nie działa** (otwarty alert z liczbą odczytów i błędów)' : 'bez otwartego alertu'}; ` +
        `zamówienia rozliczone samonaprawą po fakturze BL tego dnia: ${b.healedOrders}.`,
      '',
    )
  }

  L.push('## 2. Stany', '')
  L.push(`Produkty ze stanem BL (\`accounting_1\`, kopia z importu ${r.stocks.blSnapshotAt ?? '—'}): ${r.stocks.products}; stan fizyczny u nas ≠ BL: **${r.stocks.physicalVsBl}**.`)
  if (r.stocks.physicalVsBlForOk !== undefined)
    L.push(
      '',
      `Liczone do wyniku: **${r.stocks.physicalVsBlForOk}**; w drodze (ruch między odczytem BL a wFirmy albo niepotwierdzony, nie zeruje): ${r.stocks.inTransit ?? 0}; wyjaśnione ruchem biura (nie zeruje): ${r.stocks.office ?? 0}. Ostatni pełny odczyt wFirmy (lustro): ${r.stocks.mirrorLastFullReadAt ?? 'jeszcze nie było — wszystkie rozjazdy liczą się do wyniku'}.`,
    )
  if (r.stocks.mirrorBeforeBl)
    L.push('', `Uwaga: ostatni pełny odczyt wFirmy (${r.stocks.mirrorLastFullReadAt}) jest starszy niż kopia stanów BL (${r.stocks.blSnapshotAt}) — zmiany w wFirmie z tego okna (PZ, dokumenty spoza Kompletora) wyglądają jak rozjazdy. Po imporcie katalogu worker zleca pełny odczyt; raport bez niego wskazuje na odczyt, który nie przeszedł.`)
  const mark = (d: StockDiff) =>
    (d.inTransit ? (d.wzDocs?.length ? ` — dokument w wFirmie (${d.wzDocs.join(', ')})` : ' — w drodze') : d.office ? ' — ruch biura' : d.noMirrorRead ? ' — bez odczytu lustra wFirmy' : '') +
    (!d.inTransit && d.wzDocs?.length ? ` (WZ w oknie: ${d.wzDocs.join(', ')})` : '')
  if (r.stocks.physicalVsBlList.length) L.push('', ...r.stocks.physicalVsBlList.map((d) => `- ${d.sku}: u nas ${d.physical}${d.unit === 'KG' ? ' g' : ''} (dostępne ${d.available}), BL ${d.bl}${d.unit === 'KG' ? ' kg' : ''}${mark(d)}`))
  if (r.stocks.blConflicting)
    L.push('', `Rekordy BL jednego towaru wFirmy z różnym stanem (wzięte maksimum, sprawdź w BL): **${r.stocks.blConflicting}** — ${(r.stocks.blConflictingList ?? []).map((c) => `${c.sku} (${c.blSkus.map((b, i) => `${b}: ${c.values[i]}`).join(', ')})`).join('; ')}.`)
  if (r.stocks.blMultiGood) L.push('', `Produkty z kilkoma różnymi towarami wFirmy w BL (sprawdź powiązania): ${r.stocks.blMultiGood} — ${(r.stocks.blMultiGoodList ?? []).join(', ')}.`)
  if (r.stocks.blStaleRecords) L.push('', `Rekordy BL nieobecne w ostatnim imporcie katalogu (skasowane w BL), pominięte: ${r.stocks.blStaleRecords}.`)
  if (r.stocks.blUnreadable)
    L.push('', `Stan BL nieczytelny (ułamek przy sztukach, bez porównania): **${r.stocks.blUnreadable}** — ${(r.stocks.blUnreadableList ?? []).map((d) => `${d.sku} (BL ${d.bl})`).join(', ')}.`)
  L.push('', `Oferty ze stanem odczytanym z kanału: ${r.stocks.offersWithChannelRead}; stan kanału ≠ nasz „wysłałbym”: ${r.stocks.channelVsTarget}.`, '')

  L.push('## 3. „Uratowane sprzedaże”', '')
  L.push(`Oferty, które wystawilibyśmy (ostatni „wysłałbym” > 0), a BL ma stan 0: **${r.saved.offers}**${r.saved.list.length ? ` — ${r.saved.list.map((s) => `${s.sku} (${s.account}, ${s.target})`).join(', ')}` : ''}.`, '')
  if (r.saved.savedSkippedBundles) L.push(`Pominięte oferty zestawów i produktów bez stanu (BL nie ma ich stanu w \`accounting_1\`): ${r.saved.savedSkippedBundles}.`, '')

  L.push('## 4. Ruchy i nadmiary', '')
  L.push(`Ruchy niepotwierdzone > 24 h${r.officeItems ? ' (zaległość systemu: IN_FLIGHT, APPLIED)' : ''}: **${r.stalePending.count}**${r.stalePending.count ? ` (${entries(r.stalePending.byKind)})` : ''}. Nadmiary rezerwacji > 30 min: **${r.overcommit.count}**${r.overcommit.skus.length ? ` (${r.overcommit.skus.join(', ')})` : ''}.`, '')
  if (r.overcommit.noExcess)
    L.push(`Znacznik nadmiaru bez rezerwacji ponad stan (zwykle stan ujemny z ruchów biura; nie nadmiar, nie zeruje wyniku): ${r.overcommit.noExcess}${r.overcommit.noExcessSkus?.length ? ` (${r.overcommit.noExcessSkus.join(', ')})` : ''}.`, '')

  L.push('## 5. Niezmienniki', '')
  L.push(`Naruszenia: **${r.invariants.count}**${r.invariants.count ? ` (${entries(r.invariants.byRule)})` : ''}.`, '')

  const o = r.officeItems
  if (o) {
    L.push('## Dla biura (nie zeruje serii)', '')
    L.push(`Pozycje do obsługi ręcznej: **${o.count}**, nowe w dniu raportu: ${o.newSinceYesterday}.`, '')
    L.push(`- wysłane bez faktury (ruch ręczny > 24 h): ${o.shippedWithoutInvoice}`)
    L.push(`- faktura bez WZ albo z niepełnym WZ (ruch ręczny > 24 h): ${o.invoiceWithoutWz}`)
    if (o.otherManual) L.push(`- inne ruchy ręczne > 24 h: ${o.otherManual}`)
    L.push(`- zamówienia „Do wyjaśnienia” z kanałów w cieniu: ${o.toClarify}${r.toClarify.count ? ` (${entries(r.toClarify.byReason)})` : ''}`, '')
    if (o.orders.length) L.push(`Zamówienia: ${o.orders.join(', ')}.`, '')
    if (o.skus.length) L.push(`SKU: ${o.skus.join(', ')}.`, '')
  } else {
    L.push('## Do wyjaśnienia', '')
    L.push(`Zamówienia „Do wyjaśnienia” z kanałów w cieniu: **${r.toClarify.count}**${r.toClarify.count ? ` (${entries(r.toClarify.byReason)})` : ''}.`, '')
  }
  return L.join('\n')
}
