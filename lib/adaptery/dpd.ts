// Adaptery przewoźnika DPD Polska bezpośrednio (DPDServices REST) w trybie „przygotuj, nie wysyłaj”:
//   `dpd.services.v1` — domyślny, tylko do odczytu: liczy parametry przesyłki (lib/wysylka/dpd.ts) i sprawdza
//     połączenie zapytaniem o kod pocztowy. Klient HTTP (lib/zrodla/dpd.ts) odmawia `generate*` i zamawiania kuriera.
//   `dpd.services.zapis.v1` — numery listów i etykieta za wyłącznikiem. Trzy niezależne warunki, wszystkie wymagane:
//     firma ma ten klucz w regule przewoźnika, ma `zapisWlaczony: true` w konfiguracji i host wywoła zapis (dziś nikt
//     nie woła `createShipment`: pilnuje test). Bez `zapisWlaczony` żadne żądanie zapisu nie wychodzi.
// Dane odbiorcy wchodzą tylko w `createShipment` (w pamięci) i nigdzie nie są zapisywane. Nadawca to dane firmy.
import { DPD_URL_RE, DpdHttpError, DpdReadOnly, type DpdLogowanie } from '../zrodla/dpd'
import { DPD_SCIEZKA_ETYKIETY, DPD_SCIEZKA_NUMERY, DpdZapis } from '../zrodla/dpd-zapis'
import { ustawieniaDpd, wyliczPrzesylkeDpd, type UstawieniaDpd } from '../wysylka/dpd'
import { DPD_PICKUP } from '../wysylka/dpd'
import { buildPackagesPayload, czyEmpik, odbiorcaDpd, parseNadawca } from '../wysylka/zlecenie-dpd'
import {
  AdapterError,
  BladKontaSledzenia,
  BladPrzesylkiSledzenia,
  type AccountConfig,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type ChannelAdapter,
  type ConfigField,
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
  type ShipmentTracker,
  type OdczytPrzesylki,
  type StanDrogi,
  type StanPrzesylki,
  type WriteOutcome,
} from './kontrakt'
import { DPD_INFO_URL_RE, DpdInfoError, DpdSledzenie, type ZdarzenieDpd } from '../zrodla/dpd-sledzenie'

export const DPD_KEY = 'dpd.services.v1'
export const DPD_ZAPIS_KEY = 'dpd.services.zapis.v1'

const FID_RE = /^\d{1,10}$/

const CONFIG: readonly ConfigField[] = [
  { key: 'baseUrl', type: 'string', required: true, description: 'adres API: https://dpdservices.dpd.com.pl albo demo https://dpdservicesdemo.dpd.com.pl', pattern: DPD_URL_RE, envSuffix: 'BASE_URL' },
  { key: 'envPrefix', type: 'string', required: false, description: 'self-host: przedrostek zmiennych env (np. DPD)', pattern: /^[A-Z][A-Z0-9_]{0,40}$/ },
  { key: 'masterFid', type: 'string', required: false, description: 'FID konta głównego do nagłówka x-dpd-fid; brak = payerFid', pattern: FID_RE, envSuffix: 'MASTER_FID' },
  { key: 'payerFid', type: 'string', required: true, description: 'FID płatnika przesyłek (numer klienta DPD z umowy)', pattern: FID_RE, envSuffix: 'PAYER_FID' },
  { key: 'empikPayerFid', type: 'string', required: false, description: 'FID płatnika dla dostaw do salonu Empik, gdy inny; brak = payerFid', pattern: FID_RE },
  { key: 'labelFormat', type: 'string', required: false, description: 'format strony etykiety: LBL_PRINTER (domyślnie) albo A4', pattern: /^(A4|LBL_PRINTER)$/ },
  { key: 'defaultSideXCm', type: 'number', required: false, description: 'domyślna długość paczki DPD w cm (1–300)' },
  { key: 'defaultSideYCm', type: 'number', required: false, description: 'domyślna szerokość paczki DPD w cm (1–300)' },
  { key: 'defaultSideZCm', type: 'number', required: false, description: 'domyślna wysokość paczki DPD w cm (1–300)' },
  { key: 'defaultWeightKg', type: 'number', required: false, description: 'waga paczki w kg, gdy produkty nie mają wagi' },
  { key: 'limitWagiKuriera', type: 'number', required: false, description: 'limit wagi paczki kurierskiej z umowy w kg (domyślnie 31,5)' },
  { key: 'codLimit', type: 'number', required: false, description: 'limit pobrania w zł (domyślnie 15 000)' },
]

