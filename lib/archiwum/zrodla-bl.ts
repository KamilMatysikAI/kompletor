// etap 3: plik źródeł zamówień BL (z eksportu archiwum BL) dla importu faktur BL.
//
// Faktura BL ma `order_id` = numer zamówienia w BL, a eksport archiwum BL podaje przy tym numerze nazwę konta źródła
// („pochodzenie”). Z tym plikiem kanał faktury jest znany dokładnie, bez parowania po kwocie i dacie.
//
// Plik: CSV ze średnikiem w UTF-8, nagłówek z kolumnami wyłącznie z `KOLUMNY_ZRODEL_BL` (wymagane `order_id`
// i `pochodzenie`). Kolumna spoza listy (np. nazwisko, telefon, e-mail z surowego eksportu) = błąd całego pliku: plik
// trzeba najpierw przyciąć, żeby dane klientów nie trafiały do Kompletora nawet przejściowo. Nazwy kont źródeł nie są
// zaszyte w kodzie: przypisanie nazwa → kanał przychodzi w wywołaniu (`--mapa-zrodel "nazwa=ALLEGRO;nazwa 2=WOO"`).
// Cel mapy to kanał z importem archiwum albo `POMIN` (świadome pominięcie, np. sprzedaż ręczna). Nazwa występująca
// w pliku, a nieobecna w mapie, nie dostaje kanału (`spozaMapy`): wywołujący zatrzymuje przebieg przed zapisem.
// Kolumny `status`, `data` i `waluta` są tolerowane; walutę bierze się z faktury, plik służy tylko do wykrycia sprzeczności.
import type { Channel } from '@prisma/client'

export const KOLUMNY_ZRODEL_BL = ['order_id', 'pochodzenie', 'status', 'data', 'waluta'] as const
/** cel mapy: świadome pominięcie faktur tego źródła (np. sprzedaż ręczna bez archiwum w Kompletorze) */
export const POMIN = 'POMIN'
export type KanalZrodlaBl = Channel | typeof POMIN

const ZNAK_ZASTEPCZY = '�'
const BLAD_KODOWANIA = 'nie jest w UTF-8 (znak zastępczy U+FFFD, np. eksport z Excela w Windows-1250): zapisz plik jako „CSV UTF-8” i podaj ponownie'

/** Porównywanie nazw źródeł: NFC, bez spacji na brzegach, spacje zwinięte, bez rozróżniania wielkości liter. */
export function normalizujNazweZrodla(s: string): string {
  return s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Bajty pliku → tekst; niepoprawny UTF-8 = błąd (zamiast cichej zamiany znaków, przez którą nazwy nie pasują do mapy). */
export function tekstZrodelBl(bajty: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bajty)
  } catch {
    throw new Error(`plik źródeł BL ${BLAD_KODOWANIA}`)
  }
}

export interface OpcjeMapyZrodel {
  /** kanał importowanego konta: mapa musi mieć co najmniej jeden wpis z tym kanałem */
  kanalKonta: Channel
  /** kanały z importem archiwum w Kompletorze (lista kanałów `npm run cien -- archiwum --kanal`) */
  kanalyArchiwum: readonly Channel[]
}

/**
 * `"nazwa=KANAŁ;nazwa 2=POMIN"` → mapa znormalizowana nazwa źródła → kanał albo `POMIN`. Błąd: pusta mapa, wpis bez
 * nazwy, nazwa podana dwa razy (po normalizacji), kanał bez importu archiwum (trzeba `POMIN` albo kanał z archiwum),
 * brak wpisu z kanałem importowanego konta.
 */
