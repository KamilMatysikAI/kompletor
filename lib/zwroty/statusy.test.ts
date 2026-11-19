// nazwy statusów jak w BL i historia zwrotu ze zdarzeń zamówienia (kto, kiedy).
import { describe, expect, it } from 'vitest'
import { AKTOR_ZWROTOW_KANALU, etykietaPowodu, historiaZwrotu, ktoZrobil, powodZAllegro, STATUS_ZWROTU, STATUSY_ZWROTU } from './statusy'

describe('statusy zwrotów', () => {
  it('5 statusów jak w module zwrotów BL, w kolejności', () => {
    expect(STATUSY_ZWROTU.map((s) => STATUS_ZWROTU[s])).toEqual(['Nowe', 'Odebrane', 'W trakcie', 'Zakończone', 'Odrzucone'])
  })
  it('powody: słownik po kodzie, reklamacja ma własny, tekst spoza słownika zostaje; Allegro → nasz kod', () => {
    expect(etykietaPowodu('ZWROT', 'odstapienie')).toBe('Odstąpienie od umowy (14 dni)')
    expect(etykietaPowodu('REKLAMACJA', 'uszkodzony')).toBe('Produkt uszkodzony w transporcie')
    expect(etykietaPowodu('ZWROT', 'coś innego')).toBe('coś innego')
    expect(etykietaPowodu('ZWROT', null)).toBeNull()
    expect(powodZAllegro('DAMAGED')).toBe('uszkodzony')
    expect(powodZAllegro('NOWY_TYP')).toBe('inny')
  })
  it('historia: tylko zdarzenia tego zwrotu, od najstarszego, osoba po imieniu, odczyt kanału i system słowami', () => {
    const t = (m: number) => new Date(Date.UTC(2026, 10, 9, 10, m))
    const osoby = new Map([['u1', 'Anna']])
    const h = historiaZwrotu(
      'r1',
      [
        { kind: 'ZWROT_PRZYJETY', actorId: 'user:u1', createdAt: t(5), data: { returnId: 'r1' } },
        { kind: 'ZWROT_ZGLOSZONY', actorId: AKTOR_ZWROTOW_KANALU, createdAt: t(1), data: { returnId: 'r1' } },
        { kind: 'ZWROT_ZGLOSZONY', actorId: 'user:u1', createdAt: t(2), data: { returnId: 'r2' } },
        { kind: 'KOREKTA', actorId: 'system:korekty', createdAt: t(9), data: { returnId: 'r1', docId: '8001' } },
        { kind: 'PACZKA_WYSLANA', actorId: 'user:u1', createdAt: t(3), data: { returnId: 'r1' } },
        { kind: 'ZWROT_NA_STAN', actorId: 'user:u1', createdAt: t(6), data: { returnId: 'r1', naStan: 0, pozaStanem: 1 } },
      ],
      osoby,
    )
    expect(h.map((x) => [x.co, x.kto])).toEqual([
      ['Zwrot zgłoszony', 'odczyt zwrotów z kanału'],
      ['Paczka odebrana w magazynie', 'Anna'],
      ['Zwrot rozliczony: towar uszkodzony, poza sprzedażą', 'Anna'],
      ['Korekta faktury wystawiona (dokument 8001)', 'system'],
    ])
    expect(ktoZrobil('user:obcy', osoby)).toBe('użytkownik')
  })
})
