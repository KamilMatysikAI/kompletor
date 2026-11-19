import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { RejestrWydrukow, zamienZPonowieniem } from '../src/rejestr.js'

let plik: string
beforeEach(() => {
  plik = join(mkdtempSync(join(tmpdir(), 'rejestr-')), 'dane', 'wydrukowane.json')
})

describe('rejestr wydrukowanych zleceń', () => {
  it('przeżywa restart: wpisy czytane z pliku przez nową instancję', async () => {
    const { rejestr } = await RejestrWydrukow.wczytaj(plik)
    await rejestr.oznaczWToku('a', 'Termiczna 1')
    await rejestr.oznaczWydrukowane('a', 'Termiczna 1')
    await rejestr.oznaczWToku('b', 'Brother A4')

    const { rejestr: poRestarcie } = await RejestrWydrukow.wczytaj(plik)
    expect(poRestarcie.pobierz('a')).toMatchObject({ stan: 'WYDRUKOWANE', drukarka: 'Termiczna 1' })
    expect(poRestarcie.pobierz('b')).toMatchObject({ stan: 'W_TOKU' })
    expect(poRestarcie.pobierz('c')).toBeUndefined()
  })

  it('usuwa wpis po odrzuconym druku', async () => {
    const { rejestr } = await RejestrWydrukow.wczytaj(plik)
    await rejestr.oznaczWToku('a', 'x')
    await rejestr.usun('a')
    const { rejestr: r2 } = await RejestrWydrukow.wczytaj(plik)
    expect(r2.pobierz('a')).toBeUndefined()
  })

  it('sprząta wpisy starsze niż 7 dni, młodsze zostają', async () => {
    let teraz = new Date('2026-10-01T12:00:00Z')
    const { rejestr } = await RejestrWydrukow.wczytaj(plik, { teraz: () => teraz })
    await rejestr.oznaczWydrukowane('stary', 'x')
    teraz = new Date('2026-10-05T12:00:00Z')
    await rejestr.oznaczWydrukowane('mlodszy', 'x')

    teraz = new Date('2026-10-08T11:59:59Z') // 6 dni 23:59:59 od „stary”
    expect(await rejestr.sprzataj()).toBe(0)
    teraz = new Date('2026-10-08T12:00:01Z')
    expect(await rejestr.sprzataj()).toBe(1)
    expect(rejestr.pobierz('stary')).toBeUndefined()
    expect(rejestr.pobierz('mlodszy')).toBeDefined()
    // sprzątanie zapisane na dysku
    const { rejestr: r2 } = await RejestrWydrukow.wczytaj(plik, { teraz: () => teraz })
    expect(r2.rozmiar).toBe(1)
  })

  it('uszkodzony plik odkłada na bok i zaczyna od pustego', async () => {
    const { rejestr } = await RejestrWydrukow.wczytaj(plik)
    await rejestr.oznaczWydrukowane('a', 'x')
    writeFileSync(plik, '{"wpisy": {"a": ') // np. zanik prądu przy starym, nieatomowym zapisie
    const { rejestr: r2, uszkodzony } = await RejestrWydrukow.wczytaj(plik)
    expect(r2.rozmiar).toBe(0)
    expect(uszkodzony).toMatch(/wydrukowane\.json\.uszkodzony-\d+$/)
    expect(existsSync(uszkodzony!)).toBe(true)
  })

  it('zamiana pliku ponawia przy EPERM/EBUSY/EACCES (antywirus), poddaje się po 5 próbach, inny błąd od razu', async () => {
    const blad = (code: string) => Object.assign(new Error(code), { code })
    let wywolania = 0
    await zamienZPonowieniem('a', 'b', async () => {
      wywolania++
      if (wywolania <= 2) throw blad(wywolania === 1 ? 'EPERM' : 'EBUSY')
    })
    expect(wywolania).toBe(3)

    wywolania = 0
    await expect(
      zamienZPonowieniem('a', 'b', async () => {
        wywolania++
        throw blad('EACCES')
      }),
    ).rejects.toThrow('EACCES')
    expect(wywolania).toBe(5)

    wywolania = 0
    await expect(
      zamienZPonowieniem('a', 'b', async () => {
        wywolania++
        throw blad('ENOSPC')
      }),
    ).rejects.toThrow('ENOSPC')
    expect(wywolania).toBe(1)
  })

  it('równoległe zapisy nie gubią wpisów i nie zostawiają pliku tymczasowego', async () => {
    const { rejestr } = await RejestrWydrukow.wczytaj(plik)
    await Promise.all(Array.from({ length: 20 }, (_, i) => rejestr.oznaczWydrukowane(`z${i}`, 'x')))
    const { rejestr: r2 } = await RejestrWydrukow.wczytaj(plik)
    expect(r2.rozmiar).toBe(20)
    expect(readdirSync(join(plik, '..'))).toEqual(['wydrukowane.json'])
  })
})
