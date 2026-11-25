// Dodatkowa przesyłka: walidacja okna „Dodaj przesyłkę”, paczka bez pobrania, rodzaj w API i brak zdarzeń dla
// automatów (czyste funkcje, bez bazy i przewoźnika).
import { describe, expect, it } from 'vitest'
import { rodzajApi } from '@/lib/api/zamowienia'
import { zdarzeniaZDziennika, ZMIANY_STATUSU } from '@/lib/automaty/silnik'
import { KOSZT_MAX, paczkaDodatkowej, POWOD_MAX, STATUSY_DODATKOWEJ, walidujDodatkowa } from './dodatkowa'

const OK = { rodzaj: 'DOSYLKA', powod: '  reklamacja:   brak produktu ', gabaryt: 'INPOST_A', koszt: '14,50', potwierdzam: true }

describe('walidujDodatkowa', () => {
  it('poprawne pola: powód ze ściśniętymi spacjami, koszt z przecinkiem jako liczba', () => {
    expect(walidujDodatkowa('PACZKOMATY', OK)).toEqual({ ok: true, wejscie: { rodzaj: 'DOSYLKA', powod: 'reklamacja: brak produktu', gabaryt: 'INPOST_A', kosztNetto: 14.5 } })
    expect(walidujDodatkowa('PACZKOMATY', { ...OK, koszt: '' })).toMatchObject({ ok: true, wejscie: { kosztNetto: null } })
    expect(walidujDodatkowa('PACZKOMATY', { ...OK, koszt: 9 })).toMatchObject({ ok: true, wejscie: { kosztNetto: 9 } })
  })

  it('brak potwierdzenia (także „true” jako tekst) = odmowa, zanim cokolwiek innego', () => {
    expect(walidujDodatkowa('PACZKOMATY', { ...OK, potwierdzam: false })).toMatchObject({ ok: false, powod: expect.stringMatching(/Zaznacz/) })
    expect(walidujDodatkowa('PACZKOMATY', { ...OK, potwierdzam: 'true' })).toMatchObject({ ok: false })
  })

  it('rodzaj spoza słownika, w tym klucze prototypu', () => {
    for (const rodzaj of ['', 'INNA', 'toString', '__proto__', null]) expect(walidujDodatkowa('PACZKOMATY', { ...OK, rodzaj }).ok, String(rodzaj)).toBe(false)
  })

  it('powód krótszy niż 5 albo dłuższy niż limit znaków', () => {
    expect(walidujDodatkowa('PACZKOMATY', { ...OK, powod: ' abcd ' }).ok).toBe(false)
    expect(walidujDodatkowa('PACZKOMATY', { ...OK, powod: 'x'.repeat(POWOD_MAX + 1) }).ok).toBe(false)
    expect(walidujDodatkowa('PACZKOMATY', { ...OK, powod: 42 }).ok).toBe(false)
  })

  it('gabaryt innego przewoźnika niż w zamówieniu', () => {
    expect(walidujDodatkowa('PACZKOMATY', { ...OK, gabaryt: 'DPD' }).ok).toBe(false)
    expect(walidujDodatkowa('DPD', { ...OK, gabaryt: 'DPD' }).ok).toBe(true)
  })

  it('koszt: literówka, ujemny, ponad limit, więcej niż 2 miejsca po przecinku', () => {
    for (const koszt of ['15000', '-5', String(KOSZT_MAX + 1), '1,234', 'abc', '1e3']) expect(walidujDodatkowa('PACZKOMATY', { ...OK, koszt }).ok, koszt).toBe(false)
    expect(walidujDodatkowa('PACZKOMATY', { ...OK, koszt: String(KOSZT_MAX) }).ok).toBe(true)
  })
})

