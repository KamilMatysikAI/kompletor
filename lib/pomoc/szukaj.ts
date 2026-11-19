// Wyszukiwarka Pomocy: szuka po tytułach, opisach, nagłówkach i treści dokumentów z listy Pomocy
// (`listDocs`), bez zewnętrznych usług i bez indeksu na dysku. Dokumentów jest kilkadziesiąt, więc każde zapytanie
// czyta pliki od nowa (kilkadziesiąt milisekund przy ok. 40 dokumentach) i nie ma pamięci podręcznej do unieważniania.
//
// Z tej samej funkcji korzysta asystent AI w panelu: `szukajWPomocy` daje najlepsze sekcje z adresem
// `/pomoc/<slug>#<kotwica>`, a `sekcjeDokumentu` daje czysty tekst sekcji (bez markdownu) do odpowiedzi asystenta.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { anchorOf, DOCS_DIR, dozwolony, listDocs, type DocEntry } from './dokumenty'
import { rolaDokumentu, type RolaPomocy } from './role'

/**
 * Normalizacja do porównań: małe litery, bez polskich znaków. Znak po znaku, więc długość tekstu się nie zmienia
 * i pozycja trafienia w tekście znormalizowanym jest pozycją w oryginale (podświetlenie fragmentu).
 */
export function normalizuj(tekst: string): string {
  let out = ''
  for (const c of tekst) {
    if (c.length !== 1) {
      out += ' '.repeat(c.length) // znak spoza BMP (np. emoji): zachowaj długość
      continue
    }
    const l = c.toLowerCase()
    const z = l === 'ł' ? 'l' : l.normalize('NFD').replace(/[̀-ͯ]/g, '')
    out += z.length === 1 ? z : l.length === 1 ? l : c
  }
  return out
}

