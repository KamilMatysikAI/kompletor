// Sesja interaktywna KSeF API 2.x: otwarcie, wysyłka faktury, status, UPO, zamknięcie. Pochodzenie: nasz
// kod z systemu najmu (packages/ksef/src/online/session.ts) w wersji z DewFlow (lib/ksef/online/session.ts), działający
// produkcyjnie; logika bez zmian, odczyt błędu z ./bledy.ts.
//
// Kod sieciowy idzie WYŁĄCZNIE przez `KsefTransport`: w aplikacji `KsefPolaczenie` (./polaczenie.ts: uwierzytelnione,
// z bramką środowiska), w testach atrapa z nagranymi odpowiedziami KSeF TEST (tests/ksef-atrapa.ts).
//
// Przebieg: POST /sessions/online (klucz AES zaszyfrowany kluczem MF) → POST /sessions/online/{sesja}/invoices
// (faktura AES-256-CBC) → GET /sessions/{sesja}/invoices/{faktura} aż do statusu końcowego → GET …/upo →
// POST /sessions/online/{sesja}/close.
import { readKsefError } from './bledy'
import {
  createSessionEncryption,
  encryptInvoice,
  pickPublicKeyCertificate,
  type KsefPublicKeyCertificate,
  type SessionEncryption,
  type SessionPublicKey,
} from './szyfrowanie'

/** Żądanie do API KSeF względem bazowego URL środowiska (`…/v2`). `auth: false` — zasób
 *  publiczny, bez tokena dostępowego (np. klucze publiczne MF). */
export type KsefRequestInit = RequestInit & { auth?: boolean }

export interface KsefTransport {
  request(path: string, init?: KsefRequestInit): Promise<Response>
}

/** Kod formularza FA(3) — to, co buduje `buildFa3Xml`. */
export const FA3_FORM_CODE = { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' } as const
export type KsefFormCode = { systemCode: string; schemaVersion: string; value: string }

/** Błąd HTTP z API KSeF — `status` pozwala odróżnić odrzucenie żądania (4xx: faktura na pewno
 *  NIE została przyjęta) od awarii sieci/serwera (stan nieznany). */
export class KsefHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'KsefHttpError'
    this.status = status
  }
}

async function ensureOk(res: Response, action: string, expected: number[] = []): Promise<Response> {
  if (res.ok || expected.includes(res.status)) return res
  const detail = await readKsefError(res)
  throw new KsefHttpError(res.status, `KSeF — ${action}: HTTP ${res.status} — ${detail}`)
}

export type KsefStatusInfo = {
  code: number
  description: string
  details?: string[] | null
  extensions?: Record<string, string | null> | null
}

/** Odpowiedź GET /sessions/{sesja}/invoices/{faktura} (`SessionInvoiceStatusResponse`). */
export type KsefInvoiceStatus = {
  ordinalNumber: number
  referenceNumber: string
  invoiceNumber?: string | null
  ksefNumber?: string | null
  invoiceHash: string
  invoicingDate: string
  acquisitionDate?: string | null
  permanentStorageDate?: string | null
  upoDownloadUrl?: string | null
  upoDownloadUrlExpirationDate?: string | null
  status: KsefStatusInfo
}

export type KsefInvoiceOutcome =
  | { state: 'pending'; code: number; message: string }
  | { state: 'accepted'; ksefNumber: string; acquisitionDate?: string }
  /** 440: ta sama faktura (NIP sprzedawcy + rodzaj + numer) JEST już w KSeF — wynik
   *  wcześniejszej wysyłki. Dla nas: przyjęta, z numerem KSeF oryginału. */
  | { state: 'duplicate'; ksefNumber: string | null; originalSessionReferenceNumber: string | null; message: string }
  | { state: 'rejected'; code: number; message: string }

/** „[450] Opis — szczegół; szczegół” — do zapisania przy fakturze (`Invoice.ksefError`). */
export function formatKsefStatus(status: KsefStatusInfo): string {
  const details = status.details?.filter(Boolean) ?? []
  return `[${status.code}] ${status.description}${details.length ? ` — ${details.join('; ')}` : ''}`
}

/** Tłumaczy kod statusu faktury na stan (tabela kodów w OpenAPI, `SessionInvoiceStatusResponse`):
 *  100/150 w toku, 200 sukces, 440 duplikat, pozostałe (405, 410, 415, 430, 435, 450, 500, 550) — odrzucenie. */
export function interpretInvoiceStatus(s: KsefInvoiceStatus): KsefInvoiceOutcome {
  const { code } = s.status
  if (code === 100 || code === 150) return { state: 'pending', code, message: formatKsefStatus(s.status) }
  if (code === 200) {
    if (!s.ksefNumber) return { state: 'pending', code, message: 'KSeF: sukces bez numeru KSeF — ponów odczyt statusu' }
    const out: KsefInvoiceOutcome = { state: 'accepted', ksefNumber: s.ksefNumber }
    if (s.acquisitionDate) out.acquisitionDate = s.acquisitionDate
    return out
  }
  if (code === 440) {
    return {
      state: 'duplicate',
      ksefNumber: s.status.extensions?.originalKsefNumber ?? null,
      originalSessionReferenceNumber: s.status.extensions?.originalSessionReferenceNumber ?? null,
      message: formatKsefStatus(s.status),
    }
  }
  return { state: 'rejected', code, message: formatKsefStatus(s.status) }
}

