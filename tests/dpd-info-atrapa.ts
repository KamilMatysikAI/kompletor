// atrapa DPDInfoServices (`getEventsForWaybillV1`, SOAP) i śledzenia Base Courier (`getWaybillTracking.json`)
// w pamięci. Kształt odpowiedzi DPD jak w odczycie produkcji 20.11.2026:
// `eventsList` z `businessCode`, `description`, `eventTime`, `depot`, `depotName`, najnowsze pierwsze) i w atrapie;
// Base Courier jak w odczycie 19.11.2026 (`data.Tracking[].TrackingStatus`). Zero połączeń z DPD i Base Courier.
import type { FetchLike } from '@/lib/zrodla/http'
import { DPD_INFO_URL } from '@/lib/zrodla/dpd-sledzenie'

export const DPD_INFO_LOGIN = 'login-dpd-testowy'
export const DPD_INFO_HASLO = 'haslo-dpd-testowe-1'
export const DPD_INFO_FID = '99999'

export interface ZdarzenieAtrapy {
  kod: string
  opis?: string
  czas: string
}

export interface StatusBcAtrapy {
  status: string
  opis?: string
  kod: number
  delivered?: boolean
}

const zdarzenieXml = (numer: string, z: ZdarzenieAtrapy) =>
  `<eventsList><businessCode>${z.kod}</businessCode><country>PL</country><depot>1326</depot><depotName>Poznań</depotName><description>${z.opis ?? ''}</description>` +
  `<eventTime>${z.czas}</eventTime><objectId>1</objectId><packageReference/><parcelReference>REF-TEST</parcelReference><waybill>${numer}</waybill></eventsList>`

export function odpowiedzZdarzen(numer: string, zdarzenia: readonly ZdarzenieAtrapy[]): string {
  return (
    '<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:getEventsForWaybillV1Response xmlns:ns2="http://events.dpdinfoservices.dpd.com.pl/">' +
    `<return><confirmId>atrapa==</confirmId>${zdarzenia.map((z) => zdarzenieXml(numer, z)).join('')}</return>` +
    '</ns2:getEventsForWaybillV1Response></S:Body></S:Envelope>'
  )
}

export const FAULT_LOGOWANIA =
  '<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault><faultcode>S:Server</faultcode><faultstring>Bledny login lub haslo</faultstring></S:Fault></S:Body></S:Envelope>'

/**
 * DPD: zdarzenia po numerze listu (najnowsze pierwsze, jak DPD), `awarie` = kolejne odpowiedzi HTTP zamiast normalnej.
 * Zły login, hasło albo kanał = Fault logowania. Base Courier: historia po id zamówienia (`bcStatusy`).
 */
export function sledzenieAtrapa() {
  const zdarzenia = new Map<string, ZdarzenieAtrapy[]>()
  const awarie: { status: number; body: string }[] = []
  const bcStatusy = new Map<string, StatusBcAtrapy[]>()
  const dpdCalls: { body: string }[] = []
  const bcCalls: { endpoint: string; id: string }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const body = String(init?.body ?? '')
    if (url === DPD_INFO_URL) {
      dpdCalls.push({ body })
      const a = awarie.shift()
      if (a) return new Response(a.body, { status: a.status })
      if (!body.includes(`<login>${DPD_INFO_LOGIN}</login>`) || !body.includes(`<password>${DPD_INFO_HASLO}</password>`) || !body.includes(`<channel>${DPD_INFO_FID}</channel>`))
        return new Response(FAULT_LOGOWANIA, { status: 500 })
      const numer = /<waybill>([^<]*)<\/waybill>/.exec(body)?.[1] ?? ''
      const lista = [...(zdarzenia.get(numer) ?? [])].sort((a, b) => b.czas.localeCompare(a.czas))
      return new Response(odpowiedzZdarzen(numer, lista), { status: 200, headers: { 'Content-Type': 'text/xml' } })
    }
    const m = /^https:\/\/(?:api|sandbox)\.basecourier\.com\/api\/(.+)$/.exec(url)
    if (m) {
      const j = JSON.parse(body || '{}') as { Order?: { id?: string } }
      const id = String(j.Order?.id ?? '')
      bcCalls.push({ endpoint: m[1]!, id })
      if (m[1] !== 'getWaybillTracking.json') return new Response(JSON.stringify({ success: false, message: 'Nieznany endpoint' }), { status: 200 })
      const Tracking = (bcStatusy.get(id) ?? []).map((s) => ({ TrackingStatus: { status: s.status, status_desc: s.opis ?? null, terminal: null, error_desc: null, delivered: s.delivered ?? false, received_by: null, event_time: '2026-11-20 11:46:37', bl_status_mapped: s.kod } }))
      return new Response(JSON.stringify({ success: true, data: { Order: [], Tracking } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('', { status: 404 })
  }
  return { zdarzenia, awarie, bcStatusy, dpdCalls, bcCalls, fetchImpl }
}
