// Rozchód przy spakowaniu przez fakturę w wFirmie (spec 2.2 pkt 3 i 5, 3.4, 3.5, 4.5, 9.1).
// Ruch zakładany PRZED żądaniem (IN_FLIGHT + rezerwacje CONSUMING), `available` bez zmian na każdym etapie.
// Wywołanie wFirmy idzie przez interfejs `FakturyWfirma`: w testach atrapa, w workerze adapter zapisu
// lib/wfirma/adapter-zapis.ts za wyłącznikiem firmy „Wystawiaj faktury z Kompletora”.
// magazyn prowadzony przez Kompletor (źródło stanu KOMPLETOR, lib/rdzen/zrodlo-stanu.ts) nie zdejmuje stanu
// fakturą: `wydajZMagazynuWlasnegoInTx` przy „Do wysyłki / Do odbioru”, a dokument sprzedaży to osobny tor (lib/dokumenty).
import type { Order, OrderStatus, Prisma, Unit } from '@prisma/client'
import { rozpiszNaJednostkiBazowe, splitBundlePrice, wartoscPozycjiGr } from './ceny'
import { type PrzelicznikiPozycji, przelicznikiPozycji, wartoscCzesciGr } from './zamiana'
import { forcePushForOrder } from './propagacja'
import { flagsOf, mergeFlags, releaseOrder } from './rezerwacja'
import { alert, advisoryLock, type Db, DEFAULT_WAREHOUSE, orderLockKey, outbox, runTx, StockBook, type Tx } from './stan'
import { zrodloStanu } from './zrodlo-stanu'
import { blokadaPakowaniaFakturaBl, brakiJakoWydanePoFakturzeBlInTx, fakturaZBl, kontoWPodgladzie, odmowaPakowaniaFakturaBl, oznaczPominietaFaktureBl, PRZED_SPAKOWANIEM, zglosDwieFaktury, zglosFaktureBlPoSpakowaniu, zglosFaktureBlWKolejce, zglosTowarPoFakturzeBl } from './faktura-bl'
import { chwilaAutomatuWz } from '../dokumenty/ustawienia'
import { zwolnijKoszykPoStatusie } from '../koszyki/zwolnienie'
import type { Ctx } from './zamowienia'

export interface InvoiceLine {
  productId: string
  qty: number // jednostka bazowa
  /** Cena brutto za jednostkę bazową (grosze); `qty × unitGrossGr` = wartość pozycji. Nie za sztukę oferty. */
  unitGrossGr: number
  vatRate: string
  /** Produkt bez stanu (DIGITAL): pozycja jako usługa — bez WZ i bez ruchu magazynowego. */
  service?: true
}

export type IssueResult =
  | { kind: 'OK'; docId: string; wz: Record<string, number | null>; number?: string | null } // wz: ilość WZ per productId (null = odczyt WZ nieudany); number: numer z wFirmy
  | { kind: 'ERROR'; message: string } // jednoznaczny błąd: dokument nie powstał
  | { kind: 'TIMEOUT' }
  | { kind: 'LIMIT'; message: string; retryAfterMs?: number } // limit wFirmy: żądanie odrzucone przed przetworzeniem, kolejka wstrzymana (3.4)

/**
 * Limit wFirmy („TOTAL REQUESTS LIMIT EXCEEDED”, „AUTH FAILED LIMIT WAIT 5 MINUTES”): adapter rzuca nim przy odczytach
 * i `find`; zapis (faktura, korekta) zwraca `{ kind: 'LIMIT' }`. Kolejka wywołań wstrzymuje wtedy całą firmę (3.4).
 */
export class WfirmaLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

/** Budżet wywołań wFirmy jednego przebiegu kolejki (`maxCalls`); `take()` przed każdym wywołaniem. */
export interface CallBudget {
  left: number
  take(): boolean
}

/** Kontekst torów wołanych z kolejki: budżet przebiegu i `retryAfterMs` z wyniku LIMIT (wynik to sam kod). */
export interface QueueCtx extends Ctx {
  budget?: CallBudget
  onLimit?: (retryAfterMs?: number) => void
  /** statusy, w których dokument bez rozchodu wolno ponowić po „nie znaleziono” (z „wystawiaj przy” firmy). */
  dokumentStatusy?: OrderStatus[]
}

/** Odpowiedź `find` nie wygląda na odfiltrowaną po id_external (3.4 v1.5): rozstrzygnięcie wstrzymane, ruch zostaje IN_FLIGHT. */
export class FindValidationError extends Error {}

/** Najwięcej wyników `find` po prefiksie `<orderId>/<n>/` — więcej znaczy, że wFirma pominęła filtr. */
export const FIND_MAX_TOTAL = 20

/**
 * Walidacja odpowiedzi `find` po prefiksie (3.4 v1.5): każde id_external zaczyna się prefiksem i wyników jest ≤ 20.
 * wFirma ignorująca nieznane pole filtra oddałaby wszystkie dokumenty — wtedy błąd zamiast „znaleziono”.
 */
export function validateFound<T extends { idExternal: string }>(prefix: string, found: T[], total = found.length): T[] {
  if (total > FIND_MAX_TOTAL) throw new FindValidationError(`find ${prefix}: ${total} wyników (> ${FIND_MAX_TOTAL}) — filtr id_external nie zadziałał`)
  const bad = found.find((f) => !f.idExternal.startsWith(prefix))
  if (bad) throw new FindValidationError(`find ${prefix}: wynik spoza prefiksu (${bad.idExternal}) — filtr id_external nie zadziałał`)
  return found
}

/**
 * Test kontrolny filtra `find` przy starcie adaptera (3.4 v1.5): prefiks, którego nie ma, musi dać 0 wyników.
 * false = wFirma pomija filtr; kolejka nie rozstrzyga wtedy timeoutów przez `find` (alert, ruchy zostają w toku).
 * `known`: sonda pozytywna — prefiks dokumentu na pewno wystawionego musi go zwrócić.
 * Bez niej `find`, które nigdy nic nie znajduje (złe pole, zły endpoint), dawałoby po timeoucie drugi dokument.
 */
export async function checkFindFilter(
  find: (prefix: string) => Promise<{ idExternal: string; docId?: string }[]>,
  known?: { prefix: string; docId: string } | null,
): Promise<boolean> {
  const probe = `kontrola/${globalThis.crypto.randomUUID()}/`
  if ((await find(probe)).length !== 0) return false
  if (!known) return true
  return (await find(known.prefix)).some((f) => f.docId === known.docId)
}

export interface FoundInvoice {
  docId: string
  idExternal: string
  wz: Record<string, number | null>
  /** Numer dokumentu (`fullnumber`), gdy `find` go oddał. */
  number?: string | null
}

export interface FakturyWfirma {
  /**
   * Kontrakt: błąd jednoznaczny (wFirma odrzuciła dokument: walidacja, VAT, kontrahent) adapter zwraca jako
   * `{ kind: 'ERROR' }`. Wyjątek rdzeń traktuje jak timeout (błąd transportu: nie wiadomo, czy dokument powstał).
   */
  issue(req: { idExternal: string; lines: InvoiceLine[]; paymentMethod: string }): Promise<IssueResult>
  /** invoices/find po prefiksie id_external `<orderId>/<n>/`. */
  findByPrefix(prefix: string): Promise<FoundInvoice[]>
  /**
   * Ponowny odczyt WZ faktury (2.2 pkt 5 v1.5): pozycja faktury ma tylko `warehouse_document_content.id`, ilość
   * daje osobny odczyt dokumentu WZ. null = błąd odczytu; faktura `simple` (bez WZ) = 0. Brak metody = bez ponowień.
   */
  readWz?(docId: string): Promise<Record<string, number | null>>
}

export const FIND_SCHEDULE_MS = [30_000, 120_000, 300_000] // 30 s, 2 min, 5 min po timeoucie (3.4)
/** Ponowienia odczytu WZ po błędzie (2.2 pkt 5 v1.5): 30 s, 2 min, 5 min; potem jak 0 (MANUAL). */
export const WZ_SCHEDULE_MS = FIND_SCHEDULE_MS
/** Próba faktury odrzucona limitem wFirmy: dokument nie powstał, próba nie liczy się do MAX_INVOICE_ATTEMPTS. */
export const LIMIT_ERROR_PREFIX = 'LIMIT:'
/** Powód próby po trzech nieudanych `find` (niejednoznaczny: dokument nie powstał, ale wFirma nie odmówiła). */
const INVOICE_NOT_FOUND = 'timeout: faktury nie znaleziono po 3 próbach'

async function lockOrder(tx: Tx, orderId: string): Promise<Order> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
  await advisoryLock(tx, orderLockKey(o))
  return tx.order.findUniqueOrThrow({ where: { id: orderId } })
}

// ─── Spakowanie (T9) ─────────────────────────────────────────────────────────

export class PackError extends Error {}

/**
 * Zamówienie spakowane: faktura obejmie pozycje z ACTIVE rezerwacją. Otwarte braki dostają tor:
 * opłacone z góry → REFUND_PENDING (lista „Do zwrotu”), pobranie → COD_REDUCED (kwota pobrania pomniejszona).
 */
export async function packOrder(db: Db, orderId: string, ctx: Ctx = {}): Promise<{ status: OrderStatus; refund: number; codReduced: number }> {
  return runTx(db, (tx) => packOrderInTx(tx, orderId, ctx))
}

/**
 * `packOrder` we wskazanej transakcji (stanowisko zapisuje w niej wynik pakowania). Brak przy spakowaniu to
 * zadanie dla obsługi, nie automat: alert (zwrot pieniędzy albo pomniejszone pobranie), a gdy paczka ma już fakturę,
 * także flaga `doKorekty` (korekta ręcznie, spec 4.5).
 */
