// walidacja „Dodaj produkt” i listy bez stanu, rodzaj z typu wFirmy, preset a lista z panelu,
// uprawnienie, odczyt towaru wFirmy przez atrapę (bez sieci). Dane fikcyjne.
import { describe, expect, it } from 'vitest'
import { can, permissionsOf } from '../auth/uprawnienia'
import { fillMissingCatalog } from '../organizacje'
import { kindOfWfirmaType } from './dodawanie'
import { checkEan, checkNoStock, checkSku, checkTitle, linesOf } from './walidacja'
import { findWfirmaGood } from './wfirma-towar'

describe('walidacja wejścia', () => {
  it('SKU: trim, 1–64 znaki, bez znaków sterujących', () => {
    expect(checkSku('  EB-01 ')).toEqual({ ok: true, value: 'EB-01' })
    expect(checkSku('').ok).toBe(false)
    expect(checkSku('   ').ok).toBe(false)
    expect(checkSku(null).ok).toBe(false)
    expect(checkSku('x'.repeat(64)).ok).toBe(true)
    expect(checkSku('x'.repeat(65)).ok).toBe(false)
    expect(checkSku('A\tB').ok).toBe(false)
    expect(checkSku('A\u0000B').ok).toBe(false)
    expect(checkSku('Zielona przyprawa ąę/1').ok).toBe(true)
  })

  it('nazwa 1–200 znaków; EAN przez normalizeEan (pusty = brak, zła suma = błąd)', () => {
    expect(checkTitle(' Poradnik ')).toEqual({ ok: true, value: 'Poradnik' })
    expect(checkTitle('').ok).toBe(false)
    expect(checkTitle('a'.repeat(201)).ok).toBe(false)
    expect(checkEan('')).toEqual({ ok: true, value: null })
    expect(checkEan(' 5901234123457 ')).toEqual({ ok: true, value: '5901234123457' })
    expect(checkEan('5901234123458').ok).toBe(false)
    expect(checkEan('abc').ok).toBe(false)
  })

  it('lista bez stanu: po wierszu, bez pustych i powtórzeń; kategoria „konto:id”', () => {
    expect(linesOf(' a \r\n\nb\na\n')).toEqual(['a', 'b'])
    expect(checkNoStock('ebook1\nebook2\n', '7100001:117\n')).toEqual({ ok: true, value: { skus: ['ebook1', 'ebook2'], shopCategories: ['7100001:117'] } })
    expect(checkNoStock('', '')).toEqual({ ok: true, value: { skus: [], shopCategories: [] } })
    expect(checkNoStock('x'.repeat(65), '').ok).toBe(false)
    expect(checkNoStock('', '117').ok).toBe(false)
    expect(checkNoStock('', 'sklep 1:117').ok).toBe(false)
  })
})

describe('rodzaj z wFirmy (nigdy z nazwy)', () => {
  it('good i set = ze stanem, service = bez stanu', () => {
    expect(kindOfWfirmaType('good')).toBe('STOCKED')
    expect(kindOfWfirmaType('set')).toBe('STOCKED')
    expect(kindOfWfirmaType('service')).toBe('DIGITAL')
  })
})

describe('preset a lista z panelu (fillMissingCatalog)', () => {
  const preset = { noStock: { skus: ['ebook1'] }, nonOfferSkus: ['naklejka'] }
  it('bez flagi pusta lista dalej uzupełniana z presetu (jak dotąd)', () => {
    expect(fillMissingCatalog({ noStock: { skus: [] } }, preset)).toEqual({ noStock: { skus: ['ebook1'] }, nonOfferSkus: ['naklejka'] })
  })
  it('lista zapisana w panelu (edytowanoWPanelu) nie jest uzupełniana, także pusta; inne klucze tak', () => {
    expect(fillMissingCatalog({ noStock: { skus: [], shopCategories: [] }, edytowanoWPanelu: true }, preset)).toEqual({
      noStock: { skus: [], shopCategories: [] },
      edytowanoWPanelu: true,
      nonOfferSkus: ['naklejka'],
    })
    expect(fillMissingCatalog({ noStock: { skus: [] }, nonOfferSkus: ['wlasny'], edytowanoWPanelu: true }, preset)).toBeNull()
  })
})

describe('uprawnienie produkty.dodawanie', () => {
  it('właściciel ma, biuro i magazyn tylko jako dodatkowe', () => {
    expect(can({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] }, 'produkty.dodawanie')).toBe(true)
    expect(can({ role: 'BIURO', permissions: [], deniedPermissions: [] }, 'produkty.dodawanie')).toBe(false)
    expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, 'produkty.dodawanie')).toBe(false)
    expect(can({ role: 'BIURO', permissions: ['produkty.dodawanie'], deniedPermissions: [] }, 'produkty.dodawanie')).toBe(true)
    expect(permissionsOf({ role: 'MAGAZYN', permissions: ['produkty.dodawanie'], deniedPermissions: [] }).has('produkty.dodawanie')).toBe(true)
  })
})

describe('odczyt towaru wFirmy po kodzie (atrapa)', () => {
  const good = (id: string, code: string, over: Record<string, unknown> = {}) => ({
    good: { id, code, name: `Towar ${id}`, type: 'good', unit: 'szt.', count: '3', value: '30', vat_code: { id: '222' }, warehouse: { id: '900014' }, ...over },
  })
  function fake(goods: ReturnType<typeof good>[]) {
    const calls: { path: string; body: unknown }[] = []
    return {
      calls,
      call: async <T,>(path: string, body: unknown = {}): Promise<T> => {
        calls.push({ path, body })
        if (path === 'vat_codes/find') return { vat_codes: { 0: { vat_code: { id: '222', code: '23' } } } } as T
        return { goods: { ...Object.fromEntries(goods.map((g, i) => [String(i), g])), parameters: { total: goods.length } } } as T
      },
    }
  }

  it('warunek code eq w goods/find, tylko odczyty; wynik przefiltrowany po kodzie i magazynie', async () => {
    const wf = fake([good('1', 'EB-1'), good('2', 'INNY'), good('3', 'EB-1', { warehouse: { id: '999' } })])
    const r = await findWfirmaGood(wf, 'EB-1', '900014')
    expect(r.goods.map((g) => g.id)).toEqual(['1'])
    expect(r.goods[0]).toMatchObject({ vatRate: '23', countBase: 3, purchasePriceNet: 10 })
    expect(r.otherWarehouse).toEqual(['3'])
    expect(wf.calls.map((c) => c.path)).toEqual(['vat_codes/find', 'goods/find'])
    expect(wf.calls[1]!.body).toEqual({ api: { goods: { parameters: { conditions: { condition: { field: 'code', operator: 'eq', value: 'EB-1' } }, page: 1, limit: 20 } } } })
  })

  it('usługa bez magazynu zostaje, towar bez magazynu odpada', async () => {
    const wf = fake([good('5', 'S-1', { type: 'service', warehouse: null }), good('6', 'S-1', { warehouse: null })])
    const r = await findWfirmaGood(wf, 'S-1', '900014')
    expect(r.goods.map((g) => g.id)).toEqual(['5'])
    expect(r.otherWarehouse).toEqual(['6'])
  })
})
