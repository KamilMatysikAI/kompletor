// Adaptery przewoźnika Orlen Paczka, SOAP WebServicePwR:
//   `orlenpaczka.v1` — domyślny, tylko do odczytu: liczy przesyłkę (lib/wysylka/orlenpaczka.ts), test połączenia stanem
//     konta (GivePartnerStatus), status paczki (GiveMePackStatus). Klient odczytu odmawia każdej metody, która tworzy,
//     zmienia albo kosztuje.
//   `orlenpaczka.zapis.v1` — nadanie (GenerateBusinessPack, płatne), etykieta i duplikat (LabelPrintDuplicateListTwo),
//     anulowanie (PutCustomerPackCanceled), odszukanie po referencji i sprawdzenie numeru przy „Rozstrzygnij ręcznie”.
//     Trzy niezależne warunki, wszystkie wymagane: reguła przewoźnika firmy wskazuje ten klucz, konfiguracja ma
//     `zapisWlaczony: true`, host wywoła zapis. Bez `zapisWlaczony` żadne żądanie zapisu nie wychodzi (test pilnuje).
//
// Oparte na wiedzy z Open Integration Platform, integrators/courier/orlenpaczka/v1.0.0/src/integration.py (commit
// ae43d1e, Copyright 2024-2026 Pinquark.com, Apache License 2.0), przepisane i zmienione: własny kod TypeScript w
// kontrakcie Kompletora, klasy błędów i idempotencja po naszemu, pola i zasady z dokumentacji „API ORLEN Paczka
// v1.26.004”. Atrybucja: THIRD_PARTY_NOTICES.md.
//
// Idempotencja (u nich jej nie ma; Orlen nie zwraca żadnego pola referencji w statusie ani w liście paczek): host
// tworzy wiersz przesyłki z referencją PRZED wywołaniem, a adapter wpisuje odcisk referencji w `SenderOrders` (drukuje
// się na etykiecie). Odszukanie po referencji: lista numerów nadanych przez API w ostatnich dniach (GetGeneratedParcels)
// i etykiety ZPL tych paczek, w których szukamy odcisku. Wynik może tylko POTWIERDZIĆ paczkę; brak trafienia nigdy nie
// jest `found: false` (druga płatna paczka), tylko błędem, a przesyłka zostaje NIEJEDNOZNACZNA dla człowieka.
// Dane odbiorcy wchodzą tylko w `createShipment` (w pamięci); etykiety innych paczek przy odszukaniu też tylko w pamięci.
import { parseNadawca } from '../wysylka/zlecenie-dpd'
import { ustawieniaOrlen, wyliczPrzesylkeOrlen, type UstawieniaOrlen } from '../wysylka/orlenpaczka'
import { nadawcaOrlen, odbiorcaOrlen, odciskReferencji, zlecenieOrlen } from '../wysylka/zlecenie-orlenpaczka'
import { SourceError } from '../zrodla/http'
import { ORLEN_PROD, ORLEN_TEST, ORLEN_URL_RE, OrlenOdczyt, OrlenZapis, pole, rekordWyniku, rekordy, type OrlenLogowanie } from '../zrodla/orlenpaczka'
import {
  AdapterError,
  type AdapterContext,
  type AdapterDefinition,
  type AdapterManifest,
  type ChannelAdapter,
  type ConfigField,
  type ConnectionTest,
  type LabelFormat,
  type PotwierdzenieRecznego,
  type PreparedParcel,
  type ReferenceFinder,
  type ReferenceLookup,
  type ShipmentCreateRequest,
  type ShipmentCreator,
  type ShipmentInput,
  type ShipmentPreparer,
  type WriteOutcome,
} from './kontrakt'
import { kodLiczbowy, wynikKodu } from './orlenpaczka-kody'

export const ORLEN_KEY = 'orlenpaczka.v1'
export const ORLEN_ZAPIS_KEY = 'orlenpaczka.zapis.v1'

/** Numer paczki Orlenu: EAN-13 (nadane przez API zaczynają się od 21, pkt 3.2 dokumentacji). */
export const NUMER_PACZKI_ORLEN_RE = /^\d{13}$/

/**
 * Cyfra kontrolna EAN-13 (wagi 1 i 3 od lewej). Numer wpisany ręcznie z literówką w jednej cyfrze
 * odpada, zanim zapytamy Orlen. [NIEPEWNE: przykłady w dokumentacji są fikcyjne; numery prawdziwych paczek w niej
 * (np. 2101142967553, 2101142968208) mają poprawną cyfrę kontrolną; potwierdzić na sandboxie.]
 */
