// Cień zamówień: odczyt dziennika zamówień konta kanału przez adapter → kopia (ChannelOrderSnapshot)
// → rdzeń (ingestOrder: rezerwacje liczone jak w pracy) → kursor. Tylko odczyt kanału; zapis wyłącznie w naszej bazie.
// Fail-safe per element: błąd jednego zamówienia nie zatrzymuje strony ani kursora — trwały (nieczytelne dane,
// walidacja) idzie do alertu i kopii, przejściowy (baza, sieć przy getOrder) na listę ponowień w kursorze.
// Kursor zapisywany po każdej przetworzonej stronie, więc przerwany odczyt wraca od ostatniej strony; powtórka jest
// bezpieczna (InboundEvent w rdzeniu + porównanie rewizji w kopii). Wyjątek: błąd KONTA zgłoszony przy elemencie
// (AdapterConfigError: token, zakres) nie dotyczy zamówienia — przerywa odczyt jak błąd listy, bez ruszania prób.
import { createHash } from 'node:crypto'
import type { OrderStatus, Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { createAccountAdapter, type ChannelAccountSettings } from '../adaptery/konta'
import { AdapterError, type AdapterContext, type ChannelOrder, hasOrderFeed, type OrderFeed, type ChannelAdapter, UnreadableDataError } from '../adaptery/kontrakt'
import { AdapterConfigError, type AdapterRegistry, rodzinaAdaptera } from '../adaptery/rejestr'
import { zapiszOdczytZKanalu } from '../karta/opis-z-kanalu'
import { recordOrderPoll } from '../rdzen/propagacja'
import { hintAllocate } from '../rdzen/rezerwacja'
import { alert, runTx } from '../rdzen/stan'
import { dostawaZKanalu, ingestOrder, type IncomingOrder, ValidationError } from '../rdzen/zamowienia'
import type { SecretSource } from '../sekrety'
import type { FetchLike } from '../zrodla/http'

export const DEFAULT_LOOKBACK_MS = 24 * 3600_000
const MAX_RETRY_ATTEMPTS = 5
const ALERT_AFTER_MS = 15 * 60_000
/** Alert „konto nie czyta”: jeden otwarty na konto, zamykany pierwszym udanym odczytem. */
export const NOT_READING_ALERT = 'KANAL_ZAMOWIENIA_NIEDOSTEPNY'
const accountRef = (acc: Pick<ChannelAccountSettings, 'channel' | 'channelAccountId'>) => `${acc.channel}/${acc.channelAccountId}`

export interface PollDeps {
  registry: AdapterRegistry
  secrets: SecretSource
  fetch?: FetchLike
  now?: () => Date
  /** Odstęp i ponowienia klienta HTTP adaptera (testy na atrapach: `{ minIntervalMs: 0 }`). */
  http?: AdapterContext['http']
  /** Pierwszy odczyt konta: ile wstecz (domyślnie 24 h). */
  initialLookbackMs?: number
  maxPages?: number
}

export type HandleOutcome = 'NOWE' | 'ZMIANA' | 'DUPLIKAT' | 'PRZESTARZALE' | 'BEZ_ZMIAN' | 'POMINIETE'

export interface PollStats {
  pages: number
  items: number
  nowe: number
  zmiany: number
  bezZmian: number
  duplikaty: number
  przestarzale: number
  pominiete: number
  bledyTrwale: number
  doPonowienia: number
  ponowione: number
}

const emptyStats = (): PollStats => ({ pages: 0, items: 0, nowe: 0, zmiany: 0, bezZmian: 0, duplikaty: 0, przestarzale: 0, pominiete: 0, bledyTrwale: 0, doPonowienia: 0, ponowione: 0 })

interface RetryEntry {
  id: string
  attempts: number
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500)

/** Błąd elementu, którego ponowienie nic nie da (dane trzeba poprawić w kanale albo w mapowaniu). */
export function isPermanentItemError(e: unknown): boolean {
  return e instanceof UnreadableDataError || e instanceof ValidationError || (e instanceof AdapterError && e.kind === 'TRWALY')
}

/**
 * Klucz zdarzenia w rdzeniu (InboundEvent): rewizja + status + płatność. Rewizja Woo ma rozdzielczość sekundy, więc
 * dwie zmiany w tej samej sekundzie (pending → processing po szybkim IPN) miałyby ten sam klucz i płatność by przepadła.
 * Porównanie „przestarzałe” dalej idzie po samej rewizji (`externalRevision`).
 */
export function eventKeyOf(o: Pick<ChannelOrder, 'externalId' | 'revision' | 'channelStatus' | 'paymentState' | 'lifecycle'>, cancelledOverride = false): string {
  return `${o.externalId}:${o.revision}:${o.channelStatus}:${o.paymentState}${cancelledOverride ? ':cofniete' : ''}`
}

export function toIncoming(acc: Pick<ChannelAccountSettings, 'channel' | 'channelAccountId'>, o: ChannelOrder, opts: { forceCancelled?: boolean } = {}): IncomingOrder {
  return {
    source: `poll:${acc.channel}:${acc.channelAccountId}`,
    eventKey: eventKeyOf(o, !!opts.forceCancelled),
    channel: acc.channel,
    channelAccountId: acc.channelAccountId,
    externalId: o.externalId,
    externalRevision: o.revision,
    channelStatusRank: o.statusRank,
    cancelled: o.lifecycle === 'CANCELLED' || !!opts.forceCancelled,
    createdAtChannel: o.createdAt,
    paymentState: o.paymentState,
    paymentMethod: o.paymentMethod,
    paymentFailedOnline: o.paymentFailedOnline,
    paymentOffline: o.paymentOffline,
    totalGross: o.totalGross,
    deliveryMethod: o.deliveryMethod,
    wantInvoiceNip: o.wantInvoiceNip,
    channelNumber: o.number ?? null,
    shippingCostGross: o.shippingCostGross ?? null,
    lines: o.lines.map((l) => ({ externalLineId: l.externalLineId, offerExternalId: l.offerExternalId, qty: l.qty, unitPriceGross: l.unitPriceGross, vatRate: l.vatRate, name: l.name ?? null, sku: l.sku ?? null, ean: l.ean ?? null })),
  }
}

/**
 * Statusy rdzenia, w których cofnięcie zamówienia w kanale do szkicu/kosza anuluje je: przed wysyłką.
 * ANULOWANE też — wymuszone anulowanie jest tam bez skutków (`cancelInTx`), więc powtórka zostaje idempotentna.
 * WYSLANE, DO_ODBIORU, ODEBRANE, REKLAMACJA: tylko ostrzeżenie i alert.
 */
const CANCELLABLE_ON_REVERT: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['NOWE', 'DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'DO_WYJASNIENIA', 'ANULOWANE'])

const snapKey = (organizationId: string, acc: ChannelAccountSettings, externalId: string) => ({
  organizationId_channel_channelAccountId_externalId: { organizationId, channel: acc.channel, channelAccountId: acc.channelAccountId, externalId },
})

/**
 * Jedno zamówienie z kanału: kopia → (gdy trzeba) rdzeń. Zamówienie widziane pierwszy raz jako zrealizowane
 * (FULFILLED) nie rezerwuje — towar już zszedł ze stanu w BL/wFirmie; szkic (DRAFT) widziany pierwszy raz pomijany,
 * a zamówienie już w rdzeniu cofnięte w kanale do szkicu/kosza → anulowane z ostrzeżeniem i alertem.
 * „Bez zmian” = ta sama rewizja, status i płatność, już przyjęte do rdzenia (albo świadomie pominięte).
 */
export async function handleChannelOrder(db: PrismaClient, acc: ChannelAccountSettings, order: ChannelOrder, now: Date, opts: { supersededBy?: string } = {}): Promise<HandleOutcome> {
  const organizationId = organizationIdOf(db)
  const key = snapKey(organizationId, acc, order.externalId)
  const snap = await db.channelOrderSnapshot.findUnique({ where: key })
  const same = !!snap && snap.revision === order.revision && snap.channelStatus === order.channelStatus && snap.paymentState === order.paymentState
  // przyjęte zamówienie, które właśnie zastąpił nowszy formularz, nie jest „bez zmian” mimo tej samej treści
  const supersedeDone = !opts.supersededBy || !!snap?.skipReason?.startsWith('zastapione')
  if (snap && same && (snap.ingestedRevision === order.revision || snap.skipReason) && supersedeDone) {
    await db.channelOrderSnapshot.update({ where: key, data: { lastSeenAt: now, ...(order.number && !snap.channelNumber ? { channelNumber: order.number } : {}) } })
    return 'BEZ_ZMIAN'
  }
  const fields = {
    channelNumber: order.number ?? null,
    revision: order.revision,
    channelStatus: order.channelStatus,
    lifecycle: order.lifecycle,
    paymentState: order.paymentState,
    totalGross: order.totalGross.toFixed(2),
    currency: order.currency,
    deliveryMethod: order.deliveryMethod,
    lineCount: order.lines.length,
    warnings: order.warnings.slice(0, 20),
    createdAtChannel: order.createdAt,
    lastSeenAt: now,
    // metryka „zmiana w kanale → u nas”: chwila, gdy zobaczyliśmy tę rewizję po raz pierwszy
    ...(snap?.revision === order.revision ? {} : { revisionSeenAt: now }),
  }
  // treść się zmieniła: „przyjęte” i powód pominięcia kasujemy do czasu udanego przyjęcia (nieudane przyjęcie ponowi się
  // w kolejnym odczycie). Stary `skipReason` (np. „szkic”) przy nowej treści dawałby BEZ_ZMIAN i zamówienie nigdy nie
  // weszłoby do rdzenia; ścieżki pomijające ustawiają go z powrotem niżej.
  await db.channelOrderSnapshot.upsert({
    where: key,
    create: { channel: acc.channel, channelAccountId: acc.channelAccountId, externalId: order.externalId, firstSeenAt: now, ...fields },
    update: { ...fields, ingestedRevision: null, skipReason: null },
  })
  const existing = await db.order.findUnique({
    where: { organizationId_channel_channelAccountId_externalId: { organizationId, channel: acc.channel, channelAccountId: acc.channelAccountId, externalId: order.externalId } },
    select: { id: true, status: true },
  })
  if (opts.supersededBy) return supersede(db, acc, order, key, existing, opts.supersededBy, now)
  if (order.lifecycle === 'DRAFT' && !existing) {
    await db.channelOrderSnapshot.update({ where: key, data: { skipReason: 'szkic' } })
    return 'POMINIETE'
  }
  // zamówienie już w rdzeniu cofnięte w kanale do szkicu/kosza. Uwaga: Woo z `status: 'any'` kosza na liście
  // nie zwraca, więc dla Woo ta gałąź odpala praktycznie tylko przy pełnym pobraniu (ponowienie); „zniknięcie
  // z kanału” obsłuży dopiero (krok 6) — nie jest domknięte samą tą gałęzią.
  if (order.lifecycle === 'DRAFT' && existing && !CANCELLABLE_ON_REVERT.has(existing.status)) {
    // W-B: towar już wyszedł (albo reklamacja) — porządki w kanale po wysyłce nie anulują zamówienia ani nie robią korekty
    const warn = `zamówienie cofnięte w kanale do stanu „${order.channelStatus}” (szkic/kosz) po wysyłce (rdzeń: ${existing.status}) — rdzeń bez zmian`
    await db.channelOrderSnapshot.update({
      where: key,
      data: { ingestedRevision: order.revision, orderId: existing.id, skipReason: 'cofniete-po-wysylce', lastError: null, warnings: [...order.warnings, warn].slice(0, 20) },
    })
    await alert(db, 'ZAMOWIENIE_COFNIETE_W_KANALE', `${acc.channel}/${acc.channelAccountId}/${order.externalId}`, `Zamówienie ${order.externalId} (${acc.name}): ${warn}`, `zamowienie-cofniete:${acc.channel}:${acc.channelAccountId}:${order.externalId}:${order.revision}`)
    return 'POMINIETE'
  }
  if (order.lifecycle === 'DRAFT' && existing) {
    const warn = `zamówienie cofnięte w kanale do stanu „${order.channelStatus}” (szkic/kosz) — anulowane`
    const res = await ingestOrder(db, toIncoming(acc, order, { forceCancelled: true }), { now })
    await db.channelOrderSnapshot.update({
      where: key,
      data: { ingestedRevision: order.revision, ingestOutcome: res.outcome, orderId: existing.id, skipReason: null, lastError: null, warnings: [...order.warnings, warn].slice(0, 20) },
    })
    await alert(db, 'ZAMOWIENIE_COFNIETE_W_KANALE', `${acc.channel}/${acc.channelAccountId}/${order.externalId}`, `Zamówienie ${order.externalId} (${acc.name}): ${warn}`, `zamowienie-cofniete:${acc.channel}:${acc.channelAccountId}:${order.externalId}:${order.revision}`)
    return res.outcome
  }
  if (!existing && order.lifecycle === 'FULFILLED') {
    await db.channelOrderSnapshot.update({ where: key, data: { skipReason: 'zrealizowane-przed-pierwszym-odczytem' } })
    return 'POMINIETE'
  }
  const res = await ingestOrder(db, toIncoming(acc, order), { now })
  await db.channelOrderSnapshot.update({
    where: key,
    data: { ingestedRevision: order.revision, ingestOutcome: res.outcome, orderId: res.orderId ?? existing?.id ?? null, skipReason: null, lastError: null },
  })
  return res.outcome
}

type SnapKey = ReturnType<typeof snapKey>

/**
 * Formularz zastąpiony nowszym z tymi samymi pozycjami (Allegro: scalona płatność) — nie rezerwuje.
 * W rdzeniu przed wysyłką: anulowany (jak cofnięcie do szkicu); po wysyłce: bez zmian, ostrzeżenie i alert;
 * spoza rdzenia: pominięty. Kopia dostaje skipReason „zastapione” i ostrzeżenie z id nowego formularza.
 */
async function supersede(db: PrismaClient, acc: ChannelAccountSettings, order: ChannelOrder, key: SnapKey, existing: { id: string; status: OrderStatus } | null, by: string, now: Date): Promise<HandleOutcome> {
  const warn = `formularz zastąpiony nowszym ${by} z tymi samymi pozycjami (scalona płatność) — nie rezerwuje`
  const warnings = [...order.warnings, warn].slice(0, 20)
  if (!existing) {
    await db.channelOrderSnapshot.update({ where: key, data: { skipReason: 'zastapione', warnings } })
    return 'POMINIETE'
  }
  if (!CANCELLABLE_ON_REVERT.has(existing.status)) {
    await db.channelOrderSnapshot.update({ where: key, data: { ingestedRevision: order.revision, orderId: existing.id, skipReason: 'zastapione-po-wysylce', lastError: null, warnings } })
    await alert(db, 'ZAMOWIENIE_ZASTAPIONE_W_KANALE', `${acc.channel}/${acc.channelAccountId}/${order.externalId}`, `Zamówienie ${order.externalId} (${acc.name}): ${warn}; rdzeń: ${existing.status} — bez zmian`, `zamowienie-zastapione:${acc.channel}:${acc.channelAccountId}:${order.externalId}:${by}`)
    return 'POMINIETE'
  }
  const res = await ingestOrder(db, toIncoming(acc, order, { forceCancelled: true }), { now })
  await db.channelOrderSnapshot.update({ where: key, data: { ingestedRevision: order.revision, ingestOutcome: res.outcome, orderId: existing.id, skipReason: 'zastapione', lastError: null, warnings } })
  return res.outcome
}

/** Kanały, w których nowy formularz może przejąć pozycje starszego (Allegro: scalenie płatności za kilka zakupów). */
const SHARED_LINE_CHANNELS: ReadonlySet<string> = new Set(['ALLEGRO'])

/**
 * Zamówienie z kanału z obsługą scalonych płatności: gdy kupujący płaci łącznie za kilka zakupów, Allegro
 * tworzy nowy formularz z tymi samymi `lineItem.id`, a ważny jest tylko ostatni. Rywale = zamówienia rdzenia tego konta
 * (nie anulowane) z którąkolwiek z tych pozycji; ważny = nowsza rewizja (updatedAt), przy remisie większe id.
 * Przegrany przestaje rezerwować — najpierw zwalniamy starsze, potem przyjmujemy nowsze, więc przy żadnej kolejności
 * zdarzeń obie rezerwacje nie trwają naraz po odczycie. Inne kanały: bez zmian (pozycje są tam unikalne).
 */
export async function handleWithMergedPayments(
  db: PrismaClient,
  acc: ChannelAccountSettings,
  order: ChannelOrder,
  now: Date,
  fetchOrder: (externalId: string) => Promise<ChannelOrder | null>,
): Promise<HandleOutcome> {
  // Dokumentacja Allegro: po scaleniu stary formularz jest usuwany, więc 404 rywala to normalna droga.
  if (!SHARED_LINE_CHANNELS.has(acc.channel) || order.lifecycle === 'CANCELLED' || !order.lines.length) return handleChannelOrder(db, acc, order, now)
  const lines = await db.orderLine.findMany({
    where: {
      externalLineId: { in: order.lines.map((l) => l.externalLineId) },
      order: { channel: acc.channel, channelAccountId: acc.channelAccountId, externalId: { not: order.externalId }, status: { not: 'ANULOWANE' } },
    },
    select: { order: { select: { externalId: true } } },
  })
  const ids = [...new Set(lines.map((l) => l.order.externalId))]
  if (!ids.length) return handleChannelOrder(db, acc, order, now)
  const rivals = (
    await db.channelOrderSnapshot.findMany({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId, externalId: { in: ids } }, select: { externalId: true, revision: true, lifecycle: true, skipReason: true } })
  ).filter((r) => r.lifecycle !== 'CANCELLED' && !r.skipReason?.startsWith('zastapione')) // już przegrany nie wymaga pobrania
  const newer = (r: { externalId: string; revision: string }) => r.revision > order.revision || (r.revision === order.revision && r.externalId > order.externalId)
  const winner = rivals.filter(newer).sort((x, y) => (x.revision === y.revision ? y.externalId.localeCompare(x.externalId) : y.revision.localeCompare(x.revision)))[0]
  if (winner) return handleChannelOrder(db, acc, order, now, { supersededBy: winner.externalId })
  for (const r of rivals) {
    const old = (await fetchOrder(r.externalId)) ?? (await rivalFromStore(db, acc, r.externalId, order.externalId))
    if (old) await handleChannelOrder(db, acc, old, now, { supersededBy: order.externalId })
  }
  return handleChannelOrder(db, acc, order, now)
}

/**
 * Rywal, którego kanał już nie zwraca (404 po scaleniu): zamówienie odtworzone z kopii i pozycji rdzenia, wyłącznie do
 * anulowania ścieżką `supersede`. Rdzeń przy anulowaniu bierze stan z własnych pozycji; `statusRank: null` = bez
 * porównania kolejności statusów. Klucz zdarzenia z „:cofniete” jak w każdym wymuszonym anulowaniu, więc idempotentnie.
 */
async function rivalFromStore(db: PrismaClient, acc: ChannelAccountSettings, externalId: string, by: string): Promise<ChannelOrder | null> {
  const organizationId = organizationIdOf(db)
  const snap = await db.channelOrderSnapshot.findUnique({ where: snapKey(organizationId, acc, externalId) })
  const row = await db.order.findUnique({
    where: { organizationId_channel_channelAccountId_externalId: { organizationId, channel: acc.channel, channelAccountId: acc.channelAccountId, externalId } },
    select: { paymentMethod: true, wantInvoiceNip: true, lines: { where: { removed: false }, select: { externalLineId: true, offerId: true, qty: true, unitPriceGross: true, vatRate: true } } },
  })
  if (!snap || !row) return null
  return {
    externalId,
    number: snap.channelNumber,
    revision: snap.revision,
    createdAt: snap.createdAtChannel,
    channelStatus: snap.channelStatus,
    statusRank: null,
    lifecycle: snap.lifecycle as ChannelOrder['lifecycle'],
    paymentState: snap.paymentState,
    paymentMethod: row.paymentMethod,
    totalGross: Number(snap.totalGross),
    currency: snap.currency,
    deliveryMethod: snap.deliveryMethod,
    wantInvoiceNip: row.wantInvoiceNip,
    lines: row.lines.map((l) => ({ externalLineId: l.externalLineId, offerExternalId: l.offerId, qty: l.qty, unitPriceGross: Number(l.unitPriceGross), vatRate: l.vatRate })),
    warnings: [...snap.warnings, `formularz usunięty w kanale po scaleniu płatności z ${by}`],
  }
}

async function recordItemError(db: PrismaClient, acc: ChannelAccountSettings, externalId: string, e: unknown): Promise<void> {
  const m = msg(e)
  try {
    const organizationId = organizationIdOf(db)
    await db.channelOrderSnapshot.updateMany({
      where: { organizationId, channel: acc.channel, channelAccountId: acc.channelAccountId, externalId },
      data: { lastError: m, errorCount: { increment: 1 } },
    })
    await alert(db, 'ZAMOWIENIE_KANALU_BLAD', `${acc.channel}/${acc.channelAccountId}/${externalId}`, `Zamówienie ${externalId} (${acc.name}): ${m}`, `zamowienie-kanalu:${acc.channel}:${acc.channelAccountId}:${externalId}:${m.slice(0, 80)}`)
  } catch {
    // zapis błędu nie może zatrzymać odczytu pozostałych zamówień
  }
}

function count(stats: PollStats, o: HandleOutcome): void {
  if (o === 'NOWE') stats.nowe++
  else if (o === 'ZMIANA') stats.zmiany++
  else if (o === 'BEZ_ZMIAN') stats.bezZmian++
  else if (o === 'DUPLIKAT') stats.duplikaty++
  else if (o === 'PRZESTARZALE') stats.przestarzale++
  else stats.pominiete++
}

function parseRetry(v: Prisma.JsonValue | null | undefined): RetryEntry[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null))
    .filter((x): x is Record<string, unknown> => !!x && typeof x['id'] === 'string' && Number.isInteger(x['attempts']))
    .map((x) => ({ id: x['id'] as string, attempts: x['attempts'] as number }))
}

