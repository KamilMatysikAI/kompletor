// Dziennik zdarzeń BL: `getJournalList` (tylko odczyt) z `logs_types: [18]` —
// zmiany statusu zamówień. Zdarzenie odświeża istniejącą kopię nagłówka BL (`BlOrderSnapshot`) poza oknem
// porównania i niesie chwilę zmiany statusu, której `getOrders` nie zna. Zapis wyłącznie w naszej bazie: kopia BL,
// kursor dziennika (`BlJournalCursor`) i ewentualny alert. Bez danych klientów: numery, statusy, daty.
//
// Fakty z dokumentacji BL (02.11.2026), niepotwierdzone na żywo: dziennik trzyma zdarzenia z ostatnich 3 dni;
// identyfikator wpisu opis nazywa `id`, przykład `log_id` (obsługujemy oba); stronicowanie nieopisane; nie wiadomo,
// czy `last_log_id` jest włączne (wpisy o id ≤ kursor pomijamy). Metoda musi być włączona w ustawieniach API konta,
// a wyłączona może zwrócić pustą odpowiedź — pusty dziennik nie jest dowodem braku zmian.
import type { PrismaClient } from '@prisma/client'
import { organizationIdOf } from '../db'
import { alert } from '../rdzen/stan'
import type { BaseLinkerReadOnly } from '../zrodla/baselinker'

/** `log_type` zmiany statusu zamówienia; `object_id` = id nowego statusu. */
export const BL_LOG_STATUS_CHANGE = 18
/** Limit stron dziennika na przebieg; po przekroczeniu wynik niepełny (reszta w następnym przebiegu). */
export const JOURNAL_MAX_PAGES = 20
/** BL trzyma dziennik 3 dni: kursor bez udanego odczytu dłużej = zdarzenia utracone. */
export const JOURNAL_RETENTION_MS = 72 * 3600_000
/** Zmiany statusu z getOrders bez żadnego zdarzenia dziennika od doby = dziennik pewnie wyłączony. */
export const JOURNAL_SILENT_MS = 24 * 3600_000

export const ALERT_JOURNAL_SILENT = 'BL_DZIENNIK_MILCZY'
export const ALERT_JOURNAL_GAP = 'BL_DZIENNIK_LUKA'
/** BL od doby odpowiada błędem na getJournalList (np. metoda niewłączona na koncie). */
export const ALERT_JOURNAL_ERROR = 'BL_DZIENNIK_BLAD'

export interface JournalEvent {
  logId: bigint
  blOrderId: number
  statusId: number
  at: Date
}

export interface JournalPage {
  /** Zmiany statusu z id większym niż kursor (wszystkie, także kilka na jedno zamówienie). */
  events: JournalEvent[]
  /** Wpisy nieczytelne (bez id, numeru zamówienia, statusu albo daty) — pominięte i policzone. */
  bad: number
  /** Wpisy innego typu niż 18 (BL mógł zignorować filtr) — pominięte. */
  otherType: number
  /** Wpisy o id ≤ kursor (powtórka, `last_log_id` włączne) — pominięte. */
  old: number
  /** Największe id wpisu na stronie (także pominiętego innego typu); null = strona bez czytelnego id. */
  maxLogId: bigint | null
}

const int = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
const bigId = (v: unknown): bigint | null => {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? BigInt(v) : null
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const b = BigInt(v.trim())
    return b > 0n ? b : null
  }
  return null
}

/** Strona `getJournalList` → zdarzenia zmiany statusu po kursorze. Czysta funkcja; zły wpis = licznik, nie błąd. */
export function parseJournalPage(raw: unknown, afterLogId: bigint): JournalPage {
  const out: JournalPage = { events: [], bad: 0, otherType: 0, old: 0, maxLogId: null }
  const logs = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['logs'] : undefined
  if (!Array.isArray(logs)) return out
  for (const e of logs) {
    if (!e || typeof e !== 'object') {
      out.bad++
      continue
    }
    const r = e as Record<string, unknown>
    const logId = bigId(r['log_id'] ?? r['id'])
    if (logId === null) {
      out.bad++
      continue
    }
    if (out.maxLogId === null || logId > out.maxLogId) out.maxLogId = logId
    if (logId <= afterLogId) {
      out.old++
      continue
    }
    if (int(r['log_type']) !== BL_LOG_STATUS_CHANGE) {
      out.otherType++
      continue
    }
    const blOrderId = int(r['order_id'])
    const statusId = int(r['object_id'])
    const date = int(r['date'])
    if (blOrderId === null || statusId === null || date === null) {
      out.bad++
      continue
    }
    out.events.push({ logId, blOrderId, statusId, at: new Date(date * 1000) })
  }
  return out
}

