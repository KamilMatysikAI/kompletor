// Kolejka „brakuje”: decyzje człowieka (spec 4.2, 4.4). Jedyne przeniesienia rezerwacji do „brakuje”
// poza przyjęciem zamówienia robi obsługa: „nie ma na półce” przy pakowaniu i lista „Nadmiar rezerwacji”.
import { fakturaZBl } from './faktura-bl'
import { forcePushForOrder } from './propagacja'
import { addReservation, flagsOf, hasOpenShortage, hintAllocate, mergeFlags, reserveUnits } from './rezerwacja'
import { czyZamiennik, LINIA_ZAMIANY } from './zamiana'
import { advisoryLock, alert, type Db, DEFAULT_WAREHOUSE, loadCatalog, orderLockKey, outbox, partsOf, qtyChannelPodzamowienia, runTx, StockBook, type Tx } from './stan'
import type { Ctx } from './zamowienia'

/** Odmowa decyzji obsługi albo zgłoszenia braku z komunikatem dla ekranu. */
export class ShortageActionError extends Error {}

/** Statusy przesyłki u przewoźnika, przy których etykieta (i kwota pobrania na niej) już istnieje albo powstaje. */
export const PRZESYLKA_AKTYWNA = ['TWORZENIE', 'UTWORZONA', 'NIEJEDNOZNACZNA'] as const
/**
 * Klucz blokady przesyłki zamówienia (rezerwacja wiersza w `lib/wysylka/nadanie.ts`, poprawka adresu, zmiana sposobu
 * wysyłki, zmiana pozycji). Kolejność blokad: klient → przesyłka → zamówienie; żadna transakcja nie bierze ich odwrotnie.
 */
export const kluczBlokadyPrzesylki = (orderId: string): string => `przesylka:${orderId}`
export const KOMUNIKAT_PODZIAL_PO_ETYKIECIE =
  'Zamówienie za pobraniem ma już przesyłkę u przewoźnika z kwotą pobrania sprzed podziału: najpierw anuluj przesyłkę, potem podziel zamówienie albo dośli brak'
/** Przewoźnik bez anulowania z Kompletora (DPD, InPost ShipX, GLS). */
export const KOMUNIKAT_PODZIAL_PO_ETYKIECIE_BEZ_ANULOWANIA =
  'Zamówienie za pobraniem ma już przesyłkę u przewoźnika z kwotą pobrania sprzed podziału, a tej przesyłki nie da się anulować w Kompletorze (ten przewoźnik nie anuluje przesyłek z Kompletora). ' +
  'Podziału ani „Dośle później” przy pobraniu z gotową etykietą nie zrobisz. Zrób to ręcznie: wyślij to, co jest („Wyślij resztę”), ' +
  'zmień kwotę pobrania na tej przesyłce w panelu przewoźnika, a brakujący towar wyślij później osobnym zamówieniem (Zamówienia → Dodaj zamówienie)'

/** Komunikat odmowy podziału albo „Dośle później” przy etykiecie: zależy od tego, czy przesyłkę da się anulować w Kompletorze. */
export function komunikatPodzialuPoEtykiecie(anulowalna: boolean): string {
  return anulowalna ? KOMUNIKAT_PODZIAL_PO_ETYKIECIE : KOMUNIKAT_PODZIAL_PO_ETYKIECIE_BEZ_ANULOWANIA
}

/**
 * Czy wszystkie przesyłki tych modułów da się anulować z Kompletora (manifest: `shipment.cancel`, moduł z zapisem; jak
 * `przewoznikAnuluje` w `lib/wysylka/nadanie.ts`). Rejestr ładowany leniwie: rdzeń nie ciągnie modułów przewoźników przy imporcie.
 */
export async function przewoznicyAnulujaZKompletora(adapterKeys: string[]): Promise<boolean> {
  const { defaultRegistry } = await import('../adaptery/domyslne')
  const registry = defaultRegistry()
  return adapterKeys.every((k) => {
    const m = registry.get(k)?.manifest
    return !!m && !m.readOnly && m.capabilities.includes('shipment.cancel')
  })
}

/**
 * czy któraś paczka rodziny zamówienia (główne i paczki dodatkowe) ma przesyłkę z
 * etykietą. Etykieta niesie kwotę pobrania z chwili utworzenia, więc podział za pobraniem po niej rozjechałby kwoty
 * (klient płaci paczce 1 całość, a paczce 2 jeszcze raz jej część). Zwraca moduły przewoźników aktywnych przesyłek
 * (pusta lista = brak przesyłki).
 */
export async function przesylkaWRodzinie(tx: Tx, o: { id: string; parentOrderId: string | null }): Promise<string[]> {
  const rootId = o.parentOrderId ?? o.id
  const dzieci = await tx.order.findMany({ where: { parentOrderId: rootId }, select: { id: true } })
  // dodatkowa przesyłka (dosyłka) jest zawsze bez pobrania, więc podziału nie blokuje
  const s = await tx.shipment.findMany({ where: { orderId: { in: [rootId, ...dzieci.map((d) => d.id)] }, extraNo: 0, state: { in: [...PRZESYLKA_AKTYWNA] } }, select: { adapterKey: true } })
  return [...new Set(s.map((x) => x.adapterKey))]
}

/** Odmowa podziału albo „Dośle później” zamówienia za pobraniem z etykietą w rodzinie; null = można. */
export async function odmowaPodzialuPoEtykiecie(tx: Tx, o: { id: string; parentOrderId: string | null; paymentState: string }): Promise<string | null> {
  if (o.paymentState !== 'COD') return null
  const moduly = await przesylkaWRodzinie(tx, o)
  return moduly.length ? komunikatPodzialuPoEtykiecie(await przewoznicyAnulujaZKompletora(moduly)) : null
}

