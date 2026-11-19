// Asystent „Zapytaj”: wybór fragmentów Pomocy do pytania i „Pomoc do tego ekranu”. Źródłem są wyłącznie pliki
// dokumentacji widoczne w Pomocy (`lib/pomoc/dokumenty.ts`, lista `DOZWOLONE`), nigdy dane firmy ani klientów.
//
// Wyszukiwarka Pomocy (`szukajWPomocy`) wymaga każdego słowa zapytania w dokumencie, a pytanie zadane naturalnym
// językiem („jak zrobić korektę faktury?”) ma słowa, których w dokumentacji nie ma. Tu słowa pomocnicze odpadają,
// a sekcja przechodzi, gdy ma wystarczająco dużo słów pytania; wynik to całe sekcje (z limitem długości), żeby model
// miał z czego odpowiedzieć, i adres z kotwicą do odnośnika.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DOCS_DIR, dozwolony, listDocs } from '../pomoc/dokumenty'
import { normalizuj, rdzen, sekcjeDokumentu } from '../pomoc/szukaj'

export { pomocEkranu, POMOC_EKRANOW } from './ekrany'

/** Słowa pytania bez znaczenia dla wyszukiwania (po normalizacji: małe litery, bez polskich znaków). */
const POMIJANE = new Set(
  (
    'jak co czy gdzie kiedy ile jaki jaka jakie jakiego ktory ktora ktore mam mozna moge musze trzeba sie jest sa byc ' +
    'to ten ta te tego tej tym na do od po za przy pod nad dla bez ze we w z o i a oraz lub albo ale nie tak tez juz ' +
    'zrobic robic zrobie zrobi dziala dzialac znaczy oznacza mi mnie moj moja moje nas nasz u przez jesli gdy zeby by ' +
    'prosze pomoz pomocy powiedz wyjasnij chce chcialbym chcialabym jest tutaj tu tam ekran ekranie kompletor kompletorze ' +
    // etykiety wklejonych danych (sam numer czy adres wycina pytanieDoSzukania)
    'tel'
  ).split(/\s+/),
)

/** Słowa pytania do szukania: znormalizowane, bez pomijanych i jednoliterowych, najwyżej 10. */
export function slowaPytania(pytanie: string): string[] {
  const slowa = normalizuj(pytanie)
    .split(/[^a-z0-9]+/)
    .filter((s) => s.length >= 2 && !POMIJANE.has(s))
  return [...new Set(slowa)].slice(0, 10)
}

export interface FragmentPomocy {
  /** Numer źródła w odpowiedzi (od 1). */
  nr: number
  /** „Tytuł dokumentu → Sekcja” albo sam tytuł. */
  tytul: string
  /** Adres w panelu z kotwicą sekcji. */
  href: string
  /** Treść sekcji jako zwykły tekst (ucięta do limitu). */
  tekst: string
}

function liczTrafienia(tekstNorm: string, r: string): number {
  let n = 0
  let i = tekstNorm.indexOf(r)
  while (i !== -1) {
    if (i === 0 || !/[a-z0-9]/.test(tekstNorm[i - 1]!)) n++
    i = tekstNorm.indexOf(r, i + 1)
  }
  return n
}

/**
 * Najlepiej pasujące sekcje Pomocy do pytania. Pusta lista = Pomoc nie ma nic na ten temat (asystent odpowiada
 * „nie wiem, gdzie to jest” bez wywołania modelu). Sekcja musi mieć co najmniej jedno słowo pytania, a przy
 * dłuższych pytaniach co najmniej dwa różne.
 */
export function fragmentyPomocy(
  pytanie: string,
  opcje: { dir?: string; limit?: number; maxZnakow?: number; czyDozwolony?: (slug: string) => boolean } = {},
): FragmentPomocy[] {
  const slowa = slowaPytania(pytanie)
  if (slowa.length === 0) return []
  const rdzenie = slowa.map(rdzen)
  const minimum = rdzenie.length >= 3 ? 2 : 1
  const dir = opcje.dir ?? DOCS_DIR
  const maxZnakow = opcje.maxZnakow ?? 1800
  const kandydaci: Array<{ tytul: string; href: string; tekst: string; punkty: number }> = []
  for (const entry of listDocs(dir, opcje.czyDozwolony ?? dozwolony)) {
    let tekst: string
    try {
      tekst = readFileSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, ...entry.file.split('/')), 'utf8')
    } catch {
      continue // plik zniknął między listą a odczytem: pomijamy jeden dokument
    }
    const tytulDokN = normalizuj(entry.title)
    for (const s of sekcjeDokumentu(tekst, entry.title)) {
      if (!s.tekst) continue
      const tytulN = normalizuj(s.tytul)
      const tekstN = normalizuj(s.tekst)
      let punkty = 0
      let slow = 0
      for (const r of rdzenie) {
        const wTytule = liczTrafienia(tytulN, r)
        const wTresci = liczTrafienia(tekstN, r)
        const wDok = liczTrafienia(tytulDokN, r)
        if (wTytule || wTresci) slow++
        punkty += wTytule * 6 + Math.min(wTresci, 5) + (wDok ? 2 : 0)
      }
      if (slow < minimum) continue
      punkty += slow * 5
      kandydaci.push({
        tytul: s.kotwica ? `${entry.title} → ${s.tytul}` : entry.title,
        href: `/pomoc/${entry.slug}${s.kotwica ? `#${s.kotwica}` : ''}`,
        tekst: s.tekst.length > maxZnakow ? `${s.tekst.slice(0, maxZnakow)} …` : s.tekst,
        punkty,
      })
    }
  }
  kandydaci.sort((a, b) => b.punkty - a.punkty || a.href.localeCompare(b.href))
  const out: FragmentPomocy[] = []
  const adresy = new Set<string>()
  for (const k of kandydaci) {
    if (adresy.has(k.href)) continue
    adresy.add(k.href)
    out.push({ nr: out.length + 1, tytul: k.tytul, href: k.href, tekst: k.tekst })
    if (out.length >= (opcje.limit ?? 5)) break
  }
  return out
}
