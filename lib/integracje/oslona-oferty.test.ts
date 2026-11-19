// (3b-1): ofertowanie (`odczytDoOfert`, `zapisOfert`) idzie przez osłonę konta jak każda inna akcja adaptera:
// limit tempa per zdolność, licznik błędów, wyłączone konto. Baza i limity na atrapach (vi.mock), bez sieci.
import type { PrismaClient } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ALLEGRO_ZAPIS_MANIFEST } from '../adaptery/allegro-zapis'
import { ALLEGRO_MANIFEST } from '../adaptery/allegro'
import type { ChannelAdapter, Capability } from '../adaptery/kontrakt'
import { MIRAKL_EMPIK_MANIFEST, MIRAKL_EMPIK_ZAPIS_MANIFEST } from '../adaptery/mirakl-empik'
import { manifestProblems } from '../adaptery/rejestr'
import { WOO_MANIFEST } from '../adaptery/woo'
import { WOO_ZAPIS_MANIFEST } from '../adaptery/woo-zapis'
import { ReadOnlyViolation } from '../zrodla/http'
import { atrapaWoo, atrapaZapisu } from '../oferty/kanaly-atrapa'
import { przygotujPodgladWoo, zrodloWooZApi } from '../oferty/woo-podglad'
import { KOMUNIKAT_OSLONA_LIMIT, KOMUNIKAT_OSLONA_WYLACZONA, KOMUNIKAT_WYLACZONE, wystawProduktWoo } from '../oferty/wystawianie'
import type { ProduktDoOferty } from '../oferty/typy'

const st = vi.hoisted(() => ({
  limity: [] as { cap: string | null; granted: boolean }[],
  odmowa: new Set<string>(),
  porazki: [] as string[],
  sukcesy: 0,
  stan: null as null | { consecutiveFailures: number; disabledAt: Date | null; disabledReason: string | null },
}))

vi.mock('./limity', () => ({
  sprawdzLimit: async (_db: unknown, _k: string, _r: unknown, cap: string | null) => {
    const granted = !st.odmowa.has(String(cap))
    st.limity.push({ cap, granted })
    return granted ? { granted: true, retryAfterMs: 0 } : { granted: false, retryAfterMs: 60_000, zakres: cap ?? '*', perMinute: 1 }
  },
  zajmijMiejsce: () => true,
  zwolnijMiejsce: () => undefined,
}))
vi.mock('./zdrowie', () => ({
  stanKonta: async () => st.stan,
  zapiszPorazke: async (_db: unknown, _k: unknown, powod: string) => {
    st.porazki.push(powod)
    return { wylaczono: false, porazki: st.porazki.length }
  },
  zapiszSukces: async () => {
    st.sukcesy++
  },
}))

const { oslonAdapter, LimitTempaError, IntegracjaWylaczonaError } = await import('./oslona')

const KONTO = { klucz: 'kanal:ALLEGRO/a1', rodzaj: 'kanal', nazwa: 'Allegro testowe' } as const
const db = {} as PrismaClient

function atrapaAdaptera(odp: { status: number; body: unknown }) {
  const wolania: string[] = []
  const a = {
    manifest: ALLEGRO_ZAPIS_MANIFEST,
    testConnection: async () => ({ ok: true, message: 'ok' }),
    odczytDoOfert: async (path: string) => {
      wolania.push(`GET ${path}`)
      return odp
    },
    zapisOfert: async (_m: 'POST', sciezka: string) => {
      wolania.push(`POST ${sciezka}`)
      return odp
    },
  }
  return { adapter: a as unknown as ChannelAdapter & typeof a, wolania }
}

beforeEach(() => {
  st.limity = []
  st.odmowa = new Set()
  st.porazki = []
  st.sukcesy = 0
  st.stan = null
})

describe('osłona konta dla ofertowania', () => {
  it('odczyt i zapis ofert liczą się do limitu swojej zdolności (offers.prepare, offers.publish)', async () => {
    const { adapter, wolania } = atrapaAdaptera({ status: 200, body: {} })
    const o = await oslonAdapter(db, adapter, { ...KONTO, rodzaj: 'kanal' } as never)
    await o.odczytDoOfert('/sale/categories')
    await o.zapisOfert('POST', '/sale/product-offers')
    expect(st.limity.map((l) => l.cap)).toEqual(['offers.prepare', 'offers.publish'])
    expect(wolania).toEqual(['GET /sale/categories', 'POST /sale/product-offers'])
  })

  it('wyczerpany limit wystawiania: LimitTempaError i nic nie wychodzi do kanału', async () => {
    st.odmowa.add('offers.publish')
    const { adapter, wolania } = atrapaAdaptera({ status: 201, body: {} })
    const o = await oslonAdapter(db, adapter, KONTO as never)
    await expect(o.zapisOfert('POST', '/sale/product-offers')).rejects.toBeInstanceOf(LimitTempaError)
    expect(wolania).toEqual([])
  })

  it('konto wyłączone po błędach: odczyt do ofert odmawia przed żądaniem', async () => {
    st.stan = { consecutiveFailures: 5, disabledAt: new Date(), disabledReason: '5 kolejnych błędów' }
    const { adapter, wolania } = atrapaAdaptera({ status: 200, body: {} })
    const o = await oslonAdapter(db, adapter, KONTO as never)
    await expect(o.odczytDoOfert('/sale/categories')).rejects.toBeInstanceOf(IntegracjaWylaczonaError)
    expect(wolania).toEqual([])
  })

  it('HTTP 401/403 z odpowiedzi liczy się do licznika błędów; 422 i 429 nie; 2xx zeruje licznik', async () => {
    for (const s of [401, 403]) {
      const o = await oslonAdapter(db, atrapaAdaptera({ status: s, body: null }).adapter, KONTO as never)
      await o.zapisOfert('POST', '/sale/product-offers')
    }
    expect(st.porazki).toHaveLength(2)
    expect(st.porazki[0]).toContain('zapisOfert: HTTP 401')
    for (const s of [422, 429]) {
      const o = await oslonAdapter(db, atrapaAdaptera({ status: s, body: {} }).adapter, KONTO as never)
      await o.zapisOfert('POST', '/sale/product-offers')
      await o.odczytDoOfert('/sale/categories')
    }
    expect(st.porazki).toHaveLength(2)
    expect(st.sukcesy).toBe(0)
    st.stan = { consecutiveFailures: 2, disabledAt: null, disabledReason: null }
    const o = await oslonAdapter(db, atrapaAdaptera({ status: 200, body: {} }).adapter, KONTO as never)
    await o.odczytDoOfert('/sale/categories')
    expect(st.sukcesy).toBe(1)
  })
})

