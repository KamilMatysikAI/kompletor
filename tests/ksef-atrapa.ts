// Atrapa KSeF TEST: `FetchLike` odpowiadający jak API KSeF 2.x na ścieżce tokenu i sesji interaktywnej.
// Odpowiedzi z nagrań (tests/ksef-nagrania/, przykłady OpenAPI środowiska TEST); podmienia tylko numery referencyjne
// i numer KSeF. Klucz „MF” to certyfikat testowy atrapy: atrapa odszyfrowuje klucz sesji i fakturę, czyta P_2 (numer)
// i jak prawdziwy KSeF odrzuca dubel (ten sam NIP sprzedawcy, rodzaj i numer) kodem 440 z numerem KSeF oryginału.
// Zero połączeń z siecią: każdy adres spoza https://api-test.ksef.mf.gov.pl/v2 kończy się wyjątkiem.
import { constants, createDecipheriv, createHash, privateDecrypt, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildTestSealCertificate } from './ksef-certyfikat-testowy'

const nagranie = (n: string) => JSON.parse(readFileSync(path.join(__dirname, 'ksef-nagrania', n), 'utf8'))
const BAZA = 'https://api-test.ksef.mf.gov.pl/v2'

export interface FakturaWAtrapie {
  numer: string
  rodzaj: string
  ksefNumer: string
  sesja: string
  ref: string
  xml: string
  /** SHA-256 (base64) XML-a, jak `invoiceHash` w KSeF. */
  hash: string
}

export interface OpcjeAtrapy {
  /** Kod statusu przetwarzania dla kolejnych faktur (domyślnie 200). 450 = odrzucenie treści. */
  kodStatusu?: number
  /** Ile odpytań statusu zwraca 150 („trwa przetwarzanie”) przed wynikiem. */
  przetwarzanie?: number
  /** Pierwsza wysyłka faktury: KSeF ją przyjmuje, ale odpowiedź „ginie” (wyjątek sieci po stronie klienta). */
  zgubOdpowiedzWysylki?: number
  /** Odrzucenie tokenu przy uwierzytelnieniu (HTTP 401). */
  zlyToken?: boolean
  /** Ile odpytań statusu uwierzytelnienia zwraca 100 („w toku”) przed 200; `Infinity` = bez końca. */
  uwierzytelnienieWToku?: number
  /** Ile kolejnych odczytów statusu faktury (GET /sessions/…/invoices/{ref}) kończy się tym kodem HTTP. */
  bladStatusu?: { kod: number; ile: number; retryAfter?: string }
  /** Ile kolejnych żądań GET kończy się błędem sieci (wyjątek fetch), np. przy kluczach publicznych. */
  bledySieciGet?: number
  /** Dubel 440 bez `originalKsefNumber` (i bez numeru sesji oryginału, gdy `bezSesjiOryginalu`). */
  dubelBezNumeru?: boolean
  bezSesjiOryginalu?: boolean
  /** Ile pobrań UPO kończy się HTTP 500. */
  bladUpo?: number
  /** ile kolejnych wysyłek faktury (POST …/invoices) kończy się tym kodem HTTP BEZ przyjęcia faktury. */
  bladWysylki?: { kod: number; ile: number }
  /** lista faktur sesji podaje obcy `invoiceHash` (faktura o tym numerze z inną treścią). */
  obcyHashWLiscie?: boolean
  /** atrapa obsługuje odświeżenie tokenu dostępowego (POST /auth/token/refresh). */
  odswiezanie?: boolean
}

