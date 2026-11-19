// Kontrakt adaptera kanału. Wzorce z porównania z OpenLinkerem 25.10.2026, kod
// własny:
//   1. mały port bazowy (manifest + test połączenia) i opcjonalne zdolności sprawdzane strażnikami typu — adapter
//      nie musi umieć wszystkiego, a host pyta, co umie, zamiast łapać „not supported”;
//   2. manifest z kluczem tekstowym (`adapterKey`, format jak ChannelConfig.adapterKey), wersją,
//      zdolnościami, limitami tempa i opisem pól konfiguracji i sekretów (walidowanych przed utworzeniem adaptera);
//   3. wynik zapisu: OK / PRZEJSCIOWY / TRWALY / NIEJEDNOZNACZNY, a przy niejednoznacznym odszukanie po referencji
//      (`findByReference`) zamiast ślepego ponowienia (lib/adaptery/zapis.ts);
//   4. dziennik zamówień = kursor + pełne pobranie zamówienia (`getOrder`); webhook (później) tylko budzi odczyt;
//   5. nieczytelne dane to błąd, nigdy 0 (UnreadableDataError) — zero zdejmuje ofertę, zła ilość psuje rezerwację;
//      nieznany status z kanału = ostrzeżenie i stan nieterminalny;
//   6. fałszywy adapter (lib/adaptery/falszywy.ts) i wspólna suita kontraktowa (lib/adaptery/suita-kontraktowa.ts),
//      którą przechodzi każdy adapter.
// Dane osobowe klientów (adres, e-mail, telefon, imię) nie wchodzą do dziennika: ChannelOrder ich nie ma, więc nie
// trafią do rdzenia, logów ani raportów. Przesyłka i faktura w trybie PRACA dostają odbiorcę osobną zdolnością
// `orders.recipient`: odczyt z kanału w chwili użycia, tylko w pamięci, wyłącznie przez funkcję hosta
// `pobierzOdbiorce` (lib/odbiorca/pobierz.ts: bramka PRACA, ślad w AuditLog bez danych; docs/dane-odbiorcy.md).
import type { Carrier, Channel, PaymentState } from '@prisma/client'
import type { FetchLike, RetryOptions } from '../zrodla/http'

/** Format klucza: „<dostawca>[.<api>].v<wersja>” (lib/adaptery.ts, — jedno źródło). */
export { ADAPTER_KEY_RE } from '../adaptery'

// ─── Zdolności ───────────────────────────────────────────────────────────────

// Lista zamknięta: rejestr odrzuca nieznane zdolności. Nowa zdolność (np. etykieta przewoźnika, faktura) to zmiana
// tego pliku i strażnik typu niżej — nie zmiana rdzenia.
export const CAPABILITIES = [
  'orders.feed', // dziennik zamówień: kursor + pełne zamówienie (OrderFeed)
  'stock.write', // zapis stanu ofert (StockWriter) — w cieniu nikt go nie woła
  'order.status.write', // zmiana statusu zamówienia w kanale (OrderStatusWriter), w cieniu nikt go nie woła
  'offers.read', // lista ofert kanału z SKU, EAN i stanem (OfferReader)
  'reference.find', // odszukanie skutku zapisu po referencji (ReferenceFinder)
  'shipment.prepare', // parametry przesyłki bez jej tworzenia (ShipmentPreparer)
  'orders.recipient', // odbiorca zamówienia na żądanie, tylko w pamięci (RecipientReader)
  'shipment.create', // utworzenie przesyłki i etykieta (ShipmentCreator), w cieniu nikt tego nie woła
  'invoice.prepare', // treść faktury bez wystawiania i wysyłki (InvoicePreparer)
  'order.accept', // przyjęcie albo odrzucenie pozycji zamówienia czekającego na akceptację (Mirakl OR21)
  // dostawca dokumentów sprzedaży (lib/dokumenty/kontrakt.ts) — każda zdolność opcjonalna
  'invoice.issue', // wystawienie dokumentu (InvoiceIssuer); adapter tylko do odczytu nie może jej mieć
  'invoice.find', // odszukanie dokumentów po prefiksie referencji (InvoiceFinder), rozstrzyga timeout wystawienia
  'invoice.correct', // korekta dokumentu (InvoiceCorrector)
  'invoice.pdf', // PDF dokumentu (InvoicePdfReader)
  'order.tracking.write', // numer nadania w zamówieniu kanału (TrackingWriter), w cieniu nikt tego nie woła
  'shipment.cancel', // anulowanie utworzonej przesyłki u przewoźnika (ShipmentCreator.cancelShipment)
  // wynik asynchronicznego importu stanów (Mirakl STO02/STO03) po zapisie, który kanał przyjął do kolejki
  'stock.import.status',
  'shipment.track', // stan przesyłki u przewoźnika na żądanie (ShipmentTracker), sam odczyt
  // zwroty klientów zgłoszone w kanale (Allegro customer-returns), tylko odczyt, bez danych kupującego
  'returns.read',
  // odczyt kanału do przygotowania oferty (kategorie, parametry, katalog, sprawdzenie dubla), tylko GET
  'offers.prepare',
  // wystawienie nowej oferty albo produktu w kanale, za osobnym przełącznikiem konta
  'offers.publish',
] as const
export type Capability = (typeof CAPABILITIES)[number]

/** limit jednej zdolności konta (np. tworzenie przesyłek 120/min), obok limitu całego konta. */
export interface CapabilityRateLimit {
  requestsPerMinute: number
  /** Najwięcej wywołań tej zdolności naraz w jednym procesie (brak = bez limitu). */
  maxConcurrent?: number
}

export interface RateLimit {
  /**
   * Limit platformy na konto: wywołań adaptera na minutę (egzekwowany przez host, `lib/integracje/limity.ts`,
   * kubełek żetonów w Postgresie wspólny dla panelu i workera). Odczyt po wyczerpaniu czeka na żeton (do 30 s), zapis
   * jest odkładany z czasem ponowienia (wynik PRZEJSCIOWY z `odlozone`), nigdy błąd trwały i nigdy zgubione zadanie.
   */
  requestsPerMinute: number
  /** Informacyjnie: adaptery same trzymają jedno żądanie naraz; host nie liczy współbieżności konta. */
  maxConcurrent: number
  /**
   * limity pojedynczych zdolności (wzorzec `rate_limits.per_action` z Open Integration Platform, własna
   * implementacja). Brak zdolności w mapie = tylko limit konta. Limit jednej zdolności nie zużywa limitu innej.
   */
  perCapability?: Partial<Record<Capability, CapabilityRateLimit>>
  /** Najkrótszy dozwolony odstęp między odczytami dziennika zamówień (np. Mirakl OR11: 60 s). */
  minPollIntervalMs: number
  /**
   * Najkrótszy odstęp między odczytami odbiorcy na żądanie jednego konta (`orders.recipient`). Pilnuje go
   * host (`lib/odbiorca/tempo.ts`) w obrębie procesu, bo adapter powstaje przy każdym odczycie. Brak = bez odstępu
   * (Woo, Allegro: limity luźne); Mirakl OR11: 60 s.
   */
  recipientMinIntervalMs?: number
}

export type ConfigValue = string | number | boolean
export type AccountConfig = Readonly<Record<string, ConfigValue>>

export interface ConfigField {
  key: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
  description: string
  /** Dla type=string: wymagany kształt (np. adres https). */
  pattern?: RegExp
  /** Self-host: wartość może przyjść z env `<config.envPrefix>_<envSuffix>`, gdy nie ma jej w konfiguracji konta. */
  envSuffix?: string
  /** dla type=string lista dozwolonych wartości z etykietami (panel pokazuje listę wyboru, rejestr sprawdza). */
  options?: readonly { value: string; label: string }[]
}

