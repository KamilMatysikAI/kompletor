// Wysyłam z Allegro z nadawaniem ZA WYŁĄCZNIKIEM: `allegro.wysylam.zapis.v1`. Rozszerza tryb
// „przygotuj, nie wysyłaj” (`allegro.wysylam.v1`, bez zmian) o utworzenie przesyłki, etykietę, numer nadania
// i anulowanie. Woła go tylko host przesyłek (lib/wysylka/nadanie.ts) z jego bramkami (konto w PRACA, reguła przewoźnika
// z `zapisWlaczony: true`); bez wyłącznika `createShipment` i `cancelShipment` zwracają TRWALY bez żądania.
//
// Utworzenie: `POST /shipment-management/shipments/create-commands` asynchronicznie, wynik z `GET .../{commandId}`
// (IN_PROGRESS → SUCCESS z `shipmentId` albo ERROR). `commandId` = deterministyczny z referencji hosta i numeru próby
// (1…5): przed wysłaniem adapter czyta próby po kolei — SUCCESS = przesyłka już jest (zero drugiej płatnej etykiety),
// IN_PROGRESS = czekamy na nią, ERROR = następny numer, 404 = wolny numer (zawsze cała piątka). Dzięki temu ponowienie po odmowie hosta (ta sama
// referencja, lib/wysylka/nadanie.ts) nie trafia w zużyty commandId, a zgubiona odpowiedź nie tworzy drugiej przesyłki.
// Treść komendy: propozycja Allegro (`delivery-proposals`: metoda, punkt, nadawca) + gabaryt A/B/C, waga i pobranie
// z hosta (lib/wysylka/zlecenie-allegro.ts) + adres z karty zamówienia (poprawka adresu). Dane odbiorcy wyłącznie
// w pamięci tego wywołania; w wynikach i błędach tylko identyfikatory i kody błędów Allegro.
//
// Zakres: funkcja „Nadawanie Wysyłam z Allegro” (`shipments:read` + `shipments:write`, lib/zrodla/allegro-zakresy.ts).
import { type FetchLike, SourceError, Throttle } from '../zrodla/http'
import { ALLEGRO_API_URL } from '../zrodla/allegro'
import { etykietaFunkcji } from '../zrodla/allegro-zakresy'
import { AllegroWriter, type AllegroWriteResult, kodyBledowAllegro, WRITE_TIMEOUT_MS } from '../zrodla/allegro-zapis'
import { buildCreateCommandPayload } from '../wysylka/zlecenie-allegro'
import { telefonBezPrefiksu, telefonZPrefiksem } from '../wysylka/telefon'
import { asOutcome, sleep, writeWithToken } from './allegro-zapis'
import { ALLEGRO_WYSYLAM_MANIFEST, AllegroWysylamAdapter } from './allegro-wysylam'
import {
  AdapterError,
  BladKontaSledzenia,
  BladPrzesylkiSledzenia,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type LabelFormat,
  type PotwierdzenieRecznego,
  type RecipientAddress,
  type ReferenceFinder,
  type ReferenceLookup,
  type ShipmentCreateRequest,
  type ShipmentCreator,
  type ShipmentTracker,
  type OdczytPrzesylki,
  type StanDrogi,
  type StanPrzesylki,
  type WriteOutcome,
} from './kontrakt'
import { getAllegroTracking } from '../zrodla/allegro-wysylam'
import { deriveReference } from './rejestr'

export const ALLEGRO_WYSYLAM_ZAPIS_KEY = 'allegro.wysylam.zapis.v1'
export const FUNKCJA_WYSYLAM = etykietaFunkcji('wysylamZAllegro')
const ZAKRES = `funkcja „${FUNKCJA_WYSYLAM}”: połącz konto z Allegro ponownie z zaznaczoną funkcją`
export const NADAWANIE_WYLACZONE = 'nadawanie Wysyłam z Allegro wyłączone w ustawieniach przewoźnika (zapis wyłączony)'
/** Najwięcej prób (commandId) na referencję; po pięciu odmowach Allegro decyduje człowiek. */
export const MAX_PROB_KOMENDY = 5
/** Odpytań wyniku komendy po wysłaniu (domyślnie co 2 s, `ctx.http.pollDelayMs`): ok. 12 s przy kliknięciu. */
export const SHIPMENT_POLLS = 6
/** deadline ścienny odpytywania po wysłaniu; po nim W_TOKU, resztę przejmuje „Sprawdź u przewoźnika”. */
export const CZEKAJ_MS = 30_000
/** Limit czasu jednego odczytu stanu komendy (zwykły zapis ma `WRITE_TIMEOUT_MS`). */
export const KOMENDA_TIMEOUT_MS = 15_000
/** Odczyt klientem tylko-do-odczytu (`call`): 3 próby po 60 s + przerwy 2 i 4 s. */
const ODCZYT_NAJDLUZEJ_MS = 3 * 60_000 + 6_000
/**
 * Najgorszy czas żywego „Utwórz przesyłkę” Wysyłam z Allegro, od rezerwacji wiersza (TWORZENIE) do zapisu wyniku w hoście:
 * próby 1…5 (odczyt komend), propozycja dostawy, POST, odpytywanie (deadline + ostatni odczyt w locie + przerwa),
 * odszukanie po referencji w `executeWrite` (5 odczytów) i numer nadania; plus jedno odświeżenie tokena po 401 (
 * `writeWithToken` po 401 wysyła POST drugi raz, więc drugi `WRITE_TIMEOUT_MS`). Przerwy `Throttle` nie są
 * liczone (przy kliknięciu kolejka pusta); pokrywa je zapas hosta. Manifest podaje tę sumę jako `shipmentMaxCreateMs`, a host
 * (`progZawieszenia`, lib/wysylka/nadanie.ts) czeka dłużej, zanim pokaże „Sprawdź u przewoźnika”.
 */