describe('paczkaDodatkowej', () => {
  const z = { carrier: 'PACZKOMATY' as const, pozycje: [{ ilosc: 2, jednostka: 'szt' as const, wagaSztukiG: 300 }] } as never
  it('zawsze bez pobrania, gabaryt z okna, waga ze składu', () => {
    const p = paczkaDodatkowej(z, 'basecourier.zapis.v1', { defaultWeightKg: 1 }, 'INPOST_B', 'POZ08M')!
    expect(p.codAmount).toBeNull()
    expect(p.gabaryt).toBe('INPOST_B')
    expect(p.weightKg).toBeCloseTo(0.6, 5)
    expect(p.problems.some((x) => x.kod.startsWith('pobranie'))).toBe(false)
  })
  it('moduł bez liczenia przesyłki = null', () => {
    expect(paczkaDodatkowej(z, 'nie.ma.v1', {}, 'INPOST_A', null)).toBeNull()
  })
  // osobna przesyłka jednopaczkowa do tego samego punktu: bez błędu „tylko przesyłka jednopaczkowa… wyślij razem”
  const DPD_CONFIG = { defaultSideXCm: 40, defaultSideYCm: 30, defaultSideZCm: 20, defaultWeightKg: 1 }
  const pozycje = [{ ilosc: 1, jednostka: 'szt' as const, wagaSztukiG: 900 }]
  it('DPD Pickup: dosyłka do tego samego punktu bez błędu jednej paczki', () => {
    const p = paczkaDodatkowej({ carrier: 'DPD', pozycje } as never, 'dpd.services.zapis.v1', DPD_CONFIG, 'DPD', 'PL11033')!
    expect(p.courierCode).toBe('DPD_PICKUP')
    expect(p.pickupPoint).toBe('PL11033')
    expect(p.problems.filter((x) => x.poziom === 'BLAD')).toEqual([])
    expect(p.problems.some((x) => x.kod === 'pickup_jedna_paczka')).toBe(false)
  })
  it('salon Empik: dosyłka do tego samego salonu bez błędu jednej paczki i bez ostrzeżenia salonu (salony potwierdzone nadaniem)', () => {
    const p = paczkaDodatkowej({ carrier: 'DPD_EMPIK', pozycje } as never, 'dpd.services.zapis.v1', DPD_CONFIG, 'DPD', 'PL99001')!
    expect(p.courierCode).toBe('DPD_PICKUP')
    expect(p.pickupPoint).toBe('PL99001')
    expect(p.problems.map((x) => `${x.poziom}:${x.kod}`)).toEqual([])
  })
})

describe('dodatkowa przesyłka poza automatami i statusem', () => {
  it('zdarzenie PRZESYLKA_DODATKOWA nie daje zdarzeń reguł i nie jest zmianą statusu', () => {
    expect(zdarzeniaZDziennika({ kind: 'PRZESYLKA_DODATKOWA', actorId: 'u', data: { przesylka: 's', numerDodatkowej: 1 } })).toEqual([])
    expect((ZMIANY_STATUSU as readonly string[]).includes('PRZESYLKA_DODATKOWA')).toBe(false)
    // dla porównania: główna przesyłka wyzwala „utworzono przesyłkę”
    expect(zdarzeniaZDziennika({ kind: 'PRZESYLKA_UTWORZONA', actorId: 'u', data: {} })).toEqual(['UTWORZONO_PRZESYLKE'])
  })
  it('statusy, w których wolno dodać: tylko po utworzeniu głównej (od spakowania)', () => {
    expect([...STATUSY_DODATKOWEJ]).toEqual(['SPAKOWANE', 'DO_WYSLANIA', 'WYSLANE', 'ODEBRANE', 'REKLAMACJA'])
  })
})

describe('rodzajApi', () => {
  it('główna, rodzaje dodatkowej i nieznany rodzaj (nigdy GLOWNA dla dodatkowej)', () => {
    expect(rodzajApi(0, null)).toBe('GLOWNA')
    expect(rodzajApi(1, 'DOSYLKA')).toBe('DOSYLKA')
    expect(rodzajApi(2, 'ZASTEPCZA')).toBe('ZASTEPCZA')
    expect(rodzajApi(3, 'DODATKOWA')).toBe('DODATKOWA')
    expect(rodzajApi(4, 'COS_NOWEGO')).toBe('DODATKOWA')
    expect(rodzajApi(1, null)).toBe('DODATKOWA')
  })
})
