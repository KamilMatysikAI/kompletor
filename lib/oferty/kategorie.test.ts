// dopasowanie kategorii Allegro (port category_matcher.py).
import { describe, expect, it } from 'vitest'
import { allegroDopasujKategorie, allegroKategoria } from '@/lib/zrodla/allegro'
import { atrapaAllegro, KAT_PRZYPRAWA, KAT_KUBKI, KAT_NADRZEDNA } from './allegro-atrapa'
import { kategoriaZMapy, wybierzKategorieAllegro, type MapaKategoriiFirmy, type ZrodloKategorii } from './kategorie'

const mapa: MapaKategoriiFirmy = { poSlowie: { przyprawa: KAT_PRZYPRAWA, 'przyprawa-zielona': KAT_PRZYPRAWA, kubek: KAT_KUBKI, zestaw: '900999' } }

const zrodlo = (nadpisz = {}): ZrodloKategorii & { wywolania: string[] } => {
  const a = atrapaAllegro(nadpisz)
  return { kategoria: (id) => allegroKategoria(a.get, id), dopasujKategorie: (n) => allegroDopasujKategorie(a.get, n), wywolania: a.wywolania }
}

describe('mapa kategorii firmy', () => {
  it('najdłuższe słowo wygrywa, bez ogonków i z myślnikami jak w skillu', () => {
    expect(kategoriaZMapy(mapa, 'Przyprawa zielona Kurkuma 100 g')).toEqual({ kategoriaId: KAT_PRZYPRAWA, slowo: 'przyprawa-zielona' })
    expect(kategoriaZMapy(mapa, 'Kubek ceramiczny Żuraw 300 ml')).toEqual({ kategoriaId: KAT_KUBKI, slowo: 'kubek' })
  })
  it('patrzy też w kategorie sklepu', () => {
    expect(kategoriaZMapy(mapa, 'Prezent dla mamy', ['zestawy-prezentowe'])).toEqual({ kategoriaId: '900999', slowo: 'zestaw' })
  })
  it('brak słowa = null; pusta mapa = null', () => {
    expect(kategoriaZMapy(mapa, 'Czajnik żeliwny')).toBeNull()
    expect(kategoriaZMapy({ poSlowie: {} }, 'Przyprawa')).toBeNull()
  })
})

describe('wybór kategorii Allegro', () => {
  const wej = (nazwa: string, extra = {}) => ({ nazwa, kategorieSklepu: [], mapa, ...extra })

  it('kategoria ręczna będąca liściem wygrywa', async () => {
    const w = await wybierzKategorieAllegro(wej('Czajnik', { recznaKategoriaId: KAT_KUBKI }), zrodlo())
    expect(w).toMatchObject({ kategoriaId: KAT_KUBKI, powod: 'reczna', problemy: [] })
  })
  it('kategoria ręczna z podkategoriami = błąd i dalej mapa', async () => {
    const w = await wybierzKategorieAllegro(wej('Przyprawa zielona', { recznaKategoriaId: KAT_NADRZEDNA }), zrodlo())
    expect(w.kategoriaId).toBe(KAT_PRZYPRAWA)
    expect(w.powod).toBe('mapa')
    expect(w.problemy).toContainEqual(expect.objectContaining({ kod: 'kategoria_nie_lisc', waga: 'blad' }))
  })
  it('mapa wskazuje nieistniejącą kategorię → ostrzeżenie i propozycja Allegro (pierwszy liść)', async () => {
    const w = await wybierzKategorieAllegro(wej('Zestaw przypraw na prezent'), zrodlo())
    expect(w.problemy).toContainEqual(expect.objectContaining({ kod: 'mapa_kategorii_nieaktualna' }))
    expect(w).toMatchObject({ kategoriaId: KAT_PRZYPRAWA, powod: 'allegro', propozycje: [{ id: KAT_PRZYPRAWA, nazwa: 'Liściaste', rodzicNazwa: 'Przyprawa' }] })
  })
  it('nic nie pasuje i Allegro nic nie proponuje → błąd bez_kategorii', async () => {
    const w = await wybierzKategorieAllegro(wej('Czajnik'), zrodlo({ '/sale/matching-categories': { status: 200, body: { matchingCategories: [] } } }))
    expect(w.kategoriaId).toBeNull()
    expect(w.problemy).toContainEqual(expect.objectContaining({ kod: 'bez_kategorii', waga: 'blad' }))
  })
  it('awaria Allegro nie wywraca wyboru — trafia na listę problemów', async () => {
    const w = await wybierzKategorieAllegro(wej('Czajnik'), zrodlo({ '/sale/matching-categories': { status: 500, body: null } }))
    expect(w.problemy.map((p) => p.kod)).toEqual(['allegro_niedostepne', 'bez_kategorii'])
  })
})
