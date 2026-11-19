// pobranie zdjęcia z oferty przypina adres — lookup przy łączeniu sprawdza każdy adres,
// więc nazwa „publiczna” przy sprawdzeniu i wewnętrzna przy połączeniu (DNS rebinding) nie przejdzie.
import { describe, expect, it } from 'vitest'
import { pobierzPrzypiete, przypietyLookup } from './zdjecia'

const wynik = (lookup: ReturnType<typeof przypietyLookup>, all: boolean) =>
  new Promise<{ err: Error | null; addr: unknown; fam?: number }>((res) => lookup('sklep.example', { all }, (err, addr, fam) => res({ err, addr, fam })))

describe('przypięty lookup', () => {
  it('adres publiczny przechodzi (pojedynczy i lista), wewnętrzny albo mieszany = błąd', async () => {
    expect(await wynik(przypietyLookup(async () => ['93.184.216.34']), false)).toMatchObject({ err: null, addr: '93.184.216.34', fam: 4 })
    expect(await wynik(przypietyLookup(async () => ['93.184.216.34', '2606:4700::1111']), true)).toMatchObject({ err: null, addr: [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }] })
    expect((await wynik(przypietyLookup(async () => ['93.184.216.34', '10.0.0.5']), true)).err?.message).toMatch(/sieć wewnętrzną/)
    expect((await wynik(przypietyLookup(async () => []), false)).err).not.toBeNull()
  })

  it('pobierzPrzypiete: nazwa rozwiązana przy łączeniu na 127.0.0.1 = odmowa bez połączenia', async () => {
    let calls = 0
    const rebinding = async (_host: string) => (calls++ === 0 ? ['93.184.216.34'] : ['127.0.0.1'])
    await rebinding('sklep.example') // „sprawdzenie” przed pobraniem widzi adres publiczny
    await expect(pobierzPrzypiete(new URL('https://sklep.example/a.jpg'), rebinding, 5_000)).rejects.toThrow(/sieć wewnętrzną/)
    expect(calls).toBe(2)
  })
})
