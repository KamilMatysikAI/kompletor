// Atrapa usługi SOAP Orlen Paczki w pamięci: zapisuje każde żądanie (adres, nagłówki, metoda SOAP, pola
// koperty) i odpowiada z kolejki albo domyślnie wg metody, w kształcie DataSet .NET z dokumentacji (schemat + diffgram).
// Zero połączeń z prawdziwym Orlenem, także z sandboxem; dane wyłącznie fikcyjne. Odpowiedzi echo-ują dane odbiorcy
// (PII_SENTINELS), żeby testy sprawdzały, że nie wychodzą one w wynikach i komunikatach.
import { PII_SENTINELS } from '@/lib/adaptery/suita-kontraktowa'
import type { RecipientAddress } from '@/lib/adaptery/kontrakt'
import { ORLEN_NS, ORLEN_TEST } from '@/lib/zrodla/orlenpaczka'

export const ORLEN_URL = ORLEN_TEST
export const ORLEN_PARTNER_ID = 'PWR123TEST'
export const ORLEN_PARTNER_KEY = 'klucz-fikcyjny-orlen-01'
export const ORLEN_NUMER = '2100000000012' // poprawna cyfra kontrolna EAN-13
export const ORLEN_PUNKT = 'WS-116263-C3-01'

const [imie, email, telefon] = PII_SENTINELS

/** Odbiorca fikcyjny z wartownikami danych osobowych (adres nie jest Orlenowi potrzebny, ale kanał go podaje). */
export const ODBIORCA_ORLEN: RecipientAddress = {
  imieNazwisko: imie!,
  firma: null,
  ulica: 'Testowa',
  numerDomu: '1',
  numerLokalu: null,
  kodPocztowy: '00-001',
  miasto: 'Testowo',
  kraj: 'PL',
  telefon: telefon!,
  email: email!,
}

export const NADAWCA_ORLEN = { name: 'Firma Testowa', fullName: 'Firma Testowa sp. z o.o.', address: 'ul. Magazynowa 5/2', city: 'Testowo', postalCode: '00-002', phone: '+48 500 000 000', email: 'magazyn@example.invalid' }

export type OrlenReply = { status: number; body: string } | { error: Error }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Odpowiedź metody w kształcie DataSet (jak w przykładach dokumentacji, pkt 4.16) z wierszami `wiersz`. */
export function odpowiedz(metoda: string, wiersz: string, rows: Record<string, string>[], poza: Record<string, string> = {}): OrlenReply {
  const schema = `<xs:schema id="NewDataSet" xmlns="" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:msdata="urn:schemas-microsoft-com:xml-msdata"><xs:element name="NewDataSet"><xs:complexType><xs:choice><xs:element name="${wiersz}"><xs:complexType><xs:sequence><xs:element name="Err" type="xs:string" minOccurs="0" /></xs:sequence></xs:complexType></xs:element></xs:choice></xs:complexType></xs:element></xs:schema>`
  const dane = rows.map((r, i) => `<${wiersz} diffgr:id="${wiersz}${i + 1}" msdata:rowOrder="${i}">${Object.entries(r).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</${wiersz}>`).join('')
  const extra = Object.entries(poza).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')
  const body =
    '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
    `<soap:Body><${metoda}Response xmlns="${ORLEN_NS}"><${metoda}Result>${schema}<diffgr:diffgram xmlns:msdata="urn:schemas-microsoft-com:xml-msdata" xmlns:diffgr="urn:schemas-microsoft-com:xml-diffgram-v1"><NewDataSet xmlns="">${dane}</NewDataSet></diffgr:diffgram></${metoda}Result>${extra}</${metoda}Response></soap:Body></soap:Envelope>`
  return { status: 200, body }
}

/** Etykieta ZPL (base64) z odciskiem referencji w polu danych nadawcy i danymi odbiorcy (jak prawdziwa). */
export const etykietaZpl = (senderOrders: string) => Buffer.from(`^XA^FO20,20^FD${imie}^FS^FO20,60^FD${senderOrders}^FS^XZ`, 'latin1').toString('base64')

