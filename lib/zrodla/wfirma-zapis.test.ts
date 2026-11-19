// klient zapisu faktur wFirmy — klasyfikacja wyniku (OK / ERROR / LIMIT / TIMEOUT), brak ponowień
// wystawienia, strażnik ścieżek zapisu, PDF. Wyłącznie atrapa `fetch`, zero połączeń z siecią.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ReadOnlyViolation } from './http'
import { bledyWalidacji, fakturaZOdpowiedzi, WfirmaZapis } from './wfirma-zapis'

const KEYS = { accessKey: 'a', secretKey: 's', appKey: 'p', companyId: '1' }
const TRESC = { invoices: { invoice: { id_external: 'o1/1/1', invoicecontents: {} } } }

function klient(odp: (url: string) => Response | Promise<Response>) {
  const wywolania: string[] = []
  const fetchImpl = async (url: string) => {
    wywolania.push(new URL(url).pathname)
    return odp(url)
  }
  return { k: new WfirmaZapis(KEYS, fetchImpl, 0), wywolania }
}
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('WfirmaZapis.wystawFakture', () => {
  it('OK z id i numerem; jedno żądanie na invoices/add', async () => {
    const { k, wywolania } = klient(() => json({ status: { code: 'OK' }, invoices: { '0': { invoice: { id: '123', fullnumber: 'SD 15/5/11/26' } } } }))
    expect(await k.wystawFakture(TRESC)).toEqual({ kind: 'OK', id: '123', numer: 'SD 15/5/11/26' })
    expect(wywolania).toEqual(['/invoices/add'])
  })

  it.each([
    ['błąd sieci', () => Promise.reject(new Error('ECONNRESET')), 'TIMEOUT'],
    ['HTTP 500', () => json({}, 500), 'TIMEOUT'],
    ['HTTP 502 bez treści', () => new Response('', { status: 502 }), 'TIMEOUT'],
    ['nieczytelny JSON przy 200', () => new Response('<html>', { status: 200 }), 'TIMEOUT'],
    ['OK bez id', () => json({ status: { code: 'OK' }, invoices: { parameters: {} } }), 'TIMEOUT'],
    ['SNAPSHOT LOCK', () => json({ status: { code: 'SNAPSHOT LOCK' } }), 'TIMEOUT'],
    ['HTTP 429', () => json({}, 429, { 'retry-after': '120' }), 'LIMIT'],
    ['kod z LIMIT', () => json({ status: { code: 'AUTH FAILED LIMIT WAIT 5 MINUTES' } }), 'LIMIT'],
    ['ERROR z polami', () => json({ status: { code: 'ERROR' }, invoices: { '0': { invoice: { errors: { '0': { error: { field: 'nip', message: 'Niepoprawny' } } } } } } }), 'ERROR'],
    ['HTTP 400', () => json({ status: { code: 'INPUT ERROR' } }, 400), 'ERROR'],
    ['AUTH', () => json({ status: { code: 'AUTH' } }), 'ERROR'],
  ] as const)('%s → %s, bez ponowienia', async (_n, odp, rodzaj) => {
    const { k, wywolania } = klient(odp as () => Response)
    const r = await k.wystawFakture(TRESC)
    expect(r.kind).toBe(rodzaj)
    expect(wywolania).toHaveLength(1)
    if (r.kind === 'LIMIT' && _n === 'HTTP 429') expect(r.retryAfterMs).toBe(120_000)
    if (r.kind === 'ERROR' && _n === 'ERROR z polami') expect(r.message).toContain('nip: Niepoprawny')
  })

  it('strażnik: tylko invoices/add i invoices/download/<id>', () => {
    for (const p of ['invoices/add', 'invoices/download/15']) expect(WfirmaZapis.allowed(p)).toBe(true)
    for (const p of ['invoices/edit/1', 'invoices/delete/1', 'invoices/send/1', 'payments/add', 'invoices/download/x', 'goods/add', 'invoices/add/../delete']) expect(WfirmaZapis.allowed(p)).toBe(false)
  })

  it('bez kluczy = błąd przed jakimkolwiek żądaniem', () => {
    expect(() => new WfirmaZapis({ ...KEYS, appKey: '' })).toThrow(/kluczy/)
    expect(() => new WfirmaZapis({ ...KEYS, companyId: '' })).toThrow(/COMPANY/)
  })
})

describe('WfirmaZapis.pobierzPdf', () => {
  it('PDF w base64', async () => {
    const { k, wywolania } = klient(() => new Response(new TextEncoder().encode('%PDF-1.4 x'), { status: 200 }))
    const r = await k.pobierzPdf('77')
    expect(Buffer.from(r.base64, 'base64').toString()).toBe('%PDF-1.4 x')
    expect(wywolania).toEqual(['/invoices/download/77'])
  })
  it('JSON z błędem przy 200 = wyjątek, zły numer = wyjątek bez żądania', async () => {
    const { k, wywolania } = klient(() => json({ status: { code: 'NOT FOUND' } }))
    await expect(k.pobierzPdf('77')).rejects.toThrow(/nie jest PDF-em \(NOT FOUND\)/)
    await expect(k.pobierzPdf('../1')).rejects.toThrow(/niepoprawny/)
    expect(wywolania).toHaveLength(1)
  })
  it('ReadOnlyViolation nie jest połykany jako timeout', async () => {
    const k = new WfirmaZapis(KEYS, async () => json({}), 0)
    await expect((k as unknown as { post: (p: string, b: unknown, a: string) => Promise<Response> }).post('invoices/delete/1', {}, 'x')).rejects.toBeInstanceOf(ReadOnlyViolation)
  })
})

describe('odpowiedź wFirmy', () => {
  it('fakturaZOdpowiedzi i bledyWalidacji', () => {
    expect(fakturaZOdpowiedzi({ invoices: { parameters: {}, '0': { invoice: { id: 5, fullnumber: ' FV 1 ' } } } })).toEqual({ id: '5', numer: 'FV 1' })
    expect(fakturaZOdpowiedzi({ invoices: { '0': { invoice: { id: '0' } } } })).toBeNull()
    expect(bledyWalidacji({ invoices: { '0': { invoice: { contractor: { errors: { '0': { error: { field: 'zip', message: 'Zły kod' } } } } } } } })).toEqual(['zip: Zły kod'])
  })
})

/** Treść bez komentarzy (linie // i * w blokach): opis „invoices/add” w komentarzu to nie wywołanie. */
const kod = (t: string) =>
  t
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

describe('strażnik w źródłach: ścieżka zapisu wFirmy tylko w kliencie zapisu', () => {
  it('literał invoices/add (i inne zapisy wFirmy) poza lib/zrodla/wfirma-zapis.ts nie istnieje w lib/, app/, scripts/', () => {
    const pliki: string[] = []
    const chodz = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f)
        if (statSync(p).isDirectory()) chodz(p)
        else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) pliki.push(p)
      }
    }
    for (const d of ['lib', 'app', 'scripts']) chodz(path.resolve(d))
    const zle = pliki.filter((p) => !p.endsWith(path.join('zrodla', 'wfirma-zapis.ts')) && /['"`](invoices|payments|goods|contractors|warehouse_documents)\/(add|edit|delete|send|fiscalize)\b/.test(kod(readFileSync(p, 'utf8'))))
    expect(zle).toEqual([])
  })
})
