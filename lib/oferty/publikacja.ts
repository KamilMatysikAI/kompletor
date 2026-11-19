// Ekran „Publikacja” na karcie produktu (Etap 3a): czysta część — konto kanału w postaci potrzebnej ekranowi,
// powody nieaktywnego przycisku „Wystaw” i kafel do pokazania (dane serializowalne dla komponentu klienta). Bez bazy
// i bez sieci: dane z bazy i z kanału zbiera lib/oferty/publikacja-serwer.ts. Teksty po polsku, bez żargonu, drogi do
// ustawień z działem menu.
import type { PodgladOfertyAllegro } from './allegro-podglad'
import type { PodgladOfertyEmpik } from './empik-podglad'
import { oczyscHtmlAllegro } from './regulamin-allegro'
import { escapeHtml, tekstZHtml } from './tekst'
import type { WagaProblemu } from './typy'
import type { PodgladProduktuWoo } from './woo-podglad'

export type KanalOferty = 'allegro' | 'empik' | 'woo'

/** Kanał Kompletora (enum `Channel`) → kanał ofertowania. Inne kanały nie mają jeszcze wystawiania. */
export const KANAL_OFERT: Readonly<Record<string, KanalOferty>> = { ALLEGRO: 'allegro', EMPIK: 'empik', WOO: 'woo' }

export const NAZWA_KANALU: Readonly<Record<KanalOferty, string>> = { allegro: 'Allegro', empik: 'Empik', woo: 'Sklep internetowy (WooCommerce)' }

export const DROGA_KANALOW = 'Ustawienia → Sprzedaż i kanały → Kanały sprzedaży'

/**
 * (pkt 7): numer oferty do powiązania z produktem po udanym „Wystaw” (null = nie wiążemy). Tylko wynik OK
 * z numerem; NIEJEDNOZNACZNY i reszta nie tworzą powiązania. Empik oddaje numer IMPORTU, nie oferty: oferta powstaje
 * dopiero po przetworzeniu importu i wiąże się istniejącym łączeniem ofert po SKU.
 */
export function ofertaDoPowiazania(kanal: KanalOferty, w: { kind: string; idZewnetrzne?: string | null }): string | null {
  if (w.kind !== 'OK' || kanal === 'empik') return null
  const id = (w.idZewnetrzne ?? '').trim()
  return id ? id : null
}

export interface KontoPublikacji {
  /** Kod konta z `kodKonta` (adres ekranu konta); null = firma nie ma konta tego kanału (podgląd z samych danych produktu). */
  kod: string | null
  kanal: KanalOferty
  nazwa: string
  aktywne: boolean
  /** Konto w wersji z zapisem (adapter zna wystawianie ofert). */
  zZapisem: boolean
  wystawianieWlaczone: boolean
  /** Allegro: czy autoryzacja konta ma zapis ofert („Stany ofert”); null = nie wiadomo (konto nie połączone). */
  zakresOfert: boolean | null
  /** Allegro: warunki konta wymagane przy nowej ofercie. */
  cennikDostawId: string | null
  zwrotyId: string | null
  reklamacjeId: string | null
  /** Połączenie z kontem do podglądu nie powstało (brak kluczy, zła konfiguracja): podgląd z samych danych produktu. */
  bezPolaczenia: boolean
}

export type PodgladKanalu = PodgladOfertyAllegro | PodgladOfertyEmpik | PodgladProduktuWoo

const KODY_EAN = new Set(['bez_ean', 'zly_ean'])
const publiczny = (u: string) => /^https:\/\//i.test(u)

/**
 * Powody, dla których „Wystaw” jest nieaktywny (pusta lista = aktywny). Kolejność: konto, uprawnienia kanału, dane
 * produktu. Każdy powód mówi, gdzie to poprawić.
 */