export async function packOrderInTx(tx: Tx, orderId: string, ctx: Ctx = {}): Promise<{ status: OrderStatus; refund: number; codReduced: number }> {
  const now = ctx.now ?? new Date()
  const o = await lockOrder(tx, orderId)
  if (!['DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE'].includes(o.status)) throw new PackError(`Nie można spakować zamówienia w statusie ${o.status}`)
  if (flagsOf(o).kartaNieaktualna) throw new PackError('Karta nieaktualna: zamówienie zmieniło się w kanale po wydruku — wydrukuj kartę ponownie i zbierz według nowej')
  // konto w trybie pracy, zamówienie z fakturą BL = kończy je BaseLinker; pakowanie tylko po świadomej
  // decyzji z karty („Pakuj mimo faktury z BaseLinkera”). Podgląd i firma bez BL: bez zmian (null).
  const fakturaBl = await blokadaPakowaniaFakturaBl(tx, o)
  if (fakturaBl !== null) throw new PackError(odmowaPakowaniaFakturaBl(fakturaBl, o.parentOrderId !== null))
  const active = await tx.reservation.count({ where: { orderId, state: 'ACTIVE' } })
  // OPEN i reszta „dośle później” (SHIP_LATER) — po spakowaniu paczka nie dostaje już towaru
  const open = await tx.shortage.findMany({ where: { orderId, state: { in: ['OPEN', 'SHIP_LATER'] } } })
  // bez rezerwacji tylko zamówienie bez wysyłki: sama usługa (e-book) do faktury i żadnego braku
  const bezWysylki = !active && !open.length && (await serviceUnits(tx, orderId)) > 0
  if (!active && !bezWysylki) throw new PackError('Nic do spakowania: brak zarezerwowanych pozycji')
  const target = o.paymentState === 'COD' ? 'COD_REDUCED' : 'REFUND_PENDING'
  if (open.length) await tx.shortage.updateMany({ where: { id: { in: open.map((s) => s.id) } }, data: { state: target, resolvedAt: now } })
  const invoiced = open.length ? await tx.invoiceAttempt.count({ where: { orderId, packageNo: o.packageNo, state: 'ISSUED' } }) : 0
  await tx.order.update({ where: { id: orderId }, data: { status: 'SPAKOWANE', flags: mergeFlags(o, { brakuje: false, ...(invoiced ? { doKorekty: true } : {}) }) } })
  await zwolnijKoszykPoStatusie(tx, orderId, 'SPAKOWANE') // spakowane z karty też wychodzi z koszyka
  await tx.orderEvent.create({ data: { orderId, kind: 'SPAKOWANE', actorId: ctx.actorId ?? 'panel', data: { braki: open.length, tor: open.length ? target : null, ...(bezWysylki ? { bezWysylki: true } : {}) } } })
  if (open.length) {
    const co = target === 'COD_REDUCED' ? 'pomniejsz kwotę pobrania o brakujące pozycje' : 'zwróć pieniądze za brakujące pozycje (lista „Do zwrotu”)'
    await alert(tx, 'BRAK_PRZY_PAKOWANIU', orderId, `Paczka wyszła bez ${open.length} poz.: ${co}${invoiced ? '; faktura była wcześniej: zrób korektę ręcznie' : ''}`, `brak-przy-pakowaniu:${orderId}:${o.packageNo}`)
  }
  return { status: 'SPAKOWANE' as OrderStatus, refund: target === 'REFUND_PENDING' ? open.length : 0, codReduced: target === 'COD_REDUCED' ? open.length : 0 }
}

/** Sztuki pozycji bez stanu (DIGITAL) do faktury: nieusunięte, `qty − qtyRejected`. */
async function serviceUnits(tx: Tx, orderId: string): Promise<number> {
  const lines = await tx.orderLine.findMany({ where: { orderId, removed: false, productId: { not: null } }, select: { productId: true, qty: true, qtyRejected: true } })
  const digital = new Set((await tx.product.findMany({ where: { id: { in: lines.map((l) => l.productId!) }, kind: 'DIGITAL' }, select: { id: true } })).map((p) => p.id))
  return lines.filter((l) => digital.has(l.productId!)).reduce((s, l) => s + Math.max(0, l.qty - l.qtyRejected), 0)
}

// ─── Faktura ─────────────────────────────────────────────────────────────────

/** INNE_ZRODLO: magazyn nie jest lustrem wFirmy — faktura z rozchodem nie idzie. */
/** FAKTURA_BL: zamówienie ma fakturę z BaseLinkera (lib/rdzen/faktura-bl.ts) — druga z Kompletora nie idzie nigdy. */
export type InvoiceOutcome = 'WYSTAWIONA' | 'JUZ_WYSTAWIONA' | 'W_TOKU' | 'BLAD' | 'TIMEOUT' | 'NIC_DO_FAKTURY' | 'LIMIT_PROB' | 'LIMIT' | 'INNE_ZRODLO' | 'POZA_MOMENTEM' | 'FAKTURA_BL'

/** Próby liczone do limitu: bez odrzuconych limitem wFirmy i bez prób sprzed ręcznego „Ponów fakturę”. */
function liczoneProby(o: Pick<Order, 'flags'>, attempts: { state: string; lastError: string | null; attemptNo: number }[]) {
  const po = flagsOf(o).fakturaPonowionaPo ?? 0
  return attempts.filter((a) => a.attemptNo > po && !(a.state === 'FAILED' && a.lastError?.startsWith(LIMIT_ERROR_PREFIX)))
}

/** Limit prób osiągnięty: flaga i alert dla obsługi zamiast pętli bez końca (wspólne dla faktury i dokumentu). */
async function limitProb(tx: Tx, o: Order, n: number, ile: number): Promise<void> {
  await tx.order.update({ where: { id: o.id }, data: { flags: mergeFlags(o, { fakturaBlad: true }) } })
  await alert(tx, 'FAKTURA_BLAD', o.id, `Faktura paczki ${n}: ${ile} nieudanych prób — sprawdź w programie do faktur i kliknij „Ponów fakturę” na karcie zamówienia albo wystaw ręcznie`, `faktura-limit:${o.parentOrderId ?? o.id}/${n}`)
}

/** Zamówienie z fakturą BL: ślad w historii (raz) i odmowa faktury z Kompletora, bez ruchu stanu i bez żądania. */
async function pominPoFakturzeBl(tx: Tx, o: Order, ctx: Ctx): Promise<boolean> {
  const numer = await fakturaZBl(tx, o)
  if (numer === null) return false
  await oznaczPominietaFaktureBl(tx, o.id, numer, ctx.actorId ?? 'system:faktury')
  return true
}

/** Ile prób faktury na jedną paczkę, zanim system przestaje próbować sam i woła obsługę. */
export const MAX_INVOICE_ATTEMPTS = 3

/**
 * Linie faktury rdzenia: ilość w jednostce bazowej (to, co spakowane), cena za jednostkę bazową, `qty × unitGrossGr`
 * = wartość pozycji. `OrderLine.unitPriceGross` to cena za SZTUKĘ OFERTY, a `qty` jest w jednostce bazowej,
 * więc wartość liczymy przez `qtyBasePerOffer` oferty (`wartoscPozycjiGr`, ta sama reguła co `zlozPozycjeDokumentu`).
 * Wcześniej oferta 50 g za 12,50 zł × 2 dawała 100 × 12,50 zł. Treść dokumentu w wFirmie i tak składa `zlozFakture`
 * z zamówienia (lib/wfirma/adapter-zapis.ts), a te linie służą do kontroli ilości z paczką, WZ i zapisu próby.
 */
async function buildInvoiceLines(tx: Tx, orderId: string, reservations: { orderLineId: string; productId: string; qtyBase: number }[]): Promise<InvoiceLine[]> {
  const lineIds = [...new Set(reservations.map((r) => r.orderLineId))]
  const lines = await tx.orderLine.findMany({ where: { id: { in: lineIds } }, include: {} })
  const prodIds = [...new Set([...lines.map((l) => l.productId!), ...reservations.map((r) => r.productId)])]
  const products = await tx.product.findMany({ where: { id: { in: prodIds } }, include: { bundleComponents: true } })
  const byId = new Map(products.map((p) => [p.id, p]))
  // Pozycje bez stanu (e-book) nie mają rezerwacji: idą na fakturę paczki tego zamówienia jako usługa.
  const rest = await tx.orderLine.findMany({ where: { orderId, removed: false, productId: { not: null }, id: { notIn: lineIds } } })
  const prz = await sztukBazowychNaOferte(tx, orderId)
  const naOferte = prz.naOferte
  const out: InvoiceLine[] = []
  const dodaj = (productId: string, qty: number, wartoscGr: number, vatRate: string, service?: true) => {
    for (const x of rozpiszNaJednostkiBazowe(qty, wartoscGr)) out.push({ productId, qty: x.qty, unitGrossGr: x.unitGrossGr, vatRate, ...(service ? { service } : {}) })
  }
  for (const l of lines) {
    const p = byId.get(l.productId!)!
    const res = reservations.filter((r) => r.orderLineId === l.id)
    const priceGr = Math.round(Number(l.unitPriceGross) * 100) // za sztukę oferty
    const n = naOferte.get(l.id) ?? 1
    if (p.kind === 'STOCKED') {
      const qty = res.reduce((s, r) => s + r.qtyBase, 0)
      // część rodziny zamian: przyrost wartości rodziny; pozycja bez zamian ma przesunięcie 0
      dodaj(p.id, qty, wartoscCzesciGr(qty, prz.przesuniecie.get(l.id) ?? 0, n, priceGr), l.vatRate ?? p.vatRate ?? '23')
      continue
    }
    // zestaw wirtualny rozbity na składniki: liczba spakowanych zestawów z rezerwacji pierwszego składnika;
    // cena oferty dotyczy `n` zestawów, więc składniki na jedną sztukę oferty to `qtyBase × n` (jak zlozPozycjeDokumentu)
    const comp = p.bundleComponents[0]!
    const units = Math.round(res.filter((r) => r.productId === comp.componentId).reduce((s, r) => s + r.qtyBase, 0) / comp.qtyBase)
    // bez `continue` przy units ≤ 0 — zestaw bez rezerwacji pierwszego składnika daje
    // linie z ilością 0 (jak), więc `beginDocument` kończy się jawnym błędem z alertem, nie cichym NIC_DO_FAKTURY
    const split = splitBundlePrice(
      priceGr,
      p.bundleComponents.map((c) => ({
        productId: c.componentId,
        qty: c.qtyBase * n,
        retailGross: Number(byId.get(c.componentId)?.priceGross ?? 1),
        vatRate: byId.get(c.componentId)?.vatRate ?? '23',
      })),
    )
    const sztukOferty = units / n
    if (Number.isInteger(sztukOferty)) {
      for (const s of split) dodaj(s.productId, s.qty * sztukOferty, s.lineGrossGr * sztukOferty, s.vatRate)
      continue
    }
    // spakowana część oferty wielozestawowej (np. 1 z 2 zestawów): składnik zbiorczo, wartość proporcjonalnie
    const zbiorczo = new Map<string, { qty: number; gr: number; vatRate: string }>()
    for (const s of split) {
      const z = zbiorczo.get(s.productId) ?? { qty: 0, gr: 0, vatRate: s.vatRate }
      zbiorczo.set(s.productId, { qty: z.qty + s.qty, gr: z.gr + s.lineGrossGr, vatRate: z.vatRate })
    }
    for (const [productId, z] of zbiorczo) dodaj(productId, (z.qty / n) * units, Math.round((z.gr * units) / n), z.vatRate)
  }
  const digital = rest.length ? await tx.product.findMany({ where: { id: { in: rest.map((l) => l.productId!) }, kind: 'DIGITAL' } }) : []
  const digitalById = new Map(digital.map((p) => [p.id, p]))
  for (const l of rest) {
    const p = digitalById.get(l.productId!)
    const qty = l.qty - l.qtyRejected
    if (!p || qty <= 0) continue
    dodaj(p.id, qty, wartoscPozycjiGr(qty, naOferte.get(l.id) ?? 1, Math.round(Number(l.unitPriceGross) * 100)), l.vatRate ?? p.vatRate ?? '23', true)
  }
  return out
}

/**
 * `qtyBasePerOffer` oferty każdej pozycji (id pozycji → liczba). Ta sama reguła co `pozycjeZamowienia`
 * (lib/dokumenty/pozycje.ts): oferta kanału i konta zamówienia po `OrderLine.offerId`, tylko dla pozycji z produktem;
 * brak oferty = 1. Zamiennik („Zamień produkt”) dostaje przelicznik pozycji pierwotnej (`przelicznikiPozycji`),
 * dlatego czytamy wszystkie pozycje zamówienia, nie tylko te z rezerwacją.
 */