const SECRETS: AdapterManifest['secrets'] = [
  { name: 'DPD_LOGIN', required: true, description: 'login API DPDServices (inny niż do aplikacji kurierskiej i inny niż FID)', envSuffix: 'LOGIN' },
  { name: 'DPD_PASSWORD', required: true, description: 'hasło API DPDServices', envSuffix: 'PASSWORD' },
  // Zadeklarowany na przyszłe sprawdzanie punktów; dziś żaden kod go nie używa (docs/integracje/dpd.md)
  { name: 'DPD_MYPUDO_KEY', required: false, description: 'klucz MyPudo API (punkty DPD Pickup), gdy firma go dostała; dziś nieużywany', envSuffix: 'MYPUDO_KEY' },
]

// Limitów API nie ma w specyfikacji: ostrożnie, adapter odczytu woła tylko test połączenia.
const RATE = { requestsPerMinute: 30, maxConcurrent: 1, minPollIntervalMs: 0 }

export const DPD_MANIFEST: AdapterManifest = {
  adapterKey: DPD_KEY,
  version: '1.0.0',
  displayName: 'DPD Polska (bezpośrednio)',
  kind: 'carrier',
  capabilities: ['shipment.prepare'],
  rateLimit: RATE,
  config: CONFIG,
  secrets: SECRETS,
  readOnly: true,
}

export const DPD_ZAPIS_MANIFEST: AdapterManifest = {
  adapterKey: DPD_ZAPIS_KEY,
  version: '1.0.0',
  displayName: 'DPD Polska (bezpośrednio, zapis za wyłącznikiem)',
  kind: 'carrier',
  // reference.find tylko potwierdza paczkę (nigdy nie wyklucza) — patrz `findByReference` niżej
  // shipment.track: zdarzenia z DPDInfoServices (osobne dane logowania; bez nich śledzenie jest wyłączone)
  capabilities: ['shipment.prepare', 'shipment.create', 'reference.find', 'shipment.track'],
  rateLimit: RATE,
  config: [
    ...CONFIG,
    { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'wyłącznik: true = adapter może tworzyć przesyłki i etykiety; brak = nic nie wysyła' },
    { key: 'nadawca', type: 'string', required: false, description: 'JSON z Organization.settings.nadawca (wstawia host przy tworzeniu adaptera)' },
    { key: 'sledzenieUrl', type: 'string', required: false, description: 'adres usługi śledzenia DPDInfoServices z danych od DPD (https w domenie dpd.com.pl); brak = śledzenie wyłączone', pattern: DPD_INFO_URL_RE, envSuffix: 'SLEDZENIE_URL' },
    { key: 'sledzenieKanal', type: 'string', required: false, description: 'kanał kliencki DPDInfoServices z danych od DPD (opcjonalny przy śledzeniu po numerze listu)', pattern: /^[A-Za-z0-9._-]{1,64}$/, envSuffix: 'SLEDZENIE_KANAL' },
  ],
  secrets: [
    ...SECRETS,
    // nazwy z przedrostkiem DPD: sekrety firmy są czytane po samej nazwie, a Poczta Polska ma własne SLEDZENIE_LOGIN/HASLO
    { name: 'DPD_SLEDZENIE_LOGIN', required: false, description: 'login usługi śledzenia DPDInfoServices (inny niż DPDServices); brak = śledzenie wyłączone', envSuffix: 'SLEDZENIE_LOGIN' },
    { name: 'DPD_SLEDZENIE_HASLO', required: false, description: 'hasło usługi śledzenia DPDInfoServices; brak = śledzenie wyłączone', envSuffix: 'SLEDZENIE_HASLO' },
  ],
  readOnly: false,
}

/**
 * Kody zdarzeń DPDInfoServices (`businessCode`), przy których paczka jest już u DPD: odebrana przez kuriera (04xxxx),
 * w hubie i oddziałach (05, 11, 12, 15, 16, 22, 23, 32, 33), wydana do doręczenia (17), doręczona (19, 41, 50130x),
 * niedoręczona i zwroty (20, 24, 500xxx). Lista kodów: klient DPDInfoServices dbojdo/dpd-client
 * (`DPDInfoServices/CustomerEvents/BusinessCodes.php`) zgodny ze specyfikacją 1.0.7; nazwy kodów tam opisują zdarzenie.
 * Pominięte jako niejednoznaczne (`DPD_NEUTRALNE`): 170310 (mail do odbiorcy), 250301 (zmiana wagi), 330438 i 400133
 * (bez opisu).
 */
