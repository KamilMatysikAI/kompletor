// Akcje masowe z listy zamówień: zmiana statusu z powodem (ta sama droga co na karcie),
// utworzenie przesyłek z gabarytem (host przesyłek) i druk etykiet na stanowisku. Każde zamówienie osobno
// w try/catch: jedno złe zamówienie nie zatrzymuje reszty, wynik per zamówienie trafia do raportu (numer, ok/błąd,
// komunikat bez danych klienta). Uprawnienia sprawdza tu każda pozycja (zmienStatus sam, przesyłki i etykiety przez
// `UPRAWNIENIE`), także gdy akcja idzie w tle: worker czyta uprawnienia osoby na nowo w chwili wykonania.
// Poniżej PROG_TLA zamówień (per rodzaj, masowo-progi.ts) akcja wykonuje się od razu (wynik w toaście), od progu idzie
// w tle (OrderBulkAction + zadanie kolejki `zamowienia-masowo`), a panel odpytuje postęp. Powtórzenie jest bezpieczne:
// zmienStatus przy tym samym statusie nic nie robi, przesyłka jest jedna na paczkę, zlecenie druku ma klucz od
// przesyłki; worker po awarii wznawia od pierwszego zamówienia bez wyniku, wynik dopisuje pojedynczo.
import type { Permission } from '@/lib/auth/uprawnienia'
import type { Carrier, Prisma, PrismaClient } from '@prisma/client'
import { organizationIdOf } from '@/lib/db'
import { zlecZPanelu } from '@/lib/druk/panel'
import { BladDruku } from '@/lib/druk/zlecenia'
import { uprawnieniaOsoby } from '@/lib/klienci/odczyt'
import { powodZmiany, zmienStatus } from '@/lib/praca/status-dowolny'
import { enqueue } from '@/lib/worker/kolejka'
import { gabarytyDla, type Gabaryt } from '@/lib/stanowisko/gabaryty'
import { utworzPrzesylke } from '@/lib/wysylka/nadanie'
import { MAKS_ZAMOWIEN, RODZAJE, type RodzajAkcji } from './masowo-progi'

type Db = PrismaClient

export { MAKS_AKCJI, MAKS_ZAMOWIEN, NAZWA_AKCJI, PROG_TLA, RODZAJE, type RodzajAkcji } from './masowo-progi'
export const ZADANIE_MASOWE = 'zamowienia-masowo'
export const ZADANIE_SPRZATANIA = 'zamowienia-masowo-sprzatanie'
/** Akcja w toku albo czekająca bez ruchu dłużej niż to = przerwana (worker padł, zadanie wyczerpało próby). */
export const BEZ_RUCHU_MS = 60 * 60_000
/** Raporty zakończonych akcji starsze niż tyle dni są usuwane. */
export const RAPORT_DNI = 30

export const UPRAWNIENIE: Record<RodzajAkcji, Permission> = {
  STATUS: 'zamowienia.status_dowolny',
  PRZESYLKI: 'pakowanie.stanowisko',
  ETYKIETY: 'pakowanie.stanowisko',
}

export interface ParametryAkcji {
  status?: string
  powod?: string
  /** rozmiar paczki A/B/C (gabaryt dobiera się do przewoźnika zamówienia); puste = jedyny gabaryt przewoźnika */
  gabaryt?: string | null
  stanowisko?: string | null
  /** nazwa osoby do zlecenia druku (User nie jest czytelny dla roli aplikacji) */
  nazwa?: string
}

export interface WynikPozycji {
  id: string
  nr: string
  ok: boolean
  komunikat: string
}

export interface WynikAkcji {
  rodzaj: RodzajAkcji
  razem: number
  ok: number
  bledy: number
  pozycje: WynikPozycji[]
}

const ID_RE = /^[a-z0-9]{1,40}$/i
const ROZMIAR_RE = /^[ABC]$/

