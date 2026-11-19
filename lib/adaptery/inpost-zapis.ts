// Adapter przewoźnika `inpost.shipx.zapis.v1`: to samo co `inpost.shipx.v1` plus utworzenie przesyłki
// i etykieta, ZA WYŁĄCZNIKIEM. Przesyłka powstaje tylko przy trzech niezależnych warunkach naraz: (1) reguła
// przewoźnika firmy wskazuje ten klucz, (2) konfiguracja ma `zapisWlaczony: true`, (3) host woła `createShipment`
// (dziś nikt: pilnuje test lib/adaptery/inpost.test.ts). Bez wyłącznika klient zapisu w ogóle nie powstaje, więc
// żadne żądanie nie wychodzi. Dane odbiorcy są tylko w argumencie `createShipment`, w pamięci; wynik ich nie ma.
import { InpostZapis } from '../zrodla/inpost-zapis'
import { INPOST_ID_RE, type InpostReadOnly } from '../zrodla/inpost'
import { ustawieniaInpost, wyliczPrzesylkeInpost, type UstawieniaInpost } from '../wysylka/inpost'
import { buildShipmentPayload } from '../wysylka/zlecenie-inpost'
import { zRozdzielonymAdresem, type OdbiorcaPrzesylki } from '../wysylka/zlecenie'
import { DOMYSLNY_SENDING_METHOD, INPOST_CONFIG, INPOST_SECRETS, inpostReadOnlyFromContext, testInpostConnection } from './inpost'
import {
  AdapterError,
  BladKontaSledzenia,
  BladPrzesylkiSledzenia,
  type RecipientAddress,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type ChannelAdapter,
  type ConnectionTest,
  type LabelFormat,
  type PreparedParcel,
  type ReferenceFinder,
  type PotwierdzenieRecznego,
  type ReferenceLookup,
  type ShipmentCreateRequest,
  type ShipmentCreator,
  type ShipmentInput,
  type ShipmentPreparer,
  type OdczytPrzesylki,
  type ShipmentTracker,
  type StanDrogi,
  type StanPrzesylki,
  type WriteOutcome,
} from './kontrakt'

export const INPOST_SHIPX_ZAPIS_KEY = 'inpost.shipx.zapis.v1'

export const INPOST_SHIPX_ZAPIS_MANIFEST: AdapterManifest = {
  adapterKey: INPOST_SHIPX_ZAPIS_KEY,
  version: '1.0.0',
  displayName: 'InPost ShipX z tworzeniem przesyłek (za wyłącznikiem)',
  kind: 'carrier',
  // reference.find: niejednoznaczny wynik utworzenia rozstrzyga odszukanie po referencji, nie ślepe ponowienie
  // shipment.track: status przesyłki od ręki (GET jednej przesyłki), do automatu „Wysłane”
  capabilities: ['shipment.prepare', 'shipment.create', 'reference.find', 'shipment.track'],
  // status „delivered” = DORECZONA (stanShipX)
  trackReportsDelivered: true,
  // tworzenie przesyłek 30/min wg manifestu InPost w Open Integration Platform (ae43d1e, `rate_limits.per_action`);
  // dokumentacja ShipX liczby nie podaje [NIEPEWNE], więc to ostrożna górna granica, nie limit z umowy
  rateLimit: { requestsPerMinute: 60, maxConcurrent: 1, minPollIntervalMs: 0, perCapability: { 'shipment.create': { requestsPerMinute: 30 } } },
  config: [
    ...INPOST_CONFIG,
    { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'wyłącznik: true = adapter może utworzyć przesyłkę (płatną) i pobrać etykietę; brak = nie może' },
    { key: 'labelType', type: 'string', required: false, description: 'rodzaj etykiety ShipX (np. normal albo A6)', pattern: /^[A-Za-z0-9]{1,10}$/ },
  ],
  secrets: INPOST_SECRETS,
  readOnly: false,
}

const WYLACZONY = 'zapis wyłączony'

