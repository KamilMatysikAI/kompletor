// Rozpoznanie kodu z czytnika albo wklejonego tekstu — czyste funkcje, testy w kod-tekst.test.ts.
// Z tekstu powstają kandydaci: kod karty zamówienia (lib/stanowisko/kod.ts), kod koszyka (lib/koszyki/kod.ts), numer
// zamówienia (z przedrostkiem konta albo bez) i numer nadania przesyłki. Bazę pyta lib/stanowisko/rozpoznaj-kod.ts.
//
// Dwa tryby:
//  - `kod`: cały tekst to jeden kod (skan czytnikiem, Enter w polu szukania, krótkie wklejenie). Toleruje otoczkę
//    z maila i tytułu przelewu: „#”, „zamówienie nr”, „nr”, spacje, końcową kropkę.
//  - `tekst`: dłuższy wklejony tekst (np. cały tytuł przelewu): numery z treści tylko z kontekstem (przedrostek konta,
//    „zamówienie”, „nr”, „#” tuż przed liczbą), kod karty, numer nadania; zamówienie otwiera się
//    tylko wtedy, gdy wszystkie razem wskazują dokładnie jedno (pilnuje tego rozpoznaj-kod.ts).
import { odczytajKodKoszyka } from '@/lib/koszyki/kod'
import { odczytajSkan, type SkanKarty } from './kod'

/** Numer zamówienia do sprawdzenia: `przedrostek` (litery A–Z, np. „SD”) albo null, `numer` jak w kanale. */
export interface KandydatNumeru {
  przedrostek: string | null
  numer: string
}

export interface KandydaciKodu {
  karta: SkanKarty | null
  koszyk: string | null
  numery: KandydatNumeru[]
  /** Numery nadania do dokładnego porównania. */
  przesylki: string[]
  /**
   * Fragmenty dłuższego kodu z etykiety (kod przewoźnika z dodatkami, np. kod pocztowy i usługa przed i po numerze
   * listu): porównywane dokładnie z zapisanymi numerami nadania, wygrywa najdłuższe trafienie.
   */
  fragmentyPrzesylki: string[]
}

export const MAX_TEKSTU = 500
const MAX_KODU = 128
/** Najkrótszy numer nadania szukany jako fragment dłuższego kodu z etykiety. */
export const MIN_FRAGMENTU = 10
const MAX_DLUGOSC_CIAGU_FRAGMENTOW = 48
const MAX_FRAGMENTOW = 1200
const MAX_KANDYDATOW = 20

/** Słowa przed numerem, które nie są przedrostkiem konta („NR 48213”, „ZAM 48213”). */
const NIE_PRZEDROSTEK = new Set(['NR', 'NUMER', 'ZAM', 'NO', 'ID'])

const pusty = (): KandydaciKodu => ({ karta: null, koszyk: null, numery: [], przesylki: [], fragmentyPrzesylki: [] })

/** Znaki sterujące, zero-width i identyfikator AIM czytnika („]C1”) precz, spacje nierozdzielające jako zwykłe. */
export function oczyscTekst(tekst: string): string {
  return tekst
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‍⁠﻿]/g, '')
    .replace(/[\t\r\n]+/g, ' ')
    .trim()
    .replace(/^\]C\d/i, '')
    .trim()
}