/**
 * osobny wyłącznik konta na wystawianie ofert (zakładanie ofert i produktów w kanale). Niezależny od
 * `zapisWlaczony` (stany, statusy, numery nadania): włączony zapis stanów nie pozwala zakładać ofert. Domyślnie wyłączony,
 * przełącza go ekran konta (Ustawienia → Kanały sprzedaży → konto → „Zapis do sklepu”).
 */
export const WYSTAWIANIE_OFERT_KLUCZ = 'wystawianieOfertWlaczone'
export const POLE_WYSTAWIANIA_OFERT: ConfigField = {
  key: WYSTAWIANIE_OFERT_KLUCZ,
  type: 'boolean',
  required: false,
  description: 'wyłącznik: tak = z ekranu „Publikacja” na karcie produktu można wystawić ofertę w tym kanale; brak = nic nie wystawiamy',
}
export const wystawianieOfertWlaczone = (config: Readonly<Record<string, unknown>>) => config[WYSTAWIANIE_OFERT_KLUCZ] === true
export const WYSTAWIANIE_WYLACZONE = 'wystawianie ofert wyłączone na tym koncie'

export interface SecretField {
  name: string // nazwa sekretu konta (IntegrationSecret.name), wielkie litery
  required: boolean
  description: string
  envSuffix?: string
}

/** Rodzaj integracji: konto kanału sprzedaży, przewoźnik (CarrierRule.adapterKey), program do faktur. */
export const INTEGRATION_KINDS = ['channel', 'carrier', 'invoicing'] as const
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number]

export interface AdapterManifest {
  adapterKey: string
  version: string
  displayName: string
  kind: IntegrationKind
  /** Rodzina kanału w rdzeniu (enum Channel) — wymagana dla `kind: 'channel'` (logika rezerwacji i propagacji). */
  channel?: Channel
  capabilities: readonly Capability[]
  rateLimit: RateLimit
  config: readonly ConfigField[]
  secrets: readonly SecretField[]
  /** true = ta wersja adaptera niczego nie zapisuje w kanale (tryb cienia). */
  readOnly: boolean
  /**
   * zachowanie kanału opisane w manifeście, nie w rdzeniu. Host zapisu (lib/kanaly/zapis-host.ts)
   * czyta stąd model stanu, słownik statusów kanału do ekranu konta i domyślną mapę statusów nowego konta.
   */
  channelBehavior?: ChannelBehavior
  /**
   * najgorszy czas żywego „Utwórz przesyłkę” tego modułu przewoźnika (utworzenie, odszukanie po referencji,
   * numer nadania) w ms, gdy dłuższy niż domyślne 3 min. Host (`progZawieszenia`, lib/wysylka/nadanie.ts) dolicza zapas
   * i dopiero potem pokazuje „Sprawdź u przewoźnika” przy przesyłce, która utknęła w tworzeniu. Brak = domyślny próg.
   */
  shipmentMaxCreateMs?: number
  /**
   * `trackShipment` umie zwrócić `DORECZONA`. Tylko takie moduły host śledzi dalej po „Wysłane”
   * (do doręczenia, z limitem dni); bez tej deklaracji paczka po „Wysłane” nie jest już pytana.
   */
  trackReportsDelivered?: boolean
}

/** Klucz mapy statusów: status Kompletora albo zdarzenie szczególne (anulowanie nieopłaconego po terminie). */
export const STATUS_MAP_KEYS = ['DO_REALIZACJI', 'ZBIERANIE', 'SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE', 'ANULOWANE', 'ANULOWANE_NIEOPLACONE'] as const
export type StatusMapKey = (typeof STATUS_MAP_KEYS)[number]
/**
 * etapy Kompletora, których status firmy wolno wysłać do sklepu nadpisaniem
 * (`config.statusyFirmy`). Etapy mapy enumu plus `ZEBRANE`; bez `NOWE` (zamówienie nieopłacone: sklep nie może
 * dostać „w realizacji”), `DO_WYJASNIENIA` i `REKLAMACJA` (stan wewnętrzny biura). Jedna lista dla planu zapisu,
 * zapisu mapy konta i formularza konta.
 */
export const ETAPY_DO_SKLEPU = ['DO_REALIZACJI', 'ZBIERANIE', 'ZEBRANE', 'SPAKOWANE', 'DO_WYSLANIA', 'DO_ODBIORU', 'WYSLANE', 'ODEBRANE', 'ANULOWANE'] as const
export const etapDoSklepu = (s: string): boolean => (ETAPY_DO_SKLEPU as readonly string[]).includes(s)
/** Powód, dla którego status firmy z danego etapu nie idzie do sklepu (tekst do formularza i błędu zapisu). */
export const POWOD_ETAPU_POZA_SKLEPEM = 'nie idzie do sklepu: etap „Nowe” (zamówienie nieopłacone), „Do wyjaśnienia” i „Reklamacja” zostają tylko w Kompletorze'
/** Mapa: status Kompletora → identyfikator statusu kanału. Brak klucza = tego przejścia nie wysyłamy. */
export type StatusMap = Partial<Record<StatusMapKey, string>>

export interface ChannelBehavior {
  /** `self-decrementing` = kanał sam zdejmuje stan przy zamówieniu (wzrost dopiero po odczycie zamówień); `pushed` = nie. */
  stockModel: 'self-decrementing' | 'pushed'
  /** Statusy kanału do wyboru w mapie (id + nazwa po polsku). Brak = pole tekstowe. */
  channelStatuses?: readonly { id: string; label: string }[]
  /** Domyślna mapa konta bez własnej (preset dla rodzaju sklepu). Konto zmienia ją w panelu (`ChannelConfig.config.statusy`). */
  defaultStatusMap?: StatusMap
  /**
   * true = adapter sprawdza `StatusWriteGuard.onlyIfUnpaid` na świeżym odczycie zamówienia. Bez tego host nie wysyła
   * „anulowania nieopłaconego po terminie” (ANULOWANE_NIEOPLACONE), bo nie anulowałby bezpiecznie opłaconego w międzyczasie.
   */
  unpaidGuard?: boolean
}

// ─── Kontekst i port bazowy ──────────────────────────────────────────────────

/** Do czego jest podpięty adapter: konto kanału (channel + channelAccountId), przewoźnik albo program do faktur. */
export interface IntegrationRef {
  organizationId: string
  kind: IntegrationKind
  /** Identyfikator w obrębie firmy, np. „WOO/sklep1”, „basecourier”, „wfirma”. */
  id: string
  name: string
  channel?: Channel
  channelAccountId?: string
}

export interface AdapterContext {
  integration: IntegrationRef
  /** Konfiguracja po walidacji z manifestem (wartości z ChannelConfig.config, w self-hoście też z env). */
  config: AccountConfig
  /** Sekrety po walidacji; adapter nigdy nie wypisuje ich w błędach ani wynikach. */
  secrets: Readonly<Record<string, string>>
  fetch: FetchLike
  now: () => Date
  /** Strojenie klienta HTTP (testy, wolne kanały); domyślne wartości ma adapter. */
  http?: { retry?: RetryOptions; minIntervalMs?: number; /** odstęp odpytywania komend asynchronicznych (Allegro); testy 0. */ pollDelayMs?: number }
  /**
   * Zapis odświeżonych sekretów integracji (OAuth z jednorazowym refresh tokenem, np. Allegro) — host zapisuje je
   * zaszyfrowane w zakresie tej integracji; tylko nazwy z manifestu. Brak = host nie pozwala na zapis.
   */
  persistSecrets?: (patch: Record<string, string>) => Promise<void>
  /**
   * Odświeżenie sekretów pod blokadą integracji (OAuth z jednorazowym refresh tokenem): najwyżej jedno naraz,
   * także między procesami (worker i CLI). Host czyta świeże wartości z bazy; gdy `stale` już nie jest aktualne (inny
   * proces odświeżył), zwraca je bez wołania `refresh`. Inaczej woła `refresh` i zapisuje wynik PRZED zwrotem (nieudany
   * zapis: jedna ponowna próba, potem alert i błąd). Tylko nazwy z manifestu. Brak = host nie ma blokady.
   */
  rotateSecrets?: (rotation: SecretRotation) => Promise<Record<string, string>>
  /**
   * runda 3: ustawienia firmy potrzebne adapterowi kanału, wstawiane przez hosta (`createAccountAdapter`)
   * z `Organization.settings` tą samą funkcją, której używa dokument sprzedaży, żeby adapter i faktura nie mogły się
   * rozjechać. `rabatMaksProcent` = `settings.faktury.rabatMaksProcent` (lib/dokumenty/ustawienia.ts). Brak = domyślne.
   */
  ustawieniaFirmy?: UstawieniaFirmyAdaptera
}

