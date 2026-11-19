// Adapter przewoźnika `basecourier.zapis.v1`: to samo co `basecourier.v1` (liczenie przesyłki,
// test połączenia) plus zamówienie przesyłki InPost/DPD przez Base Courier, etykieta PDF, numer listu i anulowanie, ZA
// WYŁĄCZNIKIEM. Przesyłka powstaje tylko przy trzech warunkach naraz: (1) reguła przewoźnika firmy wskazuje ten klucz,
// (2) jej konfiguracja ma `zapisWlaczony: true`, (3) woła host przesyłek (lib/wysylka/nadanie.ts) ze swoimi bramkami
// (konto w PRACA, rezerwacja wiersza przed wywołaniem). Bez wyłącznika klient zapisu nie powstaje, więc żadne
// żądanie nie wychodzi.
//
// Odszukania po referencji NIE deklarujemy (`reference.find`): API Base Courier nie ma klucza idempotencji ani
// wyszukiwania po referencji, więc „nie znaleziono” byłoby zgadywaniem, a ponowienie po nim = druga płatna przesyłka. Referencja
// hosta idzie w pole „Zawartość przesyłki”; zgubiona odpowiedź zostaje NIEJEDNOZNACZNA, a „Rozstrzygnij ręcznie”
// sprawdza wpisany numer w Base Courier (`confirmManual`: istnieje i ma tę referencję), zanim host zapisze przesyłkę.
//
// Dane odbiorcy są tylko w argumencie `createShipment`, w pamięci; wynik i błędy ich nie mają.
import { BaseCourierZapis, BASE_COURIER_ID_RE, NUMER_LISTU_RE, type PrinterType, type PrzesylkaBaseCourier, type StatusBaseCourier } from '../zrodla/basecourier-zapis'
import { parseNadawca } from '../wysylka/zlecenie-dpd'
import { buildCreateOrderPayload, kontoPobranPoprawne, parseUbezpieczenie, rozdzielAdres, zRozdzielonymAdresem, zawartoscMaReferencje, zawartoscPrzesylki, type NadawcaBaseCourier, type OdbiorcaPrzesylki, type PlatnoscBaseCourier } from '../wysylka/zlecenie'
import { BASE_COURIER_DEFINITION, BASE_COURIER_MANIFEST } from './basecourier'
import {
  AdapterError,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type ChannelAdapter,
  type ConnectionTest,
  type LabelFormat,
  type PotwierdzenieRecznego,
  type PreparedParcel,
  type RecipientAddress,
  type ShipmentCreateRequest,
  type ShipmentCreator,
  type ShipmentInput,
  type ShipmentPreparer,
  type ShipmentTracker,
  type StanPrzesylki,
  type WriteOutcome,
} from './kontrakt'

export const BASE_COURIER_ZAPIS_KEY = 'basecourier.zapis.v1'