/** Pola odbiorcy wymagane do przesyłki ShipX; brak = błąd z nazwą pola, nigdy z wartością. */
const POLA_ODBIORCY = ['imieNazwisko', 'ulica', 'numerDomu', 'kodPocztowy', 'miasto', 'telefon', 'email'] as const

const tekst = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * Odbiorca z kontraktu (pola nullowalne) na wejście zlecenia ShipX. Moduł jest krajowy: kraj inny niż PL
 * = błąd `kraj`, bo przesyłka poszłaby jako krajowa na adres zagraniczny. Brak kraju = kanał go nie
 * podał; host i tak odrzuca zagranicę wcześniej (lib/odbiorca/przejscia.ts).
 */
function odbiorca(r0: Readonly<RecipientAddress>): (OdbiorcaPrzesylki & { kraj: string | null }) | { brak: string[] } {
  const kraj = tekst(r0.kraj)
  const r = zRozdzielonymAdresem(r0)
  if (kraj && kraj.toUpperCase() !== 'PL') return { brak: ['kraj'] }
  const brak = POLA_ODBIORCY.filter((k) => !tekst(r[k]))
  if (brak.length) return { brak: [...brak] }
  return { imieNazwisko: tekst(r.imieNazwisko)!, firma: tekst(r.firma), ulica: tekst(r.ulica)!, numerDomu: tekst(r.numerDomu)!, numerLokalu: tekst(r.numerLokalu), kodPocztowy: tekst(r.kodPocztowy)!, miasto: tekst(r.miasto)!, telefon: tekst(r.telefon)!, email: tekst(r.email)!, kraj }
}

/**
 * statusy ShipX, przy których paczka jest już u InPost (odebrana przez kuriera, nadana przez nadawcę w punkcie
 * albo paczkomacie, w drodze, doręczona). Przed nadaniem: created, offers_prepared, offer_selected, confirmed. Każdy inny
 * status (anulowana, zwrot, nieznany) = NIEZNANY: host niczego nie zmienia.
 */
export const SHIPX_PRZEKAZANA: ReadonlySet<string> = new Set([
  'dispatched_by_sender',
  'dispatched_by_sender_to_pok',
  'collected_from_sender',
  'taken_by_courier',
  'taken_by_courier_from_pok',
  'adopted_at_source_branch',
  'sent_from_source_branch',
  'adopted_at_sorting_center',
  'sent_from_sorting_center',
  'adopted_at_target_branch',
  'out_for_delivery',
  'out_for_delivery_to_address',
  'ready_to_pickup',
  'ready_to_pickup_from_pok',
  'ready_to_pickup_from_branch',
  'pickup_reminder_sent',
  'stack_in_box_machine',
  'stack_in_customer_service_point',
  'avizo',
  'delivered',
  // po przekazaniu, choć nie do odbiorcy: paczka i tak opuściła magazyn (zwrot też był wysyłką)
  'oversized',
  'returned_to_sender',
  'rejected_by_receiver',
  'claimed',
  'pickup_time_expired',
  'unstack_from_box_machine',
  'courier_avizo_in_customer_service_point',
  'taken_by_courier_from_customer_service_point',
])
/** Przesyłka anulowana w ShipX: nie pojedzie, śledzenie się kończy (ręczne „Przyjechał kurier” zostaje). */
export const SHIPX_ANULOWANA: ReadonlySet<string> = new Set(['canceled'])
export const SHIPX_PRZED_NADANIEM: ReadonlySet<string> = new Set(['created', 'offers_prepared', 'offer_selected', 'confirmed'])

export function stanShipX(status: string | null): StanPrzesylki {
  if (!status) return 'NIEZNANY'
  // doręczenie osobno, żeby śledzenie po „Wysłane” miało warunek końca
  if (status === 'delivered') return 'DORECZONA'
  // `undelivered_*` (nie doręczono: zły adres, brak odbiorcy…) = paczka już u InPost
  if (SHIPX_PRZEKAZANA.has(status) || status.startsWith('undelivered')) return 'PRZEKAZANA'
  if (SHIPX_PRZED_NADANIEM.has(status)) return 'PRZED_NADANIEM'
  if (SHIPX_ANULOWANA.has(status)) return 'ANULOWANA'
  return 'NIEZNANY'
}

