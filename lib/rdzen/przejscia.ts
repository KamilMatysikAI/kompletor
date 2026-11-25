// Przejścia statusów z ekranów zbierania, pakowania i wysyłki (spec 7, T7–T13). Każde przejście: blokada doradcza
// zamówienia → `assertTransition` (tabela statusy.ts) → warunki przejścia → zapis statusu i historii. T9 (spakowanie)
// robi `packOrder` w rozchod.ts, bo zamyka braki; reszta tutaj. Przy źródle stanu wFirmy stan magazynu się tu nie zmienia
// (rozchód idzie fakturą), więc bez blokad Stock — wyjątki: cofnięcie zbierania budzi przydział dla braków
// (`hintAllocate`), a w magazynie prowadzonym przez Kompletor „Do wysyłki / Do odbioru” zdejmuje stan
// (`wydajZMagazynuWlasnegoInTx`, blokady Stock po blokadzie zamówienia, jak w całym rdzeniu).
import type { Order, OrderStatus } from '@prisma/client'
import { dokumentPrzedWydaniem, parseUstawieniaDokumentow } from '../dokumenty/ustawienia'
import { hintAllocate, mergeFlags } from './rezerwacja'
import { wydajZMagazynuWlasnegoInTx } from './rozchod'
import { advisoryLock, type Db, DEFAULT_WAREHOUSE, orderLockKey, runTx, type Tx } from './stan'
import { zrodloStanu } from './zrodlo-stanu'
import { fakturyWWalucie, obcaWaluta, walutaCzekaNaPonowieniePoId, walutaZamowieniaPoId } from './waluta'
import { zwolnijKoszykPoStatusie } from '../koszyki/zwolnienie'
import { assertTransition, TransitionError } from './statusy'
import type { Ctx } from './zamowienia'

export interface MoveCtx extends Ctx {
  /** Numer nadania (T12) — tylko do historii; dane przesyłki i etykiety to adapter przewoźnika (F2). */
  trackingNo?: string
  /** Numer wydruku karty, który rozpoczął zbieranie (T7) — tylko do historii. */
  printNo?: number
}

export async function lockOrder(tx: Tx, orderId: string): Promise<Order> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
  await advisoryLock(tx, orderLockKey(o))
  return tx.order.findUniqueOrThrow({ where: { id: orderId } })
}

/**
 * Statusy, na które przechodzi się z ekranów tą funkcją. Reszta ma własne funkcje rdzenia, bo zmienia rezerwacje
 * albo stan: SPAKOWANE → `packOrder`, ANULOWANE → `cancelOrder`, wyjście z DO_WYJASNIENIA → `resolveClarification`,
 * opłacenie NOWE → `markPaid`. DO_REALIZACJI tylko jako cofnięcie zbierania.
 */
const SCREEN_TARGETS: OrderStatus[] = ['ZBIERANIE', 'ZEBRANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE', 'DO_REALIZACJI']

/**
 * Fakty zamówienia, od których zależą warunki przejść (`powodOdmowy`). Ładowane w transakcji przejścia (pod blokadą
 * zamówienia) i — te same — przez ekran „Co dalej” (lib/praca), żeby przycisk i rdzeń mówiły jednym głosem.
 */
export interface FaktyPrzejscia {
  /** Rezerwacje ACTIVE: towar przed fakturą. */
  aktywne: number
  /** Rezerwacje CONSUMING: faktura w drodze. */
  wFakturze: number
  /** Rezerwacje CONSUMED: towar wydany fakturą albo „wyślij bez faktury”. */
  wydane: number
  /** Sztuki pozycji bez stanu (DIGITAL) do faktury: nieusunięte, `qty − qtyRejected` (ten sam sens co w rozchodzie). */
  uslugi: number
  /** Braki OPEN i SHIP_LATER: towar, który jeszcze ma przyjść. */
  otwarteBraki: number
  /** Faktura ISSUED bieżącej paczki. */
  fakturaWystawiona: boolean
  /**
   * magazyn prowadzi Kompletor (źródło stanu KOMPLETOR) — „Do wysyłki / Do odbioru” sam zdejmuje towar ze
   * stanu, bez faktury i bez „wyślij bez faktury”. Brak pola = false (lustro wFirmy, dawna ścieżka).
   */
  wydanieWlasne?: boolean
  /**
   * dokument sprzedaży musi być przed wydaniem towaru albo zakończeniem zamówienia bez wysyłki. Brak pola =
   * true (dawna ścieżka). false w firmie bez programu do faktur albo bez ustawienia „Dokument przed wysyłką”.
   */
  dokumentWymagany?: boolean
}