export function parsujMapeZrodel(s: string, o: OpcjeMapyZrodel): Map<string, KanalZrodlaBl> {
  if (s.includes(ZNAK_ZASTEPCZY)) throw new Error('--mapa-zrodel: znak zastępczy U+FFFD (zepsute polskie znaki w wywołaniu): popraw kodowanie terminala albo wywołania')
  const dozwolone: readonly string[] = [...o.kanalyArchiwum, POMIN]
  const out = new Map<string, KanalZrodlaBl>()
  for (const cz of s.split(';')) {
    if (!cz.trim()) continue
    const i = cz.lastIndexOf('=')
    const nazwa = i > 0 ? normalizujNazweZrodla(cz.slice(0, i)) : ''
    const kanal = i > 0 ? cz.slice(i + 1).trim().toUpperCase() : ''
    if (!nazwa || nazwa.length > 200) throw new Error(`--mapa-zrodel: wpis „${cz.trim().slice(0, 60)}” bez nazwy źródła (format: nazwa=KANAŁ;…)`)
    if (!dozwolone.includes(kanal)) throw new Error(`--mapa-zrodel: „${kanal.slice(0, 30)}” nie ma importu archiwum w Kompletorze; dozwolone: ${dozwolone.join(', ')} (${POMIN} = świadome pominięcie źródła, np. sprzedaży ręcznej)`)
    if (out.has(nazwa)) throw new Error(`--mapa-zrodel: źródło „${nazwa.slice(0, 60)}” podane dwa razy`)
    out.set(nazwa, kanal as KanalZrodlaBl)
  }
  if (!out.size) throw new Error('--mapa-zrodel: pusta mapa (format: nazwa=KANAŁ;…)')
  if (![...out.values()].includes(o.kanalKonta)) throw new Error(`--mapa-zrodel: brak wpisu z kanałem importowanego konta (${o.kanalKonta}): bez niego żadna faktura nie dostanie kanału z pliku`)
  return out
}