export interface UstawieniaFirmyAdaptera {
  rabatMaksProcent: number
}

export interface SecretRotation {
  /** Sekrety czytane świeżo z bazy i przekazywane do `refresh` (pierwszy = wiersz blokady, musi istnieć). */
  names: readonly string[]
  /** Wartość, z którą adapter dostał odmowę albo której termin mija; inna w bazie = już odświeżone. */
  stale: { name: string; value: string }
  refresh(current: Readonly<Record<string, string>>): Promise<Record<string, string>>
}

export interface ConnectionTest {
  ok: boolean
  message: string
  /** Liczby i ustawienia kanału (np. hold_stock_minutes), bez sekretów i danych klientów. */
  details?: Record<string, string | number | boolean | null>
  /**
   * nazwy kluczy pól dodatkowych (`meta_data`) z kilku ostatnich zamówień i w ilu z nich wystąpiły — do
   * podpowiedzi pól NIP / punktu odbioru / faktury na ekranie konta. Same nazwy, nigdy wartości.
   */
  orderMeta?: { sample: number; keys: { key: string; orders: number }[] }
}

/** Port bazowy: każdy adapter ma manifest i test połączenia. Reszta to zdolności niżej. */
export interface ChannelAdapter {
  readonly manifest: AdapterManifest
  testConnection(): Promise<ConnectionTest>
}

// ─── Błędy ───────────────────────────────────────────────────────────────────

export type FailureKind = 'PRZEJSCIOWY' | 'TRWALY' | 'NIEJEDNOZNACZNY'

/**
 * Błąd adaptera z rodzajem: PRZEJSCIOWY (429, 5xx, sieć przy odczycie) — wolno ponowić; TRWALY (walidacja, 401/403,
 * zła konfiguracja) — ponowienie nic nie da, potrzebny człowiek albo zmiana danych; NIEJEDNOZNACZNY (5xx albo
 * timeout PO wysłaniu zapisu) — nie wiadomo, czy zapis się wykonał, nie ponawiać bez odszukania po referencji.
 */
export class AdapterError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly retryAfterMs?: number,
    /** klasa błędu trwałego (uwierzytelnienie, konfiguracja) — liczy się do automatycznego wyłączenia konta. */
    readonly errorClass?: ErrorClass,
  ) {
    super(message)
    this.name = 'AdapterError'
  }
}

/**
 * klasa błędu trwałego. `UWIERZYTELNIENIE` (klucz, token, login odrzucone: 401/403) i `KONFIGURACJA` (zły adres,
 * brak sekretu) liczą się do progu automatycznego wyłączenia konta; błędy danych pojedynczego rekordu (walidacja
 * przesyłki, nieczytelna oferta) nie, bo jeden zły rekord nie może wyłączyć całej integracji. Brak pola = host rozpoznaje
 * klasę po treści (`klasaBledu`, lib/integracje/oslona.ts).
 */
export type ErrorClass = 'UWIERZYTELNIENIE' | 'KONFIGURACJA'

/** Dane z kanału, których nie da się odczytać (brak pola, nie-liczba). Nigdy nie zamieniamy ich na 0. */
export class UnreadableDataError extends AdapterError {
  constructor(message: string) {
    super(message, 'TRWALY')
    this.name = 'UnreadableDataError'
  }
}

export function failureKindOf(e: unknown): FailureKind | null {
  return e instanceof AdapterError ? e.kind : null
}

/** Liczba z kanału albo błąd (nigdy 0 w zastępstwie). */
export function readNumber(v: unknown, what: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  if (!Number.isFinite(n)) throw new UnreadableDataError(`nieczytelna liczba: ${what}`)
  return n
}

export function readInt(v: unknown, what: string): number {
  const n = readNumber(v, what)
  if (!Number.isInteger(n)) throw new UnreadableDataError(`nie jest liczbą całkowitą: ${what}`)
  return n
}

/**
 * pole opisowe z kanału (nazwa pozycji, SKU, EAN, koszt wysyłki). Nieczytelne albo puste = null, nigdy
 * błąd: opis nie może zatrzymać przyjęcia zamówienia. Tekst przycięty do `max` znaków.
 */
export function optText(v: unknown, max = 500): string | null {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
  return s ? s.slice(0, max) : null
}

export function optAmount(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null
}

/** Data z kanału (ISO; bez strefy = UTC, gdy `assumeUtc`) albo błąd. */
export function readDate(v: unknown, what: string, assumeUtc = false): Date {
  if (typeof v !== 'string' || !v.trim()) throw new UnreadableDataError(`brak daty: ${what}`)
  const s = assumeUtc && !/[zZ]|[+-]\d\d:?\d\d$/.test(v.trim()) ? `${v.trim()}Z` : v.trim()
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) throw new UnreadableDataError(`nieczytelna data: ${what}`)
  return d
}

// ─── Zdolność: dziennik zamówień ─────────────────────────────────────────────

/**
 * Cykl życia zamówienia w kanale, z którego rdzeń bierze decyzję o rezerwacji:
 * DRAFT — jeszcze nie zamówienie (koszyk, weryfikacja) → pomijane; OPEN — rezerwuje; CANCELLED — bez rezerwacji /
 * zwolnienie; FULFILLED — wysłane/zrealizowane w kanale (widziane pierwszy raz w tym stanie nie rezerwuje, bo towar
 * już zszedł ze stanu).
 */
export type OrderLifecycle = 'DRAFT' | 'OPEN' | 'CANCELLED' | 'FULFILLED'

export interface ChannelOrderLine {
  externalLineId: string
  /** Id oferty w formacie ChannelOffer.externalId (Woo „<produkt>[/<wariant>]”, Empik product_sku); null = brak. */
  offerExternalId: string | null
  qty: number // sztuki oferty, > 0
  unitPriceGross: number
  vatRate: string | null
  /**
   * opis pozycji tak, jak podał kanał (nazwa, SKU/sygnatura sprzedawcy, EAN); bez danych klienta. Pole
   * opcjonalne: adapter bez opisu też spełnia kontrakt, a rdzeń nic na nim nie liczy (mapowanie idzie po ofercie).
   */
  name?: string | null
  sku?: string | null
  ean?: string | null
}