export type WaitOptions = {
  intervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Odpytuje status aż do wyniku końcowego albo limitu czasu. Po limicie zwraca `pending`
 *  (nie rzuca) — faktura zostaje w stanie „wysłana”, a status dociągnie kolejny przebieg. */
export async function waitForInvoiceOutcome(
  getStatus: () => Promise<KsefInvoiceStatus>,
  opts: WaitOptions = {},
): Promise<{ outcome: KsefInvoiceOutcome; status: KsefInvoiceStatus }> {
  const intervalMs = opts.intervalMs ?? 2_000
  const timeoutMs = opts.timeoutMs ?? 60_000
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const deadline = now() + timeoutMs
  for (;;) {
    const status = await getStatus()
    const outcome = interpretInvoiceStatus(status)
    if (outcome.state !== 'pending' || now() + intervalMs > deadline) return { outcome, status }
    await sleep(intervalMs)
  }
}

export async function fetchPublicKeyCertificates(transport: KsefTransport): Promise<KsefPublicKeyCertificate[]> {
  const res = await ensureOk(
    await transport.request('/security/public-key-certificates', { method: 'GET', auth: false }),
    'pobranie kluczy publicznych MF',
  )
  return (await res.json()) as KsefPublicKeyCertificate[]
}

export async function getSessionInvoiceStatus(
  transport: KsefTransport,
  sessionReferenceNumber: string,
  invoiceReferenceNumber: string,
): Promise<KsefInvoiceStatus> {
  const res = await ensureOk(
    await transport.request(
      `/sessions/${encodeURIComponent(sessionReferenceNumber)}/invoices/${encodeURIComponent(invoiceReferenceNumber)}`,
      { method: 'GET' },
    ),
    `status faktury ${invoiceReferenceNumber}`,
  )
  return (await res.json()) as KsefInvoiceStatus
}

/** Wynik szukania faktury w liście faktur sesji. */
export type ZnalezionaWSesji = { stan: 'znaleziona'; faktura: KsefInvoiceStatus } | { stan: 'inna_tresc'; faktura: KsefInvoiceStatus } | { stan: 'brak' }

/**
 * Faktura sesji o danym numerze (P_2) z listy GET /sessions/{sesja}/invoices: dubel
 * 440 bez `originalKsefNumber` → numer KSeF i referencja oryginału z jego sesji. Stronicowanie nagłówkiem
 * `x-continuation-token` (odpowiedź: `invoices`, `continuationToken`, jak w przykładach CIRFMF/ksef-docs), najwyżej
 * `maxStron` stron.
 *
 * Dopasowanie: numer + sukces (200) + numer KSeF, a gdy znamy hashe naszych wysłanych XML-i
 * (`hashe`), także `invoiceHash` (SHA-256 treści liczony przez KSeF, ten sam co nasz lokalny). Numer zgodny, a hash
 * żaden z naszych = `inna_tresc`: faktura o tym numerze przyszła z innej treści (np. inny program na tym samym NIP-ie
 * albo zmienione dane), więc numeru KSeF NIE przypisujemy, sprawdza człowiek. Bez hashy (wiersze)
 * dodatkowy warunek: KSeF przyjął ją nie wcześniej niż dzień wystawienia u nas (`invoicingDate` to chwila przyjęcia
 * w KSeF, nie data wystawienia P_1: nagranie TEST, oryginał i dubel różnią się `invoicingDate` o 2 s).
 */
export async function znajdzFaktureWSesji(
  transport: KsefTransport,
  sessionReferenceNumber: string,
  invoiceNumber: string,
  opts: { pageSize?: number; maxStron?: number; hashe?: readonly string[]; dataWystawienia?: string | null } = {},
): Promise<ZnalezionaWSesji> {
  const hashe = new Set(opts.hashe ?? [])
  let token: string | null = null
  let inna: KsefInvoiceStatus | null = null
  for (let strona = 0; strona < (opts.maxStron ?? 10); strona++) {
    const res = await ensureOk(
      await transport.request(`/sessions/${encodeURIComponent(sessionReferenceNumber)}/invoices?pageSize=${opts.pageSize ?? 100}`, {
        method: 'GET',
        headers: token ? { 'x-continuation-token': token } : {},
      }),
      `lista faktur sesji ${sessionReferenceNumber}`,
    )
    const body = (await res.json()) as { invoices?: KsefInvoiceStatus[] | null; continuationToken?: string | null }
    for (const x of body.invoices ?? []) {
      if (x.invoiceNumber !== invoiceNumber || x.status?.code !== 200 || !x.ksefNumber) continue
      const zgodna = hashe.size ? hashe.has(x.invoiceHash) : !opts.dataWystawienia || !x.invoicingDate || dzienWarszawa(x.invoicingDate) >= opts.dataWystawienia
      if (zgodna) return { stan: 'znaleziona', faktura: x }
      inna ??= x
    }
    token = body.continuationToken ?? null
    if (!token) break
  }
  return inna ? { stan: 'inna_tresc', faktura: inna } : { stan: 'brak' }
}

/** Dzień (RRRR-MM-DD) w strefie Europe/Warsaw z chwili ISO; nieczytelna data = '' (warunek wtedy nie przechodzi). */
function dzienWarszawa(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t))
}