async function sztukBazowychNaOferte(tx: Tx, orderId: string): Promise<PrzelicznikiPozycji> {
  const all = await tx.orderLine.findMany({ where: { orderId }, select: { id: true, externalLineId: true, productId: true, offerId: true, qty: true, qtyRejected: true, removed: true, unitPriceGross: true } })
  const ids = [...new Set(all.filter((l) => l.productId && l.offerId).map((l) => l.offerId!))]
  if (!ids.length) return przelicznikiPozycji(all, () => undefined)
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { channel: true, channelAccountId: true } })
  const offers = await tx.channelOffer.findMany({ where: { channel: o.channel, channelAccountId: o.channelAccountId, externalId: { in: ids } }, select: { externalId: true, qtyBasePerOffer: true } })
  const byExt = new Map(offers.map((x) => [x.externalId, x.qtyBasePerOffer]))
  return przelicznikiPozycji(all, (offerId) => byExt.get(offerId))
}

/** Krok 1 (własna krótka transakcja): ruch IN_FLIGHT + rezerwacje CONSUMING, potem dopiero żądanie. */
export async function beginInvoice(
  db: Db,
  orderId: string,
  ctx: Ctx = {},
): Promise<{ outcome: 'START'; attemptId: string; idExternal: string; lines: InvoiceLine[]; paymentMethod: string } | { outcome: Exclude<InvoiceOutcome, 'WYSTAWIONA' | 'BLAD' | 'TIMEOUT' | 'LIMIT'> }> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  return runTx(db, async (tx) => {
    const o = await lockOrder(tx, orderId)
    // wiersz magazynu FOR SHARE przed blokadą stanu, potem źródło. Zmiana źródła
    // (`zmienZrodloStanu`: Organization → Warehouse FOR UPDATE) czeka na tę transakcję, a ta na nią — bez cyklu
    // (kolejność: blokada zamówienia → Warehouse → Stock). Magazyn prowadzony przez Kompletor nie dostaje faktury z WZ.
    await tx.$queryRaw`SELECT 1 FROM "Warehouse" WHERE id = ${wh} FOR SHARE`
    if ((await zrodloStanu(tx, wh)) !== 'WFIRMA') return { outcome: 'INNE_ZRODLO' as const }
    const n = o.packageNo
    const attempts = await tx.invoiceAttempt.findMany({ where: { orderId, packageNo: n } })
    if (attempts.some((a) => a.state === 'ISSUED')) return { outcome: 'JUZ_WYSTAWIONA' as const }
    if (attempts.some((a) => a.state === 'SENDING' || a.state === 'UNKNOWN')) return { outcome: 'W_TOKU' as const }
    if (await pominPoFakturzeBl(tx, o, ctx)) return { outcome: 'FAKTURA_BL' as const }
    if (o.status !== 'SPAKOWANE') throw new PackError(`Faktura tylko dla spakowanego zamówienia (jest ${o.status})`)
    const counted = liczoneProby(o, attempts)
    if (counted.length >= MAX_INVOICE_ATTEMPTS) {
      // trwały błąd (np. adapter rzuca wyjątkiem przy każdej próbie): zamiast pętli bez końca — flaga i alert dla obsługi
      await limitProb(tx, o, n, counted.length)
      return { outcome: 'LIMIT_PROB' as const }
    }
    const res = await tx.reservation.findMany({ where: { orderId, state: 'ACTIVE', warehouseId: wh } })
    const attemptNo = Math.max(0, ...attempts.map((a) => a.attemptNo)) + 1
    // podzamówienie „dośle” (druga paczka) ma id_external z numerem zamówienia głównego: <orderId>/<n>/<próba>
    const idExternal = `${o.parentOrderId ?? orderId}/${n}/${attemptNo}`
    const paymentMethod = o.paymentState === 'COD' ? 'cod' : 'transfer'
    const newAttempt = (lines: InvoiceLine[]) =>
      tx.invoiceAttempt.create({ data: { orderId, packageNo: n, attemptNo, idExternal, state: 'SENDING', payload: lines as unknown as Prisma.InputJsonValue } })
    if (!res.length) {
      // zamówienie bez wysyłki: same usługi (e-book) — bez blokady stanu i bez ruchu magazynowego
      const lines = await buildInvoiceLines(tx, orderId, [])
      if (!lines.length) return { outcome: 'NIC_DO_FAKTURY' as const }
      const attempt = await newAttempt(lines)
      return { outcome: 'START' as const, attemptId: attempt.id, idExternal, lines, paymentMethod }
    }
    const book = await StockBook.lock(tx, wh, res.map((r) => r.productId))
    const lines = await buildInvoiceLines(tx, orderId, res)
    const attempt = await newAttempt(lines)
    await tx.reservation.updateMany({ where: { id: { in: res.map((r) => r.id) } }, data: { state: 'CONSUMING', invoiceId: attempt.id } })
    const perProduct = new Map<string, number>()
    for (const r of res) perProduct.set(r.productId, (perProduct.get(r.productId) ?? 0) + r.qtyBase)
    for (const [productId, qty] of perProduct) {
      book.change(productId, { reserved: -qty, pending: -qty }) // available bez zmian
      await tx.pendingMovement.create({
        data: {
          productId,
          warehouseId: wh,
          delta: -qty,
          type: 'OWN_INVOICE',
          state: 'IN_FLIGHT',
          sentAt: now,
          orderId,
          invoiceId: attempt.id,
          idempotencyKey: `${idExternal}:${productId}`,
        },
      })
    }
    await book.flush(tx, now)
    return { outcome: 'START' as const, attemptId: attempt.id, idExternal, lines, paymentMethod }
  })
}

/**
 * Sprawa alertów faktury zamknięta: `alert()` dedupuje po kluczu także zamknięte wiersze, więc
 * zamknięcie zwalnia klucz; kolejna nieudana seria dostaje nowy alert, zamiast stać z flagą bez żadnego.
 */
async function closeInvoiceAlerts(tx: Tx, orderId: string, now: Date, onlyAmbiguous = false): Promise<void> {
  await tx.alert.updateMany({
    where: { kind: 'FAKTURA_BLAD', ref: orderId, closedAt: null, ...(onlyAmbiguous ? { dedupeKey: { startsWith: 'faktura-niejednoznaczna:' } } : {}) },
    data: { closedAt: now, dedupeKey: null },
  })
}

/** Faktura wystawiona: rezerwacje CONSUMED, ruchy APPLIED z wzQty z odpowiedzi; brak/niepełny WZ → część MANUAL. */
export async function completeInvoice(db: Db, attemptId: string, docId: string, wz: Record<string, number | null>, ctx: Ctx & { number?: string | null } = {}): Promise<void> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  await runTx(db, async (tx) => {
    const a0 = await tx.invoiceAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const o = await lockOrder(tx, a0.orderId)
    const a = await tx.invoiceAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    if (a.state === 'ISSUED') return
    if (a.state === 'FAILED') throw new Error(`faktura ${a.idExternal} już oznaczona jako nieudana`)
    const moves = await tx.pendingMovement.findMany({ where: { invoiceId: attemptId, state: 'IN_FLIGHT' } })
    const book = await StockBook.lock(tx, wh, moves.map((m) => m.productId))
    let withoutWz = 0
    for (const m of moves) {
      await tx.pendingMovement.update({ where: { id: m.id }, data: { state: 'APPLIED', effectiveAt: now, wfirmaDocId: docId } })
      // null = odczyt WZ nieudany (2.2 pkt 5 v1.5): ponowienie, dopiero po 3 próbach jak 0
      const r = await settleWz(tx, { ...m, state: 'APPLIED', effectiveAt: now, wfirmaDocId: docId }, wz[m.productId] === null ? null : (wz[m.productId] ?? 0), now)
      if (r === 'NONE' || r === 'PARTIAL') withoutWz++
      await outbox(tx, 'WFIRMA_READ', m.productId, now) // odczyt celowany goods/get po fakturze
    }
    await tx.reservation.updateMany({ where: { invoiceId: attemptId, state: 'CONSUMING' }, data: { state: 'CONSUMED', consumedAt: now } })
    await tx.invoiceAttempt.update({ where: { id: attemptId }, data: { state: 'ISSUED', wfirmaDocId: docId, nextFindAt: null, ...(ctx.number ? { number: ctx.number.slice(0, 100) } : {}) } })
    await closeInvoiceAlerts(tx, o.id, now) // wcześniejsza nieudana próba tej paczki: faktura jest, alert nieaktualny
    if (withoutWz) await alert(tx, 'FAKTURA_BEZ_WZ', o.id, `Faktura ${docId}: ${withoutWz} pozycji bez WZ (albo WZ na część) — popraw w wFirmie i kliknij „Poprawione w wFirmie” (Braki towaru → Do poprawy w wFirmie)`, `faktura-bez-wz:${docId}`)
    // dokument bez rozchodu, który wszedł już po anulowaniu (anulowanie go nie czeka, stan
    // zwolnił rdzeń) — faktura istnieje w programie, więc zamówienie trafia na listę „do korekty” z alertem dla biura
    const poAnulowaniu = a.documentOnly && o.status === 'ANULOWANE'
    if (poAnulowaniu) await alert(tx, 'FAKTURA_DO_KOREKTY', o.id, `Faktura ${ctx.number ?? docId} weszła dla anulowanego zamówienia: wystaw korektę w programie do faktur`, `faktura-po-anulowaniu:${docId}`)
    // Anulowanie odłożone na czas faktury → tor „po fakturze” (T6). Jeden zapis flag.
    const cancelAfter = !poAnulowaniu && !!o.pendingAction?.startsWith('CANCEL')
    await tx.order.update({
      where: { id: o.id },
      data: {
        flags: mergeFlags(o, { fakturaBlad: false, fakturaBezWz: withoutWz > 0 || undefined, ...(cancelAfter || poAnulowaniu ? { doKorekty: true } : {}) }),
        ...(cancelAfter ? { status: 'ANULOWANE' as const, cancelReason: 'CANCELLED', pendingAction: null } : {}),
      },
    })
    await tx.orderEvent.create({ data: { orderId: o.id, kind: 'FAKTURA', actorId: 'system:faktury', data: { docId, idExternal: a.idExternal, bezWz: withoutWz, ...(ctx.number ? { numer: ctx.number.slice(0, 100) } : {}), ...(a.documentOnly ? { bezRozchodu: true } : {}) } } })
    if (cancelAfter) {
      await zwolnijKoszykPoStatusie(tx, o.id, 'ANULOWANE')
      await tx.orderEvent.create({ data: { orderId: o.id, kind: 'ANULOWANE', actorId: 'system:faktury', data: { poFakturze: true } } })
      await forcePushForOrder(tx, o, now) // 6.1 pkt 4
    }
    await book.flush(tx, now) // available bez zmian; flush tylko dla wersji
  })
}

type MovementRow = Awaited<ReturnType<Tx['pendingMovement']['findUniqueOrThrow']>>