type DbLike = Db | Tx

/**
 * Fakty zamówienia do warunków przejść. `opts.zasady` = zasady wydania policzone raz
 * (`zasadyWydania`) — ekran z wieloma kartami albo pętla po zamówieniach jednej firmy nie pyta wtedy o magazyn i ustawienia
 * przy każdym zamówieniu. Bez `opts` jak dotąd (2–3 zapytania).
 */
export async function faktyPrzejscia(db: DbLike, o: Pick<Order, 'id' | 'packageNo'>, opts: { zasady?: Pick<FaktyPrzejscia, 'wydanieWlasne' | 'dokumentWymagany'> } = {}): Promise<FaktyPrzejscia> {
  const res = await db.reservation.groupBy({ by: ['state'], where: { orderId: o.id, state: { in: ['ACTIVE', 'CONSUMING', 'CONSUMED'] } }, _count: { _all: true } })
  const ile = (s: string) => res.find((r) => r.state === s)?._count._all ?? 0
  const lines = await db.orderLine.findMany({ where: { orderId: o.id, removed: false, productId: { not: null } }, select: { productId: true, qty: true, qtyRejected: true } })
  const ids = [...new Set(lines.map((l) => l.productId!))]
  const digital = new Set(ids.length ? (await db.product.findMany({ where: { id: { in: ids }, kind: 'DIGITAL' }, select: { id: true } })).map((p) => p.id) : [])
  const zasady = opts.zasady ?? (await zasadyWydania(db, o.id))
  // zamówienie w obcej walucie nie dostanie dokumentu z Kompletora (faktura ręcznie, waluta.ts), więc
  // „Dokument przed wysyłką” go nie zatrzymuje: wydanie i statusy idą jak w firmie bez programu do faktur
  // przy „Faktury w walucie zamówienia” (wFirma) obca waluta czeka na dokument jak PLN, poza zamówieniem
  // sprzed włączenia (reguła w waluta.ts: wraca do kolejki dopiero po „Ponów fakturę”)
  const bezDokumentu =
    zasady.wydanieWlasne && zasady.dokumentWymagany !== false && obcaWaluta(await walutaZamowieniaPoId(db, o.id)) && (!(await fakturyWWalucie(db)) || (await walutaCzekaNaPonowieniePoId(db, o.id)))
  return {
    aktywne: ile('ACTIVE'),
    wFakturze: ile('CONSUMING'),
    wydane: ile('CONSUMED'),
    uslugi: lines.filter((l) => digital.has(l.productId!)).reduce((s, l) => s + Math.max(0, l.qty - l.qtyRejected), 0),
    otwarteBraki: await db.shortage.count({ where: { orderId: o.id, state: { in: ['OPEN', 'SHIP_LATER'] } } }),
    fakturaWystawiona: (await db.invoiceAttempt.count({ where: { orderId: o.id, packageNo: o.packageNo, state: 'ISSUED' } })) > 0,
    ...zasady,
    ...(bezDokumentu ? { dokumentWymagany: false } : {}),
  }
}

/**
 * źródło stanu magazynu zamówienia (magazyn rezerwacji, bez nich magazyn główny) i ustawienia dokumentów
 * firmy. Firma z magazynem wFirmy dostaje dokładnie dawne fakty (wydanie fakturą, dokument wymagany).
 */
