// ekran Integracje dla firmy bez żadnego konta (same „Niepodłączony” z „Podłącz”, bez błędu, bez
// BaseLinkera i wFirmy) i kafle kompletności produktów: licznik kafla = liczba wierszy listy po kliknięciu (ten sam zbiór
// testowy), dane innej firmy się nie liczą (RLS). Dane wyłącznie testowe (zmyślone produkty, konta w domenie .test).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { createUser, grantMembership, login } from '@/lib/auth/sesje'
import { DEFAULT_WAREHOUSE } from '@/lib/rdzen/stan'
import { ORG_A, ORG_B, testDb, testSystemDb, truncateAll } from './db'
import { testAppDbUrl, testDbUrl } from './global-setup'
import { seedBase } from './rdzen-fixtures'

let ciasteczko: string | undefined
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (_n: string) => (ciasteczko ? { value: ciasteczko } : undefined) }),
  headers: async () => new Headers(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
process.env.DATABASE_URL = testDbUrl()
process.env.APP_DATABASE_URL = testAppDbUrl()

const { default: Integracje } = await import('@/app/(panel)/ustawienia/integracje/page')
const { defaultRegistry } = await import('@/lib/adaptery/domyslne')
const { daneIntegracji, pozycjeIntegracji } = await import('@/lib/panel/integracje')
const { productsPage } = await import('@/lib/panel/dane')
const { BRAKI_PRODUKTU, kompletnoscProduktow } = await import('@/lib/produkty/kompletnosc')

const sys = testSystemDb()
const a = testDb()
const b = testDb({ organizationId: ORG_B })
const HASLO_TESTOWE = ['test', 'a162', 'haslo', 'lokalne'].join('-')

beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await createUser(sys, { email: 'wlasciciel@firma-b.test', name: 'Właściciel Testowy B', password: HASLO_TESTOWE })
  await grantMembership(sys, { email: 'wlasciciel@firma-b.test', organizationId: ORG_B, role: 'WLASCICIEL' })
  await createUser(sys, { email: 'magazyn@firma-b.test', name: 'Magazyn Testowy B', password: HASLO_TESTOWE })
  await grantMembership(sys, { email: 'magazyn@firma-b.test', organizationId: ORG_B, role: 'MAGAZYN' })
  ciasteczko = undefined
})
afterAll(async () => {
  await a.$disconnect()
  await b.$disconnect()
})

async function jako(email: string): Promise<void> {
  const r = await login(sys, email, HASLO_TESTOWE)
  if (!r.ok) throw new Error(`logowanie ${email}: ${r.reason}`)
  ciasteczko = r.token
}
const html = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el)

describe('Ustawienia → Integracje', () => {
  it('firma bez żadnego konta: wszystkie pozycje „Niepodłączony” z „Podłącz”, ekran bez błędu, bez BL i wFirmy', async () => {
    // firma B bez seedBase: bez kont kanałów, przewoźników, poczty, kluczy i programu do faktur
    const d = await daneIntegracji(b, defaultRegistry(), { APP_MODE: 'hosted' })
    const pozycje = pozycjeIntegracji(d).flatMap((g) => g.pozycje)
    expect(pozycje.length).toBeGreaterThan(8)
    expect(pozycje.filter((p) => p.akcja.etykieta !== 'Podłącz').map((p) => p.klucz)).toEqual(['program:brak'])
    expect(JSON.stringify(pozycje)).not.toMatch(/BaseLinker|wFirma/)
    await jako('wlasciciel@firma-b.test')
    const h = await html(Integracje())
    expect(h).toContain('Integracje')
    expect(h).toContain('Niepodłączony')
    expect(h).toContain('href="/ustawienia/kanaly/nowy?platforma=woo"')
    expect(h).not.toMatch(/BaseLinker|wFirma/)
  })

  it('bez uprawnienia `ustawienia` = 404', async () => {
    await jako('magazyn@firma-b.test')
    await expect(Integracje()).rejects.toMatchObject({ digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/) })
  })

  it('ekran tylko czyta: wejście nie zmienia baz kont, sekretów ani dziennika', async () => {
    const przed = await Promise.all([b.channelConfig.count(), b.integrationSecret.count(), b.auditLog.count()])
    await jako('wlasciciel@firma-b.test')
    await html(Integracje())
    expect(await Promise.all([b.channelConfig.count(), b.integrationSecret.count(), b.auditLog.count()])).toEqual(przed)
  })
})