/**
 * Rozliczenie ilości WZ ruchu APPLIED faktury (`got` = WZ z wFirmy dla produktu, null = odczyt nieudany).
 * Pełny WZ → APPLIED z wzQty (potwierdzi go odczyt); 0 → MANUAL (biuro poprawia w wFirmie); część → APPLIED na część
 * + MANUAL na resztę; null → zostaje APPLIED bez wzQty (żaden odczyt go nie potwierdzi) z terminem ponowienia odczytu WZ.
 * Suma `delta` się nie zmienia, więc `pendingDelta` i `physical` bez zmian.
 */
async function settleWz(tx: Tx, m: MovementRow, got: number | null, now: Date): Promise<'FULL' | 'NONE' | 'PARTIAL' | 'UNKNOWN'> {
  const qty = -m.delta
  if (got === null) {
    await tx.pendingMovement.update({ where: { id: m.id }, data: { wzQty: null, nextWzReadAt: new Date(now.getTime() + WZ_SCHEDULE_MS[Math.min(m.wzTries, WZ_SCHEDULE_MS.length - 1)]!) } })
    return 'UNKNOWN'
  }
  const take = Math.max(0, Math.min(qty, got))
  if (take === qty) {
    await tx.pendingMovement.update({ where: { id: m.id }, data: { wzQty: qty, nextWzReadAt: null } })
    return 'FULL'
  }
  if (take === 0) {
    await tx.pendingMovement.update({ where: { id: m.id }, data: { state: 'MANUAL', wzQty: 0, nextWzReadAt: null } })
    return 'NONE'
  }
  await tx.pendingMovement.update({ where: { id: m.id }, data: { wzQty: take, delta: -take, nextWzReadAt: null } })
  await tx.pendingMovement.create({
    data: {
      productId: m.productId,
      warehouseId: m.warehouseId,
      delta: -(qty - take),
      type: m.type,
      state: 'MANUAL',
      sentAt: m.sentAt,
      effectiveAt: m.effectiveAt,
      wfirmaDocId: m.wfirmaDocId,
      wzQty: 0,
      orderId: m.orderId,
      invoiceId: m.invoiceId,
      idempotencyKey: `${m.idempotencyKey}:bez-wz`,
    },
  })
  return 'PARTIAL'
}

/**
 * Ponowienia odczytu WZ (2.2 pkt 5 v1.5): ruchy faktur z nieudanym odczytem WZ, po 30 s / 2 min / 5 min; po trzeciej
 * nieudanej próbie jak 0 (MANUAL, alert „faktura bez WZ”). `WfirmaLimitError` przechodzi wyżej (kolejka wstrzymuje się).
 */
export async function resolveWzReads(db: Db, wf: FakturyWfirma, ctx: QueueCtx = {}): Promise<{ settled: number; waiting: number; asZero: number }> {
  const now = ctx.now ?? new Date()
  const stats = { settled: 0, waiting: 0, asZero: 0, errors: 0 }
  // Adapter bez `readWz` nie ponowi odczytu: ruch z nieudanym odczytem WZ od razu jak 0 (inaczej zostałby APPLIED
  // bez wzQty na zawsze — żaden odczyt stanu go nie potwierdza; weryfikacja).
  const canRetry = !!wf.readWz
  const due = await db.pendingMovement.findMany({ where: { state: 'APPLIED', wzQty: null, nextWzReadAt: { lte: now }, wfirmaDocId: { not: null } }, orderBy: { nextWzReadAt: 'asc' } })
  const byDoc = new Map<string, typeof due>()
  for (const m of due) byDoc.set(m.wfirmaDocId!, [...(byDoc.get(m.wfirmaDocId!) ?? []), m])
  for (const [docId, moves] of byDoc) {
    let wz: Record<string, number | null> = {} // błąd odczytu = null dla każdej pozycji
    if (canRetry && ctx.budget && !ctx.budget.take()) break // budżet przebiegu: reszta dokumentów w następnym (termin zostaje)
    if (canRetry)
      try {
        wz = await wf.readWz!(docId)
      } catch (e) {
        if (e instanceof WfirmaLimitError) throw e
      }
    for (const m0 of moves) {
      // fail-safe per ruch: błąd jednego nie zatrzymuje reszty (ruch zostaje z terminem, następny przebieg ponowi)
      try {
        await settleWzRead(db, m0, wz, docId, canRetry, stats, now)
      } catch (e) {
        stats.errors++
        console.error(`[wz] ruch ${m0.id} (faktura ${docId}): ${(e as Error).message}`)
      }
    }
  }
  return stats
}

async function settleWzRead(
  db: Db,
  m0: { id: string; warehouseId: string; productId: string },
  wz: Record<string, number | null>,
  docId: string,
  canRetry: boolean,
  stats: { settled: number; waiting: number; asZero: number },
  now: Date,
): Promise<void> {
  await runTx(db, async (tx) => {
    await StockBook.lock(tx, m0.warehouseId, [m0.productId]) // ten sam wiersz co odczyt wFirmy
    const m = await tx.pendingMovement.findUniqueOrThrow({ where: { id: m0.id } })
    if (m.state !== 'APPLIED' || m.wzQty !== null) return
    const tries = m.wzTries + 1
    const got = wz[m.productId] ?? null
    const value = got === null && (!canRetry || tries >= WZ_SCHEDULE_MS.length) ? 0 : got
    await tx.pendingMovement.update({ where: { id: m.id }, data: { wzTries: tries } })
    const r = await settleWz(tx, { ...m, wzTries: tries }, value, now)
    if (r === 'UNKNOWN') return void stats.waiting++
    stats.settled++
    if (got === null) stats.asZero++
    if (r === 'NONE' || r === 'PARTIAL') {
      if (m.orderId) {
        const o = await tx.order.findUnique({ where: { id: m.orderId } })
        if (o) await tx.order.update({ where: { id: o.id }, data: { flags: mergeFlags(o, { fakturaBezWz: true }) } })
      }
      const why = got === null ? (canRetry ? ' — odczyt WZ nieudany 3 razy' : ' — odczyt WZ nieudany') : ''
      await alert(tx, 'FAKTURA_BEZ_WZ', m.orderId ?? m.productId, `Faktura ${docId}: pozycja bez WZ (albo WZ na część)${why} — popraw w wFirmie i kliknij „Poprawione w wFirmie” (Braki towaru → Do poprawy w wFirmie)`, `faktura-bez-wz:${docId}`)
    }
    await outbox(tx, 'WFIRMA_READ', m.productId, now)
  })
}

/** Jednoznaczny błąd (albo nieznaleziona po timeoucie): ruch CANCELLED, rezerwacje wracają do ACTIVE. */
export async function failInvoice(db: Db, attemptId: string, message: string, ctx: Ctx & { definite?: boolean; limit?: boolean } = {}): Promise<void> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  await runTx(db, async (tx) => {
    const a0 = await tx.invoiceAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    const o = await lockOrder(tx, a0.orderId)
    const a = await tx.invoiceAttempt.findUniqueOrThrow({ where: { id: attemptId } })
    if (a.state === 'FAILED' || a.state === 'ISSUED') return
    const moves = await tx.pendingMovement.findMany({ where: { invoiceId: attemptId, state: 'IN_FLIGHT' } })
    const res = await tx.reservation.findMany({ where: { invoiceId: attemptId, state: 'CONSUMING' } })
    const book = await StockBook.lock(tx, wh, [...moves.map((m) => m.productId), ...res.map((r) => r.productId)])
    for (const m of moves) book.change(m.productId, { pending: -m.delta, reserved: -m.delta })
    await tx.pendingMovement.updateMany({ where: { id: { in: moves.map((m) => m.id) } }, data: { state: 'CANCELLED' } })
    await tx.reservation.updateMany({ where: { id: { in: res.map((r) => r.id) } }, data: { state: 'ACTIVE', invoiceId: null } })
    const definite = ctx.definite ?? true
    if (ctx.limit) {
      // limit wFirmy: dokument nie powstał, to nie błąd faktury — bez flagi i alertu, kolejka ponowi po wstrzymaniu
      await tx.invoiceAttempt.update({ where: { id: attemptId }, data: { state: 'FAILED', lastError: `${LIMIT_ERROR_PREFIX} ${message}`.slice(0, 2000), nextFindAt: null } })
      // ponowienie po „nie znaleziono po 3 próbach” trafiło na limit. Flaga z timeoutu zablokowałaby zamówienie
      // w `pendingInvoices`, choć to zwykła kolejna próba; błąd jednoznaczny zostaje dla obsługi
      const prev = await tx.invoiceAttempt.findFirst({
        where: { orderId: o.id, packageNo: a.packageNo, state: 'FAILED', id: { not: a.id }, NOT: { lastError: { startsWith: LIMIT_ERROR_PREFIX } } },
        orderBy: { attemptNo: 'desc' },
        select: { lastError: true },
      })
      if (flagsOf(o).fakturaBlad && prev?.lastError === INVOICE_NOT_FOUND) {
        await tx.order.update({ where: { id: o.id }, data: { flags: mergeFlags(o, { fakturaBlad: false, lastError: null }) } })
        await closeInvoiceAlerts(tx, o.id, now, true)
      }
    } else if (a.documentOnly && o.status === 'ANULOWANE') {
      // dokument zamówienia anulowanego w trakcie nie powstał — faktura nie jest już
      // potrzebna, więc bez flagi błędu i alertu (stan zwolnił rdzeń przy anulowaniu)
      await tx.invoiceAttempt.update({ where: { id: attemptId }, data: { state: 'FAILED', lastError: message.slice(0, 2000), nextFindAt: null } })
    } else {
      await tx.invoiceAttempt.update({ where: { id: attemptId }, data: { state: 'FAILED', lastError: message.slice(0, 2000), nextFindAt: null } })
      // także niejednoznaczny (timeout bez dokumentu): obsługa ma widzieć, że faktura nie wychodzi
      await tx.order.update({ where: { id: o.id }, data: { flags: mergeFlags(o, { fakturaBlad: true, lastError: message.slice(0, 500) }) } })
      const prefix = a.idExternal.slice(0, a.idExternal.lastIndexOf('/'))
      await alert(tx, 'FAKTURA_BLAD', o.id, `${definite ? 'Błąd' : 'Brak odpowiedzi'} przy wystawianiu faktury: ${message}`.slice(0, 1000), definite ? `faktura-blad:${a.idExternal}` : `faktura-niejednoznaczna:${prefix}`)
      await tx.orderEvent.create({ data: { orderId: o.id, kind: 'FAKTURA_BLAD', actorId: 'system:faktury', data: { idExternal: a.idExternal, definite } } })
    }
    // Anulowanie odłożone → tor „przed fakturą” (T5).
    if (o.pendingAction?.startsWith('CANCEL')) {
      await releaseOrder(tx, book, o.id, 'CANCELLED', now)
      const fresh = await tx.order.findUniqueOrThrow({ where: { id: o.id } })
      await tx.order.update({ where: { id: o.id }, data: { status: 'ANULOWANE', cancelReason: 'CANCELLED', pendingAction: null, flags: mergeFlags(fresh, { fakturaBlad: false }) } })
      await zwolnijKoszykPoStatusie(tx, o.id, 'ANULOWANE')
      await closeInvoiceAlerts(tx, o.id, now) // anulowane: faktura nie jest już potrzebna
      await tx.orderEvent.create({ data: { orderId: o.id, kind: 'ANULOWANE', actorId: 'system:faktury', data: { poFakturze: false } } })
      await forcePushForOrder(tx, o, now) // 6.1 pkt 4
    }
    await book.flush(tx, now)
  })
}

