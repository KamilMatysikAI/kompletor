// Pozycje dokumentu sprzedaży wspólne dla wszystkich programów do faktur.
//
// Jedno miejsce, które z zamówienia robi linie dokumentu: wFirma (`zlozFakture`, lib/wfirma/faktura.ts), szkic KSeF
// (`linieKsef`, lib/ksef/linie.ts) i każdy kolejny program (faktury v2, Fakturownia, korekty) biorą linie STĄD i dokładają
// tylko to, co jest ich własne (kody VAT konta, forma płatności w słowniku programu, treść żądania).
//
// Reguły (spec 3.4, 15.1):
// - wszystko w groszach (liczby całkowite); ilość pozycji `qty − qtyOdrzucone` w jednostce bazowej, cena za sztukę oferty
//   (`naOferte` = qtyBasePerOffer przelicza jedno na drugie), wartość `wartoscPozycjiGr` (ta sama funkcja co linie
//   rdzenia i karta, /);
// - zamiennik („Zamień produkt”) ma przelicznik pozycji pierwotnej i nie wchodzi do wartości pełnej: jego
//   sztuki to odrzucone sztuki pozycji pierwotnej, za które klient już zapłacił; gdy kwoty nie da się ustalić — problem;
// - zestaw rozbity na składniki `splitBundlePrice`, każdy składnik z własną stawką VAT;
// - DIGITAL (e-book, usługa) to usługa bez WZ;
// - linia z ceną, której nie da się zapisać co do grosza, idzie dwiema liniami (reszta o 1 gr droższa); ilość ułamkowa
//   (kg) dostaje najbliższą cenę, a resztę groszy wchłania wysyłka;
// - wysyłka = kwota zamówienia minus pełna wartość pozycji (z odrzuconymi), stawka i nazwa z ustawień firmy;
// - rabat na całe zamówienie: gdy znany jest koszt wysyłki z kanału, a pozycje + wysyłka przekraczają kwotę
//   zamówienia, różnica to rabat na towar (ujemna opłata Woo, rabat kanału spoza pozycji). Cena za sztukę każdej pozycji
//   × (towary po rabacie / przed), do grosza (`cenaPoRabacieGr`), reszta na pierwszej pozycji; wysyłka zostaje kosztem
//   z kanału. Różnica w granicach reszty zaokrągleń (najwyżej pół grosza na sztukę oferty, w obie strony; ceny po
//   rabacie z adaptera) cen nie skaluje, tylko idzie korektą na pierwszą pozycję (runda 2, inaczej podział groszy
//   różniłby się od BL). Większa nadwyżka kwoty (pobranie, opłata) idzie do wysyłki jak dotąd. Koszt nieznany = jak
//   dotąd. Runda 2: rabat ponad sufit firmy (domyślnie 50%) = `pozycje-drozsze-niz-zamowienie`; pozycja za 0 zł po
//   rabacie = `cena-zero-po-rabacie`; rabat liczony na dokumencie przy paczkach dodatkowych albo pobraniu =
//   `rabat-niepewny-podzial`. Runda 3: reszta groszy tylko na pozycję płatną (gratis za 0 zł nigdy), pozycja
//   z korektą ≤ 0 = `cena-zero-po-rabacie`, rabat bez płatnej pozycji = `rabat-bez-platnej-pozycji`; stop
//   `rabat-niepewny-podzial` dopiero powyżej 1% wartości pozycji (`PROG_PEWNOSCI_RABATU_PROC`);
// - bezpiecznik: suma linii = kwota zamówienia bez pozycji odrzuconych, co do grosza, inaczej problem.
//
// Problemy mają pole `dotyczyProgramu`: brak pola = problem dokumentu w każdym programie (np. pozycja bez produktu);
// `'wfirma'` = problem tylko konta wFirmy (towar bez powiązania z kartoteką wFirmy). Program filtruje po tym polu zamiast
// trzymać własną listę kodów. Nowy problem specyficzny dla programu dostaje jego klucz w `dotyczyProgramu`.
//
// Bez bazy i bez importu z lib/wfirma (test architektury w dokumenty.test.ts). `pozycjeZamowienia` buduje wejście
// z wierszy Prismy przekazanych przez wywołującego (zamówienie z pozycjami, mapy produktów i ofert).
import type { Prisma, Product } from '@prisma/client'
import { cenaPoRabacieGr, DOMYSLNY_SUFIT_RABATU_PROC, rabatWSuficie, resztaZaokraglenGr, splitBundlePrice, type SplitLine, wartoscPozycjiGr } from '../rdzen/ceny'
import { type BladZamiany, przelicznikiPozycji, wartoscCzesciGr } from '../rdzen/zamiana'
import type { ProgramDokumentow } from './ustawienia'

export type KategoriaRoznicy = 'BRAK_POWIAZANIA' | 'ZAOKRAGLENIE' | 'WYSYLKA' | 'VAT' | 'INNE'

