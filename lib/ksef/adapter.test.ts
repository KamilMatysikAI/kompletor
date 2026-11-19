// adapter `ksef.fa3.v1` w rejestrze: manifest, PROD odrzucone, strażnik zdolności, test połączenia przez
// atrapę (bez sieci), składanie faktury bez efektów ubocznych.
import { describe, expect, it } from 'vitest'
import { KSEF_KEY } from '../adaptery/ksef'
import { defaultRegistry } from '../adaptery/domyslne'
import { hasInvoicePreparer, hasOrderFeed, hasShipmentPreparer, hasStockWriter, type IntegrationRef } from '../adaptery/kontrakt'
import { AdapterConfigError, manifestProblems } from '../adaptery/rejestr'

const REF: IntegrationRef = { organizationId: 'org-test', kind: 'invoicing', id: 'ksef', name: 'KSeF' }

function adapter(srodowisko: unknown, odp: () => Response = () => new Response('{"challenge":"c"}', { status: 200 })) {
  const zadania: string[] = []
  const a = defaultRegistry().create(KSEF_KEY, {
    integration: REF,
    rawConfig: { srodowisko },
    rawSecrets: {},
    fetch: async (url, init) => {
      zadania.push(`${init?.method} ${url}`)
      return odp()
    },
    http: { minIntervalMs: 0, retry: { attempts: 1, baseDelayMs: 1 } },
  })
  return { a, zadania }
}

describe('adapter ksef.fa3.v1', () => {
  it('manifest: invoicing, tylko invoice.prepare, tylko odczyt, KSEF_TOKEN opcjonalny', () => {
    const m = defaultRegistry().get(KSEF_KEY)!.manifest
    expect(manifestProblems(m)).toEqual([])
    expect(m).toMatchObject({ kind: 'invoicing', capabilities: ['invoice.prepare'], readOnly: true })
    expect(m.secrets).toEqual([expect.objectContaining({ name: 'KSEF_TOKEN', required: false })])
  })

  it('PROD (i brak środowiska) odrzucone przez walidację konfiguracji', () => {
    expect(() => adapter('PROD')).toThrow(AdapterConfigError)
    expect(() => adapter('PROD')).toThrow(/srodowisko ma zły format/)
    expect(() => adapter('prod')).toThrow(AdapterConfigError)
    expect(() => adapter(undefined)).toThrow(/brak ustawienia srodowisko/)
  })

  it('strażniki zdolności: tylko InvoicePreparer', () => {
    const { a } = adapter('TEST')
    expect(hasInvoicePreparer(a)).toBe(true)
    expect(hasOrderFeed(a) || hasShipmentPreparer(a) || hasStockWriter(a)).toBe(false)
  })

  it('testConnection: POST /auth/challenge na TEST (atrapa), błąd jako ok=false', async () => {
    const t = adapter('TEST')
    expect(await t.a.testConnection()).toMatchObject({ ok: true })
    expect(t.zadania).toEqual(['POST https://api-test.ksef.mf.gov.pl/v2/auth/challenge'])
    expect(await adapter('DEMO', () => new Response('{}', { status: 401 })).a.testConnection()).toMatchObject({ ok: false, message: expect.stringContaining('HTTP 401') })
  })

  it('prepareInvoice: bez sieci, XML i sumy albo problemy', () => {
    const t = adapter('TEST')
    if (!hasInvoicePreparer(t.a)) throw new Error('bez invoice.prepare')
    const wejscie = {
      numer: 'SZKIC-1',
      dataWystawienia: '2026-11-02',
      wytworzono: new Date('2026-11-02T10:00:00Z'),
      waluta: 'PLN',
      rodzaj: 'VAT',
      sprzedawca: { nip: '1111111111', nazwa: 'Sprzedawca', adres: { kodKraju: 'PL', linia1: 'ul. A 1' } },
      nabywca: { nip: null, nazwa: 'Nabywca' },
      wiersze: [{ nazwa: 'Przyprawa', jednostka: 'szt.', ilosc: 1, cenaBruttoGr: 1230, bruttoGr: 1230, stawka: '23' }],
    }
    const p = t.a.prepareInvoice(wejscie)
    expect(p).toMatchObject({ schemaVersion: 'FA (3) 1-0E', sumy: { nettoGr: 1000, vatGr: 230, bruttoGr: 1230 }, problems: [] })
    expect(p.xml).toContain('<P_15>12.30</P_15>')
    expect(t.a.prepareInvoice({ ...wejscie, waluta: 'EUR' })).toMatchObject({ xml: null, problems: [expect.objectContaining({ kod: 'waluta-poza-zakresem' })] })
    expect(t.zadania).toEqual([])
  })
})