/** Z kilku zdarzeń jednego zamówienia liczy się najnowsze (największe id wpisu; przy równym — późniejsza data). */
export function latestPerOrder(events: JournalEvent[]): JournalEvent[] {
  const by = new Map<number, JournalEvent>()
  for (const e of events) {
    const p = by.get(e.blOrderId)
    if (!p || e.logId > p.logId || (e.logId === p.logId && e.at > p.at)) by.set(e.blOrderId, e)
  }
  return [...by.values()]
}

export interface JournalFetch {
  /** Najnowsze zdarzenie per zamówienie. */
  events: JournalEvent[]
  /** Wszystkie przeczytane zmiany statusu po kursorze (przed scaleniem per zamówienie). */
  read: number
  skipped: number
  pages: number
  /** Nowy kursor: największe id przeczytanego wpisu (bez zmian, gdy nic nowego). */
  lastLogId: bigint
  /** false: przekroczony limit stron albo błąd na kolejnej stronie (zdarzenia z wcześniejszych stron są). */
  complete: boolean
  errors: string[]
}

/**
 * Dziennik BL od kursora: strony aż do pustej, strony bez postępu albo limitu (`JOURNAL_MAX_PAGES` → niepełny).
 * Błąd pierwszej strony leci dalej (nic nie przeczytano); błąd kolejnej — wynik niepełny z tym, co już jest.
 */
export async function fetchBlJournal(bl: BaseLinkerReadOnly, lastLogId: bigint, opts: { maxPages?: number } = {}): Promise<JournalFetch> {
  const maxPages = opts.maxPages ?? JOURNAL_MAX_PAGES
  const all: JournalEvent[] = []
  const errors: string[] = []
  let cursor = lastLogId
  let skipped = 0
  let pages = 0
  let complete = true
  for (;;) {
    if (pages >= maxPages) {
      errors.push(`dziennik BL: ponad ${maxPages} stron — reszta w następnym przebiegu`)
      complete = false
      break
    }
    let raw: unknown
    try {
      // BaseLinker odrzuca `last_log_id` równe 0 (ERROR_BAD_PARAMETERS „must be greater than zero”), więc pierwszy
      // odczyt (kursor 0) pyta od 1; wpisy o id ≤ kursor i tak pomija `parseJournalPage`
      raw = await bl.call('getJournalList', { last_log_id: Math.max(1, Number(cursor)), logs_types: [BL_LOG_STATUS_CHANGE] })
    } catch (e) {
      if (pages === 0) throw e
      errors.push(`dziennik BL od ${cursor}: ${e instanceof Error ? e.message : String(e)}`)
      complete = false
      break
    }
    pages++
    const p = parseJournalPage(raw, cursor)
    all.push(...p.events)
    skipped += p.bad + p.otherType + p.old
    // brak postępu (pusta strona albo same stare wpisy) = koniec dziennika
    if (p.maxLogId === null || p.maxLogId <= cursor) break
    cursor = p.maxLogId
  }
  return { events: latestPerOrder(all), read: all.length, skipped, pages, lastLogId: cursor, complete, errors }
}

// ─── Przebieg z bazą ─────────────────────────────────────────────────────────

export interface JournalRun {
  /** Zmiany statusu przeczytane po kursorze (przed scaleniem per zamówienie). */
  events: number
  /** Kopie BL zaktualizowane zdarzeniem (status, chwila, `fetchedAt`). */
  applied: number
  /** Zdarzenie zamówienia, którego kopii BL nie mamy — licznik, nie błąd. */
  withoutSnapshot: number
  /** Kopia odczytana getOrders później niż zdarzenie, z innym statusem: status zostaje, chwila tylko odnotowana. */
  olderThanSnapshot: number
  /** Wpisy pominięte: nieczytelne, innego typu, o id ≤ kursor. */
  skipped: number
  complete: boolean
  /** Kursor po przebiegu (tekst: wynik idzie do JSON w ImportRun.stats); null = odczyt się nie udał. */
  lastLogId: string | null
  /** Błąd odczytu dziennika (porównanie idzie dalej; ten sam tekst w `blErrors`). */
  error?: string
}

