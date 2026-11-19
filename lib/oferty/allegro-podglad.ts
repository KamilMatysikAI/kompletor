// Podgląd oferty Allegro z produktu Kompletora. Port przepływu `scripts/create_offer_v2.py` ze skilla
// allegro-oferty, bez wysyłki: 1) EAN → wyszukanie w katalogu Allegro, 2a) produkt w katalogu → oferta do produktu
// katalogowego (id produktu + cena, stan, opis, miniatura), 2b) poza katalogiem → pełne dane produktu (kategoria,
// parametry z listą braków, zdjęcia), 3) opis w sekcjach, 4) lista problemów. Każdy krok odczytu z Allegro jest
// osobno zabezpieczony: błąd trafia na listę problemów, reszta podglądu powstaje. Zero zapisów (zapis oferty =
// osobna funkcja za wyłącznikiem konta w kolejnym etapie).
import {
  allegroDopasujKategorie,
  allegroKategoria,
  allegroParametryKategorii,
  allegroProduktyPoEan,
  allegroSciezkaKategorii,
  type AllegroGet,
  type AllegroParametrKategorii,
  type AllegroProduktKatalogu,
} from '@/lib/zrodla/allegro'
import { PUSTA_MAPA_KATEGORII, wybierzKategorieAllegro, type MapaKategoriiFirmy, type WyborKategorii, type ZrodloKategorii } from './kategorie'
import { DOMYSLNY_SZABLON_OPISU, sprawdzTresc, zbudujOpisAllegro, type OpisAllegro, type SzablonOpisu, type TrescOferty } from './opis'
import { DOMYSLNE_ZASADY_PARAMETROW, zbudujParametry, type WartoscParametruAllegro, type WierszParametru, type ZasadyParametrowFirmy } from './parametry'
import { DOMYSLNE_ZASADY_REGULAMINU, poprawTytulAllegro, sprawdzTytulAllegro, type ZasadyRegulaminu } from './regulamin-allegro'
import { maBledy, type ProblemOferty, type ProduktDoOferty } from './typy'

/** Ustawienia ofert firmy (dane, nie kod). Mapę i szablon niesie preset firmy; firma bez presetu startuje od domyślnych. */
export interface UstawieniaOfertFirmy {
  mapaKategorii: MapaKategoriiFirmy
  parametry: ZasadyParametrowFirmy
  szablonOpisu: SzablonOpisu
  regulamin: ZasadyRegulaminu
}

export const DOMYSLNE_USTAWIENIA_OFERT: UstawieniaOfertFirmy = {
  mapaKategorii: PUSTA_MAPA_KATEGORII,
  parametry: DOMYSLNE_ZASADY_PARAMETROW,
  szablonOpisu: DOMYSLNY_SZABLON_OPISU,
  regulamin: DOMYSLNE_ZASADY_REGULAMINU,
}

/** Odczyty Allegro potrzebne do podglądu (w testach atrapa, na produkcji `zrodloAllegroZApi`). */
export interface ZrodloAllegroOfert extends ZrodloKategorii {
  produktyPoEan(ean: string): Promise<AllegroProduktKatalogu[]>
  parametryKategorii(id: string): Promise<AllegroParametrKategorii[]>
  sciezkaKategorii(id: string): Promise<string[]>
}

/** Źródło na kliencie API tylko do odczytu (GET z tokenem konta, np. `AllegroAdapter.call`). */
export function zrodloAllegroZApi(get: AllegroGet): ZrodloAllegroOfert {
  return {
    kategoria: (id) => allegroKategoria(get, id),
    dopasujKategorie: (nazwa) => allegroDopasujKategorie(get, nazwa),
    produktyPoEan: (ean) => allegroProduktyPoEan(get, ean),
    parametryKategorii: (id) => allegroParametryKategorii(get, id),
    sciezkaKategorii: (id) => allegroSciezkaKategorii(get, id),
  }
}

