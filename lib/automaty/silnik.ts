// Silnik automatycznych akcji. Jedno miejsce, w którym zdarzenia zamówień zamieniają się w wykonania reguł:
//  - zdarzenia rdzenia i ekranów czytamy z dziennika zamówień (OrderEvent) po kursorze firmy (`przetworzZdarzenia`,
//    zadanie workera co 30 s) — rdzeń i ekrany nie wołają silnika same, więc żadna funkcja rdzenia się nie zmienia;
//  - „zamówienie w statusie N dni” sprawdza `przetworzCzas` (co 15 min);
//  - przycisk woła `kliknijPrzycisk` (karta zamówienia, stanowisko pakowania).
// Idempotencja: wykonanie = wiersz AutomationRun z unikalnym (reguła, zamówienie, okazja), zajmowany PRZED krokami;
// okazja = id zdarzenia z dziennika (+ rodzaj zdarzenia; „opłacono” raz na zamówienie), wejście w status (zdarzenie
// czasowe) albo klucz kliknięcia.
// Ta sama reguła wykonuje się więc najwyżej raz na zdarzenie i zamówienie, także przy dwóch workerach naraz.
// Bezpiecznik pętli: zmiany zrobione przez regułę mają autora `automat:<głębokość>:<reguła>`; zdarzenie o głębokości
// ≥ LIMIT_LANCUCHA nie uruchamia reguł, tylko zapisuje przerwane wykonanie i alert dla biura.
// Warunki zawsze z bieżącego stanu zamówienia (świeży odczyt przed każdą regułą), nie z pamięci o zdarzeniu.
// Firma bez włączonych reguł: przebieg tylko przesuwa kursor (nic nie czyta z zamówień, nic nie zapisuje).
import { Prisma, type Carrier, type OrderStatus, type PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { kluczRdzenia, warunekStatusuFirmy, wybierzStatusFirmy, type StatusFirmyT } from '@/lib/panel/statusy'
import { statusyFirmy } from '@/lib/panel/statusy-firmy-dane'
import { addBusinessDays } from '@/lib/rdzen/kalendarz'
import { alert } from '@/lib/rdzen/stan'
import { KROKI, type Krok, LIMIT_LANCUCHA, type RegulaT, type Warunek, type Zdarzenie, ZDARZENIA, przejscieMozliwe, SZABLONY_MAILI } from './schemat'
import { type FaktyWarunkow, spelniaWszystkie } from './warunki'
import { type KontekstWykonania, lancuchZAktora, wykonajKroki, ZDARZENIE_AUTOMATU, type WynikKroku } from './wykonanie'
import type { DepsNadania } from '@/lib/wysylka/nadanie'
import { BEZ_STANU_Z_PUNKTU_CIECIA } from '@/lib/kanaly/zamkniete-przy-przejsciu'

type Db = PrismaClient
type Env = Record<string, string | undefined>

export const ZADANIE_AUTOMATOW = 'automaty-zdarzenia'
export const ZADANIE_AUTOMATOW_CZAS = 'automaty-czas'
export const ALERT_PETLA = 'AUTOMAT_PETLA'

/**
 * Zdarzenia młodsze niż tyle czekają na następny przebieg. `OrderEvent.createdAt` ustawia Prisma z zegara aplikacji
 * w chwili `create` (nie `now()` Postgresa), więc wpis leży nie wcześniej niż `xact_start` swojej transakcji, ale
 * widać go dopiero po jej zatwierdzeniu. Kursor (chwila, id) jest ścisły, więc każde zdarzenie ocenia się raz —
 * warunki z bieżącego stanu w chwili oceny. Horyzont odczytu liczy baza (`horyzontDziennika`): najwcześniej
 * `now() - opóźnienie`, a gdy trwa transakcja, nie dalej niż jej `xact_start`. Założenie: zegar
 * aplikacji i bazy są zgodne (ten sam host, Coolify). Zegar aplikacji spóźniony o Δ względem bazy zostawia wpisom
 * zrobionym mniej niż Δ po `BEGIN` tylko zapas 30 s − Δ, dlatego 30 s to zapas na zatwierdzenie i rozjazd zegarów:
 * nie skracać w przekonaniu, że strażnik `xact_start` pokrywa wszystko (przegląd poprawek).
 */
const OPOZNIENIE_MS = 30_000
/** Kursor firmy bez reguł zapisujemy najwyżej raz na tyle: po włączeniu reguły ≤ 5 min historii. */
const KURSOR_BEZ_REGUL_MS = 5 * 60_000
/** Wykonanie `W_TOKU` starsze niż tyle = przerwane (pad workera w połowie kroków). */
const ZAWIESZONE_MS = 10 * 60_000
export const ALERT_PRZERWANE = 'AUTOMAT_PRZERWANY'
/** Pierwszy przebieg firmy nie przetwarza całej historii, tylko ostatnie minuty. */
const START_MS = 10 * 60_000
const PACZKA = 500
const RUND = 10

export interface CtxSilnika {
  now?: Date
  env?: Env
  deps?: KontekstWykonania['deps'] & DepsNadania
  /** opóźnienie odczytu dziennika (domyślnie 30 s; testy 0) */
  opoznienieMs?: number
}

export interface RegulaSilnika extends RegulaT {
  id: string
  enabled: boolean
}

const parsuj = (x: { id: string; name: string; event: string; conditions: Prisma.JsonValue; actions: Prisma.JsonValue; buttonLabel: string | null; buttonPlaces: string[]; enabled: boolean; description?: string | null }): RegulaSilnika => ({
  id: x.id,
  name: x.name,
  event: x.event as Zdarzenie,
  conditions: (Array.isArray(x.conditions) ? x.conditions : []) as unknown as Warunek[],
  actions: (Array.isArray(x.actions) ? x.actions : []) as unknown as Krok[],
  buttonLabel: x.buttonLabel,
  buttonPlaces: x.buttonPlaces as RegulaT['buttonPlaces'],
  enabled: x.enabled,
  description: x.description ?? null,
})

/** Reguły firmy w kolejności wykonania: najpierw reguły bez grupy, potem grupy wg kolejności, w grupie wg kolejności. */
export async function regulyWKolejnosci(db: Db, where: Prisma.AutomationRuleWhereInput = {}): Promise<RegulaSilnika[]> {
  const rows = await db.automationRule.findMany({
    where: { hidden: false, ...where },
    select: { id: true, name: true, event: true, conditions: true, actions: true, buttonLabel: true, buttonPlaces: true, enabled: true, description: true, sortOrder: true, group: { select: { sortOrder: true } } },
  })
  rows.sort((a, b) => (a.group ? a.group.sortOrder + 1 : 0) - (b.group ? b.group.sortOrder + 1 : 0) || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
  return rows.map(parsuj)
}

/** Dni w obecnym statusie: kalendarzowe i robocze (święta i weekendy z lib/rdzen/kalendarz.ts). */
export function dniOd(od: Date, teraz: Date): { kalendarzowe: number; robocze: number } {
  const kalendarzowe = Math.max(0, Math.floor((teraz.getTime() - od.getTime()) / 86_400_000))
  let robocze = 0
  while (robocze < 400 && addBusinessDays(od, robocze + 1) <= teraz) robocze++
  return { kalendarzowe, robocze }
}

/** Rodzaje zdarzeń dziennika, które zmieniają status zamówienia (wejście w status dla zdarzeń czasowych). */
export const ZMIANY_STATUSU = ['PRZYJETE', 'OPLACONE', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE', 'ZBIERANIE_COFNIETE', 'ANULOWANE', 'DO_WYJASNIENIA', 'WYJASNIONE', 'STATUS_RECZNIE', 'PRZYWROCONE_W_KANALE', ZDARZENIE_AUTOMATU] as const

const MAPA: Record<string, Zdarzenie[]> = {
  PRZYJETE: ['POBRANO', 'USTAWIONO_STATUS'],
  OPLACONE: ['OPLACONO', 'USTAWIONO_STATUS'],
  ZBIERANIE: ['ROZPOCZETO_ZBIERANIE', 'USTAWIONO_STATUS'],
  ZEBRANE: ['ZEBRANO', 'USTAWIONO_STATUS'],
  SPAKOWANE: ['SPAKOWANO', 'USTAWIONO_STATUS'],
  ANULOWANE: ['ANULOWANO', 'USTAWIONO_STATUS'],
  PRZESYLKA_UTWORZONA: ['UTWORZONO_PRZESYLKE'],
  PRZESYLKA_STATUS: ['STATUS_PRZESYLKI'],
  FAKTURA_BLAD: ['BLAD_FAKTURY'],
  DO_WYSLANIA: ['USTAWIONO_STATUS'],
  DO_ODBIORU: ['USTAWIONO_STATUS'],
  WYSLANE: ['USTAWIONO_STATUS'],
  ODEBRANE: ['USTAWIONO_STATUS'],
  ZBIERANIE_COFNIETE: ['USTAWIONO_STATUS'],
  DO_WYJASNIENIA: ['USTAWIONO_STATUS'],
  WYJASNIONE: ['USTAWIONO_STATUS'],
  STATUS_RECZNIE: ['USTAWIONO_STATUS'],
  PRZYWROCONE_W_KANALE: ['USTAWIONO_STATUS'],
}

/**
 * Zdarzenie dziennika → zdarzenia reguł (czysta funkcja). Zmiany zrobione przez regułę (autor `automat:`) dają tylko
 * „Ustawiono status” z wpisu reguły (krok ustawił status), nie zdarzenia z funkcji rdzenia, którą reguła wywołała —
 * inaczej ta sama zmiana liczyłaby się dwa razy. `oplacone` = zamówienie opłacone (nie pobranie) już przy przyjęciu
 * (`oplaconeJuzPrzyPrzyjeciu`, bez późniejszego wpisu OPLACONE).
 */
export function zdarzeniaZDziennika(e: { kind: string; actorId: string; data: unknown }, opts: { oplaconePrzyPrzyjeciu?: boolean } = {}): Zdarzenie[] {
  const d = e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : {}
  if (lancuchZAktora(e.actorId) !== null) return e.kind === ZDARZENIE_AUTOMATU && d.krok === 'ustawStatus' && typeof d.statusFirmy === 'string' && !d.odlozone ? ['USTAWIONO_STATUS'] : []
  if (e.kind === ZDARZENIE_AUTOMATU) return []
  const z = MAPA[e.kind] ?? []
  if (e.kind === 'PRZYJETE' && opts.oplaconePrzyPrzyjeciu) return ['POBRANO', 'OPLACONO', 'USTAWIONO_STATUS']
  return z
}

/**
 * Zamówienia z listy opłacone już przy przyjęciu: dziś PAID i bez wpisu OPLACONE/OPLACONE_PO_ANULOWANIU w dzienniku.
 * Płatność, która przyszła po przyjęciu, ma własny wpis OPLACONE i to on daje „opłacono” (bez tego
 * BLIK w 30–60 s po przyjęciu dawał „opłacono” dwa razy, z PRZYJETE i z OPLACONE). Odczyt w jednej migawce bazy,
 * więc płatność jeszcze niezatwierdzona nie jest widoczna ani w `paymentState`, ani w dzienniku.
 */
export async function oplaconeJuzPrzyPrzyjeciu(db: Db, orderIds: readonly string[]): Promise<Set<string>> {
  if (!orderIds.length) return new Set()
  const paid = await db.order.findMany({ where: { id: { in: [...orderIds] }, paymentState: 'PAID', events: { none: { kind: { in: ['OPLACONE', 'OPLACONE_PO_ANULOWANIU'] } } } }, select: { id: true } })
  return new Set(paid.map((o) => o.id))
}

/** Okazja wykonania: „opłacono” raz na zamówienie (z PRZYJETE albo OPLACONE), reszta raz na wpis dziennika. */
export const okazjaZdarzenia = (e: { id: string; orderId: string }, z: Zdarzenie) => (z === 'OPLACONO' ? `oplacono:${e.orderId}` : `ev:${e.id}:${z}`)

/**
 * Horyzont odczytu dziennika z zegara bazy (patrz OPOZNIENIE_MS: `createdAt` wpisów to zegar aplikacji, horyzont to
 * zegar bazy, oba z tego samego hosta): `now() - opóźnienie`, ale nie później niż początek najstarszej trwającej
 * transakcji w bazie (nie starszej niż 15 min). Horyzont jest wspólny dla całej bazy: długa transakcja jednej firmy
 * albo `pg_dump` opóźnia automaty wszystkich firm, najwyżej o 15 min (przegląd poprawek). Dwa odczyty `pg_stat_activity`: z uprawnieniami
 * roli aplikacji (widzi własne sesje przy roli LOGIN) i funkcją właściciela `automaty_najstarsza_transakcja`
 * (migracja 20261109118510; widzi sesje klienta firmy łączącego się jako właściciel z `-c role=…`).
 */
export async function horyzontDziennika(db: Db, opoznienieMs: number): Promise<Date> {
  const r = await db.$queryRaw<{ h: Date }[]>`
    SELECT LEAST(
      now() - make_interval(secs => ${opoznienieMs / 1000}::float8),
      COALESCE((SELECT min(a.xact_start) FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.state <> 'idle' AND a.xact_start IS NOT NULL
          AND a.backend_type = 'client backend' AND a.pid <> pg_backend_pid() AND a.xact_start > now() - interval '15 minutes'), now()),
      COALESCE("automaty_najstarsza_transakcja"(), now())
    ) AS h`
  return r[0]!.h
}

// ─── Fakty zamówienia ────────────────────────────────────────────────────────

const POLA = { id: true, channel: true, channelAccountId: true, paymentState: true, deliveryMethod: true, carrier: true, status: true, companyStatus: true, totalGross: true, createdAt: true } as const

export async function faktyZamowienia(db: Db, orderId: string, statusy: readonly StatusFirmyT[], opts: { zDniami?: Date; statusPrzesylki?: string | null } = {}): Promise<FaktyWarunkow | null> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: POLA })
  if (!o) return null
  const f: FaktyWarunkow = {
    channel: o.channel,
    channelAccountId: o.channelAccountId,
    paymentState: o.paymentState,
    deliveryMethod: o.deliveryMethod,
    carrier: o.carrier,
    statusFirmy: wybierzStatusFirmy(statusy, o)?.key ?? kluczRdzenia(o.status),
    totalGross: Number(o.totalGross.toString()),
  }
  if (opts.zDniami) f.dniWStatusie = dniOd((await wejscieWStatus(db, o.id))?.at ?? o.createdAt, opts.zDniami)
  if (opts.statusPrzesylki !== undefined) f.statusPrzesylki = opts.statusPrzesylki
  else {
    // status głównej przesyłki: dodatkowa (dosyłka) nie wyzwala automatów
    const s = await db.shipment.findFirst({ where: { orderId, extraNo: 0 }, orderBy: { createdAt: 'desc' }, select: { carrierStatus: true } })
    f.statusPrzesylki = s?.carrierStatus ?? null
  }
  return f
}

