// Atrapa DPDServices REST w pamięci: zapisuje każde żądanie (adres, nagłówki, treść) i odpowiada z kolejki
// albo domyślnie wg ścieżki. Zero połączeń z prawdziwym DPD, także z demo; dane wyłącznie fikcyjne. Odpowiedzi DPD
// echo-ują dane odbiorcy (PII_SENTINELS), żeby testy sprawdzały, że nie wychodzą one w wynikach i komunikatach.
import { PII_SENTINELS } from '@/lib/adaptery/suita-kontraktowa'
import type { RecipientAddress } from '@/lib/adaptery/kontrakt'

export const DPD_DEMO = 'https://dpdservicesdemo.dpd.com.pl'
export const DPD_LOGIN = 'login-api-testowy'
export const DPD_PASSWORD = 'haslo-WARTOWNIK-7c1e'
export const DPD_FID = '1495'
export const DPD_WAYBILL = '0000123456789U'

const [imie, email, telefon, ulica] = PII_SENTINELS

/** Odbiorca fikcyjny z wartownikami danych osobowych, w kształcie adresu z kanału. */
export const ODBIORCA_TESTOWY: RecipientAddress = {
  imieNazwisko: imie!,
  firma: null,
  ulica: ulica!,
  numerDomu: '1',
  numerLokalu: null,
  kodPocztowy: '00-001',
  miasto: 'Testowo',
  kraj: 'PL',
  telefon: telefon!,
  email: email!,
}

/** Nadawca fikcyjny: dane firmy z `Organization.settings.nadawca`. */
export const NADAWCA_TESTOWY = { name: 'Firma Testowa', fullName: 'Firma Testowa sp. z o.o.', address: 'ul. Magazynowa 5', city: 'Testowo', postalCode: '00-002', phone: '500000000', email: 'magazyn@example.invalid' }

export type DpdReply = { status: number; body: string } | { error: Error }
export const json = (v: unknown, status = 200): DpdReply => ({ status, body: JSON.stringify(v) })

export interface DpdCall {
  url: string
  path: string
  method: string
  headers: Record<string, string>
  body: unknown
  redirect?: string
}

function domyslna(path: string): DpdReply {
  if (path.endsWith('/postalCode')) return json({ status: 'OK', countryCode: 'PL', zipCode: '02274', city: 'Warszawa' })
  if (path.endsWith('/generatePackagesNumbers'))
    return json({ status: 'OK', sessionId: 1001, beginTime: '2026-11-02T10:00:00', endTime: '2026-11-02T10:00:01', traceId: 'trace-1', packages: [{ status: 'OK', packageId: 501, reference: 'ref', receiver: { name: PII_SENTINELS[0] }, parcels: [{ status: 'OK', parcelId: 601, waybill: DPD_WAYBILL }] }] })
  if (path.endsWith('/generateSpedLabels')) return json({ status: 'OK', documentData: Buffer.from('%PDF-fikcyjna-etykieta').toString('base64') })
  return json({ status: 'OK' })
}

export function dpdAtrapa(replies: DpdReply[] = []) {
  const calls: DpdCall[] = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname
    const raw = init?.body === undefined ? null : String(init.body)
    calls.push({ url, path, method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, body: raw === null ? null : (JSON.parse(raw) as unknown), redirect: init?.redirect })
    const r = replies.shift() ?? domyslna(path)
    if ('error' in r) throw r.error
    return new Response(r.body, { status: r.status })
  }
  return { calls, fetchImpl }
}