export const etykietaOdp = (base64: string, err = '000') => odpowiedz('LabelPrintDuplicateListTwo', 'LabelPrintDuplicateList', [{ Err: err, ErrDes: err === '000' ? 'saved' : 'blad' }], err === '000' ? { LabelData: base64 } : {})
export const kodOdp = (metoda: string, wiersz: string, err: string, reszta: Record<string, string> = {}) => odpowiedz(metoda, wiersz, [{ Err: err, ErrDes: 'opis', ...reszta }])

function domyslna(metoda: string, pola: Record<string, string | string[]>): OrlenReply {
  switch (metoda) {
    case 'GivePartnerStatus':
      return odpowiedz(metoda, 'PartnerStatus', [{ Err: '000', ErrDes: 'saved', PaymentType: 'POSTPAID', CashOnDelivery: 'false', DeliveryRUCH: 'true', CompanyName: 'Firma Testowa' }])
    case 'GenerateBusinessPack':
      return odpowiedz(metoda, 'GenerateBusinessPack', [{ Err: '000', ErrDes: 'saved', PackCode_RUCH: ORLEN_NUMER, DestinationCode: String(pola['DestinationCode'] ?? ''), PackPrice: '1099', PackPaid: 'true', FirstName: imie! }])
    case 'LabelPrintDuplicateListTwo':
      return etykietaOdp(etykietaZpl('BRAK'))
    case 'PutCustomerPackCanceled':
      return odpowiedz(metoda, 'CustomerPackCanceled', [{ Err: '000', ErrDes: 'saved', PackCode: String(pola['PackCode'] ?? '') }])
    case 'GiveMePackStatus':
      return odpowiedz(metoda, 'PackStatus', [{ PackCode: String(pola['PackCode'] ?? ''), Trans: '200', Trans_Des: 'Zaawizowana do PwR', Data: '2026-11-08T10:00:00Z', Destination: ORLEN_PUNKT }])
    case 'GetGeneratedParcels':
      return odpowiedz(metoda, 'GetGeneratedParcels', [])
    default:
      return { status: 500, body: '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>Nieznana metoda</faultstring></soap:Fault></soap:Body></soap:Envelope>' }
  }
}

export interface OrlenCall {
  url: string
  /** Metoda SOAP z koperty. */
  metoda: string
  soapAction: string
  headers: Record<string, string>
  /** Pola koperty (lista `<string>` jako tablica). */
  pola: Record<string, string | string[]>
  body: string
  redirect?: string
}

/** Pola koperty: proste elementy i listy `<X><string>…</string></X>`. */
function polaKoperty(body: string): { metoda: string; pola: Record<string, string | string[]> } {
  const m = /<soap:Body><(\w+) xmlns="[^"]*">([\s\S]*)<\/\1><\/soap:Body>/.exec(body)
  if (!m) return { metoda: '?', pola: {} }
  const pola: Record<string, string | string[]> = {}
  for (const p of m[2]!.matchAll(/<(\w+)>((?:<string>[^<]*<\/string>)+|[^<]*)<\/\1>/g)) {
    const v = p[2]!
    pola[p[1]!] = v.startsWith('<string>') ? [...v.matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')) : v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  }
  return { metoda: m[1]!, pola }
}

export function orlenAtrapa(replies: OrlenReply[] = [], poMetodzie: Record<string, OrlenReply[]> = {}) {
  const calls: OrlenCall[] = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = String(init?.body ?? '')
    const headers = { ...(init?.headers as Record<string, string>) }
    const { metoda, pola } = polaKoperty(body)
    calls.push({ url, metoda, soapAction: headers['SOAPAction'] ?? '', headers, pola, body, redirect: init?.redirect })
    const r = poMetodzie[metoda]?.shift() ?? replies.shift() ?? domyslna(metoda, pola)
    if ('error' in r) throw r.error
    return new Response(r.body, { status: r.status })
  }
  return { calls, fetchImpl, metody: () => calls.map((c) => c.metoda) }
}