/** Zamówienie znormalizowane przez adapter. Bez danych osobowych klienta. */
export interface ChannelOrder {
  externalId: string
  /** Numer zamówienia widoczny w kanale i w BL, gdy inny niż id (Woo z numeracją wtyczki: id 118438, numer 158405). */
  number?: string | null
  /** Rosnąca rewizja (ISO UTC daty ostatniej zmiany albo numer); porównywana przez rdzeń (5.3). */
  revision: string
  createdAt: Date
  /** Surowy status kanału (do raportu i porównania z BL). */
  channelStatus: string
  /** Liczba porządkowa statusu (cofnięcie → DO_WYJASNIENIA); null = nieznany albo bez kolejności. */
  statusRank: number | null
  lifecycle: OrderLifecycle
  paymentState: PaymentState
  paymentMethod: string
  /**
   * Bramka płatności online odrzuciła płatność (np. Woo `failed` przy BLIK albo karcie), a metoda nie jest przelewem
   * tradycyjnym ani pobraniem. Rdzeń trzyma wtedy towar tylko przez krótki czas z zasad rezerwacji firmy.
   * Brak = kanał tego nie rozróżnia (zwykłe terminy nieopłaconych).
   */
  paymentFailedOnline?: boolean
  /** Metoda płatności offline (przelew tradycyjny, czek, pobranie) wg identyfikatora metody z kanału, nie nazwy. */
  paymentOffline?: boolean
  totalGross: number
  currency: string
  deliveryMethod: string | null
  /** koszt wysyłki brutto z kanału (opisowy, do karty); null/brak = kanał nie podał. */
  shippingCostGross?: number | null
  wantInvoiceNip: boolean
  lines: ChannelOrderLine[]
  /** Ostrzeżenia mapowania (nieznany status, pozycja pominięta) — bez danych klientów. */
  warnings: string[]
}

export interface OrderFeedItem {
  externalId: string
  revision: string
  /** Pełne zamówienie, gdy lista kanału je zawiera; inaczej host woła getOrder. */
  order?: ChannelOrder
}

export interface OrderFeedPage {
  items: OrderFeedItem[]
  /** Kursor po tej stronie (zapisywany dopiero po przetworzeniu strony). Nieprzezroczysty dla hosta. */
  nextCursor: string
  hasMore: boolean
  /** Ostrzeżenia odczytu (np. kursor poza retencją dziennika → odczyt zapasowy); host robi z nich alert konta. */
  warnings?: string[]
}

export interface OrderFeedOptions {
  /** Pierwszy odczyt (kursor null): od ilu milisekund wstecz. */
  initialLookbackMs: number
}

export interface OrderFeed {
  listOrderChanges(cursor: string | null, opts: OrderFeedOptions): Promise<OrderFeedPage>
  /** Pełne zamówienie z API; null tylko wtedy, gdy kanał odpowiada „nie ma” (np. 404) — nigdy przy błędzie. */
  getOrder(externalId: string): Promise<ChannelOrder | null>
}

// ─── Zdolności zapisu (kontrakt na F2+, w cieniu tylko fałszywy adapter) ─────

export interface StockWriteItem {
  offerExternalId: string
  qty: number
}

/** pozycja paczki stanów, która się nie udała (reszta paczki przeszła). */
export interface FailedWriteItem {
  offerExternalId: string
  kind: FailureKind
  message: string
}

export type WriteOutcome =
  | {
      kind: 'OK'
      reference: string
      externalRef?: string
      /**
       * informacja dla obsługi przy udanym zapisie, np. przewoźnik zmienił punkt
       * odbioru. Bez danych osobowych. Host dopisuje ją do przesyłki (`lastError`), do zdarzenia i pokazuje na karcie.
       */
      info?: string
    }
  | {
      kind: FailureKind
      reference: string
      message: string
      retryAfterMs?: number
      /** klasa błędu trwałego (jak `AdapterError.errorClass`). */
      errorClass?: ErrorClass
      /**
       * zapis w ogóle nie wyszedł, bo host odłożył go (limit tempa konta albo zdolności, konto wyłączone po
       * błędach). Zawsze z `kind: 'PRZEJSCIOWY'` i `retryAfterMs`. Host ponawia po tym czasie i NIE liczy tego jako próby.
       */
      odlozone?: boolean
      /**
       * zapis paczki stanów, w której część pozycji przeszła: tu tylko te nieudane (z rodzajem), pozostałe są
       * zapisane. Brak pola = nie udała się cała paczka. Host ponawia i alarmuje per pozycja, nie per paczka.
       */
      failedItems?: readonly FailedWriteItem[]
      /** identyfikator zapisu w kanale, gdy część paczki przeszła (np. import stanów Mirakl `STO01:<id>`). */
      externalRef?: string
    }

/**
 * wynik importu stanów, który kanał przetwarza po przyjęciu pliku (Mirakl STO01 → STO02/STO03).
 * `W_TOKU` = kanał jeszcze liczy; `GOTOWE` = przetworzony (`odrzucone` > 0 = część wierszy kanał odrzucił);
 * `NIEUDANE` = kanał odrzucił cały import. Bez treści wierszy: same liczby i kody ofert (to nie są dane klientów).
 */
export type StockImportStatus =
  | { state: 'W_TOKU' }
  | { state: 'GOTOWE'; przyjete: number | null; odrzucone: number; /** kody ofert kanału z raportu błędów (do 20), gdy kanał je podaje */ kodyOdrzuconych: string[] }
  | { state: 'NIEUDANE'; message: string }
  /**
   * kanał nie podaje wyniku temu kontu (`BRAK_DOSTEPU`: 403/404, np. konto Empiku bez STO02 albo
   * historia importu usunięta; `KLUCZ`: 401). To nie znaczy „odrzucone”: stany mogły wejść, tylko nie wiemy.
   */
  | { state: 'NIEDOSTEPNY'; powod: 'BRAK_DOSTEPU' | 'KLUCZ'; message: string }

export interface StockImportStatusReader {
  /** Stan importu po `externalRef` z wyniku `pushStock`. Błąd odczytu = AdapterError (PRZEJSCIOWY albo TRWALY). */
  getStockImportStatus(externalRef: string): Promise<StockImportStatus>
}

export interface StockWriter {
  /** Zapis paczki stanów pod referencją (deterministyczny klucz idempotencji od hosta). */
  pushStock(items: StockWriteItem[], reference: string): Promise<WriteOutcome>
}

export type ReferenceLookup = { found: true; externalRef?: string } | { found: false }

/** wynik sprawdzenia numeru wpisanego przy „Rozstrzygnij ręcznie” (`ShipmentCreator.confirmManual`). */
export type PotwierdzenieRecznego = { externalRef: string; info?: string; referencjaSprawdzona?: boolean } | { odmowa: string }

export interface ReferenceFinder {
  /**
   * Czy zapis z tą referencją wykonał się w kanale. Błąd odczytu = wyjątek, nie `found: false`. `found: false` wolno
   * zwrócić tylko jako DOWÓD (przewoźnik albo kanał jednoznacznie odpowiada, że zapisu nie ma, po zakończonym
   * przetwarzaniu): `executeWrite` zamienia go na PRZEJSCIOWY, a host ponawia zapis, więc przy przesyłce zgadywanie
   * = druga płatna paczka.
   */
  findByReference(reference: string): Promise<ReferenceLookup>
}

/** Numer nadania do zapisu w zamówieniu kanału. Bez danych odbiorcy. */
export interface TrackingInfo {
  number: string
  /** Przewoźnik Kompletora (enum Carrier) albo nazwa z kanału. */
  carrier: string
  url?: string | null
}

export interface TrackingWriter {
  /** Dopisuje numer nadania do zamówienia; ponowienie z tym samym numerem nie tworzy drugiego wpisu. */
  setTracking(orderExternalId: string, tracking: TrackingInfo, reference: string): Promise<WriteOutcome>
}

/** warunek zmiany statusu sprawdzany przez adapter na świeżym odczycie zamówienia z kanału. */
export interface StatusWriteGuard {
  /** Anulowanie nieopłaconego po terminie: kanał widzi płatność → TRWALY, status bez zmian (klient zdążył zapłacić). */
  onlyIfUnpaid?: boolean
}

