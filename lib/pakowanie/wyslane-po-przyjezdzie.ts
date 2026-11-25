// (akcje BL 8 i 13): „Przyjechał <przewoźnik>” = „Wysłane” i śledzenie przesyłki jako siatka.
//
// Po kliknięciu „Przyjechał DPD” (lib/pakowanie/dane.ts `markCarrierArrived`) jedna operacja w tle (zadanie kolejki
// ZADANIE_WYSLANE_PO_PRZYJEZDZIE) przenosi do „Wysłane” wszystkie zamówienia tego przewoźnika spakowane przed
// przyjazdem, które mają przesyłkę z numerem nadania. Przejście tylko przez rdzeń (`moveOrderInTx`: Spakowane → Do
// wysłania → Wysłane w jednej transakcji, te same warunki co przy ręcznym kliknięciu na karcie), więc skutki są te same:
// mail „Faktura” z planu akcji (reguła poziomowa na statusie Wysłane, lib/akcje/silnik.ts), status i numer nadania do
// sklepu przez host zapisu (lib/kanaly/zapis-host.ts: plan ze statusu i ze zdarzenia WYSLANE z numerem). Bez nowej
// drogi zapisu do kanału. Raport „przeniesiono N, pominięto M (powód)” w CarrierPickupShipping, widoczny przy pasku
// kuriera.
//
// Każde zamówienie osobno w try/catch (jedno złe nie zatrzymuje reszty). Idempotentnie: zamówienie już wysłane nie jest
// kandydatem, drugie kliknięcie tego dnia nie tworzy nowego zdarzenia ani zadania (unikalny odbiór dnia).
//
// Bramki: zmiana statusu tylko dla konta w trybie pracy na instancji z trybem pracy (`pracaDostepna`, jak sekcja „Co
// dalej” na karcie); zapis do sklepu tylko przez host z jego wyłącznikami (konto aktywne, PRACA, `zapisWlaczony`).
// Bez danych klientów: w raporcie numer zamówienia i powód.
import type { Carrier, OrderStatus, Prisma, PrismaClient, Shipment } from '@prisma/client'
import { organizationIdOf } from '../db'
import { defaultRegistry } from '../adaptery/domyslne'
import { AdapterError, BladKontaSledzenia, BladPrzesylkiSledzenia, hasShipmentTracker, type ChannelAdapter, type OdczytPrzesylki } from '../adaptery/kontrakt'
import { AdapterConfigError } from '../adaptery/rejestr'
import { jestOdlozone, klasaBledu, kluczKonta } from '../integracje/oslona'
import { INPOST_SHIPX_ZAPIS_MANIFEST } from '../adaptery/inpost-zapis'
import { PP_ZAPIS_MANIFEST } from '../adaptery/pocztapolska'
import { ALLEGRO_WYSYLAM_ZAPIS_KEY } from '../adaptery/allegro-wysylam-zapis'
import { BASE_COURIER_ZAPIS_KEY } from '../adaptery/basecourier-zapis'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { kontoZamowienia, pracaDostepna } from '../praca/wlacznik'
import { lockOrder, moveOrderInTx } from '../rdzen/przejscia'
import { runTx } from '../rdzen/stan'
import { TransitionError } from '../rdzen/statusy'
import { enqueue } from '../worker/kolejka'
import { automatyWysylki, regulyDrogiPrzewoznikow, sledzeniePrzewoznikow, type AutomatyWysylki, type SledzeniePrzewoznikow } from '../wysylka/automaty'
import { adapterDlaPrzesylki, type DepsNadania, progZawieszenia, zrodloSekretow } from '../wysylka/nadanie'
import { SledzenieDpdPrzebiegu } from '../wysylka/sledzenie-dpd'
import { alert } from '../rdzen/stan'
import {
  ALERT_PROBLEM_PRZESYLKI,
  ALERT_ZWROT_PRZESYLKI,
  kluczAlertuProblemu,
  kluczAlertuZwrotu,
  skutkiDrogi,
  trescAlertuDrogi,
  wszystkieDoreczone,
} from '../wysylka/reguly-drogi'
import { czasPrzewoznika, jestKoncowy, odstepSledzenia, OPIS_STANU_DROGI, poPrzekazaniu, SLEDZENIE_DO_KONCA_DNI, STANY_DROGI, stanDrogiZeStanu, type StanDrogi } from '../wysylka/stany-przesylki'

/** strojenie klienta DPD w przebiegu śledzenia (testy: adres atrapy, bez czekania między próbami). */
type OpcjeSledzeniaDpd = ConstructorParameters<typeof SledzenieDpdPrzebiegu>[2]

type Db = PrismaClient
type Env = Record<string, string | undefined>

export const ZADANIE_WYSLANE_PO_PRZYJEZDZIE = 'pakowanie-wyslane-po-przyjezdzie'
export const ZADANIE_SLEDZENIA = 'wysylka-sledzenie'
/** Spakowane czytamy z ostatnich dni (jak kolejka pakowania, PACKED_WINDOW_DAYS). */
const OKNO_DNI = 14
/** Najwięcej pominiętych zapisanych w raporcie (reszta tylko w liczbie). */
const MAKS_POZYCJI = 200
/** Śledzenie: tylko przesyłki starsze niż tyle (kurier zwykle przyjeżdża tego samego dnia). */
export const SLEDZENIE_PO_MS = 30 * 60_000
/** Śledzenie: ta sama przesyłka najczęściej co tyle. */
export const SLEDZENIE_CO_MS = 30 * 60_000
/** Śledzenie: przesyłek na jeden przebieg. */
const SLEDZENIE_PACZKA = 50
/**
 * Śledzenie aż do doręczenia: przesyłek po „Wysłane” na jeden przebieg, ponad SLEDZENIE_PACZKA (te mają pierwszeństwo,
 * bo od nich zależy „Wysłane”). Przebieg co 15 min = do 400 odczytów na godzinę.
 */
export const SLEDZENIE_PACZKA_DO_KONCA = 100
/**
 * Śledzenie: nieznany stan nieprzerwanie co najmniej tyle = koniec próbkowania. Przeżywa weekend i długi weekend
 * przed odbiorem (etykieta w środę 23.12, kurier w poniedziałek 28.12 to ponad 4 doby).
 */
export const SLEDZENIE_NIEZNANY_MS = 5 * 86_400_000
/** Śledzenie: po tylu kolejnych błędach sieci jednego konta reszta jego przesyłek czeka do następnego przebiegu. */
export const SLEDZENIE_BLEDY_SIECI_LIMIT = 3
/**
 * Śledzenie aż do doręczenia: nieudany odczyt jednej przesyłki (nie konta) z rzędu n-ty raz = następny odczyt za
 * min(SLEDZENIE_CO_MS × 2^(n−1), SLEDZENIE_BLAD_MAKS_MS); po SLEDZENIE_BLEDY_STOP błędach z rzędu przesyłka po
 * „Wysłane” nie jest już pytana (trwały błąd: ok. 8 dni prób zamiast odczytu co pół godziny przez 30 dni).
 */
export const SLEDZENIE_BLAD_MAKS_MS = 12 * 3600_000
export const SLEDZENIE_BLEDY_STOP = 20

/** Odstęp do następnego odczytu po n-tym nieudanym odczycie przesyłki z rzędu (n ≥ 1). */
export function odstepPoBledzie(n: number): number {
  return Math.min(SLEDZENIE_CO_MS * 2 ** Math.max(0, n - 1), SLEDZENIE_BLAD_MAKS_MS)
}
/**
 * Śledzenie po „Wysłane” bez osi (19.11.2026, przełącznik „Śledź paczki aż do doręczenia” wyłączony): ta sama
 * przesyłka najczęściej co tyle, aż przewoźnik potwierdzi doręczenie; sam zapis statusu do karty zamówienia i API.
 */
