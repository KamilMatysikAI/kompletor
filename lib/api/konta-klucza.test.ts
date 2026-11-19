// Konta klucza obsługi klienta: odczyt kolumny (wszystko poza poprawnym kształtem = brak kont) i zawężenie kont
// z żądania do kont klucza (nigdy poszerzenie).
import { describe, expect, it } from 'vitest'
import { BRAK_KONT, kontaDoSzukania, kontaKluczaDoBazy, kontaKluczaZBazy, kontoZPola, poleKonta, type KontaKlucza } from './konta-klucza'

const KLUCZ_SD: KontaKlucza = { wszystkie: false, konta: [{ kanal: 'WOO', konto: 'sd' }, { kanal: 'ALLEGRO', konto: 'allegro' }] }

describe('kontaKluczaZBazy', () => {
  it('poprawne kształty', () => {
    expect(kontaKluczaZBazy({ wszystkie: true })).toEqual({ wszystkie: true })
    expect(kontaKluczaZBazy({ konta: [{ kanal: 'WOO', konto: 'sd' }] })).toEqual({ wszystkie: false, konta: [{ kanal: 'WOO', konto: 'sd' }] })
    expect(kontaKluczaZBazy(kontaKluczaDoBazy(KLUCZ_SD))).toEqual(KLUCZ_SD)
  })
  it('brak, uszkodzona albo niepełna wartość = brak kont, nigdy „wszystkie”', () => {
    for (const v of [null, undefined, 'wszystkie', true, [], {}, { wszystkie: 'tak' }, { wszystkie: 1 }, { konta: 'WOO:sd' }, { konta: [{ konto: 'sd' }] }, { konta: [{ kanal: 'WOO', konto: '' }] }]) {
      expect(kontaKluczaZBazy(v), JSON.stringify(v)).toEqual(BRAK_KONT)
    }
  })
})

describe('kontaDoSzukania', () => {
  it('klucz z kontami: bez parametru = konta klucza', () => {
    expect(kontaDoSzukania(KLUCZ_SD, undefined)).toEqual([{ kanal: 'WOO', konto: 'sd' }, { kanal: 'ALLEGRO', konto: 'allegro' }])
    expect(kontaDoSzukania(KLUCZ_SD, [])).toEqual([{ kanal: 'WOO', konto: 'sd' }, { kanal: 'ALLEGRO', konto: 'allegro' }])
  })
  it('parametr tylko zawęża; konto spoza klucza odpada', () => {
    expect(kontaDoSzukania(KLUCZ_SD, [{ konto: 'sd' }])).toEqual([{ kanal: 'WOO', konto: 'sd' }])
    expect(kontaDoSzukania(KLUCZ_SD, [{ konto: 'sd' }, { konto: 'lampy' }])).toEqual([{ kanal: 'WOO', konto: 'sd' }])
    expect(kontaDoSzukania(KLUCZ_SD, [{ konto: 'lampy' }])).toEqual([])
    expect(kontaDoSzukania(KLUCZ_SD, [{ kanal: 'ALLEGRO', konto: 'sd' }])).toEqual([])
    expect(kontaDoSzukania({ wszystkie: false, konta: [{ kanal: 'WOO', konto: 'sd' }] }, [{ kanal: 'ALLEGRO', konto: 'allegro' }])).toEqual([])
  })
  it('klucz bez kont: zawsze pusto', () => {
    expect(kontaDoSzukania(BRAK_KONT, undefined)).toEqual([])
    expect(kontaDoSzukania(BRAK_KONT, [{ konto: 'sd' }])).toEqual([])
  })
  it('klucz „wszystkie”: parametr albo cała firma', () => {
    expect(kontaDoSzukania({ wszystkie: true }, undefined)).toBeUndefined()
    expect(kontaDoSzukania({ wszystkie: true }, [{ konto: 'lampy' }])).toEqual([{ konto: 'lampy' }])
  })
})

describe('pole formularza konta', () => {
  it('kanał przed pierwszym dwukropkiem, id konta może go zawierać', () => {
    expect(kontoZPola(poleKonta('WOO', 'sd'))).toEqual({ kanal: 'WOO', konto: 'sd' })
    expect(kontoZPola('IDOSELL:shop:1')).toEqual({ kanal: 'IDOSELL', konto: 'shop:1' })
    for (const v of ['', 'sd', ':sd', 'WOO:']) expect(kontoZPola(v), v).toBeNull()
  })
})