async function lockLineOrder(tx: Tx, orderLineId: string) {
  const line = await tx.orderLine.findUniqueOrThrow({ where: { id: orderLineId }, include: { order: true } })
  await advisoryLock(tx, orderLockKey(line.order))
  return tx.orderLine.findUniqueOrThrow({ where: { id: orderLineId }, include: { order: true } })
}

async function moveReservationToShortage(
  tx: Tx,
  book: StockBook,
  line: { id: string; orderId: string },
  productId: string,
  qty: number,
  now: Date,
): Promise<void> {
  const res = await tx.reservation.findFirst({ where: { orderLineId: line.id, productId, state: 'ACTIVE', warehouseId: book.warehouseId } })
  if (!res || res.qtyBase < qty) throw new ShortageActionError('Za mała rezerwacja na tej pozycji')
  if (res.qtyBase === qty)
    await tx.reservation.update({ where: { id: res.id }, data: { state: 'RELEASED', releasedReason: 'MOVED_TO_SHORTAGE', releasedAt: now } })
  else await tx.reservation.update({ where: { id: res.id }, data: { qtyBase: res.qtyBase - qty } })
  book.change(productId, { reserved: -qty })
  await tx.shortage.create({ data: { orderId: line.orderId, orderLineId: line.id, productId, qtyBase: qty, state: 'OPEN', note: 'przeniesione przez obsługę' } })
}

/** Statusy „przy pakowaniu” (4.4): po spakowaniu towar jest w paczce i faktura liczy na rezerwację, brak już nie wchodzi. */
const PRZY_PAKOWANIU = ['DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE']

/**
 * „Nie ma na półce” przy pakowaniu (4.4): rezerwacja → Shortage OPEN i w tej samej transakcji ruch
 * STOCK_MISSING (MANUAL, −qty): `physical` i `reserved` spadają razem, `available` się nie zmienia.
 */
export async function markMissingOnShelf(db: Db, orderLineId: string, productId: string, qty: number, ctx: Ctx = {}): Promise<void> {
  await runTx(db, (tx) => markMissingInTx(tx, orderLineId, productId, qty, ctx))
}

/**
 * Rdzeń „nie ma na półce” we wskazanej transakcji: stanowisko zapisuje w niej też swój rejestr.
 *
 * Składnik zestawu: faktura, przydział i „dośle” liczą wyłącznie pełne zestawy (spec 3.2), więc brak `qty`
 * składnika wyjmuje z paczki całe zestawy: `ceil(qty / sztuk na zestaw)`. Rezerwacje i Shortage wszystkich składników
 * schodzą o te zestawy (reszta składników fizycznie jest i wraca do `available`), a stan fizyczny spada tylko o zgłoszone
 * `qty`. `juzZgloszone` = sztuki tego składnika zgłoszone wcześniej w tym samym oknie: zestaw już wyjęty nie schodzi drugi raz.
 */
export async function markMissingInTx(
  tx: Tx,
  orderLineId: string,
  productId: string,
  qty: number,
  ctx: Ctx & { juzZgloszone?: number } = {},
): Promise<{ units: number; zestaw: boolean }> {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Ilość musi być dodatnia')
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  const line = await lockLineOrder(tx, orderLineId)
  if (!PRZY_PAKOWANIU.includes(line.order.status)) throw new ShortageActionError(`Brak można zgłosić tylko przed spakowaniem (status ${line.order.status})`)
  const entry = line.productId ? (await loadCatalog(tx, [line.productId])).get(line.productId) : undefined
  const parts = entry ? partsOf(entry) : [{ productId, perUnit: 1 }]
  const part = parts.find((p) => p.productId === productId)
  if (!part) throw new ShortageActionError('Tego produktu nie ma w tej pozycji')
  const wczesniej = ctx.juzZgloszone ?? 0
  const units = Math.ceil((wczesniej + qty) / part.perUnit) - Math.ceil(wczesniej / part.perUnit)
  // górna granica: zarezerwowane sztuki + sztuki zestawów już wyjętych w tym oknie, jeszcze niezgłoszone;
  // druga sztuka składnika jedynego, już wyjętego zestawu przechodzi (units = 0, sam ruch STOCK_MISSING), więcej nie
  const res = await tx.reservation.findFirst({ where: { orderLineId, productId, state: 'ACTIVE', warehouseId: wh }, select: { qtyBase: true } })
  const limit = (res?.qtyBase ?? 0) + Math.ceil(wczesniej / part.perUnit) * part.perUnit - wczesniej
  if (qty > limit) throw new ShortageActionError(`Do zebrania zostało ${limit} — zamówienie mogło się zmienić`)
  const book = await StockBook.lock(tx, wh, parts.map((p) => p.productId))
  if (units > 0) for (const p of parts) await moveReservationToShortage(tx, book, line, p.productId, units * p.perUnit, now)
  book.change(productId, { pending: -qty })
  // (runda 2): druga sztuka składnika już wyjętego zestawu (units = 0) obniża stan bez rezerwacji; gdy tę
  // sztukę zdążył zarezerwować inny klient, rezerwacja jest ponad stan: znacznik nadmiaru jak przy zwrotach (niezmiennik 5)
  const s = book.get(productId)!
  if (s.reserved > s.physical && !s.overcommitSince) book.set(productId, { overcommitSince: now })
  await tx.pendingMovement.create({
    data: { productId, warehouseId: wh, delta: -qty, type: 'STOCK_MISSING', state: 'MANUAL', sentAt: now, effectiveAt: now, wzQty: 0, orderId: line.orderId, idempotencyKey: `${kluczBrakuNaPolce(orderLineId, productId)}${now.getTime()}` },
  })
  await tx.order.update({ where: { id: line.orderId }, data: { flags: mergeFlags(line.order, { brakuje: true }) } })
  await alert(tx, 'BRAK_NA_POLCE', productId, `„Nie ma na półce”: ${qty} szt. — sprawdź i popraw stan w wFirmie, potem kliknij „Poprawione w wFirmie” (Braki towaru → Do poprawy w wFirmie)`, `${kluczBrakuNaPolce(orderLineId, productId)}${now.getTime()}`)
  await tx.orderEvent.create({ data: { orderId: line.orderId, kind: 'NIE_MA_NA_POLCE', actorId: ctx.actorId ?? 'pakowanie', data: { productId, qty, ...(parts.length > 1 ? { zestawow: units } : {}) } } })
  await book.flush(tx, now)
  return { units, zestaw: parts.length > 1 }
}