export const SLEDZENIE_PO_WYSYLCE_CO_MS = 2 * 3600_000
/**
 * Śledzenie po „Wysłane” bez osi: pytamy przewoźnika najwyżej tyle dni od „Wysłane” (paczka niedoręczona dłużej =
 * sprawa dla człowieka). Z osią granicą jest SLEDZENIE_DO_KONCA_DNI.
 */
export const SLEDZENIE_PO_WYSLANIU_DNI = 7
/** raport w „czeka/w toku” dłużej niż tyle = operacja nie skończyła się (awaria, brak zadania). */
export const RAPORT_ZAWIESZONY_MS = 30 * 60_000

const DO_WYSLANIA_ZE: readonly OrderStatus[] = ['SPAKOWANE', 'DO_WYSLANIA']
const PO_WYSYLCE: readonly OrderStatus[] = ['WYSLANE', 'ODEBRANE']

export interface PominieteZamowienie {
  nr: string
  powod: string
}

export type StanRaportu = 'CZEKA' | 'W_TOKU' | 'ZROBIONE' | 'WYLACZONE' | 'BLAD'
const STANY_RAPORTU: readonly StanRaportu[] = ['CZEKA', 'W_TOKU', 'ZROBIONE', 'WYLACZONE', 'BLAD']

export interface RaportPrzyjazdu {
  stan: StanRaportu
  przeniesiono: number
  pominieto: number
  pominiete: PominieteZamowienie[]
  /**
   * zamówienia tego przewoźnika ze sklepów w trybie podglądu (statusy prowadzi tam BaseLinker), poza
   * listą kandydatów i poza „pominięte”; w raporcie tylko ta liczba, żeby realne pominięcia nie tonęły w szumie.
   */
  wPodgladzie: number
}

export type WynikWyslania = { ok: true; zmiana: boolean; nr: string } | { ok: false; powod: string; nr: string }

const krotko = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 300)

/**
 * Jedno zamówienie: spakowane albo „Do wysłania” z przesyłką z numerem nadania → „Wysłane” przez rdzeń. Zamówienie bez
 * numeru nadania, z przesyłką do rozstrzygnięcia albo na koncie bez trybu pracy zostaje (wynik z powodem).
 */
export async function wyslijPoOdbiorze(db: Db, orderId: string, ctx: { actorId: string; env?: Env; now?: Date }): Promise<WynikWyslania> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, channel: true, channelAccountId: true, externalId: true, channelNumber: true, packageNo: true } })
  if (!o) return { ok: false, powod: 'Nie ma takiego zamówienia.', nr: orderId }
  const nr = o.channelNumber ?? o.externalId
  if (PO_WYSYLCE.includes(o.status)) return { ok: true, zmiana: false, nr }
  if (!DO_WYSLANIA_ZE.includes(o.status)) return { ok: false, powod: 'Zamówienie nie jest już spakowane.', nr }
  let dostepna: boolean
  try {
    dostepna = pracaDostepna(await kontoZamowienia(db, o, ctx.env ?? process.env), ctx.env ?? process.env)
  } catch {
    return { ok: false, powod: 'Zmiana statusu wyłączona na tej instancji (zła wartość ustawienia trybu pracy).', nr }
  }
  if (!dostepna) return { ok: false, powod: 'Sklep w trybie podglądu: status zmienia się tam, gdzie paczkę nadano.', nr }
  const now = ctx.now ?? new Date()
  try {
    const wynik = await runTx(db, async (tx): Promise<boolean | string> => {
      // blokada zamówienia przed odczytem statusu: przyjazd i śledzenie naraz nie dają „niedozwolonego przejścia”
      const teraz = await lockOrder(tx, o.id)
      if (PO_WYSYLCE.includes(teraz.status)) return false
      if (!DO_WYSLANIA_ZE.includes(teraz.status)) throw new TransitionError('Zamówienie nie jest już spakowane.')
      // przesyłka czytana pod blokadą zamówienia, więc „Anuluj przesyłkę” w międzyczasie nie
      // da „Wysłane” z numerem anulowanej przesyłki
      // tylko główna przesyłka: dodatkowa (dosyłka) nie daje „Wysłane” ani numeru zamówienia
      const s = await tx.shipment.findFirst({ where: { orderId: o.id, packageNo: o.packageNo, extraNo: 0, state: { in: ['TWORZENIE', 'UTWORZONA', 'NIEJEDNOZNACZNA'] } }, orderBy: { createdAt: 'desc' } })
      const powod = powodPrzesylki(s, now)
      if (powod || !s?.trackingNumber) return powod ?? 'Przewoźnik nie nadał jeszcze numeru przesyłki: „Pobierz etykietę” na karcie zamówienia.'
      const trackingNo = s.trackingNumber
      if (teraz.status === 'SPAKOWANE') await moveOrderInTx(tx, o.id, 'DO_WYSLANIA', { actorId: ctx.actorId, now, trackingNo })
      await moveOrderInTx(tx, o.id, 'WYSLANE', { actorId: ctx.actorId, now, trackingNo })
      return true
    })
    if (typeof wynik === 'string') return { ok: false, powod: wynik, nr }
    return { ok: true, zmiana: wynik, nr }
  } catch (e) {
    if (e instanceof TransitionError) return { ok: false, powod: krotko(e.message), nr }
    throw e
  }
}

/**
 * Dlaczego przesyłka nie pozwala oznaczyć „Wysłane” (null = pozwala). TWORZENIE w progu modułu to
 * przesyłka, która właśnie powstaje (kliknięcie trwa); dopiero po progu albo przy NIEJEDNOZNACZNEJ rozstrzyga człowiek.
 */
function powodPrzesylki(s: Pick<Shipment, 'state' | 'trackingNumber' | 'updatedAt' | 'adapterKey'> | null, now: Date): string | null {
  if (!s) return 'Brak numeru nadania: przesyłka nie powstała w Kompletorze. Oznacz „Wysłane” na karcie zamówienia.'
  if (s.state === 'TWORZENIE' && now.getTime() - s.updatedAt.getTime() <= progZawieszenia(s.adapterKey))
    return 'Przesyłka właśnie powstaje u przewoźnika: przejdzie do „Wysłane” przy następnym odbiorze albo przyciskiem „Wysłane” na karcie zamówienia.'
  if (s.state !== 'UTWORZONA') return 'Przesyłka do rozstrzygnięcia ręcznie: sprawdź ją na karcie zamówienia.'
  if (!s.trackingNumber) return 'Przewoźnik nie nadał jeszcze numeru przesyłki: „Pobierz etykietę” na karcie zamówienia.'
  return null
}

// ─── „Przyjechał <przewoźnik>” ───────────────────────────────────────────────

/**
 * Zlecenie operacji w tle po pierwszym kliknięciu przyjazdu dnia (wołane z `markCarrierArrived`). Firma z wyłączonym
 * automatem: nic (raportu nie ma, przyjazd zamyka tylko odbiór). Idempotentne: raport i zadanie mają klucz zdarzenia.
 */
export async function zlecWyslanePoPrzyjezdzie(db: Db, ev: { id: string; carrier: Carrier }): Promise<boolean> {
  organizationIdOf(db)
  if (!(await automatyWysylki(db)).wyslanePoPrzyjezdzie) return false
  await db.carrierPickupShipping.createMany({ data: [{ eventId: ev.id, carrier: ev.carrier, state: 'CZEKA' }], skipDuplicates: true })
  await enqueue(db, ZADANIE_WYSLANE_PO_PRZYJEZDZIE, { eventId: ev.id }, { dedupeKey: `przyjazd-wyslane:${ev.id}`, maxAttempts: 3 })
  return true
}

/**
 * Kandydaci: zamówienia przewoźnika spakowane (albo „Do wysłania”) przed przyjazdem kuriera, z kont w trybie pracy.
 * zamówienia sklepów w podglądzie (statusami rządzi tam BaseLinker) nie są kandydatami, wracają
 * tylko jako liczba `wPodgladzie`. Bramka w `wyslijPoOdbiorze` zostaje drugą linią obrony (śledzenie, zmiana trybu
 * w trakcie). Błędne ustawienie trybu pracy instancji: zamówienie zostaje kandydatem, żeby powód trafił do raportu.
 */
