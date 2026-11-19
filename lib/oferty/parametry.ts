// Parametry oferty Allegro z danych produktu. Port `scripts/parameter_mapper.py` ze skilla allegro-oferty.
// Kolejność dla każdego parametru kategorii (jak `build_parameters`):
//   1) wartość wpisana ręcznie, 2) domyślna firmy dla tej kategorii (`CATEGORY_PARAM_DEFAULTS`),
//   3) stałe: EAN z produktu, marka firmy, waga, stan „Nowy”, inne stałe firmy (np. forma produktu w presecie firmy),
//   4) cecha produktu o pasującej nazwie, 5) brak → na listę braków, gdy parametr wymagany.
// Wartości słownikowe idą jako `valuesIds` (dopasowanie dokładne, potem zawieranie, bez ogonków).
// Różnice wobec pierwowzoru (skrypt ofert jednej firmy): marka, stan, stałe parametry, wagi domyślne i domyślne per kategoria są DANYMI firmy
// (`ZasadyParametrowFirmy`), nie stałymi w kodzie; waga z karty produktu jest w gramach (Kompletor), więc bez zgadywania
// „> 50 to gramy”; zgadnięta waga daje ostrzeżenie zamiast cichego wpisu.
import { ALLEGRO_PARAM_EAN, type AllegroParametrKategorii } from '@/lib/zrodla/allegro'
import { kluczNazwy } from './tekst'
import type { ProblemOferty, ProduktDoOferty } from './typy'

/** Parametry wspólne dla całego Allegro (id z dokumentacji Allegro, użyte w skillu). */
export const ALLEGRO_PARAM = {
  ean: ALLEGRO_PARAM_EAN,
  marka: '248811',
  waga: '221929',
  stan: '11323',
} as const

/** Wartość domyślna parametru: stała albo wzięta z produktu. */
export type WartoscDomyslna = string | { zCechy: string } | { zPola: 'sku' | 'ean' }

export interface ZasadyParametrowFirmy {
  /** Marka do parametru „Marka”; null = z cechy produktu „Marka”/„Producent”, inaczej brak. */
  marka: string | null
  /** Wartość parametru „Stan” (domyślnie „Nowy”). */
  stan: string
  /** Stałe parametry firmy niezależne od kategorii, np. { '3458': 'liściasta' } w presecie firmy. */
  stale: Record<string, WartoscDomyslna>
  /** Domyślne per kategoria Allegro: { idKategorii: { idParametru: wartość } }. */
  domyslnePerKategoria: Record<string, Record<string, WartoscDomyslna>>
  /** Waga w kg po słowie w nazwie produktu, gdy karta nie ma wagi (np. { lampa: '0.020' }). */
  wagiPoSlowie: Record<string, string>
  /** Waga w kg po kategorii sklepu (slug dokładny albo `prefiks*`), gdy nazwa nic nie podpowiada. */
  wagiPoKategoriiSklepu: Record<string, string>
}

export const DOMYSLNE_ZASADY_PARAMETROW: ZasadyParametrowFirmy = {
  marka: null,
  stan: 'Nowy',
  stale: {},
  domyslnePerKategoria: {},
  wagiPoSlowie: {},
  wagiPoKategoriiSklepu: {},
}

export interface WartoscParametruAllegro {
  id: string
  values?: string[]
  valuesIds?: string[]
}

export type ZrodloWartosci = 'reczna' | 'kategoria' | 'ean' | 'marka' | 'waga' | 'waga_zgadnieta' | 'stan' | 'stala' | 'cecha'

export interface WierszParametru {
  id: string
  nazwa: string
  wymagany: boolean
  opisujeProdukt: boolean
  /** Wartość do pokazania (z etykietą słownika); null = brak. */
  wartosc: string | null
  zrodlo: ZrodloWartosci | null
  /** Wymagany i bez wartości (na czerwono na ekranie). */
  brak: boolean
  /** Przykładowe wartości słownika przy braku (do 5). */
  przyklady: string[]
}

