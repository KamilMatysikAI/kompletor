// kiedy różnica między kartą a zamówieniem to tylko skutek braku, a kiedy karta jest nieaktualna.
import { describe, expect, it } from 'vitest'
import { tylkoSkutkiBraku, type MigawkaPozycji } from './zamowienia'

const L = (l: string, q: number, b?: number): MigawkaPozycji => ({ l, p: `p-${l}`, q, ...(b ? { b } : {}) })
const zgl = (...x: string[]) => new Set(x)

describe('tylkoSkutkiBraku', () => {
  it('brak zgłoszony na stanowisku: mniej do zebrania na tej pozycji = karta ważna', () => {
    expect(tylkoSkutkiBraku([L('a', 2), L('b', 1)], [L('a', 2, 1), L('b', 1)], zgl('a'))).toBe(true)
  })
  it('„dośle”: brak przeniesiony, reszta bez zmian, także bez zgłoszenia na stanowisku', () => {
    expect(tylkoSkutkiBraku([L('a', 2, 1)], [L('a', 1)], zgl())).toBe(true)
    expect(tylkoSkutkiBraku([L('a', 2)], [L('a', 1)], zgl('a'))).toBe(true)
  })
  it('cała pozycja zniknęła po zgłoszeniu i dosłaniu', () => {
    expect(tylkoSkutkiBraku([L('a', 1), L('b', 1)], [L('b', 1)], zgl('a'))).toBe(true)
  })
  it('mniej bez zgłoszenia, więcej, nowa pozycja, inny produkt, zniknięcie bez zgłoszenia = nowa karta', () => {
    expect(tylkoSkutkiBraku([L('a', 2)], [L('a', 1)], zgl())).toBe(false)
    expect(tylkoSkutkiBraku([L('a', 2, 1)], [L('a', 2)], zgl('a'))).toBe(false)
    expect(tylkoSkutkiBraku([L('a', 2)], [L('a', 2, 1), L('z', 1)], zgl('a'))).toBe(false)
    expect(tylkoSkutkiBraku([L('a', 2)], [{ l: 'a', p: 'inny', q: 2, b: 1 }], zgl('a'))).toBe(false)
    expect(tylkoSkutkiBraku([L('a', 1), L('b', 1)], [L('b', 1)], zgl())).toBe(false)
  })
  it('brak zamknięty „Jednak jest w paczce” = karta ważna; ta sama zmiana bez tego zamknięcia albo większa ilość = nowa karta', () => {
    expect(tylkoSkutkiBraku([L('a', 6, 2)], [L('a', 6)], zgl(), zgl('a'))).toBe(true)
    expect(tylkoSkutkiBraku([L('a', 6, 2)], [L('a', 6)], zgl(), zgl())).toBe(false)
    expect(tylkoSkutkiBraku([L('a', 6, 2)], [L('a', 8)], zgl(), zgl('a'))).toBe(false)
    expect(tylkoSkutkiBraku([L('a', 6, 2)], [L('a', 6, 1)], zgl(), zgl('a'))).toBe(true)
  })
  it('śmieci w rejestrze wydruków = nowa karta', () => {
    expect(tylkoSkutkiBraku(null, [], zgl())).toBe(false)
  })
})
