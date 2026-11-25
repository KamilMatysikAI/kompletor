// konto DPD wpisywane w panelu (Ustawienia → Wysyłka i druk → Przewoźnicy → Konta przewoźników). Panel nie
// pokazuje adresu API (`baseUrl` jest polem self-hostu), więc konto DPD wybiera środowisko jak GLS: demo (domyślnie,
// osobne dane od DPD) albo produkcja. Jawny `baseUrl` (self-host) wygrywa. Dane fikcyjne, zero połączeń z DPD.
import { describe, expect, it } from 'vitest'
import { DPD_DEMO, DPD_FID, DPD_LOGIN, DPD_PASSWORD, dpdAtrapa, NADAWCA_TESTOWY, ODBIORCA_TESTOWY } from '../../tests/dpd-atrapa'
import { adresDpd, DPD_DEFINITION, DPD_KEY, DPD_PRODUKCJA, DPD_ZAPIS_DEFINITION, DPD_ZAPIS_KEY } from './dpd'
import { defaultRegistry } from './domyslne'
import { hasShipmentCreator, type PreparedParcel } from './kontrakt'
import { validateAccountConfig } from './rejestr'
import { POLA_UKRYTE } from '../wysylka/konta'

const integration = { organizationId: 'org', kind: 'carrier' as const, id: 'dpd', name: 'DPD' }
const SECRETS = { DPD_LOGIN, DPD_PASSWORD }
const FAST = { retry: { attempts: 1, baseDelayMs: 0 }, minIntervalMs: 0 }

function utworz(key: string, config: Record<string, unknown>, fetchImpl = dpdAtrapa().fetchImpl) {
  return defaultRegistry().create(key, { integration, rawConfig: { payerFid: DPD_FID, ...config }, rawSecrets: SECRETS, fetch: fetchImpl, http: FAST })
}

describe('środowisko konta DPD (panel bez adresu API)', () => {
  it('manifest: pole „srodowisko” z listą demo/produkcja widoczne w panelu, baseUrl nieobowiązkowy (self-host)', () => {
    for (const { manifest } of [DPD_DEFINITION, DPD_ZAPIS_DEFINITION]) {
      const sr = manifest.config.find((c) => c.key === 'srodowisko')
      expect(sr).toMatchObject({ type: 'string', required: false })
      expect(sr!.options!.map((o) => o.value)).toEqual(['demo', 'produkcja'])
      expect(POLA_UKRYTE.has('srodowisko')).toBe(false)
      expect(manifest.config.find((c) => c.key === 'baseUrl')).toMatchObject({ required: false })
      expect(validateAccountConfig(manifest, { payerFid: DPD_FID }).problems).toEqual([])
      expect(validateAccountConfig(manifest, { payerFid: DPD_FID, srodowisko: 'test' }).problems).toEqual([expect.stringContaining('srodowisko')])
    }
  })

  it('adres: brak = demo, „produkcja” = produkcja, jawny baseUrl wygrywa', () => {
    expect(adresDpd({})).toBe(DPD_DEMO)
    expect(adresDpd({ srodowisko: 'demo' })).toBe(DPD_DEMO)
    expect(adresDpd({ srodowisko: 'produkcja' })).toBe(DPD_PRODUKCJA)
    expect(adresDpd({ srodowisko: 'produkcja', baseUrl: DPD_DEMO })).toBe(DPD_DEMO)
    expect(DPD_PRODUKCJA).toBe('https://dpdservices.dpd.com.pl')
  })

  it('„Sprawdź połączenie” bez baseUrl idzie na adres środowiska i mówi, które to środowisko', async () => {
    const a = dpdAtrapa()
    const demo = await utworz(DPD_KEY, {}, a.fetchImpl).testConnection()
    expect(demo).toMatchObject({ ok: true, message: expect.stringContaining('demo') })
    const b = dpdAtrapa()
    const prod = await utworz(DPD_KEY, { srodowisko: 'produkcja' }, b.fetchImpl).testConnection()
    expect(prod).toMatchObject({ ok: true, message: expect.stringContaining('produkcyjne') })
    expect(a.calls[0]!.url.startsWith(DPD_DEMO)).toBe(true)
    expect(b.calls[0]!.url.startsWith(DPD_PRODUKCJA)).toBe(true)
  })

  it('zapis bez baseUrl: numery listów na adresie środowiska', async () => {
    const a = dpdAtrapa()
    const ad = utworz(DPD_ZAPIS_KEY, { srodowisko: 'produkcja', zapisWlaczony: true, nadawca: JSON.stringify(NADAWCA_TESTOWY) }, a.fetchImpl)
    if (!hasShipmentCreator(ad)) throw new Error('bez shipment.create')
    const parcel: PreparedParcel = { courierCode: 'DPD_CLASSIC', gabaryt: 'DPD', sideXCm: 40, sideYCm: 30, sideZCm: 20, weightKg: 1, codAmount: null, pickupPoint: null, problems: [] }
    expect(await ad.createShipment({ carrier: 'DPD', parcel, recipient: ODBIORCA_TESTOWY }, 'ref-a346')).toMatchObject({ kind: 'OK' })
    expect(a.calls[0]!.url).toBe(`${DPD_PRODUKCJA}/public/shipment/v1/generatePackagesNumbers`)
  })
})