/** Problem albo różnica: same kody, liczby i SKU, bez danych kontrahenta. */
export interface Problem {
  kategoria: KategoriaRoznicy
  kod: string
  sku?: string | null
  nasze?: number | string | null
  bl?: number | string | null
  /** Brak = problem w każdym programie; klucz programu = tylko w nim (np. `'wfirma'`: towar bez powiązania z kartoteką). */
  dotyczyProgramu?: ProgramDokumentow
}

export interface SkladnikZestawu {
  sku: string
  nazwa: string
  jednostka: 'SZT' | 'KG'
  wfirmaGoodId: string | null
  qty: number // jednostka bazowa na 1 zestaw
  cenaDetalicznaBrutto: number // zł
  stawkaVat: string | null
}

export interface PozycjaZamowienia {
  /** null = pozycja bez produktu (niezmapowana oferta). */
  sku: string | null
  rodzaj: 'STOCKED' | 'BUNDLE' | 'DIGITAL' | null
  nazwa: string
  jednostka: 'SZT' | 'KG'
  /** Towar w kartotece wFirmy; inne programy go nie używają (linia dostaje wtedy `goodId`, którego nie czytają). */
  wfirmaGoodId: string | null
  qty: number // jednostka bazowa; dla zestawu liczba zestawów
  qtyOdrzucone: number
  naOferte: number // qtyBasePerOffer (1 bez oferty)
  cenaBruttoGr: number // za sztukę oferty
  stawkaVat: string | null // z pozycji albo produktu
  skladniki?: SkladnikZestawu[]
  /**
   * pozycja zamiennika („Zamień produkt”). `null` = poprawny zamiennik (nie wchodzi do wartości pełnej
   * zamówienia), kod = kwoty nie da się ustalić (problem `zamiennik-<kod>`, dokument staje). Brak pola = pozycja z kanału.
   */
  zamiennik?: BladZamiany | null
  /**
   * część rodziny zamian — jednostki bazowe części wcześniejszych (pozycja pierwotna 0).
   * Wartość części = `wartoscCzesciGr(ilość, przesuniecie, …)`. Brak pola = 0 (pozycja bez zamian: wartość jak zawsze).
   */
  przesuniecie?: number
  /** Pozycja pierwotna z zamiennikami: jednostki bazowe pokryte przez całą rodzinę (cel bezpiecznika,/). */
  pokryte?: number
  /** Pozycja pierwotna: błąd rodziny zamian (np. usunięty zamiennik) — problem `zamiennik-<kod>`, dokument staje. */
  bladZamiany?: BladZamiany
}

/** Linia dokumentu. Ten sam kształt dla każdego programu; `goodId` czyta tylko wFirma. */
export interface LiniaDokumentu {
  sku: string | null
  /** Zestaw, z którego pozycja pochodzi: BL może mieć go jedną linią (porównanie składa go z powrotem). */
  zestawSku?: string
  /** Indeks pozycji zamówienia i jej sztuki oferty (tak liczy BL); wysyłka: -1. */
  pozycja: number
  sztukOferty: number
  goodId: number | null // wFirma: 0 = bez towaru; null = brak powiązania
  nazwa: string
  ilosc: number // w jednostce dokumentu (szt. albo kg)
  jednostka: 'szt.' | 'kg'
  cenaBruttoGr: number // za jednostkę dokumentu
  bruttoGr: number
  stawkaVat: string
  usluga?: true
  wysylka?: true
}

export interface WejsciePozycji {
  totalGross: number // zł, `Order.totalGross` (dla paczki dodatkowej: suma jej pozycji)
  pozycje: PozycjaZamowienia[]
  /** Pozycja wysyłki z ustawień firmy (`settings.faktury.wysylka`). */
  wysylka: { nazwa: string; stawkaVat: string }
  /**
   * dokument bez rozchodu (stan prowadzi Kompletor). Towar bez powiązania z kartoteką wFirmy idzie pozycją
   * z nazwy (`goodId = 0`) zamiast problemu `brak-towaru-wfirmy`.
   */
  towarBezPowiazania?: boolean
  /**
   * koszt wysyłki brutto z kanału (zł, `Order.shippingCostGross`); null albo brak = nieznany (wysyłka = kwota
   * minus pozycje, jak). Znany koszt oddziela rabat na całe zamówienie od wysyłki (`towaryPoRabacieGr`).
   * Paczka dodatkowa go nie podaje (wysyłka jest na fakturze pierwszej paczki).
   */
  kosztWysylki?: number | null
  /**
   * sufit rabatu na całe zamówienie w procentach wartości pozycji (`rabatMaksProcent` firmy,
   * lib/dokumenty/ustawienia.ts). Brak = `DOMYSLNY_SUFIT_RABATU_PROC` (50).
   */
  rabatMaksProcent?: number
  /**
   * zamówienie ma paczki dodatkowe (podział, „dośle później”). Ich faktury biorą cenę
   * z pozycji zamówienia, więc rabat liczony dopiero na tym dokumencie rozjechałby sumę faktur z zapłatą: stop.
   */
  paczkiDodatkowe?: boolean
  /**
   * zamówienie za pobraniem. Opłata za pobranie siedzi w kwocie zamówienia, a nie w koszcie
   * wysyłki, więc przy rabacie liczonym na dokumencie nie da się pewnie oddzielić towaru od wysyłki: stop.
   */
  pobranie?: boolean
  /**
   * paczka dodatkowa, której zamówienie główne ma rabat liczony dopiero na dokumencie (cena
   * pozycji sprzed rabatu): faktura paczki wyszłaby po cenie bez rabatu, stop (`rabatLiczonyNaDokumencie` matki).
   */
  rabatMatkiNaDokumencie?: boolean
}

