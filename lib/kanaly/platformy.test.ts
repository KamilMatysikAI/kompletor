// kreator „Dodaj sklep” — kafle platform i pola konieczne.
import { describe, expect, it } from 'vitest'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { domyslnaWartosc, platformaZAdresu, platformy, podzialPol } from './platformy'

const registry = defaultRegistry()

describe('platformy', () => {
  it('jeden kafel na platformę, w stałej kolejności, domyślnie wersja z zapisem', () => {
    const p = platformy(registry)
    expect(p.map((x) => x.klucz)).toEqual(['woo', 'shoper', 'prestashop', 'idosell', 'allegro', 'empik'])
    for (const x of p) {
      expect(registry.get(x.adapterKey)?.manifest.channel).toBe(x.channel)
      if (x.wersje.some((w) => !w.readOnly)) expect(registry.get(x.adapterKey)!.manifest.readOnly).toBe(false)
    }
  })
  it('Allegro: kreator zakłada wersję z zapisem (allegro.zapis.v1), zapis startuje wyłączony', () => {
    const a = platformaZAdresu(registry, { platforma: 'allegro' })!
    expect(a.adapterKey).toBe('allegro.zapis.v1')
    expect(a.wersje.map((w) => w.adapterKey)).toContain('allegro.v1')
    expect(registry.get(a.adapterKey)!.manifest.config.map((f) => f.key)).toContain('zapisWlaczony')
  })
  it('adres po kluczu i po starym ?rodzaj=', () => {
    expect(platformaZAdresu(registry, { platforma: 'allegro' })?.channel).toBe('ALLEGRO')
    expect(platformaZAdresu(registry, { rodzaj: 'woo.rest.v1' })?.klucz).toBe('woo')
    expect(platformaZAdresu(registry, { platforma: 'nie-ma' })).toBeNull()
  })
  it('w widoku domyślnym najwyżej 4 pola (z nazwą), reszta w „Zaawansowane”', () => {
    for (const x of platformy(registry)) {
      const m = registry.get(x.adapterKey)!.manifest
      const { podstawowe, zaawansowane, klucze, kluczeZaawansowane } = podzialPol(m, {})
      expect(1 + podstawowe.length + klucze.length, x.klucz).toBeLessThanOrEqual(4)
      expect(podstawowe.every((f) => f.required)).toBe(true)
      expect(zaawansowane.map((f) => f.key)).not.toContain('envPrefix')
      expect(kluczeZaawansowane.every((f) => !f.required)).toBe(true)
    }
    const woo = podzialPol(registry.get(platformy(registry)[0]!.adapterKey)!.manifest, {})
    expect(woo.podstawowe.map((f) => f.key)).toEqual(['baseUrl'])
    expect(woo.zaawansowane.map((f) => f.key)).toEqual(expect.arrayContaining(['nipMetaKey', 'pickupPointMetaKey', 'holdStockMinutes']))
  })
  it('Allegro: User-Agent wypełniony sam, w formacie wymaganym przez Allegro', () => {
    const m = registry.get(platformaZAdresu(registry, { platforma: 'allegro' })!.adapterKey)!.manifest
    const ua = m.config.find((f) => f.key === 'userAgent')!
    const v = domyslnaWartosc(m, 'userAgent', { APP_PUBLIC_URL: 'https://panel.firma.pl/' })
    expect(v).toBe('Kompletor/1.0 (+https://panel.firma.pl)')
    expect(ua.pattern!.test(v)).toBe(true)
    expect(ua.pattern!.test(domyslnaWartosc(m, 'userAgent', { PANEL_URL: 'javascript:x' }))).toBe(true)
    expect(podzialPol(m, {}).podstawowe).toEqual([])
  })
})