export interface WejsciePodgladuAllegro {
  produkt: ProduktDoOferty
  /** Przygotowana treść oferty; brak = opis z karty produktu. */
  tresc?: TrescOferty
  recznaKategoriaId?: string | null
  /** Wartości parametrów wpisane na ekranie { idParametru: wartość }. */
  reczneParametry?: Record<string, string>
  /** Cena na Allegro inna niż w karcie (brutto PLN). */
  cenaBrutto?: number | null
  /** Pomiń katalog Allegro i przygotuj pełny produkt (skill: --force-new-product). */
  wymusNowyProdukt?: boolean
}

export type TrybOferty = 'katalog' | 'nowy_produkt'

export interface PodgladOfertyAllegro {
  kanal: 'allegro'
  tryb: TrybOferty
  tytul: string
  produktKatalogowy: { id: string; nazwa: string } | null
  kategoria: { id: string | null; sciezka: string[]; opis: string; propozycje: WyborKategorii['propozycje'] }
  parametry: WierszParametru[]
  opis: OpisAllegro
  zdjecia: string[]
  cena: { kwota: string; waluta: 'PLN' } | null
  stan: number
  problemy: ProblemOferty[]
  /**
   * Brak błędów (ostrzeżenia dozwolone) i udany odczyt kategorii oraz parametrów w Allegro. O tym, czy konto może
   * wystawiać, decyduje ekran (wyłącznik konta).
   */
  gotowa: boolean
  /** powód blokady przy samych ostrzeżeniach (nieudany odczyt kategorii/parametrów); null = brak. */
  powodNiegotowej?: string | null
  /** Szkic treści `POST /sale/product-offers` bez ustawień konta (cennik dostaw, zwroty, status publikacji). */
  szkicOferty: Record<string, unknown>
}

export const ZDJECIA_ALLEGRO_MAX = 16
const EAN_RE = /^\d{8,14}$/
const bezZer = (e: string) => e.replace(/^0+/, '')

/** Produkt katalogowy z tym samym EAN (porównanie bez zer wiodących, GTIN-13 = GTIN-14 z zerem). */
export function wybierzZKatalogu(ean: string, produkty: AllegroProduktKatalogu[]): { produkt: AllegroProduktKatalogu | null; problem: ProblemOferty | null } {
  const zgodny = produkty.find((p) => p.eany.some((e) => bezZer(e) === bezZer(ean)))
  if (zgodny) return { produkt: zgodny, problem: null }
  const pierwszy = produkty[0]
  if (!pierwszy) return { produkt: null, problem: null }
  if (pierwszy.eany.length === 0)
    return {
      produkt: pierwszy,
      problem: { kod: 'katalog_bez_potwierdzenia_ean', waga: 'ostrzezenie', komunikat: `Allegro znalazło produkt „${pierwszy.nazwa}”, ale bez kodu EAN do porównania — sprawdź, czy to ten sam towar.`, pole: 'katalog' },
    }
  return {
    produkt: null,
    problem: { kod: 'katalog_inny_ean', waga: 'ostrzezenie', komunikat: 'Allegro zwróciło produkty z innym kodem EAN — przygotowuję pełny produkt.', pole: 'katalog' },
  }
}

const nieudany = (komunikat: string, pole: string): ProblemOferty => ({ kod: 'allegro_niedostepne', waga: 'ostrzezenie', komunikat, pole })

/** nieudany odczyt kategorii albo parametrów zostaje ostrzeżeniem w podglądzie, ale blokuje wystawienie. */
export const POWOD_NIESPRAWDZONEJ_KATEGORII = 'Nie udało się sprawdzić kategorii albo parametrów w Allegro — spróbuj ponownie.'