/** Wynik przebiegu, w którym dziennika nie dało się przeczytać. */
export const journalFailed = (error: string): JournalRun => ({ events: 0, applied: 0, withoutSnapshot: 0, olderThanSnapshot: 0, skipped: 0, complete: false, lastLogId: null, error })

/**
 * Czyta dziennik od kursora firmy (brak kursora = 0, czyli 3 dni wstecz), stosuje najnowsze zdarzenie per zamówienie
 * do istniejących kopii BL, potem przesuwa kursor — powtórka przebiegu daje ten sam stan (wpisy ≤ kursor pomijane).
 * `statuses` = mapa id → nazwa statusu BL (getOrderStatusList z tego samego przebiegu porównania).
 */
/**
 * Chwila, do której kopia jest pewna po zastosowaniu zdarzenia dziennika. Odczyt kompletny: do „teraz”. Odczyt
 * niepełny (limit stron albo błąd kolejnej strony): tylko do chwili zdarzenia, bo późniejsze zdarzenia tego samego
 * zamówienia mogą czekać w następnym przebiegu, a kopia z `fetchedAt = teraz` odrzuciłaby je jako starsze od siebie
 * i odsunęła odświeżanie zapasowe (zamrożony stary status przy nadrabianiu zaległości).
 */
export function fetchedAtPoZdarzeniu(complete: boolean, now: Date, snapshotFetchedAt: Date, eventAt: Date): Date {
  if (complete) return now
  return snapshotFetchedAt > eventAt ? snapshotFetchedAt : eventAt
}

export async function applyBlJournal(db: PrismaClient, bl: BaseLinkerReadOnly, statuses: Map<number, string>, now: Date): Promise<JournalRun & { errors: string[] }> {
  const organizationId = organizationIdOf(db)
  let cur = await db.blJournalCursor.findUnique({ where: { organizationId } })
  // kursor zakładany przed pierwszym odczytem: jego `createdAt` liczy dobę błędów, gdy BL od początku
  // odpowiada błędem (metoda niewłączona) — wtedy `checkJournalError` ma od kiedy liczyć
  if (!cur) cur = await db.blJournalCursor.upsert({ where: { organizationId }, create: { createdAt: now }, update: {} })
  // kursor bez udanego odczytu ponad 3 dni: część zdarzeń BL już usunął — jeden alert na epizod (klucz z lastReadAt)
  if (cur?.lastReadAt && now.getTime() - cur.lastReadAt.getTime() > JOURNAL_RETENTION_MS)
    await alert(
      db,
      ALERT_JOURNAL_GAP,
      'bl-dziennik',
      `Dziennik BL nieczytany od ${cur.lastReadAt.toISOString()} (ponad 72 h): BL trzyma zdarzenia 3 dni, część zmian statusu przepadła. Kopie BL nadrobi odświeżanie zapasowe (getOrders po numerze).`,
      `bl-dziennik-luka:${cur.lastReadAt.toISOString()}`,
    )
  const f = await fetchBlJournal(bl, cur.lastLogId)
  const r: JournalRun = { events: f.read, applied: 0, withoutSnapshot: 0, olderThanSnapshot: 0, skipped: f.skipped, complete: f.complete, lastLogId: f.lastLogId.toString() }
  const snaps = f.events.length
    ? await db.blOrderSnapshot.findMany({ where: { organizationId, blOrderId: { in: f.events.map((e) => e.blOrderId) } }, select: { blOrderId: true, statusId: true, fetchedAt: true } })
    : []
  const by = new Map(snaps.map((s) => [s.blOrderId, s]))
  for (const e of f.events) {
    const s = by.get(e.blOrderId)
    if (!s) {
      r.withoutSnapshot++
      continue
    }
    const where = { organizationId_blOrderId: { organizationId, blOrderId: e.blOrderId } }
    if (s.fetchedAt > e.at && s.statusId !== e.statusId) {
      // getOrders odczytał kopię po tym zdarzeniu i widzi inny status: kopia jest nowsza, zdarzenie jej nie cofa.
      // Chwila zostaje przy swoim statusie (statusChangedToId ≠ statusId), więc reguły jej nie użyją.
      await db.blOrderSnapshot.update({ where, data: { statusChangedAt: e.at, statusChangedToId: e.statusId } })
      r.olderThanSnapshot++
      continue
    }
    await db.blOrderSnapshot.update({
      where,
      data: { statusId: e.statusId, statusName: statuses.get(e.statusId) ?? null, fetchedAt: fetchedAtPoZdarzeniu(f.complete, now, s.fetchedAt, e.at), statusChangedAt: e.at, statusChangedToId: e.statusId },
    })
    r.applied++
  }
  // kursor po zapisaniu zdarzeń: przerwany przebieg powtórzy te same wpisy z tym samym wynikiem
  await db.blJournalCursor.upsert({
    where: { organizationId },
    create: { lastLogId: f.lastLogId, lastReadAt: now, lastEventAt: f.read ? now : null, createdAt: now },
    update: { lastLogId: f.lastLogId, lastReadAt: now, ...(f.read ? { lastEventAt: now } : {}) },
  })
  // udany odczyt kończy epizod błędu, a zdarzenie w dzienniku — epizod milczenia. Alert o luce zostaje
  // otwarty: dotyczy zdarzeń, które już przepadły, kolejny odczyt ich nie przywróci.
  await db.alert.updateMany({ where: { organizationId, kind: { in: f.read ? [ALERT_JOURNAL_ERROR, ALERT_JOURNAL_SILENT] : [ALERT_JOURNAL_ERROR] }, closedAt: null }, data: { closedAt: now } })
  return { ...r, errors: f.errors }
}