describe('Produkty → kafle kompletności', () => {
  async function towar(sku: string, d: { ean?: string | null; waga?: boolean; strefa?: string | null; oferta?: boolean; rodzaj?: 'STOCKED' | 'BUNDLE' | 'DIGITAL'; aktywny?: boolean } = {}) {
    const p = await a.product.create({
      data: {
        sku,
        kind: d.rodzaj ?? 'STOCKED',
        unit: 'SZT',
        nameAccounting: `Towar testowy ${sku}`,
        title: `Towar testowy ${sku}`,
        ean: d.ean === undefined ? `590${sku.replace(/\D/g, '').padStart(10, '0')}` : d.ean,
        ...(d.waga === false ? {} : { weightG: 100, lengthCm: 10, widthCm: 8, heightCm: 4 }),
        packingZone: d.strefa === undefined ? 'REGAL' : d.strefa,
        active: d.aktywny ?? true,
      },
    })
    if (d.rodzaj !== 'DIGITAL') await a.stock.create({ data: { productId: p.id, warehouseId: DEFAULT_WAREHOUSE, physical: 5, wfirmaCount: 5, wfirmaReadAt: new Date() } })
    if (d.oferta !== false) await a.channelOffer.create({ data: { productId: p.id, channel: 'WOO', channelAccountId: '7100001', externalId: `o-${sku}` } })
    return p.id
  }

  it('licznik kafla = liczba wierszy listy z tym filtrem; produkty bez stanu, wyłączone i innej firmy poza licznikami', async () => {
    await a.packingZoneDef.create({ data: { key: 'REGAL', name: 'Regał' } })
    await a.productZoneRule.create({ data: { priority: 1, pattern: '^KAWA', zone: 'REGAL' } })
    await towar('T-1')
    await towar('T-2', { ean: null })
    await towar('T-3', { waga: false, oferta: false })
    await towar('T-4', { strefa: null })
    await towar('KAWA-5', { strefa: null }) // strefa z reguły firmy
    await towar('Z-6', { rodzaj: 'BUNDLE', strefa: null, ean: null }) // zestaw: strefa nie dotyczy
    await towar('E-7', { rodzaj: 'DIGITAL', ean: null, waga: false, oferta: false })
    await towar('T-8', { ean: null, aktywny: false })
    await b.product.create({ data: { sku: 'B-1', kind: 'STOCKED', unit: 'SZT', nameAccounting: 'B', title: 'Towar firmy B' } })

    const k = await kompletnoscProduktow(a)
    expect({ razem: k.razem, kompletne: k.kompletne, bezStanu: k.bezStanu, maStrefy: k.maStrefy }).toEqual({ razem: 6, kompletne: 2, bezStanu: 1, maStrefy: true })
    expect(Object.fromEntries(BRAKI_PRODUKTU.map((x) => [x, k.braki[x].length]))).toEqual({ bez_ean: 2, bez_wagi: 1, bez_oferty: 1, bez_strefy: 1 })
    for (const x of BRAKI_PRODUKTU) {
      const lista = await productsPage(a, { filter: 'wszystkie', tylkoId: k.braki[x] })
      expect(lista.total, x).toBe(k.braki[x].length)
    }
    // wyszukiwanie zawęża dalej w obrębie kafla
    expect((await productsPage(a, { filter: 'wszystkie', q: 'Z-6', tylkoId: k.braki.bez_ean })).total).toBe(1)
    // firma bez stref: brak strefy nie jest brakiem
    expect((await kompletnoscProduktow(b)).maStrefy).toBe(false)
  })
})