export interface WynikParametrow {
  /** `productSet[0].product.parameters` (describesProduct = true). */
  parametryProduktu: WartoscParametruAllegro[]
  /** `parameters` oferty (describesProduct = false). */
  parametryOferty: WartoscParametruAllegro[]
  wiersze: WierszParametru[]
  problemy: ProblemOferty[]
}

/** Dopasowanie wartości do słownika: najpierw równe, potem zawieranie (port `_match_value_id`). */
export function idZeSlownika(wartosc: string, slownik: { id: string; wartosc: string }[]): { id: string; wartosc: string } | null {
  const k = kluczNazwy(wartosc)
  if (!k) return null
  return slownik.find((d) => kluczNazwy(d.wartosc) === k) ?? slownik.find((d) => { const v = kluczNazwy(d.wartosc); return v !== '' && (v.includes(k) || k.includes(v)) }) ?? null
}

/** Cecha produktu o nazwie pasującej do parametru (port `_match_wc_attr`). */
export function wartoscCechy(nazwaParametru: string, cechy: ProduktDoOferty['atrybuty']): string | null {
  const pn = kluczNazwy(nazwaParametru)
  for (const c of cechy) {
    const an = kluczNazwy(c.nazwa)
    if (an === pn || (an && pn.includes(an)) || (pn && an.includes(pn))) {
      if (c.wartosc?.trim()) return c.wartosc.trim()
    }
  }
  return null
}

/** Waga w kg (3 miejsca) z karty, nazwy („75 g”) albo danych firmy; `zgadnieta` = nie z karty. */
export function wagaKg(p: ProduktDoOferty, z: ZasadyParametrowFirmy): { kg: string; zgadnieta: boolean } | null {
  if (p.wagaG && p.wagaG > 0) return { kg: (p.wagaG / 1000).toFixed(3), zgadnieta: false }
  const n = (p.nazwa ?? '').toLowerCase()
  const m = /(\d{2,4})\s*g\b/.exec(n)
  if (m) return { kg: (Number(m[1]) / 1000).toFixed(3), zgadnieta: true }
  for (const [slowo, kg] of Object.entries(z.wagiPoSlowie)) if (n.includes(slowo.toLowerCase())) return { kg, zgadnieta: true }
  for (const kat of p.kategorieSklepu) {
    const slug = kat.trim().toLowerCase()
    if (!slug) continue
    if (z.wagiPoKategoriiSklepu[slug]) return { kg: z.wagiPoKategoriiSklepu[slug]!, zgadnieta: true }
    for (const [wzor, kg] of Object.entries(z.wagiPoKategoriiSklepu)) if (wzor.endsWith('*') && slug.startsWith(wzor.slice(0, -1))) return { kg, zgadnieta: true }
  }
  return null
}

function rozwiaz(w: WartoscDomyslna, p: ProduktDoOferty): string | null {
  if (typeof w === 'string') return w.trim() || null
  if ('zCechy' in w) return wartoscCechy(w.zCechy, p.atrybuty)
  const v = w.zPola === 'sku' ? p.sku : p.ean
  return v?.trim() || null
}

/**
 * Parametry dla kategorii (`build_parameters` ze skilla). `reczne` = wartości wpisane na ekranie { idParametru: wartość }.
 */