export interface OrderStatusWriter {
  /** Ustawia status zamówienia na identyfikator statusu kanału. Mapowanie naszych statusów na kanał należy do hosta. */
  setOrderStatus(orderExternalId: string, channelStatus: string, reference: string, guard?: StatusWriteGuard): Promise<WriteOutcome>
}

/** Oferta kanału: sztuka sprzedażowa z SKU i stanem. Bez danych klientów. `qty` null = kanał nie prowadzi stanu. */
export interface ChannelOfferRow {
  externalId: string
  sku: string | null
  ean: string | null
  name: string | null
  qty: number | null
  active: boolean
  /** (opcjonalne): cena brutto i stawka VAT oferty, gdy kanał je podaje wprost; adresy zdjęć (https). */
  priceGross?: number | null
  vatRate?: string | null
  imageUrls?: string[]
}

export interface OfferPage {
  items: ChannelOfferRow[]
  nextCursor: string | null
}

export interface OfferReader {
  listOffers(cursor: string | null): Promise<OfferPage>
}

/** EAN jednej oferty, gdy lista ofert kanału go nie podaje (Allegro: szczegóły oferty, tylko GET). */
export interface OfferEan {
  ean: string | null
  /** Dlaczego bez EAN (do notatki oferty); null przy znalezionym. */
  powod: string | null
}

export interface OfferEanReader {
  getOfferEan(offerExternalId: string): Promise<OfferEan>
}

/** pozycja zwrotu klienta w kanale. Ilość w sztukach oferty (jak w zamówieniu kanału). */
export interface ChannelReturnLine {
  offerId: string
  qty: number
  /** Powód z kanału (np. Allegro `reason.type`); bez komentarza kupującego. */
  reasonType: string | null
}

/** zwrot klienta zgłoszony w kanale. Bez danych kupującego (login, e-mail, adres, numer konta). */
export interface ChannelReturn {
  externalId: string
  /** Numer zamówienia w kanale (jak `ChannelOrder.externalId`). */
  orderExternalId: string
  createdAt: Date | null
  status: string | null
  lines: ChannelReturnLine[]
}

export interface ReturnPage {
  items: ChannelReturn[]
  /** Zwroty, których nie dało się odczytać (bez id, bez zamówienia): pominięte, z krótkim opisem bez danych. */
  unreadable: string[]
  nextCursor: string | null
}

export interface ReturnReader {
  /** Zwroty utworzone od `from`; `cursor` = kolejna strona (nieprzezroczysty, null = pierwsza). Tylko odczyt. */
  listCustomerReturns(from: Date, cursor: string | null): Promise<ReturnPage>
}

// oferta, której nie da się odczytać (np. ilość „abc”), nie przerywa strony i nie staje się zerem: adapter
// pomija ją w `items` i podaje w `unreadable` (pole opcjonalne, adapter bez niego też spełnia kontrakt).
export interface OfferReadProblem {
  externalId: string
  message: string
}

export type OfferPageWithProblems = OfferPage & { unreadable?: OfferReadProblem[] }

// ─── Zdolność: przygotowanie przesyłki ───────────────────────────────────────

export interface ShipmentProblem {
  kod: string
  /** BLAD = przesyłki nie da się nadać, OSTRZEZENIE = do sprawdzenia przez człowieka. */
  poziom: 'BLAD' | 'OSTRZEZENIE'
  tekst: string
}

/** Dane zamówienia potrzebne do przesyłki. Bez odbiorcy: system nie przechowuje adresów klientów. */
/** BRAKI: otwarte braki przed pakowaniem; BRAKI_SPAKOWANE: paczka już spakowana bez nich; PODZIAL: kilka paczek; ODRZUCONE: pozycje odrzucone przy akceptacji. */
export type PowodNiepewnejKwoty = 'BRAKI' | 'BRAKI_SPAKOWANE' | 'PODZIAL' | 'ODRZUCONE'

export interface ShipmentInput {
  carrier: Carrier
  /** Nadpisanie kodu kuriera z konfiguracji reguły przewoźnika; brak = domyślny dla przewoźnika. */
  courierCode?: unknown
  gabaryt: string | null
  /** Znana waga w gramach; `weightComplete: false` = część pozycji jej nie ma. */
  weightG: number | null
  weightComplete: boolean
  paymentState: PaymentState
  paymentMethod: string
  totalGross: number | null
  /** Dlaczego totalGross nie jest kwotą do pobrania tej paczki; null = jest. */
  codAmountUncertain: PowodNiepewnejKwoty | null
  /** Zamówienie idzie w kilku paczkach (także gdy kwota paczki jest znana). Brak = jedna paczka. */
  wielePaczek?: boolean
  pickupPoint: string | null
  /**
   * waluta zamówienia (kod ISO); brak = nieznana. Przewoźnik pobierający tylko w PLN (GLS) zgłasza BLAD.
   * Host dziś jej nie podaje: zamówienie (`Order`) nie ma pola waluty, waluta jest tylko w migawce kanału.
   */
  currency?: string | null
}

export interface PreparedParcel {
  courierCode: string | null
  gabaryt: string | null
  sideXCm: number | null
  sideYCm: number | null
  sideZCm: number | null
  weightKg: number | null
  /** Kwota pobrania; null = bez pobrania albo kwota nieznana (wtedy problem z poziomem BLAD). */
  codAmount: number | null
  pickupPoint: string | null
  problems: ShipmentProblem[]
}

export interface ShipmentPreparer {
  /** Liczy przesyłkę bez efektów ubocznych: bez sieci, zapisu i danych odbiorcy. Braki trafiają do `problems`. */
  prepareShipment(input: ShipmentInput): PreparedParcel
}

// ─── Zdolność: odbiorca zamówienia na żądanie ────────────────────

/**
 * Kody problemów odbiorcy (bez wartości pól). `brak_<pole>` = kanał nie podał pola potrzebnego do przesyłki;
 * `adres_bez_podzialu` = kanał daje ulicę z numerem w jednej linii (całość w `ulica`, numer null — bez zgadywania);
 * `punkt_nieznany` = konto nie wie, gdzie kanał trzyma punkt odbioru; `adres_niedostepny_w_kanale` = kanał ukrywa
 * adres (Mirakl przed przyjęciem); `nip_klucz_nieustawiony` = konto Woo bez `nipMetaKey`; `brak_nip` = faktura na
 * firmę bez NIP; `nip_niedostepny_w_kanale` = kanał nie podaje NIP; `faktura_klucz_nieustawiony` = konto Woo bez
 * `invoiceMetaKey`, więc życzenia faktury osoby prywatnej nie widać (faktura tylko przy firmie albo NIP-ie).
 */
export type RecipientProblem =
  | 'adres_bez_podzialu'
  | 'punkt_nieznany'
  | 'adres_niedostepny_w_kanale'
  | 'nip_klucz_nieustawiony'
  | 'brak_nip'
  | 'nip_niedostepny_w_kanale'
  | 'faktura_klucz_nieustawiony'
  | `brak_${'imie_nazwisko' | 'ulica' | 'kod_pocztowy' | 'miasto' | 'kraj' | 'telefon' | 'email'}`

/** Adres dostawy. Brak w kanale = null (nigdy pusty string w zastępstwie). */
export interface RecipientAddress {
  imieNazwisko: string | null
  firma: string | null
  ulica: string | null
  /** Tylko gdy kanał podaje numer osobno; inaczej null i problem `adres_bez_podzialu`. */
  numerDomu: string | null
  numerLokalu: string | null
  kodPocztowy: string | null
  miasto: string | null
  /** Kod kraju ISO 3166-1 alpha-2, gdy kanał go podaje. */
  kraj: string | null
  telefon: string | null
  /** Jak w kanale (Allegro: adres maskowany, przekazywany bez zmian). */
  email: string | null
}