export const BASE_COURIER_ZAPIS_MANIFEST: AdapterManifest = {
  ...BASE_COURIER_MANIFEST,
  adapterKey: BASE_COURIER_ZAPIS_KEY,
  version: '1.0.0',
  displayName: 'Base Courier z tworzeniem przesyłek (InPost, DPD; za wyłącznikiem)',
  // bez `reference.find`: API nie umie odszukać przesyłki po referencji (patrz nagłówek)
  capabilities: ['shipment.prepare', 'shipment.create', 'shipment.cancel', 'shipment.track'],
  // stanBaseCourier zwraca DORECZONA (kod 5 albo flaga doręczenia)
  trackReportsDelivered: true,
  config: [
    ...BASE_COURIER_MANIFEST.config,
    { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'wyłącznik: tak = Kompletor zamawia przesyłki w Base Courier (płatne) i pobiera etykiety; brak = nie' },
    { key: 'nadawca', type: 'string', required: false, description: 'JSON z Organization.settings.nadawca (wstawia host przy tworzeniu adaptera)' },
    { key: 'kontoPobran', type: 'string', required: false, description: 'rachunek firmy na zwrot pobrań (26 cyfr); bez niego przesyłki z pobraniem nie powstają', pattern: /^(PL)?[\d ]{26,40}$/i },
    {
      key: 'platnosc',
      type: 'string',
      required: false,
      description: 'płatność za przesyłki w Base Courier',
      options: [
        { value: 'bank', label: 'Skarbonka (saldo przedpłacone)' },
        { value: 'pay_later', label: 'Płatność odroczona' },
      ],
    },
    {
      key: 'ubezpieczenie',
      type: 'string',
      required: false,
      description: 'ubezpieczenie przesyłki (może podnieść cenę): puste = bez, „pobranie” = na kwotę pobrania, liczba = kwota w zł',
      pattern: /^(pobranie|\d+([.,]\d{1,2})?)?$/i,
    },
    { key: 'zamawiajPodjazd', type: 'boolean', required: false, description: 'tak = zamawiaj podjazd kuriera przy każdej przesyłce; brak = bez podjazdu (paczkomat, stały odbiór)' },
    {
      key: 'rozmiarEtykiety',
      type: 'string',
      required: false,
      description: 'rozmiar etykiety PDF',
      options: [
        { value: 'A6', label: 'A6 (drukarka etykiet)' },
        { value: 'A4', label: 'A4 (kartka)' },
      ],
    },
  ],
  readOnly: false,
}

const WYLACZONY = 'zapis wyłączony'

/** Pola odbiorcy wymagane przez Base Courier; brak = błąd z nazwą pola, nigdy z wartością. */
const POLA_ODBIORCY = ['imieNazwisko', 'ulica', 'numerDomu', 'kodPocztowy', 'miasto', 'telefon', 'email'] as const

const tekst = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Odbiorca z kontraktu (pola nullowalne). Moduł krajowy: kraj inny niż PL = błąd `kraj` (jak InPost i DPD). */
function odbiorca(r0: Readonly<RecipientAddress>): OdbiorcaPrzesylki | { brak: string[] } {
  const kraj = tekst(r0.kraj)
  const r = zRozdzielonymAdresem(r0)
  if (kraj && kraj.toUpperCase() !== 'PL') return { brak: ['kraj'] }
  const brak = POLA_ODBIORCY.filter((k) => !tekst(r[k]))
  if (brak.length) return { brak: [...brak] }
  return { imieNazwisko: tekst(r.imieNazwisko)!, firma: tekst(r.firma), ulica: tekst(r.ulica)!, numerDomu: tekst(r.numerDomu)!, numerLokalu: tekst(r.numerLokalu), kodPocztowy: tekst(r.kodPocztowy)!, miasto: tekst(r.miasto)!, telefon: tekst(r.telefon)!, email: tekst(r.email)! }
}

/** Nadawca z `config.nadawca` (JSON od hosta): profil firmy z ulicą i numerem osobno. */
function nadawca(c: Readonly<Record<string, unknown>>): NadawcaBaseCourier | { braki: string[] } {
  let surowy: unknown = null
  try {
    surowy = typeof c['nadawca'] === 'string' ? (JSON.parse(c['nadawca']) as unknown) : null
  } catch {
    return { braki: ['nadawca'] }
  }
  const n = parseNadawca({ nadawca: surowy as never })
  if (!n.nadawca) return { braki: n.braki }
  const a = rozdzielAdres(n.nadawca.address)
  if (!a) return { braki: ['numer domu w adresie'] }
  return { nazwa: n.nadawca.name, ulica: a.ulica, numerDomu: a.numerDomu, numerLokalu: a.numerLokalu, kodPocztowy: n.nadawca.postalCode, miasto: n.nadawca.city, telefon: n.nadawca.phone, email: n.nadawca.email }
}

