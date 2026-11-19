// pozycja zamiennika („Zamień produkt”, `swapProduct` w lib/rdzen/brakuje.ts)
// na dokumencie sprzedaży, w linii faktury rdzenia i na karcie zamówienia. Czysta funkcja, bez bazy: wołają ją
// `pozycjeZamowienia` (lib/dokumenty/pozycje.ts), `buildInvoiceLines` (lib/rdzen/rozchod.ts) i karta (lib/karta/dane.ts),
// więc wszystkie trzy liczą zamiennik tak samo.
//
// Zamiennik to nowa pozycja bez oferty kanału (kanał jej nie zna), z ilością w jednostce bazowej i ceną skopiowaną
// z pozycji pierwotnej, czyli ceną za SZTUKĘ OFERTY pozycji pierwotnej. Dlatego:
// - przelicznik oferty (`qtyBasePerOffer`) zamiennika = przelicznik pozycji pierwotnej (pierwszej w łańcuchu zamian);
// - zamiennik nie jest dodatkową sprzedażą: jego sztuki to odrzucone sztuki pozycji pierwotnej, za które klient już
//   zapłacił w kwocie zamówienia. Wartość „pełna” zamówienia (z której wynika wysyłka) liczy tylko pozycje z kanału.
// Gdy pozycji pierwotnej nie ma w zamówieniu (usunięta w kanale, zamiennik z dosłania w innej paczce) albo zamieniono
// więcej sztuk, niż pozycja ma odrzuconych, kwoty nie da się ustalić: błąd zamiany, dokument staje z komunikatem.
//
// Runda 2:
// - zamiennik ma cenę pozycji pierwotnej; inna cena (edycja sprzed blokady w lib/rdzen/edycja.ts albo inna droga
//   zapisu) i usunięty zamiennik to błąd zamiany, nie cicha inna kwota;
// - pozycja pierwotna i jej zamienniki to jedna „rodzina” o cenie pozycji pierwotnej. Wartość każdej części liczymy
//   jako przyrost wartości rodziny: w(przesunięcie + ilość) − w(przesunięcie), gdzie przesunięcie = jednostki bazowe
//   części wcześniejszych (najpierw pozycja pierwotna, potem zamienniki wg numeru zamiany). Suma części = wartość
//   wszystkich pokrytych jednostek liczona raz, więc pozycja zamieniona w całości daje co do grosza wartość pozycji.
import { wartoscPozycjiGr } from './ceny'

/** Znacznik pozycji zamiennika w `OrderLine.externalLineId`: `<pozycja źródłowa>#zamiana-<n>`. */
export const LINIA_ZAMIANY = '#zamiana-'

const KONIEC_ZAMIANY = /#zamiana-\d+$/

/** Pozycja jest zamiennikiem założonym w tym zamówieniu (`swapProduct`), nie pozycją z kanału. */
export const czyZamiennik = (externalLineId: string): boolean => KONIEC_ZAMIANY.test(externalLineId)

/** `externalLineId` pozycji pierwotnej (z kanału, pierwszej w łańcuchu zamian); null = pozycja bez zamiany w nazwie. */
export function pozycjaPierwotnaZamiany(externalLineId: string): string | null {
  const i = externalLineId.indexOf(LINIA_ZAMIANY)
  return i < 0 ? null : externalLineId.slice(0, i)
}

/** `externalLineId` pozycji, z której zamiennik bezpośrednio powstał (przy zamianie zamiennika: poprzedni zamiennik). */
export function zrodloZamiany(externalLineId: string): string | null {
  const m = KONIEC_ZAMIANY.exec(externalLineId)
  return m ? externalLineId.slice(0, m.index) : null
}

/**
 * - `bez-pozycji-pierwotnej`: w zamówieniu nie ma (albo usunięto) pozycji, którą zamieniono — nie wiadomo, za co i ile
 *   klient zapłacił (także pozycja dosłania zamiennika w innej paczce);
 * - `wiecej-niz-odrzucono`: zamienniki jednej pozycji mają więcej sztuk, niż ta pozycja ma odrzuconych;
 * - `cena-inna-niz-pierwotna`: zamiennik ma inną cenę niż pozycja pierwotna (klient zapłacił cenę pozycji pierwotnej);
 * - `usuniety-zamiennik` (na pozycji pierwotnej): zamiennik tej pozycji został usunięty, więc nie wiadomo, czy klient
 *   dostał towar za zapłacone sztuki.
 */
export type BladZamiany = 'bez-pozycji-pierwotnej' | 'wiecej-niz-odrzucono' | 'cena-inna-niz-pierwotna' | 'usuniety-zamiennik'

export interface LiniaDoPrzeliczenia {
  id: string
  externalLineId: string
  productId: string | null
  offerId: string | null
  qty: number
  qtyRejected: number
  removed: boolean
  /** Cena za sztukę oferty (Decimal z bazy albo liczba w zł). Bez pola: bez sprawdzenia ceny zamiennika. */
  unitPriceGross?: { toString(): string } | number
}

export interface PrzelicznikiPozycji {
  /** Id pozycji → qtyBasePerOffer (brak w mapie = 1). Zamiennik dziedziczy przelicznik pozycji pierwotnej. */
  naOferte: Map<string, number>
  /** Id pozycji zamiennika → błąd zamiany albo null (zamiennik poprawny). Pozycji spoza zamian nie ma w mapie. */
  zamienniki: Map<string, BladZamiany | null>
  /** Id części rodziny zamian (pozycja pierwotna ma 0) → jednostki bazowe części wcześniejszych. */
  przesuniecie: Map<string, number>
  /** Id pozycji pierwotnej z zamiennikami → jednostki bazowe pokryte przez całą rodzinę (do celu bezpiecznika). */
  pokryte: Map<string, number>
  /** Id pozycji pierwotnej → błąd rodziny (`usuniety-zamiennik`). */
  bledyPierwotnych: Map<string, BladZamiany>
}

