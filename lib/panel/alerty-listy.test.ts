import { describe, expect, it } from 'vitest'
import { ukryteAlertyZ, wybierzAlerty, zIgnorowanym } from './alerty-listy'

describe('alerty nad listą zamówień (R9)', () => {
  it('najwyżej 3, w kolejności pilności, z akcją; zera i brak harmonogramu nie dają alertu', () => {
    const a = wybierzAlerty({ poTerminie: 4, bezRuchu: 2, braki: 5, ponadStan: 1 }, {})
    expect(a.map((x) => x.rodzaj)).toEqual(['po_terminie', 'bez_ruchu', 'braki'])
    expect(a[0]).toMatchObject({ ton: 'blad', tekst: '4 zamówienia czekają na wysyłkę po terminie.', akcja: { href: '/zamowienia?widok=po_terminie' } })
    expect(wybierzAlerty({ bezRuchu: 0, braki: 0, ponadStan: 0 }, {})).toEqual([])
    expect(wybierzAlerty({ poTerminie: 0, bezRuchu: 0, braki: 1, ponadStan: 0 }, {})[0]?.tekst).toBe('1 brak towaru czeka na decyzję.')
    expect(wybierzAlerty({ bezRuchu: 0, braki: 12, ponadStan: 0 }, {})[0]?.tekst).toBe('12 braków towaru czeka na decyzję.')
  })

  it('„Ignoruj” chowa alert do zmiany liczby; schowany robi miejsce czwartemu', () => {
    const d = { poTerminie: 4, bezRuchu: 2, braki: 5, ponadStan: 1 }
    expect(wybierzAlerty(d, { po_terminie: '4' }).map((x) => x.rodzaj)).toEqual(['bez_ruchu', 'braki', 'ponad_stan'])
    expect(wybierzAlerty(d, { po_terminie: '4' }).find((x) => x.rodzaj === 'ponad_stan')?.akcja.href).toBe('/braki?lista=stany') // adres bez nazwy programu do faktur
    expect(wybierzAlerty({ ...d, poTerminie: 5 }, { po_terminie: '4' })[0]?.rodzaj).toBe('po_terminie')
  })

  it('zapis per osoba i firma: inne firmy zostają, śmieci odrzucone', () => {
    const j = zIgnorowanym({ orgB: { braki: '3' }, orgA: { zly: 'x', po_terminie: 'abc' } }, 'orgA', 'bez_ruchu', '2')
    expect(j).toEqual({ orgB: { braki: '3' }, orgA: { bez_ruchu: '2' } })
    expect(ukryteAlertyZ(j, 'orgA')).toEqual({ bez_ruchu: '2' })
    expect(zIgnorowanym({}, 'orgA', 'cokolwiek', '2')).toBeNull()
    expect(zIgnorowanym({}, 'orgA', 'braki', '-1')).toBeNull()
    expect(ukryteAlertyZ(null, 'orgA')).toEqual({})
  })
})

describe('alert widoku, który już jest na ekranie', () => {
  it('na liście „Po terminie” alert „po terminie” nie zajmuje miejsca, wchodzi czwarty', () => {
    const d = { poTerminie: 4, bezRuchu: 2, braki: 5, ponadStan: 1 }
    expect(wybierzAlerty(d, {}, 'po_terminie').map((x) => x.rodzaj)).toEqual(['bez_ruchu', 'braki', 'ponad_stan'])
  })
})