/** Przesyłka do punktu bez punktu, salon Empik bez punktu: błąd przed wysyłką (adapter nie zgaduje). */
function punktProblem(req: ShipmentCreateRequest): string | null {
  if ((req.carrier === 'PACZKOMATY' || req.carrier === 'DPD_EMPIK') && !req.parcel.pickupPoint) return 'brak punktu odbioru (paczkomat albo salon Empik)'
  if (req.carrier === 'PACZKOMATY' && !/^paczkomaty/.test(req.parcel.courierCode ?? '')) return 'paczkomat wymaga kodu kuriera paczkomaty'
  if ((req.carrier === 'DPD' || req.carrier === 'DPD_EMPIK') && req.parcel.courierCode !== 'dpd') return 'przesyłka DPD wymaga kodu kuriera dpd'
  return null
}

/**
 * Kody wspólne Base Courier (`bl_status_mapped`) oznaczające paczkę u przewoźnika: 2 odebrana od nadawcy, 3 niedoręczona,
 * 4 w doręczeniu, 5 doręczona, 7 awizo, 8 czeka w punkcie, 11 w drodze (2 i 11 potwierdzone odczytem 19.11.2026).
 * 1 = etykieta utworzona. Pozostałe (0 nieznany, 6 zwrot, 9 zagubiona, 10 anulowana) host zostawia bez zmian.
 */
const BC_PRZEKAZANA = new Set([2, 3, 4, 5, 7, 8, 11])

export function stanBaseCourier(historia: readonly StatusBaseCourier[]): { stan: StanPrzesylki; status: string | null; opis: string | null } {
  const ost = { status: historia[0]?.status ?? null, opis: historia[0]?.opis ?? null }
  if (historia.some((h) => h.doreczona || h.kod === 5)) return { stan: 'DORECZONA', ...ost }
  if (historia.some((h) => h.kod !== null && BC_PRZEKAZANA.has(h.kod))) return { stan: 'PRZEKAZANA', ...ost }
  if (!historia.length || historia.every((h) => h.kod === 1)) return { stan: 'PRZED_NADANIEM', ...ost }
  return { stan: 'NIEZNANY', ...ost }
}

class BaseCourierZapisAdapter implements ChannelAdapter, ShipmentPreparer, ShipmentCreator, ShipmentTracker {
  readonly manifest = BASE_COURIER_ZAPIS_MANIFEST
  private readonly odczyt: ChannelAdapter & ShipmentPreparer
  private readonly config: Readonly<Record<string, unknown>>
  /** null = wyłącznik nie jest włączony: nie ma czym wysłać żądania zapisu. */
  private readonly zapis: BaseCourierZapis | null
  /** Numer listu z odpowiedzi utworzenia (ta sama instancja woła zaraz `getTrackingNumber`): bez drugiego żądania. */
  private readonly numery = new Map<string, string>()

  constructor(ctx: AdapterContext) {
    this.odczyt = BASE_COURIER_DEFINITION.create(ctx) as ChannelAdapter & ShipmentPreparer
    this.config = ctx.config
    this.zapis =
      ctx.config['zapisWlaczony'] === true
        ? new BaseCourierZapis({ baseUrl: String(ctx.config['baseUrl']), login: ctx.secrets['BASE_COURIER_LOGIN']!, apiKey: ctx.secrets['BASE_COURIER_API_KEY']!, wylacznik: true, fetchImpl: ctx.fetch })
        : null
  }

  testConnection(): Promise<ConnectionTest> {
    return this.odczyt.testConnection()
  }

  prepareShipment(input: ShipmentInput): PreparedParcel {
    return this.odczyt.prepareShipment(input)
  }

  private zapamietaj(p: PrzesylkaBaseCourier | null): void {
    if (p?.numer) this.numery.set(p.id, p.numer)
  }

