// Dopasowanie kategorii Allegro. Port `scripts/category_matcher.py` ze skilla allegro-oferty:
// kolejność 1) kategoria wskazana ręcznie, 2) mapa firmy (słowo kluczowe w nazwie produktu albo w kategorii sklepu,
// najdłuższe słowa najpierw), 3) propozycja Allegro (`/sale/matching-categories`, pierwszy liść).
// Każdy wybór sprawdzany: kategoria musi istnieć i być liściem. Zamiast pytania w terminalu (tryb interaktywny skilla)
// wynik niesie listę propozycji do wyboru na ekranie. Mapa kategorii to dane firmy (mapę niesie preset firmy).
import type { AllegroKategoria } from '@/lib/zrodla/allegro'
import { bezOgonkow } from './tekst'
import type { ProblemOferty } from './typy'

/** Mapa firmy: słowo kluczowe (jak `by_keyword` w pliku mapy kategorii) → id kategorii Allegro. */
export interface MapaKategoriiFirmy {
  poSlowie: Record<string, string>
}

export const PUSTA_MAPA_KATEGORII: MapaKategoriiFirmy = { poSlowie: {} }

export interface ZrodloKategorii {
  kategoria(id: string): Promise<AllegroKategoria | null>
  dopasujKategorie(nazwa: string): Promise<(AllegroKategoria & { rodzicNazwa: string | null })[]>
}

export type PowodKategorii = 'reczna' | 'mapa' | 'allegro' | 'katalog'

export interface WyborKategorii {
  kategoriaId: string | null
  powod: PowodKategorii | null
  /** Zdanie dla człowieka: skąd wzięła się kategoria. */
  opis: string
  /** Do 5 liści zaproponowanych przez Allegro (wybór na ekranie). */
  propozycje: { id: string; nazwa: string; rodzicNazwa: string | null }[]
  problemy: ProblemOferty[]
}

/** Słowo kluczowe z mapy w nazwie produktu albo w kategorii sklepu (1:1 z `match_from_keywords`). */
export function kategoriaZMapy(mapa: MapaKategoriiFirmy, nazwa: string, kategorieSklepu: string[] = []): { kategoriaId: string; slowo: string } | null {
  const stogi = [bezOgonkow(nazwa ?? ''), ...kategorieSklepu.map((k) => bezOgonkow(k ?? ''))]
  // sort stabilny jak `sorted(..., key=len, reverse=True)` w Pythonie: przy równej długości kolejność z mapy
  const slowa = Object.keys(mapa.poSlowie).sort((a, b) => b.length - a.length)
  for (const slowo of slowa) {
    const zeSpacjami = bezOgonkow(slowo.replace(/-/g, ' '))
    const zMyslnikami = bezOgonkow(slowo)
    for (const s of stogi) {
      if (s.includes(zeSpacjami) || s.replace(/ /g, '-').includes(zMyslnikami)) return { kategoriaId: mapa.poSlowie[slowo]!, slowo }
    }
  }
  return null
}

const problem = (kod: string, waga: ProblemOferty['waga'], komunikat: string): ProblemOferty => ({ kod, waga, komunikat, pole: 'kategoria' })

/**
 * Wybór kategorii Allegro dla produktu spoza katalogu. Błąd odczytu z Allegro nie przerywa: trafia na listę problemów,
 * a podgląd pokazuje resztę oferty.
 */
export async function wybierzKategorieAllegro(
  wej: { nazwa: string; kategorieSklepu: string[]; recznaKategoriaId?: string | null; mapa: MapaKategoriiFirmy },
  zrodlo: ZrodloKategorii,
): Promise<WyborKategorii> {
  const problemy: ProblemOferty[] = []
  const lisc = async (id: string): Promise<'lisc' | 'nie_lisc' | 'brak' | 'blad'> => {
    try {
      const k = await zrodlo.kategoria(id)
      return !k ? 'brak' : k.lisc ? 'lisc' : 'nie_lisc'
    } catch {
      problemy.push(problem('allegro_niedostepne', 'ostrzezenie', `Nie udało się sprawdzić kategorii ${id} w Allegro — spróbuj ponownie za chwilę.`))
      return 'blad'
    }
  }

  if (wej.recznaKategoriaId) {
    const s = await lisc(wej.recznaKategoriaId)
    if (s === 'lisc') return { kategoriaId: wej.recznaKategoriaId, powod: 'reczna', opis: 'kategoria wybrana ręcznie', propozycje: [], problemy }
    if (s === 'nie_lisc') problemy.push(problem('kategoria_nie_lisc', 'blad', `Kategoria ${wej.recznaKategoriaId} ma podkategorie — wybierz dokładniejszą.`))
    if (s === 'brak') problemy.push(problem('kategoria_nie_istnieje', 'blad', `Kategorii ${wej.recznaKategoriaId} nie ma w Allegro.`))
    if (s === 'blad') return { kategoriaId: wej.recznaKategoriaId, powod: 'reczna', opis: 'kategoria wybrana ręcznie (niesprawdzona)', propozycje: [], problemy }
  }

  const zMapy = kategoriaZMapy(wej.mapa, wej.nazwa, wej.kategorieSklepu)
  if (zMapy) {
    const s = await lisc(zMapy.kategoriaId)
    if (s === 'lisc') return { kategoriaId: zMapy.kategoriaId, powod: 'mapa', opis: `z mapy kategorii firmy (słowo „${zMapy.slowo}”)`, propozycje: [], problemy }
    if (s === 'nie_lisc' || s === 'brak')
      problemy.push(problem('mapa_kategorii_nieaktualna', 'ostrzezenie', `Mapa kategorii wskazuje ${zMapy.kategoriaId} dla słowa „${zMapy.slowo}”, ale to nie jest kategoria końcowa w Allegro — popraw mapę.`))
  }

  let propozycje: WyborKategorii['propozycje'] = []
  try {
    propozycje = (await zrodlo.dopasujKategorie(wej.nazwa))
      .filter((k) => k.lisc)
      .slice(0, 5)
      .map((k) => ({ id: k.id, nazwa: k.nazwa, rodzicNazwa: k.rodzicNazwa }))
  } catch {
    problemy.push(problem('allegro_niedostepne', 'ostrzezenie', 'Allegro nie podpowiedziało kategorii — spróbuj ponownie za chwilę albo wybierz kategorię ręcznie.'))
  }
  const pierwsza = propozycje[0]
  if (pierwsza) return { kategoriaId: pierwsza.id, powod: 'allegro', opis: `propozycja Allegro („${pierwsza.nazwa}”) — sprawdź przed wystawieniem`, propozycje, problemy }

  problemy.push(problem('bez_kategorii', 'blad', 'Nie udało się dobrać kategorii Allegro — wybierz ją ręcznie albo dopisz słowo do mapy kategorii firmy.'))
  return { kategoriaId: null, powod: null, opis: 'brak kategorii', propozycje, problemy }
}