export const DPD_PRZEKAZANA: ReadonlySet<string> = new Set(
  (
    '040101 040102 050101 050102 110302 120100 120101 120102 120103 120104 150301 160101 160102 160103 160202 160501 160502 160503 ' +
    '170101 170102 170205 170302 190101 190102 190103 190104 190105 190201 190202 190203 190204 190205 ' +
    '200201 200202 200203 200204 200205 200206 200300 200306 200400 200401 200402 200403 200404 200405 200406 200408 200409 200410 ' +
    '200411 200412 200413 200414 200415 200416 200500 200601 200602 200700 200701 200801 220101 230101 230207 230208 230209 230210 ' +
    '230309 230310 230402 230403 240304 260403 320201 320202 330135 330137 410135 500011 500015 500019 500037 500042 500046 500085 ' +
    '500411 500414 500415 500419 500437 500442 500446 500485 500610 500611 500612 500614 500615 500616 500617 500624 500629 500630 ' +
    '500633 500635 500637 500639 500642 500649 500661 500684 500685 500811 500885 501300 501304 501340'
  ).split(' '),
)
/** „Zarejestrowano dane przesyłki, nie nadano” (PARCEL_REGISTERED_NOT_DISPATCHED). */
export const DPD_PRZED_NADANIEM: ReadonlySet<string> = new Set(['030103'])
/**
 * Kody, które mogą się pojawić i przed, i po odbiorze przez kuriera (np. mail do odbiorcy po rejestracji): nie
 * rozstrzygają stanu, przy ocenie są pomijane (zostają w statusie do historii).
 */
export const DPD_NEUTRALNE: ReadonlySet<string> = new Set(['170310', '250301', '330438', '400133'])

/**
 * Stan z listy zdarzeń: którekolwiek zdarzenie „u DPD” = PRZEKAZANA; brak zdarzeń albo same rejestracje i kody neutralne
 * = przed nadaniem; inny kod = NIEZNANY.
 */
export function stanDpd(zdarzenia: readonly ZdarzenieDpd[]): { stan: StanPrzesylki; status: string | null } {
  const ost = [...zdarzenia].sort((a, b) => (a.czas ?? '').localeCompare(b.czas ?? '')).at(-1)
  const status = ost ? (ost.opis ? `${ost.kod} ${ost.opis}` : ost.kod) : null
  if (zdarzenia.some((z) => DPD_PRZEKAZANA.has(z.kod))) return { stan: 'PRZEKAZANA', status }
  if (zdarzenia.every((z) => DPD_PRZED_NADANIEM.has(z.kod) || DPD_NEUTRALNE.has(z.kod))) return { stan: 'PRZED_NADANIEM', status }
  return { stan: 'NIEZNANY', status }
}

/**
 * Doręczenie (stan końcowy) tylko z kodów wymienionych wprost: PARCEL_DELIVERED 1901xx i 1902xx (z pobraniem), 410135,
 * DELIVERED_ABROAD 501300/501304/501340. Nieznany kod z tymi przedrostkami nie kończy śledzenia (lista DPD jest
 * nieoficjalna). Kody niepewne (1902xx: doręczenie czy punkt odbioru, 200602, zwroty 230403/5006xx) do potwierdzenia u DPD.
 */
export const DPD_DORECZONA: ReadonlySet<string> = new Set('190101 190102 190103 190104 190105 190201 190202 190203 190204 190205 410135 501300 501304 501340'.split(' '))
/** Zwrot do nadawcy (stan końcowy) tylko z kodów wymienionych wprost: 230403 i PARCEL_RETURN 5006xx z listy wyżej. */
export const DPD_ZWROT: ReadonlySet<string> = new Set(['230403', ...[...DPD_PRZEKAZANA].filter((k) => k.startsWith('5006'))])

/**
 * Jeden kod DPD na osi statusów (null = kod bez znaczenia dla osi: neutralny, dokumenty zwrotne, nieznany). Źródło
 * nazw kodów jak wyżej (klient dbojdo/dpd-client, nieoficjalne). Odebrana przez kuriera 04; wydana do doręczenia
 * 170101/170102; doręczona i zwrot tylko z list wyżej (stany końcowe); nieudane doręczenie z przedrostków 20 i 500
 * (stan niekońcowy, więc nieznany kod z tymi przedrostkami najwyżej przedłuża odpytywanie), w tym 200602 „do odbioru
 * osobiście” jako czeka w punkcie; brak w oddziale i likwidacja 230309/230310 = problem; reszta kodów „u DPD” (huby,
 * oddziały, przepakowanie, zmiana adresu) = w drodze.
 */