export function powodyBlokadyWystawienia(konto: KontoPublikacji, podglad: PodgladKanalu): string[] {
  const out: string[] = []
  const droga = konto.kod ? `${DROGA_KANALOW} → „${konto.nazwa}”` : DROGA_KANALOW
  if (!konto.kod) {
    out.push(`Firma nie ma konta ${NAZWA_KANALU[konto.kanal]}: dodasz je w ${DROGA_KANALOW} → „Dodaj konto”.`)
  } else {
    if (!konto.aktywne) out.push(`Konto „${konto.nazwa}” jest wyłączone: włączysz je w ${droga}.`)
    if (!konto.zZapisem) out.push(`Konto „${konto.nazwa}” tylko czyta z kanału: przełącz je na wersję z zapisem w ${droga} → „Zapis do sklepu”.`)
    else if (!konto.wystawianieWlaczone) out.push(`Wystawianie ofert jest wyłączone na koncie „${konto.nazwa}”: włączysz je w ${droga} → „Zapis do sklepu” → „Włącz wystawianie ofert”.`)
    if (konto.kanal === 'allegro') {
      if (konto.zakresOfert !== true)
        out.push(`Konto Allegro nie ma zgody na zakładanie ofert: kliknij „Połącz ponownie z Allegro” z zaznaczonym „Stany ofert” w ${droga}.`)
      if (!konto.cennikDostawId) out.push(`Konto Allegro nie ma wybranego cennika dostaw: wpisz go w ${droga} → „Ustawienia i klucze” → „Cennik dostaw (Allegro)”.`)
    }
  }
  if (podglad.problemy.some((p) => KODY_EAN.has(p.kod) && p.waga === 'blad')) out.push('Produkt nie ma poprawnego kodu EAN: uzupełnij go na karcie produktu w sekcji „Dane produktu”.')
  const zdjeciaWymagane = podglad.kanal === 'allegro' || (podglad.kanal === 'empik' && podglad.tryb === 'wniosek_o_produkt')
  if (zdjeciaWymagane && podglad.zdjecia.some((z) => !publiczny(z)))
    out.push('Zdjęcia produktu nie mają publicznego adresu (https), więc kanał ich nie pobierze: dodaj zdjęcia z adresem w sieci albo poczekaj na wgrywanie zdjęć do kanału.')
  if (podglad.kanal === 'woo' && podglad.tryb === 'istnieje') out.push('Sklep ma już produkt z tym SKU: powiąż go z produktem zamiast zakładać drugi.')
  else if (podglad.kanal === 'allegro' && podglad.powodNiegotowej) out.push(podglad.powodNiegotowej)
  else if (!podglad.gotowa) out.push('Oferta ma błędy do poprawienia (lista „Do poprawy” w tym kaflu).')
  return [...new Set(out)]
}

/**
 * (3b-2b): ręczny wybór na ekranie „Publikacja” — kategoria z propozycji kanału i wartości brakujących
 * parametrów { numerParametru: wartość }. Dziś tylko Allegro (Empik i sklep biorą kategorię z katalogu i karty).
 * Wybór żyje w obrębie ekranu: nie zapisuje się przy produkcie.
 */
export interface WyborReczny {
  kategoriaId: string | null
  parametry: Record<string, string>
}

const ID_KANALU_RE = /^[0-9]{1,20}$/
// eslint-disable-next-line no-control-regex -- znaki sterujące nie mają czego szukać w wartości parametru
const STERUJACE_RE = /[\u0000-\u001f\u007f]/g
export const WARTOSC_PARAMETRU_MAX = 200
export const PARAMETRY_RECZNE_MAX = 60

/**
 * Wybór z przeglądarki (dane niezaufane) → `WyborReczny`. Numery kategorii i parametrów Allegro to cyfry; inne klucze,
 * puste wartości i znaki sterujące odpadają, wartość przycinana do 200 znaków, najwyżej 60 parametrów.
 */
export function wyborRecznyZWejscia(raw: unknown): WyborReczny {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kategoriaId: null, parametry: {} }
  const r = raw as { kategoriaId?: unknown; parametry?: unknown }
  const kat = typeof r.kategoriaId === 'string' ? r.kategoriaId.trim() : ''
  const parametry: Record<string, string> = {}
  if (r.parametry && typeof r.parametry === 'object' && !Array.isArray(r.parametry)) {
    for (const [k, v] of Object.entries(r.parametry as Record<string, unknown>)) {
      if (Object.keys(parametry).length >= PARAMETRY_RECZNE_MAX) break
      if (!ID_KANALU_RE.test(k) || typeof v !== 'string') continue
      const w = v.replace(STERUJACE_RE, ' ').trim().slice(0, WARTOSC_PARAMETRU_MAX)
      if (w) parametry[k] = w
    }
  }
  return { kategoriaId: ID_KANALU_RE.test(kat) ? kat : null, parametry }
}