/**
 * Sygnał o wyłączonym dzienniku: getOrders albo odświeżanie zapasowe widzą zmiany statusu, a dziennik od doby nie dał
 * żadnego zdarzenia (metoda wyłączona w ustawieniach API konta zwraca pustą odpowiedź). Jeden alert na epizod
 * milczenia (klucz z chwili ostatniego zdarzenia albo założenia kursora), zamykany przez pierwsze zdarzenie dziennika;
 * bez danych klientów. Kursor młodszy niż doba (pierwsze przebiegi) — bez alertu.
 */
export async function checkJournalSilent(db: PrismaClient, statusChangesSeen: number, now: Date): Promise<boolean> {
  if (statusChangesSeen <= 0) return false
  const organizationId = organizationIdOf(db)
  const cur = await db.blJournalCursor.findUnique({ where: { organizationId }, select: { createdAt: true, lastEventAt: true } })
  const since = cur?.lastEventAt ?? cur?.createdAt
  if (!since || now.getTime() - since.getTime() < JOURNAL_SILENT_MS) return false
  await alert(
    db,
    ALERT_JOURNAL_SILENT,
    'bl-dziennik',
    `Dziennik BL bez zdarzeń od ponad doby, a getOrders widzi zmiany statusu (${statusChangesSeen} w tym przebiegu). Sprawdź, czy metoda getJournalList jest włączona w ustawieniach API konta BL.`,
    `bl-dziennik-milczy:${since.toISOString()}`,
  )
  return true
}

/**
 * Sygnał o dzienniku, który odpowiada błędem: pierwsza strona `getJournalList` padła, a od doby nie było
 * udanego odczytu (albo od założenia kursora, gdy nigdy się nie udał) — np. metoda niewłączona w ustawieniach API konta
 * BL. Pojedynczy błąd przejściowy nie alarmuje. Jeden alert na epizod (klucz z ostatniego udanego odczytu albo założenia
 * kursora), zamykany przy pierwszym udanym odczycie. W treści kod błędu BL (bez danych klientów).
 */
export async function checkJournalError(db: PrismaClient, error: string, now: Date): Promise<boolean> {
  const organizationId = organizationIdOf(db)
  const cur = await db.blJournalCursor.findUnique({ where: { organizationId }, select: { createdAt: true, lastReadAt: true } })
  const since = cur?.lastReadAt ?? cur?.createdAt
  if (!since || now.getTime() - since.getTime() < JOURNAL_SILENT_MS) return false
  await alert(
    db,
    ALERT_JOURNAL_ERROR,
    'bl-dziennik',
    `Dziennik BL od ${since.toISOString()} odpowiada błędem (${error.slice(0, 300)}). Sprawdź, czy metoda getJournalList jest włączona w ustawieniach API konta BL; do tego czasu kopie spoza okna odświeża tylko zapas (getOrders po numerze, z opóźnieniem do doby).`,
    `bl-dziennik-blad:${since.toISOString()}`,
  )
  return true
}