export interface PozycjeDokumentu {
  linie: LiniaDokumentu[]
  problemy: Problem[]
  bruttoGr: number
  nettoGr: number
}

/** Stawka VAT w postaci kanonicznej: „5.00” → „5”, „ZW” → „zw”. */
export const stawka = (v: string): string => {
  const n = Number(String(v).replace(',', '.'))
  return String(v).trim() !== '' && Number.isFinite(n) ? String(n) : String(v).trim().toLowerCase()
}

/** Netto z sum brutto per stawka (tak liczy suma dokumentu wg stawek). */
export function nettoGr(linie: { bruttoGr: number; stawkaVat: string }[]): number {
  const per = new Map<string, number>()
  for (const l of linie) per.set(l.stawkaVat, (per.get(l.stawkaVat) ?? 0) + l.bruttoGr)
  let out = 0
  for (const [s, gr] of per) {
    const r = Number(s)
    out += Number.isFinite(r) ? Math.round((gr * 100) / (100 + r)) : gr
  }
  return out
}

/**
 * Wartość linii rozpisana na cenę jednostkową z dokładnością do grosza. Ilość całkowita: dwie linie (reszta o 1 gr droższa,
 * jak `splitBundlePrice`), więc suma zawsze się zgadza. Ilość ułamkowa (kg): najbliższa cena; reszta wraca do wywołującego.
 */
function rozpisz(bruttoGr: number, ilosc: number): { linie: { ilosc: number; cenaGr: number; bruttoGr: number }[]; resztaGr: number } {
  if (Number.isInteger(ilosc)) {
    const cena = Math.floor(bruttoGr / ilosc)
    const r = bruttoGr - cena * ilosc
    if (!r) return { linie: [{ ilosc, cenaGr: cena, bruttoGr }], resztaGr: 0 }
    return {
      linie: [
        { ilosc: ilosc - r, cenaGr: cena, bruttoGr: cena * (ilosc - r) },
        { ilosc: r, cenaGr: cena + 1, bruttoGr: (cena + 1) * r },
      ],
      resztaGr: 0,
    }
  }
  const baza = Math.round(bruttoGr / ilosc)
  const cena = [baza, baza + 1, baza - 1].find((c) => Math.round(c * ilosc) === bruttoGr) ?? baza
  const wyszlo = Math.round(cena * ilosc)
  return { linie: [{ ilosc, cenaGr: cena, bruttoGr: wyszlo }], resztaGr: bruttoGr - wyszlo }
}

/**
 * wartość towarów po rabacie na całe zamówienie (grosze) albo null = bez rozkładania. `przedGr` = pełna wartość
 * pozycji z kanału, `sztuk` = ich sztuki oferty. Koszt wysyłki nieznany = null. Towary = kwota − koszt wysyłki: mniej niż
 * pozycje = rabat; więcej o najwyżej pół grosza na sztukę oferty = reszta z zaokrąglenia ceny za sztukę (trafia na
 * pierwszą pozycję); więcej = dopłata (pobranie, opłata), która zostaje w wysyłce. Sufit rabatu sprawdza
 * `zlozPozycjeDokumentu` (`rabatPonadSufit`).
 */
export function towaryPoRabacieGr(w: Pick<WejsciePozycji, 'totalGross' | 'kosztWysylki'>, przedGr: number, sztuk: number): number | null {
  const k = w.kosztWysylki
  if (k === null || k === undefined || !Number.isFinite(k) || k < 0 || przedGr <= 0) return null
  const poGr = Math.round(w.totalGross * 100) - Math.round(k * 100)
  if (poGr === przedGr || poGr <= 0) return null
  if (poGr < przedGr) return poGr
  return resztaZaokraglenGr(przedGr, poGr, sztuk) ? poGr : null
}

/** Wartość pozycji z kanału (bez zamienników) i ich sztuki oferty: podstawa reguły rabatu. */
function podstawaRabatu(pozycje: readonly PozycjaZamowienia[]): { przedGr: number; sztuk: number } {
  let przedGr = 0
  let sztuk = 0
  for (const p of pozycje) {
    if (p.zamiennik !== undefined) continue
    przedGr += wartoscPozycjiGr(p.qty, p.naOferte, p.cenaBruttoGr)
    sztuk += p.qty / (p.naOferte > 0 ? p.naOferte : 1)
  }
  return { przedGr, sztuk }
}