/**
 * Lista wyboru kategorii na kaflu: pierwsza pozycja wraca do kategorii dobranej automatycznie, dalej kategoria
 * z podglądu (gdy nie ma jej w propozycjach) i propozycje kanału. Pusta lista = kanał bez wyboru kategorii.
 */
export function opcjeKategorii(k: Pick<KafelPublikacji, 'kanal' | 'kategoria' | 'kategoriaId' | 'kategoriaReczna' | 'propozycjeKategorii'>): { wartosc: string; etykieta: string }[] {
  if (k.kanal !== 'allegro' || (!k.propozycjeKategorii.length && !k.kategoriaReczna)) return []
  const opcje = [{ wartosc: '', etykieta: 'Dobierz automatycznie (mapa kategorii firmy albo propozycja Allegro)' }]
  if (k.kategoriaId && !k.propozycjeKategorii.some((p) => p.id === k.kategoriaId)) opcje.push({ wartosc: k.kategoriaId, etykieta: `${k.kategoria ?? `nr ${k.kategoriaId}`} (w podglądzie)` })
  for (const p of k.propozycjeKategorii) opcje.push({ wartosc: p.id, etykieta: p.etykieta })
  return opcje
}

/** Parametry do wpisania na ekranie: tylko Allegro, wymagane bez wartości i te już wpisane ręcznie (do poprawy). */
export function parametryDoUzupelnienia(k: Pick<KafelPublikacji, 'kanal' | 'parametry'>): KafelPublikacji['parametry'] {
  return k.kanal === 'allegro' ? k.parametry.filter((p) => p.brak || p.reczna) : []
}

export const wyborPusty =(w: WyborReczny | null | undefined): boolean => !w || (!w.kategoriaId && Object.keys(w.parametry).length === 0)

export type FragmentOpisu = { typ: 'tekst'; html: string } | { typ: 'zdjecie'; url: string }

export interface KafelPublikacji {
  /** Kod konta albo `brak:<kanał>` (kafel bez konta). */
  klucz: string
  kod: string | null
  kanal: KanalOferty
  nazwaKanalu: string
  nazwaKonta: string | null
  /** Co powstanie po „Wystaw”, po ludzku. */
  rodzaj: string
  tytul: string
  kategoria: string | null
  /** Numer kategorii Allegro w podglądzie (zaznaczenie na liście wyboru); null poza Allegro albo bez kategorii. */
  kategoriaId: string | null
  /** Kategoria wybrana ręcznie na ekranie (nie z mapy firmy ani z propozycji kanału). */
  kategoriaReczna: boolean
  /** Do 5 liści zaproponowanych przez kanał (wybór na ekranie). */
  propozycjeKategorii: { id: string; etykieta: string }[]
  /** `id` = numer parametru kanału (klucz wartości wpisanej ręcznie); `przyklady` = wartości ze słownika kanału. */
  parametry: { id: string; nazwa: string; wartosc: string | null; brak: boolean; wymagany: boolean; reczna: boolean; przyklady: string[] }[]
  /** Opis do pokazania: fragmenty HTML (oczyszczone do znaczników opisu Allegro) i zdjęcia. */
  opis: FragmentOpisu[]
  zdjecia: { url: string; publiczny: boolean }[]
  cena: string | null
  stan: number
  problemy: { waga: WagaProblemu; komunikat: string }[]
  bezPolaczenia: boolean
  wystaw: { mozna: boolean; powody: string[] }
}

const cenaTekst = (c: { kwota: string; waluta: 'PLN' } | null) => (c ? `${c.kwota.replace('.', ',')} zł` : null)
const akapity = (tekst: string): FragmentOpisu[] =>
  tekst
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ typ: 'tekst' as const, html: `<p>${escapeHtml(t)}</p>` }))