/** Identyfikatory z formularza: poprawne, bez powtórzeń, najwyżej MAKS_ZAMOWIEN. */
export function idZFormularza(v: unknown[]): { ids: string[]; zaDuzo: boolean } {
  const ids = [...new Set(v.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))]
  return { ids: ids.slice(0, MAKS_ZAMOWIEN), zaDuzo: ids.length > MAKS_ZAMOWIEN }
}

/** Walidacja parametrów przed startem (komunikat dla osoby) — także gdy akcja pójdzie w tle. */
export function bladParametrow(rodzaj: RodzajAkcji, p: ParametryAkcji): string | null {
  if (rodzaj === 'STATUS') {
    if (!p.status) return 'Wybierz nowy status.'
    if (!powodZmiany(p.powod)) return 'Podaj powód zmiany statusu (od 3 do 300 znaków): zostanie w historii każdego zamówienia.'
  }
  if (rodzaj === 'PRZESYLKI' && p.gabaryt && !ROZMIAR_RE.test(p.gabaryt)) return 'Nieznany gabaryt.'
  if (rodzaj === 'ETYKIETY' && (!p.stanowisko || !ID_RE.test(p.stanowisko))) return 'Wybierz stanowisko druku.'
  return null
}

/** Gabaryt z akcji masowej (rozmiar A/B/C wspólny dla przewoźników) → kod gabarytu dla przewoźnika zamówienia. */
export function gabarytDla(carrier: Carrier | null, rozmiar: string | null | undefined): Gabaryt | null {
  const lista = gabarytyDla(carrier)
  if (rozmiar) {
    const k = lista.find((g) => g.endsWith(`_${rozmiar}`))
    if (k) return k
  }
  return lista.length === 1 ? lista[0]! : null
}

/** Jedno zamówienie. Wyjątek zamienia się w wynik z błędem (bez treści wyjątku, która mogłaby nieść dane). */
export async function wykonajPozycje(db: Db, rodzaj: RodzajAkcji, p: ParametryAkcji, id: string, osoba: { id: string; uprawnienia: ReadonlySet<string> }): Promise<WynikPozycji> {
  const o = await db.order.findUnique({ where: { id }, select: { externalId: true, channelNumber: true, carrier: true } }).catch(() => null)
  const nr = o ? (o.channelNumber ?? o.externalId) : id
  const wynik = (ok: boolean, komunikat: string): WynikPozycji => ({ id, nr, ok, komunikat })
  try {
    if (!o) return wynik(false, 'Nie ma takiego zamówienia.')
    if (!osoba.uprawnienia.has(UPRAWNIENIE[rodzaj])) return wynik(false, 'Brak uprawnienia do tej akcji.')
    switch (rodzaj) {
      case 'STATUS': {
        const r = await zmienStatus(db, { orderId: id, status: String(p.status ?? ''), powod: p.powod, userId: osoba.id, uprawnienia: osoba.uprawnienia })
        if (r.blad) return wynik(false, r.blad)
        return wynik(true, r.zmiana ? 'Status zmieniony.' : 'Już był w tym statusie.')
      }
      case 'PRZESYLKI': {
        const w = await utworzPrzesylke(db, { orderId: id, gabaryt: gabarytDla(o.carrier, p.gabaryt), potwierdzoneOstrzezenia: [], userId: osoba.id })
        if (w.wynik === 'ODMOWA') return wynik(false, w.doPotwierdzenia?.length ? `${w.powod} Otwórz zamówienie i potwierdź na karcie.` : w.powod)
        if (w.wynik === 'BLAD') return wynik(false, `Przewoźnik nie utworzył przesyłki: ${w.powod}`)
        if (w.wynik === 'W_TOKU') return wynik(true, 'Przesyłka właśnie powstaje.')
        if (w.wynik === 'NIEJEDNOZNACZNA') return wynik(false, 'Nie wiadomo, czy przesyłka powstała: sprawdź na karcie zamówienia.')
        return wynik(true, w.istniala ? 'Przesyłka już była.' : `Przesyłka utworzona${w.przesylka.trackingNumber ? `, numer ${w.przesylka.trackingNumber}` : ''}.`)
      }
      case 'ETYKIETY': {
        const s = await db.shipment.findFirst({ where: { orderId: id, extraNo: 0, state: 'UTWORZONA', labelFetchedAt: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true } })
        if (!s) return wynik(false, 'Brak etykiety: najpierw utwórz przesyłkę.')
        await zlecZPanelu(db, { userId: osoba.id, nazwa: p.nazwa ?? 'panel' }, { typ: 'etykieta', ids: [id], stationId: String(p.stanowisko), klucz: `etykieta-${s.id}-masowo` })
        return wynik(true, 'Etykieta wysłana do druku.')
      }
    }
  } catch (e) {
    if (e instanceof BladDruku) return wynik(false, `Druk: ${e.message}`)
    // treść innego wyjątku zostaje w logu serwera, nie w raporcie (mógłby nieść dane z adaptera)
    console.error(`[zamowienia-masowo] ${rodzaj} ${id}:`, e instanceof Error ? e.message : e)
    return wynik(false, 'Nieoczekiwany błąd: spróbuj na karcie zamówienia.')
  }
}

