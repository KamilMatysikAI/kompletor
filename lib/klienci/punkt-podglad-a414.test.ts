// punkt odbioru do podglądu przesyłki rozróżnia „danych jeszcze nie ma”, „usunięte
// po okresie przechowywania” i „nie da się odczytać”, a wyjątek odczytu nie wywraca „Policz przesyłkę”.
import { afterEach, describe, expect, it, vi } from 'vitest'

const daneKlienta = vi.fn()
vi.mock('./odczyt', () => ({ daneKlienta: (...a: unknown[]) => daneKlienta(...a) }))
const { punktOdbioruZBazy } = await import('./wejscia')
const db = {} as never

afterEach(() => {
  daneKlienta.mockReset()
  vi.restoreAllMocks()
})

describe('punktOdbioruZBazy', () => {
  it('rekord z kodem = JEST; bez kodu = BRAK_PUNKTU; zawsze jako automat wysyłki z celem PRZESYLKA', async () => {
    daneKlienta.mockResolvedValueOnce({ stan: 'PELNY', rekord: { punktOdbioru: { kod: ' PL1 ' } } })
    expect(await punktOdbioruZBazy(db, 'z1', {})).toEqual({ stan: 'JEST', kod: 'PL1' })
    expect(daneKlienta).toHaveBeenCalledWith(db, 'z1', expect.objectContaining({ actorId: 'system:wysylka', zakres: 'PELNY', cel: 'PRZESYLKA' }))
    daneKlienta.mockResolvedValueOnce({ stan: 'PELNY', rekord: { punktOdbioru: null } })
    expect(await punktOdbioruZBazy(db, 'z1', {})).toEqual({ stan: 'BRAK_PUNKTU' })
  })

  it.each([
    [{ stan: 'BRAK' }, 'BRAK'],
    [{ stan: 'USUNIETE', usunieto: new Date() }, 'USUNIETE'],
    [{ stan: 'BRAK_KLUCZA' }, 'NIEODCZYTANE'],
    [{ stan: 'BLAD_SZYFRU' }, 'NIEODCZYTANE'],
    [{ stan: 'BEZ_UPRAWNIEN' }, 'NIEODCZYTANE'],
  ])('stan %o = NIEZNANY z powodem %s', async (d, powod) => {
    daneKlienta.mockResolvedValueOnce(d)
    expect(await punktOdbioruZBazy(db, 'z1', {})).toEqual({ stan: 'NIEZNANY', powod })
  })

  it('wyjątek odczytu (np. zapis śladu) = NIEODCZYTANE, ostrzeżenie w logu bez treści błędu', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    daneKlienta.mockRejectedValueOnce(new Error('jan.kowalski@example.com'))
    expect(await punktOdbioruZBazy(db, 'z1', {})).toEqual({ stan: 'NIEZNANY', powod: 'NIEODCZYTANE' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).not.toContain('example.com')
  })
})