/** Przedrostek klucza ruchu i alertu „nie ma na półce” jednej pozycji i produktu (`markMissingInTx`). */
export const kluczBrakuNaPolce = (orderLineId: string, productId: string) => `brak-na-polce:${orderLineId}:${productId}:`

/**
 * „Jednak jest”: cofnięcie „nie ma na półce” pozycji i produktu, zanim paczka wyszła i
 * zanim biuro poprawiło stan w wFirmie. Odwraca `markMissingInTx`: ruchy STOCK_MISSING tej pozycji (MANUAL) → CANCELLED,
 * więc `physical` wraca; otwarty brak pozycji wraca do rezerwacji (jak przydział dostawy: Shortage RESOLVED z
 * `reservationId`), najwyżej tyle zestawów, ile wyjęło zgłoszenie, i tyle, ile jest dostępne (składniki zestawu, które
 * wróciły na półkę, mógł już wziąć przydział innego zamówienia: reszta zostaje brakiem). Ruch już zatwierdzony przez biuro
 * („poprawione”) zostaje: wFirma ma mniej, więc towar przyjmuje się dokumentem w wFirmie, nie tutaj.
 */
export async function cofnijBrakNaPolceInTx(tx: Tx, orderLineId: string, productId: string, ctx: Ctx = {}): Promise<{ qty: number; units: number }> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  const line = await lockLineOrder(tx, orderLineId)
  if (!PRZY_PAKOWANIU.includes(line.order.status)) throw new ShortageActionError(`Brak cofniesz tylko przed spakowaniem (status ${line.order.status})`)
  const prefiks = kluczBrakuNaPolce(orderLineId, productId)
  const entry = line.productId ? (await loadCatalog(tx, [line.productId])).get(line.productId) : undefined
  const parts = entry ? partsOf(entry) : [{ productId, perUnit: 1 }]
  const part = parts.find((p) => p.productId === productId)
  if (!part) throw new ShortageActionError('Tego produktu nie ma w tej pozycji')
  // (runda 2): ruchy czytane dopiero za blokadą Stock, którą bierze też „poprawione” biura
  // (`officeConfirmManualInTx`); ruch zatwierdzony w międzyczasie nie może dostać drugiego `pending`
  const book = await StockBook.lock(tx, wh, parts.map((p) => p.productId))
  const ruchy = await tx.pendingMovement.findMany({ where: { orderId: line.orderId, productId, type: 'STOCK_MISSING', idempotencyKey: { startsWith: prefiks } } })
  const doCofniecia = ruchy.filter((m) => m.state === 'MANUAL')
  if (!doCofniecia.length) {
    if (ruchy.some((m) => m.state === 'APPLIED' || m.state === 'CONFIRMED')) throw new ShortageActionError('Biuro już poprawiło stan w wFirmie po tym braku: towar, który się znalazł, przyjmij dokumentem w wFirmie')
    throw new ShortageActionError('Na tej pozycji nie ma zgłoszonego braku do cofnięcia')
  }
  const qty = doCofniecia.reduce((a, m) => a - m.delta, 0)
  const { count } = await tx.pendingMovement.updateMany({ where: { id: { in: doCofniecia.map((m) => m.id) }, state: 'MANUAL' }, data: { state: 'CANCELLED' } })
  if (count !== doCofniecia.length) throw new ShortageActionError('Biuro właśnie zmieniło ten brak: odśwież i sprawdź, czy jest jeszcze co cofnąć')
  book.change(productId, { pending: qty })
  // (runda 3): stan wrócił do normy = znacznik nadmiaru schodzi od razu (jak `faktura-bl.ts`, `zwroty.ts`);
  // rezerwacje dodane niżej biorą najwyżej `available`, więc nie przywrócą nadmiaru
  const poCofnieciu = book.get(productId)!
  if (poCofnieciu.overcommitSince && poCofnieciu.reserved <= poCofnieciu.physical) book.set(productId, { overcommitSince: null, overcommitListedAt: null })
  const open = await tx.shortage.findMany({ where: { orderLineId, state: 'OPEN' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  // zestawy wyjęte przez zgłoszenia nie są zapisane per pozycja; każdy wyjęty zestaw to co najmniej jedna zgłoszona sztuka,
  // więc `qty` jest górną granicą, a otwarty brak pozycji i stan dostępny ją przycinają
  let units = qty
  for (const p of parts) {
    units = Math.min(units, Math.floor(open.filter((s) => s.productId === p.productId).reduce((a, s) => a + s.qtyBase, 0) / p.perUnit))
    units = Math.min(units, Math.floor(book.available(p.productId) / p.perUnit))
  }
  units = Math.max(0, units)
  // (runda 2): sztuki, które nie wracają do tej pozycji (brak już przeniesiony: „dośle później”, zamiana,
  // podział; albo stan dostępny za mały), podnoszą `available`. Najpierw przydział „brakuje” (paczka dodatkowa czeka na
  // ten towar), dopiero potem kanały — jak lustro przy wzroście stanu (lustro.ts)
  if (qty > units * part.perUnit) {
    book.set(productId, { allocationPendingSince: now })
    await outbox(tx, 'ALLOCATE', productId, now)
  }
  if (units > 0) {
    for (const p of parts) {
      const need = units * p.perUnit
      const resId = await addReservation(tx, book, { orderId: line.orderId, orderLineId, productId: p.productId, qty: need })
      let left = need
      for (const s of open.filter((x) => x.productId === p.productId)) {
        if (left <= 0) break
        const take = Math.min(left, s.qtyBase)
        const rozwiazane = { state: 'RESOLVED' as const, reservationId: resId, resolvedAt: now, resolvedBy: ctx.actorId ?? 'panel', note: 'cofnięty brak na półce' }
        if (take === s.qtyBase) await tx.shortage.update({ where: { id: s.id }, data: rozwiazane })
        else {
          await tx.shortage.update({ where: { id: s.id }, data: { qtyBase: s.qtyBase - take } })
          await tx.shortage.create({ data: { orderId: line.orderId, orderLineId, productId: p.productId, qtyBase: take, ...rozwiazane } })
        }
        left -= take
      }
    }
  }
  const o = await tx.order.findUniqueOrThrow({ where: { id: line.orderId } })
  await tx.order.update({ where: { id: line.orderId }, data: { flags: mergeFlags(o, { brakuje: await hasOpenShortage(tx, line.orderId) }) } })
  await tx.alert.updateMany({ where: { kind: 'BRAK_NA_POLCE', dedupeKey: { startsWith: prefiks }, closedAt: null }, data: { closedAt: now } })
  await tx.orderEvent.create({ data: { orderId: line.orderId, kind: 'BRAK_COFNIETY', actorId: ctx.actorId ?? 'panel', data: { productId, qty, ...(parts.length > 1 ? { zestawow: units } : { wrocilo: units }) } } })
  await book.flush(tx, now)
  return { qty, units }
}

/** Statusy, w których brak pozycji da się jeszcze zamknąć „jednak jest w paczce” przed spakowaniem (także w zbieraniu). */
const PRZED_PAKOWANIEM_BRAK = ['DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE']
/** Braki do zamknięcia: przed spakowaniem pomniejszają paczkę, po spakowaniu czekają na zwrot albo pomniejszyły pobranie. */
const BRAKI_PRZED = ['OPEN', 'SHIP_LATER'] as const
const BRAKI_PO = ['REFUND_PENDING', 'COD_REDUCED'] as const

export interface WynikJednakWPaczce {
  /** Sztuki (przy zestawie: zestawy) dopisane do paczki; 0 = nie było już czego zamykać (drugie kliknięcie). */
  units: number
  /** Po spakowaniu: zamknięte braki czekały na zwrot pieniędzy (obsługa ma go nie robić). */
  poSpakowaniu: boolean
}

/**
 * „Jednak jest w paczce”: towar, którego w systemie brakowało, fizycznie był i trafił do paczki (np. bieżąca
 * produkcja jeszcze nieprzyjęta na stan). Zamyka WSZYSTKIE braki pozycji jedną transakcją: rezerwacja ACTIVE na brakującą
 * ilość (tylko gdy `available` na to pozwala, inaczej odmowa: towar trzeba najpierw przyjąć na stan i zsynchronizować),
 * Shortage → RESOLVED z `reservationId` (jak przydział dostawy), wpis w historii. Rozchodu tu nie ma: robi go faktura z
 * rezerwacji (`beginInvoice`, ruch OWN_INVOICE) albo wydanie magazynu Kompletora, tak jak dla każdej spakowanej sztuki,
 * więc faktura obejmie całość, a kontrola „faktura różna od paczki” zostaje bez zmian.
 *
 * Przed spakowaniem (statusy DO_REALIZACJI, ZBIERANIE, ZEBRANE): braki OPEN/SHIP_LATER, bez „nie ma na półce” (ten cofa
 * „Jednak jest”). Po spakowaniu (SPAKOWANE, faktura jeszcze niewystawiona i nie w toku): braki REFUND_PENDING, a przy
 * pobraniu COD_REDUCED tylko bez przesyłki u przewoźnika (etykieta ma już kwotę pomniejszoną); ruchy „nie ma na półce”
 * tej pozycji niezatwierdzone przez biuro (MANUAL) → CANCELLED, bo towar jednak był. Drugie kliknięcie: `units: 0`.
 */
export async function brakJednakWPaczceInTx(tx: Tx, orderLineId: string, ctx: Ctx = {}): Promise<WynikJednakWPaczce> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  const actor = ctx.actorId ?? 'panel'
  const line = await lockLineOrder(tx, orderLineId)
  const o = line.order
  const poSpakowaniu = o.status === 'SPAKOWANE'
  // drugie kliknięcie albo brak zamknięty innym torem (przydział, dosłanie, zwrot): nic do zrobienia, w każdym statusie
  const wszystkie = await tx.shortage.findMany({ where: { orderLineId, state: { in: [...BRAKI_PRZED, ...BRAKI_PO] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  if (!wszystkie.length) return { units: 0, poSpakowaniu }
  if (!poSpakowaniu && !PRZED_PAKOWANIEM_BRAK.includes(o.status)) throw new ShortageActionError(o.status === 'NOWE' ? 'Zamówienie czeka na płatność: brak zamkniesz po opłaceniu' : 'Paczka jest już po fakturze albo wysłana: tutaj tego nie zmienisz')
  if (line.removed || !line.productId) throw new ShortageActionError('Pozycja bez produktu albo usunięta')
  const stany: readonly string[] = poSpakowaniu ? BRAKI_PO : BRAKI_PRZED
  const braki = wszystkie.filter((s) => stany.includes(s.state))
  if (!braki.length) return { units: 0, poSpakowaniu }
  if (poSpakowaniu) {
    const proby = await tx.invoiceAttempt.findMany({ where: { orderId: o.id, packageNo: o.packageNo }, select: { state: true } })
    if (proby.some((a) => a.state === 'ISSUED')) throw new ShortageActionError('Faktura tej paczki jest już wystawiona na mniejszą ilość: brakującą część dofakturuj albo popraw ręcznie w programie do faktur')
    if (proby.some((a) => a.state === 'SENDING' || a.state === 'UNKNOWN')) throw new ShortageActionError('Faktura jest w toku: poczekaj na wynik i spróbuj jeszcze raz')
    const bl = await fakturaZBl(tx, o)
    if (bl !== null) throw new ShortageActionError(`Zamówienie ma fakturę z BaseLinkera (${bl}): ilości popraw tam, nie w Kompletorze`)
    if (braki.some((s) => s.state === 'COD_REDUCED') && (await przesylkaWRodzinie(tx, o)).length)
      throw new ShortageActionError('Paczka za pobraniem ma już etykietę z pomniejszoną kwotą pobrania: najpierw anuluj przesyłkę, potem zamknij brak')
  } else {
    const naPolce = await tx.pendingMovement.count({ where: { orderId: o.id, type: 'STOCK_MISSING', state: 'MANUAL', idempotencyKey: { startsWith: `brak-na-polce:${orderLineId}:` } } })
    if (naPolce) throw new ShortageActionError('Ten brak zgłoszono przy pakowaniu („nie ma na półce”): cofnij go przyciskiem „Jednak jest” przy pozycji')
  }
  const entry = (await loadCatalog(tx, [line.productId])).get(line.productId)
  if (!entry) throw new ShortageActionError('Nieznany produkt pozycji')
  const parts = partsOf(entry)
  const book = await StockBook.lock(tx, wh, parts.map((p) => p.productId))
  // po spakowaniu: „nie ma na półce” tej pozycji, jeszcze niezatwierdzone przez biuro, było pomyłką (towar jest w paczce)
  if (poSpakowaniu) {
    const ruchy = await tx.pendingMovement.findMany({ where: { orderId: o.id, type: 'STOCK_MISSING', state: 'MANUAL', idempotencyKey: { startsWith: `brak-na-polce:${orderLineId}:` } } })
    for (const m of ruchy) {
      const { count } = await tx.pendingMovement.updateMany({ where: { id: m.id, state: 'MANUAL' }, data: { state: 'CANCELLED' } })
      if (count) book.change(m.productId, { pending: -m.delta })
    }
    // stan wrócił: znacznik nadmiaru schodzi jak w `cofnijBrakNaPolceInTx` (rezerwacja niżej bierze najwyżej `available`)
    for (const p of parts) {
      const s = book.get(p.productId)!
      if (ruchy.length && s.overcommitSince && s.reserved <= s.physical) book.set(p.productId, { overcommitSince: null, overcommitListedAt: null })
    }
    if (ruchy.length) await tx.alert.updateMany({ where: { kind: 'BRAK_NA_POLCE', dedupeKey: { startsWith: `brak-na-polce:${orderLineId}:` }, closedAt: null }, data: { closedAt: now } })
  }
  let units = Infinity
  for (const p of parts) units = Math.min(units, Math.floor(braki.filter((s) => s.productId === p.productId).reduce((a, s) => a + s.qtyBase, 0) / p.perUnit))
  if (!Number.isFinite(units) || units <= 0) throw new ShortageActionError('Brak tej pozycji nie obejmuje całego zestawu: zamknij go decyzją o braku')
  const zaMalo = parts.filter((p) => book.available(p.productId) < units * p.perUnit)
  if (zaMalo.length) {
    const sku = new Map((await tx.product.findMany({ where: { id: { in: zaMalo.map((p) => p.productId) } }, select: { id: true, sku: true } })).map((p) => [p.id, p.sku]))
    const co = zaMalo.map((p) => `${sku.get(p.productId) ?? 'produkt'}: potrzeba ${units * p.perUnit}, dostępne ${Math.max(0, book.available(p.productId))}`).join('; ')
    throw new ShortageActionError(`W systemie nie ma tego towaru na stanie (${co}). Najpierw przyjmij towar na stan w programie magazynowym i kliknij „Synchronizuj stany” (Produkty), potem spróbuj jeszcze raz.`)
  }
  for (const p of parts) {
    const need = units * p.perUnit
    const resId = await addReservation(tx, book, { orderId: o.id, orderLineId, productId: p.productId, qty: need })
    let left = need
    for (const s of braki.filter((x) => x.productId === p.productId)) {
      if (left <= 0) break
      const take = Math.min(left, s.qtyBase)
      const zamkniety = { state: 'RESOLVED' as const, reservationId: resId, resolvedAt: now, resolvedBy: actor, note: 'jednak w paczce' }
      if (take === s.qtyBase) await tx.shortage.update({ where: { id: s.id }, data: zamkniety })
      else {
        await tx.shortage.update({ where: { id: s.id }, data: { qtyBase: s.qtyBase - take } })
        await tx.shortage.create({ data: { orderId: o.id, orderLineId, productId: p.productId, qtyBase: take, ...zamkniety } })
      }
      left -= take
    }
  }
  const fresh = await tx.order.findUniqueOrThrow({ where: { id: o.id } })
  await tx.order.update({ where: { id: o.id }, data: { flags: mergeFlags(fresh, { brakuje: poSpakowaniu ? false : await hasOpenShortage(tx, o.id) }), ...(poSpakowaniu ? {} : { shortageWaitUntil: null }) } })
  if (poSpakowaniu) {
    const zostalo = await tx.shortage.count({ where: { orderId: o.id, state: { in: [...BRAKI_PO] } } })
    if (!zostalo) await tx.alert.updateMany({ where: { kind: 'BRAK_PRZY_PAKOWANIU', ref: o.id, closedAt: null }, data: { closedAt: now } })
  }
  const zestaw = parts.length > 1
  await tx.orderEvent.create({
    data: { orderId: o.id, kind: 'JEDNAK_W_PACZCE', actorId: actor, data: { pozycja: orderLineId, productId: line.productId, [zestaw ? 'zestawow' : 'sztuk']: units, poSpakowaniu, zamknieteBraki: [...new Set(braki.map((s) => s.state))] } },
  })
  await book.flush(tx, now)
  return { units, poSpakowaniu }
}

/** Lista „Nadmiar rezerwacji”: obsługa przenosi wybrane zamówienie do „brakuje” (przycisk). */
export async function moveToShortageByOffice(db: Db, orderLineId: string, productId: string, qty: number, ctx: Ctx = {}): Promise<void> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  await runTx(db, async (tx) => {
    const line = await lockLineOrder(tx, orderLineId)
    const book = await StockBook.lock(tx, wh, [productId])
    await moveReservationToShortage(tx, book, line, productId, qty, now)
    await tx.order.update({ where: { id: line.orderId }, data: { flags: mergeFlags(line.order, { brakuje: true }) } })
    await tx.orderEvent.create({ data: { orderId: line.orderId, kind: 'NADMIAR_DO_BRAKUJE', actorId: ctx.actorId ?? 'panel', data: { productId, qty } } })
    await book.flush(tx, now)
  })
}

/**
 * „Dośle później” (4.2): brakująca ilość przechodzi na pozycję podzamówienia: `qtyRejected` pozycji matki rośnie
 * (`qty` zostaje równe kanałowi, inaczej kolejna rewizja zamówienia wyglądałaby jak edycja ilości),
 * Shortage matki → CANCELLED (przeniesione), na podzamówieniu nowe Shortage SHIP_LATER (pierwszeństwo przy dostawie).
 * Działa też po spakowaniu, dla braku czekającego na zwrot pieniędzy (REFUND_PENDING): obsługa woli dosłać, niż zwracać.
 * Pobranie po spakowaniu (COD_REDUCED) odpada: kwota przesyłki jest już zmniejszona.
 */
export async function shipLater(db: Db, orderLineId: string, ctx: Ctx = {}): Promise<{ childOrderId: string; units: number }> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  return runTx(db, async (tx) => {
    const line = await lockLineOrder(tx, orderLineId)
    if (!line.productId) throw new Error('Pozycja niezmapowana')
    // dosłana część zamiennika trafiłaby do paczki bez pozycji pierwotnej, a faktura, karta
    // i raport nie znają tam jej ceny za sztukę oferty — odmowa zamiast kwoty „do ustalenia” na trzech ekranach
    if (czyZamiennik(line.externalLineId)) throw new ShortageActionError('Pozycji z zamiany („Zamień produkt”) nie da się dosłać osobną paczką. Przed spakowaniem wybierz jeszcze raz „Zamień produkt” albo „Wyślij resztę” (za brak zwrot pieniędzy); po spakowaniu za brak zostaje zwrot pieniędzy.')
    const cat = await loadCatalog(tx, [line.productId])
    const entry = cat.get(line.productId)!
    const parts = partsOf(entry)
    await StockBook.lock(tx, wh, parts.map((p) => p.productId)) // kolejność blokad jak wszędzie (Stock przed resztą)
    const open = await tx.shortage.findMany({ where: { orderLineId, state: { in: ['OPEN', 'REFUND_PENDING'] } } })
    let units = Infinity
    for (const p of parts) units = Math.min(units, Math.floor(open.filter((s) => s.productId === p.productId).reduce((a, s) => a + s.qtyBase, 0) / p.perUnit))
    if (!Number.isFinite(units) || units <= 0) throw new Error('Brak otwartych braków na tej pozycji')
    const parent = line.order
    if (parent.paymentState !== 'PAID' && parent.paymentState !== 'COD') throw new Error('„Dośle później” tylko dla zamówień opłaconych albo za pobraniem')
    const odmowaEtykiety = await odmowaPodzialuPoEtykiecie(tx, parent)
    if (odmowaEtykiety) throw new ShortageActionError(odmowaEtykiety)
    const n = (await tx.order.count({ where: { parentOrderId: parent.id } })) + 2
    const child = await tx.order.create({
      data: {
        channel: parent.channel,
        channelAccountId: parent.channelAccountId,
        externalId: `${parent.externalId}#dosle-${n}`,
        status: 'DO_REALIZACJI',
        carrier: parent.carrier,
        shippingModule: parent.shippingModule,
        deliveryMethod: parent.deliveryMethod,
        paymentState: parent.paymentState,
        paymentMethod: parent.paymentMethod,
        totalGross: '0.00',
        createdAtChannel: parent.createdAtChannel,
        parentOrderId: parent.id,
        packageNo: n,
        flags: { brakuje: true, ...(flagsOf(parent).przewoznikRecznie ? { przewoznikRecznie: true } : {}) },
      },
    })
    const oferta = line.offerId
      ? await tx.channelOffer.findFirst({ where: { channel: parent.channel, channelAccountId: parent.channelAccountId, externalId: line.offerId }, select: { qtyBasePerOffer: true } })
      : null
    const childLine = await tx.orderLine.create({
      data: { orderId: child.id, externalLineId: `${line.externalLineId}#dosle`, offerId: line.offerId, productId: line.productId, qty: units, qtyChannel: qtyChannelPodzamowienia(line.offerId, units, oferta?.qtyBasePerOffer ?? 1), unitPriceGross: line.unitPriceGross, vatRate: line.vatRate },
    })
    for (const p of parts) {
      let left = units * p.perUnit
      for (const s of open.filter((x) => x.productId === p.productId)) {
        if (left <= 0) break
        const take = Math.min(left, s.qtyBase)
        if (take === s.qtyBase) await tx.shortage.update({ where: { id: s.id }, data: { state: 'CANCELLED', note: `przeniesione do ${child.id}`, resolvedAt: now } })
        else await tx.shortage.update({ where: { id: s.id }, data: { qtyBase: s.qtyBase - take } })
        left -= take
      }
      await tx.shortage.create({ data: { orderId: child.id, orderLineId: childLine.id, productId: p.productId, qtyBase: units * p.perUnit, state: 'SHIP_LATER' } })
    }
    await tx.orderLine.update({ where: { id: orderLineId }, data: { qtyRejected: { increment: units } } })
    const stillOpen = await tx.shortage.count({ where: { orderId: parent.id, state: { in: ['OPEN', 'SHIP_LATER'] } } })
    await tx.order.update({ where: { id: parent.id }, data: { flags: mergeFlags(parent, { brakuje: stillOpen > 0 }), shortageWaitUntil: null } })
    // zwrot pieniędzy był już zadaniem obsługi (alert przy spakowaniu), a teraz towar pójdzie: nie zwracać
    if (open.some((s) => s.state === 'REFUND_PENDING')) {
      await alert(tx, 'DOSLANIE_ZAMIAST_ZWROTU', parent.id, `Brak z tej paczki pójdzie dosłaniem (${child.id}): nie zwracaj za niego pieniędzy; jeśli zwrot już poszedł, rozlicz dosłanie z klientem`, `dosle-zamiast-zwrotu:${child.id}`)
    }
    await tx.orderEvent.create({ data: { orderId: parent.id, kind: 'DOSLE_POZNIEJ', actorId: ctx.actorId ?? 'panel', data: { childOrderId: child.id, units } } })
    await hintAllocate(tx, child.id, now) // towar może już leżeć na stanie
    return { childOrderId: child.id, units }
  })
}

/** Pozycja dołożona przez obsługę („zamień produkt”): kanał jej nie zna, więc porównanie z rewizją kanału ją pomija. */
export { LINIA_ZAMIANY }
/** Pozycja dodana z karty zamówienia (lib/rdzen/edycja.ts): też lokalna, kanał jej nie zna. */
export const LINIA_KARTY = '#karta-'
export const isLocalLine = (l: { externalLineId: string }) => l.externalLineId.includes(LINIA_ZAMIANY) || l.externalLineId.includes(LINIA_KARTY)

/**
 * „Zamień produkt”: cała otwarta brakująca ilość pozycji przechodzi na nową pozycję z zamiennikiem, po tej
 * samej cenie brutto (pieniądze bez zmian; dopłata czy zwrot różnicy to sprawa obsługi), ze stawką VAT zamiennika, bo tę
 * stawkę niesie faktura. Stara pozycja: `qtyRejected`
 * rośnie, Shortage → CANCELLED. Cena zamiennika jest ceną za sztukę oferty pozycji pierwotnej, a zamiennik nie ma oferty:
 * dokument, linie faktury rdzenia i karta biorą jego przelicznik z pozycji pierwotnej i nie liczą go jako dodatkowej
 * sprzedaży (lib/rdzen/zamiana.ts), dlatego `externalLineId` zamiennika musi zostać `<źródło>#zamiana-<n>`. Zamiennik dostaje rezerwację od razu, a gdy nie ma go na stanie, zamiany nie ma.
 * Tylko produkt magazynowy w tej samej jednostce; zestaw odpada, bo brakuje w nim składnika, nie sztuk zestawu.
 */
export async function swapProduct(db: Db, orderLineId: string, replacementId: string, ctx: Ctx = {}): Promise<{ lineId: string; units: number }> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  return runTx(db, async (tx) => {
    const line = await lockLineOrder(tx, orderLineId)
    if (!line.productId) throw new ShortageActionError('Pozycja bez produktu')
    if (line.productId === replacementId) throw new ShortageActionError('Zamiennik to ten sam produkt')
    const prods = await tx.product.findMany({ where: { id: { in: [line.productId, replacementId] } }, select: { id: true, kind: true, unit: true, active: true, vatRate: true } })
    const was = prods.find((p) => p.id === line.productId)
    const next = prods.find((p) => p.id === replacementId)
    if (was?.kind !== 'STOCKED') throw new ShortageActionError('Zamiana tylko dla produktu magazynowego, nie dla zestawu')
    if (next?.kind !== 'STOCKED' || !next.active) throw new ShortageActionError('Zamiennik musi być aktywnym produktem magazynowym')
    if (next.unit !== was.unit) throw new ShortageActionError('Zamiennik w innej jednostce (sztuki i gramy)')
    const book = await StockBook.lock(tx, wh, [replacementId])
    const open = await tx.shortage.findMany({ where: { orderLineId, state: 'OPEN' } })
    const units = open.reduce((a, s) => a + s.qtyBase, 0)
    if (units <= 0) throw new ShortageActionError('Na tej pozycji nie ma otwartego braku')
    if (book.available(replacementId) < units) throw new ShortageActionError(`Zamiennika nie ma na stanie (potrzeba ${units}, dostępne ${book.available(replacementId)})`)
    await tx.shortage.updateMany({ where: { id: { in: open.map((s) => s.id) } }, data: { state: 'CANCELLED', note: `zamiana na ${replacementId}`, resolvedAt: now, resolvedBy: ctx.actorId ?? 'panel' } })
    await tx.orderLine.update({ where: { id: orderLineId }, data: { qtyRejected: { increment: units } } })
    const n = (await tx.orderLine.count({ where: { orderId: line.orderId, externalLineId: { contains: LINIA_ZAMIANY } } })) + 1
    const added = await tx.orderLine.create({
      data: { orderId: line.orderId, externalLineId: `${line.externalLineId}${LINIA_ZAMIANY}${n}`, productId: replacementId, qty: units, unitPriceGross: line.unitPriceGross, vatRate: next.vatRate ?? line.vatRate },
    })
    await reserveUnits(tx, book, line.orderId, added.id, (await loadCatalog(tx, [replacementId])).get(replacementId)!, units)
    await tx.order.update({ where: { id: line.orderId }, data: { flags: mergeFlags(line.order, { brakuje: await hasOpenShortage(tx, line.orderId) }), shortageWaitUntil: null } })
    await tx.orderEvent.create({ data: { orderId: line.orderId, kind: 'ZAMIANA_PRODUKTU', actorId: ctx.actorId ?? 'panel', data: { z: line.productId, na: replacementId, units } } })
    await book.flush(tx, now)
    return { lineId: added.id, units }
  })
}

/**
 * Lista „Do zwrotu”: obsługa zwróciła pieniądze w kanale albo bramce (system niczego nie zwraca sam, spec 4.5).
 * REFUND_PENDING → REFUNDED; ponowne kliknięcie nic nie zmienia.
 */
export async function markRefunded(db: Db, shortageId: string, ctx: Ctx = {}): Promise<boolean> {
  const now = ctx.now ?? new Date()
  return runTx(db, async (tx) => {
    const s0 = await tx.shortage.findUnique({ where: { id: shortageId }, include: { order: true } })
    if (!s0) return false
    await advisoryLock(tx, orderLockKey(s0.order))
    const r = await tx.shortage.updateMany({ where: { id: shortageId, state: 'REFUND_PENDING' }, data: { state: 'REFUNDED', resolvedAt: now, resolvedBy: ctx.actorId ?? 'panel' } })
    if (r.count) await tx.orderEvent.create({ data: { orderId: s0.orderId, kind: 'ZWROCONE', actorId: ctx.actorId ?? 'panel', data: { productId: s0.productId, qty: s0.qtyBase } } })
    return r.count === 1
  })
}

/**
 * Empik (T1b): przy akceptacji w Mirakl pozycje z „brakuje” są odrzucane zamiast wysyłane później:
 * Shortage → CANCELLED, `OrderLine.qtyRejected += sztuki` (niezmiennik 4). Wywołanie OR21 robi adapter (F2, PRACA).
 */
export async function rejectShortagesAtAcceptance(db: Db, orderId: string, ctx: Ctx = {}): Promise<number> {
  const now = ctx.now ?? new Date()
  const wh = ctx.warehouseId ?? DEFAULT_WAREHOUSE
  return runTx(db, async (tx) => {
    const o0 = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
    await advisoryLock(tx, orderLockKey(o0))
    const lines = await tx.orderLine.findMany({ where: { orderId, productId: { not: null } } })
    const cat = await loadCatalog(tx, lines.map((l) => l.productId!))
    await StockBook.lock(tx, wh, lines.flatMap((l) => partsOf(cat.get(l.productId!)!).map((p) => p.productId)))
    let rejected = 0
    const rejectedLines: string[] = []
    for (const l of lines) {
      const parts = partsOf(cat.get(l.productId!)!)
      const open = await tx.shortage.findMany({ where: { orderLineId: l.id, state: 'OPEN' } })
      if (!open.length) continue
      let units = Infinity
      for (const p of parts) units = Math.min(units, Math.floor(open.filter((s) => s.productId === p.productId).reduce((a, s) => a + s.qtyBase, 0) / p.perUnit))
      if (!Number.isFinite(units) || units <= 0) continue
      await tx.shortage.updateMany({ where: { id: { in: open.map((s) => s.id) } }, data: { state: 'CANCELLED', note: 'odrzucone przy akceptacji', resolvedAt: now } })
      await tx.orderLine.update({ where: { id: l.id }, data: { qtyRejected: { increment: units } } })
      rejected += units
      rejectedLines.push(l.id)
    }
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
    await tx.order.update({ where: { id: orderId }, data: { flags: mergeFlags(o, { brakuje: false }), shortageWaitUntil: null } })
    await tx.orderEvent.create({ data: { orderId, kind: 'ODRZUCONE_PRZY_AKCEPTACJI', actorId: 'system:empik', data: { rejected } } })
    if (rejectedLines.length) await forcePushForOrder(tx, o, now, rejectedLines) // Empik oddaje sobie odrzucone sztuki (6.1 pkt 4)
    return rejected
  })
}
