import { describe, expect, it } from 'vitest'
import { defaultRegistry } from '../adaptery/domyslne'
import type { FetchIssue } from '../import/pobieranie'
import { AtrapaBlPrzeprowadzki, zamowienia } from '@/tests/bl-przeprowadzka-atrapa'
import { kontoDlaZrodla, pobierzKonfiguracje, planuj } from './rozpoznanie'
import { parseMapa } from './statusy'
import { parseBlOrder } from './zamowienia'

const orders = () => zamowienia().filter((o) => o['order_id'] !== 5007).map(parseBlOrder)

describe('rozpoznanie konfiguracji BL', () => {
  it('konta z źródeł BL: sklep Woo, Allegro, źródła bez adaptera → BL_INNE z ostrzeżeniem', async () => {
    const issues: FetchIssue[] = []
    const k = await pobierzKonfiguracje(new AtrapaBlPrzeprowadzki().client(), issues)
    expect(issues).toEqual([])
    const plan = planuj({ konfiguracja: k, zamowienia: orders(), registry: defaultRegistry() })
    expect(plan.bladKatalogu).toBeNull()
    expect(plan.katalog).toMatchObject({ id: '700', grupaCen: '10', magazynStanu: 'bl_501' })
    const konta = Object.fromEntries(plan.konta.map((x) => [`${x.zrodlo.typ}:${x.zrodlo.id}`, x]))
    expect(konta['shop:9001']).toMatchObject({ channel: 'WOO', channelAccountId: '9001', blStorageId: 'shop_9001', adapterKey: 'woo.rest.v1', ostrzezenie: null })
    expect(konta['allegro:31']).toMatchObject({ channel: 'ALLEGRO', channelAccountId: '31', adapterKey: 'allegro.v1' })
    expect(konta['tiktok:5']).toMatchObject({ channel: 'BL_INNE', channelAccountId: 'tiktok:5' })
    expect(konta['tiktok:5']!.ostrzezenie).toMatch(/bez adaptera/)
    expect(konta['personal:0']).toMatchObject({ channel: 'BL_INNE', channelAccountId: 'personal:0' })
  })

  it('zamówienie dodane z ręki w BL (personal) zawsze BL_INNE, także gdy rejestr ma adapter manual.v1', () => {
    const zManual = { get: (k: string) => (k === 'manual.v1' ? ({} as never) : defaultRegistry().get(k)) }
    expect(kontoDlaZrodla('personal', '0', 'Ręczne', [], zManual)).toMatchObject({ channel: 'BL_INNE', channelAccountId: 'personal:0' })
  })

  it('przewoźnicy: tylko metody z zamówień; jawna nazwa = reguła, reszta do decyzji; moduł BRAK', async () => {
    const k = await pobierzKonfiguracje(new AtrapaBlPrzeprowadzki().client(), [])
    const plan = planuj({ konfiguracja: k, zamowienia: orders(), registry: defaultRegistry() })
    const metody = plan.reguly.map((r) => [r.channel, r.metoda, r.carrier, r.shippingModule])
    expect(metody).toContainEqual(['ALLEGRO', null, 'ALLEGRO', 'BRAK'])
    expect(metody).toContainEqual([null, 'Kurier DPD', 'DPD', 'BRAK'])
    expect(metody).toContainEqual([null, 'Paczkomaty InPost', 'PACZKOMATY', 'BRAK'])
    expect(plan.reguly.every((r) => r.shippingModule === 'BRAK' && !r.adapterKey)).toBe(true)
    expect(plan.decyzjePrzewoznikow.map((d) => d.metoda)).toEqual(['Poczta Polska'])
    // decyzja człowieka zamienia sprawę w regułę
    const z = planuj({ konfiguracja: k, zamowienia: orders(), registry: defaultRegistry(), mapa: parseMapa({ przewoznicy: { 'Poczta Polska': 'BRAK' } }) })
    expect(z.decyzjePrzewoznikow).toEqual([])
    expect(z.reguly.find((r) => r.metoda === 'Poczta Polska')).toMatchObject({ carrier: 'BRAK', pewnosc: 'DECYZJA' })
  })

  it('kilka katalogów: bez --katalog plan wymaga wyboru', async () => {
    const fake = new AtrapaBlPrzeprowadzki()
    fake.katalogi = [...fake.katalogi, { inventory_id: 701, name: 'Drugi', default_price_group: 10, default_warehouse: 'bl_501', warehouses: ['bl_501'] }]
    const k = await pobierzKonfiguracje(fake.client(), [])
    const bez = planuj({ konfiguracja: k, zamowienia: [], registry: defaultRegistry() })
    expect(bez.katalog).toBeNull()
    expect(bez.bladKatalogu).toMatch(/--katalog/)
    expect(planuj({ konfiguracja: k, katalog: '701', zamowienia: [], registry: defaultRegistry() }).katalog?.id).toBe('701')
  })
})