const cursorKey = (organizationId: string, acc: ChannelAccountSettings) => ({
  organizationId_channel_channelAccountId: { organizationId, channel: acc.channel, channelAccountId: acc.channelAccountId },
})

async function markFailure(db: PrismaClient, acc: ChannelAccountSettings, adapterKey: string, startedAt: Date, e: unknown, now: Date): Promise<void> {
  const organizationId = organizationIdOf(db)
  const m = (e instanceof AdapterConfigError ? 'konfiguracja: ' : '') + msg(e)
  const cur = await db.channelCursor.upsert({
    where: cursorKey(organizationId, acc),
    create: { channel: acc.channel, channelAccountId: acc.channelAccountId, adapterKey, lastPollStartedAt: startedAt, lastPollFinishedAt: now, failingSince: startedAt, lastError: m },
    update: { lastPollStartedAt: startedAt, lastPollFinishedAt: now, lastError: m },
  })
  const since = cur.failingSince ?? startedAt
  if (!cur.failingSince) await db.channelCursor.update({ where: cursorKey(organizationId, acc), data: { failingSince: startedAt } })
  // zła konfiguracja konta (brak adresu, klucza, nieznany adapter) sama nie minie — alert od razu, nie po
  // 15 min; awaria kanału po 15 min. Klucz z `since` = jeden alert na epizod awarii konta (zamyka go udany odczyt).
  const config = e instanceof AdapterConfigError
  if (config || now.getTime() - since.getTime() >= ALERT_AFTER_MS)
    await alert(
      db,
      NOT_READING_ALERT,
      accountRef(acc),
      config ? `Zamówienia ${acc.name}: cień nie czyta — błąd konfiguracji konta (${m})` : `Zamówienia ${acc.name}: brak odczytu od ${since.toISOString()} (${m})`,
      `kanal-zamowienia:${acc.channel}:${acc.channelAccountId}:${since.toISOString()}`,
    )
  await recordOrderPoll(db, { channel: acc.channel, channelAccountId: acc.channelAccountId, startedAt, finishedAt: now, ok: false, error: m })
}