/**
 * czy rabat na całe zamówienie jest liczony dopiero na dokumencie, czyli ceny pozycji
 * w zamówieniu są sprzed rabatu (zamówienie przyjęte albo kanał, który podaje rabat poza pozycjami).
 * Nowe zamówienie Woo ma ceny po rabacie z adaptera: tu widać tylko resztę zaokrągleń, więc false. Rabat ponad sufit
 * też false (to nie rabat, dokument i tak staje). Używa go też faktura paczki dodatkowej (pyta o zamówienie główne).
 */
export function rabatLiczonyNaDokumencie(w: Pick<WejsciePozycji, 'totalGross' | 'kosztWysylki' | 'pozycje' | 'rabatMaksProcent'>): boolean {
  const { przedGr, sztuk } = podstawaRabatu(w.pozycje)
  const poGr = towaryPoRabacieGr(w, przedGr, sztuk)
  return poGr !== null && !resztaZaokraglenGr(przedGr, poGr, sztuk) && rabatPonadProgPewnosci(przedGr, poGr) && rabatWSuficie(przedGr - poGr, przedGr, w.rabatMaksProcent ?? DOMYSLNY_SUFIT_RABATU_PROC)
}

/**
 * runda 3: próg pewności rabatu liczonego na dokumencie, w procentach wartości pozycji.
 * Stop `rabat-niepewny-podzial` (pobranie, paczki dodatkowe) dopiero powyżej reszty zaokrągleń I powyżej tego progu.
 * Rabat programu lojalnościowego to 6–10%; poniżej 1% są grosze: różnica kwoty sklepu bez rabatu albo reszta zaokrągleń
 * zamówienia po rabacie, z którego obsługa usunęła pozycję (kwota spada o cenę z zamówienia, reszta zostaje, a próg
 * reszty liczony z mniejszej liczby sztuk maleje). Takie grosze skalowanie rozkłada bez zmiany sumy.
 */
export const PROG_PEWNOSCI_RABATU_PROC = 1

/** Czy rabat (przed − po) przekracza próg pewności (`PROG_PEWNOSCI_RABATU_PROC` wartości pozycji). */
export const rabatPonadProgPewnosci = (przedGr: number, poGr: number | null): boolean => poGr !== null && (przedGr - poGr) * 100 > przedGr * PROG_PEWNOSCI_RABATU_PROC