export async function zasadyWydania(db: DbLike, orderId: string | null, warehouseId?: string): Promise<Pick<FaktyPrzejscia, 'wydanieWlasne' | 'dokumentWymagany'>> {
  // magazyn rezerwacji zamówienia; `orderId = null` + `warehouseId` = zasady magazynu raz dla wielu zamówień
  const r = orderId ? await db.reservation.findFirst({ where: { orderId }, orderBy: { id: 'asc' }, select: { warehouseId: true } }) : null
  const zrodlo = await zrodloStanu(db, r?.warehouseId ?? warehouseId ?? DEFAULT_WAREHOUSE)
  if (zrodlo === 'WFIRMA') return { wydanieWlasne: false, dokumentWymagany: true }
  const org = await db.organization.findFirst({ select: { settings: true } })
  return { wydanieWlasne: true, dokumentWymagany: dokumentPrzedWydaniem(zrodlo, parseUstawieniaDokumentow(org?.settings ?? null, { maWfirme: false })) }
}

/**
 * Zamówienie bez paczki: nic zarezerwowanego ani wydanego, żaden brak nie czeka na towar,
 * a zostaje usługa do faktury. Sam e-book (przewoźnik BEZ_WYSYLKI) albo zamówienie mieszane, w którym cały towar
 * odrzucono — decyduje towar, nie przewoźnik.
 */
export const bezPaczki = (f: FaktyPrzejscia): boolean => f.aktywne + f.wFakturze + f.wydane === 0 && f.otwarteBraki === 0 && f.uslugi > 0

/**
 * Warunki przejścia ponad tabelę dozwolonych przejść. Zwraca komunikat dla ekranu albo null. Czysta funkcja: fakty
 * podaje `faktyPrzejscia`, w rdzeniu pod blokadą zamówienia.
 * - anulowanie odłożone na czas faktury (3.5) blokuje każdy ruch naprzód;
 * - zbieranie tylko z czymś zarezerwowanym (bez rezerwacji nie ma czego zbierać — zostaje w „brakuje”);
 * - wydanie (DO_WYSLANIA / DO_ODBIORU) dopiero, gdy żadna rezerwacja nie jest ACTIVE ani CONSUMING: faktura
 *   wystawiona albo „wyślij bez faktury” (niezmiennik 4d — ACTIVE po wysyłce nigdy nie zostałaby skonsumowana);
 *   w magazynie prowadzonym przez Kompletor ACTIVE wolno: samo wydanie zdejmuje stan; faktura jest
 *   wymagana tylko przy ustawieniu „Dokument przed wysyłką”;
 * - odbiór osobisty idzie przez DO_ODBIORU, przesyłka przez DO_WYSLANIA;
 * - zamówienie bez wysyłki (sama usługa, np. e-book — przewoźnik BEZ_WYSYLKI albo cały towar odrzucony)
 *   nie idzie przez zbieranie ani kuriera: spakowanie od razu (`packOrder`), faktura, potem SPAKOWANE → ODEBRANE.
 *   Decyduje towar, nie przewoźnik: BEZ_WYSYLKI, które dostało towar edycją w kanale (po „Do wyjaśnienia”), idzie
 *   jak paczka — zbieranie, spakowanie, faktura, „Do wysyłki”; mieszane z całym towarem
 *   odrzuconym idzie jak sam e-book, choć ma przewoźnika paczki.
 */
export function powodOdmowy(o: Pick<Order, 'status' | 'carrier' | 'pendingAction'>, to: OrderStatus, f: FaktyPrzejscia): string | null {
  if (o.pendingAction && to !== 'DO_REALIZACJI') return 'Anulowanie w toku (faktura w drodze) — poczekaj na rozstrzygnięcie'
  if (to === 'ZBIERANIE' && !f.aktywne) {
    if (bezPaczki(f)) return 'Zamówienie bez wysyłki: zostaje sama usługa (np. e-book), towaru nie ma albo odrzucono go w całości — bez zbierania, zamówienie przejdzie do faktury automatem'
    return 'Nic do zbierania: brak zarezerwowanych pozycji'
  }
  // towar w zamówieniu: rezerwacja przed fakturą, w fakturze albo wydana (bez towaru = zamówienie bez wysyłki)
  const goods = f.aktywne + f.wFakturze + f.wydane
  if (to === 'DO_WYSLANIA' || to === 'DO_ODBIORU') {
    if (f.wFakturze || (f.aktywne && !f.wydanieWlasne)) return 'Najpierw faktura (albo „wyślij bez faktury”): towar nie jest jeszcze wydany z magazynu'
    if (!goods) return f.dokumentWymagany === false ? 'Zamówienie bez wysyłki (sama usługa, np. e-book): wybierz „Odebrane”' : 'Zamówienie bez wysyłki (sama usługa, np. e-book): po fakturze „Odebrane”'
    if (f.wydanieWlasne && f.aktywne && f.dokumentWymagany && !f.fakturaWystawiona) return 'Najpierw dokument sprzedaży: firma wymaga go przed wysyłką (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży)'
    if (to === 'DO_ODBIORU' && o.carrier !== 'OSOBISTY') return '„Do odbioru” tylko dla odbioru osobistego'
    if (to === 'DO_WYSLANIA' && o.carrier === 'OSOBISTY') return 'Odbiór osobisty: wybierz „Do odbioru”'
  }
  if (to === 'ODEBRANE' && o.status === 'SPAKOWANE') {
    if (goods) return '„Odebrane” zaraz po spakowaniu tylko dla zamówienia bez wysyłki (sama usługa, np. e-book)'
    if (!f.fakturaWystawiona && f.dokumentWymagany !== false) return 'Najpierw faktura: zamówienie bez wysyłki kończy się po jej wystawieniu'
  }
  return null
}

