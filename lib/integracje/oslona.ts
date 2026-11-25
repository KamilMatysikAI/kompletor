// osłona adaptera po stronie hosta — jedno miejsce, przez które przechodzi każde wywołanie integracji
// utworzonej przez `createAccountAdapter` (konta kanałów), `createWysylamAdapter` (Wysyłam z Allegro, klucz konta Allegro)
// i `adapterPrzewoznika` (przewoźnicy):
//   1. konto wyłączone po błędach → żadnego żądania; wywołanie dostaje `IntegracjaWylaczonaError` (PRZEJSCIOWY z czasem
//      ponowienia i znacznikiem „odłożone”), więc zadania czekają zamiast ginąć albo zużywać próby;
//   2. limit tempa konta i zdolności (lib/integracje/limity.ts): zapis po odmowie odkładany (`LimitTempaError`), odczyt
//      czeka na żeton do 30 s, potem też odłożony; zegar, który stoi, odkłada od razu (bez snu). Wywołanie z panelu
//      (`interaktywne`, czeka na nie człowiek): zapis czeka na żeton do 10 s, zanim zostanie odłożony, i bierze z całego
//      kubełka; odczyt spoza panelu (worker, automaty) zostawia w kubełku konta rezerwę dla zapisów;
//   3. zdrowie konta (lib/integracje/zdrowie.ts): test połączenia nie OK albo wynik TRWALY klasy uwierzytelnienia lub
//      konfiguracji = porażka; udane wywołanie = sukces (licznik do zera). Po progu konto jest wyłączane i ta sama
//      osłona od razu przestaje je wołać (zero kolejnych wywołań w tym przebiegu).
// Wzorce z Open Integration Platform `platform/core/connector_rate_limiter.py` i `connector_health.py` (commit ae43d1e,
// Apache-2.0, THIRD_PARTY_NOTICES.md), własna implementacja. Osłona niczego nie dodaje: tylko ogranicza wywołania.
// Metody bez sieci (`prepareShipment`, `prepareInvoice`) i pola (`manifest`) przechodzą bez zmian.
import type { PrismaClient } from '@prisma/client'
import { AdapterError, BladKontaSledzenia, type Capability, type ChannelAdapter, type ConnectionTest, type ErrorClass } from '../adaptery/kontrakt'
import { AdapterConfigError } from '../adaptery/rejestr'
import { sprawdzLimit, zajmijMiejsce, zwolnijMiejsce } from './limity'
import { type KontoIntegracji, stanKonta, zapiszPorazke, zapiszSukces } from './zdrowie'

/** Jak długo zadanie czeka, zanim host znowu sprawdzi wyłączone konto. */
export const ODLOZENIE_WYLACZONEGO_MS = 15 * 60_000
/** Najdłuższe czekanie odczytu na żeton limitu, zanim odczyt też zostanie odłożony. */
export const CZEKANIE_ODCZYTU_MS = 30_000
/**
 * Najdłuższe czekanie zapisu z panelu (`interaktywne`) na żeton, zanim dostanie komunikat „spróbuj za chwilę”. Czekanie
 * jest przed żądaniem do platformy (nic jeszcze nie wyszło), więc nie może dać drugiej przesyłki; ten sam wiersz stoi w
 * TWORZENIE, a próg „zawieszonego” tworzenia (minuty) jest daleko powyżej tych sekund.
 */
export const CZEKANIE_ZAPISU_MS = 10_000

/** Zapis albo odczyt nie wyszedł, bo host go odłożył (limit, wyłączenie). Zawsze PRZEJSCIOWY z czasem ponowienia. */
export class OdlozoneError extends AdapterError {
  readonly odlozone = true
  constructor(message: string, retryAfterMs: number) {
    super(message, 'PRZEJSCIOWY', Math.max(1, Math.round(retryAfterMs)))
    this.name = 'OdlozoneError'
  }
}

export class LimitTempaError extends OdlozoneError {
  constructor(message: string, retryAfterMs: number) {
    super(message, retryAfterMs)
    this.name = 'LimitTempaError'
  }
}

export class IntegracjaWylaczonaError extends OdlozoneError {
  constructor(nazwa: string, powod: string) {
    super(`${nazwa}: integracja wyłączona po błędach (${powod}). Nic nie wysłano; zadanie czeka na „Włącz ponownie” w szczegółach konta.`, ODLOZENIE_WYLACZONEGO_MS)
    this.name = 'IntegracjaWylaczonaError'
  }
}

/** Klucz konta integracji adaptera w osłonie (`adapter[KLUCZ_KONTA]`); host grupuje po nim błędy konta. */
export const KLUCZ_KONTA: unique symbol = Symbol('kluczKonta')

