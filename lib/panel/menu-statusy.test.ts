// statusy zamówień w menu mają te same liczniki co dawny panel statusów listy: ta sama funkcja
// `zlozLiczniki` z tych samych wierszy groupBy, inna prezentacja (kropka, kolejność, przewoźnicy pod statusem).
import { describe, expect, it } from 'vitest'
import { adresWidoku, pozycjeStatusow } from './menu-statusy'
import { GRUPY_PANELU, zlozLiczniki } from './zamowienia-lista'

const wiersze = [
  { status: 'NOWE' as const, carrier: null, n: 4 },
  { status: 'DO_REALIZACJI' as const, carrier: 'DPD' as const, n: 3 },
  { status: 'DO_REALIZACJI' as const, carrier: 'PACZKOMATY' as const, n: 2 },
  { status: 'ZEBRANE' as const, carrier: null, n: 1 },
  { status: 'WYSLANE' as const, carrier: 'DPD' as const, n: 7 },
  { status: 'DO_WYJASNIENIA' as const, carrier: null, n: 1 },
  { status: 'ANULOWANE' as const, carrier: null, n: 2 },
]

describe('pozycjeStatusow (menu „Zamówienia”)', () => {
  const l = zlozLiczniki(wiersze, 5)
  const p = pozycjeStatusow(l)

  it('każda grupa dawnego panelu jest w menu z tym samym licznikiem, „Wszystkie” i „Wymaga działania” na górze', () => {
    expect(p.map((x) => x.widok!.widok)).toEqual(['wszystkie', 'wymaga', 'nowe', 'do_realizacji', 'zebrane', 'spakowane', 'do_wyslania', 'wyslane', 'problemowe', 'anulowane'])
    for (const g of GRUPY_PANELU) expect(p.find((x) => x.widok!.widok === g.klucz)).toMatchObject({ etykieta: g.etykieta, licznik: l.grupy[g.klucz] })
    expect(p[0]).toMatchObject({ licznik: 20, licznikTon: 'neutralny' })
    expect(p[1]).toMatchObject({ licznik: 5, licznikTon: 'ostrzezenie' })
  })

  it('kropka tylko przy statusach, w tonie etapu; kolor statusu własnego firmy nadpisuje ton', () => {
    expect(p[0]!.kropka).toBeUndefined()
    expect(p[1]!.kropka).toBeUndefined()
    expect(p.find((x) => x.widok!.widok === 'nowe')!.kropka).toBe('info')
    expect(p.find((x) => x.widok!.widok === 'do_realizacji')!.kropka).toBe('ostrzezenie')
    expect(p.find((x) => x.widok!.widok === 'wyslane')!.kropka).toBe('akcent')
    expect(p.find((x) => x.widok!.widok === 'problemowe')!.kropka).toBe('uwaga')
    const z = pozycjeStatusow(l, { kolory: { nowe: '#123456' } })
    expect(z.find((x) => x.widok!.widok === 'nowe')!.kolor).toBe('#123456')
  })

  it('przewoźnicy pod statusem z kolejką magazynu, tylko niezerowi, liczniki jak w panelu', () => {
    const dr = p.find((x) => x.widok!.widok === 'do_realizacji')!
    expect(dr.dzieci.map((d) => [d.etykieta, d.licznik, d.href])).toEqual([
      ['Paczkomaty', 2, '/zamowienia?widok=do_realizacji&przewoznik=PACZKOMATY'],
      ['DPD', 3, '/zamowienia?widok=do_realizacji&przewoznik=DPD'],
    ])
    // przeglądu rebase 09.11: jedyny przewoźnik z licznikiem równym statusowi nie dubluje pozycji
    expect(p.find((x) => x.widok!.widok === 'zebrane')!.dzieci).toEqual([])
    // „Wysłane” nie ma podziału na przewoźników (jak w panelu)
    expect(p.find((x) => x.widok!.widok === 'wyslane')!.dzieci).toEqual([])
  })

  it('adres widoku zawsze z jawnym `widok`, żeby różnił się od adresu „Zamówienia”', () => {
    expect(adresWidoku('wymaga')).toBe('/zamowienia?widok=wymaga')
    expect(new Set(p.map((x) => x.href)).size).toBe(p.length)
    expect(p.every((x) => x.href !== '/zamowienia')).toBe(true)
  })
})

describe('„Po terminie” w menu', () => {
  const l = zlozLiczniki(wiersze, 5)
  it('pod „Wszystkie” i „Wymaga działania”, czerwony licznik tylko gdy coś jest po terminie; bez harmonogramu pozycji nie ma', () => {
    expect(pozycjeStatusow(l).some((x) => x.widok?.widok === 'po_terminie')).toBe(false)
    const p = pozycjeStatusow({ ...l, poTerminie: 3 })
    expect(p.slice(0, 3).map((x) => x.widok!.widok)).toEqual(['wszystkie', 'wymaga', 'po_terminie'])
    expect(p[2]).toMatchObject({ etykieta: 'Po terminie', licznik: 3, licznikTon: 'blad', href: '/zamowienia?widok=po_terminie' })
    expect(pozycjeStatusow({ ...l, poTerminie: 0 })[2]).toMatchObject({ licznik: 0, licznikTon: 'neutralny' })
    // statusy firmy: ta sama pozycja zaraz pod „Wszystkie”
    const f = pozycjeStatusow({ ...l, poTerminie: 1, firmy: { grupy: [], statusy: [], ile: {}, przewoznicy: {} } })
    expect(f.slice(0, 3).map((x) => x.etykieta)).toEqual(['Wszystkie', 'Wymaga działania', 'Po terminie'])
  })
})