async function markUnknown(db: Db, attemptId: string, now: Date): Promise<void> {
  await db.invoiceAttempt.update({ where: { id: attemptId }, data: { state: 'UNKNOWN', nextFindAt: new Date(now.getTime() + FIND_SCHEDULE_MS[0]!), lastError: 'timeout' } })
}

/**
 * Pełny tor faktury dla spakowanego zamówienia: ruch przed żądaniem, żądanie poza transakcją, rozstrzygnięcie.
 * Wyjątek z adaptera traktujemy jak timeout (nie wiemy, czy dokument powstał) → rozstrzyga `invoices/find`.
 */
export async function issueInvoice(db: Db, orderId: string, wf: FakturyWfirma, ctx: QueueCtx = {}): Promise<InvoiceOutcome> {
  const now = ctx.now ?? new Date()
  return issueStarted(db, await beginInvoice(db, orderId, { ...ctx, now }), wf, ctx)
}

type Started = { outcome: 'START'; attemptId: string; idExternal: string; lines: InvoiceLine[]; paymentMethod: string } | { outcome: Exclude<InvoiceOutcome, 'WYSTAWIONA' | 'BLAD' | 'TIMEOUT' | 'LIMIT'> }

/**
 * Dokument sprzedaży bez rozchodu: magazyn prowadzi Kompletor (źródło KOMPLETOR), firma wystawia faktury
 * w wFirmie. Bez ruchu stanu i bez zmiany rezerwacji — stan schodzi wydaniem przy „Do wysyłki” (OWN_DISPATCH), dokument
 * to osobny tor przy statusie z „wystawiaj przy”. Pozycje jak faktura z rozchodem: zarezerwowany albo wydany towar
 * (rezerwacje ACTIVE i CONSUMED) plus usługi. Ten sam `InvoiceAttempt`, `id_external` i rozstrzyganie timeoutów przez find.
 */
export async function beginDocument(db: Db, orderId: string, ctx: Ctx & { statusy: readonly OrderStatus[] }): Promise<Started> {
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  return runTx(db, async (tx) => {
    const o = await lockOrder(tx, orderId)
    await tx.$queryRaw`SELECT 1 FROM "Warehouse" WHERE id = ${wh} FOR SHARE`
    if ((await zrodloStanu(tx, wh)) !== 'KOMPLETOR') return { outcome: 'INNE_ZRODLO' as const }
    const n = o.packageNo
    const attempts = await tx.invoiceAttempt.findMany({ where: { orderId, packageNo: n } })
    if (attempts.some((a) => a.state === 'ISSUED')) return { outcome: 'JUZ_WYSTAWIONA' as const }
    if (attempts.some((a) => a.state === 'SENDING' || a.state === 'UNKNOWN')) return { outcome: 'W_TOKU' as const }
    if (await pominPoFakturzeBl(tx, o, ctx)) return { outcome: 'FAKTURA_BL' as const }
    if (!ctx.statusy.includes(o.status)) return { outcome: 'POZA_MOMENTEM' as const }
    const counted = liczoneProby(o, attempts)
    if (counted.length >= MAX_INVOICE_ATTEMPTS) {
      await limitProb(tx, o, n, counted.length)
      return { outcome: 'LIMIT_PROB' as const }
    }
    const res = await tx.reservation.findMany({ where: { orderId, state: { in: ['ACTIVE', 'CONSUMED'] }, warehouseId: wh } })
    const lines = await buildInvoiceLines(tx, orderId, res)
    if (!lines.length) return { outcome: 'NIC_DO_FAKTURY' as const }
    const attemptNo = Math.max(0, ...attempts.map((a) => a.attemptNo)) + 1
    const idExternal = `${o.parentOrderId ?? orderId}/${n}/${attemptNo}`
    const attempt = await tx.invoiceAttempt.create({ data: { orderId, packageNo: n, attemptNo, idExternal, state: 'SENDING', documentOnly: true, payload: lines as unknown as Prisma.InputJsonValue } })
    return { outcome: 'START' as const, attemptId: attempt.id, idExternal, lines, paymentMethod: o.paymentState === 'COD' ? 'cod' : 'transfer' }
  })
}

export async function issueDocument(db: Db, orderId: string, wf: FakturyWfirma, ctx: QueueCtx & { statusy: readonly OrderStatus[] }): Promise<InvoiceOutcome> {
  const now = ctx.now ?? new Date()
  return issueStarted(db, await beginDocument(db, orderId, { ...ctx, now }), wf, ctx)
}

/**
 * „Ponów fakturę” z karty: zdejmuje błąd faktury bieżącej paczki i zaczyna nową serię prób (stare nieudane
 * nie liczą się do limitu). Wystawienie robi kolejka w najbliższym przebiegu — nic tu nie woła programu do faktur.
 * Odmowa, gdy faktura jest w toku albo wystawiona (druga faktura jest gorsza niż czekanie).
 */
export async function ponowFaktureRecznie(db: Db, orderId: string, ctx: Ctx = {}): Promise<void> {
  const now = ctx.now ?? new Date()
  await runTx(db, async (tx) => {
    const o = await lockOrder(tx, orderId)
    const attempts = await tx.invoiceAttempt.findMany({ where: { orderId, packageNo: o.packageNo } })
    if (attempts.some((a) => a.state === 'ISSUED')) throw new PackError('Faktura jest już wystawiona')
    if (attempts.some((a) => a.state === 'SENDING' || a.state === 'UNKNOWN')) throw new PackError('Faktura jest w toku: poczekaj na wynik (system sprawdza ją w programie do faktur)')
    // zamówienie z fakturą z BaseLinkera: kolejka i tak nie wystawi drugiej, więc odmowa z powodem zamiast ciszy
    const bl = await fakturaZBl(tx, o)
    if (bl !== null) throw new PackError(`Zamówienie ma już fakturę z BaseLinkera (${bl}): Kompletor nie wystawi drugiej. Gdy tej faktury w BaseLinkerze nie ma, wystaw fakturę ręcznie w programie do faktur.`)
    if (!flagsOf(o).fakturaBlad && !attempts.some((a) => a.state === 'FAILED')) throw new PackError('Ta faktura nie ma błędu do ponowienia')
    if (o.status === 'ANULOWANE') throw new PackError('Zamówienie jest anulowane')
    const po = Math.max(0, ...attempts.map((a) => a.attemptNo))
    await tx.order.update({ where: { id: orderId }, data: { flags: mergeFlags(o, { fakturaBlad: false, lastError: null, fakturaPonowionaPo: po }) } })
    await closeInvoiceAlerts(tx, orderId, now)
    await tx.orderEvent.create({ data: { orderId, kind: 'FAKTURA_PONOWIONA', actorId: ctx.actorId ?? 'panel', data: { poProbie: po } } })
  })
}

/** `ctx` jak od wołającego (bez wymuszonego `now`): chwila odpowiedzi z `ctx.clock`/`ctx.now`/zegara. */
async function issueStarted(db: Db, b: Started, wf: FakturyWfirma, ctx: QueueCtx): Promise<InvoiceOutcome> {
  if (b.outcome !== 'START') return b.outcome
  let r: IssueResult
  try {
    r = await wf.issue({ idExternal: b.idExternal, lines: b.lines, paymentMethod: b.paymentMethod })
  } catch {
    r = { kind: 'TIMEOUT' }
  }
  // (przegląd): effectiveAt = chwila PO odpowiedzi wFirmy. Odczyt wysłany w trakcie żądania (requestSentAt
  // między sentAt a odpowiedzią) nie może potwierdzić ruchu — mógł dostać stan sprzed faktury.
  const receivedAt = ctx.clock ? ctx.clock() : ctx.now ? ctx.now : new Date()
  if (r.kind === 'OK') {
    await completeInvoice(db, b.attemptId, r.docId, r.wz, { ...ctx, now: receivedAt, number: r.number ?? null })
    return 'WYSTAWIONA'
  }
  if (r.kind === 'ERROR') {
    await failInvoice(db, b.attemptId, r.message, { ...ctx, now: receivedAt, definite: true })
    return 'BLAD'
  }
  if (r.kind === 'LIMIT') {
    await failInvoice(db, b.attemptId, r.message, { ...ctx, now: receivedAt, limit: true })
    ctx.onLimit?.(r.retryAfterMs)
    return 'LIMIT'
  }
  await markUnknown(db, b.attemptId, receivedAt)
  return 'TIMEOUT'
}

/**
 * Sprzątacz: próba `SENDING` starsza niż 2 min to żądanie porzucone przez martwy worker
 * (commit przed żądaniem, brak odpowiedzi). Przechodzi w `UNKNOWN` — rozstrzyga ją `invoices/find` jak timeout.
 * Założenie: cały `issue` adaptera (zapis z limitem 60 s w `WfirmaZapis` plus odczyt WZ) trwa
 * krócej niż to okno. Dłuższy limit zapisu = najpierw wydłużyć okno, inaczej żywa próba stanie się niewiadomą.
 */
