// (pkt 3): „Przygotuj oferty” masowo — logika raportu, odporność na zły produkt, idempotencja przebiegu.
// Baza jako atrapa (tylko ImportRun), kafle z atrapy; bez kanałów i bez sieci.
import type { PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { komunikatPominietych, OFERTY_MASOWO_MAX, OFERTY_RUN_KIND, policzRaport, przebiegPrzygotowania, przebiegZeStats, PrzygotowanieError, sprawdzZaznaczone } from './masowo'
import { POWOD_NIESPRAWDZONEJ_KATEGORII } from './allegro-podglad'
import type { KafelPublikacji } from './publikacja'

const kafel = (problemy: { waga: 'blad' | 'ostrzezenie'; komunikat: string }[], powody: string[] = []): KafelPublikacji =>
  ({ problemy, wystaw: { mozna: !powody.length, powody } }) as unknown as KafelPublikacji
const KONTA = [
  { klucz: 'ALLEGRO:a1', kanal: 'allegro' as const },
  { klucz: 'brak:empik', kanal: 'empik' as const },
]

describe('zaznaczone produkty', () => {
  it('bez dubli i pustych; pusta lista, za dużo i zły identyfikator = odmowa po polsku', () => {
    expect(sprawdzZaznaczone(['p1', 'p1', ' p2 ', ''])).toEqual(['p1', 'p2'])
    expect(() => sprawdzZaznaczone([])).toThrow(PrzygotowanieError)
    expect(() => sprawdzZaznaczone(Array.from({ length: OFERTY_MASOWO_MAX + 1 }, (_, i) => `p${i}`))).toThrow(/najwyżej 500/)
    expect(() => sprawdzZaznaczone(['p1', '../x'])).toThrow('Zły identyfikator produktu na liście.')
  })
})

describe('raport przygotowania', () => {
  it('per kanał: gotowe, z problemami (zliczone po komunikacie), ostrzeżenia nie psują gotowości', async () => {
    const r = await policzRaport(['p1', 'p2', 'p3'], KONTA, async (p, k) => {
      if (k === 'brak:empik') return kafel([{ waga: 'blad', komunikat: 'Brak EAN.' }])
      if (p === 'p2') return kafel([{ waga: 'blad', komunikat: 'Tytuł ma „!”.' }, { waga: 'blad', komunikat: 'Brak EAN.' }])
      return kafel([{ waga: 'ostrzezenie', komunikat: 'Krótki opis.' }])
    })
    expect(r.produkty).toBe(3)
    const allegro = r.kanaly.find((k) => k.kanal === 'allegro')!
    expect(allegro).toMatchObject({ nazwa: 'Allegro', gotowe: 2, zProblemami: 1, bledy: 0, problemy: { 'Tytuł ma „!”.': 1, 'Brak EAN.': 1 } })
    expect(r.kanaly.find((k) => k.kanal === 'empik')).toMatchObject({ gotowe: 0, zProblemami: 3, problemy: { 'Brak EAN.': 3 } })
    expect(r.lista).toHaveLength(4)
  })

  it('podgląd bez sprawdzonej kategorii albo parametrów w Allegro nie liczy się jako gotowy', async () => {
    const r = await policzRaport(['p1', 'p2'], [KONTA[0]!], async (p) =>
      p === 'p1' ? kafel([{ waga: 'ostrzezenie', komunikat: 'Allegro nie odpowiada' }], [POWOD_NIESPRAWDZONEJ_KATEGORII]) : kafel([]),
    )
    expect(r.kanaly[0]).toMatchObject({ gotowe: 1, zProblemami: 0, bledy: 1 })
    expect(r.lista).toEqual([expect.objectContaining({ productId: 'p1', blad: POWOD_NIESPRAWDZONEJ_KATEGORII })])
  })

  it('jeden zły produkt (wyjątek, brak produktu) nie zatrzymuje reszty; treść wyjątku nie trafia do raportu', async () => {
    const r = await policzRaport(['p1', 'zly', 'p3', 'nie-ma'], [KONTA[0]!], async (p) => {
      if (p === 'zly') throw new Error('HTTP 500 klucz=sekret123')
      if (p === 'nie-ma') return null
      return kafel([])
    })
    expect(r.kanaly[0]).toMatchObject({ gotowe: 2, bledy: 2 })
    const zly = r.lista.find((x) => x.productId === 'zly')!
    expect(zly.blad).toContain('Nie udało się policzyć podglądu (Error)')
    expect(zly.blad).not.toContain('sekret123')
    expect(r.lista.find((x) => x.productId === 'nie-ma')!.blad).toBe('Nie ma już takiego produktu albo konta.')
  })
})

function atrapaBazy(run: { id: string; status: string; stats: unknown } | null) {
  const zapisy: { id: string; data: Record<string, unknown> }[] = []
  const db = {
    importRun: {
      findFirst: async ({ where }: { where: { id: string; kind: string } }) => (run && where.id === run.id && where.kind === OFERTY_RUN_KIND ? run : null),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        zapisy.push({ id: where.id, data })
        if (run && typeof data['status'] === 'string') run.status = data['status']
        return run
      },
    },
  }
  return { db: db as unknown as PrismaClient, zapisy }
}