export function atrapaKsef(o: OpcjeAtrapy = {}) {
  const cert = buildTestSealCertificate('5260250274', 'Atrapa MF')
  const der = new X509Certificate(cert.certPem).raw.toString('base64')
  // stałe daty: testy podają własne „teraz” (także z przeszłości), certyfikat atrapy ma być ważny w każdym z nich
  const od = '2020-01-01T00:00:00.000Z'
  const doD = '2099-12-31T00:00:00.000Z'
  const klucze = [
    { certificate: der, publicKeyId: 'atrapa-token', validFrom: od, validTo: doD, usage: ['KsefTokenEncryption'] },
    { certificate: der, publicKeyId: 'atrapa-sesja', validFrom: od, validTo: doD, usage: ['SymmetricKeyEncryption'] },
  ]
  const sesje = new Map<string, { key: Buffer; iv: Buffer; otwarta: boolean }>()
  const faktury: FakturaWAtrapie[] = []
  const statusy = new Map<string, { kod: number; pytania: number; dubelZ?: FakturaWAtrapie; numer: string; hash: string }>()
  const wywolania: string[] = []
  let licznik = 0
  let zgubic = o.zgubOdpowiedzWysylki ?? 0
  let auth100 = o.uwierzytelnienieWToku ?? 0
  let bladStatusu = o.bladStatusu?.ile ?? 0
  let bledySieci = o.bledySieciGet ?? 0
  let bladUpo = o.bladUpo ?? 0
  let bladWysylki = o.bladWysylki?.ile ?? 0
  const hashXml = (xml: string) => createHash('sha256').update(Buffer.from(xml, 'utf8')).digest('base64')
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const id = (p: string) => `20261109-${p}-${String(++licznik).padStart(10, '0')}-ATRAPA-00`

  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (!url.startsWith(`${BAZA}/`)) throw new Error(`atrapa KSeF: adres spoza KSeF TEST: ${url}`)
    const metoda = (init.method ?? 'GET').toUpperCase()
    const sciezka = url.slice(BAZA.length)
    wywolania.push(`${metoda} ${sciezka}`)
    if (metoda === 'GET' && bledySieci > 0) {
      bledySieci--
      throw new Error('atrapa: zerwane połączenie (GET)')
    }
    const auth = (init.headers as Record<string, string> | undefined)?.['Authorization'] ?? ''
    if (metoda === 'POST' && sciezka === '/auth/challenge') return json(200, { challenge: id('CR'), timestamp: new Date().toISOString(), timestampMs: Date.now() })
    if (metoda === 'GET' && sciezka === '/security/public-key-certificates') return json(200, klucze)
    if (metoda === 'POST' && sciezka === '/auth/ksef-token') {
      if (o.zlyToken) return json(401, { exception: { exceptionDetailList: [{ exceptionCode: 21301, exceptionDescription: 'Brak autoryzacji.' }] } })
      const b = JSON.parse(String(init.body))
      // token musi dać się odszyfrować kluczem atrapy (RSA-OAEP SHA-256) i mieć postać „token|znacznik”
      const tok = privateDecrypt({ key: cert.keyPem, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(b.encryptedToken, 'base64')).toString('utf8')
      if (!/^.+\|\d+$/.test(tok) || b.contextIdentifier?.type !== 'Nip') return json(400, nagranie('error-400-exception.json'))
      return json(202, { referenceNumber: id('AU'), authenticationToken: { token: 'atrapa-auth' } })
    }
    if (metoda === 'GET' && sciezka.startsWith('/auth/') && auth === 'Bearer atrapa-auth') {
      if (auth100 > 0) {
        auth100--
        return json(200, { status: { code: 100, description: 'Uwierzytelnianie w toku' } })
      }
      return json(200, { status: { code: 200, description: 'Uwierzytelnianie zakończone sukcesem' } })
    }
    if (metoda === 'POST' && sciezka === '/auth/token/redeem') return json(200, { accessToken: { token: 'atrapa-dostep' }, refreshToken: { token: 'atrapa-odswiez' } })
    if (metoda === 'POST' && sciezka === '/auth/token/refresh' && o.odswiezanie && auth === 'Bearer atrapa-odswiez') return json(200, { accessToken: { token: 'atrapa-dostep' } })
    if (auth !== 'Bearer atrapa-dostep') return json(401, { exception: { exceptionDetailList: [{ exceptionCode: 21301, exceptionDescription: 'Brak autoryzacji.' }] } })

    if (metoda === 'POST' && sciezka === '/sessions/online') {
      const b = JSON.parse(String(init.body))
      const key = privateDecrypt({ key: cert.keyPem, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(b.encryption.encryptedSymmetricKey, 'base64'))
      const ref = id('SO')
      sesje.set(ref, { key, iv: Buffer.from(b.encryption.initializationVector, 'base64'), otwarta: true })
      return json(201, { ...nagranie('open-session-201.json'), referenceNumber: ref })
    }
    let m = /^\/sessions\/online\/([^/]+)\/invoices$/.exec(sciezka)
    if (metoda === 'POST' && m) {
      const s = sesje.get(decodeURIComponent(m[1]!))
      if (!s?.otwarta) return json(400, nagranie('error-400-exception.json'))
      if (bladWysylki > 0) {
        bladWysylki--
        return json(o.bladWysylki!.kod, { exception: { exceptionDetailList: [{ exceptionCode: o.bladWysylki!.kod, exceptionDescription: 'Atrapa: wysyłka nieprzyjęta' }] } })
      }
      const b = JSON.parse(String(init.body))
      const d = createDecipheriv('aes-256-cbc', s.key, s.iv)
      const xml = Buffer.concat([d.update(Buffer.from(b.encryptedInvoiceContent, 'base64')), d.final()]).toString('utf8')
      const numer = /<P_2>([^<]+)<\/P_2>/.exec(xml)?.[1] ?? '?'
      const rodzaj = /<RodzajFaktury>([^<]+)<\/RodzajFaktury>/.exec(xml)?.[1] ?? '?'
      const ref = id('EE')
      const hash = hashXml(xml)
      if (b.invoiceHash !== hash) return json(400, nagranie('error-400-exception.json')) // hash klienta = hash treści
      const byla = faktury.find((f) => f.numer === numer && f.rodzaj === rodzaj)
      if (byla) statusy.set(ref, { kod: 440, pytania: 0, dubelZ: byla, numer, hash })
      else {
        const kod = o.kodStatusu ?? 200
        if (kod === 200) faktury.push({ numer, rodzaj, ksefNumer: `5260250274-20261109-${String(faktury.length + 1).padStart(12, '0')}-AA`, sesja: decodeURIComponent(m[1]!), ref, xml, hash })
        statusy.set(ref, { kod, pytania: 0, numer, hash })
      }
      if (zgubic > 0) {
        zgubic--
        throw new Error('atrapa: zerwane połączenie po przyjęciu faktury')
      }
      return json(202, { ...nagranie('send-invoice-202.json'), referenceNumber: ref })
    }
    m = /^\/sessions\/([^/]+)\/invoices\?pageSize=\d+$/.exec(sciezka)
    if (metoda === 'GET' && m) {
      const sesja = decodeURIComponent(m[1]!)
      const w = faktury.filter((f) => f.sesja === sesja)
      return json(200, { continuationToken: null, invoices: w.map((f) => ({ ...nagranie('invoice-status-200.json'), referenceNumber: f.ref, invoiceNumber: f.numer, ksefNumber: f.ksefNumer, invoiceHash: o.obcyHashWLiscie ? 'obcy-hash' : f.hash })) })
    }
    m = /^\/sessions\/([^/]+)\/invoices\/([^/]+)$/.exec(sciezka)
    if (metoda === 'GET' && m) {
      if (bladStatusu > 0) {
        bladStatusu--
        return new Response(JSON.stringify({ status: { code: o.bladStatusu!.kod, description: 'Atrapa: błąd odczytu stanu', details: ['Spróbuj ponownie po 7 sekundach.'] } }), {
          status: o.bladStatusu!.kod,
          headers: { 'Content-Type': 'application/json', ...(o.bladStatusu!.retryAfter ? { 'Retry-After': o.bladStatusu!.retryAfter } : {}) },
        })
      }
      const st = statusy.get(decodeURIComponent(m[2]!))
      if (!st) return json(404, { exception: { exceptionDetailList: [{ exceptionCode: 21404, exceptionDescription: 'Nie znaleziono.' }] } })
      if (st.pytania++ < (o.przetwarzanie ?? 0)) return json(200, { ...nagranie('invoice-status-150.json'), referenceNumber: m[2], invoiceNumber: st.numer, invoiceHash: st.hash })
      if (st.kod === 200) {
        const f = faktury.find((x) => x.ref === decodeURIComponent(m![2]!))!
        return json(200, { ...nagranie('invoice-status-200.json'), referenceNumber: f.ref, invoiceNumber: f.numer, ksefNumber: f.ksefNumer, invoiceHash: f.hash })
      }
      if (st.kod === 440) {
        const r = nagranie('invoice-status-440.json')
        const ext = o.dubelBezNumeru ? { originalSessionReferenceNumber: o.bezSesjiOryginalu ? null : st.dubelZ!.sesja, originalKsefNumber: null } : { originalSessionReferenceNumber: st.dubelZ!.sesja, originalKsefNumber: st.dubelZ!.ksefNumer }
        return json(200, { ...r, referenceNumber: m[2], invoiceHash: st.hash, status: { ...r.status, extensions: ext } })
      }
      return json(200, { ...nagranie('invoice-status-150.json'), referenceNumber: m[2], invoiceHash: st.hash, status: { code: st.kod, description: 'Błąd weryfikacji semantyki dokumentu faktury', details: ['Atrapa: odrzucona treść'] } })
    }
    m = /^\/sessions\/([^/]+)\/invoices\/(ksef\/)?([^/]+)\/upo$/.exec(sciezka)
    if (metoda === 'GET' && m && bladUpo > 0) {
      bladUpo--
      return json(500, { exception: { exceptionDetailList: [{ exceptionCode: 500, exceptionDescription: 'Atrapa: UPO niedostępne' }] } })
    }
    if (metoda === 'GET' && m) return new Response(`<?xml version="1.0" encoding="UTF-8"?><Potwierdzenie><Atrapa>UPO ${decodeURIComponent(m[3]!)}</Atrapa></Potwierdzenie>`, { status: 200, headers: { 'Content-Type': 'application/xml' } })
    m = /^\/sessions\/online\/([^/]+)\/close$/.exec(sciezka)
    if (metoda === 'POST' && m) {
      const s = sesje.get(decodeURIComponent(m[1]!))
      if (s) s.otwarta = false
      return new Response(null, { status: 204 })
    }
    return json(404, { exception: { exceptionDetailList: [{ exceptionCode: 21404, exceptionDescription: `Atrapa: brak trasy ${metoda} ${sciezka}` }] } })
  }
  return { fetch: fetchImpl, faktury, wywolania }
}