/** UPO faktury po numerze referencyjnym faktury (XML jako tekst, do zapisania w `Invoice.upoXml`). */
export async function downloadInvoiceUpo(
  transport: KsefTransport,
  sessionReferenceNumber: string,
  invoiceReferenceNumber: string,
): Promise<string> {
  const res = await ensureOk(
    await transport.request(
      `/sessions/${encodeURIComponent(sessionReferenceNumber)}/invoices/${encodeURIComponent(invoiceReferenceNumber)}/upo`,
      { method: 'GET', headers: { Accept: 'application/xml' } },
    ),
    `pobranie UPO faktury ${invoiceReferenceNumber}`,
  )
  return res.text()
}

/** UPO faktury po numerze KSeF — dla duplikatu (440) z sesji oryginalnej wysyłki. */
export async function downloadInvoiceUpoByKsefNumber(
  transport: KsefTransport,
  sessionReferenceNumber: string,
  ksefNumber: string,
): Promise<string> {
  const res = await ensureOk(
    await transport.request(
      `/sessions/${encodeURIComponent(sessionReferenceNumber)}/invoices/ksef/${encodeURIComponent(ksefNumber)}/upo`,
      { method: 'GET', headers: { Accept: 'application/xml' } },
    ),
    `pobranie UPO faktury ${ksefNumber}`,
  )
  return res.text()
}

export type OpenSessionOptions = {
  formCode?: KsefFormCode
  /** Klucz MF podany z zewnątrz (testy); domyślnie pobierany z API. */
  publicKey?: SessionPublicKey
  now?: Date
}

export type SentInvoice = { referenceNumber: string; invoiceHash: string }

export class KsefOnlineSession {
  readonly referenceNumber: string
  readonly validUntil: string
  private readonly transport: KsefTransport
  private readonly encryption: SessionEncryption

  private constructor(transport: KsefTransport, referenceNumber: string, validUntil: string, encryption: SessionEncryption) {
    this.transport = transport
    this.referenceNumber = referenceNumber
    this.validUntil = validUntil
    this.encryption = encryption
  }

  static async open(transport: KsefTransport, opts: OpenSessionOptions = {}): Promise<KsefOnlineSession> {
    const mfKey =
      opts.publicKey ??
      pickPublicKeyCertificate(await fetchPublicKeyCertificates(transport), 'SymmetricKeyEncryption', opts.now)
    const encryption = createSessionEncryption(mfKey)
    const res = await ensureOk(
      await transport.request('/sessions/online', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formCode: opts.formCode ?? FA3_FORM_CODE, encryption: encryption.info }),
      }),
      'otwarcie sesji interaktywnej',
    )
    const body = (await res.json()) as { referenceNumber: string; validUntil: string }
    return new KsefOnlineSession(transport, body.referenceNumber, body.validUntil, encryption)
  }

  /** Wysyła fakturę. 202 = przyjęta DO PRZETWARZANIA (nie „przyjęta w KSeF”) — wynik daje status. */
  async sendInvoice(xml: string): Promise<SentInvoice> {
    const payload = encryptInvoice(xml, this.encryption)
    const res = await ensureOk(
      await this.transport.request(`/sessions/online/${encodeURIComponent(this.referenceNumber)}/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, offlineMode: false }),
      }),
      'wysłanie faktury',
    )
    const body = (await res.json()) as { referenceNumber: string }
    return { referenceNumber: body.referenceNumber, invoiceHash: payload.invoiceHash }
  }

  getInvoiceStatus(invoiceReferenceNumber: string): Promise<KsefInvoiceStatus> {
    return getSessionInvoiceStatus(this.transport, this.referenceNumber, invoiceReferenceNumber)
  }

  waitForInvoice(invoiceReferenceNumber: string, opts?: WaitOptions) {
    return waitForInvoiceOutcome(() => this.getInvoiceStatus(invoiceReferenceNumber), opts)
  }

  downloadInvoiceUpo(invoiceReferenceNumber: string): Promise<string> {
    return downloadInvoiceUpo(this.transport, this.referenceNumber, invoiceReferenceNumber)
  }

  /** Zamyka sesję (MF generuje zbiorcze UPO sesji). Faktury już przyjęte zostają w KSeF. */
  async close(): Promise<void> {
    await ensureOk(
      await this.transport.request(`/sessions/online/${encodeURIComponent(this.referenceNumber)}/close`, { method: 'POST' }),
      'zamknięcie sesji interaktywnej',
      [204],
    )
  }
}