function podsumuj(rodzaj: RodzajAkcji, pozycje: WynikPozycji[]): WynikAkcji {
  const ok = pozycje.filter((x) => x.ok).length
  return { rodzaj, razem: pozycje.length, ok, bledy: pozycje.length - ok, pozycje }
}

/** Akcja od razu (poniżej PROG_TLA zamówień danego rodzaju), po kolei. */
export async function wykonajOdRazu(db: Db, rodzaj: RodzajAkcji, p: ParametryAkcji, ids: string[], osoba: { id: string; uprawnienia: ReadonlySet<string> }): Promise<WynikAkcji> {
  organizationIdOf(db)
  const pozycje: WynikPozycji[] = []
  for (const id of ids) pozycje.push(await wykonajPozycje(db, rodzaj, p, id, osoba))
  return podsumuj(rodzaj, pozycje)
}

/** Akcja w tle: wiersz z postępem i zadanie kolejki. Zwraca id akcji. */
export async function zlecWTle(db: Db, rodzaj: RodzajAkcji, p: ParametryAkcji, ids: string[], userId: string): Promise<string> {
  organizationIdOf(db)
  const a = await db.orderBulkAction.create({ data: { kind: rodzaj, params: p as Prisma.InputJsonValue, orderIds: ids, createdBy: userId }, select: { id: true } })
  await enqueue(db, ZADANIE_MASOWE, { akcja: a.id }, { dedupeKey: `${ZADANIE_MASOWE}:${a.id}`, maxAttempts: 3 })
  return a.id
}

function wynikiZJson(v: Prisma.JsonValue): WynikPozycji[] {
  return Array.isArray(v) ? (v as unknown as WynikPozycji[]).filter((x) => x && typeof x.id === 'string') : []
}

/** Numer próby zadania kolejki: przy ostatniej błąd kończy akcję stanem BLAD zamiast czekać na ponowienie. */
export interface ProbaZadania {
  attempts: number
  maxAttempts: number
}

/**
 * Czy zamówienie ma już wynik w akcji. Czytane przed każdą pozycją, nie raz na starcie: drugi worker na tej samej
 * akcji (zadanie uznane za porzucone i wzięte ponownie) pomija to, co zrobił pierwszy. Brak wiersza = nic do roboty.
 */
export async function maWynik(db: Db, akcja: string, orderId: string): Promise<boolean> {
  const r = await db.$queryRaw<{ jest: boolean }[]>`SELECT results @> ${JSON.stringify([{ id: orderId }])}::jsonb AS jest FROM "OrderBulkAction" WHERE id = ${akcja}`
  return r[0]?.jest ?? true
}

/**
 * Dopisanie wyniku jednego zamówienia: `results || [wynik]` i liczniki `+ 1` w jednym UPDATE, tylko gdy
 * tego zamówienia jeszcze nie ma w wynikach. Dwa workery nie nadpisują sobie tablicy, a zapis nie przepisuje całej
 * rosnącej tablicy przy każdym zamówieniu.
 */