export function ean13Poprawny(numer: string): boolean {
  if (!NUMER_PACZKI_ORLEN_RE.test(numer)) return false
  let suma = 0
  for (let i = 0; i < 12; i++) suma += Number(numer[i]) * (i % 2 ? 3 : 1)
  return (10 - (suma % 10)) % 10 === Number(numer[12])
}

const CONFIG: readonly ConfigField[] = [
  {
    key: 'srodowisko',
    type: 'string',
    required: false,
    description: 'środowisko Orlen Paczki: test (domyślnie, osobne dane dostępu od opiekuna) albo produkcja',
    options: [
      { value: 'test', label: 'Testowe (sandbox Orlen Paczki)' },
      { value: 'produkcja', label: 'Produkcyjne (prawdziwe paczki)' },
    ],
  },
  { key: 'baseUrl', type: 'string', required: false, description: 'self-host: adres usługi zamiast środowiska (tylko adres produkcyjny albo testowy z dokumentacji)', pattern: ORLEN_URL_RE, envSuffix: 'BASE_URL' },
  { key: 'envPrefix', type: 'string', required: false, description: 'self-host: przedrostek zmiennych env (np. ORLEN)', pattern: /^[A-Z][A-Z0-9_]{0,40}$/ },
  { key: 'defaultWeightKg', type: 'number', required: false, description: 'waga paczki w kg, gdy produkty nie mają wagi (limit Orlen Paczki 20 kg)' },
]

const SECRETS: AdapterManifest['secrets'] = [
  { name: 'ORLEN_PARTNER_ID', required: true, description: 'PartnerID: login konta API Orlen Paczki (od opiekuna handlowego)', envSuffix: 'PARTNER_ID' },
  { name: 'ORLEN_PARTNER_KEY', required: true, description: 'PartnerKey: hasło konta API Orlen Paczki', envSuffix: 'PARTNER_KEY' },
]

// Dokumentacja nie podaje limitów: ostrożnie, jedno żądanie naraz.
const RATE = { requestsPerMinute: 30, maxConcurrent: 1, minPollIntervalMs: 0 }

export const ORLEN_MANIFEST: AdapterManifest = {
  adapterKey: ORLEN_KEY,
  version: '1.0.0',
  displayName: 'Orlen Paczka (bezpośrednio)',
  kind: 'carrier',
  capabilities: ['shipment.prepare'],
  rateLimit: RATE,
  config: CONFIG,
  secrets: SECRETS,
  readOnly: true,
}

/** Limit czasu jednego żądania zapisu (nadanie) i odczytu (lista paczek, 3 próby z przerwą) oraz etykiety przy odszukaniu. */
const NADANIE_TIMEOUT_MS = 60_000
const ODCZYT_TIMEOUT_MS = 30_000
const ODCZYT_PROBY = 3
const ODCZYT_PRZERWA_MS = 500
export const ODSZUKANIE_LIMIT = 10
const ODSZUKANIE_TIMEOUT_MS = 15_000
/**
 * Najgorszy czas żywego „Utwórz przesyłkę” (`shipmentMaxCreateMs`): nadanie, potem przy zgubionej
 * odpowiedzi lista nadanych paczek (3 próby + przerwy 0,5 i 1 s) i do 10 etykiet. Ok. 5 min; host dolicza zapas.
 */
export const NAJDLUZSZE_UTWORZENIE_MS = NADANIE_TIMEOUT_MS + ODCZYT_PROBY * ODCZYT_TIMEOUT_MS + ODCZYT_PRZERWA_MS * (2 ** (ODCZYT_PROBY - 1) - 1) +ODSZUKANIE_LIMIT * ODSZUKANIE_TIMEOUT_MS

export const ORLEN_ZAPIS_MANIFEST: AdapterManifest = {
  adapterKey: ORLEN_ZAPIS_KEY,
  version: '1.0.0',
  displayName: 'Orlen Paczka (bezpośrednio, nadawanie za wyłącznikiem)',
  kind: 'carrier',
  // reference.find tylko potwierdza paczkę (nigdy nie wyklucza): patrz `findByReference`
  capabilities: ['shipment.prepare', 'shipment.create', 'shipment.cancel', 'reference.find'],
  rateLimit: RATE,
  config: [
    ...CONFIG,
    { key: 'zapisWlaczony', type: 'boolean', required: false, description: 'wyłącznik: true = adapter może nadawać paczki (płatne), pobierać etykiety i anulować; brak = nic nie wysyła' },
    { key: 'nadawca', type: 'string', required: false, description: 'JSON z danymi nadawcy firmy (wstawia host przy tworzeniu adaptera)' },
  ],
  secrets: SECRETS,
  readOnly: false,
  shipmentMaxCreateMs: NAJDLUZSZE_UTWORZENIE_MS,
}