describe('manifesty: zdolności ofertowania', () => {
  it('odczyt do ofert w wersjach tylko do odczytu, wystawianie tylko w wersjach z zapisem, z osobnym limitem', () => {
    for (const m of [ALLEGRO_MANIFEST, MIRAKL_EMPIK_MANIFEST, WOO_MANIFEST]) {
      expect(m.capabilities).toContain('offers.prepare')
      expect(m.capabilities).not.toContain('offers.publish')
    }
    for (const m of [ALLEGRO_ZAPIS_MANIFEST, MIRAKL_EMPIK_ZAPIS_MANIFEST, WOO_ZAPIS_MANIFEST]) {
      expect(m.capabilities).toEqual(expect.arrayContaining(['offers.prepare', 'offers.publish']))
      expect(m.rateLimit.perCapability?.['offers.publish']).toMatchObject({ maxConcurrent: 1 })
      expect(manifestProblems(m)).toEqual([])
    }
  })

  it('rejestr odrzuca wystawianie w adapterze tylko do odczytu', () => {
    const zly = { ...ALLEGRO_MANIFEST, capabilities: [...ALLEGRO_MANIFEST.capabilities, 'offers.publish' as Capability] }
    expect(manifestProblems(zly)).toContain('adapter tylko do odczytu deklaruje offers.publish')
  })
})

const produkt = (): ProduktDoOferty => ({
  id: 'prod-z1',
  nazwa: 'Przyprawa czarna Assam Testowa 100 g',
  sku: 'HC-ASSAM-100',
  ean: '5901234123457',
  opis: '<p>Mocna, słodowa przyprawa.</p>',
  wagaG: 110,
  cenaBrutto: 29.9,
  stan: 5,
  zdjecia: ['https://cdn.przyklad.test/assam.jpg'],
  kategorieSklepu: ['przyprawa-czarna'],
  atrybuty: [],
})

describe('odmowa przed wysłaniem to nie „brak odpowiedzi”', () => {
  it('limit osłony = PRZEJSCIOWY „Nic nie wysłano”; wyłącznik adaptera = WYLACZONE; zwykła awaria sieci nadal NIEJEDNOZNACZNY', async () => {
    const pw = await przygotujPodgladWoo({ produkt: produkt() }, zrodloWooZApi(atrapaWoo().get))
    const odczyt = zrodloWooZApi(atrapaWoo().get)
    const limit = await wystawProduktWoo(pw, { wystawianieOfertWlaczone: true, wyslij: async () => Promise.reject(new LimitTempaError('Sklep: limit „offers.publish” 30/min wyczerpany', 2000)), odczyt })
    expect(limit.kind).toBe('PRZEJSCIOWY')
    expect(limit.komunikat).toMatch(/^Nic nie wysłano: /)
    const wyl = await wystawProduktWoo(pw, { wystawianieOfertWlaczone: true, wyslij: async () => Promise.reject(new ReadOnlyViolation('wyłączone')), odczyt })
    expect(wyl).toEqual({ kind: 'WYLACZONE', komunikat: KOMUNIKAT_WYLACZONE })
    expect((await wystawProduktWoo(pw, { wystawianieOfertWlaczone: true, wyslij: atrapaZapisu('siec').wyslij, odczyt })).kind).toBe('NIEJEDNOZNACZNY')
  })

  it('komunikat odmowy osłony stały, bez treści wyjątku', async () => {
    const pw = await przygotujPodgladWoo({ produkt: produkt() }, zrodloWooZApi(atrapaWoo().get))
    const odczyt = zrodloWooZApi(atrapaWoo().get)
    const tajne = 'token=SEKRET-123 odpowiedź kanału'
    const limit = await wystawProduktWoo(pw, { wystawianieOfertWlaczone: true, wyslij: async () => Promise.reject(new LimitTempaError(tajne, 2000)), odczyt })
    expect(limit).toEqual({ kind: 'PRZEJSCIOWY', komunikat: KOMUNIKAT_OSLONA_LIMIT })
    const wyl = await wystawProduktWoo(pw, { wystawianieOfertWlaczone: true, wyslij: async () => Promise.reject(new IntegracjaWylaczonaError('Sklep', tajne)), odczyt })
    expect(wyl).toEqual({ kind: 'PRZEJSCIOWY', komunikat: KOMUNIKAT_OSLONA_WYLACZONA })
    expect(JSON.stringify([limit, wyl])).not.toContain('SEKRET')
  })
})