/** Linie dokumentu z pozycji zamówienia (czysta funkcja, wspólna dla programów). */
export function zlozPozycjeDokumentu(w: WejsciePozycji): PozycjeDokumentu {
  const problemy: Problem[] = []
  const linie: LiniaDokumentu[] = []
  let reszta = 0 // grosze, których ilość ułamkowa nie pomieściła w cenie; wchłania je wysyłka

  // rabat na całe zamówienie. Jedna reguła (jak BaseLinker): cena za sztukę × po / przed, do grosza, reszta
  // na pierwszej zwykłej pozycji (`korektaGr`). Runda 2: gdy różnica mieści się w reszcie zaokrągleń (ceny już po
  // rabacie z adaptera), cen nie skalujemy drugi raz, tylko dokładamy korektę; rabat ponad sufit nie jest rabatem.
  const zKanalu = (p: PozycjaZamowienia) => p.zamiennik === undefined
  const { przedGr, sztuk } = podstawaRabatu(w.pozycje)
  const towaryGr = towaryPoRabacieGr(w, przedGr, sztuk)
  const sufit = w.rabatMaksProcent ?? DOMYSLNY_SUFIT_RABATU_PROC
  const rabatPonadSufit = towaryGr !== null && towaryGr < przedGr && !rabatWSuficie(przedGr - towaryGr, przedGr, sufit)
  const poGr = rabatPonadSufit ? null : towaryGr
  const skaluj = poGr !== null && !resztaZaokraglenGr(przedGr, poGr, sztuk)
  const ceny = w.pozycje.map((p) => (skaluj ? cenaPoRabacieGr(p.cenaBruttoGr, przedGr, poGr) : p.cenaBruttoGr))
  let korekta: { i: number; gr: number } | null = null
  if (poGr !== null) {
    const poCenachGr = w.pozycje.reduce((s, p, i) => s + (zKanalu(p) ? wartoscPozycjiGr(p.qty, p.naOferte, ceny[i]!) : 0), 0)
    // runda 3: reszta groszy tylko na pozycję płatną; gratis (cena 0 zł) nigdy nie dostaje korekty
    const i = w.pozycje.findIndex((p, j) => zKanalu(p) && ceny[j]! > 0 && !p.bladZamiany && !p.przesuniecie && p.sku !== null && (p.rodzaj === 'STOCKED' || p.rodzaj === 'DIGITAL') && p.qty - p.qtyOdrzucone > 0)
    if (i >= 0 && poGr !== poCenachGr) korekta = { i, gr: poGr - poCenachGr }
  }
  // rabat liczony dopiero tutaj, a podziału nie da się ustalić pewnie (paczki dodatkowe po cenie bez rabatu, pobranie
  // w kwocie zamówienia) albo zamówienie główne paczki dodatkowej ma taki rabat: stop z komunikatem dla biura. Runda 3
  // tylko rabat ponad próg pewności (1% wartości pozycji); mniejsza różnica to grosze (reszta po usunięciu pozycji
  // z zamówienia po rabacie, różnica kwoty sklepu), które skalowanie rozkłada bez zmiany sumy.
  if ((skaluj && rabatPonadProgPewnosci(przedGr, poGr) && (w.paczkiDodatkowe || w.pobranie)) || w.rabatMatkiNaDokumencie) problemy.push({ kategoria: 'INNE', kod: KOD_RABATU_NIEPEWNEGO })
  // rabat (kwota towarów poniżej zera) bez żadnej płatnej pozycji, na którą dałoby się go położyć: problem, nie
  // obniżona wysyłka
  if (przedGr <= 0 && w.kosztWysylki !== null && w.kosztWysylki !== undefined && Number.isFinite(w.kosztWysylki) && Math.round(w.totalGross * 100) < Math.round(w.kosztWysylki * 100))
    problemy.push({ kategoria: 'INNE', kod: KOD_RABATU_BEZ_PLATNEJ, nasze: Math.round(w.kosztWysylki * 100), bl: Math.round(w.totalGross * 100) })

  const dodaj = (p: { sku: string; zestawSku?: string; pozycja: number; sztukOferty: number; nazwa: string; jednostka: 'SZT' | 'KG'; goodId: number | null; qtyBase: number; bruttoGr: number; stawkaVat: string; usluga?: true }) => {
    const ilosc = p.jednostka === 'KG' ? p.qtyBase / 1000 : p.qtyBase
    const r = rozpisz(p.bruttoGr, ilosc)
    reszta += r.resztaGr
    for (const x of r.linie)
      linie.push({
        sku: p.sku,
        ...(p.zestawSku ? { zestawSku: p.zestawSku } : {}),
        pozycja: p.pozycja,
        sztukOferty: p.sztukOferty,
        goodId: p.goodId,
        nazwa: p.nazwa,
        ilosc: x.ilosc,
        jednostka: p.jednostka === 'KG' ? 'kg' : 'szt.',
        cenaBruttoGr: x.cenaGr,
        bruttoGr: x.bruttoGr,
        stawkaVat: p.stawkaVat,
        ...(p.usluga ? { usluga: true as const } : {}),
      })
  }
  const goodIdOf = (sku: string, id: string | null): number | null => {
    const n = id ? Number(id) : Number.NaN
    if (Number.isInteger(n) && n > 0) return n
    if (w.towarBezPowiazania) return 0
    problemy.push({ kategoria: 'BRAK_POWIAZANIA', kod: 'brak-towaru-wfirmy', sku, dotyczyProgramu: 'wfirma' })
    return null
  }
  /** Stawka produktu; brak to problem jawny, a 23% zostaje tylko jako wartość do policzenia sum (jak `buildInvoiceLines`). */
  const stawkaLubProblem = (sku: string, s: string | null): string => {
    if (s === null) problemy.push({ kategoria: 'VAT', kod: 'brak-stawki', sku })
    return stawka(s ?? '23')
  }
  const bezTowaru = (p: PozycjaZamowienia, pozycja: number, sztukOferty: number, qty: number, bruttoGr: number) =>
    linie.push({ sku: p.sku, pozycja, sztukOferty, goodId: null, nazwa: p.nazwa, ilosc: qty, jednostka: 'szt.', cenaBruttoGr: 0, bruttoGr, stawkaVat: stawka(p.stawkaVat ?? '23') })

  let pelneGr = 0 // z pozycjami odrzuconymi: kwota zamówienia je obejmuje, więc wysyłka nie może ich wchłonąć
  // wartość tego, co klient dostaje, liczona WYŁĄCZNIE z pozycji z kanału (pozycja pierwotna, jej cena i przelicznik,
  // jednostki pokryte przez rodzinę zamian); linie dokumentu liczą się osobno z ceny każdej pozycji, więc bezpiecznik
  // łapie też zamiennik z inną ceną (rundy 2: wcześniej cel liczył się z tej samej sumy co linie). Złej ilości
  // zamiennika NIE łapie: `pokryte` liczy się z ilości zamienników, więc cel przesuwa się razem z liniami (za dużo sztuk
  // łapie `wiecej-niz-odrzucono`, za mało nic)
  let dostarczaneGr = 0
  for (const [i, p0] of w.pozycje.entries()) {
    const p = ceny[i] === p0.cenaBruttoGr ? p0 : { ...p0, cenaBruttoGr: ceny[i]! }
    const korektaGr = korekta?.i === i ? korekta.gr : 0
    if (p.zamiennik) problemy.push({ kategoria: 'INNE', kod: `zamiennik-${p.zamiennik}`, sku: p.sku })
    if (p.bladZamiany) problemy.push({ kategoria: 'INNE', kod: `zamiennik-${p.bladZamiany}`, sku: p.sku })
    // zamiennik: sztuki pozycji pierwotnej, już w kwocie zamówienia (pozycja pierwotna liczy je w pełnej wartości)
    if (p.zamiennik === undefined) {
      pelneGr += wartoscPozycjiGr(p.qty, p.naOferte, p.cenaBruttoGr) + korektaGr
      dostarczaneGr += wartoscPozycjiGr(p.pokryte ?? Math.max(0, p.qty - p.qtyOdrzucone), p.naOferte, p.cenaBruttoGr) + korektaGr
    }
    const qty = p.qty - p.qtyOdrzucone
    if (qty <= 0) continue
    const sztuk = qty / p.naOferte
    const brutto = wartoscCzesciGr(qty, p.przesuniecie ?? 0, p.naOferte, p.cenaBruttoGr) + korektaGr
    // rabat nie może zrobić z płatnej pozycji darmowej (ani ujemnej); runda 3: pozycja z korektą groszy
    // niedodatnia = problem bez względu na cenę wejściową
    if (poGr !== null && ((p0.cenaBruttoGr > 0 && (p.cenaBruttoGr <= 0 || brutto <= 0)) || (korektaGr !== 0 && brutto <= 0))) problemy.push({ kategoria: 'INNE', kod: 'cena-zero-po-rabacie', sku: p.sku, nasze: brutto })
    if (p.sku === null || p.rodzaj === null) {
      problemy.push({ kategoria: 'BRAK_POWIAZANIA', kod: 'pozycja-bez-produktu', sku: p.sku })
      bezTowaru(p, i, sztuk, qty, brutto)
      continue
    }
    if (p.rodzaj === 'BUNDLE') {
      const sklad = new Map((p.skladniki ?? []).map((c) => [c.sku, c]))
      let split: SplitLine[]
      try {
        split = splitBundlePrice(p.cenaBruttoGr, (p.skladniki ?? []).map((c) => ({ productId: c.sku, qty: c.qty * p.naOferte, retailGross: c.cenaDetalicznaBrutto, vatRate: c.stawkaVat ?? '23' })))
      } catch {
        problemy.push({ kategoria: 'INNE', kod: 'zestaw-bez-rozbicia', sku: p.sku })
        bezTowaru(p, i, sztuk, qty, brutto)
        continue
      }
      for (const s of split) {
        const c = sklad.get(s.productId)!
        dodaj({ sku: c.sku, zestawSku: p.sku, pozycja: i, sztukOferty: sztuk, nazwa: c.nazwa, jednostka: c.jednostka, goodId: goodIdOf(c.sku, c.wfirmaGoodId), qtyBase: s.qty * sztuk, bruttoGr: s.lineGrossGr * sztuk, stawkaVat: stawkaLubProblem(c.sku, c.stawkaVat) })
      }
      continue
    }
    const usluga = p.rodzaj === 'DIGITAL'
    // usługa bez odpowiednika w wFirmie idzie z nazwy i ceny pozycji (15.1), towar bez powiązania to błąd (tylko wFirma)
    const goodId = usluga && !p.wfirmaGoodId ? 0 : goodIdOf(p.sku, p.wfirmaGoodId)
    dodaj({ sku: p.sku, pozycja: i, sztukOferty: sztuk, nazwa: p.nazwa, jednostka: p.jednostka, goodId, qtyBase: qty, bruttoGr: brutto, stawkaVat: stawkaLubProblem(p.sku, p.stawkaVat), ...(usluga ? { usluga: true as const } : {}) })
  }

  const totalGr = Math.round(w.totalGross * 100)
  const bazaWysylki = totalGr - pelneGr
  // rabat ponad sufit = dotychczasowy błąd (pozycje + koszt wysyłki z kanału są droższe niż kwota zamówienia)
  if (rabatPonadSufit) problemy.push({ kategoria: 'INNE', kod: 'pozycje-drozsze-niz-zamowienie', nasze: pelneGr + Math.round((w.kosztWysylki ?? 0) * 100), bl: totalGr })
  else if (bazaWysylki < 0) problemy.push({ kategoria: 'INNE', kod: 'pozycje-drozsze-niz-zamowienie', nasze: pelneGr, bl: totalGr })
  else if (bazaWysylki > 0 && bazaWysylki + reszta > 0) {
    const wysylkaGr = bazaWysylki + reszta
    linie.push({ sku: null, pozycja: -1, sztukOferty: 1, goodId: 0, nazwa: w.wysylka.nazwa, ilosc: 1, jednostka: 'szt.', cenaBruttoGr: wysylkaGr, bruttoGr: wysylkaGr, stawkaVat: stawka(w.wysylka.stawkaVat), wysylka: true })
  } else if (reszta !== 0) problemy.push({ kategoria: 'ZAOKRAGLENIE', kod: 'reszta-bez-wysylki', nasze: reszta })

  if (!linie.length) problemy.push({ kategoria: 'INNE', kod: 'nic-do-faktury' })
  const bruttoGr = linie.reduce((s, l) => s + l.bruttoGr, 0)
  // bezpiecznik: suma dokumentu = kwota zamówienia bez pozycji odrzuconych (i niezastąpionych), co do grosza
  const celGr = totalGr - (pelneGr - dostarczaneGr)
  if (bruttoGr !== celGr && !problemy.some((p) => p.kategoria === 'ZAOKRAGLENIE' || p.kod === 'pozycje-drozsze-niz-zamowienie')) problemy.push({ kategoria: 'ZAOKRAGLENIE', kod: 'suma-rozna-od-zamowienia', nasze: bruttoGr, bl: celGr })
  return { linie, problemy, bruttoGr, nettoGr: nettoGr(linie) }
}