export async function dopiszWynik(db: Db, akcja: string, w: WynikPozycji, now = new Date()): Promise<void> {
  await db.$executeRaw`UPDATE "OrderBulkAction"
    SET results = results || ${JSON.stringify([w])}::jsonb, done = done + 1, ok = ok + ${w.ok ? 1 : 0}, failed = failed + ${w.ok ? 0 : 1}, "updatedAt" = ${now}
    WHERE id = ${akcja} AND NOT (results @> ${JSON.stringify([{ id: w.id }])}::jsonb)`
}

/** `czego` w dopełniaczu liczby mnogiej („zamówień”, „przesyłek”: lista przesyłek korzysta z tej samej tabeli). */
export const komunikatPrzerwania = (zrobione: number, razem: number, czego = 'zamówień'): string =>
  `Akcja przerwana: wyniki są dla ${zrobione} z ${razem} ${czego}, reszty nie ruszono. Zaznacz pozostałe i uruchom akcję jeszcze raz.`

/**
 * Handler zadania kolejki: wykonuje akcję, dopisuje wynik po każdym zamówieniu, wznawia po awarii. Błąd poza pozycją
 * (baza, sieć) przy ostatniej próbie zadania kończy akcję stanem BLAD z opisem, przy wcześniejszej
 * idzie dalej do ponowienia przez kolejkę.
 */
export async function wykonajWTle(db: Db, payload: Prisma.JsonValue, proba?: ProbaZadania): Promise<void> {
  const id = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>)['akcja'] : undefined
  if (typeof id !== 'string' || !ID_RE.test(id)) return
  const a = await db.orderBulkAction.findUnique({ where: { id } })
  if (!a || a.state === 'GOTOWE' || a.state === 'BLAD') return
  const rodzaj = a.kind as RodzajAkcji
  if (!RODZAJE.includes(rodzaj)) {
    await db.orderBulkAction.update({ where: { id }, data: { state: 'BLAD', lastError: 'Nieznany rodzaj akcji.', finishedAt: new Date() } })
    return
  }
  try {
    const p = (a.params ?? {}) as ParametryAkcji
    const uprawnienia = await uprawnieniaOsoby(db, a.createdBy)
    await db.orderBulkAction.updateMany({ where: { id, state: { in: ['CZEKA', 'TRWA'] } }, data: { state: 'TRWA' } })
    for (const oid of a.orderIds) {
      if (await maWynik(db, id, oid)) continue
      const w = await wykonajPozycje(db, rodzaj, p, oid, { id: a.createdBy, uprawnienia })
      await dopiszWynik(db, id, w)
    }
    // akcja oznaczona w międzyczasie jako przerwana (sprzątanie) zostaje w BLAD
    await db.orderBulkAction.updateMany({ where: { id, state: { in: ['CZEKA', 'TRWA'] } }, data: { state: 'GOTOWE', finishedAt: new Date() } })
  } catch (e) {
    if (proba && proba.attempts >= proba.maxAttempts) {
      const teraz = await db.orderBulkAction.findUnique({ where: { id }, select: { done: true } }).catch(() => null)
      await db.orderBulkAction
        .updateMany({ where: { id, state: { in: ['CZEKA', 'TRWA'] } }, data: { state: 'BLAD', lastError: komunikatPrzerwania(teraz?.done ?? 0, a.orderIds.length), finishedAt: new Date() } })
        .catch(() => undefined)
    }
    throw e
  }
}

/**
 * Sprzątanie akcji (zadanie z harmonogramu, co 15 min): (a) CZEKA/TRWA bez ruchu dłużej niż BEZ_RUCHU_MS → BLAD z
 * liczbą zamówień, które mają wynik (worker umarł albo zadanie kolejki wyczerpało próby); (b) raporty
 * zakończonych akcji starsze niż RAPORT_DNI usuwane (w wynikach są tylko numery i komunikaty, bez danych klienta).
 */