describe('przebieg w tle', () => {
  it('liczy raport, zapisuje OK / PARTIAL, a powtórka po zakończeniu nic nie robi (idempotencja)', async () => {
    const run = { id: 'run1', status: 'RUNNING', stats: { produkty: ['p1', 'p2'], zlecil: 'u1' } }
    const { db, zapisy } = atrapaBazy(run)
    let wolania = 0
    const deps = { konta: async () => KONTA, podglad: async () => (wolania++, kafel([])) }
    const r = await przebiegPrzygotowania(db, { przebieg: 'run1' }, deps)
    expect(r?.kanaly.map((k) => k.gotowe)).toEqual([2, 2])
    expect(zapisy).toHaveLength(1)
    expect(zapisy[0]!.data).toMatchObject({ status: 'OK', error: null, stats: { produkty: 2, produktyId: ['p1', 'p2'], zlecil: 'u1' } })
    expect(wolania).toBe(4)
    expect(await przebiegPrzygotowania(db, { przebieg: 'run1' }, deps)).toBeNull()
    expect(wolania).toBe(4)
    expect(zapisy).toHaveLength(1)
  })

  it('część błędów = PARTIAL; wszystkie = FAILED z komunikatem; awaria listy kont = FAILED bez wyjątku', async () => {
    const a = atrapaBazy({ id: 'r2', status: 'RUNNING', stats: { produkty: ['p1', 'p2'] } })
    await przebiegPrzygotowania(a.db, { przebieg: 'r2' }, { konta: async () => [KONTA[0]!], podglad: async (p) => (p === 'p1' ? kafel([]) : Promise.reject(new Error('x'))) })
    expect(a.zapisy[0]!.data['status']).toBe('PARTIAL')

    const b = atrapaBazy({ id: 'r3', status: 'RUNNING', stats: { produkty: ['p1'] } })
    await przebiegPrzygotowania(b.db, { przebieg: 'r3' }, { konta: async () => [KONTA[0]!], podglad: async () => Promise.reject(new Error('x')) })
    expect(b.zapisy[0]!.data).toMatchObject({ status: 'FAILED', error: 'Żadnego podglądu nie udało się policzyć.' })

    const c = atrapaBazy({ id: 'r4', status: 'RUNNING', stats: { produkty: ['p1'] } })
    await expect(przebiegPrzygotowania(c.db, { przebieg: 'r4' }, { konta: async () => Promise.reject(new Error('baza')), podglad: async () => kafel([]) })).resolves.toBeNull()
    expect(c.zapisy[0]!.data['status']).toBe('FAILED')
  })

  it('lista w bazie ponad limit = przebieg liczy najwyżej OFERTY_MASOWO_MAX, nadmiar opisany w raporcie', async () => {
    const ids = Array.from({ length: OFERTY_MASOWO_MAX + 7 }, (_, i) => `p${i}`)
    const { db, zapisy } = atrapaBazy({ id: 'r6', status: 'RUNNING', stats: { produkty: [...ids, 'p0'] } })
    const policzone = new Set<string>()
    const r = await przebiegPrzygotowania(db, { przebieg: 'r6' }, { konta: async () => [KONTA[0]!], podglad: async (p) => (policzone.add(p), kafel([])) })
    expect(policzone.size).toBe(OFERTY_MASOWO_MAX)
    expect(policzone.has(`p${OFERTY_MASOWO_MAX}`)).toBe(false)
    expect(r).toMatchObject({ produkty: OFERTY_MASOWO_MAX, pominieto: 7 })
    expect(zapisy[0]!.data).toMatchObject({ status: 'OK', error: komunikatPominietych(7), stats: { produkty: OFERTY_MASOWO_MAX, pominieto: 7 } })
    expect((zapisy[0]!.data['stats'] as { produktyId: string[] }).produktyId).toHaveLength(OFERTY_MASOWO_MAX)
    expect(przebiegZeStats(zapisy[0]!.data['stats'] as never).raport?.pominieto).toBe(7)
  })

  it('zły ładunek albo cudzy rodzaj przebiegu = nic', async () => {
    const { db, zapisy } = atrapaBazy({ id: 'r5', status: 'RUNNING', stats: {} })
    const deps = { konta: async () => KONTA, podglad: async () => kafel([]) }
    expect(await przebiegPrzygotowania(db, null, deps)).toBeNull()
    expect(await przebiegPrzygotowania(db, { przebieg: '../r5' }, deps)).toBeNull()
    expect(await przebiegPrzygotowania(db, { przebieg: 'inny' }, deps)).toBeNull()
    expect(zapisy).toEqual([])
  })
})