/** Markdown jednej linii → zwykły tekst (linki i obrazki jako opis, bez znaczników, bez pionowych kresek tabel). */
export function bezZnacznikow(linia: string): string {
  return linia
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}>\s?/, '')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/, '')
    .replace(/\s*\([^()]*LOG-A-\d+[^()]*\)/g, '') // nawias z wewnętrznym identyfikatorem zadania to nie treść pomocy
    .replace(/\|/g, ' ')
    .replace(/(\*\*|__|\*|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface SekcjaDokumentu {
  /** Nagłówek sekcji (`##`, `###`…) jako zwykły tekst; pierwsza sekcja ma tytuł dokumentu. */
  tytul: string
  /** Kotwica jak w renderowanym dokumencie (`anchorOf`), pusta dla części przed pierwszym nagłówkiem. */
  kotwica: string
  /** Treść sekcji jako zwykły tekst, akapity rozdzielone pustą linią. */
  tekst: string
}

/** Dokument podzielony na sekcje po nagłówkach (poza blokami kodu). */
export function sekcjeDokumentu(markdown: string, tytulDokumentu: string): SekcjaDokumentu[] {
  const sekcje: SekcjaDokumentu[] = []
  let biezaca: { tytul: string; kotwica: string; linie: string[] } = { tytul: tytulDokumentu, kotwica: '', linie: [] }
  let wKodzie = false
  const zamknij = () => {
    const tekst = biezaca.linie
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (tekst || biezaca.kotwica) sekcje.push({ tytul: biezaca.tytul, kotwica: biezaca.kotwica, tekst })
  }
  for (const surowa of markdown.replace(/^﻿/, '').split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(surowa)) {
      wKodzie = !wKodzie
      continue
    }
    const naglowek = wKodzie ? null : /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(surowa)
    if (naglowek) {
      if (naglowek[1] === '#') continue // tytuł dokumentu: już jest w pierwszej sekcji
      zamknij()
      biezaca = { tytul: bezZnacznikow(naglowek[2]!), kotwica: anchorOf(naglowek[2]!), linie: [] }
      continue
    }
    const linia = wKodzie ? surowa.trim() : bezZnacznikow(surowa)
    biezaca.linie.push(linia)
  }
  zamknij()
  return sekcje
}

/** Słowa zapytania: znormalizowane, bez jednoliterowych, najwyżej 8. */
export function slowaZapytania(zapytanie: string): string[] {
  const slowa = normalizuj(zapytanie)
    .split(/[^a-z0-9]+/)
    .filter((s) => s.length >= 2)
  return [...new Set(slowa)].slice(0, 8)
}

/**
 * Rdzeń słowa do dopasowania odmian („faktury” znajdzie „fakturę” i „fakturach”, „przesyłki” znajdzie „przesyłka”).
 * Prosta reguła zamiast słownika odmian: dłuższe słowa tracą końcówkę, krótkie zostają całe.
 */
export function rdzen(slowo: string): string {
  if (slowo.length >= 7) return slowo.slice(0, slowo.length - 2)
  if (slowo.length >= 5) return slowo.slice(0, slowo.length - 1)
  return slowo
}

/** Pozycje trafień rdzenia na początku słowa w tekście znormalizowanym. */
function trafienia(tekstNorm: string, r: string): number[] {
  const out: number[] = []
  let i = tekstNorm.indexOf(r)
  while (i !== -1) {
    if (i === 0 || !/[a-z0-9]/.test(tekstNorm[i - 1]!)) out.push(i)
    i = tekstNorm.indexOf(r, i + 1)
  }
  return out
}

export interface WynikPomocy {
  slug: string
  /** Tytuł dokumentu. */
  tytul: string
  opis: string
  rola: RolaPomocy
  /** Najlepiej pasująca sekcja (nagłówek); null, gdy trafienie jest w tytule albo we wstępie. */
  sekcja: string | null
  /** Adres w panelu, z kotwicą sekcji, gdy jest. */
  href: string
  /** Kawałek treści wokół pierwszego trafienia (zwykły tekst). */
  fragment: string
  /** Zakresy [od, do) w `fragment` do podświetlenia. */
  zaznaczenia: Array<[number, number]>
  /** Im więcej, tym lepiej (sortowanie). */
  punkty: number
}

const DLUGOSC_FRAGMENTU = 220

function wytnijFragment(tekst: string, rdzenie: string[]): { fragment: string; zaznaczenia: Array<[number, number]> } {
  const plaski = tekst.replace(/\s+/g, ' ').trim()
  const norm = normalizuj(plaski)
  const pierwsze = rdzenie.map((r) => trafienia(norm, r)[0]).filter((x): x is number => x !== undefined)
  const start = pierwsze.length ? Math.max(0, Math.min(...pierwsze) - 60) : 0
  let od = start
  if (od > 0) {
    const spacja = plaski.indexOf(' ', od)
    od = spacja === -1 || spacja - od > 20 ? od : spacja + 1
  }
  let doo = Math.min(plaski.length, od + DLUGOSC_FRAGMENTU)
  if (doo < plaski.length) {
    const spacja = plaski.lastIndexOf(' ', doo)
    if (spacja > od + 40) doo = spacja
  }
  const prefiks = od > 0 ? '… ' : ''
  const sufiks = doo < plaski.length ? ' …' : ''
  const zaznaczenia: Array<[number, number]> = []
  const wycinekNorm = norm.slice(od, doo)
  for (const r of rdzenie) {
    for (const p of trafienia(wycinekNorm, r)) {
      let k = p + r.length
      while (k < wycinekNorm.length && /[a-z0-9]/.test(wycinekNorm[k]!)) k++ // podświetl całe słowo
      zaznaczenia.push([p + prefiks.length, k + prefiks.length])
    }
  }
  zaznaczenia.sort((a, b) => a[0] - b[0])
  const scalone: Array<[number, number]> = []
  for (const z of zaznaczenia) {
    const ost = scalone[scalone.length - 1]
    if (ost && z[0] <= ost[1]) ost[1] = Math.max(ost[1], z[1])
    else scalone.push([z[0], z[1]])
  }
  return { fragment: prefiks + plaski.slice(od, doo) + sufiks, zaznaczenia: scalone }
}

interface Kandydat {
  entry: DocEntry
  sekcje: SekcjaDokumentu[]
}

function wczytaj(dir: string, czyDozwolony: (slug: string) => boolean): Kandydat[] {
  const out: Kandydat[] = []
  for (const entry of listDocs(dir, czyDozwolony)) {
    try {
      const text = readFileSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, ...entry.file.split('/')), 'utf8')
      out.push({ entry, sekcje: sekcjeDokumentu(text, entry.title) })
    } catch {
      // plik zniknął między listą a odczytem: pomijamy jeden dokument, reszta wyników zostaje
    }
  }
  return out
}