async function guard(tx: Tx, o: Order, to: OrderStatus): Promise<{ why: string | null; f: FaktyPrzejscia }> {
  const f = await faktyPrzejscia(tx, o)
  return { why: powodOdmowy(o, to, f), f }
}

/** Przejście z ekranu (T7, T8, T10–T13 i cofnięcie zbierania). Błąd = `TransitionError` z komunikatem dla ekranu. */
export async function moveOrder(db: Db, orderId: string, to: OrderStatus, ctx: MoveCtx = {}): Promise<OrderStatus> {
  return runTx(db, (tx) => moveOrderInTx(tx, orderId, to, ctx))
}

/** `moveOrder` we wskazanej transakcji: wydruk karty (T7) i stanowisko zmieniają status razem ze swoim rejestrem. */
export async function moveOrderInTx(tx: Tx, orderId: string, to: OrderStatus, ctx: MoveCtx = {}): Promise<OrderStatus> {
  const now = ctx.now ?? new Date()
  const o = await lockOrder(tx, orderId)
  if (o.status === to) return to // podwójne kliknięcie albo ponowione żądanie: bez zmian
  if (to === 'SPAKOWANE') throw new TransitionError('Spakowanie przez „Spakuj” (packOrder) — zamyka braki')
  if (!SCREEN_TARGETS.includes(to) || (to === 'DO_REALIZACJI' && o.status !== 'ZBIERANIE'))
    throw new TransitionError(`Przejście ${o.status} → ${to} ma własną funkcję rdzenia (anulowanie, wyjaśnienie, płatność)`)
  assertTransition(o.status, to)
  const { why, f } = await guard(tx, o, to)
  if (why) throw new TransitionError(why)
  // magazyn prowadzony przez Kompletor — wydanie zdejmuje stan w tej samej transakcji co zmiana statusu
  const wydane = (to === 'DO_WYSLANIA' || to === 'DO_ODBIORU') && f.wydanieWlasne && f.aktywne ? await wydajZMagazynuWlasnegoInTx(tx, o, now, ctx.actorId ?? 'panel') : 0
  // zbieracz oddał kartę: nowe zbieranie zaczyna nowy wydruk, stara flaga nie blokuje pakowania z DO_REALIZACJI
  await tx.order.update({ where: { id: orderId }, data: { status: to, ...(to === 'DO_REALIZACJI' ? { flags: mergeFlags(o, { kartaNieaktualna: undefined }) } : {}) } })
  await zwolnijKoszykPoStatusie(tx, orderId, to) // wydane/odebrane (także z cienia) wychodzi z koszyka
  await tx.orderEvent.create({
    data: {
      orderId,
      kind: to === 'DO_REALIZACJI' ? 'ZBIERANIE_COFNIETE' : to,
      actorId: ctx.actorId ?? 'panel',
      data: { z: o.status, na: to, ...(ctx.trackingNo ? { nadanie: ctx.trackingNo } : {}), ...(ctx.printNo ? { wydruk: ctx.printNo } : {}), ...(wydane ? { wydaneZeStanu: wydane } : {}) },
    },
  })
  // zbieranie przerwane: braki znowu biorą dostawę (4.4 pkt 3), także towar, który przyszedł w trakcie zbierania
  if (to === 'DO_REALIZACJI') await hintAllocate(tx, orderId, now)
  // „Wysłane” po doręczeniu odczytanym wcześniej (odmowa przy pierwszym podejściu, ręczna zmiana później): reguły osi
  // statusów przesyłki wracają do kolejki zaległych, inaczej „Odebrane” nie nastąpi, bo stan paczki już się nie zmieni.
  // Jedno miejsce dla każdej drogi do „Wysłane” (przyjazd kuriera, śledzenie, karta, akcja masowa, automat). Bez
  // śledzenia do doręczenia stan przesyłki jest pusty, więc nic się nie dzieje.
  if (to === 'WYSLANE') {
    await tx.shipment.updateMany({
      where: { orderId, extraNo: 0, trackState: 'DORECZONA', trackRulesPending: false, state: { in: ['TWORZENIE', 'UTWORZONA', 'NIEJEDNOZNACZNA'] } },
      data: { trackRulesPending: true, trackRulesAt: null, trackRulesFailures: 0 },
    })
  }
  return to
}

