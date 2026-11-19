// podpowiedź pól zamówienia Woo (NIP, punkt odbioru, „chcę fakturę”) z nazw kluczy meta (bez bazy).
import { describe, expect, it } from 'vitest'
import { kluczeZZamowien } from '@/lib/adaptery/woo'
import { proponujPolaMeta, wykryteZBazy } from './woo-meta'

const k = (key: string, orders = 5) => ({ key, orders })

describe('nazwy kluczy z zamówień', () => {
  it('liczy wystąpienia na zamówienie (dubel w jednym zamówieniu raz), bez wartości, odsiewa złe nazwy', () => {
    const r = kluczeZZamowien([
      { id: 1, meta_data: [{ key: '_billing_nip', value: 'NIP 1234563218' }, { key: '_billing_nip', value: 'x' }, { key: 'zła nazwa ze spacją', value: 1 }] },
      { id: 2, meta_data: [{ key: '_billing_nip' }, { key: '_paczkomat_id', value: 'POZ01M' }] },
      { id: 3 },
      'śmieć',
    ])
    expect(r).toEqual({ sample: 3, keys: [k('_billing_nip', 2), k('_paczkomat_id', 1)] })
    expect(JSON.stringify(r)).not.toMatch(/1234563218|POZ01M/)
    expect(kluczeZZamowien({ nie: 'lista' })).toBeNull()
  })
  it('odczyt z bazy: kształt sprawdzony, śmieci = null', () => {
    expect(wykryteZBazy({ sample: 2, keys: [k('_nip', 1), { key: 'zły klucz', orders: 1 }], at: '2026-11-08T10:00:00.000Z' })).toEqual({ sample: 2, keys: [k('_nip', 1)], at: '2026-11-08T10:00:00.000Z' })
    expect(wykryteZBazy(null)).toBeNull()
    expect(wykryteZBazy({ sample: 'x', keys: [], at: '' })).toBeNull()
  })
})

describe('propozycje pól', () => {
  it('typowy sklep polski: NIP, paczkomat i „chcę fakturę” z wtyczek', () => {
    const p = proponujPolaMeta([k('_billing_nip', 4), k('_paczkomat_id', 6), k('_billing_faktura', 3), k('_wc_order_attribution_source_type', 10)])
    expect(p.nipMetaKey?.key).toBe('_billing_nip')
    expect(p.pickupPointMetaKey?.key).toBe('_paczkomat_id')
    expect(p.invoiceMetaKey?.key).toBe('_billing_faktura')
  })
  it('nie myli numeru wystawionej faktury ani numeru przesyłki z polem do ustawienia', () => {
    const p = proponujPolaMeta([k('_wfirma_invoice_id', 9), k('_invoice_number', 9), k('_fakturownia_invoice_pdf', 9), k('_inpost_tracking_number', 9), k('_nip_status', 9)])
    expect(p).toEqual({})
  })
  it('znana nazwa wtyczki wygrywa z częstszą pasującą; reszta w „inne”', () => {
    const p = proponujPolaMeta([k('_custom_point_code', 10), k('_paczkomat_id', 2), k('_pickup_point', 1)])
    expect(p.pickupPointMetaKey).toMatchObject({ key: '_paczkomat_id', inne: ['_pickup_point', '_custom_point_code'] })
  })
  it('jeden klucz najwyżej w jednym polu', () => {
    const p = proponujPolaMeta([k('_vat_number', 3)])
    expect(p.nipMetaKey?.key).toBe('_vat_number')
    expect(p.invoiceMetaKey).toBeUndefined()
  })
  it('bez pasujących: brak propozycji', () => {
    expect(proponujPolaMeta([k('_order_key'), k('is_vat_exempt')])).toEqual({})
  })
})
