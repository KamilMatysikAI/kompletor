// (część 2): akcje „Podpowiedz podział adresu” i „Zatwierdź” (karta zamówienia i stanowisko pakowania).
// Bramki jak przy poprawce adresu: uprawnienie `klienci.dane`, tryb pracy konta, przesyłka jeszcze nieutworzona.
// Środowisko testów bez DOM: akcje na atrapach rdzenia (lib/klienci/adres-ai.ts ma własne testy na bazie) i strażnik
// źródła komponentu (zdarzenie po zapisie, przycisk nieaktywny z powodem zamiast znikania).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const stan = vi.hoisted(() => ({
  uprawnienia: [] as string[],
  odswiezone: [] as string[],
  tryb: { ok: true } as { ok: true } | { ok: false; blad: string },
  moznaPoprawic: true,
  propozycje: 0,
  zatwierdzenia: 0,
  propozycja: { stan: 'PROPOZYCJA', linia: 'Testowa 7-9 m 3', propozycja: { ulica: 'Testowa', numerDomu: '7-9', numerLokalu: '3', pewnosc: 'wysoka' }, zZapisu: false } as unknown,
  zatwierdzenie: { wynik: 'ZAPISANO', pola: ['ulica', 'numer_domu', 'numer_lokalu'], propozycja: { ulica: 'Testowa', numerDomu: '7-9', numerLokalu: '3', pewnosc: 'wysoka' } } as unknown,
}))

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => stan.odswiezone.push(p) }))
vi.mock('@/lib/panel/kontekst', () => ({
  requirePermission: async (u: string) => {
    stan.uprawnienia.push(u)
    return { db: {}, user: { id: 'u-1', name: 'Biuro' }, organization: { organizationId: 'org-1' }, permissions: new Set(['klienci.dane', 'pakowanie.stanowisko']) }
  },
}))
vi.mock('@/lib/karta/bramka', () => ({ bramkaKarty: async () => stan.tryb }))
vi.mock('@/lib/wysylka/nadanie', async (orig) => ({ ...(await orig<typeof import('@/lib/wysylka/nadanie')>()), moznaPoprawicAdres: async () => stan.moznaPoprawic }))
vi.mock('@/lib/klienci/adres-ai', async (orig) => ({
  ...(await orig<typeof import('@/lib/klienci/adres-ai')>()),
  propozycjaPodzialu: async () => {
    stan.propozycje++
    return stan.propozycja
  },
  zatwierdzPodzial: async () => {
    stan.zatwierdzenia++
    return stan.zatwierdzenie
  },
}))

const { podpowiedzPodzialAkcja, zatwierdzPodzialAkcja } = await import('./akcje-przesylka')

describe('akcje podziału adresu przez asystenta AI', () => {
  beforeEach(() => {
    stan.uprawnienia = []
    stan.odswiezone = []
    stan.tryb = { ok: true }
    stan.moznaPoprawic = true
    stan.propozycje = 0
    stan.zatwierdzenia = 0
  })

  it('propozycja: uprawnienie do pełnych danych klientów, wynik z linią adresu dla ekranu', async () => {
    const w = await podpowiedzPodzialAkcja('o1')
    expect(stan.uprawnienia).toEqual(['klienci.dane'])
    expect(w).toEqual({ stan: 'PROPOZYCJA', linia: 'Testowa 7-9 m 3', propozycja: { ulica: 'Testowa', numerDomu: '7-9', numerLokalu: '3', pewnosc: 'wysoka' } })
  })

  it('tryb „Tylko podgląd” i utworzona przesyłka: powód, rdzeń nie jest wołany (model nie kosztuje)', async () => {
    stan.tryb = { ok: false, blad: 'Konto w trybie „Tylko podgląd”.' }
    expect(await podpowiedzPodzialAkcja('o1')).toEqual({ stan: 'BLAD', komunikat: 'Konto w trybie „Tylko podgląd”.' })
    expect(await zatwierdzPodzialAkcja('o1')).toEqual({ stan: 'BLAD', komunikat: 'Konto w trybie „Tylko podgląd”.' })
    stan.tryb = { ok: true }
    stan.moznaPoprawic = false
    expect(await podpowiedzPodzialAkcja('o1')).toMatchObject({ stan: 'BLAD', komunikat: expect.stringMatching(/Przesyłka już jest utworzona/) })
    expect(await zatwierdzPodzialAkcja('o1')).toMatchObject({ stan: 'BLAD' })
    expect(stan.propozycje + stan.zatwierdzenia).toBe(0)
    expect(await podpowiedzPodzialAkcja('../x')).toMatchObject({ stan: 'BLAD' })
  })

  it('odrzucona, niedostępna, nie dotyczy: komunikat dla człowieka', async () => {
    stan.propozycja = { stan: 'ODRZUCONA', powod: 'część linii została pominięta' }
    expect(await podpowiedzPodzialAkcja('o1')).toEqual({ stan: 'ODRZUCONA', komunikat: expect.stringMatching(/część linii została pominięta.*popraw adres ręcznie/i) })
    stan.propozycja = { stan: 'NIEDOSTEPNE', powod: 'Brak asystenta.' }
    expect(await podpowiedzPodzialAkcja('o1')).toEqual({ stan: 'NIEDOSTEPNE', komunikat: 'Brak asystenta.' })
    stan.propozycja = { stan: 'NIE_DOTYCZY' }
    expect(await podpowiedzPodzialAkcja('o1')).toEqual({ stan: 'NIE_DOTYCZY', komunikat: expect.stringMatching(/nie wymaga podziału/) })
  })

  it('„Zatwierdź”: zapisane wartości dla formularza poprawki i odświeżenie karty; odmowa = komunikat', async () => {
    const w = await zatwierdzPodzialAkcja('o1')
    expect(w).toMatchObject({ stan: 'ZAPISANO', komunikat: expect.stringMatching(/Zapisano/) })
    expect(stan.odswiezone).toEqual(['/zamowienia/o1'])
    stan.zatwierdzenie = { wynik: 'ODMOWA', powod: 'Adres zmienił się po propozycji asystenta.' }
    expect(await zatwierdzPodzialAkcja('o1')).toEqual({ stan: 'BLAD', komunikat: 'Adres zmienił się po propozycji asystenta.' })
  })
})

describe('komponent podziału adresu (źródło)', () => {
  const src = readFileSync(join(__dirname, '..', '..', '_komponenty', 'podzial-adresu-ai.tsx'), 'utf8')
  it('po zapisie ogłasza poprawkę adresu (blok nadania i formularz poprawki bez F5)', () => {
    expect(src).toMatch(/ogloszPoprawkeAdresu\(orderId\)/)
  })
  it('bez asystenta przycisk zostaje, nieaktywny z powodem; „Zatwierdź” tylko przy wysokiej pewności', () => {
    expect(src).toMatch(/powodWylaczenia=\{powod/)
    expect(src).toMatch(/pewnosc === 'wysoka'/)
  })
  it('formularz poprawki słucha zdarzenia poprawki adresu z innego miejsca karty', () => {
    const popraw = readFileSync(join(__dirname, 'popraw-adres.tsx'), 'utf8')
    expect(popraw).toMatch(/naPoprawkeAdresu\(/)
  })
})