/** Klucz konta adaptera w osłonie; adapter bez osłony = null. */
export function kluczKonta(a: unknown): string | null {
  const k = a && typeof a === 'object' ? (a as Record<symbol, unknown>)[KLUCZ_KONTA] : undefined
  return typeof k === 'string' ? k : null
}

export const jestOdlozone = (e: unknown): e is OdlozoneError => e instanceof OdlozoneError

/** Metoda adaptera → zdolność i czy to zapis (zapis po odmowie limitu jest odkładany, odczyt czeka). */
const METODY: Readonly<Record<string, { cap: Capability | null; zapis: boolean; http?: true }>> = {
  listOrderChanges: { cap: 'orders.feed', zapis: false },
  getOrder: { cap: 'orders.feed', zapis: false },
  getOrderZRabatem: { cap: 'orders.feed', zapis: false }, // Woo, odczyt do przeliczenia rabatu
  pushStock: { cap: 'stock.write', zapis: true },
  getStockImportStatus: { cap: 'stock.import.status', zapis: false },
  findByReference: { cap: 'reference.find', zapis: false },
  setOrderStatus: { cap: 'order.status.write', zapis: true },
  setTracking: { cap: 'order.tracking.write', zapis: true },
  listOffers: { cap: 'offers.read', zapis: false },
  getOfferEan: { cap: 'offers.read', zapis: false }, // EAN oferty Allegro ze szczegółów oferty
  listCustomerReturns: { cap: 'returns.read', zapis: false },
  getOrderRecipient: { cap: 'orders.recipient', zapis: false },
  createShipment: { cap: 'shipment.create', zapis: true },
  // etykieta po utworzeniu: tylko limit konta (nie zjada limitu tworzenia przesyłek)
  getLabel: { cap: null, zapis: false },
  cancelShipment: { cap: 'shipment.cancel', zapis: true },
  trackShipment: { cap: 'shipment.track', zapis: false },
  acceptOrder: { cap: 'order.accept', zapis: true },
  issueInvoice: { cap: 'invoice.issue', zapis: true },
  findInvoices: { cap: 'invoice.find', zapis: false },
  correctInvoice: { cap: 'invoice.correct', zapis: true },
  getInvoicePdf: { cap: 'invoice.pdf', zapis: false },
  // (3b-1): ofertowanie. Obie metody oddają surową odpowiedź HTTP ({ status, body }) zamiast rzucać,
  // więc 401/403 liczy się do licznika błędów po statusie (`http`), a 2xx zeruje go jak każdy sukces.
  odczytDoOfert: { cap: 'offers.prepare', zapis: false, http: true },
  zapisOfert: { cap: 'offers.publish', zapis: true, http: true },
}

/** Status surowej odpowiedzi HTTP ofertowania (null = to nie jest taka odpowiedź, np. Mirakl oddaje samo body). */
const statusHttp = (v: unknown): number | null =>
  !!v && typeof v === 'object' && typeof (v as { status?: unknown }).status === 'number' && 'body' in v ? (v as unknown as { status: number }).status : null

// Klasa błędu po treści, gdy adapter jej nie podał. Celowo wąsko: odrzucone poświadczenia i zła konfiguracja konta,
// nigdy walidacja jednego rekordu (zły kod pocztowy, za ciężka paczka).
const UWIERZYTELNIENIE_RE = /\bHTTP 40[13]\b|\b40[13]\b.*(klucz|token|login|has[łl]|autoryzac|uprawnie)|autoryzac|uwierzyteln|(klucz|token|login|has[łl]o)[^.;]{0,40}odrzucon|odrzucon[^.;]{0,40}(klucz|token|login|has[łl])|bez prawa zapisu|unauthori[sz]ed|forbidden|invalid[_ ](api[_ ])?key|invalid[_ ]grant/i
const KONFIGURACJA_RE = /zła konfiguracja|brak sekretu|brak klucza|brak wymaganego|nie ma sekretu|konfiguracj[ai] (konta|przewoźnika)/i

/** Klasa błędu trwałego (null = błąd danych albo nieznany: nie liczy się do wyłączenia). */
export function klasaBledu(x: { errorClass?: ErrorClass; message?: string } | Error): ErrorClass | null {
  // AllegroAccountError (401 po odświeżeniu, 403 bez zakresu) dziedziczy po AdapterConfigError, ale to odrzucony token:
  // UWIERZYTELNIENIE, żeby liczył się także przy zapisie (nie liczy KONFIGURACJI zapisu; Wysyłam z Allegro)
  if (x instanceof AdapterConfigError) return UWIERZYTELNIENIE_RE.test(x.message) ? 'UWIERZYTELNIENIE' : 'KONFIGURACJA'
  const ec = (x as { errorClass?: ErrorClass }).errorClass
  if (ec) return ec
  const m = x.message ?? ''
  if (UWIERZYTELNIENIE_RE.test(m)) return 'UWIERZYTELNIENIE'
  if (KONFIGURACJA_RE.test(m)) return 'KONFIGURACJA'
  return null
}

