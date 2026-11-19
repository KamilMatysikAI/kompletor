import { describe, expect, it } from 'vitest'
import { linkDoKanalu, linkDoOferty } from './link-kanalu'

describe('linkDoKanalu', () => {
  it('Woo: panel zamówienia sklepu z adresu konta (także sklep w podkatalogu)', () => {
    expect(linkDoKanalu({ channel: 'WOO', config: { baseUrl: 'https://sklep.example.pl/' } }, '48213')).toBe('https://sklep.example.pl/wp-admin/post.php?post=48213&action=edit')
    expect(linkDoKanalu({ channel: 'WOO', config: { baseUrl: 'https://example.pl/sklep' } }, '7')).toBe('https://example.pl/sklep/wp-admin/post.php?post=7&action=edit')
  })

  it('Shoper i PrestaShop: tylko z adresem w konfiguracji; PrestaShop wymaga adresu panelu', () => {
    expect(linkDoKanalu({ channel: 'SHOPER', config: { baseUrl: 'https://sklep.shoparena.pl' } }, '15')).toBe('https://sklep.shoparena.pl/admin/orders/view/id/15')
    expect(linkDoKanalu({ channel: 'PRESTASHOP', config: { baseUrl: 'https://presta.example.pl' } }, '15')).toBeNull()
    expect(linkDoKanalu({ channel: 'PRESTASHOP', config: { adminUrl: 'https://presta.example.pl/admin123x/' } }, '15')).toBe('https://presta.example.pl/admin123x/index.php?controller=AdminOrders&id_order=15&vieworder')
  })

  it('Allegro: Sprzedaż w Moim Allegro, piaskownica z adresu API', () => {
    const id = '29b7a2f0-1c3d-11ef-9d8e-0123456789ab'
    expect(linkDoKanalu({ channel: 'ALLEGRO', config: {} }, id)).toBe(`https://allegro.pl/moje-allegro/sprzedaz/zamowienia/${id}`)
    expect(linkDoKanalu({ channel: 'ALLEGRO', config: { apiUrl: 'https://api.allegro.pl.allegrosandbox.pl' } }, id)).toBe(`https://allegro.pl.allegrosandbox.pl/moje-allegro/sprzedaz/zamowienia/${id}`)
  })

  it('Empik: panel sprzedawcy Mirakl z adresu konta', () => {
    expect(linkDoKanalu({ channel: 'EMPIK', config: { baseUrl: 'https://marketplace.empik.com/api' } }, 'EMP-123-A')).toBe('https://marketplace.empik.com/mmp/shop/order/EMP-123-A')
  })

  it('bez znanego adresu albo z dziwnym numerem: brak przycisku', () => {
    expect(linkDoKanalu(null, '1')).toBeNull()
    expect(linkDoKanalu({ channel: 'RECZNE', config: {} }, '1')).toBeNull()
    expect(linkDoKanalu({ channel: 'BL_INNE', config: {} }, '1')).toBeNull()
    expect(linkDoKanalu({ channel: 'WOO', config: {} }, '1')).toBeNull()
    expect(linkDoKanalu({ channel: 'WOO', config: { baseUrl: 'javascript:alert(1)' } }, '1')).toBeNull()
    expect(linkDoKanalu({ channel: 'WOO', config: { baseUrl: 'https://u:p@sklep.pl' } }, '1')).toBeNull()
    expect(linkDoKanalu({ channel: 'WOO', config: { baseUrl: 'https://sklep.pl' } }, '1#dosle-2')).toBeNull()
    expect(linkDoKanalu({ channel: 'WOO', config: { baseUrl: 'https://sklep.pl' } }, '12abc')).toBeNull()
    expect(linkDoKanalu({ channel: 'EMPIK', config: { baseUrl: 'https://marketplace.empik.com' } }, 'a b/../x')).toBe('https://marketplace.empik.com/mmp/shop/order/a%20b%2F..%2Fx')
  })
})

describe('linkDoOferty', () => {
  it('Allegro: strona oferty (sandbox z adresu API); Woo i PrestaShop: strona produktu po id produktu (wariant bez znaczenia)', () => {
    expect(linkDoOferty({ channel: 'ALLEGRO', config: {} }, '17890012345')).toBe('https://allegro.pl/oferta/17890012345')
    expect(linkDoOferty({ channel: 'ALLEGRO', config: { apiUrl: 'https://api.allegro.pl.allegrosandbox.pl' } }, '12345')).toBe('https://allegro.pl.allegrosandbox.pl/oferta/12345')
    expect(linkDoOferty({ channel: 'WOO', config: { baseUrl: 'https://sklep.example.pl/' } }, '501/77')).toBe('https://sklep.example.pl/?p=501')
    expect(linkDoOferty({ channel: 'PRESTASHOP', config: { baseUrl: 'https://presta.example.pl' } }, '10/55')).toBe('https://presta.example.pl/index.php?controller=product&id_product=10')
  })

  it('bez wzoru adresu, bez numeru, pozycja z przeprowadzki albo zły numer = brak linku', () => {
    expect(linkDoOferty({ channel: 'EMPIK', config: { baseUrl: 'https://x.example.pl' } }, 'SKU-1')).toBeNull()
    expect(linkDoOferty({ channel: 'ALLEGRO', config: {} }, null)).toBeNull()
    expect(linkDoOferty({ channel: 'ALLEGRO', config: {} }, 'bl-pozycja:12')).toBeNull()
    expect(linkDoOferty({ channel: 'ALLEGRO', config: {} }, 'abc')).toBeNull()
    expect(linkDoOferty({ channel: 'WOO', config: { baseUrl: 'javascript:alert(1)' } }, '5')).toBeNull()
    expect(linkDoOferty(null, '5')).toBeNull()
  })
})
