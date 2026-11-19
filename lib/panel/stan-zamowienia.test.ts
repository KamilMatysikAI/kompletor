import { describe, expect, it } from 'vitest'
import { stanZamowienia, type WejscieStanu } from './stan-zamowienia'

const baza: WejscieStanu = { status: 'DO_REALIZACJI', paymentState: 'PAID', carrier: 'DPD', wantInvoice: false, invoice: null, shipment: null, zwrot: null }
const tony = (o: Partial<WejscieStanu>, program = 'wfirma') => stanZamowienia({ ...baza, ...o }, program).map((i) => `${i.rodzaj}:${i.ton}`)

describe('kolumna „Stan” (R8)', () => {
  it('zawsze cztery ikony w stałej kolejności, każda z opisem', () => {
    const s = stanZamowienia(baza, 'wfirma')
    expect(s.map((i) => i.rodzaj)).toEqual(['platnosc', 'przesylka', 'dokument', 'zwrot'])
    expect(s.every((i) => i.opis.length > 5)).toBe(true)
  })

  it('płatność: opłacone zielone, nieopłacone szare, niedopłata i wysłane bez wpłaty czerwone', () => {
    expect(tony({})[0]).toBe('platnosc:sukces')
    expect(tony({ paymentState: 'UNPAID' })[0]).toBe('platnosc:neutralny')
    expect(tony({ paymentState: 'PARTIAL' })[0]).toBe('platnosc:blad')
    expect(tony({ paymentState: 'UNPAID', status: 'WYSLANE' })[0]).toBe('platnosc:blad')
    expect(tony({ paymentState: 'COD' })[0]).toBe('platnosc:info')
  })

  it('przesyłka: bez przesyłki szara, z etykietą zielona, błąd czerwony, wysłane zielone', () => {
    expect(tony({})[1]).toBe('przesylka:neutralny')
    expect(tony({ shipment: { state: 'UTWORZONA', label: true } })[1]).toBe('przesylka:sukces')
    expect(tony({ shipment: { state: 'BLAD', label: false } })[1]).toBe('przesylka:blad')
    expect(tony({ status: 'WYSLANE' })[1]).toBe('przesylka:sukces')
  })

  it('dokument: wystawiony zielony, brak szary, nieudany czerwony; firma bez programu do faktur bez alarmu', () => {
    expect(tony({ invoice: 'ISSUED' })[2]).toBe('dokument:sukces')
    expect(tony({})[2]).toBe('dokument:neutralny')
    expect(tony({ invoice: 'FAILED' })[2]).toBe('dokument:blad')
    expect(tony({ wantInvoice: true })[2]).toBe('dokument:ostrzezenie')
    expect(tony({ wantInvoice: true, status: 'WYSLANE' })[2]).toBe('dokument:blad')
    expect(tony({ wantInvoice: true, status: 'WYSLANE' }, 'brak')[2]).toBe('dokument:neutralny')
    expect(stanZamowienia(baza, 'brak')[2].opis).toMatch(/poza Kompletorem/)
  })

  it('zwrot: brak szary, w toku bursztyn, rozliczony zielony, nieudana korekta czerwona', () => {
    expect(tony({})[3]).toBe('zwrot:neutralny')
    expect(tony({ zwrot: { status: 'ZGLOSZONY', korekta: null } })[3]).toBe('zwrot:ostrzezenie')
    expect(tony({ zwrot: { status: 'ZAKONCZONY', korekta: 'ISSUED' } })[3]).toBe('zwrot:sukces')
    expect(tony({ zwrot: { status: 'KOREKTA', korekta: 'FAILED' } })[3]).toBe('zwrot:blad')
  })
})
