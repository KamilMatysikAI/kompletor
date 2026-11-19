import { describe, expect, it } from 'vitest'
import { blokujaceStatusy, doZapisu, mapaStatusow, parseMapa, proponujStatus, statusFirmyDlaBl, statusyOtwarte, TERMINALNE, ZlaMapa } from './statusy'

const st = (id: string, name: string, group: string | null = null) => ({ id, name, group })

describe('mapa statusów BL', () => {
  it.each([
    ['Nowe zamówienia', 'NOWE'],
    ['Nieopłacone', 'NOWE'],
    ['Opłacone', 'DO_REALIZACJI'],
    ['Do realizacji Paczkomaty', 'DO_REALIZACJI'],
    ['W realizacji', 'ZBIERANIE'],
    ['Spakowane', 'SPAKOWANE'],
    ['Do wysłania', 'DO_WYSLANIA'],
    ['Wysłane', 'WYSLANE'],
    ['Wyslane kurierem', 'WYSLANE'],
    ['Odebrane', 'ODEBRANE'],
    ['Zrealizowane', 'ODEBRANE'],
    ['Anulowane', 'ANULOWANE'],
    ['Reklamacja', 'REKLAMACJA'],
    ['Do wyjaśnienia', 'DO_WYJASNIENIA'],
    ['Problem z płatnością', 'DO_WYJASNIENIA'],
  ])('pewne: „%s” → %s', (name, status) => {
    const d = proponujStatus(st('1', name))
    expect(d.status).toBe(status)
    expect(d.pewnosc).toBe('PEWNE')
  })

  it('nieznany status: DO_WYJASNIENIA, do decyzji, nie terminalny', () => {
    const d = proponujStatus(st('9', 'Status Xyz'))
    expect(d).toMatchObject({ status: 'DO_WYJASNIENIA', pewnosc: 'DO_DECYZJI', podpowiedz: null })
    expect(TERMINALNE.has(d.status)).toBe(false)
  })

  it('niepewne nigdy terminalne: grupa „Zakończone” podpowiada, ale skutkiem jest DO_WYJASNIENIA', () => {
    const d = proponujStatus(st('9', 'Etap 7', 'Zakończone'))
    expect(d.podpowiedz).toBe('ODEBRANE')
    expect(d.status).toBe('DO_WYJASNIENIA')
    expect(d.pewnosc).toBe('DO_DECYZJI')
  })

  it('nieodebrane i zwrot: do decyzji (nie „odebrane”)', () => {
    expect(proponujStatus(st('1', 'Nieodebrane'))).toMatchObject({ status: 'DO_WYJASNIENIA', pewnosc: 'DO_DECYZJI' })
    expect(proponujStatus(st('2', 'Zwrot'))).toMatchObject({ status: 'DO_WYJASNIENIA', podpowiedz: 'REKLAMACJA', pewnosc: 'DO_DECYZJI' })
  })

  it('mapa człowieka nadpisuje propozycję, otwarte statusy i blokada', () => {
    const list = [st('1', 'Nowe zamówienia'), st('3', 'Wysłane'), st('5', 'Status Xyz'), st('6', 'Inny niepewny')]
    const bez = mapaStatusow(list)
    expect(statusyOtwarte(bez)).toEqual(['1', '5', '6'])
    const open = new Map([['5', 2]])
    expect(blokujaceStatusy(bez, open).map((d) => d.blStatusId)).toEqual(['5']) // 6 bez zamówień nie blokuje
    const z = mapaStatusow(list, parseMapa({ statusy: { '5': 'ANULOWANE' } }))
    expect(z.find((d) => d.blStatusId === '5')).toMatchObject({ status: 'ANULOWANE', pewnosc: 'DECYZJA' })
    expect(statusyOtwarte(z)).toEqual(['1', '6'])
    expect(blokujaceStatusy(z, open)).toEqual([])
    expect(doZapisu(z)['5']).toEqual({ status: 'ANULOWANE', nazwa: 'Status Xyz', pewnosc: 'DECYZJA' })
  })

  it('zły plik mapy = odmowa, nie zgadywanie', () => {
    expect(() => parseMapa({ statusy: { '5': 'ZAKONCZONE' } })).toThrow(ZlaMapa)
    expect(() => parseMapa({ statusy: { abc: 'NOWE' } })).toThrow(ZlaMapa)
    expect(() => parseMapa({ przewoznicy: { 'Kurier X': 'UPS' } })).toThrow(ZlaMapa)
    expect(() => parseMapa({ klienci: {} })).toThrow(ZlaMapa)
    expect(parseMapa({ przewoznicy: { 'Poczta Polska': 'BRAK' } }).przewoznicy).toEqual({ 'poczta polska': 'BRAK' })
  })
})

describe('mapa statusów BL → status firmy', () => {
  it('ACME: ta sama nazwa i etap = ten status firmy; inna nazwa = pierwszy status etapu; etap bez statusu = null', async () => {
    const { presetStatusy } = await import('@/lib/organizacje')
    const { ACME_PRESET } = await import('@/tests/preset-testowy')
    const defs = presetStatusy(ACME_PRESET).statusy
    expect(statusFirmyDlaBl({ nazwa: 'Zebrane DPD', status: 'ZEBRANE' }, defs)).toEqual({ klucz: 'ZEBRANE_DPD', nazwa: 'Zebrane DPD', poNazwie: true })
    expect(statusFirmyDlaBl({ nazwa: 'zebrane dpd ', status: 'ZEBRANE' }, defs)?.klucz).toBe('ZEBRANE_DPD')
    expect(statusFirmyDlaBl({ nazwa: 'Wyslane', status: 'WYSLANE' }, defs)).toMatchObject({ klucz: 'WYSLANE', poNazwie: true })
    expect(statusFirmyDlaBl({ nazwa: 'Czeka na kuriera', status: 'DO_WYSLANIA' }, defs)).toMatchObject({ klucz: 'DO_WYSLANIA', poNazwie: false })
    // nazwa pasuje, ale etap inny: nie po nazwie
    expect(statusFirmyDlaBl({ nazwa: 'Zebrane DPD', status: 'DO_WYJASNIENIA' }, defs)).toMatchObject({ klucz: 'DO_WYJASNIENIA', poNazwie: false })
    expect(statusFirmyDlaBl({ nazwa: 'x', status: 'ZEBRANE' }, defs.filter((d) => d.baseStatus !== 'ZEBRANE'))).toBeNull()
  })
})