export function osDpd(kod: string): StanDrogi | null {
  if (DPD_NEUTRALNE.has(kod) || kod === '240304') return null
  if (DPD_PRZED_NADANIEM.has(kod)) return 'UTWORZONA'
  if (DPD_DORECZONA.has(kod)) return 'DORECZONA'
  if (DPD_ZWROT.has(kod)) return 'ZWROT'
  if (kod.startsWith('04')) return 'PRZEKAZANA'
  if (kod === '170101' || kod === '170102') return 'W_DORECZENIU'
  if (kod === '200602') return 'W_PUNKCIE'
  if (kod === '230309' || kod === '230310') return 'PROBLEM'
  if (kod.startsWith('20') || kod.startsWith('500')) return 'NIEUDANE_DORECZENIE'
  if (DPD_PRZEKAZANA.has(kod)) return 'W_DRODZE'
  return null
}

/** Wynik osi z listy zdarzeń przewoźnika: stan, czas i kod zdarzenia, z którego go wyliczono, czas przekazania. */
export interface OsZeZdarzen {
  stanDrogi: StanDrogi
  czas: string | null
  kod: string | null
  przekazanaO: string | null
}

/**
 * Stan na osi z listy zdarzeń: ostatnie (wg czasu) zdarzenie ze znaczeniem dla osi, jego czas i kod. Zwrot „przykleja
 * się”: po pierwszym zdarzeniu zwrotu stan to ZWROT (z czasem i kodem tego zdarzenia), także gdy później jest
 * doręczenie (do nadawcy) albo wydanie do doręczenia (droga powrotna). Bez zdarzeń = utworzona; same kody bez
 * znaczenia = nieznany (czas i kod ostatniego zdarzenia). `przekazanaO` = pierwsze zdarzenie „u DPD”.
 */
export function stanDrogiDpd(zdarzenia: readonly ZdarzenieDpd[]): OsZeZdarzen {
  const wg = [...zdarzenia].sort((a, b) => (a.czas ?? '').localeCompare(b.czas ?? ''))
  if (!wg.length) return { stanDrogi: 'UTWORZONA', czas: null, kod: null, przekazanaO: null }
  const przekazanaO = wg.find((z) => DPD_PRZEKAZANA.has(z.kod))?.czas ?? null
  const zwrot = wg.find((z) => osDpd(z.kod) === 'ZWROT')
  if (zwrot) return { stanDrogi: 'ZWROT', czas: zwrot.czas, kod: zwrot.kod, przekazanaO }
  for (let i = wg.length - 1; i >= 0; i--) {
    const os = osDpd(wg[i]!.kod)
    if (os) return { stanDrogi: os, czas: wg[i]!.czas, kod: wg[i]!.kod, przekazanaO }
  }
  return { stanDrogi: 'NIEZNANY', czas: wg.at(-1)!.czas, kod: wg.at(-1)!.kod, przekazanaO }
}

const SLEDZENIE_WYLACZONE = 'śledzenie DPD wyłączone: brak adresu, loginu albo hasła usługi DPDInfoServices w ustawieniach konta (login DPDServices nie jest tam wysyłany)'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Zapytanie testowe: stały kod pocztowy, bez danych klienta. Kształt treści [NIEPEWNE], do sprawdzenia na demo. */
const TEST_KOD = { countryCode: 'PL', zipCode: '02274' }

/** Kształt odpowiedzi nie jest potwierdzony: odmowa albo pusta odpowiedź to brak połączenia, treści nie przepisujemy. */
function postalCodeProblem(r: unknown): string | null {
  if (r === null || r === undefined) return 'pusta odpowiedź zapytania o kod pocztowy'
  if (Array.isArray(r)) return r.length ? null : 'pusta odpowiedź zapytania o kod pocztowy'
  if (!isRecord(r) || Object.keys(r).length === 0) return 'nieczytelna odpowiedź zapytania o kod pocztowy'
  const status = typeof r['status'] === 'string' ? r['status'].toUpperCase() : null
  if ((status && status !== 'OK') || r['error'] || r['errors'] || r['success'] === false) return 'DPD odrzucił zapytanie o kod pocztowy'
  return null
}

function logowanie(ctx: AdapterContext): DpdLogowanie {
  return { login: ctx.secrets['DPD_LOGIN']!, password: ctx.secrets['DPD_PASSWORD']!, fid: String(ctx.config['masterFid'] ?? ctx.config['payerFid']) }
}

class DpdAdapter implements ChannelAdapter, ShipmentPreparer {
  readonly manifest: AdapterManifest = DPD_MANIFEST
  protected readonly api: DpdReadOnly
  private readonly ustawienia: UstawieniaDpd

  constructor(protected readonly ctx: AdapterContext) {
    this.api = new DpdReadOnly(String(ctx.config['baseUrl']), logowanie(ctx), ctx.fetch, ctx.http?.minIntervalMs, ctx.http?.retry)
    this.ustawienia = ustawieniaDpd(ctx.config)
  }