export async function sprzatajAkcje(db: Db, now = new Date()): Promise<{ przerwane: number; usuniete: number }> {
  organizationIdOf(db)
  const prog = new Date(now.getTime() - BEZ_RUCHU_MS)
  const stare = await db.orderBulkAction.findMany({ where: { state: { in: ['CZEKA', 'TRWA'] }, updatedAt: { lt: prog } }, select: { id: true, kind: true, done: true, orderIds: true } })
  let przerwane = 0
  for (const a of stare) {
    try {
      const r = await db.orderBulkAction.updateMany({
        where: { id: a.id, state: { in: ['CZEKA', 'TRWA'] }, updatedAt: { lt: prog } },
        data: { state: 'BLAD', lastError: komunikatPrzerwania(a.done, a.orderIds.length, a.kind.startsWith('PRZESYLKI_') ? 'przesyłek' : 'zamówień'), finishedAt: now },
      })
      przerwane += r.count
    } catch (e) {
      console.error(`[zamowienia-masowo] sprzątanie ${a.id}:`, e instanceof Error ? e.message : e)
    }
  }
  const usun = await db.orderBulkAction.deleteMany({ where: { state: { in: ['GOTOWE', 'BLAD'] }, finishedAt: { lt: new Date(now.getTime() - RAPORT_DNI * 24 * 3600_000) } } })
  return { przerwane, usuniete: usun.count }
}

export interface StanAkcji {
  id: string
  rodzaj: RodzajAkcji
  stan: 'CZEKA' | 'TRWA' | 'GOTOWE' | 'BLAD'
  razem: number
  zrobione: number
  ok: number
  bledy: number
  /** pierwsze błędy (do raportu w panelu) */
  przyklady: WynikPozycji[]
  /** opis przerwania (stan BLAD), np. „wyniki są dla 120 z 400 zamówień” */
  blad: string | null
}

export function stanZWiersza(a: { id: string; kind: string; state: string; orderIds: string[]; done: number; ok: number; failed: number; results: Prisma.JsonValue; lastError?: string | null }): StanAkcji {
  return {
    id: a.id,
    rodzaj: a.kind as RodzajAkcji,
    stan: a.state as StanAkcji['stan'],
    razem: a.orderIds.length,
    zrobione: a.done,
    ok: a.ok,
    bledy: a.failed,
    przyklady: wynikiZJson(a.results)
      .filter((x) => !x.ok)
      .slice(0, 10),
    blad: a.state === 'BLAD' ? (a.lastError ?? 'Akcja przerwana.') : null,
  }
}

/** Stan akcji tej osoby (inna osoba z firmy nie odpytuje cudzych akcji). */
export async function stanAkcji(db: Db, id: string, userId: string): Promise<StanAkcji | null> {
  if (!ID_RE.test(id)) return null
  const a = await db.orderBulkAction.findFirst({ where: { id, createdBy: userId } })
  return a ? stanZWiersza(a) : null
}

/**
 * Akcje tej osoby w toku albo zakończone w ostatnich 15 minutach (pasek postępu po odświeżeniu listy). Akcja „w toku”
 * bez ruchu od godziny przestaje się pokazywać, a sprzątanie (`sprzatajAkcje`) oznacza ją jako przerwaną (BLAD).
 */
export async function ostatnieAkcje(db: Db, userId: string, now = new Date()): Promise<StanAkcji[]> {
  const od = new Date(now.getTime() - 15 * 60_000)
  // akcje listy przesyłek (ten sam wiersz, inne rodzaje) pokazuje lista przesyłek, nie lista zamówień
  const rows = await db.orderBulkAction.findMany({ where: { createdBy: userId, kind: { in: [...RODZAJE] }, OR: [{ state: { in: ['CZEKA', 'TRWA'] }, updatedAt: { gte: new Date(now.getTime() - 60 * 60_000) } }, { finishedAt: { gte: od } }] }, orderBy: { createdAt: 'desc' }, take: 3 })
  return rows.map(stanZWiersza)
}