export const NAJDLUZSZE_UTWORZENIE_MS =
  MAX_PROB_KOMENDY * KOMENDA_TIMEOUT_MS + ODCZYT_NAJDLUZEJ_MS + 2 * WRITE_TIMEOUT_MS + (CZEKAJ_MS + KOMENDA_TIMEOUT_MS + 2_000) + MAX_PROB_KOMENDY * KOMENDA_TIMEOUT_MS + ODCZYT_NAJDLUZEJ_MS + WRITE_TIMEOUT_MS

export const ALLEGRO_WYSYLAM_ZAPIS_MANIFEST: AdapterManifest = {
  ...ALLEGRO_WYSYLAM_MANIFEST,
  adapterKey: ALLEGRO_WYSYLAM_ZAPIS_KEY,
  version: '1.0.0',
  displayName: 'Wysyłam z Allegro (nadawanie, etykieta i anulowanie za wyłącznikiem)',
  // shipment.track: historia statusów przewoźnika (GET /order/carriers/{carrierId}/tracking), sam odczyt
  capabilities: ['shipment.prepare', 'shipment.create', 'shipment.cancel', 'reference.find', 'shipment.track'],
  // tworzenie przesyłek 120/min wg manifestu Allegro w Open Integration Platform (ae43d1e, `rate_limits.per_action`);
  // dokumentacja Allegro podaje tylko limit 9000/min na Client ID, więc konto bierze ułamek jak `allegro.v1` (300/min)
  rateLimit: { ...ALLEGRO_WYSYLAM_MANIFEST.rateLimit, requestsPerMinute: 300, perCapability: { 'shipment.create': { requestsPerMinute: 120 } } },
  shipmentMaxCreateMs: NAJDLUZSZE_UTWORZENIE_MS,
  config: [
    ...ALLEGRO_WYSYLAM_MANIFEST.config,
    { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'wyłącznik nadawania (z reguły przewoźnika): tak = Kompletor tworzy i anuluje przesyłki Wysyłam z Allegro' },
    {
      key: 'formatEtykiety',
      type: 'string',
      required: false,
      description: 'format etykiety ustalany przy tworzeniu przesyłki: PDF (domyślnie) albo ZPL (drukarka termiczna)',
      options: [
        { value: 'PDF', label: 'PDF' },
        { value: 'ZPL', label: 'ZPL' },
      ],
    },
  ],
  readOnly: false,
}

/**
 * Statusy śledzenia Allegro (poradnik „Jak zarządzać przesyłkami przez Wysyłam z Allegro”): PENDING = nadawca
 * przygotował paczkę, czeka na nadanie; IN_TRANSIT (nadana w punkcie, odebrana przez kuriera, w sortowni),
 * RELEASED_FOR_DELIVERY, AVAILABLE_FOR_PICKUP, NOTICE_LEFT, DELIVERED i RETURNED = paczka opuściła magazyn. ISSUE
 * (problem: odmowa, zaginięcie) sam niczego nie rozstrzyga.
 */
export const ALLEGRO_PRZEKAZANA: ReadonlySet<string> = new Set(['IN_TRANSIT', 'RELEASED_FOR_DELIVERY', 'AVAILABLE_FOR_PICKUP', 'NOTICE_LEFT', 'DELIVERED', 'RETURNED'])
export const ALLEGRO_PRZED_NADANIEM: ReadonlySet<string> = new Set(['PENDING'])

