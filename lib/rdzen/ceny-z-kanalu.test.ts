// porównanie cen pozycji z kanałem (czysta funkcja) i opis powodu „Do wyjaśnienia”.
import { describe, expect, it } from 'vitest'
import { powodZmianyCeny, rozniceCen } from './zamowienia'

const l = (externalLineId: string, unitPriceGross: number, removed = false) => ({ externalLineId, unitPriceGross, removed })

describe('rozniceCen', () => {
  it('różnica co do grosza tylko dla pozycji obecnych po obu stronach', () => {
    expect(rozniceCen([l('1', 10), l('2', 5.5)], [{ externalLineId: '1', unitPriceGross: 12.345 }, { externalLineId: '2', unitPriceGross: 5.5 }, { externalLineId: '3', unitPriceGross: 1 }])).toEqual([
      { pozycja: '1', z: '10.00', na: '12.35' },
    ])
  })
  it('bez usuniętych, pozycji z karty, zamienników i pozycji bez ceny z kanału', () => {
    const linie = [l('1', 10, true), l('kompletor#karta-1', 10), l('2#zamiana-1', 10), l('3', 10)]
    const kanal = [
      { externalLineId: '1', unitPriceGross: 11 },
      { externalLineId: 'kompletor#karta-1', unitPriceGross: 11 },
      { externalLineId: '2#zamiana-1', unitPriceGross: 11 },
      { externalLineId: '3' },
      { externalLineId: '3x', unitPriceGross: Number.NaN },
    ]
    expect(rozniceCen(linie, kanal)).toEqual([])
  })
  it('zapamiętana cena kanału ma pierwszeństwo przed ceną pozycji', () => {
    expect(rozniceCen([l('1', 50)], [{ externalLineId: '1', unitPriceGross: 61.7 }], { '1': '61.70' })).toEqual([])
    expect(rozniceCen([l('1', 50)], [{ externalLineId: '1', unitPriceGross: 65 }], { '1': '61.70' })).toEqual([{ pozycja: '1', z: '61.70', na: '65.00' }])
  })
  it('cena pozycji jako Decimal (toString)', () => {
    expect(rozniceCen([{ externalLineId: '1', unitPriceGross: { toString: () => '21.70' }, removed: false }], [{ externalLineId: '1', unitPriceGross: 21.7 }])).toEqual([])
  })
})

describe('powodZmianyCeny', () => {
  it('pozycje i ceny słowami, z przecinkiem', () => {
    expect(powodZmianyCeny([{ pozycja: 'L1', z: '61.70', na: '71.70' }, { pozycja: 'L2', z: '1.00', na: '0.50' }])).toBe(
      'cena pozycji zmieniona w sklepie po przyjęciu, Kompletor zostawił poprzednią: L1 61,70 zł → 71,70 zł, L2 1,00 zł → 0,50 zł',
    )
  })
})
