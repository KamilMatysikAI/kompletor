import { describe, expect, it } from 'vitest'
import type { SkutekPoprawionego } from '@/lib/rdzen/rozchod'
import { tekstSkutku, warunekPoprawionego } from './poprawione-skutek'

const NBSP = ' '
const s = (x: Partial<SkutekPoprawionego>): SkutekPoprawionego => ({ rodzaj: 'BL_INVOICE', ilosc: 20, jednostka: 'SZT', wfirma: 22, dostepnyPrzed: 2, dostepnyPo: 22, fakturaBezWz: 'FV 87/11/2026', blokada: null, ...x })

describe('okno „Poprawione w wFirmie”', () => {
  it('faktura bez WZ: skutek liczbami i ostrzeżenie z numerem faktury', () => {
    const t = tekstSkutku(s({}))
    expect(t.skutek).toBe(`Przy obecnym stanie z wFirmy (22${NBSP}szt.) stan dostępny wzrośnie o 20${NBSP}szt., z 2${NBSP}szt. do 22${NBSP}szt., i tyle zobaczą sklepy (konto w podglądzie: dopiero po przełączeniu w tryb pracy).`)
    expect(t.ostrzezenie).toBe('Kompletor nie znalazł w wFirmie WZ do tej faktury FV 87/11/2026: kliknij tylko, jeśli wydanie jest w wFirmie pod innym dokumentem.')
  })

  it('każdy rodzaj pozycji dostaje skutek liczbami; ostrzeżenie tylko przy fakturach', () => {
    for (const rodzaj of ['BL_INVOICE', 'OWN_INVOICE', 'ISSUED_WITHOUT_DOCUMENT', 'STOCK_MISSING', 'DAMAGED_RETURN']) {
      const faktura = rodzaj.endsWith('_INVOICE')
      const t = tekstSkutku(s({ rodzaj, ilosc: 3, wfirma: 10, dostepnyPrzed: 4, dostepnyPo: 7, fakturaBezWz: faktura ? '' : null }))
      expect(t.skutek).toContain(`wzrośnie o 3${NBSP}szt., z 4${NBSP}szt. do 7${NBSP}szt.`)
      expect(t.ostrzezenie !== null).toBe(faktura)
      expect(warunekPoprawionego(rodzaj)).toMatch(/w wFirmie$/)
    }
    expect(tekstSkutku(s({ fakturaBezWz: '' })).ostrzezenie).toBe('Kompletor nie znalazł w wFirmie WZ do tej faktury: kliknij tylko, jeśli wydanie jest w wFirmie pod innym dokumentem.')
  })

  it('rezerwacje zajmują cały stan: bez obietnicy wzrostu dostępnego', () => {
    const t = tekstSkutku(s({ ilosc: 2, wfirma: 5, dostepnyPrzed: 0, dostepnyPo: 0, rodzaj: 'STOCK_MISSING', fakturaBezWz: null }))
    expect(t.skutek).toBe(`Przy obecnym stanie z wFirmy (5${NBSP}szt.) pozycja przestanie pomniejszać stan o 2${NBSP}szt., ale stan dostępny zostanie 0${NBSP}szt., bo zajmują go rezerwacje.`)
    expect(t.ostrzezenie).toBeNull()
  })

  it('produkt na wagę: gramy', () => {
    expect(tekstSkutku(s({ jednostka: 'KG', ilosc: 250, wfirma: 900, dostepnyPrzed: 400, dostepnyPo: 650 })).skutek).toContain(`wzrośnie o 250${NBSP}g, z 400${NBSP}g do 650${NBSP}g`)
  })
})