/**
 * Kody ShipX na osi statusów (lib/wysylka/stany-przesylki.ts). Źródło: publiczna lista `GET /v1/statuses` (53 kody,
 * pobrana 14.11.2026, bez klucza; pola name, title, description); każdy kod z listy ma tu stan albo świadomie zostaje nieznany (`other`, `missing` bez opisu).
 * `stack_*` (paczka przełożona do innego punktu) = w punkcie, a `stack_parcel_*_pickup_time_expired` (termin minął,
 * kurier zabierze paczkę do pierwotnego automatu) = w drodze; `taken_by_courier_from_customer_service_point`
 * („zwrócona do nadawcy”) = zwrot; `avizo` (tytuł „Powrót do oddziału”: drugi raz nie zastano odbiorcy) = nieudane
 * doręczenie, nie zwrot: po nim paczka bywa wydana ponownie albo czeka w oddziale, a stan końcowy tylko z kodu, po
 * którym paczka nie może już trafić do odbiorcy (prawdziwy zwrot pokazuje `returned_to_sender`);
 * `return_pickup_confirmation_to_sender` („przesyłka została odebrana”, potwierdzenie odbioru do nadawcy) = doręczona;
 * `pickup_time_expired` i `rejected_by_receiver` = zwrot (decyzja z przeglądu osi statusów, 14.11.2026: po nich paczka jedzie do nadawcy, a ShipX podaje tylko bieżący status, więc kolejne
 * `taken_by_courier` i `out_for_delivery` byłyby drogą powrotną wyglądającą jak doręczanie; stan końcowy zatrzymuje
 * odpytywanie, chwilę powrotu paczki rejestruje przyjęcie zwrotu); `claimed` (reklamacja u InPost) = problem.
 */
const SHIPX_OS: Readonly<Record<string, StanDrogi>> = {
  dispatched_by_sender: 'PRZEKAZANA',
  dispatched_by_sender_to_pok: 'PRZEKAZANA',
  collected_from_sender: 'PRZEKAZANA',
  taken_by_courier: 'PRZEKAZANA',
  taken_by_courier_from_pok: 'PRZEKAZANA',
  adopted_at_source_branch: 'W_DRODZE',
  sent_from_source_branch: 'W_DRODZE',
  adopted_at_sorting_center: 'W_DRODZE',
  sent_from_sorting_center: 'W_DRODZE',
  adopted_at_target_branch: 'W_DRODZE',
  unstack_from_box_machine: 'W_DRODZE',
  unstack_from_customer_service_point: 'W_DRODZE',
  delay_in_delivery: 'W_DRODZE',
  redirect_to_box: 'W_DRODZE',
  canceled_redirect_to_box: 'W_DRODZE',
  readdressed: 'W_DRODZE',
  stack_parcel_pickup_time_expired: 'W_DRODZE',
  stack_parcel_in_box_machine_pickup_time_expired: 'W_DRODZE',
  taken_by_courier_from_customer_service_point: 'ZWROT',
  out_for_delivery: 'W_DORECZENIU',
  out_for_delivery_to_address: 'W_DORECZENIU',
  ready_to_pickup: 'W_PUNKCIE',
  ready_to_pickup_from_pok: 'W_PUNKCIE',
  ready_to_pickup_from_pok_registered: 'W_PUNKCIE',
  ready_to_pickup_from_branch: 'W_PUNKCIE',
  stack_in_box_machine: 'W_PUNKCIE',
  stack_in_customer_service_point: 'W_PUNKCIE',
  pickup_reminder_sent: 'W_PUNKCIE',
  delivered: 'DORECZONA',
  return_pickup_confirmation_to_sender: 'DORECZONA',
  avizo: 'NIEUDANE_DORECZENIE',
  pickup_reminder_sent_address: 'NIEUDANE_DORECZENIE',
  courier_avizo_in_customer_service_point: 'NIEUDANE_DORECZENIE',
  oversized: 'NIEUDANE_DORECZENIE',
  pickup_time_expired: 'ZWROT',
  rejected_by_receiver: 'ZWROT',
  returned_to_sender: 'ZWROT',
  claimed: 'PROBLEM',
}