  /** 401 i 403 = TRWALY (login, hasło, FID), 429 i 5xx = PRZEJSCIOWY; `details.rodzaj` mówi to hostowi. */
  async testConnection(): Promise<ConnectionTest> {
    try {
      const problem = postalCodeProblem(await this.api.post('/public/routing/v1/postalCode', TEST_KOD))
      return problem ? { ok: false, message: problem, details: { rodzaj: 'TRWALY' } } : { ok: true, message: 'zapytanie o kod pocztowy działa' }
    } catch (e) {
      const rodzaj = e instanceof DpdHttpError && e.retryable ? 'PRZEJSCIOWY' : 'TRWALY'
      return { ok: false, message: e instanceof DpdHttpError ? e.message : 'błąd zapytania o kod pocztowy', details: { rodzaj } }
    }
  }

  prepareShipment(input: ShipmentInput): PreparedParcel {
    return wyliczPrzesylkeDpd(input, this.ustawienia)
  }
}

/** Kody błędów DPD z odpowiedzi (np. INCORRECT_PUDO); tylko stałe kody, bez tekstów, które mogą powtarzać dane. */
function kodyBledow(v: unknown, out = new Set<string>(), glebokosc = 0): Set<string> {
  if (glebokosc > 6) return out
  if (Array.isArray(v)) for (const x of v) kodyBledow(x, out, glebokosc + 1)
  else if (isRecord(v)) {
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'errorCode' || k === 'code') && typeof x === 'string' && /^[A-Z][A-Z0-9_]{2,60}$/.test(x)) out.add(x)
      else if (typeof x === 'object') kodyBledow(x, out, glebokosc + 1)
    }
  }
  return out
}

/** `GeneratePackagesNumbersResponse`: status, packages[].parcels[].waybill [NIEPEWNE: dokładne pola do demo]. */
function wynikNumerow(body: unknown, reference: string): WriteOutcome {
  if (!isRecord(body)) return { kind: 'NIEJEDNOZNACZNY', reference, message: 'DPD: nieczytelna odpowiedź po wysłaniu; sprawdź paczkę w panelu DPD po referencji' }
  const status = typeof body['status'] === 'string' ? body['status'].toUpperCase() : null
  const pkg = Array.isArray(body['packages']) && isRecord(body['packages'][0]) ? body['packages'][0] : null
  const parcel = pkg && Array.isArray(pkg['parcels']) && isRecord(pkg['parcels'][0]) ? pkg['parcels'][0] : null
  const waybill = parcel && typeof parcel['waybill'] === 'string' && parcel['waybill'].trim() ? parcel['waybill'].trim() : null
  if (status === 'OK' && waybill) return { kind: 'OK', reference, externalRef: waybill }
  if (status && status !== 'OK') {
    const kody = [...kodyBledow(body)].filter((k) => k !== status)
    return { kind: 'TRWALY', reference, message: `DPD odrzucił paczkę (${status})${kody.length ? `: ${kody.join(', ')}` : ''}` }
  }
  return { kind: 'NIEJEDNOZNACZNY', reference, message: 'DPD: odpowiedź bez numeru listu; sprawdź paczkę w panelu DPD po referencji' }
}

const CONTENT_TYPE: Record<LabelFormat, string> = { PDF: 'application/pdf', ZPL: 'text/plain', EPL: 'text/plain' }

class DpdZapisAdapter extends DpdAdapter implements ShipmentCreator, ReferenceFinder, ShipmentTracker {
  override readonly manifest: AdapterManifest = DPD_ZAPIS_MANIFEST
  private klient: DpdZapis | null = null

  /**
   * Stan przesyłki z DPDInfoServices (sam odczyt, po numerze listu = `externalRef`). Bez wyłącznika zapisu przesyłek
   * z Kompletora nie ma; bez osobnych danych usługi śledzenia nie pytamy (login DPDServices nie idzie do innej usługi).
   * Sieć, 429, 5xx, Fault inny niż o logowaniu i nieczytelna treść = PRZEJSCIOWY (następny przebieg); odmowa logowania,
   * brak danych i wyłączony zapis = błąd konta (przesyłki zostają w śledzeniu; nie liczy się do wyłączenia konta
   * nadawania DPD, bo usługa śledzenia ma własne dane); zły numer listu = błąd tej przesyłki.
   */
  async trackShipment(externalRef: string): Promise<OdczytPrzesylki> {
    if (!this.wlaczony) throw new BladKontaSledzenia('zapis wyłączony')
    const url = this.ctx.config['sledzenieUrl']
    const login = this.ctx.secrets['DPD_SLEDZENIE_LOGIN']
    const haslo = this.ctx.secrets['DPD_SLEDZENIE_HASLO']
    if (typeof url !== 'string' || !DPD_INFO_URL_RE.test(url) || !login || !haslo) throw new BladKontaSledzenia(SLEDZENIE_WYLACZONE, true)
    const kanal = typeof this.ctx.config['sledzenieKanal'] === 'string' ? this.ctx.config['sledzenieKanal'] : null
    try {
      const zdarzenia = await new DpdSledzenie(url, { login, haslo, kanal }, this.ctx.fetch, 30_000, this.ctx.http?.retry ?? { attempts: 2, baseDelayMs: 1_000 }).zdarzenia(externalRef)
      return { ...stanDpd(zdarzenia), ...stanDrogiDpd(zdarzenia) }
    } catch (e) {
      if (e instanceof DpdInfoError) {
        if (e.zakres === 'KONTO') throw new BladKontaSledzenia(e.message, true)
        if (e.zakres === 'PRZESYLKA') throw new BladPrzesylkiSledzenia(e.message)
        throw new AdapterError(e.message, 'PRZEJSCIOWY')
      }
      throw e
    }
  }

