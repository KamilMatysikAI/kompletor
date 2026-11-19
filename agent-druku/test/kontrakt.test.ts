import { describe, expect, it } from 'vitest'
import { MAKS_KOPII, parsujZlecenia, WERSJA_AGENTA } from '../src/kontrakt.js'

const dobre = { id: 'Z-1', typ: 'etykieta', format: 'zpl', rola: 'TERMICZNA_1', plikUrl: '/api/druk/pliki/Z-1', kopie: 1 }

describe('kontrakt: odpowiedź GET /api/druk/zlecenia', () => {
  it('przyjmuje poprawne zlecenie (z opcjonalnym czasem utworzenia) i odrzuca nadmiarowe pola', () => {
    const w = parsujZlecenia({ zlecenia: [{ ...dobre, utworzono: '2026-10-25T08:00:00Z', klient: 'Jan Testowy' }] })
    expect(w.bledne).toEqual([])
    expect(w.poprawne).toEqual([{ ...dobre, utworzono: '2026-10-25T08:00:00Z' }])
  })

  it('bez tablicy zlecenia → wyjątek (cała odpowiedź do odrzucenia)', () => {
    expect(() => parsujZlecenia({})).toThrow(/zlecenia/)
    expect(() => parsujZlecenia(null)).toThrow()
  })

  it('każde złe pole opisane po polsku, zlecenie z poprawnym id wraca jako błędne z id', () => {
    const w = parsujZlecenia({
      zlecenia: [{ id: 'Z-2', typ: 'faktura', format: 'docx', rola: 'TERMICZNA_123', plikUrl: '', kopie: 0 }],
    })
    expect(w.poprawne).toEqual([])
    expect(w.bledne).toHaveLength(1)
    expect(w.bledne[0]!.id).toBe('Z-2')
    for (const fragment of ['nieznany typ', 'nieznany format', 'nieznana rola', 'brak adresu pliku', 'liczba kopii'])
      expect(w.bledne[0]!.powod).toContain(fragment)
  })

  it('limit kopii i liczby całkowite', () => {
    const kopie = (k: unknown) => parsujZlecenia({ zlecenia: [{ ...dobre, kopie: k }] }).poprawne.length
    expect(kopie(MAKS_KOPII)).toBe(1)
    expect(kopie(MAKS_KOPII + 1)).toBe(0)
    expect(kopie(1.5)).toBe(0)
    expect(kopie('2')).toBe(0)
  })

  it('id tylko z bezpiecznych znaków (idzie do URL i nazwy pliku)', () => {
    const w = parsujZlecenia({ zlecenia: [{ ...dobre, id: '..\\..\\windows' }, { ...dobre, id: 'a/b' }, 'tekst'] })
    expect(w.poprawne).toEqual([])
    expect(w.bledne.map((b) => b.id)).toEqual([undefined, undefined, undefined])
  })

  it('duplikat id w jednej odpowiedzi drukuje się raz', () => {
    expect(parsujZlecenia({ zlecenia: [dobre, dobre] }).poprawne).toHaveLength(1)
  })

  it('ZPL na A4 odrzucony; PDF na termicznej dozwolony', () => {
    expect(parsujZlecenia({ zlecenia: [{ ...dobre, rola: 'A4' }] }).bledne[0]).toMatchObject({ id: 'Z-1', rola: 'A4' })
    expect(parsujZlecenia({ zlecenia: [{ ...dobre, format: 'pdf' }] }).poprawne).toHaveLength(1)
  })
})

describe('role według wzoru', () => {
  const z = (rola: string, format = 'pdf') => ({ id: `Z-${rola}-${format}`, typ: 'etykieta', format, rola, plikUrl: '/p', kopie: 1 })
  it('TERMICZNA_4 i A4_2 są poprawne; ZPL tylko na termiczną (także nie na A4_2)', () => {
    const w = parsujZlecenia({ zlecenia: [z('TERMICZNA_4', 'zpl'), z('A4_2'), z('A4_2', 'zpl'), z('TERMICZNA_100')] })
    expect(w.poprawne.map((x) => x.id)).toEqual(['Z-TERMICZNA_4-zpl', 'Z-A4_2-pdf'])
    expect(w.bledne.find((b) => b.id === 'Z-A4_2-zpl')?.powod).toMatch(/ZPL nie może iść na drukarkę nietermiczną A4_2/)
    expect(w.bledne.find((b) => b.id === 'Z-TERMICZNA_100-pdf')?.powod).toMatch(/nieznana rola/)
  })
  it('wersja agenta 0.2.0', () => {
    expect(WERSJA_AGENTA).toBe('0.2.0')
  })
})