/**
 * T7 w transakcji wydruku karty („Do spec”): pierwszy wydruk zamówienia DO_REALIZACJI to początek
 * zbierania. Otwarcie ekranu ani skan karty statusu nie zmieniają. Odmowa warunku przejścia (anulowanie w toku, nic
 * zarezerwowanego) nie blokuje wydruku: karta wychodzi, status zostaje. Zwraca, czy zbieranie ruszyło.
 */
export async function startPickingOnPrint(tx: Tx, orderId: string, ctx: MoveCtx): Promise<boolean> {
  try {
    return (await moveOrderInTx(tx, orderId, 'ZBIERANIE', ctx)) === 'ZBIERANIE'
  } catch (e) {
    if (e instanceof TransitionError) return false
    throw e
  }
}

/** T7 poza wydrukiem (rdzeń, testy). Od tej chwili edycja z kanału = różnica rezerwacji + „karta nieaktualna” (3.7). */
export const startPicking = (db: Db, orderId: string, ctx: MoveCtx = {}) => moveOrder(db, orderId, 'ZBIERANIE', ctx)
/** Zbieranie przerwane (zbieracz oddaje listę) — z powrotem DO_REALIZACJI. */
export const cancelPicking = (db: Db, orderId: string, ctx: MoveCtx = {}) => moveOrder(db, orderId, 'DO_REALIZACJI', ctx)
/** T8: wszystko zebrane, do pakowania. */
export const finishPicking = (db: Db, orderId: string, ctx: MoveCtx = {}) => moveOrder(db, orderId, 'ZEBRANE', ctx)
/** T10 / T11: po fakturze (w magazynie Kompletora: od razu po spakowaniu) — przesyłka czeka na kuriera albo paczka czeka na odbiór osobisty (wg przewoźnika). */
export async function readyForDispatch(db: Db, orderId: string, ctx: MoveCtx = {}): Promise<OrderStatus> {
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { carrier: true } })
  return moveOrder(db, orderId, o.carrier === 'OSOBISTY' ? 'DO_ODBIORU' : 'DO_WYSLANIA', ctx)
}
/** T12: nadane (kurier odebrał paczkę). */
export const markShipped = (db: Db, orderId: string, ctx: MoveCtx = {}) => moveOrder(db, orderId, 'WYSLANE', ctx)
/** Zamówienie bez wysyłki: po fakturze usługi od razu odebrane — bez kuriera i bez „Do wysyłki”. */
export const finishWithoutShipping = (db: Db, orderId: string, ctx: MoveCtx = {}) => moveOrder(db, orderId, 'ODEBRANE', ctx)
/** T13: odebrane przez klienta (odbiór osobisty albo doręczenie). */
export const markReceived = (db: Db, orderId: string, ctx: MoveCtx = {}) => moveOrder(db, orderId, 'ODEBRANE', ctx)