export function stanDrogiShipX(status: string | null): StanDrogi {
  if (!status) return 'NIEZNANY'
  const os = Object.hasOwn(SHIPX_OS, status) ? SHIPX_OS[status] : undefined
  if (os) return os
  if (status.startsWith('undelivered')) return 'NIEUDANE_DORECZENIE'
  if (SHIPX_PRZED_NADANIEM.has(status)) return 'UTWORZONA'
  if (SHIPX_ANULOWANA.has(status)) return 'ANULOWANA'
  return 'NIEZNANY'
}

class InpostShipxZapisAdapter implements ChannelAdapter, ShipmentPreparer, ShipmentCreator, ReferenceFinder, ShipmentTracker {
  readonly manifest = INPOST_SHIPX_ZAPIS_MANIFEST
  private readonly api: InpostReadOnly
  private readonly organizationId: string
  private readonly ustawienia: UstawieniaInpost
  private readonly sendingMethod: string
  /** null = wyłącznik nie jest włączony: nie ma czym wysłać żądania zapisu. */
  private readonly zapis: InpostZapis | null

  constructor(ctx: AdapterContext) {
    this.api = inpostReadOnlyFromContext(ctx)
    this.organizationId = String(ctx.config['organizationId'])
    this.ustawienia = ustawieniaInpost(ctx.config)
    this.sendingMethod = typeof ctx.config['sendingMethod'] === 'string' ? ctx.config['sendingMethod'] : DOMYSLNY_SENDING_METHOD
    this.zapis =
      ctx.config['zapisWlaczony'] === true
        ? new InpostZapis({ baseUrl: String(ctx.config['baseUrl']), token: ctx.secrets['INPOST_TOKEN']!, organizationId: this.organizationId, wylacznik: true, fetchImpl: ctx.fetch, labelType: typeof ctx.config['labelType'] === 'string' ? ctx.config['labelType'] : null })
        : null
  }

  testConnection(): Promise<ConnectionTest> {
    return testInpostConnection(this.api, this.organizationId)
  }

  prepareShipment(input: ShipmentInput): PreparedParcel {
    return wyliczPrzesylkeInpost(input, this.ustawienia)
  }

  /**
   * Ostrzeżenia przesyłki (wartości robocze) przechodzą tylko wtedy, gdy człowiek je potwierdził
   * (`req.potwierdzoneOstrzezenia`); każde inne blokuje utworzenie (jak `buildCreateOrderPayload`).
   */
  async createShipment(req: ShipmentCreateRequest, reference: string): Promise<WriteOutcome> {
    if (!this.zapis) return { kind: 'TRWALY', reference, message: WYLACZONY }
    const r = odbiorca(req.recipient)
    if ('brak' in r) return { kind: 'TRWALY', reference, message: r.brak.includes('kraj') ? 'odbiorca spoza Polski: moduł InPost ShipX jest krajowy (kraj)' : `brak danych odbiorcy: ${r.brak.join(', ')}` }
    let payload: Record<string, unknown>
    try {
      payload = buildShipmentPayload(req.parcel, r, { sendingMethod: this.sendingMethod }, req.potwierdzoneOstrzezenia ?? [])
    } catch (e) {
      return { kind: 'TRWALY', reference, message: e instanceof Error ? e.message : String(e) }
    }
    return this.zapis.createShipment(payload, reference)
  }

  async getLabel(externalRef: string, format: LabelFormat): Promise<{ contentType: string; base64: string }> {
    if (!this.zapis) throw new AdapterError(WYLACZONY, 'TRWALY')
    return this.zapis.getLabel(externalRef, format)
  }

  async getTrackingNumber(externalRef: string): Promise<string | null> {
    if (!this.zapis) throw new AdapterError(WYLACZONY, 'TRWALY')
    return this.zapis.getTrackingNumber(externalRef)
  }