export interface RecipientPickupPoint {
  kod: string
  nazwa: string | null
  /** adres punktu, gdy kanał go podaje (Allegro `pickupPoint.address`). */
  adres?: { ulica: string | null; kodPocztowy: string | null; miasto: string | null } | null
}

export interface RecipientInvoice {
  nazwa: string | null
  nip: string | null
  ulica: string | null
  kodPocztowy: string | null
  miasto: string | null
  kraj: string | null
}

/**
 * Odbiorca zamówienia prosto z kanału. Dane osobowe: tylko w pamięci wywołującego, nigdy w bazie, alertach, kolejce
 * ani logach. `dostawa: null` = kanał nie podał adresu (problem mówi dlaczego).
 */
export interface OrderRecipient {
  dostawa: RecipientAddress | null
  punktOdbioru: RecipientPickupPoint | null
  faktura: RecipientInvoice | null
  problemy: RecipientProblem[]
  /** login kupującego w kanale (Allegro `buyer.login`), gdy kanał go podaje. */
  login?: string | null
  /** uwagi klienta do zamówienia (Allegro `messageToSeller`, Woo `customer_note`). */
  uwagi?: string | null
}

export interface RecipientReader {
  /**
   * Odbiorca zamówienia z API kanału, bez pamięci podręcznej. Brak zamówienia = AdapterError TRWALY; pole złego typu =
   * UnreadableDataError. Komunikaty błędów nigdy nie zawierają wartości pól.
   */
  getOrderRecipient(externalId: string): Promise<OrderRecipient>
}

/**
 * Tekst pola odbiorcy: brak, null i same spacje = null; liczba = tekst (telefon, kod); inny typ = UnreadableDataError
 * z nazwą pola, bez wartości.
 */
export function readRecipientText(v: unknown, what: string): string | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'string') return v.trim() ? v.trim() : null
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  throw new UnreadableDataError(`nieczytelne pole odbiorcy: ${what}`)
}

/** Obiekt z kanału albo null (brak); inny typ = UnreadableDataError z nazwą pola. */
export function readRecipientObject(v: unknown, what: string): Record<string, unknown> | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  throw new UnreadableDataError(`nieczytelne pole odbiorcy: ${what}`)
}

/** Imię i nazwisko z dwóch pól (każde może być puste); oba puste = null. */
export function joinName(...parts: (string | null)[]): string | null {
  const s = parts.filter((p): p is string => !!p).join(' ')
  return s || null
}

/** Problemy brakujących pól dostawy potrzebnych do przesyłki (kolejność stała). */
export function missingAddressProblems(d: RecipientAddress): RecipientProblem[] {
  const out: RecipientProblem[] = []
  if (!d.imieNazwisko && !d.firma) out.push('brak_imie_nazwisko')
  if (!d.ulica) out.push('brak_ulica')
  if (!d.kodPocztowy) out.push('brak_kod_pocztowy')
  if (!d.miasto) out.push('brak_miasto')
  if (!d.kraj) out.push('brak_kraj')
  if (!d.telefon) out.push('brak_telefon')
  if (!d.email) out.push('brak_email')
  return out
}

// ─── Zdolność: utworzenie przesyłki (/091) ──────────────────────────

export interface ShipmentCreateRequest {
  parcel: PreparedParcel
  /** Przewoźnik zamówienia (np. DPD_EMPIK = salon Empik), zamiast zgadywania po kodach ostrzeżeń. */
  carrier: Carrier
  /**
   * Adres dostawy z `getOrderRecipient`, tylko w pamięci, z kanału w chwili użycia; nigdy do bazy ani logu.
   * Każdy adapter sam sprawdza pola, których wymaga jego API, i kraj.
   */
  recipient: Readonly<RecipientAddress>
  /** Kody ostrzeżeń przesyłki świadomie przyjęte przez człowieka; każde inne ostrzeżenie blokuje utworzenie. */
  potwierdzoneOstrzezenia?: readonly string[]
  /**
   * id zamówienia w kanale (Wysyłam z Allegro bierze z niego propozycję dostawy: metodę, punkt, nadawcę).
   * Host podaje je zawsze; przewoźnik, który go nie potrzebuje, pomija pole.
   */
  orderExternalId?: string
  /**
   * true = ta referencja już szła do przewoźnika (ponowienie wiersza po błędzie, także po
   * „Sprawdź u przewoźnika” bez trafienia; ręczne „Nie powstała” daje nową referencję i ponowieniem nie jest), więc poprzednia próba mogła coś utworzyć. Brak/false = pierwsza próba z nową referencją. Adapter,
   * który przed zapisem szuka śladów poprzedniej próby (GLS), może kosztowny przegląd zrobić tylko przy ponowieniu.
   */
  ponowienie?: boolean
}

export type LabelFormat = 'PDF' | 'ZPL' | 'EPL'

/**
 * stan przesyłki u przewoźnika sprowadzony do tego, co obchodzi magazyn. PRZED_NADANIEM = paczka jeszcze
 * u nas (utworzona, czeka na kuriera); PRZEKAZANA = przewoźnik ma paczkę (odebrał kurier, nadana w punkcie, w drodze,
 * doręczona); NIEZNANY = status, którego adapter nie umie przypisać — host nic wtedy nie zmienia (po kilku dniach
 * samych odczytów NIEZNANY przestaje pytać); ANULOWANA = przewoźnik anulował przesyłkę albo jej nie ma, nie pojedzie: host
 * nie zmienia statusu zamówienia i kończy śledzenie tej przesyłki. DORECZONA (od 19.11.2026, Base Courier) = przewoźnik
 * potwierdził doręczenie: dla magazynu to samo co PRZEKAZANA (paczka pojechała), na osi wprost DORECZONA.
 */
export type StanPrzesylki = 'PRZED_NADANIEM' | 'PRZEKAZANA' | 'DORECZONA' | 'NIEZNANY' | 'ANULOWANA'

/**
 * Oś statusów przesyłki wspólna dla przewoźników: droga paczki od utworzenia etykiety do stanu końcowego. Słownik,
 * opisy, stany końcowe i odstępy odpytywania: lib/wysylka/stany-przesylki.ts. UTWORZONA = paczka u nas; PRZEKAZANA =
 * odebrana przez kuriera albo nadana w punkcie; W_DRODZE = sortownie i oddziały; W_DORECZENIU = wydana kurierowi do
 * doręczenia; W_PUNKCIE = czeka na odbiór w punkcie albo automacie; DORECZONA; NIEUDANE_DORECZENIE = awizo, brak
 * odbiorcy, odmowa, minął czas odbioru; ZWROT = wraca albo wróciła do nadawcy; PROBLEM = zaginięcie, reklamacja,
 * likwidacja; ANULOWANA = przewoźnik anulował albo przesyłki nie ma; NIEZNANY = kod bez przypisania.
 */
export type StanDrogi = 'UTWORZONA' | 'PRZEKAZANA' | 'W_DRODZE' | 'W_DORECZENIU' | 'W_PUNKCIE' | 'DORECZONA' | 'NIEUDANE_DORECZENIE' | 'ZWROT' | 'PROBLEM' | 'ANULOWANA' | 'NIEZNANY'

/**
 * Wynik odczytu śledzenia. `stan` (magazyn: czy paczka pojechała) zostaje bez zmian znaczenia; `stanDrogi` = miejsce na
 * osi (moduł, który go nie podaje, dostaje stan wyliczony ze `stan`); `czas` = czas ostatniego zdarzenia u przewoźnika
 * (ISO, ze strefą albo bez, wtedy czas polski), null gdy przewoźnik go nie podaje. `kod` = sam kod zdarzenia
 * przewoźnika, z którego wyliczono `stanDrogi` (bez opisu; może być inny niż ostatnie zdarzenie w `status`);
 * `przekazanaO` = czas pierwszego zdarzenia po przekazaniu przewoźnikowi (tylko moduły z listą zdarzeń: DPD, Allegro,
 * Poczta), host bierze go jako datę przekazania przed `czas`.
 */