/**
 * Jeden odczyt konta. Wyjątek tylko przy błędzie całego odczytu (adapter, konfiguracja, lista) — wtedy kursor nie
 * rusza, błąd jest w ChannelCursor.lastError i ChannelOrderPoll, alert od razu (konfiguracja) albo po 15 min.
 * Błędy elementów są w statystyce. Udany (pełny) odczyt zamyka otwarty alert konta.
 */
export async function pollAccount(db: PrismaClient, acc: ChannelAccountSettings, deps: PollDeps): Promise<PollStats> {
  const clock = deps.now ?? (() => new Date())
  const startedAt = clock()
  const organizationId = organizationIdOf(db)
  const lookback = deps.initialLookbackMs ?? DEFAULT_LOOKBACK_MS
  const stats = emptyStats()
  let adapter: ChannelAdapter & OrderFeed
  try {
    const a = await createAccountAdapter(db, deps.registry, acc, deps.secrets, { fetch: deps.fetch, now: clock, ...(deps.http ? { http: deps.http } : {}) })
    if (!hasOrderFeed(a)) throw new AdapterConfigError(`adapter ${a.manifest.adapterKey} nie ma zdolności orders.feed`)
    adapter = a
  } catch (e) {
    await markFailure(db, acc, acc.adapterKey, startedAt, e, clock())
    throw e
  }
  const adapterKey = adapter.manifest.adapterKey
  const existing = await db.channelCursor.findUnique({ where: cursorKey(organizationId, acc) })
  // zmiana adaptera konta = inny format kursora: czytamy od nowa (powtórki są bezpieczne). Ta sama rodzina
  // (wersja tylko do odczytu ↔ z zapisem, odczyt dziedziczony 1:1) = ten sam kursor, pokrycie i lista ponowień.
  const sameFeed = !!existing && rodzinaAdaptera(existing.adapterKey) === rodzinaAdaptera(adapterKey)
  let cursor = sameFeed ? existing.cursor : null
  let coverageFrom = sameFeed ? existing.coverageFrom : null
  let retry = sameFeed ? parseRetry(existing.retryIds) : []
  await db.channelCursor.upsert({
    where: cursorKey(organizationId, acc),
    create: { channel: acc.channel, channelAccountId: acc.channelAccountId, adapterKey, firstPollAt: startedAt, lastPollStartedAt: startedAt },
    update: { adapterKey, lastPollStartedAt: startedAt, ...(existing?.firstPollAt && sameFeed ? {} : { firstPollAt: startedAt, cursor: null, coverageFrom: null, retryIds: [] }) },
  })

  const handleItem = async (externalId: string, given: ChannelOrder | undefined): Promise<'ok' | 'retry' | 'drop'> => {
    try {
      const order = given ?? (await adapter.getOrder(externalId))
      if (!order) return 'drop' // kanał mówi „nie ma” — nic do zrobienia (nie kasujemy kopii: kasowanie stwierdza tylko kanał)
      count(stats, await handleWithMergedPayments(db, acc, order, clock(), (id) => adapter.getOrder(id)))
      return 'ok'
    } catch (e) {
      if (e instanceof AdapterConfigError) throw e // błąd konta, nie zamówienia: przerywa odczyt
      if (isPermanentItemError(e)) {
        stats.bledyTrwale++
        await recordItemError(db, acc, externalId, e)
        return 'drop'
      }
      return 'retry'
    }
  }

  // 1. ponowienia z poprzednich odczytów (pełne pobranie zamówienia)
  const stillRetry: RetryEntry[] = []
  for (const [i, r] of retry.entries()) {
    let out: 'ok' | 'retry' | 'drop'
    try {
      out = await handleItem(r.id, undefined)
    } catch (e) {
      // błąd konta: ten element i kolejne zostają na liście z niezmienioną liczbą prób
      await db.channelCursor.update({ where: cursorKey(organizationId, acc), data: { retryIds: [...stillRetry, ...retry.slice(i)] as unknown as Prisma.InputJsonValue } })
      await markFailure(db, acc, adapterKey, startedAt, e, clock())
      throw e
    }
    if (out === 'ok') stats.ponowione++
    else if (out === 'retry') {
      if (r.attempts + 1 >= MAX_RETRY_ATTEMPTS) {
        stats.bledyTrwale++
        await recordItemError(db, acc, r.id, new Error(`nie udało się pobrać po ${MAX_RETRY_ATTEMPTS} próbach`))
      } else stillRetry.push({ id: r.id, attempts: r.attempts + 1 })
    }
  }
  retry = stillRetry

  // 2. dziennik zmian od kursora, strona po stronie
  const maxPages = deps.maxPages ?? 50
  let reachedEnd = false
  try {
    for (let page = 0; page < maxPages; page++) {
      const pg = await adapter.listOrderChanges(cursor, { initialLookbackMs: lookback })
      if (cursor === null && !coverageFrom) coverageFrom = new Date(startedAt.getTime() - lookback)
      stats.pages++
      // ostrzeżenie odczytu (np. kursor poza retencją → lista zapasowa) — alert konta, nigdy cicha luka.
      // Klucz z odcisku całej treści (treść niesie datę luki): jeden alert na lukę, nie jeden na przebieg.
      for (const w of pg.warnings ?? [])
        await alert(db, 'KANAL_ZAMOWIENIA_OSTRZEZENIE', accountRef(acc), `Zamówienia ${acc.name}: ${w}`.slice(0, 2000), `kanal-ostrzezenie:${accountRef(acc)}:${createHash('sha256').update(w, 'utf8').digest('hex').slice(0, 32)}`)
      for (const item of pg.items) {
        stats.items++
        const out = await handleItem(item.externalId, item.order)
        if (out === 'retry' && !retry.some((r) => r.id === item.externalId)) retry.push({ id: item.externalId, attempts: 0 })
      }
      cursor = pg.nextCursor
      await db.channelCursor.update({ where: cursorKey(organizationId, acc), data: { cursor, coverageFrom, retryIds: retry as unknown as Prisma.InputJsonValue } })
      if (!pg.hasMore) {
        reachedEnd = true
        break
      }
    }
  } catch (e) {
    await db.channelCursor.update({ where: cursorKey(organizationId, acc), data: { retryIds: retry as unknown as Prisma.InputJsonValue } })
    await markFailure(db, acc, adapterKey, startedAt, e, clock())
    throw e
  }
  stats.doPonowienia = retry.length
  // zamówienia przyjęte bez sposobu dostawy (odczyt w trakcie zapisu w kanale); osobno, nie psuje odczytu
  await uzupelnijPusteDostawy(db, acc, clock, (id) => adapter.getOrder(id)).catch((e) => {
    console.warn(`[odczyt-zamowien] uzupełnianie dostaw nie powiodło się: ${accountRef(acc)}, ${e instanceof Error ? e.name : 'błąd'}`)
  })
  const finishedAt = clock()
  // „Odczyt OK” (warunek wzrostów stanu, spec 6.2; pokrycie kanału w porównaniu z BL) tylko przy pełnym odczycie:
  // do końca dziennika, bez zaległych ponowień i bez zamówień nieczytelnych — inaczej nie znamy wszystkich zamówień.
  // Bezpieczny kierunek: wzrosty stoją, alert o nieczytelnym zamówieniu już poszedł.
  const problems: string[] = []
  if (retry.length) problems.push(`${retry.length} zamówień do ponowienia`)
  if (stats.bledyTrwale) problems.push(`${stats.bledyTrwale} zamówień nieczytelnych`)
  if (!reachedEnd) problems.push(`odczyt ucięty po ${stats.pages} stronach (ciąg dalszy w następnym)`)
  const ok = problems.length === 0
  await recordOrderPoll(db, { channel: acc.channel, channelAccountId: acc.channelAccountId, startedAt, finishedAt, ok, ...(ok ? {} : { error: problems.join('; ') }) })
  await db.channelCursor.update({
    where: cursorKey(organizationId, acc),
    data: {
      retryIds: retry as unknown as Prisma.InputJsonValue,
      lastPollFinishedAt: finishedAt,
      ...(ok ? { lastOkAt: finishedAt, failingSince: null } : {}),
      lastError: ok ? null : problems.join('; '),
      stats: stats as unknown as Prisma.InputJsonValue,
    },
  })
  if (ok) await db.alert.updateMany({ where: { kind: NOT_READING_ALERT, ref: accountRef(acc), closedAt: null }, data: { closedAt: finishedAt } })
  return stats
}

