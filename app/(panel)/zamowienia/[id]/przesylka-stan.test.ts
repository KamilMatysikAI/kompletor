// osoba bez nadawania nie widzi „Przesyłka utworzona” przy przesyłce w toku albo niejasnej.
import { describe, expect, it } from 'vitest'
import { tekstStanuBezNadania } from './przesylka-stan'

describe('tekstStanuBezNadania', () => {
  it('stan przesyłki w zdaniu', () => {
    expect(tekstStanuBezNadania('UTWORZONA')).toBe('Przesyłka utworzona.')
    expect(tekstStanuBezNadania('TWORZENIE')).toBe('Przesyłka tworzy się u przewoźnika.')
    expect(tekstStanuBezNadania('NIEJEDNOZNACZNA')).toContain('do sprawdzenia u przewoźnika')
    expect(tekstStanuBezNadania('NIEJEDNOZNACZNA')).not.toContain('utworzona')
  })
})
