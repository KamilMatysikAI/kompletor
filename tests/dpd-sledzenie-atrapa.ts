// Atrapa usługi śledzenia DPDInfoServices (SOAP) w pamięci. Kształt odpowiedzi z przykładów specyfikacji
// „DPDInfoServices. Specyfikacja biznesowa” 1.0.7, rozdz. 11 (`getEventsForCustomerV1Response` → `return` →
// `confirmId`, `eventsList[]`), z nazwą odpowiedzi metody `getEventsForWaybillV1`. Zero połączeń z DPD; dane fikcyjne.
import type { FetchLike } from '@/lib/zrodla/http'

export const DPD_INFO_URL = 'https://info.dpd.com.pl/atrapa/zdarzenia'
export const DPD_INFO_LOGIN = 'login-sledzenia-testowy'
export const DPD_INFO_HASLO = 'haslo-sledzenia-testowe-1'

export interface ZdarzenieAtrapy {
  kod: string
  opis?: string
  czas: string
}

const zdarzenieXml = (numer: string, z: ZdarzenieAtrapy) =>
  `<eventsList><businessCode>${z.kod}</businessCode><country>PL</country><depot>XXX</depot><description>${z.opis ?? ''}</description>` +
  `<eventTime>${z.czas}</eventTime><objectId>1</objectId><packageReference/><parcelReference>REF-TEST</parcelReference><waybill>${numer}</waybill></eventsList>`

export function odpowiedzZdarzen(numer: string, zdarzenia: readonly ZdarzenieAtrapy[]): string {
  return (
    '<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:getEventsForWaybillV1Response xmlns:ns2="http://events.dpdinfoservices.dpd.com.pl/">' +
    `<return><confirmId>atrapa==</confirmId>${zdarzenia.map((z) => zdarzenieXml(numer, z)).join('')}</return>` +
    '</ns2:getEventsForWaybillV1Response></S:Body></S:Envelope>'
  )
}

export const FAULT =
  '<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault><faultcode>S:Server</faultcode><faultstring>Brak uprawnien</faultstring></S:Fault></S:Body></S:Envelope>'

/** Zdarzenia po numerze listu; `awarie` = kolejne odpowiedzi HTTP zamiast normalnej (status, treść). */
export function dpdSledzenieAtrapa() {
  const zdarzenia = new Map<string, ZdarzenieAtrapy[]>()
  const awarie: { status: number; body: string }[] = []
  const calls: { url: string; method: string; body: string }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const body = String(init?.body ?? '')
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body })
    if (url !== DPD_INFO_URL) return new Response('', { status: 404 })
    const a = awarie.shift()
    if (a) return new Response(a.body, { status: a.status })
    if (!body.includes(`<login>${DPD_INFO_LOGIN}</login>`) || !body.includes(`<password>${DPD_INFO_HASLO}</password>`)) return new Response(FAULT, { status: 500 })
    const numer = /<waybill>([^<]*)<\/waybill>/.exec(body)?.[1] ?? ''
    return new Response(odpowiedzZdarzen(numer, zdarzenia.get(numer) ?? []), { status: 200, headers: { 'Content-Type': 'text/xml' } })
  }
  return { zdarzenia, awarie, calls, fetchImpl }
}