/** ile minut od złożenia świeże zamówienie bez sposobu dostawy jest czytane z kanału ponownie. */
export const PONOWNY_ODCZYT_DOSTAWY_MIN = 10
const LIMIT_PUSTYCH_DOSTAW = 50

/**
 * otwarte zamówienia konta przed zbieraniem z pustym sposobem dostawy i bez przewoźnika. Kanał potrafi pokazać
 * zamówienie w trakcie zapisu (bez linii wysyłki, pozycje po 0 zł) z tą samą datą zmiany co gotowe, więc dziennik zmian
 * już go nie zwróci. Kopia z kanału ma sposób dostawy (nowsza rewizja zapisana) → uzupełnienie z kopii,
 * bez odczytu kanału. Kopia bez sposobu, zamówienie młodsze niż `PONOWNY_ODCZYT_DOSTAWY_MIN` → ponowny odczyt z kanału
 * (opis, ceny przy otwartych kwotach, dostawa: jak „Odśwież z kanału”). Starsze bez dostawy także w kopii zostają
 * dla obsługi („Odśwież z kanału” na karcie). Każde zamówienie osobno; błąd jednego nie zatrzymuje reszty ani odczytu.
 * Zwraca liczbę uzupełnionych.
 */
export async function uzupelnijPusteDostawy(db: PrismaClient, acc: ChannelAccountSettings, clock: () => Date, getOrder: (externalId: string) => Promise<ChannelOrder | null>): Promise<number> {
  const now = clock()
  const kandydaci = await db.order.findMany({
    where: {
      channel: acc.channel,
      channelAccountId: acc.channelAccountId,
      parentOrderId: null,
      status: { in: ['NOWE', 'DO_REALIZACJI', 'DO_WYJASNIENIA'] },
      AND: [{ OR: [{ carrier: null }, { carrier: 'BRAK' }] }, { OR: [{ deliveryMethod: null }, { deliveryMethod: '' }] }],
    },
    select: { id: true, externalId: true, createdAtChannel: true },
    orderBy: { createdAtChannel: 'desc' },
    take: LIMIT_PUSTYCH_DOSTAW,
  })
  if (!kandydaci.length) return 0
  const kopie = new Map(
    (
      await db.channelOrderSnapshot.findMany({
        where: { channel: acc.channel, channelAccountId: acc.channelAccountId, externalId: { in: kandydaci.map((k) => k.externalId) } },
        select: { externalId: true, deliveryMethod: true, orderId: true },
      })
    ).map((s) => [s.externalId, s]),
  )
  const aktor = `system:poll:${acc.channel}:${acc.channelAccountId}`
  let uzupelnione = 0
  for (const k of kandydaci) {
    try {
      const kopia = kopie.get(k.externalId)
      if (kopia?.deliveryMethod?.trim() && (!kopia.orderId || kopia.orderId === k.id)) {
        const d = await runTx(db, async (tx) => {
          const w = await dostawaZKanalu(tx, k.id, kopia.deliveryMethod, aktor)
          if (w) await hintAllocate(tx, k.id, now) // jak po wyjaśnieniu: braki mogą dostać towar ze stanu
          return w
        })
        if (d) uzupelnione++
        continue
      }
      const wiekMs = now.getTime() - k.createdAtChannel.getTime()
      if (wiekMs < 0 || wiekMs > PONOWNY_ODCZYT_DOSTAWY_MIN * 60_000) continue
      const z = await getOrder(k.externalId)
      if (!z?.deliveryMethod?.trim() || z.lifecycle !== 'OPEN') continue
      const { dostawa } = await zapiszOdczytZKanalu(db, k.id, z, aktor, now)
      if (dostawa) {
        uzupelnione++
        await db.channelOrderSnapshot.updateMany({ where: { channel: acc.channel, channelAccountId: acc.channelAccountId, externalId: k.externalId, deliveryMethod: null }, data: { deliveryMethod: z.deliveryMethod } })
      }
    } catch (e) {
      if (e instanceof AdapterConfigError) throw e
      // bez treści wyjątku (odpowiedź kanału); zamówienie spróbuje się w kolejnym odczycie
      console.warn(`[odczyt-zamowien] dostawa zamówienia ${k.id} nieuzupełniona: ${e instanceof Error ? e.name : 'błąd'}`)
    }
  }
  return uzupelnione
}

/** Odstęp odczytów konta: max(limit adaptera, ustawienie konta, domyślnie 60 s); przy awarii co 5 min. */
export function pollIntervalMs(minPollIntervalMs: number, config: Record<string, unknown>, failing: boolean): number {
  const sec = Number(config['pollIntervalSec'])
  const base = Math.max(minPollIntervalMs, Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000)
  return failing ? Math.max(base, 5 * 60_000) : base
}