export function zbudujParametry(
  kategoriaId: string,
  parametryKategorii: AllegroParametrKategorii[],
  produkt: ProduktDoOferty,
  zasady: ZasadyParametrowFirmy = DOMYSLNE_ZASADY_PARAMETROW,
  reczne: Record<string, string> = {},
): WynikParametrow {
  const parametryProduktu: WartoscParametruAllegro[] = []
  const parametryOferty: WartoscParametruAllegro[] = []
  const wiersze: WierszParametru[] = []
  const problemy: ProblemOferty[] = []
  const domKat = zasady.domyslnePerKategoria[kategoriaId] ?? {}
  const waga = wagaKg(produkt, zasady)
  const ean = produkt.ean?.trim() || null
  const marka = zasady.marka?.trim() || wartoscCechy('Marka', produkt.atrybuty) || wartoscCechy('Producent', produkt.atrybuty)

  for (const p of parametryKategorii) {
    const wymagany = p.wymagany || p.wymaganyDlaProduktu
    const cel = p.opisujeProdukt ? parametryProduktu : parametryOferty
    const wiersz: WierszParametru = { id: p.id, nazwa: p.nazwa, wymagany, opisujeProdukt: p.opisujeProdukt, wartosc: null, zrodlo: null, brak: false, przyklady: [] }
    wiersze.push(wiersz)

    /** Wpis wartości; słownik bez trafienia i bez „inna wartość” = false (szukamy dalej). */
    const wpisz = (v: string, zrodlo: ZrodloWartosci, tylkoSlownik = false): boolean => {
      if (p.slownik.length) {
        const hit = idZeSlownika(v, p.slownik)
        if (hit) {
          cel.push({ id: p.id, valuesIds: [hit.id] })
          Object.assign(wiersz, { wartosc: hit.wartosc, zrodlo })
          return true
        }
        if (tylkoSlownik || !p.dowolnaWartosc) return false
      }
      cel.push({ id: p.id, values: [v] })
      Object.assign(wiersz, { wartosc: v, zrodlo })
      return true
    }

    // 1. ręcznie (skill: --params-file; przy słowniku bez trafienia idzie jako tekst)
    const r = reczne[p.id]?.trim()
    if (r && wpisz(r, 'reczna')) continue
    // 2. domyślne firmy dla kategorii
    if (p.id in domKat) {
      const v = rozwiaz(domKat[p.id]!, produkt)
      if (v && wpisz(v, 'kategoria')) continue
    }
    // 3. stałe
    if (p.id === ALLEGRO_PARAM.ean) {
      if (ean && wpisz(ean, 'ean')) continue
    } else if (p.id === ALLEGRO_PARAM.marka) {
      if (marka) {
        if (wpisz(marka, 'marka', !p.dowolnaWartosc)) continue
        if (wymagany) problemy.push({ kod: 'marka_spoza_slownika', waga: 'blad', komunikat: `Marki „${marka}” nie ma na liście marek tej kategorii Allegro.`, pole: 'parametry' })
      }
    } else if (p.id === ALLEGRO_PARAM.waga) {
      if (waga && wpisz(waga.kg, waga.zgadnieta ? 'waga_zgadnieta' : 'waga')) {
        if (waga.zgadnieta)
          problemy.push({ kod: 'waga_zgadnieta', waga: 'ostrzezenie', komunikat: `Waga ${waga.kg.replace('.', ',')} kg dobrana z nazwy albo kategorii produktu — wpisz wagę w karcie produktu.`, pole: 'parametry' })
        continue
      }
    } else if (p.id === ALLEGRO_PARAM.stan) {
      if (zasady.stan && wpisz(zasady.stan, 'stan')) continue
    } else if (p.id in zasady.stale) {
      const v = rozwiaz(zasady.stale[p.id]!, produkt)
      if (v && wpisz(v, 'stala')) continue
    }
    // 4. cecha produktu
    const c = wartoscCechy(p.nazwa, produkt.atrybuty)
    if (c && wpisz(c, 'cecha')) continue
    // 5. brak
    if (wymagany) {
      wiersz.brak = true
      wiersz.przyklady = p.slownik.slice(0, 5).map((d) => d.wartosc)
    }
  }

  const braki = wiersze.filter((w) => w.brak)
  if (braki.length)
    problemy.push({
      kod: 'brak_parametrow',
      waga: 'blad',
      komunikat: `Brakuje wymaganych parametrów: ${braki.map((b) => b.nazwa).join(', ')}.`,
      pole: 'parametry',
    })
  return { parametryProduktu, parametryOferty, wiersze, problemy }
}