  /**
   * Ostrzeżenia przesyłki (wartości robocze) przechodzą tylko potwierdzone przez człowieka; braki odbiorcy, nadawcy,
   * punktu i rachunku pobrań = TRWALY bez żądania. Pobranie (`uptake`) to kwota policzona przez host z zamówienia.
   */
  async createShipment(req: ShipmentCreateRequest, reference: string): Promise<WriteOutcome> {
    if (!this.zapis) return { kind: 'TRWALY', reference, message: WYLACZONY }
    const r = odbiorca(req.recipient)
    if ('brak' in r) return { kind: 'TRWALY', reference, message: r.brak.includes('kraj') ? 'odbiorca spoza Polski: moduł Base Courier w Kompletorze jest krajowy (kraj)' : `brak danych odbiorcy: ${r.brak.join(', ')}` }
    const n = nadawca(this.config)
    if ('braki' in n) return { kind: 'TRWALY', reference, message: `brak danych nadawcy firmy (Ustawienia → Dokumenty i faktury → Dane firmy): ${n.braki.join(', ')}` }
    const pp = punktProblem(req)
    if (pp) return { kind: 'TRWALY', reference, message: pp }
    const platnosc: PlatnoscBaseCourier = this.config['platnosc'] === 'pay_later' ? 'pay_later' : 'bank'
    let payload: Record<string, unknown>
    try {
      payload = buildCreateOrderPayload(req.parcel, r, req.potwierdzoneOstrzezenia ?? [], {
        nadawca: n,
        zawartosc: zawartoscPrzesylki(reference, req.orderExternalId),
        kontoPobran: tekst(this.config['kontoPobran']),
        platnosc,
        bezPodjazdu: this.config['zamawiajPodjazd'] !== true,
        ubezpieczenie: parseUbezpieczenie(this.config['ubezpieczenie']),
      })
    } catch (e) {
      return { kind: 'TRWALY', reference, message: e instanceof Error ? e.message : String(e) }
    }
    const konto = kontoPobranPoprawne(tekst(this.config['kontoPobran']))
    const wrazliwe = [r.imieNazwisko, r.firma, r.ulica, r.kodPocztowy, r.miasto, r.telefon, r.email, n.nazwa, n.ulica, n.telefon, n.email, konto].filter((x): x is string => !!x)
    const w = await this.zapis.createOrder(payload, reference, wrazliwe)
    this.zapamietaj(w.przesylka)
    return w.wynik
  }

  /** Etykieta PDF (Kompletor bierze z Base Courier tylko PDF: przy ZPL host zapisze PDF); rozmiar z `rozmiarEtykiety`, domyślnie A6. */
  async getLabel(externalRef: string, _format: LabelFormat): Promise<{ contentType: string; base64: string }> {
    if (!this.zapis) throw new AdapterError(WYLACZONY, 'TRWALY')
    const rozmiar: PrinterType = this.config['rozmiarEtykiety'] === 'A4' ? 'A4' : 'LBL'
    return this.zapis.waybill(externalRef, rozmiar)
  }

  /**
   * Numer listu przewozowego zamówienia Base Courier; null = jeszcze nienadany. Szczegóły (`getOrderDetails`) paczek
   * InPost mają pusty `waybill_no`, choć lista zamówień ma numer: wtedy numer z listy (`getOrders`, ostatnie strony).
   * Zamówienia z istniejącymi szczegółami nie ma na tych stronach = błąd z opisem (nie „jeszcze nienadany”).
   */
  async getTrackingNumber(externalRef: string): Promise<string | null> {
    if (!this.zapis) throw new AdapterError(WYLACZONY, 'TRWALY')
    const z = this.numery.get(externalRef)
    if (z) return z
    const d = await this.zapis.details(externalRef)
    if (!d) throw new AdapterError('Base Courier getOrderDetails.json: brak zamówienia o tym numerze', 'TRWALY')
    this.zapamietaj(d)
    if (d.numer) return d.numer
    const n = await this.zapis.numerZListy(d.id)
    if (n === undefined) throw new AdapterError(`Base Courier getOrders.json: zamówienia ${d.id} nie ma wśród ostatnich na liście; numer listu sprawdź w panelu Base Courier`, 'TRWALY')
    this.zapamietaj({ ...d, numer: n })
    return n
  }

