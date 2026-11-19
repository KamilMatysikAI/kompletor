// parser `Organization.settings.oferty` — brak i śmieci dają neutralne domyślne, nic nie pada.
import { describe, expect, it } from 'vitest'
import { DOMYSLNE_USTAWIENIA_KANALOW, ustawieniaOfertZSettings } from './ustawienia'

describe('ustawienia ofert firmy', () => {
  it('brak sekcji oferty = domyślne neutralne', () => {
    expect(ustawieniaOfertZSettings(null)).toBe(DOMYSLNE_USTAWIENIA_KANALOW)
    expect(ustawieniaOfertZSettings({ faktury: {} })).toBe(DOMYSLNE_USTAWIENIA_KANALOW)
    expect(ustawieniaOfertZSettings({ oferty: [] })).toBe(DOMYSLNE_USTAWIENIA_KANALOW)
  })

  it('złe wpisy są pomijane, dobre zostają', () => {
    const u = ustawieniaOfertZSettings({
      oferty: {
        mapaKategoriiAllegro: { kubek: '110886', zly: 'abc', pusty: '' },
        parametry: { marka: '  Pracownia Testowa ', stale: { '3458': 'liściasta', x: 'y', '1': 5 }, wagiPoSlowie: { kubek: '0.300', zla: 'dużo' }, domyslnePerKategoria: { '110886': { '23389': 'ceramika', '224017': { zPola: 'nip' } } } },
        szablonOpisu: { naglowki: { uzycie: 'Parzenie' }, oMarce: 42 },
        empik: { mapaKategorii: { przyprawa: '13-34-8-2', zla: 'a b c' }, stawkaVat: '8%', minIloscAlarm: -1 },
        woo: { status: 'publish', poleEan: '_ean; DROP' },
      },
    })
    expect(u.mapaKategorii.poSlowie).toEqual({ kubek: '110886' })
    expect(u.parametry.marka).toBe('Pracownia Testowa')
    expect(u.parametry.stale).toEqual({ '3458': 'liściasta' })
    expect(u.parametry.wagiPoSlowie).toEqual({ kubek: '0.300' })
    expect(u.parametry.domyslnePerKategoria).toEqual({ '110886': { '23389': 'ceramika' } })
    expect(u.szablonOpisu.naglowki.uzycie).toBe('Parzenie')
    expect(u.szablonOpisu.naglowki.opis).toBe('Opis produktu')
    expect(u.szablonOpisu.oMarce).toBeNull()
    expect(u.empik).toEqual({ mapaKategorii: { poSlowie: { przyprawa: '13-34-8-2' } }, stawkaVat: '8%', minIloscAlarm: 2 })
    expect(u.woo).toEqual({ status: 'publish', poleEan: 'global_unique_id' })
  })
})