/**
 * komunikat dla biura, gdy dokument staje na zamienniku (kod `zamiennik-*`). Runda 2: faktura powstaje
 * po spakowaniu, a wtedy pozycji nie da się już zmienić (`powodBlokadyEdycji`), więc „Ponów fakturę” skończy się tym
 * samym błędem. Droga sprawdzona w kodzie: karta zamówienia „Spakowane” → przycisk „Wyślij bez faktury”
 * (lib/praca/przejscia-ekran.ts, `shipWithoutInvoice`), faktura ręcznie w programie, potem sekcja „Dokument sprzedaży”
 * → „Dokument wystawiony” (app/(panel)/zamowienia/[id]/faktura.tsx, `potwierdzDokumentWystawiony`).
 */
export const KOMUNIKAT_ZAMIENNIKA =
  'Zamówienie ma pozycję wymienioną przyciskiem „Zamień produkt”, a Kompletor nie umie ustalić, ile klient za nią zapłacił (wymienionej pozycji nie ma już w zamówieniu, zamiennik ma inną cenę albo został usunięty, albo wymieniono więcej sztuk, niż brakowało). Faktura nie została wystawiona i „Ponów fakturę” tego nie zmieni. Wystaw fakturę ręcznie w programie do faktur na kwotę, którą zapłacił klient. Potem na karcie zamówienia (Zamówienia → to zamówienie) kliknij „Wyślij bez faktury”, a w sekcji „Dokument sprzedaży” kliknij „Dokument wystawiony”.'