/**
 * Szukanie w Pomocy. Dokument pasuje, gdy każde słowo zapytania (z odmianą) występuje gdzieś w nim; wynik pokazuje
 * sekcję z największą liczbą trafień. Tytuł waży najwięcej, potem nagłówek sekcji, opis, na końcu treść.
 * Puste albo zbyt krótkie zapytanie daje pustą listę.
 */
export function szukajWPomocy(
  zapytanie: string,
  opcje: { dir?: string; limit?: number; rola?: RolaPomocy; czyDozwolony?: (slug: string) => boolean } = {},
): WynikPomocy[] {
  const slowa = slowaZapytania(zapytanie)
  if (slowa.length === 0) return []
  const rdzenie = slowa.map(rdzen)
  const wyniki: WynikPomocy[] = []
  for (const { entry, sekcje } of wczytaj(opcje.dir ?? DOCS_DIR, opcje.czyDozwolony ?? dozwolony)) {
    const rola = rolaDokumentu(entry.slug)
    if (opcje.rola && rola !== opcje.rola) continue
    const tytulN = normalizuj(entry.title)
    const opisN = normalizuj(entry.description)
    const sekcjeN = sekcje.map((s) => ({ s, tytulN: normalizuj(s.tytul), tekstN: normalizuj(s.tekst) }))
    // każde słowo musi być w dokumencie
    const wszystkie = rdzenie.every(
      (r) => trafienia(tytulN, r).length > 0 || trafienia(opisN, r).length > 0 || sekcjeN.some((x) => trafienia(x.tytulN, r).length > 0 || trafienia(x.tekstN, r).length > 0),
    )
    if (!wszystkie) continue
    let punkty = 0
    for (const r of rdzenie) {
      if (trafienia(tytulN, r).length) punkty += 10
      if (trafienia(opisN, r).length) punkty += 3
    }
    let najlepsza: (typeof sekcjeN)[number] | null = null
    let najlepszaPunkty = -1
    for (const x of sekcjeN) {
      let p = 0
      let slowW = 0
      for (const r of rdzenie) {
        const wTytule = trafienia(x.tytulN, r).length
        const wTresci = trafienia(x.tekstN, r).length
        if (wTytule || wTresci) slowW++
        p += wTytule * 5 + Math.min(wTresci, 5)
      }
      p += slowW * 4 // sekcja z wszystkimi słowami przed sekcją z jednym słowem powtórzonym wiele razy
      if (p > najlepszaPunkty) {
        najlepszaPunkty = p
        najlepsza = x
      }
    }
    punkty += Math.max(0, najlepszaPunkty)
    // dokumentacja administratora (integracje, instalacja) niżej niż tematy do codziennej pracy przy tym samym trafieniu
    if (rola === 'administrator') punkty = Math.round(punkty * 0.7)
    const zSekcji = najlepsza && najlepszaPunkty > 0 ? najlepsza : null
    const zrodloFragmentu = zSekcji?.s.tekst || entry.description
    const { fragment, zaznaczenia } = wytnijFragment(zrodloFragmentu, rdzenie)
    const kotwica = zSekcji?.s.kotwica ?? ''
    wyniki.push({
      slug: entry.slug,
      tytul: entry.title,
      opis: entry.description,
      rola,
      sekcja: kotwica ? zSekcji!.s.tytul : null,
      href: `/pomoc/${entry.slug}${kotwica ? `#${kotwica}` : ''}`,
      fragment,
      zaznaczenia,
      punkty,
    })
  }
  wyniki.sort((a, b) => b.punkty - a.punkty || a.slug.localeCompare(b.slug))
  return wyniki.slice(0, opcje.limit ?? 20)
}