/** Jeden wiersz CSV ze średnikiem; pola w cudzysłowach mogą zawierać średnik i podwojony cudzysłów. */
function polaWiersza(l: string): string[] {
  const out: string[] = []
  let cur = ''
  let wCudz = false
  for (let i = 0; i < l.length; i++) {
    const c = l[i]!
    if (wCudz) {
      if (c === '"' && l[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') wCudz = false
      else cur += c
    } else if (c === '"') wCudz = true
    else if (c === ';') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map((x) => x.trim())
}

export interface ZrodlaBl {
  /** order_id zamówienia BL → kanał albo `POMIN` (tylko nazwy z mapy) */
  kanal: Map<number, KanalZrodlaBl>
  /** order_id → waluta z pliku (wielkimi literami; tylko gdy kolumna jest i pole niepuste) */
  waluta: Map<number, string>
  /** nazwy źródeł spoza mapy (pierwsza pisownia z pliku, do 60 znaków; wyglądająca na dane osobowe = opis z numerem wiersza) → order_id tych zamówień */
  spozaMapy: Map<string, number[]>
  wierszy: number
}

/**
 * Nazwa spoza mapy, która wygląda na dane osobowe (przegląd r2 W-B: e-mail, telefon albo długi tekst z przesuniętej
 * kolumny), nie trafia do komunikatu: zamiast niej opis z numerem wiersza.
 */
export const wygladaNaDaneOsobowe = (s: string): boolean => s.includes('@') || /\d{7,}/.test(s.replace(/[\s-]/g, '')) || s.length > 40
const opisDanychOsobowych = (wiersz: number) => `(nazwa wygląda na dane osobowe: wiersz ${wiersz} pliku źródeł)`

/** Nazwa kolumny do komunikatu: tylko proste nazwy, reszta (np. wartość danych z pliku bez nagłówka) bez treści. */
const nazwaKolumnyDoKomunikatu = (k: string) => (k === '' ? '(pusta nazwa)' : /^[a-z_]{1,30}$/.test(k) ? k : '(nieczytelna nazwa)')

/** Plik źródeł → kanał per `order_id`. Błąd formatu (nagłówek, kolumna spoza listy, kodowanie, zły numer, sprzeczny dubel) = błąd całego pliku. */
export function zrodlaBlZCsv(tekst: string, mapa: ReadonlyMap<string, KanalZrodlaBl>): ZrodlaBl {
  const linie = tekst.replace(/^﻿/, '').split(/\r?\n/)
  const nag = polaWiersza(linie[0] ?? '').map((k) => k.toLowerCase())
  while (nag.length > 1 && nag[nag.length - 1] === '') nag.pop() // końcowy średnik nagłówka (Excel)
  const iId = nag.indexOf('order_id')
  const iPoch = nag.indexOf('pochodzenie')
  // bez wartości z pierwszego wiersza w komunikacie: plik bez nagłówka ma tam dane (możliwe dane osobowe)
  if (iId < 0 || iPoch < 0) throw new Error(`plik źródeł BL: pierwszy wiersz musi być nagłówkiem z wymaganymi kolumnami order_id i pochodzenie (kolumn w pierwszym wierszu: ${nag.length}); dozwolone: ${KOLUMNY_ZRODEL_BL.join(';')}`)
  const obce = nag.filter((k) => !(KOLUMNY_ZRODEL_BL as readonly string[]).includes(k))
  if (obce.length) throw new Error(`plik źródeł BL: kolumny spoza listy (${[...new Set(obce.map(nazwaKolumnyDoKomunikatu))].join(', ')}); dozwolone: ${KOLUMNY_ZRODEL_BL.join(';')} — przytnij plik`)
  const iWal = nag.indexOf('waluta')
  const kanal = new Map<number, KanalZrodlaBl>()
  const waluta = new Map<number, string>()
  const nazwaId = new Map<number, string>()
  const spozaMapy = new Map<string, number[]>()
  const pisownia = new Map<string, string>() // znormalizowana nazwa spoza mapy → pierwsza pisownia z pliku
  let wierszy = 0
  for (let n = 1; n < linie.length; n++) {
    if (!linie[n]!.trim()) continue
    const p = polaWiersza(linie[n]!)
    // przegląd r2 W-B: inna liczba pól niż w nagłówku (po odcięciu końcowych pustych pól, np. średnik z Excela) =
    // przesunięte kolumny, w których pochodzeniem mogłoby być pole z danymi klienta; w komunikacie tylko liczby
    while (p.length > nag.length && p[p.length - 1] === '') p.pop()
    if (p.length !== nag.length) throw new Error(`plik źródeł BL: wiersz ${n + 1}: pól ${p.length}, w nagłówku ${nag.length} (przesunięte kolumny?); popraw plik, nic nie zapisano ani nie usunięto`)
    const id = Number(p[iId])
    if (!/^\d{1,15}$/.test(p[iId] ?? '') || !Number.isSafeInteger(id) || id <= 0) throw new Error(`plik źródeł BL: wiersz ${n + 1}: order_id nie jest liczbą`)
    const surowa = p[iPoch] ?? ''
    if (surowa.includes(ZNAK_ZASTEPCZY)) throw new Error(`plik źródeł BL: wiersz ${n + 1}: nazwa źródła ${BLAD_KODOWANIA}`)
    const nazwa = normalizujNazweZrodla(surowa)
    if (!nazwa) throw new Error(`plik źródeł BL: wiersz ${n + 1}: puste pochodzenie`)
    const bylo = nazwaId.get(id)
    if (bylo !== undefined) {
      if (bylo !== nazwa) throw new Error(`plik źródeł BL: zamówienie ${id} z dwoma różnymi źródłami`)
      continue
    }
    wierszy++
    nazwaId.set(id, nazwa)
    const w = iWal >= 0 ? (p[iWal] ?? '').toUpperCase() : ''
    if (w) waluta.set(id, w)
    const k = mapa.get(nazwa)
    if (k) kanal.set(id, k)
    else {
      if (!pisownia.has(nazwa)) pisownia.set(nazwa, wygladaNaDaneOsobowe(surowa) ? opisDanychOsobowych(n + 1) : surowa.slice(0, 60))
      const klucz = pisownia.get(nazwa)!
      spozaMapy.set(klucz, [...(spozaMapy.get(klucz) ?? []), id])
    }
  }
  return { kanal, waluta, spozaMapy, wierszy }
}

/**
 * Błąd przebiegu, gdy w pliku są nazwy źródeł spoza mapy (null = brak): lista nazw z liczbą zamówień w pliku źródeł
 * i faktur w pliku faktur (`orderIdFaktur` = order_id faktur normalnych z całego pliku). Same nazwy kont, bez innych pól.
 */
export function bladSpozaMapy(z: ZrodlaBl, orderIdFaktur: Iterable<number>): string | null {
  if (!z.spozaMapy.size) return null
  const fakt = new Map<number, number>()
  for (const id of orderIdFaktur) fakt.set(id, (fakt.get(id) ?? 0) + 1)
  const opis = [...z.spozaMapy]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    // obrona w głąb (przegląd r2 W-B): klucz z danymi osobowymi nie przechodzi, nawet gdy `ZrodlaBl` zbudowano inaczej
    .map(([n, ids]) => `„${n.startsWith('(nazwa wygląda na dane osobowe') || !wygladaNaDaneOsobowe(n) ? n : '(nazwa wygląda na dane osobowe)'}” (zamówień ${ids.length}, faktur ${ids.reduce((s, id) => s + (fakt.get(id) ?? 0), 0)})`)
  return `plik źródeł BL: źródła spoza --mapa-zrodel: ${opis.join(', ')}; dopisz je do mapy (kanał z archiwum albo ${POMIN}) — nic nie zapisano ani nie usunięto`
}