/** kod problemu „rabat liczony na dokumencie, podziału nie da się ustalić pewnie”. */
export const KOD_RABATU_NIEPEWNEGO = 'rabat-niepewny-podzial'

/** runda 3: rabat na całe zamówienie bez żadnej płatnej pozycji (same gratisy za 0 zł). */
export const KOD_RABATU_BEZ_PLATNEJ = 'rabat-bez-platnej-pozycji'

/**
 * komunikat dla biura przy `rabat-bez-platnej-pozycji` (wcześniej
 * ścieżka wFirmy pokazywała sam kod). Ta sama droga ręczna co przy rabacie niepewnym.
 */
export const KOMUNIKAT_RABATU_BEZ_PLATNEJ =
  'Rabat na całe zamówienie, a w zamówieniu nie ma płatnej pozycji, na którą dałoby się go rozłożyć (same gratisy za 0 zł). Faktura nie została wystawiona, a „Ponów fakturę” tego nie zmieni. Wystaw fakturę ręcznie w programie do faktur na kwotę, którą zapłacił klient. Potem na karcie zamówienia (Zamówienia → to zamówienie) kliknij „Wyślij bez faktury”, a w sekcji „Dokument sprzedaży” kliknij „Dokument wystawiony”.'

/**
 * komunikat dla biura przy `rabat-niepewny-podzial`. Ta sama droga ręczna co przy zamienniku
 * (sprawdzona w kodzie, `KOMUNIKAT_ZAMIENNIKA`): faktura ręcznie, „Wyślij bez faktury”, „Dokument wystawiony”.
 */
export const KOMUNIKAT_RABATU =
  'Zamówienie ma rabat na całe zamówienie (np. program lojalnościowy sklepu), a ceny pozycji w Kompletorze są sprzed rabatu. Przy pobraniu albo przy paczce wysłanej osobno Kompletor nie umie pewnie podzielić kwoty między towar, wysyłkę i paczki, więc faktura nie została wystawiona, a „Ponów fakturę” tego nie zmieni. Wystaw fakturę ręcznie w programie do faktur na kwotę, którą zapłacił klient (przy paczkach osobno: jedna faktura na całe zamówienie albo podział zgodny z zapłatą). Potem na karcie zamówienia (Zamówienia → to zamówienie) kliknij „Wyślij bez faktury”, a w sekcji „Dokument sprzedaży” kliknij „Dokument wystawiony”.'

/** Komunikat zamiennika, gdy wśród problemów jest kod `zamiennik-*`; null = brak takiego problemu. */
export const komunikatZamiennika = (problemy: readonly Problem[]): string | null => (problemy.some((p) => p.kod.startsWith('zamiennik-')) ? KOMUNIKAT_ZAMIENNIKA : null)

/** Komunikat dla biura, gdy dokument staje na problemie z gotową drogą ręczną (zamiennik, rabat niepewny); inaczej null. */
export const komunikatDokumentu = (problemy: readonly Problem[]): string | null =>
  komunikatZamiennika(problemy) ?? (problemy.some((p) => p.kod === KOD_RABATU_NIEPEWNEGO) ? KOMUNIKAT_RABATU : problemy.some((p) => p.kod === KOD_RABATU_BEZ_PLATNEJ) ? KOMUNIKAT_RABATU_BEZ_PLATNEJ : null)

