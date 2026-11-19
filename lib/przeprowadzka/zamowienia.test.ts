import { describe, expect, it } from 'vitest'
import type { FetchIssue } from '../import/pobieranie'
import { AtrapaBlPrzeprowadzki, NOW, PII_SENTINELS, zamowienia } from '@/tests/bl-przeprowadzka-atrapa'
import { externalIdOf, parseBlOrder, pobierzZamowienia, POLA_POZYCJI, POLA_ZAMOWIENIA, stanPlatnosci, ZleZamowienie } from './zamowienia'

const byId = (id: number) => zamowienia().find((o) => o['order_id'] === id)!

describe('parser zamówień BL — lista dozwolonych pól', () => {
  it('kopiuje tylko pola z listy; dane klienta i nieznane pola odrzucone', () => {
    for (const raw of zamowienia().filter((o) => o['order_id'] !== 5007)) {
      const o = parseBlOrder(raw)
      expect(Object.keys(o).filter((k) => k !== 'products').sort()).toEqual([...POLA_ZAMOWIENIA].sort())
      for (const p of o.products) expect(Object.keys(p).sort()).toEqual([...POLA_POZYCJI].sort())
      const json = JSON.stringify(o)
      for (const s of PII_SENTINELS) expect(json).not.toContain(s)
      expect(json).not.toContain('nowe_pole_bl')
    }
  })

  it('pozycja dodana z ręki: nazwa zastąpiona (nazwę mogą tworzyć dane klienta)', () => {
    const o = parseBlOrder(byId(5006))
    expect(o.products[1]!.name).toBe('pozycja ręczna bez SKU')
  })

  it('zły rekord: błąd z samym id, bez wartości pól', () => {
    let err: unknown
    try {
      parseBlOrder(byId(5007))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ZleZamowienie)
    expect(String((err as Error).message)).toContain('5007')
    for (const s of PII_SENTINELS) expect(String((err as Error).message)).not.toContain(s)
    expect(() => parseBlOrder({ email: PII_SENTINELS[1] })).toThrow(/bez order_id/)
  })

  it('płatność i id zamówienia w kanale', () => {
    expect(stanPlatnosci(parseBlOrder(byId(5001)))).toBe('PAID') // 2 × 20 + 12
    expect(stanPlatnosci(parseBlOrder(byId(5003)))).toBe('COD')
    expect(stanPlatnosci(parseBlOrder(byId(5005)))).toBe('UNPAID')
    expect(stanPlatnosci({ ...parseBlOrder(byId(5001)), payment_done: 10 })).toBe('PARTIAL')
    expect(externalIdOf(parseBlOrder(byId(5001)), 'WOO')).toBe('7001')
    expect(externalIdOf(parseBlOrder(byId(5002)), 'ALLEGRO')).toBe('alg-1111')
    expect(externalIdOf(parseBlOrder(byId(5006)), 'BL_INNE')).toBe('bl:5006')
  })
})

describe('pobieranie zamówień: limity stron', () => {
  const wzor = () => zamowienia().find((o) => o['order_id'] === 5001)!
  /** n zamówień fikcyjnych w statusie BL, id od `od`, data dodania „przed chwilą”. */
  const seria = (n: number, status: number, od: number) =>
    Array.from({ length: n }, (_, i) => ({ ...wzor(), order_id: od + i, order_status_id: status, date_add: Math.floor(NOW.getTime() / 1000) - 3600 }))

  it('otwarte zamówienia poza limitem stron: complete = false i wpis w problemach', async () => {
    const fake = new AtrapaBlPrzeprowadzki()
    fake.orders = seria(150, 1, 10_000)
    const issues: FetchIssue[] = []
    const r = await pobierzZamowienia(fake.client(), ['1'], issues, { now: NOW, maxStron: 1, dniOstatnich: 0 })
    expect(r.complete).toBe(false)
    expect(r.otwarte).toHaveLength(100)
    expect(issues.map((i) => i.message).join(' ')).toMatch(/więcej niż 1 stron/)
  })

  it('okno „ostatnich” obcięte limitem: bez wpisu w problemach, complete zostaje true', async () => {
    const fake = new AtrapaBlPrzeprowadzki()
    fake.orders = [...seria(5, 1, 10_000), ...seria(250, 3, 20_000)]
    const issues: FetchIssue[] = []
    const r = await pobierzZamowienia(fake.client(), ['1'], issues, { now: NOW, maxStronOkna: 2 })
    expect(r).toMatchObject({ complete: true, ostatnieObciete: true })
    expect(r.ostatnie).toHaveLength(200)
    expect(issues).toEqual([])
  })

  it('status do decyzji: jedna strona, status na liście obciętych, bez wpisu w problemach i bez wpływu na complete', async () => {
    const fake = new AtrapaBlPrzeprowadzki()
    fake.orders = [...seria(3, 1, 10_000), ...seria(150, 5, 20_000)]
    const issues: FetchIssue[] = []
    const r = await pobierzZamowienia(fake.client(), ['1', '5'], issues, { now: NOW, dniOstatnich: 0, statusyDoDecyzji: new Set(['5']) })
    expect(r).toMatchObject({ complete: true, statusyObciete: ['5'] })
    expect(fake.calls.filter((c) => c.method === 'getOrders' && c.params['status_id'] === 5)).toHaveLength(1)
    expect(r.otwarte.filter((o) => o.order_status_id === '5')).toHaveLength(100)
    expect(issues).toEqual([])
  })
})