async function kandydaci(db: Db, carrier: Carrier, arrivedAt: Date, env: Env): Promise<{ ids: string[]; wPodgladzie: number }> {
  const since = new Date(arrivedAt.getTime() - OKNO_DNI * 86_400_000)
  const rows = await db.order.findMany({
    where: { carrier, status: { in: [...DO_WYSLANIA_ZE] }, updatedAt: { gte: since } },
    orderBy: [{ createdAtChannel: 'asc' }, { id: 'asc' }],
    take: 3000,
    select: { id: true, channel: true, channelAccountId: true, updatedAt: true, events: { where: { kind: 'SPAKOWANE' }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } } },
  })
  // Spakowane po przyjeździe kuriera nie pojechało (jak „pojechało” w kolejce pakowania: chwila spakowania ≤ przyjazd).
  // Zamówienie „Do wysłania” bez zdarzenia SPAKOWANE (np. status zmieniony ręcznie) liczy się od `updatedAt`, więc po
  // późniejszej zmianie (notatka, płatność) zostaje poza raportem, choć mogło być spakowane wcześniej.
  const pojechaly = rows.filter((r) => (r.events[0]?.createdAt ?? r.updatedAt) <= arrivedAt)
  const praca = new Map<string, boolean>()
  for (const r of pojechaly) {
    const k = `${r.channel}/${r.channelAccountId}`
    if (praca.has(k)) continue
    let ok: boolean
    try {
      ok = pracaDostepna(await kontoZamowienia(db, r, env), env)
    } catch {
      ok = true
    }
    praca.set(k, ok)
  }
  const ids: string[] = []
  let wPodgladzie = 0
  for (const r of pojechaly) {
    if (praca.get(`${r.channel}/${r.channelAccountId}`)) ids.push(r.id)
    else wPodgladzie++
  }
  return { ids, wPodgladzie }
}

/** Operacja w tle: wszystkie kandydatki po kolei, wynik do raportu. Ponowienie po awarii liczy od nowa (idempotentnie). */
export async function wyslanePoPrzyjezdzie(db: Db, eventId: string, ctx: { env?: Env; now?: Date } = {}): Promise<RaportPrzyjazdu> {
  const organizationId = organizationIdOf(db)
  const ev = await db.carrierPickupEvent.findUnique({ where: { id: eventId } })
  if (!ev) return { stan: 'ZROBIONE', przeniesiono: 0, pominieto: 0, pominiete: [], wPodgladzie: 0 }
  const key = { organizationId_eventId: { organizationId, eventId } }
  await db.carrierPickupShipping.upsert({ where: key, create: { eventId, carrier: ev.carrier, state: 'W_TOKU' }, update: { state: 'W_TOKU' } })
  try {
    return await przeniesPoPrzyjezdzie(db, ev, key, ctx)
  } catch (e) {
    // awaria w połowie (np. baza) nie zostawia paska „Przenoszę…” na zawsze; ponowienie zadania
    // ustawi znów „w toku” i policzy od nowa (idempotentnie)
    await db.carrierPickupShipping.update({ where: key, data: { state: 'BLAD', doneAt: ctx.now ?? new Date() } }).catch(() => {})
    throw e
  }
}

async function przeniesPoPrzyjezdzie(
  db: Db,
  ev: { carrier: Carrier; arrivedAt: Date; actorId: string },
  key: { organizationId_eventId: { organizationId: string; eventId: string } },
  ctx: { env?: Env; now?: Date },
): Promise<RaportPrzyjazdu> {
  if (!(await automatyWysylki(db)).wyslanePoPrzyjezdzie) {
    await db.carrierPickupShipping.update({ where: key, data: { state: 'WYLACZONE', doneAt: ctx.now ?? new Date() } })
    return { stan: 'WYLACZONE', przeniesiono: 0, pominieto: 0, pominiete: [], wPodgladzie: 0 }
  }
  let przeniesiono = 0
  const pominiete: PominieteZamowienie[] = []
  let pominieto = 0
  const { ids, wPodgladzie } = await kandydaci(db, ev.carrier, ev.arrivedAt, ctx.env ?? process.env)
  for (const id of ids) {
    let w: WynikWyslania
    try {
      w = await wyslijPoOdbiorze(db, id, { actorId: `user:${ev.actorId}`, env: ctx.env, now: ctx.now })
    } catch (e) {
      // treść wyjątku zostaje w logu serwera, nie w raporcie (mogłaby nieść dane z adaptera)
      console.error(`[${ZADANIE_WYSLANE_PO_PRZYJEZDZIE}] ${id}:`, e instanceof Error ? e.message : e)
      w = { ok: false, powod: 'Nieoczekiwany błąd: oznacz „Wysłane” na karcie zamówienia.', nr: id }
    }
    if (w.ok) {
      if (w.zmiana) przeniesiono++
      continue
    }
    pominieto++
    if (pominiete.length < MAKS_POZYCJI) pominiete.push({ nr: w.nr, powod: w.powod })
  }
  await db.carrierPickupShipping.update({
    where: key,
    data: { state: 'ZROBIONE', moved: przeniesiono, skipped: pominieto, skippedPreview: wPodgladzie, details: pominiete as unknown as Prisma.InputJsonValue, doneAt: ctx.now ?? new Date() },
  })
  return { stan: 'ZROBIONE', przeniesiono, pominieto, pominiete, wPodgladzie }
}

/** Handler zadania kolejki: payload `{ eventId }`. */
export async function zadanieWyslanePoPrzyjezdzie(db: Db, payload: Prisma.JsonValue, ctx: { env?: Env } = {}): Promise<RaportPrzyjazdu> {
  const eventId = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>)['eventId'] : undefined
  if (typeof eventId !== 'string' || !/^[a-z0-9]{1,40}$/i.test(eventId)) throw new Error(`${ZADANIE_WYSLANE_PO_PRZYJEZDZIE}: brak eventId`)
  return wyslanePoPrzyjezdzie(db, eventId, ctx)
}

/**
 * Raporty przyjazdów po id zdarzenia (pasek kuriera na ekranie pakowania). „czeka/w toku” starsze
 * niż RAPORT_ZAWIESZONY_MS (zadanie nie powstało albo padło bez śladu) pokazujemy jako „nie udało się”.
 */
export async function raportyPrzyjazdow(db: Db, eventIds: string[], now: Date = new Date()): Promise<Map<string, RaportPrzyjazdu>> {
  if (!eventIds.length) return new Map()
  const rows = await db.carrierPickupShipping.findMany({ where: { eventId: { in: eventIds } } })
  const stanRaportu = (r: { state: string; updatedAt: Date }): StanRaportu => {
    const st: StanRaportu = (STANY_RAPORTU as readonly string[]).includes(r.state) ? (r.state as StanRaportu) : 'W_TOKU'
    return (st === 'CZEKA' || st === 'W_TOKU') && now.getTime() - r.updatedAt.getTime() > RAPORT_ZAWIESZONY_MS ? 'BLAD' : st
  }
  return new Map(
    rows.map((r) => [
      r.eventId,
      {
        stan: stanRaportu(r),
        przeniesiono: r.moved,
        pominieto: r.skipped,
        wPodgladzie: r.skippedPreview,
        pominiete: Array.isArray(r.details) ? (r.details as unknown as PominieteZamowienie[]).filter((x) => x && typeof x.nr === 'string' && typeof x.powod === 'string') : [],
      },
    ]),
  )
}