  async findByReference(reference: string): Promise<ReferenceLookup> {
    if (!this.zapis) throw new AdapterError(WYLACZONY, 'TRWALY')
    return this.zapis.findByReference(reference)
  }

  /**
   * id przesyłki wpisane przy „Rozstrzygnij ręcznie”. Przesyłka musi istnieć w ShipX, nieść
   * referencję tej przesyłki i mieć numer nadania; inaczej odmowa bez zapisu. Sieć, 429 i 5xx = wyjątek (host: „spróbuj
   * ponownie”). Każda przesyłka Kompletora idzie do ShipX z `reference`
   * (`lib/zrodla/inpost-zapis.ts`), więc przesyłka bez referencji powstała poza Kompletorem (Manager Paczek, inny
   * system) i nie jest tą przesyłką: odmowa, nie przyjęcie z dopiskiem (id ShipX rosną kolejno, literówka trafia w
   * sąsiednią paczkę tej samej firmy).
   */
  async confirmManual(identyfikator: string, reference: string): Promise<PotwierdzenieRecznego> {
    if (!this.zapis) return { odmowa: 'Nadawanie InPost jest wyłączone w ustawieniach przewoźnika: Kompletor nie może sprawdzić numeru w InPost.' }
    const id = identyfikator.trim()
    if (!/^\d{1,20}$/.test(id)) return { odmowa: 'Podaj id przesyłki z panelu InPost (same cyfry).' }
    let p: { reference: string | null; trackingNumber: string | null }
    try {
      p = await this.zapis.getShipment(id)
    } catch (e) {
      if (e instanceof AdapterError && e.kind === 'TRWALY') return { odmowa: `InPost nie potwierdził przesyłki o id ${id}: sprawdź id w panelu InPost.` }
      throw e
    }
    if (p.reference === null) return { odmowa: `Przesyłka ${id} w InPost nie ma referencji Kompletora: nie utworzył jej Kompletor. Sprawdź id w panelu InPost.` }
    if (p.reference !== reference) return { odmowa: `Przesyłka ${id} w InPost ma inną referencję niż ta przesyłka: to inna paczka. Sprawdź id w panelu InPost.` }
    if (!p.trackingNumber) return { odmowa: `InPost nie nadał jeszcze numeru przesyłce ${id}: spróbuj za kilka minut.` }
    return { externalRef: id, info: `Sprawdzone w InPost: numer nadania ${p.trackingNumber}.`, referencjaSprawdzona: true }
  }

  /** stan przesyłki w ShipX (sam odczyt). Bez wyłącznika zapisu przesyłek z Kompletora i tak nie ma. */
  // Wyłączony zapis = błąd konta (przesyłki zostają w śledzeniu); zły id = błąd tej przesyłki; 404 = stan nieznany; 401/403 rozpoznaje
  // host po treści jako błąd konta; reszta odmów = następna próba za pół godziny.
  async trackShipment(externalRef: string): Promise<OdczytPrzesylki> {
    if (!this.zapis) throw new BladKontaSledzenia(WYLACZONY)
    if (!INPOST_ID_RE.test(externalRef)) throw new BladPrzesylkiSledzenia('Zły identyfikator przesyłki InPost ShipX')
    let status: string | null
    try {
      ;({ status } = await this.zapis.getShipment(externalRef))
    } catch (e) {
      // 404 = stan nieznany, nie koniec: ten sam kod może dać zły adres usługi w regule (sandbox zamiast produkcji)
      // albo token innej organizacji; koniec sprawdzania dopiero po progu czasu nieznanego stanu
      if (e instanceof AdapterError && e.kind === 'TRWALY' && /\bHTTP 404\b/.test(e.message)) return { stan: 'NIEZNANY', status: null, stanDrogi: 'NIEZNANY', kod: null }
      throw e
    }
    return { stan: stanShipX(status), status, stanDrogi: stanDrogiShipX(status), kod: status }
  }
}

export const INPOST_SHIPX_ZAPIS_DEFINITION: AdapterDefinition = { manifest: INPOST_SHIPX_ZAPIS_MANIFEST, create: (ctx) => new InpostShipxZapisAdapter(ctx) }