  /** Stan przesyłki w Base Courier (sam odczyt historii statusów). */
  async trackShipment(externalRef: string): Promise<{ stan: StanPrzesylki; status: string | null; opis: string | null }> {
    if (!this.zapis) throw new AdapterError(WYLACZONY, 'TRWALY')
    return stanBaseCourier(await this.zapis.tracking(externalRef))
  }

  async cancelShipment(externalRef: string, reference: string): Promise<WriteOutcome> {
    if (!this.zapis) return { kind: 'TRWALY', reference, message: WYLACZONY }
    return this.zapis.cancel(externalRef, reference)
  }

  /**
   * „Rozstrzygnij ręcznie”: numer z panelu Base Courier (numer zamówienia = same cyfry, do 12; inaczej numer listu;
   * same cyfry nieznane jako zamówienie próbujemy jeszcze jako numer listu). Zamówienie musi
   * istnieć, a jego „Zawartość przesyłki” zawierać referencję hosta (pełną albo początek UUID, gdy API obcięło pole).
   * Bez „Zawartości” w odpowiedzi sprawdzone jest tylko istnienie: wynik ma wtedy `info`. Wynik: id
   * zamówienia Base Courier (externalRef do etykiety i anulowania).
   */
  async confirmManual(identyfikator: string, reference: string): Promise<PotwierdzenieRecznego> {
    if (!this.zapis) throw new AdapterError(WYLACZONY, 'TRWALY')
    const zapis = this.zapis
    const id = identyfikator.trim()
    const poId = BASE_COURIER_ID_RE.test(id) && id.length <= 12
    const poNumerze = NUMER_LISTU_RE.test(id)
    if (!poId && !poNumerze) return { odmowa: 'Podaj numer zamówienia z panelu Base Courier albo numer listu przewozowego (litery i cyfry, bez spacji).' }
    const odmowaLogowania = (e: unknown) => e instanceof AdapterError && e.kind === 'TRWALY' && e.message.includes('odmowa logowania')
    const szukaj = async (jak: 'id' | 'list'): Promise<PrzesylkaBaseCourier | null | 'odmowa'> => {
      try {
        return jak === 'id' ? await zapis.details(id) : await zapis.detailsByWaybill(id)
      } catch (e) {
        // odmowa Base Courier (np. „nie znaleziono”) = numer do poprawy; logowanie i sieć/5xx = wyjątek (host pokazuje)
        if (e instanceof AdapterError && e.kind === 'TRWALY' && !odmowaLogowania(e)) return 'odmowa'
        throw e
      }
    }
    let p = await szukaj(poId ? 'id' : 'list')
    if ((p === 'odmowa' || p === null) && poId && poNumerze) p = await szukaj('list')
    if (p === 'odmowa') return { odmowa: `Base Courier nie potwierdził przesyłki o numerze ${id}: sprawdź numer w panelu Base Courier.` }
    if (!p) return { odmowa: `Base Courier nie zna przesyłki o numerze ${id}: sprawdź numer w panelu Base Courier.` }
    if (p.zawartosc !== undefined && !zawartoscMaReferencje(p.zawartosc, reference))
      return { odmowa: `Przesyłka ${id} w Base Courier ma inną referencję w polu „Zawartość przesyłki”: to nie jest przesyłka tego zamówienia.` }
    this.zapamietaj(p)
    if (p.zawartosc === undefined) return { externalRef: p.id, info: 'Base Courier nie zwrócił „Zawartości przesyłki”: sprawdzono tylko, że przesyłka o tym numerze istnieje.' }
    return { externalRef: p.id, referencjaSprawdzona: true }
  }
}

export const BASE_COURIER_ZAPIS_DEFINITION: AdapterDefinition = { manifest: BASE_COURIER_ZAPIS_MANIFEST, create: (ctx) => new BaseCourierZapisAdapter(ctx) }