/** Stan z historii: którykolwiek status „po nadaniu” = PRZEKAZANA; pusta historia albo samo PENDING = przed nadaniem. */
export function stanAllegro(statusy: readonly { kod: string; czas: string | null }[]): { stan: StanPrzesylki; status: string | null } {
  const ost = [...statusy].sort((a, b) => (a.czas ?? '').localeCompare(b.czas ?? '')).at(-1)
  const status = ost?.kod ?? null
  if (statusy.some((s) => ALLEGRO_PRZEKAZANA.has(s.kod))) return { stan: 'PRZEKAZANA', status }
  if (statusy.every((s) => ALLEGRO_PRZED_NADANIEM.has(s.kod))) return { stan: 'PRZED_NADANIEM', status }
  return { stan: 'NIEZNANY', status }
}

/**
 * Kody Allegro na osi statusów (OpenAPI Allegro, `ParcelTrackingStatus`). IN_TRANSIT obejmuje i odbiór przez kuriera,
 * i sortownie: pierwsze IN_TRANSIT = przekazana, kolejne = w drodze. ISSUE (odmowa albo zaginięcie) = problem.
 */
const ALLEGRO_OS: Readonly<Record<string, StanDrogi>> = {
  PENDING: 'UTWORZONA',
  IN_TRANSIT: 'W_DRODZE',
  RELEASED_FOR_DELIVERY: 'W_DORECZENIU',
  AVAILABLE_FOR_PICKUP: 'W_PUNKCIE',
  NOTICE_LEFT: 'NIEUDANE_DORECZENIE',
  DELIVERED: 'DORECZONA',
  RETURNED: 'ZWROT',
  ISSUE: 'PROBLEM',
}

const osAllegro = (kod: string): StanDrogi | undefined => (Object.hasOwn(ALLEGRO_OS, kod) ? ALLEGRO_OS[kod] : undefined)

/**
 * Stan na osi z historii: ostatni (wg czasu) znany kod, jego czas i kod; pusta historia = utworzona, same nieznane =
 * nieznany. Zwrot „przykleja się”: po pierwszym RETURNED stan to ZWROT (czas i kod tego zdarzenia), także gdy
 * później jest DELIVERED (doręczenie do nadawcy). `przekazanaO` = pierwszy znany kod inny niż PENDING.
 */