/** Ostatnia zmiana statusu zamówienia z dziennika: chwila i id wpisu (okazja zdarzenia czasowego). */
export async function wejscieWStatus(db: Db, orderId: string): Promise<{ at: Date; id: string } | null> {
  // wpis reguły liczy się tylko, gdy reguła ustawiła status (mail czy gwiazdka nie zaczynają nowego pobytu w statusie)
  const e = await db.orderEvent.findFirst({ where: { orderId, OR: [{ kind: { in: ZMIANY_STATUSU.filter((k) => k !== ZDARZENIE_AUTOMATU) } }, { kind: ZDARZENIE_AUTOMATU, data: { path: ['krok'], equals: 'ustawStatus' } }] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true } })
  return e ? { at: e.createdAt, id: e.id } : null
}

// ─── Wykonanie reguł dla jednego zdarzenia ───────────────────────────────────

export interface ZdarzenieZamowienia {
  orderId: string
  zdarzenie: Zdarzenie
  okazja: string
  lancuch: number
  statusPrzesylki?: string | null
  /** tylko ta reguła (przycisk) */
  regulaId?: string
}

export interface WynikZdarzenia {
  wykonane: { regulaId: string; kroki: WynikKroku[] }[]
  przerwane: number
}

async function zajmij(db: Db, r: RegulaSilnika, z: ZdarzenieZamowienia, result: string): Promise<string | null> {
  try {
    return (await db.automationRun.create({ data: { ruleId: r.id, orderId: z.orderId, occasion: z.okazja.slice(0, 190), event: z.zdarzenie, chain: z.lancuch, result }, select: { id: true } })).id
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null
    throw e
  }
}