/**
 * czy błąd liczy się do wyłączenia konta. Błąd KONFIGURACJI przy ZAPISIE (np. „brak klucza zapisu
 * Woo”, gdy zapis włączony bez osobnego klucza) psuje tylko zapis: wynik TRWALY idzie zwykłą drogą (alert zapisu, wiersz
 * stoi), a odczyt zamówień dalej działa. Odczyt z błędem konfiguracji i każde odrzucenie poświadczeń liczą się.
 */
export function liczySie(zapis: boolean, klasa: ErrorClass | null): boolean {
  if (!klasa) return false
  return !(zapis && klasa === 'KONFIGURACJA')
}

const FAILURE = new Set(['PRZEJSCIOWY', 'TRWALY', 'NIEJEDNOZNACZNY'])
const jestWynikZapisu = (v: unknown): v is { kind: string; message?: string; errorClass?: ErrorClass } =>
  !!v && typeof v === 'object' && typeof (v as { kind?: unknown }).kind === 'string' && ((v as { kind: string }).kind === 'OK' || FAILURE.has((v as { kind: string }).kind)) && 'reference' in v

export interface OpcjeOslony {
  /**
   * Zegar limitów i zdrowia, TYLKO w testach; domyślnie bieżący czas przy każdym wywołaniu. Hosty nie podają tu zegara
   * adaptera (`createAccountAdapter`, `createWysylamAdapter`, `adapterPrzewoznika` przekazują wyłącznie `opts.oslona`):
   * zegar zamrożony na przebieg zatrzymałby uzupełnianie kubełka.
   */
  now?: () => Date
  /** Czekanie odczytu na żeton (testy wstrzykują natychmiastowe). */
  sleep?: (ms: number) => Promise<void>
  /** true = nie sprawdzaj wyłączenia (test połączenia przy „Włącz ponownie” musi przejść przez wyłączone konto). */
  pomijajWylaczenie?: boolean
  /**
   * true = wywołania z panelu, na które czeka człowiek (np. „Utwórz przesyłkę”): zapis po odmowie limitu czeka do
   * `CZEKANIE_ZAPISU_MS`, odczyt bierze z całego kubełka. Brak = tło (worker, automaty): zapis odkładany od razu (zadanie
   * ponowi), odczyt nie zjada rezerwy konta (`REZERWA_ZAPISOW`), tylko czeka na żeton ponad nią jak na pusty kubełek.
   */
  interaktywne?: boolean
}

const domyslnySleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const krotko = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

/**
 * Adapter w osłonie hosta. Stan wyłączenia czytany raz przy tworzeniu (adapter żyje jeden przebieg), a wyłączenie w tym
 * przebiegu (próg osiągnięty) zatrzymuje kolejne wywołania od razu.
 */