export function stanDrogiAllegro(statusy: readonly { kod: string; czas: string | null }[]): { stanDrogi: StanDrogi; czas: string | null; kod: string | null; przekazanaO: string | null } {
  const wg = [...statusy].sort((a, b) => (a.czas ?? '').localeCompare(b.czas ?? ''))
  if (!wg.length) return { stanDrogi: 'UTWORZONA', czas: null, kod: null, przekazanaO: null }
  const przekazanaO = wg.find((s) => s.kod !== 'PENDING' && osAllegro(s.kod) !== undefined)?.czas ?? null
  const zwrot = wg.find((s) => osAllegro(s.kod) === 'ZWROT')
  if (zwrot) return { stanDrogi: 'ZWROT', czas: zwrot.czas, kod: zwrot.kod, przekazanaO }
  for (let i = wg.length - 1; i >= 0; i--) {
    const kod = wg[i]!.kod
    const os = osAllegro(kod)
    if (!os) continue
    const pierwszeWDrodze = kod === 'IN_TRANSIT' && !wg.slice(0, i).some((s) => s.kod === 'IN_TRANSIT')
    return { stanDrogi: pierwszeWDrodze ? 'PRZEKAZANA' : os, czas: wg[i]!.czas, kod, przekazanaO }
  }
  return { stanDrogi: 'NIEZNANY', czas: wg.at(-1)!.czas, kod: wg.at(-1)!.kod, przekazanaO }
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const codes = (r: AllegroWriteResult) => {
  const c = kodyBledowAllegro(r.body)
  return c.length ? ` (${c.join(', ')})` : ''
}

/** commandId próby `n` utworzenia przesyłki pod referencją hosta (UUID). */
export const commandIdUtworzenia = (reference: string, n: number) => deriveReference([reference, 'allegro-przesylka', n])
export const commandIdAnulowania = (reference: string) => deriveReference([reference, 'allegro-anulowanie'])

type Komenda = { status: 'BRAK' } | { status: 'W_TOKU' } | { status: 'OK'; shipmentId: string | null } | { status: 'BLAD'; kody: string[] }

/** Odbiorca z karty zamówienia nadpisuje pola propozycji Allegro (punkt odbioru zostaje z propozycji). */
export function odbiorcaAllegro(proposed: Record<string, unknown>, r: Readonly<RecipientAddress>): Record<string, unknown> {
  const ulica = [r.ulica, r.numerDomu ? `${r.numerDomu}${r.numerLokalu ? `/${r.numerLokalu}` : ''}` : null].filter(Boolean).join(' ')
  const pola: Record<string, string | null> = {
    name: r.imieNazwisko,
    company: r.firma,
    street: ulica || null,
    postalCode: r.kodPocztowy,
    city: r.miasto,
    countryCode: r.kraj,
    phone: r.telefon,
    email: r.email,
  }
  const out = { ...proposed }
  for (const [k, v] of Object.entries(pola)) if (v) out[k] = v
  return out
}

/**
 * Allegro od 01.10.2026 odrzuca komendę bez prefiksu kraju w `sender.phone` i `receiver.phone`. Telefon
 * nadawcy (z propozycji Allegro albo profilu) i odbiorcy (z karty zamówienia albo propozycji) przechodzi przez wspólny
 * odczyt (lib/wysylka/telefon.ts) do postaci „+48600100200”; +48 dopisujemy tylko osobie z `countryCode` PL albo bez kraju. Brak telefonu zostaje bez zmian (rozstrzyga Allegro);
 * nieczytelny albo bez prefiksu = błąd z polem do poprawy, bez wysyłki komendy i bez wartości numeru w komunikacie.
 */
export function telefonyAllegro(input: Record<string, unknown>): { input: Record<string, unknown> } | { blad: string } {
  const out = { ...input }
  for (const [pole, kto] of [['sender', 'nadawcy'], ['receiver', 'odbiorcy']] as const) {
    const osoba = input[pole]
    if (!osoba || typeof osoba !== 'object' || Array.isArray(osoba)) continue
    const tel = (osoba as Record<string, unknown>)['phone']
    if (tel === undefined || tel === null || (typeof tel === 'string' && !tel.trim())) continue
    const kraj = (osoba as Record<string, unknown>)['countryCode']
    const z = typeof tel === 'string' || typeof tel === 'number' ? telefonZPrefiksem(String(tel), { krajDomyslny: typeof kraj === 'string' ? kraj : null }) : null
    if (!z) return { blad: telefonBezPrefiksu(kto) }
    out[pole] = { ...(osoba as Record<string, unknown>), phone: z }
  }
  return { input: out }
}

export class AllegroWysylamZapisAdapter extends AllegroWysylamAdapter implements ShipmentCreator, ReferenceFinder, ShipmentTracker {
  private writerInstance: AllegroWriter | null = null

  constructor(ctx: AdapterContext) {
    super(ctx, ALLEGRO_WYSYLAM_ZAPIS_MANIFEST)
  }

  private get enabled(): boolean {
    return this.ctx.config['zapisWlaczony'] === true
  }

  private get pollDelayMs(): number {
    return this.ctx.http?.pollDelayMs ?? 2_000
  }

  private get writer(): AllegroWriter {
    this.writerInstance ??= new AllegroWriter(String(this.ctx.config['apiUrl'] ?? ALLEGRO_API_URL), String(this.ctx.config['userAgent']), this.ctx.fetch as FetchLike, new Throttle(this.ctx.http?.minIntervalMs ?? 100))
    return this.writerInstance
  }

  private write(method: 'GET' | 'POST', path: string, body: unknown, o: { binary?: boolean; timeoutMs?: number } = {}): Promise<AllegroWriteResult> {
    return writeWithToken(this.writer, this.tokens, method, path, body, o)
  }

  /** Stan komendy (utworzenia albo anulowania). Błąd odczytu = AdapterError. */
  private async komenda(rodzaj: 'create' | 'cancel', commandId: string): Promise<Komenda> {
    const r = await this.write('GET', `/shipment-management/shipments/${rodzaj}-commands/${commandId}`, undefined, { timeoutMs: KOMENDA_TIMEOUT_MS })
    if (r.status === 404) return { status: 'BRAK' }
    if (r.status === 403) throw new AdapterError(`Allegro: HTTP 403 przy odczycie komendy przesyłki — ${ZAKRES}`, 'TRWALY')
    if (r.status < 200 || r.status >= 300 || !r.body) throw new AdapterError(`Allegro: wynik komendy przesyłki HTTP ${r.status}`, r.status === 429 || r.status >= 500 ? 'PRZEJSCIOWY' : 'TRWALY', r.retryAfterMs ?? undefined)
    const status = str(r.body['status'])
    if (status === 'SUCCESS') return { status: 'OK', shipmentId: str(r.body['shipmentId']) }
    if (status === 'ERROR') return { status: 'BLAD', kody: kodyBledowAllegro(r.body) }
    return { status: 'W_TOKU' }
  }

  /**
   * Odpytywanie komendy po wysłaniu; `W_TOKU` po limicie odpytań albo po deadline ściennym `CZEKAJ_MS` (przegląd
   * wolne Allegro nie trzyma akcji serwera) = nadal nie wiadomo.
   */
  private async czekaj(rodzaj: 'create' | 'cancel', commandId: string): Promise<Komenda> {
    let k: Komenda = { status: 'W_TOKU' }
    const koniec = Date.now() + CZEKAJ_MS
    for (let i = 0; i < SHIPMENT_POLLS && Date.now() < koniec; i++) {
      await sleep(this.pollDelayMs)
      try {
        k = await this.komenda(rodzaj, commandId)
      } catch {
        // po wysłaniu komendy żaden błąd odczytu wyniku nie znaczy „nie powstała”: próbujemy dalej, a po limicie W_TOKU
        // (= NIEJEDNOZNACZNY i odszukanie), nigdy PRZEJSCIOWY ani TRWALY
        continue
      }
      if (k.status !== 'W_TOKU' && k.status !== 'BRAK') return k
    }
    return k
  }

  /** Stan wszystkich prób 1…5 referencji (bez przerwy na pierwszym 404: Allegro mogło zapomnieć starą komendę). */
  private async proby(reference: string): Promise<{ n: number; k: Komenda }[]> {
    const out: { n: number; k: Komenda }[] = []
    for (let n = 1; n <= MAX_PROB_KOMENDY; n++) out.push({ n, k: await this.komenda('create', commandIdUtworzenia(reference, n)) })
    return out
  }

  /**
   * Próba do użycia: udana (przesyłka jest) przed będącą w toku, ta przed pierwszą wolną (404).
   * Wszystkie pięć z błędem = null. Przegląd całej piątki: gdy Allegro przestało znać komendę `n=1` (stary ERROR),
   * a przesyłka istnieje pod `n=2`, zatrzymanie na pierwszym 404 wysłałoby drugą, płatną przesyłkę.
   */
  private async proba(reference: string): Promise<{ n: number; k: Komenda } | null> {
    const p = await this.proby(reference)
    return p.find((x) => x.k.status === 'OK') ?? p.find((x) => x.k.status === 'W_TOKU') ?? p.find((x) => x.k.status === 'BRAK') ?? null
  }

  private static wynik(k: Komenda, reference: string, what: string): WriteOutcome {
    if (k.status === 'OK') return k.shipmentId ? { kind: 'OK', reference, externalRef: k.shipmentId } : { kind: 'NIEJEDNOZNACZNY', reference, message: `${what}: Allegro potwierdziło przesyłkę bez jej numeru` }
    if (k.status === 'BLAD') return { kind: 'TRWALY', reference, message: `${what}: Allegro odrzuciło przesyłkę${k.kody.length ? ` (${k.kody.join(', ')})` : ''}` }
    return { kind: 'NIEJEDNOZNACZNY', reference, message: `${what}: Allegro jeszcze tworzy przesyłkę — „Sprawdź u przewoźnika” za chwilę` }
  }

  async createShipment(req: ShipmentCreateRequest, reference: string): Promise<WriteOutcome> {
    if (!this.enabled) return { kind: 'TRWALY', reference, message: NADAWANIE_WYLACZONE }
    const what = 'Wysyłam z Allegro'
    const order = req.orderExternalId ?? ''
    if (!UUID_RE.test(order)) return { kind: 'TRWALY', reference, message: `${what}: brak numeru formularza Allegro zamówienia (przesyłkę Wysyłam z Allegro tworzy się tylko dla zamówień z Allegro)` }
    try {
      const p = await this.proba(reference)
      if (!p) return { kind: 'TRWALY', reference, message: `${what}: ${MAX_PROB_KOMENDY} prób odrzuconych przez Allegro — sprawdź przesyłkę w Allegro i popraw dane` }
      if (p.k.status === 'OK') return AllegroWysylamZapisAdapter.wynik(p.k, reference, what)
      const commandId = commandIdUtworzenia(reference, p.n)
      if (p.k.status === 'W_TOKU') return AllegroWysylamZapisAdapter.wynik(await this.czekaj('create', commandId), reference, what)

      // propozycja dostawy z Allegro (metoda, punkt, nadawca): tylko w pamięci tego wywołania
      const pr = await this.call<unknown>(`/shipment-management/delivery-proposals/${order}`, ZAKRES)
      if (pr.status === 404) return { kind: 'TRWALY', reference, message: `${what}: Allegro nie ma propozycji dostawy dla tego zamówienia (inna metoda dostawy niż Wysyłam z Allegro?)` }
      if (pr.status < 200 || pr.status >= 300) return { kind: 'TRWALY', reference, message: `${what}: propozycja dostawy HTTP ${pr.status}` }
      const suggested = obj(obj(pr.body)['suggestedInput'])
      const tel = telefonyAllegro({ ...suggested, receiver: odbiorcaAllegro(obj(suggested['receiver']), req.recipient) })
      if ('blad' in tel) return { kind: 'TRWALY', reference, message: `${what}: ${tel.blad}` }
      const input = tel.input
      let payload: Record<string, unknown>
      try {
        payload = buildCreateCommandPayload(req.parcel, input, { commandId, labelFormat: this.ctx.config['formatEtykiety'] === 'ZPL' ? 'ZPL' : 'PDF', referenceNumber: reference.slice(0, 8) }, req.potwierdzoneOstrzezenia ?? [])
      } catch (e) {
        // komunikaty zlecenia mają tylko kody problemów, bez wartości pól
        return { kind: 'TRWALY', reference, message: `${what}: ${e instanceof Error ? e.message : String(e)}` }
      }
      let r: AllegroWriteResult | null = null
      try {
        r = await this.write('POST', '/shipment-management/shipments/create-commands', payload)
      } catch (e) {
        if (!(e instanceof SourceError)) throw e
        // brak odpowiedzi: wynik komendy rozstrzyga (ten sam commandId nie utworzy drugiej przesyłki)
      }
      if (r && !(r.status >= 200 && r.status < 300) && r.status !== 409) {
        if (r.status === 403) return { kind: 'TRWALY', reference, message: `${what}: HTTP 403 — ${ZAKRES}` }
        if (r.status === 429) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: HTTP 429 (limit zapytań)`, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) }
        if (r.status < 500) return { kind: 'TRWALY', reference, message: `${what}: Allegro odrzuciło komendę (HTTP ${r.status}${codes(r)})` }
        // 5xx: komenda mogła wejść — wynik komendy rozstrzyga niżej
      }
      const k = await this.czekaj('create', commandId)
      if (k.status === 'BRAK') {
        if (!r) return { kind: 'NIEJEDNOZNACZNY', reference, message: `${what}: brak odpowiedzi Allegro, a komenda przesyłki jeszcze nie jest widoczna` }
        // 2xx/409 bez widocznej komendy to opóźnienie Allegro, nie sprzeczność; ponowienie użyje tego samego commandId
        if (r.status < 500) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: Allegro przyjęło komendę, ale jeszcze jej nie pokazuje: kliknij ponownie za chwilę` }
        return { kind: 'PRZEJSCIOWY', reference, message: `${what}: Allegro odpowiedziało błędem (HTTP ${r.status}) i nie pokazuje komendy przesyłki: kliknij ponownie za chwilę` }
      }
      return AllegroWysylamZapisAdapter.wynik(k, reference, what)
    } catch (e) {
      return asOutcome(e, reference, what)
    }
  }

  /**
   * Odszukanie po referencji: udana próba = przesyłka jest; próba w toku = nadal nie wiadomo (wyjątek); żadnej
   * zarejestrowanej albo same odrzucone = dowód, że przesyłki nie ma (Allegro zna każdą przyjętą komendę).
   */
  async findByReference(reference: string): Promise<ReferenceLookup> {
    // cała piątka; `found:false` tylko, gdy żadna próba nie jest udana ani w toku
    const p = await this.proby(reference)
    const ok = p.find((x) => x.k.status === 'OK')
    if (ok && ok.k.status === 'OK') {
      if (!ok.k.shipmentId) throw new AdapterError('Allegro potwierdziło przesyłkę bez jej numeru', 'NIEJEDNOZNACZNY')
      return { found: true, externalRef: ok.k.shipmentId }
    }
    if (p.some((x) => x.k.status === 'W_TOKU')) throw new AdapterError('Allegro jeszcze tworzy przesyłkę: sprawdź za chwilę', 'NIEJEDNOZNACZNY')
    return { found: false }
  }

  /**
   * „Rozstrzygnij ręcznie” z numerem przesyłki z panelu Allegro. Dowodem są komendy
   * utworzenia tej referencji (te same `commandIdUtworzenia`, tylko odczyt, zero nowych komend): udana komenda musi
   * wskazywać dokładnie wpisaną przesyłkę, inaczej odmowa (wklejone id z sąsiedniego wiersza panelu). Komenda w toku =
   * odmowa „spróbuj za chwilę”; żadnej udanej ani w toku = przesyłka Kompletora nie powstała w Allegro (Allegro zna
   * każdą przyjętą komendę, jak w `findByReference`). Przy zgodnym numerze numer nadania dociąga host (`getTrackingNumber`).
   */
  async confirmManual(identyfikator: string, reference: string): Promise<PotwierdzenieRecznego> {
    if (!this.enabled) return { odmowa: 'Nadawanie Wysyłam z Allegro jest wyłączone w ustawieniach przewoźnika: Kompletor nie może sprawdzić przesyłki w Allegro.' }
    const id = identyfikator.trim()
    if (!UUID_RE.test(id)) return { odmowa: 'Podaj numer przesyłki z panelu Allegro (identyfikator w postaci 8-4-4-4-12 znaków).' }
    const p = await this.proby(reference)
    const ok = p.find((x) => x.k.status === 'OK')
    if (ok && ok.k.status === 'OK') {
      if (!ok.k.shipmentId) return { odmowa: 'Allegro potwierdziło przesyłkę tej referencji bez jej numeru: spróbuj za kilka minut.' }
      if (ok.k.shipmentId.toLowerCase() !== id.toLowerCase())
        return { odmowa: `Pod referencją tej przesyłki Allegro ma inną przesyłkę (${ok.k.shipmentId}) niż wpisana: sprawdź numer w panelu Allegro. Nic nie zapisano.` }
      return { externalRef: ok.k.shipmentId, info: 'Sprawdzone w Allegro: to przesyłka utworzona przez Kompletor dla tej referencji.', referencjaSprawdzona: true }
    }
    if (p.some((x) => x.k.status === 'W_TOKU')) return { odmowa: 'Allegro jeszcze tworzy przesyłkę tej referencji: spróbuj za chwilę.' }
    return { odmowa: `Allegro nie ma przesyłki utworzonej przez Kompletor dla tej referencji: przesyłka ${id} nie pochodzi z tego zamówienia w Kompletorze. Sprawdź numer w panelu Allegro; jeśli przesyłki tego zamówienia tam nie ma, wybierz „Nie powstała”.` }
  }

  async getLabel(externalRef: string, format: LabelFormat): Promise<{ contentType: string; base64: string }> {
    if (!UUID_RE.test(externalRef)) throw new AdapterError('zły numer przesyłki Allegro (oczekiwany UUID)', 'TRWALY')
    let r: AllegroWriteResult
    try {
      r = await this.write('POST', '/shipment-management/label', { shipmentIds: [externalRef], pageSize: 'A6', cutLine: false }, { binary: true })
    } catch (e) {
      if (e instanceof SourceError) throw new AdapterError(`etykieta Allegro: ${e.message}`, 'PRZEJSCIOWY')
      throw e
    }
    if (r.status === 403) throw new AdapterError(`etykieta Allegro: HTTP 403 — ${ZAKRES}`, 'TRWALY')
    if (r.status < 200 || r.status >= 300 || !r.bytes?.length) throw new AdapterError(`etykieta Allegro: HTTP ${r.status}${codes(r)}`, r.status === 429 || r.status >= 500 ? 'PRZEJSCIOWY' : 'TRWALY')
    const ct = r.contentType?.split(';')[0]?.trim() || (format === 'ZPL' ? 'text/plain' : 'application/pdf')
    return { contentType: ct, base64: r.bytes.toString('base64') }
  }

  /** Numer nadania z przesyłki (`packages[].waybill`); null = Allegro jeszcze go nie nadało. */
  async getTrackingNumber(externalRef: string): Promise<string | null> {
    if (!UUID_RE.test(externalRef)) throw new AdapterError('zły numer przesyłki Allegro (oczekiwany UUID)', 'TRWALY')
    const r = await this.call<unknown>(`/shipment-management/shipments/${externalRef}`, ZAKRES)
    if (r.status === 404) return null
    if (r.status < 200 || r.status >= 300) throw new AdapterError(`przesyłka Allegro: HTTP ${r.status}`, 'PRZEJSCIOWY')
    const pk = obj(r.body)['packages']
    for (const p of Array.isArray(pk) ? pk : []) {
      const w = str(obj(p)['waybill'])
      if (w && /^[A-Za-z0-9-]{4,64}$/.test(w)) return w
    }
    return null
  }

  /**
   * Stan przesyłki (sam odczyt): szczegóły przesyłki (`carrier`, `packages[].waybill`), potem historia statusów
   * przewoźnika. Przesyłki nie ma (404, anulowana) = ANULOWANA ze statusem „BRAK”; brak numeru albo historii
   * (`trackingDetails: null`) = przed nadaniem. Bez wyłącznika zapisu przesyłek z Kompletora nie ma (błąd konta). 404
   * historii (np. przewoźnik bez historii w Allegro) = NIEZNANY, nie koniec śledzenia: tego nie potwierdził sandbox.
   */
  async trackShipment(externalRef: string): Promise<OdczytPrzesylki> {
    if (!this.enabled) throw new BladKontaSledzenia('zapis wyłączony')
    if (!UUID_RE.test(externalRef)) throw new BladPrzesylkiSledzenia('zły numer przesyłki Allegro (oczekiwany UUID)')
    const r = await this.call<unknown>(`/shipment-management/shipments/${externalRef}`, ZAKRES)
    if (r.status === 404) return { stan: 'ANULOWANA', status: 'BRAK', stanDrogi: 'ANULOWANA' }
    if (r.status < 200 || r.status >= 300) throw new AdapterError(`przesyłka Allegro: HTTP ${r.status}`, 'PRZEJSCIOWY')
    const carrier = str(obj(r.body)['carrier'])
    const pk = obj(r.body)['packages']
    const waybill = (Array.isArray(pk) ? pk : []).map((p) => str(obj(p)['waybill'])).find((w) => !!w && /^[A-Za-z0-9-]{4,64}$/.test(w))
    if (!waybill) return { stan: 'PRZED_NADANIEM', status: null, stanDrogi: 'UTWORZONA' }
    if (!carrier || !/^[A-Z0-9_]{1,32}$/.test(carrier)) return { stan: 'NIEZNANY', status: null, stanDrogi: 'NIEZNANY' }
    const t = await this.callWith<unknown>('/order/carriers/{id}/tracking', (token) => getAllegroTracking<unknown>(this.api, carrier, waybill, token), 'token bez zakresu odczytu zamówień (allegro:api:orders:read) potrzebnego do śledzenia przesyłki')
    if (t.status === 404) return { stan: 'NIEZNANY', status: null, stanDrogi: 'NIEZNANY' }
    if (t.status < 200 || t.status >= 300) throw new AdapterError(`śledzenie Allegro: HTTP ${t.status}`, 'PRZEJSCIOWY')
    const wb = obj(t.body)['waybills']
    const wpis = (Array.isArray(wb) ? wb : []).map(obj).find((w) => str(w['waybill']) === waybill)
    const st = obj(wpis?.['trackingDetails'])['statuses']
    const statusy = (Array.isArray(st) ? st : []).map((s) => ({ kod: str(obj(s)['code']) ?? '', czas: str(obj(s)['occurredAt']) })).filter((s) => s.kod)
    return { ...stanAllegro(statusy), ...stanDrogiAllegro(statusy) }
  }

  async cancelShipment(externalRef: string, reference: string): Promise<WriteOutcome> {
    if (!this.enabled) return { kind: 'TRWALY', reference, message: NADAWANIE_WYLACZONE }
    const what = 'anulowanie przesyłki Wysyłam z Allegro'
    if (!UUID_RE.test(externalRef)) return { kind: 'TRWALY', reference, message: `${what}: zły numer przesyłki` }
    const commandId = commandIdAnulowania(reference)
    try {
      let k = await this.komenda('cancel', commandId)
      if (k.status === 'BRAK') {
        let r: AllegroWriteResult | null = null
        try {
          r = await this.write('POST', '/shipment-management/shipments/cancel-commands', { commandId, input: { shipmentId: externalRef } })
        } catch (e) {
          if (!(e instanceof SourceError)) throw e
        }
        if (r && !(r.status >= 200 && r.status < 300) && r.status !== 409) {
          if (r.status === 403) return { kind: 'TRWALY', reference, message: `${what}: HTTP 403 — ${ZAKRES}` }
          if (r.status === 429 || r.status >= 500) return { kind: 'PRZEJSCIOWY', reference, message: `${what}: HTTP ${r.status}` }
          return { kind: 'TRWALY', reference, message: `${what}: Allegro odrzuciło (HTTP ${r.status}${codes(r)})` }
        }
        k = await this.czekaj('cancel', commandId)
      } else if (k.status === 'W_TOKU') k = await this.czekaj('cancel', commandId)
      if (k.status === 'OK') return { kind: 'OK', reference, externalRef }
      if (k.status === 'BLAD') return { kind: 'TRWALY', reference, message: `${what}: Allegro odmówiło${k.kody.length ? ` (${k.kody.join(', ')})` : ''} — przesyłka mogła już zostać nadana` }
      // komenda anulowania z tym samym commandId jest bezpieczna do powtórki
      return { kind: 'PRZEJSCIOWY', reference, message: `${what}: Allegro jeszcze przetwarza anulowanie` }
    } catch (e) {
      return asOutcome(e, reference, what)
    }
  }
}

export const ALLEGRO_WYSYLAM_ZAPIS_DEFINITION: AdapterDefinition = { manifest: ALLEGRO_WYSYLAM_ZAPIS_MANIFEST, create: (ctx) => new AllegroWysylamZapisAdapter(ctx) }