export async function wykonajDlaZdarzenia(db: Db, z: ZdarzenieZamowienia, reguly: readonly RegulaSilnika[], statusy: readonly StatusFirmyT[], ctx: CtxSilnika = {}): Promise<WynikZdarzenia> {
  const now = ctx.now ?? new Date()
  const out: WynikZdarzenia = { wykonane: [], przerwane: 0 }
  const pasujace = reguly.filter((r) => r.enabled && r.event === z.zdarzenie && (!z.regulaId || r.id === z.regulaId))
  if (!pasujace.length) return out
  // warunki wszystkich reguł zdarzenia z jednego odczytu stanu (tuż przed pierwszą regułą): dwie reguły tego samego
  // zdarzenia działają na tym samym stanie, a późniejsza na liście nadpisuje status wcześniejszej (jak w ostrzeżeniu)
  const f = await faktyZamowienia(db, z.orderId, statusy, { zDniami: z.zdarzenie === 'W_STATUSIE_DNI' ? now : undefined, statusPrzesylki: z.statusPrzesylki })
  if (!f) return out
  for (const r of pasujace) {
    try {
      if (!spelniaWszystkie(r.conditions, f)) continue
      const juz = await db.automationRun.findUnique({ where: { organizationId_ruleId_orderId_occasion: { organizationId: organizationIdOf(db), ruleId: r.id, orderId: z.orderId, occasion: z.okazja.slice(0, 190) } }, select: { id: true } })
      if (juz) continue
      if (z.lancuch >= LIMIT_LANCUCHA) {
        // bezpiecznik pętli: reguła pasuje, ale łańcuch „ustawiono status → ustaw status” jest za długi
        if (await zajmij(db, r, z, 'PRZERWANY_LANCUCH')) {
          out.przerwane++
          await db.orderEvent.create({ data: { orderId: z.orderId, kind: 'AUTOMAT_POMINIETY', actorId: 'system:automaty', data: { regula: r.id, nazwa: r.name, krok: 'lancuch', powod: `łańcuch reguł zatrzymany po ${LIMIT_LANCUCHA} zmianach statusu (reguły przestawiają się nawzajem)` } } })
          await alert(db, ALERT_PETLA, z.orderId, `Automatyczne akcje: reguły przestawiają status zamówienia w kółko, łańcuch zatrzymany po ${LIMIT_LANCUCHA} zmianach (ostatnia reguła „${r.name}”). Sprawdź reguły w Ustawienia → Sprzedaż i kanały → Automatyczne akcje.`, `automat-petla:${z.orderId}:${r.id}`)
        }
        continue
      }
      const runId = await zajmij(db, r, z, 'W_TOKU')
      if (!runId) continue
      const kroki = await wykonajKroki(db, z.orderId, r.actions, { regulaId: r.id, regulaNazwa: r.name, lancuch: z.lancuch, okazja: z.okazja, statusy, env: ctx.env ?? process.env, now, deps: ctx.deps, cicho: z.zdarzenie !== 'PRZYCISK' })
      const result = kroki.every((k) => k.wynik === 'WYKONANY') ? 'WYKONANA' : kroki.some((k) => k.wynik === 'WYKONANY') ? 'CZESCIOWO' : kroki.some((k) => k.wynik === 'BLAD') ? 'BLAD' : 'POMINIETA'
      await db.automationRun.update({ where: { id: runId }, data: { result, steps: kroki as unknown as Prisma.InputJsonArray } })
      out.wykonane.push({ regulaId: r.id, kroki })
    } catch (e) {
      // jedna reguła nie zatrzymuje pozostałych; ślad w alertach biura (bez danych klienta)
      await alert(db, 'AUTOMAT_BLAD', z.orderId, `Automatyczna akcja „${r.name}” nie wykonała się: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 300)}`, `automat-blad:${r.id}:${z.orderId}:${z.okazja}`.slice(0, 190)).catch(() => {})
    }
  }
  return out
}