/** Adres usługi: jawny `baseUrl` (self-host) albo środowisko; brak = testowe (bez ryzyka prawdziwej paczki). */
export function adresOrlen(config: Readonly<Record<string, unknown>>): string {
  if (typeof config['baseUrl'] === 'string' && config['baseUrl']) return config['baseUrl']
  return config['srodowisko'] === 'produkcja' ? ORLEN_PROD : ORLEN_TEST
}

function logowanie(ctx: AdapterContext): OrlenLogowanie {
  return { partnerId: ctx.secrets['ORLEN_PARTNER_ID']!, partnerKey: ctx.secrets['ORLEN_PARTNER_KEY']! }
}

/** Data w Polsce (YYYY-MM-DD), w której Orlen liczy daty nadania. */
const dzienPl = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
/** „2026-11-08” → „08.11”. */
const dzienKrotko = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`
/** Godzina nadania z `Data` GetGeneratedParcels (czas polski, pkt 4.11): „2026-11-08T10:59:01+01:00” → „08.11 10:59”. */
function godzinaNadania(data: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(data)
  return m ? `${m[3]}.${m[2]} ${m[4]}:${m[5]}` : 'godzina nieznana'
}

/**
 * paczek nadanych przez API nie widać w panelu Orlen Paczki (WebTrucker, pkt 3.2 dokumentacji),
 * więc komunikaty nie odsyłają do panelu; człowiek porównuje listę paczek z API (pokazuje ją „Sprawdź u przewoźnika”).
 */
const BEZ_PONAWIANIA = 'nie wiadomo, czy paczka powstała: nie twórz jej drugi raz, kliknij „Sprawdź u przewoźnika” (paczek z API nie widać w panelu Orlen Paczki)'

/** Paczka z listy nadanych przez API (GetGeneratedParcels): sam numer i godzina, bez danych odbiorcy. */
export interface PaczkaZApi {
  numer: string
  data: string
}

/** Lista paczek konta z okna dni (najnowsze najpierw) i opis okna do komunikatów („06.11”–„09.11”). */
interface OknoPaczek {
  paczki: PaczkaZApi[]
  od: string
  do: string
}

export interface StatusPaczkiOrlen {
  numer: string
  kod: number
  opis: string | null
  od: string | null
  punkt: string | null
}

class OrlenAdapter implements ChannelAdapter, ShipmentPreparer {
  readonly manifest: AdapterManifest = ORLEN_MANIFEST
  protected readonly odczyt: OrlenOdczyt
  private readonly ustawienia: UstawieniaOrlen

  constructor(protected readonly ctx: AdapterContext) {
    // ponowienia hosta najwyżej do wartości, z których liczy się NAJDLUZSZE_UTWORZENIE_MS
    // (manifest jest statyczny, więc dłuższe ponowienia rozjechałyby próg „Sprawdź u przewoźnika”).
    const r = ctx.http?.retry
    const retry = {
      attempts: Math.max(1, Math.min(r?.attempts ?? ODCZYT_PROBY, ODCZYT_PROBY)),
      baseDelayMs: Math.max(0, Math.min(r?.baseDelayMs ?? ODCZYT_PRZERWA_MS, ODCZYT_PRZERWA_MS)),
    }
    this.odczyt = new OrlenOdczyt({ url: adresOrlen(ctx.config), auth: logowanie(ctx), fetchImpl: ctx.fetch, timeoutMs: ODCZYT_TIMEOUT_MS, retry })
    this.ustawienia = ustawieniaOrlen(ctx.config)
  }

  /** Stan konta (GivePartnerStatus): zły PartnerID albo klucz = TRWALY, sieć i 5xx = PRZEJSCIOWY (`details.rodzaj`). */
  async testConnection(): Promise<ConnectionTest> {
    const srodowisko = adresOrlen(this.ctx.config) === ORLEN_PROD ? 'produkcja' : 'test'
    try {
      const rec = rekordWyniku(await this.odczyt.wywolaj('GivePartnerStatus'))
      const kod = kodLiczbowy(rec?.['Err'])
      if (kod === null) return { ok: false, message: 'nieczytelna odpowiedź Orlen Paczki na zapytanie o konto', details: { rodzaj: 'TRWALY', srodowisko } }
      const w = wynikKodu(kod, 'odczyt')
      if (w.kind !== 'OK') return { ok: false, message: w.message, details: { rodzaj: w.kind === 'PRZEJSCIOWY' ? 'PRZEJSCIOWY' : 'TRWALY', srodowisko } }
      return { ok: true, message: `konto Orlen Paczki odpowiada (środowisko ${srodowisko === 'test' ? 'testowe' : 'produkcyjne'})`, details: { srodowisko, platnosc: rec?.['PaymentType'] || null } }
    } catch (e) {
      const rodzaj = e instanceof SourceError && e.retryable ? 'PRZEJSCIOWY' : 'TRWALY'
      return { ok: false, message: e instanceof SourceError ? e.message : 'błąd zapytania o konto Orlen Paczki', details: { rodzaj, srodowisko } }
    }
  }

  prepareShipment(input: ShipmentInput): PreparedParcel {
    return wyliczPrzesylkeOrlen(input, this.ustawienia)
  }

  /** Ostatni status paczki (GiveMePackStatus, tylko odczyt); pod przyszłe śledzenie przesyłek. */
  async statusPaczki(numer: string): Promise<StatusPaczkiOrlen> {
    if (!NUMER_PACZKI_ORLEN_RE.test(numer)) throw new AdapterError('zły numer paczki Orlen Paczki (13 cyfr)', 'TRWALY')
    let xml: string
    try {
      xml = await this.odczyt.wywolaj('GiveMePackStatus', { PackCode: numer })
    } catch (e) {
      throw new AdapterError(e instanceof Error ? e.message : 'błąd odczytu statusu', e instanceof SourceError && e.retryable ? 'PRZEJSCIOWY' : 'TRWALY')
    }
    const rec = rekordy(xml).find((r) => 'Trans' in r || 'Err' in r)
    if (!rec) throw new AdapterError('Orlen Paczka: odpowiedź bez statusu paczki', 'TRWALY')
    const blad = kodLiczbowy(rec['Err'])
    if (blad !== null && blad !== 0) {
      const w = wynikKodu(blad, 'odczyt')
      if (w.kind !== 'OK') throw new AdapterError(w.message, w.kind)
    }
    const kod = kodLiczbowy(rec['Trans'])
    if (kod === null) throw new AdapterError('Orlen Paczka: nieczytelny status paczki', 'TRWALY')
    if (rec['PackCode'] && rec['PackCode'] !== numer) throw new AdapterError('Orlen Paczka: status innej paczki niż pytana', 'TRWALY')
    return { numer, kod, opis: rec['Trans_Des'] || null, od: rec['Data'] || null, punkt: rec['Destination'] || null }
  }
}

const WYLACZONY = 'zapis wyłączony'
const CONTENT_TYPE: Record<LabelFormat, string> = { PDF: 'application/pdf', ZPL: 'text/plain', EPL: 'text/plain' }
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/

/** Wynik sprawdzenia numeru przy „Rozstrzygnij ręcznie” (kontrakt). */
export type PotwierdzenieOrlen = PotwierdzenieRecznego

type Etykieta = { kod: 'OK'; base64: string } | { kod: number; message: string; kind: 'PRZEJSCIOWY' | 'TRWALY' | 'NIEJEDNOZNACZNY' }

class OrlenZapisAdapter extends OrlenAdapter implements ShipmentCreator, ReferenceFinder {
  override readonly manifest: AdapterManifest = ORLEN_ZAPIS_MANIFEST
  private klient: OrlenZapis | null = null

  private get wlaczony(): boolean {
    return this.ctx.config['zapisWlaczony'] === true
  }

  /** Klient zapisu powstaje dopiero przy pierwszym użyciu i tylko przy włączonym zapisie. */
  private zapis(): OrlenZapis {
    if (!this.wlaczony) throw new AdapterError(WYLACZONY, 'TRWALY')
    this.klient ??= new OrlenZapis({ url: adresOrlen(this.ctx.config), auth: logowanie(this.ctx), fetchImpl: this.ctx.fetch, timeoutMs: NADANIE_TIMEOUT_MS, wylacznik: true })
    return this.klient
  }

  async createShipment(req: ShipmentCreateRequest, reference: string): Promise<WriteOutcome> {
    if (!this.wlaczony) return { kind: 'TRWALY', reference, message: WYLACZONY }
    if (req.carrier !== 'ORLEN_PACZKA') return { kind: 'TRWALY', reference, message: 'moduł Orlen Paczka nadaje tylko przesyłki przewoźnika „Orlen Paczka”' }
    const o = odbiorcaOrlen(req.recipient)
    if (!o.odbiorca) return { kind: 'TRWALY', reference, message: o.braki.includes('kraj') ? 'odbiorca spoza Polski: Orlen Paczka jest krajowa (kraj)' : `niepełne dane odbiorcy: ${o.braki.join(', ')}` }
    let surowy: unknown = null
    try {
      surowy = typeof this.ctx.config['nadawca'] === 'string' ? (JSON.parse(this.ctx.config['nadawca']) as unknown) : null
    } catch {
      return { kind: 'TRWALY', reference, message: 'nieczytelne dane nadawcy w konfiguracji' }
    }
    const z = parseNadawca({ nadawca: surowy as never })
    if (!z.nadawca) return { kind: 'TRWALY', reference, message: `brak danych nadawcy firmy: ${z.braki.join(', ')}` }
    const n = nadawcaOrlen(z.nadawca)
    if (!n.nadawca) return { kind: 'TRWALY', reference, message: `dane nadawcy firmy nie pasują do Orlen Paczki: ${n.braki.join(', ')} (Ustawienia → Dokumenty i faktury → Dane firmy)` }
    let params: ReturnType<typeof zlecenieOrlen>
    try {
      params = zlecenieOrlen(req.parcel, o.odbiorca, n.nadawca, { reference, potwierdzoneOstrzezenia: req.potwierdzoneOstrzezenia ?? [] })
    } catch (e) {
      return { kind: 'TRWALY', reference, message: e instanceof Error ? e.message : 'zła treść przesyłki' }
    }
    const r = await this.zapis().wywolaj('GenerateBusinessPack', params)
    if (!r.ok) return { kind: r.kind, reference, message: r.kind === 'NIEJEDNOZNACZNY' ? `${r.message}; ${BEZ_PONAWIANIA}` : r.message }
    const rec = rekordWyniku(r.xml)
    const kod = kodLiczbowy(rec?.['Err'])
    if (!rec || kod === null) return { kind: 'NIEJEDNOZNACZNY', reference, message: `Orlen Paczka: nieczytelna odpowiedź po nadaniu; ${BEZ_PONAWIANIA}` }
    const w = wynikKodu(kod, 'nadanie')
    if (w.kind !== 'OK') return { kind: w.kind, reference, message: w.message }
    const numer = (rec['PackCode_RUCH'] ?? '').trim()
    if (!NUMER_PACZKI_ORLEN_RE.test(numer)) return { kind: 'NIEJEDNOZNACZNY', reference, message: `Orlen Paczka: odpowiedź bez numeru paczki; ${BEZ_PONAWIANIA}` }
    const info = OrlenZapisAdapter.zmianaPunktu(String(params['DestinationCode'] ?? ''), (rec['DestinationCode'] ?? '').trim(), w.ostrzezenie)
    return { kind: 'OK', reference, externalRef: numer, ...(info ? { info } : {}) }
  }

  /**
   * kody 006/007/008 („zapisano, ale zmieniono kod punktu”, rozdz. 6 dokumentacji) albo inny
   * `DestinationCode` w odpowiedzi niż wysłany = informacja dla obsługi przy przesyłce. Orlen podstawia aktualny kod
   * punktu (np. pełny za uniwersalny XX-116263-00-00, pkt 3.5.2): ten sam numer punktu = ten sam punkt z nowym kodem.
   * Kod punktu nie jest daną osobową.
   */
  private static zmianaPunktu(wyslany: string, zwrocony: string, ostrzezenie: string | null): string | null {
    const zwr = /^[A-Z0-9]{1,4}-\d{1,10}-[A-Z0-9]{1,4}-[A-Z0-9]{1,4}$/i.test(zwrocony) ? zwrocony : null
    if (zwr && zwr.toUpperCase() !== wyslany.toUpperCase()) {
      const nr = (k: string) => k.split('-')[1] ?? ''
      return nr(zwr) === nr(wyslany)
        ? `Orlen Paczka zapisał paczkę z aktualnym kodem punktu odbioru ${zwr} (wybrany ${wyslany}, ten sam punkt); lista punktów w Kompletorze jest nieaktualna.`
        : `Orlen Paczka zmienił punkt odbioru na ${zwr} (wybrany ${wyslany}): paczka pojedzie do punktu ${zwr}, sprawdź, czy klient o tym wie.`
    }
    if (ostrzezenie) return `Orlen Paczka zapisał paczkę z ostrzeżeniem: ${ostrzezenie}.`
    return null
  }

  /** Etykieta jednej paczki (LabelPrintDuplicateListTwo); wynik z kodem Orlenu, bez rzucania przy odmowie Orlenu. */
  private async etykieta(numer: string, format: LabelFormat, timeoutMs?: number): Promise<Etykieta> {
    const r = await this.zapis().wywolaj('LabelPrintDuplicateListTwo', { Format: format, PackCodeList: [numer] }, timeoutMs)
    // Etykieta nie tworzy paczki: niepewny wynik wolno pobrać ponownie.
    if (!r.ok) return { kod: -1, message: r.message, kind: r.kind === 'TRWALY' ? 'TRWALY' : 'PRZEJSCIOWY' }
    const kod = kodLiczbowy(rekordWyniku(r.xml)?.['Err'])
    if (kod === null) return { kod: -1, message: 'Orlen Paczka: nieczytelna odpowiedź na pobranie etykiety', kind: 'PRZEJSCIOWY' }
    const w = wynikKodu(kod, 'odczyt')
    if (w.kind !== 'OK') return { kod, message: w.message, kind: w.kind }
    const dane = pole(r.xml, 'LabelData') ?? pole(r.xml, 'Label')
    if (!dane || dane === 'null' || !BASE64_RE.test(dane)) return { kod: -1, message: 'Orlen Paczka: odpowiedź bez etykiety', kind: 'TRWALY' }
    return { kod: 'OK', base64: dane.replace(/\s/g, '') }
  }

  async getLabel(externalRef: string, format: LabelFormat): Promise<{ contentType: string; base64: string }> {
    if (!this.wlaczony) throw new AdapterError(WYLACZONY, 'TRWALY')
    if (!NUMER_PACZKI_ORLEN_RE.test(externalRef)) throw new AdapterError('zły numer paczki Orlen Paczki (13 cyfr)', 'TRWALY')
    if (!(format in CONTENT_TYPE)) throw new AdapterError('zły format etykiety', 'TRWALY')
    const e = await this.etykieta(externalRef, format)
    if (e.kod !== 'OK') throw new AdapterError(e.message, e.kind === 'TRWALY' ? 'TRWALY' : 'PRZEJSCIOWY')
    return { contentType: CONTENT_TYPE[format], base64: e.base64 }
  }

  /** Anulowanie (PutCustomerPackCanceled): „już anulowana” = OK; sieć i błąd Orlenu = PRZEJSCIOWY (ponowienie bezpieczne). */
  async cancelShipment(externalRef: string, reference: string): Promise<WriteOutcome> {
    if (!this.wlaczony) return { kind: 'TRWALY', reference, message: WYLACZONY }
    if (!NUMER_PACZKI_ORLEN_RE.test(externalRef)) return { kind: 'TRWALY', reference, message: 'zły numer paczki Orlen Paczki (13 cyfr)' }
    const r = await this.zapis().wywolaj('PutCustomerPackCanceled', { PackCode: externalRef })
    if (!r.ok) return { kind: r.kind === 'TRWALY' ? 'TRWALY' : 'PRZEJSCIOWY', reference, message: r.message }
    const kod = kodLiczbowy(rekordWyniku(r.xml)?.['Err'])
    if (kod === null) return { kind: 'PRZEJSCIOWY', reference, message: 'Orlen Paczka: nieczytelna odpowiedź na anulowanie' }
    const w = wynikKodu(kod, 'anulowanie')
    if (w.kind !== 'OK') return { kind: w.kind === 'NIEJEDNOZNACZNY' ? 'PRZEJSCIOWY' : w.kind, reference, message: w.message }
    return { kind: 'OK', reference, externalRef }
  }

  /** Czy etykieta ZPL paczki niesie odcisk referencji (`SenderOrders`) [NIEPEWNE: tekst pola w ZPL do sandboxa]. */
  private static maOdcisk(base64: string, odcisk: string): boolean {
    return Buffer.from(base64, 'base64').toString('latin1').toUpperCase().includes(odcisk)
  }

  /**
   * Paczki nadane przez API tego konta od przedwczoraj do jutra (GetGeneratedParcels, tylko odczyt), najnowsze najpierw.
   * Odmowa Orlenu i błąd sieci = wyjątek (PRZEJSCIOWY albo TRWALY).
   */
  private async paczkiZOkna(): Promise<OknoPaczek> {
    const teraz = (this.ctx.now ?? (() => new Date()))()
    const od = dzienPl(new Date(teraz.getTime() - 2 * 86_400_000))
    const doDnia = dzienPl(new Date(teraz.getTime() + 86_400_000))
    let xml: string
    try {
      xml = await this.odczyt.wywolaj('GetGeneratedParcels', { dateFrom: od, dateTo: doDnia })
    } catch (e) {
      throw new AdapterError(`Orlen Paczka: lista nadanych paczek niedostępna (${e instanceof Error ? e.message : 'błąd'})`, e instanceof SourceError && e.retryable ? 'PRZEJSCIOWY' : 'TRWALY')
    }
    const wiersze = rekordy(xml)
    const odmowa = wiersze.find((r) => 'Err' in r && kodLiczbowy(r['Err']) !== 0 && !r['PackCode_RUCH'])
    if (odmowa) {
      const w = wynikKodu(kodLiczbowy(odmowa['Err']) ?? -1, 'odczyt')
      throw new AdapterError(`Orlen Paczka: lista nadanych paczek odrzucona (${w.kind === 'OK' ? 'kod' : w.message})`, w.kind === 'PRZEJSCIOWY' ? 'PRZEJSCIOWY' : 'TRWALY')
    }
    const paczki = [...new Map(wiersze.filter((r) => NUMER_PACZKI_ORLEN_RE.test(r['PackCode_RUCH'] ?? '')).map((r) => [r['PackCode_RUCH']!, r['Data'] ?? ''])).entries()]
      .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
      .map(([numer, data]) => ({ numer, data }))
    return { paczki, od: dzienKrotko(od), do: dzienKrotko(doDnia) }
  }

  /** „2100000000012 08.11 10:59, …” do komunikatu (same numery i godziny, bez danych odbiorcy). */
  private static wykaz(paczki: readonly PaczkaZApi[]): string {
    return paczki.map((p) => `${p.numer} ${godzinaNadania(p.data)}`).join(', ')
  }

  /**
   * Odszukanie paczki po referencji hosta: numery nadane przez API od przedwczoraj do jutra (GetGeneratedParcels,
   * najnowsze najpierw, najwyżej ODSZUKANIE_LIMIT) i etykieta ZPL każdego z nich z odciskiem w `SenderOrders`. Jedno
   * trafienie = paczka potwierdzona. Kilka trafień = człowiek. Brak trafienia = błąd (PRZEJSCIOWY, gdy część etykiet
   * nie była jeszcze gotowa; inaczej TRWALY), nigdy `found: false`: niepotwierdzony kształt etykiety nie jest dowodem.
   * komunikat TRWALY podaje okno i wykaz sprawdzonych paczek (numer i godzina nadania), żeby
   * człowiek rozpoznał paczkę bez zamówienia, zamiast szukać jej w panelu Orlenu, w którym paczek z API nie widać.
   */
  async findByReference(reference: string): Promise<ReferenceLookup> {
    if (!this.wlaczony) throw new AdapterError(WYLACZONY, 'TRWALY')
    let odcisk: string
    try {
      odcisk = odciskReferencji(reference)
    } catch {
      throw new AdapterError('zła referencja paczki Orlen Paczki', 'TRWALY')
    }
    const okno = await this.paczkiZOkna()
    const dni = `${okno.od}–${okno.do}`
    if (!okno.paczki.length) throw new AdapterError(`Orlen Paczka nie pokazuje żadnej paczki nadanej przez API w dniach ${dni}; to nie jest dowód, że paczka nie powstała`, 'TRWALY')
    const sprawdzane = okno.paczki.slice(0, ODSZUKANIE_LIMIT)
    const reszta = okno.paczki.length - sprawdzane.length
    const trafione: string[] = []
    let niegotowe = 0
    for (const p of sprawdzane) {
      const e = await this.etykieta(p.numer, 'ZPL', ODSZUKANIE_TIMEOUT_MS)
      if (e.kod === 'OK') {
        if (OrlenZapisAdapter.maOdcisk(e.base64, odcisk)) trafione.push(p.numer)
      } else if (e.kind === 'PRZEJSCIOWY') niegotowe++
    }
    if (trafione.length > 1) throw new AdapterError(`Orlen Paczka: kilka paczek z referencją tej przesyłki (${trafione.join(', ')}), potrzebny człowiek`, 'TRWALY')
    if (trafione.length === 1) return { found: true, externalRef: trafione[0]! }
    if (niegotowe) throw new AdapterError('Orlen Paczka: część etykiet ostatnich paczek nie jest jeszcze gotowa, nie da się potwierdzić paczki; spróbuj „Sprawdź u przewoźnika” za minutę', 'PRZEJSCIOWY')
    throw new AdapterError(
      `Orlen Paczka: żadna z ${sprawdzane.length} najnowszych paczek nadanych przez API w dniach ${dni} nie ma na etykiecie referencji tej przesyłki. Sprawdzone: ${OrlenZapisAdapter.wykaz(sprawdzane)}${reszta ? ` (starszych niesprawdzonych: ${reszta})` : ''}. Paczka z tej listy bez zamówienia w Kompletorze może być tą paczką: wtedy nie wybieraj „Nie powstała”.`,
      'TRWALY',
    )
  }

  /**
   * Numer paczki wpisany przy „Rozstrzygnij ręcznie”. Najpierw cyfra kontrolna EAN-13 (literówka odpada bez zapytania).
   * Potem etykieta tej paczki musi nieść odcisk referencji tej przesyłki (paczka utworzona przez Kompletor dla tego
   * zamówienia). Paczka już w drodze nie ma duplikatu etykiety (kod 213), wtedy numer musi być na
   * liście paczek nadanych przez API tego konta (GetGeneratedParcels, to samo okno co przy odszukaniu), inaczej
   * odmowa; przy przyjęciu `info` mówi wprost, że referencji nie porównano (GiveMePackStatus nie dowodzi, że paczka
   * jest z konta firmy: pkt 4.23 to kształt publicznego śledzenia). Odmowa Orlenu = odmowa bez zapisu; sieć i dane
   * jeszcze niegotowe = wyjątek PRZEJSCIOWY (host: „spróbuj ponownie”).
   */
  async confirmManual(identyfikator: string, reference: string): Promise<PotwierdzenieOrlen> {
    if (!this.wlaczony) return { odmowa: 'Nadawanie Orlen Paczki jest wyłączone w ustawieniach przewoźnika: Kompletor nie może sprawdzić numeru w Orlen Paczce.' }
    const numer = identyfikator.trim()
    if (!NUMER_PACZKI_ORLEN_RE.test(numer)) return { odmowa: 'Podaj 13-cyfrowy numer paczki z Orlen Paczki (same cyfry).' }
    if (!ean13Poprawny(numer)) return { odmowa: `Numer ${numer} ma złą cyfrę kontrolną (ostatnia cyfra numeru paczki): sprawdź, czy nie ma literówki. Nic nie zapisano.` }
    const e = await this.etykieta(numer, 'ZPL')
    if (e.kod === 'OK') {
      if (OrlenZapisAdapter.maOdcisk(e.base64, odciskReferencji(reference))) return { externalRef: numer, info: 'Sprawdzone w Orlen Paczce: etykieta tej paczki ma referencję tej przesyłki.', referencjaSprawdzona: true }
      return { odmowa: `Paczka ${numer} w Orlen Paczce nie ma na etykiecie referencji tej przesyłki: to inna paczka albo nie utworzył jej Kompletor. Nic nie zapisano.` }
    }
    if (e.kod === 213) {
      const okno = await this.paczkiZOkna()
      const p = okno.paczki.find((x) => x.numer === numer)
      if (!p)
        return {
          odmowa: `Paczka ${numer} jest już w drodze (Orlen nie wydaje duplikatu jej etykiety), a na liście paczek nadanych przez API tego konta w dniach ${okno.od}–${okno.do} jej nie ma: to nie jest paczka tej przesyłki albo numer ma literówkę. Nic nie zapisano.`,
        }
      return {
        externalRef: numer,
        info: `Paczka ${numer} jest na liście paczek nadanych przez API tego konta (${godzinaNadania(p.data)}) i jest już w drodze, więc Orlen nie wydaje duplikatu etykiety: referencji tej przesyłki na etykiecie nie porównano.`,
      }
    }
    if (e.kind === 'TRWALY') return { odmowa: `Orlen Paczka nie potwierdził paczki ${numer} (${e.message}). Nic nie zapisano.` }
    throw new AdapterError(e.message, 'PRZEJSCIOWY')
  }
}

export const ORLEN_DEFINITION: AdapterDefinition = { manifest: ORLEN_MANIFEST, create: (ctx) => new OrlenAdapter(ctx) }
export const ORLEN_ZAPIS_DEFINITION: AdapterDefinition = { manifest: ORLEN_ZAPIS_MANIFEST, create: (ctx) => new OrlenZapisAdapter(ctx) }