  private get wlaczony(): boolean {
    return this.ctx.config['zapisWlaczony'] === true
  }

  /** Klient zapisu powstaje dopiero przy pierwszym użyciu i tylko przy włączonym zapisie. */
  private zapis(): DpdZapis {
    this.klient ??= new DpdZapis({ baseUrl: String(this.ctx.config['baseUrl']), auth: logowanie(this.ctx), fetchImpl: this.ctx.fetch, wylacznik: true })
    return this.klient
  }

  async createShipment(req: ShipmentCreateRequest, reference: string): Promise<WriteOutcome> {
    if (!this.wlaczony) return { kind: 'TRWALY', reference, message: 'zapis wyłączony' }
    const c: AccountConfig = this.ctx.config
    const o = odbiorcaDpd(req.recipient, req.parcel.courierCode === DPD_PICKUP)
    if (!o.odbiorca) return { kind: 'TRWALY', reference, message: o.braki.includes('kraj') ? 'odbiorca spoza Polski: moduł DPD jest krajowy (kraj)' : `niepełne dane odbiorcy: ${o.braki.join(', ')}` }
    let surowy: unknown = null
    try {
      surowy = typeof c['nadawca'] === 'string' ? (JSON.parse(c['nadawca']) as unknown) : null
    } catch {
      return { kind: 'TRWALY', reference, message: 'nieczytelne dane nadawcy w konfiguracji' }
    }
    const n = parseNadawca({ nadawca: surowy as never })
    if (!n.nadawca) return { kind: 'TRWALY', reference, message: `brak danych nadawcy firmy: ${n.braki.join(', ')}` }
    const payerFid = String((czyEmpik(req.carrier) ? c['empikPayerFid'] : undefined) ?? c['payerFid'])
    let payload: Record<string, unknown>
    try {
      payload = buildPackagesPayload(req.parcel, o.odbiorca, n.nadawca, { payerFid, reference, potwierdzoneOstrzezenia: req.potwierdzoneOstrzezenia ?? [] })
    } catch (e) {
      return { kind: 'TRWALY', reference, message: e instanceof Error ? e.message : 'zła treść przesyłki' }
    }
    const r = await this.zapis().post(DPD_SCIEZKA_NUMERY, payload)
    if (!r.ok) return { kind: r.kind, reference, message: r.kind === 'NIEJEDNOZNACZNY' ? `${r.message}; sprawdź paczkę w panelu DPD po referencji, bez ponawiania` : r.message }
    return wynikNumerow(r.body, reference)
  }

  async getLabel(externalRef: string, format: LabelFormat): Promise<{ contentType: string; base64: string }> {
    if (!this.wlaczony) throw new AdapterError('zapis wyłączony', 'TRWALY')
    if (!/^[0-9A-Z]{6,40}$/.test(externalRef)) throw new AdapterError('zły numer listu DPD', 'TRWALY')
    if (!(format in CONTENT_TYPE)) throw new AdapterError('zły format etykiety', 'TRWALY')
    // Kształt `labelSearchParams` jak w DPDServices SOAP `generateSpedLabelsV4` [NIEPEWNE dla REST, do demo].
    const body = {
      labelSearchParams: { policy: 'STOP_ON_FIRST_ERROR', session: { type: 'DOMESTIC', packages: [{ parcels: [{ waybill: externalRef }] }] } },
      outputDocFormat: format,
      format: String(this.ctx.config['labelFormat'] ?? 'LBL_PRINTER'),
      outputType: 'BIC3',
      variant: 'STANDARD',
    }
    const r = await this.zapis().post(DPD_SCIEZKA_ETYKIETY, body)
    // Etykieta nie tworzy paczki: niepewny wynik wolno pobrać ponownie.
    if (!r.ok) throw new AdapterError(r.message, r.kind === 'TRWALY' ? 'TRWALY' : 'PRZEJSCIOWY')
    // status inny niż OK albo kod błędu na KTÓRYMKOLWIEK poziomie odpowiedzi (wierzch,
    // sesja, paczki, listy) = DPD nie dał etykiety tego listu (np. nieznany numer), nawet gdy `documentData` nie jest puste
    if (!statusyOdpowiedziOk(r.body)) throw new AdapterError('DPD odrzucił pobranie etykiety tego numeru listu', 'TRWALY')
    const doc = isRecord(r.body) ? r.body['documentData'] : null
    if (typeof doc !== 'string' || !doc.trim() || !/^[A-Za-z0-9+/=\s]+$/.test(doc)) throw new AdapterError('DPD: odpowiedź bez etykiety', 'TRWALY')
    return { contentType: CONTENT_TYPE[format], base64: doc.replace(/\s/g, '') }
  }