/** „Wysłane: 5 · pominięte 2” (pasek kuriera). */
export function tekstRaportu(r: Pick<RaportPrzyjazdu, 'stan' | 'przeniesiono' | 'pominieto'>): string {
  if (r.stan === 'CZEKA' || r.stan === 'W_TOKU') return 'Przenoszę spakowane do „Wysłane”…'
  if (r.stan === 'WYLACZONE') return 'Automat „Wysłane” wyłączony w ustawieniach'
  if (r.stan === 'BLAD') return 'Nie udało się przenieść spakowanych do „Wysłane”: oznacz je na karcie zamówienia'
  return r.pominieto ? `Do „Wysłane”: ${r.przeniesiono} · pominięte: ${r.pominieto}` : `Do „Wysłane”: ${r.przeniesiono}`
}

/** jedna linia o zamówieniach sklepów w podglądzie („3 zamówienia ze sklepów w trybie podglądu pominięto”); 0 = null. */
export function tekstPodgladu(n: number): string | null {
  if (!(n > 0)) return null
  const d10 = n % 10
  const d100 = n % 100
  const slowo = n === 1 ? 'zamówienie' : d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14) ? 'zamówienia' : 'zamówień'
  return `${n} ${slowo} ze sklepów w trybie podglądu pominięto`
}

// ─── Śledzenie przesyłki (siatka) ────────────────────────────────────────────

export interface WynikSledzenia {
  sprawdzone: number
  przeniesione: number
  bledy: string[]
}

/**
 * Moduły śledzone od początku automatu (domyślnie włączone). Każdy moduł, który dostaje śledzenie później, jest
 * domyślnie wyłączony: firma włącza go w Ustawienia → Wysyłka i druk → Przewoźnicy → „Automatyczne statusy wysyłki”.
 * Base Courier: śledzony na produkcji od 19.11.2026 (przed listą wyborów na tej gałęzi), więc zostaje domyślnie włączony.
 * Wysyłam z Allegro: śledzony na produkcji od 22.11.2026 (każdy moduł z `shipment.track` bez listy wyborów), więc też.
 * DPD bezpośrednio: paczki DPD pyta osobna droga przez konto DPD firmy (lib/wysylka/sledzenie-dpd.ts), niezależnie od
 * tej listy; moduł DPD na liście (DPDInfoServices z osobnymi danymi) zostaje domyślnie wyłączony.
 */
export const SLEDZENIE_DOMYSLNIE_WLACZONE: ReadonlySet<string> = new Set([INPOST_SHIPX_ZAPIS_MANIFEST.adapterKey, PP_ZAPIS_MANIFEST.adapterKey, BASE_COURIER_ZAPIS_KEY, ALLEGRO_WYSYLAM_ZAPIS_KEY])

export function sledzenieModulu(adapterKey: string, wybory: SledzeniePrzewoznikow = {}): boolean {
  return typeof wybory[adapterKey] === 'boolean' ? wybory[adapterKey] : SLEDZENIE_DOMYSLNIE_WLACZONE.has(adapterKey)
}

/**
 * Moduły domyślnie objęte regułami na osi („Odebrane” po doręczeniu, powiadomienia o zwrocie i problemie): te, których
 * kody końcowe (doręczenie, zwrot, punkt odbioru) są potwierdzone. Każdy inny moduł (dziś DPD, jutro każdy nowy) jest
 * domyślnie poza regułami: stan paczki widać w historii, a status zamówienia zmienia dopiero zaznaczenie przez firmę.
 */
export const REGULY_DROGI_DOMYSLNIE_WLACZONE: ReadonlySet<string> = new Set([INPOST_SHIPX_ZAPIS_MANIFEST.adapterKey, PP_ZAPIS_MANIFEST.adapterKey, ALLEGRO_WYSYLAM_ZAPIS_KEY])

export function regulyDrogiModulu(adapterKey: string, wybory: SledzeniePrzewoznikow = {}): boolean {
  return typeof wybory[adapterKey] === 'boolean' ? wybory[adapterKey] : REGULY_DROGI_DOMYSLNIE_WLACZONE.has(adapterKey)
}

/** Moduły przewoźników, które podają stan przesyłki od ręki (`shipment.track`), z nazwą do ekranu ustawień. */
export function modulySledzenia(registry: AdapterRegistry): { adapterKey: string; nazwa: string }[] {
  return registry
    .list()
    .filter((m) => m.kind === 'carrier' && m.capabilities.includes('shipment.track'))
    .map((m) => ({ adapterKey: m.adapterKey, nazwa: m.displayName }))
}

/** Klucze modułów ze śledzeniem, włączone w firmie (`wybory` z `Organization.settings.wysylkaSledzenie`). */
export function kluczeSledzenia(registry: AdapterRegistry, wybory: SledzeniePrzewoznikow = {}): string[] {
  return modulySledzenia(registry)
    .map((m) => m.adapterKey)
    .filter((k) => sledzenieModulu(k, wybory))
}

/**
 * Przesyłka w przebiegu: `doWyslania` = z kolejki „Wysłane” (zamówienie spakowane albo „Do wysłania” przy wyborze);
 * `tylkoStatus` = po „Wysłane” bez osi (19.11.2026): sam zapis statusu i zdarzenia do karty zamówienia i API.
 */
type PrzesylkaSledzona = Shipment & { doWyslania: boolean; tylkoStatus?: boolean }

/**
 * Moduły ze śledzeniem, które zwracają doręczenie (`trackReportsDelivered`): tylko je pytamy po „Wysłane” bez osi
 * (inaczej warunek końca, zdarzenie DORECZONA, nigdy nie zachodzi).
 */
export function kluczeSledzeniaDoDoreczenia(registry: AdapterRegistry): string[] {
  return registry
    .list()
    .filter((m) => m.kind === 'carrier' && m.capabilities.includes('shipment.track') && m.trackReportsDelivered === true)
    .map((m) => m.adapterKey)
}

/**
 * Jeden przebieg śledzenia: spakowane z numerem nadania, starsze niż SLEDZENIE_PO_MS, których magazyn nie przeniósł
 * do „Wysłane” (nie kliknął przyjazdu). Przewoźnik mówi „u nas” = „Wysłane” tą samą drogą co pkt 1. Przewoźnik bez
 * śledzenia nie jest pytany. Każda przesyłka osobno; błędy razem w wyjątku na końcu (ślad w Job.lastError).
 * paczka DPD/DPD_EMPIK z numerem listu przy firmie z kompletnym kontem DPD jest pytana prosto w DPD
 * (DPDInfoServices, lib/wysylka/sledzenie-dpd.ts); brak konta, brak zdarzeń albo błąd DPD = droga modułu przesyłki.
 *
 * Z włączonym „Śledź paczki aż do doręczenia” (domyślnie wyłączone) dodatkowo: przesyłki zamówień po „Wysłane” (i w
 * każdym innym statusie poza kolejką „Wysłane”) do stanu końcowego na osi, najdłużej SLEDZENIE_DO_KONCA_DNI od
 * utworzenia, z odstępem wg stanu (`nextTrackAt`); przy każdej przesyłce zapis osi i wiersz historii przy zmianie.
 * Dla nich bez zmiany statusu zamówienia i bez zdarzenia zamówienia „status przesyłki” (automatyczne akcje widzą
 * śledzenie jak dotąd, tylko przed „Wysłane”). Wyłączone = ten sam wybór i te same zapisy co przed dodaniem osi.
 */