describe('raport do ekranu (stats przebiegu)', () => {
  it('w toku: liczba zaznaczonych z listy, bez raportu', () => {
    expect(przebiegZeStats({ produkty: ['p1', 'p2'], zlecil: 'u1' })).toEqual({ produkty: 2, raport: null })
    expect(przebiegZeStats(null)).toEqual({ produkty: 0, raport: null })
  })

  it('po przebiegu: kanały i lista; śmieci w zapisie odrzucone zamiast wywracać ekran', () => {
    const s = przebiegZeStats({
      produkty: 2,
      produktyId: ['p1', 'p2'],
      kanaly: [{ kanal: 'allegro', nazwa: 'x', gotowe: 1, zProblemami: 1, bledy: 0, problemy: { 'Brak EAN.': 1, zle: 'a' } }, { kanal: 'obcy', gotowe: 9 }, 'tekst'],
      lista: [
        { productId: 'p2', klucz: 'ALLEGRO:a1', kanal: 'allegro', problemy: ['Brak EAN.', 3] },
        { productId: '../x', klucz: 'k', kanal: 'allegro', problemy: [] },
        { productId: 'p1', klucz: 'brak:empik', kanal: 'empik', problemy: [], blad: 'Nie udało się.' },
      ],
    })
    expect(s.produkty).toBe(2)
    expect(s.raport!.kanaly).toEqual([{ kanal: 'allegro', nazwa: 'Allegro', gotowe: 1, zProblemami: 1, bledy: 0, problemy: { 'Brak EAN.': 1 } }])
    expect(s.raport!.lista).toEqual([
      { productId: 'p2', klucz: 'ALLEGRO:a1', kanal: 'allegro', problemy: ['Brak EAN.'] },
      { productId: 'p1', klucz: 'brak:empik', kanal: 'empik', problemy: [], blad: 'Nie udało się.' },
    ])
  })
})