  /**
   * numer listu wpisany przy „Rozstrzygnij ręcznie” potwierdza etykieta: DPD musi ją wydać dla
   * tego numeru (pobranie etykiety nie tworzy paczki). Odmowa DPD = odmowa bez zapisu; sieć i 5xx = wyjątek („spróbuj
   * ponownie”). DPD nie zwraca w etykiecie referencji: adapter sprawdza, że list istnieje na koncie firmy, a host
   * (`potwierdzNumer`) porównuje numer z odszukaniem po referencji (`findByReference`); numery DPD są
   * seryjne, więc literówka w ostatniej cyfrze trafia w sąsiedni list tej samej firmy.
   */
  async confirmManual(identyfikator: string, _reference: string): Promise<PotwierdzenieRecznego> {
    if (!this.wlaczony) return { odmowa: 'Nadawanie DPD jest wyłączone w ustawieniach przewoźnika: Kompletor nie może sprawdzić numeru listu w DPD.' }
    const numer = identyfikator.trim()
    if (!/^[0-9A-Z]{6,40}$/.test(numer)) return { odmowa: 'Podaj numer listu przewozowego z panelu DPD (wielkie litery i cyfry, bez spacji).' }
    try {
      await this.getLabel(numer, 'PDF')
    } catch (e) {
      if (e instanceof AdapterError && e.kind === 'TRWALY') return { odmowa: `DPD nie potwierdził numeru listu ${numer}: sprawdź numer w panelu DPD.` }
      throw e
    }
    return { externalRef: numer, info: 'Sprawdzone w DPD: etykieta tego numeru listu jest dostępna.' }
  }

  /**
   * (raport OpenLinker: bez tego ryzyko podwójnego pobrania): odszukanie paczki po referencji, którą host
   * nadał przy `generatePackagesNumbers` (`packages[].reference`). DPD nie ma osobnego odczytu paczki po referencji;
   * pytamy `generateSpedLabels` z `packages: [{ reference }]` [NIEPEWNE: kształt wyszukiwania i odpowiedzi do
   * potwierdzenia na demo, docs/integracje/dpd.md]. Zasada bezpieczeństwa: wynik może tylko POTWIERDZIĆ paczkę
   * (numer listu w odpowiedzi przy tej referencji). Nigdy nie zwraca `found: false`, bo brak paczki w odpowiedzi
   * niepotwierdzonego kształtu nie jest dowodem, a „nie znaleziono” zamieniłoby NIEJEDNOZNACZNY w PRZEJSCIOWY i host
   * utworzyłby drugą płatną paczkę. Wszystko inne = błąd, wynik zapisu zostaje NIEJEDNOZNACZNY i rozstrzyga człowiek.
   */
  async findByReference(reference: string): Promise<ReferenceLookup> {
    if (!this.wlaczony) throw new AdapterError('zapis wyłączony', 'TRWALY')
    if (!/^[A-Za-z0-9_-]{1,50}$/.test(reference)) throw new AdapterError('zła referencja paczki DPD', 'TRWALY')
    const body = {
      labelSearchParams: { policy: 'STOP_ON_FIRST_ERROR', session: { type: 'DOMESTIC', packages: [{ reference }] } },
      outputDocFormat: 'PDF',
      format: 'A4',
      outputType: 'BIC3',
      variant: 'STANDARD',
    }
    const r = await this.zapis().post(DPD_SCIEZKA_ETYKIETY, body)
    // etykieta nie tworzy paczki: niepewny wynik odszukania wolno powtórzyć (PRZEJSCIOWY), odmowa = TRWALY
    if (!r.ok) throw new AdapterError(`DPD: odszukanie po referencji nieudane (${r.message})`, r.kind === 'TRWALY' ? 'TRWALY' : 'PRZEJSCIOWY')
    return { found: true, externalRef: numerListuDlaReferencji(r.body, reference) }
  }
}