/** Kafel ekranu z podglądu kanału i konta (serializowalny: bez funkcji, bez dat). */
export function kafelZPodgladu(konto: KontoPublikacji, podglad: PodgladKanalu, reczne?: WyborReczny): KafelPublikacji {
  const powody = powodyBlokadyWystawienia(konto, podglad)
  const wspolne = {
    klucz: konto.kod ?? `brak:${konto.kanal}`,
    kod: konto.kod,
    kanal: konto.kanal,
    nazwaKanalu: NAZWA_KANALU[konto.kanal],
    nazwaKonta: konto.kod ? konto.nazwa : null,
    cena: cenaTekst(podglad.cena),
    stan: podglad.stan,
    problemy: podglad.problemy.map((p) => ({ waga: p.waga, komunikat: p.komunikat })),
    bezPolaczenia: konto.bezPolaczenia,
    wystaw: { mozna: powody.length === 0, powody },
  }
  if (podglad.kanal === 'allegro') {
    const opis: FragmentOpisu[] = podglad.opis.sections.flatMap((s) => s.items.map((i): FragmentOpisu => (i.type === 'TEXT' ? { typ: 'tekst', html: oczyscHtmlAllegro(i.content) } : { typ: 'zdjecie', url: i.url })))
    return {
      ...wspolne,
      rodzaj: podglad.tryb === 'katalog' ? `Oferta do produktu z katalogu Allegro („${podglad.produktKatalogowy?.nazwa ?? ''}”)` : 'Nowy produkt w katalogu Allegro z ofertą',
      tytul: podglad.tytul,
      kategoria: podglad.kategoria.sciezka.length ? podglad.kategoria.sciezka.join(' → ') : podglad.kategoria.id ? `nr ${podglad.kategoria.id}` : null,
      kategoriaId: podglad.kategoria.id,
      kategoriaReczna: !!reczne?.kategoriaId && reczne.kategoriaId === podglad.kategoria.id,
      propozycjeKategorii: podglad.kategoria.propozycje.slice(0, 5).map((p) => ({ id: p.id, etykieta: p.rodzicNazwa ? `${p.rodzicNazwa} → ${p.nazwa}` : p.nazwa })),
      parametry: podglad.parametry.map((p) => ({ id: p.id, nazwa: p.nazwa, wartosc: p.wartosc, brak: p.brak, wymagany: p.wymagany, reczna: p.zrodlo === 'reczna', przyklady: p.przyklady.slice(0, 5) })),
      opis,
      zdjecia: podglad.zdjecia.map((url) => ({ url, publiczny: publiczny(url) })),
    }
  }
  if (podglad.kanal === 'empik') {
    const wniosek = podglad.tryb === 'wniosek_o_produkt'
    return {
      ...wspolne,
      rodzaj: wniosek ? 'Wniosek o nowy produkt w katalogu Empiku (Empik sprawdza go ręcznie), potem oferta' : `Oferta do produktu z katalogu Empiku („${podglad.produktPim?.tytul ?? ''}”)`,
      tytul: podglad.tytul,
      kategoria: podglad.kategoria.kod ? `${podglad.produktPim?.kategoriaNazwa ?? podglad.kategoria.opis} (kod ${podglad.kategoria.kod})` : null,
      kategoriaId: null,
      kategoriaReczna: false,
      propozycjeKategorii: [],
      parametry: [],
      opis: akapity(wniosek ? podglad.opisProduktu : podglad.opisOferty),
      zdjecia: podglad.zdjecia.map((url) => ({ url, publiczny: publiczny(url) })),
    }
  }
  return {
    ...wspolne,
    rodzaj: podglad.tryb === 'istnieje' ? `Sklep ma już ten produkt (nr ${podglad.istniejacyId ?? '?'})` : `Nowy produkt w sklepie (${podglad.status === 'draft' ? 'jako szkic, do opublikowania w sklepie' : 'od razu opublikowany'})`,
    tytul: podglad.nazwa,
    kategoria: podglad.kategorie.length ? podglad.kategorie.map((k) => k.nazwa).join(', ') : null,
    kategoriaId: null,
    kategoriaReczna: false,
    propozycjeKategorii: [],
    parametry: [
      { id: 'sku', nazwa: 'SKU', wartosc: podglad.sku || null, brak: !podglad.sku, wymagany: true, reczna: false, przyklady: [] },
      { id: 'ean', nazwa: 'EAN', wartosc: podglad.ean, brak: false, wymagany: false, reczna: false, przyklady: [] },
    ],
    opis: akapity(tekstZHtml(podglad.opis)),
    zdjecia: podglad.zdjecia.map((url) => ({ url, publiczny: publiczny(url) })),
  }
}