export async function sledzeniePrzesylek(db: Db, deps: DepsNadania & { env?: Env; dpd?: OpcjeSledzeniaDpd } = {}): Promise<WynikSledzenia> {
  organizationIdOf(db)
  const wynik: WynikSledzenia = { sprawdzone: 0, przeniesione: 0, bledy: [] }
  const automaty = await automatyWysylki(db)
  if (!automaty.sledzenie) return wynik
  const doKonca = automaty.sledzenieDoDoreczenia
  const registry = deps.registry ?? defaultRegistry()
  const klucze = kluczeSledzenia(registry, await sledzeniePrzewoznikow(db))
  // paczki DPD (także nadane przez Base Courier) pytamy prosto w DPD, gdy firma ma kompletne konto DPD;
  // przewoźnicy z kontem wchodzą do zapytań niezależnie od modułu przesyłki i od listy przewoźników do pytania
  const dpd = new SledzenieDpdPrzebiegu(db, zrodloSekretow(deps), { fetch: deps.fetch, ...deps.dpd })
  const przewoznicyDpd = await dpd.przewoznicy()
  if (!klucze.length && !przewoznicyDpd.length) return wynik
  const modulLubDpd = (kl: string[]): Prisma.ShipmentWhereInput => ({
    OR: [{ adapterKey: { in: kl } }, ...(przewoznicyDpd.length ? [{ carrier: { in: przewoznicyDpd }, trackingNumber: { not: null } }] : [])],
  })
  const now = deps.now?.() ?? new Date()
  const doWyslania = await db.shipment.findMany({
    where: {
      state: 'UTWORZONA',
      trackingNumber: { not: null },
      externalRef: { not: null },
      trackingStoppedAt: null,
      createdAt: { lte: new Date(now.getTime() - SLEDZENIE_PO_MS), gte: new Date(now.getTime() - OKNO_DNI * 86_400_000) },
      AND: [modulLubDpd(klucze), { OR: [{ trackedAt: null }, { trackedAt: { lt: new Date(now.getTime() - SLEDZENIE_CO_MS) } }] }],
      // kolejka „Wysłane” tylko dla głównej przesyłki: odbiór dosyłki nie zmienia statusu zamówienia (dodatkowa
      // spakowanego zamówienia czeka na odczyt po „Wysłane”, w śledzeniu do doręczenia)
      extraNo: 0,
      order: { status: { in: [...DO_WYSLANIA_ZE] } },
    },
    orderBy: [{ trackedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: SLEDZENIE_PACZKA,
  })
  const lista: PrzesylkaSledzona[] = doWyslania.map((s) => ({ ...s, doWyslania: true }))
  if (doKonca) for (const s of await poWyslaniu(db, klucze, now, doWyslania.map((x) => x.id))) lista.push({ ...s, doWyslania: false })
  // 19.11.2026 (produkcja): bez osi paczki już wysłane sprawdzamy dalej (rzadziej), aż przewoźnik potwierdzi
  // doręczenie; tylko zapis statusu do karty zamówienia i API (zdarzenie PRZESYLKA_STATUS z opisem), bez zmiany
  // statusu zamówienia. Z osią (doKonca) tę rolę pełni poWyslaniu. Tylko moduły, które zwracają doręczenie (inaczej
  // warunek końca nigdy nie zachodzi), i najwyżej SLEDZENIE_PO_WYSLANIU_DNI od „Wysłane”.
  else {
    const doreczenie = new Set(kluczeSledzeniaDoDoreczenia(registry))
    const kluczeDoreczenia = klucze.filter((k) => doreczenie.has(k))
    if (kluczeDoreczenia.length || przewoznicyDpd.length)
      for (const s of await db.shipment.findMany({
        where: {
          id: { notIn: doWyslania.map((x) => x.id) },
          state: 'UTWORZONA',
          externalRef: { not: null },
          trackingStoppedAt: null,
          // tylko główna przesyłka: stan dosyłki nie może zastąpić na karcie stanu głównej paczki
          extraNo: 0,
          createdAt: { gte: new Date(now.getTime() - OKNO_DNI * 86_400_000) },
          AND: [modulLubDpd(kluczeDoreczenia), { OR: [{ trackedAt: null }, { trackedAt: { lt: new Date(now.getTime() - SLEDZENIE_PO_WYSYLCE_CO_MS) } }] }],
          order: {
            status: 'WYSLANE',
            AND: [
              { events: { some: { kind: 'WYSLANE', createdAt: { gte: new Date(now.getTime() - SLEDZENIE_PO_WYSLANIU_DNI * 86_400_000) } } } },
              { events: { none: { kind: 'PRZESYLKA_STATUS', data: { path: ['stan'], equals: 'DORECZONA' } } } },
            ],
          },
        },
        orderBy: [{ trackedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
        take: SLEDZENIE_PACZKA,
      }))
        lista.push({ ...s, doWyslania: false, tylkoStatus: true })
  }
  const przerwane = new Set<string>()
  const bledySieci = new Map<string, number>()
  // reguły firmy na osi tylko ze śledzeniem aż do doręczenia; bez niego ani odczytu ustawień, ani zapytań
  const kontekstRegul: KontekstRegulDrogi | null = doKonca ? { automaty, przewoznicy: await regulyDrogiPrzewoznikow(db), env: deps.env ?? process.env, now } : null
  const regulyDrogi = kontekstRegul ? (id: string) => wykonajRegulyDrogi(db, id, kontekstRegul, wynik.bledy) : null
  const obsluzone = new Set<string>()
  // Kolejka następnego przebiegu idzie po `trackedAt` rosnąco. Przesyłka z błędem staje za pytanymi w tym przebiegu
  // (`now + 1 ms`), a niepytana z przerwanego konta przed nimi (`now − 1 ms`): ta sama przesyłka z błędem na czele
  // nie zatrzymuje reszty konta w każdym przebiegu. Obie wartości są świeże, więc zepsute konto z wieloma
  // przesyłkami nie zajmuje miejsc przesyłek innych kont, czekających dłużej (ich `trackedAt` jest starszy).
  // z osią: przesyłka z błędem konta czeka też na termin odczytu (SLEDZENIE_CO_MS), żeby zepsute konto nie było
  // pytane co przebieg; kolejka po „Wysłane” też idzie po `trackedAt` (nextTrackAt to tylko termin), więc niepytane
  // przesyłki zepsutego konta (`now − 1 ms`) stają za przesyłkami innych kont, czekającymi dłużej
  const odloz = (id: string, przesuniecieMs: number) =>
    db.shipment
      .update({ where: { id }, data: { trackedAt: new Date(now.getTime() + przesuniecieMs), ...(doKonca && przesuniecieMs > 0 ? { nextTrackAt: new Date(now.getTime() + SLEDZENIE_CO_MS) } : {}) } })
      .catch(() => {})
  const odlozPoBledzie = (id: string) => odloz(id, 1)
  const odlozNiepytana = (id: string) => odloz(id, -1)
  // błąd tej przesyłki (nie konta): bez osi jak dotąd; z osią licznik błędów z rzędu, rosnący odstęp, a po
  // SLEDZENIE_BLEDY_STOP koniec pytania przesyłki po „Wysłane” (kolejka „Wysłane” ma swoje okno OKNO_DNI, bez zmian)
  const poBledziePrzesylki = (s: PrzesylkaSledzona) => {
    if (!doKonca) return odlozPoBledzie(s.id)
    const n = s.trackFailures + 1
    const stop = !s.doWyslania && n >= SLEDZENIE_BLEDY_STOP
    return db.shipment
      .update({ where: { id: s.id }, data: { trackedAt: new Date(now.getTime() + 1), nextTrackAt: new Date(now.getTime() + odstepPoBledzie(n)), trackFailures: n, ...(stop ? { trackingStoppedAt: now } : {}) } })
      .catch(() => {})
  }
  for (const s of lista) {
    let konto = `${s.adapterKey}|${s.accountSuffix ?? ''}`
    let nazwa = s.adapterKey
    try {
      // najpierw DPD (gdy dotyczy); brak wyniku albo błąd DPD = droga modułu przesyłki (np. Base Courier)
      let t: OdczytPrzesylki | null = await dpd.odczyt(s)
      if (!t) {
        let a: ChannelAdapter
        try {
          a = await adapterDlaPrzesylki(db, s, deps)
        } catch (e) {
          wynik.bledy.push(`${s.reference}: ${krotko(e instanceof Error ? e.message : String(e))}`)
          await poBledziePrzesylki(s)
          continue
        }
        konto = `${s.adapterKey}|${kluczKonta(a) ?? s.accountSuffix ?? ''}`
        nazwa = `${a.manifest.displayName}${s.accountSuffix ? ` (konto ${s.accountSuffix})` : ''}`
        // konto przerwane w tym przebiegu (błąd konta, kilka błędów sieci z rzędu): przesyłka czeka do następnego
        if (przerwane.has(konto)) {
          await odlozNiepytana(s.id)
          continue
        }
        if (!hasShipmentTracker(a)) throw new BladKontaSledzenia(BEZ_SLEDZENIA)
        t = await a.trackShipment(s.externalRef!)
        bledySieci.set(konto, 0)
      }
      wynik.sprawdzone++
      const nowyStatus = t.status?.slice(0, 60) ?? null
      // nieznany stan liczony czasem od pierwszego odczytu serii (etykieta w piątek, kurier w poniedziałek = dalej pytamy).
      // Próg dotyczy tylko kolejki „Wysłane” (paczka przed odbiorem): po „Wysłane” granicą jest okno
      // SLEDZENIE_DO_KONCA_DNI, a „anulowana” po przekazaniu przewoźnikowi nie kończy śledzenia (np. Allegro: 404
      // przesyłki po czasie przechowywania); bez osi wszystkie przesyłki są z kolejki „Wysłane”, więc jak dotąd
      const nieznanyOd = t.stan === 'NIEZNANY' ? (s.trackingUnknownSince ?? now) : null
      const anulowana = t.stan === 'ANULOWANA' && !(doKonca && s.handedOverAt)
      const koniec = anulowana || (s.doWyslania && nieznanyOd !== null && now.getTime() - nieznanyOd.getTime() >= SLEDZENIE_NIEZNANY_MS)
      const dane = { trackedAt: now, carrierStatus: nowyStatus, trackingUnknownSince: nieznanyOd, ...(koniec ? { trackingStoppedAt: now } : {}) }
      if (doKonca) {
        const ostrzezenie = await zapiszOs(db, s, t, nowyStatus, dane, now)
        if (ostrzezenie) wynik.bledy.push(ostrzezenie)
      } else await db.shipment.update({ where: { id: s.id }, data: dane })
      // zmiana statusu u przewoźnika = wpis w dzienniku zamówienia (zdarzenie „Zmieniono status przesyłki
      // u kuriera” automatycznych akcji); ten sam status przy kolejnym odczycie nie daje wpisu. W kolejce „Wysłane”,
      // jak przed osią (z osią po „Wysłane” droga paczki idzie do historii przesyłki, nie do automatów), i bez osi
      // po „Wysłane” (19.11.2026: stan paczki na karcie zamówienia i w API). Opis przewoźnika obcięty do 120 znaków.
      // Doręczenie po „Wysłane” bez osi zapisuje zdarzenie także przy tym samym kodzie (flaga doręczenia w Base
      // Courier); zdarzenie DORECZONA wyklucza przesyłkę z kolejnych przebiegów, więc wpis jest jeden.
      const doreczonaPoWysylce = s.tylkoStatus === true && t.stan === 'DORECZONA'
      if ((s.doWyslania || s.tylkoStatus) && nowyStatus && (nowyStatus !== s.carrierStatus || doreczonaPoWysylce))
        await db.orderEvent.create({ data: { orderId: s.orderId, kind: 'PRZESYLKA_STATUS', actorId: AKTOR_SLEDZENIA, data: { przesylka: s.id, status: nowyStatus, stan: t.stan, ...(t.opis ? { opis: t.opis.slice(0, 120) } : {}) } } })
      // DORECZONA (Base Courier) = paczka pojechała, jak PRZEKAZANA
      if (s.doWyslania && (t.stan === 'PRZEKAZANA' || t.stan === 'DORECZONA')) {
        const w = await wyslijPoOdbiorze(db, s.orderId, { actorId: AKTOR_SLEDZENIA, env: deps.env, now })
        if (w.ok && w.zmiana) wynik.przeniesione++
      }
      // reguły firmy na osi po „Wysłane” (także zaraz po przeniesieniu do „Wysłane” w tym przebiegu); błąd reguł nie
      // jest błędem odczytu przesyłki: znacznik zostaje, następny przebieg ponawia
      if (regulyDrogi) {
        obsluzone.add(s.id)
        await regulyDrogi(s.id)
      }
    } catch (e) {
      const m = krotko(e instanceof Error ? e.message : String(e))
      if (bladKontaSledzenia(e)) {
        // dane logowania, wyłącznik, konfiguracja, konto wyłączone albo limit: dotyczy każdej przesyłki konta i minie po
        // poprawie ustawień; przesyłki zostają w śledzeniu, konto czeka do następnego przebiegu, jedna linia błędu
        przerwane.add(konto)
        wynik.bledy.push(`${nazwa}: ${m}`)
        await odlozPoBledzie(s.id)
        continue
      }
      wynik.bledy.push(`${s.reference}: ${m}`)
      if (e instanceof BladPrzesylkiSledzenia) {
        // przesyłki nie ma u przewoźnika albo zły numer: pytanie jej znowu nic nie da
        await db.shipment.update({ where: { id: s.id }, data: { trackedAt: now, trackingStoppedAt: now } }).catch(() => {})
        continue
      }
      // reszta (sieć, limit, inna odmowa): kolejna próba za SLEDZENIE_CO_MS (z osią: rosnący odstęp), za pozostałymi
      await poBledziePrzesylki(s)
      if (e instanceof AdapterError && e.kind === 'PRZEJSCIOWY') {
        const n = (bledySieci.get(konto) ?? 0) + 1
        bledySieci.set(konto, n)
        if (n >= SLEDZENIE_BLEDY_SIECI_LIMIT) {
          przerwane.add(konto)
          wynik.bledy.push(`${nazwa}: ${n} błędy sieci z rzędu, pozostałe przesyłki tego konta w następnym przebiegu`)
        }
      }
    }
  }
  // zaległe reguły (awaria w trakcie poprzedniego przebiegu): przesyłka w stanie końcowym nie jest już pytana, więc
  // jej reguły wykonują się stąd
  if (regulyDrogi)
    // przesyłki z nieudanymi próbami na końcu: kilkadziesiąt trwale błędnych nie zagłodzi pozostałych
    for (const z of await db.shipment.findMany({ where: { trackRulesPending: true, id: { notIn: [...obsluzone] } }, orderBy: [{ trackRulesFailures: 'asc' }, { updatedAt: 'asc' }], take: REGULY_DROGI_ZALEGLE, select: { id: true } }))
      await regulyDrogi(z.id)
  const bladDpd = dpd.podsumowanieBledow()
  if (bladDpd) wynik.bledy.push(bladDpd)
  return wynik
}

const AKTOR_SLEDZENIA = 'system:sledzenie-przesylki'
/** Zaległych przesyłek z regułami do ponowienia na jeden przebieg. */
const REGULY_DROGI_ZALEGLE = 50
/**
 * Nieudanych prób reguł jednej przesyłki z rzędu (przebieg co 15 minut, czyli ok. 2 godziny), po których znacznik
 * schodzi: przesyłka nie wraca w każdym przebiegu bez końca, a następna zmiana stanu paczki daje reguły od nowa.
 */
export const REGULY_DROGI_PROB = 8
const AKTYWNE_PRZESYLKI: Shipment['state'][] = ['TWORZENIE', 'UTWORZONA', 'NIEJEDNOZNACZNA']

interface KontekstRegulDrogi {
  automaty: AutomatyWysylki
  przewoznicy: SledzeniePrzewoznikow
  env: Env
  now: Date
}

/**
 * Reguły firmy dla wierszy historii przesyłki, których jeszcze nie obsłużono (`trackRulesPending`), w jednej transakcji
 * pod blokadą zamówienia, razem ze zdjęciem znacznika: ponowienie po awarii robi to samo albo nic.
 *   1. Wpis w historii zamówienia (PRZESYLKA_STAN: przesyłka, wiersz historii, stan, kod przewoźnika) przy każdej
 *      zmianie stanu, gdy zamówienie jest poza kolejką „Wysłane” (tam drogę paczki opisuje PRZESYLKA_STATUS). Bez
 *      zdarzeń automatycznych akcji (lib/automaty/silnik.ts go nie mapuje). Raz na wiersz historii.
 *   2. Skutki bieżącego stanu (lib/wysylka/reguly-drogi.ts): tylko konto w trybie pracy (jak „Wysłane” ze śledzenia)
 *      i przewoźnik z listy objętych regułami. „Odebrane” przez rdzeń (`moveOrderInTx`, te same skutki co ręczne
 *      kliknięcie: status do sklepu przez host zapisu, plan maili po dokumencie), tylko z „Wysłane” i gdy każda
 *      aktywna przesyłka zamówienia jest doręczona; powiadomienia z kluczem na przesyłkę (jedno na przesyłkę).
 * Błąd = linia w wyniku przebiegu, znacznik zostaje do następnego przebiegu; po REGULY_DROGI_PROB błędach z rzędu
 * znacznik schodzi z jedną linią „pominięte” (do następnej zmiany stanu paczki).
 */
async function wykonajRegulyDrogi(db: Db, shipmentId: string, k: KontekstRegulDrogi, bledy: string[]): Promise<void> {
  try {
    const s0 = await db.shipment.findUnique({ where: { id: shipmentId }, select: { orderId: true, reference: true, trackRulesPending: true } })
    if (!s0?.trackRulesPending) return
    const o = await db.order.findUnique({ where: { id: s0.orderId }, select: { id: true, channel: true, channelAccountId: true } })
    if (!o) return
    let praca = false
    try {
      praca = pracaDostepna(await kontoZamowienia(db, o, k.env), k.env)
    } catch {
      praca = false
    }
    const odmowa = await runTx(db, async (tx): Promise<string | null> => {
      const teraz = await lockOrder(tx, o.id)
      const s = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } })
      if (!s.trackRulesPending) return null
      const kolejno = { orderBy: [{ observedAt: 'desc' as const }, { occurredAt: 'desc' as const }] }
      // bez wcześniej obsłużonego wiersza (pierwsze reguły tej przesyłki) tylko najnowszy: bez wpisów wstecz
      const nowe = (await tx.shipmentTrackEvent.findMany({ where: { shipmentId, ...(s.trackRulesAt ? { observedAt: { gt: s.trackRulesAt } } : {}) }, ...kolejno, take: s.trackRulesAt ? 20 : 1 })).reverse()
      const ostatni = nowe.at(-1)
      if (!ostatni) {
        await tx.shipment.update({ where: { id: s.id }, data: { trackRulesPending: false } })
        return null
      }
      let poprzedni = (await tx.shipmentTrackEvent.findFirst({ where: { shipmentId, observedAt: { lt: nowe[0]!.observedAt } }, ...kolejno, select: { state: true } }))?.state ?? null
      for (const e of nowe) {
        if (e.state !== poprzedni && !DO_WYSLANIA_ZE.includes(teraz.status)) {
          const jest = await tx.orderEvent.findFirst({ where: { orderId: teraz.id, kind: 'PRZESYLKA_STAN', data: { path: ['zdarzenie'], equals: e.id } }, select: { id: true } })
          if (!jest) await tx.orderEvent.create({ data: { orderId: teraz.id, kind: 'PRZESYLKA_STAN', actorId: AKTOR_SLEDZENIA, data: { przesylka: s.id, zdarzenie: e.id, stan: e.state, kod: e.carrierCode } } })
        }
        poprzedni = e.state
      }
      const stan = s.trackState ?? ostatni.state
      const sk = skutkiDrogi(stan, {
        odebrane: k.automaty.odebranePoDoreczeniu,
        powiadomienia: k.automaty.powiadomieniaODrodze,
        przewoznikObjety: regulyDrogiModulu(s.adapterKey, k.przewoznicy),
        praca,
      })
      const nr = teraz.channelNumber ?? teraz.externalId
      if (sk.zamknijProblem) await tx.alert.updateMany({ where: { dedupeKey: kluczAlertuProblemu(s.id), closedAt: null }, data: { closedAt: k.now } })
      // zwrot tego zamówienia już przyjęty w magazynie (paczka wróciła przed odczytem): powiadomienie nic nie wnosi
      const zwrotPrzyjety = sk.alert === 'ZWROT' && (await tx.return.count({ where: { orderId: teraz.id, kind: { in: ['ZWROT', 'REKLAMACJA'] }, receivedAt: { not: null } } })) > 0
      if (sk.alert === 'ZWROT' && !zwrotPrzyjety) await alert(tx, ALERT_ZWROT_PRZESYLKI, teraz.id, trescAlertuDrogi('ZWROT', { nr, numerNadania: s.trackingNumber, kod: ostatni.carrierCode }), kluczAlertuZwrotu(s.id))
      if (sk.alert === 'PROBLEM') await alert(tx, ALERT_PROBLEM_PRZESYLKI, teraz.id, trescAlertuDrogi('PROBLEM', { nr, numerNadania: s.trackingNumber, kod: ostatni.carrierCode }), kluczAlertuProblemu(s.id))
      let powod: string | null = null
      // „Odebrane” liczy się od głównej przesyłki: doręczenie dosyłki go nie daje, a niedoręczona dosyłka go nie wstrzymuje
      if (sk.odebrane && teraz.status === 'WYSLANE' && s.extraNo === 0) {
        const aktywne = await tx.shipment.findMany({ where: { orderId: teraz.id, packageNo: teraz.packageNo, extraNo: 0, state: { in: AKTYWNE_PRZESYLKI } }, select: { trackState: true } })
        if (wszystkieDoreczone(aktywne)) {
          try {
            await moveOrderInTx(tx, teraz.id, 'ODEBRANE', { actorId: AKTOR_SLEDZENIA, now: k.now })
          } catch (e) {
            // odmowa rdzenia (warunek przejścia) przed jakimkolwiek zapisem: status zostaje, reguła się nie powtarza
            if (!(e instanceof TransitionError)) throw e
            powod = `${s.reference}: „Odebrane” po doręczeniu pominięte (${krotko(e.message)})`
          }
        }
      }
      await tx.shipment.update({ where: { id: s.id }, data: { trackRulesPending: false, trackRulesAt: ostatni.observedAt, trackRulesFailures: 0 } })
      return powod
    })
    if (odmowa) bledy.push(odmowa)
  } catch (e) {
    const blad = krotko(e instanceof Error ? e.message : String(e))
    try {
      const { trackRulesFailures: n, reference } = await db.shipment.update({ where: { id: shipmentId }, data: { trackRulesFailures: { increment: 1 } }, select: { trackRulesFailures: true, reference: true } })
      if (n >= REGULY_DROGI_PROB) {
        await db.shipment.updateMany({ where: { id: shipmentId, trackRulesPending: true }, data: { trackRulesPending: false } })
        bledy.push(`${reference}: reguły po zmianie stanu paczki nie przeszły ${n} razy z rzędu, pominięte do następnej zmiany stanu (${blad})`)
        return
      }
    } catch {
      // licznik niezapisany (np. baza niedostępna): znacznik zostaje, następny przebieg spróbuje znowu
    }
    bledy.push(`reguły przesyłki ${shipmentId}: ${blad}`)
  }
}

/**
 * Przesyłki po „Wysłane” do odczytu (śledzenie aż do doręczenia): z modułu ze śledzeniem, z numerem, niezakończone, nie
 * w stanie końcowym osi, nie starsze niż SLEDZENIE_DO_KONCA_DNI, z terminem odczytu, który minął (bez terminu: jak
 * w kolejce „Wysłane”, ostatni odczyt ponad SLEDZENIE_CO_MS temu). Zamówienia z kolejki „Wysłane” idą osobno.
 * Kolejność jak w kolejce „Wysłane”: najdawniej pytane pierwsze (`trackedAt`), nie najwcześniejszy termin: przesyłki
 * konta przerwanego w przebiegu (`trackedAt = now − 1 ms`) nie zajmują czoła kolejki w kolejnych przebiegach. Po
 * włączeniu przełącznika zaległe przesyłki z okna 30 dni schodzą partiami po SLEDZENIE_PACZKA_DO_KONCA.
 */
async function poWyslaniu(db: Db, klucze: string[], now: Date, pomin: string[]): Promise<Shipment[]> {
  const koncowe = STANY_DROGI.filter(jestKoncowy)
  return db.shipment.findMany({
    where: {
      id: { notIn: pomin },
      state: 'UTWORZONA',
      adapterKey: { in: klucze },
      trackingNumber: { not: null },
      externalRef: { not: null },
      trackingStoppedAt: null,
      createdAt: { lte: new Date(now.getTime() - SLEDZENIE_PO_MS), gte: new Date(now.getTime() - SLEDZENIE_DO_KONCA_DNI * 86_400_000) },
      AND: [
        { OR: [{ trackState: null }, { trackState: { notIn: koncowe } }] },
        { OR: [{ nextTrackAt: { lte: now } }, { nextTrackAt: null, OR: [{ trackedAt: null }, { trackedAt: { lt: new Date(now.getTime() - SLEDZENIE_CO_MS) } }] }] },
      ],
      order: { status: { notIn: [...DO_WYSLANIA_ZE] } },
    },
    orderBy: [{ trackedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: SLEDZENIE_PACZKA_DO_KONCA,
  })
}

/**
 * Stan na osi do zapisu z odczytu przewoźnika i zapisanego stanu przesyłki (czysta funkcja, jedno miejsce dla
 * wszystkich przewoźników). Kolejno: stan końcowy ze zdarzenia sprzed utworzenia przesyłki (ponownie użyty numer
 * listu) = nieznany z ostrzeżeniem; zapisany zwrot zostaje zwrotem (doręczenie po nim to doręczenie do nadawcy); po
 * przekazaniu przewoźnikowi nie wracamy do „utworzona” ani „anulowana”; nieznany nie nadpisuje znanego stanu (zmienia
 * się wtedy tylko kod przewoźnika w historii).
 */
export function stanDoZapisu(
  odczyt: StanDrogi,
  czasZdarzenia: Date | null,
  s: Pick<Shipment, 'trackState' | 'handedOverAt' | 'createdAt'>,
): { stan: StanDrogi; przedUtworzeniem: boolean } {
  const przedUtworzeniem = jestKoncowy(odczyt) && czasZdarzenia !== null && czasZdarzenia.getTime() < s.createdAt.getTime()
  let stan: StanDrogi = przedUtworzeniem ? 'NIEZNANY' : odczyt
  const poprzedni = s.trackState
  if (poprzedni === 'ZWROT') return { stan: 'ZWROT', przedUtworzeniem }
  if (s.handedOverAt && (stan === 'UTWORZONA' || stan === 'ANULOWANA')) stan = poprzedni ?? 'PRZEKAZANA'
  if (stan === 'NIEZNANY' && poprzedni && poprzedni !== 'NIEZNANY') stan = poprzedni
  return { stan, przedUtworzeniem }
}

/**
 * Zapis odczytu z osią statusów: pola śledzenia jak dotąd + stan na osi (`stanDoZapisu`), od kiedy, przekazanie,
 * doręczenie, termin następnego odczytu, zerowany licznik błędów; przy zmianie stanu albo kodu przewoźnika wiersz
 * historii z kodem zdarzenia, z którego wyliczono stan. Jedna transakcja, więc ponowienie po awarii nie daje dubla
 * (historia porównywana z zapisanym stanem przesyłki, unikalny klucz z kodem dla tego samego czasu). Wynik =
 * ostrzeżenie do dziennika zadania (stan końcowy sprzed utworzenia przesyłki) albo null.
 */
async function zapiszOs(db: Db, s: Shipment, t: OdczytPrzesylki, nowyStatus: string | null, dane: Prisma.ShipmentUpdateInput, now: Date): Promise<string | null> {
  const odczyt: StanDrogi = t.stanDrogi && (STANY_DROGI as readonly string[]).includes(t.stanDrogi) ? t.stanDrogi : stanDrogiZeStanu(t.stan)
  const czasZdarzenia = czasPrzewoznika(t.czas, now)
  const czas = czasZdarzenia ?? now
  const { stan, przedUtworzeniem } = stanDoZapisu(odczyt, czasZdarzenia, s)
  const kod = (t.kod ?? '').slice(0, 60)
  const zmianaStanu = stan !== s.trackState
  const odstep = odstepSledzenia(stan)
  // data przekazania: pierwsze zdarzenie po przekazaniu u przewoźnika (DPD, Allegro, Poczta), inaczej czas zdarzenia,
  // inaczej chwila odczytu (InPost); czas sprzed utworzenia przesyłki nie jest datą przekazania tej przesyłki
  const poUtworzeniu = (d: Date | null) => (d && d.getTime() >= s.createdAt.getTime() ? d : null)
  const przekazana = poPrzekazaniu(stan) || t.stan === 'PRZEKAZANA'
  const przekazanaO = poUtworzeniu(czasPrzewoznika(t.przekazanaO, now)) ?? poUtworzeniu(czasZdarzenia) ?? now
  await db.$transaction(async (tx) => {
    // nowy wiersz historii = reguły firmy do obsłużenia (znacznik w tej samej transakcji co wiersz)
    const wiersz =
      zmianaStanu || nowyStatus !== s.carrierStatus
        ? (await tx.shipmentTrackEvent.createMany({ data: [{ shipmentId: s.id, state: stan, carrierCode: kod, carrierStatus: nowyStatus, occurredAt: czas }], skipDuplicates: true })).count > 0
        : false
    await tx.shipment.update({
      where: { id: s.id },
      data: {
        ...dane,
        trackState: stan,
        trackStateSince: zmianaStanu || !s.trackStateSince ? czas : s.trackStateSince,
        handedOverAt: s.handedOverAt ?? (przekazana ? przekazanaO : null),
        deliveredAt: s.deliveredAt ?? (stan === 'DORECZONA' ? czas : null),
        nextTrackAt: odstep === null ? null : new Date(now.getTime() + odstep),
        trackFailures: 0,
        ...(wiersz ? { trackRulesPending: true, trackRulesFailures: 0 } : {}),
      },
    })
  })
  return przedUtworzeniem ? `${s.reference}: przewoźnik podał stan „${OPIS_STANU_DROGI[odczyt]}” ze zdarzenia sprzed utworzenia przesyłki (${kod || 'bez kodu'}): pominięty, numer listu mógł być użyty ponownie` : null
}

/** Błąd konta przy śledzeniu (nie tej przesyłki): host przerywa konto w przebiegu i nie kończy śledzenia przesyłek. */
export function bladKontaSledzenia(e: unknown): boolean {
  if (e instanceof BladKontaSledzenia || e instanceof AdapterConfigError || jestOdlozone(e)) return true
  return e instanceof AdapterError && e.kind === 'TRWALY' && !(e instanceof BladPrzesylkiSledzenia) && klasaBledu(e) !== null
}

const BEZ_SLEDZENIA = 'moduł przewoźnika nie podaje stanu przesyłki'

/** Handler zadania okresowego śledzenia. Błędy przesyłek = wyjątek po przebiegu (reszta przeszła). */
export async function zadanieSledzenia(db: Db, deps: DepsNadania & { env?: Env } = {}): Promise<WynikSledzenia> {
  const w = await sledzeniePrzesylek(db, deps)
  if (w.bledy.length) throw new Error(`śledzenie przesyłek: ${w.bledy.join('; ')}`.slice(0, 4000))
  return w
}