// ─── Przebieg zdarzeń z dziennika ────────────────────────────────────────────

export interface WynikPrzebiegu {
  zdarzen: number
  wykonan: number
  przerwanych: number
  bledy: string[]
}

/** Przebieg zdarzeń firmy po kursorze (klient firmy, RLS). Pusty, gdy firma nie ma włączonych reguł zdarzeń. */
export async function przetworzZdarzenia(db: Db, ctx: CtxSilnika = {}): Promise<WynikPrzebiegu> {
  organizationIdOf(db)
  const wynik: WynikPrzebiegu = { zdarzen: 0, wykonan: 0, przerwanych: 0, bledy: [] }
  const reguly = (await regulyWKolejnosci(db, { enabled: true })).filter((r) => r.event !== 'PRZYCISK' && r.event !== 'W_STATUSIE_DNI')
  const kursor = await db.automationCursor.findFirst({ select: { lastAt: true, lastId: true } })
  const opoznienie = ctx.opoznienieMs ?? OPOZNIENIE_MS
  const gorna = () => horyzontDziennika(db, opoznienie)
  if (!reguly.length) {
    // bez reguł nic nie czytamy; kursor idzie z czasem, żeby włączenie reguły nie przetworzyło starej historii
    // (zapis najwyżej co 5 min; przy kursorze z przyszłości, np. po zmianie zegara, też zapis)
    const h = await gorna()
    if (!kursor || h.getTime() - kursor.lastAt.getTime() >= KURSOR_BEZ_REGUL_MS || h < kursor.lastAt) await zapiszKursor(db, h, '')
    return wynik
  }
  const statusy = (await statusyFirmy(db)).statusy
  const zdarzenia = new Set(reguly.map((r) => r.event))
  let k = kursor ?? { lastAt: new Date((await gorna()).getTime() - START_MS), lastId: '' }
  // rundy: kolejne strony dziennika; przy opóźnieniu 0 (testy) także zmiany zrobione przez reguły w tej rundzie (łańcuch)
  for (let runda = 0; runda < RUND; runda++) {
    const po: Prisma.OrderEventWhereInput = { OR: [{ createdAt: { gt: k.lastAt } }, { createdAt: k.lastAt, id: { gt: k.lastId } }] }
    const ev = await db.orderEvent.findMany({ where: { AND: [po, { createdAt: { lte: await gorna() } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: PACZKA, select: { id: true, orderId: true, kind: true, actorId: true, data: true, createdAt: true } })
    if (!ev.length) break
    const oplacone = zdarzenia.has('OPLACONO') ? await oplaconeJuzPrzyPrzyjeciu(db, [...new Set(ev.filter((e) => e.kind === 'PRZYJETE').map((e) => e.orderId))]) : new Set<string>()
    for (const e of ev) {
      try {
        const zz = zdarzeniaZDziennika(e, { oplaconePrzyPrzyjeciu: e.kind === 'PRZYJETE' && oplacone.has(e.orderId) }).filter((z) => zdarzenia.has(z))
        if (!zz.length) continue
        wynik.zdarzen++
        const lancuch = lancuchZAktora(e.actorId) ?? 0
        const d = e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : {}
        for (const z of zz) {
          const w = await wykonajDlaZdarzenia(db, { orderId: e.orderId, zdarzenie: z, okazja: okazjaZdarzenia(e, z), lancuch, ...(z === 'STATUS_PRZESYLKI' ? { statusPrzesylki: typeof d.status === 'string' ? d.status : null } : {}) }, reguly, statusy, ctx)
          wynik.wykonan += w.wykonane.length
          wynik.przerwanych += w.przerwane
        }
      } catch (err) {
        wynik.bledy.push(`${e.id}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`)
      }
    }
    const ost = ev.at(-1)!
    k = { lastAt: ost.createdAt, lastId: ost.id }
    await zapiszKursor(db, k.lastAt, k.lastId)
  }
  return wynik
}

async function zapiszKursor(db: Db, at: Date, id: string): Promise<void> {
  await db.automationCursor.upsert({ where: { organizationId: organizationIdOf(db) }, create: { lastAt: at, lastId: id }, update: { lastAt: at, lastId: id } })
}

// ─── Wykonania przerwane w połowie ───────────────────────────────────────────

/**
 * Wykonanie zajęte (`W_TOKU`) i niezakończone przez 10 min = worker padł w trakcie kroków. Kroków nie wznawiamy (mogły
 * już częściowo pójść, a unikalna okazja chroni przed dublem), tylko oznaczamy wykonanie `PRZERWANA` i dajemy biuru
 * alert z listą kroków reguły do sprawdzenia na karcie zamówienia. Zwraca liczbę oznaczonych.
 */
export async function sprzatnijZawieszone(db: Db, now: Date): Promise<number> {
  const stare = await db.automationRun.findMany({ where: { result: 'W_TOKU', createdAt: { lt: new Date(now.getTime() - ZAWIESZONE_MS) } }, select: { id: true, orderId: true, rule: { select: { id: true, name: true, actions: true } } }, take: 200 })
  let n = 0
  for (const r of stare) {
    try {
      const u = await db.automationRun.updateMany({ where: { id: r.id, result: 'W_TOKU' }, data: { result: 'PRZERWANA' } })
      if (!u.count) continue
      n++
      const kroki = (Array.isArray(r.rule.actions) ? (r.rule.actions as unknown as Krok[]) : []).map((a, i) => `${i + 1}. ${opisKroku(a)}`).join(', ')
      await alert(db, ALERT_PRZERWANE, r.orderId, `Automatyczna akcja „${r.rule.name}” przerwała się w trakcie (np. restart systemu). Kroki nie zostaną powtórzone: sprawdź na karcie zamówienia, które z nich się wykonały (${kroki || 'brak kroków'}).`.slice(0, 900), `automat-przerwany:${r.id}`)
    } catch {
      // jeden wiersz nie zatrzymuje pozostałych; spróbujemy w następnym przebiegu
    }
  }
  return n
}

function opisKroku(a: Krok): string {
  const nazwa = KROKI[a.typ]?.nazwa ?? a.typ
  if (a.typ === 'wyslijEmail') return `${nazwa} „${SZABLONY_MAILI[a.szablon]?.nazwa ?? a.szablon}”`
  if (a.typ === 'ustawStatus') return `${nazwa} ${a.status}`
  return nazwa
}

// ─── Zdarzenie czasowe: „zamówienie w statusie N dni” ────────────────────────

/** Przebieg reguł czasowych (co 15 min): zamówienia w statusach z warunku, okazja = wejście w obecny status. */
export async function przetworzCzas(db: Db, ctx: CtxSilnika = {}): Promise<WynikPrzebiegu> {
  organizationIdOf(db)
  const wynik: WynikPrzebiegu = { zdarzen: 0, wykonan: 0, przerwanych: 0, bledy: [] }
  const now = ctx.now ?? new Date()
  try {
    wynik.przerwanych += await sprzatnijZawieszone(db, now)
  } catch (e) {
    wynik.bledy.push(`zawieszone: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`)
  }
  const reguly = (await regulyWKolejnosci(db, { enabled: true, event: 'W_STATUSIE_DNI' }))
  if (!reguly.length) return wynik
  const statusy = (await statusyFirmy(db)).statusy
  for (const r of reguly) {
    const st = r.conditions.find((c): c is Extract<Warunek, { typ: 'status' }> => c.typ === 'status' && !c.nie)
    if (!st) continue
    // zamknięte przy przejściu z BaseLinkera, które stoją w stanie z chwili cięcia, pomijamy: „dni w statusie” liczyłyby
    // się od przyjęcia w podglądzie, a obsługę tego stanu (maile, statusy) zrobił BaseLinker; przy okazji nie zajmują
    // limitu 1000 najstarszych. Po późniejszej zmianie statusu w Kompletorze (np. ręczne „Odebrane”) okazją jest wejście
    // w nowy status, zapisane już przez Kompletor, więc reguły działają normalnie
    const ids = await db.order.findMany({ where: { OR: st.wartosci.map((k) => warunekStatusuFirmy(statusy, k)), ...BEZ_STANU_Z_PUNKTU_CIECIA }, select: { id: true }, take: 1000, orderBy: { createdAt: 'asc' } })
    for (const { id } of ids) {
      try {
        const wej = await wejscieWStatus(db, id)
        const w = await wykonajDlaZdarzenia(db, { orderId: id, zdarzenie: 'W_STATUSIE_DNI', okazja: `czas:${wej?.id ?? 'przyjecie'}`, lancuch: 0 }, [r], statusy, { ...ctx, now })
        wynik.zdarzen++
        wynik.wykonan += w.wykonane.length
      } catch (e) {
        wynik.bledy.push(`${id}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`)
      }
    }
  }
  return wynik
}

// ─── Przyciski ───────────────────────────────────────────────────────────────

export interface PrzyciskZamowienia {
  regulaId: string
  etykieta: string
  /** null = można kliknąć */
  powod: string | null
}

/**
 * Przyciski reguł dla zamówienia w danym miejscu: tylko włączone reguły z tym miejscem, których warunki pasują do
 * zamówienia. Krok przesyłki przy wyłączonym nadawaniu = przycisk widoczny, nieaktywny, z powodem (bramka przewoźnika).
 */
export async function przyciskiZamowienia(db: Db, orderId: string, miejsce: 'karta' | 'pakowanie', ctx: CtxSilnika = {}): Promise<PrzyciskZamowienia[]> {
  const reguly = (await regulyWKolejnosci(db, { enabled: true, event: 'PRZYCISK' })).filter((r) => (r.buttonPlaces ?? []).includes(miejsce))
  if (!reguly.length) return []
  const statusy = (await statusyFirmy(db)).statusy
  const f = await faktyZamowienia(db, orderId, statusy)
  if (!f) return []
  const out: PrzyciskZamowienia[] = []
  let bramka: string | null | undefined
  for (const r of reguly) {
    if (!spelniaWszystkie(r.conditions, f)) continue
    let powod: string | null = null
    if (r.actions.some((a) => a.typ === 'utworzPrzesylke')) {
      if (bramka === undefined) {
        const { bramkaNadania } = await import('@/lib/wysylka/nadanie')
        bramka = (await bramkaNadania(db, orderId, { ...(ctx.deps ?? {}), env: ctx.env ?? process.env }))?.powod ?? null
      }
      powod = bramka
    }
    out.push({ regulaId: r.id, etykieta: r.buttonLabel || r.name, powod })
  }
  return out
}

/** Kliknięcie przycisku: `klucz` z formularza (podwójne kliknięcie = jedno wykonanie). */
export async function kliknijPrzycisk(db: Db, regulaId: string, orderId: string, klucz: string, miejsce: 'karta' | 'pakowanie', ctx: CtxSilnika = {}): Promise<{ blad: string | null; kroki: WynikKroku[] }> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(klucz)) return { blad: 'Odśwież stronę i kliknij ponownie.', kroki: [] }
  const r = (await regulyWKolejnosci(db, { id: regulaId, event: 'PRZYCISK' }))[0]
  if (!r || !r.enabled) return { blad: 'Tego przycisku już nie ma: odśwież stronę.', kroki: [] }
  // przycisk działa tylko tam, gdzie reguła go pokazuje (stanowisko nie wywoła przycisku z karty)
  if (!(r.buttonPlaces ?? []).includes(miejsce)) return { blad: 'Tego przycisku tu nie ma: odśwież stronę.', kroki: [] }
  const statusy = (await statusyFirmy(db)).statusy
  const f = await faktyZamowienia(db, orderId, statusy)
  if (!f) return { blad: 'Nie ma takiego zamówienia.', kroki: [] }
  if (!spelniaWszystkie(r.conditions, f)) return { blad: 'Ten przycisk nie dotyczy tego zamówienia: odśwież stronę.', kroki: [] }
  const w = await wykonajDlaZdarzenia(db, { orderId, zdarzenie: 'PRZYCISK', okazja: `przycisk:${klucz}`, lancuch: 0, regulaId }, [r], statusy, ctx)
  const kroki = w.wykonane[0]?.kroki ?? []
  const pom = kroki.find((k) => k.wynik !== 'WYKONANY')
  return { blad: pom ? pom.opis : null, kroki }
}

// ─── Podgląd na sucho ────────────────────────────────────────────────────────

export interface WynikPodgladu {
  dni: number
  zamowien: number
  zdarzen: number
  /** co reguła zrobiłaby: liczba zamówień per rodzaj kroku */
  kroki: Partial<Record<Krok['typ'], number>>
  /** kroki, które zostałyby pominięte (np. przejście niedozwolone, nadawanie wyłączone) */
  pominiete: number
  przyklady: string[]
  zdanie: string
}

const DNI_PODGLADU = 7

/**
 * „Co by było” dla reguły na zamówieniach z ostatnich 7 dni: zdarzenia z dziennika (albo bieżący stan dla reguł
 * czasowych i przycisków), warunki z bieżącego stanu, kroki tylko oceniane (bez zapisu, bez wywołań kanałów,
 * przewoźników i programu do faktur). Przybliżenie: warunek „status” oceniany na dzisiejszym statusie zamówienia.
 */
export async function podgladNaSucho(db: Db, r: RegulaT, ctx: CtxSilnika = {}): Promise<WynikPodgladu> {
  organizationIdOf(db)
  const now = ctx.now ?? new Date()
  const od = new Date(now.getTime() - DNI_PODGLADU * 86_400_000)
  const statusy = (await statusyFirmy(db)).statusy
  const orders = await db.order.findMany({ where: { OR: [{ createdAt: { gte: od } }, { updatedAt: { gte: od } }] }, select: { id: true, externalId: true, status: true, carrier: true, companyStatus: true, paymentState: true }, take: 3000, orderBy: { createdAt: 'desc' } })
  const out: WynikPodgladu = { dni: DNI_PODGLADU, zamowien: 0, zdarzen: 0, kroki: {}, pominiete: 0, przyklady: [], zdanie: '' }
  if (!orders.length) {
    out.zdanie = 'Brak zamówień z ostatnich 7 dni: nie ma na czym sprawdzić reguły.'
    return out
  }
  const byId = new Map(orders.map((o) => [o.id, o]))
  // okazje: (zamówienie) dla reguł czasowych i przycisków, (zamówienie, wpis dziennika) dla zdarzeń
  const okazje: { orderId: string }[] = []
  if (r.event === 'W_STATUSIE_DNI' || r.event === 'PRZYCISK') for (const o of orders) okazje.push({ orderId: o.id })
  else {
    const ev = await db.orderEvent.findMany({ where: { orderId: { in: [...byId.keys()] }, createdAt: { gte: od } }, select: { orderId: true, kind: true, actorId: true, data: true }, take: 20_000 })
    const oplacone = r.event === 'OPLACONO' ? await oplaconeJuzPrzyPrzyjeciu(db, [...new Set(ev.filter((e) => e.kind === 'PRZYJETE').map((e) => e.orderId))]) : new Set<string>()
    const opl = new Set<string>() // „opłacono” raz na zamówienie, jak w silniku (okazjaZdarzenia)
    for (const e of ev) {
      if (!zdarzeniaZDziennika(e, { oplaconePrzyPrzyjeciu: e.kind === 'PRZYJETE' && oplacone.has(e.orderId) }).includes(r.event)) continue
      if (r.event === 'OPLACONO') {
        if (opl.has(e.orderId)) continue
        opl.add(e.orderId)
      }
      okazje.push({ orderId: e.orderId })
    }
  }
  const trafione = new Set<string>()
  const praca = new Map<string, boolean>()
  for (const { orderId } of okazje) {
    const f = await faktyZamowienia(db, orderId, statusy, { zDniami: r.event === 'W_STATUSIE_DNI' ? now : undefined })
    if (!f || !spelniaWszystkie(r.conditions, f)) continue
    out.zdarzen++
    trafione.add(orderId)
    const o = byId.get(orderId)!
    for (const a of r.actions) {
      let ok = true
      if (a.typ === 'ustawStatus') {
        const def = statusy.find((d) => d.key === a.status)
        if (!def || (def.carriers.length && !def.carriers.includes((o.carrier ?? 'BRAK') as Carrier))) ok = false
        else if (def.baseStatus !== o.status) {
          ok = przejscieMozliwe(o.status as OrderStatus, def.baseStatus)
          if (ok) {
            if (!praca.has(orderId)) {
              const { kontoZamowienia, pracaDostepna } = await import('@/lib/praca/wlacznik')
              const full = await db.order.findUnique({ where: { id: orderId }, select: { channel: true, channelAccountId: true } })
              let p = false
              try {
                p = !!full && pracaDostepna(await kontoZamowienia(db, full, ctx.env ?? process.env), ctx.env ?? process.env)
              } catch {
                p = false
              }
              praca.set(orderId, p)
            }
            ok = praca.get(orderId)!
          }
        }
      } else if (a.typ === 'utworzPrzesylke') {
        const { bramkaNadania } = await import('@/lib/wysylka/nadanie')
        ok = !(await bramkaNadania(db, orderId, { ...(ctx.deps ?? {}), env: ctx.env ?? process.env }))?.powod
      } else if (a.typ === 'wyslijEmail' && a.szablon === 'brak-platnosci') ok = o.paymentState === 'UNPAID' || o.paymentState === 'PARTIAL'
      if (ok) out.kroki[a.typ] = (out.kroki[a.typ] ?? 0) + 1
      else out.pominiete++
    }
    if (out.przyklady.length < 8 && !out.przyklady.includes(o.externalId)) out.przyklady.push(o.externalId)
  }
  out.zamowien = trafione.size
  out.zdanie = zdaniePodgladu(out, r)
  return out
}

export function zdaniePodgladu(w: Pick<WynikPodgladu, 'zamowien' | 'kroki' | 'pominiete' | 'dni'>, r: Pick<RegulaT, 'event' | 'actions'>): string {
  if (!w.zamowien) return `Przez ostatnie ${w.dni} dni reguła nie zadziałałaby ani razu.`
  const c: string[] = []
  const k = w.kroki
  const n = (x: number, a: string, b: string, cc: string) => `${x} ${x === 1 ? a : x % 10 >= 2 && x % 10 <= 4 && (x % 100 < 10 || x % 100 >= 20) ? b : cc}`
  if (k.ustawStatus) c.push(`zmieniłaby status ${n(k.ustawStatus, 'zamówienia', 'zamówień', 'zamówień')}`)
  if (k.wyslijEmail) c.push(`wysłałaby ${n(k.wyslijEmail, 'mail', 'maile', 'maili')}`)
  if (k.utworzPrzesylke) c.push(`utworzyłaby ${n(k.utworzPrzesylke, 'przesyłkę', 'przesyłki', 'przesyłek')}`)
  if (k.drukujEtykiete) c.push(`wydrukowałaby ${n(k.drukujEtykiete, 'etykietę', 'etykiety', 'etykiet')}`)
  if (k.anulujZamowienie) c.push(`anulowałaby ${n(k.anulujZamowienie, 'zamówienie', 'zamówienia', 'zamówień')}`)
  if (k.oznacz) c.push(`oznaczyłaby ${n(k.oznacz, 'zamówienie', 'zamówienia', 'zamówień')}`)
  if (k.wystawFakture || k.anulujFakture) c.push(`zajęłaby się fakturą ${n((k.wystawFakture ?? 0) + (k.anulujFakture ?? 0), 'raz', 'razy', 'razy')}`)
  const pocz = r.event === 'PRZYCISK' ? `Przycisk pasowałby do ${n(w.zamowien, 'zamówienia', 'zamówień', 'zamówień')} z ostatnich ${w.dni} dni` : `Przez ostatnie ${w.dni} dni reguła zadziałałaby na ${n(w.zamowien, 'zamówieniu', 'zamówieniach', 'zamówieniach')}`
  return `${pocz}${c.length ? `: ${c.join(', ')}` : ''}.${w.pominiete ? ` ${n(w.pominiete, 'krok zostałby pominięty', 'kroki zostałyby pominięte', 'kroków zostałoby pominiętych')} (np. przejście niedozwolone albo nadawanie wyłączone).` : ''} Nic nie zostało zapisane ani wysłane.`
}

export { SZABLONY_MAILI, ZDARZENIA }