export async function reapStaleInvoices(db: Db, ctx: { now?: Date } = {}): Promise<number> {
  const now = ctx.now ?? new Date()
  const r = await db.invoiceAttempt.updateMany({
    where: { state: 'SENDING', createdAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
    data: { state: 'UNKNOWN', nextFindAt: now, lastError: 'porzucona (worker)' },
  })
  return r.count
}

/**
 * Rozstrzyganie faktur po timeoucie: `invoices/find` po prefiksie `<orderId>/<n>/` po 30 s, 2 min i 5 min.
 * Znaleziona → APPLIED; nieznaleziona po ostatniej próbie → CANCELLED i nowa próba z kolejnym numerem.
 * Więcej niż jedna faktura na `<orderId>/<n>` → alert „dublet” (raport dla biura).
 */
export async function resolveUnknownInvoices(db: Db, wf: FakturyWfirma, ctx: QueueCtx = {}): Promise<{ found: number; retried: number; waiting: number; errors: number }> {
  const now = ctx.now ?? new Date()
  const { budget } = ctx
  await reapStaleInvoices(db, { now })
  const due = await db.invoiceAttempt.findMany({ where: { state: 'UNKNOWN', nextFindAt: { lte: now } }, orderBy: { nextFindAt: 'asc' }, ...(budget ? { take: Math.max(0, budget.left) } : {}) })
  const stats = { found: 0, retried: 0, waiting: 0, errors: 0 }
  for (const a of due) {
    // ostatnia próba `find` może pociągnąć ponowienie faktury (2 wywołania). Bez budżetu na oba próba czeka na
    // następny przebieg: inaczej `failInvoice` bez ponowienia zostawiłby zamówienie z flagą błędu
    const last = a.findTries + 1 >= FIND_SCHEDULE_MS.length
    if (budget && budget.left < (last ? 2 : 1)) break
    budget?.take()
    try {
      const prefix = a.idExternal.slice(0, a.idExternal.lastIndexOf('/') + 1) // <orderId>/<n>/
      const found = validateFound(prefix, await wf.findByPrefix(prefix))
      if (found.length > 1)
        await alert(db, 'DUBLET_FAKTURY', a.orderId, `Więcej niż jedna faktura dla ${prefix}: ${found.map((f) => f.docId).join(', ')} — korekta przez biuro`, `dublet:${prefix}`)
      if (found.length) {
        // effectiveAt = start przebiegu: faktura istniała już przed find, więc ta chwila jest bezpiecznie po jej wystawieniu
        await completeInvoice(db, a.id, found[0]!.docId, found[0]!.wz, { ...ctx, now, number: found[0]!.number ?? null })
        stats.found++
        continue
      }
      const tries = a.findTries + 1
      if (tries >= FIND_SCHEDULE_MS.length) {
        await failInvoice(db, a.id, INVOICE_NOT_FOUND, { ...ctx, now, definite: false })
        const o = await db.order.findUniqueOrThrow({ where: { id: a.orderId } })
        if (!a.documentOnly && o.status !== 'SPAKOWANE') continue // w międzyczasie anulowane (tor „przed fakturą”)
        if (a.documentOnly && (o.status === 'ANULOWANE' || !ctx.dokumentStatusy?.includes(o.status))) continue
        budget?.take()
        let retryAfterMs: number | undefined
        const again = a.documentOnly
          ? await issueDocument(db, a.orderId, wf, { ...ctx, now, statusy: ctx.dokumentStatusy ?? [], onLimit: (ms) => (retryAfterMs = ms) })
          : await issueInvoice(db, a.orderId, wf, { ...ctx, now, onLimit: (ms) => (retryAfterMs = ms) })
        if (again === 'LIMIT') throw new WfirmaLimitError('limit wFirmy przy ponowieniu faktury', retryAfterMs)
        if (again === 'WYSTAWIONA' || again === 'TIMEOUT') stats.retried++
        continue
      }
      const base = a.nextFindAt!.getTime() - FIND_SCHEDULE_MS[a.findTries]!
      await db.invoiceAttempt.update({ where: { id: a.id }, data: { findTries: tries, nextFindAt: new Date(base + FIND_SCHEDULE_MS[tries]!) } })
      stats.waiting++
    } catch (e) {
      if (e instanceof WfirmaLimitError) throw e // kolejka wstrzymuje całą firmę; próba zostaje UNKNOWN
      stats.errors++
      await db.invoiceAttempt.update({ where: { id: a.id }, data: { lastError: (e as Error).message.slice(0, 1000) } }).catch(() => {})
      if (e instanceof FindValidationError) await alert(db, 'WFIRMA_FIND_FILTR', a.orderId, e.message, `find-filtr:${a.idExternal}`)
    }
  }
  return stats
}

/** „Wyślij bez faktury” (decyzja obsługi przy uporczywym błędzie): CONSUMED + ruch MANUAL do kliknięcia biura. */
export async function shipWithoutInvoice(db: Db, orderId: string, ctx: Ctx = {}): Promise<void> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  await runTx(db, async (tx) => {
    const o = await lockOrder(tx, orderId)
    if (o.status !== 'SPAKOWANE') throw new PackError(`„Wyślij bez faktury” tylko dla spakowanego (jest ${o.status})`)
    if (await tx.invoiceAttempt.count({ where: { orderId, state: { in: ['SENDING', 'UNKNOWN', 'ISSUED'] }, packageNo: o.packageNo } }))
      throw new PackError('Faktura w toku albo wystawiona')
    const res = await tx.reservation.findMany({ where: { orderId, state: 'ACTIVE', warehouseId: wh } })
    const book = await StockBook.lock(tx, wh, res.map((r) => r.productId))
    const per = new Map<string, number>()
    for (const r of res) per.set(r.productId, (per.get(r.productId) ?? 0) + r.qtyBase)
    for (const [productId, qty] of per) {
      book.change(productId, { reserved: -qty, pending: -qty })
      await tx.pendingMovement.create({
        data: { productId, warehouseId: wh, delta: -qty, type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL', sentAt: now, effectiveAt: now, wzQty: 0, orderId, idempotencyKey: `bez-dokumentu:${orderId}:${o.packageNo}:${productId}` },
      })
    }
    await tx.reservation.updateMany({ where: { id: { in: res.map((r) => r.id) } }, data: { state: 'CONSUMED', consumedAt: now } })
    await tx.order.update({ where: { id: orderId }, data: { status: 'DO_WYSLANIA', flags: mergeFlags(o, { wydaneBezDokumentu: true }) } })
    await zwolnijKoszykPoStatusie(tx, orderId, 'DO_WYSLANIA')
    // przy włączonym WZ z Kompletora biuro nie wystawia dokumentu równolegle (dubel w wFirmie)
    const wzOd = chwilaAutomatuWz((await tx.organization.findFirst({ select: { settings: true } }))?.settings ?? null)
    const tresc =
      wzOd && now >= wzOd && wh === DEFAULT_WAREHOUSE
        ? 'Wydane bez faktury. Kompletor wystawi dokument WZ w wFirmie w ciągu kilku minut: nie wystawiaj go ręcznie. Jeśli się nie uda, dostaniesz osobny alert.'
        : 'Wydane bez dokumentu w wFirmie. Wystaw dokument w wFirmie i kliknij „Dokument wystawiony” (Zamówienia → numer zamówienia → sekcja „Dokument sprzedaży”).'
    await alert(tx, 'WYDANE_BEZ_DOKUMENTU', orderId, tresc, `bez-dokumentu:${orderId}:${o.packageNo}`)
    await book.flush(tx, now)
  })
}

/**
 * Biuro klika „poprawione” / „dokument wystawiony” przy ruchu MANUAL: ruch → APPLIED z effectiveAt = now
 * i zlecony odczyt goods/get. Potwierdza go dopiero odczyt wysłany po kliknięciu (2.2 pkt 5).
 */
export async function officeConfirmManual(db: Db, movementId: string, ctx: Ctx = {}): Promise<void> {
  const now = ctx.now ?? new Date()
  await runTx(db, (tx) => officeConfirmManualInTx(tx, movementId, now, ctx.actorId ?? 'panel').then(() => undefined))
}

/** Rodzaje alertów „wydane bez dokumentu” i WZ z programu, które zamyka ostatni potwierdzony ruch zamówienia. */
const ALERTY_BEZ_DOKUMENTU = ['WYDANE_BEZ_DOKUMENTU', 'WZ_BLAD', 'WZ_NIEWIADOMA']

/** Jak `officeConfirmManual`, w transakcji wołającego; true = ruch zamknięty (był MANUAL). `wfirmaDocId`: numer dokumentu
 * w wFirmie, pod którym znalazło się WZ (faktura BL rozliczona po późniejszym odczycie numeru), zapisany w ruchu. */
async function officeConfirmManualInTx(tx: Tx, movementId: string, now: Date, actorId: string, wfirmaDocId?: string): Promise<boolean> {
  const m0 = await tx.pendingMovement.findUniqueOrThrow({ where: { id: movementId } })
  await StockBook.lock(tx, m0.warehouseId, [m0.productId]) // ten sam wiersz co odczyt wFirmy
  const m = await tx.pendingMovement.findUniqueOrThrow({ where: { id: movementId } })
  if (m.state !== 'MANUAL') return false
  await tx.pendingMovement.update({ where: { id: m.id }, data: { state: 'APPLIED', effectiveAt: now, wzQty: -m.delta, nextWzReadAt: null, ...(wfirmaDocId ? { wfirmaDocId } : {}) } })
  await outbox(tx, 'WFIRMA_READ', m.productId, now)
  await tx.auditLog.create({ data: { entity: 'PendingMovement', entityId: m.id, actorId, before: { state: 'MANUAL' }, after: { state: 'APPLIED', effectiveAt: now.toISOString(), ...(wfirmaDocId ? { wfirmaDocId } : {}) } } })
  // ostatni ruch „wydane bez dokumentu” zamówienia potwierdzony = alerty zamówienia
  // o brakującym dokumencie i WZ zamknięte (z `dedupeKey = null`, żeby nie wisiały w digeście ani nie blokowały)
  if (m.type === 'ISSUED_WITHOUT_DOCUMENT' && m.orderId && !(await tx.pendingMovement.count({ where: { orderId: m.orderId, type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL' } })))
    await tx.alert.updateMany({ where: { kind: { in: ALERTY_BEZ_DOKUMENTU }, ref: m.orderId, closedAt: null }, data: { closedAt: now, dedupeKey: null } })
  // ostatnia pozycja faktury bez WZ zamknięta = alert „faktura bez WZ” tej faktury zamknięty (ten sam wzór co wyżej)
  if ((m.type === 'BL_INVOICE' || m.type === 'OWN_INVOICE') && m.wfirmaDocId && !(await tx.pendingMovement.count({ where: { wfirmaDocId: m.wfirmaDocId, type: m.type, state: 'MANUAL' } })))
    await tx.alert.updateMany({ where: { kind: 'FAKTURA_BEZ_WZ', dedupeKey: `faktura-bez-wz:${m.wfirmaDocId}`, closedAt: null }, data: { closedAt: now, dedupeKey: null } })
  return true
}

/** Wynik „Poprawione w wFirmie”: ZAMKNIETE = pozycja zamknięta teraz, JUZ_ZAMKNIETE = ktoś (albo automat) zamknął ją wcześniej. */
export type WynikPoprawione = 'ZAMKNIETE' | 'JUZ_ZAMKNIETE'

/** Powód, dla którego biuro nie zamyka pozycji „wydane bez dokumentu” ręcznie: WZ wystawi automat. */
export const POWOD_AUTOMAT_WZ = 'Kompletor wystawi WZ sam'

/**
 * Czy pozycję „wydane bez dokumentu” obejmie automat WZ (te same warunki co przebieg WZ przy wysyłce bez faktury: klucz
 * wysyłki z Kompletora, główny magazyn, wysyłka od chwili włączenia automatu) i nie ma otwartego alertu o błędzie albo
 * niepewnym wyniku WZ tego zamówienia. Wtedy kliknięcie przed przebiegiem zamknęłoby pozycję bez dokumentu w wFirmie.
 */
async function automatWzWystawiSam(tx: Tx, m: RuchDlaAutomatuWz): Promise<boolean> {
  const od = chwilaAutomatuWz((await tx.organization.findFirst({ select: { settings: true } }))?.settings ?? null)
  if (!automatWzObejmie(m, od)) return false
  return !(await tx.alert.count({ where: { ref: m.orderId!, closedAt: null, kind: { in: ALERTY_BLEDU_WZ } } }))
}

/** Alerty o błędzie albo niepewnym wyniku WZ zamówienia: przy otwartym biuro zamyka pozycję samo. */
export const ALERTY_BLEDU_WZ = ['WZ_BLAD', 'WZ_NIEWIADOMA']

export type RuchDlaAutomatuWz = { type: string; state: string; warehouseId: string; idempotencyKey: string; sentAt: Date; orderId: string | null }

/** Czysta część warunku (bez alertów): pozycja w zakresie automatu WZ włączonego od chwili `od` (`chwilaAutomatuWz`). */
export function automatWzObejmie(m: RuchDlaAutomatuWz, od: Date | null): boolean {
  if (m.type !== 'ISSUED_WITHOUT_DOCUMENT' || m.state !== 'MANUAL' || m.warehouseId !== DEFAULT_WAREHOUSE || !m.orderId || !m.idempotencyKey.startsWith('bez-dokumentu:')) return false
  return !!od && m.sentAt >= od
}

/** Skutek kliknięcia „Poprawione w wFirmie” liczony z bieżącego stanu (okno potwierdzenia). */
export interface SkutekPoprawionego {
  rodzaj: string
  /** ilość pozycji w jednostce bazowej (dodatnia) */
  ilosc: number
  jednostka: Unit
  /** stan z ostatniego odczytu wFirmy */
  wfirma: number
  dostepnyPrzed: number
  /** dostępny po odczycie wFirmy, gdy stan w wFirmie się nie zmieni */
  dostepnyPo: number
  /** faktura bez WZ (albo z WZ na część ilości) w wFirmie: numer dokumentu z pozycji */
  fakturaBezWz: string | null
  /** powód, dla którego przycisk nie zamyka pozycji (np. WZ wystawi automat) */
  blokada: string | null
}

/**
 * Dane do okna potwierdzenia „Poprawione w wFirmie”, z bieżącego stanu bazy (nie z danych strony): o ile wzrośnie stan
 * dostępny, gdy stan w wFirmie się nie zmieni, i czy Kompletor wie, że dokumentu w wFirmie brakuje. null = pozycja
 * nieznana albo już zamknięta.
 */
export async function skutekPoprawionego(db: Db, movementId: string): Promise<SkutekPoprawionego | null> {
  return runTx(db, async (tx) => {
    const m = await tx.pendingMovement.findUnique({ where: { id: movementId } })
    if (!m || m.state !== 'MANUAL') return null
    const [s, p] = await Promise.all([
      tx.stock.findUnique({ where: { productId_warehouseId: { productId: m.productId, warehouseId: m.warehouseId } }, select: { physical: true, reserved: true, wfirmaCount: true } }),
      tx.product.findUnique({ where: { id: m.productId }, select: { unit: true } }),
    ])
    const physical = s?.physical ?? 0
    const reserved = s?.reserved ?? 0
    const ilosc = -m.delta
    const faktura = m.type === 'BL_INVOICE' || m.type === 'OWN_INVOICE'
    return {
      rodzaj: m.type,
      ilosc,
      jednostka: p?.unit ?? 'SZT',
      wfirma: s?.wfirmaCount ?? 0,
      dostepnyPrzed: Math.max(0, physical - reserved),
      dostepnyPo: Math.max(0, physical + ilosc - reserved),
      fakturaBezWz: faktura ? (m.wfirmaDocId ?? '') : null,
      blokada: (await automatWzWystawiSam(tx, m)) ? POWOD_AUTOMAT_WZ : null,
    }
  })
}

/**
 * Przycisk „Poprawione w wFirmie” na liście Braki towaru → „Do poprawy w wFirmie”: biuro poprawiło dokumenty w wFirmie
 * (faktura z WZ, WZ do faktury, RW), więc pozycja MANUAL przestaje pomniejszać stan. Ruch → APPLIED i zlecony odczyt
 * stanu z wFirmy (`officeConfirmManualInTx`); stan w Kompletorze wraca do stanu z wFirmy po tym odczycie. Nic nie idzie
 * do wFirmy, BaseLinkera ani sklepów; działa tak samo na kontach w podglądzie. Wpis w historii zamówienia (gdy pozycja
 * ma zamówienie) i w dzienniku zmian z osobą. Drugie kliknięcie (albo kliknięcie po zamknięciu przez automat) nic nie
 * zmienia i zwraca JUZ_ZAMKNIETE. Nieznana pozycja = PackError.
 */
export async function potwierdzPoprawioneWWfirmie(db: Db, movementId: string, ctx: Ctx = {}): Promise<WynikPoprawione> {
  const now = ctx.now ?? new Date()
  const actorId = ctx.actorId ?? 'panel'
  return runTx(db, async (tx) => {
    const m = await tx.pendingMovement.findUnique({ where: { id: movementId }, select: { id: true, orderId: true, type: true, delta: true, wfirmaDocId: true } })
    if (!m) throw new PackError('Nie ma takiej pozycji do poprawy.')
    if (m.orderId) await lockOrder(tx, m.orderId)
    // za blokadą zamówienia, ze świeżego odczytu: pozycję obejmie automat WZ, więc ręczne zamknięcie zostawiłoby wydanie bez dokumentu
    const teraz = await tx.pendingMovement.findUniqueOrThrow({ where: { id: m.id } })
    if (await automatWzWystawiSam(tx, teraz)) throw new PackError(`${POWOD_AUTOMAT_WZ}: dokument powstanie w wFirmie w ciągu kilku minut, nie zamykaj tej pozycji ręcznie.`)
    if (!(await officeConfirmManualInTx(tx, m.id, now, actorId))) return 'JUZ_ZAMKNIETE'
    if (m.orderId) await tx.orderEvent.create({ data: { orderId: m.orderId, kind: 'POPRAWIONE_W_WFIRMIE', actorId, data: { ruch: m.id, rodzaj: m.type, ilosc: -m.delta, ...(m.wfirmaDocId ? { dokument: m.wfirmaDocId } : {}) } } })
    return 'ZAMKNIETE'
  })
}

/**
 * Faktura BL rozliczona bez WZ (ruchy BL_INVOICE w MANUAL pod numerem `docOld`), a później WZ znalazło się w wFirmie pod
 * numerem `docNew` (BL dopisał numer wFirmy po skopiowaniu faktury). Rozliczenie jak przy zwykłej fakturze z WZ: ruch
 * pokryty przez WZ w całości → APPLIED z wzQty = ilość, numer wFirmy w ruchu i zlecony odczyt stanu; stan potwierdza
 * dopiero odczyt wFirmy po tej chwili, więc sztuka nie schodzi drugi raz (WZ jest już w stanie wFirmy). Pozycje bez
 * WZ (albo z WZ na część) zostają MANUAL. Zwraca liczbę zamkniętych ruchów; 0 = nic do zrobienia (idempotentnie).
 */
export async function rozliczPozneWzFakturyBl(db: Db, orderId: string, docOld: string, docNew: string, wz: Record<string, number | null>, ctx: Ctx = {}): Promise<number> {
  const now = ctx.now ?? new Date()
  const actorId = ctx.actorId ?? 'system:cien-bl'
  return runTx(db, async (tx) => {
    await lockOrder(tx, orderId)
    const moves = await tx.pendingMovement.findMany({ where: { orderId, wfirmaDocId: docOld, type: 'BL_INVOICE', state: 'MANUAL' }, orderBy: { id: 'asc' } })
    const left = new Map<string, number>()
    for (const [productId, n] of Object.entries(wz)) left.set(productId, Math.max(0, n ?? 0))
    // Ruchy tego zamówienia rozliczone już tym dokumentem (wcześniejszy przebieg albo nowa rezerwacja rozliczona tym WZ,
    // pod starym albo nowym numerem) zużyły część WZ: bez tego ta sama sztuka z WZ zamknęłaby drugi ruch (zawyżony stan).
    // Ruch bez odczytanego WZ liczony pełną ilością, żeby nie zawyżyć.
    const juz = await tx.pendingMovement.findMany({ where: { orderId, type: 'BL_INVOICE', wfirmaDocId: { in: [docOld, docNew] }, state: { in: ['APPLIED', 'CONFIRMED'] } }, select: { productId: true, delta: true, wzQty: true } })
    for (const j of juz) left.set(j.productId, Math.max(0, (left.get(j.productId) ?? 0) - (j.wzQty ?? -j.delta)))
    let done = 0
    for (const m of moves) {
      const have = left.get(m.productId) ?? 0
      if (have < -m.delta) continue
      if (!(await officeConfirmManualInTx(tx, m.id, now, actorId, docNew))) continue
      left.set(m.productId, have + m.delta)
      done++
    }
    if (done) await tx.orderEvent.create({ data: { orderId, kind: 'WZ_PO_NUMERZE_WFIRMY', actorId, data: { faktura: docOld, numerWfirmy: docNew, ruchy: done } } })
    return done
  })
}

/**
 * przycisk „Dokument wystawiony” na karcie zamówienia (sekcja „Dokument sprzedaży”).
 * Biuro wystawiło dokument w programie do faktur ręcznie (albo sprawdziło, że WZ z Kompletora jednak powstało):
 * wszystkie ruchy „wydane bez dokumentu” zamówienia → APPLIED z odczytem stanu, alerty zamknięte, wpis w historii
 * zamówienia i w dzienniku zmian (każdy ruch). Nic nie idzie do programu. Zwraca liczbę zamkniętych ruchów; 0 = nie
 * było czego potwierdzać (PackError).
 */
export async function potwierdzDokumentWystawiony(db: Db, orderId: string, ctx: Ctx = {}): Promise<number> {
  const now = ctx.now ?? new Date()
  const actorId = ctx.actorId ?? 'panel'
  const n = await runTx(db, async (tx) => {
    if (!(await tx.order.findUnique({ where: { id: orderId }, select: { id: true } }))) return 0
    await lockOrder(tx, orderId)
    const moves = await tx.pendingMovement.findMany({ where: { orderId, type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL' }, orderBy: { id: 'asc' }, select: { id: true } })
    let done = 0
    for (const m of moves) if (await officeConfirmManualInTx(tx, m.id, now, actorId)) done++
    if (done) await tx.orderEvent.create({ data: { orderId, kind: 'DOKUMENT_WYSTAWIONY_RECZNIE', actorId, data: { ruchy: done } } })
    return done
  })
  if (!n) throw new PackError('To zamówienie nie ma pozycji „wydane bez dokumentu” do potwierdzenia.')
  return n
}

// ─── Wydanie z magazynu prowadzonego przez Kompletor ───────────────

/**
 * Źródło stanu KOMPLETOR: przy „Do wysyłki / Do odbioru” rezerwacje ACTIVE → CONSUMED, stan fizyczny −ilość w tej samej
 * transakcji (ruch OWN_DISPATCH w historii), `available` bez zmian. Bez ruchu MANUAL, alertu i odczytu wFirmy: nikt
 * poza Kompletorem stanu nie prowadzi, więc nie ma czego potwierdzać. Zestawy mają rezerwacje na składnikach, więc
 * schodzą składniki (jak w fakturze). `wfirmaCount` (w tym magazynie: stan bazowy) zmienia się o tę samą ilość, żeby
 * zachować niezmiennik physical = wfirmaCount + pendingDelta (jak korekta stanu z panelu, lib/kanaly/korekta-stanu.ts).
 * Woła ją `moveOrderInTx` pod blokadą zamówienia; zwraca liczbę wydanych sztuk (jednostka bazowa).
 */
export async function wydajZMagazynuWlasnegoInTx(tx: Tx, o: Pick<Order, 'id' | 'packageNo'>, now: Date, actorId: string): Promise<number> {
  const res = await tx.reservation.findMany({ where: { orderId: o.id, state: 'ACTIVE' }, orderBy: { id: 'asc' } })
  if (!res.length) return 0
  let units = 0
  for (const wh of [...new Set(res.map((r) => r.warehouseId))].sort()) {
    const mine = res.filter((r) => r.warehouseId === wh)
    // każdy magazyn rezerwacji osobno — z magazynu lustra wFirmy towar schodzi tylko fakturą z WZ
    if ((await zrodloStanu(tx, wh)) !== 'KOMPLETOR') throw new Error(`wydanie z magazynu ${wh}: stan prowadzi wFirma, rozchód tylko fakturą`)
    const book = await StockBook.lock(tx, wh, mine.map((r) => r.productId))
    const per = new Map<string, number>()
    for (const r of mine) per.set(r.productId, (per.get(r.productId) ?? 0) + r.qtyBase)
    for (const [productId, qty] of [...per].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const before = book.get(productId)
      if (!before) throw new Error(`brak wiersza stanu dla ${productId} w magazynie ${wh}`)
      book.change(productId, { reserved: -qty, physical: -qty })
      book.set(productId, { wfirmaCount: before.wfirmaCount - qty })
      await tx.stockMovement.create({ data: { productId, warehouseId: wh, deltaPhysical: -qty, source: 'OWN_DISPATCH', reason: `wydanie zamówienia (paczka ${o.packageNo})`, actorId, orderId: o.id } })
      units += qty
      // nadmiar rezerwacji dał ujemny stan po wydaniu — w magazynie Kompletora poprawia go tylko korekta z panelu
      const after = book.get(productId)!
      if (after.physical < 0) await alert(tx, 'STAN_UJEMNY_PO_WYDANIU', productId, `Stan po wydaniu zamówienia ujemny (${after.physical}): przelicz półkę i popraw stan korektą na karcie produktu`, `stan-ujemny:${wh}:${productId}:${o.id}:${o.packageNo}`) // jeden alert na wydanie, nie raz na zawsze
    }
    await tx.reservation.updateMany({ where: { id: { in: mine.map((r) => r.id) } }, data: { state: 'CONSUMED', consumedAt: now } })
    await book.flush(tx, now)
  }
  return units
}

// ─── Tryb cienia: faktura BL (9.1) ───────────────────────────────────────────

/**
 * Zamówienie dostało fakturę w BL (numer z wFirmy): rezerwacje CONSUMED, ruch BL_INVOICE APPLIED z wzQty
 * z invoices/get, effectiveAt = chwila, gdy zobaczyliśmy fakturę. Ruch ISSUED_WITHOUT_DOCUMENT (BL „Wysłane”
 * bez faktury) zamienia się w BL_INVOICE.
 */
export async function applyBlInvoice(db: Db, orderId: string, docId: string, wz: Record<string, number | null>, ctx: Ctx = {}): Promise<void> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  await runTx(db, async (tx) => {
    const o = await lockOrder(tx, orderId)
    const res = await tx.reservation.findMany({ where: { orderId, state: 'ACTIVE', warehouseId: wh } })
    const withoutDoc = await tx.pendingMovement.findMany({ where: { orderId, type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL' } })
    const book = await StockBook.lock(tx, wh, [...res.map((r) => r.productId), ...withoutDoc.map((m) => m.productId)])
    const per = new Map<string, number>()
    for (const r of res) per.set(r.productId, (per.get(r.productId) ?? 0) + r.qtyBase)
    const already = new Set((await tx.pendingMovement.findMany({ where: { wfirmaDocId: docId, type: 'BL_INVOICE' }, select: { productId: true } })).map((m) => m.productId))
    const moved = new Set<string>()
    for (const [productId, qty] of per) {
      if (already.has(productId)) continue // ta sama faktura BL przetworzona ponownie (5.2: konflikt = sukces)
      book.change(productId, { reserved: -qty, pending: -qty })
      const got = Math.max(0, Math.min(qty, wz[productId] ?? 0))
      await tx.pendingMovement.create({
        data: { productId, warehouseId: wh, delta: -qty, type: 'BL_INVOICE', state: got === qty ? 'APPLIED' : 'MANUAL', sentAt: now, effectiveAt: now, wzQty: got, wfirmaDocId: docId, orderId, idempotencyKey: `bl:${docId}:${productId}` },
      })
      moved.add(productId)
    }
    for (const m of withoutDoc) {
      const got = Math.max(0, Math.min(-m.delta, wz[m.productId] ?? 0))
      await tx.pendingMovement.update({ where: { id: m.id }, data: { type: 'BL_INVOICE', state: got === -m.delta ? 'APPLIED' : 'MANUAL', effectiveAt: now, wzQty: got, wfirmaDocId: docId } })
      moved.add(m.productId)
    }
    // odczyt celowany goods/get po fakturze BL (jak `completeInvoice`) — ruch APPLIED potwierdza tylko odczyt
    // wFirmy wysłany po `effectiveAt`. Raz na produkt, tylko dla produktów z ruchem w tej transakcji (nie dla pozycji
    // pominiętych przez `already` przy ponownym przetworzeniu tej samej faktury).
    for (const productId of [...moved].sort()) await outbox(tx, 'WFIRMA_READ', productId, now)
    await tx.reservation.updateMany({ where: { id: { in: res.filter((r) => !already.has(r.productId)).map((r) => r.id) } }, data: { state: 'CONSUMED', consumedAt: now } })
    // faktura BL obejmuje całe zamówienie: otwarte braki (sprzed faktury) wyszły razem z nim (WZ do faktury), nie
    // czekają na dostawę. Inaczej przydział dostawy zarezerwowałby towar drugi raz, a drugiego dokumentu do tego
    // zamówienia Kompletor nie wystawi. W każdym trybie konta: w podglądzie obok BL wszystkie (resztę i tak rozlicza
    // samonaprawa); w trybie pracy tylko braki, których ilość pokrywa WZ do faktury po rozliczeniu rezerwacji i ruchów
    // bez dokumentu. Brak niepokryty zostaje otwarty i idzie do biura alertem.
    let pokrycie: Map<string, number> | undefined
    if (!(await kontoWPodgladzie(tx, o))) {
      pokrycie = new Map<string, number>()
      for (const [productId, n] of Object.entries(wz)) pokrycie.set(productId, Math.max(0, n ?? 0))
      for (const [productId, qty] of per) pokrycie.set(productId, (pokrycie.get(productId) ?? 0) - qty)
      for (const m of withoutDoc) pokrycie.set(m.productId, (pokrycie.get(m.productId) ?? 0) + m.delta)
    }
    const braki = await brakiJakoWydanePoFakturzeBlInTx(tx, o.id, docId, now, pokrycie)
    if (braki.zostawione) await zglosTowarPoFakturzeBl(tx, o)
    // tryb pracy, zamówienie w kolejce pakowania. Faktura BL zobaczona po przełączeniu (ręczna w BL
    // albo spóźniona para) zużyła rezerwacje: bez alertu zamówienie wyglądałoby na „Nic do spakowania”. Pakowanie
    // i tak odmawia (`blokadaPakowaniaFakturaBl`); alert mówi biuru, co z nim zrobić. Podgląd: bez zmian.
    if (pokrycie && !flagsOf(o).pakujMimoFakturyBl) {
      // dokument sprzedaży z Kompletora w toku albo wystawiony: dwie faktury na jedno zamówienie, rozstrzyga biuro
      const wlasny = await tx.invoiceAttempt.count({ where: { orderId: o.id, state: { in: ['SENDING', 'UNKNOWN', 'ISSUED'] } } })
      if (wlasny && o.status !== 'ANULOWANE') await zglosDwieFaktury(tx, o, docId)
      else if ((PRZED_SPAKOWANIEM as readonly string[]).includes(o.status)) await zglosFaktureBlWKolejce(tx, o, docId)
      // już spakowane (okno odczytu faktur albo spóźniona para): paczka wychodzi z Kompletora, dokument z BaseLinkera
      else if (o.status === 'SPAKOWANE') await zglosFaktureBlPoSpakowaniu(tx, o, docId)
    }
    for (const productId of braki.produkty.filter((p) => !moved.has(p))) await outbox(tx, 'WFIRMA_READ', productId, now)
    await tx.orderEvent.create({ data: { orderId: o.id, kind: 'FAKTURA_BL', actorId: 'system:cien-bl', data: { docId } } })
    await book.flush(tx, now)
  })
}

/** Cień: zamówienie BL „Wysłane” bez faktury → CONSUMED + ISSUED_WITHOUT_DOCUMENT (MANUAL) w raporcie. */
export async function applyBlShippedWithoutInvoice(db: Db, orderId: string, ctx: Ctx = {}): Promise<void> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  await runTx(db, async (tx) => {
    const o = await lockOrder(tx, orderId)
    const res = await tx.reservation.findMany({ where: { orderId, state: 'ACTIVE', warehouseId: wh } })
    const book = await StockBook.lock(tx, wh, res.map((r) => r.productId))
    const per = new Map<string, number>()
    for (const r of res) per.set(r.productId, (per.get(r.productId) ?? 0) + r.qtyBase)
    for (const [productId, qty] of per) {
      book.change(productId, { reserved: -qty, pending: -qty })
      await tx.pendingMovement.create({
        data: { productId, warehouseId: wh, delta: -qty, type: 'ISSUED_WITHOUT_DOCUMENT', state: 'MANUAL', sentAt: now, effectiveAt: now, wzQty: 0, orderId, idempotencyKey: `bl-bez-faktury:${orderId}:${productId}` },
      })
    }
    await tx.reservation.updateMany({ where: { id: { in: res.map((r) => r.id) } }, data: { state: 'CONSUMED', consumedAt: now } })
    await alert(tx, 'WYDANE_BEZ_DOKUMENTU', o.id, 'BL: zamówienie wysłane bez faktury', `bl-bez-faktury:${o.id}`)
    await book.flush(tx, now)
  })
}

/**
 * Korekta faktury (zwrot na stan) po odpowiedzi wFirmy: tylko wpis w historii i zlecony goods/get.
 * Bez ruchu dodatniego w `pendingDelta` (2.2 pkt 3, uwaga 1 z rundy 3): wzrost pokaże odczyt i przejdzie przez allocate.
 */
export async function recordCorrection(db: Db, orderId: string, docId: string, items: { productId: string; qty: number }[], ctx: Ctx = {}): Promise<void> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  await runTx(db, async (tx) => {
    for (const it of items) {
      await tx.stockMovement.create({
        data: { productId: it.productId, warehouseId: wh, deltaPhysical: 0, source: 'OWN_CORRECTION', reason: `korekta ${docId}: +${it.qty} (stan pokaże odczyt wFirmy)`, actorId: ctx.actorId ?? 'panel', orderId },
      })
      await outbox(tx, 'WFIRMA_READ', it.productId, now)
    }
    await tx.orderEvent.create({ data: { orderId, kind: 'KOREKTA', actorId: ctx.actorId ?? 'panel', data: { docId, items } } })
  })
}