/** Wartość części rodziny zamian: przyrost wartości rodziny od `przesuniecie` do `przesuniecie + qtyBase`. */
export function wartoscCzesciGr(qtyBase: number, przesuniecie: number, naOferte: number, cenaOfertyGr: number): number {
  return wartoscPozycjiGr(przesuniecie + qtyBase, naOferte, cenaOfertyGr) - wartoscPozycjiGr(przesuniecie, naOferte, cenaOfertyGr)
}

const groszeCeny = (v: { toString(): string } | number | undefined): number | null => (v === undefined ? null : Math.round(Number(v.toString()) * 100))
/** Numery zamian w nazwie (`L1#zamiana-3#zamiana-7` → [3, 7]): kolejność części rodziny, deterministyczna. */
const numeryZamian = (ext: string): number[] => [...ext.matchAll(/#zamiana-(\d+)/g)].map((m) => Number(m[1]))
function porownajZamiany(a: string, b: string): number {
  const x = numeryZamian(a)
  const y = numeryZamian(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return x.length - y.length || (a < b ? -1 : a > b ? 1 : 0)
}

const poprawny = (n: number | undefined): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0

/**
 * Przeliczniki oferty wszystkich pozycji zamówienia (wejście: WSZYSTKIE pozycje, także usunięte). Pozycja z kanału:
 * przelicznik jej oferty (`przelicznikOferty(offerId)`, tylko pozycja z produktem i ofertą). Pozycja z „zamiana” w nazwie:
 * przelicznik pozycji pierwotnej i wpis w `zamienniki`.
 */
export function przelicznikiPozycji(linie: readonly LiniaDoPrzeliczenia[], przelicznikOferty: (offerId: string) => number | undefined): PrzelicznikiPozycji {
  const naOferte = new Map<string, number>()
  const zamienniki = new Map<string, BladZamiany | null>()
  const poExt = new Map(linie.map((l) => [l.externalLineId, l]))
  for (const l of linie) {
    if (pozycjaPierwotnaZamiany(l.externalLineId) !== null) continue
    const n = l.productId && l.offerId ? przelicznikOferty(l.offerId) : undefined
    if (poprawny(n)) naOferte.set(l.id, n)
  }
  const zZamiana = linie.filter((l) => pozycjaPierwotnaZamiany(l.externalLineId) !== null)
  // ile sztuk przeszło z każdej pozycji źródłowej na jej zamienniki
  const naZamienniki = new Map<string, number>()
  for (const l of zZamiana) {
    const zrodlo = zrodloZamiany(l.externalLineId)
    if (zrodlo !== null && !l.removed) naZamienniki.set(zrodlo, (naZamienniki.get(zrodlo) ?? 0) + l.qty)
  }
  for (const l of zZamiana) {
    const pierwotna = poExt.get(pozycjaPierwotnaZamiany(l.externalLineId)!)
    const zrodloId = zrodloZamiany(l.externalLineId)
    const zrodlo = zrodloId !== null ? poExt.get(zrodloId) : undefined
    // pozycja pochodna zamiennika w innej paczce (np. `…#zamiana-1#dosle`): źródło jest w zamówieniu głównym
    if (!pierwotna || pierwotna.removed || !zrodlo || zrodlo.removed) {
      zamienniki.set(l.id, 'bez-pozycji-pierwotnej')
      continue
    }
    const n = naOferte.get(pierwotna.id)
    if (n !== undefined) naOferte.set(l.id, n)
    const cenaZ = groszeCeny(l.unitPriceGross)
    const cenaP = groszeCeny(pierwotna.unitPriceGross)
    zamienniki.set(l.id, cenaZ !== null && cenaP !== null && cenaZ !== cenaP ? 'cena-inna-niz-pierwotna' : (naZamienniki.get(zrodloId!) ?? 0) > zrodlo.qtyRejected ? 'wiecej-niz-odrzucono' : null)
  }
  // rodziny zamian (pozycja pierwotna + jej zamienniki w tym zamówieniu), przesunięcia i jednostki pokryte
  const przesuniecie = new Map<string, number>()
  const pokryte = new Map<string, number>()
  const bledyPierwotnych = new Map<string, BladZamiany>()
  const rodziny = new Map<string, LiniaDoPrzeliczenia[]>()
  for (const l of zZamiana) {
    const pierwotna = poExt.get(pozycjaPierwotnaZamiany(l.externalLineId)!)
    if (!pierwotna || pierwotna.removed) continue
    if (l.removed) {
      if (czyZamiennik(l.externalLineId)) bledyPierwotnych.set(pierwotna.id, 'usuniety-zamiennik')
      continue
    }
    rodziny.set(pierwotna.id, [...(rodziny.get(pierwotna.id) ?? []), l])
  }
  for (const pierwotna of linie) {
    const czesci = rodziny.get(pierwotna.id)
    if (!czesci) continue
    let suma = Math.max(0, pierwotna.qty - pierwotna.qtyRejected)
    przesuniecie.set(pierwotna.id, 0)
    for (const l of [...czesci].sort((a, b) => porownajZamiany(a.externalLineId, b.externalLineId))) {
      przesuniecie.set(l.id, suma)
      suma += Math.max(0, l.qty - l.qtyRejected)
    }
    pokryte.set(pierwotna.id, suma)
  }
  return { naOferte, zamienniki, przesuniecie, pokryte, bledyPierwotnych }
}