export async function przygotujPodgladAllegro(
  wej: WejsciePodgladuAllegro,
  zrodlo: ZrodloAllegroOfert,
  ustawienia: UstawieniaOfertFirmy = DOMYSLNE_USTAWIENIA_OFERT,
): Promise<PodgladOfertyAllegro> {
  const p = wej.produkt
  const problemy: ProblemOferty[] = []
  const ean = p.ean?.trim() || null

  // 1. EAN i katalog
  let katalogowy: AllegroProduktKatalogu | null = null
  if (!ean) problemy.push({ kod: 'bez_ean', waga: 'blad', komunikat: 'Produkt nie ma kodu EAN — uzupełnij go w karcie produktu.', pole: 'ean' })
  else if (!EAN_RE.test(ean)) problemy.push({ kod: 'zly_ean', waga: 'blad', komunikat: `Kod EAN „${ean}” ma zły format (8–14 cyfr).`, pole: 'ean' })
  else if (!wej.wymusNowyProdukt) {
    try {
      const w = wybierzZKatalogu(ean, await zrodlo.produktyPoEan(ean))
      katalogowy = w.produkt
      if (w.problem) problemy.push(w.problem)
    } catch {
      problemy.push(nieudany('Nie udało się sprawdzić katalogu Allegro — podgląd pokazuje pełny produkt; spróbuj ponownie za chwilę.', 'katalog'))
    }
  }
  const tryb: TrybOferty = katalogowy ? 'katalog' : 'nowy_produkt'

  // 2. Tytuł i treść
  const tresc: TrescOferty = { ...(wej.tresc ?? {}), opis: wej.tresc?.opis?.trim() ? wej.tresc.opis : (p.opis ?? '') }
  const tytul = poprawTytulAllegro(tresc.tytul?.trim() || p.nazwa)
  problemy.push(
    ...sprawdzTytulAllegro(tytul, ustawienia.regulamin),
    // oferta do produktu z katalogu może iść bez własnego opisu (opis niesie katalog), więc tam to tylko ostrzeżenie
    ...sprawdzTresc(tresc, ustawienia.regulamin).map((x) => (katalogowy && x.kod === 'bez_opisu' ? { ...x, waga: 'ostrzezenie' as const } : x)),
  )

  // 3. Zdjęcia (pierwsze = miniatura; bez powtórzeń, Allegro odrzuca duplikaty)
  const zdjecia = [...new Set(p.zdjecia.map((u) => u?.trim()).filter((u): u is string => !!u))]
  if (!zdjecia.length) problemy.push({ kod: 'bez_zdjec', waga: 'blad', komunikat: 'Produkt nie ma zdjęć — Allegro wymaga co najmniej jednego.', pole: 'zdjecia' })
  if (zdjecia.length > ZDJECIA_ALLEGRO_MAX)
    problemy.push({ kod: 'za_duzo_zdjec', waga: 'ostrzezenie', komunikat: `Produkt ma ${zdjecia.length} zdjęć, do Allegro trafi pierwszych ${ZDJECIA_ALLEGRO_MAX}.`, pole: 'zdjecia' })
  if (zdjecia.some((u) => !/^https:\/\//i.test(u)))
    problemy.push({ kod: 'zdjecie_bez_adresu', waga: 'ostrzezenie', komunikat: 'Część zdjęć nie ma publicznego adresu — przy wystawianiu zostaną wgrane do Allegro.', pole: 'zdjecia' })
  const doOferty = zdjecia.slice(0, ZDJECIA_ALLEGRO_MAX)
  const miniatura = doOferty[0] ?? null
  const opis = zbudujOpisAllegro(tresc, tytul, { miniatura, zdjecia: doOferty.slice(1) }, ustawienia.szablonOpisu)

  // 4. Kategoria i parametry
  let kategoria: PodgladOfertyAllegro['kategoria'] = { id: null, sciezka: [], opis: 'brak kategorii', propozycje: [] }
  let niesprawdzone = false
  if (katalogowy) {
    kategoria = { id: katalogowy.kategoriaId, sciezka: [], opis: 'kategoria produktu z katalogu Allegro', propozycje: [] }
  } else {
    const w = await wybierzKategorieAllegro({ nazwa: p.nazwa, kategorieSklepu: p.kategorieSklepu, recznaKategoriaId: wej.recznaKategoriaId, mapa: ustawienia.mapaKategorii }, zrodlo)
    problemy.push(...w.problemy)
    if (w.problemy.some((x) => x.kod === 'allegro_niedostepne')) niesprawdzone = true
    kategoria = { id: w.kategoriaId, sciezka: [], opis: w.opis, propozycje: w.propozycje }
  }
  if (kategoria.id) {
    try {
      kategoria.sciezka = await zrodlo.sciezkaKategorii(kategoria.id)
    } catch {
      // sama nazwa kategorii — bez niej podgląd jest pełny (id zostaje)
    }
  }

  let parametryProduktu: WartoscParametruAllegro[] = []
  let parametryOferty: WartoscParametruAllegro[] = []
  let wiersze: WierszParametru[] = []
  if (kategoria.id) {
    try {
      const wszystkie = await zrodlo.parametryKategorii(kategoria.id)
      // w trybie katalogowym parametry produktu niesie katalog; zostają parametry oferty (np. „Stan”)
      const potrzebne = katalogowy ? wszystkie.filter((x) => !x.opisujeProdukt) : wszystkie
      const w = zbudujParametry(kategoria.id, potrzebne, p, ustawienia.parametry, wej.reczneParametry ?? {})
      ;({ parametryProduktu, parametryOferty, wiersze } = w)
      problemy.push(...w.problemy)
    } catch {
      problemy.push(nieudany('Nie udało się pobrać parametrów kategorii z Allegro — spróbuj ponownie za chwilę.', 'parametry'))
      niesprawdzone = true
    }
  }

  // 5. Cena i stan
  const cenaBrutto = wej.cenaBrutto ?? p.cenaBrutto
  const cena = cenaBrutto !== null && cenaBrutto !== undefined && Number.isFinite(cenaBrutto) && cenaBrutto > 0 ? { kwota: cenaBrutto.toFixed(2), waluta: 'PLN' as const } : null
  if (!cena) problemy.push({ kod: 'bez_ceny', waga: 'blad', komunikat: 'Produkt nie ma ceny brutto — uzupełnij ją w karcie produktu.', pole: 'cena' })
  const stan = Math.max(0, Math.floor(p.stan || 0))
  if (stan < 1) problemy.push({ kod: 'brak_stanu', waga: 'blad', komunikat: 'Brak towaru na stanie — oferta bez sztuk nie może być aktywna.', pole: 'stan' })

  const produktNode: Record<string, unknown> = katalogowy
    ? { id: katalogowy.id, ...(miniatura ? { images: [miniatura] } : {}) }
    : { name: tytul, category: { id: kategoria.id }, parameters: parametryProduktu, images: doOferty }
  const szkicOferty: Record<string, unknown> = {
    name: tytul,
    productSet: [{ product: produktNode }],
    sellingMode: { format: 'BUY_NOW', ...(cena ? { price: { amount: cena.kwota, currency: cena.waluta } } : {}) },
    stock: { available: stan, unit: 'UNIT' },
    ...(parametryOferty.length ? { parameters: parametryOferty } : {}),
    ...(opis.sections.length ? { description: opis } : {}),
    language: 'pl-PL',
  }

  return {
    kanal: 'allegro',
    tryb,
    tytul,
    produktKatalogowy: katalogowy ? { id: katalogowy.id, nazwa: katalogowy.nazwa } : null,
    kategoria,
    parametry: wiersze,
    opis,
    zdjecia: doOferty,
    cena,
    stan,
    problemy,
    gotowa: !maBledy(problemy) && !niesprawdzone,
    powodNiegotowej: niesprawdzone ? POWOD_NIESPRAWDZONEJ_KATEGORII : null,
    szkicOferty,
  }
}