/** Problemy, które dotyczą danego programu (bez pola = każdego). */
export function problemyProgramu(problemy: readonly Problem[], program: ProgramDokumentow): Problem[] {
  return problemy.filter((p) => !p.dotyczyProgramu || p.dotyczyProgramu === program)
}

// ─── Wejście z bazy ───────────────────────────────────────────────────────────

export type OrderRow = Prisma.OrderGetPayload<{ include: { lines: true } }>
export type ProductRow = Product & { bundleComponents: { componentId: string; qtyBase: number }[] }

const gr = (v: Prisma.Decimal | number) => Math.round(Number(v) * 100)

/**
 * Kwota faktury paczki dodatkowej. Podzamówienie z podziału albo „dośle później” ma
 * `totalGross` 0 (pieniądze i wysyłka zostają na paczce 1, której faktura liczy pozycję matki bez sztuk przeniesionych),
 * więc kwotą jest suma pozycji tej paczki liczona tak samo jak w `zlozFakture` (`pelneGr`): bez wysyłki, bez zamienników
 * (ich sztuki są już w pozycji pierwotnej).
 */
export function kwotaPaczkiDodatkowej(pozycje: { qty: number; naOferte: number; cenaBruttoGr: number; zamiennik?: unknown }[]): number {
  return pozycje.reduce((s, p) => s + (p.zamiennik === undefined ? wartoscPozycjiGr(p.qty, p.naOferte, p.cenaBruttoGr) : 0), 0) / 100
}

/**
 * koszt wysyłki z kanału do `WejsciePozycji.kosztWysylki` (zł). Paczka dodatkowa (`parentOrderId`) = null:
 * wysyłka jest na fakturze pierwszej paczki, a jej kwota to suma jej pozycji.
 */
export function kosztWysylkiZamowienia(o: { parentOrderId: string | null; shippingCostGross: Prisma.Decimal | number | null }): number | null {
  return o.parentOrderId || o.shippingCostGross === null ? null : Number(o.shippingCostGross)
}
/** Klucz mapy ofert `pozycjeZamowienia`: kanał | konto | id oferty → qtyBasePerOffer. */
export const kluczOferty = (channel: string, konto: string, oferta: string) => `${channel}|${konto}|${oferta}`

/**
 * Pozycje zamówienia z wierszy bazy: pozycje usunięte pominięte, nazwa księgowa produktu, stawka z pozycji albo produktu,
 * składniki zestawu z mapy `products` (musi zawierać też składniki). `offers`: klucz `kluczOferty` → qtyBasePerOffer.
 */
export function pozycjeZamowienia(o: OrderRow, products: Map<string, ProductRow>, offers: Map<string, number>): PozycjaZamowienia[] {
  const out: PozycjaZamowienia[] = []
  // OrderLine.offerId = id oferty w kanale. Bez produktu (oferta nieaktywna albo nieznana) ingest zostawił qty w sztukach kanału.
  // Zamiennik (bez oferty) dostaje przelicznik pozycji pierwotnej.
  const prz = przelicznikiPozycji(o.lines, (offerId) => offers.get(kluczOferty(o.channel, o.channelAccountId, offerId)))
  const rodzina = (id: string) => ({
    ...(prz.przesuniecie.get(id) ? { przesuniecie: prz.przesuniecie.get(id)! } : {}),
    ...(prz.pokryte.has(id) ? { pokryte: prz.pokryte.get(id)! } : {}),
    ...(prz.bledyPierwotnych.has(id) ? { bladZamiany: prz.bledyPierwotnych.get(id)! } : {}),
  })
  for (const l of o.lines) {
    if (l.removed) continue
    const p = l.productId ? products.get(l.productId) : undefined
    const naOferte = prz.naOferte.get(l.id) ?? 1
    const wspolne = { qty: l.qty, qtyOdrzucone: l.qtyRejected, naOferte, cenaBruttoGr: gr(l.unitPriceGross), ...(prz.zamienniki.has(l.id) ? { zamiennik: prz.zamienniki.get(l.id)! } : {}), ...rodzina(l.id) }
    if (!p) {
      out.push({ ...wspolne, sku: null, rodzaj: null, nazwa: 'Pozycja bez produktu', jednostka: 'SZT', wfirmaGoodId: null, stawkaVat: l.vatRate })
      continue
    }
    out.push({
      ...wspolne,
      sku: p.sku,
      rodzaj: p.kind,
      nazwa: p.nameAccounting,
      jednostka: p.unit,
      wfirmaGoodId: p.wfirmaGoodId,
      stawkaVat: l.vatRate ?? p.vatRate,
      ...(p.kind === 'BUNDLE'
        ? {
            skladniki: p.bundleComponents.flatMap((c) => {
              const s = products.get(c.componentId)
              return s ? [{ sku: s.sku, nazwa: s.nameAccounting, jednostka: s.unit, wfirmaGoodId: s.wfirmaGoodId, qty: c.qtyBase, cenaDetalicznaBrutto: Number(s.priceGross ?? 1), stawkaVat: s.vatRate }] : []
            }),
          }
        : {}),
    })
  }
  return out
}