export interface OdczytPrzesylki {
  stan: StanPrzesylki
  status: string | null
  stanDrogi?: StanDrogi
  czas?: string | null
  kod?: string | null
  przekazanaO?: string | null
  /** Opis statusu po ludzku od przewoźnika (oczyszczony, bez danych odbiorcy; Base Courier od 19.11.2026), do karty i API. */
  opis?: string | null
}

/**
 * Śledzenie: błąd konta, nie przesyłki (brak albo odrzucone dane logowania, wyłączony zapis, zła konfiguracja). Dotyczy
 * każdej przesyłki tego konta i minie po poprawie ustawień, więc host nie kończy śledzenia przesyłek: przerywa pytanie
 * tego konta w bieżącym przebiegu i zgłasza jedną linię błędu. `osobneDane` = usługa śledzenia ma własne dane logowania
 * (DPDInfoServices, Śledzenie Poczty Polskiej): jej odmowa nie liczy się do automatycznego wyłączenia konta nadawania.
 */
export class BladKontaSledzenia extends AdapterError {
  constructor(
    message: string,
    readonly osobneDane = false,
  ) {
    super(message, 'TRWALY')
    this.name = 'BladKontaSledzenia'
  }
}

/** Śledzenie: ta przesyłka nie istnieje u przewoźnika albo ma zły numer. Host kończy śledzenie tej jednej przesyłki. */
export class BladPrzesylkiSledzenia extends AdapterError {
  constructor(message: string) {
    super(message, 'TRWALY')
    this.name = 'BladPrzesylkiSledzenia'
  }
}

export interface ShipmentTracker {
  /**
   * Sam odczyt: stan przesyłki o `externalRef` (id przesyłki u przewoźnika). `status` = surowy kod przewoźnika do
   * historii (bez danych odbiorcy). Błąd sieci i 5xx = AdapterError PRZEJSCIOWY; błąd konta = `BladKontaSledzenia`;
   * przesyłki nie ma albo zły numer = `BladPrzesylkiSledzenia`; inna odmowa = TRWALY (host pyta znowu za pół godziny).
   */
  trackShipment(externalRef: string): Promise<OdczytPrzesylki>
}

export interface ShipmentCreator {
  /** Referencja to klucz idempotencji od hosta. Wynik jak przy zapisie stanu: OK / PRZEJSCIOWY / TRWALY / NIEJEDNOZNACZNY. */
  createShipment(req: ShipmentCreateRequest, reference: string): Promise<WriteOutcome>
  getLabel(externalRef: string, format: LabelFormat): Promise<{ contentType: string; base64: string }>
  /**
   * numer nadania (do śledzenia, kanału i maila), gdy przewoźnik daje go osobno od id przesyłki (ShipX: id
   * od razu, numer po chwili). null = jeszcze nie nadany. Brak metody = numer nadania to `externalRef` (DPD: numer listu).
   */
  getTrackingNumber?(externalRef: string): Promise<string | null>
  /**
   * anulowanie utworzonej przesyłki u przewoźnika (Wysyłam z Allegro: komenda anulowania). OK = przesyłka
   * anulowana albo już anulowana; ponowienie z tą samą referencją nie wysyła drugiej komendy. Brak metody = przewoźnik
   * nie anuluje z Kompletora (anulowanie w jego panelu).
   */
  cancelShipment?(externalRef: string, reference: string): Promise<WriteOutcome>
  /**
   * sprawdzenie numeru, który człowiek wpisał przy „Rozstrzygnij ręcznie” (przewoźnik bez odszukania po
   * referencji, np. Base Courier): czy ta przesyłka istnieje u przewoźnika i nosi referencję hosta. Wynik: identyfikator
   * do zapisu jako `externalRef` (np. numer listu → id zamówienia) albo odmowa z powodem dla ekranu (inna referencja,
   * brak przesyłki). Błąd odczytu = wyjątek (host nie zapisuje rozstrzygnięcia). Brak metody = numer przyjmowany wprost.
   * `referencjaSprawdzona: true` = moduł sam porównał przesyłkę z referencją hosta;
   * bez tego host porównuje wynik z odszukaniem po referencji (`findByReference`), gdy moduł je ma.
   */
  confirmManual?(identyfikator: string, reference: string): Promise<PotwierdzenieRecznego>
}

// ─── Zdolność: przygotowanie faktury ─────────────────────────────

export interface InvoiceProblem {
  kod: string
  /** Ścieżka pola (np. „Podmiot1.NIP”), bez wartości z danych. */
  pole?: string
  tekst: string
}

export interface PreparedInvoice {
  /** Treść dokumentu (np. XML FA(3)); null = są problemy, dokumentu nie wolno odłożyć ani wysłać. */
  xml: string | null
  schemaVersion: string
  sumy: { nettoGr: number; vatGr: number; bruttoGr: number }
  problems: InvoiceProblem[]
}

export interface InvoicePreparer<I = unknown> {
  /** Składa fakturę bez efektów ubocznych: bez sieci, zapisu i numeru z serii. Braki trafiają do `problems`. */
  prepareInvoice(input: I): PreparedInvoice
}

// ─── Zdolności: akceptacja zamówienia i numer nadania ───────────

/** Decyzja o jednej pozycji zamówienia czekającego na przyjęcie (pozycja = ChannelOrderLine.externalLineId). */
export interface OrderAcceptDecision {
  externalLineId: string
  accepted: boolean
}

/** Początek `externalRef` wyniku OK, gdy kanał miał już decyzję (nasza z poprzedniej próby albo podjęta poza Kompletorem); po dwukropku stan zamówienia w kanale, np. `JUZ_ROZSTRZYGNIETE:CANCELED`. */
export const ACCEPT_ALREADY_DECIDED = 'JUZ_ROZSTRZYGNIETE'

export interface OrderAcceptor {
  /**
   * Decyzja dla WSZYSTKICH pozycji zamówienia (kanał odrzuca decyzję niepełną). Ponowienie jest bezpieczne: zamówienie
   * już rozstrzygnięte = OK z `externalRef: "${ACCEPT_ALREADY_DECIDED}:<stan kanału>"` (stan pozycji ustala następny odczyt dziennika).
   */
  acceptOrder(orderExternalId: string, decisions: readonly OrderAcceptDecision[], reference: string): Promise<WriteOutcome>
}

// ─── Zdolności dostawcy dokumentów sprzedaży ─────────────────────
// Adapter programu do faktur (np. `fakturownia.v1`) implementuje te metody; host owija go w DostawcaDokumentow
// (lib/dokumenty/z-adaptera.ts). Kontrakt wyników jak przy zapisie stanu i kolejce wFirmy.

export interface InvoiceIssueRequest {
  /** Klucz idempotencji hosta (np. `<orderId>/<paczka>/<próba>`), program zapisuje go przy dokumencie. */
  reference: string
  /**
   * `qty` w jednostce bazowej produktu (sztuka, gram), `unitGrossGr` za tę jednostkę: `qty × unitGrossGr` = wartość pozycji.
   * NIE GOTOWE dla programu do faktur: towar na wagę daje linie w gramach z ceną 0 gr albo dwie
   * linie jednego towaru (1000 g za 9,00 zł → 100 × 0 gr + 900 × 1 gr). Przed podłączeniem drugiego programu przez
   * `wystaw` kontrakt ma nieść wartość linii i jednostkę dokumentu albo dostawca bierze linie z `zlozPozycjeDokumentu`.
   */
  lines: readonly { productId: string; qty: number; unitGrossGr: number; vatRate: string; service?: true; name?: string }[]
  paymentMethod: string
  kind?: 'faktura' | 'paragon'
}