export async function oslonAdapter<A extends ChannelAdapter>(db: PrismaClient, adapter: A, konto: KontoIntegracji, opts: OpcjeOslony = {}): Promise<A> {
  const now = opts.now ?? (() => new Date())
  const sleep = opts.sleep ?? domyslnySleep
  let wylaczone: string | null = null
  // jeden odczyt na adapter: wyłączenie i czy licznik porażek trzeba zerować (sukces bez porażek = bez zapisu)
  const st = await stanKonta(db, konto.klucz)
  if (!opts.pomijajWylaczenie && st?.disabledAt) wylaczone = st.disabledReason || 'za dużo kolejnych błędów'
  let saPorazki = (st?.consecutiveFailures ?? 0) > 0
  const rate = adapter.manifest.rateLimit

  const porazka = async (powod: string) => {
    try {
      saPorazki = true
      const r = await zapiszPorazke(db, konto, powod, now())
      if (r.wylaczono && !opts.pomijajWylaczenie) wylaczone = `${r.porazki} kolejnych błędów połączenia`
    } catch (e) {
      // licznik zdrowia nie może zepsuć wywołania (np. baza chwilowo niedostępna): tylko log
      console.error(`[integracje] ${konto.klucz}: nie zapisano porażki: ${krotko(e)}`)
    }
  }
  const sukces = async () => {
    if (!saPorazki) return
    saPorazki = false
    try {
      await zapiszSukces(db, konto.klucz, now())
    } catch (e) {
      console.error(`[integracje] ${konto.klucz}: nie zapisano sukcesu: ${krotko(e)}`)
    }
  }

  // zegar, który nie idzie mimo snu (zamrożony `now` w testach albo cofnięty zegar), nie uzupełnia
  // kubełka, więc czekanie nic nie da. Po pierwszym takim obrocie odczyty na tym adapterze są odkładane od razu, zamiast
  // spać do 30 s na każde nadmiarowe wywołanie (grudzień: 80 odczytów × 30 s = 40 min stania workera).
  let zegarStoi = false
  const limit = async (cap: Capability | null, zapis: boolean, metoda: string) => {
    const start = Date.now()
    // czas czekania: realny upływ albo suma snów (sen wstrzyknięty w testach nie przesuwa Date.now), większe z dwóch
    let czekano = 0
    let poprzedni: number | null = null
    for (;;) {
      const t = now()
      const r = await sprawdzLimit(db, konto.klucz, rate, cap, t, { rezerwaKonta: !zapis && !opts.interaktywne })
      if (r.granted) return
      if (poprzedni !== null && t.getTime() <= poprzedni) zegarStoi = true
      const ktory = r.zakres === '*' ? `limit konta ${r.perMinute}/min` : `limit „${r.zakres}” ${r.perMinute}/min`
      // zapis z tła: odłożony od razu (zadanie ponowi bez kliknięcia); zapis z panelu i odczyt: krótkie czekanie
      const maxCzekania = zapis ? (opts.interaktywne ? CZEKANIE_ZAPISU_MS : 0) : CZEKANIE_ODCZYTU_MS
      if (zegarStoi || Math.max(Date.now() - start, czekano) + r.retryAfterMs > maxCzekania)
        throw new LimitTempaError(`${konto.nazwa}: ${ktory} wyczerpany (${metoda}); nic nie wysłano, ponowienie za ${Math.ceil(r.retryAfterMs / 1000)} s`, r.retryAfterMs)
      poprzedni = t.getTime()
      czekano += r.retryAfterMs
      await sleep(r.retryAfterMs)
    }
  }

  const testConnection = async (): Promise<ConnectionTest> => {
    let r: ConnectionTest
    try {
      r = await adapter.testConnection()
    } catch (e) {
      const k = e instanceof Error ? klasaBledu(e) : null
      if (k || (e instanceof AdapterError && e.kind === 'TRWALY')) await porazka(`test połączenia: ${krotko(e)}`)
      throw e
    }
    if (r.ok) await sukces()
    else await porazka(`test połączenia: ${r.message.slice(0, 300)}`)
    return r
  }

  return new Proxy(adapter, {
    get(target, prop, _receiver) {
      if (prop === 'testConnection') return testConnection
      if (prop === KLUCZ_KONTA) return konto.klucz
      const v = Reflect.get(target, prop, target) as unknown
      if (typeof prop !== 'string' || typeof v !== 'function') return v
      const meta = METODY[prop]
      if (!meta) return (v as (...a: unknown[]) => unknown).bind(target)
      return async (...args: unknown[]) => {
        if (wylaczone) throw new IntegracjaWylaczonaError(konto.nazwa, wylaczone)
        await limit(meta.cap, meta.zapis, prop)
        const max = meta.cap ? rate.perCapability?.[meta.cap]?.maxConcurrent : undefined
        if (meta.cap && !zajmijMiejsce(konto.klucz, meta.cap, max)) {
          throw new LimitTempaError(`${konto.nazwa}: za dużo równoległych wywołań „${meta.cap}” (najwyżej ${max}); ponowienie za 2 s`, 2_000)
        }
        let out: unknown
        try {
          out = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
        } catch (e) {
          // odmowa usługi śledzenia z własnymi danymi logowania nie mówi nic o koncie nadawania: nie liczy się
          if (e instanceof BladKontaSledzenia && e.osobneDane) throw e
          if (e instanceof AdapterConfigError || (e instanceof AdapterError && e.kind === 'TRWALY' && klasaBledu(e))) {
            if (liczySie(meta.zapis, klasaBledu(e as Error))) await porazka(`${prop}: ${krotko(e)}`)
          }
          throw e
        } finally {
          if (meta.cap) zwolnijMiejsce(konto.klucz, meta.cap, max)
        }
        const st = meta.http ? statusHttp(out) : null
        if (st !== null) {
          // odrzucone poświadczenia albo brak zgody konta: liczy się do wyłączenia; inne kody (walidacja oferty, 429,
          // 5xx) to sprawa jednego żądania, nie konta — licznik bez zmian
          if (st === 401 || st === 403) await porazka(`${prop}: HTTP ${st} (odrzucone poświadczenia albo brak zgody)`)
          else if (st >= 200 && st < 300) await sukces()
        } else if (jestWynikZapisu(out)) {
          if (out.kind === 'OK') await sukces()
          else if (out.kind === 'TRWALY' && liczySie(meta.zapis, klasaBledu({ ...(out.errorClass ? { errorClass: out.errorClass } : {}), message: out.message ?? '' }))) await porazka(`${prop}: ${(out.message ?? '').slice(0, 300)}`)
        } else await sukces()
        return out
      }
    },
  })
}