/** Otoczka typowa dla maila i tytułu przelewu: „Zamówienie nr #SD 48213.” → „SD 48213”. */
export function bezOtoczki(tekst: string): string {
  let t = oczyscTekst(tekst)
  for (let i = 0; i < 3; i++) {
    const przed = t
    t = t
      .replace(/^(?:zam(?:ó|o)wieni(?:e|a|u)|zam\.?)(?=[\s#:.]|nr|$)\s*/iu, '')
      .replace(/^(?:nr|numer|no)\.?(?=[\s#:]|\d|$)\s*/iu, '')
      .replace(/^[#:]\s*/u, '')
      .replace(/[\s.,;:!?)]+$/u, '')
      .trim()
    if (t === przed) break
  }
  return t
}

/** Przedrostek do porównania z przedrostkiem konta: wielkie litery A–Z, polskie znaki bez ogonków („RĘ” → „RE”). */
export function przedrostekPorownania(p: string): string {
  return p
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/gi, 'L')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
}

function dodajNumer(k: KandydaciKodu, przedrostek: string | null, numer: string) {
  const p = przedrostek ? przedrostekPorownania(przedrostek) : null
  const pp = p && !NIE_PRZEDROSTEK.has(p) ? p : null
  if (k.numery.length >= MAX_KANDYDATOW || k.numery.some((n) => n.numer === numer && n.przedrostek === pp)) return
  k.numery.push({ przedrostek: pp, numer })
}

function dodajPrzesylke(k: KandydaciKodu, numer: string) {
  const n = numer.toUpperCase()
  if (k.przesylki.length < MAX_KANDYDATOW * 2 && !k.przesylki.includes(n)) k.przesylki.push(n)
}

/** Słowo tuż przed numerem w dłuższym tekście, które czyni z liczby numer zamówienia („zamówienie nr #48213”). */
const SLOWO_PRZED_NUMEREM = /(?:(?<![\p{L}\d])(?:zam\p{L}*|nr|numer)\.?|#)[\s:#.]*$/iu

/** Ciąg liter i cyfr z co najmniej jedną cyfrą: może być numerem nadania (InPost 24 cyfry, DPD 13 cyfr i litera). */
const NUMER_NADANIA = /^(?=[A-Z0-9]*\d)[A-Z0-9]{8,40}$/i

/** Kandydaci z jednego kodu (tryb `kod`). */
function zKodu(tekst: string): KandydaciKodu {
  const k = pusty()
  const czysty = oczyscTekst(tekst)
  if (!czysty || czysty.length > MAX_KODU * 2) return k
  // karta i koszyk mają własne, ścisłe wzory (karta zawsze z „/<numer wydruku>”, koszyk „KOSZ-…”): rozstrzygają od razu.
  // najpierw z tekstu PRZED zdjęciem otoczki, bo przedrostek konta „NR” albo „NO” (inicjały sklepu)
  // wygląda jak słowo „nr”. Tekst bez otoczki wygrywa tylko wtedy, gdy otoczkę oddziela spacja, „#” albo „:”
  // („nr SD48213/1”, „Zamówienie: SD48213/1”), bo kod z czytnika takich znaków nie ma.
  const t = bezOtoczki(czysty)
  const zCalego = odczytajSkan(czysty)
  const bezOtoczkiKarta = t && t !== czysty ? odczytajSkan(t) : null
  k.karta = (bezOtoczkiKarta && /[\s#:]/.test(czysty) ? bezOtoczkiKarta : null) ?? zCalego ?? bezOtoczkiKarta
  if (k.karta) return k
  k.koszyk = odczytajKodKoszyka(czysty) ?? (t ? odczytajKodKoszyka(t) : null)
  if (k.koszyk) return k
  if (!t || t.length > MAX_KODU) return k
  const zwarty = t.replace(/\s+/g, '')
  // numer zamówienia z przedrostkiem konta albo bez: „SD 48213”, „SD48213”, „48213”, dosyłka „SD 48213-2”
  const m = /^(\p{L}{1,4})?(\d{1,18}(?:-\d{1,3})?)$/u.exec(zwarty)
  if (m) {
    dodajNumer(k, m[1] ?? null, m[2]!)
  } else if (/^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/.test(zwarty)) {
    // identyfikator z kanału bez samych cyfr (Allegro: UUID, Empik z sufiksem): tylko dokładnie
    dodajNumer(k, null, zwarty)
    if (zwarty.toLowerCase() !== zwarty) dodajNumer(k, null, zwarty.toLowerCase())
  }
  if (NUMER_NADANIA.test(zwarty)) dodajPrzesylke(k, zwarty)
  // kod z etykiety z dodatkami albo adres śledzenia z kodu QR: ciągi liter i cyfr dokładnie, a krótsze także fragmentami
  const ciagi = zwarty.split(/[^A-Za-z0-9]+/).filter((c) => c.length >= MIN_FRAGMENTU && /\d/.test(c))
  for (const c of ciagi) {
    if (c !== zwarty) dodajPrzesylke(k, c)
    if (c.length <= MIN_FRAGMENTU || c.length > MAX_DLUGOSC_CIAGU_FRAGMENTOW) continue
    const C = c.toUpperCase()
    for (let dl = c.length - 1; dl >= MIN_FRAGMENTU && k.fragmentyPrzesylki.length < MAX_FRAGMENTOW; dl--) {
      for (let i = 0; i + dl <= C.length && k.fragmentyPrzesylki.length < MAX_FRAGMENTOW; i++) {
        const f = C.slice(i, i + dl)
        if (/\d/.test(f) && !k.fragmentyPrzesylki.includes(f)) k.fragmentyPrzesylki.push(f)
      }
    }
  }
  return k
}

/** Kandydaci z dłuższego tekstu (tryb `tekst`): karty, UUID, numery z przedrostkiem albo bez, numery nadania. */
function zTekstu(tekst: string): KandydaciKodu {
  const k = pusty()
  const t = oczyscTekst(tekst).slice(0, MAX_TEKSTU)
  for (const m of t.matchAll(/(?<![\p{L}\d])\p{L}{1,4}\d{1,18}(?:-\d{1,3})?\/\d{1,7}(?![\d/])/gu)) {
    const karta = odczytajSkan(m[0])
    if (karta && !k.karta) k.karta = karta
  }
  for (const m of t.matchAll(/(?<![\p{L}\d-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\p{L}\d-])/giu)) dodajNumer(k, null, m[0].toLowerCase())
  // numer zamówienia: co najmniej 5 cyfr (krótsze w tytule przelewu to zwykle kwota albo data), nie część kwoty „1234,50”.
  // w dłuższym tekście liczy się tylko numer z kontekstem: przedrostek konta („SD 48213”) albo słowo
  // „zam…”, „zamówienie”, „nr”, „numer”, „#” tuż przed liczbą. Gołe liczby („Faktura 45210”) zostają do filtrowania.
  for (const m of t.matchAll(/(?<![\p{L}\d])(?:(\p{L}{1,4})\s?)?(\d{5,18}(?:-\d{1,3})?)(?![\p{L}\d]|[.,]\d)/gu)) {
    // przedrostek liczy się tylko pisany wielkimi literami, jak na liście („SD 48213”); „nr”, „dla” to zwykłe słowa
    const p = m[1] && m[1] === m[1].toUpperCase() && !NIE_PRZEDROSTEK.has(przedrostekPorownania(m[1])) ? m[1] : null
    const przed = t.slice(0, m.index + m[0].length - m[2]!.length)
    if (p || SLOWO_PRZED_NUMEREM.test(przed)) dodajNumer(k, p, m[2]!)
  }
  // numer w kanale z literami albo myślnikiem („WZ-2026-77”): całe słowo z cyfrą i literą/myślnikiem, tylko dokładnie
  for (const slowo of t.split(/\s+/)) {
    const s = slowo.replace(/^[#(„"']+|[.,;:!?)”"']+$/gu, '')
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/.test(s) && /\d/.test(s) && /[A-Za-z-]/.test(s) && !/^\d{1,4}-\d{1,2}-\d{1,4}$/.test(s)) dodajNumer(k, null, s)
  }
  for (const m of t.matchAll(/(?<![A-Za-z0-9])[A-Za-z0-9]{10,40}(?![A-Za-z0-9])/g)) if (/\d/.test(m[0])) dodajPrzesylke(k, m[0])
  return k
}

export function kandydaciKodu(tekst: unknown, tryb: 'kod' | 'tekst'): KandydaciKodu {
  if (typeof tekst !== 'string' || tekst.length > MAX_TEKSTU * 4) return pusty()
  return tryb === 'kod' ? zKodu(tekst) : zTekstu(tekst)
}

/** Wklejony tekst: krótki (jedno słowo, numer z otoczką) jak kod, dłuższy jak treść maila albo tytuł przelewu. */
export function trybWklejenia(tekst: string): 'kod' | 'tekst' {
  const t = bezOtoczki(tekst)
  return t.length <= 64 && t.split(/\s+/).length <= 2 ? 'kod' : 'tekst'
}

/**
 * Pole „Szukaj”: goły numer bez przedrostka konta krótszy niż 5 cyfr („1234”, „nr 12”) to częściej
 * fragment numeru albo SKU niż cały numer zamówienia, więc filtruje listę zamiast otwierać kartę.
 */
export function krotkiGolyNumer(fraza: string): boolean {
  return /^\d{1,4}(?:-\d{1,3})?$/.test(bezOtoczki(fraza).replace(/\s+/g, ''))
}
