// „Popraw adres albo punkt odbioru” — po zapisie formularz wracał do starych danych (zapis się udawał,
// widać było po F5), a po błędzie gubił wpisane wartości. Przyczyna: `<form action={fn}>` w React 19 sam resetuje
// formularz po akcji, a pola są niekontrolowane z `defaultValue` z odczytu przy otwarciu. Środowisko testów bez DOM:
// tu akcja (zwraca zapisane wartości i pole błędu) i strażnik źródła formularza; zachowanie w przeglądarce sprawdzała
// próba w jsdom (poza repo, 3/3 czerwone przed poprawką, 3/3 zielone po).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BladPoprawki, poprawkaZFormularza, type PoprawkaDostawy } from '@/lib/klienci/poprawka'

const stan = vi.hoisted(() => ({
  odswiezone: [] as string[],
  zapisano: null as PoprawkaDostawy | null,
  wynik: { wynik: 'ZAPISANO', pola: ['ulica'] } as { wynik: 'ZAPISANO'; pola: string[] } | { wynik: 'BEZ_ZMIAN' } | { wynik: 'ODMOWA'; powod: string },
}))

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => stan.odswiezone.push(p) }))
vi.mock('@/lib/panel/kontekst', () => ({
  requirePermission: async () => ({ db: {}, user: { id: 'u-1', name: 'Magazyn' }, organization: { organizationId: 'org-1' }, permissions: new Set(['klienci.dane', 'pakowanie.stanowisko']) }),
}))
vi.mock('@/lib/karta/bramka', () => ({ bramkaKarty: async () => ({ ok: true }) }))
vi.mock('@/lib/wysylka/nadanie', async (orig) => ({ ...(await orig<typeof import('@/lib/wysylka/nadanie')>()), moznaPoprawicAdres: async () => true }))
vi.mock('@/lib/klienci/poprawka', async (orig) => ({
  ...(await orig<typeof import('@/lib/klienci/poprawka')>()),
  poprawDostawe: async (_db: unknown, _id: string, p: PoprawkaDostawy) => {
    stan.zapisano = p
    return stan.wynik
  },
}))

const { poprawAdresAkcja } = await import('./akcje-przesylka')

function form(pola: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(pola)) f.set(k, v)
  return f
}
const ADRES = { imie: 'Jan Nowy', ulica: ' Nowa 5 ', dom: '5', kod: '60-001', miasto: 'Poznań', telefon: '600100200', punkt: '' }

describe('akcja poprawki adresu oddaje formularzowi zapisane wartości', () => {
  beforeEach(() => {
    stan.odswiezone = []
    stan.zapisano = null
    stan.wynik = { wynik: 'ZAPISANO', pola: ['ulica'] }
  })

  it('udany zapis: „Zapisano”, wartości po zapisie (przycięte) i odświeżenie karty', async () => {
    const w = await poprawAdresAkcja('o1', form(ADRES))
    expect(w.blad).toBeNull()
    expect(w.info).toMatch(/^Zapisano\./)
    expect(w.zapisane).toEqual(stan.zapisano)
    expect(w.zapisane).toMatchObject({ imieNazwisko: 'Jan Nowy', ulica: 'Nowa 5', kodPocztowy: '60-001', miasto: 'Poznań', punkt: null })
    expect(stan.odswiezone).toEqual(['/zamowienia/o1'])
  })

  it('sam punkt odbioru: wartości po zapisie bez adresu (jak `rekordPoPoprawce`)', async () => {
    const w = await poprawAdresAkcja('o1', form({ imie: 'Jan Nowy', lokal: '3', punkt: 'POZ08M' }))
    expect(w.zapisane).toMatchObject({ punkt: 'POZ08M', numerLokalu: null, ulica: null, miasto: null })
  })

  it('bez zmian: też potwierdzenie i wartości do formularza', async () => {
    stan.wynik = { wynik: 'BEZ_ZMIAN' }
    const w = await poprawAdresAkcja('o1', form(ADRES))
    expect(w.blad).toBeNull()
    expect(w.info).toMatch(/^Zapisano/)
    expect(w.zapisane?.ulica).toBe('Nowa 5')
  })

  it('błąd walidacji: komunikat z nazwą pola formularza, nic nie zapisane, bez wartości do formularza', async () => {
    const w = await poprawAdresAkcja('o1', form({ ...ADRES, kod: '6000' }))
    expect(w).toMatchObject({ blad: 'Kod pocztowy w formacie NN-NNN', pole: 'kod' })
    expect(w.zapisane).toBeUndefined()
    expect(stan.zapisano).toBeNull()
  })

  it('odmowa zapisu (np. przesyłka powstała w międzyczasie): błąd całego formularza, bez wartości do formularza', async () => {
    stan.wynik = { wynik: 'ODMOWA', powod: 'Przesyłka już jest utworzona.' }
    const w = await poprawAdresAkcja('o1', form(ADRES))
    expect(w.blad).toBe('Przesyłka już jest utworzona.')
    expect(w.pole ?? null).toBeNull()
    expect(w.zapisane).toBeUndefined()
  })
})

describe('błąd poprawki wskazuje pole formularza', () => {
  const blad = (pola: Record<string, string>) => {
    try {
      poprawkaZFormularza(form(pola))
    } catch (e) {
      if (e instanceof BladPoprawki) return { komunikat: e.message, pole: e.pole }
      throw e
    }
    return null
  }
  it.each([
    [{ ulica: 'Nowa', kod: '60-001', miasto: 'Poznań' }, 'imie'],
    [{ imie: 'Jan', kod: '60-001', miasto: 'Poznań' }, 'ulica'],
    [{ imie: 'Jan', ulica: 'Nowa', miasto: 'Poznań' }, 'kod'],
    [{ imie: 'Jan', ulica: 'Nowa', kod: '60-001' }, 'miasto'],
    [{ imie: 'Jan', ulica: 'Nowa', kod: '6000', miasto: 'Poznań' }, 'kod'],
    [{ imie: 'Jan', punkt: 'POZ08M', telefon: '12' }, 'telefon'],
    [{ imie: 'Jan', punkt: 'POZ 08M' }, 'punkt'],
    [{ imie: 'Jan', punkt: 'POZ08M', dom: 'x'.repeat(21) }, 'dom'],
  ])('%j → pole %s', (pola, pole) => {
    expect(blad(pola)?.pole).toBe(pole)
  })
  it('brak adresu i punktu: błąd całego formularza (bez pola)', () => {
    expect(blad({ imie: 'Jan' })).toEqual({ komunikat: 'Podaj adres dostawy albo punkt odbioru', pole: null })
  })
})

describe('strażnik źródła formularza', () => {
  it('formularz poprawki nie używa `<form action={…}>` (React 19 czyści wtedy pola po zapisie)', () => {
    const zrodlo = readFileSync(join(__dirname, 'popraw-adres.tsx'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect(zrodlo).not.toMatch(/<form[^>]*\saction=\{/)
    expect(zrodlo).toMatch(/<form[^>]*\sonSubmit=\{zapisz\}/)
  })
})