/**
 * Numer listu paczki o tej referencji z odpowiedzi `generateSpedLabels` (`session.packages[].reference` i
 * `parcels[].waybill`, także bez `session` na wierzchu) [NIEPEWNE]. Paczki z inną referencją = filtr nie zadziałał;
 * kilka paczek albo kilka listów = potrzebny człowiek; brak numeru = nie da się potwierdzić. Każdy z tych przypadków
 * to AdapterError TRWALY bez treści odpowiedzi (może mieć dane odbiorcy).
 */
export function numerListuDlaReferencji(body: unknown, reference: string): string {
  const sesja = isRecord(body) && isRecord(body['session']) ? body['session'] : body
  const paczki = isRecord(sesja) && Array.isArray(sesja['packages']) ? sesja['packages'].filter(isRecord) : []
  if (!paczki.length) throw new AdapterError('DPD: odpowiedź odszukania bez paczek; nie da się potwierdzić ani wykluczyć paczki, sprawdź w panelu DPD po referencji', 'TRWALY')
  if (paczki.some((p) => p['reference'] !== reference)) throw new AdapterError('DPD: odszukanie zwróciło paczkę z inną referencją, wynik nierozstrzygnięty', 'TRWALY')
  if (paczki.length > 1) throw new AdapterError('DPD: kilka paczek z tą samą referencją, potrzebny człowiek', 'TRWALY')
  // echo referencji z żądania nie jest potwierdzeniem, jeśli sesja, paczka albo list niesie status
  // inny niż OK albo kod błędu (np. PACKAGE_NOT_FOUND, sesja z innego dnia) [NIEPEWNE: nazwy pól do demo DPD]
  const parcele = (Array.isArray(paczki[0]!['parcels']) ? paczki[0]!['parcels'] : []).filter(isRecord)
  if (!statusyOdpowiedziOk(body)) throw new AdapterError('DPD: status paczki w odpowiedzi odszukania nie potwierdza paczki, sprawdź w panelu DPD', 'TRWALY')
  const listy = parcele
    .map((x) => (typeof x['waybill'] === 'string' ? x['waybill'].trim() : ''))
    .filter((w) => /^[0-9A-Z]{6,40}$/.test(w))
  if (listy.length !== 1) throw new AdapterError('DPD: paczka z referencją bez jednego numeru listu, sprawdź w panelu DPD', 'TRWALY')
  return listy[0]!
}

/**
 * status całej odpowiedzi DPD (etykieta, odszukanie): wierzch, `session`, każda paczka
 * `packages[]` i każdy list `parcels[]` (także bez `session` na wierzchu) [NIEPEWNE: kształt REST do demo]. Sprzeciw
 * na dowolnym poziomie = odpowiedź nie potwierdza listu.
 */
export function statusyOdpowiedziOk(body: unknown): boolean {
  const sesja = isRecord(body) && isRecord(body['session']) ? body['session'] : null
  const paczki = [body, sesja].flatMap((x) => (isRecord(x) && Array.isArray(x['packages']) ? x['packages'].filter(isRecord) : []))
  const parcele = paczki.flatMap((p) => (Array.isArray(p['parcels']) ? p['parcels'].filter(isRecord) : []))
  return [body, sesja, ...paczki, ...parcele].every(statusOk)
}

/** Status elementu odpowiedzi DPD: brak pola = bez sprzeciwu; `status`/`statusInfo.status` różny od OK albo kod błędu = sprzeciw. */
function statusOk(x: unknown): boolean {
  if (!isRecord(x)) return true
  const st = [x['status'], isRecord(x['statusInfo']) ? x['statusInfo']['status'] : undefined].filter((v) => v !== undefined && v !== null)
  if (st.some((v) => String(v).trim().toUpperCase() !== 'OK')) return false
  for (const k of ['errorCode', 'errors', 'error']) {
    const v = x[k]
    if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) return false
  }
  if (isRecord(x['statusInfo'])) for (const k of ['errorCode', 'errors']) {
    const v = x['statusInfo'][k]
    if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) return false
  }
  return true
}

export const DPD_DEFINITION: AdapterDefinition = { manifest: DPD_MANIFEST, create: (ctx) => new DpdAdapter(ctx) }
export const DPD_ZAPIS_DEFINITION: AdapterDefinition = { manifest: DPD_ZAPIS_MANIFEST, create: (ctx) => new DpdZapisAdapter(ctx) }