export type InvoiceIssueResult =
  | { kind: 'OK'; docId: string; number?: string | null }
  | { kind: 'ERROR'; message: string }
  | { kind: 'TIMEOUT' }
  | { kind: 'LIMIT'; message: string; retryAfterMs?: number }

export interface InvoiceIssuer {
  issueInvoice(req: InvoiceIssueRequest): Promise<InvoiceIssueResult>
}

export interface InvoiceFinder {
  findInvoices(referencePrefix: string): Promise<{ docId: string; reference: string; number?: string | null }[]>
}

export interface InvoiceCorrector {
  correctInvoice(req: { reference: string; docId: string; lines: readonly { productId: string; qty: number }[] }): Promise<InvoiceIssueResult>
}

export interface InvoicePdfReader {
  getInvoicePdf(docId: string): Promise<{ contentType: string; base64: string }>
}

// ─── Strażniki typu ──────────────────────────────────────────────────────────

const declares = (a: ChannelAdapter, c: Capability) => a.manifest.capabilities.includes(c)

export function hasOrderFeed(a: ChannelAdapter): a is ChannelAdapter & OrderFeed {
  const x = a as Partial<OrderFeed>
  return declares(a, 'orders.feed') && typeof x.listOrderChanges === 'function' && typeof x.getOrder === 'function'
}

export function hasStockWriter(a: ChannelAdapter): a is ChannelAdapter & StockWriter {
  return declares(a, 'stock.write') && !a.manifest.readOnly && typeof (a as Partial<StockWriter>).pushStock === 'function'
}

export function hasStockImportStatus(a: ChannelAdapter): a is ChannelAdapter & StockImportStatusReader {
  return declares(a, 'stock.import.status') && typeof (a as Partial<StockImportStatusReader>).getStockImportStatus === 'function'
}

export function hasReferenceFinder(a: ChannelAdapter): a is ChannelAdapter & ReferenceFinder {
  return declares(a, 'reference.find') && typeof (a as Partial<ReferenceFinder>).findByReference === 'function'
}

export function hasOrderStatusWriter(a: ChannelAdapter): a is ChannelAdapter & OrderStatusWriter {
  return declares(a, 'order.status.write') && !a.manifest.readOnly && typeof (a as Partial<OrderStatusWriter>).setOrderStatus === 'function'
}

export function hasTrackingWriter(a: ChannelAdapter): a is ChannelAdapter & TrackingWriter {
  return declares(a, 'order.tracking.write') && !a.manifest.readOnly && typeof (a as Partial<TrackingWriter>).setTracking === 'function'
}

export function hasReturnReader(a: ChannelAdapter): a is ChannelAdapter & ReturnReader {
  return declares(a, 'returns.read') && typeof (a as Partial<ReturnReader>).listCustomerReturns === 'function'
}

export function hasOfferReader(a: ChannelAdapter): a is ChannelAdapter & OfferReader {
  return declares(a, 'offers.read') && typeof (a as Partial<OfferReader>).listOffers === 'function'
}

/** adapter umie dociągnąć EAN jednej oferty (ta sama zdolność odczytu ofert, tylko GET). */
export function hasOfferEanReader(a: ChannelAdapter): a is ChannelAdapter & OfferEanReader {
  return declares(a, 'offers.read') && typeof (a as Partial<OfferEanReader>).getOfferEan === 'function'
}

export function hasShipmentPreparer(a: ChannelAdapter): a is ChannelAdapter & ShipmentPreparer {
  return declares(a, 'shipment.prepare') && typeof (a as Partial<ShipmentPreparer>).prepareShipment === 'function'
}

export function hasRecipientReader(a: ChannelAdapter): a is ChannelAdapter & RecipientReader {
  return declares(a, 'orders.recipient') && typeof (a as Partial<RecipientReader>).getOrderRecipient === 'function'
}

export function hasShipmentCreator(a: ChannelAdapter): a is ChannelAdapter & ShipmentCreator {
  const x = a as Partial<ShipmentCreator>
  return declares(a, 'shipment.create') && !a.manifest.readOnly && typeof x.createShipment === 'function' && typeof x.getLabel === 'function'
}

/** przewoźnik anuluje utworzoną przesyłkę z Kompletora (deklaracja w manifeście i metoda). */
export function hasShipmentCanceller(a: ChannelAdapter): a is ChannelAdapter & ShipmentCreator & Required<Pick<ShipmentCreator, 'cancelShipment'>> {
  return hasShipmentCreator(a) && declares(a, 'shipment.cancel') && typeof a.cancelShipment === 'function'
}

/** przewoźnik podaje stan przesyłki od ręki (deklaracja w manifeście i metoda). Wzór: `hasShipmentCanceller`. */
export function hasShipmentTracker(a: ChannelAdapter): a is ChannelAdapter & ShipmentTracker {
  return declares(a, 'shipment.track') && typeof (a as Partial<ShipmentTracker>).trackShipment === 'function'
}

export function hasInvoicePreparer(a: ChannelAdapter): a is ChannelAdapter & InvoicePreparer {
  return declares(a, 'invoice.prepare') && typeof (a as Partial<InvoicePreparer>).prepareInvoice === 'function'
}

export function hasOrderAcceptor(a: ChannelAdapter): a is ChannelAdapter & OrderAcceptor {
  return declares(a, 'order.accept') && !a.manifest.readOnly && typeof (a as Partial<OrderAcceptor>).acceptOrder === 'function'
}

export function hasInvoiceIssuer(a: ChannelAdapter): a is ChannelAdapter & InvoiceIssuer {
  return declares(a, 'invoice.issue') && !a.manifest.readOnly && typeof (a as Partial<InvoiceIssuer>).issueInvoice === 'function'
}

export function hasInvoiceFinder(a: ChannelAdapter): a is ChannelAdapter & InvoiceFinder {
  return declares(a, 'invoice.find') && typeof (a as Partial<InvoiceFinder>).findInvoices === 'function'
}

export function hasInvoiceCorrector(a: ChannelAdapter): a is ChannelAdapter & InvoiceCorrector {
  return declares(a, 'invoice.correct') && !a.manifest.readOnly && typeof (a as Partial<InvoiceCorrector>).correctInvoice === 'function'
}

export function hasInvoicePdfReader(a: ChannelAdapter): a is ChannelAdapter & InvoicePdfReader {
  return declares(a, 'invoice.pdf') && typeof (a as Partial<InvoicePdfReader>).getInvoicePdf === 'function'
}

// ─── Definicja adaptera (wpis w rejestrze) ───────────────────────────────────

export interface AdapterDefinition {
  manifest: AdapterManifest
  create(ctx: AdapterContext): ChannelAdapter
}

/** opis pozycji bez pustych pól (adapter dokleja go do ChannelOrderLine). */
export function opisLinii(name: string | null, sku: string | null, ean: string | null): Pick<ChannelOrderLine, 'name' | 'sku' | 'ean'> {
  return { ...(name ? { name } : {}), ...(sku ? { sku } : {}), ...(ean ? { ean } : {}) }
}

/** stan kanału z `externalRef` „już rozstrzygnięte” (`JUZ_ROZSTRZYGNIETE:<stan>`); null = to nie ten wynik. */
export function alreadyDecidedState(externalRef: string | undefined): string | null {
  if (!externalRef || !(externalRef === ACCEPT_ALREADY_DECIDED || externalRef.startsWith(`${ACCEPT_ALREADY_DECIDED}:`))) return null
  return externalRef.slice(ACCEPT_ALREADY_DECIDED.length + 1) || '?'
}
